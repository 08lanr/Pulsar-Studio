// Plan, vision and review (plan B2, stages 3–5).
//
// Plan: `pick_cuts.py --emit-options review/options.json` (with `--pin-from`
// the newest DELIVERED file when the film has one), the option strips
// (`boundary_frames.py --options … --window 5 --step 0.5 --cols 6`), then
// `--verify`, whose NOT READY is a refusal shown verbatim. An options file
// already applied is resumed only with THIS run's record files beside it;
// one whose boundaries were all delivered (a first proof) is re-emitted for
// the stretch past the pins when the run plans further; one stamped by an
// earlier Studio run of the same folder that is over (cancelled at its
// review, say) is re-emitted too, since Studio judged it and that run can
// never resume; a film delivered to its end has nothing to extend; anything
// else was judged outside Studio and is refused, naming the stamp.
//
// Vision: the API pass (lib/segment/vision.ts, decision 4) or the Claude
// Code hand-off — the exact Workflow call is shown and the run waits for
// its `.output` file — then `apply_vision.py --from <records> --label <run>`.
// A FAIL from apply_vision (a reviewer that refused, a skeptic dispute with
// no fix) is not fatal here: those boundaries are exactly what the review
// waits for.
//
// Review: every boundary below CONFIDENCE_GATE, with a skeptic override or
// with a fault needs a person (accept, move, reject → re-judge); the rest are
// pre-accepted but shown. A boundary the person rejected stays theirs: after
// its re-judge it needs their accept or move whatever the second answer's
// confidence, so a rejection is never closed by the model alone (decision
// 5; the calibration has the model confidently disagreeing with the recorded
// pass on 16 of 20 times). Applying writes ONE override file in the Workflow
// output shape (reviewer "ruobin") into review/vision and runs
// `apply_vision.py --from <every record file of the run> --from <override>`,
// so the pipeline's audit trail and refusals still apply and Studio never
// hand-edits choices.json. Then `pick_cuts.py --choices … --dry-run` proves
// the plan is in band; a band refusal is handed to the band-fix judge once
// (lib/segment/vision.ts judgeBandFix) and otherwise waits for moves.

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dramaRemixRoot } from "@/lib/python";
import type { FilmRunDecision, Json } from "@/lib/types";
import { findBandConflicts, type FirstPassRecord } from "@/lib/prompts/band-fix";
import { loadCandidates, loadOptionsDoc, legalCutsNear, verifyOptions, type OptionsDoc } from "@/lib/segment/strips";
import { UNVERIFIED_OUTCOMES, WorkflowOutputSchema, appliedTimeOf, isUnavailable, mergeVisionPasses, readGuard, type WorkflowRecord } from "@/lib/segment/vision";
import {
  CONFIDENCE_GATE,
  DECISION,
  SRC_ARG,
  bandArgs,
  decisionData,
  fail,
  fileExists,
  handoffCommand,
  isTerminal,
  newestDelivered,
  next,
  pendingDecision,
  pendingDecisions,
  planDuration,
  readJson,
  refusalOf,
  runStep,
  snapshotReview,
  sourceRefOf,
  tailLines,
  visionLabel,
  wait,
  withHeartbeat,
  type StageContext,
  type StageDetail,
  type StageOutcome,
} from "./stages";

// ---- the run's vision files ------------------------------------------------------------------------------------

export type VisionFile = { file: string; name: string; role: "pass" | "rejudge" | "review" | "band_fix" | "handoff"; mtime: number };

/**
 * The record files this run wrote under review/vision, oldest first (the
 * order `apply_vision.py --from … --from …` takes: the later file wins per
 * boundary): `<label>.json` (the pass), `<label>_r<n>.json` (re-judges),
 * `<label>_review<n>.json` (the person's overrides), `<label>_band-fix*.json`.
 */
export function listRunVisionFiles(cutDir: string, label: string): VisionFile[] {
  const dir = path.join(cutDir, "review", "vision");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: VisionFile[] = [];
  for (const name of names) {
    if (!name.startsWith(label) || !name.toLowerCase().endsWith(".json")) continue;
    const rest = name.slice(label.length, -5);
    let role: VisionFile["role"];
    if (rest === "") role = "pass";
    else if (/^_r\d+$/.test(rest)) role = "rejudge";
    else if (/^_review\d+$/.test(rest)) role = "review";
    else if (/^_band-fix(\d+)?$/.test(rest)) role = "band_fix";
    else if (rest === "_handoff") role = "handoff";
    else continue;
    const file = path.join(dir, name);
    out.push({ file, name, role, mtime: statSync(file).mtimeMs });
  }
  return out.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
}

/** The records of every run file, in apply order; a file that does not parse is skipped with a note. */
export function loadRunRecords(files: VisionFile[]): { passes: WorkflowRecord[][]; problems: string[] } {
  const passes: WorkflowRecord[][] = [];
  const problems: string[] = [];
  for (const f of files) {
    const raw = readJson(f.file);
    const parsed = WorkflowOutputSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`${f.name}: not a Workflow output (${parsed.error.issues[0]?.message ?? "invalid"})`);
      continue;
    }
    passes.push(parsed.data.result);
  }
  return { passes, problems };
}

