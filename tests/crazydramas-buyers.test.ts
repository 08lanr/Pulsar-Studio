// Stats: campaigns, buyers and the full episode curve (decision 2026-09-26). The pure pieces behind the
// Overview tiles, the Campaigns tab's "TikTok says / We saw" and its reasons, which clip each ad played, the
// Buyers tab's people and timelines, and the Series tab's episode curve. No request leaves the process.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStatsLaunches, fakeStatsReport, FAKE_STATS_ADS, FAKE_STATS_CAMPAIGNS, FAKE_STATS_CLIPS } from "@/lib/crazydramas/fake-stats";
import {
  adCreatives, byAdType, campaignFacts, compareCampaigns, dailySpend, fmtRatio, gapReasons, launchClipTitles, lifeInPeriod, returnOnSpend, sourceFileName, spendIn, type CreativeClip,
} from "@/lib/crazydramas/stats-ads";
import {
  adBuyers, browsersOf, buyerCounts, buyersByAd, fmtDuration, fromAd, hasBuyerDetails, personOf, purchasesIn, purchaseSourceKey, timelineRows, untagged, untaggedBuyers,
} from "@/lib/crazydramas/stats-buyers";
import { biggestEpisodeDrops, episodeCurve, paywallEpisode, seriesFunnel } from "@/lib/crazydramas/stats-series";
import { adSpendsFromRuns, campaignTable, NO_FILTER, parseDashTab, rangeDays, sumRows, dashRows, type AdPeriod } from "@/lib/crazydramas/stats-summary";
import { CdStatsReportSchema, type CdStatsPurchase } from "@/lib/crazydramas/stats-types";
import type { LaunchRun } from "@/lib/launch/types";
import { optimizesPurchases, purchaseGoal } from "@/lib/tiktok/settings";

const NOW = new Date("2026-09-26T20:00:00Z");
const SERIES = [
  { id: "d1", slug: "one", title: "My Cold Boss", status: "published", free_episode_count: 5 },
  { id: "d2", slug: "two", title: "Flirt", status: "published", free_episode_count: 6 },
];
const fake = () => fakeStatsReport(SERIES, [], NOW);

const purchase = (over: Partial<CdStatsPurchase> & Pick<CdStatsPurchase, "person">): CdStatsPurchase => ({
  id: over.id ?? `p-${Math.random()}`,
  at: "2026-09-26T18:00:00Z",
  drama_id: "d1",
  amount_cents: 199,
  renewal: false,
  browser: "b1",
  source: { platform: "tiktok", campaign: "c1", ad: "a1", stored_copy: false, device: "tiktok_android", country: "US", region: "CA" },
  first_seen_at: null,
  paid_after_s: null,
  ...over,
});

// ---- the contract ------------------------------------------------------------------------------------------------

test("buyer details are optional: an older report parses without them and says so", () => {
  const f = fake();
  const { purchases: _p, journeys: _j, people: _q, ...old } = f;
  const parsed = CdStatsReportSchema.parse(old);
  assert.equal(parsed.purchases, undefined);
  assert.equal(hasBuyerDetails(parsed), false);
  assert.equal(hasBuyerDetails(CdStatsReportSchema.parse(f)), true);
  // A source missing its newer fields is filled with defaults, never refused.
  const loose = CdStatsReportSchema.parse({ ...f, purchases: [{ id: "x", at: "2026-09-26T10:00:00Z", drama_id: "d1", amount_cents: 199, person: "abc", browser: "b", source: { platform: "tiktok" } }] });
  assert.deepEqual(loose.purchases![0].source, { platform: "tiktok", campaign: null, ad: null, stored_copy: false, device: "unknown", country: null, region: null });
  assert.equal(loose.purchases![0].renewal, false);
});

