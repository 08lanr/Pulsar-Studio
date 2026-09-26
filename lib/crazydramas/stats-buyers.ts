// Buyers on the CrazyDramas stats pages (decision 2026-09-26, "Stats: campaigns, buyers and the full episode
// curve"). Ruobin: "I dont know if the 6 buyers are different for the same people ... perhaps i can click on
// buyers? see where they came from?" crazydramas' report now lists every payment under a person code (one code
// across a person's browsers) and each buyer's steps; this module narrows them by the filter row, counts people
// against payments, reads one person's header, and turns their steps into a timeline. Pure and client-safe;
// tests/crazydramas-buyers.test.ts.

import { dayIn, NO_PLACE, sourceKey, type DashFilter } from "./stats-summary";
import type { CdStatsJourneyStep, CdStatsPurchase, CdStatsReport, CdStatsTouch, JourneyKind } from "./stats-types";

const inRange = (day: string, r: { from: string; to: string }) => day >= r.from && day <= r.to;
const ms = (iso: string) => Date.parse(iso);

/** Does the report carry buyer details at all (an older crazydramas does not). */
export function hasBuyerDetails(report: Pick<CdStatsReport, "purchases">): boolean {
  return Array.isArray(report.purchases);
}

/** A payment's source in the filter row's words (a payment with no recorded landing is "no ad"). */
export function purchaseSourceKey(p: Pick<CdStatsPurchase, "source">): string {
  return p.source ? sourceKey(p.source) : "no_ad";
}

