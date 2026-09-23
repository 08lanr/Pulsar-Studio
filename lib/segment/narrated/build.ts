// The build, the final watch, and the episode scheduler that drives both
// lanes of every episode (narrated spec N1 E7–E8 and stage 6,
// `episode_work`).
//
// E7 build — when the words lane is ready (frames and joins status 0) and the
// picture lane is ready, and ep(N-1) exists with a shipped variant
// (continuity.py passes silently when ep(N-1) is missing, ST/continuity.py:
// 46-50, so Studio refuses to build N before N-1 has shipped — a Studio
// episode of this run, or the prior project's through its junction). Under
// the heavy lock: `bash scripts/build_ep.sh N v<next>`, always a fresh K
// (assemble_v rewrites a variant in place with no .part). Its stop lines are
// the refusal, verbatim; its five Jev scripts are one `jev_check` row. The
// gate's counts and the two files' SHA-256 go on the row.
//
// E8 final watch ✋ — a 480p proxy of the shipped file in the run's work
// folder, the gate report, USER-REVIEW.md and the transcript; approve ships
// it (`approved_by/at`), send back names a stage, drop takes the episode out
// (only the last open one of the plan: the numbers must run on). A build
// that stops on PICTURE IS STALE sends the episode back to its lanes with
// the picture lane to run again (a Retry would stop the same way).
//
// The scheduler runs the lanes concurrently, as practice did (the GPU queue
// cleaned ep9 while ep11 was being prepped): per pass it lists the episodes,
// picks each lane's next step, and starts it when its class has room — ONE
// writing session (the machine lock in lib/claude-session.ts holds it
// machine-wide too), ONE heavy step (the heavy lock serialises the machine;
// one here keeps a second from blocking a slot while it waits), ONE voice
// render (tts_narration.py rewrites the film's tts_ledger.json, and the
// budget check must see the render before it), two light ones. Each step claims its episode row (CAS + lease, renewed while it
// runs), writes what it found, and lets go. A lane waiting for a person does
// not run again until a decision about that episode wakes it; the run waits
// (`episode_work`) when nothing can move, and moves on to film_meta when
// every episode is shipped or dropped.

import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { ffmpegBin } from "@/lib/clips/cut";
import type { RunEpisodeStageInput } from "@/lib/data";
import { runProcess } from "@/lib/python";
import type { FilmRun, FilmRunEpisode, Json } from "@/lib/types";
import { RunCancelled, fail, next, tailLines, withHeartbeat, withHeavyLock, type StageOutcome } from "../stages";
import { gateMarkdown, readGate } from "./gate";
import { runPictureStep, runReframeGlanceStep } from "./gpu";
import { runFramesStep, runJoinsStep } from "./narration";
import { prepAutoRetry, runPrepReviewStep, runPrepStep } from "./prep";
import {
  dataOf,
  EPISODE_WAKES,
  epDir,
  fileSha256,
  hasShippedVariant,
  JEV_SCRIPTS,
  lastScriptOf,
  NARRATED_DECISION,
  narratedRefusal,
  narratedWait,
  newestVariant,
  pendingEpisodeDecision,
  prepApprovalOf,
  runFilmStep,
  type EpisodePatch,
  type EpisodeStepOutcome,
  type EpisodeWaitFor,
  type NarratedContext,
} from "./stages";
import { runVoiceStep } from "./voice";

// ---- E7 -------------------------------------------------------------------------------------------------------------

/** Why episode N may not build yet because of N-1, or null (the ordering rule). */
export function orderingRefusal(ep: Pick<FilmRunEpisode, "n">, episodes: Pick<FilmRunEpisode, "n" | "stage">[], film: string): string | null {
  const prev = ep.n - 1;
  if (prev < 1) return null;
  const row = episodes.find((e) => e.n === prev);
  if (row) {
    if (row.stage === "shipped") return null;
    return `ep${ep.n} builds after ep${prev} has shipped (continuity.py passes silently when the episode before is missing); ep${prev} is ${row.stage}`;
  }
  if (hasShippedVariant(path.join(film, epDir(prev)), prev)) return null;
  return `ep${ep.n} builds after ep${prev} exists with a shipped variant, and ${epDir(prev)} (the prior project's, through its junction) has none`;
}

