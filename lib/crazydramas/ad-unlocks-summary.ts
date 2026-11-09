// The Ad unlocks tab's sums (decision 2026-11-09, "Ad unlocks in Studio"): crazydramas' own ad-unlock counts
// (./ad-unlocks-types.ts) next to Google AdMob's network report (lib/admob/report.ts). Pure and client-safe.
//
// Two rules the tab keeps:
//   - viewers are distinct per day only (crazydramas counts them per day and platform), so over several days they
//     are viewer-days, never people: "episodes per ad viewer" and "share hitting the cap" divide by viewer-days,
//     which is "on a day they used ads"; the people over the whole window are the `after` panel's own count;
//   - AdMob serves the apps only (the web's ads are Google Ad Manager or house ads), so AdMob is compared with our
//     rows whose provider is `admob`, day by day and platform by platform; AdMob's impressions are set against
//     our granted + unfinished (every ad that started and was not refused), eCPM is earnings over impressions.

import type { AdmobRow } from "@/lib/admob/report";
import { rangeDays, prevSpan, chartSpan, type StatsRange } from "./stats-summary";
import { AD_PLATFORMS, REFUSE_REASONS, type AdPlatform, type AdUnlockDay, type AdUnlockFailure, type AdUnlocksReport, type RefuseReason } from "./ad-unlocks-types";

export type Span = { from: string; to: string };

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every day of a span, oldest first. */
export function spanDays(span: Span): string[] {
  const out: string[] = [];
  for (let d = span.from; d <= span.to; d = addDays(d, 1)) out.push(d);
  return out;
}

const inSpan = (day: string, s: Span) => day >= s.from && day <= s.to;

/** The days AdMob is asked for: the last 90 Pacific days ending today, crazydramas' window. */
export function admobWindow(today: string): Span {
  return { from: addDays(today, -89), to: today };
}

/**
 * The days the tab's periods are cut from: ending on crazydramas' last day (or today, when crazydramas has no
 * report), starting on the first day either source has anything (an ad opened, or an AdMob request), so "All"
 * never starts on empty weeks and a period before the first ad has nothing to compare with.
 */
export function adUnlockFrame(report: Pick<AdUnlocksReport, "window" | "days"> | null, admob: readonly AdmobRow[] | null, today: string): Span {
  const to = report?.window.to ?? today;
  let first: string | null = null;
  for (const d of report?.days ?? []) if ((d.opened || d.granted) && (first === null || d.day < first)) first = d.day;
  for (const r of admob ?? []) if ((r.ad_requests || r.impressions) && (first === null || r.day < first)) first = r.day;
  return { from: first && first <= to ? first : to, to };
}

/** The period's days, the period before (null for All, or when it would start before the frame) and the chart's days. */
export function adUnlockSpans(frame: Span, range: StatsRange): { span: Span; prev: Span | null; chart: Span } {
  return { span: rangeDays(frame, range), prev: prevSpan(frame, range), chart: chartSpan(frame, range) };
}

// ---- ours ------------------------------------------------------------------------------------------------------

export function adDaysIn(report: Pick<AdUnlocksReport, "days">, span: Span): AdUnlockDay[] {
  return report.days.filter((d) => inSpan(d.day, span));
}

export type AdUnlockTotals = {
  opened: number;
  granted: number;
  unfinished: number;
  refused: Record<RefuseReason, number>;
  refused_total: number;
  /** Per-day distinct viewers added over days and platforms: viewer-days, not people. */
  viewer_days: number;
  granted_viewer_days: number;
  capped_viewer_days: number;
  ssv: number;
  client: number;
  by_platform: Record<AdPlatform, { opened: number; granted: number; unfinished: number }>;
};

export function adUnlockTotals(rows: readonly AdUnlockDay[]): AdUnlockTotals {
  const refused = Object.fromEntries(REFUSE_REASONS.map((k) => [k, 0])) as Record<RefuseReason, number>;
  const by_platform = Object.fromEntries(AD_PLATFORMS.map((p) => [p, { opened: 0, granted: 0, unfinished: 0 }])) as AdUnlockTotals["by_platform"];
  const t: AdUnlockTotals = { opened: 0, granted: 0, unfinished: 0, refused, refused_total: 0, viewer_days: 0, granted_viewer_days: 0, capped_viewer_days: 0, ssv: 0, client: 0, by_platform };
  for (const d of rows) {
    t.opened += d.opened;
    t.granted += d.granted;
    t.unfinished += d.unfinished;
    for (const k of REFUSE_REASONS) {
      t.refused[k] += d.refused[k];
      t.refused_total += d.refused[k];
    }
    t.viewer_days += d.viewers;
    t.granted_viewer_days += d.granted_viewers;
    t.capped_viewer_days += d.capped_viewers;
    t.ssv += d.ssv;
    t.client += d.client;
    const p = t.by_platform[d.platform];
    p.opened += d.opened;
    p.granted += d.granted;
    p.unfinished += d.unfinished;
  }
  return t;
}

/** Episodes unlocked per ad viewer on a day they used ads; null with nobody. */
export function episodesPerViewer(t: Pick<AdUnlockTotals, "granted" | "granted_viewer_days">): number | null {
  return t.granted_viewer_days > 0 ? t.granted / t.granted_viewer_days : null;
}

/** Of the viewers who unlocked with an ad on a day, the share who reached the daily cap; null with nobody. */
export function capShare(t: Pick<AdUnlockTotals, "capped_viewer_days" | "granted_viewer_days">): number | null {
  return t.granted_viewer_days > 0 ? t.capped_viewer_days / t.granted_viewer_days : null;
}

