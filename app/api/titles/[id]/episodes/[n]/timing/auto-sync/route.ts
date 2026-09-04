// Auto-sync from audio: ask the configured alignment provider (lib/align)
// for per-cue timing proposals against the episode's own audio, keeping
// the written Chinese text untouched. The response is a REVIEWABLE diff —
// nothing is applied here; the studio's review UI accepts or rejects
// per cue and persists accepted rows through /timing/cues. With no
// provider configured this returns the honest unavailable state.

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { alignmentAvailability, alignmentProvider } from "@/lib/align";
import { DataError, getData } from "@/lib/data";
import { episodeNumber, handle, isResponse } from "../../../../../_lib/handler";

export const maxDuration = 300;

/** Availability probe for the studio's disabled state. */
export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    return NextResponse.json(alignmentAvailability());
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;

    const provider = alignmentProvider();
    if (!provider) {
      const a = alignmentAvailability();
      return NextResponse.json({ available: false, reason: a.available ? "" : a.reason }, { status: 409 });
    }

    const wb = await getData().getWorkbench(g.session, params.id, n);
    if (!wb.episode.video_path) throw new DataError("invalid", "auto-sync needs the episode's video for its audio track");
    const cues = wb.lines
      .filter((l) => !l.merged_into_id && l.start_ms !== null && l.end_ms !== null)
      .map((l) => ({ line_id: l.id, start_ms: l.start_ms!, end_ms: l.end_ms!, text_zh: l.text_zh }));
    if (!cues.length) throw new DataError("invalid", "no timed cues to align");

    const proposals = await provider.alignCues({ videoPath: wb.episode.video_path, cues });
    return NextResponse.json({ available: true, provider: provider.name, proposals });
  });
}
