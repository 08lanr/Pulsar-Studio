// A title per ad, ad-level stats and stats by title (Ruobin, 2026-09-24).
// Each pasted Spark code row names the title it promotes (default: the
// launch's; a picked clip's otherwise), the server writes that title's own
// crazydramas link on it, the gate checks every title and clip, the driver
// sends each ad its own landing_page_url; the monitor reads every ad's own
// numbers (failing soft), and the results by title add them up. Fixture mode
// only: nothing leaves the process.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession } from "@/lib/auth";
import { FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { getData } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture } from "@/lib/data/launch";
import { ingestEpisodeFile } from "@/lib/ingest";
import { buildLaunchPlan, defaultLaunchDraft, INSTANT_PAGE_ONE_TITLE } from "@/lib/launch/plan";
import { tiktokLaunchGate } from "@/lib/launch/tiktok-gate";
import { resultsByTitle, titleResults } from "@/lib/launch/title-stats";
import type { DeliverySnapshot, DriverContext, LaunchCampaign, LaunchConnection, LaunchDraft, LaunchRun } from "@/lib/launch/types";
import { adStatsByAd, adStatsFromRows } from "@/lib/tiktok/ad-stats";
import { crazydramasAdUrl } from "@/lib/tiktok/ad-url";
import { fakeTikTokSnapshot, fakeTransport, resetFakeTikTok } from "@/lib/tiktok/fake";
import { defaultLaunchSettings, defaultSalesLaunchSettings } from "@/lib/tiktok/settings";
import { tiktokSparkDriver } from "@/lib/tiktok/spark-driver";
import { readFileSync } from "node:fs";
import path from "node:path";
import { launchTitle } from "./launch-title";
import { seedRenderedClips } from "./seed-minute";

const originalGet = fakeTransport.get;
beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  delete process.env.TIKTOK_LIVE; delete process.env.TIKTOK_FAKE_PIXEL; delete process.env.TIKTOK_PIXEL_CODE;
  resetFixtureStore(); resetLaunchFixture(); resetFakeTikTok();
});
afterEach(() => { fakeTransport.get = originalGet; resetFakeTikTok(); });

const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");
const A_LINK = crazydramasAdUrl(FAKE_SLUGS.complete);
const B_LINK = crazydramasAdUrl(FAKE_SLUGS.partial);

async function account(): Promise<LaunchConnection> {
  return getData().assignLaunchConnection(staff(), {
    producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: "7000000000000000001", name: "TikTok 1",
    currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true,
  });
}
function draftOf(titleId: string, accountId: string, content: LaunchDraft["content"], settings = defaultLaunchSettings()): LaunchDraft {
  return { ...defaultLaunchDraft("tiktok"), name: "Two titles", account_ids: [accountId], content_per_campaign: content.length, allocation: "shared",
    content, title_id: titleId, destination_url: "", total_budget_cents: 20000, daily_budget_cents: 3000,
    tiktok_settings: { ...settings, budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 30, start_paused: true } };
}
/** A live title with one episode and `n` finished clips, so a Spark row can name the clip it was made from. */
async function titleWithClips(slug: string, n = 1) {
  const title = await launchTitle(slug);
  const ingest = ingestEpisodeFile(new Uint8Array(readFileSync(path.join(process.cwd(), "docs", "demo", "xiangyuan-ep1.srt"))), "xiangyuan-ep1.srt");
  const episode = await fixtureData.addEpisodeFromIngest(staff(), title.id, 1, ingest, { subtitlePath: null, videoPath: null });
  const clips = await seedRenderedClips(title.id, episode.id, n);
  return { title, clips };
}
function contextOf(run: LaunchRun, campaign: LaunchCampaign): DriverContext {
  return { run, campaign, connection: run.connections![0],
    checkpoint: async (patch) => { campaign.state = { ...campaign.state, ...structuredClone(patch) }; }, assertActive: async () => {} };
}

