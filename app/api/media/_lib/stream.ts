// The pure half of GET /api/media/[...path]: which title a stored path
// belongs to, and how one disk file is streamed with HTTP Range support.
// Lives beside the route in a private folder (Next never routes `_lib`, and
// a route file may export only Next's own fields) so the Range rules and the
// local-tier path shape can be tested without a session cookie.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { LOCAL_TIER } from "@/lib/data/storage";

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  json: "application/json",
  srt: "text/plain; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  ass: "text/plain; charset=utf-8",
  ssa: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Which title a stored path belongs to, for the access check: the first
 * segment of a bucket path (`<title_id>/<folder>/<file>`), the second of a
 * local-tier one (`local/<title_id>/ws/<slug>/<file>`, decision 2026-09-22).
 * Null when the shape is wrong (too short, an empty or dot segment).
 */
export function titleIdOfMediaPath(segments: string[]): string | null {
  if (segments.some((s) => !s || s === "." || s === "..")) return null;
  const local = segments[0] === LOCAL_TIER;
  if (segments.length < (local ? 3 : 2)) return null;
  return local ? segments[1] : segments[0];
}

/** `bytes=start-end` (either side optional) against a file of `size` bytes; null = no / unusable header. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // suffix range: the last N bytes
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

/**
 * Stream one disk file: 206 with Content-Range for a satisfiable Range
 * header, 416 for an unusable one, 200 whole otherwise; 404 when there is
 * no such file. Shared by the fixture path and the local tier.
 */
export async function streamFile(req: NextRequest, abs: string): Promise<NextResponse> {
  const info = await stat(abs).catch(() => null);
  if (!info || !info.isFile()) return apiError("Not found", undefined, 404);
  const size = info.size;
  const type = contentTypeFor(abs);

  const base = new Headers({
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0",
    "Last-Modified": info.mtime.toUTCString(),
  });

  const rangeHeader = req.headers.get("range");
  const range = parseRange(rangeHeader, size);
  if (rangeHeader && !range) {
    base.set("Content-Range", `bytes */${size}`);
    return new NextResponse(null, { status: 416, headers: base });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  base.set("Content-Length", String(end - start + 1));
  if (range) base.set("Content-Range", `bytes ${start}-${end}/${size}`);

  // Node stream -> web stream: what a Response body takes.
  const body = Readable.toWeb(createReadStream(abs, { start, end })) as unknown as ReadableStream;
  return new NextResponse(body, { status: range ? 206 : 200, headers: base });
}
