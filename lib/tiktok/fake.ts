// The fake TikTok — what fixture mode launches into. Same interface as the
// live transport, nothing leaves the process, every id is deterministic and
// of a shape no real TikTok object has (17 digits starting 17…). The launch
// engine, the review poll and the metrics sync run the SAME code against it
// that they run against TikTok, so the demo exercises the real pipeline
// while spending nothing (the demo-replay rule, applied to ads).
//
// What it models, and no more:
//   /advertiser/info/          a READY account with a balance
//   /identity/get/             one linked handle per account
//   /file/video/ad/upload/     video id per upload
//   /file/video/suggestcover/  one cover url; /file/image/ad/upload/ an image id
//   /campaign|adgroup|ad/create/  ids, recorded in memory
//   /ad/get/ + /ad/review_info/   review: the first poll is in review, the
//                              second delivers (TIKTOK_FAKE_REVIEW=reject
//                              rejects every ad, for the failure path)
//   /campaign/status/update/ + /campaign/get/   the on/off switch
//   /report/integrated/get/    a deterministic daily row per ad since the
//                              launch, budget-bounded
//
// State sits on globalThis (Next bundles lib/ per route) and resets with the
// process, like the fixture store.

import type { TikTokResponse, TikTokTransport, UploadField } from "./transport";

type FakeAd = { adId: string; adgroupId: string; campaignId: string; advertiserId: string; polls: number; adName: string };
type FakeCampaign = { campaignId: string; advertiserId: string; status: "ENABLE" | "DISABLE"; createdAt: number; budget: number };
type FakeState = {
  seq: number;
  campaigns: Map<string, FakeCampaign>;
  adgroups: Map<string, { adgroupId: string; campaignId: string; budget: number }>;
  ads: Map<string, FakeAd>;
};

const stateStore = globalThis as unknown as { __studioFakeTikTok?: FakeState };
function state(): FakeState {
  if (!stateStore.__studioFakeTikTok) {
    stateStore.__studioFakeTikTok = { seq: 0, campaigns: new Map(), adgroups: new Map(), ads: new Map() };
  }
  return stateStore.__studioFakeTikTok;
}

/** Tests reset the fake between cases, like resetFixtureStore(). */
export function resetFakeTikTok(): void {
  delete stateStore.__studioFakeTikTok;
}

function nextId(prefix: string): string {
  const s = state();
  s.seq += 1;
  // 17 digits: "17" + kind digit + 14-digit counter. Distinct from any real id
  // and from the seed's fixed ids (which use counter 1–2 under the same kinds).
  return `${prefix}${String(1_000_000 + s.seq).padStart(14, "0")}`;
}

const ok = (data: Record<string, unknown>): TikTokResponse => ({ code: 0, message: "OK", data });
const refuse = (message: string): TikTokResponse => ({ code: 40002, message });

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619;
  return (h >>> 0) / 4294967296;
}

