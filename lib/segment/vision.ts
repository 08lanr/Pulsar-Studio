// The vision pass as an API module (segment spec, decision 4, 2026-09-23):
// the pipeline's pick_by_eye.workflow.js run from Studio through lib/llm.ts
// instead of a Claude Code hand-off. One reviewer call per boundary with the
// option strips as images, one skeptic call on its pick (plus a dense 10 fps
// strip when the runner made one), and a result file in EXACTLY the shape
// apply_vision.py reads - `{result: [{boundary_s, pick, verdict}]}`, an
// object and not a bare list - so the pipeline's own refusal rules and audit
// trail still apply: the worker then runs
// `apply_vision.py --from <file> --label <label>`.
//
// Every model call is a studio.jobs row (kind verify_boundaries, target the
// film run) through runJob: idempotent on (run, boundary, role, options sha,
// rule version, attempt), so a crashed pass resumes without paying again;
// the cost is on every row. No provider key, or fixture demo replay, means
// `{unavailable}` and no call. Nothing here writes into the film folder
// except the result file the caller names (by default
// `review/vision/<label>.json`, where the pipeline keeps its records).

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { systemSession, type Session } from "@/lib/auth";
import { demoReplayActive } from "@/lib/data-source";
import { runJob } from "@/lib/jobs";
import { callStructured, visionProviderStatus, type LlmProvider, type StructuredCall, type StructuredResult } from "@/lib/llm";
import {
  BAND_FIX_RULE_VERSION,
  bandFixNote,
  bandFixToVisionRecords,
  buildBandFixJudge,
  buildBandFixSkeptic,
  resolveBandFix,
  type BandFixGroup,
  type BandFixJudged,
  type BandFixPick,
  type BandFixResolution,
  type BandFixVerdict,
  type FirstPassRecord,
} from "@/lib/prompts/band-fix";
import { BOUNDARY_RULE_VERSION, buildBoundaryReview, type BoundaryPick } from "@/lib/prompts/boundary-review";
import { buildBoundarySkeptic, type BoundaryVerdict } from "@/lib/prompts/boundary-skeptic";
import type { CandidatesIndex } from "@/lib/film-import/types";
import type { JobKind, Json } from "@/lib/types";
import {
  SegmentError,
  boundaryStrips,
  findBoundary,
  legalCutsNear,
  loadCandidates,
  optionsSha,
  stripLayoutOf,
  verifyOptions,
  type OptionsBoundary,
  type OptionsDoc,
  type StripImage,
} from "./strips";

// ---- the job kind -------------------------------------------------------------------------------

/** The studio.jobs kind of every call here (lib/types.ts JobKind; migration 0016 adds it to studio.job_kind before `begin`). */
export const VERIFY_BOUNDARIES_JOB_KIND = "verify_boundaries" as const satisfies JobKind;
export type VerifyBoundariesJobKind = typeof VERIFY_BOUNDARIES_JOB_KIND;
const JOB_KIND: JobKind = VERIFY_BOUNDARIES_JOB_KIND;

/** The target_type of the job rows: the film run (studio.film_runs) whose id is `target_id`. */
export const FILM_RUN_TARGET = "film_run";

/** A film run has no title yet (the title is born at import, after the render): every row here carries title_id null. */
const NO_TITLE = null;

// ---- the Workflow output shape ---------------------------------------------------------------------
//
// Read against apply_vision.py: it takes `raw["result"]` when the JSON is an
// object, then per record `boundary_s`, `pick.confidence` (0 or missing =
// refused), `pick.chosen_t`, `pick.why`, `verdict.agree` (False exactly),
// `verdict.better_t` (truthy = the fix), `verdict.fault` or `.reason`. The
// real records (He Hated All Women, 2026-09-22) carry `fault` and
// `better_key` as "" when empty and omit `better_t` when there is none.

export const WorkflowPickSchema = z
  .object({
    chosen_key: z.string(),
    chosen_t: z.number(),
    ends_on: z.string(),
    opens_on: z.string(),
    why: z.string(),
    rejected: z.string().nullish(),
    payoff_in_episode: z.boolean(),
    confidence: z.number(),
  })
  .passthrough();

