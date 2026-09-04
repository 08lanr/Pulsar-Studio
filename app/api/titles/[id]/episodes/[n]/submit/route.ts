// Staff "Approve episode": submit_version() on the episode's current draft.
// The data layer requires every scene approved and every changed line to
// carry rationale_zh + back_translation_zh, writes the frozen snapshot and
// its sha256, moves draft -> in_review (now visible to the partner) and
// inserts the audit row. No draft -> 409 frozen / 404.

import { NextResponse, type NextRequest } from "next/server";
import { DataError, getData } from "@/lib/data";
import { requireStaff } from "@/lib/auth";
import { episodeNumber, handle, isResponse } from "../../../../_lib/handler";

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const data = getData();
    const wb = await data.getWorkbench(g.session, params.id, n);
    if (!wb.version) throw new DataError("not_found", "no version for this episode yet; run a first pass first");
    const version = await data.submitVersion(g.session, wb.version.id);
    return NextResponse.json({ version });
  });
}