// ---- the review state ----------------------------------------------------------------------------------------------

/**
 * `rejudged`: the person rejected the boundary and its re-judge has run; their accept or move closes it, not the new confidence.
 * `skeptic_unverified`: the skeptic named a fix the guard refused (a time it never saw, a band break, a card, an illegal cut) or
 * nobody could tie-break; the reviewer's pick is written and a person decides (decision 2026-09-23, "The frame judge, second pass").
 */
export type ReviewReason = "low_confidence" | "skeptic_override" | "fault" | "no_record" | "rejudged" | "skeptic_unverified";
export type BoundaryStatus = "pre_accepted" | "needs_decision" | "decided" | "rejudging";

export type BoundaryReview = {
  boundary_s: number;
  dp_pick: number | null;
  /** The newest record for the boundary (a re-judge replaces the pass's). */
  record: WorkflowRecord | null;
  /** apply_vision's answer for that record; null on a fault. */
  applied_t: number | null;
  applied_source: "reviewer" | "SKEPTIC OVERRIDE" | null;
  fault: string | null;
  reasons: ReviewReason[];
  /** The newest accept / move on the boundary since its last re-judge. */
  decision: FilmRunDecision | null;
  /** Re-judges asked for, and how many the worker has run. */
  rejudges_asked: number;
  rejudges_done: number;
  status: BoundaryStatus;
  /** Where the boundary stands now: the decision's time, else the applied time, else the reviewer's pick, else the DP's. */
  current_t: number;
  confidence: number | null;
};

export type ReviewState = {
  band: [number, number];
  duration: number;
  boundaries: BoundaryReview[];
  needs_decision: number;
  decided: number;
  pre_accepted: number;
  rejudging: number;
  /** Every boundary that needs one has a decision and no re-judge is outstanding. */
  complete: boolean;
  missing: number[];
  /** Episode lengths between the fixed start, the current boundary times and the duration. */
  lengths: { from: number; to: number; length: number; in_band: boolean }[];
};

const keyOf = (t: number) => Math.round(t * 1000);

/**
 * The state of the review, pure: the options document, the run's record
 * files (in apply order) and the run's decisions in. `rejudgesDone` says
 * how many re-judges the worker has run per boundary (stage_detail), so a
 * boundary with a `rejudge` recorded and not yet run reads `rejudging`.
 */
export function reviewState(doc: OptionsDoc, passes: WorkflowRecord[][], decisions: FilmRunDecision[], rejudgesDone: Record<string, number> = {}, opts: { fixedStart?: number } = {}): ReviewState {
  const merged = new Map(mergeVisionPasses(passes.filter((p, i) => i < passes.length)).map((r) => [keyOf(r.boundary_s), r]));
  const boundaries: BoundaryReview[] = doc.boundaries.map((b) => {
    const k = keyOf(b.boundary_s);
    const record = merged.get(k) ?? null;
    const asked = decisions.filter((d) => d.action === DECISION.rejudge && d.boundary_s !== null && keyOf(d.boundary_s) === k).length;
    const done = rejudgesDone[String(b.boundary_s)] ?? 0;
    // Decisions before the newest re-judge no longer count: the boundary was sent back.
    const lastRejudgeAt = decisions.filter((d) => d.action === DECISION.rejudge && d.boundary_s !== null && keyOf(d.boundary_s) === k).map((d) => d.at).sort().pop() ?? "";
    const own = decisions.filter((d) => (d.action === DECISION.accept || d.action === DECISION.move) && d.boundary_s !== null && keyOf(d.boundary_s) === k && d.at >= lastRejudgeAt);
    const decision = own.length ? own[own.length - 1] : null;
    const applied = record ? appliedTimeOf(record) : null;
    const reasons: ReviewReason[] = [];
    if (!record) reasons.push("no_record");
    else {
      if (applied && applied.t === null) reasons.push("fault");
      if ((record.pick.confidence ?? 0) < CONFIDENCE_GATE) reasons.push("low_confidence");
      if (record.verdict && record.verdict.agree === false && record.verdict.better_t) reasons.push("skeptic_override");
      const guard = readGuard(record.verdict);
      if (guard && UNVERIFIED_OUTCOMES.includes(guard.outcome)) reasons.push("skeptic_unverified");
    }
    // A re-judge the person asked for is theirs to close: the second answer, however sure, is shown, not applied unread.
    if (asked > 0 && done >= asked) reasons.push("rejudged");
    let status: BoundaryStatus;
    if (asked > done) status = "rejudging";
    else if (decision) status = "decided";
    else if (reasons.length) status = "needs_decision";
    else status = "pre_accepted";
    const appliedT = applied && applied.t !== null ? applied.t : null;
    const current = decision?.action === DECISION.move && typeof decision.to_s === "number" ? decision.to_s : appliedT ?? record?.pick.chosen_t ?? b.dp_pick ?? b.boundary_s;
    return {
      boundary_s: b.boundary_s,
      dp_pick: b.dp_pick ?? null,
      record,
      applied_t: appliedT,
      applied_source: applied && applied.t !== null ? applied.source : null,
      fault: applied && applied.t === null ? applied.fault : null,
      reasons,
      decision,
      rejudges_asked: asked,
      rejudges_done: done,
      status,
      current_t: current,
      confidence: record?.pick.confidence ?? null,
    };
  });
  const [lo, hi] = doc.band;
  const points = [opts.fixedStart ?? 0, ...boundaries.map((b) => b.current_t).sort((a, b) => a - b), doc.duration];
  const lengths = points.slice(1).map((to, i) => {
    const from = points[i];
    const length = Math.round((to - from) * 1000) / 1000;
    return { from, to, length, in_band: length >= lo && length <= hi };
  });
  const needs = boundaries.filter((b) => b.status === "needs_decision");
  const rejudging = boundaries.filter((b) => b.status === "rejudging");
  return {
    band: doc.band,
    duration: doc.duration,
    boundaries,
    needs_decision: needs.length,
    decided: boundaries.filter((b) => b.status === "decided").length,
    pre_accepted: boundaries.filter((b) => b.status === "pre_accepted").length,
    rejudging: rejudging.length,
    complete: needs.length === 0 && rejudging.length === 0 && boundaries.every((b) => b.status !== "needs_decision" && !(b.status === "pre_accepted" && b.applied_t === null)),
    missing: [...needs, ...rejudging].map((b) => b.boundary_s).sort((a, b) => a - b),
    lengths,
  };
}

