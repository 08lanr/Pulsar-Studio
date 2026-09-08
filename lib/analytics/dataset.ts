// The normalized rows lib/analytics/compute.ts reads. A connector (or the
// demo fixture) produces one TitleDataset per platform listing; compute never
// sees the provider. Daily additive fields sum to period totals; the two
// unique-user figures (viewers, payers) are NOT additive across days, so the
// dataset carries an explicit period-deduplication model instead of a sum.

export type DailyRow = {
  date: string;
  /** Distinct users who started any episode that day = new + returning. */
  new_viewers: number;
  returning_viewers: number;
  /** Events. */
  starts: number;
  completions: number;
  watch_seconds: number;
  entries: number;
  /** Entries that played at least one episode (events). */
  playbacks: number;
  paywall_reached: number;
  unlock_attempts: number;
  unlock_success: number;
  continued_after_unlock: number;
  /** Money and orders. */
  recharge_orders: number;
  recharge_gmv_usd: number;
  refunds_usd: number;
  redeem_orders: number;
  redeem_coins: number;
  ad_impressions: number | null;
  /** After the platform's fee, as the source documents it; null when the component is unavailable. */
  ad_revenue_usd: number | null;
  /** Distinct users with a first-ever recharge that day / with a repeat recharge that day. */
  new_payers: number;
  returning_payers: number;
  /** Cohort entered this day (= new_viewers) and its cumulative gross revenue by D7 / D30; null until elapsed. */
  cohort_size: number;
  cohort_rev_d7_usd: number | null;
  cohort_rev_d30_usd: number | null;
};

export type EpisodeDailyRow = {
  number: number;
  date: string;
  starts: number;
  unique_starters: number;
  /** Unique starters who had not started N-1 within the continuation window. */
  direct_entries: number;
  /** Of this day's unique starters of N, how many started N+1 within the window; null until the window has elapsed. */
  continued_to_next: number | null;
  completions: number;
  watch_seconds: number;
  paywall_reached: number;
  unlock_attempts: number;
  paid_unlocks: number;
  ad_unlocks: number;
  revenue_usd: number;
};

export type PriorRound = {
  id: string;
  name: string;
  window: { from: string; to: string };
  spend_usd: number;
  impressions: number;
  clicks: number;
  video_views: number;
  hook_hold_rate: number;
  attributed_users: number;
  attributed_payers: number;
  attributed_revenue_usd: number;
  observed_at: string;
};

export type CampaignAttribution = {
  attributed_users: number;
  attributed_payers: number;
  attributed_revenue_usd: number;
  attribution_window: string;
  observed_at: string;
};

export type TitleDataset = {
  listing_id: string;
  source: "demo";
  currency: "USD";
  data_from: string;
  data_through: string;
  last_sync_at: string;
  sync_status: "ok" | "pending" | "failed";
  /** Definition keys the source cannot deliver for this listing. */
  unavailable: string[];
  episode_attribution: "available" | "unavailable";
  paywall_episode: number | null;
  /** Contractual platform share of net IAP sales; null when unknown (fees then unavailable). */
  fee_share: number | null;
  /** Share of returning users that are distinct from each other over a period (demo dedupe model). */
  dedupe: { viewers: number; payers: number };
  continuation_window_days: number;
  platform_ltv: { value: number; period_from: string; period_to: string } | null;
  settled_through: string | null;
  paid_out_through: string | null;
  region_split: { region: string; share: number }[];
  source_split: { source: string; share: number }[];
  daily: DailyRow[];
  episode_daily: EpisodeDailyRow[];
  prior_rounds: PriorRound[];
  campaign_attribution: Record<string, CampaignAttribution>;
};
