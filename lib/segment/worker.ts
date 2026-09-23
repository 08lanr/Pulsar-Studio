// The segment worker (plan B1): claims runs, drives the stage machine, and
// lets go. One process, `scripts/segment-worker.ts`, in Supabase mode
// (stages run for an hour and a dev-server restart would kill their
// children); in fixture mode the same loop runs inside the dev server
// (`ensureInProcessWorker`), because the fixture store is that process's
// memory — a second process would see no runs. Either way a restart is
// safe: the row says the stage, the artifacts on disk say what is done, and
// every stage skips what it finds finished.
//
// One tick: list the runs, pick the actionable ones (not terminal, not
// waiting for a decision that has not come, no other worker's live lease),
// claim each with a CAS on its revision, and drive it stage by stage until
// it waits, ends or fails. While a script runs the lease is renewed every
// thirty seconds and the row re-read: a `cancelled` row aborts the child
// (`taskkill /T /F`) and releases the locks. Every stage is a `segment_film`
// job row (cost 0) on the run. `cut/.studio-run.json` is taken once the
// intake's folder check has passed (a refused folder never gets it), before
// every later stage, and removed when the run ends, so a Claude Code session
// sees Studio is at work in that folder.

import { appendFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { systemSession, type Session } from "@/lib/auth";
import { getData, isDataError, type DataLayer, type FilmRunStageInput } from "@/lib/data";
import { dataSource } from "@/lib/data-source";
import { ffprobeFacts, type VideoFacts } from "@/lib/film-import/import";
import { LockHeldError, studioRunLock, workerName, type Held, type StudioRunLock } from "@/lib/locks";
import { dramaRemixRoot, runBashScript, runProcess, runPython, type RunResult } from "@/lib/python";
import { ffmpegBin } from "@/lib/clips/cut";
import { syncScripts, type SyncResult } from "@/lib/segment/scripts-sync";
import { annotateEnabled, annotateStrip } from "@/lib/segment/annotate";
import { renderDenseStrip, type StripImage } from "@/lib/segment/strips";
import { judgeBandFix, judgeBoundaries, type BandFixResult, type JudgeResult, type JudgeUnavailable } from "@/lib/segment/vision";
import type { FilmRun, FilmRunStage, Json } from "@/lib/types";
import { FakePipelineRunner } from "./fake-runner";
import { runFilmMetaStage, runHandoffStage } from "./handoff";
import { runCardsStage, runIndexStage } from "./index";
import { runIntakeStage } from "./intake";
import { runPlanStage, runReviewStage, runVisionStage } from "./plan";
import { runQaStage } from "./qa";
import { runRenderStage } from "./render";
import {
  DECISION,
  RunCancelled,
  fakePipeline,
  isActionable,
  isTerminal,
  runDirs,
  type BandFixRequest,
  type Env,
  type JudgeRequest,
  type PipelineRunner,
  type RunnerContext,
  type ScriptStep,
  type StageContext,
  type StageDetail,
  type StageOutcome,
  type Waiting,
} from "./stages";
import { runWatermarkStage } from "./watermark";

// ---- the real runner -----------------------------------------------------------------------------------------------------------------

/** The pipeline as it is: the film's own cut/scripts copy under the pipeline's interpreter, ffprobe, the drama-remix sync, lib/llm's vision pass, ffmpeg proxies. */
export function realRunner(env: Env = process.env): PipelineRunner {
  return {
    fake: false,
    async run(step: ScriptStep, ctx: RunnerContext): Promise<RunResult> {
      // checks.py is run FROM the canonical copy (README, "Order of work" 0): a drifted project copy would pass itself.
      const script = step.script === "checks.py" ? path.join(dramaRemixRoot(env), "scripts", "cut-only", "checks.py") : path.join("scripts", step.script);
      const opts = { cwd: ctx.cutDir, env: { ...process.env, ...ctx.env } as NodeJS.ProcessEnv, timeoutMs: step.timeoutMs, onLine: step.onLine, heartbeat: ctx.heartbeat, priority: "below_normal" as const };
      const p = step.script.endsWith(".sh") ? runBashScript(script, step.args, opts) : runPython([script, ...step.args], opts);
      const onAbort = () => void p.cancel();
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await p.done;
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
    probe: (file: string): Promise<VideoFacts | null> => ffprobeFacts(file),
    sync: (cutDir: string, opts: { allowDirty: boolean }): SyncResult => syncScripts(cutDir, { root: dramaRemixRoot(env), allowDirty: opts.allowDirty }),
    judge: (req: JudgeRequest): Promise<JudgeResult | JudgeUnavailable> => {
      // The skeptic's dense 10 fps strip is rendered by the pipeline's own script into Studio's work folder, never the film's;
      // the annotated copies every call sees (lib/segment/annotate, ffmpeg) land beside it. SEGMENT_STRIP_ANNOTATE=off sends the raw PNGs.
      const work = req.work_dir ?? path.join(tmpdir(), "studio-work");
      const outDir = path.join(work, "dense");
      const dense = req.opts.dense === undefined ? (_boundary: unknown, chosenT: number) => renderDenseStrip({ src: path.join(req.run.cut_dir, "..", "source", "original.mp4"), at: chosenT, outDir }, { env }).catch(() => null) : req.opts.dense;
      const annotate = req.opts.annotate === undefined ? (annotateEnabled(env) ? (strip: StripImage, cutT: number) => annotateStrip(strip, cutT, path.join(work, "annotated"), { env }) : null) : req.opts.annotate;
      return judgeBoundaries(req.run, req.doc, { ...req.opts, dense, annotate });
    },
    bandFix: (req: BandFixRequest): Promise<BandFixResult | JudgeUnavailable> => judgeBandFix(req.run, req.doc, req.groups, { label: req.label, session: req.session, env, work_dir: req.work_dir, signal: req.signal }),
    async proxy(src: string, at: number, out: string): Promise<void> {
      const start = Math.max(0, at - 5);
      const part = `${out}.part.mp4`;
      const r = await runProcess(
        ffmpegBin(),
        ["-y", "-v", "error", "-ss", start.toFixed(3), "-i", src, "-t", "10", "-vf", "scale=480:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", part],
        { timeoutMs: 5 * 60 * 1000, priority: "normal" }
      ).done;
      if (r.code !== 0) throw new Error(`ffmpeg could not make the proxy at ${at}s: ${r.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ")}`);
      renameSync(part, out);
    },
    async joinProxy(before: string, after: string, out: string): Promise<void> {
      // `-sseof -2` reads the last 2 s of the first episode as it was encoded (delogo and all), `-t 2` the first 2 s of the
      // next; both are scaled to 480 px, given one frame rate and one sample rate, and joined by the concat filter.
      const part = `${out}.part.mp4`;
      const graph = "[0:v]scale=480:-2,setsar=1,fps=30[v0];[1:v]scale=480:-2,setsar=1,fps=30[v1];[0:a]aresample=48000[a0];[1:a]aresample=48000[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]";
      const r = await runProcess(
        ffmpegBin(),
        ["-y", "-v", "error", "-sseof", "-2", "-i", before, "-t", "2", "-i", after, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", part],
        { timeoutMs: 5 * 60 * 1000, priority: "normal" }
      ).done;
      if (r.code !== 0) throw new Error(`ffmpeg could not make the join proxy of ${path.basename(before)} → ${path.basename(after)}: ${r.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ")}`);
      renameSync(part, out);
    },
  };
}

/** The runner for the environment: the fake under STUDIO_FAKE_PIPELINE=1, else the real one. */
export function runnerFor(env: Env = process.env): PipelineRunner {
  return fakePipeline(env) ? new FakePipelineRunner() : realRunner(env);
}

// ---- the stage table ------------------------------------------------------------------------------------------------------------------

type StageFn = (ctx: StageContext) => Promise<StageOutcome>;

const STAGES: Partial<Record<FilmRunStage, StageFn>> = {
  intake: runIntakeStage,
  watermark: runWatermarkStage,
  index: runIndexStage,
  cards: runCardsStage,
  plan: runPlanStage,
  vision: runVisionStage,
  review: runReviewStage,
  render: runRenderStage,
  qa: runQaStage,
  film_meta: runFilmMetaStage,
  handoff: runHandoffStage,
};

/** Keys of stage_detail that describe one moment, dropped when the stage moves on or waits again. */
const TRANSIENT = new Set(["waiting", "progress", "waiting_for_heavy_lock", "apply_refused", "handoff_error", "film_meta_error", "import_error", "unavailable", "note", "rejudge_errors", "errors", "detect_tail", "unmark_result", "cancelled_from"]);

function carry(detail: Json): StageDetail {
  const out: StageDetail = {};
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    for (const [k, v] of Object.entries(detail)) if (!TRANSIENT.has(k)) out[k] = v;
  }
  return out;
}

const clean = (d: StageDetail): Json => JSON.parse(JSON.stringify(d)) as Json;

// ---- driving one run -------------------------------------------------------------------------------------------------------------------

export type WorkerOptions = {
  owner?: string;
  session?: Session;
  data?: DataLayer;
  runner?: PipelineRunner;
  env?: Env;
  log?: (line: string) => void;
  /** Seconds between ticks (default 5; the in-process fixture worker 2). */
  pollMs?: number;
  /** How often progress may be written (default 1 s; 0 in tests); a forced write (a stage's summary) ignores it. */
  progressEveryMs?: number;
  /** Tests: a tick awaits the runs it started instead of letting them run on. */
  awaitRuns?: boolean;
};

export type RunOutcome = { run_id: string; from: FilmRunStage; to: FilmRunStage; waiting: Waiting | null; error: string | null; cancelled: boolean; skipped?: string };

/** The run's log line writer; `current` is read at every line, so the stamp carries the stage the run is at now, not the one it was claimed at. */
function stageLog(base: ((line: string) => void) | undefined, current: () => FilmRun, env: Env): (line: string) => void {
  const run = current();
  let file: string | null = null;
  try {
    file = path.join(runDirs(run, env).work, "logs", "run.log");
  } catch {
    file = null;
  }
  return (line: string) => {
    const stamped = `${new Date().toISOString()} [${run.id.slice(0, 8)}/${current().stage}] ${line}`;
    (base ?? ((l: string) => console.log(`[segment-worker] ${l}`)))(stamped);
    if (file) {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `${stamped}\n`, "utf8");
      } catch {
        // the log file is a convenience
      }
    }
  };
}