export const WorkflowVerdictSchema = z
  .object({
    agree: z.boolean(),
    fault: z.string().nullish(),
    better_key: z.string().nullish(),
    better_t: z.number().nullish(),
    reason: z.string(),
  })
  .passthrough();

export const WorkflowRecordSchema = z.object({ boundary_s: z.number(), pick: WorkflowPickSchema, verdict: WorkflowVerdictSchema.nullish() }).passthrough();

/** The file apply_vision.py accepts: `result` is the list; everything else is run bookkeeping it ignores. */
export const WorkflowOutputSchema = z
  .object({
    summary: z.string().nullish(),
    logs: z.array(z.string()).nullish(),
    result: z.array(WorkflowRecordSchema),
    totalTokens: z.number().nullish(),
  })
  .passthrough();

export type WorkflowPick = z.infer<typeof WorkflowPickSchema>;
export type WorkflowVerdict = z.infer<typeof WorkflowVerdictSchema>;
export type WorkflowRecord = z.infer<typeof WorkflowRecordSchema>;
export type WorkflowOutput = z.infer<typeof WorkflowOutputSchema>;

/** A reviewer's pick as the Workflow wrote it: `rejected` only when there was one. */
export function toWorkflowPick(p: BoundaryPick): WorkflowPick {
  const out: WorkflowPick = {
    chosen_key: p.chosen_key,
    chosen_t: p.chosen_t,
    ends_on: p.ends_on,
    opens_on: p.opens_on,
    why: p.why,
    payoff_in_episode: p.payoff_in_episode,
    confidence: p.confidence,
  };
  if (p.rejected) out.rejected = p.rejected;
  return out;
}

/** A skeptic's verdict as the Workflow wrote it: empty strings for no fault / no key, `better_t` only when named. */
export function toWorkflowVerdict(v: BoundaryVerdict): WorkflowVerdict {
  const out: WorkflowVerdict = { agree: v.agree, fault: v.fault ?? "", better_key: v.better_key ?? "", reason: v.reason };
  if (v.better_t !== null && v.better_t !== undefined) out.better_t = v.better_t;
  return out;
}

// ---- apply_vision.py's rules, as a pure function -------------------------------------------------------

export type AppliedRow = { boundary_s: number; reviewer_t: number; applied_t: number; source: "reviewer" | "SKEPTIC OVERRIDE"; confidence: number };

export type AppliedChoices = {
  /** review/choices.json: `String(boundary_s)` -> applied time; empty when any boundary faulted. */
  choices: Record<string, number>;
  rows: AppliedRow[];
  /** apply_vision.py's FAIL lines; any one means choices.json is NOT written. */
  faults: string[];
};

const keyOf = (t: number) => Math.round(t * 1000);

