// Serves a stored episode file (the video beside the workbench, or the
// delivered subtitle file). The path is the storage path the episode row
// holds, <title_id>/<folder>/<file>, so the first segment names the title
// and access is canReadTitle on it: staff read everything, a producer only
// their own titles (checked through the producer-scoped title list, which
// is the same rule RLS applies in supabase mode).
//
//   fixture   streams the file from .uploads/ with HTTP Range support, which
//             <video> needs to seek (a player that cannot seek is a demo
//             that cannot jump to a line)
//   supabase  302 to a one-hour signed URL on the private bucket; the
//             browser fetches bytes from Supabase directly, Range included

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { requireSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resolveUploadPath, signedMediaUrl } from "@/lib/data/storage";
import { dataSource } from "@/lib/data-source";
import { handle } from "../../titles/_lib/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  srt: "text/plain; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  ass: "text/plain; charset=utf-8",
  ssa: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

function contentTypeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** True when the caller may read the title; a producer never learns whether a foreign id exists. */
async function canRead(session: Session, titleId: string): Promise<boolean> {
  const data = getData();
  if (session.kind === "staff") {
    await data.getTitle(session, titleId); // throws not_found -> 404
    return true;
  }
  const titles = await data.getProducerTitles(session);
  return titles.some((t) => t.id === titleId);
}

/** `bytes=start-end` (either side optional) against a file of `size` bytes; null = no / unusable header. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
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

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return handle(req, async () => {
    const g = await requireSession();
    if (g.response) return g.response;

    const segments = params.path ?? [];
    if (segments.length < 2 || segments.some((s) => !s || s === "." || s === "..")) {
      return apiError("Not found", undefined, 404);
    }
    const stored = segments.join("/");
    if (!(await canRead(g.session, segments[0]))) return apiError("Not found", undefined, 404);

    if (dataSource() === "supabase") {
      return NextResponse.redirect(await signedMediaUrl(stored), 302);
    }

    const abs = resolveUploadPath(stored);
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
  });
}

/** Players probe with HEAD before the first Range request; answer with the headers only. */
export async function HEAD(req: NextRequest, ctx: { params: { path: string[] } }) {
  const res = await GET(req, ctx);
  if (res.body) await res.body.cancel().catch(() => undefined);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
