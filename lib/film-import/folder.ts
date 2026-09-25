// "Upload by folder" (decision 2026-09-24): a folder of finished episodes —
// `ep1.mp4` … `epN.mp4`, anywhere on this computer (the narrated route
// delivers Love Between Lines to Desktop\Dramas\Love between lines) — becomes
// a title with one video-only episode per file, the same rows the workspace
// import writes, so "Upload to CrazyDramas" takes it unchanged. It reads no
// pipeline plan, index or transcript: the folder IS the delivery, numbered by
// its file names.
//
// What it never does: write into the folder (it is only listed and read);
// point an episode row at the folder (each file is COPIED into the local tier
// under its hash — a finished folder under OneDrive may be synced, replaced
// or made online-only later, which a hardlink would follow); import a folder
// whose numbers do not run 1..N without a gap or a repeat; run for a
// producer session (the path is a path on the server's disk: admin staff
// only, like the workspace import's staff route).
//
// The title's source_ref is `_folders/<folder name as a slug>`, a plain
// relative path that names no workspace project, so a later import of the
// same folder name for the same company updates the same title (only the
// changed files are copied again).

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fsp, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { systemSession, type Session } from "@/lib/auth";
import { assignCrazydramasSlug } from "@/lib/crazydramas/slug-assign";
import { checkAfterImport } from "@/lib/crazydramas/sweep";
import { DataError, getData, isDataError, type EpisodeImportInput, type NewJob } from "@/lib/data";
import { normalizeSourceRef } from "@/lib/data/film-import";
import { localPathOf, localStoredPath, putStoredBytes } from "@/lib/data/storage";
import type { Episode, Json, Title } from "@/lib/types";
import { ffprobeFacts, IMPORT_JOB_KIND, sourceLocaleOf, type ImportCounts, type VideoProbe } from "./import";

const log = (m: string) => console.log(`[folder-import] ${m}`);

// ---- the folder ---------------------------------------------------------------------------------------------------

/** `ep12.mp4`, `EP012.mp4`, `episode 12.mp4`, `12.mp4` (and .mov / .m4v): the episode number is the file's. */
export const EPISODE_FILE = /^(?:ep(?:isode)?)?[\s._-]*0*(\d{1,4})\.(mp4|mov|m4v)$/i;
const POSTER = /^(poster|cover)\.(jpe?g|png)$/i;

export type FolderEpisode = { n: number; name: string; bytes: number; mtime_ms: number };

export type FolderScan = {
  /** The folder as resolved on this computer. */
  folder: string;
  /** Its own name, the default display title. */
  name: string;
  /** The title's source_ref: `_folders/<slug>`. */
  source_ref: string;
  episodes: FolderEpisode[];
  bytes: number;
  /** `poster.jpg` / `cover.png` in the folder, when there is one. */
  poster: string | null;
  /** Why the folder cannot be imported as it is: a gap, a repeat, nothing numbered. Empty = importable. */
  problems: string[];
  /** Video files whose name carries no episode number (left out, and said so). */
  ignored: string[];
};

/** `Love between lines` → `love-between-lines`: lowercase ASCII words joined by hyphens; `folder` when nothing is left. Pure. */
export function folderSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "folder";
}

export function folderSourceRef(folder: string): string {
  return normalizeSourceRef(`_folders/${folderSlug(path.basename(folder))}`);
}

/**
 * The episodes a folder holds, read from its file names. Pure over the
 * listing: numbers must run 1..N with no gap and no repeat (a repeat is two
 * files for one episode — `ep1.mp4` and `ep01.mp4` — and which one ships is
 * the person's call, not Studio's).
 */
