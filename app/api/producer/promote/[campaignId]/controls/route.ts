import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { controlSchema, PRODUCER_ACTIONS, runControl } from "@/lib/tiktok/control-actions";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// The producer's approver manages their own launched campaign (decision
// 2026-09-16: "we can let producers do that"). Same dispatcher as staff;
// the data layer refuses a foreign campaign as not found and a non-approver
// as forbidden.

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "approver" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, controlSchema);
    if (parsed.response) return parsed.response;
    if (!PRODUCER_ACTIONS.includes(parsed.data.action)) return NextResponse.json({ error: "that control is staff-only", code: "forbidden" }, { status: 403 });
    // Ownership first (not found for a foreign campaign, before any TikTok call).
    await getData().getPromoCampaign(g.session, params.campaignId);
    return NextResponse.json(await runControl(g.session, params.campaignId, parsed.data));
  });
}
