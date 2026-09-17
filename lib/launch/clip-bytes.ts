// One bounded reader for a company-authorized clip file, shared by the ZIP
// download (lib/launch/clip-download.ts) and the organic publishing engine
// (lib/meta/publish.ts). The caller has already checked who may read the path;
// this module only enforces the byte ceilings and never widens them.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { dataSource } from "@/lib/data-source";
import { invalid, notFound } from "@/lib/data/errors";
import { MEDIA_BUCKET, resolveUploadPath } from "@/lib/data/storage";

/** One finished clip, and one ZIP of up to 30 of them. */
export const MAX_CLIP_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw invalid("Selected clips exceed the download limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks, length);
}

/** A bounded read of a company-authorized storage key, including in Supabase mode. */
export async function readClipBytes(path: string, limit: number): Promise<Buffer> {
  if (dataSource() === "fixture") {
    const abs = resolveUploadPath(path);
    const size = (await stat(abs)).size;
    if (size > limit) throw invalid("Selected clips exceed the download limit.");
    return collect(Readable.toWeb(createReadStream(abs)) as ReadableStream<Uint8Array>, limit);
  }
  const { createServiceSupabase } = await import("@/lib/supabase/server");
  const { data, error } = await createServiceSupabase().storage.from(MEDIA_BUCKET).createSignedUrl(path, 60);
  if (error || !data) throw notFound("Finished clip");
  const response = await fetch(data.signedUrl, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!response.ok || !response.body) throw notFound("Finished clip");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) { await response.body.cancel(); throw invalid("Selected clips exceed the download limit."); }
  return collect(response.body, limit);
}

/**
 * A short-lived public URL for a stored clip. Instagram fetches the file
 * itself, so a Reel container needs one; nothing else does. Fixture mode mints
 * nothing — the fake accepts any URL and never leaves the process.
 */
export async function signedClipUrl(path: string, seconds = 900): Promise<string> {
  if (dataSource() === "fixture") return `fixture://clip/${encodeURIComponent(path)}`;
  const { createServiceSupabase } = await import("@/lib/supabase/server");
  const { data, error } = await createServiceSupabase().storage.from(MEDIA_BUCKET).createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) throw notFound("Finished clip");
  return data.signedUrl;
}