/**
 * Claim `runId` and drive it until it waits for a person, ends, or fails.
 * Answers what happened; never throws for a run's own failure (that goes on
 * the row). A lost claim or an inactionable run is `skipped`.
 */
export async function executeRun(runId: string, opts: WorkerOptions = {}): Promise<RunOutcome> {
  const env = opts.env ?? process.env;
  const data = opts.data ?? getData();
  const session = opts.session ?? systemSession();
  const owner = opts.owner ?? workerName();
  const runner = opts.runner ?? runnerFor(env);
  const progressEvery = opts.progressEveryMs ?? (runner.fake ? 0 : 1000);

  let run = await data.getFilmRun(session, runId);
  const from = run.stage;
  const skip = (why: string): RunOutcome => ({ run_id: runId, from, to: run.stage, waiting: null, error: null, cancelled: false, skipped: why });
  if (!isActionable(run)) return skip("not actionable");
  const claimed = await data.claimFilmRun(session, runId, { owner, revision: run.revision });
  if (!claimed) return skip("claim lost");
  run = claimed;
  const log = stageLog(opts.log, () => run, env);
  const controller = new AbortController();
  let jobId: string | null = null;
  // A holder object, not a bare `let`: the lock is taken inside `lock()` below, and TypeScript keeps a closure-assigned variable narrowed to its initial null.
  const runLock: { held: Held<StudioRunLock> | null } = { held: null };
  let lastProgressAt = 0;

  /** Write the row with a CAS; on a conflict re-read once (a decision or a cancel moved the revision) and either stop or retry. */
  const write = async (input: Omit<FilmRunStageInput, "revision" | "owner">): Promise<FilmRun> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        run = await data.setFilmRunStage(session, run.id, { ...input, revision: run.revision, owner });
        return run;
      } catch (e) {
        if (!isDataError(e) || e.code !== "conflict" || attempt === 1) throw e;
        run = await data.getFilmRun(session, run.id);
        if (run.stage === "cancelled" || run.lease_owner !== owner) {
          controller.abort();
          throw new RunCancelled(run.id);
        }
      }
    }
    throw new RunCancelled(run.id);
  };

  const beat = async () => {
    if (controller.signal.aborted) throw new RunCancelled(run.id);
    const fresh = await data.getFilmRun(session, run.id);
    if (fresh.stage === "cancelled" || (fresh.lease_owner !== null && fresh.lease_owner !== owner)) {
      controller.abort();
      throw new RunCancelled(run.id);
    }
    run = fresh;
    try {
      await data.renewFilmRunLease(session, run.id, { owner });
    } catch (e) {
      if (isDataError(e) && e.code === "conflict") {
        controller.abort();
        throw new RunCancelled(run.id);
      }
      throw e;
    }
    if (jobId) await data.heartbeatJob(session, jobId).catch(() => undefined);
  };

  /** Throttled to one write a second (whisper-log tailing, judging and rendering report often); `force` is for a stage's final summary, which must land. */
  const progress = async (detail: StageDetail, o: { force?: boolean } = {}) => {
    const now = Date.now();
    if (!o.force && now - lastProgressAt < progressEvery) return;
    lastProgressAt = now;
    await write({ stage: run.stage, stage_detail: clean({ ...carry(run.stage_detail), ...detail }) });
  };

  let waiting: Waiting | null = null;
  let error: string | null = null;
  let cancelled = false;
  try {
    const dirs = runDirs(run, env);
    // The run lock is taken lazily: before every stage but the intake, which takes it once its folder check has passed, so
    // a folder the run may not drive (a session's film, a delivered one) never gets the file, not even briefly (B0).
    const lock = () => {
      if (runLock.held) return;
      const held = studioRunLock(dirs.cut, { run_id: run.id, stage: run.stage });
      runLock.held = held;
      if (held.replaced) log(`replaced a stale run lock (${held.replaced.reason}): ${JSON.stringify(held.replaced.lock)}`);
    };
    const ctx: StageContext = { run, session, data, runner, owner, env, dirs, log, progress, beat, signal: controller.signal, lock };
    const retries = run.decisions.filter((d) => d.action === DECISION.retry).length;

    for (;;) {
      ctx.run = run;
      if (isTerminal(run.stage)) break;
      if (run.stage === "queued") {
        run = await write({ stage: "intake", stage_detail: clean({ ...carry(run.stage_detail), started_at: new Date().toISOString(), worker: owner }) });
        continue;
      }
      const fn = STAGES[run.stage];
      if (!fn) {
        error = `no worker code for stage ${run.stage}`;
        run = await write({ stage: "failed", stage_detail: clean({ ...carry(run.stage_detail), failed_stage: run.stage }), error_text: error });
        break;
      }
      const stage = run.stage;
      if (stage !== "intake") lock();
      runLock.held?.update({ stage });
      log(`stage ${stage} starts`);
      const job = await data.recordJob(session, { kind: "segment_film", title_id: null, target_type: "film_run", target_id: run.id, idempotency_key: `segment_film:${run.id}:${stage}:${retries}`, input: { stage, worker: owner } });
      jobId = job.id;
      let outcome: StageOutcome;
      try {
        outcome = await fn(ctx);
      } catch (e) {
        if (e instanceof RunCancelled) throw e;
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        outcome = { kind: "fail", error: message };
      }
      if (controller.signal.aborted) throw new RunCancelled(run.id);
      if (outcome.kind === "next") {
        await data.finishJob(session, job.id, { status: "done", cost_cents: 0, output: { stage, next: outcome.stage } });
        run = await write({ stage: outcome.stage, stage_detail: clean({ ...carry(run.stage_detail), ...(outcome.detail ?? {}) }), ...(outcome.row ?? {}) });
        log(`stage ${stage} done → ${outcome.stage}`);
        lastProgressAt = 0;
        continue;
      }
      if (outcome.kind === "wait") {
        waiting = { for: outcome.for, since: new Date().toISOString(), retry_after: outcome.retryMs ? new Date(Date.now() + outcome.retryMs).toISOString() : null };
        await data.finishJob(session, job.id, { status: "done", cost_cents: 0, output: { stage, waiting: outcome.for } });
        run = await write({ stage, stage_detail: clean({ ...carry(run.stage_detail), ...(outcome.detail ?? {}), waiting: waiting as unknown as Json, decisions_seen: run.decisions.length }) });
        log(`stage ${stage} waits for ${outcome.for}`);
        break;
      }
      error = outcome.error;
      await data.finishJob(session, job.id, { status: "failed", cost_cents: 0, error: outcome.error.slice(0, 2000) });
      run = await write({ stage: "failed", stage_detail: clean({ ...carry(run.stage_detail), ...(outcome.detail ?? {}), failed_stage: stage }), error_text: outcome.error });
      log(`stage ${stage} FAILED: ${outcome.error.split("\n")[0]}`);
      break;
    }
  } catch (e) {
    if (e instanceof RunCancelled) {
      cancelled = true;
      log("cancelled");
      if (jobId) await data.finishJob(session, jobId, { status: "cancelled", cost_cents: 0 }).catch(() => undefined);
    } else if (e instanceof LockHeldError) {
      error = e.message;
      try {
        run = await write({ stage: "failed", stage_detail: clean({ ...carry(run.stage_detail), failed_stage: run.stage }), error_text: e.message });
      } catch {
        // a cancel got there first
      }
    } else {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      log(`worker error: ${error}`);
      try {
        run = await write({ stage: "failed", stage_detail: clean({ ...carry(run.stage_detail), failed_stage: run.stage }), error_text: error });
      } catch {
        // nothing more to record
      }
    }
  } finally {
    try {
      const fresh = await data.getFilmRun(session, run.id).catch(() => run);
      if (isTerminal(fresh.stage) && runLock.held) runLock.held.release();
      await data.releaseFilmRun(session, run.id, { owner }).catch(() => undefined);
    } catch {
      // best effort
    }
  }
  return { run_id: runId, from, to: run.stage, waiting, error, cancelled };
}