/** The lengths of the two episodes a boundary at `t` would make, given the current times of the others (pure; the move check). */
export function lengthsAround(state: Pick<ReviewState, "boundaries" | "duration">, boundaryS: number, t: number, fixedStart = 0): { before: number; after: number } {
  const others = state.boundaries.filter((b) => keyOf(b.boundary_s) !== keyOf(boundaryS)).map((b) => b.current_t);
  const points = [fixedStart, ...others, state.duration].sort((a, b) => a - b);
  const prev = Math.max(...points.filter((p) => p < t), fixedStart);
  const nxt = Math.min(...points.filter((p) => p > t), state.duration);
  return { before: Math.round((t - prev) * 1000) / 1000, after: Math.round((nxt - t) * 1000) / 1000 };
}

/** The file the run's pinned boundaries come from and the pinned times (every delivered end but the free final one). */
export function pinsOf(cutDir: string): { file: string | null; pins: number[]; fixedStart: number } {
  const newest = newestDelivered(cutDir);
  if (!newest) return { file: null, pins: [], fixedStart: 0 };
  const plan = readJson<{ episodes?: { end: number }[]; final_end_is_boundary?: boolean }>(path.join(cutDir, "review", newest.file));
  const eps = plan?.episodes ?? [];
  const pinned = plan?.final_end_is_boundary ? eps : eps.slice(0, -1);
  const pins = pinned.map((e) => e.end);
  return { file: newest.file, pins, fixedStart: pins.length ? Math.max(...pins) : 0 };
}

// ---- the override file -----------------------------------------------------------------------------------------------

export const REVIEWER = "ruobin";

/**
 * The Workflow-shaped record a human decision becomes (apply_vision.py reads
 * `pick.chosen_t` and `verdict.agree`). The record describes the time it
 * applies: an accept of a skeptic override carries the skeptic's key and
 * reason, not the reviewer's; the reviewer's ends_on / opens_on are copied
 * only when the time is still the reviewer's own pick.
 */
export function overrideRecord(b: BoundaryReview, decision: FilmRunDecision): WorkflowRecord {
  const pick = b.record?.pick ?? null;
  const verdict = b.record?.verdict ?? null;
  const moved = decision.action === DECISION.move && typeof decision.to_s === "number";
  const t = moved ? (decision.to_s as number) : b.applied_t ?? pick?.chosen_t ?? b.boundary_s;
  const skeptics = !moved && b.applied_source === "SKEPTIC OVERRIDE" && !!verdict;
  // The reviewer's frame description holds only for the reviewer's own time (an accept of it, or a move back to it).
  const reviewers = !skeptics && pick !== null && Math.abs(pick.chosen_t - t) <= 0.0015;
  const note = decision.why ? `: ${decision.why}` : "";
  const why = moved ? `moved by ${REVIEWER} to ${t}s${note}` : skeptics ? `accepted by ${REVIEWER} at ${t}s, the skeptic's time (${verdict.reason})${note}` : `accepted by ${REVIEWER} at ${t}s${note}`;
  return {
    boundary_s: b.boundary_s,
    pick: {
      chosen_key: moved ? "review" : skeptics ? verdict.better_key || "review" : pick?.chosen_key ?? "review",
      chosen_t: t,
      ends_on: reviewers ? pick.ends_on : "",
      opens_on: reviewers ? pick.opens_on : "",
      why,
      payoff_in_episode: pick?.payoff_in_episode ?? true,
      confidence: 1,
    },
    verdict: { agree: true, fault: "", better_key: "", reason: `human decision (${decision.action}) on ${decision.at}` },
  };
}

