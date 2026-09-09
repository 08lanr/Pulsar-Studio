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

/** TikTok's report rows → Studio result rows for the creatives that own the ads. */
export function resultsFromReport(row: LaunchedCampaign, rows: ReportRow[], observedAt: string): NewCreativeResult[] {
  const creativeByAd = new Map(Object.entries(row.launch.ad_ids).map(([creativeId, adId]) => [adId, creativeId]));
  const source: NewCreativeResult["source"] = launchMode() === "fake" ? "demo" : "tiktok";
  const out: NewCreativeResult[] = [];
  for (const r of rows) {
    const creativeId = creativeByAd.get(r.ad_id);
    if (!creativeId || !r.date) continue;
    const plays = Math.max(0, Math.round(r.video_play_actions));
    out.push({
      campaign_id: row.campaign.id,
      creative_id: creativeId,
      source,
      window_start: r.date,
      window_end: r.date,
      impressions: Math.max(0, Math.round(r.impressions)),
      video_views: plays,
      hook_hold_rate: plays > 0 ? Math.min(1, Math.max(0, r.video_watched_2s / plays)) : 0,
      clicks: Math.max(0, Math.round(r.clicks)),
      spend_usd: Math.max(0, Math.round(r.spend * 100) / 100),
      landing_actions: null,
      observed_at: observedAt,
    });
  }
  return out;
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
