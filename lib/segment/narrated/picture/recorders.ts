// The pipeline's own recorders, called from Studio (narrated spec N0.2, N4):
// an API verdict enters a skip-through project ONLY through
// `frame_claims.py record` and `cut_joins.py record`, which check it against
// the prepared sheet (a text hash, a words fingerprint) and write
// `epN/review/frame_check.json` / `cut_joins.json` themselves. Studio writes
// the verdict file the recorder reads — `epN/review/frame_verdicts_studio-<run>-<k>.json`
// or `cut_verdicts_studio-<run>-<k>.json`, the Workflow's own return list —
// and never the records.
//
// `status` is the pipeline's too: frame_claims.py status always rewrites
// `review/frame_pending.json`; cut_joins.py status rewrites
// `review/cut_pending.json` only while something is pending, so the join
// pass reads the pending list only when status rewrote it (`rewrote`).
//
// Every script runs from the film root (the pipeline's paths are relative to
// it) with the film's synced scripts, through lib/python.ts, under the same
// environment allow-list as every other pipeline step (`stepEnv`). A recorder's
// refusal (exit 1, `sys.exit("frame_claims: ...")`) is returned verbatim.

import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { pipelinePython, runPython, type RunResult } from "@/lib/python";
import { stepEnv } from "../stages";

export type PictureRecorder = "frame_claims" | "cut_joins";

export type ScriptOutcome = {
  script: string;
  args: string[];
  code: number | null;
  /** Every line the script printed, stdout and stderr in arrival order. */
  lines: string[];
  /** The script's own words when it exited non-zero (the last lines of stderr, else of stdout); null on exit 0. */
  refusal: string | null;
  timed_out: boolean;
};

