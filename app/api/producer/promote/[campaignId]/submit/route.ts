import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { pickLaunchAccount } from "@/lib/tiktok/business-centers";
import { runLaunch } from "@/lib/tiktok/launch";
import { handle } from "@/app/api/titles/_lib/handler";

// The producer's launch (decision 2026-09-09): pick the ad account inside
// the company's assigned Business Center (or its explicit account), let the
// data layer gate the approved manifest, the signed budget and the
// destination and record the launch row (one per manifest), then run the
// engine against TikTok — inline, so the answer already says whether the
// objects were created, and adoptable by the scheduler if this request dies
// mid-way. No staff step in between.

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "approver" });
    if (g.response) return g.response;
    const data = getData();
    const current = await data.getPromoCampaign(g.session, params.campaignId);
    let resolved = null;
    if (current.campaign.status === "approved") {
      const pick = await pickLaunchAccount(g.session, current.campaign.producer_id);
      if (!pick.ok) return NextResponse.json({ error: pick.reason, code: "conflict", blocker: pick.blocker }, { status: 409 });
      resolved = pick.pick;
    }
    let detail = await data.submitPromoCampaign(g.session, params.campaignId, resolved);
    if (detail.launch && (detail.launch.status === "pending" || detail.launch.status === "running")) {
      await runLaunch(detail.launch.id);
      detail = await data.getPromoCampaign(g.session, params.campaignId);
    }
    return NextResponse.json(detail);
  });
}
