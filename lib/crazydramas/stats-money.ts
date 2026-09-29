// Money, the paywall, VIP and coins on crazydramas.com (decision 2026-09-28 "Stats for coins and VIP"): pure sums
// over crazydramas' report (`payments`, `paywall_days`, `vip`, `coins`; crazydramas docs/COINS.md and
// docs/STUDIO_API.md). Client-safe, like ./stats-summary.ts.
//
// The owner's calls (2026-09-28):
//   money   cash the day it is paid, before Stripe's fees; refunds counted against the day the payment was made
//           (as RevenueCat does), since the ledger keeps no refund date.
//   series  a series and its ads are credited with coins where they are spent (crazydramas does it in the source
//           rows); a coin pack itself credits no series.
//   first   a person's first payment of all: a second coin pack is a repeat, not a new payer.

import { NO_PLACE, sourceKey, type DashFilter } from "./stats-summary";
import { PAYMENT_KINDS, type CdStatsPayment, type CdStatsReport, type PaymentKind } from "./stats-types";

type Span = { from: string; to: string };

/** The report carries coins and VIP details (crazydramas since 2026-09-28): without them those tabs say so. */
export const hasMoneyDetails = (report: Pick<CdStatsReport, "payments">): boolean => Array.isArray(report.payments);

/** The report's payments carry the payer's whole origin (ad, stored copy, phone, country), so every filter applies. */
export const paymentsHaveOrigin = (report: Pick<CdStatsReport, "payments">): boolean => (report.payments ?? []).some((p) => p.stored_copy !== undefined);

/**
 * The payments of a period, scoped like the rest of the page. Series: the one the payment is tied to, coin packs
 * never (a pack credits no series, even one bought on its unlock sheet: its coins do, where they are spent, in the
 * Series tab and the source rows). Source, phone and country: the paying browser's origin, by the rows' own rule
 * (`sourceKey`). A report from before crazydramas sent the whole origin has platform and campaign only: the source
 * is then read from those, and phone and country do not apply (the Money tab says so).
 */
export function paymentsIn(report: Pick<CdStatsReport, "payments">, span: Span, filter: Partial<DashFilter>): CdStatsPayment[] {
  return (report.payments ?? []).filter((p) => {
    if (p.day < span.from || p.day > span.to) return false;
    if (filter.series && (p.kind === "coins" || p.drama_id !== filter.series)) return false;
    const whole = p.stored_copy !== undefined;
    if (whole && filter.device && p.device !== filter.device) return false;
    if (whole && filter.country && (p.country ?? NO_PLACE) !== filter.country) return false;
    const src = filter.source;
    if (!src) return true;
    const key = whole
      ? sourceKey({ stored_copy: !!p.stored_copy, ad: p.ad ?? null, campaign: p.campaign })
      : p.campaign
        ? `campaign:${p.campaign}`
        : p.platform === "tiktok"
          ? "stored_copy"
          : "no_ad";
    return src === "ads" ? key.startsWith("campaign:") : key === src;
  });
}

export type MoneyTotals = {
  /** Every payment's cash, refunded ones too; what was refunded of it; what stayed (cash − refunds). */
  cash_cents: number;
  refund_cents: number;
  net_cents: number;
  payments: number;
  refunds: number;
  /** Different people who paid (refunds left out); of them, the ones whose first payment of all this was. */
  payers: number;
  first_payers: number;
  /** Net cash per kind of product. */
  by_kind: Record<PaymentKind, number>;
};

const noKinds = (): Record<PaymentKind, number> => Object.fromEntries(PAYMENT_KINDS.map((k) => [k, 0])) as Record<PaymentKind, number>;

export function moneyTotals(list: readonly CdStatsPayment[]): MoneyTotals {
  const t: MoneyTotals = { cash_cents: 0, refund_cents: 0, net_cents: 0, payments: 0, refunds: 0, payers: 0, first_payers: 0, by_kind: noKinds() };
  const payers = new Set<string>();
  const firsts = new Set<string>();
  for (const p of list) {
    t.cash_cents += p.cents;
    t.payments++;
    if (p.refunded) {
      t.refund_cents += p.cents;
      t.refunds++;
      continue;
    }
    t.by_kind[p.kind] += p.cents;
    payers.add(p.person);
    if (p.first) firsts.add(p.person);
  }
  t.net_cents = t.cash_cents - t.refund_cents;
  t.payers = payers.size;
  t.first_payers = firsts.size;
  return t;
}

