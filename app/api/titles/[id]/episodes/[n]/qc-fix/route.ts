// One button for the QC card: every text-shape error QC found (reading
// speed, line too wide, too many lines) is handed back to the rewrite job
// with a hard character budget for its window, sequentially, as normal
// cost-tracked jobs. Timing errors (overlaps) and missing lines are not
// text problems, so they are left for a human. The response re-runs QC so
// the client can say what remains.

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { DataError, getData } from "@/lib/data";
import { demoReplayActive } from "@/lib/demo-replay";
import { runRewrite } from "@/lib/jobs";
import { charBudget } from "@/lib/prompts/shared";
import { runQc, type QcIssue } from "@/lib/qc";
import { episodeNumber, handle, isResponse } from "../../../../_lib/handler";

export const maxDuration = 300;

const FIXABLE = new Set<QcIssue["code"]>(["reading_speed", "line_too_long", "too_many_lines"]);

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    if (demoReplayActive()) {
      throw new DataError("invalid", "the AI fix needs a model; demo replay mode has none");
    }
    const data = getData();
    const wb = await data.getWorkbench(g.session, params.id, n);
    if (!wb.version || wb.version.status !== "draft") {
      throw new DataError("invalid", "the AI fix edits the open draft — fork the approved version first");
    }
    const version = wb.version;

    const qc = runQc({
      lines: wb.lines,
      adapted: wb.adapted_lines.filter((a) => a.version_id === version.id),
      characterNames: new Map(wb.characters.map((c) => [c.id, c.name_en])),
    });
    const targets = qc.errors.filter((i) => FIXABLE.has(i.code));

    let fixed = 0;
    const failures: string[] = [];
    for (const issue of targets) {
      const line = wb.lines.find((l) => l.id === issue.line_id);
      const adapted = wb.adapted_lines.find((a) => a.line_id === issue.line_id && a.version_id === version.id);
      if (!line || !adapted || line.start_ms == null || line.end_ms == null) continue;
      const budget = charBudget(line.start_ms, line.end_ms);
      try {
        await runRewrite(
          g.session,
          adapted.id,
          `shorten to fit its ${((line.end_ms - line.start_ms) / 1000).toFixed(1)}s window: at most ${budget} characters excluding spaces, on a single line, keeping the meaning and tone`,
          { titleId: params.id, episodeNumber: n }
        );
        fixed += 1;
      } catch (e) {
        failures.push(`seq ${issue.seq}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const fresh = await data.getWorkbench(g.session, params.id, n);
    const after = runQc({
      lines: fresh.lines,
      adapted: fresh.adapted_lines.filter((a) => a.version_id === version.id),
      characterNames: new Map(fresh.characters.map((c) => [c.id, c.name_en])),
    });

    return NextResponse.json({
      attempted: targets.length,
      fixed,
      failures,
      remaining_errors: after.errors.length,
      remaining_warnings: after.warnings.length,
    });
  });
}
