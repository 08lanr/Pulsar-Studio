// The index stage (plan B2, stage 2): `index_cut.sh --src … --lang … --threads 2`
// (audio, shot cuts, the word-level whisper transcript; 43–88 minutes,
// mostly whisper), then `motion.py`, then `candidates.py` — under the
// machine's heavy lock, with `index/whisper.log` tailed for progress. Each
// step is skipped when its artifact is already there, so a restarted worker
// resumes after the step that finished. `--from` is never passed (the
// script refuses it: segment-relative times would misalign every pin).

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DECISION, SRC_ARG, decisionData, fail, fileExists, next, pendingDecision, refusalOf, runStep, sourceFacts, tailLines, wait, withHeavyLock, type StageContext, type StageOutcome } from "./stages";

/** The pipeline's machine rule: two whisper threads. */
export const DEFAULT_THREADS = 2;

/** ~18 min per 30 min of film at two threads (README); the limit is three times that, never under two hours. */
export function indexTimeoutMs(durationS: number | null): number {
  const perMinute = 18 / 30;
  const minutes = durationS ? (durationS / 60) * perMinute * 3 : 0;
  return Math.max(2 * 60 * 60 * 1000, Math.round(minutes * 60 * 1000));
}

/** The last non-empty line of a log file, or null. */
export function lastLogLine(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

export async function runIndexStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const index = (name: string) => path.join(dirs.cut, "index", name);
  const to = typeof run.settings.to_s === "number" && run.settings.to_s > 0 ? String(run.settings.to_s) : null;
  const toArgs = to ? ["--to", to] : [];
  const threads = typeof run.settings.threads === "number" ? run.settings.threads : DEFAULT_THREADS;
  const detail = ctx.run.stage_detail as Record<string, unknown>;
  const durationS = typeof (detail.source as { duration_s?: number } | undefined)?.duration_s === "number" ? (detail.source as { duration_s: number }).duration_s : null;

  return withHeavyLock(ctx, "index", async () => {
    // index_cut.sh: audio, scdet, whisper. Skipped when the transcript is there.
    if (!fileExists(index("whisper.json"))) {
      const log = index("whisper.log");
      let lastSeen: string | null = null;
      const timer = setInterval(() => {
        const line = lastLogLine(log);
        if (line && line !== lastSeen) {
          lastSeen = line;
          void ctx.progress({ progress: { step: "whisper", file: "index/whisper.log", line } }).catch(() => undefined);
        }
      }, ctx.runner.fake ? 100 : 5000);
      timer.unref?.();
      let r;
      try {
        await ctx.progress({ progress: { step: "index_cut", line: null } });
        r = await runStep(ctx, {
          script: "index_cut.sh",
          args: ["--src", SRC_ARG, ...toArgs, "--lang", run.lang, "--threads", String(threads)],
          what: "index_cut.sh",
          timeoutMs: indexTimeoutMs(durationS),
        });
      } finally {
        clearInterval(timer);
      }
      if (r.code !== 0) return fail(refusalOf({ script: "index_cut.sh", args: [], what: "" }, r), { index_tail: tailLines(r.stderrTail + "\n" + r.stdoutTail) });
      const size = safeSize(index("whisper.json"));
      ctx.log(`whisper.json: ${size} bytes`);
    } else {
      ctx.log("index/whisper.json exists: index_cut.sh skipped");
    }

    if (!fileExists(index("motion.json"))) {
      await ctx.progress({ progress: { step: "motion" } });
      const r = await runStep(ctx, { script: "motion.py", args: ["--src", SRC_ARG, ...toArgs], what: "motion.py", timeoutMs: 60 * 60 * 1000 });
      if (r.code !== 0) return fail(refusalOf({ script: "motion.py", args: [], what: "" }, r));
    } else {
      ctx.log("index/motion.json exists: motion.py skipped");
    }

    if (!fileExists(index("candidates.json"))) {
      await ctx.progress({ progress: { step: "candidates" } });
      const r = await runStep(ctx, { script: "candidates.py", args: [], what: "candidates.py", timeoutMs: 10 * 60 * 1000 });
      if (r.code !== 0) return fail(refusalOf({ script: "candidates.py", args: [], what: "" }, r));
    } else {
      ctx.log("index/candidates.json exists: candidates.py skipped");
    }

    const summary = indexSummary(dirs.cut);
    return next(run.mode === "source_episodes" ? "cards" : "plan", { index: summary, progress: null });
  });
}

function safeSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Counts the screens show once the index exists. */
export function indexSummary(cutDir: string): Record<string, number | string | null> {
  const read = <T>(name: string): T | null => {
    try {
      return JSON.parse(readFileSync(path.join(cutDir, "index", name), "utf8")) as T;
    } catch {
      return null;
    }
  };
  const whisper = read<{ language?: string; duration?: number; model?: string; segments?: unknown[] }>("whisper.json");
  const motion = read<{ beats?: unknown[] }>("motion.json");
  const candidates = read<{ legal?: number; shot_cuts?: number; candidates?: unknown[] }>("candidates.json");
  let scdet: number | null = null;
  try {
    scdet = readFileSync(path.join(cutDir, "index", "scdet.txt"), "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
  } catch {
    scdet = null;
  }
  return {
    language: whisper?.language ?? null,
    duration_s: whisper?.duration ?? null,
    model: whisper?.model ?? null,
    segments: whisper?.segments?.length ?? null,
    shot_cuts: candidates?.shot_cuts ?? scdet,
    beats: motion?.beats?.length ?? null,
    legal_cuts: candidates?.legal ?? candidates?.candidates?.length ?? null,
  };
}

// ---- the cards stage (source-episodes mode, plan B2 stage 2b) ---------------------------------------------------

/**
 * The source's own episode breaks: a person names one source time per card
 * lettering style (`{kind: "cards", templates: [t, …]}`), then
 * `cards.py --templates` finds every card and writes `index/skips.json`,
 * and `cards.py --plan` makes `cuts.json` with one episode per original
 * episode (no vision pass, no length band: the original series put its
 * breaks on cliffhangers). Ends at the render.
 */
export async function runCardsStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const decision = pendingDecision(run, DECISION.cards);
  const skips = path.join(dirs.cut, "index", "skips.json");
  if (!decision) {
    const facts = sourceFacts(dirs.cut);
    return wait("cards", { cards: { skips: fileExists(skips), evidence: fileExists(path.join(dirs.cut, "index", "skips-evidence.png")) ? "index/skips-evidence.png" : null, duration_s: facts?.duration ?? null } });
  }
  const templates = decisionData(decision).templates;
  if (!Array.isArray(templates) || !templates.length || !templates.every((t) => typeof t === "number" && Number.isFinite(t) && t >= 0)) return fail("cards need one source time per card style, in seconds");
  const args = ["--src", SRC_ARG, "--templates", templates.map((t) => String(t)).join(",")];
  const found = await runStep(ctx, { script: "cards.py", args, what: "cards --templates", timeoutMs: 2 * 60 * 60 * 1000 });
  if (found.code !== 0) return fail(refusalOf({ script: "cards.py", args, what: "" }, found));
  const planned = await runStep(ctx, { script: "cards.py", args: ["--src", SRC_ARG, "--plan"], what: "cards --plan", timeoutMs: 10 * 60 * 1000 });
  if (planned.code !== 0) return fail(refusalOf({ script: "cards.py", args: ["--plan"], what: "" }, planned));
  return next("render", { cards: { templates, skips: fileExists(skips), evidence: fileExists(path.join(dirs.cut, "index", "skips-evidence.png")) ? "index/skips-evidence.png" : null, tail: tailLines(found.stdoutTail, 12) } });
}
