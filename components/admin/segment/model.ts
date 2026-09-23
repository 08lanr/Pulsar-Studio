// Pure helpers behind the segmenting screens (plan B2/B3): the stage list
// the timeline walks, the words for a stage's progress, the slug the intake
// proposes from a file name, and the boundary-review model over the served
// review state — which cards need a person, in what order, what a move
// does to the episode lengths, and what the 95–150 s band refuses (the
// same arithmetic the decide route runs, so a refusal is seen before it is
// sent). No React and no node here: the tests run these against the
// recorded films' shapes and the client bundle imports them.

import type { BoundaryView, ReviewState } from "@/lib/segment/api-types";
import type { FilmRunDecision, FilmRunStage, Json } from "@/lib/types";

// ---- stages ---------------------------------------------------------------------------------------------

/** The stages a run walks, in order (plan B2); `cards` only in source-episodes mode. */
export const RUN_STEPS: readonly FilmRunStage[] = ["intake", "watermark", "index", "cards", "plan", "vision", "review", "render", "qa", "film_meta", "handoff", "done"];

/** Stages where the worker waits for a person (the watermark box, the cards, the vision hand-off, the review, film-meta, the import). */
export const WAITING_STAGES: readonly FilmRunStage[] = ["watermark", "cards", "review", "film_meta", "handoff"];

export const TERMINAL_STAGES: readonly FilmRunStage[] = ["done", "failed", "cancelled"];

/** The human-review threshold (decision 2026-09-23 #5): below it a boundary needs a person. */
export const REVIEW_CONFIDENCE = 0.65;

export function stepsFor(mode: string): FilmRunStage[] {
  return RUN_STEPS.filter((s) => s !== "cards" || mode === "source_episodes");
}

export function stageIndex(stage: FilmRunStage, mode = "by_eye_2min"): number {
  const steps = stepsFor(mode);
  if (stage === "queued") return -1;
  if (stage === "failed" || stage === "cancelled") return -2;
  return steps.indexOf(stage);
}

export function isTerminal(stage: FilmRunStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** True when the run's stage_detail says the worker is waiting for a person (`waiting.for`), or the stage is one that does. */
export function isWaiting(stage: FilmRunStage, detail?: Json | null): boolean {
  const w = waitingFor(detail);
  if (w) return true;
  return WAITING_STAGES.includes(stage);
}

/** `stage_detail.waiting.for`, or null. */
export function waitingFor(detail: Json | null | undefined): string | null {
  const d = asRecord(detail);
  const w = d ? asRecord(d.waiting) : null;
  return w && typeof w.for === "string" ? w.for : null;
}

/** True once the episodes are built: the review screen switches to join review. */
export function isRendered(stage: FilmRunStage, mode = "by_eye_2min"): boolean {
  return stage !== "failed" && stage !== "cancelled" && stageIndex(stage, mode) >= stageIndex("qa", mode);
}

function asRecord(v: Json | null | undefined): Record<string, Json | undefined> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json | undefined>) : null;
}

/** `stage_detail.source` (the intake's ffprobe facts), when the run got that far. */
export function sourceFactsOf(detail: Json | null | undefined): { width: number; height: number; fps: number; duration_s: number | null } | null {
  const d = asRecord(detail);
  const s = d ? asRecord(d.source) : null;
  if (!s || typeof s.width !== "number" || typeof s.height !== "number" || typeof s.fps !== "number") return null;
  return { width: s.width, height: s.height, fps: s.fps, duration_s: typeof s.duration_s === "number" ? s.duration_s : null };
}

/**
 * The words for a stage's progress: the worker's `stage_detail.progress`
 * (`{step, line}`, `{step: "render", t, of, kept}`, `{step}`), else the
 * detail itself (`{t, of}`, `{episode, of}`, `{file}`, `{line}`), else
 * `key: value` pairs. Never throws on an unknown shape.
 */
