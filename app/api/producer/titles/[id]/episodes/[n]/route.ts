// The bilingual review of one episode, rendered from the frozen snapshot of
// the in_review (else approved) version: per scene the Chinese source, the
// back-translation, the English and the zh rationale, major changes first,
// with the decisions made so far. A title that is not theirs, or an episode
// with nothing submitted yet, is a 404 either way.

import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { episodeNumber, handle, isResponse } from "../../../../../titles/_lib/handler";

export async function GET(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const payload = await getData().getProducerReview(g.session, params.id, n);
    return NextResponse.json(payload);
  });
}