/** The scripts build_ep.sh runs, in its order: what a bare `|| exit 1` stopped on is the last of these the log shows. */
export const BUILD_SCRIPTS = ["make_ep.py", "stale_check.py", "dropped_lines.py", "transcript.py", "text_changes.py", "continuity.py", "ledger_check.py", "narr_lint.py", "scene_audit.py", "frame_claims.py", "cut_joins.py", "narr_verify.py", "assemble_v.py", "gate.py", "preflight.py", "checklist.py", "make_intro.py"] as const;

export async function runBuildStep(ctx: NarratedContext, ep: FilmRunEpisode, all: FilmRunEpisode[]): Promise<EpisodeStepOutcome> {
  const d = ep.stage_detail as Record<string, Json | undefined>;
  if (ep.words_stage !== "ready" || ep.picture_stage !== "ready") return { kind: "moved", patch: { stage: "lanes" }, note: `ep${ep.n} is not ready to build (words ${ep.words_stage}, picture ${ep.picture_stage})` };
  const order = orderingRefusal(ep, all, ctx.paths.film);
  if (order) return { kind: "wait", for: "order", patch: { stage_detail: { ...d, order } } };
  const epFolder = path.join(ctx.paths.film, epDir(ep.n));
  const k = (newestVariant(epFolder)?.k ?? 0) + 1;
  const variant = `v${k}`;
  return withHeavyLock(ctx, `build ep${ep.n} ${variant}`, async () => {
    const lines: string[] = [];
    const job = await ctx.data.recordJob(ctx.session, {
      kind: "jev_check",
      title_id: null,
      target_type: "film_run",
      target_id: ctx.run.id,
      idempotency_key: `jev:${ctx.run.id}:${ep.n}:build_ep:${variant}:${Date.now()}`,
      input: { via: "build_ep.sh", ep: ep.n, variant, scripts: [...JEV_SCRIPTS], metered: false } as Json,
    });
    const started = Date.now();
    const r = await runFilmStep(ctx, { script: "build_ep.sh", args: [String(ep.n), variant], what: `build ep${ep.n} ${variant}`, interpreter: "bash", keys: ["TYPESAFE_API_KEY"], timeoutMs: 60 * 60 * 1000, onLine: (_s, line) => lines.push(line) });
    await ctx.data.finishJob(ctx.session, job.id, { status: "done", cost_cents: null, output: { exit: r.code, unmetered: true } as Json }).catch(() => undefined);
    const variantDir = path.join(epFolder, "variants", variant);
    const gate = readGate(variantDir, ep.n);
    const text_changes = lines.filter((l) => /text_changes|changed|→/.test(l)).slice(0, 80);
    const buildDetail = { variant, exit: r.code, seconds: Math.round((Date.now() - started) / 1000), gate: gate?.counts ?? null, tail: tailLines(lines.join("\n"), 40), text_changes };
    if (r.code !== 0) {
      const last = lastScriptOf(lines, BUILD_SCRIPTS);
      const said = lines.length ? lines : r.stdoutTail.split(/\r?\n/);
      const refusal = narratedRefusal({ script: "build_ep.sh" }, { ...r, stdoutTail: said.slice(-200).join("\n") }, last);
      if (said.some((l) => /^PICTURE IS STALE/.test(l.trim()))) {
        // Not a refusal a Retry cures: the cleaned picture is older than the cut (a re-prep re-cut base.mp4, a cue fix),
        // so the episode goes back to its lanes with the picture lane to run again, then builds.
        return {
          kind: "moved",
          patch: { stage: "lanes", picture_stage: "stale", error_text: null, stage_detail: { ...d, build: buildDetail as unknown as Json, stale: { found_after: `build ${variant}`, refusal } as unknown as Json } },
          note: `ep${ep.n}: build_ep.sh says the picture is stale; the picture lane runs again before the build`,
        };
      }
      return { kind: "refused", error: refusal, patch: { variant: existsSync(variantDir) ? variant : ep.variant, gate: gate?.counts ?? null, stage_detail: { ...d, build: buildDetail as unknown as Json } } };
    }
    const shipped = path.join(variantDir, `ep${ep.n}.mp4`);
    const body = existsSync(path.join(variantDir, "body.mp4")) ? path.join(variantDir, "body.mp4") : shipped;
    if (!gate || gate.counts.FAIL !== 0 || !existsSync(shipped)) {
      return { kind: "refused", error: `build_ep.sh exited 0 but ${epDir(ep.n)}/variants/${variant} has ${gate ? `a gate with FAIL ${gate.counts.FAIL}` : "no gate report"}${existsSync(shipped) ? "" : " and no shipped file"}`, patch: { variant, stage_detail: { ...d, build: buildDetail as unknown as Json } } };
    }
    return {
      kind: "moved",
      patch: {
        stage: "ep_review",
        variant,
        gate: gate.counts,
        body_sha256: fileSha256(body),
        shipped_sha256: fileSha256(shipped),
        error_text: null,
        stage_detail: { ...d, build: { ...buildDetail, intro: existsSync(path.join(variantDir, "intro.mp4")) } as unknown as Json },
      },
      note: `ep${ep.n} built as ${variant}: gate PASS ${gate.counts.PASS} / WARN ${gate.counts.WARN} / FAIL 0`,
    };
  });
}

