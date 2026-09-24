// "Read CrazyDramas now" on the CrazyDramas hub (2026-09-24): the sweep's
// reads — the catalog, each linked title's series, each unmatched series —
// run once, so the hub's rows reflect the site without waiting for the
// hourly sweep. Staff only (the unmatched series are nobody's), same-origin,
// no body. 429 with `retry_after_s` while a sweep runs or ran less than fifteen
// seconds ago. Reads only: nothing is written to crazydramas, and no
// credential is involved or printed.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { sweepCrazydramasNow } from "@/lib/crazydramas/sweep";
import { handle, parseJson } from "../../../titles/_lib/handler";

const Body = z.object({}).strict();

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const r = await sweepCrazydramasNow();
    if (!r.ran) {
      return NextResponse.json(
        { error: r.reason === "running" ? "A read of CrazyDramas is running; try again in a few seconds" : `CrazyDramas was read a moment ago; try again in ${r.retry_after_s} s`, code: r.reason, retry_after_s: r.retry_after_s },
        { status: 429, headers: { "Retry-After": String(r.retry_after_s) } }
      );
    }
    const s = r.summary;
    return NextResponse.json({ ran: true, at: s.at, catalog: s.catalog, titles: s.titles, unmatched: s.unmatched, errors: s.errors.length });
  });
}
