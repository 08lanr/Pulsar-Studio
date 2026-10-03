// What the auto-poster did last (decision 2026-10-03, "Auto-post proven clips"):
// the Clips page's one line. Staff only, read-only, and process-local — the
// sweep keeps its last summary in memory, so a restarted server reports none
// until the next run. The cadence itself is not in memory: it is read from the
// newest clip post the system user created, so a restart never re-posts.

import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { AUTO_POST_RULE, autoPostEnabled, lastAutoPostRun, nextDueAt } from "@/lib/launch/auto-post";
import { getData } from "@/lib/data";
import { handle } from "../../titles/_lib/handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const enabled = autoPostEnabled();
    const due = enabled ? (await nextDueAt(await getData().listClipPosts(g.session))).toISOString() : null;
    return NextResponse.json(
      { enabled, rule: AUTO_POST_RULE, next_due_at: due, last: lastAutoPostRun() },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}
