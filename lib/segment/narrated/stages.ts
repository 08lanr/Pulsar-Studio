// The narrated route's stage machine: its vocabulary, its context and the
// helpers every stage shares (decision 2026-09-23 "Narrated mode in Studio";
// narrated spec N1 with Ruobin's amendments). One run per source episode
// under `projects/high-quality/<slug>`; the run row walks the run-level
// stages, and each episode walks two lanes on its own
// `studio.film_run_episodes` row.
//
// Run level (film_runs.stage):
//
//   intake → index → sheets → script_raw → script ✋ → episodes ✋ → episode_work → film_meta ✋ → handoff → done
//
// Per episode (film_run_episodes):
//
//   words    prep (a writing session) → prep_review ✋ → voice (paid) → frames → joins → ready
//   picture  waiting → picture (GPU, heavy lock) → [reframe_glance ✋] → ready   (stale when a cue fix outdated it)
//   joined   lanes → build (heavy lock) → ep_review ✋ → shipped   (or dropped)
//
// The four approvals that block (amendment 3): the script, the episode
// breaks, each episode's decide list plus the transcript read (prep_review:
// nothing is spent on voice or GPU before it — `requirePrepApproved`), and
// the final watch (ep_review). Nothing else waits for a person unless a
// check refused.
//
// The writing steps (the script read, the prep) are headless Claude Code
// sessions Studio launches itself (lib/claude-session.ts): one at a time on
// the machine, on the subscription, resumed by id after a usage limit or an
// interruption. `settings.creative = "handoff"` or a `run_yourself` decision
// keeps the old hand-off: the filled brief and the one command to run, and a
// wait for `handoff_done`.
//
// The stage functions return the cut-only machine's StageOutcome (next /
// wait / fail), so the worker drives both routes with one loop; a narrated
// wait names one of NARRATED_WAKES' keys. The per-episode steps return an
// EpisodeStepOutcome the episode scheduler (./build.ts) writes onto the
// episode's row.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { CHILD_ENV_ALLOWED, claudeLauncher, writingSlotHolder, type ClaudeLauncher, type SessionOutcome } from "@/lib/claude-session";
import type { RunEpisodeStageInput } from "@/lib/data";
import { LockHeldError, studioRunLock, type Held, type StudioRunLock } from "@/lib/locks";
import { dramaRemixRoot, gitBashPath, pipelinePython, runBashScript, runProcess, runPython, type RunResult } from "@/lib/python";
import { resolveNarratedSettings, type NarratedSettings } from "@/lib/segment/settings";
import { syncSkipThrough, type SyncResult } from "@/lib/segment/scripts-sync";
import type { FilmRun, FilmRunDecision, FilmRunEpisode, FilmRunStage, Json } from "@/lib/types";
import { RunCancelled, heavyLockRootFor, readJson, tailLines, type Env, type StageContext, type StageDetail, type StageOutcome, type WaitFor } from "../stages";

// ---- the vocabulary ------------------------------------------------------------------------------------------------

/** The run-level stages of a narrated run, in order (the terminal ones are the machine's). */
export const NARRATED_RUN_STAGES: readonly FilmRunStage[] = ["intake", "index", "sheets", "script_raw", "script", "episodes", "episode_work", "film_meta", "handoff"];

/**
 * The `action` of a narrated decision (film_runs.decisions; a per-episode
 * one carries `ep`). The decide route maps its `kind` onto these.
 *
 *   intake        {settings}: what the source cannot default (sheet_premise, season, voice_id), or a raised budget
 *   handoff_done  {stage, output_path?}: the person ran the hand-off themselves ("Run it yourself")
 *   run_yourself  switch a writing step to the hand-off (a limited session, or a preference)
 *   script        {action: approve | send_back}, `why` the note
 *   episodes      {action: approve | edit}, `why` the note (an edit re-issues the session)
 *   prep ep       {action: approve | send_back, answers: [...], waivers: [{key, reason}], transcript_read: true}
 *   reframe ep    {action: accept | override, shot, box? | crop?}
 *   voice ep      {action: go}: render past the episode's soft cap
 *   line ep       {action: reword | waive, id, text?}, `why` the reason
 *   join ep       {action: restore | narrate | waive, key}, `why` the reason
 *   episode ep    {action: approve | send_back | drop, to_stage?}, `why` the note
 *   film_meta     the season's titles and slug (no licence gate: amendment 5)
 *   import_now    import the delivered episodes
 *   retry         run the failed stage (or, with `ep`, the episode's refused step) again, unchanged
 */
export const NARRATED_DECISION = {
  intake: "intake",
  handoff_done: "handoff_done",
  run_yourself: "run_yourself",
  script: "script",
  episodes: "episodes",
  prep: "prep",
  reframe: "reframe",
  voice: "voice",
  line: "line",
  join: "join",
  episode: "episode",
  film_meta: "film_meta",
  import_now: "import_now",
  retry: "retry",
} as const;

export type NarratedDecisionAction = (typeof NARRATED_DECISION)[keyof typeof NARRATED_DECISION];

/** What a narrated run-level stage waits for (`stage_detail.waiting.for`). */
export type NarratedWaitFor =
  /** Settings the source cannot default (the sheet premise, the season, a voice). */
  | "intake"
  /** A writing session that could not run now: the machine's slot is busy, a usage limit has to reset, or Claude Code is missing / logged out. */
  | "session"
  /** "Run it yourself": the filled brief and the command are shown; `handoff_done` wakes it. */
  | "handoff"
  /** A picture pass that failed or had no reader: retry, or a hand-off. */
  | "sheets"
  | "script"
  | "episodes"
  /** Every open episode waits for a person, a lock or a limit (the episode rows say which). */
  | "episode_work"
  | "film_meta"
  | "ready"
  | "import";

