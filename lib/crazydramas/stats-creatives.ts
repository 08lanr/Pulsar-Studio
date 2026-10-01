// The Ads tab of /crazydramas/stats and the Clips page's TikTok columns (decision 2026-09-28, "Ad video stats"):
// every ad creative's TikTok numbers, summed across every ad it ran as, in every launch. Pure and client-safe;
// tests/ad-video-stats.test.ts. The numbers come from lib/tiktok/ad-video.ts (TikTok's AUCTION_AD report,
// lifetime or per day); which creative an ad played is `adCreatives` (lib/crazydramas/stats-ads.ts).
//
//   - A creative is a Studio clip (its id), else the content it was made from (a Spark code, a post id).
//   - Counts are summed; every share is recomputed from the sums (a share of plays for how far people watched,
//     of impressions for CTR and checkouts per 1,000), never averaged. The average play is weighted by plays.
//   - Unknown stays null, never zero: an ad TikTok did not answer for leaves its creative's sums unknown
//     (`unknown_ads` says how many); a share with no base (no plays, no impressions) is null.
//   - Under 500 impressions a creative is "early": its numbers show, but it is left out of the benchmark (the
//     median of the creatives with 500+ impressions) and its cells are not marked above or below it.
//
// The reference is the ad-review collector (drama-remix/scripts/ad-review/collect_launches.py), whose math this
// follows: hold2/hold6/p25/p100 = share of plays, average play weighted by plays, checkouts = TikTok's
// `conversion`, checkouts per 1k impressions.

import type { AdFormat } from "@/lib/ad-formats";
import type { ContentKind } from "@/lib/launch/types";
import type { AdVideoNumbers } from "@/lib/tiktok/ad-stats";
import type { AdCreative } from "./stats-ads";
import { oneDay, type StatsRange } from "./stats-summary";

/** Under this many impressions a creative is early: shown, never benchmarked or marked. */
export const EARLY_IMPRESSIONS = 500;
/** A cell is clearly above (or below) the median when it is at least this much higher (lower), relatively. */
export const CLEAR_MARGIN = 0.2;

const KEYS = ["spend_cents", "impressions", "clicks", "conversions", "plays", "watched_2s", "watched_6s", "views_p25", "views_p50", "views_p75", "views_p100", "play_seconds"] as const;

export const ZERO: AdVideoNumbers = Object.fromEntries(KEYS.map((k) => [k, 0])) as AdVideoNumbers;
export const UNKNOWN: AdVideoNumbers = Object.fromEntries(KEYS.map((k) => [k, null])) as AdVideoNumbers;

/** Sums; a metric any part does not know is unknown for the whole. No parts = zero. */
export function sumVideo(parts: readonly AdVideoNumbers[]): AdVideoNumbers {
  const out = { ...ZERO } as Record<(typeof KEYS)[number], number | null>;
  for (const p of parts) for (const k of KEYS) out[k] = out[k] === null || p[k] === null ? null : (out[k] as number) + (p[k] as number);
  return out as AdVideoNumbers;
}

export type VideoRates = {
  ctr: number | null;
  hold_2s: number | null;
  hold_6s: number | null;
  p25: number | null;
  p100: number | null;
  /** Seconds, weighted by plays. */
  avg_play_s: number | null;
  checkouts_per_1k: number | null;
  cost_per_checkout_cents: number | null;
};
export type RateKey = keyof VideoRates;
/** The rates the benchmark compares, and which way is good. */
export const RATE_KEYS: RateKey[] = ["ctr", "hold_2s", "hold_6s", "p25", "p100", "avg_play_s", "checkouts_per_1k", "cost_per_checkout_cents"];
export const LOWER_IS_BETTER: ReadonlySet<RateKey> = new Set(["cost_per_checkout_cents"]);

const over = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : a / b);