// ---- save, gate, plan, driver ------------------------------------------------------------------------------

test("save gives every Spark code row its own title and link: a row with none takes the launch's, a sent link is ignored", async () => {
  const one = await account();
  const a = await launchTitle(FAKE_SLUGS.complete);
  const b = await launchTitle(FAKE_SLUGS.partial);
  const sent = draftOf(a.id, one.id, [
    { kind: "spark", value: "code-a", landing_url: "https://evil.example/steal" } as LaunchDraft["content"][number],
    { kind: "spark", value: "code-b", title_id: b.id },
  ]);
  const saved = await getData().saveLaunchDraft(producer(), sent);
  assert.equal(saved.draft.destination_url, A_LINK, "the launch's title decides the campaign's link");
  assert.deepEqual(saved.draft.content.map((c) => [c.value, c.title_id, c.landing_url]), [["code-a", a.id, A_LINK], ["code-b", b.id, B_LINK]]);
  const preview = await getData().previewLaunchRun(producer(), saved.id);
  assert.deepEqual(preview.rows[0].content.map((c) => c.landing_url), [A_LINK, B_LINK], "the plan carries each ad's own link");
  const approved = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  assert.deepEqual(approved.campaigns[0].content.map((c) => c.title_id), [a.id, b.id]);
  // The driver sends each ad its own title's link, macros literal.
  await tiktokSparkDriver.launch(contextOf(approved, approved.campaigns[0]));
  const ads = fakeTikTokSnapshot().ads;
  assert.equal(ads.length, 2);
  assert.deepEqual(new Set(ads.map((ad) => ad.body.landing_page_url)), new Set([A_LINK, B_LINK]));
});

test("preview checks every title an ad names: not live is refused in words, another company's title is not found", async () => {
  const one = await account();
  const a = await launchTitle(FAKE_SLUGS.complete);
  const draftTitle = await launchTitle(FAKE_SLUGS.draft);
  const notLive = await getData().saveLaunchDraft(producer(), draftOf(a.id, one.id, [{ kind: "spark", value: "code-a" }, { kind: "spark", value: "code-b", title_id: draftTitle.id }]));
  await assert.rejects(getData().previewLaunchRun(producer(), notLive.id), /is not live on crazydramas\.com/);
  const other = await getData().createProducer(staff(), { name_zh: "别家", name_en: "Other" });
  const foreign = await launchTitle(FAKE_SLUGS.partial, other.id);
  const stranger = await getData().saveLaunchDraft(producer(), draftOf(a.id, one.id, [{ kind: "spark", value: "code-a", title_id: foreign.id }]));
  assert.equal(stranger.draft.content[0].landing_url, undefined, "no link is written for a title this company cannot see");
  await assert.rejects(getData().previewLaunchRun(producer(), stranger.id), (e: unknown) => (e as { code?: string }).code === "not_found");
});

test("a Sales Instant Page has one button link: an ad on another title is refused before anything else", async () => {
  const one = await account();
  const a = await launchTitle(FAKE_SLUGS.complete);
  const b = await launchTitle(FAKE_SLUGS.partial);
  const mixed = await getData().saveLaunchDraft(producer(), draftOf(a.id, one.id, [{ kind: "spark", value: "code-a" }, { kind: "spark", value: "code-b", title_id: b.id }], defaultSalesLaunchSettings()));
  await assert.rejects(getData().previewLaunchRun(producer(), mixed.id), /Ad 2 promotes .* but a Sales Instant Page has one button link/);
  // The planner refuses it on its own too, should a draft ever reach it.
  assert.throws(() => buildLaunchPlan(mixed.draft, [one], mixed.external_id), (e: unknown) => (e as Error).message === INSTANT_PAGE_ONE_TITLE);
});

