// Where uploaded files live and how they are served. One bucket in V1,
// `studio-media` (private), paths `<title_id>/<episode_id>/<file>`; fixture
// mode writes the same relative paths under .uploads/ (gitignored) so a demo
// with a video works with no Supabase project. The stored value on the row
// (episodes.video_path, episodes.source_script_path) is always the relative
// storage path — never a URL, never an absolute filesystem path — and
// GET /api/media/[...path] turns it into bytes (fixture: Range streaming from
// .uploads; supabase: 302 to a signed URL) after canReadTitle.
//
// The one exception (decision 2026-09-22, "imported films are hardlink
// snapshots"): the LOCAL TIER. An imported episode is a hardlink from the
// pipeline's cut/eps/epNN.mp4 into STUDIO_LOCAL_MEDIA_DIR, stored as
// `local/<title_id>/ws/<slug>/epNN-<sha8>.mp4`, and that value resolves on
// disk in BOTH modes (`localPathOf`): the media route streams it with Range,
// ffmpeg reads it in place, nothing is copied into the bucket. The tier
// marker comes first so no bucket path can be mistaken for it, the title id
// second so the media route still authorizes on the title. `localPathOf`
// refuses a value that would leave the tier or point into WORKSPACE_ROOT:
// Studio never opens the pipeline's own files (a render holding the
// original path open would crash the pipeline's os.replace), it reads the
// link. Rendered ads and every upload still go to the bucket. Since
// 2026-09-24 the tier's files are also copied to the bucket under the same
// key (lib/cloud-copy.ts), so another computer on the same database plays
// and cuts an imported film too (`ensureLocalTierFile`, at the end).

import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, linkSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureComputerSettings } from "@/lib/computer";
import { dataSource } from "@/lib/data-source";
import { invalid } from "./errors";

export const MEDIA_BUCKET = "studio-media";

/** Fixture-mode root; resolved per call so a script run from another cwd still lands in the repo. */
export function uploadsDir(): string {
  return path.join(process.cwd(), ".uploads");
}

// ---- the local tier (decision 2026-09-22) ----------------------------------------------------------

/** The first segment of a local-tier stored value. */
export const LOCAL_TIER = "local";

/** Where the local tier lives on disk: STUDIO_LOCAL_MEDIA_DIR, else .uploads/local (the same disk file the fixture route would serve). */
export function localMediaDir(): string {
  const configured = process.env.STUDIO_LOCAL_MEDIA_DIR?.trim();
  return path.resolve(process.cwd(), configured || path.join(".uploads", LOCAL_TIER));
}

/** The pipeline's projects folder (read-only for Studio), or null when none is configured. */
export function workspaceRoot(): string | null {
  ensureComputerSettings(); // this computer's films folder, when one is connected (lib/computer.ts)
  const configured = process.env.WORKSPACE_ROOT?.trim();
  return configured ? path.resolve(configured) : null;
}

/** True for a stored value of the local tier (`local/...`). */
export function isLocalTierPath(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(`${LOCAL_TIER}/`);
}

/** The stored value for a workspace file linked under a title: `local/<title_id>/ws/<slug>/<file>`. */
export function localStoredPath(titleId: string, slug: string, filename: string): string {
  const safeSlug = slug.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "film";
  return `${LOCAL_TIER}/${titleId}/ws/${safeSlug}/${safeFilename(filename)}`;
}

