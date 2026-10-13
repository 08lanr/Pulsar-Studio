// Acquisition routes A/B/C (decision 2026-10-12): the launch setting `acquisition_route` and what each route sends
// (A the App Link with route=store, B the landing page with TikTok's macros, C today's link + route=web, `none` today's
// link byte for byte), the [cd:<slug>] tag on every App install campaign and ad group name, the route-against-shape
// rule, the stats report's optional `routes`, and the Routes tab's grouping and costs. Fixture mode only.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { launchHash, resetLaunchFixture } from "@/lib/data/launch";
import { defaultLaunchDraft, metaDraftIssues } from "@/lib/launch/plan";
import { metaDestination } from "@/lib/launch/draft-defaults";
import type { DriverContext, LaunchCampaign, LaunchConnection, LaunchDraft, LaunchRun } from "@/lib/launch/types";
import {
  CRAZYDRAMAS_TRY_BASE, TIKTOK_AD_QUERY, TIKTOK_NAME_MAX,
  crazydramasAdUrl, crazydramasAdUrlParts, crazydramasAppLink, crazydramasNameTag, crazydramasRouteAdUrl, isCrazydramasAdUrl, slugOfCrazydramasAdUrl, slugOfCrazydramasAppLink, withNameTag,
} from "@/lib/tiktok/ad-url";
import { FAKE_PIXEL_ID, fakeTikTokSnapshot, fakeTransport, resetFakeTikTok } from "@/lib/tiktok/fake";
import {
  adGroupBody, defaultAppInstallSettings, defaultSalesLaunchSettings, defaultTikTokLaunchSettings, defaultWebsitePurchaseSettings, landerOptimization, launchShape,
  LaunchSettingsError, normalizeLaunchSettings, planAdGroup, purchaseGoal, presetSettings, routeShapeProblem, summarizeLaunchSettings, validateLaunchSettings, withAcquisitionRoute, withoutDownloadEvent, type LaunchSettings,
} from "@/lib/tiktok/settings";
import { appInstallNameTag, tiktokSparkDriver } from "@/lib/tiktok/spark-driver";
import { CdStatsReportSchema, type CdStatsRoute } from "@/lib/crazydramas/stats-types";
import { campaignRoutes, hasRoutes, routeColumns, routeDaily, routeOfRun, routesIn, routeSpanAll, routeTotals } from "@/lib/crazydramas/stats-routes";
import type { AdPeriod, AdSpend } from "@/lib/crazydramas/stats-summary";
import { fakeRouteLaunches, fakeRoutes, FAKE_ROUTE_CAMPAIGNS } from "@/lib/crazydramas/fake-stats";
import { launchTitle, LIVE_SLUG } from "./launch-title";

const SLUG = "forced-to-marry-the-mafia-boss";
const originalPost = fakeTransport.post;
beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  delete process.env.TIKTOK_LIVE;
  resetFixtureStore(); resetLaunchFixture(); resetFakeTikTok();
});
afterEach(() => { fakeTransport.post = originalPost; resetFakeTikTok(); });

// ---- the links --------------------------------------------------------------------------------------------------

test("none is today's link byte for byte; C appends &route=web; B is the landing page with the same literal macros", () => {
  const today = `https://crazydramas.com/watch/${SLUG}?source=tiktok&campaign=__CAMPAIGN_ID__&adgroup=__AID__&creative=__CID__`;
  assert.equal(crazydramasRouteAdUrl(SLUG, "none"), today);
  assert.equal(crazydramasRouteAdUrl(SLUG, undefined), today);
  assert.equal(crazydramasRouteAdUrl(SLUG, null), crazydramasAdUrl(SLUG));
  assert.equal(crazydramasRouteAdUrl(SLUG, "web"), `${today}&route=web`);
  assert.equal(crazydramasRouteAdUrl(SLUG, "lander"), `https://crazydramas.com/try/${SLUG}?source=tiktok&campaign=__CAMPAIGN_ID__&adgroup=__AID__&creative=__CID__`);
  assert.equal(crazydramasRouteAdUrl(SLUG, "lander"), `${CRAZYDRAMAS_TRY_BASE}${SLUG}?${TIKTOK_AD_QUERY}`);
  for (const r of ["web", "lander"] as const) assert.ok(!crazydramasRouteAdUrl(SLUG, r).includes("%5F"), "macros never encoded");
  assert.throws(() => crazydramasRouteAdUrl(SLUG, "store"), /no website link/);
  assert.throws(() => crazydramasRouteAdUrl("mock-flirt", "lander"), /design mock/);
});

test("A's App Link says route=store and carries no macro; without a route it is the 2026-10-10 link", () => {
  assert.equal(crazydramasAppLink(SLUG, "store"), `https://crazydramas.com/watch/${SLUG}?source=tiktok&route=store`);
  assert.equal(crazydramasAppLink(SLUG), `https://crazydramas.com/watch/${SLUG}?source=tiktok`);
  assert.equal(crazydramasAppLink(SLUG, "none"), crazydramasAppLink(SLUG));
  assert.ok(!crazydramasAppLink(SLUG, "store").includes("__"));
  assert.equal(slugOfCrazydramasAppLink(crazydramasAppLink(SLUG, "store")), SLUG);
  assert.equal(slugOfCrazydramasAppLink(crazydramasAppLink(SLUG)), SLUG);
  assert.equal(slugOfCrazydramasAppLink(`${crazydramasAppLink(SLUG)}&x=1`), null);
  assert.equal(slugOfCrazydramasAppLink("https://evil.example/watch/x?source=tiktok"), null);
});

