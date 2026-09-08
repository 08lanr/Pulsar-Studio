// Movement over time, computed only when comparable observations exist.
//
// Contracts (docs/market-intelligence-review.md, "metric contracts"):
// - Counter velocity = (end - start) / actual elapsed days, same listing,
//   same platform counter (same source_field and unit). A decrease is an
//   anomaly (counter reset or sampling change), reported as such, never as
//   negative demand.
// - Rank movement = prior_rank - current_rank within the same named list.
//   Entry and exit are categorical.
// - Trend intervals report the actual elapsed time between the two
//   observations. Nothing here invents a zero before first discovery.
// - With fewer than two published DAYS, every function returns the
//   `collecting_history` state.

import type { MarketSnapshot, MarketTitle, MetricUnit } from "./types";

export type HistoryState = "collecting_history" | "ok";

export type CounterMovement =
  | { state: "collecting_history" }
  | { state: "no_baseline"; reason: "first_seen" | "no_counter" }
  | { state: "incomparable"; reason: string }
  | { state: "anomaly"; reason: "counter_decreased"; start: number; end: number; start_at: string; end_at: string }
  | { state: "ok"; unit: MetricUnit; start: number; end: number; delta: number; start_at: string; end_at: string; elapsed_days: number; per_day: number; growth_pct: number | null };

export type RankMovement =
  | { state: "collecting_history" }
  | { state: "entered"; list: string; rank: number }
  | { state: "exited"; list: string; prior_rank: number }
  | { state: "absent" }
  | { state: "ok"; list: string; prior_rank: number; rank: number; movement: number };

const MS_PER_DAY = 86_400_000;

function elapsedDays(a: string, b: string): number {
  return Math.round(((Date.parse(b) - Date.parse(a)) / MS_PER_DAY) * 100) / 100;
}

export function counterMovement(metric: "views" | "saves", current: MarketTitle, previous: MarketTitle | null, hasHistory: boolean): CounterMovement {
  if (!hasHistory) return { state: "collecting_history" };
  if (!previous) return { state: "no_baseline", reason: "first_seen" };
  const end = current.metrics[metric];
  const start = previous.metrics[metric];
  if (!end || !start) return { state: "no_baseline", reason: "no_counter" };
  if (end.source_field !== start.source_field || end.unit !== start.unit) return { state: "incomparable", reason: `${start.source_field}/${start.unit} vs ${end.source_field}/${end.unit}` };
  const days = elapsedDays(start.observed_at, end.observed_at);
  if (days <= 0) return { state: "incomparable", reason: "observations are not in order" };
  if (end.value < start.value) return { state: "anomaly", reason: "counter_decreased", start: start.value, end: end.value, start_at: start.observed_at, end_at: end.observed_at };
  const delta = end.value - start.value;
  return {
    state: "ok",
    unit: end.unit,
    start: start.value,
    end: end.value,
    delta,
    start_at: start.observed_at,
    end_at: end.observed_at,
    elapsed_days: days,
    per_day: Math.round(delta / days),
    growth_pct: start.value > 0 ? Math.round((delta / start.value) * 1000) / 10 : null,
  };
}

export function rankMovement(list: string, current: MarketTitle | null, previous: MarketTitle | null, hasHistory: boolean): RankMovement {
  if (!hasHistory) return { state: "collecting_history" };
  const now = current?.placements.find((p) => p.list === list) ?? null;
  const before = previous?.placements.find((p) => p.list === list) ?? null;
  if (now && !before) return { state: "entered", list, rank: now.rank };
  if (!now && before) return { state: "exited", list, prior_rank: before.rank };
  if (!now && !before) return { state: "absent" };
  return { state: "ok", list, prior_rank: before!.rank, rank: now!.rank, movement: before!.rank - now!.rank };
}

/** Earliest published day a listing appeared in; null if only in the current snapshot. */
export function firstSeen(key: string, history: MarketSnapshot[]): string | null {
  for (const s of history) if (s.titles.some((t) => t.key === key)) return s.observed_at;
  return null;
}

/** Days with a valid views counter for a listing, oldest first, for a sparkline (needs >= 3 to draw). */
export function counterSeries(key: string, metric: "views" | "saves", history: MarketSnapshot[]): { observed_at: string; value: number; unit: MetricUnit }[] {
  const out: { observed_at: string; value: number; unit: MetricUnit }[] = [];
  for (const s of history) {
    const t = s.titles.find((x) => x.key === key);
    const o = t?.metrics[metric];
    if (o) out.push({ observed_at: o.observed_at, value: o.value, unit: o.unit });
  }
  return out;
}

/** True when at least two distinct published days exist. */
export function hasHistory(days: [string, string][]): boolean {
  return new Set(days.map(([d]) => d)).size >= 2;
}
