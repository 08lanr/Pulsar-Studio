// Every metric the analytics views show, keyed by `definition_key`. The
// provenance class says who defines it: `documented` = the TikTok mini-drama
// analytics documentation names and defines it (docs/analytics/
// tiktok-source-mapping.md, read 2026-09-08); `calculated` = Pulsar derives it
// from documented inputs with the stated formula; `proposed` = we want it but
// no public source verifies that a provider exposes it at this granularity.
// docs/analytics/metric-dictionary.md is generated from the same list by hand
// and must stay in step.

import type { Evidence } from "@/lib/research/types";

export type ProvenanceClass = "documented" | "calculated" | "proposed";

export type Definition = {
  key: string;
  name_en: string;
  name_zh: string;
  unit: "people" | "events" | "orders" | "usd" | "rate" | "seconds" | "coins" | "usd_per_user" | "ratio";
  scope: "title" | "episode" | "campaign" | "cohort";
  window: string;
  denominator: string | null;
  formula: string;
  provenance: ProvenanceClass;
  evidence: Evidence;
  note?: string;
};

const D = (d: Definition) => d;

export const DEFINITIONS: Definition[] = [
  // ---- viewing ----
  D({ key: "viewers", name_en: "Viewers", name_zh: "观看用户", unit: "people", scope: "title", window: "selected period", denominator: null, formula: "Distinct users who started any episode of the listing in the period (period-unique; daily uniques are never summed).", provenance: "documented", evidence: "partner_reported", note: "TikTok documents active/new users at app level; per-listing uniqueness is proposed." }),
  D({ key: "viewers_daily", name_en: "Daily viewers", name_zh: "每日观看用户", unit: "people", scope: "title", window: "one day", denominator: null, formula: "Distinct users who started any episode that day.", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "new_viewers", name_en: "New viewers", name_zh: "新观看用户", unit: "people", scope: "title", window: "selected period", denominator: null, formula: "Users whose first start of any episode of the listing falls in the period.", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "starts", name_en: "Episode starts", name_zh: "剧集开播次数", unit: "events", scope: "title", window: "selected period", denominator: null, formula: "Sum of episode start events (replays count again).", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "completions", name_en: "Completions", name_zh: "完播次数", unit: "events", scope: "title", window: "selected period", denominator: null, formula: "Episode start events that reached the end of the episode.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "completion_rate", name_en: "Completion rate", name_zh: "完播率", unit: "rate", scope: "episode", window: "selected period", denominator: "episode starts", formula: "completions / starts.", provenance: "calculated", evidence: "inferred" }),
  D({ key: "watch_seconds_avg", name_en: "Average watch time", name_zh: "平均观看时长", unit: "seconds", scope: "episode", window: "selected period", denominator: "episode starts", formula: "total watch seconds / starts.", provenance: "calculated", evidence: "inferred", note: "TikTok documents median duration per user at app level, not per episode." }),
  D({ key: "continuation", name_en: "Continuation to next episode", name_zh: "续看率（下一集）", unit: "rate", scope: "episode", window: "3 days after starting episode N", denominator: "eligible unique starters of episode N (started at least 3 days before data end)", formula: "starters of N who started N+1 within 3 days / eligible starters of N. Mid-title entries into N+1 are not in the numerator; replays are not counted twice.", provenance: "proposed", evidence: "inferred" }),
  D({ key: "unique_starters", name_en: "Unique starting viewers", name_zh: "开播用户数", unit: "people", scope: "episode", window: "selected period", denominator: null, formula: "Distinct users who started the episode in the period.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "direct_entries", name_en: "Mid-title entries", name_zh: "中途进入", unit: "people", scope: "episode", window: "selected period", denominator: null, formula: "Unique starters of N who had not started N-1 in the previous 3 days (entered from a feed, search or a link).", provenance: "proposed", evidence: "partner_reported" }),
  // ---- funnel ----
  D({ key: "entries", name_en: "Entries", name_zh: "进入次数", unit: "events", scope: "title", window: "selected period", denominator: null, formula: "Visits to the listing (documented as 'TT Minis Visit PV' for Mini Program).", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "playbacks", name_en: "Entries with playback", name_zh: "有播放的进入", unit: "events", scope: "title", window: "selected period", denominator: null, formula: "Entries during which at least one episode started playing.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "paywall_reached", name_en: "Reached last free episode", name_zh: "到达最后免费集", unit: "events", scope: "title", window: "selected period", denominator: null, formula: "Documented as 'Last Free Episode Watch PV' (page views, not people).", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "unlock_attempts", name_en: "Payment or unlock interactions", name_zh: "支付/解锁交互", unit: "events", scope: "title", window: "selected period", denominator: null, formula: "Payment panel shows and clicks plus ad-unlock starts (documented as payment panel PVs).", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "unlock_success", name_en: "Successful unlocks", name_zh: "成功解锁", unit: "orders", scope: "title", window: "selected period", denominator: null, formula: "Consumption orders plus completed ad unlocks.", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "continued_after_unlock", name_en: "Continued viewing after unlock", name_zh: "解锁后继续观看", unit: "people", scope: "title", window: "selected period", denominator: null, formula: "Users who started the unlocked episode after a successful unlock.", provenance: "proposed", evidence: "partner_reported" }),
  // ---- monetization ----
  D({ key: "iap_gross", name_en: "IAP gross sales (GMV)", name_zh: "内购总销售额（GMV）", unit: "usd", scope: "title", window: "selected period", denominator: null, formula: "Total sales value of recharge orders, before refunds and fees (documented as GMV).", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "ad_revenue", name_en: "In-app ad revenue", name_zh: "广告收入", unit: "usd", scope: "title", window: "selected period", denominator: null, formula: "Ad revenue after the platform fee deduction, as documented.", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "iap_share", name_en: "IAP share of revenue", name_zh: "内购占比", unit: "rate", scope: "title", window: "selected period", denominator: "IAP gross + ad revenue", formula: "iap_gross / (iap_gross + ad_revenue). Unavailable when either side is unavailable.", provenance: "calculated", evidence: "inferred" }),
  D({ key: "paying_users", name_en: "Paying users", name_zh: "付费用户", unit: "people", scope: "title", window: "selected period", denominator: null, formula: "Deduplicated users with at least one successful recharge order in the period.", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "payer_conversion", name_en: "Payer conversion", name_zh: "付费转化率", unit: "rate", scope: "title", window: "selected period", denominator: "viewers (period-unique)", formula: "paying_users / viewers. TikTok's 'percentage of paying users' uses active users of the app as denominator; ours uses viewers of the listing.", provenance: "calculated", evidence: "inferred" }),
  D({ key: "repeat_payers", name_en: "Repeat paying users", name_zh: "复购用户", unit: "people", scope: "title", window: "selected period", denominator: null, formula: "Deduplicated users with more than one successful recharge order in the period.", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "repeat_share", name_en: "Repeat payer share", name_zh: "复购用户占比", unit: "rate", scope: "title", window: "selected period", denominator: "paying users", formula: "repeat_payers / paying_users.", provenance: "documented", evidence: "inferred" }),
  D({ key: "arppu", name_en: "ARPPU", name_zh: "付费用户平均收入", unit: "usd_per_user", scope: "title", window: "selected period", denominator: "paying users", formula: "iap_gross / paying_users (gross basis).", provenance: "documented", evidence: "inferred" }),
  D({ key: "recharge_orders", name_en: "Recharge orders", name_zh: "充值订单", unit: "orders", scope: "title", window: "selected period", denominator: null, formula: "Orders that bought coins (documented as recharge / top-up orders). These carry the money.", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "redeem_orders", name_en: "Redeem orders", name_zh: "消耗订单", unit: "orders", scope: "title", window: "selected period", denominator: null, formula: "Orders that spent coins to unlock episodes (documented as redeem / consumption orders). Never counted as revenue.", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "redeem_coins", name_en: "Coins redeemed", name_zh: "消耗虚拟币", unit: "coins", scope: "title", window: "selected period", denominator: null, formula: "Coins spent on unlocks. A quantity of virtual currency, not money.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "avg_gmv_per_order", name_en: "Average GMV per recharge order", name_zh: "每充值订单平均金额", unit: "usd", scope: "title", window: "selected period", denominator: "recharge orders", formula: "iap_gross / recharge_orders.", provenance: "documented", evidence: "inferred" }),
  D({ key: "refunds", name_en: "Refunds", name_zh: "退款", unit: "usd", scope: "title", window: "selected period", denominator: null, formula: "Refunded recharge value in the period (by refund date).", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "fees_share", name_en: "Platform fees and revenue share", name_zh: "平台费用与分成", unit: "usd", scope: "title", window: "selected period", denominator: null, formula: "(iap_gross - refunds) x the contract's platform share. The share itself is contractual and not public.", provenance: "proposed", evidence: "estimated" }),
  D({ key: "publisher_earnings", name_en: "Publisher earnings", name_zh: "发行方收益", unit: "usd", scope: "title", window: "selected period", denominator: null, formula: "iap_gross - refunds - fees_share (+ ad_revenue when reported after fees).", provenance: "proposed", evidence: "estimated" }),
  D({ key: "settled", name_en: "Settled", name_zh: "已结算", unit: "usd", scope: "title", window: "selected period, through the settlement cutoff", denominator: null, formula: "Publisher earnings for days the platform has settled (documented as risk-controlled T+1 data).", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "paid_out", name_en: "Paid out", name_zh: "已打款", unit: "usd", scope: "title", window: "through the last payout", denominator: null, formula: "Amount transferred to the publisher's account. Not exposed by the analytics documentation.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "platform_ltv", name_en: "Platform-reported LTV", name_zh: "平台报告 LTV", unit: "usd_per_user", scope: "title", window: "platform-defined", denominator: "new users of the period", formula: "As documented by TikTok: 'average sales for new users in the date range'. Kept separate from Pulsar's cohort figure.", provenance: "documented", evidence: "partner_reported" }),
  D({ key: "cohort_d7", name_en: "Observed D7 revenue per user", name_zh: "D7 观测人均收入", unit: "usd_per_user", scope: "cohort", window: "7 days after cohort entry", denominator: "initial eligible cohort users", formula: "eligible cumulative cohort revenue / initial eligible cohort users. Cohort entry = first start of any episode; eligible = entry date at least 7 days before data end.", provenance: "calculated", evidence: "inferred" }),
  D({ key: "cohort_d30", name_en: "Observed D30 revenue per user", name_zh: "D30 观测人均收入", unit: "usd_per_user", scope: "cohort", window: "30 days after cohort entry", denominator: "initial eligible cohort users", formula: "eligible cumulative cohort revenue / initial eligible cohort users. Eligible = entry date at least 30 days before data end.", provenance: "calculated", evidence: "inferred" }),
  // ---- episodes ----
  D({ key: "paywall_reached_ep", name_en: "Reached paywall", name_zh: "到达付费点", unit: "people", scope: "episode", window: "selected period", denominator: null, formula: "Unique starters of the episode who saw the unlock prompt for the next episode.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "paid_unlocks", name_en: "Paid unlocks", name_zh: "付费解锁", unit: "orders", scope: "episode", window: "selected period", denominator: null, formula: "Redeem orders that unlocked this episode.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "ad_unlocks", name_en: "Ad-supported unlocks", name_zh: "广告解锁", unit: "orders", scope: "episode", window: "selected period", denominator: null, formula: "Completed rewarded-ad unlocks of this episode.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "unlock_conversion", name_en: "Unlock conversion", name_zh: "解锁转化率", unit: "rate", scope: "episode", window: "selected period", denominator: "unlock interactions on this episode", formula: "(paid_unlocks + ad_unlocks) / unlock_attempts.", provenance: "calculated", evidence: "inferred" }),
  D({ key: "episode_revenue", name_en: "Directly mapped episode revenue", name_zh: "直接归属剧集收入", unit: "usd", scope: "episode", window: "selected period", denominator: null, formula: "Recharge value redeemed on this episode's unlocks. The sum over episodes is at most the title's IAP gross; coins bought but not yet redeemed stay unmapped.", provenance: "proposed", evidence: "estimated" }),
  // ---- acquisition ----
  D({ key: "spend", name_en: "Spend", name_zh: "花费", unit: "usd", scope: "campaign", window: "campaign result window", denominator: null, formula: "Sum of spend_usd over the campaign's promote.results rows.", provenance: "calculated", evidence: "observed" }),
  D({ key: "impressions", name_en: "Impressions", name_zh: "曝光", unit: "events", scope: "campaign", window: "campaign result window", denominator: null, formula: "Sum of impressions over result rows. Ad impressions are never added to title views.", provenance: "calculated", evidence: "observed" }),
  D({ key: "clicks", name_en: "Clicks", name_zh: "点击", unit: "events", scope: "campaign", window: "campaign result window", denominator: null, formula: "Sum of clicks over result rows.", provenance: "calculated", evidence: "observed" }),
  D({ key: "ctr", name_en: "CTR", name_zh: "点击率", unit: "rate", scope: "campaign", window: "campaign result window", denominator: "impressions", formula: "clicks / impressions.", provenance: "calculated", evidence: "inferred" }),
  D({ key: "cpc", name_en: "CPC", name_zh: "单次点击成本", unit: "usd", scope: "campaign", window: "campaign result window", denominator: "clicks", formula: "spend / clicks.", provenance: "calculated", evidence: "inferred" }),
  D({ key: "cpm", name_en: "CPM", name_zh: "千次曝光成本", unit: "usd", scope: "campaign", window: "campaign result window", denominator: "impressions / 1000", formula: "spend / impressions x 1000.", provenance: "calculated", evidence: "inferred" }),
  D({ key: "hook_hold_rate", name_en: "Hook hold rate", name_zh: "前 3 秒留存率", unit: "rate", scope: "campaign", window: "campaign result window", denominator: "video views", formula: "Share of viewers still watching at 3 s, impression-weighted over result rows (the same field lib/research/assessment.ts benchmarks).", provenance: "calculated", evidence: "observed" }),
  D({ key: "attributed_users", name_en: "Attributed acquired users", name_zh: "归因获取用户", unit: "people", scope: "campaign", window: "attribution window", denominator: null, formula: "Users whose first start of the listing follows an ad click within the attribution window. Reported by the ad platform; not derivable from title analytics.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "attributed_payers", name_en: "Attributed payers", name_zh: "归因付费用户", unit: "people", scope: "campaign", window: "attribution window", denominator: null, formula: "Attributed users with a successful recharge order.", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "attributed_revenue", name_en: "Attributed revenue", name_zh: "归因收入", unit: "usd", scope: "campaign", window: "attribution window", denominator: null, formula: "IAP gross from attributed users. Always at most the title's revenue in the same window; the remainder is unattributed (not 'organic').", provenance: "proposed", evidence: "partner_reported" }),
  D({ key: "cost_per_acquired_user", name_en: "Cost per acquired user", name_zh: "单个获取用户成本", unit: "usd", scope: "campaign", window: "attribution window", denominator: "attributed users", formula: "spend / attributed_users.", provenance: "calculated", evidence: "inferred" }),
  D({ key: "cohort_roas", name_en: "Cohort ROAS", name_zh: "归因 ROAS", unit: "ratio", scope: "campaign", window: "attribution window", denominator: "spend", formula: "attributed_revenue / spend, gross basis. A ratio of attributable sales to spend; not profit.", provenance: "calculated", evidence: "inferred" }),
];

const BY_KEY = new Map(DEFINITIONS.map((d) => [d.key, d]));

export function definition(key: string): Definition | undefined {
  return BY_KEY.get(key);
}