test("every route's link reads back as a TikTok crazydramas link with its slug and route; one byte off is not ours", () => {
  assert.deepEqual(crazydramasAdUrlParts(crazydramasRouteAdUrl(SLUG, "none")), { slug: SLUG, provider: "tiktok" });
  assert.deepEqual(crazydramasAdUrlParts(crazydramasRouteAdUrl(SLUG, "web")), { slug: SLUG, provider: "tiktok", route: "web" });
  assert.deepEqual(crazydramasAdUrlParts(crazydramasRouteAdUrl(SLUG, "lander")), { slug: SLUG, provider: "tiktok", route: "lander" });
  assert.ok(isCrazydramasAdUrl(crazydramasRouteAdUrl(SLUG, "lander"), "tiktok") && !isCrazydramasAdUrl(crazydramasRouteAdUrl(SLUG, "lander"), "meta"));
  assert.equal(slugOfCrazydramasAdUrl(crazydramasRouteAdUrl(SLUG, "web")), SLUG);
  assert.equal(crazydramasAdUrlParts(`${crazydramasRouteAdUrl(SLUG, "web")}&x=1`), null);
  assert.equal(crazydramasAdUrlParts(`${CRAZYDRAMAS_TRY_BASE}${SLUG}?source=meta`), null, "the landing page is TikTok's alone this round");
  assert.equal(crazydramasAdUrlParts(`https://crazydramas.com/watch/${SLUG}?source=meta&route=web`), null);
});

// ---- the name tag -----------------------------------------------------------------------------------------------

test("[cd:<slug>] goes last; the human part is trimmed to fit, never the tag", () => {
  const tag = crazydramasNameTag(SLUG);
  assert.equal(tag, `[cd:${SLUG}]`);
  assert.equal(withNameTag("studio-run-1-primary", tag), `studio-run-1-primary ${tag}`);
  const long = withNameTag("x".repeat(200), tag);
  assert.equal(long.length, TIKTOK_NAME_MAX);
  assert.ok(long.endsWith(` ${tag}`));
  assert.equal(withNameTag("x".repeat(200), null), "x".repeat(TIKTOK_NAME_MAX), "no tag: cut at 100 as always");
  assert.throws(() => withNameTag("x", "[cd:" + "a".repeat(120) + "]"), /no room/);
});

test("appInstallNameTag: the first ad's app link on an App install launch; none on a website launch or without a link", () => {
  const app = validateLaunchSettings({ ...defaultAppInstallSettings() }, 100);
  assert.equal(appInstallNameTag(app, [{ kind: "spark", value: "a" }, { kind: "spark", value: "b", app_link: crazydramasAppLink(SLUG, "store") }]), `[cd:${SLUG}]`);
  assert.equal(appInstallNameTag(app, [{ kind: "spark", value: "a", app_link: crazydramasAppLink(SLUG) }]), `[cd:${SLUG}]`, "any App install launch, any route");
  assert.equal(appInstallNameTag(app, [{ kind: "spark", value: "a" }]), null);
  assert.equal(appInstallNameTag(defaultWebsitePurchaseSettings(), [{ kind: "spark", value: "a", app_link: crazydramasAppLink(SLUG) }]), null);
});

function context(settings: LaunchSettings, content: LaunchCampaign["content"]): DriverContext {
  const campaign: LaunchCampaign = {
    id: "row-1", run_id: "8a8a8a8a-1111-4222-8333-444455556666", index: 1, connection_id: "connection-1", advertiser_id: "7000000000000000001", name: "app-a1b2c3d4e5f6-001",
    content, budget_cents: 12000, daily_budget_cents: 3000, status: "running", state: {}, error: null, snapshot: null,
  };
  const run: LaunchRun = {
    id: "8a8a8a8a-1111-4222-8333-444455556666", external_id: "lr_a1b2c3d4e5f6", producer_id: FIXTURE_PRODUCER_ID, round: 1, parent_run_id: null, status: "running", revision: 1,
    snapshot_hash: null, approved_by: "approver-1", approved_at: new Date().toISOString(), approval_note: null,
    created_by: "approver-1", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mode: "fake", error: null,
    campaigns: [campaign], lease_owner: "worker", lease_until: new Date(Date.now() + 60_000).toISOString(),
    draft: { ...defaultLaunchDraft("tiktok"), name: "App launch", account_ids: ["connection-1"], content_per_campaign: 1, content,
      destination_url: "", total_budget_cents: 12000, daily_budget_cents: 3000, start_paused: true, tiktok_settings: settings },
  };
  run.connections = [{ id: "connection-1", producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: campaign.advertiser_id, name: "TikTok test", currency: "USD", timezone: "", page_id: null, instagram_id: null, business_id: "bc-1", assigned_by: "staff-1", verified_at: "", enabled: true }];
  // Signed as approval reads it: without the campaign rows, as none carries a campid.
  run.snapshot_hash = launchHash(run.draft, run.connections);
  return { run, campaign, connection: run.connections[0],
    checkpoint: async (patch) => { campaign.state = { ...campaign.state, ...structuredClone(patch) }; }, assertActive: async () => {} };
}

