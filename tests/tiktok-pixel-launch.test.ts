// TikTok launch: the crazydramas link contract, the pixel and one account
// (decision 2026-09-23). The link every TikTok website ad carries, the three
// ad group shapes, the pixel refusals before anything is written, the fake's
// documented pixel rules, the TikTok-attributed monitor numbers and the
// default account. Fixture mode only: nothing leaves the process.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession } from "@/lib/auth";
import { FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { launchHash, resetLaunchFixture } from "@/lib/data/launch";
import { defaultLaunchConnectionId } from "@/lib/launch/account-authority";
import { metaDestination, startingDraft } from "@/lib/launch/draft-defaults";
import { buildLaunchPlan, defaultLaunchDraft, trackingUrlForCampaign } from "@/lib/launch/plan";
import type { DriverContext, LaunchCampaign, LaunchConnection, LaunchDraft, LaunchRun, LaunchWorkspace } from "@/lib/launch/types";
import { crazydramasAdUrl, crazydramasSlugProblem, isCrazydramasAdUrl, slugOfCrazydramasAdUrl, TIKTOK_AD_QUERY } from "@/lib/tiktok/ad-url";
import { FAKE_PIXEL_ID, fakeTikTokSnapshot, fakeTransport, resetFakeTikTok } from "@/lib/tiktok/fake";
import { CRAZYDRAMAS_PIXEL_CODE, pixelFromList, resolvePixel, tiktokPixelCode } from "@/lib/tiktok/pixel";
import { probePixel } from "@/lib/tiktok/preflight";
import { adGroupBody, defaultLaunchSettings, defaultSalesLaunchSettings, defaultTikTokLaunchSettings, defaultWebsitePurchaseSettings, launchShape, LaunchSettingsError, planAdGroup, validateLaunchSettings, type LaunchSettings } from "@/lib/tiktok/settings";
import { tiktokSparkDriver } from "@/lib/tiktok/spark-driver";
import { webConversionsFromReport } from "@/lib/tiktok/web-metrics";
import { launchTitle, LIVE_AD_URL } from "./launch-title";

const EXACT = "https://crazydramas.com/watch/forced-to-marry-the-mafia-boss?source=tiktok&campaign=__CAMPAIGN_ID__&adgroup=__AID__&creative=__CID__";
const env = { TIKTOK_FAKE_PIXEL: process.env.TIKTOK_FAKE_PIXEL, TIKTOK_PIXEL_CODE: process.env.TIKTOK_PIXEL_CODE, TIKTOK_DEFAULT_ADVERTISER_ID: process.env.TIKTOK_DEFAULT_ADVERTISER_ID };
const originalGet = fakeTransport.get;
const originalPost = fakeTransport.post;
beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  delete process.env.TIKTOK_LIVE; delete process.env.TIKTOK_FAKE_PIXEL; delete process.env.TIKTOK_PIXEL_CODE; delete process.env.TIKTOK_DEFAULT_ADVERTISER_ID;
  resetFixtureStore(); resetLaunchFixture(); resetFakeTikTok();
});
afterEach(() => {
  fakeTransport.get = originalGet; fakeTransport.post = originalPost;
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  resetFakeTikTok();
});

// ---- the link ---------------------------------------------------------------------------------------------

test("crazydramasAdUrl is exactly the contract: the slug, source=tiktok and TikTok's three macros, literal and unencoded", () => {
  assert.equal(crazydramasAdUrl("forced-to-marry-the-mafia-boss"), EXACT);
  assert.equal(TIKTOK_AD_QUERY, "source=tiktok&campaign=__CAMPAIGN_ID__&adgroup=__AID__&creative=__CID__");
  const url = crazydramasAdUrl("forced-to-marry-the-mafia-boss");
  assert.ok(!/%5F|%5f/.test(url), "underscores are never percent-encoded");
  assert.ok(!url.includes("campid"), "nothing else is appended");
  assert.equal(slugOfCrazydramasAdUrl(url), "forced-to-marry-the-mafia-boss");
  assert.equal(isCrazydramasAdUrl(`${url}&campid=x`), false, "one appended byte is not the contract");
  assert.equal(isCrazydramasAdUrl(url.replace("__AID__", "%5F%5FAID%5F%5F")), false);
  assert.equal(isCrazydramasAdUrl("https://crazydramas.com/watch/forced-to-marry-the-mafia-boss"), false);
  assert.equal(isCrazydramasAdUrl("https://crazydramas.com"), false);
});

