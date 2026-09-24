// Imported films in the cloud (decision 2026-09-24, "two computers, one
// database", choice B). An import hardlinks a film's episodes and copies its
// index files into the local tier of the computer that ran it
// (lib/data/storage.ts), so until now only that computer could play, cut or
// upload the film. This sweep copies every one of those files to the bucket
// under the same key, and lib/data/storage.ts's `ensureLocalTierFile` and
// the media route read them back on any other computer.
//
// Only imported films: the files the imported titles' rows name (each
// episode's video, the film assets, a cover in the tier) — never a pipeline
// folder, a source film or a work file. The rows decide what is wanted, the
// bucket listing decides what is there already (nothing is recorded twice),
// and only a file on this computer's disk can be uploaded from here, so two
// computers never race for one file: the other one's files are counted as
// "elsewhere" until they arrive.
//
// Uploading is this computer's choice (`cloud_copy` in .studio-computer.json,
// the card's switch), off until someone turns it on: the Supabase plan sets
// the room (the free plan holds 1 GB and 50 MB per file; Pro 100 GB, with a
// per-file limit the project sets), and filling a free project would put the
// live database at risk. Reading from the cloud is always on. One sweep at a
// time per process, one file at a time, never overwriting; a file over the
// project's size limit is reported and tried again an hour later (or at
// once, from the card). The scheduler starts a sweep every tick, an import
// when it finishes; neither waits for it.

import { statSync } from "node:fs";
import path from "node:path";
import { systemSession, type Session } from "@/lib/auth";
import { readComputerFile } from "@/lib/computer";
import { getData, type DataLayer } from "@/lib/data";
import { CloudError, cloudStore, isLocalTierPath, localPathOf, type CloudStore } from "@/lib/data/storage";

export type CloudFileKind = "asset" | "cover" | "episode";
export type CloudFile = { key: string; kind: CloudFileKind };

/** One imported title as the card shows it. */
export type TitleCloud = {
  title_id: string;
  name: string;
  /** Every file the title's rows name in the local tier. */
  files: number;
  in_cloud: number;
  /** On this computer and not in the cloud yet: what this computer uploads. */
  waiting_here: number;
  /** Neither here nor in the cloud: on the computer that imported it, not uploaded yet. */
  elsewhere: number;
  /** Refused by the project's file size limit. */
  too_big: { file: string; bytes: number }[];
  failed: { file: string; message: string }[];
  /** The file being uploaded now. */
  uploading: string | null;
  checked_at: string;
};

export type CloudSummary = {
  /** False in fixture mode: there is no bucket. */
  available: boolean;
  /** This computer uploads (its switch). */
  on: boolean;
  running: boolean;
  titles: TitleCloud[];
  last_run_at: string | null;
  error: string | null;
};

/** A file over the size limit is tried again after this long (or at once, when a person asks). */
export const TOO_BIG_RETRY_MS = 60 * 60 * 1000;

type State = { running: boolean; titles: Map<string, TitleCloud>; tooBigAt: Map<string, number>; lastRunAt: string | null; error: string | null };

function state(): State {
  const g = globalThis as unknown as { __studioCloudCopy?: State };
  if (!g.__studioCloudCopy) g.__studioCloudCopy = { running: false, titles: new Map(), tooBigAt: new Map(), lastRunAt: null, error: null };
  return g.__studioCloudCopy;
}

/** For tests. */
export function resetCloudCopyForTests(): void {
  const g = globalThis as unknown as { __studioCloudCopy?: State };
  delete g.__studioCloudCopy;
}

const KIND_ORDER: Record<CloudFileKind, number> = { cover: 0, asset: 1, episode: 2 };

/** The local-tier files a title's rows name, each once, the small ones first and the episodes in order. */
export function wantedFiles(
  title: { cover_path?: string | null },
  episodes: readonly { video_path?: string | null }[],
  assets: readonly { storage_path: string }[],
): CloudFile[] {
  const out = new Map<string, CloudFile>();
  const add = (key: string | null | undefined, kind: CloudFileKind) => {
    if (key && isLocalTierPath(key) && !out.has(key)) out.set(key, { key, kind });
  };
  add(title.cover_path, "cover");
  for (const a of assets) add(a.storage_path, "asset");
  for (const e of episodes) add(e.video_path, "episode");
  return [...out.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key.localeCompare(b.key, "en", { numeric: true }));
}

export function contentTypeOf(key: string): string {
  const ext = path.extname(key).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".json") return "application/json";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".vtt") return "text/vtt";
  if (ext === ".srt" || ext === ".txt" || ext === ".md") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** The size of this computer's copy of a local-tier file, or null when it has none. */