/** Cents per payer: net cash over the different people who paid (null with nobody). */
export const perPayer = (t: Pick<MoneyTotals, "net_cents" | "payers">): number | null => (t.payers ? Math.round(t.net_cents / t.payers) : null);

/** The money chart's stacks: net cash per kind of product each day, refunds as their own (drawn below zero). */
export type MoneyDayStack = { day: string } & Record<PaymentKind | "refunds", number>;
export function moneyByDay(list: readonly CdStatsPayment[], days: readonly string[]): MoneyDayStack[] {
  const at = new Map(days.map((d) => [d, { day: d, refunds: 0, ...noKinds() } as MoneyDayStack]));
  for (const p of list) {
    const row = at.get(p.day);
    if (!row) continue;
    if (p.refunded) row.refunds += p.cents;
    else row[p.kind] += p.cents;
  }
  return days.map((d) => at.get(d)!);
}

/** Seconds from a person's first visit to their first payment of all: the middle value (null without any). */
export function medianToFirstPay(list: readonly CdStatsPayment[]): number | null {
  const s = list.filter((p) => p.first && !p.refunded && p.paid_after_s !== null).map((p) => p.paid_after_s!).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
}

/** What sold, most money first: each product's payments and net cash (refunds left out). */
export function productMix(list: readonly CdStatsPayment[]): { product: string; kind: PaymentKind; payments: number; cents: number }[] {
  const m = new Map<string, { product: string; kind: PaymentKind; payments: number; cents: number }>();
  for (const p of list) {
    if (p.refunded) continue;
    const key = p.product ?? p.kind;
    const row = m.get(key) ?? { product: key, kind: p.kind, payments: 0, cents: 0 };
    row.payments++;
    row.cents += p.cents;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => b.cents - a.cents || b.payments - a.payments);
}

// ---- the paywall ---------------------------------------------------------------------------------------------