function reviewFor(ad: FakeAd): { secondary: string; review: Record<string, unknown> } {
  const reject = process.env.TIKTOK_FAKE_REVIEW === "reject";
  if (reject) {
    return { secondary: "AD_STATUS_AUDIT_DENY", review: { review_status: "UNAVAILABLE", reject_info: [{ reasons: ["Fake review: rejected by TIKTOK_FAKE_REVIEW=reject"], suggestion: "Unset TIKTOK_FAKE_REVIEW to approve." }], last_audit_time: "2026-09-09 00:00:00" } };
  }
  if (ad.polls < 1) return { secondary: "AD_STATUS_AUDIT", review: { review_status: "AUDIT" } };
  const campaign = state().campaigns.get(ad.campaignId);
  if (campaign?.status === "DISABLE") return { secondary: "AD_STATUS_CAMPAIGN_DISABLE", review: { review_status: "ALL_AVAILABLE", last_audit_time: "2026-09-09 00:00:00" } };
  return { secondary: "AD_STATUS_DELIVERY_OK", review: { review_status: "ALL_AVAILABLE", last_audit_time: "2026-09-09 00:00:00" } };
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Deterministic daily numbers per ad: the first ad of a launch does better, so the decision is legible. */
function reportRows(campaignIds: string[], start: string, end: string, level: "AUCTION_AD" | "AUCTION_CAMPAIGN") {
  const rows: Array<{ dimensions: Record<string, string>; metrics: Record<string, number> }> = [];
  const s = state();
  for (const cid of campaignIds) {
    const campaign = s.campaigns.get(cid);
    if (!campaign) continue;
    const ads = [...s.ads.values()].filter((a) => a.campaignId === cid && a.polls >= 1);
    if (!ads.length) continue;
    // Whole days: the campaign's creation DAY, not its creation instant, or a
    // campaign launched this afternoon would report nothing until tomorrow.
    const from = new Date(day(new Date(Math.max(new Date(start).getTime(), campaign.createdAt))));
    const to = new Date(end);
    const perAdDay = campaign.budget / Math.max(1, ads.length) / 5; // the fake spends the budget over five days
    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const dayKey = day(d);
      const byCampaign = { spend: 0, impressions: 0, clicks: 0, conversion: 0, video_play_actions: 0, video_watched_2s: 0, video_watched_6s: 0 };
      ads.forEach((ad, i) => {
        const seed = hash(`${ad.adId}:${dayKey}`);
        const spend = Math.round(perAdDay * (0.85 + seed * 0.3) * 100) / 100;
        const impressions = Math.round(spend * (900 + seed * 300));
        const plays = Math.round(impressions * (0.5 + seed * 0.1));
        const hold2 = Math.round(plays * (0.3 + (i === 0 ? 0.14 : 0.02) + seed * 0.05));
        const hold6 = Math.round(hold2 * (0.4 + seed * 0.1));
        const clicks = Math.round(impressions * (0.009 + (i === 0 ? 0.007 : 0.001) + seed * 0.003));
        const m = { spend, impressions, clicks, conversion: 0, video_play_actions: plays, video_watched_2s: hold2, video_watched_6s: hold6 };
        if (level === "AUCTION_AD") rows.push({ dimensions: { ad_id: ad.adId, stat_time_day: `${dayKey} 00:00:00` }, metrics: m });
        for (const k of Object.keys(byCampaign) as Array<keyof typeof byCampaign>) byCampaign[k] += m[k];
      });
      if (level === "AUCTION_CAMPAIGN") rows.push({ dimensions: { campaign_id: cid, stat_time_day: `${dayKey} 00:00:00` }, metrics: byCampaign });
    }
  }
  return rows;
}

function filterIds(raw: unknown, key: string): string[] {
  try {
    const f = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(f)) {
      const hit = f.find((x) => x?.field_name === key);
      return hit ? (JSON.parse(hit.filter_value) as string[]).map(String) : [];
    }
    return Array.isArray(f?.[key]) ? f[key].map(String) : [];
  } catch {
    return [];
  }
}

