import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle } from "@/app/api/titles/_lib/handler";

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "approver" });
    if (g.response) return g.response;
    return NextResponse.json(await getData().approvePromoCampaign(g.session, params.campaignId));
  });
}
