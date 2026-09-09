import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { runLaunch } from "@/lib/tiktok/launch";
import { handle } from "@/app/api/titles/_lib/handler";

// The producer's launch (decision 2026-09-09): the data layer gates the
// approved manifest, the signed budget, the destination and the assigned
// account, records the launch row (one per manifest), and the engine runs
// against TikTok — inline, so the answer already says whether the objects
// were created, and adoptable by the scheduler if this request dies
// mid-way. No staff step in between.

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "approver" });
    if (g.response) return g.response;
    const data = getData();
    let detail = await data.submitPromoCampaign(g.session, params.campaignId);
    if (detail.launch && (detail.launch.status === "pending" || detail.launch.status === "running")) {
      await runLaunch(detail.launch.id);
      detail = await data.getPromoCampaign(g.session, params.campaignId);
    }
    return NextResponse.json(detail);
  });
}
