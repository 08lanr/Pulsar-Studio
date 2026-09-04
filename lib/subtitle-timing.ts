// Subtitle timing math — pure functions shared by the data layers, the
// timing routes and the studio UI (2026-09-05: the founder's footage runs
// ~500 ms late, so timing became a first-class control, not a re-ingest).
//
// Conventions: a cue is any object with start_ms / end_ms (Line and
// AdaptedLine both qualify); functions return NEW values and never mutate.
// Rules, in priority order: no negative starts, end after start, durations
// preserved where possible, overlaps resolved by trimming the EARLIER cue
// (the later cue's start is the ear's anchor).

export type TimedCue = { start_ms: number | null; end_ms: number | null };

export type ShiftedCue = { start_ms: number; end_ms: number; clamped: boolean };

/** A cue must render for at least this long to be seekable/readable. */
export const MIN_CUE_MS = 100;

/** The studio warns below this duration (a subtitle nobody can read). */
export const SHORT_CUE_WARN_MS = 300;

/**
 * Shift every timed cue by `offsetMs`. Starts clamp at 0 with the cue's
 * duration preserved; when clamping piles early cues onto each other, the
 * later cue is pushed to the previous cue's end (durations kept) — only
 * overlaps the shift itself introduced are resolved; a pre-existing
 * overlap in the source passes through untouched for QC to flag.
 * Input order must be by start time. Untimed cues pass through as null.
 */
export function applyGlobalOffset<T extends TimedCue>(
  cues: T[],
  offsetMs: number
): { cues: (T & { start_ms: number | null; end_ms: number | null })[]; shifted: number; clamped: number } {
  let shifted = 0;
  let clamped = 0;
  const out = cues.map((c) => {
    if (c.start_ms === null || c.end_ms === null) return { ...c, _clamped: false };
    const duration = Math.max(MIN_CUE_MS, c.end_ms - c.start_ms);
    let start = c.start_ms + offsetMs;
    let wasClamped = false;
    if (start < 0) {
      start = 0;
      wasClamped = true;
      clamped += 1;
    }
    shifted += 1;
    return { ...c, start_ms: start, end_ms: start + duration, _clamped: wasClamped };
  });
  let prevEnd: number | null = null;
  let prevClamped = false;
  for (const c of out) {
    if (c.start_ms === null || c.end_ms === null) continue;
    if (prevEnd !== null && (c._clamped || prevClamped) && c.start_ms < prevEnd) {
      const dur = c.end_ms - c.start_ms;
      c.start_ms = prevEnd;
      c.end_ms = prevEnd + dur;
    }
    prevEnd = c.end_ms;
    prevClamped = c._clamped;
  }
  return { cues: out.map(({ _clamped, ...c }) => c as T & { start_ms: number | null; end_ms: number | null }), shifted, clamped };
}

export type CueTimingUpdate = { start_ms: number; end_ms: number };

/** Throws (Error with a plain message) when a per-cue edit is invalid on its own. */
export function assertValidCue(u: CueTimingUpdate): void {
  if (!Number.isInteger(u.start_ms) || !Number.isInteger(u.end_ms)) throw new Error("timestamps must be integer milliseconds");
  if (u.start_ms < 0) throw new Error("start must not be negative");
  if (u.end_ms <= u.start_ms) throw new Error("end must come after start");
}

export type TimingIssue = {
  code: "overlap" | "reversed" | "too_short" | "beyond_video";
  /** Index into the cue list the issue anchors to. */
  index: number;
  detail?: number;
};

/** The studio's warning list (advisory; QC keeps its own blocking rules). */
export function timingIssues(cues: TimedCue[], videoMs?: number | null): TimingIssue[] {
  const issues: TimingIssue[] = [];
  let prevEnd: number | null = null;
  cues.forEach((c, i) => {
    if (c.start_ms === null || c.end_ms === null) return;
    if (c.end_ms <= c.start_ms) issues.push({ code: "reversed", index: i });
    else if (c.end_ms - c.start_ms < SHORT_CUE_WARN_MS) issues.push({ code: "too_short", index: i, detail: c.end_ms - c.start_ms });
    if (prevEnd !== null && c.start_ms < prevEnd) issues.push({ code: "overlap", index: i, detail: prevEnd - c.start_ms });
    if (videoMs && c.end_ms > videoMs) issues.push({ code: "beyond_video", index: i, detail: c.end_ms - videoMs });
    if (c.end_ms !== null) prevEnd = Math.max(prevEnd ?? 0, c.end_ms);
  });
  return issues;
}

/** m:ss.mmm for the timing editor's readouts. */
export function preciseTimecode(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export type MergeableCue = { start_ms: number; end_ms: number; text: string };

/** Pair two short neighboring cues into one two-row cue spanning both
 * windows: longer reading time, less flicker. Only single-line cues merge,
 * pairs never chain into triples, and the limits keep QC's 2-row / 42-char
 * shape intact. */
export function mergeShortCues(
  cues: MergeableCue[],
  opts: { maxGapMs?: number; maxCombinedMs?: number; maxCombinedChars?: number } = {}
): MergeableCue[] {
  const maxGap = opts.maxGapMs ?? 300;
  const maxMs = opts.maxCombinedMs ?? 6000;
  const maxChars = opts.maxCombinedChars ?? 60;
  const out: MergeableCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const a = cues[i];
    const b = cues[i + 1];
    const fits =
      b &&
      !a.text.includes("\n") &&
      !b.text.includes("\n") &&
      b.start_ms - a.end_ms >= -50 &&
      b.start_ms - a.end_ms <= maxGap &&
      b.end_ms - a.start_ms <= maxMs &&
      a.text.replace(/\s/g, "").length + b.text.replace(/\s/g, "").length <= maxChars;
    if (fits) {
      out.push({ start_ms: a.start_ms, end_ms: b.end_ms, text: `${a.text}\n${b.text}` });
      i += 1; // the pair is consumed; never chain into a third row
    } else {
      out.push({ ...a });
    }
  }
  return out;
}

/** Frame-sampled stamps betray themselves: starts rounded to whole seconds.
 * True when enough timed cues sit exactly on second boundaries. */
export function looksFrameSampled(startsMs: (number | null)[]): boolean {
  const timed = startsMs.filter((v): v is number => v !== null);
  if (timed.length < 5) return false;
  const onSecond = timed.filter((v) => v % 1000 === 0).length;
  return onSecond / timed.length >= 0.6;
}