test("the fake report has the buyers the screens need: 6 people, 8 payments, two series, one on two browsers, one untagged", () => {
  const f = fake();
  const counts = buyerCounts(f.purchases!);
  assert.deepEqual([counts.people, counts.purchases], [6, 8]);
  assert.deepEqual(f.people, { buyers: 6, purchases: 8, revenue_cents: counts.revenue_cents });
  assert.equal(new Set(f.purchases!.map((p) => p.drama_id)).size, 2);
  assert.equal([...browsersOf(f.purchases!).values()].filter((n) => n > 1).length, 1);
  assert.equal(untaggedBuyers(f.purchases!), 1);
  for (const steps of Object.values(f.journeys!)) assert.ok(steps.length >= 10 && steps.length <= 40, `journey of ${steps.length}`);
  assert.ok(f.sources.some((s) => s.platform === "tiktok" && !s.campaign && !s.stored_copy), "an untagged TikTok source row");
});

// ---- buyers ------------------------------------------------------------------------------------------------------

test("payments are narrowed by period, series, phone, source and country, newest first", () => {
  const f = fake();
  const all = purchasesIn(f, rangeDays(f, "30d"), NO_FILTER);
  assert.equal(all.length, 8);
  assert.ok(all.every((p, i) => i === 0 || all[i - 1].at >= p.at));
  assert.ok(purchasesIn(f, rangeDays(f, "today"), NO_FILTER).length < 8);
  assert.ok(purchasesIn(f, rangeDays(f, "30d"), { ...NO_FILTER, series: "d2" }).every((p) => p.drama_id === "d2"));
  assert.ok(purchasesIn(f, rangeDays(f, "30d"), { ...NO_FILTER, device: "iphone" }).every((p) => p.source?.device === "iphone"));
  const camp = purchasesIn(f, rangeDays(f, "30d"), { ...NO_FILTER, source: `campaign:${FAKE_STATS_CAMPAIGNS[0]}` });
  assert.equal(camp.length, 4);
  assert.equal(purchasesIn(f, rangeDays(f, "30d"), { ...NO_FILTER, source: "ads" }).length, 6);
  assert.equal(purchasesIn(f, rangeDays(f, "30d"), { ...NO_FILTER, country: "US", source: "no_ad" }).length, 2, "direct and untagged");
  assert.equal(purchaseSourceKey({ source: null }), "no_ad");
});

test("people against payments; ad buyers include TikTok's untagged click; buyers per campaign and ad", () => {
  const list = [
    purchase({ person: "a", browser: "b1" }),
    purchase({ person: "a", browser: "b2", source: { platform: "direct", campaign: null, ad: null, stored_copy: false, device: "iphone", country: "US", region: null } }),
    purchase({ person: "b", amount_cents: 499, renewal: true }),
    purchase({ person: "c", source: { platform: "tiktok", campaign: null, ad: null, stored_copy: false, device: "tiktok_android", country: null, region: null } }),
    purchase({ person: "d", source: { platform: "tiktok", campaign: null, ad: null, stored_copy: true, device: "tiktok_android", country: null, region: null } }),
  ];
  assert.deepEqual(buyerCounts(list), { people: 4, purchases: 5, first_purchases: 4, renewals: 1, revenue_cents: 199 * 4 + 499 });
  assert.equal(adBuyers(list), 4, "a (first browser), b, c untagged, d stored copy");
  assert.equal(untaggedBuyers(list), 1);
  assert.equal(fromAd(null), false);
  assert.equal(untagged(list[4].source), false, "a stored copy is not untagged");
  const by = buyersByAd(list);
  assert.deepEqual(by.campaigns.get("c1"), { people: 2, purchases: 2, first_purchases: 1, renewals: 1, revenue_cents: 199 + 499 });
  assert.equal(by.ads.get("a1")?.people, 2);
});

