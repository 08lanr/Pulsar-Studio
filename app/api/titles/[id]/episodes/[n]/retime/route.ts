// Repair a pre-2026-09-05 ingest whose [hh:mm:ss] stamps sat inside the
// line text: lift them into real timecodes (data layer), then — when the
// episode is already finalized — fork and refinalize so the frozen snapshot
// the exports read carries the times too. Refinalize runs the same QC gate
// as the finalize route; on QC errors the fork is left as a draft for the
// producer to review, and the response says so.

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { refreshApprovalAfterRepair } from "../../../../_lib/refinalize";
import { episodeNumber, handle, isResponse } from "../../../../_lib/handler";

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const data = getData();

    const { timed } = await data.retimeEpisodeFromStamps(g.session, params.id, n);
    const outcome = await refreshApprovalAfterRepair(data, g.session, params.id, n);
    return NextResponse.json({ timed, ...outcome });
  });
}
