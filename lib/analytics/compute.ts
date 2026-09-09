// Title analytics computation: one pure function from a normalized dataset
// (lib/analytics/dataset.ts) plus the title's existing Studio rows to the
// record the four views render (lib/analytics/types.ts). Both backends and
// the tests call it; the demo fixture and a future provider connector only
// differ in where the dataset comes from.
//
// Rules kept here, not in the UI: a rate is always numerator / denominator
// of fields the record also carries; daily additive values sum to the period;
// unique users use the dataset's period-dedupe model rather than a sum;
// missing is null with a reason, never 0; comparisons need two fully
// covered periods; cohort D7/D30 count only elapsed cohorts; attributed
// revenue comes from the campaign rows and is bounded by title revenue;
// nothing here says why a number moved.

import { addDays, daysBetween } from "@/data/fixture/demo-analytics";
import { BENCHMARK } from "@/lib/research/assessment";
import type { CreativeResult, PromoCampaign } from "@/lib/types";
import type { DailyRow, EpisodeDailyRow, TitleDataset } from "./dataset";
import { definition } from "./definitions";
import type {
  AcquisitionView,
  AnalyticsLink,
  AnalyticsListing,
  AnalyticsRange,
  AnalyticsState,
  CampaignAnalytics,
  CohortMeasure,
  Comparison,
  EpisodeFlag,
  EpisodeRow,
  EpisodesView,
  Freshness,
  FunnelStep,
  FunnelView,
  Headline,
  Metric,
  OverviewView,
  ProvenanceSource,
  RateMetric,
  ReportingPeriod,
  RevenueView,
  SeriesPoint,
  Takeaway,
  TitleAnalytics,
  TitlePerformanceRow,
  WaterfallStep,
} from "./types";
import { RANGE_DAYS } from "./types";

export const ANALYTICS_VERSION = "1.0";
export const STALE_AFTER_DAYS = 7;
export const MIN_EPISODE_SAMPLE = 100;

export type ComputeInput = {
  title: { id: string; producer_id: string; name_zh: string; name_en: string | null; episode_count: number };
  episodes: { id: string; number: number }[];
  listing: AnalyticsListing | null;
  link: AnalyticsLink | null;
  dataset: TitleDataset | null;
  campaigns: PromoCampaign[];
  results: CreativeResult[];
  range: AnalyticsRange;
  today: string;
};

// ---- metric helpers ------------------------------------------------------------------------

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function prov(key: string, source: ProvenanceSource, observed_at: string | null) {
  const d = definition(key);
  return { source, evidence: d?.evidence ?? "partner_reported", definition_key: key, observed_at } as const;
}

export function metric(key: string, value: number | null, source: ProvenanceSource, observed_at: string | null, opts: { availability?: Metric["availability"]; reason?: string | null } = {}): Metric {
  if (value == null) return { value: null, availability: opts.availability ?? "unavailable", provenance: prov(key, source, observed_at), reason: opts.reason ?? "an.reason.notReported" };
  return { value, availability: opts.availability ?? "available", provenance: prov(key, source, observed_at), reason: opts.reason ?? null };
}

export function unavailable(key: string, reason: string, source: ProvenanceSource = "demo", availability: Metric["availability"] = "unavailable"): Metric {
  return { value: null, availability, provenance: prov(key, source, null), reason };
}

export function rate(key: string, numerator: number | null, denominator: number | null, denominator_key: string, source: ProvenanceSource, observed_at: string | null, reason?: string): RateMetric {
  if (numerator == null || denominator == null) return { ...unavailable(key, reason ?? "an.reason.notReported", source), numerator, denominator, denominator_key };
  if (denominator === 0) return { ...unavailable(key, "an.reason.zeroDenominator", source, "not_applicable"), numerator, denominator, denominator_key };
  return { value: r4(numerator / denominator), availability: "available", provenance: prov(key, source, observed_at), numerator, denominator, denominator_key, reason: null };
}

function pctChange(now: number | null, prev: number | null): Comparison | null {
  if (now == null || prev == null) return null;
  if (prev === 0) return { kind: "not_comparable", reason: "an.reason.zeroBaseline" };
  return { kind: "pct_change", value: r4((now - prev) / prev), previous: prev };
}

function ppChange(now: number | null, prev: number | null): Comparison | null {
  if (now == null || prev == null) return null;
  return { kind: "pp_change", value: r4(now - prev), previous: prev };
}

// ---- periods ---------------------------------------------------------------------------------

function periodFor(ds: TitleDataset, range: AnalyticsRange, to: string): ReportingPeriod {
  const days = RANGE_DAYS[range];
  const from = addDays(to, -(days - 1));
  const covered = ds.daily.filter((d) => d.date >= from && d.date <= to).length;
  return { from, to, timezone: "UTC", currency: "USD", days, covered_days: covered };
}

function sliceDaily(ds: TitleDataset, p: ReportingPeriod): DailyRow[] {
  return ds.daily.filter((d) => d.date >= p.from && d.date <= p.to);
}