test("one person: first touch from the journey, two browsers, time to pay, total", () => {
  const f = fake();
  const p = personOf(f, "m4rq2z")!;
  assert.equal(p.purchases.length, 2);
  assert.equal(p.browsers, 2);
  assert.equal(p.total_cents, 398);
  assert.equal(p.first_touch?.platform, "tiktok");
  assert.equal(p.first_touch?.campaign, FAKE_STATS_CAMPAIGNS[0]);
  assert.equal(p.first_touch?.ad, FAKE_STATS_ADS[0]);
  assert.equal(p.device, "tiktok_android");
  assert.equal(p.to_pay_s, Math.round(0.3 * 3600));
  assert.equal(personOf(f, "nobody"), null);
  // Without a journey, the first payment's source and times stand in.
  const lone = personOf({ purchases: [purchase({ person: "z", at: "2026-09-26T10:10:00Z", first_seen_at: "2026-09-26T10:00:00Z" })] }, "z")!;
  assert.equal(lone.first_touch?.campaign, "c1");
  assert.equal(lone.to_pay_s, 600);
});

test("a timeline folds a run of episodes into one row and keeps landings, the paywall, checkout, payment and leaving", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 8, 26, 10, m)).toISOString();
  const rows = timelineRows([
    { at: at(0), drama_id: "d1", kind: "landing", platform: "tiktok", campaign: "c1", ad: "a1" },
    { at: at(1), drama_id: "d1", kind: "ep_start", episode: 1 },
    { at: at(3), drama_id: "d1", kind: "ep_finish", episode: 1 },
    { at: at(4), drama_id: "d1", kind: "ep_start", episode: 2 },
    { at: at(5), drama_id: "d1", kind: "ep_start", episode: 3 },
    { at: at(7), drama_id: "d1", kind: "ep_finish", episode: 3 },
    { at: at(8), drama_id: "d1", kind: "paywall", episode: 4 },
    { at: at(9), drama_id: "d1", kind: "checkout", episode: 4 },
    { at: at(10), drama_id: "d1", kind: "paid", episode: 4, amount_cents: 199 },
    { at: at(11), drama_id: "d1", kind: "ep_start", episode: 4 },
    { at: at(20), drama_id: "d2", kind: "ep_start", episode: 1 },
    { at: at(30), drama_id: "d2", kind: "left", episode: 1 },
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["landing", "episodes", "paywall", "checkout", "paid", "episodes", "episodes", "left"]);
  const run = rows[1];
  assert.ok(run.kind === "episodes");
  if (run.kind === "episodes") assert.deepEqual([run.from, run.to, run.started, run.finished], [1, 3, 3, 2]);
  assert.equal(rows[0].gap_s, null);
  assert.equal(rows[2].gap_s, 60);
  const paid = rows[4];
  assert.ok(paid.kind === "paid" && paid.amount_cents === 199);
  assert.equal(fmtDuration(45), "45 s");
  assert.equal(fmtDuration(720), "12 min");
  assert.equal(fmtDuration(3 * 3600 + 300), "3 h 5 min");
  assert.equal(fmtDuration(52 * 3600), "2 d 4 h");
});

// ---- campaigns -------------------------------------------------------------------------------------------------

test("what a campaign optimizes: only Website purchases on Purchase counts purchases at TikTok", () => {
  assert.equal(purchaseGoal({ objective_type: "WEB_CONVERSIONS", sales_destination: "website", optimization_goal: "CONVERT", optimization_event: "SHOPPING" }), "purchases");
  assert.equal(purchaseGoal({ objective_type: "WEB_CONVERSIONS", sales_destination: "website", optimization_goal: "CONVERT", optimization_event: "INITIATE_ORDER" }), "checkouts");
  assert.equal(purchaseGoal({ objective_type: "WEB_CONVERSIONS", sales_destination: "instant_page", optimization_goal: "CONVERT" }), "instant_page");
  assert.equal(purchaseGoal({ objective_type: "TRAFFIC", optimization_goal: "CLICK" }), "clicks");
  assert.equal(purchaseGoal({ optimization_goal: "TRAFFIC_LANDING_PAGE_VIEW" }), "page_views");
  assert.equal(optimizesPurchases({ optimization_goal: "CLICK" }), false);
});

