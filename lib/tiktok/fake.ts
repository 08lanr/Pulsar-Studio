// The fake TikTok — what fixture mode launches into. Same interface as the
// live transport, nothing leaves the process, every id is deterministic and
// of a shape no real TikTok object has (17 digits starting 17…). The launch
// engine, the review poll, the metrics sync, the controls and the monitor
// run the SAME code against it that they run against TikTok, so the demo
// exercises the real pipeline while spending nothing (the demo-replay rule,
// applied to ads).
//
// What it models, and no more:
//   /advertiser/info/          a READY account with a balance
//   /identity/get/             one linked handle per account
//   /file/video/ad/upload/     video id per upload
//   /file/video/suggestcover/  one cover url; /file/image/ad/upload/ an image id
//   /campaign|adgroup|ad/create/  ids, recorded in memory with what was sent
//   /ad/get/ + /ad/review_info/   review: the first poll is in review, the
//                              second delivers (TIKTOK_FAKE_REVIEW=reject
//                              rejects every ad, for the failure path)
//   /campaign/get/ /adgroup/get/  the objects, their switches, budgets, bids
//   /campaign|adgroup/status/update/   the on/off switches
//   /campaign|adgroup/update/  budget, bid and schedule changes
//   /report/integrated/get/    a deterministic daily row per ad since the
//                              launch, budget-bounded
//   /tool/region/              a handful of countries for the location picker
//   /bc/get/ /bc/asset/get/    one Business Center holding two ad accounts
//
// TIKTOK_FAKE_ACCOUNT=suspended models a punished account: status
// STATUS_DISABLE, campaigns report PUNISH, and a status update answers
// code 0 without applying (measured live in Pulsar, 2026-08-29).
//
// State sits on globalThis (Next bundles lib/ per route) and resets with the
// process, like the fixture store.

import type { TikTokResponse, TikTokTransport, UploadField } from "./transport";

/** The fake Business Center and the two ad accounts inside it (the seed assigns the BC to the demo studio). */
export const FAKE_BC_ID = "7000000000000000000";
export const FAKE_BC_ACCOUNTS = ["7000000000000000001", "7000000000000000002"];

/** The countries the fake's region catalogue knows. */
export const FAKE_REGIONS: Array<{ location_id: string; name: string; level: string; region_code: string }> = [
  { location_id: "6252001", name: "United States", level: "COUNTRY", region_code: "US" },
  { location_id: "6251999", name: "Canada", level: "COUNTRY", region_code: "CA" },
  { location_id: "2635167", name: "United Kingdom", level: "COUNTRY", region_code: "GB" },
  { location_id: "2077456", name: "Australia", level: "COUNTRY", region_code: "AU" },
  { location_id: "5128638", name: "New York", level: "PROVINCE", region_code: "US" },
  { location_id: "5332921", name: "California", level: "PROVINCE", region_code: "US" },
];

type FakeAd = { adId: string; adgroupId: string; campaignId: string; advertiserId: string; polls: number; adName: string; body: Record<string, unknown> };
type FakeCampaign = { campaignId: string; advertiserId: string; status: "ENABLE" | "DISABLE"; createdAt: number; budget: number | null; budgetMode: string; name: string; objective: string };
type FakeAdGroup = { adgroupId: string; campaignId: string; advertiserId: string; status: "ENABLE" | "DISABLE"; budget: number; budgetMode: string; name: string; bidType: string; bidPrice: number | null; conversionBidPrice: number | null; billingEvent: string; scheduleEnd: string | null; body: Record<string, unknown> };
type FakeState = {
  seq: number;
  campaigns: Map<string, FakeCampaign>;
  adgroups: Map<string, FakeAdGroup>;
  ads: Map<string, FakeAd>;
  sparks: Map<string, { code: string; advertiserId: string; itemId: string; identityId: string }>;
};