type Totals = {
  new_viewers: number; returning_viewers: number; daily_viewer_sum: number; starts: number; completions: number; watch_seconds: number; entries: number; playbacks: number; paywall_reached: number; unlock_attempts: number; unlock_success: number; continued_after_unlock: number;
  recharge_orders: number; recharge_gmv_usd: number; refunds_usd: number; redeem_orders: number; redeem_coins: number; ad_impressions: number | null; ad_revenue_usd: number | null; new_payers: number; returning_payers: number;
  viewers: number; paying_users: number; repeat_payers: number;
};

/** Period totals: additive sums, plus the two deduplicated user counts from the dataset's dedupe model. */
export function totals(rows: DailyRow[], dedupe: TitleDataset["dedupe"]): Totals {
  const s = (f: (r: DailyRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const adRows = rows.filter((r) => r.ad_revenue_usd != null);
  const adAvailable = rows.length > 0 && adRows.length === rows.length;
  const t: Totals = {
    new_viewers: s((r) => r.new_viewers),
    returning_viewers: s((r) => r.returning_viewers),
    daily_viewer_sum: s((r) => r.new_viewers + r.returning_viewers),
    starts: s((r) => r.starts),
    completions: s((r) => r.completions),
    watch_seconds: s((r) => r.watch_seconds),
    entries: s((r) => r.entries),
    playbacks: s((r) => r.playbacks),
    paywall_reached: s((r) => r.paywall_reached),
    unlock_attempts: s((r) => r.unlock_attempts),
    unlock_success: s((r) => r.unlock_success),
    continued_after_unlock: s((r) => r.continued_after_unlock),
    recharge_orders: s((r) => r.recharge_orders),
    recharge_gmv_usd: r2(s((r) => r.recharge_gmv_usd)),
    refunds_usd: r2(s((r) => r.refunds_usd)),
    redeem_orders: s((r) => r.redeem_orders),
    redeem_coins: s((r) => r.redeem_coins),
    ad_impressions: adAvailable ? s((r) => r.ad_impressions ?? 0) : null,
    ad_revenue_usd: adAvailable ? r2(s((r) => r.ad_revenue_usd ?? 0)) : null,
    new_payers: s((r) => r.new_payers),
    returning_payers: s((r) => r.returning_payers),
    viewers: 0,
    paying_users: 0,
    repeat_payers: 0,
  };
  // Period-unique users: every new user is distinct by definition; returning
  // users repeat across days, so only the dedupe share of them are distinct.
  t.viewers = t.new_viewers + Math.round(t.returning_viewers * dedupe.viewers);
  t.repeat_payers = Math.round(t.returning_payers * dedupe.payers);
  t.paying_users = t.new_payers + t.repeat_payers;
  return t;
}

// ---- state and freshness ------------------------------------------------------------------

export function deriveState(link: AnalyticsLink | null, ds: TitleDataset | null, period: ReportingPeriod | null, today: string): AnalyticsState {
  if (!link || !ds) return "needs_listing_link";
  if (!ds.daily.length) return "linked_awaiting_data";
  if (ds.sync_status === "failed") return "sync_failed";
  if (daysBetween(ds.data_through, today) > STALE_AFTER_DAYS) return "stale";
  if (period && period.covered_days < period.days) return "partial";
  return "available";
}

function freshness(state: AnalyticsState, ds: TitleDataset | null, listing: AnalyticsListing | null, today: string): Freshness {
  const through = ds?.daily.length ? ds.data_through : null;
  const lag = through ? daysBetween(through, today) : null;
  const notes: string[] = [];
  if (ds?.unavailable.length) notes.push(...ds.unavailable.map((k) => `an.note.unavailable.${k}`));
  if (ds?.episode_attribution === "unavailable") notes.push("an.note.noEpisodeAttribution");
  return {
    state,
    last_sync_at: ds?.last_sync_at ?? listing?.last_sync_at ?? null,
    data_through: through,
    lag_days: lag,
    stale: state === "stale",
    sync_status: ds?.sync_status ?? listing?.sync_status ?? null,
    source_label: listing?.platform_label ?? "",
    notes,
  };
}

// ---- overview ---------------------------------------------------------------------------------

function overview(ds: TitleDataset, p: ReportingPeriod, prev: ReportingPeriod | null, t: Totals, tp: Totals | null, base: string, epView: EpisodesView | null, fun: FunnelView, acq: AcquisitionView, rev: RevenueView): OverviewView {
  const at = ds.last_sync_at;
  const src: ProvenanceSource = ds.source;
  const conv = rate("payer_conversion", t.paying_users, t.viewers, "an.denom.viewers", "pulsar_derived", at);
  const convPrev = tp ? rate("payer_conversion", tp.paying_users, tp.viewers, "an.denom.viewers", "pulsar_derived", at) : null;
  const comp = rate("completion_rate", t.completions, t.starts, "an.denom.starts", "pulsar_derived", at);
  const compPrev = tp ? rate("completion_rate", tp.completions, tp.starts, "an.denom.starts", "pulsar_derived", at) : null;
  const headlines: Headline[] = [
    { key: "viewers", unit: "count", metric: metric("viewers", t.viewers, src, at), comparison: prev ? pctChange(t.viewers, tp?.viewers ?? null) : null },
    { key: "iap_gross", unit: "usd", metric: metric("iap_gross", t.recharge_gmv_usd, src, at), comparison: prev ? pctChange(t.recharge_gmv_usd, tp?.recharge_gmv_usd ?? null) : null, href: `${base}/revenue` },
    { key: "paying_users", unit: "count", metric: metric("paying_users", t.paying_users, src, at), comparison: prev ? pctChange(t.paying_users, tp?.paying_users ?? null) : null, href: `${base}/revenue` },
    { key: "payer_conversion", unit: "rate", metric: conv, comparison: prev ? ppChange(conv.value, convPrev?.value ?? null) : null, href: `${base}/revenue` },
    { key: "completion_rate", unit: "rate", metric: comp, comparison: prev ? ppChange(comp.value, compPrev?.value ?? null) : null, href: `${base}/episodes` },
  ];
  const series: SeriesPoint[] = sliceDaily(ds, p).map((d) => ({ date: d.date, viewers: d.new_viewers + d.returning_viewers, starts: d.starts, iap_gross_usd: d.recharge_gmv_usd, ad_revenue_usd: d.ad_revenue_usd, new_payers: d.new_payers }));
  const viewing = [
    { key: "viewers", unit: "count" as const, metric: metric("viewers", t.viewers, src, at) },
    { key: "new_viewers", unit: "count" as const, metric: metric("new_viewers", t.new_viewers, src, at) },
    { key: "starts", unit: "count" as const, metric: metric("starts", t.starts, src, at) },
    { key: "completions", unit: "count" as const, metric: metric("completions", t.completions, src, at) },
    { key: "completion_rate", unit: "rate" as const, metric: comp },
    { key: "watch_seconds_avg", unit: "count" as const, metric: rate("watch_seconds_avg", t.watch_seconds, t.starts, "an.denom.starts", "pulsar_derived", at) },
  ];
  const monetization = [
    { key: "iap_gross", unit: "usd" as const, metric: metric("iap_gross", t.recharge_gmv_usd, src, at) },
    { key: "ad_revenue", unit: "usd" as const, metric: t.ad_revenue_usd == null ? unavailable("ad_revenue", "an.reason.componentUnavailable", src) : metric("ad_revenue", t.ad_revenue_usd, src, at) },
    { key: "paying_users", unit: "count" as const, metric: metric("paying_users", t.paying_users, src, at) },
    { key: "payer_conversion", unit: "rate" as const, metric: conv },
    { key: "arppu", unit: "usd_per_user" as const, metric: rate("arppu", t.recharge_gmv_usd, t.paying_users, "an.denom.payingUsers", "pulsar_derived", at) },
    { key: "recharge_orders", unit: "count" as const, metric: metric("recharge_orders", t.recharge_orders, src, at) },
  ];
  return { headlines, series, viewing, monetization, takeaways: takeaways(epView, fun, acq, rev, headlines, p, t), previous_period: prev };
}

function takeaways(ep: EpisodesView | null, fun: FunnelView, acq: AcquisitionView, rev: RevenueView, headlines: Headline[], p: ReportingPeriod, t: Totals): Takeaway[] {
  const out: Takeaway[] = [];
  // 1. The largest continuation loss between consecutive episodes.
  if (ep && ep.rows.length > 1) {
    const cands = ep.rows.filter((r) => r.continuation.value != null && !r.small_sample);
    const worst = cands.reduce<EpisodeRow | null>((w, r) => (w == null || (r.continuation.value ?? 1) < (w.continuation.value ?? 1) ? r : w), null);
    if (worst && (worst.continuation.value ?? 1) < 0.5) out.push({ key: "an.take.continuation", vars: { n: worst.number, next: worst.number + 1, pct: Math.round((worst.continuation.value ?? 0) * 100) }, view: "episodes" });
  }
  // 2. Payer conversion movement vs the previous period (only when comparable).
  const conv = headlines.find((h) => h.key === "payer_conversion");
  if (conv?.comparison?.kind === "pp_change" && Math.abs(conv.comparison.value) >= 0.005) {
    out.push({ key: conv.comparison.value < 0 ? "an.take.conversionDown" : "an.take.conversionUp", vars: { pp: Math.abs(r2(conv.comparison.value * 100)), pct: r2((conv.metric.value ?? 0) * 100) }, view: "revenue" });
  }
  // 3. Revenue mix.
  if (rev.mix.iap_share.value != null) {
    const share = rev.mix.iap_share.value;
    if (share <= 0.6) out.push({ key: "an.take.adsShare", vars: { pct: Math.round((1 - share) * 100) }, view: "revenue" });
    else if (share >= 0.85) out.push({ key: "an.take.iapShare", vars: { pct: Math.round(share * 100) }, view: "revenue" });
  }
  // 4. The largest funnel loss.
  if (fun.largest_loss_key) {
    const i = fun.steps.findIndex((s) => s.key === fun.largest_loss_key);
    const step = fun.steps[i];
    if (i > 0 && step.loss_from_previous?.value != null) out.push({ key: "an.take.funnel", vars: { pct: Math.round(step.loss_from_previous.value * 100) }, view: "revenue" });
  }
  // 5. Attribution boundary, or no campaign.
  const withRev = acq.campaigns.filter((c) => c.attributed_revenue_usd.value != null);
  if (withRev.length && t.recharge_gmv_usd > 0) {
    const sum = withRev.reduce((a, c) => a + (c.attributed_revenue_usd.value ?? 0), 0);
    out.push({ key: "an.take.attributed", vars: { usd: r2(sum), n: withRev.length }, view: "acquisition" });
  } else if (!acq.campaigns.length) out.push({ key: "an.take.noCampaign", view: "acquisition" });
  if (out.length < 2) out.push({ key: "an.take.coverage", vars: { covered: p.covered_days, days: p.days }, view: "overview" });
  return out.slice(0, 4);
}

// ---- revenue & LTV ---------------------------------------------------------------------------

function revenue(ds: TitleDataset, p: ReportingPeriod, t: Totals): RevenueView {
  const at = ds.last_sync_at;
  const src = ds.source;
  const adUnavailable = t.ad_revenue_usd == null;
  const iap = metric("iap_gross", t.recharge_gmv_usd, src, at);
  const ads = adUnavailable ? unavailable("ad_revenue", "an.reason.componentUnavailable", src) : metric("ad_revenue", t.ad_revenue_usd, src, at);
  const iap_share = adUnavailable ? { ...unavailable("iap_share", "an.reason.componentUnavailable", "pulsar_derived"), numerator: t.recharge_gmv_usd, denominator: null, denominator_key: "an.denom.allRevenue" } : rate("iap_share", t.recharge_gmv_usd, r2(t.recharge_gmv_usd + (t.ad_revenue_usd ?? 0)), "an.denom.allRevenue", "pulsar_derived", at);

  const net = r2(t.recharge_gmv_usd - t.refunds_usd);
  const fees = ds.fee_share == null ? null : r2(net * ds.fee_share);
  const earnings = fees == null ? null : r2(net - fees);
  const settledRows = ds.settled_through ? sliceDaily(ds, p).filter((d) => d.date <= ds.settled_through!) : [];
  const settled = ds.fee_share == null || !ds.settled_through ? null : r2(settledRows.reduce((a, d) => a + (d.recharge_gmv_usd - d.refunds_usd) * (1 - ds.fee_share!), 0));
  const paidOut = ds.unavailable.includes("paid_out") || !ds.paid_out_through ? null : r2(sliceDaily(ds, p).filter((d) => d.date <= ds.paid_out_through!).reduce((a, d) => a + (d.recharge_gmv_usd - d.refunds_usd) * (1 - (ds.fee_share ?? 0)), 0));
  const waterfall: WaterfallStep[] = [
    { key: "iap_gross", sign: "plus", metric: iap },
    { key: "refunds", sign: "minus", metric: metric("refunds", t.refunds_usd, src, at) },
    { key: "fees_share", sign: "minus", metric: fees == null ? unavailable("fees_share", "an.reason.feeUnknown", "pulsar_derived") : { ...metric("fees_share", fees, "pulsar_derived", at), provenance: { ...prov("fees_share", "pulsar_derived", at), evidence: "estimated" } } },
    { key: "publisher_earnings", sign: "equals", metric: earnings == null ? unavailable("publisher_earnings", "an.reason.feeUnknown", "pulsar_derived") : { ...metric("publisher_earnings", earnings, "pulsar_derived", at), provenance: { ...prov("publisher_earnings", "pulsar_derived", at), evidence: "estimated" } } },
    { key: "settled", sign: "subtotal", metric: settled == null ? unavailable("settled", "an.reason.notSettled", src) : metric("settled", settled, src, at) },
    { key: "paid_out", sign: "subtotal", metric: paidOut == null ? unavailable("paid_out", "an.reason.componentUnavailable", src) : metric("paid_out", paidOut, src, at) },
  ];

  const users = {
    paying_users: metric("paying_users", t.paying_users, src, at),
    payer_conversion: rate("payer_conversion", t.paying_users, t.viewers, "an.denom.viewers", "pulsar_derived", at),
    repeat_payers: metric("repeat_payers", t.repeat_payers, src, at),
    repeat_share: rate("repeat_share", t.repeat_payers, t.paying_users, "an.denom.payingUsers", "pulsar_derived", at),
    arppu: rate("arppu", t.recharge_gmv_usd, t.paying_users, "an.denom.payingUsers", "pulsar_derived", at),
  };
  const orders = {
    recharge_orders: metric("recharge_orders", t.recharge_orders, src, at),
    recharge_gmv: metric("iap_gross", t.recharge_gmv_usd, src, at),
    redeem_orders: metric("redeem_orders", t.redeem_orders, src, at),
    redeem_coins: metric("redeem_coins", t.redeem_coins, src, at),
    avg_gmv_per_order: rate("avg_gmv_per_order", t.recharge_gmv_usd, t.recharge_orders, "an.denom.rechargeOrders", "pulsar_derived", at),
  };
  const platform_ltv = ds.platform_ltv
    ? { ...metric("platform_ltv", ds.platform_ltv.value, src, at), definition_text_key: "an.ltv.platformDefinition", period_key: `${ds.platform_ltv.period_from} → ${ds.platform_ltv.period_to}` }
    : { ...unavailable("platform_ltv", "an.reason.notReported", src), definition_text_key: "an.ltv.platformDefinition", period_key: "" };

  return { mix: { iap, ads, iap_share }, users, orders, waterfall, platform_ltv, cohorts: [cohort(ds, p, 7), cohort(ds, p, 30)] };
}

/**
 * Observed cohort value: the latest `period.days` entry days whose D{horizon}
 * has elapsed (entry window ends at data_through - horizon), so a 30-day
 * range reads the most recent 30 mature cohorts rather than none. Immature
 * when no entry day has elapsed yet.
 */
export function cohort(ds: TitleDataset, p: ReportingPeriod, horizon: 7 | 30): CohortMeasure {
  const entryTo = addDays(ds.data_through, -horizon);
  const entryFrom = addDays(entryTo, -(p.days - 1));
  const rows = ds.daily.filter((d) => d.date >= entryFrom && d.date <= entryTo);
  const field = horizon === 7 ? "cohort_rev_d7_usd" : "cohort_rev_d30_usd";
  const key = horizon === 7 ? "cohort_d7" : "cohort_d30";
  const eligible = rows.filter((d) => d[field] != null && d.cohort_size > 0);
  const users = eligible.reduce((a, d) => a + d.cohort_size, 0);
  const revenueSum = r2(eligible.reduce((a, d) => a + (d[field] ?? 0), 0));
  const last = eligible.length ? eligible[eligible.length - 1].date : null;
  const mature = eligible.length > 0 && users > 0;
  const value = mature ? r4(revenueSum / users) : null;
  const m: Metric = mature ? metric(key, value, "pulsar_derived", ds.last_sync_at) : unavailable(key, "an.reason.immature", "pulsar_derived");
  return {
    horizon,
    metric: m,
    initial_users: mature ? users : null,
    eligible_cohorts: eligible.length,
    elapsed_days_min: last ? daysBetween(last, ds.data_through) : null,
    entry_from: mature ? eligible[0].date : null,
    entry_to: mature ? last : null,
    mature,
    basis: "gross",
    entry_definition_key: "an.cohort.entryDefinition",
    formula: "eligible cumulative cohort revenue / initial eligible cohort users",
    breakdown: mature ? ds.region_split.map((r) => ({ key: r.region, label: r.region, users: Math.round(users * r.share), value })) : [],
  };
}

// ---- episodes ---------------------------------------------------------------------------------

function episodes(ds: TitleDataset, p: ReportingPeriod, t: Totals, studioEpisodes: { id: string; number: number }[]): EpisodesView {
  const at = ds.last_sync_at;
  const src = ds.source;
  if (ds.episode_attribution === "unavailable") {
    return { rows: [], attribution: "unavailable", paywall_episode: ds.paywall_episode, continuation_window_days: ds.continuation_window_days, min_sample: MIN_EPISODE_SAMPLE, mapped_revenue_usd: null, title_revenue_usd: t.recharge_gmv_usd };
  }
  const inPeriod = ds.episode_daily.filter((r) => r.date >= p.from && r.date <= p.to);
  const numbers = [...new Set(inPeriod.map((r) => r.number))].sort((a, b) => a - b);
  const byNumber = new Map(studioEpisodes.map((e) => [e.number, e.id]));
  const rows: EpisodeRow[] = numbers.map((n) => {
    const rs = inPeriod.filter((r) => r.number === n);
    const s = (f: (r: EpisodeDailyRow) => number) => rs.reduce((a, r) => a + f(r), 0);
    const starts = s((r) => r.starts);
    const unique = s((r) => r.unique_starters);
    const completions = s((r) => r.completions);
    const eligibleRows = rs.filter((r) => r.continued_to_next != null);
    const eligible = eligibleRows.reduce((a, r) => a + r.unique_starters, 0);
    const continued = eligibleRows.reduce((a, r) => a + (r.continued_to_next ?? 0), 0);
    const isLast = n === numbers[numbers.length - 1];
    const cont: RateMetric & { window_days: number } = {
      ...(isLast ? { ...unavailable("continuation", "an.reason.lastEpisode", "pulsar_derived", "not_applicable"), numerator: null, denominator: null, denominator_key: "an.denom.eligibleStarters" } : eligibleRows.length ? rate("continuation", continued, eligible, "an.denom.eligibleStarters", "pulsar_derived", at) : { ...unavailable("continuation", "an.reason.windowNotElapsed", "pulsar_derived"), numerator: null, denominator: null, denominator_key: "an.denom.eligibleStarters" }),
      window_days: ds.continuation_window_days,
    };
    const paywalled = ds.paywall_episode != null && n >= ds.paywall_episode;
    const paid = s((r) => r.paid_unlocks);
    const ad = s((r) => r.ad_unlocks);
    const attempts = s((r) => r.unlock_attempts);
    const rev = r2(s((r) => r.revenue_usd));
    const small = unique < MIN_EPISODE_SAMPLE;
    const completion = rate("completion_rate", completions, starts, "an.denom.starts", "pulsar_derived", at);
    const unlock = paywalled ? rate("unlock_conversion", paid + ad, attempts, "an.denom.unlockAttempts", "pulsar_derived", at) : { ...unavailable("unlock_conversion", "an.reason.freeEpisode", "pulsar_derived", "not_applicable"), numerator: null, denominator: null, denominator_key: "an.denom.unlockAttempts" };
    const flags: EpisodeFlag[] = [];
    if (small) flags.push("small_sample");
    if (!small && (completion.value ?? 0) >= 0.7) flags.push("strong_completion");
    if (!small && cont.value != null && cont.value < 0.5) flags.push("continuation_loss");
    if (!small && paywalled && (unlock.value ?? 0) >= 0.4) flags.push("strong_unlock");
    return {
      number: n,
      episode_id: byNumber.get(n) ?? null,
      starts: metric("starts", starts, src, at),
      unique_starters: metric("unique_starters", unique, src, at),
      completions: metric("completions", completions, src, at),
      completion_rate: completion,
      continuation: cont,
      watch_seconds_avg: rate("watch_seconds_avg", s((r) => r.watch_seconds), starts, "an.denom.starts", "pulsar_derived", at),
      paywall_reached: metric("paywall_reached_ep", s((r) => r.paywall_reached), src, at),
      paid_unlocks: paywalled ? metric("paid_unlocks", paid, src, at) : unavailable("paid_unlocks", "an.reason.freeEpisode", src, "not_applicable"),
      ad_unlocks: paywalled ? metric("ad_unlocks", ad, src, at) : unavailable("ad_unlocks", "an.reason.freeEpisode", src, "not_applicable"),
      unlock_conversion: unlock,
      revenue_usd: paywalled ? metric("episode_revenue", rev, src, at) : unavailable("episode_revenue", "an.reason.freeEpisode", src, "not_applicable"),
      is_paywall: ds.paywall_episode === n,
      flags,
      small_sample: small,
    };
  });
  const mapped = r2(rows.reduce((a, r) => a + (r.revenue_usd.value ?? 0), 0));
  for (const r of rows) if (!r.small_sample && mapped > 0 && (r.revenue_usd.value ?? 0) >= mapped * 0.4) r.flags.push("high_revenue");
  return { rows, attribution: rows.length ? "available" : "unavailable", paywall_episode: ds.paywall_episode, continuation_window_days: ds.continuation_window_days, min_sample: MIN_EPISODE_SAMPLE, mapped_revenue_usd: mapped, title_revenue_usd: t.recharge_gmv_usd };
}

// ---- funnel --------------------------------------------------------------------------------

function funnel(ds: TitleDataset, t: Totals): FunnelView {
  const at = ds.last_sync_at;
  const src = ds.source;
  const spec: [string, number, FunnelStep["unit"]][] = [
    ["entries", t.entries, "events"],
    ["playbacks", t.playbacks, "events"],
    ["paywall_reached", t.paywall_reached, "events"],
    ["unlock_attempts", t.unlock_attempts, "events"],
    ["unlock_success", t.unlock_success, "orders"],
    ["continued_after_unlock", t.continued_after_unlock, "people"],
  ];
  const steps: FunnelStep[] = spec.map(([key, value, unit], i) => ({
    key,
    unit,
    metric: metric(key, value, src, at),
    loss_from_previous: i === 0 ? null : rate(key, value, spec[i - 1][1], `an.funnel.${spec[i - 1][0]}`, "pulsar_derived", at),
  }));
  let largest: string | null = null;
  let worst = 1;
  for (const s of steps) if (s.loss_from_previous?.value != null && s.loss_from_previous.value < worst) { worst = s.loss_from_previous.value; largest = s.key; }
  return { linked_cohort: false, steps, largest_loss_key: largest };
}

// ---- acquisition ---------------------------------------------------------------------------

function campaignRow(c: PromoCampaign, rows: CreativeResult[], ds: TitleDataset | null, titleId: string): CampaignAnalytics {
  const source: ProvenanceSource = "campaign_results";
  const has = rows.length > 0;
  const demoRows = rows.some((r) => r.source === "demo");
  const at = has ? rows.reduce((m, r) => (r.observed_at > m ? r.observed_at : m), rows[0].observed_at) : null;
  const spend = has ? r2(rows.reduce((a, r) => a + r.spend_usd, 0)) : null;
  const imps = has ? rows.reduce((a, r) => a + r.impressions, 0) : null;
  const clicks = has ? rows.reduce((a, r) => a + r.clicks, 0) : null;
  const views = has ? rows.reduce((a, r) => a + r.video_views, 0) : null;
  const holdNum = has ? rows.reduce((a, r) => a + r.hook_hold_rate * r.video_views, 0) : null;
  const attr = ds?.campaign_attribution[c.id] ?? null;
  const noResults = "an.reason.noResults";
  const m = (key: string, v: number | null) => (has ? metric(key, v, source, at) : unavailable(key, noResults, source));
  const attrM = (key: string, v: number | null | undefined) => (attr && v != null ? metric(key, v, ds!.source, attr.observed_at) : unavailable(key, has ? "an.reason.attributionNotReported" : noResults, source));
  const window = has ? { from: rows.reduce((m, r) => (r.window_start < m ? r.window_start : m), rows[0].window_start), to: rows.reduce((m, r) => (r.window_end > m ? r.window_end : m), rows[0].window_end) } : null;
  return {
    campaign_id: c.id,
    external_id: c.external_id,
    name: c.name,
    status: c.status,
    href: `/producer/promote/${c.id}?returnTo=${encodeURIComponent(`/producer/titles/${titleId}/analytics/acquisition`)}`,
    reporting_source: has ? (demoRows ? "demo" : "tiktok") : "none",
    attribution_window: attr?.attribution_window ?? "not reported",
    refreshed_at: at,
    window,
    spend_usd: m("spend", spend),
    impressions: m("impressions", imps),
    clicks: m("clicks", clicks),
    video_views: m("impressions", views),
    ctr: has ? rate("ctr", clicks, imps, "an.denom.impressions", "pulsar_derived", at) : { ...unavailable("ctr", noResults, "pulsar_derived"), numerator: null, denominator: null, denominator_key: "an.denom.impressions" },
    cpc: has && clicks ? metric("cpc", r2(spend! / clicks), "pulsar_derived", at) : unavailable("cpc", has ? "an.reason.zeroDenominator" : noResults, "pulsar_derived"),
    cpm: has && imps ? metric("cpm", r2((spend! / imps) * 1000), "pulsar_derived", at) : unavailable("cpm", has ? "an.reason.zeroDenominator" : noResults, "pulsar_derived"),
    hook_hold_rate: has && views ? rate("hook_hold_rate", r2(holdNum!), views, "an.denom.videoViews", "pulsar_derived", at) : { ...unavailable("hook_hold_rate", noResults, "pulsar_derived"), numerator: null, denominator: null, denominator_key: "an.denom.videoViews" },
    attributed_users: attrM("attributed_users", attr?.attributed_users),
    attributed_payers: attrM("attributed_payers", attr?.attributed_payers),
    attributed_revenue_usd: attrM("attributed_revenue", attr?.attributed_revenue_usd),
    cost_per_acquired_user: attr && spend != null && attr.attributed_users > 0 ? metric("cost_per_acquired_user", r2(spend / attr.attributed_users), "pulsar_derived", attr.observed_at) : unavailable("cost_per_acquired_user", attr ? "an.reason.zeroDenominator" : "an.reason.attributionNotReported", "pulsar_derived"),
    cohort_roas: attr && spend ? metric("cohort_roas", r4(attr.attributed_revenue_usd / spend), "pulsar_derived", attr.observed_at) : unavailable("cohort_roas", "an.reason.noAttributedRevenue", "pulsar_derived"),
    benchmark: BENCHMARK,
    result_ids: rows.map((r) => r.id),
  };
}

function priorRow(ds: TitleDataset, r: TitleDataset["prior_rounds"][number]): CampaignAnalytics {
  const at = r.observed_at;
  const src = ds.source;
  return {
    campaign_id: null,
    external_id: null,
    name: r.name,
    status: "prior_round_demo",
    href: null,
    reporting_source: "demo",
    attribution_window: "7-day click, 1-day view",
    refreshed_at: at,
    window: r.window,
    spend_usd: metric("spend", r.spend_usd, src, at),
    impressions: metric("impressions", r.impressions, src, at),
    clicks: metric("clicks", r.clicks, src, at),
    video_views: metric("impressions", r.video_views, src, at),
    ctr: rate("ctr", r.clicks, r.impressions, "an.denom.impressions", "pulsar_derived", at),
    cpc: metric("cpc", r2(r.spend_usd / r.clicks), "pulsar_derived", at),
    cpm: metric("cpm", r2((r.spend_usd / r.impressions) * 1000), "pulsar_derived", at),
    hook_hold_rate: rate("hook_hold_rate", r2(r.hook_hold_rate * r.video_views), r.video_views, "an.denom.videoViews", "pulsar_derived", at),
    attributed_users: metric("attributed_users", r.attributed_users, src, at),
    attributed_payers: metric("attributed_payers", r.attributed_payers, src, at),
    attributed_revenue_usd: metric("attributed_revenue", r.attributed_revenue_usd, src, at),
    cost_per_acquired_user: r.attributed_users > 0 ? metric("cost_per_acquired_user", r2(r.spend_usd / r.attributed_users), "pulsar_derived", at) : unavailable("cost_per_acquired_user", "an.reason.zeroDenominator", "pulsar_derived"),
    cohort_roas: metric("cohort_roas", r4(r.attributed_revenue_usd / r.spend_usd), "pulsar_derived", at),
    benchmark: BENCHMARK,
    result_ids: [],
  };
}

function acquisition(input: ComputeInput, ds: TitleDataset | null, t: Totals | null): AcquisitionView {
  const campaigns = [...input.campaigns].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((c) => campaignRow(c, input.results.filter((r) => r.campaign_id === c.id), ds, input.title.id));
  for (const r of ds?.prior_rounds ?? []) campaigns.push(priorRow(ds!, r));
  return {
    campaigns,
    title_revenue_usd: ds && t ? metric("iap_gross", t.recharge_gmv_usd, ds.source, ds.last_sync_at) : unavailable("iap_gross", "an.reason.needsLink"),
    unattributed_note_key: "an.acq.unattributedNote",
  };
}

/** Title IAP gross between two dates, for the attribution boundary (tests, and the acquisition caption). */
export function grossBetween(ds: TitleDataset, from: string, to: string): number {
  return r2(ds.daily.filter((d) => d.date >= from && d.date <= to).reduce((a, d) => a + d.recharge_gmv_usd, 0));
}

// ---- the record --------------------------------------------------------------------------------

export function computeTitleAnalytics(input: ComputeInput): TitleAnalytics {
  const { title, listing, link, dataset: ds, range, today } = input;
  const base = `/producer/titles/${title.id}/analytics`;
  const identity = { producer_id: title.producer_id, provider_account_ref: listing?.provider_account_ref ?? null, listing_id: link?.listing_id ?? null, title_id: title.id };
  const hasData = !!(link && ds && ds.daily.length);
  const period = hasData ? periodFor(ds!, range, ds!.data_through) : null;
  const state = deriveState(link, ds, period, today);
  const fresh = freshness(state, ds, listing, today);
  const t = hasData ? totals(sliceDaily(ds!, period!), ds!.dedupe) : null;
  const acq = acquisition(input, hasData ? ds : null, t);
  const shell: TitleAnalytics = {
    identity,
    title: { id: title.id, name_zh: title.name_zh, name_en: title.name_en, episode_count: title.episode_count },
    listing,
    range,
    period,
    analytics_state: state,
    freshness: fresh,
    source: ds?.source ?? null,
    overview: null,
    revenue: null,
    episodes: null,
    funnel: null,
    acquisition: acq,
    campaigns: input.campaigns,
    results: input.results,
  };
  if (!hasData || !period || !t) return shell;
  // Previous period: only when both periods are fully covered.
  let prev: ReportingPeriod | null = periodFor(ds!, range, addDays(period.from, -1));
  if (period.covered_days < period.days || prev.covered_days < prev.days) prev = null;
  const tp = prev ? totals(sliceDaily(ds!, prev), ds!.dedupe) : null;
  const rev = revenue(ds!, period, t);
  const ep = episodes(ds!, period, t, input.episodes);
  const fun = funnel(ds!, t);
  return { ...shell, overview: overview(ds!, period, prev, t, tp, base, ep, fun, acq, rev), revenue: rev, episodes: ep, funnel: fun };
}

/** The catalog performance row: a subset of the record, with the revenue basis named. */
export function performanceRow(a: TitleAnalytics): TitlePerformanceRow {
  const earnings = a.revenue?.waterfall.find((w) => w.key === "publisher_earnings")?.metric ?? null;
  const gross = a.overview?.headlines.find((h) => h.key === "iap_gross")?.metric ?? null;
  const revenueMetric = earnings?.value != null ? { ...earnings, basis: "publisher_earnings" as const } : gross ? { ...gross, basis: "iap_gross" as const } : { ...unavailable("iap_gross", stateReason(a.analytics_state)), basis: "none" as const };
  const viewers = a.overview?.headlines.find((h) => h.key === "viewers")?.metric ?? unavailable("viewers", stateReason(a.analytics_state));
  const conv = (a.overview?.headlines.find((h) => h.key === "payer_conversion")?.metric as RateMetric | undefined) ?? { ...unavailable("payer_conversion", stateReason(a.analytics_state)), numerator: null, denominator: null, denominator_key: "an.denom.viewers" };
  const d30 = a.revenue?.cohorts.find((c) => c.horizon === 30)?.metric ?? unavailable("cohort_d30", stateReason(a.analytics_state));
  return {
    title_id: a.title.id,
    name_zh: a.title.name_zh,
    name_en: a.title.name_en,
    analytics_state: a.analytics_state,
    range: a.range,
    period: a.period,
    revenue: revenueMetric,
    viewers,
    payer_conversion: conv,
    cohort_d30: d30,
    freshness: a.freshness,
    source: a.source,
  };
}

export function stateReason(state: AnalyticsState): string {
  return state === "needs_listing_link" ? "an.reason.needsLink" : state === "linked_awaiting_data" ? "an.reason.awaitingData" : state === "sync_failed" ? "an.reason.syncFailed" : "an.reason.notReported";
}