/** Which decisions wake each narrated wait (the worker's `isActionable` reads WAKES ∪ this). */
export const NARRATED_WAKES: Record<NarratedWaitFor, readonly NarratedDecisionAction[]> = {
  intake: ["intake"],
  session: ["retry", "run_yourself", "handoff_done"],
  handoff: ["handoff_done", "retry"],
  sheets: ["retry", "handoff_done"],
  script: ["script", "run_yourself", "handoff_done", "retry"],
  episodes: ["episodes", "run_yourself", "handoff_done", "retry"],
  episode_work: ["prep", "reframe", "voice", "line", "join", "episode", "retry", "run_yourself", "handoff_done", "intake"],
  film_meta: ["film_meta"],
  ready: [],
  import: ["import_now"],
};

/** What one episode's lane waits for (`film_run_episodes.stage_detail.waiting`). */
export type EpisodeWaitFor = "session" | "handoff" | "prep" | "reframe" | "voice" | "line" | "join" | "episode" | "order" | "retry";

/** Which of the run's decisions (with this `ep`) wake an episode's wait. */
export const EPISODE_WAKES: Record<EpisodeWaitFor, readonly NarratedDecisionAction[]> = {
  session: ["retry", "run_yourself", "handoff_done"],
  handoff: ["handoff_done", "retry"],
  prep: ["prep"],
  reframe: ["reframe"],
  voice: ["voice", "intake"],
  // A Retry re-runs the pass too: a pass that recorded only part of the lines (a reader call failed) is finished by it.
  line: ["line", "retry"],
  join: ["join", "retry"],
  episode: ["episode"],
  order: [],
  retry: ["retry"],
};

/** A narrated wait as the cut-only machine's outcome: the worker writes `for` verbatim and the wakes are NARRATED_WAKES'. */
export function narratedWait(waitFor: NarratedWaitFor, detail?: StageDetail, retryMs?: number): StageOutcome {
  return { kind: "wait", for: waitFor as unknown as WaitFor, detail, retryMs };
}

/** The worker's actionable rule for a narrated run: WAKES from NARRATED_WAKES, the readiness poll as before. Pure. */
export function isNarratedActionable(run: Pick<FilmRun, "stage" | "stage_detail" | "decisions">, nowMs = Date.now()): boolean {
  if (run.stage === "done" || run.stage === "failed" || run.stage === "cancelled") return false;
  const d = run.stage_detail as { waiting?: { for?: unknown; retry_after?: unknown }; decisions_seen?: unknown } | null;
  const w = d && typeof d === "object" ? d.waiting : null;
  if (!w || typeof w.for !== "string") return true;
  const wakes = (NARRATED_WAKES as Record<string, readonly string[]>)[w.for] ?? [];
  const seen = typeof d?.decisions_seen === "number" ? d.decisions_seen : 0;
  if (run.decisions.slice(seen).some((x) => wakes.includes(x.action))) return true;
  if (typeof w.retry_after === "string") {
    const at = Date.parse(w.retry_after);
    return Number.isFinite(at) ? at <= nowMs : true;
  }
  return false;
}

// ---- the seams ------------------------------------------------------------------------------------------------------

/** One script under `<film>/scripts/` (or an absolute path: the canonical checks.py), run from the film root. */
export type FilmStep = {
  script: string;
  args: string[];
  /** For the log and the detail. */
  what: string;
  /** `python` (the pipeline's interpreter), `bash` (Git Bash), `gpu-python` (STUDIO_GPU_PYTHON), or an executable path (audio-separator). Default: by extension. */
  interpreter?: "python" | "bash" | "gpu-python" | { exe: string };
  /** Extra environment for this step (T0/T1, ELEVEN_MODEL); never a secret. */
  env?: Env;
  /** The secrets this step may see (N6: ELEVENLABS_API_KEY for voice only, TYPESAFE_API_KEY for Jev steps only). */
  keys?: ("ELEVENLABS_API_KEY" | "TYPESAFE_API_KEY")[];
  timeoutMs?: number;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
};

/**
 * Runs the pipeline's skip-through scripts for the narrated stages: cwd the
 * film root (the scripts find their project from their own location), a
 * per-step environment allow-list instead of full inheritance (N6), below-
 * normal priority, the child killed on a cancel.
 */
export interface NarratedScriptRunner {
  readonly fake: boolean;
  run(step: FilmStep, ctx: { film: string; signal: AbortSignal; heartbeat: { cb: () => void | Promise<void>; everyMs: number } }): Promise<RunResult>;
}

/** What a picture pass answered (sheets, frames, joins through the shim; lib/segment/narrated/picture/*). */
export type PictureOutcome =
  | { status: "done"; detail: StageDetail; contradicted?: { id: string; claim: string; evidence: string }[]; lost?: { id: string; why: string }[]; incomplete?: number }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: string; detail?: StageDetail };

/** The three API picture checks (amendment 6): the Workflow prompts through the shim, recorded only by the pipeline's recorders. */
export interface PictureReaders {
  sheets(ctx: NarratedContext): Promise<PictureOutcome>;
  frames(ctx: NarratedContext, ep: FilmRunEpisode): Promise<PictureOutcome>;
  joins(ctx: NarratedContext, ep: FilmRunEpisode): Promise<PictureOutcome>;
}

export type NarratedDeps = {
  launcher: ClaudeLauncher;
  /** Null: every picture check is a hand-off. */
  readers: PictureReaders | null;
  scripts: NarratedScriptRunner;
  /** The skip-through sync (tests inject a fake checkout's). */
  sync: (film: string, opts: { allowDirty: boolean }) => SyncResult;
  /** The canonical skip-through folder checks.py is run FROM (a drifted project copy would pass itself). */
  canonicalScripts: string;
};

/** Everything a narrated run touches on disk. */
export type NarratedPaths = {
  film: string;
  scripts: string;
  index: string;
  source: string;
  work: string;
  briefs: string;
  sessions: string;
  handoff: string;
  snapshots: string;
  logs: string;
  /** Where the machine's heavy lock and the writing-session lock live. */
  lockRoot: string;
  /** The folder the film sits in (`projects/`), for the brief's sibling-project paths. */
  projects: string;
};

