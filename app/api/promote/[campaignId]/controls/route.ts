import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { controlSchema, runControl } from "@/lib/tiktok/control-actions";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Staff manage a launched campaign on TikTok (decision 2026-09-16): pause,
// resume, end, budget, daily budget, cost cap, schedule end, duplicate,
// per-ad-group switch. lib/tiktok/controls.ts does the work and reads back.

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = await parseJson(req, controlSchema);
    if (parsed.response) return parsed.response;
    return NextResponse.json(await runControl(g.session, params.campaignId, parsed.data));
  });
}
