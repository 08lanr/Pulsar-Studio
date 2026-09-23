// The narrated index (narrated spec N1 stage 1): under the machine's heavy
// lock, `T0=<t0> T1=<t1> bash scripts/index_chain.sh` from the film root —
// audio, shot cuts, whisper, one contact sheet per minute, the caption and
// lyric scans, the OCR cues. T0 is always passed: the scans default to
// T0=50 (ST/caption_scan.py:10, lyric_scan.py:11), which would never scan
// the first 50 s of captions; T1 defaults to the source's length. The chain
// is `set -e` and all-or-nothing, so Studio skips it only when every output
// is there and covers the source (a restarted worker resumes after a
// finished index; a half-finished one runs again). `index/whisper.log` is
// tailed into the run's progress. 56–81 minutes for a 43–46 minute source.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fail, next, readJson, tailLines, withHeavyLock, type StageOutcome } from "../stages";
import { lastLogLine } from "../index";
import { narratedRefusal, runFilmStep, sourceDurationOf, type NarratedContext } from "./stages";

/** What index_chain.sh leaves when it finished (the chain's own outputs, index/ relative). */
export const INDEX_OUTPUTS = ["audio16k.wav", "scdet.txt", "whisper.json", "captions_zh.json", "lyric_cues.json"] as const;

/** Minutes of contact sheets the chain cuts: one per started minute of the source. */
export function sheetMinutes(durationS: number): number {
  return Math.max(1, Math.ceil(durationS / 60 - 1e-9));
}

/** What is missing from a finished index of a source of `durationS` seconds (empty when the chain may be skipped). */
export function indexGaps(indexDir: string, durationS: number | null): string[] {
  const gaps: string[] = INDEX_OUTPUTS.filter((f) => !existsSync(path.join(indexDir, f))).map((f) => `index/${f}`);
  const w = readJson<{ duration?: unknown }>(path.join(indexDir, "whisper.json"));
  if (w && durationS !== null && typeof w.duration === "number" && w.duration + 2 < durationS) gaps.push(`index/whisper.json covers ${w.duration} s of ${durationS} s`);
  if (durationS !== null) {
    let have = 0;
    try {
      have = readdirSync(path.join(indexDir, "sheets")).filter((f) => /^min-\d+\.png$/.test(f)).length;
    } catch {
      have = 0;
    }
    const want = sheetMinutes(durationS);
    if (have < want) gaps.push(`index/sheets has ${have} of ${want} minute sheets`);
  }
  return gaps;
}

/** ~81 min for a 46 min source (lbl-e03); the limit is three times the source's length, never under three hours. */
export function chainTimeoutMs(durationS: number | null): number {
  return Math.max(3 * 60 * 60 * 1000, Math.round((durationS ?? 0) * 3 * 1000 * 1.8));
}

export async function runNarratedIndexStage(ctx: NarratedContext): Promise<StageOutcome> {
  const duration = sourceDurationOf(ctx.run);
  const gaps = indexGaps(ctx.paths.index, duration);
  if (!gaps.length) {
    ctx.log("the index is complete and covers the source: index_chain.sh skipped");
    return next("sheets", { index: { skipped: true } });
  }
  const t0 = ctx.settings.scan.t0;
  const t1 = ctx.settings.scan.t1 ?? duration;
  if (t1 === null) return fail("the source's length is unknown (the intake's probe gave none) and settings.scan.t1 is not set: index_chain.sh's caption scans need T1");
  return withHeavyLock(ctx, "index", async () => {
    const log = path.join(ctx.paths.index, "whisper.log");
    let lastSeen: string | null = null;
    const timer = setInterval(() => {
      const line = lastLogLine(log);
      if (line && line !== lastSeen) {
        lastSeen = line;
        void ctx.progress({ progress: { step: "whisper", file: "index/whisper.log", line } }).catch(() => undefined);
      }
    }, ctx.scripts.fake ? 100 : 5000);
    timer.unref?.();
    ctx.log(`index: ${gaps.join("; ")} — index_chain.sh runs (T0=${t0} T1=${t1})`);
    let r;
    try {
      await ctx.progress({ progress: { step: "index_chain", line: null } }, { force: true });
      r = await runFilmStep(ctx, {
        script: "index_chain.sh",
        args: [],
        what: "index_chain.sh",
        interpreter: "bash",
        env: { T0: String(t0), T1: String(t1) },
        timeoutMs: chainTimeoutMs(duration),
      });
    } finally {
      clearInterval(timer);
    }
    if (r.code !== 0) return fail(narratedRefusal({ script: "index_chain.sh" }, r), { index_tail: tailLines(`${r.stderrTail}\n${r.stdoutTail}`) });
    const after = indexGaps(ctx.paths.index, duration);
    if (after.length) return fail(`index_chain.sh exited 0 but the index is not complete: ${after.join("; ")}`);
    return next("sheets", { index: { t0, t1, done: true } });
  });
}
