// Regenerate / shorten / free instruction on one line. Never deduplicated
// (each call is a new job); the rewritten text replaces the line with
// authored_by 'ai' and the job's model so the chip stays honest.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { runRewrite } from "@/lib/jobs";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../../../_lib/handler";

const Body = z.object({ instruction: z.string().trim().min(1).max(2000) });

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
    const r = await runRewrite(g.session, params.adaptedLineId, p.data.instruction, {
      titleId: params.id,
      episodeNumber: n,
    });
    return NextResponse.json({ line: r.line, job: r.job });
  });
}
