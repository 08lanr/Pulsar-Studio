// Transcribe a script-less episode (decision 2026-09-15): the explicit
// Materials-page action behind lib/asr.ts. Same-origin guard, member role
// (the data layer scopes to the producer's own titles), no body to parse.
// Unavailability is answered BEFORE any work with code 'asr_unavailable' so
// the portal shows its own words, not a server sentence. Runs inline like
// the subtitled-video render; a minute of audio takes well under the cap.

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { asrAvailability, runTranscribeEpisode } from "@/lib/asr";
import { episodeNumber, handle, isResponse } from "../../../../_lib/handler";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const avail = asrAvailability();
    if (!avail.available) {
      return NextResponse.json({ error: avail.reason, code: "asr_unavailable" }, { status: 503 });
    }
    const r = await runTranscribeEpisode(g.session, params.id, n);
    return NextResponse.json(r, { status: 201 });
  });
}