export function episodesOfListing(files: { name: string; bytes: number; mtime_ms: number }[]): { episodes: FolderEpisode[]; problems: string[]; ignored: string[] } {
  const byN = new Map<number, FolderEpisode[]>();
  const ignored: string[] = [];
  for (const f of files) {
    const m = f.name.match(EPISODE_FILE);
    if (!m) {
      if (/\.(mp4|mov|m4v)$/i.test(f.name)) ignored.push(f.name);
      continue;
    }
    const n = Number(m[1]);
    if (n < 1) {
      ignored.push(f.name);
      continue;
    }
    byN.set(n, [...(byN.get(n) ?? []), { n, name: f.name, bytes: f.bytes, mtime_ms: f.mtime_ms }]);
  }
  const problems: string[] = [];
  const numbers = [...byN.keys()].sort((a, b) => a - b);
  if (!numbers.length) problems.push("no episode files: name them ep1.mp4, ep2.mp4 … (or 1.mp4, 2.mp4 …)");
  const last = numbers[numbers.length - 1] ?? 0;
  const missing: number[] = [];
  for (let n = 1; n <= last; n++) if (!byN.has(n)) missing.push(n);
  if (missing.length) problems.push(`episode${missing.length > 1 ? "s" : ""} ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? " …" : ""} missing: the numbers must run from 1 to ${last} without a gap`);
  for (const n of numbers) {
    const two = byN.get(n)!;
    if (two.length > 1) problems.push(`episode ${n} has ${two.length} files (${two.map((x) => x.name).join(", ")}): keep one`);
  }
  for (const n of numbers) {
    const f = byN.get(n)![0];
    if (f.bytes === 0) problems.push(`${f.name} is empty`);
  }
  const episodes = numbers.map((n) => byN.get(n)![0]);
  return { episodes, problems, ignored: ignored.sort() };
}

/** Lists a folder on this computer. Refuses what is not an absolute path to a folder that exists. */
export async function scanFolder(input: string): Promise<FolderScan> {
  const raw = (input ?? "").trim().replace(/^"(.*)"$/, "$1");
  if (!raw) throw new DataError("invalid", "folder is required");
  if (!path.isAbsolute(raw)) throw new DataError("invalid", `${raw} is not a full path: paste the folder's address, like C:\\Users\\you\\Desktop\\Dramas\\My film`);
  const folder = path.resolve(raw);
  const st = statSync(folder, { throwIfNoEntry: false });
  if (!st) throw new DataError("not_found", `${folder} does not exist on this computer`);
  if (!st.isDirectory()) throw new DataError("invalid", `${folder} is a file, not a folder`);
  const files: { name: string; bytes: number; mtime_ms: number }[] = [];
  let poster: string | null = null;
  for (const d of await fsp.readdir(folder, { withFileTypes: true })) {
    if (!d.isFile()) continue;
    if (POSTER.test(d.name)) poster ??= d.name;
    const s = statSync(path.join(folder, d.name), { throwIfNoEntry: false });
    if (s) files.push({ name: d.name, bytes: s.size, mtime_ms: s.mtimeMs });
  }
  const { episodes, problems, ignored } = episodesOfListing(files);
  return {
    folder,
    name: path.basename(folder),
    source_ref: folderSourceRef(folder),
    episodes,
    bytes: episodes.reduce((s, e) => s + e.bytes, 0),
    poster,
    problems,
    ignored,
  };
}

// ---- progress (process-wide, as the workspace import's) ------------------------------------------------------------

export type FolderImportStep = "copy" | "finish" | "done" | "failed";

export type FolderImportProgress = {
  key: string;
  producer_id: string;
  source_ref: string;
  folder: string;
  job_id: string;
  title_id: string;
  started_at: string;
  updated_at: string;
  step: FolderImportStep;
  /** The episode being copied, during `copy`. */
  episode: number | null;
  total: number;
  counts: ImportCounts;
  warnings: string[];
  error: string | null;
};

type Registry = Map<string, FolderImportProgress>;
const holder = globalThis as unknown as { __studioFolderImports?: Registry };
const registry = (): Registry => (holder.__studioFolderImports ??= new Map());
const keyOf = (producerId: string, sourceRef: string) => `${producerId}:${sourceRef}`;