export type NarratedContext = StageContext & NarratedDeps & { settings: NarratedSettings; paths: NarratedPaths };

export function narratedPaths(ctx: Pick<StageContext, "dirs" | "env">): NarratedPaths {
  const film = ctx.dirs.film;
  const work = ctx.dirs.work;
  return {
    film,
    scripts: path.join(film, "scripts"),
    index: path.join(film, "index"),
    source: path.join(film, "source", "original.mp4"),
    work,
    briefs: path.join(work, "briefs"),
    sessions: path.join(work, "sessions"),
    handoff: path.join(work, "handoff"),
    snapshots: path.join(work, "snapshots"),
    logs: path.join(work, "logs"),
    lockRoot: heavyLockRootFor(ctx.env),
    projects: ctx.dirs.root,
  };
}

/** The canonical skip-through folder of the drama-remix checkout. */
export function canonicalSkipThrough(env: Env = process.env): string {
  return path.join(dramaRemixRoot(env), "scripts", "skip-through");
}

/** The narrated run locks this process holds, by run id: `lock()` adopts, `releaseNarratedRunLock` removes the file when the run ends. */
const heldNarratedLocks = new Map<string, Held<StudioRunLock>>();

/** Take (or adopt) `<film>/.studio-run.json` for the run; a live foreign lock is a LockHeldError. */
export function takeNarratedRunLock(film: string, run: Pick<FilmRun, "id" | "stage">): Held<StudioRunLock> {
  const have = heldNarratedLocks.get(run.id);
  if (have) {
    have.update({ stage: run.stage });
    return have;
  }
  const held = narratedRunLock(film, run);
  heldNarratedLocks.set(run.id, held);
  return held;
}

/** The worker's `finally` for a narrated run that ended: remove its lock file (only while it is still this run's). */
export function releaseNarratedRunLock(runId: string): boolean {
  const held = heldNarratedLocks.get(runId);
  heldNarratedLocks.delete(runId);
  return held ? held.release() : false;
}

/** The narrated stages' context over the worker's: the real launcher, runner and sync unless given; `lock()` takes the lock at the film root. */
export function narratedContext(ctx: StageContext, deps: Partial<NarratedDeps> = {}): NarratedContext {
  const settings = resolveNarratedSettings(ctx.run);
  return {
    ...ctx,
    lock: () => {
      const held = takeNarratedRunLock(ctx.dirs.film, ctx.run);
      if (held.replaced) ctx.log(`replaced a stale run lock (${held.replaced.reason}): ${JSON.stringify(held.replaced.lock)}`);
    },
    launcher: deps.launcher ?? claudeLauncher({ env: ctx.env }),
    readers: deps.readers === undefined ? null : deps.readers,
    scripts: deps.scripts ?? realScriptRunner(ctx.env),
    sync: deps.sync ?? ((film, o) => syncSkipThrough(film, { root: dramaRemixRoot(ctx.env), allowDirty: o.allowDirty })),
    canonicalScripts: deps.canonicalScripts ?? canonicalSkipThrough(ctx.env),
    settings,
    paths: narratedPaths(ctx),
  };
}

/**
 * The narrated run's lock: `<film>/.studio-run.json` (N0.1), not the
 * cut-only `cut/.studio-run.json` — a narrated project has no cut/ folder,
 * and one would make the scanner read it as cut-only.
 */
export function narratedRunLock(film: string, run: Pick<FilmRun, "id" | "stage">): Held<StudioRunLock> {
  return studioRunLock(film, { run_id: run.id, stage: run.stage });
}

// ---- the environment of a step (N6) -----------------------------------------------------------------------------------

/**
 * The environment a step sees, as a patch over process.env: the machine's
 * basics (CHILD_ENV_ALLOWED, lib/claude-session.ts: PATH and the Windows
 * system variables a Python and an ffmpeg child need, the user folders the
 * model caches live under, PYTHON* / CUDA* / HF_* / OMP_*) and nothing
 * else — every other key is `undefined`, which Node leaves out of the child.
 * A secret only by name, for the step that needs it.
 */
export function stepEnv(base: Env, step: Pick<FilmStep, "env" | "keys">): Env {
  const out: Env = {};
  for (const k of Object.keys(base)) out[k] = CHILD_ENV_ALLOWED.test(k) ? base[k] : undefined;
  for (const k of step.keys ?? []) if (base[k] !== undefined) out[k] = base[k];
  for (const [k, v] of Object.entries(step.env ?? {})) out[k] = v;
  return out;
}

/**
 * The GPU venv's python: STUDIO_GPU_PYTHON, else the pipeline's own venv
 * beside mini-drama-system (`<workspace>/mini-drama-analysis/.gpu-venv`,
 * torch cu128 — the path residue_fix.py and the chain scripts hard-code),
 * when it is there; null otherwise.
 */
