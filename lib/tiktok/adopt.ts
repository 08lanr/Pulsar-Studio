// Reading a TikTok campaign Studio did not create, so Studio can adopt it
// (decision 2026-10-04, "Adopt a TikTok campaign"). Read-only: three GETs
// (/campaign/get/, /adgroup/get/, /ad/get/), nothing is ever written to
// TikTok here. Like every TikTok call it goes through the transport
// (`tiktokTransport()`: the fake in fixture mode), with the ad account's own
// token.

import { accessTokenFor, tiktokTransport } from "./index";
import type { TikTokResponse, TikTokTransport } from "./transport";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const cents = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "" || !Number.isFinite(Number(v))) return null;
  return Math.round(Number(v) * 100);
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

export type TikTokCampaignRead = {
  /** The transport that answered: the adopted record keeps it, as a launched one does. */
  mode: TikTokTransport["mode"];
  campaign: { id: string; name: string; created_at: string | null };
  groups: {
    id: string; name: string; budget_cents: number | null; budget_mode: string;
    age_groups: string[]; audience_ids: string[]; excluded_audience_ids: string[];
  }[];
  ads: { id: string; group_id: string; name: string; video_id: string | null; item_id: string | null }[];
};

const requireOk = (res: TikTokResponse, operation: string) => {
  if (res.code !== 0) throw new Error(`${operation}: ${res.message || "TikTok did not confirm the request"}`);
  return res.data ?? {};
};

/** Every page or nothing: a listing that stops short must never read as "no more ads". */
async function list(tt: TikTokTransport, token: string, advertiser: string, path: string, params: Record<string, string | number>): Promise<Row[]> {
  const rows: Row[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > 1000) throw new Error(`${path}: pagination limit reached; refusing an incomplete lookup`);
    const data = requireOk(await tt.get(path, token, { advertiser_id: advertiser, ...params, page, page_size: 100 }), path);
    if (!Array.isArray(data.list)) throw new Error(`${path}: TikTok returned no list; refusing an incomplete lookup`);
    rows.push(...(data.list as Row[]));
    const pages = (data.page_info as { total_page?: number } | undefined)?.total_page;
    if (pages === undefined && data.list.length >= 100) throw new Error(`${path}: pagination information is missing; refusing an incomplete lookup`);
    total = pages === undefined ? 1 : Math.max(1, Number(pages));
    if (!Number.isSafeInteger(total)) throw new Error(`${path}: invalid pagination information`);
  }
  return rows;
}

/** TikTok's "2026-10-03 03:15:15" is UTC; anything else is left unknown rather than guessed. */
function createdAt(v: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(str(v));
  return m ? `${m[1]}T${m[2]}.000Z` : null;
}

/**
 * The campaign with that id on that ad account, with its ad groups and ads;
 * null when the account has no such campaign. Throws when the account has no
 * token or TikTok refuses a read.
 */
export async function readTikTokCampaign(advertiserId: string, campaignId: string): Promise<TikTokCampaignRead | null> {
  const tt = tiktokTransport();
  const token = accessTokenFor(advertiserId);
  if (!token) throw new Error("No TikTok connection covers this ad account.");
  const filtering = JSON.stringify({ campaign_ids: [campaignId] });
  const campaign = (await list(tt, token, advertiserId, "/campaign/get/", { filtering }))
    .find((c) => str(c.campaign_id) === campaignId && (!c.advertiser_id || str(c.advertiser_id) === advertiserId));
  if (!campaign) return null;
  const groups = (await list(tt, token, advertiserId, "/adgroup/get/", { filtering })).filter((g) => str(g.campaign_id) === campaignId);
  const ads = (await list(tt, token, advertiserId, "/ad/get/", { filtering })).filter((a) => str(a.campaign_id) === campaignId);
  return {
    mode: tt.mode,
    campaign: { id: campaignId, name: str(campaign.campaign_name), created_at: createdAt(campaign.create_time) },
    groups: groups.map((g) => ({
      id: str(g.adgroup_id), name: str(g.adgroup_name), budget_cents: cents(g.budget), budget_mode: str(g.budget_mode),
      age_groups: strings(g.age_groups), audience_ids: strings(g.audience_ids), excluded_audience_ids: strings(g.excluded_audience_ids),
    })),
    ads: ads.map((a) => ({
      id: str(a.ad_id), group_id: str(a.adgroup_id), name: str(a.ad_name),
      video_id: str(a.video_id) || null, item_id: str(a.tiktok_item_id) || null,
    })),
  };
}
