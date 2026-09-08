import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle } from "@/app/api/titles/_lib/handler";

// Keeps every creative still waiting for a decision; per-creative changes stay on the review route.
export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    return NextResponse.json(await getData().approveAllPromoCreatives(g.session, params.campaignId));
  });
}