test("an App install launch names its campaign and ad group with [cd:<slug>]; the ad's name and a launch without a link are untouched", async () => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  fakeTransport.post = async (path, token, body) => { writes.push({ path, body: structuredClone(body) }); return originalPost(path, token, body); };
  const ctx = context({ ...defaultAppInstallSettings(), acquisition_route: "store", start_paused: true }, [{ kind: "spark", value: "good-one", app_link: crazydramasAppLink(SLUG, "store") }]);
  await tiktokSparkDriver.launch(ctx);
  assert.equal(ctx.campaign.state.name_tag, `[cd:${SLUG}]`);
  const campaignName = String(writes.find((w) => w.path === "/campaign/create/")!.body.campaign_name);
  const groupName = String(writes.find((w) => w.path === "/adgroup/create/")!.body.adgroup_name);
  assert.equal(groupName, `studio-${ctx.run.id}-1-primary [cd:${SLUG}]`);
  assert.ok(campaignName.startsWith(`studio-${ctx.run.id}-1-`) && campaignName.endsWith(` [cd:${SLUG}]`) && campaignName.length <= TIKTOK_NAME_MAX, campaignName);
  assert.ok(!String(fakeTikTokSnapshot().ads[0].body.ad_name).includes("[cd:"), "ads keep their names");

  resetFakeTikTok(); writes.length = 0;
  const bare = context({ ...defaultAppInstallSettings(), start_paused: true }, [{ kind: "spark", value: "good-one" }]);
  await tiktokSparkDriver.launch(bare);
  assert.equal(writes.find((w) => w.path === "/adgroup/create/")!.body.adgroup_name, `studio-${bare.run.id}-1-primary`, "no app link, no tag, the name as before");
});

test("a long slug never cuts the unique key: the tagged name runs past 100, within TikTok's 512", async () => {
  const slug = "a-very-long-series-name-that-goes-on-and-on-for-a-while-and-then-some-more-words";
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  fakeTransport.post = async (path, token, body) => { writes.push({ path, body: structuredClone(body) }); return originalPost(path, token, body); };
  const ctx = context({ ...defaultAppInstallSettings(), start_paused: true }, [{ kind: "spark", value: "good-one", app_link: crazydramasAppLink(slug) }]);
  await tiktokSparkDriver.launch(ctx);
  const groupName = String(writes.find((w) => w.path === "/adgroup/create/")!.body.adgroup_name);
  assert.equal(groupName, `studio-${ctx.run.id}-1-primary [cd:${slug}]`);
  assert.ok(groupName.length > TIKTOK_NAME_MAX && groupName.length <= 512);
});

test("a B launch end to end: the ad carries the landing page link; landing page views send no pixel, Download sends DOWNLOAD_START; no name tag", async () => {
  const link = crazydramasRouteAdUrl(SLUG, "lander");
  const launchWith = async (settings: LaunchSettings) => {
    resetFakeTikTok();
    const writes: { path: string; body: Record<string, unknown> }[] = [];
    fakeTransport.post = async (path, token, body) => { writes.push({ path, body: structuredClone(body) }); return originalPost(path, token, body); };
    const ctx = context({ ...settings, start_paused: true }, [{ kind: "spark", value: "good-one", landing_url: link }]);
    ctx.run.draft.destination_url = link;
    ctx.run.snapshot_hash = launchHash(ctx.run.draft, ctx.run.connections!);
    await tiktokSparkDriver.launch(ctx);
    return { ctx, group: writes.find((w) => w.path === "/adgroup/create/")!.body, campaign: writes.find((w) => w.path === "/campaign/create/")!.body };
  };
  const lpv = await launchWith(withAcquisitionRoute(defaultTikTokLaunchSettings(), "lander"));
  assert.deepEqual([lpv.campaign.objective_type, lpv.group.optimization_goal, lpv.group.billing_event, lpv.group.pixel_id], ["TRAFFIC", "TRAFFIC_LANDING_PAGE_VIEW", "OCPM", undefined]);
  assert.equal(fakeTikTokSnapshot().ads[0].body.landing_page_url, link);
  assert.ok(!String(lpv.group.adgroup_name).includes("[cd:"), "the tag is the App install launch's alone");
  const dl = await launchWith(landerOptimization(withAcquisitionRoute(defaultTikTokLaunchSettings(), "lander"), "downloads"));
  assert.deepEqual([dl.campaign.objective_type, dl.group.optimization_goal, dl.group.optimization_event, dl.group.pixel_id], ["WEB_CONVERSIONS", "CONVERT", "DOWNLOAD_START", FAKE_PIXEL_ID]);
  assert.equal(fakeTikTokSnapshot().ads[0].body.landing_page_url, link);
});

// ---- the route against the shape --------------------------------------------------------------------------------