/** True when `abs` is WORKSPACE_ROOT or inside it (case as the OS compares it; another drive is never inside). */
function underWorkspace(abs: string): boolean {
  const ws = workspaceRoot();
  if (!ws) return false;
  const inside = (p: string) => {
    const rel = path.relative(ws, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (inside(abs)) return true;
  // A junction or symlink under the tier that leads into the workspace counts too.
  try {
    return inside(realpathSync.native(abs));
  } catch {
    return false;
  }
}

/**
 * A backslash, a colon or a NUL inside a stored path segment: Windows reads
 * `ws\..\..\<other>` as directories (path.resolve splits on both slashes),
 * and Next decodes `%5C` in a route segment before the handler sees it, so
 * a segment that is not literally `..` could still walk out of the title's
 * folder. Refused wherever a stored value meets the disk.
 */
export const BAD_PATH_CHARS = /[\\:\0]/;

/**
 * The same for ONE segment of a route path, where a slash is bad too: Next
 * decodes `%2F` inside a catch-all segment as well, so `x/../../<other>`
 * arrives as one segment that is not literally `..` and yet walks into
 * another title's folder once the segments are joined.
 */
export const BAD_SEGMENT_CHARS = /[\\/:\0]/;

/** The segments of a stored value, or null when one is empty, a dot segment or carries a bad character. */
function storedSegments(stored: string): string[] | null {
  const segments = stored.split("/");
  if (segments.some((s) => !s || s === "." || s === ".." || BAD_SEGMENT_CHARS.test(s))) return null;
  return segments;
}

/**
 * The absolute disk file behind a local-tier value, in both modes. Refuses
 * anything else: a bucket path, a value that would escape the tier (`..`,
 * an absolute segment, a backslash or colon inside a segment) or one that
 * resolves into WORKSPACE_ROOT — the pipeline's files are read through their
 * links only, never in place. The resolved file must sit under the title id
 * the value names, which is what the media route authorized on.
 */
export function localPathOf(stored: string): string {
  if (!isLocalTierPath(stored)) throw invalid("not a local-tier media path");
  const segments = storedSegments(stored.slice(LOCAL_TIER.length + 1));
  if (!segments || segments.length < 2) throw invalid("invalid media path");
  const root = localMediaDir();
  const abs = path.resolve(root, ...segments);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw invalid("invalid media path");
  if (rel.split(path.sep)[0] !== segments[0]) throw invalid("invalid media path");
  if (underWorkspace(abs)) throw invalid("the workspace is read-only: a media path may not point into WORKSPACE_ROOT");
  return abs;
}

export type LocalLink = { abs: string; how: "linked" | "copied" | "existing" };

/**
 * Snapshot a file into the local tier: a hardlink (the same volume; the
 * pipeline's later os.replace leaves the link on the old bytes), a copy only
 * when the volumes differ (EXDEV). The source is only stat'ed here — never
 * opened — unless that one fallback runs; any other link error (EPERM,
 * EBUSY, ENOSPC …) is rethrown, because a copy would hold the original open
 * for its whole length, which is exactly what a running render cannot
 * survive; the import fails and is retried instead. Idempotent: a target
 * already there with the same size is the snapshot; one with another size
 * is refused (the stored name carries the hash, so that is a caller's
 * mistake, not a race to win).
 */
export function linkIntoLocalTier(srcAbs: string, stored: string): LocalLink {
  const abs = localPathOf(stored);
  const src = path.resolve(srcAbs);
  const source = statSync(src, { throwIfNoEntry: false });
  if (!source?.isFile()) throw invalid(`source file not found: ${path.basename(src)}`);
  const existing = statSync(abs, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isFile() && existing.size === source.size) return { abs, how: "existing" };
    throw invalid(`${stored} already exists with a different size`);
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  try {
    linkSync(src, abs);
    return { abs, how: "linked" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const raced = statSync(abs, { throwIfNoEntry: false });
      if (raced?.isFile() && raced.size === source.size) return { abs, how: "existing" };
      throw invalid(`${stored} already exists with a different size`);
    }
    if (code !== "EXDEV") throw e;
    copyFileSync(src, abs);
    return { abs, how: "copied" };
  }
}

const SIGNED_URL_SECONDS = 60 * 60;

/** Keep the extension, drop anything a path or a storage key would choke on. */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._一-鿿-]+/g, "_").replace(/^\.+/, "");
  return cleaned || "file";
}

