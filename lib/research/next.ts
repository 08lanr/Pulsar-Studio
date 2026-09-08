// What to make next: the freshest listings on each US platform and the story
// types they carry, so a producer can decide what to shoot now rather than
// which existing title to launch.
//
// Contracts (same rules as the rest of the market desk):
// - "Fresh" is observed, and every reason is kept: the platform's own new
//   flag, its newest list, a release date within FRESH_DAYS, or first seen by
//   Studio on the latest published day (needs history).
// - Growth needs two published days (lib/research/history.ts). Before that
//   every growth value is null and the board says "collecting history".
//   Nothing here invents a zero.
// - Raw counters stay within a platform: listings are grouped per platform
//   and ranked within it. Story-type shares are shares of the fresh cohort,
//   multi-label, with their denominators.
// - A recipe is templated from the snapshot (inferred). It is a starting
//   point for a clone brief, never a claim about audience demand.

import { firstSentence, formatStats, prominenceOf, rankTitles, scoreSnapshot, type FormatStat, type Scores } from "./engine";
import { counterMovement, firstSeen, rankMovement, type CounterMovement, type RankMovement } from "./history";
import { TROPES, type TropeId } from "./taxonomy";
import type { MarketSnapshot, MarketTitle, Observation, Platform } from "./types";

export const NEXT_VERSION = "1.0";
/** A platform release date this recent counts as fresh. */
export const FRESH_DAYS = 30;
/** Platform lists whose membership means "the platform calls this new". */
const NEW_LISTS = new Set(["new", "newest"]);
const MS_PER_DAY = 86_400_000;

export type FreshReason =
  | { kind: "platform_new" }
  | { kind: "released"; date: string; days_ago: number }
  | { kind: "new_list"; list: string; name: string; rank: number }
  | { kind: "first_seen"; date: string };

export type FreshTitle = {
  title: MarketTitle;
  prominence: number | null;
  reasons: FreshReason[];
  /** Earliest published day Studio saw this listing; null until history exists. */
  first_seen: string | null;
  /** Days between the platform's release date and the observation; null when the platform exposes no date. */
  days_since_release: number | null;
  views: Observation | null;
  growth: CounterMovement;
  best_chart: { list: string; name: string; rank: number } | null;
  chart: RankMovement | null;
  premise: string;
};

export type RisingTrope = {
  id: TropeId;
  /** Fresh listings carrying the trope and the fresh cohort size (its denominator). */
  fresh_titles: number;
  fresh_sample: number;
  fresh_share: number;
  /** The same share across every listing in the snapshot. */
  titles: number;
  sample: number;
  share: number;
  /** fresh_share / share: > 1 means the platforms are launching more of this than they carry. */
  lift: number | null;
  by_platform: Partial<Record<Platform, number>>;
  /** Median day-over-day growth (%) of the fresh listings carrying the trope; null without history or a baseline. */
  growth_pct: number | null;
  n_growth: number;
  /** The trope most often launched together with this one in the fresh cohort. */
  pair: TropeId | null;
  pair_titles: number;
  /** Fresh listing keys, most prominent first. */
  examples: string[];
  premises: { key: string; title: string; platform: Platform; sentence: string }[];
  /** The producer's own titles that already carry this trope. */
  catalog_ids: string[];
};

export type PlatformBoard = {
  platform: Platform;
  sample: number;
  fresh: number;
  with_views: number;
  format: FormatStat | null;
  /** Fresh listings, ranked by growth when history exists, else by prominence. */
  titles: FreshTitle[];
  /** Any listing with a comparable counter, fastest growing first. Empty while collecting history. */
  movers: FreshTitle[];
};

export type NextWindow = { state: "collecting_history" } | { state: "ok"; start: string; end: string; days: number };

export type NextBoard = {
  version: string;
  taxonomy_version: string;
  observed_at: string;
  window: NextWindow;
  fresh_sample: number;
  sample: number;
  platforms: PlatformBoard[];
  tropes: RisingTrope[];
};

export type NextInput = {
  latest: MarketSnapshot;
  /** The newest snapshot of the most recent earlier day; null with one day of history. */
  previous: MarketSnapshot | null;
  /** Every published day's snapshot, oldest first (lib/research/snapshot.ts snapshotHistory). */
  history: MarketSnapshot[];
  /** Days published: [date, run_id]. Two distinct days turn growth on. */
  days: [string, string][];
  /** The producer's own titles tagged with the taxonomy, for "you already have N like this". */
  catalog?: { id: string; tropes: TropeId[] }[];
  scores?: Scores;
  limits?: { titles?: number; movers?: number; tropes?: number };
};

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / MS_PER_DAY);
}

export function freshReasons(t: MarketTitle, observed_at: string, first_seen: string | null, windowOk: boolean): FreshReason[] {
  const out: FreshReason[] = [];
  if (t.platform_new) out.push({ kind: "platform_new" });
  if (t.released_at) {
    const ago = daysBetween(t.released_at, observed_at);
    if (ago >= 0 && ago <= FRESH_DAYS) out.push({ kind: "released", date: t.released_at, days_ago: ago });
  }
  const list = [...t.placements].filter((p) => NEW_LISTS.has(p.list)).sort((a, b) => a.rank - b.rank)[0];
  if (list) out.push({ kind: "new_list", list: list.list, name: list.name, rank: list.rank });
  if (windowOk && first_seen === observed_at) out.push({ kind: "first_seen", date: first_seen });
  return out;
}

function bestChart(t: MarketTitle): { list: string; name: string; rank: number } | null {
  const c = [...t.placements].filter((p) => p.chart).sort((a, b) => a.rank - b.rank)[0];
  return c ? { list: c.list, name: c.name, rank: c.rank } : null;
}