/** Where a checkout was opened: the unlock sheet, the "Exclusive Gift" and "Don't stop here" pop-ups, the store page. */
export const PLACEMENTS = ["sheet", "gift", "retention", "store"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export type PaywallTotals = {
  /** Unlock sheets shown (views, not people); episodes opened with coins. */
  views: number;
  unlocks: number;
  /** People shown a sheet / who opened an episode with coins, added up day by day (a person on two days counts twice). */
  viewer_days: number;
  unlocker_days: number;
  gift_shown: number;
  retention_shown: number;
  not_completed: number;
  checkouts: Record<Placement | "other", number>;
};

export function paywallIn(report: Pick<CdStatsReport, "paywall_days">, span: Span): PaywallTotals {
  const t: PaywallTotals = { views: 0, unlocks: 0, viewer_days: 0, unlocker_days: 0, gift_shown: 0, retention_shown: 0, not_completed: 0, checkouts: { sheet: 0, gift: 0, retention: 0, store: 0, other: 0 } };
  for (const d of report.paywall_days ?? []) {
    if (d.day < span.from || d.day > span.to) continue;
    t.views += d.views;
    t.unlocks += d.unlocks;
    t.viewer_days += d.viewers;
    t.unlocker_days += d.unlockers;
    t.gift_shown += d.gift_shown;
    t.retention_shown += d.retention_shown;
    t.not_completed += d.not_completed;
    for (const [k, n] of Object.entries(d.checkouts)) {
      const key = (PLACEMENTS as readonly string[]).includes(k) ? (k as Placement) : "other";
      t.checkouts[key] += n;
    }
  }
  return t;
}

/**
 * One row per screen that sells: how often it was shown (the store page has no count), the checkouts it opened,
 * what was paid from it and how much. Payments from before the screen was recorded (no placement) count as the
 * sheet's.
 */
export type PlacementRow = { placement: Placement; shown: number | null; checkouts: number; paid: number; cents: number };
export function placementRows(pw: PaywallTotals, list: readonly CdStatsPayment[]): PlacementRow[] {
  const paid = (pl: Placement) => list.filter((p) => !p.refunded && p.kind !== "vip_renewal" && (p.placement === pl || (pl === "sheet" && !p.placement)));
  const shown: Record<Placement, number | null> = { sheet: pw.views, gift: pw.gift_shown, retention: pw.retention_shown, store: null };
  return PLACEMENTS.map((pl) => {
    const ps = paid(pl);
    return { placement: pl, shown: shown[pl], checkouts: pw.checkouts[pl] + (pl === "sheet" ? pw.checkouts.other : 0), paid: ps.length, cents: ps.reduce((a, p) => a + p.cents, 0) };
  });
}

/** The first-time prices taken in a period: the $1.99 VIP week and the first-time $4.99 pack. */
export function firstOffersTaken(list: readonly CdStatsPayment[]): { first_week: number; first_pack: number } {
  const live = list.filter((p) => !p.refunded);
  // Only the $1.99 week itself: its renewals carry the subscription's `offer: first_week` too.
  return { first_week: live.filter((p) => p.kind === "vip_intro").length, first_pack: live.filter((p) => p.product === "coins:c500first").length };
}

// ---- VIP -------------------------------------------------------------------------------------------------------

/** A plan's price over a month (a week is 52/12 of one): what monthly recurring revenue adds up. Unknown plans (the app stores' All-Access) count as weekly. */
export const PLAN_MONTHLY_CENTS: Record<string, number> = { all_access_weekly: (699 * 52) / 12, vip_monthly: 1399, vip_yearly: 6999 / 12 };
export const planOf = (plan: string | null): "weekly" | "monthly" | "yearly" => (plan === "vip_monthly" ? "monthly" : plan === "vip_yearly" ? "yearly" : "weekly");

export type VipNow = {
  /** Subscriptions on today, by plan; of them, the ones still in their $1.99 first week. */
  active: number;
  by_plan: Record<"weekly" | "monthly" | "yearly", number>;
  intros: number;
  /** Monthly recurring revenue of the paying ones (first weeks left out until they renew, as Stripe leaves trials out). */
  mrr_cents: number;
};

export function vipNow(report: Pick<CdStatsReport, "vip" | "to">): VipNow {
  const out: VipNow = { active: 0, by_plan: { weekly: 0, monthly: 0, yearly: 0 }, intros: 0, mrr_cents: 0 };
  for (const v of report.vip ?? []) {
    if (!v.active || (v.expires_day !== null && v.expires_day < report.to)) continue;
    out.active++;
    out.by_plan[planOf(v.plan)]++;
    if (v.intro) out.intros++;
    else out.mrr_cents += PLAN_MONTHLY_CENTS[v.plan ?? "all_access_weekly"] ?? PLAN_MONTHLY_CENTS.all_access_weekly;
  }
  out.mrr_cents = Math.round(out.mrr_cents);
  return out;
}

/**
 * A VIP that ended: its paid time ran out before today with no renewal (cancelled, unpaid: crazydramas leaves these
 * `active`, their end date past), or it was stopped early (refund, dispute: `active` false, ended the day it stopped).
 */
const vipHasEnded = (v: { active: boolean; expires_day: string | null }, today: string): v is { active: boolean; expires_day: string } =>
  v.expires_day !== null && (!v.active || v.expires_day < today);

/** VIPs that ended in the period (see vipHasEnded). */
export function vipEnded(report: Pick<CdStatsReport, "vip" | "to">, span: Span): number {
  return (report.vip ?? []).filter((v) => vipHasEnded(v, report.to) && v.expires_day >= span.from && v.expires_day <= span.to).length;
}

export type VipPeriod = {
  /** New subscriptions: at the $1.99 first week, and at full price. */
  new_intro: number;
  new_full: number;
  renewals: number;
  renewal_cents: number;
  /** $1.99 first weeks whose week ran out in the period (by yesterday), and of them the ones renewed at full price. */
  intros_due: number;
  intros_renewed: number;
};

/** VIP in a period, from the payments: new subscriptions, renewals, and how many $1.99 weeks turned into paid ones. */
export function vipPeriod(report: Pick<CdStatsReport, "payments" | "to">, span: Span): VipPeriod {
  const all = (report.payments ?? []).filter((p) => !p.refunded);
  const inSpan = all.filter((p) => p.day >= span.from && p.day <= span.to);
  const out: VipPeriod = { new_intro: 0, new_full: 0, renewals: 0, renewal_cents: 0, intros_due: 0, intros_renewed: 0 };
  for (const p of inSpan) {
    if (p.kind === "vip_intro") out.new_intro++;
    else if (p.kind === "vip") out.new_full++;
    else if (p.kind === "vip_renewal") {
      out.renewals++;
      out.renewal_cents += p.cents;
    }
  }
  // Due by yesterday: a week due today may still renew later today.
  const yesterday = addDays(report.to, -1);
  const lastDue = span.to < yesterday ? span.to : yesterday;
  for (const p of all) {
    const due = addDays(p.day, 7);
    if (p.kind !== "vip_intro" || due < span.from || due > lastDue) continue;
    out.intros_due++;
    if (all.some((r) => r.person === p.person && r.kind === "vip_renewal" && r.day > p.day)) out.intros_renewed++;
  }
  return out;
}

/** The VIP chart: per week (Monday first), new first weeks, new full-price subscriptions, renewals, and ended (below zero). */
export type VipWeek = { week: string; new_intro: number; new_full: number; renewals: number; ended: number };
export function vipWeeks(report: Pick<CdStatsReport, "payments" | "vip" | "to">, span: Span): VipWeek[] {
  const weeks = new Map<string, VipWeek>();
  for (let d = weekOf(span.from); d <= span.to; d = addDays(d, 7)) weeks.set(d, { week: d, new_intro: 0, new_full: 0, renewals: 0, ended: 0 });
  for (const p of report.payments ?? []) {
    if (p.refunded || p.day < span.from || p.day > span.to) continue;
    const w = weeks.get(weekOf(p.day));
    if (!w) continue;
    if (p.kind === "vip_intro") w.new_intro++;
    else if (p.kind === "vip") w.new_full++;
    else if (p.kind === "vip_renewal") w.renewals++;
  }
  for (const v of report.vip ?? []) {
    if (!vipHasEnded(v, report.to) || v.expires_day < span.from || v.expires_day > span.to) continue;
    const w = weeks.get(weekOf(v.expires_day));
    if (w) w.ended++;
  }
  return [...weeks.values()];
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The Monday of a day's week. */
export function weekOf(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

// ---- coins -----------------------------------------------------------------------------------------------------

export type CoinTotals = {
  bought: number;
  bonus: number;
  reward: number;
  spent_paid: number;
  spent_bonus: number;
  expired: number;
  clawed_back: number;
  unlocks: number;
};

export function coinsIn(report: Pick<CdStatsReport, "coins">, span: Span): CoinTotals {
  const t: CoinTotals = { bought: 0, bonus: 0, reward: 0, spent_paid: 0, spent_bonus: 0, expired: 0, clawed_back: 0, unlocks: 0 };
  for (const d of report.coins?.days ?? []) {
    if (d.day < span.from || d.day > span.to) continue;
    for (const k of Object.keys(t) as (keyof CoinTotals)[]) t[k] += d[k];
  }
  return t;
}

/** The coins chart: coins in (bought, bonus, reward) and out (spent paid, spent bonus, expired) each day. */
export type CoinDayStack = { day: string } & CoinTotals;
export function coinsByDay(report: Pick<CdStatsReport, "coins">, days: readonly string[]): CoinDayStack[] {
  const at = new Map((report.coins?.days ?? []).map((d) => [d.day, d]));
  return days.map((day) => {
    const d = at.get(day);
    return { day, bought: d?.bought ?? 0, bonus: d?.bonus ?? 0, reward: d?.reward ?? 0, spent_paid: d?.spent_paid ?? 0, spent_bonus: d?.spent_bonus ?? 0, expired: d?.expired ?? 0, clawed_back: d?.clawed_back ?? 0, unlocks: d?.unlocks ?? 0 };
  });
}

/** Of the people who bought coins in a period, how many bought more than once (all their packs, not only the period's). */
export function repeatCoinBuyers(report: Pick<CdStatsReport, "payments">, list: readonly CdStatsPayment[]): { buyers: number; repeat: number } {
  const buyers = new Set(list.filter((p) => p.kind === "coins" && !p.refunded).map((p) => p.person));
  const packsOf = new Map<string, number>();
  for (const p of report.payments ?? []) if (p.kind === "coins" && !p.refunded) packsOf.set(p.person, (packsOf.get(p.person) ?? 0) + 1);
  return { buyers: buyers.size, repeat: [...buyers].filter((b) => (packsOf.get(b) ?? 0) >= 2).length };
}

/** Coins spent on each series in a period and what they credited it. */
export function coinsBySeries(report: Pick<CdStatsReport, "coins">, span: Span): Map<string, { spent_paid: number; spent_bonus: number; cents: number; unlocks: number }> {
  const out = new Map<string, { spent_paid: number; spent_bonus: number; cents: number; unlocks: number }>();
  for (const r of report.coins?.series_days ?? []) {
    if (r.day < span.from || r.day > span.to) continue;
    const t = out.get(r.drama_id) ?? { spent_paid: 0, spent_bonus: 0, cents: 0, unlocks: 0 };
    t.spent_paid += r.spent_paid;
    t.spent_bonus += r.spent_bonus;
    t.cents += r.cents;
    t.unlocks += r.unlocks;
    out.set(r.drama_id, t);
  }
  return out;
}