test("slug guards refuse a missing, mock or malformed slug", () => {
  for (const slug of ["", "   "]) { assert.equal(crazydramasSlugProblem(slug), "missing"); assert.throws(() => crazydramasAdUrl(slug), /no crazydramas slug/); }
  assert.equal(crazydramasSlugProblem("mock-billionaire"), "mock");
  assert.throws(() => crazydramasAdUrl("mock-billionaire"), /design mock/);
  for (const slug of ["Forced-To-Marry", "two  words", "a--b", "-lead", "trail-", "slug?x=1", "slug/ep"]) {
    assert.equal(crazydramasSlugProblem(slug), "shape", slug);
    assert.throws(() => crazydramasAdUrl(slug), /not a crazydramas slug/);
  }
  assert.equal(crazydramasSlugProblem("mocking-bird"), null, "only the mock- prefix is a mock");
});

test("the tracking link: a TikTok website ad carries the link verbatim, an Instant Page adds its campid, Meta keeps its campid", () => {
  assert.equal(trackingUrlForCampaign(EXACT, "summer-001", { provider: "tiktok", shape: "website_purchases" }), EXACT);
  assert.equal(trackingUrlForCampaign(EXACT, "summer-001", { provider: "tiktok", shape: "traffic" }), EXACT);
  assert.equal(trackingUrlForCampaign(EXACT, "summer-001", { provider: "tiktok", shape: "instant_page" }), `${EXACT}&campid=summer-001`);
  assert.equal(trackingUrlForCampaign("https://crazydramas.com/watch/x", "rlapple01", { provider: "meta" }), "https://crazydramas.com/watch/x?campid=rlapple01");
});

test("the planner refuses a TikTok destination that is not the title's crazydramas ad link", () => {
  const draft: LaunchDraft = { ...defaultLaunchDraft("tiktok"), account_ids: ["one"], content_per_campaign: 1, content: [{ kind: "spark", value: "code-1" }], destination_url: "https://crazydramas.com" };
  const one: LaunchConnection = { id: "one", producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: "7000000000000000001", name: "One", currency: "USD", timezone: "", page_id: null, instagram_id: null, business_id: null, assigned_by: "staff", verified_at: "", enabled: true };
  assert.throws(() => buildLaunchPlan(draft, [one], "lr_0123456789ab"), /crazydramas page/);
  const plan = buildLaunchPlan({ ...draft, destination_url: EXACT }, [one], "lr_0123456789ab");
  assert.equal(plan.rows[0].tracking_url, EXACT);
  assert.ok(plan.rows[0].campid);
});

// ---- the three ad group shapes ------------------------------------------------------------------------

const plan = (s: LaunchSettings) => planAdGroup(validateLaunchSettings(s, 500), 500, new Date("2026-09-23T00:00:00Z"));

test("adGroupBody: Traffic sends clicks to the website with no pixel and no Instant Page", () => {
  const s = validateLaunchSettings(defaultLaunchSettings(), 500);
  const body = adGroupBody(s, plan(s));
  assert.equal(launchShape(s), "traffic");
  assert.equal(body.promotion_type, "WEBSITE");
  assert.equal(body.promotion_website_type, undefined);
  assert.equal(body.optimization_goal, "CLICK");
  assert.equal(body.billing_event, "CPC");
  for (const key of ["pixel_id", "optimization_event", "click_attribution_window", "view_attribution_window", "attribution_event_count"]) assert.equal(body[key], undefined, key);
});

test("adGroupBody: the Sales Instant Page stays TIKTOK_NATIVE_PAGE with the BUTTON event and never a pixel", () => {
  const s = validateLaunchSettings(defaultSalesLaunchSettings(), 500);
  const body = adGroupBody(s, plan(s));
  assert.equal(launchShape(s), "instant_page");
  assert.equal(body.promotion_website_type, "TIKTOK_NATIVE_PAGE");
  assert.equal(body.optimization_goal, "CONVERT");
  assert.equal(body.billing_event, "OCPM");
  assert.equal(body.optimization_event, "BUTTON");
  assert.equal(body.pixel_id, undefined);
  assert.equal(body.conversion_bid_price, 0.2);
});