export function progressText(detail: Json | null | undefined): string {
  const top = asRecord(detail);
  if (!top) return typeof detail === "string" ? detail : "";
  const p = asRecord(top.progress);
  const d = p ?? top;
  const step = typeof d.step === "string" ? d.step : null;
  if (typeof d.line === "string" && d.line) return step ? `${step}: ${d.line}` : d.line;
  if (typeof d.file === "string" && !step) return d.file;
  if (typeof d.episode === "number" && typeof d.of === "number") return `episode ${d.episode} of ${d.of}`;
  if (typeof d.t === "number" && typeof d.of === "number") return step === "render" ? `${step}: ${d.t} / ${d.of} episodes${typeof d.kept === "number" && d.kept > 0 ? ` (${d.kept} kept)` : ""}` : `${fmtT(d.t)} / ${fmtT(d.of)}`;
  if (typeof d.n === "number" && typeof d.of === "number") return `${d.n} / ${d.of}`;
  if (typeof d.message === "string") return d.message;
  if (step) return step;
  if (p) return "";
  return Object.entries(d)
    .filter(([k, v]) => v !== null && v !== undefined && typeof v !== "object" && k !== "ready")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
}

// ---- time and names ---------------------------------------------------------------------------------------

/** Film seconds as `m:ss.s` (`115.367` → `1:55.4`); hours appear past 60 minutes. */
export function fmtT(t: number): string {
  const sign = t < 0 ? "-" : "";
  const abs = Math.abs(t);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const ss = s.toFixed(1).padStart(4, "0");
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, "0")}:${ss}` : `${sign}${m}:${ss}`;
}

/** A length in seconds with one decimal. */
export function fmtLen(s: number): string {
  return `${s.toFixed(1)} s`;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The pipeline rounds film times to 3 decimals; `String(round3(t))` is the key `choices.json` uses. */
export function timeKey(t: number): string {
  return String(round3(t));
}

export function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.0015;
}

/**
 * The folder name proposed from a source file name when the server gave
 * none: the download suffix `_Media_(<11-char id>)_(nnn)_(<n>)p` and the
 * extension go, the rest is lower-cased and joined with dashes
 * (`He Hated All Women_Media_(AbC…)_(001)_(1080)p.mp4` → `he-hated-all-women`).
 */
export function slugFromFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const noExt = base.replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const noSuffix = noExt.replace(/_Media_\([A-Za-z0-9_-]{11}\)_\(\d+\)_\(\d+\)p?$/i, "").replace(/[_ ]?\(\d{3,4}p?\)$/i, "");
  return noSuffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** `He Hated All Women` from `he-hated-all-women`, for a form default. */
export function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// ---- the boundary review model ---------------------------------------------------------------------------

export type CardReason = "low_confidence" | "skeptic" | "fault" | "no_record" | "rejudging" | "band";

export type ReviewCard = {
  key: string;
  boundary_s: number;
  /** The served boundary: record, options with their strip URLs, legal cuts, proxy URL. */
  view: BoundaryView;
  /** Where the cut currently is after the decisions (the server's `current_t`). */
  current_t: number;
  confidence: number | null;
  skeptic_override: boolean;
  /** What apply_vision would apply for the record, or null with the fault. */
  applied: { t: number; source: "reviewer" | "skeptic" } | { t: null; fault: string } | null;
  reasons: CardReason[];
  /** A person must look: the server says `needs_decision` or `rejudging`. */
  required: boolean;
  /** Decided (accepted or moved) since the last re-judge. */
  settled: boolean;
  rejudging: boolean;
  decision: FilmRunDecision | null;
};

/** What the cards and the arithmetic need of the served review state. */
export type ReviewLike = Pick<ReviewState, "band" | "duration" | "lengths"> & { boundaries: BoundaryView[] };

/** The fixed start of the stretch under review: the last delivered end (`lengths[0].from`), else 0. */
export function fixedStartOf(review: Pick<ReviewState, "lengths">): number {
  return review.lengths.length ? review.lengths[0].from : 0;
}

/** One card per served boundary, in options order, before any ordering. */
export function buildCards(review: ReviewLike): ReviewCard[] {
  return review.boundaries.map((b) => {
    const reasons: CardReason[] = [];
    for (const r of b.reasons) reasons.push(r === "skeptic_override" ? "skeptic" : r);
    if (b.status === "rejudging") reasons.push("rejudging");
    const applied: ReviewCard["applied"] = b.applied_t !== null ? { t: b.applied_t, source: b.applied_source === "SKEPTIC OVERRIDE" ? "skeptic" : "reviewer" } : b.fault ? { t: null, fault: b.fault } : null;
    return {
      key: timeKey(b.boundary_s),
      boundary_s: b.boundary_s,
      view: b,
      current_t: b.current_t,
      confidence: b.confidence,
      skeptic_override: !!b.record?.verdict && b.record.verdict.agree === false,
      applied,
      reasons,
      required: b.status === "needs_decision" || b.status === "rejudging",
      settled: b.status === "decided",
      rejudging: b.status === "rejudging",
      decision: b.decision,
    };
  });
}

/** The episodes the current cut times make between the fixed start and the duration; `firstN` numbers the first one. */
export function episodesOf(cards: readonly ReviewCard[], fixedStart: number, durationS: number, firstN = 1): { n: number; start: number; end: number; dur: number }[] {
  const times = cards.map((c) => c.current_t).filter((t) => t > fixedStart && t < durationS).sort((a, b) => a - b);
  const ends = [...times, durationS];
  const out: { n: number; start: number; end: number; dur: number }[] = [];
  let prev = fixedStart;
  ends.forEach((end, i) => {
    out.push({ n: firstN + i, start: prev, end, dur: round3(end - prev) });
    prev = end;
  });
  return out;
}

export type Neighbours = { before: { n: number; dur: number } | null; after: { n: number; dur: number } | null };

/** The two episodes around a card's cut if it sat at `t` (its current time by default), given the other cards' current times. */
export function neighbours(cards: readonly ReviewCard[], card: ReviewCard, review: { fixedStart: number; duration: number; firstN?: number }, t = card.current_t): Neighbours {
  const trial = cards.map((c) => (c.key === card.key ? { ...c, current_t: t } : c));
  const eps = episodesOf(trial, review.fixedStart, review.duration, review.firstN ?? 1);
  const before = eps.find((e) => sameTime(e.end, t)) ?? null;
  const after = eps.find((e) => sameTime(e.start, t)) ?? null;
  return { before: before ? { n: before.n, dur: before.dur } : null, after: after ? { n: after.n, dur: after.dur } : null };
}

export function inBand(len: number, band: [number, number]): boolean {
  return len >= band[0] - 1e-6 && len <= band[1] + 1e-6;
}

export type MoveCheck = { ok: boolean; before: number | null; after: number | null; refusals: string[] };

/**
 * What moving `card` to `t` does to its two episodes and whether the band
 * refuses it — the decide route's own rule (`moveRefusal`: both episodes
 * in band, the target within ±30 s and a listed option or legal cut), run
 * here first so the refusal is seen before it is sent.
 */
export function checkMove(cards: readonly ReviewCard[], card: ReviewCard, t: number, review: { fixedStart: number; duration: number; band: [number, number]; firstN?: number }): MoveCheck {
  const nb = neighbours(cards, card, review, t);
  const refusals: string[] = [];
  if (Math.abs(t - card.boundary_s) > 30 + 1e-6) refusals.push(`${fmtT(t)} is more than 30 s from the boundary at ${fmtT(card.boundary_s)}`);
  if (!isLegalTarget(card, t)) refusals.push(`${fmtT(t)} is not a listed option or a legal cut`);
  if (nb.before && !inBand(nb.before.dur, review.band)) refusals.push(`episode ${nb.before.n} would be ${fmtLen(nb.before.dur)}, outside ${review.band[0]}–${review.band[1]} s`);
  if (nb.after && !inBand(nb.after.dur, review.band)) refusals.push(`episode ${nb.after.n} would be ${fmtLen(nb.after.dur)}, outside ${review.band[0]}–${review.band[1]} s`);
  return { ok: refusals.length === 0, before: nb.before?.dur ?? null, after: nb.after?.dur ?? null, refusals };
}

/** Is `t` a place this card may move to: one of its options or a listed legal cut (the route only lists those within ±30 s). */
export function isLegalTarget(card: ReviewCard, t: number): boolean {
  return card.view.options.some((o) => sameTime(o.t, t)) || card.view.legal_cuts.some((c) => sameTime(c.t, t));
}

/** Boundaries whose current cut leaves an episode outside the band, grouped by the chain of episodes they share. */
export function bandConflictGroups(cards: readonly ReviewCard[], review: { fixedStart: number; duration: number; band: [number, number] }): number[][] {
  const live = cards.slice().sort((a, b) => a.current_t - b.current_t);
  const eps = episodesOf(live, review.fixedStart, review.duration);
  const flagged = new Set<string>();
  for (const e of eps) {
    if (inBand(e.dur, review.band)) continue;
    for (const c of live) if (sameTime(c.current_t, e.start) || sameTime(c.current_t, e.end)) flagged.add(c.key);
  }
  const groups: number[][] = [];
  let current: number[] = [];
  let prevFlagged = false;
  for (const c of live) {
    const on = flagged.has(c.key);
    if (on && prevFlagged) current.push(c.boundary_s);
    else if (on) {
      if (current.length) groups.push(current);
      current = [c.boundary_s];
    }
    prevFlagged = on;
  }
  if (current.length) groups.push(current);
  return groups;
}

export type ReviewOrder = {
  /** Lowest confidence and skeptic overrides first: the cards a person must look at. */
  attention: ReviewCard[];
  /** Band-conflict groups (cards not already above), each group in time order. */
  conflicts: ReviewCard[][];
  /** Agreed by reviewer and skeptic with confidence, or already decided: collapsed by default. */
  rest: ReviewCard[];
};

/** Plan B3's order: attention cards (skeptic overrides and faults, then rising confidence), band-conflict groups, then the rest collapsed. */
export function orderCards(cards: readonly ReviewCard[], review: { fixedStart: number; duration: number; band: [number, number] }): ReviewOrder {
  const groups = bandConflictGroups(cards, review);
  const attention = cards
    .filter((c) => c.required)
    .slice()
    .sort((a, b) => {
      const ra = a.skeptic_override || a.reasons.includes("fault") || a.reasons.includes("no_record") ? -1 : a.confidence ?? 1;
      const rb = b.skeptic_override || b.reasons.includes("fault") || b.reasons.includes("no_record") ? -1 : b.confidence ?? 1;
      return ra - rb || a.boundary_s - b.boundary_s;
    });
  const seen = new Set(attention.map((c) => c.key));
  const conflicts = groups
    .map((g) => g.map((t) => cards.find((c) => sameTime(c.boundary_s, t))!).filter((c) => !seen.has(c.key)))
    .filter((g) => g.length > 0);
  for (const g of conflicts) for (const c of g) seen.add(c.key);
  const rest = cards.filter((c) => !seen.has(c.key));
  return { attention, conflicts, rest };
}

/** Apply is allowed once every card that needs a person is settled and no episode is outside the band (the route checks the same). */
export function applyReady(cards: readonly ReviewCard[], review: { fixedStart: number; duration: number; band: [number, number] }): { ok: boolean; undecided: number; conflicts: number } {
  const undecided = cards.filter((c) => c.required && !c.settled).length;
  const conflicts = bandConflictGroups(cards, review).length;
  return { ok: undecided === 0 && conflicts === 0, undecided, conflicts };
}

/** Which tile of a strip is the cut (the centre tile), as row and column in a grid `cols` wide. */
export function cutTile(tiles: readonly number[], t: number, cols: number): { index: number; row: number; col: number; rows: number } {
  let index = tiles.findIndex((x) => sameTime(x, t));
  if (index < 0) index = Math.floor(tiles.length / 2);
  const rows = Math.max(1, Math.ceil(tiles.length / cols));
  return { index, row: Math.floor(index / cols), col: index % cols, rows };
}
