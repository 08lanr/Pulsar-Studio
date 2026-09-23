// The stage machine's shared vocabulary (decision 2026-09-23, "segment a film
// in Studio"; plan B1–B2): where a run's film lives on disk, what a stage
// hands back to the worker, how a script is run inside the film's cut/
// folder and how its refusal is kept verbatim, the two lock files around a
// heavy stage, the review/ snapshot before anything is applied or rendered,
// the decisions a person records on a run and which of them wake a waiting
// stage, and the runner seam that lets the fixture's fake pipeline stand in
// for Python (lib/segment/fake-runner.ts) without a second copy of the
// stage code. Nothing here decides a boundary: the scripts and the vision
// pass do, and the person on the review screen.
//
// A run's film folder is `<film root>/<bucket>/<slug>`. The film root is
// WORKSPACE_ROOT — except under STUDIO_FAKE_PIPELINE=1 (the e2e server, the
// worker test), where it is `<STUDIO_WORK_DIR>/fake-workspace`, so the fake
// never writes into the checked-in fixture workspace. Everything Studio
// makes for a run that is not a pipeline artifact — logs, review snapshots,
// proxy clips, dense strips — lands under `<STUDIO_WORK_DIR>/<run id>/`,
// never under projects/.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Session } from "@/lib/auth";
import type { DataLayer, NewFilmRunDecision } from "@/lib/data";
import { invalid } from "@/lib/data/errors";
import { workspaceRoot } from "@/lib/data/storage";
import type { VideoFacts } from "@/lib/film-import/import";
import { pickNewestDelivered } from "@/lib/film-import/manifest";
import { LockHeldError, heavyLock, heavyLockRoot, type Held, type HeavyLock } from "@/lib/locks";
import { lastLine, type RunResult } from "@/lib/python";
import type { SyncResult } from "@/lib/segment/scripts-sync";
import type { OptionsDoc } from "@/lib/segment/strips";
import type { BandFixResult, JudgeOptions, JudgeResult, JudgeUnavailable, SegmentRun } from "@/lib/segment/vision";
import type { BandFixGroup } from "@/lib/prompts/band-fix";
import type { FilmRun, FilmRunDecision, FilmRunStage, Json } from "@/lib/types";

/** An environment-shaped record, so the path rules can be tested without touching process.env. */
export type Env = Record<string, string | undefined>;

/** Below this reviewer confidence a boundary needs a person (segment spec, decision 5). */
export const CONFIDENCE_GATE = 0.65;

/** The label the run's vision files carry: `studio-<first 8 of the run id>` (a plain file-name token, as judgeBoundaries requires). */
export function visionLabel(run: Pick<FilmRun, "id">): string {
  return `studio-${run.id.replace(/-/g, "").slice(0, 8)}`;
}

// ---- where things are ------------------------------------------------------------------------------

export function fakePipeline(env: Env = process.env): boolean {
  return env.STUDIO_FAKE_PIPELINE === "1";
}

/** STUDIO_WORK_DIR, else the OS temp dir (the same rule as lib/film-import/import.ts). */
export function segmentWorkDir(env: Env = process.env): string {
  const configured = env.STUDIO_WORK_DIR?.trim();
  return configured ? path.resolve(process.cwd(), configured) : path.join(tmpdir(), "studio-work");
}

/** The projects folder a run's film lives under: WORKSPACE_ROOT, or the fake workspace under the work dir. Null when neither is configured. */
export function filmRoot(env: Env = process.env): string | null {
  if (fakePipeline(env)) return path.join(segmentWorkDir(env), "fake-workspace");
  const ws = env.WORKSPACE_ROOT?.trim();
  return ws ? path.resolve(ws) : workspaceRoot();
}

export function sourceRefOf(run: Pick<FilmRun, "bucket" | "slug">): string {
  return `${run.bucket}/${run.slug}`;
}

/** Everything a run touches on disk. `film` is `<root>/<bucket>/<slug>`; `work` is Studio's own scratch for the run. */
export type RunDirs = { root: string; film: string; cut: string; source: string; work: string };

export function runWorkDir(runId: string, env: Env = process.env): string {
  return path.join(segmentWorkDir(env), runId);
}

export function runDirs(run: Pick<FilmRun, "id" | "bucket" | "slug">, env: Env = process.env): RunDirs {
  const root = filmRoot(env);
  if (!root) throw invalid("WORKSPACE_ROOT is not set: Studio has no film workspace to write into");
  const film = path.join(root, run.bucket, run.slug);
  return { root, film, cut: path.join(film, "cut"), source: path.join(film, "source", "original.mp4"), work: runWorkDir(run.id, env) };
}

