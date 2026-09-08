// Demo title analytics for fixture mode (Title Analytics, 2026-09-08).
//
// Everything here is invented, deterministic (a string hash, no Math.random;
// the same title shows the same numbers on every refresh) and labelled
// `source: "demo"`. It is keyed to the demo catalog's ids so the linking
// workflow, the four analytics views and the catalog performance view have
// something to stand on. Ten scenarios (docs/analytics/metric-dictionary.md
// § scenarios) map to demo titles:
//
//   1 strong viewing, weak monetization        title 8   lst_demo_son_in_law
//   2 strong monetization, low traffic          title 6   lst_demo_wolf_king_bride
//   3 healthy early retention, paywall drop     title 1   lst_demo_reborn_ceo (paywall ep 4; campaign 1 results reused)
//   4 strong ad engagement, expensive acquisition title 4 lst_demo_fake_heiress (prior round stored here)
//   5 successful title, no Pulsar campaign      title 7   lst_demo_divorce_begged
//   6 unmapped title                            title 3 (+ 5, 9, 11, 13): needs a listing link
//   7 linked, awaiting data                     title 12  lst_demo_palace_willows
//   8 immature cohort (linked 5 days ago)       title 14  lst_demo_last_warehouse
//   9 partial / stale (9-day-old sync, no ad revenue) title 10 lst_demo_substitute_lover
//  10 failed sync, no episode attribution       title 2   lst_demo_wargod
//
// Reconciliation rules the builder keeps (tests/analytics.test.ts checks
// them): rates are numerator / denominator of shown fields; additive daily
// fields sum to period totals; unique users are never summed across days;
// cohort D7/D30 are null until elapsed; episode revenue is a distribution of
// the day's redeemed recharge value (never more than the title's gross);
// recharge (buying coins) and redemption (spending coins) are separate.

import type { CampaignAttribution, DailyRow, EpisodeDailyRow, PriorRound, TitleDataset } from "@/lib/analytics/dataset";
import type { AnalyticsLink, AnalyticsListing } from "@/lib/analytics/types";
import { demoCampaignId, demoTitleId } from "./demo-catalog";
import { PRODUCER_ID, PRODUCER_USER_ID, uuid } from "./ids";

/** The demo world's clock: the fixture's daily series end the day before this. */
export const DEMO_TODAY = "2026-09-08";

const B_LINK = 0x40;

// ---- deterministic noise -------------------------------------------------------------

/** [0, 1) from a string, FNV-1a then one xorshift round; the same input always gives the same output. */
export function hash01(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let x = h || 0x9e3779b9;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return x / 4294967296;
}

/** [-1, 1) */
const noise = (seed: string) => hash01(seed) * 2 - 1;

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Split `total` across weights so the parts sum exactly to `total` (largest remainder). */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map((v) => Math.floor(v));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (const o of order) { if (rest <= 0) break; parts[o.i] += 1; rest -= 1; }
  return parts;
}

// ---- scenarios ---------------------------------------------------------------------------

type Params = {
  viewers: number;
  trend: number;
  newShare: number;
  startsPerViewer: number;
  completion: number;
  avgWatch: number;
  paywallShare: number;
  attemptRate: number;
  successRate: number;
  paidShare: number;
  payerRate: number;
  repeatRate: number;
  avgOrder: number;
  refundRate: number;
  adImpPerViewer: number | null;
  ecpm: number;
  d7pu: number;
  d30pu: number;
  episodes: number;
  paywall: number | null;
  /** Continuation N -> N+1 per episode index (0-based); the paywall step is lower. */
  continuation: number[];
  directShare: number;
  mappedShare: number;
  coinsPerUnlock: number;
};

type Scenario = {
  listing: Omit<AnalyticsListing, "linked_title_id" | "linked_title_name" | "source" | "producer_id" | "coverage_from" | "coverage_to" | "last_sync_at" | "sync_status" | "platform" | "platform_label">;
  linkTo: number | null;
  linkedDaysAgo: number;
  /** Days of daily data before data_through; 0 = no data yet. */
  historyDays: number;
  lagDays: number;
  syncStatus: TitleDataset["sync_status"];
  feeShare: number | null;
  settledLag: number | null;
  paidOutDay: number | null;
  platformLtv: number | null;
  params: Params;
  priorRounds?: PriorRound[];
  attribution?: Record<string, CampaignAttribution>;
};