// ---- E8 -------------------------------------------------------------------------------------------------------------

/** The final watch's proxy: 480 px, into the run's work folder (never the project's). */
export async function makeReviewProxy(ctx: NarratedContext, src: string, out: string): Promise<boolean> {
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) return true;
  if (ctx.scripts.fake) return false;
  mkdirSync(path.dirname(out), { recursive: true });
  const part = `${out}.part.mp4`;
  const r = await runProcess(ffmpegBin(), ["-y", "-v", "error", "-i", src, "-vf", "scale=-2:480", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", part], { timeoutMs: 20 * 60 * 1000 }).done;
  if (r.code !== 0) return false;
  const { renameSync } = await import("node:fs");
  renameSync(part, out);
  return true;
}

/** Where a send-back lands: the lane stages it re-opens. */
export function sendBackPatch(ep: FilmRunEpisode, to: string): EpisodePatch | null {
  switch (to) {
    case "prep":
      return { stage: "lanes", words_stage: "prep", approved: false };
    case "voice":
      return { stage: "lanes", words_stage: "voice", approved: false };
    case "frames":
      return { stage: "lanes", words_stage: "frames", approved: false };
    case "joins":
      return { stage: "lanes", words_stage: "joins", approved: false };
    case "picture":
      return { stage: "lanes", picture_stage: "picture", approved: false };
    case "build":
      return { stage: "build", approved: false };
    default:
      return null;
  }
}

/**
 * Why episode N may not be dropped, or null: only the last open episode of
 * the plan can go (the season's numbers must run on without a gap for the
 * import, and the episode after a dropped one could never build: the
 * ordering rule wants its predecessor shipped). Pure.
 */
export function dropRefusal(ep: Pick<FilmRunEpisode, "n">, episodes: Pick<FilmRunEpisode, "n" | "stage">[]): string | null {
  const later = episodes.filter((e) => e.n > ep.n && e.stage !== "dropped").map((e) => e.n);
  if (!later.length) return null;
  return `ep${ep.n} cannot be dropped while ep${later.join(", ep")} stay${later.length === 1 ? "s" : ""} in the plan: the season's numbers must run on for the import, and the episode after a dropped one never builds. Drop the last episode first, or send this one back to a stage`;
}

export async function runEpisodeReviewStep(ctx: NarratedContext, ep: FilmRunEpisode, all: FilmRunEpisode[] = []): Promise<EpisodeStepOutcome> {
  const d = ep.stage_detail as Record<string, Json | undefined>;
  const variantDir = ep.variant ? path.join(ctx.paths.film, epDir(ep.n), "variants", ep.variant) : null;
  const shipped = variantDir ? path.join(variantDir, `ep${ep.n}.mp4`) : null;
  const proxy = ep.variant ? path.join(ctx.paths.work, "proxies", `ep${ep.n}-${ep.variant}.mp4`) : null;
  const review = {
    proxy: shipped && proxy && existsSync(shipped) && (await makeReviewProxy(ctx, shipped, proxy)) ? proxy : null,
    gate_md: variantDir ? `${epDir(ep.n)}/variants/${ep.variant}/ep${ep.n}.mp4.gate.md` : null,
    gate_md_present: variantDir ? gateMarkdown(variantDir, ep.n) !== null : false,
    user_review: variantDir ? `${epDir(ep.n)}/variants/${ep.variant}/USER-REVIEW.md` : null,
    transcript: `${epDir(ep.n)}/review/transcript.txt`,
    preflight: `${epDir(ep.n)}/review/preflight.txt (reporting only)`,
  };
  const decision = pendingEpisodeDecision(ctx.run, ep, NARRATED_DECISION.episode);
  if (!decision) return { kind: "wait", for: "episode", patch: { stage_detail: { ...d, review: review as unknown as Json } } };
  const data = dataOf(decision);
  const consumed = { decisions_seen: ctx.run.decisions.length };
  if (data.action === "approve") {
    if (!ep.gate || ep.gate.FAIL !== 0) return { kind: "wait", for: "episode", patch: { stage_detail: { ...d, ...consumed, review: review as unknown as Json, note: "an episode with a gate FAIL is not approved" } } };
    return { kind: "moved", patch: { stage: "shipped", approved: true, approved_by: decision.by, stage_detail: { ...d, ...consumed, review: review as unknown as Json, approved_note: decision.why ?? null } }, note: `ep${ep.n} ${ep.variant} approved by ${decision.by}` };
  }
  if (data.action === "drop") {
    const refusal = dropRefusal(ep, all);
    if (refusal) return { kind: "wait", for: "episode", patch: { stage_detail: { ...d, ...consumed, review: review as unknown as Json, note: refusal } } };
    return { kind: "moved", patch: { stage: "dropped", approved: false, stage_detail: { ...d, ...consumed, dropped: { by: decision.by, at: decision.at, why: decision.why ?? null } } } };
  }
  if (data.action === "send_back") {
    const to = typeof data.to_stage === "string" ? data.to_stage : "";
    const patch = sendBackPatch(ep, to);
    if (!patch) return { kind: "wait", for: "episode", patch: { stage_detail: { ...d, ...consumed, note: `send back to what? (prep, voice, frames, joins, picture, build), not "${to}"` } } };
    const rest = { ...d } as Record<string, Json | undefined>;
    if (to === "prep") delete rest.prep_approved;
    return { kind: "moved", patch: { ...patch, stage_detail: { ...rest, ...consumed, send_back: { note: decision.why ?? "", by: decision.by, at: decision.at, to } } } };
  }
  return { kind: "wait", for: "episode", patch: { stage_detail: { ...d, ...consumed } } };
}

// ---- the scheduler ----------------------------------------------------------------------------------------------------

export type Lane = "words" | "picture" | "joined";
/**
 * What a step holds while it runs: `writing` a Claude Code session, `heavy`
 * the GPU (the machine's heavy lock), `voice` the paid ElevenLabs render —
 * one at a time per film, because tts_narration.py rewrites tts_ledger.json
 * by read-append-dump and the run's budget check must see the last render's
 * spend — and `light` the rest.
 */
export type StepClass = "writing" | "heavy" | "voice" | "light";

type LaneWait = { for: EpisodeWaitFor; since: string; retry_after: string | null };

export type PlannedStep = {
  lane: Lane;
  name: "prep" | "prep_review" | "voice" | "frames" | "joins" | "arm_picture" | "picture" | "reframe_glance" | "join_lanes" | "build" | "ep_review";
  cls: StepClass;
};

const waitsOf = (ep: Pick<FilmRunEpisode, "stage_detail">): Partial<Record<Lane, LaneWait | null>> => {
  const w = (ep.stage_detail as { waits?: unknown }).waits;
  return w && typeof w === "object" && !Array.isArray(w) ? (w as Partial<Record<Lane, LaneWait | null>>) : {};
};

const seenOf = (ep: Pick<FilmRunEpisode, "stage_detail">): Partial<Record<Lane, number>> => {
  const s = (ep.stage_detail as { seen?: unknown }).seen;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Partial<Record<Lane, number>>) : {};
};

