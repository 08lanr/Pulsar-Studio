import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { switchCampaign } from "@/lib/tiktok/controls";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Staff pause / resume a launched campaign on TikTok (lib/tiktok/controls.ts).

const schema = z.object({ on: z.boolean() });

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    return NextResponse.json(await switchCampaign(g.session, params.campaignId, parsed.data.on));
  });
}
