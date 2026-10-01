// The title's quick hook ads (decision 2026-10-01, lib/clips/quick-hook-run.ts).
// GET: the finished variants (with download URLs and their codes), the newest
// build's state and the suggested texts — the title's clips page polls it
// while a build runs; never the job's cost.
// POST { texts: [1-3 lines] }: pick and build every bait × body × text — a
// reviewer or approver of the title, or a staff administrator, the same rule
// as the 60-second ad. Answers 202 with the variants while it builds, 200
// when every variant was built already, 409 while a build is going, 422 with
// the reason in words (and a `code`) when the clips or the texts cannot make
// an ad, 503 when this server cannot render. A title that is not theirs is a
// 404 either way (the data layer's rule).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession, requireProducer, requireSession, requireStaff } from "@/lib/auth";
import { overlayIssue, QUICK_HOOK_DEFAULTS } from "@/lib/clips/quick-hook";
import { quickHooksStatus, startQuickHooks } from "@/lib/clips/quick-hook-run";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireSession();
    if (g.response) return g.response;
    return NextResponse.json(await quickHooksStatus(g.session, params.id));
  });
}

const Body = z.object({
  texts: z.array(z.string().superRefine((t, ctx) => { const issue = overlayIssue(t); if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue }); }))
    .min(1, "write at least one line of text for the ads to show")
    .max(QUICK_HOOK_DEFAULTS.textsMax, `at most ${QUICK_HOOK_DEFAULTS.textsMax} texts per build`),
}).strict();

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const s = await getSession();
    const g = s?.kind === "staff" ? await requireStaff({ role: "admin" }) : await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const r = await startQuickHooks(g.session, params.id, parsed.data.texts);
    switch (r.outcome) {
      case "refused": return NextResponse.json({ error: r.refusal.message, code: r.refusal.code, usable: r.refusal.usable, held_back: r.refusal.held_back }, { status: 422 });
      case "running": return NextResponse.json({ error: "quick hook ads are already being built for this title", code: "conflict", job_id: r.job_id }, { status: 409 });
      case "failed": return NextResponse.json({ error: r.error, code: "unavailable" }, { status: 503 });
      case "exists": return NextResponse.json({ outcome: "exists", count: r.count });
      case "started": return NextResponse.json({ outcome: "started", codes: r.variants.map((v) => v.code), total: r.variants.length }, { status: 202 });
    }
  });
}
