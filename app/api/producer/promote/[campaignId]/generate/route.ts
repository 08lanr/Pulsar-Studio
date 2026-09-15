import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { generateAds } from "@/lib/promote/generate";
import { handle } from "@/app/api/titles/_lib/handler";

// Generate the round's ads from the title's finished clips, add the clips
// that finished since to an open round, or start cutting when there is
// nothing yet — the page polls in that case (lib/promote/generate.ts).

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const out = await generateAds(g.session, params.campaignId);
    return NextResponse.json(out, { status: out.cutting ? 202 : 200 });
  });
}