export function ratesOf(n: AdVideoNumbers): VideoRates {
  const perK = over(n.conversions, n.impressions);
  return {
    ctr: over(n.clicks, n.impressions),
    hold_2s: over(n.watched_2s, n.plays),
    hold_6s: over(n.watched_6s, n.plays),
    p25: over(n.views_p25, n.plays),
    p100: over(n.views_p100, n.plays),
    avg_play_s: over(n.play_seconds, n.plays),
    checkouts_per_1k: perK === null ? null : perK * 1000,
    cost_per_checkout_cents: n.spend_cents === null || !n.conversions ? null : Math.round(n.spend_cents / n.conversions),
  };
}

export type CreativeRow = {
  /** The clip id, else the content value (a Spark code, a post id), else the ad id. */
  key: string;
  clip_id: string | null;
  kind: ContentKind | null;
  title_id: string | null;
  ad_format: AdFormat | null;
  text: string | null;
  file_path: string | null;
  file_name: string | null;
  /** Every TikTok ad it ran as, and in how many launches. */
  ad_ids: string[];
  launches: number;
  /** Ads TikTok's report did not cover (their ad account did not answer): the sums are unknown then. */
  unknown_ads: number;
  sums: AdVideoNumbers;
  rates: VideoRates;
  early: boolean;
};

/** Which creative an ad played. */
export function creativeKey(c: Pick<AdCreative, "clip_id" | "code" | "ad_id">): string {
  return c.clip_id ?? c.code ?? c.ad_id;
}

/**
 * One row per TikTok creative, its ads' numbers summed (`numbers`: ad id -> the ad's numbers over the span; an
 * ad missing from it was not covered: unknown). Most impressions first.
 */