/** Every pass given, merged: for the same boundary the LATER file wins, as `--from a --from b` does. */
export function mergeVisionPasses(passes: WorkflowRecord[][]): WorkflowRecord[] {
  const merged = new Map<number, WorkflowRecord>();
  for (const recs of passes) for (const r of recs) merged.set(keyOf(r.boundary_s), r);
  return [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}

/** The time apply_vision.py applies for one record, or null with the fault it prints. */
export function appliedTimeOf(r: WorkflowRecord): { t: number; source: AppliedRow["source"] } | { t: null; fault: string } {
  const pick = r.pick;
  if (!pick || (pick.confidence || 0) === 0) return { t: null, fault: `${r.boundary_s}s: reviewer refused or returned nothing - ${(pick?.why ?? "").slice(0, 120)}` };
  const v = r.verdict ?? null;
  if (v && v.agree === false) {
    if (v.better_t) return { t: v.better_t, source: "SKEPTIC OVERRIDE" };
    return { t: null, fault: `${r.boundary_s}s: skeptic disputes ${pick.chosen_t}s and names no fix - ${(v.fault || v.reason || "").slice(0, 160)}` };
  }
  return { t: pick.chosen_t, source: "reviewer" };
}

/**
 * apply_vision.py, rule for rule: a skeptic that disagrees AND names a better
 * time wins; a skeptic that disagrees without one is a fault, not a choice;
 * a reviewer at confidence 0 refused and its answer is never applied. A
 * later pass replaces an earlier record of the same boundary.
 */
export function applyVision(...passes: WorkflowRecord[][]): AppliedChoices {
  const choices: Record<string, number> = {};
  const rows: AppliedRow[] = [];
  const faults: string[] = [];
  for (const r of mergeVisionPasses(passes)) {
    const a = appliedTimeOf(r);
    if (a.t === null) {
      faults.push(a.fault);
      continue;
    }
    choices[String(r.boundary_s)] = a.t;
    rows.push({ boundary_s: r.boundary_s, reviewer_t: r.pick.chosen_t, applied_t: a.t, source: a.source, confidence: r.pick.confidence ?? 0 });
  }
  return { choices: faults.length ? {} : choices, rows, faults };
}

// ---- judgeBoundaries ------------------------------------------------------------------------------

/** What the module needs of a film run (studio.film_runs, task 2a): its id (the jobs' target_id) and its folder. */
export type SegmentRun = {
  id: string;
  /** The film's `cut/` folder, absolute. */
  cut_dir: string;
  /** The Workflow's `film_notes`: how the source marks its own breaks, and the like. */
  film_notes?: string | null;
};

export type LlmFn = <T>(call: StructuredCall<T>) => Promise<StructuredResult<T>>;

/** Makes the skeptic's dense strip for one boundary (renderDenseStrip into STUDIO_WORK_DIR); null skips it. */
export type DenseStripFn = (boundary: OptionsBoundary, chosenT: number) => Promise<StripImage | null>;

export type JudgeOptions = {
  /** The audit label (`0-end`, `900-1800`); names the file and the jobs' input. */
  label: string;
  /** callStructured unless a fake is injected (tests, never a network). */
  llm?: LlmFn;
  /** Boundaries judged at once; 3 as the plan says. */
  concurrency?: number;
  /** Where the result goes; default `<cut>/review/vision/<label>.json`. The calibration run points it at STUDIO_WORK_DIR. */
  out_file?: string;
  /** Only these boundaries (a re-judge of one boundary, the calibration sample); default every boundary in the doc. */
  boundaries?: number[];
  /** Part of every idempotency key: 2 re-judges a boundary whose first answer was rejected by a person. */
  attempt?: number;
  /** Who records the jobs; the system actor unless given (a staff session on the desk). */
  session?: Session;
  dense?: DenseStripFn | null;
  /** index/candidates.json; loaded from the run's folder when absent, [] when the film has none. */
  candidates?: CandidatesIndex | null;
  /** The `--verify` allowances the calibration run needs (an applied options file of a delivered film). */
  allow_applied?: boolean;
  /**
   * Evaluation only (scripts/segment-eval.ts): skip `--verify`'s "strip is
   * older than index/candidates.json" check. A delivered film's candidates
   * file may have been rewritten (a `--allow` re-index) after its recorded
   * pass looked at these same strips; measuring agreement with that pass
   * wants the strips it saw. A real run never sets this.
   */
  allow_stale?: boolean;
  onBoundary?: (record: WorkflowRecord, done: number, total: number) => void;
  env?: Record<string, string | undefined>;
  /**
   * The run's cancel signal (the worker's). Checked before every reviewer and
   * skeptic call: once it is aborted no further call is made or paid for, and
   * every boundary not yet judged is reported as `cancelled` in `errors`. The
   * calls already made keep their job rows, so a retry pays for nothing twice.
   */
  signal?: AbortSignal;
};

/** The `errors[].error` text of a boundary the pass did not reach because the run was cancelled. */
export const CANCELLED = "cancelled";

export type JudgedJob = { boundary_s: number; role: "look" | "verify"; job_id: string; cost_cents: number; skipped: boolean };

export type JudgeResult = {
  file: string;
  output: WorkflowOutput;
  records: WorkflowRecord[];
  /** Boundaries whose call failed (an LlmError, a missing strip); a result with any is not ready for apply_vision.py. */
  errors: { boundary_s: number; error: string }[];
  jobs: JudgedJob[];
  cost_cents: number;
  provider: LlmProvider;
  model: string;
};

export type JudgeUnavailable = { unavailable: string };

export function isUnavailable<T extends object>(r: T | JudgeUnavailable): r is JudgeUnavailable {
  return "unavailable" in r;
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/** The refusal `{unavailable}` carries before any call, or null when the pass may run. */
export function visionUnavailableReason(env: Record<string, string | undefined> = process.env): string | null {
  if (demoReplayActive()) return "AI passes are off in demo mode: the vision pass never runs from the demo replay (DEMO_REPLAY=0 is the explicit override)";
  const status = visionProviderStatus(env);
  return status.available ? null : status.reason;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 1)}\n`, "utf8");
  await fsp.rename(tmp, file);
}

const SUMMARY = "Choose each episode boundary by looking at contact strips, then adversarially verify each choice";

/**
 * The pass: every boundary of `doc` (or `opts.boundaries`), reviewer then
 * skeptic, three at a time, into the Workflow's output file. Refuses before
 * any call what `boundary_frames.py --verify` refuses (SegmentError with the
 * faults), and returns `{unavailable}` with no call when no vision provider
 * can run. A boundary whose call fails is reported in `errors` and left out
 * of `result`; the done job rows make a re-run pay only for what failed.
 */
export async function judgeBoundaries(run: SegmentRun, doc: OptionsDoc, opts: JudgeOptions): Promise<JudgeResult | JudgeUnavailable> {
  const env = opts.env ?? process.env;
  const unavailable = visionUnavailableReason(env);
  if (unavailable) return { unavailable };
  const status = visionProviderStatus(env);
  const { provider, model } = status;
  const llm = opts.llm ?? (callStructured as LlmFn);
  const session = opts.session ?? systemSession();
  const attempt = opts.attempt ?? 1;
  const label = opts.label;
  if (!/^[\w.-]+$/.test(label)) throw new SegmentError("options", `label ${JSON.stringify(label)} must be a plain file-name token`);

  const verified = await verifyOptions(run.cut_dir, doc, { allowApplied: !!opts.allow_applied, allowDelivered: !!opts.allow_applied, allowStale: !!opts.allow_stale });
  if (!verified.ok) throw new SegmentError("strips", `NOT READY - ${verified.faults.length} fault(s) across ${verified.n_options} options:\n  ${verified.faults.slice(0, 20).join("\n  ")}`, verified.faults);

  const wanted = opts.boundaries ? opts.boundaries.map((b) => findBoundary(doc, b) ?? (() => { throw new SegmentError("options", `boundary ${b} is not in review/options.json`); })()) : doc.boundaries;
  const sha = optionsSha(doc);
  const layout = stripLayoutOf(doc);
  const candidates = opts.candidates === undefined ? await loadCandidates(run.cut_dir) : opts.candidates;
  const filmNotes = run.film_notes ?? null;
  const outFile = opts.out_file ?? path.join(run.cut_dir, "review", "vision", `${label}.json`);

  const jobs: JudgedJob[] = [];
  const errors: JudgeResult["errors"] = [];
  let done = 0;
  const keyFor = (b: number, role: "look" | "verify") => `verify_boundaries:${run.id}:${b}:${role}:${sha.slice(0, 12)}:${BOUNDARY_RULE_VERSION}:${attempt}`;
  const cancelled = () => opts.signal?.aborted === true;

  const judgeOne = async (boundary: OptionsBoundary): Promise<WorkflowRecord | null> => {
    const b = boundary.boundary_s;
    // A cancelled run makes no further call: the boundary is reported, not judged.
    if (cancelled()) {
      errors.push({ boundary_s: b, error: CANCELLED });
      done += 1;
      return null;
    }
    try {
      const strips = await boundaryStrips(run.cut_dir, boundary, layout);
      const look = buildBoundaryReview({ boundary, strips, layout, band: doc.band, film_notes: filmNotes, provider, model });
      const looked = await runJob<BoundaryPick>(session, {
        kind: JOB_KIND,
        title_id: NO_TITLE,
        target_type: FILM_RUN_TARGET,
        target_id: run.id,
        idempotency_key: keyFor(b, "look"),
        provider,
        model,
        input: { boundary_s: b, role: "look", label, attempt, options_sha: sha, rule_version: look.prompt_version, strips: strips.map((s) => s.rel) },
        run: async () => {
          const c = await llm(look);
          return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model, provider: c.provider };
        },
      });
      jobs.push({ boundary_s: b, role: "look", job_id: looked.job.id, cost_cents: looked.job.cost_cents ?? 0, skipped: looked.skipped });
      const pick = looked.output;

      let verdict: WorkflowVerdict;
      if (pick.confidence === 0) {
        // The reviewer refused (no strip, unreadable strip). apply_vision.py faults it on the confidence alone; no skeptic is paid for.
        verdict = { agree: false, fault: "", better_key: "", reason: "reviewer refused (confidence 0); not verified" };
      } else {
        // The reviewer's row is done and reused by a retry; the skeptic is not called for a cancelled run.
        if (cancelled()) throw new Error(CANCELLED);
        const dense = opts.dense ? await opts.dense(boundary, pick.chosen_t) : null;
        const verify = buildBoundarySkeptic({ boundary, strips, pick, dense, legal_cuts: legalCutsNear(candidates, b), layout, band: doc.band, film_notes: filmNotes, provider, model });
        const verified2 = await runJob<BoundaryVerdict>(session, {
          kind: JOB_KIND,
          title_id: NO_TITLE,
          target_type: FILM_RUN_TARGET,
          target_id: run.id,
          idempotency_key: keyFor(b, "verify"),
          provider,
          model,
          input: { boundary_s: b, role: "verify", label, attempt, options_sha: sha, rule_version: verify.prompt_version, chosen_t: pick.chosen_t, dense: dense ? dense.rel : null },
          run: async () => {
            const c = await llm(verify);
            return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model, provider: c.provider };
          },
        });
        jobs.push({ boundary_s: b, role: "verify", job_id: verified2.job.id, cost_cents: verified2.job.cost_cents ?? 0, skipped: verified2.skipped });
        verdict = toWorkflowVerdict(verified2.output);
      }
      const record: WorkflowRecord = { boundary_s: b, pick: toWorkflowPick(pick), verdict };
      done += 1;
      opts.onBoundary?.(record, done, wanted.length);
      return record;
    } catch (e) {
      const message = e instanceof Error ? (e.message === CANCELLED ? CANCELLED : `${e.name}: ${e.message}`) : String(e);
      errors.push({ boundary_s: b, error: message });
      done += 1;
      return null;
    }
  };

  const judged = await pool(wanted, opts.concurrency ?? 3, judgeOne);
  const records = judged.filter((r): r is WorkflowRecord => r !== null).sort((a, b) => a.boundary_s - b.boundary_s);
  const costCents = jobs.reduce((s, j) => s + j.cost_cents, 0);
  const output: WorkflowOutput = {
    summary: SUMMARY,
    source: "pulsar-studio",
    rule_version: BOUNDARY_RULE_VERSION,
    provider,
    model,
    run_id: run.id,
    label,
    attempt,
    options_sha: sha,
    agentCount: jobs.length,
    logs: [`${records.length} boundaries judged by eye`, ...errors.map((e) => `${e.boundary_s}s: ${e.error}`)],
    result: records,
    errors,
    jobs: jobs.map((j) => ({ ...j })),
    cost_cents: costCents,
    totalTokens: 0,
  };
  WorkflowOutputSchema.parse(output);
  await writeJson(outFile, output);
  return { file: outFile, output, records, errors, jobs, cost_cents: costCents, provider, model };
}

// ---- the band-fix path ----------------------------------------------------------------------------

export type BandFixOptions = Pick<JudgeOptions, "label" | "llm" | "session" | "attempt" | "env" | "out_file" | "candidates" | "signal"> & {
  /** The first pass's records (the audit file), for the judge's context and the note. */
  first_pass?: FirstPassRecord[];
  /** The run's scratch folder (STUDIO_WORK_DIR/<run>), where anything the fix renders for itself must land; it renders nothing today, and the film folder takes only the record and the note. */
  work_dir?: string;
};

export type BandFixGroupResult = { group: BandFixGroup; judged: BandFixJudged; resolution: BandFixResolution };

export type BandFixResult = {
  file: string;
  note_file: string;
  output: WorkflowOutput;
  groups: BandFixGroupResult[];
  /** Groups with no applicable answer (a judge that refused, a skeptic with a fault and no set). */
  faults: string[];
  jobs: JudgedJob[];
  cost_cents: number;
  provider: LlmProvider;
  model: string;
};

/**
 * band_fix.workflow.js through the API: one judge per group, two skeptics
 * per judged group, resolved by the same rules as a boundary; the answer is
 * written as Workflow-shaped records (`<label>_band-fix.json`, for
 * `apply_vision.py --from <first pass> --from <this file>`) and a note in the
 * pipeline's phrasing (`<label>_band-fix.md`).
 */
export async function judgeBandFix(run: SegmentRun, doc: OptionsDoc, groups: BandFixGroup[], opts: BandFixOptions): Promise<BandFixResult | JudgeUnavailable> {
  const env = opts.env ?? process.env;
  const unavailable = visionUnavailableReason(env);
  if (unavailable) return { unavailable };
  const { provider, model } = visionProviderStatus(env);
  const llm = opts.llm ?? (callStructured as LlmFn);
  const session = opts.session ?? systemSession();
  const attempt = opts.attempt ?? 1;
  const label = opts.label;
  if (!/^[\w.-]+$/.test(label)) throw new SegmentError("options", `label ${JSON.stringify(label)} must be a plain file-name token`);
  const sha = optionsSha(doc);
  const layout = stripLayoutOf(doc);
  const candidates = opts.candidates === undefined ? await loadCandidates(run.cut_dir) : opts.candidates;
  const firstPass = opts.first_pass ?? [];
  const outFile = opts.out_file ?? path.join(run.cut_dir, "review", "vision", `${label}_band-fix.json`);
  const noteFile = outFile.replace(/\.json$/i, ".md");
  const jobs: JudgedJob[] = [];
  const results: BandFixGroupResult[] = [];
  const keyFor = (g: string, role: string) => `verify_boundaries:${run.id}:band:${g}:${role}:${sha.slice(0, 12)}:${BAND_FIX_RULE_VERSION}:${attempt}`;
  // A cancelled run stops the fix between calls; the rows already made are reused by a retry.
  const checkCancelled = () => {
    if (opts.signal?.aborted) throw new Error(`the band fix was ${CANCELLED} before its next call`);
  };

  for (const group of groups) {
    checkCancelled();
    const boundaries = group.boundaries.map((b) => findBoundary(doc, b.key) ?? (() => { throw new SegmentError("options", `band fix ${group.label}: boundary ${b.key} is not in review/options.json`); })());
    const strips: StripImage[][] = [];
    for (const b of boundaries) strips.push(await boundaryStrips(run.cut_dir, b, layout));
    const legal = (candidates?.candidates ?? []).map((c) => c.t).filter((t) => t > group.fixed_before && t < group.fixed_after);
    const records = firstPass.filter((r) => group.boundaries.some((b) => keyOf(b.key) === keyOf(r.boundary_s)));
    const input = { group, band: doc.band, boundaries, strips, layout, legal_cuts: legal, first_pass: records, film_notes: run.film_notes ?? null, provider, model };
    const judge = buildBandFixJudge(input);
    const judged = await runJob<BandFixPick>(session, {
      kind: JOB_KIND,
      title_id: NO_TITLE,
      target_type: FILM_RUN_TARGET,
      target_id: run.id,
      idempotency_key: keyFor(group.label, "judge"),
      provider,
      model,
      input: { group: group.label, role: "band_judge", label, attempt, options_sha: sha, rule_version: judge.prompt_version, keys: group.boundaries.map((b) => b.key) },
      run: async () => {
        const c = await llm(judge);
        return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model, provider: c.provider };
      },
    });
    jobs.push({ boundary_s: group.boundaries[0]?.key ?? 0, role: "look", job_id: judged.job.id, cost_cents: judged.job.cost_cents ?? 0, skipped: judged.skipped });
    const pick = judged.output;
    const verdicts: BandFixVerdict[] = [];
    if (pick.confidence > 0) {
      for (const lens of [0, 1] as const) {
        checkCancelled();
        const verify = buildBandFixSkeptic(input, pick, lens);
        const r = await runJob<BandFixVerdict>(session, {
          kind: JOB_KIND,
          title_id: NO_TITLE,
          target_type: FILM_RUN_TARGET,
          target_id: run.id,
          idempotency_key: keyFor(group.label, `verify${lens}`),
          provider,
          model,
          input: { group: group.label, role: `band_verify_${lens}`, label, attempt, options_sha: sha, rule_version: verify.prompt_version, times: pick.times },
          run: async () => {
            const c = await llm(verify);
            return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model, provider: c.provider };
          },
        });
        jobs.push({ boundary_s: group.boundaries[0]?.key ?? 0, role: "verify", job_id: r.job.id, cost_cents: r.job.cost_cents ?? 0, skipped: r.skipped });
        verdicts.push(r.output);
      }
    }
    const judgedGroup: BandFixJudged = { pick, verdicts };
    results.push({ group, judged: judgedGroup, resolution: resolveBandFix(group, judgedGroup) });
  }

  const records = results.flatMap((r) => {
    const boundaries = r.group.boundaries.map((b) => findBoundary(doc, b.key)!);
    return bandFixToVisionRecords(r.group, boundaries, r.resolution, r.judged);
  });
  const faults = results.flatMap((r) => r.resolution.faults);
  const costCents = jobs.reduce((s, j) => s + j.cost_cents, 0);
  const output: WorkflowOutput = {
    summary: "Re-judge groups of adjacent episode boundaries whose combined moves broke the length band; skeptics try to beat each answer",
    source: "pulsar-studio",
    rule_version: BAND_FIX_RULE_VERSION,
    provider,
    model,
    run_id: run.id,
    label,
    attempt,
    options_sha: sha,
    agentCount: jobs.length,
    logs: [`${results.length} groups judged`, ...faults],
    result: records,
    groups: results.map((r) => ({ label: r.group.label, times: r.resolution.times, lengths: r.resolution.lengths, source: r.resolution.source, faults: r.resolution.faults, pick: r.judged.pick, verdicts: r.judged.verdicts })) as unknown as Json,
    faults,
    jobs: jobs.map((j) => ({ ...j })),
    cost_cents: costCents,
    totalTokens: 0,
  };
  WorkflowOutputSchema.parse(output);
  await writeJson(outFile, output);
  const note = [
    `# Band fixes after the ${label} vision pass (Studio API, ${new Date().toISOString().slice(0, 10)})`,
    "",
    "Each first-pass reviewer checked the 95-150 s band against the DP positions of its neighbours, not their",
    "moved positions. Each group was re-judged by one judge looking at every boundary's strips and the first-pass",
    "records, with the band as a hard rule and the outer neighbours fixed; two skeptics tried to beat it.",
    "",
    ...results.map((r) => `${bandFixNote(r.group, r.resolution, r.judged)}\n`),
  ].join("\n");
  await fsp.writeFile(noteFile, note, "utf8");
  return { file: outFile, note_file: noteFile, output, groups: results, faults, jobs, cost_cents: costCents, provider, model };
}

