// Render the episode's video with the adapted English subtitles burned in
// (lib/subtitle-video.ts) and hand back a download URL. Runs inline; a
// minute of 720p takes ~20-40s and the button spins while it does.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { renderSubtitledVideo } from "@/lib/subtitle-video";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../_lib/handler";

const Body = z.object({
  layout: z.enum(["en", "en_zh"]).default("en"),
  font: z.enum(["sans", "serif"]).default("sans"),
  size: z.enum(["s", "m", "l"]).default("m"),
  position: z.enum(["bottom", "top"]).default("bottom"),
  merge: z.boolean().default(false),
});

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const r = await renderSubtitledVideo(g.session, params.id, n, p.data);
    return NextResponse.json(r);
  });
}