function growthRank(g: CounterMovement): number {
  return g.state === "ok" ? g.per_day : -1;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

export function whatToMakeNext(input: NextInput): NextBoard {
  const { latest, previous, history, days } = input;
  const scores = input.scores ?? scoreSnapshot(latest);
  const distinctDays = new Set(days.map(([d]) => d)).size;
  const windowOk = distinctDays >= 2 && previous != null && previous.observed_at !== latest.observed_at;
  const window: NextWindow = windowOk
    ? { state: "ok", start: previous!.observed_at, end: latest.observed_at, days: Math.max(1, daysBetween(previous!.observed_at, latest.observed_at)) }
    : { state: "collecting_history" };
  const prevByKey = new Map((previous?.titles ?? []).map((t) => [t.key, t]));
  const limits = { titles: 12, movers: 8, tropes: 10, ...input.limits };

  const describe = (t: MarketTitle): FreshTitle => {
    const seen = windowOk ? firstSeen(t.key, history) : null;
    const prev = prevByKey.get(t.key) ?? null;
    const chart = bestChart(t);
    return {
      title: t,
      prominence: prominenceOf(scores, t.key),
      reasons: freshReasons(t, latest.observed_at, seen, windowOk),
      first_seen: seen,
      days_since_release: t.released_at ? daysBetween(t.released_at, latest.observed_at) : null,
      views: t.metrics.views,
      growth: counterMovement("views", t, prev, windowOk),
      best_chart: chart,
      chart: chart ? rankMovement(chart.list, t, prev, windowOk) : null,
      premise: firstSentence(t.blurb),
    };
  };

  const all = latest.titles.map(describe);
  const fresh = all.filter((x) => x.reasons.length > 0);
  const byProminence = (a: FreshTitle, b: FreshTitle) => (b.prominence ?? -1) - (a.prominence ?? -1) || a.title.key.localeCompare(b.title.key);
  const byGrowth = (a: FreshTitle, b: FreshTitle) => growthRank(b.growth) - growthRank(a.growth) || byProminence(a, b);
  const formats = formatStats(latest.titles);

  const platforms: PlatformBoard[] = latest.platforms
    .map((p) => p.id)
    .map((platform) => {
      const rows = all.filter((x) => x.title.platform === platform);
      const freshRows = fresh.filter((x) => x.title.platform === platform).sort(windowOk ? byGrowth : byProminence);
      const movers = windowOk ? rows.filter((x) => x.growth.state === "ok" && x.growth.per_day > 0).sort(byGrowth).slice(0, limits.movers) : [];
      return {
        platform,
        sample: rows.length,
        fresh: freshRows.length,
        with_views: rows.filter((x) => x.views != null).length,
        format: formats.find((f) => f.platform === platform) ?? null,
        titles: freshRows.slice(0, limits.titles),
        movers,
      };
    });

  // Story types among fresh listings, against their share of the whole snapshot.
  const freshTitles = fresh.map((x) => x.title);
  const catalog = input.catalog ?? [];
  const tropes: RisingTrope[] = [];
  for (const trope of TROPES) {
    const freshRows = freshTitles.filter((t) => t.tropes.some((x) => x.id === trope.id));
    if (freshRows.length === 0) continue;
    const allRows = latest.titles.filter((t) => t.tropes.some((x) => x.id === trope.id));
    const share = latest.titles.length ? allRows.length / latest.titles.length : 0;
    const fresh_share = freshTitles.length ? freshRows.length / freshTitles.length : 0;
    const by_platform: Partial<Record<Platform, number>> = {};
    for (const t of freshRows) by_platform[t.platform] = (by_platform[t.platform] ?? 0) + 1;
    const pairCounts = new Map<TropeId, number>();
    for (const t of freshRows) for (const x of t.tropes) if (x.id !== trope.id) pairCounts.set(x.id, (pairCounts.get(x.id) ?? 0) + 1);
    const pair = [...pairCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? null;
    const growths = windowOk
      ? freshRows.map((t) => counterMovement("views", t, prevByKey.get(t.key) ?? null, true)).flatMap((g) => (g.state === "ok" && g.growth_pct != null ? [g.growth_pct] : []))
      : [];
    const ranked = rankTitles(freshRows, scores, 6);
    tropes.push({
      id: trope.id,
      fresh_titles: freshRows.length,
      fresh_sample: freshTitles.length,
      fresh_share,
      titles: allRows.length,
      sample: latest.titles.length,
      share,
      lift: share > 0 && freshTitles.length >= 10 ? Math.round((fresh_share / share) * 100) / 100 : null,
      by_platform,
      growth_pct: median(growths),
      n_growth: growths.length,
      pair: pair?.[0] ?? null,
      pair_titles: pair?.[1] ?? 0,
      examples: ranked.map((t) => t.key),
      premises: ranked
        .map((t) => ({ key: t.key, title: t.title, platform: t.platform, sentence: firstSentence(t.blurb) }))
        .filter((p) => p.sentence.length >= 30)
        .slice(0, 4),
      catalog_ids: catalog.filter((c) => c.tropes.includes(trope.id)).map((c) => c.id),
    });
  }
  tropes.sort((a, b) => b.fresh_titles - a.fresh_titles || (b.lift ?? 0) - (a.lift ?? 0) || a.id.localeCompare(b.id));

  return {
    version: NEXT_VERSION,
    taxonomy_version: latest.taxonomy_version,
    observed_at: latest.observed_at,
    window,
    fresh_sample: fresh.length,
    sample: latest.titles.length,
    platforms,
    tropes: tropes.slice(0, limits.tropes),
  };
}
