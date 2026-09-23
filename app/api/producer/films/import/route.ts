import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { ImportRequestSchema, startImport } from "@/lib/film-import/import";
import { handle, parseJson } from "../../../titles/_lib/handler";

// POST: import a READY film as a title of the caller's company, or update an
// imported one (decision 2026-09-22; spec §3.6). The approver only, like a
// launch. The route checks the caller and refuses what cannot start (not
// READY, already imported, never imported, already running: 409 / 404); the
// title is created now and the episodes, transcripts and assets follow in
// the background as the system actor with the caller as the creator. The
// page follows the film's row on GET /api/producer/films.

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "approver" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, ImportRequestSchema);
    if (parsed.response) return parsed.response;
    const started = await startImport(g.session, parsed.data, { producer_id: g.session.producerId!, created_by: g.session.userId });
    return NextResponse.json(started, { status: 202 });
  });
}
