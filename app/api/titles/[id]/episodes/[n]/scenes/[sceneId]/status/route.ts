// The staff working status of a scene: 'approved' is the checkpoint the
// episode submit requires on every scene; 'draft' reopens it.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../../../_lib/handler";

const Body = z.object({ status: z.enum(["draft", "approved"]) });

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; n: string; sceneId: string } }
) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const scene = await getData().setSceneStatus(g.session, params.sceneId, p.data.status);
    return NextResponse.json({ scene });
  });
}
