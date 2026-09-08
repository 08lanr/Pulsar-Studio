// The market engine: pure functions over MarketSnapshot (schema v2).
// Everything the producer portal shows on the desk is computed here from
// published snapshots, so a number on screen is reproducible from committed
// data and testable without a server (tests/research*.test.ts).
//
// Rules (docs/market-desk-plan.md, metric contracts):
// - Score a WHOLE snapshot first, filter after. Current and previous use the
//   same reference population, so a filter can never fabricate movement.
// - A listing with no observed views and no chart placement has NO score
//   (null), not zero. Missing is not failure.
// - `view_percentile` (lifetime counter, within platform) and
//   `chart_visibility` (the platform's own current placement) are separate.
//   Their combination is called PROMINENCE. It is not momentum; momentum
//   needs history (lib/research/history.ts).
// - Absolute views are never compared across platforms.
// - Trope share is multi-label: shares can sum above 100%. Every share
//   reports its denominator.

import { TROPES, assignTropes, type TropeId } from "./taxonomy";
import type { Audience, CompanyRole, Evidence, MarketSnapshot, MarketTitle, Platform } from "./types";

export const ENGINE_VERSION = "2.0";

// ---- scoring ----------------------------------------------------------------------------------

export type Score = {
  /** 0-100 percentile of the views counter among same-platform listings with a views counter; null if no counter. */
  view_percentile: number | null;
  /** 0-100 from the best chart rank (rank 1 = 100, decaying); null if on no chart. */
  chart_visibility: number | null;
  /** max(view_percentile, chart_visibility); null when both are null. Prominence, not momentum. */
  prominence: number | null;
  best_chart_rank: number | null;
};

function percentileRank(values: number[], v: number): number {
  if (values.length <= 1) return 100;
  let below = 0;
  for (const x of values) if (x < v) below++;
  return Math.round((below / (values.length - 1)) * 100);
}

export function bestChartRank(t: MarketTitle): number | null {
  let best: number | null = null;
  for (const p of t.placements) if (p.chart && p.rank > 0 && (best == null || p.rank < best)) best = p.rank;
  return best;
}

export type Scores = Map<string, Score>;

/** Score every listing of a snapshot against its own platform's population. */
export function scoreSnapshot(snapshot: Pick<MarketSnapshot, "titles">): Scores {
  const byPlatform = new Map<Platform, number[]>();
  for (const t of snapshot.titles) {
    if (t.metrics.views == null) continue;
    const arr = byPlatform.get(t.platform) ?? [];
    arr.push(t.metrics.views.value);
    byPlatform.set(t.platform, arr);
  }
  const out: Scores = new Map();
  for (const t of snapshot.titles) {
    const view_percentile = t.metrics.views == null ? null : percentileRank(byPlatform.get(t.platform) ?? [], t.metrics.views.value);
    const rank = bestChartRank(t);
    const chart_visibility = rank == null ? null : Math.max(1, Math.round(100 - Math.min(rank, 100) * 0.9));
    const prominence = view_percentile == null && chart_visibility == null ? null : Math.max(view_percentile ?? 0, chart_visibility ?? 0);
    out.set(t.key, { view_percentile, chart_visibility, prominence, best_chart_rank: rank });
  }
  return out;
}

export const prominenceOf = (scores: Scores, key: string): number | null => scores.get(key)?.prominence ?? null;

/**
 * Prominence desc, unscored last. Ties: a charted listing beats an
 * uncharted one, a better rank beats a worse one, then the title. Raw views
 * never break a cross-platform tie.
 */
export function rankTitles(titles: MarketTitle[], scores: Scores, limit?: number): MarketTitle[] {
  const sorted = [...titles].sort((a, b) => {
    const pa = prominenceOf(scores, a.key);
    const pb = prominenceOf(scores, b.key);
    if (pa == null && pb != null) return 1;
    if (pb == null && pa != null) return -1;
    if (pa != null && pb != null && pa !== pb) return pb - pa;
    const ra = scores.get(a.key)?.best_chart_rank ?? null;
    const rb = scores.get(b.key)?.best_chart_rank ?? null;
    if (ra != null && rb == null) return -1;
    if (rb != null && ra == null) return 1;
    if (ra != null && rb != null && ra !== rb) return ra - rb;
    return a.title.localeCompare(b.title);
  });
  return limit ? sorted.slice(0, limit) : sorted;
}

