// Every Studio-launched TikTok ad's delivery and video numbers (decision 2026-09-28, "Ad video stats"), for the
// Ads tab of /crazydramas/stats and the Clips page. Ruobin, 2026-09-28, of a table of lifetime numbers per ad
// creative: "lets build those tiktok stats into pulsar studio, this seems super useful".
//
// TikTok's AUCTION_AD report, dimensions ["ad_id"] (lifetime: `query_lifetime=true`) or ["ad_id",
// "stat_time_day"] (a span of days, at most 30 per request), metrics AD_METRICS + VIDEO_METRICS, filtered by
// our own ad ids in batches of 50, per ad account with that account's own token, paged. The numbers are summed
// by lib/tiktok/ad-stats.ts (counts; the average play weighted by plays) and grouped per creative by the pure
// lib/crazydramas/stats-creatives.ts. An ad account that fails fails soft: its ads are left out of `covered`
// (unknown, never zero) and `failed` says why. Kept ten minutes. Server-only; read-only.

import type { LaunchRun } from "@/lib/launch/types";
import { AD_METRICS, adVideoNumbers, groupByAd, VIDEO_METRICS, type AdVideoNumbers } from "./ad-stats";
import { accessTokenFor, tiktokTransport } from "./index";
import type { TikTokTransport } from "./transport";

export const AD_VIDEO_CACHE_MS = 10 * 60_000;
/** TikTok refuses a day breakdown over more than 30 days in one request. */
const DAYS_PER_REQUEST = 30;
const ADS_PER_REQUEST = 50;
const PAGE_SIZE = 1000;

export type { AdVideoNumbers } from "./ad-stats";

export type AdVideoFailure = { advertiser_id: string; error: string };

export type AdVideoRead = {
  /** The ad ids a successful report covered: one it covered but did not list delivered nothing (observed zero). */
  covered: string[];
  failed: AdVideoFailure[];
  /** Lifetime: each ad's life; days: each ad's days, oldest first ("2026-09-28"). */
  ads: Record<string, AdVideoNumbers>;
  days?: Record<string, (AdVideoNumbers & { day: string })[]>;
  from?: string;
  to?: string;
};

type Row = Record<string, unknown>;
type Cached = { at: number; read: AdVideoRead };
const holder = globalThis as typeof globalThis & { __studioTtAdVideoCache?: Map<string, Cached> };
const cache = (holder.__studioTtAdVideoCache ??= new Map<string, Cached>());

export function clearAdVideoCache(): void {
  cache.clear();
}

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/** Advertiser -> every TikTok ad id Studio made there (the ad groups' record and the Monitor's), in the transport's own environment. */
export function tiktokAdsByAdvertiser(runs: readonly LaunchRun[], mode: TikTokTransport["mode"]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const run of runs) {
    if (run.draft?.provider !== "tiktok" || (run.mode === "fake") !== (mode === "fake")) continue;
    for (const c of run.campaigns ?? []) {
      if (!c.advertiser_id) continue;
      const state = (c.state ?? {}) as { groups?: { ads?: Record<string, unknown> }[] };
      const ids = [...(state.groups ?? []).flatMap((g) => Object.values(g.ads ?? {}).map(str)), ...(c.snapshot?.ads ?? []).map((a) => str(a.id))].filter(Boolean);
      const list = out.get(c.advertiser_id) ?? [];
      for (const id of ids) if (!list.includes(id)) list.push(id);
      out.set(c.advertiser_id, list);
    }
  }
  return out;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** [from, to] cut into spans of at most 30 days, oldest first. */
export function daySpans(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let a = from; a <= to; a = addDays(a, DAYS_PER_REQUEST)) {
    const b = addDays(a, DAYS_PER_REQUEST - 1);
    out.push({ from: a, to: b < to ? b : to });
  }
  return out;
}