/** The `--src` every cut-only script takes from the cut/ folder. */
export const SRC_ARG = "../source/original.mp4";

// ---- stage outcomes ---------------------------------------------------------------------------------

export const TERMINAL_STAGES: readonly FilmRunStage[] = ["done", "failed", "cancelled"];

export function isTerminal(stage: FilmRunStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** What a waiting stage waits for; the screens read it from `stage_detail.waiting.for`. */
export type WaitFor = "watermark" | "cards" | "vision" | "review" | "film_meta" | "ready" | "import";

/** Progress and findings inside a stage: free-form JSON the screens read (documented per stage in docs/segment-a-film.md). */
export type StageDetail = Record<string, Json | undefined>;

export type StageOutcome =
  | { kind: "next"; stage: FilmRunStage; detail?: StageDetail; row?: { drama_remix_sha?: string | null; drama_remix_dirty?: boolean; title_id?: string | null } }
  | { kind: "wait"; for: WaitFor; detail?: StageDetail; /** Look again after this many ms even without a decision (a readiness poll). */ retryMs?: number }
  | { kind: "fail"; error: string; detail?: StageDetail };

export const next = (stage: FilmRunStage, detail?: StageDetail, row?: Extract<StageOutcome, { kind: "next" }>["row"]): StageOutcome => ({ kind: "next", stage, detail, row });
export const wait = (waitFor: WaitFor, detail?: StageDetail, retryMs?: number): StageOutcome => ({ kind: "wait", for: waitFor, detail, retryMs });
export const fail = (error: string, detail?: StageDetail): StageOutcome => ({ kind: "fail", error, detail });

/** Thrown inside a stage when the run was cancelled under it (the worker cleans up; nothing is written as a failure). */
export class RunCancelled extends Error {
  constructor(runId: string) {
    super(`run ${runId} was cancelled`);
    this.name = "RunCancelled";
  }
}

// ---- decisions ------------------------------------------------------------------------------------------

/**
 * The `action` of a stored decision (film_runs.decisions). The API's
 * `kind` maps onto these; the worker reads them back in the stage that
 * waits for them.
 */
export const DECISION = {
  watermark_accept: "watermark_accept",
  watermark_region: "watermark_region",
  no_logo: "no_logo",
  unmark: "unmark",
  cards: "cards",
  accept: "accept",
  move: "move",
  rejudge: "rejudge",
  apply_review: "apply_review",
  handoff_vision: "handoff_vision",
  join: "join",
  film_meta: "film_meta",
  import_now: "import_now",
  retry: "retry",
  note: "note",
} as const;

export type DecisionAction = (typeof DECISION)[keyof typeof DECISION];

/** Which decisions wake each wait. */
export const WAKES: Record<WaitFor, readonly DecisionAction[]> = {
  watermark: ["watermark_accept", "watermark_region", "no_logo", "unmark"],
  cards: ["cards"],
  vision: ["handoff_vision", "retry"],
  review: ["apply_review", "rejudge"],
  film_meta: ["film_meta", "join"],
  ready: [],
  import: ["import_now", "join"],
};

export type Waiting = { for: WaitFor; since: string; retry_after?: string | null };

/** The wait a run's stage_detail records, or null when the stage is not waiting. */
export function waitingOf(run: Pick<FilmRun, "stage_detail">): Waiting | null {
  const d = run.stage_detail as { waiting?: unknown } | null;
  const w = d && typeof d === "object" ? (d as { waiting?: unknown }).waiting : null;
  if (!w || typeof w !== "object") return null;
  const x = w as Partial<Waiting>;
  if (typeof x.for !== "string") return null;
  return { for: x.for as WaitFor, since: typeof x.since === "string" ? x.since : "", retry_after: typeof x.retry_after === "string" ? x.retry_after : null };
}

/**
 * How many of the run's decisions the worker has consumed
 * (`stage_detail.decisions_seen`): set to the decision count when a stage
 * begins to wait, and by a stage that acted on a pending decision and moved
 * on (`consumed`). Everything after it is pending — across a stage change
 * too, so a join recorded at film-meta is still there when the render runs.
 */
export function decisionsSeen(run: Pick<FilmRun, "stage_detail">): number {
  const d = run.stage_detail as { decisions_seen?: unknown } | null;
  const n = d && typeof d === "object" ? (d as { decisions_seen?: unknown }).decisions_seen : undefined;
  return typeof n === "number" && n >= 0 ? n : 0;
}

/** The decisions the worker has not acted on yet. */
export function pendingDecisions(run: Pick<FilmRun, "decisions" | "stage_detail">): FilmRunDecision[] {
  return run.decisions.slice(decisionsSeen(run));
}

/** The stage-detail patch a stage adds when it acted on the pending decisions and moves on (a new wait does this on its own). */
export function consumed(run: Pick<FilmRun, "decisions">): StageDetail {
  return { decisions_seen: run.decisions.length };
}

/** The newest pending decision with one of these actions, or null. */
export function pendingDecision(run: Pick<FilmRun, "decisions" | "stage_detail">, ...actions: DecisionAction[]): FilmRunDecision | null {
  const pending = pendingDecisions(run).filter((d) => (actions as string[]).includes(d.action));
  return pending.length ? pending[pending.length - 1] : null;
}

/** A decision's `data` as an object, or {}. */
export function decisionData(d: FilmRunDecision | null | undefined): Record<string, Json> {
  const v = d?.data;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : {};
}

/**
 * Whether a worker should pick the run up now: a run not waiting is
 * actionable; a waiting run is actionable when a decision that wakes its
 * wait has been recorded since it began waiting, or when its readiness
 * poll is due. Pure; the worker and the tests share it.
 */
export function isActionable(run: Pick<FilmRun, "stage" | "stage_detail" | "decisions">, nowMs = Date.now()): boolean {
  if (isTerminal(run.stage)) return false;
  const w = waitingOf(run);
  if (!w) return true;
  const wakes = WAKES[w.for] ?? [];
  if (pendingDecisions(run).some((d) => (wakes as string[]).includes(d.action))) return true;
  if (w.retry_after) {
    const at = Date.parse(w.retry_after);
    return Number.isFinite(at) ? at <= nowMs : true;
  }
  return false;
}

/** The decision the route records for one API `kind`; the data layer stamps at/by. */
export function decisionOf(action: DecisionAction, fields: { boundary_s?: number | null; to_s?: number | null; why?: string | null; data?: Json; by?: string } = {}): NewFilmRunDecision {
  const d: NewFilmRunDecision = { action, boundary_s: fields.boundary_s ?? null };
  if (fields.to_s !== undefined) d.to_s = fields.to_s;
  if (fields.why !== undefined) d.why = fields.why;
  if (fields.data !== undefined) d.data = fields.data;
  if (fields.by) d.by = fields.by;
  return d;
}

// ---- the runner seam --------------------------------------------------------------------------------------

/** One script call inside the film's cut/ folder, as the stage code states it (the runner spawns or fakes it). */
export type ScriptStep = {
  /** A file under cut/scripts: `watermark.py` (python) or `index_cut.sh` (Git Bash). */
  script: string;
  args: string[];
  /** For the log and the stage detail. */
  what: string;
  timeoutMs?: number;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
};

export type RunnerContext = {
  cutDir: string;
  /** Renews the lease and checks for a cancel; the runner calls it while a script runs. */
  heartbeat: { cb: () => void | Promise<void>; everyMs: number };
  /** Aborted when the run is cancelled: the runner kills the child. */
  signal: AbortSignal;
  /** The interpreter's environment additions (STUDIO_WORK_DIR for a strip, nothing secret), merged over the process's. */
  env?: Env;
};

/** What the vision stage asks of the runner: the pass over these boundaries, in the API or a fake. `work_dir` takes the skeptic's dense strips. */
export type JudgeRequest = { run: SegmentRun; doc: OptionsDoc; opts: JudgeOptions; work_dir?: string };

export type BandFixRequest = { run: SegmentRun; doc: OptionsDoc; groups: BandFixGroup[]; label: string; session?: Session };

/**
 * The seam between the stages and the machine: the real runner spawns the
 * pipeline's scripts, probes with ffprobe, syncs from the drama-remix
 * checkout and judges through lib/llm; the fake runner writes plausible
 * artifacts and judges from a table. The stages never spawn anything
 * themselves.
 */
export interface PipelineRunner {
  readonly fake: boolean;
  run(step: ScriptStep, ctx: RunnerContext): Promise<RunResult>;
  probe(file: string): Promise<VideoFacts | null>;
  sync(cutDir: string, opts: { allowDirty: boolean }): SyncResult;
  judge(req: JudgeRequest): Promise<JudgeResult | JudgeUnavailable>;
  bandFix(req: BandFixRequest): Promise<BandFixResult | JudgeUnavailable>;
  /** A ±5 s, 480 px clip of the source around `at`, written to `out` (a `.part` beside it while it renders). */
  proxy(src: string, at: number, out: string): Promise<void>;
}

// ---- the stage context ------------------------------------------------------------------------------------

export type StageContext = {
  run: FilmRun;
  session: Session;
  data: DataLayer;
  runner: PipelineRunner;
  owner: string;
  env: Env;
  dirs: RunDirs;
  /** One line to the worker's log and the run's log file. */
  log: (line: string) => void;
  /** Write progress into stage_detail (merged over the stage's detail so far; the worker throttles). */
  progress: (detail: StageDetail) => Promise<void>;
  /** Renew the lease, heartbeat the job row, and throw RunCancelled when the run was cancelled. */
  beat: () => Promise<void>;
  signal: AbortSignal;
};

/** The last `n` lines of a tail, for a stage detail. */
export function tailLines(tail: string, n = 30): string[] {
  return tail.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter(Boolean).slice(-n);
}

/**
 * A script's refusal, verbatim: from the first stdout line that says
 * REFUSED / FAIL / NOT READY to the end (cut_episodes.py, apply_vision.py
 * and boundary_frames.py --verify print theirs on stdout), else the stderr
 * tail (an argparse `sys.exit("REFUSED: …")` lands there), else the last
 * stdout line. Never paraphrased.
 */
export function refusalOf(step: ScriptStep, r: RunResult): string {
  if (r.timedOut) return `${step.script} ran past its time limit and was stopped`;
  if (r.cancelled) return `${step.script} was cancelled`;
  const out = r.stdoutTail.replace(/\r/g, "");
  const err = r.stderrTail.replace(/\r/g, "").trim();
  const lines = out.split("\n");
  const at = lines.findIndex((l) => /^(REFUSED|FAIL|NOT READY)/.test(l.trim()));
  let text = at >= 0 ? lines.slice(at).join("\n").trim() : "";
  if (!text && err) text = err.split("\n").slice(-12).join("\n");
  if (!text) text = lastLine(out) || `${step.script} exited ${r.code}`;
  const head = `${step.script} exited ${r.code ?? "killed"}`;
  return `${head}\n${text}`.slice(0, 6000);
}

/** Run one script in the film's cut/ folder, logging every line; the result is answered, never thrown (a refusal is exit 1). */
export async function runStep(ctx: StageContext, step: ScriptStep): Promise<RunResult> {
  ctx.log(`> ${step.script} ${step.args.join(" ")}`);
  const onLine = step.onLine;
  const r = await ctx.runner.run(
    {
      ...step,
      onLine: (stream, line) => {
        ctx.log(`${stream === "stderr" ? "! " : "  "}${line}`);
        onLine?.(stream, line);
      },
    },
    { cutDir: ctx.dirs.cut, heartbeat: { cb: ctx.beat, everyMs: 30_000 }, signal: ctx.signal, env: { STUDIO_WORK_DIR: ctx.dirs.work } }
  );
  if (ctx.signal.aborted) throw new RunCancelled(ctx.run.id);
  ctx.log(`< ${step.script} exit ${r.code ?? "killed"} in ${Math.round(r.durationMs / 1000)} s`);
  return r;
}

// ---- the heavy lock around a stage -------------------------------------------------------------------------

/** Where the machine's heavy lock lives for this run: the work dir under the fake pipeline (never the fixture tree), else HEAVY_LOCK_ROOT / above WORKSPACE_ROOT. */
export function heavyLockRootFor(env: Env = process.env): string {
  if (fakePipeline(env)) return segmentWorkDir(env);
  const configured = env.HEAVY_LOCK_ROOT?.trim();
  if (configured) return path.resolve(configured);
  return heavyLockRoot();
}

/**
 * Take the machine's heavy slot for `what`, waiting while a session or
 * another run holds it live (the lease is renewed and a cancel honoured
 * while waiting, and the run's detail says who holds it), run `fn`, release.
 */
export async function withHeavyLock<T>(ctx: StageContext, what: string, fn: () => Promise<T>, opts: { pollMs?: number } = {}): Promise<T> {
  const root = heavyLockRootFor(ctx.env);
  mkdirSync(root, { recursive: true });
  const pollMs = opts.pollMs ?? (ctx.runner.fake ? 200 : 30_000);
  let held: Held<HeavyLock> | null = null;
  let waited = 0;
  while (!held) {
    await ctx.beat();
    try {
      held = heavyLock(root, { what });
    } catch (e) {
      if (!(e instanceof LockHeldError)) throw e;
      const holder = e.holder as HeavyLock;
      if (waited === 0) ctx.log(`waiting for the heavy slot: ${e.message}`);
      await ctx.progress({ waiting_for_heavy_lock: { owner: holder.owner, what: holder.what, pid: holder.pid, since: holder.started_at, file: e.file } });
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
      waited += pollMs;
    }
  }
  if (held.replaced) ctx.log(`replaced a stale heavy lock (${held.replaced.reason}): ${JSON.stringify(held.replaced.lock)}`);
  if (waited) await ctx.progress({ waiting_for_heavy_lock: null });
  try {
    return await fn();
  } finally {
    held.release();
  }
}

// ---- snapshots ------------------------------------------------------------------------------------------------

/**
 * Copy `cut/review/*` (the option and choice files, the vision records; not
 * the frame strips or QA sheets) and `cut/cuts.json` into
 * `<work>/snapshots/<label>-<stamp>/` before anything is applied or
 * rendered (plan B0: projects/ is not in git, a bad write cannot be undone).
 * Returns the folder, or null when there is nothing to snapshot yet.
 */
export function snapshotReview(ctx: StageContext, label: string): string | null {
  const review = path.join(ctx.dirs.cut, "review");
  const plan = path.join(ctx.dirs.cut, "cuts.json");
  if (!existsSync(review) && !existsSync(plan)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(ctx.dirs.work, "snapshots", `${label}-${stamp}`);
  mkdirSync(dest, { recursive: true });
  if (existsSync(review)) {
    cpSync(review, path.join(dest, "review"), {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(review, src);
        if (!rel) return true;
        const top = rel.split(path.sep)[0];
        return top !== "frames" && top !== "qa";
      },
    });
  }
  if (existsSync(plan)) cpSync(plan, path.join(dest, "cuts.json"));
  ctx.log(`review snapshot: ${dest}`);
  return dest;
}

// ---- small readers the stages share -----------------------------------------------------------------------

export function readJson<T = unknown>(file: string): T | null {
  try {
    const text = readFileSync(file, "utf8");
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
  } catch {
    return null;
  }
}

export function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `index/source.json`'s facts when the index wrote them. */
export function sourceFacts(cutDir: string): { fps: number; width: number; height: number; duration: number } | null {
  const s = readJson<{ fps?: number; width?: number; height?: number; duration?: number }>(path.join(cutDir, "index", "source.json"));
  if (!s || typeof s.fps !== "number" || typeof s.duration !== "number" || typeof s.width !== "number" || typeof s.height !== "number") return null;
  return { fps: s.fps, width: s.width, height: s.height, duration: s.duration };
}

/** The newest DELIVERED file under review/, as `review/<name>` for `--pin-from`, or null. */
export function newestDelivered(cutDir: string): { arg: string; file: string; end: number } | null {
  const review = path.join(cutDir, "review");
  let names: string[] = [];
  try {
    names = readdirSync(review);
  } catch {
    return null;
  }
  const newest = pickNewestDelivered(names);
  return newest ? { arg: `review/${newest.file}`, file: newest.file, end: newest.end } : null;
}

/** The `--duration` the plan stages pass: the run's `to_s`, else the source's measured length, else nothing (pick_cuts takes the last word). */
export function planDuration(run: Pick<FilmRun, "settings">, cutDir: string): number | null {
  const to = run.settings.to_s;
  if (typeof to === "number" && to > 0) return to;
  return sourceFacts(cutDir)?.duration ?? null;
}

/** The pick_cuts.py band and target flags from the run's settings (the pipeline's defaults when absent). */
export function bandArgs(run: Pick<FilmRun, "settings">): string[] {
  const out: string[] = [];
  if (typeof run.settings.target_s === "number") out.push("--target", String(run.settings.target_s));
  if (Array.isArray(run.settings.band)) out.push("--min", String(run.settings.band[0]), "--max", String(run.settings.band[1]));
  return out;
}

/** True when the run renders without delogo: the setting, or a `no_logo` decision. */
export function noDelogo(run: Pick<FilmRun, "settings" | "decisions">): boolean {
  return run.settings.no_delogo === true || run.decisions.some((d) => d.action === DECISION.no_logo);
}

/** The exact Workflow call a person pastes into Claude Code for the hand-off vision pass (plan B2, stage 4 v1). */
export function handoffCommand(cutDir: string, boundaries: number[], filmNotes: string | null, dramaRemixRoot: string): string {
  const base = cutDir.replace(/\\/g, "/");
  const script = `${dramaRemixRoot.replace(/\\/g, "/")}/scripts/cut-only/pick_by_eye.workflow.js`;
  const notes = filmNotes ? `, film_notes: ${JSON.stringify(filmNotes)}` : "";
  return `Workflow({ scriptPath: ${JSON.stringify(script)}, args: { base: ${JSON.stringify(base)}, boundaries: ${JSON.stringify(boundaries)}${notes} } })`;
}
