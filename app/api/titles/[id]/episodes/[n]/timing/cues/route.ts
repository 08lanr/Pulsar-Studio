// Millisecond-precise edits to individual cues, batched: the studio's
// timing editor keeps edits pending client-side (undo/reset costs nothing)
// and saves them here in one call. Validation is per cue (start >= 0, end
// after start; overlaps are advisory and QC's business). On an approved
// version the batch forks and refinalizes through the shared repair tail.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { refreshApprovalAfterRepair } from "../../../../../_lib/refinalize";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../../_lib/handler";

const Body = z.object({
  updates: z
    .array(
      z.object({
        line_id: z.string().uuid(),
        start_ms: z.number().int().min(0),
        end_ms: z.number().int().positive(),
      })
    )
    .min(1)
    .max(500),
});

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const data = getData();
    const r = await data.updateLineTimings(g.session, params.id, n, p.data.updates);
    const outcome = await refreshApprovalAfterRepair(data, g.session, params.id, n);
    return NextResponse.json({ ...r, ...outcome });
  });
}
