// 2-3 alternative rewrites for one line, as a new batch. `alternatives` is
// every alternative on the line afterwards (the UI re-renders the list);
// `added` is what this call produced (empty when the batch already existed).

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { demoReplayActive, replayAlternatives } from "@/lib/demo-replay";
import { runAlternatives } from "@/lib/jobs";
import { episodeNumber, handle, isResponse } from "../../../../../../_lib/handler";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; n: string; adaptedLineId: string } }
) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;

    // Fixture mode serves the canned batch; `available: false` lets the UI
    // say "no more options in demo mode" instead of pretending to generate.
    if (demoReplayActive()) {
      const r = await replayAlternatives(g.session, params.adaptedLineId, { titleId: params.id, episodeNumber: n });
      return NextResponse.json({ alternatives: r.all, added: r.alternatives, available: r.available });
    }

    const r = await runAlternatives(g.session, params.adaptedLineId, { titleId: params.id, episodeNumber: n });
    return NextResponse.json({ alternatives: r.all, added: r.alternatives, job: r.job, available: true });
  });
}
