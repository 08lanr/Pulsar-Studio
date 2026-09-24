import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { elsewhereOf, stageView } from "@/lib/segment/view";
import { ensureInProcessWorker } from "@/lib/segment/worker";
import { handle } from "../../../../titles/_lib/handler";

// GET → { run, stage_view }: the row plus everything the run screens read
// from the film folder (watermark images, options and strips, the review
// state, the plan, the QA sheets, film-meta, the import's progress), with
// URLs on the evidence route. Polled every few seconds by the screens. A
// run started on another computer has no view here (its folder is on that
// disk): `elsewhere` names the computer and the screens show it read-only.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    ensureInProcessWorker();
    const run = await getData().getFilmRun(g.session, params.runId);
    const elsewhere = elsewhereOf(run);
    if (elsewhere) return NextResponse.json({ run, stage_view: null, elsewhere });
    return NextResponse.json({ run, stage_view: await stageView(run), elsewhere: null });
  });
}