const stateStore = globalThis as unknown as { __studioFakeTikTok?: FakeState };
function state(): FakeState {
  if (!stateStore.__studioFakeTikTok) {
    stateStore.__studioFakeTikTok = { seq: 0, campaigns: new Map(), adgroups: new Map(), ads: new Map(), sparks: new Map() };
    // The demo seed's two launched campaigns exist here too (same fixed ids as
    // data/fixture/demo-catalog.ts), so the monitor, the review poll and the
    // controls find them instead of "not found on TikTok". The bare seed (tests)
    // starts empty, so every count a test asserts is its own.
    if (process.env.FIXTURE_SEED !== "empty") seedDemoObjects(stateStore.__studioFakeTikTok);
  }
  // Next may hot-reload this transport while retaining an older fake store.
  stateStore.__studioFakeTikTok.sparks ??= new Map();
  return stateStore.__studioFakeTikTok;
}

function seedDemoObjects(s: FakeState): void {
  const demo: Array<{ campaign: string; adgroup: string; ads: string[]; name: string; createdAt: string }> = [
    { campaign: "1700000000000000001", adgroup: "1710000000000000001", ads: ["1720000000000000001", "1720000000000000002"], name: "studio-demo-c1", createdAt: "2026-09-01T03:00:00.000Z" },
    { campaign: "1700000000000000004", adgroup: "1710000000000000004", ads: ["1720000000000000041", "1720000000000000042"], name: "studio-demo-c4", createdAt: "2026-09-06T09:00:00.000Z" },
  ];
  for (const d of demo) {
    s.campaigns.set(d.campaign, { campaignId: d.campaign, advertiserId: FAKE_BC_ACCOUNTS[0], status: "ENABLE", createdAt: new Date(d.createdAt).getTime(), budget: null, budgetMode: "BUDGET_MODE_INFINITE", name: d.name, objective: "TRAFFIC" });
    s.adgroups.set(d.adgroup, { adgroupId: d.adgroup, campaignId: d.campaign, advertiserId: FAKE_BC_ACCOUNTS[0], status: "ENABLE", budget: 100, budgetMode: "BUDGET_MODE_TOTAL", name: `${d.name}-US`, bidType: "BID_TYPE_NO_BID", bidPrice: null, conversionBidPrice: null, billingEvent: "CPC", scheduleEnd: null, body: {} });
    d.ads.forEach((adId, i) => s.ads.set(adId, { adId, adgroupId: d.adgroup, campaignId: d.campaign, advertiserId: FAKE_BC_ACCOUNTS[0], polls: 1, adName: `${d.name}-ad-${i + 1}`, body: { identity_id: `${FAKE_BC_ACCOUNTS[0].slice(0, -3)}101`, identity_type: "BC_AUTH_TT", video_id: `v${d.campaign.slice(0, 16)}${i + 1}`, image_ids: [`c${d.campaign.slice(0, 16)}${i + 1}`], ad_text: "Demo ad", call_to_action: "WATCH_NOW", landing_page_url: "https://www.reelshort.com/" } }));
  }
}

const DEMO_CAMPAIGN_IDS = ["1700000000000000001", "1700000000000000004"];

/** Replay the demo hierarchy while retaining every other company's fake ads. */
export function resetFakeTikTokForDemo(campaignIds: readonly string[], runIds: readonly string[], seed: "demo" | "empty"): void {
  const s = state();
  const remove = new Set([...DEMO_CAMPAIGN_IDS, ...campaignIds]);
  // A create can succeed before its ID is checkpointed. New launch names
  // begin with the run UUID, so those interrupted creates belong to demo too.
  for (const campaign of s.campaigns.values()) {
    if (runIds.some(id => campaign.name.startsWith(`studio-${id}-`))) remove.add(campaign.campaignId);
  }
  for (const id of remove) s.campaigns.delete(id);
  for (const [id, group] of s.adgroups) if (remove.has(group.campaignId)) s.adgroups.delete(id);
  for (const [id, ad] of s.ads) if (remove.has(ad.campaignId)) s.ads.delete(id);
  if (seed === "demo") seedDemoObjects(s);
}

/** Tests reset the fake between cases, like resetFixtureStore(). */
export function resetFakeTikTok(): void {
  delete stateStore.__studioFakeTikTok;
  delete pageStore.__studioFakeTikTokPages;
}

