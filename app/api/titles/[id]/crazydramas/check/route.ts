// Check now (decision 2026-09-23, "the crazydramas connection"; plan A5):
// one public read of the title's series, recorded as a snapshot, answered
// as the reading the screens show. Same-origin guard, staff or a producer
// reviewer / approver — a viewer stays read-only (CLAUDE.md) and gets 403,
// the same rule the page's Check now follows; a foreign title is not found,
// never forbidden — zod, the shared check function, JSON. Refused with 429
// while a snapshot of that slug is younger than 30 seconds (`retry_after_s`
// says how long), 409 when the title has no slug to read. No credential is
// involved and none is printed.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireProducer, requireSession, requireStaff } from "@/lib/auth";
import { checkCrazydramasTitle } from "@/lib/crazydramas/sweep";
import { handle, parseJson } from "../../../_lib/handler";

const Body = z.object({}).strict();

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const who = await requireSession();
    if (who.response) return who.response;
    const g = who.session.kind === "staff" ? await requireStaff() : await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return apiError("Not found", undefined, 404);

    const r = await checkCrazydramasTitle(g.session, params.id);
    if (r.outcome === "not_linked") {
      return NextResponse.json({ error: "This title has no crazydramas slug to read", code: "not_linked", status: r.status }, { status: 409 });
    }
    if (r.outcome === "too_soon") {
      return NextResponse.json(
        { error: `Checked less than 30 seconds ago; try again in ${r.retry_after_s} s`, code: "too_soon", retry_after_s: r.retry_after_s, status: r.status },
        { status: 429, headers: { "Retry-After": String(r.retry_after_s) } }
      );
    }
    return NextResponse.json({ checked: true, slug: r.slug, http_status: r.http_status, error: r.error, linked: r.linked, checked_at: r.snapshot.read_at, status: r.status });
  });
}
