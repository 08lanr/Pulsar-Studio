import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { requireProducer } from "@/lib/auth";
import { readPoster } from "@/lib/film-import/import";
import { handle } from "../../../titles/_lib/handler";

// GET ?ref=<film>/poster/final/<file>: the poster of a film that is not
// imported yet, for the listing's thumbnail. Once imported, the title's
// cover is served by GET /api/media/... from the local tier. Only a poster
// path under the workspace root resolves; a poster is not an episode, so
// reading it in place is allowed.

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    const ref = req.nextUrl.searchParams.get("ref") ?? "";
    const poster = await readPoster(ref);
    if (!poster) return apiError("Not found", undefined, 404);
    return new NextResponse(new Uint8Array(poster.bytes), { headers: { "Content-Type": poster.contentType, "Cache-Control": "private, max-age=300" } });
  });
}