test("the gap reasons: the live numbers of 2026-09-26 read as Ruobin would expect", () => {
  // da4a optimizes purchases: $18.18, TikTok 5, crazydramas 4, one untagged TikTok buyer.
  assert.deepEqual(gapReasons({ spend_cents: 1818, goal: "purchases", tiktok: 5, ours: 4, untagged: 1, in_period: true }), [{ code: "tiktok_higher" }, { code: "untagged", n: 1 }]);
  // 0d76 optimizes clicks: $11.33, TikTok 0, crazydramas 2.
  assert.deepEqual(gapReasons({ spend_cents: 1133, goal: "clicks", tiktok: null, ours: 2, untagged: 1, in_period: true }), [{ code: "not_purchases", goal: "clicks" }]);
  assert.deepEqual(gapReasons({ spend_cents: 0, goal: "purchases", tiktok: 0, ours: 0, untagged: 0, in_period: true }), [{ code: "no_spend" }]);
  assert.deepEqual(gapReasons({ spend_cents: 500, goal: "purchases", tiktok: 3, ours: 1, untagged: 0, in_period: false }), [{ code: "outside_period" }]);
  assert.deepEqual(gapReasons({ spend_cents: 500, goal: "purchases", tiktok: null, ours: 1, untagged: 0, in_period: true }), [{ code: "not_reported" }]);
  assert.deepEqual(gapReasons({ spend_cents: 500, goal: "purchases", tiktok: 1, ours: 3, untagged: 0, in_period: true }), [{ code: "we_higher" }]);
  assert.deepEqual(gapReasons({ spend_cents: 500, goal: "purchases", tiktok: 2, ours: 2, untagged: 2, in_period: true }), [{ code: "match" }]);
  assert.equal(lifeInPeriod("2026-09-24T18:00:00Z", undefined), true, "All compares whole lives");
  const period: AdPeriod = { from: "2026-09-25", to: "2026-09-26", timezone: "America/Los_Angeles", days: null };
  assert.equal(lifeInPeriod("2026-09-24T18:00:00Z", period), false);
  assert.equal(lifeInPeriod("2026-09-25T18:00:00Z", period), true);
  assert.equal(lifeInPeriod(null, period), false);
});

test("which clip each ad played: by the snapshot's code, the ad groups' record, the uploaded video or the post", () => {
  const clips = new Map<string, CreativeClip>([
    ["clip-hook", { id: "clip-hook", title_id: "t1", ad_format: "hook_ad", hook_en: "The hook", render_path: "t1/e1/upload-0123456789abcdef-flirt-hook-v1.mp4" }],
    ["clip-narr", { id: "clip-narr", title_id: "t1", ad_format: "narration_trailer", hook_en: "The trailer", render_path: "t1/e1/flirt-v4.mp4" }],
  ]);
  const run = {
    external_id: "lr_1",
    created_at: "2026-09-24T18:00:00Z",
    draft: { provider: "tiktok", name: "Sep 24", content: [], tiktok_settings: { optimization_goal: "CLICK" } },
    campaigns: [
      {
        name: "0d76",
        content: [
          { kind: "video", value: "clip-hook", clip_id: "clip-hook", title_id: "t1", text: "Item text" },
          { kind: "video", value: "clip-narr", title_id: "t1" },
          { kind: "tiktok_post", value: "post-1", text: "A post" },
          { kind: "spark", value: "#spark", text: "A Spark code" },
        ],
        state: {
          campaign_id: "c2",
          groups: [{ ads: { "#spark": "ad-spark" } }],
          uploads: { "clip-narr": { video_id: "v-narr" } },
          posts: [{ code: "post-1", item_id: "item-9" }],
        },
        snapshot: {
          ads: [
            { id: "ad-hook", status: "live", content_value: "clip-hook" },
            { id: "ad-narr", status: "live", video_id: "v-narr" },
            { id: "ad-post", status: "live", item_id: "item-9" },
            { id: "ad-lost", status: "live" },
          ],
        },
      },
    ],
  } as unknown as LaunchRun;
  const m = adCreatives([run], clips);
  assert.equal(m.get("ad-hook")?.ad_format, "hook_ad");
  assert.equal(m.get("ad-hook")?.text, "The hook", "the clip's hook before the item's text");
  assert.equal(m.get("ad-hook")?.file_name, "flirt-hook-v1.mp4");
  assert.equal(m.get("ad-narr")?.clip_id, "clip-narr", "by the uploaded video id");
  assert.equal(m.get("ad-narr")?.ad_format, "narration_trailer");
  assert.equal(m.get("ad-post")?.kind, "tiktok_post");
  assert.equal(m.get("ad-post")?.text, "A post");
  assert.equal(m.get("ad-spark")?.text, "A Spark code", "by the ad groups' record");
  assert.equal(m.get("ad-lost")?.clip_id, null);
  assert.equal(m.get("ad-lost")?.campaign_id, "c2");
  assert.deepEqual([...launchClipTitles([run]).get("t1")!].sort(), ["clip-hook", "clip-narr"]);
  assert.equal(sourceFileName("a/b/upload-0123456789abcdef-x.mp4"), "x.mp4");
  assert.equal(sourceFileName("a/b/plain.mp4"), "plain.mp4");
  assert.equal(sourceFileName(null), null);
});

