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

/**
 * How far people watched an ad's video (decision 2026-09-28, "Ad video stats"): plays, still watching at 2 s
 * and 6 s, watched to 25/50/75/100%, and TikTok's average play time in seconds. The shares are recomputed
 * from these counts (a share of plays); the average play is weighted by plays (`play_seconds`).
 */
export const VIDEO_METRICS = [
  "video_play_actions", "video_watched_2s", "video_watched_6s",
  "video_views_p25", "video_views_p50", "video_views_p75", "video_views_p100", "average_video_play",
] as const;

/** An ad's video counts, summed; `play_seconds` is TikTok's average play time × plays, so it adds up across rows. */
export type AdVideoCounts = {
  plays: number | null; watched_2s: number | null; watched_6s: number | null;
  views_p25: number | null; views_p50: number | null; views_p75: number | null; views_p100: number | null;
  play_seconds: number | null;
};

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const adIdOf = (row: Row) => {
  const id = (row.dimensions as Row | undefined)?.ad_id;
  return id === undefined || id === null ? "" : String(id);
};

export function groupByAd(rows: readonly Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const row of rows) {
    const id = adIdOf(row);
    if (!id) continue;
    out.set(id, [...(out.get(id) ?? []), row]);
  }
  return out;
}

const sumOf = (metrics: readonly Row[], key: string): number | null =>
  metrics.every((m) => num(m[key]) !== null) ? metrics.reduce((n, m) => n + Number(m[key]), 0) : null;

/** An ad's video counts from its report rows (none listed = observed zero; a count any row lacks is unknown). */
export function adVideoFromRows(rows: readonly Row[]): AdVideoCounts {
  const metrics = rows.map((r) => (r.metrics ?? {}) as Row);
  const sum = (key: string) => sumOf(metrics, key);
  const seconds = metrics.every((m) => num(m.average_video_play) !== null && num(m.video_play_actions) !== null)
    ? metrics.reduce((n, m) => n + Number(m.average_video_play) * Number(m.video_play_actions), 0)
    : null;
  return {
    plays: sum("video_play_actions"), watched_2s: sum("video_watched_2s"), watched_6s: sum("video_watched_6s"),
    views_p25: sum("video_views_p25"), views_p50: sum("video_views_p50"), views_p75: sum("video_views_p75"), views_p100: sum("video_views_p100"),
    play_seconds: seconds,
  };
}

/**
 * One ad's delivery numbers from its report rows (one lifetime row, or one per day). `withVideo`: the report
 * was asked for VIDEO_METRICS too, and the ad carries its video counts.
 */
export function adStatsFromRows(rows: readonly Row[], withVideo = false): AdStats {
  const metrics = rows.map((r) => (r.metrics ?? {}) as Row);
  const sum = (key: string) => sumOf(metrics, key);
  const spend = sum("spend");
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const spendCents = spend === null ? null : Math.round(spend * 100);
  return {
    spend_cents: spendCents, impressions, clicks,
    ctr: impressions && clicks !== null ? clicks / impressions : null,
    cpc_cents: spendCents !== null && clicks ? Math.round(spendCents / clicks) : null,
    conversions: sum("conversion"),
    ...(withVideo ? { video: adVideoFromRows(rows) } : {}),
  };
}

/**
 * Ad id → its numbers, for every id in `adIds` (ours) and none other.
 * `webRows` (Website purchases launches) adds TikTok's attributed website
 * conversions per ad; null means they were not read, so no ad gets any.
 */
export function adStatsByAd(adIds: Iterable<string>, rows: readonly Row[], webRows: readonly Row[] | null = null, withVideo = false): Map<string, AdStats> {
  const delivery = groupByAd(rows);
  const web = webRows ? groupByAd(webRows) : null;
  const out = new Map<string, AdStats>();
  for (const id of adIds) {
    const stats = adStatsFromRows(delivery.get(id) ?? [], withVideo);
    out.set(id, web ? { ...stats, web: webConversionsFromReport(web.get(id) ?? []) } : stats);
  }
  return out;
}

/** One ad's numbers on one of TikTok's days (the ad account's time zone). Unknown stays null. */
export type AdDay = { day: string; spend_cents: number | null; impressions: number | null; clicks: number | null };

/** Ad id → its days, oldest first, from a report broken down by `stat_time_day` ("2026-09-24 00:00:00"). */
export function adDaysFromRows(rows: readonly Row[]): Record<string, AdDay[]> {
  const out: Record<string, AdDay[]> = {};
  for (const [id, adRows] of groupByAd(rows)) {
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

/** One ad's numbers over a span: TikTok's delivery counts and its video counts, summed. Unknown stays null. */
export type AdVideoNumbers = AdVideoCounts & {
  spend_cents: number | null;
  impressions: number | null;
  clicks: number | null;
  /** TikTok's `conversion`: the campaign's optimization event (checkouts started on most of ours). */
  conversions: number | null;
};

/** One ad's report rows as delivery and video numbers (no rows = observed zero). */
export function adVideoNumbers(rows: readonly Row[]): AdVideoNumbers {
  const s = adStatsFromRows(rows, true);
  return { spend_cents: s.spend_cents, impressions: s.impressions, clicks: s.clicks, conversions: s.conversions, ...adVideoFromRows(rows) };
}