/** Write `<cut>/review/vision/<label>_review<n>.json` with one record per decided boundary; returns the file. */
export function writeOverrideFile(cutDir: string, label: string, runId: string, state: ReviewState): string {
  const dir = path.join(cutDir, "review", "vision");
  const n = listRunVisionFiles(cutDir, label).filter((f) => f.role === "review").length + 1;
  const file = path.join(dir, `${label}_review${n}.json`);
  const result = state.boundaries.filter((b) => b.decision).map((b) => overrideRecord(b, b.decision!));
  const out = {
    summary: "Human review of the boundaries the vision pass left below the confidence gate, with a skeptic override or a fault",
    source: "pulsar-studio-review",
    reviewer: REVIEWER,
    run_id: runId,
    label,
    logs: [`${result.length} boundaries decided by ${REVIEWER}`],
    result,
    totalTokens: 0,
  };
  WorkflowOutputSchema.parse(out);
  writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`, "utf8");
  return file;
}

// ---- the plan stage --------------------------------------------------------------------------------------------------

const STRIP_ARGS = ["--window", "5", "--step", "0.5", "--cols", "6", "--width", "200", "--out-dir", "review/frames"];

/**
 * Why an APPLIED options file is not this run's stretch, or null when it is
 * still in the way: every boundary it lists lies at or under the newest
 * delivered file's pinned end (its stretch was rendered) and the run plans
 * past that end (an extension of a first proof). Pure.
 */
export function staleOptionsReason(doc: { boundaries: { boundary_s: number }[]; duration: number }, pin: { file: string; end: number } | null, planTo: number | null): string | null {
  if (!pin) return null;
  const end = planTo ?? doc.duration;
  if (!(end > pin.end + 0.05)) return null;
  const beyond = doc.boundaries.filter((b) => b.boundary_s > pin.end + 0.05);
  if (beyond.length) return null;
  return `${doc.boundaries.length} boundaries, all at or under ${pin.end} s of ${pin.file}`;
}

/**
 * The Studio run label an applied options file is stamped with, or null when
 * the stamp is not Studio's. apply_vision.py writes `--label` as given:
 * `studio-<8 hex>` after the pass, `studio-<8 hex>-review` / `-band` after
 * the review's apply, so the run's own label is the first token. Pure.
 */
export function appliedRunLabel(doc: Pick<OptionsDoc, "applied">): string | null {
  const label = doc.applied?.label;
  const m = typeof label === "string" ? /^(studio-[0-9a-f]{8})(?:-review|-band)?$/.exec(label) : null;
  return m ? m[1] : null;
}

/** The film is delivered up to `pin.end` and the run plans no further: nothing to extend. Pure. */
export function deliveredToEnd(pin: { end: number } | null, planTo: number | null): boolean {
  return !!pin && planTo !== null && planTo <= pin.end + 0.05;
}

/** An earlier run of this film folder (same company, bucket and slug) whose label stamped the options, or null. */
async function earlierRunByLabel(ctx: Pick<StageContext, "run" | "data" | "session">, label: string): Promise<StageContext["run"] | null> {
  const runs = await ctx.data.listFilmRuns(ctx.session, { producerId: ctx.run.producer_id });
  return runs.find((r) => r.id !== ctx.run.id && r.bucket === ctx.run.bucket && r.slug === ctx.run.slug && visionLabel(r) === label) ?? null;
}

async function optionsState(cutDir: string): Promise<{ doc: OptionsDoc | null; applied: boolean; problem: string | null }> {
  if (!fileExists(path.join(cutDir, "review", "options.json"))) return { doc: null, applied: false, problem: null };
  try {
    const doc = await loadOptionsDoc(cutDir);
    return { doc, applied: !!doc.applied, problem: null };
  } catch (e) {
    return { doc: null, applied: false, problem: (e as Error).message };
  }
}

export async function runPlanStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const duration = planDuration(run, dirs.cut);
  const pin = newestDelivered(dirs.cut);
  const common = [...(duration ? ["--duration", String(duration)] : []), ...(pin ? ["--pin-from", pin.arg] : []), ...bandArgs(run)];

  const before = await optionsState(dirs.cut);
  if (before.problem) return fail(`review/options.json: ${before.problem}`);
  let fresh = false;
  if (before.applied && before.doc) {
    // An applied options file WITH this run's own records: the plan was made in an earlier life of this run; go on to the review.
    // A foreign choices.json alone is not this run's: its review would move, re-judge and apply inside a film Studio never judged.
    if (listRunVisionFiles(dirs.cut, visionLabel(run)).length) return next("review", { note: "review/options.json is already applied by this run: resuming at the review" });
    const planTo = duration ?? before.doc.duration;
    const stamp = `${before.doc.applied?.label ?? "?"} on ${before.doc.applied?.on ?? "?"}`;
    // The applied options belong to a stretch a render delivered (every boundary at or under its pins) and this run plans
    // further: an extension. pick_cuts emits fresh options for the new stretch under --pin-from (the file is rewritten).
    const stale = staleOptionsReason(before.doc, pin, duration);
    if (stale) {
      ctx.log(`review/options.json is applied for the delivered stretch (${stale}): fresh options for ${pin?.end ?? 0}–${duration ?? "end"} s`);
      fresh = true;
    } else if (deliveredToEnd(pin, planTo)) {
      return fail(`${sourceRefOf(run)} is delivered to its end (${pin!.file} ends at ${pin!.end} s; this run plans to ${planTo} s): there is nothing to extend. The film can be imported as it is; a join is moved on the run that delivered it.`);
    } else {
      // The stamp is an earlier Studio run of this very folder, and that run is over (cancelled at its review, failed
      // after the pass): Studio judged the film, nobody can resume that run, and its choices were never rendered. This run
      // takes the stretch again with fresh options; the earlier run's record files stay under its own label.
      const label = appliedRunLabel(before.doc);
      const earlier = label ? await earlierRunByLabel(ctx, label) : null;
      if (earlier && !isTerminal(earlier.stage)) return fail(`review/options.json is stamped applied by run ${earlier.id} (${stamp}), which is still ${earlier.stage} on ${sourceRefOf(run)}: cancel it first`);
      if (!earlier) return fail(`review/options.json is stamped applied (${stamp}) and this run has no records for it: the film was judged outside Studio; emit fresh options for a new stretch (a session's work), or start a new run on a new slug`);
      ctx.log(`review/options.json was applied by run ${earlier.id} (${stamp}), now ${earlier.stage}: fresh options for this run`);
      fresh = true;
    }
  }
  if (!before.doc || fresh) {
    const args = [...common, "--emit-options", "review/options.json"];
    const r = await runStep(ctx, { script: "pick_cuts.py", args, what: "pick_cuts --emit-options", timeoutMs: 30 * 60 * 1000 });
    if (r.code !== 0) return fail(refusalOf({ script: "pick_cuts.py", args, what: "" }, r));
    await ctx.progress({ progress: { step: "options", tail: tailLines(r.stdoutTail, 8) } });
  } else {
    ctx.log("review/options.json exists and is not applied: pick_cuts skipped");
  }

  const mid = await optionsState(dirs.cut);
  if (!mid.doc) return fail(`review/options.json did not come out of pick_cuts.py: ${mid.problem ?? "missing"}`);
  if (mid.doc.strips_stale !== false) {
    const args = ["--src", SRC_ARG, "--options", "review/options.json", ...STRIP_ARGS];
    await ctx.progress({ progress: { step: "strips", of: mid.doc.boundaries.reduce((s, b) => s + b.options.length, 0) } });
    const r = await runStep(ctx, { script: "boundary_frames.py", args, what: "boundary_frames --options", timeoutMs: 2 * 60 * 60 * 1000 });
    if (r.code !== 0) return fail(refusalOf({ script: "boundary_frames.py", args, what: "" }, r));
  } else {
    ctx.log("strips are current: boundary_frames --options skipped");
  }

  const verify = await runStep(ctx, { script: "boundary_frames.py", args: ["--verify", "review/options.json"], what: "boundary_frames --verify", timeoutMs: 10 * 60 * 1000 });
  if (verify.code !== 0) return fail(refusalOf({ script: "boundary_frames.py", args: ["--verify"], what: "" }, verify));
  const doc = (await optionsState(dirs.cut)).doc;
  const boundaries = doc?.boundaries.map((b) => b.boundary_s) ?? [];
  return next("vision", { options: { boundaries: boundaries.length, options: doc?.boundaries.reduce((s, b) => s + b.options.length, 0) ?? 0, band: doc?.band ?? null, duration: doc?.duration ?? null, pin_from: pin?.arg ?? null }, verify_tail: tailLines(verify.stdoutTail, 4), progress: null });
}

