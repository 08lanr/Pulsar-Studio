// The QA stage (plan B2, stage 7): `qa_episodes.py --src …` under the heavy
// lock, then the sheets `review/qa/epNN.png` and the measured faults from
// `review/qa/qa.json` for the screen. After a join move only the two
// episodes it touched are re-measured (`--only k`, which the script reads as
// k and k+1) — and the script then writes a report of ONLY those, so the
// report it had is snapshotted first and the untouched episodes' records
// are merged back afterwards, verbatim; a fault found earlier on another
// episode never leaves the screen. The qa_review Workflow stays a hand-off
// (it has never finished on any film); a person looks at the sheets and the
// join previews on the film-meta screen.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/** The raw report as the script writes it (episode records kept as they are, so a merge never rewrites what the pipeline measured). */
type RawQaReport = { fps?: unknown; regions?: unknown[]; episodes?: { n?: unknown }[] } & Record<string, unknown>;

/**
 * The report after an `--only` run: the script's own records for the
 * episodes it re-measured, and the earlier report's records for every other
 * episode, verbatim, in episode order. Pure. `after` wins for an episode both
 * carry; an episode neither carries (dropped from the plan) is gone.
 */
export function mergeQaReports(before: RawQaReport | null, after: RawQaReport): RawQaReport {
  const byN = new Map<number, { n?: unknown }>();
  for (const e of before?.episodes ?? []) if (typeof e.n === "number") byN.set(e.n, e);
  for (const e of after.episodes ?? []) if (typeof e.n === "number") byN.set(e.n, e);
  const episodes = [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  return { ...before, ...after, episodes };
}

export async function runQaStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const only = (run.stage_detail as { qa_only?: unknown }).qa_only;
  const partial = Array.isArray(only) && only.length > 0 && only.every((n) => Number.isInteger(n));
  const args = ["--src", SRC_ARG];
  if (partial) args.push("--only", (only as number[]).join(","));
  const qaFile = path.join(dirs.cut, "review", "qa", "qa.json");
  return withHeavyLock(ctx, "qa", async () => {
    await ctx.progress({ progress: { step: "qa", only: partial ? (only as Json) : null } });
    // A partial run rewrites qa.json with only the episodes it measured: keep what is there first.
    let before: RawQaReport | null = null;
    if (partial && existsSync(qaFile)) {
      before = readJson<RawQaReport>(qaFile);
      const snap = path.join(dirs.work, "qa", `qa-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      mkdirSync(path.dirname(snap), { recursive: true });
      copyFileSync(qaFile, snap);
      ctx.log(`qa.json snapshot: ${snap}`);
    }
    const r = await runStep(ctx, { script: "qa_episodes.py", args, what: "qa_episodes", timeoutMs: 2 * 60 * 60 * 1000 });
    if (r.code !== 0) return fail(refusalOf({ script: "qa_episodes.py", args, what: "" }, r), { qa_tail: tailLines(r.stdoutTail) });
    let merged: number[] = [];
    if (before) {
      const after = readJson<RawQaReport>(qaFile);
      if (after) {
        const measured = new Set((after.episodes ?? []).map((e) => e.n).filter((n): n is number => typeof n === "number"));
        const out = mergeQaReports(before, after);
        merged = (out.episodes ?? []).map((e) => e.n as number).filter((n) => !measured.has(n));
        if (merged.length) {
          writeFileSync(qaFile, `${JSON.stringify(out, null, 1)}\n`, "utf8");
          ctx.log(`qa.json: ${measured.size} episodes re-measured (--only ${(only as number[]).join(",")}), ${merged.length} earlier records merged back: ${merged.join(", ")}`);
        }
      }
    }
    const report = readQa(dirs.cut);
    return next("film_meta", {
      qa: report ? { episodes: report.episodes.length, faults_total: report.faults_total, with_faults: report.episodes.filter((e) => e.faults.length).map((e) => e.n), merged_from_before: merged } : null,
      qa_tail: tailLines(r.stdoutTail, 6),
      qa_only: null,
      progress: null,
    });
  });
}