test("adGroupBody: Website purchases optimizes the pixel's Purchase event with 7-day click / 1-day view sent explicitly", () => {
  const s = validateLaunchSettings({ ...defaultWebsitePurchaseSettings(), pixel_code: CRAZYDRAMAS_PIXEL_CODE }, 500);
  assert.equal(launchShape(s), "website_purchases");
  assert.throws(() => adGroupBody(s, plan(s)), LaunchSettingsError, "no body without the resolved pixel id");
  const body = adGroupBody(s, plan(s), { pixel_id: "1790000000000000001" });
  assert.equal(body.promotion_type, "WEBSITE");
  assert.equal(body.promotion_website_type, undefined, "UNSET: a native page refuses pixel_id");
  assert.equal(body.optimization_goal, "CONVERT");
  assert.equal(body.billing_event, "OCPM");
  assert.equal(body.pixel_id, "1790000000000000001");
  assert.equal(body.optimization_event, "SHOPPING");
  assert.equal(body.click_attribution_window, "SEVEN_DAYS");
  assert.equal(body.view_attribution_window, "ONE_DAY");
  assert.equal(body.attribution_event_count, "EVERY");
  assert.equal(body.bid_type, "BID_TYPE_NO_BID");
  assert.equal(body.budget_mode, "BUDGET_MODE_DAY");
  assert.equal(body.budget, 30);
  // InitiateCheckout is the selectable fallback; a checkout counts once per person.
  const checkout = validateLaunchSettings({ ...defaultWebsitePurchaseSettings(), optimization_event: "INITIATE_ORDER", attribution: undefined }, 500);
  const fallback = adGroupBody(checkout, plan(checkout), { pixel_id: "1790000000000000001" });
  assert.equal(fallback.optimization_event, "INITIATE_ORDER");
  assert.equal(fallback.attribution_event_count, "ONCE");
});

test("validation keeps the shapes apart: a website launch takes no Instant Page, a Traffic launch sheds every pixel field", () => {
  assert.throws(() => validateLaunchSettings({ ...defaultWebsitePurchaseSettings(), instant_page_template: defaultSalesLaunchSettings().instant_page_template }, 500), /not to an Instant Page/);
  assert.throws(() => validateLaunchSettings({ ...defaultWebsitePurchaseSettings(), optimization_goal: "CLICK" }, 500), /pixel event/);
  const traffic = validateLaunchSettings({ ...defaultLaunchSettings(), sales_destination: "website", optimization_event: "SHOPPING", attribution: { click: "SEVEN_DAYS", view: "ONE_DAY", event_count: "EVERY" }, pixel_code: CRAZYDRAMAS_PIXEL_CODE }, 500);
  assert.equal(launchShape(traffic), "traffic");
  for (const key of ["sales_destination", "optimization_event", "attribution", "pixel_code"] as const) assert.equal(traffic[key], undefined, key);
  const page = validateLaunchSettings({ ...defaultSalesLaunchSettings(), pixel_code: CRAZYDRAMAS_PIXEL_CODE }, 500);
  assert.equal(page.pixel_code, undefined);
});

test("a new TikTok draft is Website purchases at $30 a day, with no title chosen yet", () => {
  const draft = defaultLaunchDraft("tiktok");
  assert.equal(launchShape(draft.tiktok_settings), "website_purchases");
  assert.deepEqual(draft.tiktok_settings, { ...defaultTikTokLaunchSettings(), start_paused: true });
  assert.equal(draft.daily_budget_cents, 3000);
  assert.equal(draft.title_id, null);
  assert.equal(draft.destination_url, "");
});

// ---- the pixel ------------------------------------------------------------------------------------------

test("the pixel code defaults to crazydramas.com's and TIKTOK_PIXEL_CODE overrides it", () => {
  assert.equal(tiktokPixelCode(), "DALLBMJC77U250DBQUR0");
  process.env.TIKTOK_PIXEL_CODE = "  OTHERPIXEL123  ";
  assert.equal(tiktokPixelCode(), "OTHERPIXEL123");
  process.env.TIKTOK_PIXEL_CODE = "";
  assert.equal(tiktokPixelCode(), CRAZYDRAMAS_PIXEL_CODE);
});