// ---- filters ----------------------------------------------------------------------------------

export type MarketFilter = {
  platform?: Platform | "all";
  audience?: Audience | "all";
  trope?: TropeId | null;
  /** Case-insensitive substring on the listing title or blurb. */
  q?: string | null;
};

export function filterTitles(titles: MarketTitle[], f: MarketFilter): MarketTitle[] {
  const q = f.q?.trim().toLowerCase() || null;
  return titles.filter((t) => {
    if (f.platform && f.platform !== "all" && t.platform !== f.platform) return false;
    if (f.audience && f.audience !== "all" && t.audience !== f.audience) return false;
    if (f.trope && !t.tropes.some((x) => x.id === f.trope)) return false;
    if (q && !t.title.toLowerCase().includes(q) && !t.blurb.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ---- trope shares -----------------------------------------------------------------------------

export const COHORT_SIZE = 50;

export type TropeStat = {
  id: TropeId;
  /** Listings carrying the trope in the filtered set. */
  titles: number;
  /** Denominator of `share`: listings in the filtered set. */
  sample: number;
  share: number;
  /** Listings carrying it among the prominence cohort. */
  in_cohort: number;
  /** Denominator of `cohort_share`: the cohort (up to COHORT_SIZE scored listings), with its platform split. */
  cohort: number;
  cohort_by_platform: Partial<Record<Platform, number>>;
  cohort_share: number;
  /** cohort_share / share: > 1 means over-represented among prominent listings (exploratory, not demand). */
  lift: number | null;
  observed_share: number;
  examples: string[];
  /** Change in cohort_share vs the previous snapshot in percentage points; null without comparable history. */
  delta_pts: number | null;
};

export function cohortOf(titles: MarketTitle[], scores: Scores): MarketTitle[] {
  return rankTitles(
    titles.filter((t) => prominenceOf(scores, t.key) != null),
    scores,
    COHORT_SIZE
  );
}

export type Comparable = { titles: MarketTitle[]; scores: Scores; taxonomy_version: string };

export function tropeStats(titles: MarketTitle[], scores: Scores, taxonomy_version: string, previous?: Comparable | null): TropeStat[] {
  const cohortRows = cohortOf(titles, scores);
  const cohort = new Set(cohortRows.map((t) => t.key));
  const cohort_by_platform: Partial<Record<Platform, number>> = {};
  for (const t of cohortRows) cohort_by_platform[t.platform] = (cohort_by_platform[t.platform] ?? 0) + 1;
  const prevShare = previous && previous.taxonomy_version === taxonomy_version ? cohortShareByTrope(previous.titles, previous.scores) : null;
  const out: TropeStat[] = [];
  for (const trope of TROPES) {
    const rows = titles.filter((t) => t.tropes.some((x) => x.id === trope.id));
    if (rows.length === 0) continue;
    const inCohort = rows.filter((t) => cohort.has(t.key)).length;
    const observed = rows.filter((t) => t.tropes.find((x) => x.id === trope.id)?.evidence === "observed").length;
    const share = titles.length ? rows.length / titles.length : 0;
    const cohort_share = cohort.size ? inCohort / cohort.size : 0;
    out.push({
      id: trope.id,
      titles: rows.length,
      sample: titles.length,
      share,
      in_cohort: inCohort,
      cohort: cohort.size,
      cohort_by_platform,
      cohort_share,
      lift: share > 0 && cohort.size >= 10 ? Math.round((cohort_share / share) * 100) / 100 : null,
      observed_share: rows.length ? observed / rows.length : 0,
      examples: rankTitles(rows, scores, 3).map((t) => t.key),
      delta_pts: prevShare ? Math.round((cohort_share - (prevShare.get(trope.id) ?? 0)) * 100) : null,
    });
  }
  return out.sort((a, b) => b.cohort_share - a.cohort_share || b.titles - a.titles || a.id.localeCompare(b.id));
}

function cohortShareByTrope(titles: MarketTitle[], scores: Scores): Map<TropeId, number> {
  const cohort = cohortOf(titles, scores);
  const m = new Map<TropeId, number>();
  for (const trope of TROPES) {
    const n = cohort.filter((t) => t.tropes.some((x) => x.id === trope.id)).length;
    m.set(trope.id, cohort.length ? n / cohort.length : 0);
  }
  return m;
}

/** Co-occurring trope pairs in the filtered set, with supporting examples. */
export type TropePair = { a: TropeId; b: TropeId; titles: number; in_cohort: number; examples: string[] };

export function tropePairs(titles: MarketTitle[], scores: Scores, limit = 12): TropePair[] {
  const cohort = new Set(cohortOf(titles, scores).map((t) => t.key));
  const counts = new Map<string, { a: TropeId; b: TropeId; rows: MarketTitle[] }>();
  for (const t of titles) {
    const ids = t.tropes.map((x) => x.id).sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const k = `${ids[i]}|${ids[j]}`;
        const entry = counts.get(k) ?? { a: ids[i], b: ids[j], rows: [] };
        entry.rows.push(t);
        counts.set(k, entry);
      }
  }
  return Array.from(counts.values())
    .map((e) => ({ a: e.a, b: e.b, titles: e.rows.length, in_cohort: e.rows.filter((t) => cohort.has(t.key)).length, examples: rankTitles(e.rows, scores, 3).map((t) => t.key) }))
    .filter((p) => p.titles >= 3)
    .sort((x, y) => y.in_cohort - x.in_cohort || y.titles - x.titles || x.a.localeCompare(y.a))
    .slice(0, limit);
}

// ---- companies --------------------------------------------------------------------------------

export type CompanyStat = {
  name: string;
  role: CompanyRole;
  evidence: Evidence;
  platforms: Platform[];
  titles: number;
  in_cohort: number;
  top_tropes: TropeId[];
  example_keys: string[];
};

export function companyStats(titles: MarketTitle[], scores: Scores): CompanyStat[] {
  const cohort = new Set(cohortOf(titles, scores).map((t) => t.key));
  const groups = new Map<string, { name: string; role: CompanyRole; evidence: Evidence; rows: MarketTitle[] }>();
  for (const t of titles)
    for (const c of t.companies) {
      const k = `${c.role}|${c.name}`;
      const g = groups.get(k) ?? { name: c.name, role: c.role, evidence: c.evidence, rows: [] };
      g.rows.push(t);
      groups.set(k, g);
    }
  const out: CompanyStat[] = [];
  for (const g of groups.values()) {
    const tropeCount = new Map<TropeId, number>();
    for (const t of g.rows) for (const x of t.tropes) tropeCount.set(x.id, (tropeCount.get(x.id) ?? 0) + 1);
    out.push({
      name: g.name,
      role: g.role,
      evidence: g.evidence,
      platforms: Array.from(new Set(g.rows.map((t) => t.platform))),
      titles: g.rows.length,
      in_cohort: g.rows.filter((t) => cohort.has(t.key)).length,
      top_tropes: Array.from(tropeCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id),
      example_keys: rankTitles(g.rows, scores, 3).map((t) => t.key),
    });
  }
  return out.sort((a, b) => b.in_cohort - a.in_cohort || b.titles - a.titles || a.name.localeCompare(b.name));
}

// ---- formats ----------------------------------------------------------------------------------

export type FormatStat = {
  platform: Platform;
  titles: number;
  with_views: number;
  median_episodes: number | null;
  n_episodes: number;
  median_paywall_episode: number | null;
  n_paywall: number;
  median_episode_seconds: number | null;
  n_episode_seconds: number;
  episode_seconds_basis: "episode_1" | "listed_average" | "mixed" | null;
  platform_new: number;
  female_audience_share: number | null;
  n_audience: number;
};

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function formatStats(titles: MarketTitle[]): FormatStat[] {
  const platforms = Array.from(new Set(titles.map((t) => t.platform))).sort();
  return platforms.map((platform) => {
    const rows = titles.filter((t) => t.platform === platform);
    const withAudience = rows.filter((t) => t.audience);
    const eps = rows.map((t) => t.episode_count).filter((x): x is number => x != null);
    const pay = rows.map((t) => t.paywall_episode).filter((x): x is number => x != null);
    const secs = rows.filter((t) => t.episode_seconds != null);
    const bases = new Set(secs.map((t) => t.episode_seconds_basis));
    return {
      platform,
      titles: rows.length,
      with_views: rows.filter((t) => t.metrics.views != null).length,
      median_episodes: median(eps),
      n_episodes: eps.length,
      median_paywall_episode: median(pay),
      n_paywall: pay.length,
      median_episode_seconds: median(secs.map((t) => t.episode_seconds as number)),
      n_episode_seconds: secs.length,
      episode_seconds_basis: bases.size === 0 ? null : bases.size === 1 ? (Array.from(bases)[0] as "episode_1" | "listed_average") : "mixed",
      platform_new: rows.filter((t) => t.platform_new).length,
      female_audience_share: withAudience.length ? withAudience.filter((t) => t.audience === "female").length / withAudience.length : null,
      n_audience: withAudience.length,
    };
  });
}

// ---- similarity and the producer's catalog ---------------------------------------------------

/** Jaccard overlap on trope ids, ties broken by prominence. Similarity is not identity. */
export function similarTitles(target: MarketTitle, titles: MarketTitle[], scores: Scores, limit = 6): { title: MarketTitle; overlap: TropeId[]; score: number }[] {
  const mine = new Set(target.tropes.map((x) => x.id));
  if (mine.size === 0) return [];
  return titles
    .filter((t) => t.key !== target.key)
    .map((t) => {
      const theirs = t.tropes.map((x) => x.id);
      const overlap = theirs.filter((id) => mine.has(id));
      const union = mine.size + theirs.length - overlap.length;
      return { title: t, overlap, score: union ? overlap.length / union : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (prominenceOf(scores, b.title.key) ?? -1) - (prominenceOf(scores, a.title.key) ?? -1))
    .slice(0, limit);
}

export type CatalogRow = { id: string; name_zh: string; name_en: string | null; genre: string | null; synopsis_zh: string | null; synopsis_en: string | null };

/** Tag one of the producer's own titles with the same taxonomy (inferred: from its synopsis). */
export function tagCatalogTitle(input: Omit<CatalogRow, "id">): TropeId[] {
  return assignTropes({
    platform_tags: [],
    title: `${input.name_zh} ${input.name_en ?? ""}`,
    blurb: `${input.genre ?? ""} ${input.synopsis_zh ?? ""} ${input.synopsis_en ?? ""}`,
  }).map((x) => x.id);
}

export type CatalogMatch = {
  title_id: string;
  tropes: TropeId[];
  /** Mean cohort_share of its tropes, in points (0-100); null when untagged. Similarity to prominent listings, not success probability. */
  market_score: number | null;
  hot_tropes: TropeId[];
  comparable_keys: string[];
  /** Why: which trope contributed what. */
  explanation: { trope: TropeId; cohort_share: number }[];
};

export function catalogMatches(catalog: { id: string; tropes: TropeId[] }[], stats: TropeStat[], titles: MarketTitle[], scores: Scores): CatalogMatch[] {
  const byId = new Map(stats.map((s) => [s.id, s]));
  const hot = new Set(stats.slice(0, 10).map((s) => s.id));
  return catalog
    .map((c) => {
      const explanation = c.tropes.map((id) => ({ trope: id, cohort_share: byId.get(id)?.cohort_share ?? 0 }));
      const mine = new Set(c.tropes);
      const comparable = titles
        .filter((t) => t.tropes.some((x) => mine.has(x.id)))
        .map((t) => ({ t, overlap: t.tropes.filter((x) => mine.has(x.id)).length }))
        .sort((a, b) => b.overlap - a.overlap || (prominenceOf(scores, b.t.key) ?? -1) - (prominenceOf(scores, a.t.key) ?? -1))
        .slice(0, 4)
        .map((x) => x.t.key);
      return {
        title_id: c.id,
        tropes: c.tropes,
        market_score: explanation.length ? Math.round((explanation.reduce((a, e) => a + e.cohort_share, 0) / explanation.length) * 100) : null,
        hot_tropes: c.tropes.filter((id) => hot.has(id)),
        comparable_keys: comparable,
        explanation,
      };
    })
    .sort((a, b) => (b.market_score ?? -1) - (a.market_score ?? -1));
}

export type Opportunities = { producing_hot: TropeStat[]; hot_not_producing: TropeStat[]; producing_cold: TropeStat[] };

export function profileOpportunities(profileTropes: TropeId[], stats: TropeStat[]): Opportunities {
  const mine = new Set(profileTropes);
  const hot = stats.slice(0, 10);
  const hotIds = new Set(hot.map((s) => s.id));
  return {
    producing_hot: hot.filter((s) => mine.has(s.id)),
    hot_not_producing: hot.filter((s) => !mine.has(s.id)).slice(0, 5),
    producing_cold: stats.filter((s) => mine.has(s.id) && !hotIds.has(s.id)),
  };
}

// ---- premise examples -------------------------------------------------------------------------

export type PremiseExample = { key: string; title: string; platform: Platform; sentence: string; tropes: TropeId[] };

/**
 * The opening sentence of prominent listings' blurbs. These are premise
 * EXAMPLES, not tested hooks: no creative-outcome evidence exists here.
 */
export function premiseExamples(tropes: TropeId[], titles: MarketTitle[], scores: Scores, limit = 8): PremiseExample[] {
  const wanted = new Set(tropes);
  const rows = wanted.size ? titles.filter((t) => t.tropes.some((x) => wanted.has(x.id))) : titles;
  return rankTitles(rows, scores, limit * 2)
    .map((t) => ({
      key: t.key,
      title: t.title,
      platform: t.platform,
      sentence: firstSentence(t.blurb),
      tropes: t.tropes.filter((x) => wanted.size === 0 || wanted.has(x.id)).map((x) => x.id),
    }))
    .filter((h) => h.sentence.length >= 30)
    .slice(0, limit);
}

export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const m = clean.match(/^(.{20,220}?[.!?…])(\s|$)/);
  if (m) return m[1].trim();
  if (clean.length <= 200) return clean;
  const cut = clean.slice(0, 200);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 120)).trim()}…`;
}

// ---- templated observations -------------------------------------------------------------------

/**
 * Insight copy is templated and cites the listings/stats it was computed
 * from. Every template is defensible from the snapshot alone ("chart
 * visibility", "listings"); none claims audience demand.
 */
export type Insight =
  | { kind: "trope_lift"; trope: TropeId; lift: number; in_cohort: number; cohort: number; titles: number; sample: number; refs: string[] }
  | { kind: "paywall_gap"; a: Platform; a_median: number; a_n: number; b: Platform; b_median: number; b_n: number }
  | { kind: "new_listings"; platform: Platform; count: number; refs: string[] }
  | { kind: "audience_split"; platform: Platform; female_share: number; n: number };

export function insights(titles: MarketTitle[], scores: Scores, stats: TropeStat[], formats: FormatStat[]): Insight[] {
  const out: Insight[] = [];
  const lifted = stats.filter((s) => s.lift != null && s.lift >= 1.4 && s.in_cohort >= 5).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
  for (const s of lifted.slice(0, 2)) out.push({ kind: "trope_lift", trope: s.id, lift: s.lift!, in_cohort: s.in_cohort, cohort: s.cohort, titles: s.titles, sample: s.sample, refs: s.examples });
  const withPay = formats.filter((f) => f.median_paywall_episode != null && f.n_paywall >= 10);
  if (withPay.length >= 2 && withPay[0].median_paywall_episode !== withPay[1].median_paywall_episode) {
    const [a, b] = withPay;
    out.push({ kind: "paywall_gap", a: a.platform, a_median: a.median_paywall_episode!, a_n: a.n_paywall, b: b.platform, b_median: b.median_paywall_episode!, b_n: b.n_paywall });
  }
  for (const f of formats) {
    if (f.platform_new >= 5) {
      const fresh = rankTitles(titles.filter((t) => t.platform === f.platform && t.platform_new), scores, 3);
      out.push({ kind: "new_listings", platform: f.platform, count: f.platform_new, refs: fresh.map((t) => t.key) });
    }
  }
  const aud = formats.filter((f) => f.female_audience_share != null && f.n_audience >= 20);
  if (aud.length) out.push({ kind: "audience_split", platform: aud[0].platform, female_share: aud[0].female_audience_share!, n: aud[0].n_audience });
  return out.slice(0, 4);
}

export function findTitle(snapshot: MarketSnapshot, key: string): MarketTitle | null {
  return snapshot.titles.find((t) => t.key === key) ?? null;
}