/** The episode as a lane's step sees it: `decisions_seen` is that lane's own pointer, so one lane consuming a decision never hides it from another. */
export function laneView(ep: FilmRunEpisode, lane: Lane): FilmRunEpisode {
  return { ...ep, stage_detail: { ...(ep.stage_detail as Record<string, Json | undefined>), decisions_seen: seenOf(ep)[lane] ?? 0 } };
}

/** Whether a lane waiting for `w` may run again: a decision about the episode that wakes it (after its pointer), a run-level intake answer for a voice budget, or its poll being due. Pure. */
export function laneWakes(run: Pick<FilmRun, "decisions">, ep: FilmRunEpisode, lane: Lane, w: LaneWait | null | undefined, nowMs = Date.now(), orderReady: () => boolean = () => false): boolean {
  if (!w) return true;
  // The ordering rule wakes on its condition (the episode before has shipped), not on a clock.
  if (w.for === "order") return orderReady();
  const seen = seenOf(ep)[lane] ?? 0;
  const fresh = run.decisions.slice(seen);
  const wakes = EPISODE_WAKES[w.for] ?? [];
  if (fresh.some((d) => d.ep === ep.n && (wakes as string[]).includes(d.action))) return true;
  if (w.for === "voice" && fresh.some((d) => (d.ep === undefined || d.ep === null) && d.action === NARRATED_DECISION.intake)) return true;
  if (w.for === "retry" && lane === "words" && ep.words_stage === "prep" && prepAutoRetry(ep)) return true;
  if (w.retry_after) {
    const at = Date.parse(w.retry_after);
    return Number.isFinite(at) ? at <= nowMs : true;
  }
  return false;
}

