// Read a launched campaign's numbers back from TikTok's reporting API into
// promote.results — Pulsar Grow's lib/metrics-sync.ts, at the ad level,
// with the video metrics Studio's benchmark needs (decision 2026-09-09).
//
// Rules, from the metric dictionary:
// - One row per creative per day, upserted on (creative, window, source):
//   a re-read updates a day, it never duplicates it.
// - hook_hold_rate = video_watched_2s / video_play_actions. TikTok reports
//   2 s and 6 s watch counts, never 3 s; Studio defines "hook hold" as the
//   2-second figure (docs/analytics/metric-dictionary.md).
// - landing_actions is null: no source here observes a landing action for
//   a TRAFFIC campaign (TikTok's `conversion` counts the optimisation event,
//   which is a click here). Null, never 0.
// - Source is `tiktok` for the live transports and `demo` for the fake, so a
//   fixture read-back is labelled like every other demo number.

import { systemSession } from "@/lib/auth";
import { getData, type LaunchedCampaign, type NewCreativeResult } from "@/lib/data";
import { accessTokenFor, launchMode, tiktokTransport } from "./index";

const SYNC_WINDOW_DAYS = 30;
const METRICS = ["spend", "impressions", "clicks", "conversion", "video_play_actions", "video_watched_2s", "video_watched_6s"];

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type ReportRow = { ad_id: string; date: string; spend: number; impressions: number; clicks: number; conversion: number; video_play_actions: number; video_watched_2s: number; video_watched_6s: number };

/**
 * Every ad id the launch owns → its creative: the original ads, and the ads
 * of every copy (auto-duplicates and cost-cap replacements). A copy carries
 * the same creatives in the same order as the original submission
 * (lib/tiktok/duplicate.ts adPayloads), so its ad ids map by position
 * (review finding 6: copies used to fall out of creative results).
 */
export function creativeByAdId(row: LaunchedCampaign): Map<string, string> {
  const { launch, creatives } = row;
  const map = new Map(Object.entries(launch.ad_ids).map(([creativeId, adId]) => [adId, creativeId]));
  const order = creatives.filter((c) => launch.ad_ids[c.id]).map((c) => c.id);
  for (const adIds of Object.values(launch.duplicates ?? {})) {
    adIds.forEach((adId, i) => {
      if (order[i] && !map.has(adId)) map.set(adId, order[i]);
    });
  }
  return map;
}

/** TikTok's report rows → Studio result rows, one per creative per day, every ad variant of the creative summed. */
export function resultsFromReport(row: LaunchedCampaign, rows: ReportRow[], observedAt: string): NewCreativeResult[] {
  const creativeByAd = creativeByAdId(row);
  const source: NewCreativeResult["source"] = launchMode() === "fake" ? "demo" : "tiktok";
  type Acc = { creativeId: string; date: string; spend: number; impressions: number; clicks: number; plays: number; watched2s: number };
  const byKey = new Map<string, Acc>();
  for (const r of rows) {
    const creativeId = creativeByAd.get(r.ad_id);
    if (!creativeId || !r.date) continue;
    const key = `${creativeId}|${r.date}`;
    const acc = byKey.get(key) ?? { creativeId, date: r.date, spend: 0, impressions: 0, clicks: 0, plays: 0, watched2s: 0 };
    acc.spend += Math.max(0, r.spend);
    acc.impressions += Math.max(0, Math.round(r.impressions));
    acc.clicks += Math.max(0, Math.round(r.clicks));
    acc.plays += Math.max(0, Math.round(r.video_play_actions));
    acc.watched2s += Math.max(0, Math.round(r.video_watched_2s));
    byKey.set(key, acc);
  }
  return [...byKey.values()].map((a) => ({
    campaign_id: row.campaign.id,
    creative_id: a.creativeId,
    source,
    window_start: a.date,
    window_end: a.date,
    impressions: a.impressions,
    video_views: a.plays,
    hook_hold_rate: a.plays > 0 ? Math.min(1, Math.max(0, a.watched2s / a.plays)) : 0,
    clicks: a.clicks,
    spend_usd: Math.round(a.spend * 100) / 100,
    landing_actions: null,
    observed_at: observedAt,
  }));
}

/** Pull the last 30 days for one launched campaign and upsert them. Returns rows written, or the error. */
export async function syncCampaignResults(row: LaunchedCampaign): Promise<{ written: number; error?: string }> {
  const { campaign, launch } = row;
  const token = accessTokenFor(launch.advertiser_id);
  if (!token || !campaign.grow_campaign_id || !Object.keys(launch.ad_ids).length) return { written: 0 };
  const tt = tiktokTransport();
  const end = new Date();
  const start = new Date(end.getTime() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const res = await tt.get("/report/integrated/get/", token, {
    advertiser_id: launch.advertiser_id,
    report_type: "BASIC",
    data_level: "AUCTION_AD",
    dimensions: JSON.stringify(["ad_id", "stat_time_day"]),
    metrics: JSON.stringify(METRICS),
    start_date: day(start),
    end_date: day(end),
    // The REPORTING api wants a list of filter objects (unlike /ad/get/).
    filtering: JSON.stringify([{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([campaign.grow_campaign_id]) }]),
    page_size: 200,
  });
  if (res.code !== 0) return { written: 0, error: res.message };
  const rows: ReportRow[] = [];
  for (const r of (res.data?.list ?? []) as Array<{ dimensions?: { ad_id?: string | number; stat_time_day?: string }; metrics?: Record<string, string | number> }>) {
    const m = r.metrics ?? {};
    const n = (k: string) => Number(m[k]) || 0;
    rows.push({
      ad_id: String(r.dimensions?.ad_id ?? ""),
      date: (r.dimensions?.stat_time_day ?? "").slice(0, 10),
      spend: n("spend"),
      impressions: n("impressions"),
      clicks: n("clicks"),
      conversion: n("conversion"),
      video_play_actions: n("video_play_actions"),
      video_watched_2s: n("video_watched_2s"),
      video_watched_6s: n("video_watched_6s"),
    });
  }
  const results = resultsFromReport(row, rows, new Date().toISOString());
  if (!results.length) return { written: 0 };
  const written = await getData().upsertCreativeResults(systemSession(), results);
  return { written };
}