function localSize(key: string): number | null {
  try {
    const s = statSync(localPathOf(key), { throwIfNoEntry: false });
    return s?.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** What the card reads: the last sweep's picture of every imported title. */
export function cloudSummary(store: CloudStore | null = cloudStore()): CloudSummary {
  const s = state();
  return {
    available: !!store,
    on: store ? readComputerFile().cloud_copy === true : false,
    running: s.running,
    titles: [...s.titles.values()].sort((a, b) => a.name.localeCompare(b.name)),
    last_run_at: s.lastRunAt,
    error: s.error,
  };
}

export type SyncOptions = {
  /** Only this title (after its import). */
  titleId?: string;
  /** Try files over the size limit again now (the card's button). */
  force?: boolean;
  store?: CloudStore | null;
  data?: DataLayer;
  session?: Session;
  /** Upload regardless of the computer's switch (tests). */
  upload?: boolean;
  now?: () => number;
};

/**
 * One pass: for every imported title (or the one named), what its rows want
 * against what the bucket lists, then — when this computer's switch is on —
 * upload what only this computer has, one file at a time. A sweep already
 * running answers with its picture and starts nothing.
 */
export async function syncCloudCopies(opts: SyncOptions = {}): Promise<CloudSummary> {
  const store = opts.store === undefined ? cloudStore() : opts.store;
  const s = state();
  if (!store || s.running) return cloudSummary(store);
  const data = opts.data ?? getData();
  const session = opts.session ?? systemSession();
  const now = opts.now ?? Date.now;
  const uploading = opts.upload ?? readComputerFile().cloud_copy === true;
  s.running = true;
  s.error = null;
  try {
    const titles = (await data.listImportedTitles(session)).filter((t) => !opts.titleId || t.id === opts.titleId);
    if (!opts.titleId) for (const id of [...s.titles.keys()]) if (!titles.some((t) => t.id === id)) s.titles.delete(id);
    for (const t of titles) {
      const [episodes, assets] = await Promise.all([data.listTitleEpisodes(session, t.id), data.listFilmAssets(session, t.id)]);
      const wanted = wantedFiles(t, episodes, assets);
      const listed = new Map<string, number>();
      for (const folder of new Set(wanted.map((f) => path.posix.dirname(f.key)))) {
        for (const o of await store.list(folder)) if (o.size > 0) listed.set(`${folder}/${o.name}`, o.size);
      }
      const entry: TitleCloud = {
        title_id: t.id,
        name: t.name_en || t.name_zh,
        files: wanted.length,
        in_cloud: 0,
        waiting_here: 0,
        elsewhere: 0,
        too_big: [],
        failed: [],
        uploading: null,
        checked_at: new Date(now()).toISOString(),
      };
      const queue: { key: string; bytes: number }[] = [];
      for (const f of wanted) {
        if (listed.has(f.key)) {
          entry.in_cloud++;
          continue;
        }
        const bytes = localSize(f.key);
        if (bytes === null) {
          entry.elsewhere++;
          continue;
        }
        entry.waiting_here++;
        const refusedAt = s.tooBigAt.get(f.key);
        if (refusedAt !== undefined && !opts.force && now() - refusedAt < TOO_BIG_RETRY_MS) {
          entry.too_big.push({ file: path.posix.basename(f.key), bytes });
          continue;
        }
        queue.push({ key: f.key, bytes });
      }
      s.titles.set(t.id, entry);
      if (!uploading) continue;
      for (const q of queue) {
        const file = path.posix.basename(q.key);
        entry.uploading = file;
        try {
          await store.upload(q.key, localPathOf(q.key), contentTypeOf(q.key));
          entry.in_cloud++;
          entry.waiting_here--;
          s.tooBigAt.delete(q.key);
        } catch (e) {
          if (e instanceof CloudError && e.code === "exists") {
            entry.in_cloud++;
            entry.waiting_here--;
          } else if (e instanceof CloudError && e.code === "too_big") {
            s.tooBigAt.set(q.key, now());
            entry.too_big.push({ file, bytes: q.bytes });
          } else {
            entry.failed.push({ file, message: (e as Error).message });
            console.error(`[cloud-copy] ${q.key}: ${(e as Error).message}`);
          }
        }
      }
      entry.uploading = null;
    }
  } catch (e) {
    s.error = (e as Error).message;
    console.error(`[cloud-copy] sweep failed: ${s.error}`);
  } finally {
    s.running = false;
    s.lastRunAt = new Date(now()).toISOString();
  }
  return cloudSummary(store);
}

/** The scheduler's step: start a sweep when there is a bucket, without waiting for it. */
export function tickCloudCopies(): void {
  if (!cloudStore() || state().running) return;
  void syncCloudCopies().catch((e) => console.error(`[cloud-copy] ${(e as Error).message}`));
}
