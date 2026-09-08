import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Staff record Grow's launch progress on a submitted campaign.
const schema = z.object({
  status: z.enum(["launching", "live", "failed"]),
  grow_campaign_id: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    return NextResponse.json(await getData().advancePromoCampaign(g.session, params.campaignId, parsed.data));
  });
}
