// Each launched Studio clip's TikTok numbers over its whole life (decision 2026-09-28, "Ad video stats"): the
// Clips page's compact TikTok cell, by clip id (impressions, CTR, still watching at 6 s, checkouts; early under
// 500 impressions). Staff only, read-only; the same ten-minute read the Ads tab of /crazydramas/stats makes
// (lib/tiktok/ad-video.ts), summed per creative by lib/crazydramas/stats-creatives.ts. A clip never launched is
// absent. An ad account TikTok did not answer for is named in `failed` and its clips show nothing.

import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { adCreatives } from "@/lib/crazydramas/stats-ads";
import { clipSummaries, creativeRows } from "@/lib/crazydramas/stats-creatives";
import { getData } from "@/lib/data";
import { readTikTokAdVideo } from "@/lib/tiktok/ad-video";
import { handle } from "../../../titles/_lib/handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const runs = await getData().listLaunchRuns(g.session);
    const read = await readTikTokAdVideo(runs, "lifetime", { fresh: req.nextUrl.searchParams.get("fresh") === "1" });
    const rows = creativeRows(adCreatives(runs, new Map()), read.ads);
    return NextResponse.json({ clips: clipSummaries(rows), failed: read.failed }, { headers: { "Cache-Control": "no-store" } });
  });
}
