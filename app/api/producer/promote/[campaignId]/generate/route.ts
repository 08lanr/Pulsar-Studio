import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { generateAds } from "@/lib/promote/generate";
import { handle } from "@/app/api/titles/_lib/handler";

// Generate the round's ads: concept rows now, finished files in the
// background when ffmpeg is present (the page polls while the campaign is
// `generating`), then review opens (lib/promote/generate.ts).

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const out = await generateAds(g.session, params.campaignId);
    return NextResponse.json({ creatives: out.creatives, rendering: out.rendering });
  });
}
