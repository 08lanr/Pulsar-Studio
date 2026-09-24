// The last step of the publish progress (2026-09-24): does the public page
// show the series yet? One PUBLIC read of the title's series (what a viewer's
// browser gets; the live site's cache trails a publish by up to 60 s),
// answered as `{ live, episodes, url }`. Same guard as Check now: staff, or a
// producer reviewer / approver of the title (a viewer gets 403, a foreign
// title is not found). 429 with `retry_after_ms` when polled faster than
// every three seconds; 409 when the title has no slug. A read that fails is
// answered as `{ failed: true, error }` in words, so the page can keep
// polling. Nothing is recorded and no credential is involved.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireProducer, requireSession, requireStaff } from "@/lib/auth";
import { checkPublicPage } from "@/lib/crazydramas/sweep";
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

    const r = await checkPublicPage(g.session, params.id);
    if (r.outcome === "not_linked") return NextResponse.json({ error: "This title has no crazydramas slug to read", code: "not_linked" }, { status: 409 });
    if (r.outcome === "too_soon") {
      return NextResponse.json({ error: "Read less than three seconds ago", code: "too_soon", retry_after_ms: r.retry_after_ms }, { status: 429, headers: { "Retry-After": String(Math.ceil(r.retry_after_ms / 1000)) } });
    }
    if (r.outcome === "failed") return NextResponse.json({ failed: true, slug: r.slug, url: r.url, error: r.error });
    return NextResponse.json({ failed: false, slug: r.slug, url: r.url, http_status: r.http_status, live: r.live, episodes: r.episodes });
  });
}