test("validation: A only on App install, B and C only on a website shape; B never on a sale event; Download only on B; none is dropped", () => {
  const web = defaultWebsitePurchaseSettings();
  const app = defaultAppInstallSettings();
  const traffic: LaunchSettings = landerOptimization(web, "page_views");
  assert.throws(() => validateLaunchSettings({ ...web, acquisition_route: "store" }, 100), LaunchSettingsError);
  assert.throws(() => validateLaunchSettings({ ...app, acquisition_route: "lander" }, 100), /route A/);
  assert.throws(() => validateLaunchSettings({ ...app, acquisition_route: "web" }, 100), /route A/);
  assert.throws(() => validateLaunchSettings({ ...defaultSalesLaunchSettings(), acquisition_route: "web" }, 100), /not a Sales Instant Page/);
  assert.throws(() => validateLaunchSettings({ ...web, acquisition_route: "lander" }, 100), /no purchase on the web/, "a lander on Purchase");
  assert.throws(() => validateLaunchSettings({ ...web, optimization_event: "INITIATE_ORDER", acquisition_route: "lander" }, 100), /no purchase on the web/);
  assert.throws(() => validateLaunchSettings({ ...web, optimization_event: "DOWNLOAD_START" }, 100), /only a landing page launch/);
  assert.throws(() => validateLaunchSettings({ ...web, optimization_event: "DOWNLOAD_START", acquisition_route: "web" }, 100), /only a landing page launch/);
  assert.equal(validateLaunchSettings({ ...app, acquisition_route: "store" }, 100).acquisition_route, "store");
  assert.equal(validateLaunchSettings({ ...web, acquisition_route: "web" }, 100).acquisition_route, "web");
  assert.equal(validateLaunchSettings({ ...traffic, optimization_goal: "CLICK", acquisition_route: "web" }, 100).acquisition_route, "web", "C on Traffic is a website shape too");
  assert.equal(validateLaunchSettings({ ...traffic, acquisition_route: "lander" }, 100).acquisition_route, "lander");
  assert.equal(validateLaunchSettings(landerOptimization({ ...web, acquisition_route: "lander" }, "downloads"), 100).optimization_event, "DOWNLOAD_START");
  assert.equal(validateLaunchSettings({ ...web, acquisition_route: "none" }, 100).acquisition_route, undefined, "none is stored as absent");
  assert.equal(routeShapeProblem(web), null);
  assert.equal(normalizeLaunchSettings({ ...app, acquisition_route: "store" }).acquisition_route, "store", "kept through normalization");
  assert.equal(normalizeLaunchSettings({ ...app, acquisition_route: "elsewhere" }).acquisition_route, undefined, "an unknown route is not a route");
});

test("picking a route sets its shape: A App install, B Traffic on landing page views, C Website purchases; Android on each; budget and audiences kept", () => {
  const base: LaunchSettings = { ...defaultTikTokLaunchSettings(), duration_days: 4, audiences: { include: [{ id: "123456789", name: "Viewers" }], exclude: [] } };
  const a = withAcquisitionRoute(base, "store");
  assert.deepEqual([launchShape(a), a.acquisition_route, a.optimization_goal, a.operating_systems, a.duration_days, a.audiences?.include[0].id], ["app_install", "store", "INSTALL", ["ANDROID"], 4, "123456789"]);
  const b = withAcquisitionRoute(base, "lander");
  assert.deepEqual([launchShape(b), b.acquisition_route, b.optimization_goal, b.optimization_event, b.operating_systems, purchaseGoal(b)], ["traffic", "lander", "TRAFFIC_LANDING_PAGE_VIEW", undefined, ["ANDROID"], "page_views"]);
  const c = withAcquisitionRoute(base, "web");
  assert.deepEqual([launchShape(c), c.acquisition_route, c.optimization_event, c.operating_systems, purchaseGoal(c)], ["website_purchases", "web", "SHOPPING", ["ANDROID"], "purchases"]);
  const none = withAcquisitionRoute(c, "none");
  assert.equal(none.acquisition_route, undefined);
  assert.equal(launchShape(none), "website_purchases", "dropping the route keeps the shape");
  const downloads = landerOptimization(b, "downloads");
  assert.deepEqual([launchShape(downloads), downloads.optimization_goal, downloads.optimization_event, downloads.attribution?.event_count, purchaseGoal(downloads)], ["website_purchases", "CONVERT", "DOWNLOAD_START", "ONCE", "downloads"]);
  assert.ok(summarizeLaunchSettings(validateLaunchSettings(b, 100)).includes("acquisition route B · landing page"));
  assert.ok(summarizeLaunchSettings(validateLaunchSettings(downloads, 100)).includes("optimizes for Download (pixel)"));
  for (const s of [a, b, c, downloads]) assert.doesNotThrow(() => validateLaunchSettings(s, 100));
});

