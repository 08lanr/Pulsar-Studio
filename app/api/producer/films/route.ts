import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { listFilms } from "@/lib/film-import/import";
import { handle } from "../../titles/_lib/handler";

// The films under the pipeline's workspace as this company sees them
// (decision 2026-09-22, "the workspace import"): every film with its scan
// state, IMPORTED / K_CHANGED against the company's own import records, and
// the progress of an import that is running. The scan stats files and reads
// JSON; no episode is opened, nothing is hashed here (the update run hashes
// the links). Any producer role may look; importing needs the approver.

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    return NextResponse.json(await listFilms(g.session, g.session.producerId!));
  });
}
