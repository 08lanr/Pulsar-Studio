// The staff mirror (decision 2026-09-23, "the crazydramas connection"; plan
// A4): the crazydramas series that match no Studio title, from the newest
// snapshot per slug the sweep recorded with no title (today: he-mocked-…,
// he-treated-…, ever-since-…). Staff only — a producer never sees another
// company's, or nobody's, series. Read-only; nothing here is a credential.
// `series` is null until a sweep has read the catalog at all.

import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { crazydramasReadMode } from "@/lib/crazydramas";
import { crazydramasSweepStatus, listUnmatchedCrazydramas } from "@/lib/crazydramas/sweep";
import { handle } from "../../../titles/_lib/handler";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const series = await listUnmatchedCrazydramas(g.session);
    const sweep = crazydramasSweepStatus();
    return NextResponse.json({
      series,
      mode: crazydramasReadMode(),
      read_at: series?.map((s) => s.read_at).sort().at(-1) ?? null,
      sweep: { last_at: sweep.lastAt, next_at: sweep.nextAt },
    });
  });
}
