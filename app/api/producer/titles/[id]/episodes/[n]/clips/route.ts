// The episode's auto-cut ad clips (decision 2026-09-14). GET: the rows with
// download URLs and the derived run state (the Materials page polls it
// while cutting). POST { force? }: start a run — reviewer role or above —
// answered 202 with the job, or 409 while a run is already going. A title
// that is not theirs is a 404 either way (the data layer's rule).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession, requireProducer, requireSession, requireStaff } from "@/lib/auth";
import { episodeClipsPayload } from "@/lib/clips/payload";
import { cutEpisodeClips } from "@/lib/clips/run";
import { jobIsRunning } from "@/lib/clips/state";
import { getData } from "@/lib/data";
import { episodeNumber, handle, isResponse, parseJson } from "@/app/api/titles/_lib/handler";

export async function GET(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    // Read-only: a producer of any role, or staff previewing the portal (the data layer scopes the title).
    const g = await requireSession();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    return NextResponse.json(await episodeClipsPayload(g.session, params.id, n));
  });
}

const Body = z.object({ force: z.boolean().optional() });

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    // A reviewer or approver of the title, or a staff administrator (the staff clips page, /titles/[id]/clips).
    const s = await getSession();
    const g = s?.kind === "staff" ? await requireStaff({ role: "admin" }) : await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const data = getData();
    const wb = await data.getWorkbench(g.session, params.id, n); // scoping + 404 for foreign titles
    if (!wb.episode.video_path) return NextResponse.json({ error: "this episode has no video to cut from", code: "invalid" }, { status: 400 });
    const latest = await data.latestEpisodeJob(g.session, params.id, n, "cut_clips");
    if (jobIsRunning(latest)) return NextResponse.json({ error: "a cutting run is already going", code: "conflict", job_id: latest!.id }, { status: 409 });
    // The run outlives this request; the page polls GET for the outcome.
    void cutEpisodeClips(params.id, n, { force: parsed.data.force ?? true }).catch((e) => console.error(`[clips] ${params.id}/${n} threw`, e));
    return NextResponse.json({ started: true }, { status: 202 });
  });
}
