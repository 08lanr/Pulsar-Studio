// The pipeline's checks as the narrated stages run and read them (narrated
// spec N6). Studio only runs and surfaces them; every threshold, question
// and refusal is the pipeline's own.
//
//   The draft checks after a prep (E1): make_ep.py (its INVARIANT blocks:
//   inside build_ep.sh it is piped to `head -1` and does not, so Studio runs
//   it first and separately), dropped_lines, transcript, narr_lint,
//   scene_audit, ledger_check --plan over ep1..epN, continuity. A check that
//   FAILs is shown verbatim on the prep review with the waivers the agent
//   proposed; only make_ep sends the episode straight back to the prep.
//   The Jev-calling ones each get a `jev_check` job row (unmetered).
//
//   stale_check (E3 step 6, the shared-index rule after any prep): exit 1
//   blocks; a neighbour's picture that reads stale is marked `stale`.
//
//   The gate report of a build (`variants/vK/epN.mp4.gate.json`,
//   `{variant, counts: {PASS, WARN, FAIL}, items}`), read, never re-derived.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EpisodeGateCounts, FilmRunEpisode, Json } from "@/lib/types";
import { readJson, tailLines } from "../stages";
import { epDir, runCheckedStep, runFilmStep, withFilmLock, type FilmStep, type NarratedContext } from "./stages";

export type CheckResult = {
  script: string;
  args: string[];
  exit: number | null;
  /** Blocking (exit 1 stops the build): the pipeline's rule for that script. */
  blocking: boolean;
  /** The FAIL / WARN lines, verbatim, first 40. */
  fail_lines: string[];
  warn_lines: string[];
  tail: string[];
};

/** The FAIL and WARN lines of a check's output, verbatim. Pure. */
export function verdictLines(text: string): { fail: string[]; warn: string[] } {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  return {
    fail: lines.filter((l) => /\bFAIL\b|^\s*REFUSED|INVARIANT|\bLOST\b/.test(l)).slice(0, 40),
    warn: lines.filter((l) => /\bWARN\b/.test(l)).slice(0, 40),
  };
}

/** The draft checks of episode N, in the spec's order; `baseExists` picks make_ep's `--no-cut` (it fails with no base yet, ST/make_ep.py:135-137). */
export function draftChecks(n: number, opts: { baseExists: boolean; narration?: string }): FilmStep[] {
  const ep = epDir(n);
  const nf = opts.narration ?? "narration.json";
  const eps = Array.from({ length: n }, (_, i) => `ep${i + 1}`);
  return [
    { script: "make_ep.py", args: ["--ep", String(n), ...(opts.baseExists ? ["--no-cut"] : [])], what: "make_ep (draft)", timeoutMs: 60 * 60 * 1000 },
    { script: "dropped_lines.py", args: ["--eps", ep], what: "dropped_lines" },
    { script: "transcript.py", args: [ep, "--narration", nf, "--out", `${ep}/review/transcript.txt`], what: "transcript" },
    { script: "narr_lint.py", args: ["--ep", ep, "--narration", nf], what: "narr_lint (Jev)" },
    { script: "scene_audit.py", args: ["--ep", ep, "--narration", nf], what: "scene_audit (Jev)" },
    { script: "ledger_check.py", args: ["--plan", "--eps", ...eps], what: "ledger_check (Jev)" },
    { script: "continuity.py", args: ["--ep", ep, "--narration", nf], what: "continuity (Jev)" },
  ];
}

/** Run one check (make_ep under the shared `.lock`, Jev ones with their job row) and read its verdict lines. */
export async function runCheck(ctx: NarratedContext, step: FilmStep, n: number): Promise<CheckResult> {
  const run = () => runCheckedStep(ctx, { ...step, timeoutMs: step.timeoutMs ?? 30 * 60 * 1000 }, n);
  const r = step.script === "make_ep.py" ? await withFilmLock(ctx, run) : await run();
  const text = `${r.stdoutTail}\n${r.stderrTail}`;
  const v = verdictLines(text);
  return { script: step.script, args: step.args, exit: r.code, blocking: step.script !== "transcript.py", fail_lines: v.fail, warn_lines: v.warn, tail: tailLines(text, 20) };
}

/** All the draft checks of an episode, in order; make_ep's refusal stops the rest (nothing else can read a cut that was not made). */
export async function runDraftChecks(ctx: NarratedContext, ep: Pick<FilmRunEpisode, "n">): Promise<{ results: CheckResult[]; refused: string | null }> {
  const baseExists = existsSync(path.join(ctx.paths.film, epDir(ep.n), "base.mp4"));
  const results: CheckResult[] = [];
  for (const step of draftChecks(ep.n, { baseExists })) {
    await ctx.beat();
    const c = await runCheck(ctx, step, ep.n);
    results.push(c);
    if (step.script === "make_ep.py" && c.exit !== 0) {
      const text = c.fail_lines.length ? c.fail_lines.join("\n") : c.tail.join("\n");
      return { results, refused: `make_ep.py --ep ${ep.n} exited ${c.exit}\n${text}` };
    }
  }
  return { results, refused: null };
}

/** `stale_check.py --ep epN`: 0 fresh, 1 stale (its lines say which cue), anything else an error. */
export async function staleCheck(ctx: NarratedContext, n: number): Promise<{ stale: boolean; exit: number | null; lines: string[] }> {
  const r = await runFilmStep(ctx, { script: "stale_check.py", args: ["--ep", epDir(n)], what: `stale_check ep${n}` });
  return { stale: r.code === 1, exit: r.code, lines: tailLines(`${r.stdoutTail}\n${r.stderrTail}`, 12) };
}

/** gate.py's counts for a variant (`variants/vK/epN.mp4.gate.json`), or null when there is no report. */
export function readGate(variantDir: string, n: number): { counts: EpisodeGateCounts; file: string; items: Json } | null {
  const file = path.join(variantDir, `ep${n}.mp4.gate.json`);
  const g = readJson<{ counts?: Partial<EpisodeGateCounts>; items?: Json }>(file);
  if (!g?.counts) return null;
  const c = g.counts;
  return { counts: { PASS: Number(c.PASS ?? 0), WARN: Number(c.WARN ?? 0), FAIL: Number(c.FAIL ?? 0) }, file, items: g.items ?? [] };
}

/** The `.gate.md` beside a variant's report, when there is one (the E8 screen shows it). */
export function gateMarkdown(variantDir: string, n: number): string | null {
  const file = path.join(variantDir, `ep${n}.mp4.gate.md`);
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
