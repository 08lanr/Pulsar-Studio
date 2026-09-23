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

import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { systemSession, type Session } from "@/lib/auth";
import { demoReplayActive } from "@/lib/data-source";
import { runJob } from "@/lib/jobs";
import { KEY_VAR, callStructured, isLlmAvailable, modelFamily, modelSupportsVision, visionProviderStatus, type LlmProvider, type StructuredCall, type StructuredResult } from "@/lib/llm";
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
import { buildBoundarySkeptic, citationProblem, type BoundaryVerdict } from "@/lib/prompts/boundary-skeptic";
import { buildBoundaryTiebreak, type TiebreakSide, type TiebreakVerdict } from "@/lib/prompts/boundary-tiebreak";
import type { CandidatesIndex } from "@/lib/film-import/types";
import { CONFIDENCE_GATE } from "@/lib/segment/stages";
import type { JobKind, Json } from "@/lib/types";
import {
  SEEN_TOLERANCE_S,
  SegmentError,
  allowedRange,
  boundaryStrips,
  deliveredFixedStart,
  findBoundary,
  inBand,
  inCardSpan,
  isListedTime,
  isSeenTime,
  legalCutsInView,
  lengthsAt,
  loadCandidates,
  loadCardSpans,
  neighboursOf,
  optionsSha,
  stripLayoutOf,
  verifyOptions,
  type CardSpan,
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

/** A reviewer's pick as the Workflow wrote it: `rejected` only when there was one; `options_seen` (the second pass's observation-first field) kept for the audit, which apply_vision.py ignores. */
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
  if (p.options_seen?.length) out.options_seen = p.options_seen;
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

// ---- the guard on a skeptic override -----------------------------------------------------------------
//
// The first calibration (diagnosis 2026-09-23): the API skeptic named a fix
// nine times in twenty boundaries and none was right; every one broke a
// standing rule, and apply_vision.py's rule 1 (a skeptic with a better time
// wins) applied them all. The Workflow's skeptic had more evidence than its
// reviewer; the API's has the same or less. So here an override is a
// candidate, not an answer: it must be a time the skeptic saw in an image,
// keep both episodes in band against the planner's neighbours, lie outside
// the source's card spans and be a legal cut; then a blind tie-break call
// decides between the two cuts. The file Studio writes already carries the
// guarded decision, so apply_vision.py stays as it is.

export type GuardRule = "unseen_time" | "band" | "card" | "illegal";

export type GuardInput = {
  better_t: number;
  /** Every image the skeptic received (the option strips, then the dense strip). */
  images: Pick<StripImage, "tiles">[];
  prev: number;
  next: number;
  band: [number, number];
  card_spans: CardSpan[];
  /** The listed option times plus every legal cut of the index. */
  legal_times: number[];
};

export type GuardResult = { ok: true } | { ok: false; rule: GuardRule; detail: string };

/** The four checks an override must pass, in order; the first failure names itself. Pure. */
export function guardOverride(g: GuardInput): GuardResult {
  const t = g.better_t;
  if (!isSeenTime(t, g.images)) return { ok: false, rule: "unseen_time", detail: `${t}s is not a tile time of any image the skeptic saw (a listed option's centre tile or a dense tile within ${SEEN_TOLERANCE_S}s)` };
  if (!inBand(t, g.prev, g.next, g.band)) {
    const { before, after } = lengthsAt(t, g.prev, g.next);
    return { ok: false, rule: "band", detail: `${t}s makes episodes of ${before}s and ${after}s against the neighbours ${g.prev}s and ${g.next}s; every episode must be ${g.band[0]}-${g.band[1]} s` };
  }
  const card = inCardSpan(t, g.card_spans);
  if (card) return { ok: false, rule: "card", detail: `${t}s is inside the source's card ${card.from_s}-${card.to_s}s: the next episode would open on the card` };
  if (!isListedTime(t, g.legal_times)) return { ok: false, rule: "illegal", detail: `${t}s is neither a listed option nor a legal cut in index/candidates.json` };
  return { ok: true };
}

/** What became of the skeptic's answer at a boundary, recorded on the verdict (`guard.outcome`) for the review screen and the eval. */
export type GuardOutcome =
  | "agreed"
  | "refused"
  | "uncited"
  | "fault_no_fix"
  | "rejected"
  | "no_tiebreak"
  | "tiebreak_skeptic"
  | "tiebreak_reviewer"
  | "tiebreak_neither";

/** The outcomes that send the boundary to a person as `skeptic_unverified`: a fix that failed a guard, or one nobody could tie-break. */
export const UNVERIFIED_OUTCOMES: readonly GuardOutcome[] = ["rejected", "no_tiebreak"];

const GuardOutcomeSchema = z.enum(["agreed", "refused", "uncited", "fault_no_fix", "rejected", "no_tiebreak", "tiebreak_skeptic", "tiebreak_reviewer", "tiebreak_neither"]);

/** The guard's note on a verdict: the outcome, the rule that stopped a fix, the skeptic's time. Passthrough for apply_vision.py and phase 1, read back by reviewState. */
export const VerdictGuardSchema = z.object({
  outcome: GuardOutcomeSchema,
  rule: z.enum(["unseen_time", "band", "card", "illegal"]).nullable(),
  detail: z.string(),
  better_t: z.number().nullable(),
});

export type VerdictGuard = z.infer<typeof VerdictGuardSchema>;

/** One image the skeptic saw, compactly: its number, key, first and last tile and step (the eval's unseen check rebuilds the tiles from these). */
export const VerdictEvidenceSchema = z.object({ image: z.number().int(), key: z.string(), from: z.number(), to: z.number(), step: z.number(), annotated: z.boolean() });

export type VerdictEvidence = z.infer<typeof VerdictEvidenceSchema>;

export const VerdictTiebreakSchema = z.object({
  /** Which side was A: the reviewer's cut or the skeptic's. */
  a_side: z.enum(["reviewer", "skeptic"]),
  a_t: z.number(),
  b_t: z.number(),
  winner: z.enum(["reviewer", "skeptic", "neither"]),
  a_shows: z.string(),
  b_shows: z.string(),
  /** The tile of each side's own images where it breaks a rule (the losing side always; both for `neither`): what the review screen shows the person to look at. */
  a_fault_tile_t: z.number().nullable(),
  b_fault_tile_t: z.number().nullable(),
  evidence_image: z.number().nullable(),
  evidence_tile_t: z.number().nullable(),
  reason: z.string(),
});

export type VerdictTiebreak = z.infer<typeof VerdictTiebreakSchema>;

/** The fault tiles of a tie-break by side: the reviewer's cut and the skeptic's, whichever letter each was. */
export function tiebreakFaults(tb: Pick<VerdictTiebreak, "a_side" | "a_fault_tile_t" | "b_fault_tile_t">): { reviewer: number | null; skeptic: number | null } {
  return tb.a_side === "reviewer" ? { reviewer: tb.a_fault_tile_t, skeptic: tb.b_fault_tile_t } : { reviewer: tb.b_fault_tile_t, skeptic: tb.a_fault_tile_t };
}

/** The guard's note on a record's verdict, or null for a record without one (a hand-off, the fake, a first-pass Workflow record). */
export function readGuard(verdict: WorkflowVerdict | null | undefined): VerdictGuard | null {
  const raw = (verdict as Record<string, unknown> | null | undefined)?.guard;
  const parsed = VerdictGuardSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The images a record's skeptic saw, as tile lists (the eval's unseen-time check). */
export function evidenceTiles(verdict: WorkflowVerdict | null | undefined): { tiles: number[] }[] {
  const raw = (verdict as Record<string, unknown> | null | undefined)?.evidence;
  const parsed = z.array(VerdictEvidenceSchema).safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((e) => {
    const n = Math.max(0, Math.round((e.to - e.from) / e.step));
    return { tiles: Array.from({ length: n + 1 }, (_, i) => Math.round((e.from + i * e.step) * 1000) / 1000) };
  });
}

const evidenceOf = (images: StripImage[]): VerdictEvidence[] => images.map((img, i) => ({ image: i + 1, key: img.key, from: img.tiles[0] ?? img.t, to: img.tiles[img.tiles.length - 1] ?? img.t, step: img.step, annotated: !!img.annotated }));

/** Which side is A in the tie-break: from a hash of the run, the boundary and the attempt, so a re-run repeats the order and another run varies it. */
export function tiebreakOrder(runId: string, boundaryS: number, attempt: number): "reviewer" | "skeptic" {
  const h = createHash("sha256").update(`${runId}:${boundaryS}:${attempt}`).digest();
  return h[0] % 2 === 0 ? "reviewer" : "skeptic";
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

/** Makes the annotated copy of a strip for the model (lib/segment/annotate annotateStrip into STUDIO_WORK_DIR), the cut at `cutT`. */
export type AnnotateFn = (strip: StripImage, cutT: number) => Promise<StripImage>;

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
  /** The annotated copies (on by default in the runner and the eval); null or absent sends the pipeline's raw PNGs. */
  annotate?: AnnotateFn | null;
  /** index/candidates.json; loaded from the run's folder when absent, [] when the film has none. */
  candidates?: CandidatesIndex | null;
  /** The source's card spans (film-meta.json exclusions of kind card, index/skips.json); loaded from the run's folder when absent. */
  card_spans?: CardSpan[] | null;
  /** The fixed start of the stretch (the last delivered pin); read from the newest DELIVERED file when absent, 0 for a film without one. The eval passes 0. */
  fixed_start?: number;
  /** A model of the vision provider's own family in place of its fast tier (the eval's --model); refused when it cannot read images or its key is missing. */
  model?: string;
  /** The blind tie-break on an override that passed the guards (default on); off, such an override needs a person. */
  tiebreak?: boolean;
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
   * The run's cancel signal (the worker's). Checked before every reviewer,
   * skeptic and tie-break call: once it is aborted no further call is made
   * or paid for, and every boundary not yet judged is reported as
   * `cancelled` in `errors`. The calls already made keep their job rows, so
   * a retry pays for nothing twice.
   */
  signal?: AbortSignal;
};