test("B's ad groups: landing page views on oCPM with no pixel; Download on the pixel, counted once; the fake takes both", async () => {
  const b = validateLaunchSettings(withAcquisitionRoute(defaultTikTokLaunchSettings(), "lander"), 100);
  const lpv = adGroupBody(b, planAdGroup(b, 100));
  assert.deepEqual([lpv.promotion_type, lpv.optimization_goal, lpv.billing_event, lpv.pixel_id, lpv.optimization_event], ["WEBSITE", "TRAFFIC_LANDING_PAGE_VIEW", "OCPM", undefined, undefined]);
  const d = validateLaunchSettings(landerOptimization(b, "downloads"), 100);
  const pixel = { pixel_id: FAKE_PIXEL_ID };
  const dl = adGroupBody(d, planAdGroup(d, 100), pixel);
  assert.deepEqual([dl.optimization_goal, dl.optimization_event, dl.attribution_event_count, dl.billing_event], ["CONVERT", "DOWNLOAD_START", "ONCE", "OCPM"]);
  const adv = "7000000000000000001";
  const trafficCampaign = await fakeTransport.post("/campaign/create/", "fake-token", { advertiser_id: adv, campaign_name: "lander-lpv", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_INFINITE" });
  const ok1 = await fakeTransport.post("/adgroup/create/", "fake-token", { advertiser_id: adv, campaign_id: (trafficCampaign.data as { campaign_id: string }).campaign_id, adgroup_name: "lpv", ...lpv });
  assert.equal(ok1.code, 0, ok1.message);
  const salesCampaign = await fakeTransport.post("/campaign/create/", "fake-token", { advertiser_id: adv, campaign_name: "lander-dl", objective_type: "WEB_CONVERSIONS", virtual_objective_type: "SALES", sales_destination: "WEBSITE", budget_mode: "BUDGET_MODE_INFINITE" });
  const ok2 = await fakeTransport.post("/adgroup/create/", "fake-token", { advertiser_id: adv, campaign_id: (salesCampaign.data as { campaign_id: string }).campaign_id, adgroup_name: "dl", ...dl });
  assert.equal(ok2.code, 0, ok2.message);
  const withPixel = await fakeTransport.post("/adgroup/create/", "fake-token", { advertiser_id: adv, campaign_id: (trafficCampaign.data as { campaign_id: string }).campaign_id, adgroup_name: "lpv-pixel", ...lpv, pixel_id: "1790000000000000001" });
  assert.match(withPixel.message, /pixel_id is not supported/, "TikTok takes no pixel_id on landing page views");
});

// ---- the data layer ---------------------------------------------------------------------------------------------

const producer = () => fixtureSession("producer");
async function tiktokAccount(): Promise<LaunchConnection> {
  return getData().assignLaunchConnection(fixtureSession("staff"), {
    producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: "7000000000000000001", name: "TikTok 1",
    currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true,
  });
}
function websiteDraft(account: LaunchConnection, titleId: string, settings: LaunchSettings): LaunchDraft {
  return { ...defaultLaunchDraft("tiktok"), name: "Route launch", account_ids: [account.id], content_per_campaign: 1, allocation: "shared",
    content: [{ kind: "spark", value: "good-one", title_id: titleId }], title_id: titleId, destination_url: "", total_budget_cents: 20000, daily_budget_cents: null,
    tiktok_settings: settings };
}

test("save writes each route's link from the title: B the landing page, C + route=web, none today's; preview takes B", async () => {
  const account = await tiktokAccount();
  const title = await launchTitle(LIVE_SLUG);
  const b = await getData().saveLaunchDraft(producer(), websiteDraft(account, title.id, withAcquisitionRoute(defaultTikTokLaunchSettings(), "lander")));
  assert.equal(b.draft.destination_url, crazydramasRouteAdUrl(LIVE_SLUG, "lander"));
  assert.equal(b.draft.content[0].landing_url, crazydramasRouteAdUrl(LIVE_SLUG, "lander"));
  const preview = await getData().previewLaunchRun(producer(), b.id);
  assert.equal(preview.rows[0].content[0].landing_url, crazydramasRouteAdUrl(LIVE_SLUG, "lander"));
  const c = await getData().saveLaunchDraft(producer(), websiteDraft(account, title.id, withAcquisitionRoute(defaultTikTokLaunchSettings(), "web")));
  assert.equal(c.draft.destination_url, `${crazydramasAdUrl(LIVE_SLUG)}&route=web`);
  const none = await getData().saveLaunchDraft(producer(), websiteDraft(account, title.id, defaultTikTokLaunchSettings()));
  assert.equal(none.draft.destination_url, crazydramasAdUrl(LIVE_SLUG), "no route: the link as before");
  assert.equal(none.draft.tiktok_settings.acquisition_route, undefined);
});

test("save gives route A's ads the App Link with route=store; a Meta draft never keeps a route and the planner refuses one", async () => {
  const account = await tiktokAccount();
  const title = await launchTitle(LIVE_SLUG);
  const a = await getData().saveLaunchDraft(producer(), { ...websiteDraft(account, title.id, withAcquisitionRoute(defaultTikTokLaunchSettings(), "store")), title_id: null, daily_budget_cents: 3000 });
  assert.equal(a.draft.content[0].app_link, crazydramasAppLink(LIVE_SLUG, "store"));
  assert.equal(a.draft.destination_url, "");
  const meta = { ...defaultLaunchDraft("meta"), destination_url: "https://crazydramas.com/watch/x?source=meta", tiktok_settings: { ...defaultLaunchDraft("meta").tiktok_settings, acquisition_route: "web" } } as LaunchDraft;
  assert.ok(metaDraftIssues(meta, []).some((i) => i.code === "acquisitionRoute"));
  assert.ok(!metaDraftIssues({ ...meta, tiktok_settings: defaultLaunchDraft("meta").tiktok_settings }, []).some((i) => i.code === "acquisitionRoute"));
});

// ---- the stats report ---------------------------------------------------------------------------------------------

const REPORT = {
  version: 1, generated_at: "2026-10-12T12:00:00Z", timezone: "America/Los_Angeles", from: "2026-10-01", to: "2026-10-12", ep1_step_s: 15,
  robots: { people: 0, crawler_ua: 0, burst: 0, end_jump: 0 }, days: [], series: [],
};

test("the report parses without routes (an older crazydramas) and with them; a row of an unknown route is left out, not the report", () => {
  const old = CdStatsReportSchema.parse(REPORT);
  assert.equal(old.routes, undefined);
  assert.equal(hasRoutes(old), false);
  const row = { day: "2026-10-11", route: "lander", campaign_id: "1878", landed: 10, store_taps: 4, installs: 2, opened_episode: 1, trials: 1, paid: 0, repeat_viewers: 1, revenue_cents: 0, extra: "dropped" };
  const parsed = CdStatsReportSchema.parse({ ...REPORT, routes: [row, { ...row, route: "email" }, { ...row, day: "not a day" }, { day: "2026-10-12", route: "store" }] });
  assert.equal(parsed.routes?.length, 2);
  assert.deepEqual(parsed.routes?.[0], { day: "2026-10-11", route: "lander", campaign_id: "1878", landed: 10, store_taps: 4, installs: 2, opened_episode: 1, trials: 1, paid: 0, repeat_viewers: 1, revenue_cents: 0 });
  assert.deepEqual(parsed.routes?.[1], { day: "2026-10-12", route: "store", campaign_id: null, landed: 0, store_taps: 0, installs: 0, opened_episode: 0, trials: 0, paid: 0, repeat_viewers: 0, revenue_cents: 0 }, "missing counts read 0");
  assert.equal(hasRoutes(CdStatsReportSchema.parse({ ...REPORT, routes: [] })), true, "an empty list is a crazydramas with routes and nobody on them");
});

// ---- grouping and costs -----------------------------------------------------------------------------------------

const r = (day: string, route: CdStatsRoute["route"], campaign_id: string | null, n: Partial<CdStatsRoute> = {}): CdStatsRoute =>
  ({ day, route, campaign_id, landed: 0, store_taps: 0, installs: 0, opened_episode: 0, trials: 0, paid: 0, repeat_viewers: 0, revenue_cents: 0, ...n });
const spend = (ad_id: string, campaign_id: string, spend_cents: number | null, provider: "tiktok" | "meta" = "tiktok"): AdSpend =>
  ({ ad_id, provider, spend_cents, impressions: spend_cents === null ? null : spend_cents * 3, clicks: spend_cents === null ? null : Math.round(spend_cents / 20), campaign_id, campaign_name: "c", launch_name: "l", run_id: "lr_x", launched_at: "2026-10-01T10:00:00Z" });
const run = (campaignId: string, route: string | undefined, provider: "tiktok" | "meta" = "tiktok") =>
  ({ draft: { provider, tiktok_settings: route ? { acquisition_route: route } : {} }, campaigns: [{ state: { campaign_id: campaignId } }] }) as unknown as LaunchRun;

test("a campaign's route: a Studio launch decides for its own campaigns (none = in no route); only unknown campaigns take the report's route", () => {
  const rows = [r("2026-10-11", "web", "C1", { landed: 9 }), r("2026-10-11", "store", "LIVE", { installs: 30 }), r("2026-10-11", "lander", "U1", { landed: 1 }), r("2026-10-11", "web", "U1", { landed: 5 })];
  const routes = campaignRoutes(rows, [run("C1", "lander"), run("C2", "store"), run("LIVE", undefined), run("C4", "web", "meta")]);
  assert.equal(routes.get("C1"), "lander", "the launch's route wins over the report's");
  assert.equal(routes.get("C2"), "store", "no rows yet: the launch's route");
  assert.equal(routes.get("LIVE"), null, "an App install launch on no route (1878639243715761) is in none of A/B/C, whatever crazydramas calls it");
  assert.equal(routes.get("U1"), "web", "a campaign Studio does not know: the report's route with more activity");
  assert.equal(routes.has("C4"), false, "a Meta run is never on a route");
  assert.equal(routeOfRun(run("x", "none")), null);
  // The excluded campaign's installs are counted nowhere; C1's rows count under its launch's route.
  const [a, b, c] = routeColumns(rows, [spend("live1", "LIVE", 50000)], routes);
  assert.deepEqual([a.installs, a.spend_cents, b.landed, c.landed], [0, null, 9, 6], "U1's stray lander row counts under its campaign's route");
  assert.deepEqual(routeDaily(rows, { from: "2026-10-11", to: "2026-10-11" }, "installs", routes), [0], "the daily line leaves it out too");
});

test("routeColumns: counts summed; spend per route's campaigns; costs divide known spend by only the people of costed campaigns", () => {
  const rows = [
    r("2026-10-10", "store", "A1", { installs: 40, opened_episode: 10, trials: 4, paid: 2, repeat_viewers: 12, revenue_cents: 798 }),
    r("2026-10-11", "store", null, { installs: 10, trials: 1 }),
    r("2026-10-11", "store", "ONELINK", { installs: 6 }),
    r("2026-10-10", "lander", "B1", { landed: 300, store_taps: 100, installs: 25, opened_episode: 20, trials: 0, paid: 0 }),
  ];
  const spends = [spend("a1", "A1", 10000), spend("b1", "B1", 6000), spend("b2", "B1", 4000), spend("m1", "B1", 99999, "meta"), spend("x1", "X9", 5000)];
  const routeOf = campaignRoutes(rows, []);
  const [a, b, c] = routeColumns(rows, spends, routeOf);
  assert.deepEqual([a.route, b.route, c.route], ["store", "lander", "web"]);
  assert.deepEqual([a.installs, a.trials, a.paid, a.revenue_cents, a.spend_cents, a.campaigns], [56, 5, 2, 798, 10000, ["A1", "ONELINK"]], "every count stays in the route's totals");
  assert.deepEqual([a.unmatched.installs, a.unmatched.trials], [16, 1], "no campaign, and a campaign Studio has no spend for");
  assert.deepEqual([a.cost_per_install_cents, a.cost_per_trial_cents, a.cost_per_paid_cents, a.partial, a.spend_partial], [250, 2500, 5000, true, false], "$100 over A1's 40 installs, not 56");
  assert.deepEqual([b.landed, b.store_taps, b.installs, b.spend_cents, b.impressions, b.clicks], [300, 100, 25, 10000, 30000, 500], "two ads summed; the Meta ad and an unrouted campaign left out");
  assert.deepEqual([b.cost_per_install_cents, b.cost_per_trial_cents, b.cost_per_paid_cents, b.partial], [400, null, null, false], "nobody trialled or paid: no cost, never a division by zero");
  assert.deepEqual([c.installs, c.spend_cents, c.cost_per_install_cents, c.campaigns], [0, null, null, []]);
  const total = routeTotals([a, b, c]);
  assert.deepEqual([total.installs, total.unmatched.installs, total.spend_cents, total.cost_per_install_cents, total.partial], [81, 16, 20000, 308, true]);
});

test("spend unknown for an ad: its campaign's people and spend leave the costs; the spend shown is the known part", () => {
  const rows = [r("2026-10-10", "web", "C1", { installs: 4, paid: 2 }), r("2026-10-10", "web", "C2", { installs: 5, paid: 1 })];
  const [, , c] = routeColumns(rows, [spend("c1", "C1", 3000), spend("c1b", "C1", null), spend("c2", "C2", 2000)], campaignRoutes(rows, []));
  assert.deepEqual([c.spend_cents, c.costed_spend_cents, c.spend_partial, c.partial, c.unmatched.installs], [5000, 2000, true, true, 4]);
  assert.deepEqual([c.cost_per_install_cents, c.cost_per_paid_cents], [400, 2000], "only C2: $20 over its 5 installs and 1 payer");
  const [, , none] = routeColumns(rows.slice(0, 1), [spend("c1b", "C1", null)], campaignRoutes(rows, []));
  assert.deepEqual([none.spend_cents, none.costed_spend_cents, none.cost_per_install_cents], [null, null, null]);
  assert.equal(routeTotals(routeColumns(rows.slice(0, 1), [spend("c1b", "C1", null)], campaignRoutes(rows, []))).spend_cents, null);
});

test("All starts on the first day with route rows: lifetime spend from before the routes is never set against them", () => {
  assert.equal(routeSpanAll({ routes: undefined, to: "2026-10-20" }), null);
  const rows = [r("2026-10-14", "web", "C1", { installs: 2 }), r("2026-10-12", "web", "C1", { installs: 1 })];
  const all = routeSpanAll({ routes: rows, to: "2026-10-20" })!;
  assert.deepEqual(all, { from: "2026-10-12", to: "2026-10-20" });
  const period: AdPeriod = { ...all, timezone: "America/Los_Angeles", last_day: "2026-10-20",
    days: { ok: true, from: "2026-09-21", campaigns: ["C1"], days: { c1: [{ day: "2026-10-05", spend_cents: 7000, impressions: 1, clicks: 1 }, { day: "2026-10-13", spend_cents: 1500, impressions: 1, clicks: 1 }] } } };
  const [, , c] = routeColumns(routesIn({ routes: rows }, all), [spend("c1", "C1", 8500)], campaignRoutes(rows, []), period);
  assert.deepEqual([c.spend_cents, c.installs, c.cost_per_install_cents], [1500, 3, 500], "the Oct 5 spend predates the routes");
});

test("the period: route rows by their day, spend from TikTok's days in it; the daily line has every day", () => {
  const rows = [r("2026-10-09", "lander", "B1", { installs: 5 }), r("2026-10-11", "lander", "B1", { installs: 7, trials: 1 }), r("2026-10-12", "lander", "B1", { installs: 1 })];
  const span = { from: "2026-10-10", to: "2026-10-11" };
  const inSpan = routesIn({ routes: rows }, span);
  assert.equal(inSpan.length, 1);
  const period: AdPeriod = { ...span, timezone: "America/Los_Angeles", last_day: "2026-10-12",
    days: { ok: true, from: "2026-09-13", campaigns: ["B1"], days: { b1: [
      { day: "2026-10-09", spend_cents: 900, impressions: 100, clicks: 9 },
      { day: "2026-10-10", spend_cents: 1000, impressions: 200, clicks: 10 },
      { day: "2026-10-11", spend_cents: 1100, impressions: 300, clicks: 11 },
    ] } } };
  const [, b] = routeColumns(inSpan, [spend("b1", "B1", 99999)], campaignRoutes(rows, []), period);
  assert.deepEqual([b.installs, b.spend_cents, b.impressions, b.clicks, b.cost_per_install_cents, b.cost_per_trial_cents], [7, 2100, 500, 21, 300, 2100]);
  assert.deepEqual(routeDaily(rows, { from: "2026-10-09", to: "2026-10-12" }, "installs"), [5, 0, 7, 1]);
});

test("the fixture's routes join the invented route launches: three routes with spend, B best per install, C best per paid user", () => {
  const now = new Date("2026-10-12T19:00:00Z");
  const fake = fakeRouteLaunches(now);
  const rows = fakeRoutes("2026-10-12");
  const spends = fake.runs.flatMap((x) => (x.campaigns ?? []).flatMap((c) => (c.snapshot?.ads ?? []).map((ad) => spend(ad.id, String(c.state.campaign_id), ad.stats?.spend_cents ?? null))));
  const routeOf = campaignRoutes(rows, fake.runs);
  assert.equal(routeOf.get(FAKE_ROUTE_CAMPAIGNS.lander), "lander");
  const [a, b, c] = routeColumns(rows, spends, routeOf);
  assert.ok(a.spend_cents && b.spend_cents && c.spend_cents);
  assert.equal(a.landed, 0, "A has no page in between");
  assert.ok(b.cost_per_install_cents! < a.cost_per_install_cents! && a.cost_per_install_cents! < c.cost_per_install_cents!);
  assert.ok(c.cost_per_paid_cents! < a.cost_per_paid_cents! && c.cost_per_paid_cents! < b.cost_per_paid_cents!);
  const days = fake.days.days[fake.runs[1].campaigns![0].snapshot!.ads![0].id];
  assert.equal(days.reduce((n, d) => n + (d.spend_cents ?? 0), 0), b.spend_cents, "the invented days add up to the lifetime spend");
  assert.ok(CdStatsReportSchema.safeParse({ ...REPORT, routes: rows }).success);
});

// ---- review fixes (2026-10-12) --------------------------------------------------------------------------------------

test("leaving B on Download puts the event back to Purchase (and its count), so the draft saves", () => {
  const downloads = landerOptimization(withAcquisitionRoute(defaultTikTokLaunchSettings(), "lander"), "downloads");
  const none = withAcquisitionRoute(downloads, "none");
  assert.deepEqual([none.acquisition_route, launchShape(none), none.optimization_event, none.attribution?.event_count], [undefined, "website_purchases", "SHOPPING", "EVERY"]);
  assert.doesNotThrow(() => validateLaunchSettings(none, 100));
  for (const route of ["web", "store"] as const) assert.doesNotThrow(() => validateLaunchSettings(withAcquisitionRoute(downloads, route), 100), route);
  assert.equal(withAcquisitionRoute(downloads, "web").optimization_event, "SHOPPING");
  assert.equal(withoutDownloadEvent(downloads), downloads, "on B, Download stays");
});

test("presets never carry a route or the deferred deep link: stripped by presetSettings, on save in the data layer", async () => {
  const downloads = landerOptimization(withAcquisitionRoute(defaultTikTokLaunchSettings(), "lander"), "downloads");
  const stripped = presetSettings(downloads);
  assert.deepEqual([stripped.acquisition_route, stripped.optimization_event], [undefined, "SHOPPING"]);
  assert.doesNotThrow(() => validateLaunchSettings(stripped, 100));
  assert.equal(presetSettings({ ...defaultAppInstallSettings(), app_deeplink: true, acquisition_route: "store" }).app_deeplink, undefined);
  const saved = await getData().saveLaunchPreset(fixtureSession("staff"), { name: "Route preset", settings: { ...defaultAppInstallSettings(), app_deeplink: true, acquisition_route: "store" } });
  assert.deepEqual([saved.settings.acquisition_route, saved.settings.app_deeplink, saved.settings.objective_type], [undefined, undefined, "APP_PROMOTION"]);
});

test("a Meta draft started from a route link gets the series' player page, never the landing page", () => {
  assert.equal(metaDestination(crazydramasRouteAdUrl(SLUG, "lander")), `https://crazydramas.com/watch/${SLUG}`);
  assert.equal(metaDestination(crazydramasRouteAdUrl(SLUG, "web")), `https://crazydramas.com/watch/${SLUG}`);
  assert.equal(metaDestination(crazydramasAdUrl(SLUG)), `https://crazydramas.com/watch/${SLUG}`, "today's link as before");
  assert.equal(metaDestination("https://example.com/x?y=1"), "https://example.com/x?y=1");
});

test("routes: null or not a list reads as absent; it never fails the report", () => {
  for (const routes of [null, "x", 3, { a: 1 }]) {
    const parsed = CdStatsReportSchema.safeParse({ ...REPORT, routes });
    assert.ok(parsed.success, JSON.stringify(routes));
    assert.equal(parsed.data!.routes ?? undefined, undefined);
    assert.equal(hasRoutes(parsed.data!), false);
  }
});
