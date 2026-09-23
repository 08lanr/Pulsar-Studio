import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { stageView } from "@/lib/segment/view";
import { ensureInProcessWorker } from "@/lib/segment/worker";
import { handle } from "../../../../titles/_lib/handler";

// GET → { run, stage_view }: the row plus everything the run screens read
// from the film folder (watermark images, options and strips, the review
// state, the plan, the QA sheets, film-meta, the import's progress), with
// URLs on the evidence route. Polled every few seconds by the screens.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    ensureInProcessWorker();
    const run = await getData().getFilmRun(g.session, params.runId);
    const stage_view = await stageView(run);
    return NextResponse.json({ run, stage_view });
  });
}