test("pixel resolution: shared resolves to its id; not listed and UNBOUND both say it isn't shared in Business Center", async () => {
  const code = tiktokPixelCode();
  const ok = await resolvePixel(fakeTransport, "fake-token", "7000000000000000001", code);
  assert.deepEqual(ok.ok && [ok.pixel_id, ok.relation], [FAKE_PIXEL_ID, "SHARED"]);
  process.env.TIKTOK_FAKE_PIXEL = "missing";
  const missing = await resolvePixel(fakeTransport, "fake-token", "7000000000000000001", code);
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.reason, "not_found");
  assert.match(!missing.ok ? missing.message : "", /isn't shared with ad account 7000000000000000001 in Business Center/);
  process.env.TIKTOK_FAKE_PIXEL = "unbound";
  const unbound = await resolvePixel(fakeTransport, "fake-token", "7000000000000000001", code);
  assert.equal(!unbound.ok && unbound.reason, "not_linked");
  assert.match(!unbound.ok ? unbound.message : "", /isn't shared with ad account .* in Business Center \(it was unbound\)/);
  process.env.TIKTOK_FAKE_PIXEL = "unreadable";
  const unreadable = await resolvePixel(fakeTransport, "fake-token", "7000000000000000001", code);
  assert.equal(!unreadable.ok && unreadable.reason, "unreadable");
  assert.match(!unreadable.ok ? unreadable.message : "", /pixel permission/);
  const bad = await resolvePixel(fakeTransport, "fake-token", "7000000000000000001", "not a code");
  assert.equal(!bad.ok && bad.reason, "bad_code");
  // The preflight probe is the same read through the chosen transport (the fake in fixture mode).
  delete process.env.TIKTOK_FAKE_PIXEL;
  const probed = await probePixel("7000000000000000002");
  assert.deepEqual(probed.ok && [probed.code, probed.pixel_id], [CRAZYDRAMAS_PIXEL_CODE, FAKE_PIXEL_ID]);
});

test("pixelFromList reads the ownership the docs name: owned and transferred pixels are usable", () => {
  const row = (status: string | null) => ({ pixel_id: "42", pixel_code: "CODE12345", asset_ownership: status === null ? { ownership_status: true } : { asset_relation_status: status } });
  assert.deepEqual(pixelFromList([row(null)], "CODE12345", "1"), { ok: true, code: "CODE12345", pixel_id: "42", relation: "OWNED", name: null });
  assert.equal((pixelFromList([row("TRANSFERRED")], "CODE12345", "1") as { relation: string }).relation, "TRANSFERRED");
  assert.equal(pixelFromList([row("UNBOUND")], "CODE12345", "1").ok, false);
  assert.equal(pixelFromList([row("SHARED")], "OTHERCODE1", "1").ok, false, "another pixel's code is not ours");
});

// ---- the fake enforces the documented rules ---------------------------------------------------------------

async function fakeCampaign(objective: string): Promise<string> {
  const res = await fakeTransport.post("/campaign/create/", "t", { advertiser_id: "7000000000000000001", campaign_name: `rules-${objective}-${Math.random()}`, objective_type: objective, budget_mode: "BUDGET_MODE_INFINITE", operation_status: "DISABLE" });
  return String(res.data?.campaign_id);
}
const groupBase = { advertiser_id: "7000000000000000001", budget_mode: "BUDGET_MODE_DAY", budget: 30, schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: "2026-09-24 00:00:00", promotion_type: "WEBSITE", bid_type: "BID_TYPE_NO_BID", operation_status: "DISABLE" };
async function group(campaignId: string, body: Record<string, unknown>) {
  return fakeTransport.post("/adgroup/create/", "t", { ...groupBase, campaign_id: campaignId, adgroup_name: `g-${Math.random()}`, ...body });
}

test("the fake refuses what /adgroup/create/ documents: pixel_id off CONVERT, CONVERT without pixel, pixel on an Instant Page, no event, split windows", async () => {
  const web = await fakeCampaign("WEB_CONVERSIONS");
  const traffic = await fakeCampaign("TRAFFIC");
  const pixel = { pixel_id: FAKE_PIXEL_ID, optimization_event: "SHOPPING", click_attribution_window: "SEVEN_DAYS", view_attribution_window: "ONE_DAY", attribution_event_count: "EVERY" };
  assert.equal((await group(web, { optimization_goal: "CONVERT", billing_event: "OCPM", ...pixel })).code, 0);
  assert.match((await group(traffic, { optimization_goal: "CLICK", billing_event: "CPC", pixel_id: FAKE_PIXEL_ID, optimization_event: "SHOPPING" })).message, /pixel_id is not supported/);
  assert.match((await group(traffic, { optimization_goal: "CONVERT", billing_event: "OCPM", ...pixel })).message, /not supported by objective TRAFFIC/);
  assert.match((await group(web, { optimization_goal: "CONVERT", billing_event: "OCPM" })).message, /pixel_id is required/);
  assert.match((await group(web, { optimization_goal: "CONVERT", billing_event: "OCPM", promotion_website_type: "TIKTOK_NATIVE_PAGE", ...pixel })).message, /TIKTOK_NATIVE_PAGE/);
  assert.equal((await group(web, { optimization_goal: "CONVERT", billing_event: "OCPM", promotion_website_type: "TIKTOK_NATIVE_PAGE", optimization_event: "BUTTON" })).code, 0, "the Instant Page shape still passes");
  assert.match((await group(web, { optimization_goal: "CONVERT", billing_event: "OCPM", pixel_id: FAKE_PIXEL_ID })).message, /optimization_event is required/);
  assert.match((await group(web, { optimization_goal: "CONVERT", billing_event: "CPC", ...pixel })).message, /billing_event must be OCPM/);
  assert.match((await group(web, { optimization_goal: "CONVERT", billing_event: "OCPM", ...pixel, view_attribution_window: undefined })).message, /passed together/);
  assert.match((await group(web, { optimization_goal: "CONVERT", billing_event: "OCPM", ...pixel, click_attribution_window: "THIRTY_DAYS" })).message, /click_attribution_window/);
  assert.match((await group(web, { optimization_goal: "CONVERT", billing_event: "OCPM", ...pixel, pixel_id: "1790000000000000999" })).message, /not available/);
  process.env.TIKTOK_FAKE_PIXEL = "unbound";
  assert.match((await group(web, { optimization_goal: "CONVERT", billing_event: "OCPM", ...pixel })).message, /not available/);
});

// ---- the driver -----------------------------------------------------------------------------------------

function context(settings: LaunchSettings, landing = LIVE_AD_URL): DriverContext {
  const campaign: LaunchCampaign = {
    id: "row-1", run_id: "run-1", index: 1, connection_id: "connection-1", advertiser_id: "7000000000000000001", name: "pixel-a1b2c3d4e5f6-001",
    campid: "pixel-a1b2c3d4e5f6-001", tracking_url: landing,
    content: [{ kind: "spark", value: "good-one" }], budget_cents: 12000, daily_budget_cents: 3000,
    status: "running", state: {}, error: null, snapshot: null,
  };
  const run: LaunchRun = {
    id: "run-1", external_id: "lr_a1b2c3d4e5f6", producer_id: FIXTURE_PRODUCER_ID, round: 1, parent_run_id: null, status: "running", revision: 1,
    snapshot_hash: null, approved_by: "approver-1", approved_at: new Date().toISOString(), approval_note: null,
    created_by: "approver-1", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mode: "fake", error: null,
    campaigns: [campaign], lease_owner: "worker", lease_until: new Date(Date.now() + 60_000).toISOString(),
    draft: { ...defaultLaunchDraft("tiktok"), name: "Pixel launch", account_ids: ["connection-1"], content_per_campaign: 1, content: campaign.content,
      destination_url: landing, total_budget_cents: 12000, daily_budget_cents: 3000, start_paused: true, tiktok_settings: settings },
  };
  run.connections = [{ id: "connection-1", producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: campaign.advertiser_id, name: "TikTok test", currency: "USD", timezone: "", page_id: null, instagram_id: null, business_id: "bc-1", assigned_by: "staff-1", verified_at: "", enabled: true }];
  run.snapshot_hash = launchHash(run.draft, run.connections, run.campaigns);
  return { run, campaign, connection: run.connections[0],
    checkpoint: async (patch) => { campaign.state = { ...campaign.state, ...structuredClone(patch) }; }, assertActive: async () => {} };
}
const website = (): LaunchSettings => ({ ...defaultWebsitePurchaseSettings(), pixel_code: tiktokPixelCode(), start_paused: true });

test("a Website purchases launch resolves the pixel, sends it on the ad group and the exact link on every ad", async () => {
  const ctx = context(website());
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  fakeTransport.post = async (path, token, body) => { writes.push({ path, body: structuredClone(body) }); return originalPost(path, token, body); };
  await tiktokSparkDriver.launch(ctx);
  assert.deepEqual(ctx.campaign.state.pixel, { code: CRAZYDRAMAS_PIXEL_CODE, pixel_id: FAKE_PIXEL_ID });
  const campaign = writes.find((w) => w.path === "/campaign/create/")!.body;
  assert.deepEqual([campaign.objective_type, campaign.virtual_objective_type, campaign.sales_destination], ["WEB_CONVERSIONS", "SALES", "WEBSITE"]);
  const group = writes.find((w) => w.path === "/adgroup/create/")!.body;
  assert.equal(group.pixel_id, FAKE_PIXEL_ID);
  assert.equal(group.optimization_event, "SHOPPING");
  assert.equal(group.promotion_website_type, undefined);
  assert.deepEqual([group.click_attribution_window, group.view_attribution_window, group.attribution_event_count], ["SEVEN_DAYS", "ONE_DAY", "EVERY"]);
  const ads = fakeTikTokSnapshot().ads;
  assert.equal(ads.length, 1);
  assert.equal(ads[0].body.landing_page_url, LIVE_AD_URL, "the macros reach TikTok literally");
  assert.equal(ads[0].body.page_id, undefined);
  assert.equal(writes.some((w) => w.path.startsWith("/page/")), false, "no Instant Page is built");
});

test("the pixel is checked before any TikTok write: not shared, nothing is authorized or created", async () => {
  for (const mode of ["missing", "unbound"]) {
    resetFakeTikTok();
    process.env.TIKTOK_FAKE_PIXEL = mode;
    const ctx = context(website());
    const writes: string[] = [];
    fakeTransport.post = async (path, token, body) => { writes.push(path); return originalPost(path, token, body); };
    await assert.rejects(tiktokSparkDriver.launch(ctx), /isn't shared with ad account 7000000000000000001 in Business Center/);
    assert.deepEqual(writes, [], `${mode}: no Spark authorization, campaign, ad group or ad`);
    assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
  }
});

test("a Website purchases launch refuses a link that is not the crazydramas contract", async () => {
  const ctx = context(website(), "https://crazydramas.com/watch/fixture-film?campid=x");
  await assert.rejects(tiktokSparkDriver.launch(ctx), /no crazydramas ad link/);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
});

test("adopting an existing ad group compares its pixel and event, not only its budget", async () => {
  const ctx = context(website());
  await tiktokSparkDriver.launch(ctx);
  // A crash before the group id was saved, and an approval that now says InitiateCheckout: the group of our name optimizes for Purchase.
  ctx.campaign.state = { ...ctx.campaign.state, groups: [], settings: { ...(ctx.campaign.state.settings as LaunchSettings), optimization_event: "INITIATE_ORDER" } };
  await assert.rejects(tiktokSparkDriver.launch(ctx), /different pixel or event/);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1, "no second group");
});

test("Traffic and the Instant Page still launch as before: the website ad carries the link, the Instant Page ad its page", async () => {
  const traffic = context({ ...defaultLaunchSettings(), start_paused: true, budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 30 });
  await tiktokSparkDriver.launch(traffic);
  assert.equal(fakeTikTokSnapshot().ads[0].body.landing_page_url, LIVE_AD_URL);
  assert.equal(fakeTikTokSnapshot().adgroups[0].body.pixel_id, undefined);
  resetFakeTikTok();
  const page = context({ ...defaultSalesLaunchSettings(), start_paused: true }, `${LIVE_AD_URL}&campid=pixel-a1b2c3d4e5f6-001`);
  await tiktokSparkDriver.launch(page);
  const ad = fakeTikTokSnapshot().ads[0].body;
  assert.match(String(ad.page_id), /^fake-tip-/);
  assert.equal(ad.landing_page_url, undefined);
});

// ---- the monitor ----------------------------------------------------------------------------------------

test("webConversionsFromReport keeps TikTok's ratios for one row, recomputes them for several, and never invents a zero", () => {
  const one = webConversionsFromReport([{ metrics: { spend: "30.00", complete_payment: "3", total_complete_payment_rate: "29.97", cost_per_complete_payment: "10.00", complete_payment_roas: "1.00", initiate_checkout: "9", cost_per_initiate_checkout: "3.33" } }]);
  assert.deepEqual(one, { purchases: 3, purchase_value_cents: 2997, cost_per_purchase_cents: 1000, roas: 1, checkouts: 9, cost_per_checkout_cents: 333 });
  const two = webConversionsFromReport([
    { metrics: { spend: 10, complete_payment: 1, total_complete_payment_rate: 9.99, initiate_checkout: 2 } },
    { metrics: { spend: 30, complete_payment: 3, total_complete_payment_rate: 29.97, initiate_checkout: 6 } },
  ]);
  assert.deepEqual(two, { purchases: 4, purchase_value_cents: 3996, cost_per_purchase_cents: 1000, roas: 1, checkouts: 8, cost_per_checkout_cents: 500 });
  const missing = webConversionsFromReport([{ metrics: { spend: 10, initiate_checkout: 2 } }]);
  assert.equal(missing.purchases, null);
  assert.equal(missing.purchase_value_cents, null);
  assert.equal(missing.cost_per_purchase_cents, null);
  assert.deepEqual(webConversionsFromReport([]), { purchases: 0, purchase_value_cents: 0, cost_per_purchase_cents: null, roas: null, checkouts: 0, cost_per_checkout_cents: null });
});

test("the monitor reads TikTok-attributed purchases for a Website purchases launch and fails soft", async () => {
  const ctx = context(website());
  await tiktokSparkDriver.launch(ctx);
  await tiktokSparkDriver.control(ctx, { action: "resume" });
  await tiktokSparkDriver.monitor(ctx);
  const snapshot = await tiktokSparkDriver.monitor(ctx);
  assert.ok(snapshot.web, "web conversions are read");
  assert.equal(snapshot.web!.event, "SHOPPING");
  assert.equal(snapshot.web!.attribution, "7-day click · 1-day view · every conversion");
  assert.equal(typeof snapshot.web!.purchases, "number");
  assert.equal(snapshot.web_error, undefined);
  fakeTransport.get = async (path, token, params) => path === "/report/integrated/get/" && String(params?.metrics).includes("complete_payment")
    ? { code: 40002, message: "Invalid metric complete_payment" } : originalGet(path, token, params);
  const soft = await tiktokSparkDriver.monitor(ctx);
  assert.equal(soft.web, null);
  assert.match(soft.web_error ?? "", /Invalid metric/);
  assert.equal(soft.delivery, snapshot.delivery, "the delivery state survives");
  assert.equal(soft.spend_cents, snapshot.spend_cents, "the spend survives");
  const traffic = context({ ...defaultLaunchSettings(), start_paused: true });
  resetFakeTikTok();
  await tiktokSparkDriver.launch(traffic);
  assert.equal((await tiktokSparkDriver.monitor(traffic)).web, undefined, "no pixel, no web numbers");
});

// ---- the data layer: title, link and pixel gates; the default account --------------------------------------

const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");
async function tiktokAccounts(count: number): Promise<LaunchConnection[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => getData().assignLaunchConnection(staff(), {
    producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: `700000000000000000${i + 1}`, name: `TikTok ${i + 1}`,
    currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true,
  })));
}
async function websiteDraft(titleId: string | null, accounts: LaunchConnection[]): Promise<LaunchDraft> {
  return { ...defaultLaunchDraft("tiktok"), name: "Pixel launch", account_ids: accounts.map((a) => a.id), content_per_campaign: 1, allocation: "shared",
    content: [{ kind: "spark", value: "good-one" }], title_id: titleId, destination_url: "https://example.com/typed", total_budget_cents: 20000, daily_budget_cents: 3000 };
}