const PLATFORM_LABEL = "TikTok Drama Center (demo)";

const base: Params = {
  viewers: 1000, trend: 0.001, newShare: 0.42, startsPerViewer: 2.6, completion: 0.62, avgWatch: 68, paywallShare: 0.31, attemptRate: 0.46, successRate: 0.38, paidShare: 0.55,
  payerRate: 0.03, repeatRate: 0.05, avgOrder: 5.4, refundRate: 0.012, adImpPerViewer: 1.9, ecpm: 6.5, d7pu: 0.21, d30pu: 0.34,
  episodes: 6, paywall: 4, continuation: [0.74, 0.7, 0.66, 0.6, 0.58, 0.55, 0.52, 0.5], directShare: 0.08, mappedShare: 0.82, coinsPerUnlock: 60,
};

const SCENARIOS: Scenario[] = [
  {
    listing: { id: "lst_demo_son_in_law", name: "Rise of the Son-in-Law", publishing_path: "drama_center", provider_account_ref: "demo-app-xinghai-01", region_scope: "US", reporting_scope: "listing, all episodes, daily", unavailable_components: ["paid_out"], episode_attribution: "available" },
    linkTo: 8, linkedDaysAgo: 120, historyDays: 200, lagDays: 1, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.09,
    params: { ...base, viewers: 4100, trend: 0.0025, newShare: 0.47, payerRate: 0.006, repeatRate: 0.02, avgOrder: 3.9, adImpPerViewer: 2.6, ecpm: 5.8, d7pu: 0.04, d30pu: 0.07, episodes: 8, paywall: 5, continuation: [0.8, 0.77, 0.75, 0.52, 0.62, 0.6, 0.58, 0.55], completion: 0.71 },
  },
  {
    listing: { id: "lst_demo_wolf_king_bride", name: "Bride of the Wolf King", publishing_path: "mini_program", provider_account_ref: "demo-app-xinghai-01", region_scope: "US", reporting_scope: "listing, all episodes, daily", unavailable_components: ["paid_out"], episode_attribution: "available" },
    linkTo: 6, linkedDaysAgo: 90, historyDays: 200, lagDays: 1, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.92,
    params: { ...base, viewers: 460, trend: 0.0005, newShare: 0.36, payerRate: 0.062, repeatRate: 0.14, avgOrder: 9.8, adImpPerViewer: 1.2, ecpm: 7.1, d7pu: 0.71, d30pu: 1.18, episodes: 5, paywall: 3, continuation: [0.76, 0.58, 0.7, 0.66, 0.6], completion: 0.66, paywallShare: 0.42, attemptRate: 0.55, successRate: 0.47, paidShare: 0.72 },
  },
  {
    listing: { id: "lst_demo_reborn_ceo", name: "Reborn as the CEO's First Love", publishing_path: "drama_center", provider_account_ref: "demo-app-xinghai-01", region_scope: "US", reporting_scope: "listing, all episodes, daily", unavailable_components: ["paid_out"], episode_attribution: "available" },
    linkTo: 1, linkedDaysAgo: 100, historyDays: 200, lagDays: 1, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.31,
    params: { ...base, viewers: 1800, trend: 0.0015, payerRate: 0.028, repeatRate: 0.07, avgOrder: 5.9, d7pu: 0.19, d30pu: 0.33, episodes: 6, paywall: 4, continuation: [0.78, 0.74, 0.31, 0.66, 0.62, 0.6], completion: 0.64 },
    attribution: { [demoCampaignId(1)]: { attributed_users: 74, attributed_payers: 5, attributed_revenue_usd: 38.6, attribution_window: "7-day click, 1-day view", observed_at: "2026-09-06T09:00:00.000Z" } },
  },
  {
    listing: { id: "lst_demo_fake_heiress", name: "The Fake Heiress Strikes Back", publishing_path: "drama_center", provider_account_ref: "demo-app-xinghai-01", region_scope: "US", reporting_scope: "listing, all episodes, daily", unavailable_components: ["paid_out"], episode_attribution: "available" },
    linkTo: 4, linkedDaysAgo: 80, historyDays: 200, lagDays: 1, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.2,
    params: { ...base, viewers: 610, trend: 0.0008, payerRate: 0.021, repeatRate: 0.05, avgOrder: 5.2, d7pu: 0.13, d30pu: 0.22, episodes: 4, paywall: 3, continuation: [0.72, 0.44, 0.6, 0.58] },
    priorRounds: [{ id: "prior_demo_title4_r0", name: "Fake-heiress reveal — US pilot (prior round, demo)", window: { from: "2026-07-20", to: "2026-07-27" }, spend_usd: 240, impressions: 61_000, clicks: 902, video_views: 33_400, hook_hold_rate: 0.44, attributed_users: 19, attributed_payers: 1, attributed_revenue_usd: 9.9, observed_at: "2026-07-29T08:00:00.000Z" }],
  },
  {
    listing: { id: "lst_demo_divorce_begged", name: "After the Divorce, He Begged", publishing_path: "drama_center", provider_account_ref: "demo-app-xinghai-01", region_scope: "US", reporting_scope: "listing, all episodes, daily", unavailable_components: ["paid_out"], episode_attribution: "available" },
    linkTo: 7, linkedDaysAgo: 110, historyDays: 200, lagDays: 1, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.41,
    params: { ...base, viewers: 2200, trend: 0.002, payerRate: 0.033, repeatRate: 0.09, avgOrder: 6.4, d7pu: 0.26, d30pu: 0.44, episodes: 8, paywall: 4, continuation: [0.79, 0.76, 0.58, 0.68, 0.64, 0.62, 0.6, 0.58], completion: 0.68 },
  },
  {
    listing: { id: "lst_demo_substitute_lover", name: "The Substitute Lover", publishing_path: "mini_program", provider_account_ref: "demo-app-xinghai-02", region_scope: "US", reporting_scope: "listing, all episodes, daily; ad revenue component not delivered", unavailable_components: ["ad_revenue", "paid_out"], episode_attribution: "available" },
    linkTo: 10, linkedDaysAgo: 60, historyDays: 200, lagDays: 9, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.24,
    params: { ...base, viewers: 900, trend: -0.001, payerRate: 0.024, avgOrder: 5.1, adImpPerViewer: null, d7pu: 0.15, d30pu: 0.25, episodes: 3, paywall: 3, continuation: [0.7, 0.48, 0.6] },
  },
  {
    listing: { id: "lst_demo_palace_willows", name: "Willows Behind the Palace Wall", publishing_path: "drama_center", provider_account_ref: "demo-app-xinghai-01", region_scope: "US", reporting_scope: "listing; first report not yet delivered", unavailable_components: [], episode_attribution: "available" },
    linkTo: 12, linkedDaysAgo: 1, historyDays: 0, lagDays: 0, syncStatus: "pending", feeShare: 0.3, settledLag: null, paidOutDay: null, platformLtv: null,
    params: { ...base, viewers: 0, episodes: 0, paywall: null, continuation: [] },
  },
  {
    listing: { id: "lst_demo_last_warehouse", name: "Last Warehouse", publishing_path: "drama_center", provider_account_ref: "demo-app-xinghai-01", region_scope: "US", reporting_scope: "listing, all episodes, daily", unavailable_components: ["paid_out"], episode_attribution: "available" },
    linkTo: 14, linkedDaysAgo: 5, historyDays: 5, lagDays: 0, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: null, platformLtv: null,
    params: { ...base, viewers: 320, trend: 0.03, newShare: 0.7, payerRate: 0.02, avgOrder: 4.8, d7pu: 0.12, d30pu: 0.2, episodes: 6, paywall: 4, continuation: [0.74, 0.7, 0.4, 0.62, 0.6, 0.58] },
  },
  {
    listing: { id: "lst_demo_wargod", name: "The War God Returns", publishing_path: "drama_center", provider_account_ref: "demo-app-xinghai-02", region_scope: "US", reporting_scope: "listing totals only; episode attribution not delivered", unavailable_components: ["paid_out", "episode_revenue", "continuation"], episode_attribution: "unavailable" },
    linkTo: 2, linkedDaysAgo: 40, historyDays: 120, lagDays: 4, syncStatus: "failed", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.18,
    params: { ...base, viewers: 1500, payerRate: 0.019, avgOrder: 4.4, d7pu: 0.1, d30pu: 0.17, episodes: 0, paywall: null, continuation: [] },
  },
  // ---- unlinked listings the link workflow offers ----
  {
    listing: { id: "lst_demo_flash_marriage_a", name: "Flash Marriage with the Cold CEO", publishing_path: "drama_center", provider_account_ref: "demo-app-xinghai-01", region_scope: "US", reporting_scope: "listing, all episodes, daily", unavailable_components: ["paid_out"], episode_attribution: "available" },
    linkTo: null, linkedDaysAgo: 0, historyDays: 60, lagDays: 1, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.22,
    params: { ...base, viewers: 420, payerRate: 0.025, avgOrder: 5.0, d7pu: 0.16, d30pu: 0.27, episodes: 6, paywall: 3, continuation: [0.73, 0.5, 0.64, 0.6, 0.58, 0.56] },
  },
  {
    listing: { id: "lst_demo_flash_marriage_b", name: "Flash Marriage With The Cold CEO (Dubbed)", publishing_path: "mini_program", provider_account_ref: "demo-app-xinghai-02", region_scope: "US", reporting_scope: "listing, all episodes, daily", unavailable_components: ["paid_out"], episode_attribution: "available" },
    linkTo: null, linkedDaysAgo: 0, historyDays: 45, lagDays: 1, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.11,
    params: { ...base, viewers: 150, payerRate: 0.018, avgOrder: 4.6, d7pu: 0.1, d30pu: 0.16, episodes: 6, paywall: 3, continuation: [0.7, 0.46, 0.6, 0.58, 0.56, 0.54] },
  },
  {
    listing: { id: "lst_demo_twins_revenge", name: "Revenge with My Twins", publishing_path: "drama_center", provider_account_ref: "demo-app-xinghai-01", region_scope: "US", reporting_scope: "listing, all episodes, daily", unavailable_components: ["paid_out"], episode_attribution: "available" },
    linkTo: null, linkedDaysAgo: 0, historyDays: 200, lagDays: 1, syncStatus: "ok", feeShare: 0.3, settledLag: 2, paidOutDay: 31, platformLtv: 0.35,
    params: { ...base, viewers: 700, payerRate: 0.031, avgOrder: 5.7, d7pu: 0.22, d30pu: 0.37, episodes: 8, paywall: 4, continuation: [0.77, 0.73, 0.55, 0.66, 0.62, 0.6, 0.58, 0.56] },
  },
];