/** Instant Pages the fake lists on /page/get/. Fixture creates answer a deterministic id without recording one, so a test seeds these. */
type FakeInstantPage = { advertiserId: string; pageId: string; title: string };
const pageStore = globalThis as unknown as { __studioFakeTikTokPages?: FakeInstantPage[] };
export function seedFakeInstantPages(rows: FakeInstantPage[]): void {
  pageStore.__studioFakeTikTokPages = rows.map((row) => ({ ...row }));
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

const suspended = () => process.env.TIKTOK_FAKE_ACCOUNT === "suspended";

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
  const s = state();
  const campaign = s.campaigns.get(ad.campaignId);
  const adgroup = s.adgroups.get(ad.adgroupId);
  const audited = { review_status: "ALL_AVAILABLE", last_audit_time: "2026-09-09 00:00:00" };
  if (campaign?.status === "DISABLE") return { secondary: "AD_STATUS_CAMPAIGN_DISABLE", review: audited };
  if (adgroup?.status === "DISABLE") return { secondary: "AD_STATUS_ADGROUP_DISABLE", review: audited };
  return { secondary: "AD_STATUS_DELIVERY_OK", review: audited };
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic daily numbers per ad: the first ad of a launch does better,
 * so the decision is legible. A campaign delivers once any of its ads has
 * been ruled on (the second look); copies made after that deliver with it.
 * Levels: AUCTION_AD (per ad), AUCTION_ADGROUP (per group, lifetime),
 * AUCTION_CAMPAIGN (per campaign, daily or lifetime).
 */
function reportRows(campaignIds: string[], adgroupIds: string[], start: string, end: string, level: "AUCTION_AD" | "AUCTION_ADGROUP" | "AUCTION_CAMPAIGN", byDay: boolean) {
  const rows: Array<{ dimensions: Record<string, string>; metrics: Record<string, number> }> = [];
  const s = state();
  const cids = campaignIds.length ? campaignIds : [...new Set(adgroupIds.map((g) => s.adgroups.get(g)?.campaignId).filter((c): c is string => !!c))];
  const byGroup = new Map<string, number>();
  for (const cid of cids) {
    const campaign = s.campaigns.get(cid);
    if (!campaign) continue;
    const ruled = [...s.ads.values()].some((a) => a.campaignId === cid && a.polls >= 1);
    const ads = ruled ? [...s.ads.values()].filter((a) => a.campaignId === cid && (!adgroupIds.length || adgroupIds.includes(a.adgroupId))) : [];
    if (!ads.length) continue;
    // Whole days: the campaign's creation DAY, not its creation instant, or a
    // campaign launched this afternoon would report nothing until tomorrow.
    const from = new Date(day(new Date(Math.max(new Date(start).getTime(), campaign.createdAt))));
    const to = new Date(end);
    const groupBudget = [...s.adgroups.values()].filter((g) => g.campaignId === cid).reduce((sum, g) => sum + g.budget, 0);
    // Each ad spends its own group's budget over five days, shared with the group's other ads.
    const adsPerGroup = new Map<string, number>();
    for (const a of s.ads.values()) if (a.campaignId === cid) adsPerGroup.set(a.adgroupId, (adsPerGroup.get(a.adgroupId) ?? 0) + 1);
    const perAdDayOf = (ad: FakeAd) => (s.adgroups.get(ad.adgroupId)?.budget ?? 0) / Math.max(1, adsPerGroup.get(ad.adgroupId) ?? 1) / 5;
    const total = { spend: 0, impressions: 0, clicks: 0, conversion: 0, video_play_actions: 0, video_watched_2s: 0, video_watched_6s: 0 };
    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      // A lifetime budget is a ceiling: once the five days have spent it, the campaign reports nothing more.
      if (campaign.budgetMode !== "BUDGET_MODE_DAY" && total.spend >= groupBudget) break;
      const dayKey = day(d);
      const byCampaign = { spend: 0, impressions: 0, clicks: 0, conversion: 0, video_play_actions: 0, video_watched_2s: 0, video_watched_6s: 0 };
      ads.forEach((ad, i) => {
        const seed = hash(`${ad.adId}:${dayKey}`);
        const spend = Math.round(perAdDayOf(ad) * (0.85 + seed * 0.3) * 100) / 100;
        const impressions = Math.round(spend * (900 + seed * 300));
        const plays = Math.round(impressions * (0.5 + seed * 0.1));
        const hold2 = Math.round(plays * (0.3 + (i === 0 ? 0.14 : 0.02) + seed * 0.05));
        const hold6 = Math.round(hold2 * (0.4 + seed * 0.1));
        const clicks = Math.round(impressions * (0.009 + (i === 0 ? 0.007 : 0.001) + seed * 0.003));
        const m = { spend, impressions, clicks, conversion: 0, video_play_actions: plays, video_watched_2s: hold2, video_watched_6s: hold6 };
        for (const k of Object.keys(byCampaign) as Array<keyof typeof byCampaign>) byCampaign[k] += m[k];
      });
      // The day that would cross the lifetime ceiling is not spent: TikTok stops delivery at the budget.
      if (campaign.budgetMode !== "BUDGET_MODE_DAY" && total.spend + byCampaign.spend > groupBudget + 0.005) break;
      ads.forEach((ad, i) => {
        const seed = hash(`${ad.adId}:${dayKey}`);
        const spend = Math.round(perAdDayOf(ad) * (0.85 + seed * 0.3) * 100) / 100;
        const impressions = Math.round(spend * (900 + seed * 300));
        const plays = Math.round(impressions * (0.5 + seed * 0.1));
        const hold2 = Math.round(plays * (0.3 + (i === 0 ? 0.14 : 0.02) + seed * 0.05));
        const hold6 = Math.round(hold2 * (0.4 + seed * 0.1));
        const clicks = Math.round(impressions * (0.009 + (i === 0 ? 0.007 : 0.001) + seed * 0.003));
        if (level === "AUCTION_AD") rows.push({ dimensions: { ad_id: ad.adId, stat_time_day: `${dayKey} 00:00:00` }, metrics: { spend, impressions, clicks, conversion: 0, video_play_actions: plays, video_watched_2s: hold2, video_watched_6s: hold6 } });
        byGroup.set(ad.adgroupId, (byGroup.get(ad.adgroupId) ?? 0) + spend);
      });
      if (level === "AUCTION_CAMPAIGN" && byDay) rows.push({ dimensions: { campaign_id: cid, stat_time_day: `${dayKey} 00:00:00` }, metrics: byCampaign });
      for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += byCampaign[k];
    }
    if (level === "AUCTION_CAMPAIGN" && !byDay) rows.push({ dimensions: { campaign_id: cid }, metrics: { ...total, spend: Math.round(total.spend * 100) / 100 } });
  }
  if (level === "AUCTION_ADGROUP") for (const [gid, spend] of byGroup) if (!adgroupIds.length || adgroupIds.includes(gid)) rows.push({ dimensions: { adgroup_id: gid }, metrics: { spend: Math.round(spend * 100) / 100 } });
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

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const campaignRow = (c: FakeCampaign) => ({
  campaign_id: c.campaignId,
  campaign_name: c.name,
  advertiser_id: c.advertiserId,
  objective_type: c.objective,
  operation_status: c.status,
  secondary_status: suspended() ? "CAMPAIGN_STATUS_ADVERTISER_PUNISH" : c.status === "DISABLE" ? "CAMPAIGN_STATUS_DISABLE" : "CAMPAIGN_STATUS_ENABLE",
  budget_mode: c.budgetMode,
  budget: c.budget ?? undefined,
});

const adgroupRow = (g: FakeAdGroup) => ({
  adgroup_id: g.adgroupId,
  adgroup_name: g.name,
  campaign_id: g.campaignId,
  advertiser_id: g.advertiserId,
  operation_status: g.status,
  secondary_status: g.status === "DISABLE" ? "ADGROUP_STATUS_DISABLE" : "ADGROUP_STATUS_DELIVERY_OK",
  budget_mode: g.budgetMode,
  budget: g.budget,
  bid_type: g.bidType,
  bid_price: g.bidPrice ?? undefined,
  conversion_bid_price: g.conversionBidPrice ?? undefined,
  billing_event: g.billingEvent,
  schedule_end_time: g.scheduleEnd ?? undefined,
});

export const fakeTransport: TikTokTransport = {
  mode: "fake",
  async get(pathname, _token, params = {}) {
    const s = state();
    switch (pathname) {
      case "/tt_video/list/": {
        const posts = [...s.sparks.values()].filter((p) => p.advertiserId === String(params.advertiser_id));
        const size = Math.max(1, Number(params.page_size) || 50);
        const page = Math.max(1, Number(params.page) || 1);
        return ok({ list: posts.slice((page - 1) * size, page * size).map((p) => ({
          item_info: { auth_code: p.code, item_id: p.itemId, item_type: "VIDEO" },
          user_info: { identity_id: p.identityId },
        })), page_info: { total_page: Math.max(1, Math.ceil(posts.length / size)) } });
      }
      case "/advertiser/info/": {
        const ids = JSON.parse(String(params.advertiser_ids ?? "[]")) as string[];
        return ok({ list: ids.map((id) => ({ advertiser_id: id, name: `Fake ad account ${id.slice(-4)}`, status: suspended() ? "STATUS_DISABLE" : "STATUS_ENABLE", currency: "USD", balance: 500, owner_bc_id: FAKE_BC_ID })) });
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
        const gids = filterIds(params.filtering, "adgroup_ids");
        const ads = [...s.ads.values()].filter((a) => (ids.length ? ids.includes(a.adId) : gids.length ? gids.includes(a.adgroupId) : cids.includes(a.campaignId)));
        const list = ads.map((a) => {
          const r = reviewFor(a);
          a.polls += 1;
          return { ad_id: a.adId, adgroup_id: a.adgroupId, campaign_id: a.campaignId, ad_name: a.adName, secondary_status: r.secondary, operation_status: "ENABLE", ad_text: a.body.ad_text, video_id: a.body.video_id, tiktok_item_id: a.body.tiktok_item_id, image_ids: a.body.image_ids, identity_id: a.body.identity_id, identity_type: a.body.identity_type, call_to_action: a.body.call_to_action, landing_page_url: a.body.landing_page_url };
        });
        return ok({ list, page_info: { total_page: 1 } });
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
        const adv = String(params.advertiser_id ?? "");
        const list = cids.length
          ? cids.map((id) => s.campaigns.get(id)).filter((c): c is FakeCampaign => !!c)
          : [...s.campaigns.values()].filter((c) => c.advertiserId === adv);
        return ok({ list: list.map(campaignRow), page_info: { total_page: 1, total_number: list.length } });
      }
      case "/adgroup/get/": {
        const cids = filterIds(params.filtering, "campaign_ids");
        const gids = filterIds(params.filtering, "adgroup_ids");
        const list = [...s.adgroups.values()].filter((g) => (gids.length ? gids.includes(g.adgroupId) : cids.includes(g.campaignId)));
        return ok({ list: list.map(adgroupRow), page_info: { total_page: 1 } });
      }
      case "/report/integrated/get/": {
        const cids = filterIds(params.filtering, "campaign_ids");
        const gids = filterIds(params.filtering, "adgroup_ids");
        const level = params.data_level === "AUCTION_AD" ? "AUCTION_AD" : params.data_level === "AUCTION_ADGROUP" ? "AUCTION_ADGROUP" : "AUCTION_CAMPAIGN";
        const dims = String(params.dimensions ?? "");
        const byDay = dims.includes("stat_time_day");
        const end = params.end_date ? String(params.end_date) : day(new Date());
        const start = params.start_date ? String(params.start_date) : day(new Date(Date.now() - 30 * 86_400_000));
        return ok({ list: reportRows(cids, gids, start, end, level, byDay) });
      }
      case "/tool/region/":
        return ok({ region_info: FAKE_REGIONS });
      case "/bc/get/":
        return ok({ list: [{ bc_info: { bc_id: FAKE_BC_ID, name: "Pulsar Business Center (fake)", company: "Pulsar", verification_status: "VERIFIED" } }], page_info: { total_page: 1 } });
      case "/bc/asset/get/": {
        if (String(params.bc_id) !== FAKE_BC_ID) return refuse("Business Center not found");
        return ok({ list: FAKE_BC_ACCOUNTS.map((id, i) => ({ asset_id: id, asset_name: `Fake ad account ${i + 1}` })), page_info: { total_page: 1 } });
      }
      case "/page/get/": {
        if (params.business_type !== "TIKTOK_INSTANT_PAGE") return ok({ list: [], page_info: { total_page: 1 } });
        const list = (pageStore.__studioFakeTikTokPages ?? []).filter((p) => p.advertiserId === String(params.advertiser_id));
        return ok({ list: list.map((p) => ({ page_id: p.pageId, title: p.title, status: "PUBLISHED" })), page_info: { total_page: 1 } });
      }
      default:
        return refuse(`fake TikTok does not model GET ${pathname}`);
    }
  },
  async post(pathname, _token, body) {
    const s = state();
    switch (pathname) {
      case "/tt_video/authorize/": {
        const code = String(body.auth_code ?? "").trim();
        if (!code || /^(invalid|expired|private)/i.test(code)) return refuse("Spark code is invalid, expired or its post is private");
        const advertiserId = String(body.advertiser_id);
        const key = `${advertiserId}:${code}`;
        if (s.sparks.has(key)) return refuse("Spark code is already authorized");
        s.sparks.set(key, { code, advertiserId, itemId: nextId("173"), identityId: nextId("174") });
        return ok({});
      }
      case "/file/image/ad/upload/":
        return ok({ image_id: nextId("c17") });
      case "/campaign/create/": {
        const name = String(body.campaign_name ?? "");
        if ([...s.campaigns.values()].some((c) => c.advertiserId === String(body.advertiser_id) && c.name === name)) return refuse("Campaign name already exists");
        const budget = num(body.budget);
        if (body.budget_mode === "BUDGET_MODE_TOTAL" && (budget === null || budget < 50)) return refuse("Campaign budget is below the minimum of 50");
        const campaignId = nextId("170");
        s.campaigns.set(campaignId, { campaignId, advertiserId: String(body.advertiser_id), status: body.operation_status === "DISABLE" ? "DISABLE" : "ENABLE", createdAt: Date.now(), budget: body.budget_mode === "BUDGET_MODE_INFINITE" ? null : budget, budgetMode: String(body.budget_mode ?? "BUDGET_MODE_INFINITE"), name, objective: String(body.objective_type ?? "TRAFFIC") });
        return ok({ campaign_id: campaignId });
      }
      case "/adgroup/create/": {
        const campaign = s.campaigns.get(String(body.campaign_id));
        if (!campaign) return refuse("campaign not found");
        const name = String(body.adgroup_name ?? "");
        if ([...s.adgroups.values()].some((g) => g.campaignId === campaign.campaignId && g.name === name)) return refuse("Ad group name already exists");
        const budget = num(body.budget);
        if (budget === null || budget < 20) return refuse("Budget is below the minimum of 20");
        if (Array.isArray(body.age_groups) && body.age_groups.length === 0) return refuse("age_groups must not be empty");
        if (body.schedule_type === "SCHEDULE_START_END" && !body.schedule_end_time) return refuse("schedule_end_time is required");
        if (body.bid_type === "BID_TYPE_CUSTOM" && num(body.bid_price) === null && num(body.conversion_bid_price) === null) return refuse("A custom bid needs bid_price or conversion_bid_price");
        const adgroupId = nextId("171");
        s.adgroups.set(adgroupId, {
          adgroupId, campaignId: campaign.campaignId, advertiserId: String(body.advertiser_id), status: body.operation_status === "DISABLE" ? "DISABLE" : "ENABLE",
          budget, budgetMode: String(body.budget_mode ?? "BUDGET_MODE_TOTAL"), name, bidType: String(body.bid_type ?? "BID_TYPE_NO_BID"),
          bidPrice: num(body.bid_price), conversionBidPrice: num(body.conversion_bid_price), billingEvent: String(body.billing_event ?? "CPC"),
          scheduleEnd: body.schedule_end_time ? String(body.schedule_end_time) : null, body: { ...body },
        });
        return ok({ adgroup_id: adgroupId });
      }
      case "/ad/create/": {
        const adgroup = s.adgroups.get(String(body.adgroup_id));
        if (!adgroup) return refuse("adgroup not found");
        const creatives = Array.isArray(body.creatives) ? (body.creatives as Array<Record<string, unknown>>) : [];
        if (!creatives.length) return refuse("creatives is empty");
        for (const c of creatives) {
          if (c.identity_type === "AUTH_CODE") {
            const post = [...s.sparks.values()].find((p) => p.advertiserId === String(body.advertiser_id) && p.itemId === c.tiktok_item_id && p.identityId === c.identity_id);
            if (!post || !(c.landing_page_url || c.page_id) || c.video_id || c.image_ids || c.ad_text) return refuse("Invalid Spark ad: use only the authorized post and identity");
            if (/^reject-ad/i.test(post.code)) return refuse("Spark creative not valid");
          } else if (!c.identity_id || !c.video_id || !Array.isArray(c.image_ids) || !c.landing_page_url) {
            throw new Error("fake TikTok: incomplete ad payload");
          }
        }
        const adIds = creatives.map((c) => {
          const adId = nextId("172");
          s.ads.set(adId, { adId, adgroupId: adgroup.adgroupId, campaignId: adgroup.campaignId, advertiserId: String(body.advertiser_id), polls: 0, adName: String(c.ad_name ?? ""), body: { ...c } });
          return adId;
        });
        return ok({ ad_ids: adIds });
      }
      case "/campaign/status/update/": {
        // A suspended account answers 0 and ignores the change (measured live).
        if (suspended()) return ok({});
        for (const id of (body.campaign_ids as string[]) ?? []) {
          const c = s.campaigns.get(String(id));
          if (c) c.status = body.operation_status === "DISABLE" ? "DISABLE" : "ENABLE";
        }
        return ok({});
      }
      case "/adgroup/status/update/": {
        if (suspended()) return ok({});
        for (const id of (body.adgroup_ids as string[]) ?? []) {
          const g = s.adgroups.get(String(id));
          if (g) g.status = body.operation_status === "DISABLE" ? "DISABLE" : "ENABLE";
        }
        return ok({});
      }
      case "/campaign/update/": {
        const c = s.campaigns.get(String(body.campaign_id));
        if (!c) return refuse("campaign not found");
        if (body.budget !== undefined) {
          const budget = num(body.budget);
          if (budget === null || budget < 50) return refuse("Campaign budget is below the minimum of 50");
          c.budget = budget;
          if (body.budget_mode) c.budgetMode = String(body.budget_mode);
        }
        if (body.campaign_name) c.name = String(body.campaign_name);
        return ok({ campaign_id: c.campaignId });
      }
      case "/adgroup/update/": {
        const g = s.adgroups.get(String(body.adgroup_id));
        if (!g) return refuse("adgroup not found");
        if (body.budget !== undefined) {
          const budget = num(body.budget);
          if (budget === null || budget < 20) return refuse("Budget is below the minimum of 20");
          g.budget = budget;
        }
        if (body.bid_price !== undefined || body.conversion_bid_price !== undefined) {
          // Lowest cost has no bid, and TikTok will not let one be added (overlord, probed).
          if (g.bidType !== "BID_TYPE_CUSTOM") return refuse("Bid is not editable on a lowest-cost ad group");
          if (body.bid_price !== undefined) g.bidPrice = num(body.bid_price);
          if (body.conversion_bid_price !== undefined) g.conversionBidPrice = num(body.conversion_bid_price);
        }
        if (body.schedule_end_time !== undefined) g.scheduleEnd = String(body.schedule_end_time);
        if (body.adgroup_name) g.name = String(body.adgroup_name);
        return ok({ adgroup_id: g.adgroupId });
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
