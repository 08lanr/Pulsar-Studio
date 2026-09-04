// Global timing offset: shift every cue of the episode by a signed number
// of milliseconds (lib/subtitle-timing rules — clamp at 0, keep durations,
// trim overlaps clamping introduces). Distinct from /retime, which repairs
// stamps trapped in text. On an approved version the edit forks and
// refinalizes through the shared repair tail, so exports and burns pick up
// the shifted timeline without ever mutating a frozen snapshot — and the
// offset is applied to rows exactly once, so repeated exports never
// accumulate it.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { refreshApprovalAfterRepair } from "../../../../../_lib/refinalize";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../../_lib/handler";

const Body = z.object({
  offset_ms: z.number().int().refine((v) => v !== 0, "offset_ms must be non-zero").refine((v) => Math.abs(v) <= 60_000, "offset_ms must stay within one minute"),
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
    const r = await data.applyEpisodeTimingOffset(g.session, params.id, n, p.data.offset_ms);
    const outcome = await refreshApprovalAfterRepair(data, g.session, params.id, n);
    return NextResponse.json({ ...r, ...outcome });
  });
}