export function gpuPython(env: Env = process.env): string | null {
  const configured = env.STUDIO_GPU_PYTHON?.trim();
  if (configured) return configured;
  const beside = path.join(path.dirname(path.dirname(dramaRemixRoot(env))), "mini-drama-analysis", ".gpu-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return existsSync(beside) ? path.resolve(beside) : null;
}

/** audio-separator from the GPU venv: STUDIO_AUDIO_SEPARATOR, else beside STUDIO_GPU_PYTHON. */
export function audioSeparator(env: Env = process.env): string | null {
  const configured = env.STUDIO_AUDIO_SEPARATOR?.trim();
  if (configured) return configured;
  const py = gpuPython(env);
  return py ? path.join(path.dirname(py), process.platform === "win32" ? "audio-separator.exe" : "audio-separator") : null;
}

/** The real runner: the film's own scripts/ copy under the pipeline's interpreters. */
export function realScriptRunner(env: Env = process.env): NarratedScriptRunner {
  return {
    fake: false,
    async run(step, ctx) {
      const script = path.isAbsolute(step.script) ? step.script : path.join("scripts", step.script);
      const childEnv = stepEnv(env, step) as NodeJS.ProcessEnv;
      const opts = { cwd: ctx.film, env: childEnv, timeoutMs: step.timeoutMs, onLine: step.onLine, heartbeat: ctx.heartbeat, priority: "below_normal" as const };
      const how = step.interpreter ?? (step.script.endsWith(".sh") ? "bash" : "python");
      let p;
      if (how === "bash") {
        if (!gitBashPath()) throw new Error("could not run bash: Git for Windows' bash.exe was not found (set STUDIO_BASH to its path)");
        p = runBashScript(script, step.args, opts);
      } else if (how === "gpu-python") {
        const py = gpuPython(env);
        if (!py) throw new Error("STUDIO_GPU_PYTHON is not set: the picture lane needs the GPU venv's python (mini-drama-analysis/.gpu-venv/Scripts/python.exe)");
        p = runPython([script, ...step.args], { ...opts, python: py });
      } else if (how === "python") {
        p = runPython([script, ...step.args], { ...opts, python: pipelinePython(env) });
      } else {
        p = runProcess(how.exe, step.args, opts);
      }
      const onAbort = () => void p.cancel();
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await p.done;
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Run one step from the film root, every line to the run's log; a refusal is exit 1, answered, never thrown. */
export async function runFilmStep(ctx: NarratedContext, step: FilmStep): Promise<RunResult> {
  ctx.log(`> ${step.script} ${step.args.join(" ")}`);
  const onLine = step.onLine;
  const r = await ctx.scripts.run(
    {
      ...step,
      onLine: (stream, line) => {
        ctx.log(`${stream === "stderr" ? "! " : "  "}${line}`);
        onLine?.(stream, line);
      },
    },
    { film: ctx.paths.film, signal: ctx.signal, heartbeat: { cb: ctx.beat, everyMs: 30_000 } }
  );
  if (ctx.signal.aborted) throw new RunCancelled(ctx.run.id);
  ctx.log(`< ${step.script} exit ${r.code ?? "killed"} in ${Math.round(r.durationMs / 1000)} s`);
  return r;
}

/** The skip-through scripts that call TypeSafe Jev (jev.py): one `jev_check` job row per run of one, cost null until jev.py logs usage. */
export const JEV_SCRIPTS = ["narr_lint.py", "scene_audit.py", "continuity.py", "ledger_check.py", "preflight.py"] as const;

export function isJevScript(script: string): boolean {
  return (JEV_SCRIPTS as readonly string[]).includes(path.basename(script));
}

/** Run a step; a Jev-calling one gets TYPESAFE_API_KEY and its `jev_check` job row (unmetered: cost null). */
export async function runCheckedStep(ctx: NarratedContext, step: FilmStep, ep: number | null): Promise<RunResult> {
  if (!isJevScript(step.script)) return runFilmStep(ctx, step);
  const stamp = new Date().toISOString();
  const job = await ctx.data.recordJob(ctx.session, {
    kind: "jev_check",
    title_id: null,
    target_type: "film_run",
    target_id: ctx.run.id,
    idempotency_key: `jev:${ctx.run.id}:${ep ?? "run"}:${path.basename(step.script)}:${stamp}`,
    input: { script: path.basename(step.script), args: step.args, ep, metered: false } as Json,
  });
  const r = await runFilmStep(ctx, { ...step, keys: [...(step.keys ?? []), "TYPESAFE_API_KEY"] });
  await ctx.data
    .finishJob(ctx.session, job.id, { status: r.code === 0 || r.code === 1 ? "done" : "failed", cost_cents: null, output: { exit: r.code, unmetered: true, last: tailLines(r.stdoutTail, 3) } as Json, error: r.code === 0 || r.code === 1 ? null : `exit ${r.code}` })
    .catch(() => undefined);
  return r;
}

// ---- refusals (N6) ---------------------------------------------------------------------------------------------------

/** The stop lines build_ep.sh prints before `exit 1`; each names what refused. */
export const BUILD_STOP_LINES = [/^PICTURE IS STALE/, /^LEDGER FAILED/, /^FRAME CHECK:/, /^CUT CHECK:/, /^STT VERIFY FAILED/, /^GATE FAILED/] as const;

/**
 * A narrated step's refusal, verbatim: build_ep.sh's stop lines (GATE FAILED
 * with the next line naming the .gate.md), a FAIL / REFUSED / NOT READY line
 * of the script itself, else the stderr tail, else the last stdout line.
 * For a bare `|| exit 1` inside build_ep.sh (dropped_lines, continuity,
 * narr_lint, scene_audit, the prepares, assemble_v) the script that ran
 * last is named from the log (`lastScript`).
 */
export function narratedRefusal(step: Pick<FilmStep, "script">, r: Pick<RunResult, "code" | "stdoutTail" | "stderrTail" | "timedOut" | "cancelled">, lastScript: string | null = null): string {
  if (r.timedOut) return `${path.basename(step.script)} ran past its time limit and was stopped`;
  if (r.cancelled) return `${path.basename(step.script)} was cancelled`;
  const out = r.stdoutTail.replace(/\r/g, "");
  const err = r.stderrTail.replace(/\r/g, "").trim();
  const lines = out.split("\n").map((l) => l.replace(/\s+$/, ""));
  const head = `${path.basename(step.script)} exited ${r.code ?? "killed"}`;
  const stop = lines.findIndex((l) => BUILD_STOP_LINES.some((re) => re.test(l.trim())));
  if (stop >= 0) {
    const take = /^GATE FAILED/.test(lines[stop].trim()) ? lines.slice(stop, stop + 2) : [lines[stop]];
    const fails = lines.filter((l) => /^\s*FAIL\b/.test(l)).slice(0, 12);
    return `${head}\n${[...fails, ...take].join("\n")}`.slice(0, 6000);
  }
  const at = lines.findIndex((l) => /^\s*(REFUSED|FAIL|NOT READY|INVARIANT)/.test(l));
  let text = at >= 0 ? lines.slice(at).join("\n").trim() : "";
  if (!text && err) text = err.split("\n").slice(-12).join("\n");
  if (!text) text = lines.filter(Boolean).slice(-1)[0] ?? "";
  const named = lastScript && !text.includes(lastScript) ? `(the step that stopped: ${lastScript})\n` : "";
  return `${head}\n${named}${text || `${path.basename(step.script)} exited ${r.code}`}`.slice(0, 6000);
}

/** The last `scripts/<name>.py` a build log shows running (bash -x is not on; the scripts print their own names or outputs). */
export function lastScriptOf(lines: string[], known: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const name of known) if (lines[i].includes(name)) return name;
  }
  return null;
}

// ---- per-episode decisions --------------------------------------------------------------------------------------------

/** How many of the run's decisions the episode has consumed (`stage_detail.decisions_seen` on the episode row). */
export function episodeDecisionsSeen(ep: Pick<FilmRunEpisode, "stage_detail">): number {
  const d = ep.stage_detail as { decisions_seen?: unknown } | null;
  const n = d && typeof d === "object" ? d.decisions_seen : undefined;
  return typeof n === "number" && n >= 0 ? n : 0;
}

/** The run's decisions about this episode (by `ep`) the episode has not acted on. */
export function pendingEpisodeDecisions(run: Pick<FilmRun, "decisions">, ep: Pick<FilmRunEpisode, "n" | "stage_detail">): FilmRunDecision[] {
  return run.decisions.slice(episodeDecisionsSeen(ep)).filter((d) => d.ep === ep.n);
}

/** The newest pending decision about the episode with one of these actions, or null. */
export function pendingEpisodeDecision(run: Pick<FilmRun, "decisions">, ep: Pick<FilmRunEpisode, "n" | "stage_detail">, ...actions: NarratedDecisionAction[]): FilmRunDecision | null {
  const hits = pendingEpisodeDecisions(run, ep).filter((d) => (actions as string[]).includes(d.action));
  return hits.length ? hits[hits.length - 1] : null;
}

/** The pending run-level decisions (no `ep`) with one of these actions, newest last. */
export function pendingRunDecisions(run: Pick<FilmRun, "decisions" | "stage_detail">, ...actions: NarratedDecisionAction[]): FilmRunDecision[] {
  const d = run.stage_detail as { decisions_seen?: unknown } | null;
  const seen = d && typeof d.decisions_seen === "number" ? d.decisions_seen : 0;
  return run.decisions.slice(seen).filter((x) => (x.ep === undefined || x.ep === null) && (actions as string[]).includes(x.action));
}

/** A decision's `data` as an object, or {}. */
export function dataOf(d: FilmRunDecision | null | undefined): Record<string, Json | undefined> {
  const v = d?.data;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json | undefined>) : {};
}

// ---- the prep approval: nothing paid before it (amendment 3) ------------------------------------------------------------

export type PrepApproval = { by: string; at: string; answers: Json; waivers: Json };

/** The episode's recorded decide-list approval (E2), or null. */
export function prepApprovalOf(ep: Pick<FilmRunEpisode, "stage_detail">): PrepApproval | null {
  const d = ep.stage_detail as { prep_approved?: unknown } | null;
  const a = d && typeof d === "object" ? (d.prep_approved as PrepApproval | undefined) : undefined;
  return a && typeof a.at === "string" && typeof a.by === "string" ? a : null;
}

/** The refusal of a voice or GPU step before the decide-list approval (amendment 3), or null when it may start. */
export function requirePrepApproved(ep: Pick<FilmRunEpisode, "n" | "stage_detail">, what: "voice" | "picture"): string | null {
  if (prepApprovalOf(ep)) return null;
  return `ep${ep.n}: the ${what === "voice" ? "voice (paid ElevenLabs)" : "GPU picture lane"} does not start before the episode's decide list and transcript read are approved (prep review)`;
}

// ---- an episode step's answer -----------------------------------------------------------------------------------------

/** The episode fields a step moves; the scheduler adds the revision and the owner. */
export type EpisodePatch = Omit<RunEpisodeStageInput, "revision" | "owner">;

/** A change a step asks for on ANOTHER episode's row (a cue fix made a neighbour's picture stale); the scheduler claims that row to write it. */
export type NeighbourPatch = { n: number; patch: EpisodePatch; why: string };

export type EpisodeStepOutcome = (
  /** The step finished: write this. */
  | { kind: "moved"; patch: EpisodePatch; note?: string }
  /** The lane waits (a person, a lock, a limit); `retryMs` looks again without a decision. */
  | { kind: "wait"; for: EpisodeWaitFor; detail?: StageDetail; retryMs?: number; patch?: EpisodePatch }
  /** A check refused: the verbatim text goes on the episode (error_text), the lane waits for a retry or the patch's send-back. */
  | { kind: "refused"; error: string; detail?: StageDetail; patch?: EpisodePatch }
) & { others?: NeighbourPatch[] };

// ---- the writing sessions ---------------------------------------------------------------------------------------------

/** How a writing step asks for its session. */
export type WritingSpec = {
  /** `script` or `prep-ep12`: the brief's file name and the log's. */
  label: string;
  /** The machine lock's holder: `<run>/script`, `<run>/ep12`. */
  holder: string;
  what: string;
  /** The filled brief (a new session). */
  brief: { text: string; sha: string; path: string };
  /** Where the session left off, from the stage detail: its id and how it ended. */
  previous: SessionRecord | null;
  /** A continuation for a resumed session (a send-back note, a refusal to fix); default "Continue …". */
  continuation?: string | null;
  /** Folders outside the film the session may write (the work folder for an output file). */
  extraDirs?: string[];
};

/** What a stage keeps of its session (`stage_detail.session`). */
export type SessionRecord = {
  session_id: string | null;
  status: "running" | "done" | "limited" | "interrupted" | "failed" | "busy" | "unavailable";
  transport: string | null;
  log_file: string | null;
  brief_path: string;
  brief_sha: string;
  started_at: string;
  ended_at: string | null;
  resets_at?: string | null;
  message?: string | null;
  turns?: number;
  /** How many times this step's session was resumed. */
  resumes: number;
  /** The note (a send-back, an edit, a refusal to fix) this session was asked to act on; kept until it is done, so a busy slot, a limit, an interruption or a failure never loses it. */
  continuation?: string | null;
};

export function sessionRecordOf(detail: Json | undefined): SessionRecord | null {
  const v = detail as SessionRecord | undefined;
  return v && typeof v === "object" && typeof v.status === "string" && typeof v.brief_path === "string" ? v : null;
}

/** The one command a person runs in "Run it yourself" (the hand-off fallback). */
export function runYourselfCommand(film: string, briefPath: string): string {
  return `cd "${film.replace(/\\/g, "/")}" && claude "$(cat '${briefPath.replace(/\\/g, "/")}')"`;
}

export type WritingResult =
  /** The session answered (or the person ran it and said so): validate the outputs. */
  | { kind: "done"; record: SessionRecord }
  /** Nothing to validate yet: wait (`session` for a limit / busy slot / missing CLI, `handoff` for run-it-yourself). */
  | { kind: "wait"; for: "session" | "handoff"; record: SessionRecord; detail: StageDetail; retryMs?: number }
  /** A session error a resume will not cure: shown verbatim, Retry starts again. */
  | { kind: "failed"; record: SessionRecord; error: string };

/**
 * Run (or resume) the writing session a step needs, or wait for the person
 * who runs it themselves. The stage detail keeps the session record, so a
 * worker restart mid-session RESUMES by id ("running" with an id means the
 * process died with the worker) and a usage limit waits until it resets.
 */
export async function runWritingSession(ctx: NarratedContext, spec: WritingSpec, opts: { handoff: boolean; progress: (record: SessionRecord, progress: Json) => Promise<void> }): Promise<WritingResult> {
  const now = () => new Date().toISOString();
  const prev = spec.previous;
  // A note (a send-back, an edit, a refusal to fix) that a session never finished — the slot was busy, a limit or an
  // interruption stopped it, it failed, Claude Code was missing — is still the note to send: the decision that carried it
  // is consumed, so the record is the only place it survives.
  const note = spec.continuation ?? (prev && prev.status !== "done" ? prev.continuation ?? null : null);
  mkdirSync(path.dirname(spec.brief.path), { recursive: true });
  // The brief file is what "Run it yourself" hands over: a send-back note rides at its end there, since no conversation carries it.
  const fileText = opts.handoff && note ? `${spec.brief.text}\n\n${note}\n` : spec.brief.text;
  if (!existsSync(spec.brief.path) || readFileSync(spec.brief.path, "utf8") !== fileText) writeFileSync(spec.brief.path, fileText, "utf8");

  if (opts.handoff) {
    const record: SessionRecord = { ...(prev ?? { session_id: null, transport: null, log_file: null, started_at: now(), ended_at: null, resumes: 0 }), status: "running", brief_path: spec.brief.path, brief_sha: spec.brief.sha, message: "run it yourself", continuation: note } as SessionRecord;
    return {
      kind: "wait",
      for: "handoff",
      record,
      detail: { handoff: { command: runYourselfCommand(ctx.paths.film, spec.brief.path), brief_path: spec.brief.path, brief_sha: spec.brief.sha } as Json },
    };
  }

  // Resume the same conversation when there is one for this brief: after a limit or an interruption, or — a finished one — when a
  // send-back note or a refusal continues it. A new brief (another sha) starts a new session.
  // A failed session (an error a resume will not cure) starts again.
  const resumable = prev ? ["running", "limited", "interrupted", "busy"].includes(prev.status) || (prev.status === "done" && !!note) : false;
  const resumeId = prev && prev.session_id && prev.brief_sha === spec.brief.sha && resumable ? prev.session_id : null;
  const continuation = note ?? "Continue the task from where you stopped. When it is done, give the summary the brief asks for.";
  const logFile = path.join(ctx.paths.sessions, `${spec.label}.jsonl`);
  const started: SessionRecord = {
    session_id: resumeId,
    status: "running",
    transport: null,
    log_file: logFile,
    brief_path: spec.brief.path,
    brief_sha: spec.brief.sha,
    started_at: prev?.started_at ?? now(),
    ended_at: null,
    resumes: (prev?.resumes ?? 0) + (resumeId ? 1 : 0),
    // Kept until the session is done: a worker that dies mid-session leaves this record, and the resume sends the note again.
    continuation: note,
  };
  // The machine's writing slot, looked at before anything is recorded: a busy slot is a wait, not a job row a minute.
  const holder = writingSlotHolder({ root: ctx.paths.lockRoot, holder: spec.holder, what: spec.what });
  if (holder) {
    const message = `another writing session holds the machine's slot: ${holder.what} (${holder.run_id ?? holder.owner}, since ${holder.started_at})`;
    return { kind: "wait", for: "session", record: { ...(prev ?? started), status: "busy", message, continuation: note }, detail: { session_problem: message }, retryMs: 60_000 };
  }
  await opts.progress(started, null).catch(() => undefined);

  const job = await ctx.data.recordJob(ctx.session, {
    kind: "claude_session",
    title_id: null,
    target_type: "film_run",
    target_id: ctx.run.id,
    idempotency_key: `claude_session:${ctx.run.id}:${spec.label}:${spec.brief.sha.slice(0, 12)}:${started.resumes}:${Date.now()}`,
    model: ctx.settings.writer_model,
    provider: "claude-code",
    input: { label: spec.label, brief_path: spec.brief.path, brief_sha: spec.brief.sha, resume: resumeId, billing: "subscription" } as Json,
  });

  let lastProgressAt = 0;
  const req = {
    cwd: ctx.paths.film,
    model: ctx.settings.writer_model,
    maxTurns: ctx.settings.session_max_turns,
    additionalDirectories: spec.extraDirs ?? [],
    skills: ["drama-remix"],
    logFile,
    signal: ctx.signal,
    env: ctx.env,
    lock: { root: ctx.paths.lockRoot, holder: spec.holder, what: spec.what },
    onEvent: (e: { progress: { session_id: string | null } & Record<string, unknown> }) => {
      const t = Date.now();
      if (t - lastProgressAt < 5000) return;
      lastProgressAt = t;
      void opts.progress({ ...started, session_id: e.progress.session_id ?? started.session_id }, e.progress as unknown as Json).catch(() => undefined);
    },
  };
  let out: SessionOutcome;
  try {
    out = resumeId ? await ctx.launcher.resume(resumeId, continuation, req) : await ctx.launcher.launch({ ...req, prompt: note ? `${spec.brief.text}\n\n${note}` : spec.brief.text });
  } catch (e) {
    if (e instanceof RunCancelled) throw e;
    out = { status: "failed", transport: "sdk", session_id: resumeId, log_file: logFile, turns: 0, message: e instanceof Error ? e.message : String(e) };
  }
  if (ctx.signal.aborted) {
    await ctx.data.finishJob(ctx.session, job.id, { status: "cancelled", cost_cents: null }).catch(() => undefined);
    throw new RunCancelled(ctx.run.id);
  }

  const ended = now();
  const base: SessionRecord = { ...started, ended_at: ended };
  if (out.status === "busy" || out.status === "unavailable") {
    const record: SessionRecord = { ...base, status: out.status, message: out.message };
    await ctx.data.finishJob(ctx.session, job.id, { status: "cancelled", cost_cents: null, output: { status: out.status, message: out.message } as Json }).catch(() => undefined);
    // Busy: look again in a minute. Missing CLI / logged out: a person installs or logs in, then Retry.
    return { kind: "wait", for: "session", record, detail: { session_problem: out.message }, retryMs: out.status === "busy" ? 60_000 : undefined };
  }
  const record: SessionRecord = { ...base, status: out.status, session_id: out.session_id ?? base.session_id, transport: out.transport, turns: out.turns };
  const output = { status: out.status, session_id: record.session_id, turns: out.turns, transport: out.transport, billing: "subscription" } as Record<string, Json>;
  if (out.status === "done") {
    output.cost_usd_estimate = out.cost_usd;
    await ctx.data.finishJob(ctx.session, job.id, { status: "done", cost_cents: null, output: output as Json }).catch(() => undefined);
    return { kind: "done", record: { ...record, continuation: null } };
  }
  await ctx.data.finishJob(ctx.session, job.id, { status: out.status === "failed" ? "failed" : "cancelled", cost_cents: null, output: output as Json, error: out.message.slice(0, 2000) }).catch(() => undefined);
  if (out.status === "limited") {
    const resets = out.resets_at ? Math.max(60_000, Date.parse(out.resets_at) - Date.now() + 60_000) : 30 * 60_000;
    return { kind: "wait", for: "session", record: { ...record, resets_at: out.resets_at, message: out.message }, detail: { session_problem: `${out.message}${out.resets_at ? ` (resets ${out.resets_at})` : ""}; the session resumes by its id` }, retryMs: resets };
  }
  if (out.status === "interrupted") {
    return { kind: "wait", for: "session", record: { ...record, message: out.message }, detail: { session_problem: `${out.message}; Retry resumes session ${record.session_id ?? "(no id)"}` } };
  }
  return { kind: "failed", record: { ...record, message: out.message }, error: out.message };
}

// ---- what a session wrote ---------------------------------------------------------------------------------------------

/** Every file under the film root with its mtime and size (the heavy media folders skipped; junctions not followed). */
export type MtimeSnapshot = Record<string, { mtime_ms: number; size: number }>;

const SNAPSHOT_SKIP = new Set(["source", "scripts", "node_modules", ".git", "__pycache__", "stems", "pieces", "clean_evidence", "variants", "frames", "joins", "sheets", "narration", "audition"]);

export function snapshotMtimes(root: string): MtimeSnapshot {
  const out: MtimeSnapshot = {};
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // an epK junction to a prior project is not this project's
      if (e.isDirectory()) {
        if (SNAPSHOT_SKIP.has(e.name) || e.name === ".lock") continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        try {
          const s = statSync(path.join(dir, e.name));
          out[r] = { mtime_ms: s.mtimeMs, size: s.size };
        } catch {
          // gone between the listing and the stat
        }
      }
    }
  };
  walk(root, "");
  return out;
}

