// The Series tab (decision 2026-09-26, "Stats: campaigns, buyers and the full episode curve"). Ruobin: "Our
// current series metric also stops at episode 2". A series' whole curve: of the people who started episode 1,
// the share who reached each episode to the last, the paywall episode marked and the biggest drops flagged;
// beside it the path from opening the page to paying. Pure and client-safe; tests/crazydramas-buyers.test.ts.

import { seriesTotals, share, type DashTotals } from "./stats-summary";
import type { CdStatsJourneyStep, CdStatsSeries } from "./stats-types";

export type CurvePoint = { n: number; people: number; share: number | null };

export type EpisodeCurve = {
  starters: number;
  points: CurvePoint[];
  /** The first locked episode, and how it was found: the series' free-episode count, or where buyers' paywall steps gather. */
  paywall: { n: number; from: "free_episodes" | "journeys" } | null;
  /** The steps that lost the most people (from episode n-1 to n), most first; at most three, the paywall's among them when it is one. */
  drops: { n: number; lost: number; share_lost: number | null }[];
};

/**
 * The episode where the paywall stands: after the series' free episodes when crazydramas says how many; else the
 * episode most of the buyers' paywall steps in that series name; else unknown.
 */
export function paywallEpisode(series: Pick<CdStatsSeries, "drama_id" | "free_episodes" | "episode_count">, journeys?: Record<string, CdStatsJourneyStep[]>): EpisodeCurve["paywall"] {
  if (series.free_episodes > 0 && (series.episode_count === 0 || series.free_episodes < series.episode_count)) return { n: series.free_episodes + 1, from: "free_episodes" };
  const counts = new Map<number, number>();
  for (const steps of Object.values(journeys ?? {})) {
    for (const s of steps) if (s.kind === "paywall" && s.drama_id === series.drama_id && s.episode) counts.set(s.episode, (counts.get(s.episode) ?? 0) + 1);
  }
  let best: [number, number] | null = null;
  for (const [n, c] of counts) if (!best || c > best[1] || (c === best[1] && n < best[0])) best = [n, c];
  return best ? { n: best[0], from: "journeys" } : null;
}

/** The biggest losses between consecutive episodes, in people (a big episode losing 30% outweighs a small one losing 50%). */
export function biggestEpisodeDrops(points: readonly CurvePoint[], max = 3): EpisodeCurve["drops"] {
  const drops: EpisodeCurve["drops"] = [];
  for (let i = 1; i < points.length; i++) {
    const lost = points[i - 1].people - points[i].people;
    if (lost > 0) drops.push({ n: points[i].n, lost, share_lost: share(lost, points[i - 1].people) });
  }
  return drops.sort((a, b) => b.lost - a.lost || a.n - b.n).slice(0, max);
}

/**
 * One series' episode curve over a period (people grouped by the day they first opened it): episode 1 to the last,
 * each as a share of episode 1's starters.
 */
export function episodeCurve(series: CdStatsSeries, span: { from: string; to: string }, journeys?: Record<string, CdStatsJourneyStep[]>): EpisodeCurve {
  const t = seriesTotals(series, span);
  const starters = t.episodes[0] ?? t.started_ep1;
  const last = Math.max(series.episode_count, t.episodes.length);
  const points: CurvePoint[] = [];
  for (let n = 1; n <= last; n++) {
    const people = n === 1 ? starters : (t.episodes[n - 1] ?? 0);
    points.push({ n, people, share: share(people, starters) });
  }
  return { starters, points, paywall: paywallEpisode(series, journeys), drops: biggestEpisodeDrops(points) };
}

export const SERIES_STEPS = ["opened", "started", "finished", "paywall", "checkout", "paid"] as const;
export type SeriesStep = { key: (typeof SERIES_STEPS)[number]; people: number; of_opened: number | null };

/** The path from the page to paying, from the filtered source rows, and the two rates beside it. */
export function seriesFunnel(t: DashTotals): { steps: SeriesStep[]; paywall_to_paid: number | null; revenue_per_buyer_cents: number | null } {
  const people: Record<SeriesStep["key"], number> = {
    opened: t.opened,
    started: t.started_ep1,
    finished: t.finished_ep1,
    paywall: t.paywall,
    checkout: t.checkouts,
    paid: t.buyers,
  };
  return {
    steps: SERIES_STEPS.map((key) => ({ key, people: people[key], of_opened: share(people[key], t.opened) })),
    paywall_to_paid: share(t.buyers, t.paywall),
    revenue_per_buyer_cents: t.buyers > 0 ? Math.round(t.revenue_cents / t.buyers) : null,
  };
}
