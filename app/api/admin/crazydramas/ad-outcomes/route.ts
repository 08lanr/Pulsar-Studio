// What each TikTok ad brought on crazydramas.com over its life (decision
// 2026-09-24, "CrazyDramas stats: ads, the team, why viewers leave"): the
// Monitor's second line under each ad (people, episode 1 started / finished,
// episode 2, paid), by TikTok's ad id. Staff only; from the same kept stats
// read as /crazydramas/stats, so the Monitor never waits on crazydramas twice.

import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { readCrazydramasStats } from "@/lib/crazydramas/stats";
import { adOutcomes } from "@/lib/crazydramas/stats-summary";
import { handle } from "../../../titles/_lib/handler";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const read = await readCrazydramasStats();
    if (!read.ok) return NextResponse.json({ ok: false, code: read.code, error: read.error });
    return NextResponse.json({ ok: true, read_at: read.read_at, mode: read.mode, ads: adOutcomes(read.report) });
  });
}