// ---- the vision stage ------------------------------------------------------------------------------------------------

function filmNotes(run: StageContext["run"]): string | null {
  const v = run.settings.film_notes;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function handoffDetail(ctx: StageContext, doc: OptionsDoc, reason: string | null): StageDetail {
  const boundaries = doc.boundaries.map((b) => b.boundary_s);
  return {
    handoff: {
      command: handoffCommand(ctx.dirs.cut, boundaries, filmNotes(ctx.run), dramaRemixRoot(ctx.env)),
      boundaries,
      expects: "the Workflow task's .output file (its path in the handoff_vision decision)",
    },
    unavailable: reason,
  };
}

/** `apply_vision.py --from <each record file, oldest first> --label <label>`; a FAIL is answered as faults, any other exit as a refusal. */
async function applyVisionRecords(ctx: StageContext, label: string, extraLabel = ""): Promise<{ ok: true; tail: string[] } | { ok: false; faults: string[]; refusal: string }> {
  const files = listRunVisionFiles(ctx.dirs.cut, label);
  const args = files.flatMap((f) => ["--from", `review/vision/${f.name}`]);
  args.push("--label", `${label}${extraLabel}`);
  const r = await runStep(ctx, { script: "apply_vision.py", args, what: "apply_vision", timeoutMs: 10 * 60 * 1000 });
  if (r.code === 0) return { ok: true, tail: tailLines(r.stdoutTail, 12) };
  const out = r.stdoutTail.replace(/\r/g, "");
  const at = out.indexOf("FAIL - these boundaries have no usable answer");
  const faults = at >= 0 ? out.slice(at).split("\n").slice(1).map((l) => l.trim()).filter(Boolean) : [];
  return { ok: false, faults, refusal: refusalOf({ script: "apply_vision.py", args, what: "" }, r) };
}

export async function runVisionStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const label = visionLabel(run);
  const doc = await loadOptionsDoc(dirs.cut);
  const passFile = path.join(dirs.cut, "review", "vision", `${label}.json`);
  const handoff = pendingDecision(run, DECISION.handoff_vision);
  const handoffMode = run.settings.vision === "handoff" || (handoff !== null && !decisionData(handoff).output_path);

  // A pass file short of records (a call failed last time) is judged again as a whole: the done job rows are reused, only the failed calls are paid for.
  const passComplete = (() => {
    const parsed = WorkflowOutputSchema.safeParse(readJson(passFile));
    return parsed.success && parsed.data.result.length >= doc.boundaries.length;
  })();
  if (fileExists(passFile) && !passComplete) ctx.log(`review/vision/${label}.json is short of records: judging again (done rows are reused)`);

  if (!fileExists(passFile) || !passComplete) {
    if (handoff && typeof decisionData(handoff).output_path === "string") {
      // The Workflow finished: its .output file becomes the run's pass file.
      const src = String(decisionData(handoff).output_path).replace(/\//g, path.sep);
      const raw = readJson(src);
      const parsed = WorkflowOutputSchema.safeParse(raw);
      if (!parsed.success) return wait("vision", { ...handoffDetail(ctx, doc, null), handoff_error: `${src}: not a Workflow output (${parsed.error.issues[0]?.message ?? "invalid"})` });
      const listed = new Set(doc.boundaries.map((b) => keyOf(b.boundary_s)));
      const foreign = parsed.data.result.filter((r) => !listed.has(keyOf(r.boundary_s))).map((r) => r.boundary_s);
      if (foreign.length) return wait("vision", { ...handoffDetail(ctx, doc, null), handoff_error: `${src}: boundaries not in review/options.json: ${JSON.stringify(foreign.slice(0, 8))}` });
      mkdirSync(path.dirname(passFile), { recursive: true });
      writeFileSync(passFile, `${JSON.stringify({ ...parsed.data, source: "claude-code-handoff", run_id: run.id, label, handoff_output: src.replace(/\\/g, "/") }, null, 1)}\n`, "utf8");
      ctx.log(`hand-off output taken: ${src} → review/vision/${label}.json (${parsed.data.result.length} records)`);
    } else if (handoffMode) {
      return wait("vision", handoffDetail(ctx, doc, null));
    } else {
      await ctx.progress({ progress: { step: "judge", judged: 0, of: doc.boundaries.length } });
      // The lease is renewed while the pass runs: a long film's pass outlasts the ten-minute lease.
      const result = await withHeartbeat(ctx, () =>
        ctx.runner.judge({
          run: { id: run.id, cut_dir: dirs.cut, film_notes: filmNotes(run) },
          doc,
          work_dir: dirs.work,
          opts: {
            label,
            session: ctx.session,
            out_file: passFile,
            env: ctx.env as Record<string, string | undefined>,
            signal: ctx.signal,
            onBoundary: (record, done, total) => {
              void ctx.progress({ progress: { step: "judge", judged: done, of: total, last: record.boundary_s } }).catch(() => undefined);
            },
          },
        })
      );
      if (isUnavailable(result)) {
        ctx.log(`vision unavailable: ${result.unavailable}`);
        return wait("vision", handoffDetail(ctx, doc, result.unavailable));
      }
      ctx.log(`judged ${result.records.length} boundaries on ${result.provider} ${result.model}; ${result.errors.length} errors; ${result.cost_cents} cents`);
      if (result.errors.length) {
        // The done rows are reused: a retry pays only for what failed.
        return wait("vision", { ...handoffDetail(ctx, doc, null), errors: result.errors.map((e) => `${e.boundary_s}s: ${e.error}`), judged: result.records.length, cost_cents: result.cost_cents, note: "some boundaries failed; a retry decision re-runs only those, or hand the pass off" });
      }
      // The pass's summary is forced past the throttle: it came within a second of the last onBoundary write once and was lost.
      await ctx.progress({ progress: null, vision: { provider: result.provider, model: result.model, judged: result.records.length, cost_cents: result.cost_cents } }, { force: true });
    }
  } else {
    ctx.log(`review/vision/${label}.json exists: the pass is not repeated`);
  }

  const applied = await applyVisionRecords(ctx, label);
  const detail: StageDetail = { apply_faults: applied.ok ? [] : applied.faults, apply_tail: applied.ok ? applied.tail : null, progress: null };
  if (!applied.ok && !applied.faults.length) return fail(applied.refusal, detail);
  return next("review", detail);
}

// ---- the review stage -------------------------------------------------------------------------------------------------

/** What the stage and the view compute from disk plus the run: the review state with the run's own files, and the pinned start the lengths are measured from. */
export async function reviewStateOf(ctx: Pick<StageContext, "run" | "dirs">): Promise<{ doc: OptionsDoc; state: ReviewState; files: VisionFile[]; problems: string[]; fixedStart: number }> {
  const label = visionLabel(ctx.run);
  const doc = await loadOptionsDoc(ctx.dirs.cut);
  const files = listRunVisionFiles(ctx.dirs.cut, label);
  const { passes, problems } = loadRunRecords(files);
  const done = ((ctx.run.stage_detail as Record<string, unknown>).rejudges_done ?? {}) as Record<string, number>;
  const fixedStart = pinsOf(ctx.dirs.cut).fixedStart;
  const state = reviewState(doc, passes, ctx.run.decisions, done, { fixedStart });
  return { doc, state, files, problems, fixedStart };
}

/** A `move` is refused when its time is not a legal cut within 30 s or breaks the band on either side (pure over the state). */
export function moveRefusal(state: ReviewState, boundaryS: number, toT: number, legal: number[], fixedStart = 0): string | null {
  const b = state.boundaries.find((x) => keyOf(x.boundary_s) === keyOf(boundaryS));
  if (!b) return `boundary ${boundaryS} is not in review/options.json`;
  if (Math.abs(toT - boundaryS) > 30) return `${toT}s is more than 30 s from the boundary at ${boundaryS}s`;
  if (!legal.some((t) => Math.abs(t - toT) <= 0.0015)) return `${toT}s is not a legal cut in index/candidates.json (a shot change clear of words); pick a listed candidate`;
  const [lo, hi] = state.band;
  const { before, after } = lengthsAround(state, boundaryS, toT, fixedStart);
  if (before < lo || before > hi) return `moving to ${toT}s makes the episode before it ${before}s, outside the ${lo}–${hi}s band`;
  if (after < lo || after > hi) return `moving to ${toT}s makes the episode after it ${after}s, outside the ${lo}–${hi}s band`;
  return null;
}

const BAND_REFUSAL = /outside the .*band/i;

export async function runReviewStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const label = visionLabel(run);
  const { doc, state, problems } = await reviewStateOf(ctx);
  const detailBase: StageDetail = { review: reviewSummary(state), problems };

  // Re-judges asked for since the last look: run them (the API or the fake), one file per round.
  const rejudge = pendingDecisions(run).filter((d) => d.action === DECISION.rejudge && d.boundary_s !== null);
  const outstanding = state.boundaries.filter((b) => b.status === "rejudging").map((b) => b.boundary_s);
  if (outstanding.length) {
    const round = listRunVisionFiles(dirs.cut, label).filter((f) => f.role === "rejudge").length + 1;
    const attempt = round + 1;
    const why = rejudge.map((d) => `${d.boundary_s}s: ${d.why ?? "rejected"}`);
    await ctx.progress({ progress: { step: "rejudge", boundaries: outstanding } });
    const result = await withHeartbeat(ctx, () =>
      ctx.runner.judge({
        run: { id: run.id, cut_dir: dirs.cut, film_notes: [filmNotes(run), why.length ? `A person rejected the earlier answer: ${why.join("; ")}` : null].filter(Boolean).join("\n") || null },
        doc,
        // The run's work dir: the skeptic's dense strip for the re-judge lands beside the pass's, never in the OS temp dir.
        work_dir: dirs.work,
        opts: { label, session: ctx.session, boundaries: outstanding, attempt, out_file: path.join(dirs.cut, "review", "vision", `${label}_r${round}.json`), allow_applied: true, env: ctx.env as Record<string, string | undefined>, signal: ctx.signal },
      })
    );
    if (isUnavailable(result)) return wait("review", { ...detailBase, ...handoffDetail(ctx, doc, result.unavailable), note: "re-judge needs a vision provider; move or accept the boundary instead, or hand the pass off" });
    const done = { ...(((run.stage_detail as Record<string, unknown>).rejudges_done ?? {}) as Record<string, number>) };
    for (const b of outstanding) if (!result.errors.some((e) => keyOf(e.boundary_s) === keyOf(b))) done[String(b)] = (done[String(b)] ?? 0) + 1;
    const after = await reviewStateOf({ run: { ...run, stage_detail: { ...(run.stage_detail as Record<string, Json>), rejudges_done: done } }, dirs });
    return wait("review", { ...detailBase, review: reviewSummary(after.state), rejudges_done: done, rejudge_errors: result.errors.map((e) => `${e.boundary_s}s: ${e.error}`), progress: null });
  }

  const apply = pendingDecision(run, DECISION.apply_review);
  if (!apply) return wait("review", detailBase);
  if (!state.complete) return wait("review", { ...detailBase, apply_refused: `${state.missing.length} boundaries still need a decision: ${JSON.stringify(state.missing.slice(0, 12))}` });

  // Apply: snapshot, the override file, apply_vision over every record file of the run, then the band proof.
  snapshotReview(ctx, "review");
  const override = writeOverrideFile(dirs.cut, label, run.id, state);
  ctx.log(`override file: ${path.basename(override)} (${state.decided} decisions by ${REVIEWER})`);
  const applied = await applyVisionRecords(ctx, label, "-review");
  if (!applied.ok) return wait("review", { ...detailBase, apply_faults: applied.faults, apply_refused: applied.refusal });

  const bandCheck = await dryRunChoices(ctx);
  if (bandCheck.ok) return next("render", { ...detailBase, apply_tail: applied.tail, band: null, dry_run: bandCheck.tail });
  if (!BAND_REFUSAL.test(bandCheck.refusal)) return fail(bandCheck.refusal, detailBase);

  // Two right choices broke the band between them (README, "When two good choices break the band"): one band-fix round by the judge.
  const choices = readJson<Record<string, number>>(path.join(dirs.cut, "review", "choices.json")) ?? {};
  const pins = pinsOf(dirs.cut);
  const files = listRunVisionFiles(dirs.cut, label);
  const { passes } = loadRunRecords(files.filter((f) => f.role !== "review"));
  const groups = findBandConflicts({ doc, choices, pins: pins.pins, records: mergeVisionPasses(passes) as unknown as FirstPassRecord[] });
  const already = files.some((f) => f.role === "band_fix" && f.mtime > (files.find((x) => x.role === "review")?.mtime ?? 0));
  if (groups.length && !already) {
    const fix = await withHeartbeat(ctx, () => ctx.runner.bandFix({ run: { id: run.id, cut_dir: dirs.cut, film_notes: filmNotes(run) }, doc, groups, label, session: ctx.session, work_dir: dirs.work, signal: ctx.signal }));
    if (!isUnavailable(fix)) {
      ctx.log(`band fix: ${fix.groups.length} groups, ${fix.faults.length} faults, ${fix.cost_cents} cents`);
      const reapplied = await applyVisionRecords(ctx, label, "-band");
      if (reapplied.ok) {
        const again = await dryRunChoices(ctx);
        if (again.ok) return next("render", { ...detailBase, band: { fixed_by: "band_fix", groups: groups.map((g) => g.label) }, dry_run: again.tail });
        return wait("review", { ...detailBase, band: { refusal: again.refusal, groups: groupsJson(groups), fixed_by: null }, note: "the band fix did not resolve it: move a boundary of the group and apply again" });
      }
      return wait("review", { ...detailBase, band: { refusal: bandCheck.refusal, groups: groupsJson(groups), fixed_by: null }, apply_faults: reapplied.faults });
    }
    return wait("review", { ...detailBase, band: { refusal: bandCheck.refusal, groups: groupsJson(groups), fixed_by: null, unavailable: fix.unavailable } });
  }
  return wait("review", { ...detailBase, band: { refusal: bandCheck.refusal, groups: groupsJson(groups), fixed_by: null } });
}