/** Files created or changed between two snapshots that no `allowed` pattern covers (N0.3: "flags any write outside writes"). */
export function writesOutside(before: MtimeSnapshot, after: MtimeSnapshot, allowed: readonly RegExp[]): string[] {
  const out: string[] = [];
  for (const [rel, s] of Object.entries(after)) {
    const b = before[rel];
    if (b && b.mtime_ms === s.mtime_ms && b.size === s.size) continue;
    if (allowed.some((re) => re.test(rel))) continue;
    out.push(rel);
  }
  for (const rel of Object.keys(before)) if (!after[rel] && !allowed.some((re) => re.test(rel))) out.push(`${rel} (deleted)`);
  return out.sort();
}

// ---- the shared-index lock (the prep brief's own `mkdir .lock`) -----------------------------------------------------------

/** Hold `<film>/.lock` (the directory the prep agents take around make_ep and the shared index files) while `fn` runs; waits while an agent holds it. */
export async function withFilmLock<T>(ctx: Pick<NarratedContext, "paths" | "beat" | "signal" | "run">, fn: () => Promise<T>, opts: { pollMs?: number; maxWaitMs?: number } = {}): Promise<T> {
  const dir = path.join(ctx.paths.film, ".lock");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (ctx.signal.aborted) throw new RunCancelled(ctx.run.id);
      const age = (() => {
        try {
          return Date.now() - statSync(dir).mtimeMs;
        } catch {
          return 0;
        }
      })();
      // The brief says "never hold it while you think": a lock older than 30 minutes is a dead agent's.
      if (age > 30 * 60_000) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (opts.maxWaitMs !== undefined && Date.now() - started > opts.maxWaitMs) throw new LockHeldError(dir, { run_id: "?", stage: "?", started_at: new Date(Date.now() - age).toISOString(), pid: 0, owner: "a prep agent" }, `${dir} is held by a prep agent`);
      await ctx.beat();
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 3000));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the project writer (N4: the few files Studio writes into a project) ------------------------------------------------