test("a picked clip gives its row the clip's title; a clip of another title is refused in plain words", async () => {
  const one = await account();
  const a = await titleWithClips(FAKE_SLUGS.complete);
  const b = await titleWithClips(FAKE_SLUGS.partial);
  // No title on the row: the clip's title and link.
  const fromClip = await getData().saveLaunchDraft(producer(), draftOf(a.title.id, one.id, [{ kind: "spark", value: "code-b", clip_id: b.clips[0].id }]));
  assert.equal(fromClip.draft.content[0].title_id, b.title.id);
  assert.equal(fromClip.draft.content[0].landing_url, B_LINK);
  await getData().previewLaunchRun(producer(), fromClip.id);
  // The row names one title, the clip is from another: refused, naming both.
  const mismatch = await getData().saveLaunchDraft(producer(), draftOf(a.title.id, one.id, [{ kind: "spark", value: "code-b", clip_id: b.clips[0].id, title_id: a.title.id }]));
  await assert.rejects(getData().previewLaunchRun(producer(), mismatch.id), /Ad 1 is made from a clip of .*, but it is set to promote .*\. Set the ad's title to .*, or clear its clip\./);
});

test("content saved before per-ad titles (no title, no link) still passes the gate on the launch's title", async () => {
  const one = await account();
  const a = await launchTitle(FAKE_SLUGS.complete);
  const draft: LaunchDraft = { ...draftOf(a.id, one.id, [{ kind: "spark", value: "code-a" }]), destination_url: A_LINK };
  assert.equal(await tiktokLaunchGate(producer(), draft, FIXTURE_PRODUCER_ID, [one]), undefined);
  // A stale per-ad link is a changed draft, never sent.
  await assert.rejects(tiktokLaunchGate(producer(), { ...draft, content: [{ kind: "spark", value: "code-a", title_id: a.id, landing_url: B_LINK }] }, FIXTURE_PRODUCER_ID, [one]), /Ad 1's crazydramas link changed/);
});

// ---- ad-level stats ------------------------------------------------------------------------------------------

test("adStatsByAd sums a day-by-day report per ad, recomputes CTR and CPC, lists every ad of ours and nothing else", () => {
  const row = (ad: string, spend: number, impressions: number, clicks: number) => ({ dimensions: { ad_id: ad }, metrics: { spend, impressions, clicks, conversion: 0 } });
  const stats = adStatsByAd(["ad-1", "ad-2"], [row("ad-1", 10, 1000, 20), row("ad-1", 5, 500, 10), row("stranger", 99, 9, 9)]);
  assert.deepEqual(stats.get("ad-1"), { spend_cents: 1500, impressions: 1500, clicks: 30, ctr: 0.02, cpc_cents: 50, conversions: 0 });
  assert.deepEqual(stats.get("ad-2"), { spend_cents: 0, impressions: 0, clicks: 0, ctr: null, cpc_cents: null, conversions: 0 }, "an ad the report does not list delivered nothing yet");
  assert.equal(stats.has("stranger"), false);
  assert.equal(adStatsFromRows([{ dimensions: { ad_id: "x" }, metrics: { spend: 1 } }]).clicks, null, "a missing metric is unknown, never zero");
  const web = adStatsByAd(["ad-1"], [row("ad-1", 10, 1000, 20)], [{ dimensions: { ad_id: "ad-1" }, metrics: { spend: 10, complete_payment: 2, total_complete_payment_rate: 19.98, complete_payment_roas: 2, cost_per_complete_payment: 5, initiate_checkout: 6, cost_per_initiate_checkout: 1.67 } }]);
  assert.equal(web.get("ad-1")!.web!.purchases, 2);
  assert.equal(web.get("ad-1")!.web!.purchase_value_cents, 1998);
});

test("the monitor reads each ad's own numbers and purchases, and a refused ad report fails soft", async () => {
  const one = await account();
  const a = await launchTitle(FAKE_SLUGS.complete);
  const b = await launchTitle(FAKE_SLUGS.partial);
  const saved = await getData().saveLaunchDraft(producer(), { ...draftOf(a.id, one.id, [{ kind: "spark", value: "code-a" }, { kind: "spark", value: "code-b", title_id: b.id }]),
    tiktok_settings: { ...defaultLaunchDraft("tiktok").tiktok_settings, start_paused: true } });
  await getData().previewLaunchRun(producer(), saved.id);
  const approved = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  const ctx = contextOf(approved, approved.campaigns[0]);
  await tiktokSparkDriver.launch(ctx);
  await tiktokSparkDriver.control(ctx, { action: "resume" });
  await tiktokSparkDriver.monitor(ctx);
  const snapshot = await tiktokSparkDriver.monitor(ctx);
  assert.equal(snapshot.ads?.length, 2);
  for (const ad of snapshot.ads!) {
    assert.ok(ad.stats, "every ad has its own numbers");
    assert.equal(typeof ad.stats!.spend_cents, "number");
    assert.equal(typeof ad.stats!.impressions, "number");
    assert.ok(ad.stats!.web, "a Website purchases launch reads each ad's purchases");
  }
  const adSpend = snapshot.ads!.reduce((n, ad) => n + ad.stats!.spend_cents!, 0);
  assert.ok(Math.abs(adSpend - snapshot.spend_cents!) <= 2, `the ads add up to the campaign (${adSpend} vs ${snapshot.spend_cents})`);
  assert.equal(snapshot.ad_stats_error, undefined);
  fakeTransport.get = async (p, token, params) => p === "/report/integrated/get/" && params?.data_level === "AUCTION_AD"
    ? { code: 40002, message: "Invalid data_level" } : originalGet(p, token, params);
  const soft = await tiktokSparkDriver.monitor(ctx);
  assert.match(soft.ad_stats_error ?? "", /Invalid data_level/);
  assert.equal(soft.ads?.every((ad) => !ad.stats), true);
  assert.equal(soft.spend_cents, snapshot.spend_cents, "the campaign's numbers survive");
  assert.equal(soft.delivery, snapshot.delivery);
});

// ---- stats by title ------------------------------------------------------------------------------------------

function campaignOf(index: number, content: LaunchCampaign["content"], snapshot: Partial<DeliverySnapshot> | null): LaunchCampaign {
  return { id: `c-${index}`, run_id: "r", index, connection_id: "x", advertiser_id: "1", name: `c${index}`, content, budget_cents: 1000, daily_budget_cents: null,
    status: "done", state: {}, error: null,
    snapshot: snapshot ? { delivery: "live", note: null, checked_at: `2026-09-2${index}T00:00:00.000Z`, spend_cents: null, impressions: null, clicks: null, conversions: null, cpc_cents: null, ...snapshot } : null };
}
function runOf(id: string, titleId: string | null, campaigns: LaunchCampaign[], provider: "tiktok" | "meta" = "tiktok"): LaunchRun {
  return { id, external_id: `lr_${id.padStart(12, "0")}`, producer_id: FIXTURE_PRODUCER_ID, round: 1, parent_run_id: null, status: "done", revision: 1,
    snapshot_hash: null, approved_by: null, approved_at: null, approval_note: null, created_by: "u", created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z",
    mode: "fake", error: null, lease_owner: null, lease_until: null, campaigns,
    draft: { ...defaultLaunchDraft(provider), title_id: titleId, content: campaigns.flatMap((c) => c.content) } };
}
const web = (purchases: number, valueCents: number) => ({ purchases, purchase_value_cents: valueCents, cost_per_purchase_cents: null, roas: null, checkouts: purchases * 3, cost_per_checkout_cents: null, event: "SHOPPING", attribution: "7-day click" });

test("results by title: whole campaigns count whole, mixed ones by their ads, unread mixed ones are counted not added", () => {
  const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
  const whole = campaignOf(1, [{ kind: "spark", value: "a1" }], { spend_cents: 10000, impressions: 50000, clicks: 500, web: web(10, 9990) });
  const mixed = campaignOf(2, [{ kind: "spark", value: "a2", title_id: A }, { kind: "spark", value: "b2", title_id: B }], {
    spend_cents: 6000, impressions: 30000, clicks: 300,
    ads: [
      { id: "ad-a2", status: "approved", content_value: "a2", stats: { spend_cents: 2000, impressions: 10000, clicks: 100, ctr: 0.01, cpc_cents: 20, conversions: 0, web: { purchases: 2, purchase_value_cents: 1998, cost_per_purchase_cents: 1000, roas: 1, checkouts: 6, cost_per_checkout_cents: 333 } } },
      { id: "ad-a2-copy", status: "approved", content_value: "a2", stats: { spend_cents: 1000, impressions: 5000, clicks: 50, ctr: 0.01, cpc_cents: 20, conversions: 0, web: { purchases: 1, purchase_value_cents: 999, cost_per_purchase_cents: 1000, roas: 1, checkouts: 3, cost_per_checkout_cents: 333 } } },
      { id: "ad-b2", status: "approved", content_value: "b2", stats: { spend_cents: 3000, impressions: 15000, clicks: 150, ctr: 0.01, cpc_cents: 20, conversions: 0, web: null } },
    ] });
  const unread = campaignOf(3, [{ kind: "spark", value: "a3", title_id: A }, { kind: "spark", value: "b3", title_id: B }], { spend_cents: 4000 });
  const traffic = campaignOf(4, [{ kind: "spark", value: "a4" }], { spend_cents: 5000, impressions: 10000, clicks: 100 });
  const runs = [runOf("1", A, [whole, mixed, unread]), runOf("2", A, [traffic]), runOf("3", A, [])];
  const r = titleResults(runs, A);
  assert.equal(r.launches, 2, "a draft adds nothing");
  assert.equal(r.campaigns.length, 4);
  assert.equal(r.ads, 4, "one ad in each of the four campaigns promotes A");
  assert.equal(r.unattributed, 1);
  assert.equal(r.totals.spend_cents, 10000 + 3000 + 5000, "whole + A's ads in the mixed one + traffic; the unread mixed one is not added");
  assert.equal(r.totals.clicks, 500 + 150 + 100);
  assert.equal(r.totals.purchases, 13);
  assert.equal(r.totals.value_cents, 9990 + 2997);
  assert.equal(r.totals.web_spend_cents, 13000, "ROAS divides by the spend that read purchases, never the Traffic campaign's");
  assert.equal(r.totals.roas, Math.round(((9990 + 2997) / 13000) * 100) / 100);
  assert.equal(r.totals.cost_per_purchase_cents, Math.round(13000 / 13));
  assert.equal(r.totals.ctr, 750 / (50000 + 15000 + 10000));
  const mixedA = r.campaigns.find((c) => c.campaign.id === "c-2")!;
  assert.equal(mixedA.whole, false);
  assert.equal(mixedA.ads[0].totals!.spend_cents, 3000, "an ad's numbers include its copies");
  const rb = titleResults(runs, B);
  assert.equal(rb.totals.spend_cents, 3000);
  assert.equal(rb.totals.purchases, null, "B's ad read no purchases: unknown, not zero");
  const list = resultsByTitle(runs);
  assert.deepEqual(list.map((x) => x.title_id), [A, B], "most spend first");
});

test("a Spark code TikTok never made into an ad counts as observed zero once the ad report read the others; Meta's mixed campaigns get their own note", () => {
  const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
  // Two A codes and one B code; TikTok refused "a-skipped" for good when the ads were made, so it has no ad.
  const mixed = campaignOf(1, [{ kind: "spark", value: "a1", title_id: A }, { kind: "spark", value: "a-skipped", title_id: A }, { kind: "spark", value: "b1", title_id: B }], {
    spend_cents: 5000, impressions: 20000, clicks: 200, web: web(3, 2997),
    ads: [
      { id: "ad-a1", status: "approved", content_value: "a1", stats: { spend_cents: 2000, impressions: 8000, clicks: 80, ctr: 0.01, cpc_cents: 25, conversions: 0, web: { purchases: 1, purchase_value_cents: 999, cost_per_purchase_cents: 2000, roas: 0.5, checkouts: 4, cost_per_checkout_cents: 500 } } },
      { id: "ad-b1", status: "approved", content_value: "b1", stats: { spend_cents: 3000, impressions: 12000, clicks: 120, ctr: 0.01, cpc_cents: 25, conversions: 0, web: { purchases: 2, purchase_value_cents: 1998, cost_per_purchase_cents: 1500, roas: 0.67, checkouts: 6, cost_per_checkout_cents: 500 } } },
    ] });
  const r = titleResults([runOf("1", A, [mixed])], A);
  assert.equal(r.unattributed, 0, "the skipped code no longer keeps the campaign 'not added in' for good");
  assert.equal(r.totals.spend_cents, 2000);
  assert.equal(r.totals.purchases, 1);
  assert.equal(r.totals.checkouts, 4);
  assert.equal(r.totals.cost_per_checkout_cents, 500, "cost per checkout: spend that read purchases ÷ checkouts");
  const skipped = r.campaigns[0].ads.find((ad) => ad.item.value === "a-skipped")!;
  assert.equal(skipped.totals!.spend_cents, 0, "observed zero");
  assert.equal(skipped.totals!.purchases, 0, "zero purchases on a campaign that reads purchases");

  // The per-ad report failed: the skipped code is unknown again, and the campaign waits for a Refresh.
  const failed = campaignOf(2, mixed.content, { ...mixed.snapshot!, ad_stats_error: "Invalid data_level", ads: mixed.snapshot!.ads!.map(({ stats: _s, ...ad }) => ad) });
  assert.equal(titleResults([runOf("1", A, [failed])], A).unattributed, 1);

  // Meta reports no ad separately: a Meta campaign with two titles is counted under its own note, never "TikTok has not reported yet".
  const meta = campaignOf(3, [{ kind: "video", value: "clip-a", title_id: A }, { kind: "facebook_post", value: "123_456", title_id: B }], { spend_cents: 4000, ads: [{ id: "m1", status: "active" }, { id: "m2", status: "active" }] });
  const rm = titleResults([runOf("m", null, [meta], "meta")], A);
  assert.equal(rm.unattributed, 0);
  assert.equal(rm.unattributed_meta, 1);
  assert.equal(rm.totals.spend_cents, null);
});

test("a refused per-ad purchases read leaves the ads their delivery numbers and says only that", async () => {
  const one = await account();
  const a = await launchTitle(FAKE_SLUGS.complete);
  const b = await launchTitle(FAKE_SLUGS.partial);
  const saved = await getData().saveLaunchDraft(producer(), { ...draftOf(a.id, one.id, [{ kind: "spark", value: "code-a" }, { kind: "spark", value: "code-b", title_id: b.id }]),
    tiktok_settings: { ...defaultLaunchDraft("tiktok").tiktok_settings, start_paused: true } });
  await getData().previewLaunchRun(producer(), saved.id);
  const approved = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  const ctx = contextOf(approved, approved.campaigns[0]);
  await tiktokSparkDriver.launch(ctx);
  await tiktokSparkDriver.control(ctx, { action: "resume" });
  await tiktokSparkDriver.monitor(ctx);
  fakeTransport.get = async (p, token, params) => p === "/report/integrated/get/" && params?.data_level === "AUCTION_AD" && String(params?.metrics ?? "").includes("complete_payment")
    ? { code: 40001, message: "No permission to read complete_payment" } : originalGet(p, token, params);
  const soft = await tiktokSparkDriver.monitor(ctx);
  assert.equal(soft.ad_stats_error, undefined, "the delivery read worked");
  assert.match(soft.ad_web_error ?? "", /complete_payment/);
  assert.equal(soft.ads?.every((ad) => ad.stats && typeof ad.stats.spend_cents === "number"), true, "each ad keeps its own numbers");
});