export type RecorderOptions = {
  /** The film root: the scripts' cwd. */
  film: string;
  /** Where the synced scripts are; `<film>/scripts` when absent. */
  scripts_dir?: string;
  python?: string;
  /** Kill after this long (default 10 minutes: the recorders read JSON only). */
  timeout_ms?: number;
  signal?: AbortSignal;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The refusal of a non-zero exit: stderr's last lines when it said anything, else stdout's. Pure. */
export function refusalText(r: Pick<RunResult, "code" | "stderrTail" | "stdoutTail" | "timedOut">): string | null {
  if (r.code === 0) return null;
  if (r.timedOut) return "timed out";
  const pick = (tail: string) => tail.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter(Boolean).slice(-12).join("\n");
  return pick(r.stderrTail) || pick(r.stdoutTail) || `exit ${r.code}`;
}

async function runScript(opts: RecorderOptions, script: string, args: string[]): Promise<ScriptOutcome> {
  const scriptsDir = opts.scripts_dir ?? path.join(opts.film, "scripts");
  const file = path.join(scriptsDir, script);
  if (!existsSync(file)) {
    return { script, args, code: null, lines: [], refusal: `${file} is missing: sync the skip-through scripts into the film first`, timed_out: false };
  }
  const lines: string[] = [];
  const run = runPython([file, ...args], {
    cwd: opts.film,
    // The per-step allow-list every pipeline step gets (N6): no key of Studio's reaches a recorder.
    env: stepEnv(process.env, {}) as NodeJS.ProcessEnv,
    python: opts.python ?? pipelinePython(),
    timeoutMs: opts.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    onLine: (stream, line) => {
      lines.push(line);
      opts.onLine?.(stream, line);
    },
  });
  const onAbort = () => void run.cancel();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await run.done;
    return { script, args, code: r.code, lines, refusal: r.cancelled ? "cancelled" : refusalText(r), timed_out: r.timedOut };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** A path under the film root in the pipeline's spelling (forward slashes, relative). */
export function filmRelative(film: string, file: string): string {
  const rel = path.relative(film, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${file} is not inside ${film}`);
  return rel.replace(/\\/g, "/");
}

// ---- verdict files ----------------------------------------------------------------------------------

export const VERDICT_PREFIX: Record<PictureRecorder, string> = { frame_claims: "frame_verdicts", cut_joins: "cut_verdicts" };

/** `frame_verdicts_studio-<run>-<k>.json`. Pure. */
export function verdictFileName(recorder: PictureRecorder, runId: string, k: number): string {
  return `${VERDICT_PREFIX[recorder]}_studio-${runId}-${k}.json`;
}

/** The next free k for a run in a review folder: one past the highest already there. */
export async function nextVerdictIndex(reviewDir: string, recorder: PictureRecorder, runId: string): Promise<number> {
  const prefix = `${VERDICT_PREFIX[recorder]}_studio-${runId}-`;
  let max = 0;
  for (const name of await fsp.readdir(reviewDir).catch(() => [] as string[])) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const k = Number(name.slice(prefix.length, -".json".length));
    if (Number.isInteger(k) && k > max) max = k;
  }
  return max + 1;
}

/**
 * Write the Workflow's return list (the shape both recorders accept, bare,
 * as `frame_verdicts_batch.json` holds it) as the run's next verdict file in
 * `<film>/<ep>/review/`, temp + rename. Returns its absolute path.
 */
export async function writeVerdictFile(film: string, ep: string, recorder: PictureRecorder, runId: string, list: unknown[]): Promise<string> {
  if (!/^[\w.-]+$/.test(runId)) throw new Error(`run id ${JSON.stringify(runId)} cannot name a file`);
  const reviewDir = path.join(film, ep, "review");
  await fsp.mkdir(reviewDir, { recursive: true });
  const file = path.join(reviewDir, verdictFileName(recorder, runId, await nextVerdictIndex(reviewDir, recorder, runId)));
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(list, null, 1)}\n`, "utf8");
  await fsp.rename(tmp, file);
  return file;
}

// ---- the recorders ---------------------------------------------------------------------------------

/** `python scripts/frame_claims.py record --ep <ep> --verdicts <file>` from the film root. */
export function recordFrameVerdicts(opts: RecorderOptions & { ep: string; verdicts: string }): Promise<ScriptOutcome> {
  return runScript(opts, "frame_claims.py", ["record", "--ep", opts.ep, "--verdicts", filmRelative(opts.film, opts.verdicts)]);
}

/** `python scripts/cut_joins.py record --ep <ep> --verdicts <file>` from the film root. */
export function recordCutVerdicts(opts: RecorderOptions & { ep: string; verdicts: string }): Promise<ScriptOutcome> {
  return runScript(opts, "cut_joins.py", ["record", "--ep", opts.ep, "--verdicts", filmRelative(opts.film, opts.verdicts)]);
}

export type StatusOutcome = ScriptOutcome & {
  /** The pending file the status call writes. */
  pending_file: string;
  /** True when this call wrote the pending file (frame_claims always does; cut_joins only while a join is pending). */
  rewrote: boolean;
};

async function mtimeOf(file: string): Promise<number | null> {
  return fsp.stat(file).then((s) => s.mtimeMs, () => null);
}

async function status(opts: RecorderOptions & { ep: string }, script: string, pendingName: string, args: string[]): Promise<StatusOutcome> {
  const pending = path.join(opts.film, opts.ep, "review", pendingName);
  const before = await mtimeOf(pending);
  const out = await runScript(opts, script, args);
  const after = await mtimeOf(pending);
  return { ...out, pending_file: pending, rewrote: after !== null && after !== before };
}

/** `frame_claims.py status --ep <ep>`: exit 1 while a line is unchecked or contradicted; writes review/frame_pending.json. */
export function frameClaimsStatus(opts: RecorderOptions & { ep: string }): Promise<StatusOutcome> {
  return status(opts, "frame_claims.py", "frame_pending.json", ["status", "--ep", opts.ep]);
}

/** `cut_joins.py status --ep <ep>`: exit 1 while a join is unjudged or lost; writes review/cut_pending.json only while one is unjudged. */
export function cutJoinsStatus(opts: RecorderOptions & { ep: string }): Promise<StatusOutcome> {
  return status(opts, "cut_joins.py", "cut_pending.json", ["status", "--ep", opts.ep]);
}