/** The period's payments that pass the filter, newest first; `except` ignores one part of the filter. */
export function purchasesIn(report: Pick<CdStatsReport, "purchases" | "timezone">, r: { from: string; to: string }, f: DashFilter, except?: keyof DashFilter): CdStatsPurchase[] {
  return (report.purchases ?? [])
    .filter((p) => {
      if (!inRange(dayIn(p.at, report.timezone), r)) return false;
      if (except !== "series" && f.series && p.drama_id !== f.series) return false;
      if (except !== "device" && f.device && (p.source?.device ?? "unknown") !== f.device) return false;
      if (except !== "country" && f.country && (p.source?.country ?? NO_PLACE) !== f.country) return false;
      if (except !== "source" && f.source) {
        const k = purchaseSourceKey(p);
        if (f.source === "ads" ? !k.startsWith("campaign:") : k !== f.source) return false;
      }
      return true;
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Came from an ad: a TikTok landing (tagged or only TikTok's click id), an ad's campaign or ad, or TikTok's stored copy of the page. */
export function fromAd(source: CdStatsTouch | null | undefined): boolean {
  return !!source && (source.platform === "tiktok" || !!source.campaign || !!source.ad || source.stored_copy);
}

/** A TikTok landing with no campaign tag (TikTok's click id only): an ad buyer no campaign can claim. */
export function untagged(source: CdStatsTouch | null | undefined): boolean {
  return !!source && source.platform === "tiktok" && !source.campaign && !source.ad && !source.stored_copy;
}

export type BuyerCounts = { people: number; purchases: number; first_purchases: number; renewals: number; revenue_cents: number };

/** Payments against the different people who made them (one person on two browsers is one person). */
export function buyerCounts(list: readonly CdStatsPurchase[]): BuyerCounts {
  const people = new Set(list.map((p) => p.person));
  const renewals = list.filter((p) => p.renewal).length;
  return { people: people.size, purchases: list.length, first_purchases: list.length - renewals, renewals, revenue_cents: list.reduce((a, p) => a + p.amount_cents, 0) };
}

/** The different people among some payments that came from ads (the cost-per-buyer's divisor). */
export function adBuyers(list: readonly CdStatsPurchase[]): number {
  return new Set(list.filter((p) => fromAd(p.source)).map((p) => p.person)).size;
}

/** The different people who arrived from TikTok with no campaign tag. */
export function untaggedBuyers(list: readonly CdStatsPurchase[]): number {
  return new Set(list.filter((p) => untagged(p.source)).map((p) => p.person)).size;
}

export type BoughtBy = {
  /** By TikTok's campaign id. */
  campaigns: Map<string, BuyerCounts>;
  /** By TikTok's ad id. */
  ads: Map<string, BuyerCounts>;
  /** TikTok's stored copy (which ad unknown) and no ad at all (direct, organic, TikTok with no campaign tag). */
  other: Map<"stored_copy" | "no_ad", BuyerCounts>;
};

/** The different people and payments each campaign and each ad brought (by the payment's own landing tags), and the rest. */
export function buyersByAd(list: readonly CdStatsPurchase[]): BoughtBy {
  const byCampaign = new Map<string, CdStatsPurchase[]>();
  const byAd = new Map<string, CdStatsPurchase[]>();
  const other = new Map<"stored_copy" | "no_ad", CdStatsPurchase[]>();
  const add = <K,>(m: Map<K, CdStatsPurchase[]>, k: K, p: CdStatsPurchase) => m.set(k, [...(m.get(k) ?? []), p]);
  for (const p of list) {
    const key = purchaseSourceKey(p);
    if (key === "stored_copy" || key === "no_ad") {
      add(other, key, p);
      continue;
    }
    if (p.source?.campaign) add(byCampaign, p.source.campaign, p);
    if (p.source?.ad) add(byAd, p.source.ad, p);
  }
  const counted = <K,>(m: Map<K, CdStatsPurchase[]>) => new Map([...m].map(([k, v]) => [k, buyerCounts(v)]));
  return { campaigns: counted(byCampaign), ads: counted(byAd), other: counted(other) };
}

// ---- one person ---------------------------------------------------------------------------------------------

export type Person = {
  person: string;
  /** Every payment of theirs in the report (not only the period's), newest first. */
  purchases: CdStatsPurchase[];
  browsers: number;
  total_cents: number;
  /** The first landing we know of: their first journey landing, else their first payment's source. */
  first_touch: { at: string | null; platform: string; campaign: string | null; ad: string | null; stored_copy: boolean } | null;
  device: string | null;
  country: string | null;
  region: string | null;
  first_seen_at: string | null;
  /** Seconds from their first visit to their first payment. */
  to_pay_s: number | null;
  steps: CdStatsJourneyStep[];
};

export function personOf(report: Pick<CdStatsReport, "purchases" | "journeys">, person: string): Person | null {
  const purchases = (report.purchases ?? []).filter((p) => p.person === person).sort((a, b) => b.at.localeCompare(a.at));
  const steps = [...(report.journeys?.[person] ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  if (!purchases.length && !steps.length) return null;
  const first = purchases[purchases.length - 1] ?? null;
  const landing = steps.find((s) => s.kind === "landing");
  const firstTouch = landing
    ? { at: landing.at, platform: landing.platform ?? "unknown", campaign: landing.campaign ?? null, ad: landing.ad ?? null, stored_copy: false }
    : first?.source
      ? { at: first.first_seen_at, platform: first.source.platform, campaign: first.source.campaign, ad: first.source.ad, stored_copy: first.source.stored_copy }
      : null;
  const seen = [first?.first_seen_at, landing?.at, steps[0]?.at].filter((x): x is string => !!x).sort()[0] ?? null;
  const toPay = first ? (first.paid_after_s ?? (seen ? Math.max(0, Math.round((ms(first.at) - ms(seen)) / 1000)) : null)) : null;
  return {
    person,
    purchases,
    browsers: new Set(purchases.map((p) => p.browser).filter(Boolean)).size,
    total_cents: purchases.reduce((a, p) => a + p.amount_cents, 0),
    first_touch: firstTouch,
    device: first?.source?.device ?? null,
    country: first?.source?.country ?? null,
    region: first?.source?.region ?? null,
    first_seen_at: seen,
    to_pay_s: toPay,
    steps,
  };
}

/** The browsers a person paid from, when that is more than one ("same person on 2 browsers"). */
export function browsersOf(list: readonly CdStatsPurchase[]): Map<string, number> {
  const out = new Map<string, Set<string>>();
  for (const p of list) if (p.browser) out.set(p.person, (out.get(p.person) ?? new Set()).add(p.browser));
  return new Map([...out].map(([k, v]) => [k, v.size]));
}

// ---- a person's timeline ------------------------------------------------------------------------------------

export type TimelineRow =
  | { kind: Exclude<JourneyKind, "ep_start" | "ep_finish">; at: string; drama_id: string | null; episode: number | null; platform: string | null; campaign: string | null; ad: string | null; amount_cents: number | null; gap_s: number | null }
  /** Episodes started one after another in one series: the first and last started, and how many of them were finished. */
  | { kind: "episodes"; at: string; until: string; drama_id: string | null; from: number; to: number; started: number; finished: number; gap_s: number | null };

/**
 * A person's steps as rows, oldest first: each landing, paywall, checkout, payment and leaving on its own; a run
 * of episodes in one series folded into one row ("episodes 2-5, 3 finished"), so 30 steps read as a few lines.
 * `gap_s`: seconds since the row before.
 */
export function timelineRows(steps: readonly CdStatsJourneyStep[]): TimelineRow[] {
  const sorted = [...steps].sort((a, b) => a.at.localeCompare(b.at));
  const rows: TimelineRow[] = [];
  let last: string | null = null;
  const gap = (at: string) => (last ? Math.max(0, Math.round((ms(at) - ms(last)) / 1000)) : null);
  for (const s of sorted) {
    if (s.kind === "ep_start" || s.kind === "ep_finish") {
      const prev = rows[rows.length - 1];
      const ep = s.episode ?? 0;
      if (prev?.kind === "episodes" && prev.drama_id === s.drama_id) {
        prev.until = s.at;
        if (s.kind === "ep_start") {
          prev.started += 1;
          prev.from = Math.min(prev.from, ep);
          prev.to = Math.max(prev.to, ep);
        } else prev.finished += 1;
      } else {
        rows.push({ kind: "episodes", at: s.at, until: s.at, drama_id: s.drama_id, from: ep, to: ep, started: s.kind === "ep_start" ? 1 : 0, finished: s.kind === "ep_finish" ? 1 : 0, gap_s: gap(s.at) });
      }
    } else {
      rows.push({ kind: s.kind, at: s.at, drama_id: s.drama_id, episode: s.episode ?? null, platform: s.platform ?? null, campaign: s.campaign ?? null, ad: s.ad ?? null, amount_cents: s.amount_cents ?? null, gap_s: gap(s.at) });
    }
    last = s.at;
  }
  return rows;
}

/** "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
