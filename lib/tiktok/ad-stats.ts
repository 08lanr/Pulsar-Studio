// One TikTok ad's own results, for the monitor's ad rows and the stats by
// title (Ruobin, 2026-09-24: "Studio reads TikTok results per AD, not just
// per campaign"). Pure and client-safe: the driver reads TikTok's AUCTION_AD
// report (`dimensions: ["ad_id"]`, "Basic report supported metrics",
// https://business-api.tiktok.com/portal/docs?id=1751443967255553), this
// turns its rows into numbers.
//
// Rows are summed per ad and the ratios recomputed from the sums (a report
// broken down by day, as the fake answers, sums to the same lifetime numbers;
// averaging ratios would be wrong). A metric any of an ad's rows lacks is
// unknown for that ad: null, never zero. An ad a successful report does not
// list delivered nothing yet: observed zero, as at campaign level. The website conversions are
// TikTok's own attribution, exactly as at campaign level (lib/tiktok/web-metrics.ts).

import type { AdStats } from "@/lib/launch/types";
import { webConversionsFromReport } from "./web-metrics";

/** The delivery metrics read per ad; CTR and CPC are recomputed from them. */
export const AD_METRICS = ["spend", "impressions", "clicks", "conversion"] as const;

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const adIdOf = (row: Row) => {
  const id = (row.dimensions as Row | undefined)?.ad_id;
  return id === undefined || id === null ? "" : String(id);
};

function group(rows: readonly Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const row of rows) {
    const id = adIdOf(row);
    if (!id) continue;
    out.set(id, [...(out.get(id) ?? []), row]);
  }
  return out;
}

/** One ad's delivery numbers from its report rows (one lifetime row, or one per day). */
export function adStatsFromRows(rows: readonly Row[]): AdStats {
  const metrics = rows.map((r) => (r.metrics ?? {}) as Row);
  const sum = (key: string): number | null => (metrics.every((m) => num(m[key]) !== null) ? metrics.reduce((n, m) => n + Number(m[key]), 0) : null);
  const spend = sum("spend");
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const spendCents = spend === null ? null : Math.round(spend * 100);
  return {
    spend_cents: spendCents, impressions, clicks,
    ctr: impressions && clicks !== null ? clicks / impressions : null,
    cpc_cents: spendCents !== null && clicks ? Math.round(spendCents / clicks) : null,
    conversions: sum("conversion"),
  };
}

/**
 * Ad id → its numbers, for every id in `adIds` (ours) and none other.
 * `webRows` (Website purchases launches) adds TikTok's attributed website
 * conversions per ad; null means they were not read, so no ad gets any.
 */
export function adStatsByAd(adIds: Iterable<string>, rows: readonly Row[], webRows: readonly Row[] | null = null): Map<string, AdStats> {
  const delivery = group(rows);
  const web = webRows ? group(webRows) : null;
  const out = new Map<string, AdStats>();
  for (const id of adIds) {
    const stats = adStatsFromRows(delivery.get(id) ?? []);
    out.set(id, web ? { ...stats, web: webConversionsFromReport(web.get(id) ?? []) } : stats);
  }
  return out;
}

/** One ad's numbers on one of TikTok's days (the ad account's time zone). Unknown stays null. */
export type AdDay = { day: string; spend_cents: number | null; impressions: number | null; clicks: number | null };

/** Ad id → its days, oldest first, from a report broken down by `stat_time_day` ("2026-09-24 00:00:00"). */
export function adDaysFromRows(rows: readonly Row[]): Record<string, AdDay[]> {
  const out: Record<string, AdDay[]> = {};
  for (const [id, adRows] of group(rows)) {
    const byDay = new Map<string, Row[]>();
    for (const row of adRows) {
      const day = String((row.dimensions as Row | undefined)?.stat_time_day ?? "").slice(0, 10);
      if (day) byDay.set(day, [...(byDay.get(day) ?? []), row]);
    }
    out[id] = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, dayRows]) => {
        const s = adStatsFromRows(dayRows);
        return { day, spend_cents: s.spend_cents, impressions: s.impressions, clicks: s.clicks };
      });
  }
  return out;
}
