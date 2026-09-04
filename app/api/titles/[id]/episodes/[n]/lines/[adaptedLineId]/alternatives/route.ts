// Alternative rewrites for one line, as a new batch: two takes in different
// directions by default, or - with `direction` in the body - ONE more take
// that leans into that tag ("take it another direction"). `alternatives` is
// every alternative on the line afterwards (the UI re-renders the list);
// `added` is what this call produced (empty when the batch already existed).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireMember } from "@/lib/auth";
import { demoReplayActive, replayAlternatives } from "@/lib/demo-replay";
import { runAlternatives } from "@/lib/jobs";
import { AdaptTagSchema } from "@/lib/prompts/shared";
import { episodeNumber, handle, isResponse } from "../../../../../../_lib/handler";

const Body = z.object({ direction: AdaptTagSchema.nullish() });

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; n: string; adaptedLineId: string } }
) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const body = await req.json().catch(() => ({}));
    const parsed = Body.safeParse(body ?? {});
    if (!parsed.success) return apiError("Invalid request", parsed.error.flatten(), 400);
    const opts = { direction: parsed.data.direction ?? null };

    // Fixture mode serves the canned batch; `available: false` lets the UI
    // say "no more options in demo mode" instead of pretending to generate.
    if (demoReplayActive()) {
      const r = await replayAlternatives(g.session, params.adaptedLineId, { titleId: params.id, episodeNumber: n }, opts);
      return NextResponse.json({ alternatives: r.all, added: r.alternatives, available: r.available });
    }

    const r = await runAlternatives(g.session, params.adaptedLineId, { titleId: params.id, episodeNumber: n }, opts);
    return NextResponse.json({
      alternatives: r.all,
      added: r.alternatives,
      available: true,
      ...(g.session.kind === "staff" ? { job: r.job } : {}),
    });
  });
}
