// Title analytics: the typed contract between a data source (today the demo
// fixture; later a provider connector such as TikTok Drama Center) and the
// four analytics views. Values are separated from their provenance and
// availability so a real connector can fill the same shapes without the UI
// changing: a Metric carries a value OR an availability reason, never a
// fabricated zero. Every identifier level a connector must supply is named
// here (docs/analytics/tiktok-source-mapping.md).

import type { Evidence } from "@/lib/research/types";
import type { CreativeResult, PromoCampaign } from "@/lib/types";

// ---- ranges and periods ----------------------------------------------------------------

export type PresetRange = "7d" | "30d" | "90d";
/** "custom" means the record was computed for an explicit from/to window (AnalyticsWindow). */
export type AnalyticsRange = PresetRange | "custom";
export const RANGES: PresetRange[] = ["7d", "30d", "90d"];
export const RANGE_DAYS: Record<PresetRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** An explicit reporting window, inclusive ISO dates (decision 2026-09-10: a date filter beside the presets). */
export type AnalyticsWindow = { from: string; to: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function isoDay(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string" || !ISO_DAY.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/** A valid from/to pair (from ≤ to, at most 366 days), else null: an incomplete or bad pair falls back to the preset. */
export function parseWindow(from: unknown, to: unknown): AnalyticsWindow | null {
  const f = isoDay(from), t = isoDay(to);
  if (!f || !t || f > t) return null;
  const days = Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000) + 1;
  return days > 366 ? null : { from: f, to: t };
}

/** The preset that stands in for a custom window where only presets exist (the catalog comparison). */
export function presetFor(range: AnalyticsRange): PresetRange {
  return range === "custom" ? "30d" : range;
}

export function parseRange(raw: string | string[] | undefined | null): AnalyticsRange {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return RANGES.includes(v as PresetRange) ? (v as PresetRange) : "30d";
}

/** A reporting period: inclusive calendar days, one timezone, one currency. */
export type ReportingPeriod = {
  from: string;
  to: string;
  timezone: "UTC";
  currency: "USD";
  /** Days of the period that carry data; `days` is the period length. */
  days: number;
  covered_days: number;
};

// ---- provenance and availability ---------------------------------------------------------

export type Availability = "available" | "unavailable" | "partial" | "stale" | "not_applicable";

export type ProvenanceSource = "demo" | "tiktok_drama_center" | "pulsar_derived" | "campaign_results";

export type Provenance = {
  source: ProvenanceSource;
  evidence: Evidence;
  /** Key into lib/analytics/definitions.ts and docs/analytics/metric-dictionary.md. */
  definition_key: string;
  observed_at: string | null;
};

export type Metric<T = number> = {
  value: T | null;
  availability: Availability;
  provenance: Provenance;
  /** Why the value is missing or partial (an i18n key), when it is. */
  reason?: string | null;
};

/** A rate shown with the numbers behind it. */
export type RateMetric = Metric<number> & {
  numerator: number | null;
  denominator: number | null;
  /** What the denominator counts (an i18n key). */
  denominator_key: string;
};

/** Percentage change (relative, of a count or amount) vs percentage-point change (of a rate) are distinct types. */
export type Comparison =
  | { kind: "pct_change"; value: number; previous: number }
  | { kind: "pp_change"; value: number; previous: number }
  | { kind: "not_comparable"; reason: string };

// ---- identifiers -------------------------------------------------------------------------

export type AnalyticsIdentity = {
  /** Company: core.producers.id */
  producer_id: string;
  /** The provider account/app the listing lives under (opaque, provider-defined). */
  provider_account_ref: string | null;
  /** Platform listing external id (lst_ prefix). */
  listing_id: string | null;
  title_id: string;
};

export type AnalyticsState = "available" | "needs_listing_link" | "linked_awaiting_data" | "partial" | "stale" | "sync_failed";

export type ListingPlatform = "tiktok_drama_center_demo";

export type AnalyticsListing = {
  id: string;
  producer_id: string;
  platform: ListingPlatform;
  platform_label: string;
  /** What the platform calls the series. */
  name: string;
  /** Publishing path the listing reports through. */
  publishing_path: "drama_center" | "mini_program";
  provider_account_ref: string;
  region_scope: string;
  reporting_scope: string;
  coverage_from: string | null;
  coverage_to: string | null;
  last_sync_at: string | null;
  sync_status: "ok" | "pending" | "failed";
  /** Components the source cannot deliver for this listing (definition keys). */
  unavailable_components: string[];
  episode_attribution: "available" | "unavailable";
  /** Set by the list method: the title this listing is already linked to, if any. */
  linked_title_id: string | null;
  linked_title_name: string | null;
  source: "demo";
};

/** core/analytics_links row. */
export type AnalyticsLink = {
  id: string;
  producer_id: string;
  title_id: string;
  listing_id: string;
  linked_by: string;
  linked_at: string;
};

// ---- freshness -------------------------------------------------------------------------

export type Freshness = {
  state: AnalyticsState;
  last_sync_at: string | null;
  data_through: string | null;
  /** Whole days between data_through and today. */
  lag_days: number | null;
  stale: boolean;
  sync_status: AnalyticsListing["sync_status"] | null;
  source_label: string;
  notes: string[];
};

// ---- the catalog performance row -----------------------------------------------------

export type TitlePerformanceRow = {
  title_id: string;
  name_zh: string;
  name_en: string | null;
  analytics_state: AnalyticsState;
  range: AnalyticsRange;
  period: ReportingPeriod | null;
  /** Publisher earnings when the source reports them; otherwise IAP gross. `basis` names which. */
  revenue: Metric & { basis: "publisher_earnings" | "iap_gross" | "none" };
  viewers: Metric;
  payer_conversion: RateMetric;
  /** Observed D30 cohort revenue per user; null with a reason while immature. */
  cohort_d30: Metric;
  freshness: Freshness;
  source: ProvenanceSource | null;
};

// ---- the full record ---------------------------------------------------------------------

export type SeriesPoint = {
  date: string;
  viewers: number | null;
  starts: number | null;
  iap_gross_usd: number | null;
  ad_revenue_usd: number | null;
  new_payers: number | null;
};

export type Headline = {
  key: string;
  metric: Metric;
  comparison: Comparison | null;
  /** "count" | "usd" | "rate" | "usd_per_user" */
  unit: "count" | "usd" | "rate" | "usd_per_user";
  href?: string;
};

export type Takeaway = {
  key: string;
  vars?: Record<string, string | number>;
  /** Which view explains it. */
  view: "overview" | "revenue" | "episodes" | "acquisition";
};

export type OverviewView = {
  headlines: Headline[];
  series: SeriesPoint[];
  viewing: { key: string; metric: Metric | RateMetric; unit: Headline["unit"] }[];
  monetization: { key: string; metric: Metric | RateMetric; unit: Headline["unit"] }[];
  takeaways: Takeaway[];
  previous_period: ReportingPeriod | null;
};

export type WaterfallStep = { key: string; metric: Metric; sign: "plus" | "minus" | "equals" | "subtotal" };

export type CohortMeasure = {
  horizon: 7 | 30;
  metric: Metric;
  initial_users: number | null;
  eligible_cohorts: number;
  elapsed_days_min: number | null;
  /** The entry-day window the eligible cohorts come from. */
  entry_from: string | null;
  entry_to: string | null;
  mature: boolean;
  basis: "gross" | "net";
  entry_definition_key: string;
  formula: string;
  breakdown: { key: string; label: string; users: number; value: number | null }[];
};

export type RevenueView = {
  mix: { iap: Metric; ads: Metric; iap_share: RateMetric };
  users: { paying_users: Metric; payer_conversion: RateMetric; repeat_payers: Metric; repeat_share: RateMetric; arppu: RateMetric };
  orders: { recharge_orders: Metric; recharge_gmv: Metric; redeem_orders: Metric; redeem_coins: Metric; avg_gmv_per_order: RateMetric };
  waterfall: WaterfallStep[];
  platform_ltv: Metric & { definition_text_key: string; period_key: string };
  cohorts: CohortMeasure[];
};

export type EpisodeRow = {
  number: number;
  episode_id: string | null;
  starts: Metric;
  unique_starters: Metric;
  completions: Metric;
  completion_rate: RateMetric;
  continuation: RateMetric & { window_days: number };
  watch_seconds_avg: Metric;
  paywall_reached: Metric;
  paid_unlocks: Metric;
  ad_unlocks: Metric;
  unlock_conversion: RateMetric;
  revenue_usd: Metric;
  is_paywall: boolean;
  flags: EpisodeFlag[];
  small_sample: boolean;
};

export type EpisodeFlag = "strong_completion" | "continuation_loss" | "strong_unlock" | "high_revenue" | "small_sample";

export type EpisodesView = {
  rows: EpisodeRow[];
  attribution: Availability;
  paywall_episode: number | null;
  continuation_window_days: number;
  min_sample: number;
  /** Sum of directly mapped episode revenue vs the title total, so the basis is explicit. */
  mapped_revenue_usd: number | null;
  title_revenue_usd: number | null;
};

export type FunnelStep = { key: string; metric: Metric; unit: "people" | "events" | "orders"; loss_from_previous: RateMetric | null };

export type FunnelView = {
  /** True when the steps are a linked user cohort (sequential); false when they are event counts. */
  linked_cohort: boolean;
  steps: FunnelStep[];
  largest_loss_key: string | null;
};

export type CampaignAnalytics = {
  campaign_id: string | null;
  external_id: string | null;
  name: string;
  status: PromoCampaign["status"] | "prior_round_demo";
  href: string | null;
  reporting_source: string;
  attribution_window: string;
  refreshed_at: string | null;
  window: { from: string; to: string } | null;
  spend_usd: Metric;
  impressions: Metric;
  clicks: Metric;
  video_views: Metric;
  ctr: RateMetric;
  cpc: Metric;
  cpm: Metric;
  hook_hold_rate: RateMetric;
  attributed_users: Metric;
  attributed_payers: Metric;
  attributed_revenue_usd: Metric;
  cost_per_acquired_user: Metric;
  cohort_roas: Metric;
  benchmark: { hook_hold_rate: number; ctr: number };
  /** The existing promo_results rows this row was built from (never re-derived). */
  result_ids: string[];
};

export type AcquisitionView = {
  campaigns: CampaignAnalytics[];
  /** Title revenue in the same window as the campaigns, for the boundary check. */
  title_revenue_usd: Metric;
  unattributed_note_key: string;
};

export type TitleAnalytics = {
  identity: AnalyticsIdentity;
  title: { id: string; name_zh: string; name_en: string | null; episode_count: number };
  listing: AnalyticsListing | null;
  range: AnalyticsRange;
  period: ReportingPeriod | null;
  analytics_state: AnalyticsState;
  freshness: Freshness;
  source: ProvenanceSource | null;
  overview: OverviewView | null;
  revenue: RevenueView | null;
  episodes: EpisodesView | null;
  funnel: FunnelView | null;
  acquisition: AcquisitionView;
  /** Existing campaign rows, so a page can link to them. */
  campaigns: PromoCampaign[];
  results: CreativeResult[];
};