// ---- the loop -----------------------------------------------------------------------------------------------------------------------------

export type TickResult = { considered: number; started: string[]; skipped: string[] };

/** One pass over the runs: drive every actionable, unleased run not already being driven by this worker. */
export async function runTick(opts: WorkerOptions & { executing?: Set<string> } = {}): Promise<TickResult> {
  const data = opts.data ?? getData();
  const session = opts.session ?? systemSession();
  const owner = opts.owner ?? workerName();
  const executing = opts.executing ?? new Set<string>();
  const runs = await data.listFilmRuns(session);
  const result: TickResult = { considered: runs.length, started: [], skipped: [] };
  const now = Date.now();
  for (const run of runs) {
    if (executing.has(run.id) || isTerminal(run.stage) || !isActionable(run, now)) continue;
    const until = Date.parse(run.leased_until ?? "");
    if (run.lease_owner && run.lease_owner !== owner && Number.isFinite(until) && until > now) {
      result.skipped.push(run.id);
      continue;
    }
    executing.add(run.id);
    result.started.push(run.id);
    const p = executeRun(run.id, { ...opts, owner })
      .catch((e) => (opts.log ?? console.error)(`[segment-worker] ${run.id}: ${(e as Error).message}`))
      .finally(() => executing.delete(run.id));
    if (opts.awaitRuns) await p;
  }
  return result;
}

