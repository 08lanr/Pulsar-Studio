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
//   local     a local-tier path, `local/<title_id>/ws/<slug>/<file>` (an
//             imported episode's hardlink, decision 2026-09-22): the title
//             id is the SECOND segment, and the file is streamed from disk
//             with Range in both modes — nothing of the local tier is in the
//             bucket, so there is no signed URL to send the browser to.

import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { requireSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { isLocalTierPath, localPathOf, resolveUploadPath, signedMediaUrl } from "@/lib/data/storage";
import { dataSource } from "@/lib/data-source";
import { handle } from "../../titles/_lib/handler";
import { streamFile, titleIdOfMediaPath } from "../_lib/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return handle(req, async () => {
    const g = await requireSession();
    if (g.response) return g.response;

    const segments = params.path ?? [];
    const titleId = titleIdOfMediaPath(segments);
    if (!titleId) return apiError("Not found", undefined, 404);
    const stored = segments.join("/");
    if (!(await canRead(g.session, titleId))) return apiError("Not found", undefined, 404);

    if (isLocalTierPath(stored)) {
      // The local tier is a disk folder in both modes; localPathOf refuses a
      // path that leaves the tier or points into the read-only workspace.
      return streamFile(req, localPathOf(stored));
    }
    if (dataSource() === "supabase") {
      return NextResponse.redirect(await signedMediaUrl(stored), 302);
    }
    return streamFile(req, resolveUploadPath(stored));
  });
}

/** Players probe with HEAD before the first Range request; answer with the headers only. */
export async function HEAD(req: NextRequest, ctx: { params: { path: string[] } }) {
  const res = await GET(req, ctx);
  if (res.body) await res.body.cancel().catch(() => undefined);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