async function pages(tt: TikTokTransport, token: string, params: Record<string, string | number>): Promise<Row[]> {
  const rows: Row[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > 100) throw new Error("TikTok's ad report ran past 100 pages.");
    const res = await tt.get("/report/integrated/get/", token, { ...params, page, page_size: PAGE_SIZE });
    if (res.code !== 0) throw new Error(res.message || "TikTok did not return the ad report.");
    const list = res.data?.list;
    if (!Array.isArray(list)) throw new Error("TikTok's ad report came back without its rows.");
    rows.push(...(list as Row[]));
    const count = (res.data?.page_info as { total_page?: number } | undefined)?.total_page;
    if (count === undefined && list.length >= PAGE_SIZE) throw new Error("TikTok's ad report came back without its page count.");
    total = count === undefined ? 1 : Math.max(1, Number(count));
  }
  return rows;
}

/**
 * The numbers of every Studio-launched TikTok ad: over each ad's life (`span: "lifetime"`), or per day over
 * `{ from, to }` (TikTok's days, the ad account's time zone). Never throws: an ad account whose read fails is
 * named in `failed` and its ads are not `covered`.
 */
export async function readTikTokAdVideo(
  runs: readonly LaunchRun[],
  span: "lifetime" | { from: string; to: string },
  opts: { fresh?: boolean; transport?: TikTokTransport; tokenFor?: (advertiserId: string) => string | null; now?: () => number } = {},
): Promise<AdVideoRead> {
  const tt = opts.transport ?? tiktokTransport();
  const tokenFor = opts.tokenFor ?? accessTokenFor;
  const now = opts.now ?? Date.now;
  const accounts = tiktokAdsByAdvertiser(runs, tt.mode);
  const spanKey = span === "lifetime" ? "life" : `${span.from}..${span.to}`;
  const key = `${tt.mode}|${spanKey}|${[...accounts].map(([a, ids]) => `${a}:${[...ids].sort().join(",")}`).sort().join(";")}`;
  const kept = cache.get(key);
  if (!opts.fresh && kept && now() - kept.at < AD_VIDEO_CACHE_MS) return kept.read;

  const metrics = JSON.stringify([...AD_METRICS, ...VIDEO_METRICS]);
  const covered: string[] = [];
  const failed: AdVideoFailure[] = [];
  const rows: Row[] = [];
  for (const [advertiser, ids] of accounts) {
    try {
      const token = tokenFor(advertiser);
      if (!token) throw new Error(`No TikTok connection covers ad account ${advertiser}.`);
      const got: Row[] = [];
      for (let i = 0; i < ids.length; i += ADS_PER_REQUEST) {
        const filtering = JSON.stringify([{ field_name: "ad_ids", filter_type: "IN", filter_value: JSON.stringify(ids.slice(i, i + ADS_PER_REQUEST)) }]);
        const base = { advertiser_id: advertiser, report_type: "BASIC", data_level: "AUCTION_AD", metrics, filtering };
        if (span === "lifetime") got.push(...(await pages(tt, token, { ...base, dimensions: JSON.stringify(["ad_id"]), query_lifetime: "true" })));
        else for (const part of daySpans(span.from, span.to)) got.push(...(await pages(tt, token, { ...base, dimensions: JSON.stringify(["ad_id", "stat_time_day"]), start_date: part.from, end_date: part.to })));
      }
      rows.push(...got);
      covered.push(...ids);
    } catch (e) {
      failed.push({ advertiser_id: advertiser, error: (e as Error).message });
    }
  }

  const byAd = groupByAd(rows);
  const ads: Record<string, AdVideoNumbers> = {};
  for (const id of covered) ads[id] = adVideoNumbers(byAd.get(id) ?? []);
  const read: AdVideoRead = { covered, failed, ads };
  if (span !== "lifetime") {
    const days: NonNullable<AdVideoRead["days"]> = {};
    for (const id of covered) {
      const byDay = new Map<string, Row[]>();
      for (const row of byAd.get(id) ?? []) {
        const day = str((row.dimensions as Row | undefined)?.stat_time_day).slice(0, 10);
        if (day) byDay.set(day, [...(byDay.get(day) ?? []), row]);
      }
      days[id] = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, dayRows]) => ({ day, ...adVideoNumbers(dayRows) }));
    }
    read.days = days;
    read.from = span.from;
    read.to = span.to;
  }
  // A read with an account that failed is not kept: the next look asks again.
  if (!failed.length) cache.set(key, { at: now(), read });
  return read;
}