/** Each lane's next step for an episode, when one can run now. Pure over the rows (and, for the ordering rule, the prior project's episode on disk). */
export function planEpisodeSteps(run: Pick<FilmRun, "decisions">, ep: FilmRunEpisode, nowMs = Date.now(), season: { eps: Pick<FilmRunEpisode, "n" | "stage">[]; film: string } | null = null): PlannedStep[] {
  if (ep.stage === "shipped" || ep.stage === "dropped") return [];
  const waits = waitsOf(ep);
  const out: PlannedStep[] = [];
  const orderReady = () => (season ? orderingRefusal(ep, season.eps, season.film) === null : true);
  const ok = (lane: Lane) => laneWakes(run, ep, lane, waits[lane], nowMs, orderReady);
  if (ep.stage === "build") {
    if (ok("joined")) out.push({ lane: "joined", name: "build", cls: "heavy" });
    return out;
  }
  if (ep.stage === "ep_review") {
    if (ok("joined")) out.push({ lane: "joined", name: "ep_review", cls: "light" });
    return out;
  }
  // Both lanes, until they join.
  if (ep.words_stage === "ready" && ep.picture_stage === "ready") return [{ lane: "joined", name: "join_lanes", cls: "light" }];
  if (ok("words")) {
    const w = ep.words_stage;
    if (w === "prep") out.push({ lane: "words", name: "prep", cls: "writing" });
    else if (w === "prep_review") out.push({ lane: "words", name: "prep_review", cls: "light" });
    else if (w === "voice") out.push({ lane: "words", name: "voice", cls: "voice" });
    else if (w === "frames") out.push({ lane: "words", name: "frames", cls: "light" });
    else if (w === "joins") out.push({ lane: "words", name: "joins", cls: "light" });
  }
  if (ok("picture") && prepApprovalOf(ep)) {
    const p = ep.picture_stage;
    if (p === "waiting") out.push({ lane: "picture", name: "arm_picture", cls: "light" });
    else if (p === "picture" || p === "stale") out.push({ lane: "picture", name: "picture", cls: "heavy" });
    else if (p === "reframe_glance") {
      // An override re-runs track_faces.py and reframe.py on the GPU: a heavy step, so it never runs beside this run's
      // own picture or build step (both would take the heavy lock under the same holder and adopt each other's slot).
      const override = dataOf(pendingEpisodeDecision(run, laneView(ep, "picture"), NARRATED_DECISION.reframe)).action === "override";
      out.push({ lane: "picture", name: "reframe_glance", cls: override ? "heavy" : "light" });
    }
  }
  return out;
}

