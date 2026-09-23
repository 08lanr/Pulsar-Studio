import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { requireStaff } from "@/lib/auth";
import { readPoster } from "@/lib/film-import/import";
import { handle } from "../../../titles/_lib/handler";

// Staff mirror of GET /api/producer/films/poster: a film's poster under the
// workspace, for the import desk's thumbnail before the film is imported.

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const ref = req.nextUrl.searchParams.get("ref") ?? "";
    const poster = await readPoster(ref);
    if (!poster) return apiError("Not found", undefined, 404);
    return new NextResponse(new Uint8Array(poster.bytes), { headers: { "Content-Type": poster.contentType, "Cache-Control": "private, max-age=300" } });
  });
}
