// The stats page's first tab answers the daily questions without a query (decision 2026-10-04 "The summary answers
// the daily questions"): how the paywall test's two sheets are doing, what was bought (VIP against a series
// against coins), and what each campaign spent for what it sold. Pure sums over crazydramas' report
// (`payments[].arm`, `paywall_days[].arms`, since 2026-10-04) and the campaign rows of `stats-summary.ts`.
import type { CampaignRow } from "./stats-summary";
import { PAYWALL_ARMS, type CdStatsPayment, type CdStatsReport, type PaywallArm } from "./stats-types";

type Span = { from: string; to: string };

/** What a payment bought, as the summary groups it: a new VIP (the first week or a full plan), a series, coins, a renewal. */
export const BOUGHT_GROUPS = ["vip", "series", "coins", "renewal"] as const;
export type BoughtGroup = (typeof BOUGHT_GROUPS)[number];
export const boughtGroup = (p: Pick<CdStatsPayment, "kind">): BoughtGroup => (p.kind === "vip_intro" || p.kind === "vip" ? "vip" : p.kind === "vip_renewal" ? "renewal" : p.kind);

export type BoughtMix = Record<BoughtGroup, { payments: number; cents: number }>;
const noMix = (): BoughtMix => Object.fromEntries(BOUGHT_GROUPS.map((g) => [g, { payments: 0, cents: 0 }])) as BoughtMix;

/** Payments and cash per group; refunded payments are left out. */
export function boughtMix(list: readonly CdStatsPayment[]): BoughtMix {
  const mix = noMix();
  for (const p of list) {
    if (p.refunded) continue;
    const g = mix[boughtGroup(p)];
    g.payments++;
    g.cents += p.cents;
  }
  return mix;
}

/** One sheet of the paywall test over a period. */
export type ArmRow = {
  arm: PaywallArm;
  /** Times the sheet was shown; people shown it, per day (a person on two days counts twice, as the Paywall tab's). */
  views: number;
  viewer_days: number;
  /** Checkouts opened from it, and the people who opened one (per day). */
  checkouts: number;
  starter_days: number;
  /** Payments its viewers made (renewals and refunds left out), the people who paid, and the cash. */
  payments: number;
  payers: number;
  cents: number;
  /** Of those payments: new VIPs, series, coin packs. */
  vip: number;
  series: number;
  coins: number;
};

/**
 * The paywall test in a period: a row per sheet, VIP first. Null when crazydramas sent no arms for those days (an
 * older release, or days before the test started on 2026-10-02): the page then says so instead of showing zeros.
 * The sheets' views are the whole site's (crazydramas does not split them); `list` is the period's payments.
 */
export function paywallTest(report: Pick<CdStatsReport, "paywall_days">, span: Span, list: readonly CdStatsPayment[]): ArmRow[] | null {
  const days = (report.paywall_days ?? []).filter((d) => d.day >= span.from && d.day <= span.to && d.arms && Object.keys(d.arms).length > 0);
  if (!days.length) return null;
  return PAYWALL_ARMS.map((arm) => {
    const row: ArmRow = { arm, views: 0, viewer_days: 0, checkouts: 0, starter_days: 0, payments: 0, payers: 0, cents: 0, vip: 0, series: 0, coins: 0 };
    for (const d of days) {
      const a = d.arms?.[arm];
      if (!a) continue;
      row.views += a.views;
      row.viewer_days += a.viewers;
      row.checkouts += a.checkouts;
      row.starter_days += a.starters;
    }
    const people = new Set<string>();
    for (const p of list) {
      if (p.arm !== arm || p.refunded || p.kind === "vip_renewal") continue;
      row.payments++;
      row.cents += p.cents;
      people.add(p.person);
      const g = boughtGroup(p);
      if (g !== "renewal") row[g]++;
    }
    row.payers = people.size;
    return row;
  });
}

/** A campaign (or the stored copy, or no ad) with what it spent and what its visitors paid for in the period. */
export type CampaignBrief = {
  key: string;
  kind: CampaignRow["kind"];
  campaign_id: string | null;
  name: string | null;
  spend_cents: number | null;
  opened: number;
  checkouts: number;
  /** Payments by its visitors (renewals and refunds left out), split by what was bought, and their cash. */
  payments: number;
  vip: number;
  series: number;
  coins: number;
  cents: number;
  /** Spend over payments; null without spend or without a payment. */
  cost_per_payment_cents: number | null;
};

const briefKey = (p: CdStatsPayment): string => (p.campaign ? `campaign:${p.campaign}` : p.stored_copy || (p.stored_copy === undefined && p.platform === "tiktok") ? "stored_copy" : "no_ad");

/**
 * The campaign rows with the period's payments laid over them, by the paying browser's origin (the rows' own keys).
 * A campaign that sold something but has no row (no visit in the period: its buyer landed earlier) gets a row of its own.
 */
export function campaignBrief(rows: readonly CampaignRow[], list: readonly CdStatsPayment[]): CampaignBrief[] {
  const out = new Map<string, CampaignBrief>();
  for (const r of rows) {
    out.set(r.key, { key: r.key, kind: r.kind, campaign_id: r.campaign_id, name: r.launch_name ?? r.campaign_name, spend_cents: r.spend_cents, opened: r.opened, checkouts: r.checkouts, payments: 0, vip: 0, series: 0, coins: 0, cents: 0, cost_per_payment_cents: null });
  }
  for (const p of list) {
    if (p.refunded || p.kind === "vip_renewal") continue;
    const key = briefKey(p);
    let b = out.get(key);
    if (!b) {
      b = { key, kind: p.campaign ? "campaign" : key === "stored_copy" ? "stored_copy" : "no_ad", campaign_id: p.campaign, name: null, spend_cents: null, opened: 0, checkouts: 0, payments: 0, vip: 0, series: 0, coins: 0, cents: 0, cost_per_payment_cents: null };
      out.set(key, b);
    }
    b.payments++;
    b.cents += p.cents;
    const g = boughtGroup(p);
    if (g !== "renewal") b[g]++;
  }
  const order = { campaign: 0, stored_copy: 1, no_ad: 2 } as const;
  return [...out.values()]
    .map((b) => ({ ...b, cost_per_payment_cents: b.spend_cents !== null && b.spend_cents > 0 && b.payments > 0 ? Math.round(b.spend_cents / b.payments) : null }))
    .sort((a, b) => order[a.kind] - order[b.kind] || (b.spend_cents ?? -1) - (a.spend_cents ?? -1) || b.payments - a.payments);
}