/** How many steps of each class run at once in one run (one film). */
export const STEP_CAPACITY: Readonly<Record<StepClass, number>> = { writing: 1, heavy: 1, voice: 1, light: 2 };
const CAPACITY = STEP_CAPACITY;

async function stepFn(ctx: NarratedContext, step: PlannedStep, ep: FilmRunEpisode, all: FilmRunEpisode[]): Promise<EpisodeStepOutcome> {
  switch (step.name) {
    case "prep":
      return runPrepStep(ctx, ep, all);
    case "prep_review":
      return runPrepReviewStep(ctx, ep);
    case "voice":
      return runVoiceStep(ctx, ep, all);
    case "frames":
      return runFramesStep(ctx, ep);
    case "joins":
      return runJoinsStep(ctx, ep);
    case "arm_picture":
      return { kind: "moved", patch: { picture_stage: "picture" } };
    case "picture":
      return runPictureStep(ctx, ep);
    case "reframe_glance":
      return runReframeGlanceStep(ctx, ep);
    case "join_lanes":
      return { kind: "moved", patch: { stage: "build" }, note: `ep${ep.n}: both lanes ready` };
    case "build":
      return runBuildStep(ctx, ep, all);
    case "ep_review":
      return runEpisodeReviewStep(ctx, ep, all);
  }
}

/**
 * The detail a lane's write leaves: the row's CURRENT detail with only the
 * keys the step changed (against the detail it started from) laid over it —
 * the other lane of the same episode may have written meanwhile (the GPU
 * lane runs while the voice renders), and a step's whole-detail spread must
 * not undo that. Pure.
 */
export function mergeDetail(current: Json, start: Json, patch: Json | undefined): Record<string, Json | undefined> {
  const cur = { ...((current ?? {}) as Record<string, Json | undefined>) };
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return cur;
  const from = (start ?? {}) as Record<string, Json | undefined>;
  for (const [k, v] of Object.entries(patch as Record<string, Json | undefined>)) {
    if (JSON.stringify(v) !== JSON.stringify(from[k])) cur[k] = v;
  }
  for (const k of Object.keys(from)) if (!(k in (patch as Record<string, unknown>)) && k in cur && JSON.stringify(cur[k]) === JSON.stringify(from[k])) delete cur[k];
  return cur;
}

