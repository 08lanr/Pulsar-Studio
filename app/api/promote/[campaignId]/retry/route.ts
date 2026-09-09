import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { runLaunch } from "@/lib/tiktok/launch";
import { handle } from "@/app/api/titles/_lib/handler";

// Staff retry a failed launch: the same launch row resumes at its first
// unfinished step (recorded TikTok ids are skipped), never a second campaign.

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const data = getData();
    const launch = await data.retryPromoLaunch(g.session, params.campaignId);
    const outcome = await runLaunch(launch.id);
    return NextResponse.json({ launch: await data.getPromoLaunch(g.session, launch.id), outcome });
  });
}