export function folderImportProgress(producerId: string, sourceRef: string): FolderImportProgress | null {
  const p = registry().get(keyOf(producerId, sourceRef));
  return p ? { ...p, counts: { ...p.counts }, warnings: [...p.warnings] } : null;
}

export function folderImportRunning(p: FolderImportProgress | null | undefined): boolean {
  return !!p && p.step !== "done" && p.step !== "failed";
}

/** Tests only. */
export function resetFolderImportRegistry(): void {
  registry().clear();
}

const touch = (p: FolderImportProgress, patch: Partial<FolderImportProgress>) => Object.assign(p, patch, { updated_at: new Date().toISOString() });

// ---- the import --------------------------------------------------------------------------------------------------

export const FolderImportRequestSchema = z.object({
  folder: z.string().trim().min(1).max(1000),
  /** The name the title shows (and the crazydramas series is created with); the folder's name when absent. */
  display_title: z.string().trim().min(1).max(200).nullish(),
});
export type FolderImportRequest = z.infer<typeof FolderImportRequestSchema>;

export type FolderImportOptions = { probe?: VideoProbe; skipSlug?: boolean };

export type FolderImportStarted = { job_id: string; title_id: string; source_ref: string; created: boolean; episodes: number };

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** A fingerprint of the listing (names, sizes, mtimes): the job's idempotency key, so the same folder twice is one job. */
function listingSha(scan: FolderScan): string {
  return createHash("sha256")
    .update(JSON.stringify(scan.episodes.map((e) => [e.n, e.name, e.bytes, Math.round(e.mtime_ms)])))
    .digest("hex");
}

type Prepared = { scan: FolderScan; title: Title; created: boolean; job: { id: string }; progress: FolderImportProgress; opts: FolderImportOptions };

async function prepare(caller: Session, request: FolderImportRequest, producerId: string, createdBy: string, opts: FolderImportOptions): Promise<Prepared> {
  if (caller.kind !== "staff") throw new DataError("forbidden", "only staff may import a folder from this computer");
  const scan = await scanFolder(request.folder);
  if (scan.problems.length) throw new DataError("conflict", `${scan.folder} cannot be imported: ${scan.problems.join("; ")}`);
  const key = keyOf(producerId, scan.source_ref);
  const previous = registry().get(key);
  if (folderImportRunning(previous)) throw new DataError("conflict", `an import of ${scan.name} is already running`);
  const at = new Date().toISOString();
  const placeholder: FolderImportProgress = { key, producer_id: producerId, source_ref: scan.source_ref, folder: scan.folder, job_id: "", title_id: "", started_at: at, updated_at: at, step: "copy", episode: null, total: scan.episodes.length, counts: { added: 0, updated: 0, unchanged: 0, flagged: 0, transcripts: 0, transcripts_skipped: 0 }, warnings: [], error: null };
  registry().set(key, placeholder);
  let claimed = false;
  try {
    const data = getData();
    const sys = systemSession();
    const display = request.display_title?.trim() || scan.name;
    const existing = await data.findTitleBySourceRef(sys, producerId, scan.source_ref);
    let title: Title;
    let created = false;
    if (existing) {
      title = existing;
      if (request.display_title?.trim() && request.display_title.trim() !== (existing.name_en ?? "")) title = await data.setTitleImport(sys, existing.id, { display_title_en: request.display_title.trim() });
    } else {
      // Every folder delivered so far is an English remix (the narrated route's language); a Chinese folder is renamed on the title page.
      title = await data.createImportedTitle(sys, { producer_id: producerId, source_ref: scan.source_ref, display_title_en: display, crazydramas_slug: null, created_by: createdBy, source_locale: sourceLocaleOf("en") });
      created = true;
    }
    const base = `folder-import:${producerId}:${scan.source_ref}:${listingSha(scan)}`;
    const input = (idem: string): NewJob => ({
      kind: IMPORT_JOB_KIND,
      title_id: title.id,
      target_type: "title",
      target_id: title.id,
      idempotency_key: idem,
      provider: null,
      model: null,
      input: { source: "folder", folder: scan.folder, source_ref: scan.source_ref, episodes: scan.episodes.length, caller: createdBy },
    });
    let job = await data.recordJob(sys, input(base));
    if (job.status === "done") job = await data.recordJob(sys, input(`${base}:u${Date.now().toString(36)}`));
    const progress: FolderImportProgress = { ...placeholder, job_id: job.id, title_id: title.id };
    registry().set(key, progress);
    claimed = true;
    return { scan, title, created, job, progress, opts };
  } finally {
    if (!claimed && registry().get(key) === placeholder) {
      if (previous) registry().set(key, previous);
      else registry().delete(key);
    }
  }
}

