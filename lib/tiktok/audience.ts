// Who each Studio-launched TikTok campaign reached, by age (2026-10-01, Ruobin: "I just want to see that age range
// breakdown for each campaign, as well as an aggregate"), for the Campaigns tab of /crazydramas/stats.
//
// TikTok's AUDIENCE report at AUCTION_CAMPAIGN level, dimensions ["campaign_id", "age"], metrics spend,
// impressions, clicks and conversion, filtered by our own campaign ids in batches of 100, per ad account with
// that account's own token, over the period in spans of at most 30 days (summed here). Age is TikTok's own
// estimate of its users. An ad account that fails fails soft: its campaigns are left out of `covered` (unknown,
// never zero) and `failed` says why. Kept ten minutes. Server-only; read-only. The sums are the pure
// lib/crazydramas/stats-audience.ts.

import type { LaunchRun } from "@/lib/launch/types";
import { tiktokCampaignsByAdvertiser } from "./ad-days";
import { daySpans } from "./ad-video";
import { accessTokenFor, tiktokTransport } from "./index";
import type { TikTokTransport } from "./transport";

export const AUDIENCE_CACHE_MS = 10 * 60_000;
const CAMPAIGNS_PER_REQUEST = 100;
const PAGE_SIZE = 1000;
const METRICS = ["spend", "impressions", "clicks", "conversion"] as const;

/** One campaign's numbers in one age group over the period. */
export type AgeCell = { spend: number; impressions: number; clicks: number; conversion: number };
export type AudienceFailure = { advertiser_id: string; error: string };
export type AudienceRead = {
  /** The campaign ids a successful report covered: one it covered but did not list reached nobody. */
  covered: string[];
  failed: AudienceFailure[];
  /** Campaign id → TikTok's age group ("AGE_25_34") → its numbers. */
  campaigns: Record<string, Record<string, AgeCell>>;
};

type Row = Record<string, unknown>;
type Cached = { at: number; read: AudienceRead };
const holder = globalThis as typeof globalThis & { __studioTtAudienceCache?: Map<string, Cached> };
const cache = (holder.__studioTtAudienceCache ??= new Map<string, Cached>());

export function clearAudienceCache(): void {
  cache.clear();
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);

/** The report's rows added up by campaign and age group. */
export function ageCellsFromRows(rows: readonly Row[]): Record<string, Record<string, AgeCell>> {
  const out: Record<string, Record<string, AgeCell>> = {};
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as Row;
    const m = (row.metrics ?? {}) as Row;
    const cid = String(dims.campaign_id ?? "");
    const age = String(dims.age ?? "");
    if (!cid || !age) continue;
    const cell = ((out[cid] ??= {})[age] ??= { spend: 0, impressions: 0, clicks: 0, conversion: 0 });
    cell.spend = Math.round((cell.spend + num(m.spend)) * 100) / 100;
    cell.impressions += num(m.impressions);
    cell.clicks += num(m.clicks);
    cell.conversion += num(m.conversion);
  }
  return out;
}

async function pages(tt: TikTokTransport, token: string, params: Record<string, string | number>): Promise<Row[]> {
  const rows: Row[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > 100) throw new Error("TikTok's audience report ran past 100 pages.");
    const res = await tt.get("/report/integrated/get/", token, { ...params, page, page_size: PAGE_SIZE });
    if (res.code !== 0) throw new Error(res.message || "TikTok did not return the audience report.");
    const list = res.data?.list;
    if (!Array.isArray(list)) throw new Error("TikTok's audience report came back without its rows.");
    rows.push(...(list as Row[]));
    const count = (res.data?.page_info as { total_page?: number } | undefined)?.total_page;
    if (count === undefined && list.length >= PAGE_SIZE) throw new Error("TikTok's audience report came back without its page count.");
    total = count === undefined ? 1 : Math.max(1, Number(count));
  }
  return rows;
}

/**
 * Every Studio-launched TikTok campaign's numbers by age group over `{ from, to }` (TikTok's days, the ad account's
 * time zone). Never throws: an ad account whose read fails is named in `failed` and its campaigns are not `covered`.
 */
export async function readTikTokAudience(
  runs: LaunchRun[],
  span: { from: string; to: string },
  opts: { fresh?: boolean; transport?: TikTokTransport; tokenFor?: (advertiserId: string) => string | null; now?: () => number } = {},
): Promise<AudienceRead> {
  const tt = opts.transport ?? tiktokTransport();
  const tokenFor = opts.tokenFor ?? accessTokenFor;
  const now = opts.now ?? Date.now;
  const accounts = tiktokCampaignsByAdvertiser(runs, tt.mode);
  const key = `${tt.mode}|${span.from}..${span.to}|${[...accounts].map(([a, ids]) => `${a}:${[...ids].sort().join(",")}`).sort().join(";")}`;
  const kept = cache.get(key);
  if (!opts.fresh && kept && now() - kept.at < AUDIENCE_CACHE_MS) return kept.read;

  const covered: string[] = [];
  const failed: AudienceFailure[] = [];
  const rows: Row[] = [];
  for (const [advertiser, ids] of accounts) {
    try {
      const token = tokenFor(advertiser);
      if (!token) throw new Error(`No TikTok connection covers ad account ${advertiser}.`);
      const got: Row[] = [];
      for (let i = 0; i < ids.length; i += CAMPAIGNS_PER_REQUEST) {
        const filtering = JSON.stringify([{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify(ids.slice(i, i + CAMPAIGNS_PER_REQUEST)) }]);
        for (const part of daySpans(span.from, span.to)) {
          got.push(
            ...(await pages(tt, token, {
              advertiser_id: advertiser,
              report_type: "AUDIENCE",
              data_level: "AUCTION_CAMPAIGN",
              dimensions: JSON.stringify(["campaign_id", "age"]),
              metrics: JSON.stringify(METRICS),
              filtering,
              start_date: part.from,
              end_date: part.to,
            })),
          );
        }
      }
      rows.push(...got);
      covered.push(...ids);
    } catch (e) {
      failed.push({ advertiser_id: advertiser, error: (e as Error).message });
    }
  }
  const read: AudienceRead = { covered, failed, campaigns: ageCellsFromRows(rows) };
  if (!failed.length) cache.set(key, { at: now(), read });
  return read;
}