/** Ad viewers per day over a span: the day's own count for one day, else the average of the span's days. */
export function viewersPerDay(t: Pick<AdUnlockTotals, "granted_viewer_days">, span: Span): number {
  const n = spanDays(span).length;
  return n > 0 ? t.granted_viewer_days / n : 0;
}

/** Granted ads per day and platform: the chart's stacks (days with nothing are zeros). */
export function grantedByDay(report: Pick<AdUnlocksReport, "days">, span: Span): { day: string; values: Record<AdPlatform, number> }[] {
  return spanDays(span).map((day) => {
    const values = { ios: 0, android: 0, web: 0 } as Record<AdPlatform, number>;
    for (const d of report.days) if (d.day === day) values[d.platform] += d.granted;
    return { day, values };
  });
}

/** Failures in the span by reason (most first), with each platform's share; reasons as crazydramas spells them. */
export function failuresByReason(failures: readonly AdUnlockFailure[], span: Span): { reason: string; count: number; by_platform: Record<string, number> }[] {
  const out = new Map<string, { reason: string; count: number; by_platform: Record<string, number> }>();
  for (const f of failures) {
    if (!inSpan(f.day, span) || f.count <= 0) continue;
    const row = out.get(f.reason) ?? { reason: f.reason, count: 0, by_platform: {} };
    row.count += f.count;
    row.by_platform[f.platform] = (row.by_platform[f.platform] ?? 0) + f.count;
    out.set(f.reason, row);
  }
  return [...out.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** The "after" panel's numbers; the share is of ad viewers, null with none. */
export function afterAds(after: AdUnlocksReport["after"]): AdUnlocksReport["after"] & { share: number | null } {
  return { ...after, share: after.ad_viewers > 0 ? after.bought_after / after.ad_viewers : null };
}

// ---- AdMob -----------------------------------------------------------------------------------------------------

export function admobIn(rows: readonly AdmobRow[], span: Span): AdmobRow[] {
  return rows.filter((r) => inSpan(r.day, span));
}

export type AdmobTotals = {
  earnings_micros: number;
  impressions: number;
  ad_requests: number;
  matched_requests: number;
  clicks: number;
  /** Matched over requests (from the sums, not an average of Google's rates); null with no request. */
  match_rate: number | null;
  /** Earnings per 1,000 impressions, in micros; null with no impression. */
  ecpm_micros: number | null;
};

export function admobTotals(rows: readonly AdmobRow[]): AdmobTotals {
  const t = { earnings_micros: 0, impressions: 0, ad_requests: 0, matched_requests: 0, clicks: 0 };
  for (const r of rows) {
    t.earnings_micros += r.earnings_micros;
    t.impressions += r.impressions;
    t.ad_requests += r.ad_requests;
    t.matched_requests += r.matched_requests;
    t.clicks += r.clicks;
  }
  return { ...t, match_rate: t.ad_requests > 0 ? t.matched_requests / t.ad_requests : null, ecpm_micros: t.impressions > 0 ? (t.earnings_micros * 1000) / t.impressions : null };
}

/** Micros (millionths of a dollar) to cents, rounded. */
export const microsToCents = (micros: number): number => Math.round(micros / 10_000);

/** AdMob's earnings per day, in cents (days with nothing are zero). */
export function admobEarningsByDay(rows: readonly AdmobRow[], span: Span): { day: string; value: number }[] {
  return spanDays(span).map((day) => ({ day, value: microsToCents(rows.filter((r) => r.day === day).reduce((a, r) => a + r.earnings_micros, 0)) }));
}

export type CompareRow = {
  day: string;
  platform: "ios" | "android";
  /** AdMob's numbers for the day and platform (all its apps on that platform); null when AdMob has no row. */
  admob: Pick<AdmobTotals, "impressions" | "ad_requests" | "match_rate" | "earnings_micros" | "ecpm_micros"> | null;
  /** Our admob-provider rows for the day and platform; null when crazydramas has none. */
  ours: { opened: number; granted: number; unfinished: number; started: number } | null;
  /** AdMob's impressions minus our started (granted + unfinished); null without both. */
  gap: number | null;
};

/** AdMob next to ours, newest day first, iPhone then Android; a (day, platform) neither side has is left out. */
export function admobVsOurs(ours: readonly AdUnlockDay[] | null, admob: readonly AdmobRow[] | null, span: Span): CompareRow[] {
  const out: CompareRow[] = [];
  for (const day of spanDays(span).reverse()) {
    for (const platform of ["ios", "android"] as const) {
      const a = (admob ?? []).filter((r) => r.day === day && r.platform === platform);
      const o = (ours ?? []).filter((d) => d.day === day && d.platform === platform && d.provider === "admob");
      if (!a.length && !o.length) continue;
      const at = a.length ? admobTotals(a) : null;
      const granted = o.reduce((s, d) => s + d.granted, 0), unfinished = o.reduce((s, d) => s + d.unfinished, 0);
      const mine = o.length ? { opened: o.reduce((s, d) => s + d.opened, 0), granted, unfinished, started: granted + unfinished } : null;
      out.push({
        day,
        platform,
        admob: at ? { impressions: at.impressions, ad_requests: at.ad_requests, match_rate: at.match_rate, earnings_micros: at.earnings_micros, ecpm_micros: at.ecpm_micros } : null,
        ours: mine,
        gap: at && mine ? at.impressions - mine.started : null,
      });
    }
  }
  return out;
}

/** "$12.40" for an eCPM in micros per 1,000 impressions. */
export function fmtEcpm(micros: number | null): string {
  return micros === null ? "–" : `$${(micros / 1_000_000).toFixed(2)}`;
}