test("the fixture's two campaigns: TikTok says and we saw, reasons, clips reused across campaigns, and totals by ad type", () => {
  const f = fake();
  const { runs, days } = fakeStatsLaunches(NOW);
  const spends = adSpendsFromRuns(runs);
  const span = rangeDays(f, "7d");
  const period: AdPeriod = { ...span, timezone: f.timezone, days };
  const rows = campaignTable({ ...f, sources: dashRows(f, { from: f.from, to: f.to }, NO_FILTER) }, spends, undefined, period);
  const clips = new Map<string, CreativeClip>(FAKE_STATS_CLIPS.map((c) => [c.id, { ...c }]));
  const creatives = adCreatives(runs, clips);
  const list = purchasesIn(f, span, NO_FILTER);
  const views = compareCampaigns(rows, campaignFacts(runs), creatives, buyersByAd(list), untaggedBuyers(list), period);
  const [a, b] = views.filter((v) => v.kind === "campaign");
  assert.equal(a.campaign_id, FAKE_STATS_CAMPAIGNS[0]);
  assert.equal(a.spend_cents, 1818);
  assert.equal(a.tiktok, 5);
  assert.deepEqual([a.ours.people, a.ours.purchases], [3, 4]);
  assert.deepEqual(a.reasons.map((r) => r.code), ["tiktok_higher", "untagged"]);
  assert.equal(b.spend_cents, 1133);
  assert.equal(b.tiktok, null);
  assert.equal(b.ours.people, 2);
  assert.deepEqual(b.reasons, [{ code: "not_purchases", goal: "clicks" }]);
  // The same clip ran in both campaigns.
  const hookAds = views.flatMap((v) => v.ads).filter((x) => x.creative?.clip_id === "fake-clip-flirt-hook-v1").map((x) => x.creative?.campaign_id);
  assert.deepEqual(hookAds.sort(), [...FAKE_STATS_CAMPAIGNS].sort());
  const types = byAdType(views.filter((v) => v.kind === "campaign").flatMap((v) => v.ads));
  assert.deepEqual(types.map((t) => t.format), ["hook_ad", "narration_trailer"]);
  assert.equal(types.reduce((x, t) => x + (t.spend_cents ?? 0), 0), 1818 + 1133);
  assert.equal(types.find((t) => t.format === "narration_trailer")?.buyers, 3, "w5ee3r and t8wd1c (ad 2), q2nn7e (ad 3)");
});

