// The QA stage (plan B2, stage 7): `qa_episodes.py --src …` under the heavy
// lock, then the sheets `review/qa/epNN.png` and the measured faults from
// `review/qa/qa.json` for the screen. After a join move only the two
// episodes it touched are re-measured (`--only`). The qa_review Workflow
// stays a hand-off (it has never finished on any film); a person looks at
// the sheets and the join previews on the film-meta screen.

import path from "node:path";
import type { Json } from "@/lib/types";
import { SRC_ARG, fail, next, readJson, refusalOf, runStep, tailLines, withHeavyLock, type StageContext, type StageOutcome } from "./stages";

export type QaEpisode = { n: number; start: number; end: number; faults: string[]; notes: string[]; sheet: string | null; first_frame_offset?: number | null; last_frame_offset?: number | null };
export type QaReport = { fps: number | null; regions: unknown[]; episodes: QaEpisode[]; faults_total: number };

/** `review/qa/qa.json`, read as the screen shows it; null when the QA has not run. */
export function readQa(cutDir: string): QaReport | null {
  const raw = readJson<{ fps?: number; regions?: unknown[]; episodes?: Record<string, unknown>[] }>(path.join(cutDir, "review", "qa", "qa.json"));
  if (!raw || !Array.isArray(raw.episodes)) return null;
  const episodes: QaEpisode[] = raw.episodes.map((e) => ({
    n: Number(e.n),
    start: Number(e.start),
    end: Number(e.end),
    faults: Array.isArray(e.faults) ? e.faults.map(String) : [],
    notes: Array.isArray(e.notes) ? e.notes.map(String) : [],
    sheet: typeof e.sheet === "string" ? e.sheet.replace(/\\/g, "/") : null,
    first_frame_offset: typeof e.first_frame_offset === "number" ? e.first_frame_offset : null,
    last_frame_offset: typeof e.last_frame_offset === "number" ? e.last_frame_offset : null,
  }));
  return { fps: typeof raw.fps === "number" ? raw.fps : null, regions: raw.regions ?? [], episodes, faults_total: episodes.reduce((s, e) => s + e.faults.length, 0) };
}

export async function runQaStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const only = (run.stage_detail as { qa_only?: unknown }).qa_only;
  const args = ["--src", SRC_ARG];
  if (Array.isArray(only) && only.length && only.every((n) => Number.isInteger(n))) args.push("--only", only.join(","));
  return withHeavyLock(ctx, "qa", async () => {
    await ctx.progress({ progress: { step: "qa", only: Array.isArray(only) ? (only as Json) : null } });
    const r = await runStep(ctx, { script: "qa_episodes.py", args, what: "qa_episodes", timeoutMs: 2 * 60 * 60 * 1000 });
    if (r.code !== 0) return fail(refusalOf({ script: "qa_episodes.py", args, what: "" }, r), { qa_tail: tailLines(r.stdoutTail) });
    const report = readQa(dirs.cut);
    return next("film_meta", {
      qa: report ? { episodes: report.episodes.length, faults_total: report.faults_total, with_faults: report.episodes.filter((e) => e.faults.length).map((e) => e.n) } : null,
      qa_tail: tailLines(r.stdoutTail, 6),
      qa_only: null,
      progress: null,
    });
  });
}