/** The `errors[].error` text of a boundary the pass did not reach because the run was cancelled. */
export const CANCELLED = "cancelled";

export type JudgedJob = { boundary_s: number; role: "look" | "verify" | "tiebreak"; job_id: string; cost_cents: number; skipped: boolean };

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

/** The provider and model a pass runs on: the vision provider's fast tier, or `model` when it is one of that family's and reads images. */
export function resolveJudgeModel(env: Record<string, string | undefined>, model: string | undefined): { provider: LlmProvider; model: string } | JudgeUnavailable {
  const status = visionProviderStatus(env);
  if (!model || model === status.model) return { provider: status.provider, model: status.model };
  const family = modelFamily(model) ?? status.provider;
  if (!isLlmAvailable(family, env)) return { unavailable: `vision provider unavailable: ${model} needs ${KEY_VAR[family]} in .env.local` };
  if (!modelSupportsVision(family, model)) return { unavailable: `vision provider unavailable: ${model} does not read images` };
  return { provider: family, model };
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
 * skeptic (then, for a skeptic's fix that passes the guards, a blind
 * tie-break), three at a time, into the Workflow's output file. Refuses
 * before any call what `boundary_frames.py --verify` refuses (SegmentError
 * with the faults), and returns `{unavailable}` with no call when no vision
 * provider can run. A boundary whose call fails is reported in `errors` and
 * left out of `result`; the done job rows make a re-run pay only for what
 * failed.
 */
export async function judgeBoundaries(run: SegmentRun, doc: OptionsDoc, opts: JudgeOptions): Promise<JudgeResult | JudgeUnavailable> {
  const env = opts.env ?? process.env;
  const unavailable = visionUnavailableReason(env);
  if (unavailable) return { unavailable };
  const resolved = resolveJudgeModel(env, opts.model);
  if (isUnavailable(resolved)) return resolved;
  const { provider, model } = resolved;
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
  const cardSpans = opts.card_spans === undefined || opts.card_spans === null ? await loadCardSpans(run.cut_dir) : opts.card_spans;
  const fixedStart = opts.fixed_start ?? (await deliveredFixedStart(run.cut_dir));
  const filmNotes = run.film_notes ?? null;
  const annotate = opts.annotate ?? null;
  const tiebreakOn = opts.tiebreak !== false;
  const outFile = opts.out_file ?? path.join(run.cut_dir, "review", "vision", `${label}.json`);
  const allLegal = (candidates?.candidates ?? []).map((c) => c.t);

  const jobs: JudgedJob[] = [];
  const errors: JudgeResult["errors"] = [];
  let done = 0;
  const keyFor = (b: number, role: JudgedJob["role"]) => `verify_boundaries:${run.id}:${b}:${role}:${sha.slice(0, 12)}:${BOUNDARY_RULE_VERSION}:${attempt}`;
  const cancelled = () => opts.signal?.aborted === true;
  const common = { kind: JOB_KIND, title_id: NO_TITLE, target_type: FILM_RUN_TARGET, target_id: run.id, provider, model } as const;

  const judgeOne = async (boundary: OptionsBoundary): Promise<WorkflowRecord | null> => {
    const b = boundary.boundary_s;
    // A cancelled run makes no further call: the boundary is reported, not judged.
    if (cancelled()) {
      errors.push({ boundary_s: b, error: CANCELLED });
      done += 1;
      return null;
    }
    try {
      const raw = await boundaryStrips(run.cut_dir, boundary, layout);
      const strips: StripImage[] = [];
      for (const s of raw) strips.push(annotate ? await annotate(s, s.t) : s);
      const { prev, next } = neighboursOf(doc, b, fixedStart);
      // An inverted range (neighbours too far apart for any in-band cut: a sparse or synthetic options file) states the band alone; the guard still measures the lengths.
      const span = allowedRange(prev, next, doc.band);
      const range = span.lo <= span.hi ? { prev, next, ...span } : null;
      const look = buildBoundaryReview({ boundary, strips, layout, band: doc.band, range, card_spans: cardSpans, film_notes: filmNotes, provider, model });
      const looked = await runJob<BoundaryPick>(session, {
        ...common,
        idempotency_key: keyFor(b, "look"),
        input: { boundary_s: b, role: "look", label, attempt, options_sha: sha, rule_version: look.prompt_version, strips: strips.map((s) => s.rel), annotated: strips.every((s) => !!s.annotated), range },
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
        verdict = { agree: false, fault: "", better_key: "", reason: "reviewer refused (confidence 0); not verified", guard: { outcome: "refused", rule: null, detail: "", better_t: null } satisfies VerdictGuard };
      } else {
        // The reviewer's row is done and reused by a retry; the skeptic is not called for a cancelled run.
        if (cancelled()) throw new Error(CANCELLED);
        const denseRaw = opts.dense ? await opts.dense(boundary, pick.chosen_t) : null;
        const dense = denseRaw && annotate ? await annotate(denseRaw, pick.chosen_t) : denseRaw;
        const images = [...strips, ...(dense ? [dense] : [])];
        const legal = legalCutsInView(candidates, images, range);
        const verify = buildBoundarySkeptic({ boundary, strips, pick, dense, legal_cuts: legal, layout, band: doc.band, range, card_spans: cardSpans, film_notes: filmNotes, provider, model });
        const verified2 = await runJob<BoundaryVerdict>(session, {
          ...common,
          idempotency_key: keyFor(b, "verify"),
          input: { boundary_s: b, role: "verify", label, attempt, options_sha: sha, rule_version: verify.prompt_version, chosen_t: pick.chosen_t, dense: dense ? dense.rel : null, legal_cuts: legal.map((c) => c.t), range },
          run: async () => {
            const c = await llm(verify);
            return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model, provider: c.provider };
          },
        });
        jobs.push({ boundary_s: b, role: "verify", job_id: verified2.job.id, cost_cents: verified2.job.cost_cents ?? 0, skipped: verified2.skipped });
        const skeptic = verified2.output;
        const evidence = evidenceOf(images);
        const note = (outcome: GuardOutcome, rule: GuardRule | null, detail: string): VerdictGuard => ({ outcome, rule, detail, better_t: skeptic.better_t ?? null });

        if (skeptic.agree) {
          verdict = { ...toWorkflowVerdict(skeptic), skeptic_raw: skeptic, guard: note("agreed", null, ""), evidence };
        } else if (skeptic.fault_image === null || skeptic.fault_tile_t === null || citationProblem(skeptic, images) !== null) {
          // A fault that cites no image and tile (or a tile the image does not have) is recorded, never applied: the reviewer's pick stands.
          const problem = citationProblem(skeptic, images) ?? "cite both fault_image and fault_tile_t, or neither";
          verdict = { agree: true, fault: "", better_key: "", reason: `skeptic disputed ${pick.chosen_t}s without citing a frame (${problem}); ignored. Skeptic said: ${skeptic.fault ?? ""} ${skeptic.reason}`.trim(), skeptic_raw: skeptic, guard: note("uncited", null, problem), evidence };
        } else if (skeptic.better_t === null || skeptic.better_t === undefined || skeptic.better_t === 0) {
          // A cited fault with no fix: apply_vision.py's rule 2, the boundary goes to a person.
          verdict = { ...toWorkflowVerdict({ ...skeptic, better_t: null }), skeptic_raw: skeptic, guard: note("fault_no_fix", null, ""), evidence };
        } else {
          const betterT = skeptic.better_t;
          const guard = guardOverride({ better_t: betterT, images, prev, next, band: doc.band, card_spans: cardSpans, legal_times: [...boundary.options.map((o) => o.t), ...allLegal] });
          if (!guard.ok) {
            // The reviewer's pick is written as the answer; the skeptic's verdict is the note. reviewState reads guard.outcome and asks a person.
            verdict = { agree: true, fault: "", better_key: "", reason: `skeptic disputed ${pick.chosen_t}s (${skeptic.fault ?? "fault"}) and named ${betterT}s, not applied (${guard.rule}: ${guard.detail}). Skeptic said: ${skeptic.reason}`, skeptic_raw: skeptic, guard: note("rejected", guard.rule, guard.detail), evidence };
          } else {
            // The blind tie-break: the reviewer's cut and the skeptic's, as A and B, each with its images; no reasoning from either side.
            if (cancelled()) throw new Error(CANCELLED);
            const optionStripAt = (t: number) => strips.find((s) => Math.abs(s.t - t) <= 0.0015) ?? null;
            const skepticDenseRaw = opts.dense ? await opts.dense(boundary, betterT) : null;
            const skepticDense = skepticDenseRaw && annotate ? await annotate(skepticDenseRaw, betterT) : skepticDenseRaw;
            const reviewerImages = [optionStripAt(pick.chosen_t), dense].filter((x): x is StripImage => x !== null);
            const skepticImages = [optionStripAt(betterT), skepticDense].filter((x): x is StripImage => x !== null);
            const first = tiebreakOrder(run.id, b, attempt);
            if (!tiebreakOn || !reviewerImages.length || !skepticImages.length) {
              const why = !tiebreakOn ? "the tie-break is off for this pass" : "no image covers one of the two cuts (no dense strip could be rendered)";
              verdict = { agree: true, fault: "", better_key: "", reason: `skeptic disputed ${pick.chosen_t}s (${skeptic.fault ?? "fault"}) and named ${betterT}s; the guards passed but ${why}, so a person decides. Skeptic said: ${skeptic.reason}`, skeptic_raw: skeptic, guard: note("no_tiebreak", null, why), evidence };
            } else {
              const sideOf = (label: "A" | "B", who: "reviewer" | "skeptic"): TiebreakSide => {
                const t = who === "reviewer" ? pick.chosen_t : betterT;
                const opt = boundary.options.find((o) => Math.abs(o.t - t) <= 0.0015);
                return { label, t, option_key: opt?.key ?? null, images: who === "reviewer" ? reviewerImages : skepticImages };
              };
              const a = sideOf("A", first);
              const bSide = sideOf("B", first === "reviewer" ? "skeptic" : "reviewer");
              const tb = buildBoundaryTiebreak({ boundary, sides: [a, bSide], layout, band: doc.band, range, card_spans: cardSpans, film_notes: filmNotes, provider, model });
              const broken = await runJob<TiebreakVerdict>(session, {
                ...common,
                idempotency_key: keyFor(b, "tiebreak"),
                input: { boundary_s: b, role: "tiebreak", label, attempt, options_sha: sha, rule_version: tb.prompt_version, a_t: a.t, b_t: bSide.t, a_side: first, images: [...a.images, ...bSide.images].map((i) => i.rel) },
                run: async () => {
                  const c = await llm(tb);
                  return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model, provider: c.provider };
                },
              });
              jobs.push({ boundary_s: b, role: "tiebreak", job_id: broken.job.id, cost_cents: broken.job.cost_cents ?? 0, skipped: broken.skipped });
              const tv = broken.output;
              const winner: VerdictTiebreak["winner"] = tv.winner === "neither" ? "neither" : (tv.winner === "A") === (first === "reviewer") ? "reviewer" : "skeptic";
              const tiebreak: VerdictTiebreak = { a_side: first, a_t: a.t, b_t: bSide.t, winner, a_shows: tv.a_shows, b_shows: tv.b_shows, a_fault_tile_t: tv.a_fault_tile_t, b_fault_tile_t: tv.b_fault_tile_t, evidence_image: tv.evidence_image, evidence_tile_t: tv.evidence_tile_t, reason: tv.reason };
              const faults = tiebreakFaults(tiebreak);
              const at = (t: number | null) => (t === null ? "no tile cited" : `look at tile ${t}s`);
              if (winner === "skeptic") {
                verdict = { ...toWorkflowVerdict(skeptic), reason: `${skeptic.reason} | tie-break chose the skeptic's ${betterT}s (${pick.chosen_t}s faults: ${at(faults.reviewer)}): ${tv.reason}`, skeptic_raw: skeptic, guard: note("tiebreak_skeptic", null, tv.reason), tiebreak, evidence };
              } else if (winner === "reviewer") {
                verdict = { agree: true, fault: "", better_key: "", reason: `skeptic disputed ${pick.chosen_t}s (${skeptic.fault ?? "fault"}) and named ${betterT}s; the blind tie-break kept ${pick.chosen_t}s (${betterT}s faults: ${at(faults.skeptic)}): ${tv.reason}. Skeptic said: ${skeptic.reason}`, skeptic_raw: skeptic, guard: note("tiebreak_reviewer", null, tv.reason), tiebreak, evidence };
              } else {
                verdict = { agree: false, fault: skeptic.fault || `tie-break: neither ${pick.chosen_t}s nor ${betterT}s satisfies the payoff rule`, better_key: "", reason: `the blind tie-break found neither cut sound (${pick.chosen_t}s: ${at(faults.reviewer)}; ${betterT}s: ${at(faults.skeptic)}): ${tv.reason}. Skeptic said: ${skeptic.reason}`, skeptic_raw: skeptic, guard: note("tiebreak_neither", null, tv.reason), tiebreak, evidence };
              }
            }
          }
        }
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
    annotated: annotate !== null,
    dense: !!opts.dense,
    tiebreak: tiebreakOn,
    film_notes: filmNotes,
    fixed_start: fixedStart,
    card_spans: cardSpans.length,
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

// ---- scoring against the DELIVERED cuts ------------------------------------------------------------------
//
// The first calibration scored the API pass against the first-pass records
// (2026-09-22_0-end.json), which the band fix and the QA re-pins moved at
// several boundaries (323.4's delivered cut is 315.533, not 316.067;
// 1325.967's is 1342.067, not 1352.633). The truth for a calibration is the
// newest `review/cuts-*-DELIVERED.json`: what was rendered. This maps each
// options boundary to its delivered end, scores the judged pass against it
// with and without the skeptic, and runs the hard-rule checks that need no
// model (a cut inside a card span, an episode out of band with the applied
// neighbours, an applied override the skeptic never saw).

/** The delivered end each options boundary became: the nearest delivered end inside the boundary's own half-window (between the midpoints to its neighbours), or null when none (a join removed it). */
export function deliveredTruth(doc: Pick<OptionsDoc, "boundaries">, deliveredEnds: number[]): { truth: Record<string, number | null>; unmatched: number[] } {
  const bs = [...doc.boundaries].map((b) => b.boundary_s).sort((a, b) => a - b);
  const ends = [...deliveredEnds].sort((a, b) => a - b);
  const truth: Record<string, number | null> = {};
  const unmatched: number[] = [];
  for (const [i, b] of bs.entries()) {
    const lo = i > 0 ? (bs[i - 1] + b) / 2 : -Infinity;
    const hi = i < bs.length - 1 ? (b + bs[i + 1]) / 2 : Infinity;
    const inside = ends.filter((e) => e > lo && e < hi);
    if (!inside.length) {
      truth[String(b)] = null;
      unmatched.push(b);
      continue;
    }
    truth[String(b)] = inside.reduce((best, e) => (Math.abs(e - b) < Math.abs(best - b) ? e : best), inside[0]);
  }
  return { truth, unmatched };
}

export type SkepticEffect = "helped" | "hurt" | "neutral" | "handoff";

export type ScoreRow = {
  boundary_s: number;
  truth_t: number | null;
  /** What apply_vision.py applies for the judged record (null: a fault, the boundary goes to a person). */
  applied_t: number | null;
  applied_source: "reviewer" | "SKEPTIC OVERRIDE" | null;
  reviewer_t: number;
  reviewer_confidence: number;
  applied_agree: boolean;
  /** The reviewer's own pick against the truth: the score with the skeptic switched off. */
  reviewer_agree: boolean;
  dp_pick: boolean;
  skeptic_agree: boolean | null;
  guard: GuardOutcome | null;
  skeptic_better_t: number | null;
  effect: SkepticEffect;
  /** A card boundary: the delivered cut is the first frame after a card span. */
  card_boundary: boolean;
  card_agree: boolean | null;
  /** Hard-rule failures of the applied time, in words; [] when it passes. */
  rule_failures: string[];
  lengths: { before: number; after: number } | null;
};

export type Score = {
  tolerance_s: number;
  n: number;
  applied_agree: number;
  reviewer_only_agree: number;
  /** Boundaries with no applied time (a fault) or a fix nobody could verify or tie-break: apply_vision's FAILs plus `skeptic_unverified`. */
  handoffs: number;
  /** Every boundary reviewState marks needs_decision: the hand-offs plus every reviewer pick under the confidence gate. The person's real workload; the bar counts this. */
  person_reviews: number;
  confidence_gate: number;
  dp_rate: number | null;
  skeptic: {
    agreed: number;
    disputed: number;
    fixes_named: number;
    applied: number;
    rejected: Record<string, number>;
    uncited: number;
    fault_no_fix: number;
    no_tiebreak: number;
    tiebreak_skeptic: number;
    tiebreak_reviewer: number;
    tiebreak_neither: number;
    helped: number;
    hurt: number;
    /** Applied overrides that moved away from a reviewer pick which matched the truth. */
    bad_overrides: number;
  };
  cards: { boundaries: number; agree: number };
  rule_failures: { card: number; band: number; unseen: number; total: number };
  rows: ScoreRow[];
};

export type ScoreInput = {
  doc: Pick<OptionsDoc, "boundaries" | "duration" | "band">;
  /** deliveredTruth's map. */
  truth: Record<string, number | null>;
  judged: WorkflowRecord[];
  card_spans: CardSpan[];
  fixed_start?: number;
  tolerance_s?: number;
};

/**
 * The judged pass against the delivered cuts: the applied time (after the
 * guarded skeptic), the reviewer's own pick (the skeptic switched off), the
 * skeptic's effect boundary by boundary, the DP-pick rate, the card
 * boundaries, and the three hard-rule checks on every applied time. The
 * band check uses the APPLIED neighbours: a judged neighbour's applied time,
 * else the delivered truth, else the planner's position.
 */
export function scoreAgainstTruth(input: ScoreInput): Score {
  const tol = input.tolerance_s ?? 0.2;
  const [lo, hi] = input.doc.band;
  const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= tol + 1e-9;
  const byKey = new Map(input.judged.map((r) => [keyOf(r.boundary_s), r]));
  // Every boundary's current position for the neighbour arithmetic.
  const positions = [...input.doc.boundaries]
    .map((b) => {
      const j = byKey.get(keyOf(b.boundary_s));
      const applied = j ? appliedTimeOf(j) : null;
      const at = applied && applied.t !== null ? applied.t : input.truth[String(b.boundary_s)] ?? b.dp_pick ?? b.boundary_s;
      return { key: b.boundary_s, at };
    })
    .sort((a, b) => a.key - b.key);
  const cardEnds = input.card_spans.map((c) => c.to_s);
  const rows: ScoreRow[] = [];
  for (const j of [...input.judged].sort((a, b) => a.boundary_s - b.boundary_s)) {
    const entry = input.doc.boundaries.find((b) => keyOf(b.boundary_s) === keyOf(j.boundary_s));
    if (!entry) continue;
    const truth = input.truth[String(j.boundary_s)] ?? null;
    const applied = appliedTimeOf(j);
    const appliedT = applied.t;
    const guard = readGuard(j.verdict);
    const dp = entry.options.find((o) => o.is_dp_pick)?.t ?? entry.dp_pick ?? entry.boundary_s;
    const i = positions.findIndex((p) => keyOf(p.key) === keyOf(j.boundary_s));
    const prev = i > 0 ? positions[i - 1].at : input.fixed_start ?? 0;
    const next = i < positions.length - 1 ? positions[i + 1].at : input.doc.duration;
    const failures: string[] = [];
    let lengths: { before: number; after: number } | null = null;
    if (appliedT !== null) {
      lengths = lengthsAt(appliedT, prev, next);
      const card = inCardSpan(appliedT, input.card_spans);
      if (card) failures.push(`card: ${appliedT}s opens the next episode on the card ${card.from_s}-${card.to_s}s`);
      if (!inBand(appliedT, prev, next, input.doc.band)) failures.push(`band: ${lengths.before}s / ${lengths.after}s against ${prev}s and ${next}s (${lo}-${hi} s)`);
      if (applied.t !== null && applied.source === "SKEPTIC OVERRIDE" && !isSeenTime(appliedT, evidenceTiles(j.verdict))) failures.push(`unseen: the applied override ${appliedT}s is not a tile of any image the skeptic saw`);
    }
    const reviewerAgree = (j.pick.confidence ?? 0) > 0 && near(j.pick.chosen_t, truth);
    const appliedAgree = near(appliedT, truth);
    const effect: SkepticEffect = appliedT === null ? "handoff" : reviewerAgree && !appliedAgree ? "hurt" : !reviewerAgree && appliedAgree ? "helped" : "neutral";
    const cardBoundary = truth !== null && cardEnds.some((e) => Math.abs(e - truth) <= tol + 1e-9);
    rows.push({
      boundary_s: j.boundary_s,
      truth_t: truth,
      applied_t: appliedT,
      applied_source: applied.t !== null ? applied.source : null,
      reviewer_t: j.pick.chosen_t,
      reviewer_confidence: j.pick.confidence ?? 0,
      applied_agree: appliedAgree,
      reviewer_agree: reviewerAgree,
      dp_pick: Math.abs(j.pick.chosen_t - dp) <= 0.0015,
      skeptic_agree: j.verdict ? j.verdict.agree : null,
      guard: guard?.outcome ?? null,
      skeptic_better_t: guard?.better_t ?? j.verdict?.better_t ?? null,
      effect,
      card_boundary: cardBoundary,
      card_agree: cardBoundary ? appliedAgree : null,
      rule_failures: failures,
      lengths,
    });
  }
  const n = rows.length;
  const count = (f: (r: ScoreRow) => boolean) => rows.filter(f).length;
  const outcome = (o: GuardOutcome) => count((r) => r.guard === o);
  const rejected: Record<string, number> = {};
  for (const j of input.judged) {
    const g = readGuard(j.verdict);
    if (g?.outcome === "rejected" && g.rule) rejected[g.rule] = (rejected[g.rule] ?? 0) + 1;
  }
  const cardRows = rows.filter((r) => r.card_boundary);
  const handoff = (r: ScoreRow) => r.applied_t === null || r.guard === "rejected" || r.guard === "no_tiebreak";
  return {
    tolerance_s: tol,
    n,
    applied_agree: count((r) => r.applied_agree),
    reviewer_only_agree: count((r) => r.reviewer_agree),
    handoffs: count(handoff),
    // The same predicate reviewState applies (lib/segment/plan.ts): a fault, an unverified fix, or a pick under CONFIDENCE_GATE.
    person_reviews: count((r) => handoff(r) || r.reviewer_confidence < CONFIDENCE_GATE),
    confidence_gate: CONFIDENCE_GATE,
    dp_rate: n ? Math.round((count((r) => r.dp_pick) / n) * 1000) / 1000 : null,
    skeptic: {
      agreed: outcome("agreed"),
      disputed: count((r) => r.guard !== null && r.guard !== "agreed" && r.guard !== "refused"),
      fixes_named: count((r) => r.skeptic_better_t !== null && r.guard !== "agreed"),
      applied: count((r) => r.applied_source === "SKEPTIC OVERRIDE"),
      rejected,
      uncited: outcome("uncited"),
      fault_no_fix: outcome("fault_no_fix"),
      no_tiebreak: outcome("no_tiebreak"),
      tiebreak_skeptic: outcome("tiebreak_skeptic"),
      tiebreak_reviewer: outcome("tiebreak_reviewer"),
      tiebreak_neither: outcome("tiebreak_neither"),
      helped: count((r) => r.effect === "helped"),
      hurt: count((r) => r.effect === "hurt"),
      bad_overrides: count((r) => r.applied_source === "SKEPTIC OVERRIDE" && r.reviewer_agree && !r.applied_agree),
    },
    cards: { boundaries: cardRows.length, agree: cardRows.filter((r) => r.card_agree).length },
    rule_failures: {
      card: count((r) => r.rule_failures.some((f) => f.startsWith("card:"))),
      band: count((r) => r.rule_failures.some((f) => f.startsWith("band:"))),
      unseen: count((r) => r.rule_failures.some((f) => f.startsWith("unseen:"))),
      total: count((r) => r.rule_failures.length > 0),
    },
    rows,
  };
}