export function creativeRows(creatives: ReadonlyMap<string, AdCreative>, numbers: Readonly<Record<string, AdVideoNumbers>>): CreativeRow[] {
  const groups = new Map<string, AdCreative[]>();
  for (const c of creatives.values()) {
    if (c.provider !== "tiktok") continue;
    const k = creativeKey(c);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const rows: CreativeRow[] = [];
  for (const [key, ads] of groups) {
    const known = ads.filter((a) => numbers[a.ad_id]);
    const sums = known.length === ads.length ? sumVideo(known.map((a) => numbers[a.ad_id])) : { ...UNKNOWN };
    const first = ads.find((a) => a.clip_id) ?? ads[0];
    rows.push({
      key,
      clip_id: first.clip_id,
      kind: first.kind,
      title_id: ads.find((a) => a.title_id)?.title_id ?? null,
      ad_format: ads.find((a) => a.ad_format)?.ad_format ?? null,
      text: ads.find((a) => a.text)?.text ?? null,
      file_path: ads.find((a) => a.file_path)?.file_path ?? null,
      file_name: ads.find((a) => a.file_name)?.file_name ?? null,
      ad_ids: ads.map((a) => a.ad_id),
      launches: new Set(ads.map((a) => a.run_id)).size,
      unknown_ads: ads.length - known.length,
      sums,
      rates: ratesOf(sums),
      early: sums.impressions === null || sums.impressions < EARLY_IMPRESSIONS,
    });
  }
  return rows.sort((a, b) => (b.sums.impressions ?? -1) - (a.sums.impressions ?? -1) || a.key.localeCompare(b.key));
}

/** The totals of some rows (the headline numbers): the sums of the rows whose sums are known, and how many are not. */
export function totalsOf(rows: readonly CreativeRow[]): { sums: AdVideoNumbers; rates: VideoRates; unknown: number } {
  const known = rows.filter((r) => r.unknown_ads === 0);
  const sums = sumVideo(known.map((r) => r.sums));
  return { sums, rates: ratesOf(sums), unknown: rows.length - known.length };
}

/** The median of the known values; null for none. */
export function median(values: readonly (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export type Benchmark = { n: number; rates: VideoRates };

/** Each rate's median over the creatives with 500+ impressions (the benchmark row). */
export function benchmark(rows: readonly CreativeRow[], min = EARLY_IMPRESSIONS): Benchmark {
  const base = rows.filter((r) => (r.sums.impressions ?? 0) >= min);
  const rates = Object.fromEntries(RATE_KEYS.map((k) => [k, median(base.map((r) => r.rates[k]))])) as VideoRates;
  return { n: base.length, rates };
}

/** "above" / "below" when a value is clearly (20%) better / worse than the median; null otherwise, or for an early row. */
export function versusMedian(value: number | null, med: number | null, key: RateKey, early = false): "above" | "below" | null {
  if (early || value === null || med === null || med === 0) return null;
  const r = (value - med) / med;
  const better = LOWER_IS_BETTER.has(key) ? -r : r;
  return better >= CLEAR_MARGIN ? "above" : better <= -CLEAR_MARGIN ? "below" : null;
}

// ---- periods ----------------------------------------------------------------------------------------------------

type Day = AdVideoNumbers & { day: string };

/**
 * Each covered ad's numbers over [from, to] from its days (a covered ad with no day in the span delivered
 * nothing then); an ad not covered is left out (unknown).
 */
export function numbersIn(days: Readonly<Record<string, readonly Day[]>>, covered: readonly string[], span: { from: string; to: string }): Record<string, AdVideoNumbers> {
  const out: Record<string, AdVideoNumbers> = {};
  for (const id of covered) out[id] = sumVideo((days[id] ?? []).filter((d) => d.day >= span.from && d.day <= span.to));
  return out;
}

/** Every day of a span, oldest first, with the numbers of `ads` added up (days nobody saw an ad are zero). */
export function dailyTotals(days: Readonly<Record<string, readonly Day[]>>, ads: readonly string[], span: { from: string; to: string }): { day: string; sums: AdVideoNumbers; rates: VideoRates }[] {
  const out: { day: string; sums: AdVideoNumbers; rates: VideoRates }[] = [];
  for (let d = span.from; d <= span.to; d = addDays(d, 1)) {
    const sums = sumVideo(ads.flatMap((id) => (days[id] ?? []).filter((x) => x.day === d)));
    out.push({ day: d, sums, rates: ratesOf(sums) });
  }
  return out;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The Ads tab's days for a range ending `today` (yesterday: the day before it): the period (none for "all": each
 * ad's life), the period before of the same length (for the change), and the days the small lines show (the last
 * 14 for one day, the last 30 for all). `read` is the one span of days to ask TikTok for, covering all three.
 */
export function adSpans(range: StatsRange, today: string): {
  span: { from: string; to: string } | null;
  prev: { from: string; to: string } | null;
  chart: { from: string; to: string };
  read: { from: string; to: string };
} {
  const len = oneDay(range) ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : null;
  const end = range === "yesterday" ? addDays(today, -1) : today;
  const span = len === null ? null : { from: addDays(end, -(len - 1)), to: end };
  const prev = len === null || !span ? null : { from: addDays(span.from, -len), to: addDays(span.from, -1) };
  const chart = oneDay(range) ? { from: addDays(end, -13), to: end } : span ?? { from: addDays(today, -29), to: today };
  const from = [chart.from, span?.from, prev?.from].filter((x): x is string => !!x).sort()[0];
  return { span, prev, chart, read: { from, to: today } };
}

/** The change from before to now (0.12 = up 12%); null without a meaningful before (under `min`, or zero). */
export function changeOf(now: number | null, before: number | null, min = 0): number | null {
  return now === null || before === null || before === 0 || before < min ? null : (now - before) / before;
}

/** A share to one decimal ("0.7%", "5.2%", "23.4%"); "–" when unknown. Ad rates are small: "<1%" would hide them. */
export function fmtPct(v: number | null): string {
  return v === null ? "–" : `${(v * 100).toFixed(1)}%`;
}

/** The Clips page's compact cell: each launched clip's lifetime numbers, by clip id (Spark codes and posts left out). */
export type ClipSummary = { impressions: number | null; ctr: number | null; hold_6s: number | null; checkouts: number | null; early: boolean };
export function clipSummaries(rows: readonly CreativeRow[]): Record<string, ClipSummary> {
  const out: Record<string, ClipSummary> = {};
  for (const r of rows) if (r.clip_id) out[r.clip_id] = { impressions: r.sums.impressions, ctr: r.rates.ctr, hold_6s: r.rates.hold_6s, checkouts: r.sums.conversions, early: r.early };
  return out;
}