// ---- evaluate: agreement with the recorded pass ------------------------------------------------------

export type EvalRow = {
  boundary_s: number;
  recorded_t: number | null;
  judged_t: number | null;
  delta_s: number | null;
  /** |recorded applied - judged applied| within the tolerance (both applied). */
  applied_agree: boolean;
  /** The reviewers chose the same time before any skeptic. */
  reviewer_agree: boolean;
  payoff_agree: boolean;
  recorded_confidence: number;
  judged_confidence: number;
  recorded_skeptic_agree: boolean | null;
  judged_skeptic_agree: boolean | null;
};

export type Evaluation = {
  tolerance_s: number;
  n_recorded: number;
  n_judged: number;
  matched: number;
  applied_agree: number;
  applied_rate: number | null;
  reviewer_agree: number;
  reviewer_rate: number | null;
  payoff_agree: number;
  payoff_rate: number | null;
  /** Boundaries where one side has an applicable time and the other faulted. */
  one_sided: number;
  rows: EvalRow[];
};

/** A record from either side: the pipeline's parsed VisionBoundary (phase 1) or a Workflow record. */
export type EvalRecord = { boundary_s: number; pick: { chosen_t: number; payoff_in_episode: boolean; confidence: number; why?: string }; verdict?: { agree: boolean; better_t?: number | null; fault?: string | null; reason?: string } | null };