/**
 * The object name for a partner-uploaded finished ad (decision 2026-09-24).
 * CONTENT-ADDRESSED on purpose: storagePath is <title>/<episode>/<name> and
 * putObject upserts, so a bare caller filename would let a second `ad.mp4`
 * overwrite the first clip's bytes — its recorded SHA-256 would then fail the
 * launch re-verification and silently drop an approved ad — and would let an
 * ad sharing the episode video's name overwrite the master. Identical bytes
 * intentionally reuse one object, which makes a genuine re-upload idempotent.
 */
export function uploadedClipFilename(sha256: string, originalName: string): string {
  return `upload-${sha256.slice(0, 16)}-${safeFilename(originalName)}`;
}

export function storagePath(titleId: string, episodeId: string, filename: string): string {
  return `${titleId}/${episodeId}/${safeFilename(filename)}`;
}

/** The app URL that serves a stored path, or null when there is nothing stored. */
export function mediaUrl(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return `/api/media/${stored.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The absolute file under .uploads/ for a stored path. The same rules as
 * `localPathOf`: no empty or dot segment, no backslash, colon or NUL, and
 * the resolved file must sit under the first segment the value names (the
 * title id the media route authorized on) — staying under .uploads/ is not
 * enough, since the local tier and every other title live there too. A
 * local-tier value resolves through `localPathOf` instead (the tier may
 * live outside .uploads/).
 */
export function resolveUploadPath(stored: string): string {
  if (isLocalTierPath(stored)) return localPathOf(stored);
  const segments = storedSegments(stored);
  if (!segments) throw invalid("invalid media path");
  const root = uploadsDir();
  const abs = path.resolve(root, ...segments);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw invalid("invalid media path");
  }
  if (rel.split(path.sep)[0] !== segments[0]) throw invalid("invalid media path");
  return abs;
}

async function putObject(stored: string, bytes: Uint8Array, contentType: string | undefined): Promise<string> {
  // The local tier is a disk folder in both modes (a Studio-made film asset lands beside the linked ones).
  if (dataSource() === "fixture" || isLocalTierPath(stored)) {
    const abs = resolveUploadPath(stored);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    return stored;
  }
  // Storage writes run as the service role (CLAUDE.md allows it for storage
  // helpers): the caller's authorization was checked by the data layer, and
  // the render step and the launch engine run with no request cookie at all.
  const { createServiceSupabase } = await import("@/lib/supabase/server");
  const supabase = createServiceSupabase();
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(stored, bytes, { contentType, upsert: true });
  if (error) throw invalid(`storage upload failed: ${error.message}`);
  return stored;
}

/** Any stored file (a rendered ad, a cover). Returns the storage path. */
export function putStoredBytes(stored: string, bytes: Uint8Array, contentType: string): Promise<string> {
  return putObject(stored, bytes, contentType);
}

/**
 * The bytes behind a stored path: the file under .uploads/ in fixture mode,
 * a download from the private bucket in supabase mode, a local-tier file
 * from disk (or from its cloud copy when this computer lacks it). The launch
 * engine reads the rendered ad through here to upload it to TikTok, and the
 * render step reads the episode source through here.
 */
export async function readStoredBytes(stored: string): Promise<Buffer> {
  if (isLocalTierPath(stored)) return readFile(await ensureLocalTierFile(stored));
  if (dataSource() === "fixture") return readFile(resolveUploadPath(stored));
  const { createServiceSupabase } = await import("@/lib/supabase/server");
  const supabase = createServiceSupabase();
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).download(stored);
  if (error || !data) throw invalid(`storage download failed: ${error?.message ?? "no data"}`);
  return Buffer.from(await data.arrayBuffer());
}

/** The delivered subtitle / script file, kept for reference beside the parsed rows. Returns the storage path. */
export function uploadImport(titleId: string, episodeId: string, filename: string, bytes: Uint8Array): Promise<string> {
  return putObject(storagePath(titleId, episodeId, filename), bytes, "text/plain; charset=utf-8");
}

/** The optional episode video. Returns the storage path for episodes.video_path. */
export function uploadMedia(
  titleId: string,
  episodeId: string,
  filename: string,
  bytes: Uint8Array,
  contentType?: string
): Promise<string> {
  return putObject(storagePath(titleId, episodeId, filename), bytes, contentType ?? "video/mp4");
}

/**
 * Where the bytes are right now: a one-hour signed URL in supabase mode (the
 * media route 302s to it), the /api/media path itself in fixture mode and for
 * a local-tier value in either mode (the route streams the file).
 */
export async function signedMediaUrl(stored: string): Promise<string> {
  if (dataSource() === "fixture" || isLocalTierPath(stored)) return mediaUrl(stored) as string;
  const { createServerSupabase } = await import("@/lib/supabase/server");
  const supabase = createServerSupabase();
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(stored, SIGNED_URL_SECONDS);
  if (error || !data) throw invalid(`signed url failed: ${error?.message ?? "no data"}`);
  return data.signedUrl;
}

// ---- the cloud copy of the local tier (decision 2026-09-24, "two computers, one database") -------
//
// An imported film's files live on the computer that imported it (the local
// tier above). lib/cloud-copy.ts copies them to the bucket under the SAME
// key (`local/<title_id>/ws/<slug>/<file>`), so a computer without a file
// finds it by the value the row already holds: the media route sends the
// browser to a signed URL, and a reader that needs the bytes on disk (ffmpeg,
// the CrazyDramas upload, readStoredBytes) downloads it into its own local
// tier first (`ensureLocalTierFile`), checked against the SHA-256 prefix the
// file name carries. Only the files of imported films go there: nothing of
// the pipeline's folders, sources or work files. Service role throughout —
// the local/ keys sit outside the per-title folder policy, and every caller
// authorized on the title already. Fixture mode has no bucket: the local
// tier stays a disk folder there, as before.

export type CloudObject = { name: string; size: number };

export type CloudErrorCode = "too_big" | "exists" | "missing" | "failed";

export class CloudError extends Error {
  constructor(readonly code: CloudErrorCode, message: string) {
    super(message);
    this.name = "CloudError";
  }
}

/** The bucket as the cloud copy uses it; the Supabase one in live mode, a fake in the tests. */
export interface CloudStore {
  /** The files directly under `folder` (no recursion), with their sizes. */
  list(folder: string): Promise<CloudObject[]>;
  /** Upload a disk file to `key`; never overwrites (an existing key is CloudError `exists`). */
  upload(key: string, file: string, contentType: string): Promise<void>;
  /** Download `key` to the disk file `to` (the caller renames it into place); a missing key is CloudError `missing`. */
  download(key: string, to: string): Promise<void>;
  /** A signed URL for `key`, or null when the bucket has no such object. */
  signedUrl(key: string, seconds: number): Promise<string | null>;
}

/** A storage answer as a CloudError: 413 / "maximum allowed size" is too big, 409 exists, 404 missing. */
export function cloudErrorOf(error: { message?: string; status?: number; statusCode?: string | number }): CloudError {
  const message = error.message || "storage error";
  const status = Number(error.statusCode ?? error.status);
  if (status === 413 || /maximum allowed size|payload too large|too large/i.test(message)) return new CloudError("too_big", message);
  if (status === 409 || /already exists|duplicate/i.test(message)) return new CloudError("exists", message);
  if (status === 404 || /not found/i.test(message)) return new CloudError("missing", message);
  return new CloudError("failed", message);
}

function supabaseCloudStore(): CloudStore {
  const bucket = async () => {
    const { createServiceSupabase } = await import("@/lib/supabase/server");
    return createServiceSupabase().storage.from(MEDIA_BUCKET);
  };
  return {
    async list(folder) {
      const b = await bucket();
      const out: CloudObject[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await b.list(folder, { limit: 1000, offset });
        if (error) throw cloudErrorOf(error);
        for (const o of data ?? []) {
          if (o.id === null) continue; // a sub-folder
          out.push({ name: o.name, size: Number((o.metadata as { size?: number } | null)?.size ?? 0) });
        }
        if (!data || data.length < 1000) break;
      }
      return out;
    },
    async upload(key, file, contentType) {
      const bytes = await readFile(file);
      const { error } = await (await bucket()).upload(key, bytes, { contentType, upsert: false });
      if (error) throw cloudErrorOf(error);
    },
    async download(key, to) {
      const { data, error } = await (await bucket()).download(key);
      if (error || !data) throw cloudErrorOf(error ?? { message: "no data" });
      await writeFile(to, Buffer.from(await data.arrayBuffer()));
    },
    async signedUrl(key, seconds) {
      const { data, error } = await (await bucket()).createSignedUrl(key, seconds);
      if (error || !data) {
        if (error && cloudErrorOf(error).code !== "missing") throw cloudErrorOf(error);
        return null;
      }
      return data.signedUrl;
    },
  };
}

type CloudSlot = { store?: CloudStore | null };
const cloudSlot = (): CloudSlot => {
  const g = globalThis as unknown as { __studioCloudStore?: CloudSlot };
  if (!g.__studioCloudStore) g.__studioCloudStore = {};
  return g.__studioCloudStore;
};

/** For tests: a fake bucket (or null for none); undefined restores the real choice. */
export function setCloudStoreForTests(store: CloudStore | null | undefined): void {
  cloudSlot().store = store;
}

/** The bucket in live mode, null in fixture mode (no bucket; the local tier is the only copy). */
export function cloudStore(): CloudStore | null {
  const slot = cloudSlot();
  if (slot.store !== undefined) return slot.store;
  return dataSource() === "supabase" ? supabaseCloudStore() : null;
}

/** The first 8 hex of the SHA-256 a local-tier file name carries (`ep07-1a2b3c4d.mp4`), or null. */
export function sha8OfStored(stored: string): string | null {
  const m = stored.match(/-([0-9a-f]{8})\.[A-Za-z0-9]+$/);
  return m ? m[1] : null;
}

const inflight = new Map<string, Promise<string>>();

/**
 * The disk file behind a local-tier value, fetched from the cloud copy when
 * this computer does not have it: downloaded beside its final name, its
 * SHA-256 checked against the prefix in the name when there is one, then
 * renamed into place, so a half-written file is never read. Two readers of
 * one file share one download. Without a bucket (fixture) this is
 * `localPathOf`. A file in neither place is a plain `invalid`.
 */
export async function ensureLocalTierFile(stored: string): Promise<string> {
  const abs = localPathOf(stored);
  if (statSync(abs, { throwIfNoEntry: false })?.isFile()) return abs;
  const cloud = cloudStore();
  if (!cloud) return abs;
  const running = inflight.get(abs);
  if (running) return running;
  const job = (async () => {
    await mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.download-${process.pid}-${Date.now()}`;
    try {
      await cloud.download(stored, tmp);
      const want = sha8OfStored(stored);
      if (want) {
        const hash = createHash("sha256");
        await new Promise<void>((resolve, reject) => {
          createReadStream(tmp).on("data", (c) => hash.update(c)).on("end", () => resolve()).on("error", reject);
        });
        if (!hash.digest("hex").startsWith(want)) throw invalid(`the cloud copy of ${path.basename(abs)} does not match its name; it was not used`);
      }
      await rename(tmp, abs);
      return abs;
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (e instanceof CloudError && e.code === "missing") {
        throw invalid(`${path.basename(abs)} is only on the computer that imported the film, and it is not in the cloud yet`);
      }
      throw e;
    } finally {
      inflight.delete(abs);
    }
  })();
  inflight.set(abs, job);
  return job;
}