export class SegmentWorker {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  readonly executing = new Set<string>();
  readonly owner: string;
  constructor(private readonly opts: WorkerOptions = {}) {
    this.owner = opts.owner ?? workerName();
  }
  get running(): boolean {
    return this.timer !== null;
  }
  async tick(): Promise<TickResult> {
    if (this.ticking) return { considered: 0, started: [], skipped: [] };
    this.ticking = true;
    try {
      return await runTick({ ...this.opts, owner: this.owner, executing: this.executing });
    } catch (e) {
      (this.opts.log ?? console.error)(`[segment-worker] tick failed: ${(e as Error).message}`);
      return { considered: 0, started: [], skipped: [] };
    } finally {
      this.ticking = false;
    }
  }
  start(): void {
    if (this.timer) return;
    const every = this.opts.pollMs ?? 5000;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref?.();
    void this.tick();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Fixture mode runs the worker inside the dev server (the store is this
 * process's memory). Idempotent; a no-op in Supabase mode (the separate
 * process), in tests, on the edge runtime, and with STUDIO_SEGMENT_WORKER=off.
 */
export function ensureInProcessWorker(): SegmentWorker | null {
  const g = globalThis as unknown as { __studioSegmentWorker?: SegmentWorker | null };
  if (g.__studioSegmentWorker !== undefined) return g.__studioSegmentWorker;
  if (dataSource() !== "fixture" || process.env.NEXT_RUNTIME === "edge" || process.env.NODE_ENV === "test" || process.env.STUDIO_SEGMENT_WORKER === "off") {
    g.__studioSegmentWorker = null;
    return null;
  }
  const worker = new SegmentWorker({ owner: `${workerName()}:inproc`, pollMs: 2000 });
  worker.start();
  console.log(`[segment-worker] in-process worker started (fixture mode${fakePipeline() ? ", fake pipeline" : ""})`);
  g.__studioSegmentWorker = worker;
  return worker;
}
