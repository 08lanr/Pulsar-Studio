// Where uploaded files live and how they are served. One bucket in V1,
// `studio-media` (private), paths `<title_id>/<episode_id>/<file>`; fixture
// mode writes the same relative paths under .uploads/ (gitignored) so a demo
// with a video works with no Supabase project. The stored value on the row
// (episodes.video_path, episodes.source_script_path) is always the relative
// storage path — never a URL, never an absolute filesystem path — and
// GET /api/media/[...path] turns it into bytes (fixture: Range streaming from
// .uploads; supabase: 302 to a signed URL) after canReadTitle.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataSource } from "@/lib/data-source";
import { invalid } from "./errors";

export const MEDIA_BUCKET = "studio-media";

/** Fixture-mode root; resolved per call so a script run from another cwd still lands in the repo. */
export function uploadsDir(): string {
  return path.join(process.cwd(), ".uploads");
}

const SIGNED_URL_SECONDS = 60 * 60;

/** Keep the extension, drop anything a path or a storage key would choke on. */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._一-鿿-]+/g, "_").replace(/^\.+/, "");
  return cleaned || "file";
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
 * The absolute file under .uploads/ for a stored path. Rejects anything that
 * would escape the root (`..`, absolute segments) so the media route cannot
 * be pointed at the rest of the disk.
 */
export function resolveUploadPath(stored: string): string {
  const root = uploadsDir();
  const abs = path.resolve(root, stored);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw invalid("invalid media path");
  }
  return abs;
}

async function putObject(stored: string, bytes: Uint8Array, contentType: string | undefined): Promise<string> {
  if (dataSource() === "fixture") {
    const abs = resolveUploadPath(stored);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    return stored;
  }
  const { createServerSupabase } = await import("@/lib/supabase/server");
  const supabase = createServerSupabase();
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(stored, bytes, { contentType, upsert: true });
  if (error) throw invalid(`storage upload failed: ${error.message}`);
  return stored;
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
 * media route 302s to it), the /api/media path itself in fixture mode (the
 * route streams the file).
 */
export async function signedMediaUrl(stored: string): Promise<string> {
  if (dataSource() === "fixture") return mediaUrl(stored) as string;
  const { createServerSupabase } = await import("@/lib/supabase/server");
  const supabase = createServerSupabase();
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(stored, SIGNED_URL_SECONDS);
  if (error || !data) throw invalid(`signed url failed: ${error?.message ?? "no data"}`);
  return data.signedUrl;
}
