import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireStaff } from "@/lib/auth";
import { listFilms } from "@/lib/film-import/import";
import { handle } from "../../titles/_lib/handler";

// Staff mirror of GET /api/producer/films: the workspace's films with their
// states for the company named by ?producer_id (staff may not act in the
// producer portal, so the import desk has one of its own). Without a company
// the states are the disk's alone.

const Query = z.object({ producer_id: z.string().uuid().nullish() });

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = Query.safeParse({ producer_id: req.nextUrl.searchParams.get("producer_id") || null });
    if (!parsed.success) return apiError("Invalid request", parsed.error.flatten(), 400);
    return NextResponse.json(await listFilms(g.session, parsed.data.producer_id ?? null));
  });
}