/**
 * Write one project file Studio is allowed to write (waivers.json, a line's
 * text in narration.json, film-meta.json, DELIVERED-narrated.json,
 * sheet_premise.txt, credits-ledger.json): the previous bytes are copied to
 * `<work>/snapshots/` first, the new ones land through a temp file renamed
 * into place, and `<work>/project-writes.jsonl` records who, why and the
 * snapshot — the decision that asked for it is the person's record.
 */
export function writeProjectFile(ctx: Pick<NarratedContext, "paths" | "log">, rel: string, content: string, why: { by: string; why: string; decision_at?: string | null }): string {
  const file = path.join(ctx.paths.film, ...rel.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  let snapshot: string | null = null;
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    snapshot = path.join(ctx.paths.snapshots, `${rel.replace(/[\\/]/g, "__")}.${stamp}`);
    mkdirSync(path.dirname(snapshot), { recursive: true });
    writeFileSync(snapshot, readFileSync(file));
  }
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
  mkdirSync(ctx.paths.work, { recursive: true });
  appendFileSync(path.join(ctx.paths.work, "project-writes.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), file: rel, snapshot, sha256: sha256Of(content), ...why })}\n`, "utf8");
  ctx.log(`wrote ${rel}${snapshot ? ` (previous kept at ${snapshot})` : ""}: ${why.why}`);
  return file;
}

/** Remove one project file Studio is allowed to write, the same way: snapshot first, recorded with who and why. False when it was not there. */
export function removeProjectFile(ctx: Pick<NarratedContext, "paths" | "log">, rel: string, why: { by: string; why: string; decision_at?: string | null }): boolean {
  const file = path.join(ctx.paths.film, ...rel.split("/"));
  if (!existsSync(file)) return false;
  const bytes = readFileSync(file);
  const snapshot = path.join(ctx.paths.snapshots, `${rel.replace(/[\\/]/g, "__")}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(path.dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, bytes);
  rmSync(file, { force: true });
  mkdirSync(ctx.paths.work, { recursive: true });
  appendFileSync(path.join(ctx.paths.work, "project-writes.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), file: rel, removed: true, snapshot, ...why })}\n`, "utf8");
  ctx.log(`removed ${rel} (kept at ${snapshot}): ${why.why}`);
  return true;
}

export function sha256Of(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A file's SHA-256, or null when it is not there. */
export function fileSha256(file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

// ---- small readers --------------------------------------------------------------------------------------------------

/** `epN` for a season number. */
export const epDir = (n: number): string => `ep${n}`;

/** The source's length the intake measured (stage_detail.source.duration_s), or null. */
export function sourceDurationOf(run: Pick<FilmRun, "stage_detail">): number | null {
  const s = (run.stage_detail as { source?: { duration_s?: unknown } } | null)?.source;
  return s && typeof s.duration_s === "number" && Number.isFinite(s.duration_s) ? s.duration_s : null;
}

/** Newest `variants/vK` of an episode folder, or null. */
export function newestVariant(epFolder: string): { name: string; k: number } | null {
  let best: { name: string; k: number } | null = null;
  try {
    for (const e of readdirSync(path.join(epFolder, "variants"), { withFileTypes: true })) {
      const m = /^v(\d+)$/.exec(e.name);
      if (m && e.isDirectory() && (!best || Number(m[1]) > best.k)) best = { name: e.name, k: Number(m[1]) };
    }
  } catch {
    return null;
  }
  return best;
}

/** True when an episode folder holds a shipped variant: some `variants/vK/epN.mp4` beside a gate report with FAIL 0. */
export function hasShippedVariant(epFolder: string, n: number): boolean {
  try {
    for (const e of readdirSync(path.join(epFolder, "variants"), { withFileTypes: true })) {
      if (!e.isDirectory() || !/^v\d+$/.test(e.name)) continue;
      const dir = path.join(epFolder, "variants", e.name);
      if (!existsSync(path.join(dir, `ep${n}.mp4`))) continue;
      const gate = readJson<{ counts?: { FAIL?: number } }>(path.join(dir, `ep${n}.mp4.gate.json`));
      if (gate?.counts && gate.counts.FAIL === 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

// ---- the dispatch (the worker calls this for a narrated run) -------------------------------------------------------------

type NarratedStageFn = (ctx: NarratedContext) => Promise<StageOutcome>;

/** The stage functions, loaded on first use (the stage modules import this one; a static import back would be a cycle). */
async function stageTable(): Promise<Partial<Record<FilmRunStage, NarratedStageFn>>> {
  const [intake, index, sheets, script, build, handoff] = await Promise.all([import("./intake"), import("./index"), import("./sheets"), import("./script"), import("./build"), import("./handoff")]);
  return {
    intake: intake.runNarratedIntakeStage,
    index: index.runNarratedIndexStage,
    sheets: sheets.runSheetsStage,
    script_raw: script.runScriptRawStage,
    script: script.runScriptStage,
    episodes: script.runEpisodesStage,
    episode_work: build.runEpisodeWorkStage,
    film_meta: handoff.runNarratedFilmMetaStage,
    handoff: handoff.runNarratedHandoffStage,
  };
}

/**
 * The one entry the worker needs for a narrated run: the stage function of
 * `ctx.run.stage` over the narrated context. `deps` injects the launcher,
 * the readers and the runner (tests, the fake pipeline).
 */
export async function runNarratedStage(ctx: StageContext, deps: Partial<NarratedDeps> = {}): Promise<StageOutcome> {
  const table = await stageTable();
  const fn = table[ctx.run.stage];
  if (!fn) return { kind: "fail", error: `no narrated stage ${ctx.run.stage}` };
  return fn(narratedContext(ctx, deps));
}