export const fakeTransport: TikTokTransport = {
  mode: "fake",
  async get(pathname, _token, params = {}) {
    const s = state();
    switch (pathname) {
      case "/advertiser/info/": {
        const ids = JSON.parse(String(params.advertiser_ids ?? "[]")) as string[];
        return ok({ list: ids.map((id) => ({ advertiser_id: id, name: `Fake ad account ${id.slice(-4)}`, status: "STATUS_ENABLE", currency: "USD", balance: 500, owner_bc_id: "7000000000000000000" })) });
      }
      case "/identity/get/": {
        if (params.identity_type !== "BC_AUTH_TT") return ok({ identity_list: [] });
        const adv = String(params.advertiser_id ?? "");
        return ok({ identity_list: [{ identity_id: `${adv.slice(0, -3)}101`, identity_type: "BC_AUTH_TT", display_name: "@pulsar.dramas" }] });
      }
      case "/file/video/suggestcover/":
        return ok({ list: [{ cover_url: `https://fake.tiktok.invalid/cover/${params.video_id}.jpg` }] });
      case "/ad/get/": {
        const ids = filterIds(params.filtering, "ad_ids");
        const cids = filterIds(params.filtering, "campaign_ids");
        const ads = [...s.ads.values()].filter((a) => (ids.length ? ids.includes(a.adId) : cids.includes(a.campaignId)));
        const list = ads.map((a) => {
          const r = reviewFor(a);
          a.polls += 1;
          return { ad_id: a.adId, adgroup_id: a.adgroupId, campaign_id: a.campaignId, ad_name: a.adName, secondary_status: r.secondary, operation_status: "ENABLE" };
        });
        return ok({ list });
      }
      case "/ad/review_info/": {
        const ids = JSON.parse(String(params.ad_ids ?? "[]")) as string[];
        const map: Record<string, unknown> = {};
        for (const id of ids) {
          const ad = s.ads.get(String(id));
          if (ad) map[String(id)] = reviewFor({ ...ad, polls: Math.max(ad.polls - 1, 0) }).review;
        }
        return ok({ ad_review_map: map });
      }
      case "/campaign/get/": {
        const cids = filterIds(params.filtering, "campaign_ids");
        return ok({ list: cids.map((id) => s.campaigns.get(id)).filter(Boolean).map((c) => ({ campaign_id: c!.campaignId, operation_status: c!.status, budget: c!.budget })) });
      }
      case "/report/integrated/get/": {
        const cids = filterIds(params.filtering, "campaign_ids");
        const level = params.data_level === "AUCTION_AD" ? "AUCTION_AD" : "AUCTION_CAMPAIGN";
        return ok({ list: reportRows(cids, String(params.start_date), String(params.end_date), level) });
      }
      case "/bc/get/":
        return ok({ list: [{ bc_info: { bc_id: "7000000000000000000", name: "Pulsar (fake)" } }] });
      default:
        return refuse(`fake TikTok does not model GET ${pathname}`);
    }
  },
  async post(pathname, _token, body) {
    const s = state();
    switch (pathname) {
      case "/file/image/ad/upload/":
        return ok({ image_id: nextId("c17") });
      case "/campaign/create/": {
        const campaignId = nextId("170");
        s.campaigns.set(campaignId, { campaignId, advertiserId: String(body.advertiser_id), status: body.operation_status === "DISABLE" ? "DISABLE" : "ENABLE", createdAt: Date.now(), budget: 0 });
        return ok({ campaign_id: campaignId });
      }
      case "/adgroup/create/": {
        const campaign = s.campaigns.get(String(body.campaign_id));
        if (!campaign) return refuse("campaign not found");
        const budget = Number(body.budget);
        if (!Number.isFinite(budget) || budget < 20) return refuse("Budget is below the minimum of 20");
        const adgroupId = nextId("171");
        s.adgroups.set(adgroupId, { adgroupId, campaignId: campaign.campaignId, budget });
        campaign.budget = budget;
        return ok({ adgroup_id: adgroupId });
      }
      case "/ad/create/": {
        const adgroup = s.adgroups.get(String(body.adgroup_id));
        if (!adgroup) return refuse("adgroup not found");
        const creatives = Array.isArray(body.creatives) ? (body.creatives as Array<Record<string, unknown>>) : [];
        if (!creatives.length) return refuse("creatives is empty");
        const adIds = creatives.map((c) => {
          if (!c.identity_id || !c.video_id || !Array.isArray(c.image_ids) || !c.landing_page_url) throw new Error("fake TikTok: incomplete ad payload");
          const adId = nextId("172");
          s.ads.set(adId, { adId, adgroupId: adgroup.adgroupId, campaignId: adgroup.campaignId, advertiserId: String(body.advertiser_id), polls: 0, adName: String(c.ad_name ?? "") });
          return adId;
        });
        return ok({ ad_ids: adIds });
      }
      case "/campaign/status/update/": {
        for (const id of (body.campaign_ids as string[]) ?? []) {
          const c = s.campaigns.get(String(id));
          if (c) c.status = body.operation_status === "DISABLE" ? "DISABLE" : "ENABLE";
        }
        return ok({});
      }
      default:
        return refuse(`fake TikTok does not model POST ${pathname}`);
    }
  },
  async upload(pathname, _token, fields: Record<string, UploadField>) {
    if (pathname === "/file/video/ad/upload/") {
      const file = fields.video_file;
      if (!file || typeof file === "string" || !file.data.length) return refuse("video_file is empty");
      // Shape confirmed live against sandbox: a bare ARRAY — {"data": [{"video_id"}]}.
      return { code: 0, message: "OK", data: [{ video_id: nextId("v17") }] as unknown as TikTokResponse["data"] };
    }
    if (pathname === "/file/image/ad/upload/") return ok({ image_id: nextId("c17") });
    return refuse(`fake TikTok does not model upload ${pathname}`);
  },
};

/** For tests and the admin monitor in fixture mode: what the fake holds. */
export function fakeTikTokSnapshot() {
  const s = state();
  return { campaigns: [...s.campaigns.values()], adgroups: [...s.adgroups.values()], ads: [...s.ads.values()] };
}