/**
 * How far a judged pass agrees with a recorded one, boundary by boundary:
 * the APPLIED time (after the skeptic, by apply_vision.py's rules) within
 * ±0.2 s, the reviewers' own picks, and payoff_in_episode. Agreement with
 * past agent picks, not correctness: most recorded boundaries were never
 * watched by Ruobin (plan B5).
 */
export function evaluate(recorded: EvalRecord[], judged: EvalRecord[], opts: { tolerance_s?: number } = {}): Evaluation {
  const tol = opts.tolerance_s ?? 0.2;
  const asRecord = (r: EvalRecord): WorkflowRecord => ({
    boundary_s: r.boundary_s,
    pick: { chosen_key: "", chosen_t: r.pick.chosen_t, ends_on: "", opens_on: "", why: r.pick.why ?? "", payoff_in_episode: r.pick.payoff_in_episode, confidence: r.pick.confidence },
    verdict: r.verdict ? { agree: r.verdict.agree, better_t: r.verdict.better_t ?? undefined, fault: r.verdict.fault ?? undefined, reason: r.verdict.reason ?? "" } : null,
  });
  const byKey = new Map(recorded.map((r) => [keyOf(r.boundary_s), r]));
  const rows: EvalRow[] = [];
  let oneSided = 0;
  for (const j of [...judged].sort((a, b) => a.boundary_s - b.boundary_s)) {
    const r = byKey.get(keyOf(j.boundary_s));
    if (!r) continue;
    const ra = appliedTimeOf(asRecord(r));
    const ja = appliedTimeOf(asRecord(j));
    const both = ra.t !== null && ja.t !== null;
    if ((ra.t === null) !== (ja.t === null)) oneSided += 1;
    const delta = both ? Math.round((ja.t! - ra.t!) * 1000) / 1000 : null;
    rows.push({
      boundary_s: j.boundary_s,
      recorded_t: ra.t,
      judged_t: ja.t,
      delta_s: delta,
      applied_agree: both && Math.abs(delta!) <= tol + 1e-9,
      reviewer_agree: Math.abs(j.pick.chosen_t - r.pick.chosen_t) <= tol + 1e-9,
      payoff_agree: j.pick.payoff_in_episode === r.pick.payoff_in_episode,
      recorded_confidence: r.pick.confidence,
      judged_confidence: j.pick.confidence,
      recorded_skeptic_agree: r.verdict ? r.verdict.agree : null,
      judged_skeptic_agree: j.verdict ? j.verdict.agree : null,
    });
  }
  const n = rows.length;
  const count = (f: (r: EvalRow) => boolean) => rows.filter(f).length;
  const rate = (c: number) => (n ? Math.round((c / n) * 1000) / 1000 : null);
  const applied = count((r) => r.applied_agree);
  const reviewer = count((r) => r.reviewer_agree);
  const payoff = count((r) => r.payoff_agree);
  return {
    tolerance_s: tol,
    n_recorded: recorded.length,
    n_judged: judged.length,
    matched: n,
    applied_agree: applied,
    applied_rate: rate(applied),
    reviewer_agree: reviewer,
    reviewer_rate: rate(reviewer),
    payoff_agree: payoff,
    payoff_rate: rate(payoff),
    one_sided: oneSided,
    rows,
  };
}