// ---- the builder ---------------------------------------------------------------------

function buildDataset(s: Scenario, today: string): TitleDataset {
  const p = s.params;
  const lid = s.listing.id;
  const through = s.historyDays > 0 ? addDays(today, -s.lagDays) : today;
  const from = s.historyDays > 0 ? addDays(through, -(s.historyDays - 1)) : today;
  const daily: DailyRow[] = [];
  const episode_daily: EpisodeDailyRow[] = [];
  const W = 3; // continuation window, days
  const paywalled = p.paywall ? Array.from({ length: p.episodes }, (_, i) => i + 1).filter((n) => n >= p.paywall!) : [];

  for (let i = 0; i < s.historyDays; i++) {
    const date = addDays(from, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const week = dow === 0 || dow === 6 ? 1.12 : 0.97;
    const n = (k: string) => noise(`${lid}:${date}:${k}`);
    const viewers = Math.max(1, Math.round(p.viewers * Math.pow(1 + p.trend, i) * (1 + 0.12 * n("v")) * week));
    const new_viewers = Math.round(viewers * p.newShare * (1 + 0.08 * n("n")));
    const returning_viewers = viewers - new_viewers;
    const starts = Math.round(viewers * p.startsPerViewer * (1 + 0.05 * n("s")));
    const completions = Math.round(starts * p.completion * (1 + 0.04 * n("c")));
    const watch_seconds = Math.round(starts * p.avgWatch * (1 + 0.05 * n("w")));
    const entries = Math.round(viewers * 1.3 * (1 + 0.04 * n("e")));
    const playbacks = Math.round(entries * 0.87 * (1 + 0.03 * n("pb")));
    const paywall_reached = Math.round(viewers * p.paywallShare * (1 + 0.06 * n("p")));
    const unlock_attempts = Math.round(paywall_reached * p.attemptRate * (1 + 0.05 * n("a")));
    const unlock_success = Math.round(unlock_attempts * p.successRate * (1 + 0.05 * n("u")));
    const continued_after_unlock = Math.round(unlock_success * 0.9);
    const new_payers = Math.round(new_viewers * p.payerRate * (1 + 0.15 * n("np")));
    const returning_payers = Math.round(returning_viewers * p.repeatRate * p.payerRate * 4 * (1 + 0.15 * n("rp")));
    const recharge_orders = new_payers + returning_payers + Math.round(returning_payers * 0.4);
    const recharge_gmv_usd = r2(recharge_orders * p.avgOrder * (1 + 0.06 * n("g")));
    const refunds_usd = r2(recharge_gmv_usd * p.refundRate * (1 + 0.3 * n("r")));
    const redeem_orders = Math.round(unlock_success * p.paidShare);
    const redeem_coins = redeem_orders * p.coinsPerUnlock;
    const adUnavailable = p.adImpPerViewer == null;
    const ad_impressions = adUnavailable ? null : Math.round(viewers * p.adImpPerViewer! * (1 + 0.08 * n("ai")));
    const ad_revenue_usd = adUnavailable ? null : r2((ad_impressions! / 1000) * p.ecpm * (1 + 0.05 * n("ar")));
    const elapsed7 = daysBetween(date, through) >= 7;
    const elapsed30 = daysBetween(date, through) >= 30;
    const cohort_rev_d7_usd = elapsed7 ? r2(new_viewers * p.d7pu * (1 + 0.1 * n("d7"))) : null;
    const cohort_rev_d30_usd = elapsed30 ? r2(Math.max(cohort_rev_d7_usd ?? 0, new_viewers * p.d30pu * (1 + 0.1 * n("d30")))) : null;
    daily.push({ date, new_viewers, returning_viewers, starts, completions, watch_seconds, entries, playbacks, paywall_reached, unlock_attempts, unlock_success, continued_after_unlock, recharge_orders, recharge_gmv_usd, refunds_usd, redeem_orders, redeem_coins, ad_impressions, ad_revenue_usd, new_payers, returning_payers, cohort_size: new_viewers, cohort_rev_d7_usd, cohort_rev_d30_usd });

    if (s.listing.episode_attribution === "unavailable" || p.episodes === 0) continue;
    // Episodes: unique starters of N+1 = continued from N + direct entries; the
    // paywall's redeem orders, ad unlocks and redeemed value are apportioned.
    const ep1 = Math.round(new_viewers + returning_viewers * 0.35);
    const uniques: number[] = [];
    const direct: number[] = [];
    const contRaw: number[] = [];
    for (let k = 0; k < p.episodes; k++) {
      const d = k === 0 ? ep1 : Math.round(ep1 * p.directShare * Math.pow(0.85, k) * (1 + 0.1 * n(`d${k}`)));
      const u = k === 0 ? ep1 : contRaw[k - 1] + d;
      uniques.push(u);
      direct.push(d);
      contRaw.push(Math.round(u * (p.continuation[k] ?? 0.5) * (1 + 0.04 * n(`k${k}`))));
    }
    const windowElapsed = daysBetween(date, through) >= W;
    const weights = paywalled.map((num) => uniques[num - 1] * (num === p.paywall ? 1.6 : 1));
    const paidParts = apportion(redeem_orders, weights);
    const adParts = apportion(unlock_success - redeem_orders, weights);
    const attemptParts = apportion(unlock_attempts, weights);
    const mapped = r2(recharge_gmv_usd * p.mappedShare);
    const revParts = paidParts.reduce((a, b) => a + b, 0) ? apportion(Math.round(mapped * 100), paidParts).map((c) => c / 100) : paidParts.map(() => 0);
    for (let k = 0; k < p.episodes; k++) {
      const num = k + 1;
      const pi = paywalled.indexOf(num);
      const st = Math.round(uniques[k] * 1.15);
      episode_daily.push({
        number: num,
        date,
        starts: st,
        unique_starters: uniques[k],
        direct_entries: direct[k],
        continued_to_next: k < p.episodes - 1 ? (windowElapsed ? contRaw[k] : null) : null,
        completions: Math.round(st * Math.min(0.95, p.completion + 0.04 * (k === 0 ? 1 : 0) + 0.03 * n(`ec${k}`))),
        watch_seconds: Math.round(st * p.avgWatch * (1 + 0.05 * n(`ew${k}`))),
        paywall_reached: pi >= 0 || num === (p.paywall ?? 0) - 1 ? Math.round(uniques[k] * 0.78) : 0,
        unlock_attempts: pi >= 0 ? attemptParts[pi] : 0,
        paid_unlocks: pi >= 0 ? paidParts[pi] : 0,
        ad_unlocks: pi >= 0 ? adParts[pi] : 0,
        revenue_usd: pi >= 0 ? revParts[pi] : 0,
      });
    }
  }

  const hasData = s.historyDays > 0;
  return {
    listing_id: lid,
    source: "demo",
    currency: "USD",
    data_from: hasData ? from : today,
    data_through: hasData ? through : today,
    last_sync_at: hasData ? `${addDays(through, s.syncStatus === "failed" ? 1 : s.lagDays > 1 ? 0 : 1)}T04:30:00.000Z` : `${today}T04:30:00.000Z`,
    sync_status: s.syncStatus,
    unavailable: s.listing.unavailable_components,
    episode_attribution: s.listing.episode_attribution,
    paywall_episode: p.paywall,
    fee_share: s.feeShare,
    dedupe: { viewers: 0.35, payers: 0.45 },
    continuation_window_days: W,
    platform_ltv: s.platformLtv != null && hasData ? { value: s.platformLtv, period_from: addDays(through, -29), period_to: through } : null,
    settled_through: hasData && s.settledLag != null ? addDays(through, -s.settledLag) : null,
    paid_out_through: hasData && s.paidOutDay != null ? "2026-07-31" : null,
    region_split: [{ region: "US", share: 0.86 }, { region: "CA", share: 0.08 }, { region: "GB", share: 0.06 }],
    source_split: [{ source: "feed_recommendation", share: 0.61 }, { source: "search", share: 0.14 }, { source: "paid_ads", share: 0.09 }, { source: "other_or_unknown", share: 0.16 }],
    daily,
    episode_daily,
    prior_rounds: s.priorRounds ?? [],
    campaign_attribution: s.attribution ?? {},
  };
}

export type DemoAnalytics = {
  today: string;
  listings: AnalyticsListing[];
  links: AnalyticsLink[];
  datasets: Map<string, TitleDataset>;
};

const cache = new Map<string, DemoAnalytics>();

/** The demo analytics world for `today` (memoized; the store's links are the mutable copy). */
export function buildDemoAnalytics(today: string = DEMO_TODAY): DemoAnalytics {
  const hit = cache.get(today);
  if (hit) return hit;
  const listings: AnalyticsListing[] = [];
  const links: AnalyticsLink[] = [];
  const datasets = new Map<string, TitleDataset>();
  SCENARIOS.forEach((s, i) => {
    const ds = buildDataset(s, today);
    datasets.set(s.listing.id, ds);
    listings.push({
      ...s.listing,
      producer_id: PRODUCER_ID,
      platform: "tiktok_drama_center_demo",
      platform_label: PLATFORM_LABEL,
      coverage_from: ds.daily.length ? ds.data_from : null,
      coverage_to: ds.daily.length ? ds.data_through : null,
      last_sync_at: ds.last_sync_at,
      sync_status: ds.sync_status,
      linked_title_id: null,
      linked_title_name: null,
      source: "demo",
    });
    if (s.linkTo != null) {
      links.push({ id: uuid(B_LINK, i + 1), producer_id: PRODUCER_ID, title_id: demoTitleId(s.linkTo), listing_id: s.listing.id, linked_by: PRODUCER_USER_ID, linked_at: `${addDays(today, -s.linkedDaysAgo)}T08:00:00.000Z` });
    }
  });
  const built = { today, listings, links, datasets };
  cache.set(today, built);
  return built;
}

/** Which scenario title each listing is meant for, for tests and docs. */
export const DEMO_SCENARIO_TITLES = { strong_viewing_weak_monetization: 8, strong_monetization_low_traffic: 6, paywall_drop: 1, expensive_acquisition: 4, no_campaign: 7, unmapped: 3, awaiting_data: 12, immature_cohort: 14, stale: 10, sync_failed: 2 } as const;
