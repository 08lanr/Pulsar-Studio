// The title's 60-second ad (decision 2026-09-24, lib/clips/montage-run.ts).
// GET: the finished ads (with download URLs) and the newest build's state —
// the title's clips page polls it while a build runs; never the job's cost.
// POST {}: pick and build — a reviewer or approver of the title, or a staff
// administrator (the staff clips page, /titles/[id]/clips), the same rule as
// "Cut clips again". Answers 202 with the pick while it builds, 200 with the
// ad when the same pick was built already, 409 while a build is going, 422
// with the reason in words (and a `code` the page words for itself) when the
// title's clips cannot make an ad yet, 503 when this server cannot render.
// A title that is not theirs is a 404 either way (the data layer's rule).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession, requireProducer, requireSession, requireStaff } from "@/lib/auth";
import { montageStatus, startMontage } from "@/lib/clips/montage-run";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireSession();
    if (g.response) return g.response;
    return NextResponse.json(await montageStatus(g.session, params.id));
  });
}

const Body = z.object({}).strict();

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const s = await getSession();
    const g = s?.kind === "staff" ? await requireStaff({ role: "admin" }) : await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const r = await startMontage(g.session, params.id);
    switch (r.outcome) {
      case "refused": return NextResponse.json({ error: r.refusal.message, code: r.refusal.code, usable: r.refusal.usable, held_back: r.refusal.held_back }, { status: 422 });
      case "running": return NextResponse.json({ error: "a 60-second ad is already being built for this title", code: "conflict", job_id: r.job_id }, { status: 409 });
      case "failed": return NextResponse.json({ error: r.error, code: "unavailable" }, { status: 503 });
      case "exists": return NextResponse.json({ outcome: "exists", montage: r.clip });
      case "started": return NextResponse.json({ outcome: "started", pieces: r.plan.pieces, duration_ms: r.plan.duration_ms }, { status: 202 });
    }
  });
}