function groupsJson(groups: ReturnType<typeof findBandConflicts>): Json {
  return groups.map((g) => ({ label: g.label, episodes_out_of_band: g.episodes_out_of_band, fixed_before: g.fixed_before, fixed_after: g.fixed_after, boundaries: g.boundaries.map((b) => ({ key: b.key, applied: b.applied, options: b.options })) })) as unknown as Json;
}

/** `pick_cuts.py … --choices review/choices.json --dry-run`: the plan is in band, or the refusal. Writes work/dry-run.json, never cuts.json. */
export async function dryRunChoices(ctx: StageContext): Promise<{ ok: true; tail: string[] } | { ok: false; refusal: string }> {
  const duration = planDuration(ctx.run, ctx.dirs.cut);
  const pin = newestDelivered(ctx.dirs.cut);
  const args = [...(duration ? ["--duration", String(duration)] : []), ...(pin ? ["--pin-from", pin.arg] : []), ...bandArgs(ctx.run), "--choices", "review/choices.json", "--dry-run"];
  const r = await runStep(ctx, { script: "pick_cuts.py", args, what: "pick_cuts --choices --dry-run", timeoutMs: 30 * 60 * 1000 });
  if (r.code === 0) return { ok: true, tail: tailLines(r.stdoutTail, 6) };
  return { ok: false, refusal: refusalOf({ script: "pick_cuts.py", args, what: "" }, r) };
}

export function reviewSummary(state: ReviewState): Json {
  return {
    needs_decision: state.needs_decision,
    decided: state.decided,
    pre_accepted: state.pre_accepted,
    rejudging: state.rejudging,
    complete: state.complete,
    missing: state.missing,
    out_of_band: state.lengths.filter((l) => !l.in_band).map((l) => ({ from: l.from, to: l.to, length: l.length })),
  };
}

/** The legal cuts near a boundary, as times (the move check's list). */
export async function legalTimesNear(cutDir: string, t: number): Promise<number[]> {
  const candidates = await loadCandidates(cutDir);
  return legalCutsNear(candidates, t).map((c) => c.t);
}

export { verifyOptions };
