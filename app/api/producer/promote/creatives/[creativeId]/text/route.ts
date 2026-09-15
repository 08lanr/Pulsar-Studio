// The producer writes the TikTok ad text of an ad in review (2026-09-15:
// "where would the hook go?"). It is the one string TikTok shows above
// the video; it is not drawn on the picture. Reviewer role or above; the
// data layer refuses once the round is approved (the manifest froze it).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { AD_TEXT_MAX } from "@/lib/clips/creatives";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

const schema = z.object({ hook: z.string().trim().min(1).max(AD_TEXT_MAX) });

export async function POST(req: NextRequest, { params }: { params: { creativeId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ creative: await getData().setPromoCreativeText(g.session, params.creativeId, parsed.data.hook) });
  });
}
