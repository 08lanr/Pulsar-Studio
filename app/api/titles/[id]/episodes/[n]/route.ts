// The Adaptation workbench payload: episode, scenes, lines, the current
// version with its adapted lines and alternatives, the partner's decisions
// on it, the video URL and whether AI is available.

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { episodeNumber, handle, isResponse } from "../../../_lib/handler";

export async function GET(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const payload = await getData().getWorkbench(g.session, params.id, n);
    return NextResponse.json(payload);
  });
}