async function run(p: Prepared): Promise<void> {
  const data = getData();
  const sys = systemSession();
  const { scan, title, progress, opts } = p;
  const probe = opts.probe ?? ffprobeFacts;
  const slug = folderSlug(scan.name);
  const beat = () => data.heartbeatJob(sys, p.job.id).catch(() => undefined);
  const known = new Map<number, Episode>();
  // The episode rows themselves (the summary carries no video fields), as the workspace import reads them.
  if (!p.created) for (const e of (await data.getTitle(sys, title.id)).episodes) known.set(e.number, (await data.getWorkbench(sys, title.id, e.number)).episode);

  for (const ep of scan.episodes) {
    const nn = String(ep.n).padStart(2, "0");
    touch(progress, { episode: ep.n });
    const original = path.join(scan.folder, ep.name);
    // The folder's file is hashed where it lies (read only), and copied into the tier only when the tier does not hold those
    // bytes yet: under a pending name, the copy hashed again (the file must not have changed in between), then renamed to the
    // hash's name, so the row always names bytes that are there. A re-run of an unchanged folder copies nothing.
    const sha = await sha256File(original);
    const finalStored = localStoredPath(title.id, slug, `ep${nn}-${sha.slice(0, 8)}.mp4`);
    const finalAbs = localPathOf(finalStored);
    const there = statSync(finalAbs, { throwIfNoEntry: false });
    if (!there || there.size !== ep.bytes) {
      const pendingAbs = localPathOf(localStoredPath(title.id, slug, `ep${nn}.pending-${randomUUID().slice(0, 8)}.mp4`));
      await fsp.mkdir(path.dirname(pendingAbs), { recursive: true });
      try {
        await fsp.copyFile(original, pendingAbs);
        const copied = await sha256File(pendingAbs);
        if (copied !== sha) throw new DataError("conflict", `${ep.name} changed while it was being copied; import the folder again`);
        if (there) await fsp.unlink(finalAbs);
        await fsp.rename(pendingAbs, finalAbs);
      } catch (e) {
        await fsp.unlink(pendingAbs).catch(() => undefined);
        throw e;
      }
    }
    const have = known.get(ep.n);
    if (have && have.video_sha256 === sha && have.video_path === finalStored && have.video_frames) {
      progress.counts.unchanged += 1;
      await beat();
      continue;
    }
    const facts = await probe(localPathOf(finalStored));
    if (!facts?.frames) {
      progress.warnings.push(`ep${nn}: ffprobe could not count its frames; CrazyDramas will refuse to upload it until it is imported again`);
      progress.counts.flagged += 1;
    }
    const patch: EpisodeImportInput = {
      source_ref: `${scan.source_ref}/${ep.name}`,
      video_sha256: sha,
      video_bytes: statSync(finalAbs).size,
      video_frames: facts?.frames ?? null,
      duration_ms: facts?.duration_s ? Math.round(facts.duration_s * 1000) : null,
      film_start_ms: null,
      film_end_ms: null,
      end_note: { decision: "folder", file: ep.name } as Json,
      auto_cut: false,
    };
    if (have) {
      known.set(ep.n, await data.setEpisodeImport(sys, have.id, { video_path: finalStored, ...patch }));
      progress.counts.updated += 1;
    } else {
      known.set(ep.n, await data.addVideoOnlyEpisode(sys, title.id, ep.n, finalStored, patch));
      progress.counts.added += 1;
    }
    await beat();
  }
  touch(progress, { step: "finish", episode: null });
  for (const n of [...known.keys()].filter((n) => n > scan.episodes.length).sort((a, b) => a - b)) {
    progress.warnings.push(`ep${String(n).padStart(2, "0")}: the title has it but the folder no longer does; it keeps its old file`);
  }

  // The folder's poster, when it has one, becomes the title's cover (the series' poster on crazydramas).
  if (scan.poster) {
    const bytes = await fsp.readFile(path.join(scan.folder, scan.poster));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const ext = path.extname(scan.poster).toLowerCase();
    const stored = localStoredPath(title.id, slug, `poster-${sha.slice(0, 8)}${ext}`);
    await putStoredBytes(stored, bytes, ext === ".png" ? "image/png" : "image/jpeg");
    await data.putFilmAsset(sys, { title_id: title.id, kind: "poster", storage_path: stored, sha256: sha, bytes: bytes.length, origin: "workspace", source_ref: `${scan.source_ref}/${scan.poster}`, meta: { file: scan.poster, from: "folder" } });
    if (title.cover_path !== stored) await data.setTitleImport(sys, title.id, { cover_path: stored });
  }

  // A crazydramas slug, picked the way the workspace import picks one (failure-soft; the upload form tries again when it opens).
  if (!opts.skipSlug && !(await data.getTitle(sys, title.id)).title.crazydramas_slug?.trim()) {
    try {
      const r = await assignCrazydramasSlug(sys, title.id, { skipCheck: true });
      log(`slug for ${title.external_id}: ${r.slug} (${r.outcome})`);
    } catch (e) {
      progress.warnings.push(`no crazydramas slug was picked (${(e as Error).message}); the upload form picks one when it opens`);
    }
  }

  const counts = { ...progress.counts };
  await data.finishJob(sys, p.job.id, { status: "done", cost_cents: 0, output: { source: "folder", folder: scan.folder, counts, warnings: progress.warnings } as unknown as Json });
  touch(progress, { step: "done" });
  log(`${scan.folder} → ${title.external_id}: ${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.flagged} flagged`);
  if ((await data.getTitle(sys, title.id)).title.crazydramas_slug?.trim()) await checkAfterImport(title.id);
}