test("ad spend over a period and per day from TikTok's days; revenue per dollar", () => {
  const f = fake();
  const { runs, days } = fakeStatsLaunches(NOW);
  const spends = adSpendsFromRuns(runs);
  assert.deepEqual(spendIn(spends, undefined), { cents: 1818 + 1133, partial: false });
  const week: AdPeriod = { ...rangeDays(f, "7d"), timezone: f.timezone, days };
  assert.equal(spendIn(spends, week).cents, 1818 + 1133);
  const today: AdPeriod = { ...rangeDays(f, "today"), timezone: f.timezone, days };
  assert.ok((spendIn(spends, today).cents ?? 0) < 1818 + 1133);
  const perDay = dailySpend(spends, days, rangeDays(f, "7d"));
  assert.equal(perDay.length, 7);
  assert.equal(perDay.reduce((x, d) => x + (d.cents ?? 0), 0), 1818 + 1133);
  assert.equal(perDay[0].cents, 0, "a covered day with no spend spent nothing");
  assert.ok(dailySpend(spends, { ok: false, error: "x" }, rangeDays(f, "7d")).every((d) => d.cents === null));
  assert.ok(dailySpend(spends, days, { from: "2026-01-01", to: "2026-01-02" }).every((d) => d.cents === null), "before the read");
  assert.equal(returnOnSpend(1000, 2000), 0.5);
  assert.equal(returnOnSpend(1000, 0), null);
  assert.equal(fmtRatio(0.5), "0.50×");
  assert.equal(fmtRatio(null), "–");
});

// ---- series ------------------------------------------------------------------------------------------------------

test("the episode curve runs to the last episode, marks the paywall and flags the biggest drops", () => {
  const f = fake();
  const s = f.series.find((x) => x.drama_id === "d1")!;
  const curve = episodeCurve(s, rangeDays(f, "7d"), f.journeys);
  assert.equal(curve.points.length, s.episode_count);
  assert.equal(curve.points[0].share, 1);
  assert.deepEqual(curve.paywall, { n: 6, from: "free_episodes" });
  assert.ok(curve.drops.length > 0 && curve.drops.length <= 3);
  assert.ok(curve.drops.some((d) => d.n === 6), "the paywall is among the biggest drops");
  assert.ok(curve.drops.every((d, i) => i === 0 || curve.drops[i - 1].lost >= d.lost));
  // Without a free-episode count, the paywall is where buyers' paywall steps gather.
  assert.deepEqual(paywallEpisode({ ...s, free_episodes: 0 }, f.journeys), { n: 6, from: "journeys" });
  assert.equal(paywallEpisode({ ...s, free_episodes: 0 }, {}), null);
  assert.deepEqual(biggestEpisodeDrops([{ n: 1, people: 100, share: 1 }, { n: 2, people: 40, share: 0.4 }, { n: 3, people: 35, share: 0.35 }], 1), [{ n: 2, lost: 60, share_lost: 0.6 }]);
});

test("the series funnel: page to paying, paywall to paid, revenue per buyer; old tab addresses land on their successor", () => {
  const f = fake();
  const t = sumRows(dashRows(f, rangeDays(f, "7d"), { ...NO_FILTER, series: "d1" }));
  const fun = seriesFunnel(t);
  assert.deepEqual(fun.steps.map((s) => s.key), ["opened", "started", "finished", "paywall", "checkout", "paid"]);
  assert.equal(fun.steps[0].of_opened, 1);
  assert.equal(fun.paywall_to_paid, t.paywall ? t.buyers / t.paywall : null);
  assert.equal(fun.revenue_per_buyer_cents, t.buyers ? Math.round(t.revenue_cents / t.buyers) : null);
  assert.equal(parseDashTab("funnel"), "overview");
  assert.equal(parseDashTab("ads"), "campaigns");
  assert.equal(parseDashTab("audience"), "overview");
  assert.equal(parseDashTab("buyers"), "buyers");
});
