// Footage-only clip selection (decision 2026-09-14): when an episode has no
// script to rank from, the moments are picked from what the footage itself
// says — where the picture cuts and where the sound peaks. Pure functions
// over numbers so the scoring is unit-testable without ffmpeg; the signals
// come from lib/clips/signals.ts.
//
// Nothing here invents meaning: a window is "strong" because it is loud and
// busy, and the row that comes out of it says exactly that (why_en /
// why_zh are fixed sentences, the hook is empty).

export type LoudnessSample = { t: number; db: number };

export type FootageWindow = {
  start_ms: number;
  end_ms: number;
  /** 0..2: normalized loudness peak + normalized cut density. */
  score: number;
  /** True when the start snapped to a scene cut. */
  on_cut: boolean;
};

export type ScoreOptions = {
  /** Window length in ms (default 25 s: inside the 20-30 s clip rule). */
  windowMs?: number;
  /** Slide step in ms. */
  stepMs?: number;
  /** How many windows to return at most. */
  limit?: number;
  /** Minimum gap between two returned windows, ms. */
  gapMs?: number;
  /** Snap the start to a cut this close before it, ms. */
  snapMs?: number;
};

export const FOOTAGE_DEFAULTS: Required<ScoreOptions> = { windowMs: 25_000, stepMs: 1_000, limit: 6, gapMs: 3_000, snapMs: 1_500 };

/**
 * Slide a window over the episode and score it by the loudest second inside
 * it and by how many scene cuts fall inside it (each normalized against the
 * episode's own range, so a quiet episode still ranks its windows). The
 * strongest non-overlapping windows come back first; a window never runs
 * past the duration, and a short episode returns fewer than `limit`.
 */
export function scoreWindows(cuts: number[], loudness: LoudnessSample[], durationMs: number, opts: ScoreOptions = {}): FootageWindow[] {
  const o = { ...FOOTAGE_DEFAULTS, ...opts };
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const windowMs = Math.min(o.windowMs, durationMs);
  const cutsMs = cuts.map((s) => Math.round(s * 1000)).filter((c) => c >= 0 && c <= durationMs).sort((a, b) => a - b);
  const samples = loudness.filter((s) => Number.isFinite(s.db)).map((s) => ({ t: Math.round(s.t * 1000), db: s.db }));
  const dbs = samples.map((s) => s.db);
  const dbMin = dbs.length ? Math.min(...dbs) : 0;
  const dbMax = dbs.length ? Math.max(...dbs) : 0;
  const dbRange = dbMax - dbMin;

  const raw: Array<{ start_ms: number; end_ms: number; loud: number; cuts: number }> = [];
  for (let start = 0; start + windowMs <= durationMs; start += o.stepMs) {
    const end = start + windowMs;
    let peak = -Infinity;
    for (const s of samples) if (s.t >= start && s.t < end && s.db > peak) peak = s.db;
    const loud = Number.isFinite(peak) && dbRange > 0 ? (peak - dbMin) / dbRange : 0;
    const cutCount = cutsMs.filter((c) => c >= start && c < end).length;
    raw.push({ start_ms: start, end_ms: end, loud, cuts: cutCount });
  }
  // Both signals normalized to 0..1 against the episode's own busiest / loudest window, then summed.
  // The start snaps to the nearest cut within `snapMs` so the clip opens on a fresh shot; among equal
  // scores a window that opens on a cut wins, then the earlier one.
  const maxCuts = Math.max(1, ...raw.map((c) => c.cuts));
  const candidates: FootageWindow[] = raw.map((c) => {
    let start = c.start_ms;
    let on_cut = false;
    let best = Infinity;
    for (const k of cutsMs) {
      const d = Math.abs(k - c.start_ms);
      if (d <= o.snapMs && d < best) { best = d; start = k; on_cut = true; }
    }
    return { start_ms: start, end_ms: Math.min(durationMs, start + windowMs), score: c.loud + c.cuts / maxCuts, on_cut };
  });
  candidates.sort((a, b) => b.score - a.score || Number(b.on_cut) - Number(a.on_cut) || a.start_ms - b.start_ms);

  const chosen: FootageWindow[] = [];
  for (const c of candidates) {
    if (chosen.length >= o.limit) break;
    if (c.end_ms - c.start_ms < Math.min(windowMs, durationMs) * 0.8) continue;
    if (chosen.some((w) => c.start_ms < w.end_ms + o.gapMs && c.end_ms > w.start_ms - o.gapMs)) continue;
    chosen.push(c);
  }
  return chosen;
}

/** Parse the `pts_time:` stamps ffmpeg's showinfo filter prints for frames the scene filter let through. */
export function parseSceneCuts(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/pts_time:\s*([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/**
 * Parse the ebur128 filter's momentary loudness log lines
 * (`t: 12.3  ... M: -23.4 S: ...`) into one sample per report.
 */
export function parseLoudness(stderr: string): LoudnessSample[] {
  const out: LoudnessSample[] = [];
  for (const m of stderr.matchAll(/t:\s*([0-9.]+)\s+.*?\bM:\s*(-?[0-9.]+|-inf)/g)) {
    const t = Number(m[1]);
    const db = m[2] === "-inf" ? -70 : Number(m[2]);
    if (Number.isFinite(t) && Number.isFinite(db)) out.push({ t, db });
  }
  return out;
}

/** Parse `Duration: 00:01:02.04` from ffmpeg's input dump. */
export function parseDurationMs(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return Math.round(((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3]) + frac) * 1000);
}
