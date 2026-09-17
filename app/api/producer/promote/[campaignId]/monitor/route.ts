import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { buildMonitor } from "@/lib/tiktok/monitor";
import { handle } from "@/app/api/titles/_lib/handler";

// One campaign's live delivery state for its producer (decision 2026-09-16):
// the same sweep staff see, scoped to a campaign the caller can read.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    // Staff previewing the producer portal read too (they may look, not act); the data layer scopes the campaign.
    const g = await requireSession();
    if (g.response) return g.response;
    await getData().getPromoCampaign(g.session, params.campaignId); // not found for a foreign campaign
    const out = await buildMonitor(g.session, { campaignId: params.campaignId, force: req.nextUrl.searchParams.get("force") === "1" });
    return NextResponse.json({ row: out.rows[0] ?? null, swept_at: out.swept_at });
  });
}
