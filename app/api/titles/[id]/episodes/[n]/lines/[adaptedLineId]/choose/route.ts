// Pick one alternative: its text lands on the adapted line (authored_by
// 'editor', the AI first pass retained in ai_*), the alternative is marked
// chosen. Frozen versions refuse (409).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../../../_lib/handler";

const Body = z.object({ alternative_id: z.string().uuid() });

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; n: string; adaptedLineId: string } }
) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const line = await getData().chooseAlternative(g.session, params.adaptedLineId, p.data.alternative_id);
    return NextResponse.json({ line });
  });
}