async function runGuarded(p: Prepared): Promise<void> {
  try {
    await run(p);
  } catch (e) {
    const message = isDataError(e) || e instanceof Error ? (e as Error).message : String(e);
    await getData().finishJob(systemSession(), p.job.id, { status: "failed", error: message, cost_cents: 0 }).catch(() => undefined);
    touch(p.progress, { step: "failed", error: message });
    console.error(`[folder-import] ${p.scan.folder}: ${message}`);
    throw e;
  }
}

/** The whole folder import, awaited (tests and scripts). */
export async function importFolder(caller: Session, request: FolderImportRequest, producerId: string, createdBy: string, opts: FolderImportOptions = {}): Promise<FolderImportProgress> {
  const p = await prepare(caller, request, producerId, createdBy, opts);
  await runGuarded(p);
  return folderImportProgress(producerId, p.scan.source_ref)!;
}

/** What the route calls: the refusals and the title now, the copying in the background; the page polls the progress. */
export async function startFolderImport(caller: Session, request: FolderImportRequest, producerId: string, createdBy: string, opts: FolderImportOptions = {}): Promise<FolderImportStarted> {
  const p = await prepare(caller, request, producerId, createdBy, opts);
  void runGuarded(p)
    .then(() => import("@/lib/cloud-copy").then((m) => void m.syncCloudCopies({ titleId: p.title.id })))
    .catch(() => undefined);
  return { job_id: p.job.id, title_id: p.title.id, source_ref: p.scan.source_ref, created: p.created, episodes: p.scan.episodes.length };
}