test("save writes the title's ad link and the pixel code; preview resolves the pixel on every account and signs the exact link", async () => {
  const accounts = await tiktokAccounts(2);
  const title = await launchTitle();
  const saved = await getData().saveLaunchDraft(producer(), await websiteDraft(title.id, accounts));
  assert.equal(saved.draft.destination_url, LIVE_AD_URL, "a typed URL never reaches TikTok");
  assert.equal(saved.draft.tiktok_settings.pixel_code, CRAZYDRAMAS_PIXEL_CODE);
  const preview = await getData().previewLaunchRun(producer(), saved.id);
  assert.deepEqual(preview.tiktok_pixel, { code: CRAZYDRAMAS_PIXEL_CODE, event: "Purchase", attribution: "7-day click · 1-day view · every conversion",
    accounts: accounts.map((a) => ({ connection_id: a.id, pixel_id: FAKE_PIXEL_ID })) });
  assert.ok(preview.rows.every((row) => row.tracking_url === LIVE_AD_URL));
  const approved = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  assert.ok(approved.campaigns.every((c) => c.tracking_url === LIVE_AD_URL));
});

test("preview refuses a TikTok draft with no title, a title that is not live, and a pixel the account cannot use", async () => {
  const accounts = await tiktokAccounts(1);
  const none = await getData().saveLaunchDraft(producer(), await websiteDraft(null, accounts));
  await assert.rejects(getData().previewLaunchRun(producer(), none.id), /Choose the title this launch promotes/);
  const draftTitle = await launchTitle(FAKE_SLUGS.draft);
  const notLive = await getData().saveLaunchDraft(producer(), await websiteDraft(draftTitle.id, accounts));
  await assert.rejects(getData().previewLaunchRun(producer(), notLive.id), /is not live on crazydramas\.com/);
  const mock = await launchTitle("mock-billionaire");
  const mocked = await getData().saveLaunchDraft(producer(), await websiteDraft(mock.id, accounts));
  await assert.rejects(getData().previewLaunchRun(producer(), mocked.id), /design mock/);
  const live = await launchTitle();
  const saved = await getData().saveLaunchDraft(producer(), await websiteDraft(live.id, accounts));
  process.env.TIKTOK_FAKE_PIXEL = "missing";
  await assert.rejects(getData().previewLaunchRun(producer(), saved.id), /isn't shared with ad account 7000000000000000001 in Business Center/);
  await assert.rejects(getData().submitLaunchRun(producer(), saved.id, saved.revision), /isn't shared/);
  delete process.env.TIKTOK_FAKE_PIXEL;
  // A pixel setting changed after save is a new approval, never a silent swap.
  process.env.TIKTOK_PIXEL_CODE = "ANOTHERPIXEL01";
  await assert.rejects(getData().submitLaunchRun(producer(), saved.id, saved.revision), /pixel setting changed/);
  // Another company's title is not found.
  const other = await getData().createProducer(staff(), { name_zh: "别家", name_en: "Other" });
  const foreign = await launchTitle(undefined, other.id);
  delete process.env.TIKTOK_PIXEL_CODE;
  const stranger = await getData().saveLaunchDraft(producer(), await websiteDraft(foreign.id, accounts));
  await assert.rejects(getData().previewLaunchRun(producer(), stranger.id), (e: unknown) => (e as { code?: string }).code === "not_found");
});

test("the default account: the operator's when the company reaches it, else the preferred, else the only one", async () => {
  const conn = (id: string, advertiser: string): LaunchConnection => ({ id, producer_id: "p", provider: "tiktok", advertiser_id: advertiser, name: id, currency: "USD", timezone: "", page_id: null, instagram_id: null, business_id: "bc", assigned_by: "staff", verified_at: "", enabled: true });
  const two = [conn("a", "111111"), conn("b", "222222")];
  assert.equal(defaultLaunchConnectionId(two, { defaultAdvertiserId: "222222" }), "b");
  assert.equal(defaultLaunchConnectionId(two, { defaultAdvertiserId: "999999", preferredAdvertiserId: "111111" }), "a", "a default the company cannot reach is never added");
  assert.equal(defaultLaunchConnectionId(two, {}), null, "two accounts and no default: a person chooses");
  assert.equal(defaultLaunchConnectionId([two[0]], {}), "a");
  assert.equal(defaultLaunchConnectionId([{ ...two[0], assigned_by: "" }], {}), null, "an unassigned row is never a launch account");

  const accounts = await tiktokAccounts(2);
  assert.equal((await getData().getLaunchWorkspace(producer())).tiktok_default_connection_id, null);
  process.env.TIKTOK_DEFAULT_ADVERTISER_ID = accounts[1].advertiser_id;
  const workspace = await getData().getLaunchWorkspace(producer());
  assert.equal(workspace.tiktok_default_connection_id, accounts[1].id);
  const title = await launchTitle();
  assert.deepEqual(workspace.titles, [], "titles are read per call");
  const withTitle = await getData().getLaunchWorkspace(producer());
  assert.deepEqual(withTitle.titles?.map((t) => [t.id, t.slug, t.ad_url]), [[title.id, "fixture-film", LIVE_AD_URL]]);
});

test("a new Launch draft starts on the default account and the only linked title, and the baseline takes the same defaults", () => {
  const workspace = { connections: [], library: [], runs: [], business_centers: [], default_destination_url: LIVE_AD_URL, producer_id: FIXTURE_PRODUCER_ID, can_edit: true, can_launch: true,
    titles: [{ id: "t1", name: "Live one", slug: "fixture-film", state: "live_complete", ad_url: LIVE_AD_URL }, { id: "t2", name: "Mock", slug: "mock-x", state: null, ad_url: null }],
    tiktok_default_connection_id: "tiktok:p:222222" } as LaunchWorkspace;
  const started = startingDraft(defaultLaunchDraft("tiktok"), workspace);
  assert.deepEqual(started.account_ids, ["tiktok:p:222222"], "zero clicks for the one account");
  assert.equal(started.title_id, "t1");
  assert.equal(started.destination_url, LIVE_AD_URL);
  assert.deepEqual(startingDraft(started, workspace), started, "idempotent, so an untouched page stays untouched");
  const chosen = startingDraft({ ...defaultLaunchDraft("tiktok"), account_ids: ["mine"] }, workspace);
  assert.deepEqual(chosen.account_ids, ["mine"], "a person's choice is never replaced");
  assert.deepEqual(startingDraft(defaultLaunchDraft("tiktok"), { ...workspace, tiktok_default_connection_id: null }).account_ids, []);
  // Meta never inherits TikTok's macros from the last launch's link.
  assert.equal(startingDraft(defaultLaunchDraft("meta"), workspace).destination_url, "https://crazydramas.com/watch/fixture-film");
  assert.equal(metaDestination("https://example.com/watch?x=1"), "https://example.com/watch?x=1");
});