/** The write a lane's outcome makes on the row as it is NOW (`ep`), given the detail the step started from; the waits and the lane's decision pointer are the scheduler's. */
export function writeFor(ep: FilmRunEpisode, start: Json, lane: Lane, outcome: EpisodeStepOutcome, owner: string): Omit<RunEpisodeStageInput, "revision"> {
  const base = (outcome.patch ?? {}) as EpisodePatch;
  const detail = mergeDetail(ep.stage_detail, start, base.stage_detail);
  const seen = { ...seenOf(ep) };
  const stepSeen = (base.stage_detail as { decisions_seen?: unknown } | undefined)?.decisions_seen;
  if (typeof stepSeen === "number") seen[lane] = stepSeen;
  delete detail.decisions_seen;
  const waits = { ...waitsOf(ep) };
  const now = new Date().toISOString();
  if (outcome.kind === "moved") waits[lane] = null;
  else if (outcome.kind === "wait") waits[lane] = { for: outcome.for, since: now, retry_after: outcome.retryMs ? new Date(Date.now() + outcome.retryMs).toISOString() : null };
  else waits[lane] = { for: "retry", since: now, retry_after: null };
  if (base.stage && base.stage !== ep.stage) {
    // Leaving or entering the joined stages starts every lane's pointer fresh at this point.
    waits.joined = outcome.kind === "moved" ? null : waits.joined;
  }
  if (outcome.kind === "wait" && outcome.detail) Object.assign(detail, outcome.detail);
  if (outcome.kind === "refused") detail.failed_step = { lane, at: now } as unknown as Json;
  detail.seen = seen as unknown as Json;
  detail.waits = waits as unknown as Json;
  const input: Omit<RunEpisodeStageInput, "revision"> = { ...base, owner, stage_detail: detail as Json };
  if (outcome.kind === "refused") input.error_text = outcome.error;
  return input;
}

