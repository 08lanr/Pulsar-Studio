// Each Studio-launched TikTok ad's numbers per day, for the CrazyDramas stats
// pages' Today / 7 days / 30 days (Ruobin, 2026-09-25: "the by ad part does
// not filter by today, last 7 days, the same way that by series does"). The
// launch records keep each ad's lifetime numbers only, and only as fresh as
// the Monitor's last look, so a period's spend is read here: TikTok's
// AUCTION_AD report broken down by `stat_time_day` over the 30 days ending on
// the stats' last day, one report per ad account, kept five minutes.
// TikTok's days are the ad account's time zone (Pulsar Entertainment's is
// UTC−8, an hour off Pacific summer time). A report that fails fails soft:
// the stats pages then cost only ads whose whole life is in the period.
// Server-only.

import type { LaunchRun } from "@/lib/launch/types";
import { adDaysFromRows, type AdDay } from "./ad-stats";
import { accessTokenFor, tiktokTransport } from "./index";
import type { TikTokTransport } from "./transport";

/** TikTok refuses a report broken down by day over more than 30 days. */
export const AD_DAYS_SPAN = 30;
export const AD_DAYS_CACHE_MS = 5 * 60_000;

export type AdDaysRead =
  /** `campaigns`: the TikTok campaign ids the read covered; an ad of one of them with no days spent nothing. */
  | { ok: true; from: string; to: string; campaigns: string[]; days: Record<string, AdDay[]> }
  | { ok: false; error: string };

type Cached = { at: number; read: AdDaysRead & { ok: true } };
const holder = globalThis as typeof globalThis & { __studioTtAdDaysCache?: Map<string, Cached> };
const cache = (holder.__studioTtAdDaysCache ??= new Map<string, Cached>());

export function clearAdDaysCache(): void {
  cache.clear();
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Advertiser → the TikTok campaign ids Studio launched there, from runs in the transport's own environment. */
export function tiktokCampaignsByAdvertiser(runs: LaunchRun[], mode: TikTokTransport["mode"]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const run of runs) {
    if (run.draft?.provider !== "tiktok" || (run.mode === "fake") !== (mode === "fake")) continue;
    for (const c of run.campaigns ?? []) {
      const id = typeof c.state?.campaign_id === "string" ? c.state.campaign_id : null;
      if (!id || !c.advertiser_id) continue;
      const list = out.get(c.advertiser_id) ?? [];
      if (!list.includes(id)) list.push(id);
      out.set(c.advertiser_id, list);
    }
  }
  return out;
}

/** The days of every Studio-launched TikTok ad over the 30 days ending `to` (the stats' last day). */
export async function readTikTokAdDays(
  runs: LaunchRun[],
  opts: { to: string; fresh?: boolean; transport?: TikTokTransport; tokenFor?: (advertiserId: string) => string | null; now?: () => number },
): Promise<AdDaysRead> {
  const tt = opts.transport ?? tiktokTransport();
  const tokenFor = opts.tokenFor ?? accessTokenFor;
  const now = opts.now ?? Date.now;
  const from = addDays(opts.to, -(AD_DAYS_SPAN - 1));
  const accounts = tiktokCampaignsByAdvertiser(runs, tt.mode);
  const campaigns = [...accounts.values()].flat().sort();
  const key = `${tt.mode}|${opts.to}|${campaigns.join(",")}`;
  const kept = cache.get(key);
  if (!opts.fresh && kept && now() - kept.at < AD_DAYS_CACHE_MS) return kept.read;
  try {
    const rows: Record<string, unknown>[] = [];
    for (const [advertiser, ids] of accounts) {
      const token = tokenFor(advertiser);
      if (!token) throw new Error(`No TikTok connection covers ad account ${advertiser}.`);
      for (let i = 0; i < ids.length; i += 100) {
        const filtering = JSON.stringify([{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify(ids.slice(i, i + 100)) }]);
        // Paged as the launch driver pages: a page missing is never a day with no spend.
        let total = 1;
        for (let page = 1; page <= total; page++) {
          if (page > 100) throw new Error("TikTok's daily ad report ran past 100 pages.");
          const res = await tt.get("/report/integrated/get/", token, {
            advertiser_id: advertiser, report_type: "BASIC", data_level: "AUCTION_AD",
            dimensions: JSON.stringify(["ad_id", "stat_time_day"]), metrics: JSON.stringify(["spend", "impressions", "clicks"]),
            start_date: from, end_date: opts.to, filtering, page, page_size: 100,
          });
          if (res.code !== 0) throw new Error(res.message || "TikTok did not return the daily ad report.");
          const list = res.data?.list;
          if (!Array.isArray(list)) throw new Error("TikTok's daily ad report came back without its rows.");
          rows.push(...(list as Record<string, unknown>[]));
          const pages = (res.data?.page_info as { total_page?: number } | undefined)?.total_page;
          if (pages === undefined && list.length >= 100) throw new Error("TikTok's daily ad report came back without its page count.");
          total = pages === undefined ? 1 : Math.max(1, Number(pages));
        }
      }
    }
    const read = { ok: true as const, from, to: opts.to, campaigns, days: adDaysFromRows(rows) };
    cache.set(key, { at: now(), read });
    return read;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
