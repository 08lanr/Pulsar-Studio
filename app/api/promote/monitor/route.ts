import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { buildMonitor } from "@/lib/tiktok/monitor";
import { handle } from "@/app/api/titles/_lib/handler";

// The launch monitor (decision 2026-09-16): every launched campaign with its
// switch, review verdicts, ad groups and lifetime numbers, cached 90 s;
// ?force=1 re-sweeps TikTok, ?campaign=<id> sweeps one campaign only.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const q = req.nextUrl.searchParams;
    const campaignId = q.get("campaign");
    const out = await buildMonitor(g.session, { force: q.get("force") === "1", campaignId: campaignId && /^[0-9a-f-]{36}$/i.test(campaignId) ? campaignId : undefined });
    return NextResponse.json(out);
  });
}
