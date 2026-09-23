import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { ensureProxy, evidencePathOf, proxyTimeOf } from "@/lib/segment/evidence";
import { runDirs } from "@/lib/segment/stages";
import { runnerFor } from "@/lib/segment/worker";
import { handle } from "../../../../titles/_lib/handler";
import { streamFile } from "../../../../media/_lib/stream";

// GET /api/film-runs/<run>/evidence/<review|index|work>/<path>.<png|json|mp4>
// (plan B3): the strips, the watermark and QA images, the pipeline's small
// JSON files under the run's cut/review and cut/index, and Studio's own
// proxy clips and dense strips under STUDIO_WORK_DIR/<run>/. A proxy clip
// (`work/proxies/t<s>_<ms>.mp4`) is made from the source on first request.
// Range is honoured (the player seeks). Staff only; anything else is 404 —
// never an episode file, never the source, never another film.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { runId: string; path: string[] } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const run = await getData().getFilmRun(g.session, params.runId);
    const dirs = runDirs(run);
    const ref = evidencePathOf(dirs, params.path ?? []);
    if (!ref) return apiError("Not found", undefined, 404);
    if (ref.area === "work" && ref.rel.startsWith("proxies/")) {
      const t = proxyTimeOf(ref.rel.slice("proxies/".length));
      if (t === null) return apiError("Not found", undefined, 404);
      try {
        await ensureProxy(run, t, runnerFor());
      } catch (e) {
        return apiError((e as Error).message, undefined, 502);
      }
    }
    return streamFile(req, ref.abs);
  });
}

export async function HEAD(req: NextRequest, ctx: { params: { runId: string; path: string[] } }) {
  const res = await GET(req, ctx);
  if (res.body) await res.body.cancel().catch(() => undefined);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