/** Write with a CAS on the row as it is now, re-reading and re-merging when another lane wrote in between (at most four tries). */
async function writeLane(ctx: NarratedContext, epId: string, build: (current: FilmRunEpisode) => Omit<RunEpisodeStageInput, "revision">): Promise<FilmRunEpisode> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await ctx.data.getRunEpisode(ctx.session, epId);
    try {
      return await ctx.data.setRunEpisodeStage(ctx.session, epId, { ...build(cur), revision: cur.revision });
    } catch (e) {
      last = e;
      if (!(e instanceof Error) || !/changed|conflict/i.test(e.message)) throw e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Claim an episode, run one lane step on it (its lease renewed), write the outcome, apply any neighbour patches, let go. */
async function runOneStep(ctx: NarratedContext, run: FilmRun, step: PlannedStep, epId: string): Promise<void> {
  const fresh = await ctx.data.getRunEpisode(ctx.session, epId);
  const claimed = await ctx.data.claimRunEpisode(ctx.session, epId, { owner: ctx.owner, revision: fresh.revision });
  if (!claimed) return;
  const renew = setInterval(() => void ctx.data.renewRunEpisodeLease(ctx.session, epId, { owner: ctx.owner }).catch(() => undefined), 60_000);
  renew.unref?.();
  let current = claimed;
  try {
    const all = await ctx.data.listRunEpisodes(ctx.session, run.id);
    const stepCtx: NarratedContext = { ...ctx, run };
    let outcome: EpisodeStepOutcome;
    try {
      outcome = await stepFn(stepCtx, step, laneView(claimed, step.lane), all);
    } catch (e) {
      if (e instanceof RunCancelled) throw e;
      outcome = { kind: "refused", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
    ctx.log(`ep${claimed.n} ${step.name}: ${outcome.kind}${outcome.kind === "refused" ? ` — ${outcome.error.split("\n")[0]}` : outcome.kind === "wait" ? ` for ${outcome.for}` : outcome.note ? ` — ${outcome.note}` : ""}`);
    const start = laneView(claimed, step.lane).stage_detail;
    current = await writeLane(ctx, epId, (cur) => writeFor(cur, start, step.lane, outcome, ctx.owner));
    for (const o of outcome.others ?? []) {
      const row = all.find((e) => e.n === o.n);
      if (!row) continue;
      // A neighbour's lane may be running under this worker (its lease is ours) or another's (then the next pass sees it).
      const theirs = await ctx.data.getRunEpisode(ctx.session, row.id);
      if (theirs.lease_owner && theirs.lease_owner !== ctx.owner && Date.parse(theirs.leased_until ?? "") > Date.now()) {
        ctx.log(`ep${o.n}: ${o.why} — its row is held by ${theirs.lease_owner}; not marked now`);
        continue;
      }
      await writeLane(ctx, row.id, (cur) => ({ ...o.patch, owner: ctx.owner, stage_detail: mergeDetail(cur.stage_detail, row.stage_detail, o.patch.stage_detail) as Json }));
      ctx.log(`ep${o.n}: ${o.why}`);
    }
  } finally {
    clearInterval(renew);
    await ctx.data.releaseRunEpisode(ctx.session, current.id, { owner: ctx.owner }).catch(() => undefined);
  }
}

/** One line per open episode for the run's detail (the grid reads the rows themselves). */
function summary(eps: FilmRunEpisode[]): Json {
  return eps.map((e) => ({ n: e.n, stage: e.stage, words: e.words_stage, picture: e.picture_stage, variant: e.variant, waits: waitsOf(e) as unknown as Json, error: e.error_text ? e.error_text.split("\n")[0].slice(0, 200) : null })) as unknown as Json;
}

export async function runEpisodeWorkStage(ctx: NarratedContext): Promise<StageOutcome> {
  return withHeartbeat(ctx, async () => {
    const inFlight = new Map<string, { cls: StepClass; p: Promise<void> }>();
    const errors: string[] = [];
    for (;;) {
      if (ctx.signal.aborted) throw new RunCancelled(ctx.run.id);
      const run = await ctx.data.getFilmRun(ctx.session, ctx.run.id);
      if (run.stage === "cancelled") throw new RunCancelled(run.id);
      const eps = await ctx.data.listRunEpisodes(ctx.session, run.id);
      if (!eps.length) return fail("the run has no episode rows: the episode plan was never approved");
      const open = eps.filter((e) => e.stage !== "shipped" && e.stage !== "dropped");
      if (!open.length && !inFlight.size) {
        if (!eps.some((e) => e.stage === "shipped")) return fail("every episode of the plan was dropped: nothing to deliver");
        return next("film_meta", { episodes: summary(eps), decisions_seen: run.decisions.length });
      }
      const busy = (cls: StepClass) => [...inFlight.values()].filter((x) => x.cls === cls).length;
      const now = Date.now();
      for (const ep of open) {
        for (const step of planEpisodeSteps(run, ep, now, { eps, film: ctx.paths.film })) {
          const key = `${ep.id}:${step.lane}`;
          if (inFlight.has(key) || [...inFlight.keys()].some((k) => k.startsWith(`${ep.id}:`) && (step.lane === "joined" || k.endsWith(":joined")))) continue;
          if (busy(step.cls) >= CAPACITY[step.cls]) continue;
          const p = runOneStep(ctx, run, step, ep.id)
            .catch((e) => {
              if (e instanceof RunCancelled) throw e;
              errors.push(`ep${ep.n} ${step.name}: ${(e as Error).message}`);
              ctx.log(`ep${ep.n} ${step.name} could not be written: ${(e as Error).message}`);
            })
            .finally(() => inFlight.delete(key));
          inFlight.set(key, { cls: step.cls, p });
        }
      }
      if (!inFlight.size) {
        // Nothing can move now: every open lane waits for a person, a lock, a limit or its turn.
        const retries = open.flatMap((e) => Object.values(waitsOf(e)).map((w) => (w?.retry_after ? Date.parse(w.retry_after) : NaN))).filter((t) => Number.isFinite(t));
        const soonest = retries.length ? Math.max(5_000, Math.min(...retries) - Date.now()) : undefined;
        return narratedWait("episode_work", { episodes: summary(eps), step_errors: errors.slice(-10) }, soonest);
      }
      await Promise.race([...inFlight.values()].map((x) => x.p));
      await ctx.progress({ episodes: summary(await ctx.data.listRunEpisodes(ctx.session, run.id)) }).catch(() => undefined);
    }
  });
}

/** The decisions that mean "look at the episodes again" (the decide route can use it to label a wake). */
export const EPISODE_DECISIONS = [NARRATED_DECISION.prep, NARRATED_DECISION.reframe, NARRATED_DECISION.voice, NARRATED_DECISION.line, NARRATED_DECISION.join, NARRATED_DECISION.episode, NARRATED_DECISION.retry, NARRATED_DECISION.run_yourself, NARRATED_DECISION.handoff_done] as const;

export { narratedWait };
