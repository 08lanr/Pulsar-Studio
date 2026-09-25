// What the CrazyDramas stats pages show, summed from crazydramas' report
// (./stats-types.ts). Pure and client-safe; tests/crazydramas-stats.test.ts.
//
// Two kinds of number, never mixed:
//   - per-day audience (watchers, visitors, WAU, MAU): people are never added
//     across days (one person on three days is one person, not three), so a
//     period shows each day, and the week and month come from crazydramas'
//     own distinct counts (`wau`, `mau` of the last day);
//   - per-series paths: people are grouped by the day they FIRST opened the
//     series (a person is in one day's group per series), so the groups of a
//     period add up, and every step is a share of the people who opened it.

import type { CdStatsCohort, CdStatsDay, CdStatsReport, CdStatsSeries } from "./stats-types";

export const STATS_RANGES = ["today", "7d", "30d", "all"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export function parseStatsRange(raw: unknown): StatsRange {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return STATS_RANGES.includes(v as StatsRange) ? (v as StatsRange) : "7d";
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The first day anything happened (a visit, a robot, a payment), or null for an empty report. */
export function firstActiveDay(report: Pick<CdStatsReport, "days" | "series">): string | null {
  let first: string | null = null;
  const see = (day: string) => {
    if (first === null || day < first) first = day;
  };
  for (const d of report.days) if (d.visitors || d.watchers || d.robots || d.payments) see(d.day);
  for (const s of report.series) for (const c of s.cohorts) if (c.opened || c.robots || c.buyers) see(c.day);
  return first;
}

/**
 * The inclusive days a range covers, ending on the report's last day (today, in the report's time zone).
 * "All" starts on the first day anything happened, not on the report's first (empty) day.
 */
export function rangeDays(report: Pick<CdStatsReport, "from" | "to"> & Partial<Pick<CdStatsReport, "days" | "series">>, range: StatsRange): { from: string; to: string } {
  const span = range === "today" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : null;
  const active = span === null && report.days && report.series ? firstActiveDay({ days: report.days, series: report.series }) : null;
  const from = span === null ? (active ?? report.from) : addDays(report.to, -(span - 1));
  return { from: from < report.from ? report.from : from, to: report.to };
}

const inRange = (day: string, r: { from: string; to: string }) => day >= r.from && day <= r.to;

// ---- the audience -------------------------------------------------------------------------------------------

export type Audience = {
  today: CdStatsDay | null;
  yesterday: CdStatsDay | null;
  /** Different people who pressed play in the 7 / 30 days ending today. */
  wau: number;
  mau: number;
  /** The range's days, oldest first. */
  days: CdStatsDay[];
  money: { revenue_cents: number; payments: number; first_purchases: number; renewals: number };
  /** Robot browsers seen per day, summed over the range (a robot seen on two days counts twice). */
  robot_visits: number;
};

export function audience(report: CdStatsReport, range: StatsRange): Audience {
  const r = rangeDays(report, range);
  const days = report.days.filter((d) => inRange(d.day, r)).sort((a, b) => a.day.localeCompare(b.day));
  const byDay = new Map(report.days.map((d) => [d.day, d]));
  const today = byDay.get(report.to) ?? null;
  const money = { revenue_cents: 0, payments: 0, first_purchases: 0, renewals: 0 };
  let robots = 0;
  for (const d of days) {
    money.revenue_cents += d.revenue_cents;
    money.payments += d.payments;
    money.first_purchases += d.first_purchases;
    money.renewals += d.renewals;
    robots += d.robots;
  }
  return { today, yesterday: byDay.get(addDays(report.to, -1)) ?? null, wau: today?.wau ?? 0, mau: today?.mau ?? 0, days, money, robot_visits: robots };
}

// ---- one series ---------------------------------------------------------------------------------------------

export type SeriesTotals = {
  drama_id: string;
  slug: string;
  title: string;
  free_episodes: number;
  episode_count: number;
  ep1_duration_s: number | null;
  opened: number;
  started_ep1: number;
  finished_ep1: number;
  ep1_seconds: number;
  ep1_reached: number[];
  episodes: number[];
  episodes_watched: number[];
  paywall: number;
  paywall_watched: number;
  paywall_skipped: number;
  checkouts: number;
  buyers: number;
  revenue_cents: number;
  robots: number;
};

function addInto(into: number[], add: number[]): void {
  for (let i = 0; i < add.length; i++) into[i] = (into[i] ?? 0) + add[i];
}

export function seriesTotals(series: CdStatsSeries, r: { from: string; to: string }): SeriesTotals {
  const t: SeriesTotals = {
    drama_id: series.drama_id,
    slug: series.slug,
    title: series.title,
    free_episodes: series.free_episodes,
    episode_count: series.episode_count,
    ep1_duration_s: series.ep1_duration_s,
    opened: 0,
    started_ep1: 0,
    finished_ep1: 0,
    ep1_seconds: 0,
    ep1_reached: [],
    episodes: [],
    episodes_watched: [],
    paywall: 0,
    paywall_watched: 0,
    paywall_skipped: 0,
    checkouts: 0,
    buyers: 0,
    revenue_cents: 0,
    robots: 0,
  };
  const scalar: (keyof CdStatsCohort & keyof SeriesTotals)[] = [
    "opened",
    "started_ep1",
    "finished_ep1",
    "ep1_seconds",
    "paywall",
    "paywall_watched",
    "paywall_skipped",
    "checkouts",
    "buyers",
    "revenue_cents",
    "robots",
  ];
  for (const c of series.cohorts) {
    if (!inRange(c.day, r)) continue;
    for (const k of scalar) (t[k] as number) += c[k] as number;
    addInto(t.ep1_reached, c.ep1_reached);
    addInto(t.episodes, c.episodes);
    addInto(t.episodes_watched, c.episodes_watched);
  }
  return t;
}

/** Every series' totals for the range, most opened first (then by title); series nobody opened come last. */
export function seriesTable(report: CdStatsReport, range: StatsRange): SeriesTotals[] {
  const r = rangeDays(report, range);
  return report.series.map((s) => seriesTotals(s, r)).sort((a, b) => b.opened - a.opened || b.revenue_cents - a.revenue_cents || a.title.localeCompare(b.title));
}

/** A share, 0..1, or null when there is nobody to share out. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** "12%", "4.5%" under 10, "<1%" for a sliver, "–" for no base. */
export function fmtShare(s: number | null): string {
  if (s === null) return "–";
  const p = s * 100;
  if (p > 0 && p < 1) return "<1%";
  return p < 10 ? `${Number(p.toFixed(1))}%` : `${Math.round(p)}%`;
}

/** m:ss */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtUsdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- episode 1 ----------------------------------------------------------------------------------------------

export type Ep1Point = { t: number; people: number; share: number | null };

export type Ep1Curve = {
  started: number;
  finished: number;
  duration_s: number | null;
  /** People still watching at each step, then (when the length is known) the end: the finishers. */
  points: Ep1Point[];
  /** Share of starters gone before the first step (15 s). */
  gone_first_step: number | null;
  step_s: number;
  /** The first step at which fewer than half are still watching, or null when half or more reach the end. */
  half_gone_at: number | null;
  avg_seconds: number | null;
};

export function ep1Curve(t: SeriesTotals, stepS: number): Ep1Curve {
  const started = t.started_ep1;
  const points: Ep1Point[] = t.ep1_reached.map((people, k) => ({ t: k * stepS, people, share: share(people, started) }));
  if (t.ep1_duration_s && (points.length === 0 || points[points.length - 1].t < t.ep1_duration_s)) {
    points.push({ t: t.ep1_duration_s, people: t.finished_ep1, share: share(t.finished_ep1, started) });
  }
  const half = points.find((p) => p.share !== null && p.share < 0.5);
  return {
    started,
    finished: t.finished_ep1,
    duration_s: t.ep1_duration_s,
    points,
    gone_first_step: started > 0 && points.length > 1 ? 1 - points[1].people / started : null,
    step_s: stepS,
    half_gone_at: half ? half.t : null,
    avg_seconds: started > 0 ? t.ep1_seconds / started : null,
  };
}

// ---- every episode ------------------------------------------------------------------------------------------

export type EpisodeBar = { n: number; started: number; watched: number; free: boolean };

/**
 * One bar per episode, up to a little past the last one anybody started (and
 * at least two past the first locked one, so the paywall shows), capped at
 * the series' length. `hidden_after`: the episodes left off, which nobody
 * has started.
 */
export function episodeBars(t: SeriesTotals): { bars: EpisodeBar[]; hidden_after: number | null } {
  let last = 0;
  t.episodes.forEach((v, i) => {
    if (v > 0) last = i + 1;
  });
  const shown = Math.min(Math.max(t.episode_count, t.episodes.length), Math.max(last + 2, t.free_episodes + 3, 8));
  const bars: EpisodeBar[] = [];
  for (let n = 1; n <= shown; n++) bars.push({ n, started: t.episodes[n - 1] ?? 0, watched: t.episodes_watched[n - 1] ?? 0, free: n <= t.free_episodes });
  const total = Math.max(t.episode_count, t.episodes.length);
  return { bars, hidden_after: shown < total ? shown : null };
}
