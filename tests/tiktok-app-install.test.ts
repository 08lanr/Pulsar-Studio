// TikTok App install launches (decision 2026-10-09, "App install launches"):
// the fourth launch shape, APP_PROMOTION / APP_INSTALL for the crazydramas
// Android app on Google Play. The app resolved on the ad account the way the
// pixel is (lib/tiktok/app.ts, TIKTOK_PROMOTED_APP_ID set by hand while TikTok refuses
// /app/list/), the ad group on the app with INSTALL / OCPM and the operating
// system, the campaign with app_promotion_type, ads with no link and no page,
// the fake's documented refusals, the data layer's save / preview / approval
// without a title or a link. Fixture mode only: nothing leaves the process.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { launchHash, resetLaunchFixture } from "@/lib/data/launch";
import { buildLaunchPlan, defaultLaunchDraft } from "@/lib/launch/plan";
import type { DriverContext, LaunchCampaign, LaunchConnection, LaunchDraft, LaunchRun } from "@/lib/launch/types";
import { APP_ID_SHAPE, appFromList, CRAZYDRAMAS_ANDROID_PACKAGE, playStoreUrl, resolveApp, tiktokAppId, tiktokAppPackage } from "@/lib/tiktok/app";
import { FAKE_APP_ID, fakeTikTokSnapshot, fakeTransport, resetFakeTikTok } from "@/lib/tiktok/fake";
import { adGroupBody, defaultAppInstallSettings, defaultWebsitePurchaseSettings, launchShape, LaunchSettingsError, planAdGroup, purchaseGoal, summarizeLaunchSettings, validateLaunchSettings, type LaunchSettings } from "@/lib/tiktok/settings";
import { tiktokSparkDriver } from "@/lib/tiktok/spark-driver";
import { planAppNote } from "@/components/launch/plan-summary";
import { t } from "@/lib/i18n";

const HAND_SET_APP = "7290000000000000777";
const env = { TIKTOK_FAKE_APP: process.env.TIKTOK_FAKE_APP, TIKTOK_PROMOTED_APP_ID: process.env.TIKTOK_PROMOTED_APP_ID, TIKTOK_APP_PACKAGE: process.env.TIKTOK_APP_PACKAGE };
const originalGet = fakeTransport.get;
const originalPost = fakeTransport.post;
const en = (key: string, vars?: Record<string, string | number>) => t("en", key, vars);
beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  delete process.env.TIKTOK_LIVE; delete process.env.TIKTOK_FAKE_APP; delete process.env.TIKTOK_PROMOTED_APP_ID; delete process.env.TIKTOK_APP_PACKAGE;
  resetFixtureStore(); resetLaunchFixture(); resetFakeTikTok();
});
afterEach(() => {
  fakeTransport.get = originalGet; fakeTransport.post = originalPost;
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  resetFakeTikTok();
});

const app = (): LaunchSettings => ({ ...defaultAppInstallSettings(), start_paused: true });
const plan = (s: LaunchSettings) => planAdGroup(validateLaunchSettings(s, 500), 500);

// ---- the shape ----------------------------------------------------------------------------------------------

test("the App install default: APP_PROMOTION on Google Play, installs, Android only, 18+, lifetime budget, Install Now, profile posts", () => {
  const d = defaultAppInstallSettings();
  assert.equal(launchShape(d), "app_install");
  assert.equal(purchaseGoal(d), "installs");
  assert.deepEqual([d.objective_type, d.app_platform, d.optimization_goal, d.operating_systems, d.call_to_action, d.profile_posts, d.budget_mode], ["APP_PROMOTION", "ANDROID", "INSTALL", ["ANDROID"], "INSTALL_NOW", true, "BUDGET_MODE_TOTAL"]);
  assert.ok(!d.age_groups.includes("AGE_13_17"), "18+");
  const line = summarizeLaunchSettings(d);
  assert.ok(line.includes("App install · Google Play") && line.includes("Android only") && line.includes("optimizes for app installs (measurement partner)"), line.join(" · "));
});

test("validation: an App install launch forces the operating system, drops every pixel field, and refuses other goals; INSTALL is refused elsewhere", () => {
  const s = validateLaunchSettings({ ...app(), operating_systems: [], optimization_event: "SHOPPING", pixel_code: "DALLBMJC77U250DBQUR0", sales_destination: "website" } as LaunchSettings, 500);
  assert.deepEqual(s.operating_systems, ["ANDROID"]);
  assert.equal(s.optimization_event, undefined); assert.equal(s.pixel_code, undefined); assert.equal(s.attribution, undefined); assert.equal(s.sales_destination, undefined);
  assert.throws(() => validateLaunchSettings({ ...app(), optimization_goal: "CONVERT" }, 500), LaunchSettingsError);
  assert.throws(() => validateLaunchSettings({ ...app(), optimization_goal: "CLICK" }, 500), /app installs/);
  assert.throws(() => validateLaunchSettings({ ...defaultWebsitePurchaseSettings(), objective_type: "TRAFFIC", sales_destination: undefined, optimization_event: undefined, attribution: undefined, pixel_code: undefined, optimization_goal: "INSTALL" }, 500), /App installs are the App install launch's goal/);
  assert.throws(() => validateLaunchSettings({ ...defaultWebsitePurchaseSettings(), optimization_goal: "INSTALL" }, 500), LaunchSettingsError, "a website launch on INSTALL is refused too");
  const ios = validateLaunchSettings({ ...app(), app_platform: "IOS" }, 500);
  assert.deepEqual(ios.operating_systems, ["IOS"]);
  assert.ok(summarizeLaunchSettings(ios).includes("App install · App Store"));
  // The website shape sheds the app field.
  assert.equal(validateLaunchSettings({ ...defaultWebsitePurchaseSettings(), app_platform: "ANDROID" }, 500).app_platform, undefined);
});

test("adGroupBody: the app's store as the optimization location, the app id, INSTALL on oCPM, the operating system, no pixel", () => {
  const s = validateLaunchSettings(app(), 500);
  assert.throws(() => adGroupBody(s, plan(s)), LaunchSettingsError, "no body without the resolved app id");
  const body = adGroupBody(s, plan(s), null, { app_id: FAKE_APP_ID });
  assert.deepEqual([body.promotion_type, body.app_id, body.optimization_goal, body.billing_event, body.operating_systems], ["APP_ANDROID", FAKE_APP_ID, "INSTALL", "OCPM", ["ANDROID"]]);
  for (const key of ["pixel_id", "optimization_event", "promotion_website_type", "click_attribution_window", "view_attribution_window", "attribution_event_count"]) assert.equal(body[key], undefined, key);
  assert.equal(body.bid_type, "BID_TYPE_NO_BID");
  const ios = validateLaunchSettings({ ...app(), app_platform: "IOS" }, 500);
  assert.equal(adGroupBody(ios, plan(ios), null, { app_id: FAKE_APP_ID }).promotion_type, "APP_IOS");
});

// ---- the app --------------------------------------------------------------------------------------------------

test("the app settings: the crazydramas package by default, TIKTOK_APP_PACKAGE overrides it; TIKTOK_PROMOTED_APP_ID blank is none, a 10–20 digit id is its shape", () => {
  assert.equal(tiktokAppPackage(), CRAZYDRAMAS_ANDROID_PACKAGE);
  assert.equal(playStoreUrl(CRAZYDRAMAS_ANDROID_PACKAGE), "https://play.google.com/store/apps/details?id=com.crazydrama.app");
  process.env.TIKTOK_APP_PACKAGE = " com.example.other ";
  assert.equal(tiktokAppPackage(), "com.example.other");
  assert.equal(tiktokAppId(), null);
  process.env.TIKTOK_PROMOTED_APP_ID = `  ${HAND_SET_APP} `;
  assert.equal(tiktokAppId(), HAND_SET_APP);
  for (const good of [HAND_SET_APP, FAKE_APP_ID, "1".repeat(10), "1".repeat(20)]) assert.ok(APP_ID_SHAPE.test(good), good);
  for (const bad of ["1".repeat(9), "1".repeat(21), "com.crazydrama.app", "7290-0000"]) assert.ok(!APP_ID_SHAPE.test(bad), bad);
});

test("appFromList: the row that names the package wins, whatever TikTok calls its fields; nothing listed says where to register the app", () => {
  const rows = [
    { app_id: "1", app_name: "Other", platform: "ANDROID", package_name: "com.other.app" },
    { app_id: "2", app_name: "Crazy Drama iOS", platform: "IOS", bundle_id: "com.crazydrama.app" },
    { app_id: "3", app_name: "Crazy Drama", app_platform_id: "2", download_url: playStoreUrl("com.crazydrama.app") },
  ];
  const android = appFromList(rows, "com.crazydrama.app", "ANDROID", "700");
  assert.ok(android.ok && android.app_id === "3" && android.relation === "LISTED" && android.name === "Crazy Drama");
  const ios = appFromList(rows, "com.crazydrama.app", "IOS", "700");
  assert.ok(ios.ok && ios.app_id === "2");
  const none = appFromList(rows.slice(0, 1), "com.crazydrama.app", "ANDROID", "700");
  assert.ok(!none.ok && none.reason === "not_found" && /no Google Play app registered for com.crazydrama.app/.test(none.message) && /Assets → Events → App/.test(none.message));
});

test("resolveApp: listed resolves to its id; a hand-set id that disagrees is refused with both numbers; a bad hand-set id is refused by name before any read", async () => {
  const listed = await resolveApp(fakeTransport, "fake-token", "700");
  assert.ok(listed.ok && listed.app_id === FAKE_APP_ID && listed.relation === "LISTED");
  process.env.TIKTOK_PROMOTED_APP_ID = HAND_SET_APP;
  const differs = await resolveApp(fakeTransport, "fake-token", "700");
  assert.ok(!differs.ok && differs.reason === "app_id_differs" && differs.message.includes(FAKE_APP_ID) && differs.message.includes(HAND_SET_APP));
  process.env.TIKTOK_PROMOTED_APP_ID = "not-an-id";
  const reads: string[] = [];
  fakeTransport.get = async (path, token, query) => { reads.push(path); return originalGet.call(fakeTransport, path, token, query); };
  const bad = await resolveApp(fakeTransport, "fake-token", "700");
  assert.ok(!bad.ok && bad.reason === "bad_app_id" && /TIKTOK_PROMOTED_APP_ID/.test(bad.message));
  assert.deepEqual(reads, [], "nothing read for a malformed setting");
});

test("refused for the permission: with TIKTOK_PROMOTED_APP_ID set, ok and unverified in plain words; without it, the refusal says which permission and what to set", async () => {
  process.env.TIKTOK_FAKE_APP = "unreadable";
  const refused = await resolveApp(fakeTransport, "fake-token", "700");
  assert.ok(!refused.ok && refused.reason === "no_permission" && /App Management permission/.test(refused.message) && /TIKTOK_PROMOTED_APP_ID/.test(refused.message));
  process.env.TIKTOK_PROMOTED_APP_ID = HAND_SET_APP;
  const handSet = await resolveApp(fakeTransport, "fake-token", "700");
  assert.ok(handSet.ok && handSet.relation === "UNVERIFIED" && handSet.app_id === HAND_SET_APP && /set by hand/.test(handSet.note));
  assert.equal(planAppNote(en, { package: CRAZYDRAMAS_ANDROID_PACKAGE, accounts: [{ app_id: HAND_SET_APP, unverified: true }] }), en("lpx.appUnverified", { id: HAND_SET_APP, package: CRAZYDRAMAS_ANDROID_PACKAGE }));
  assert.equal(planAppNote(en, { package: CRAZYDRAMAS_ANDROID_PACKAGE, accounts: [{ app_id: FAKE_APP_ID }] }), undefined);
});

// ---- the fake's refusals ------------------------------------------------------------------------------------

test("the fake refuses what the docs name: an app campaign without its type, an app group without app_id, an unknown app, no operating system, INSTALL off APP_PROMOTION, app_id on a website group", async () => {
  const adv = "7000000000000000001";
  const noType = await fakeTransport.post("/campaign/create/", "fake-token", { advertiser_id: adv, campaign_name: "app-no-type", objective_type: "APP_PROMOTION", budget_mode: "BUDGET_MODE_INFINITE" });
  assert.notEqual(noType.code, 0); assert.match(noType.message, /app_promotion_type is required/);
  const campaign = await fakeTransport.post("/campaign/create/", "fake-token", { advertiser_id: adv, campaign_name: "app-ok", objective_type: "APP_PROMOTION", app_promotion_type: "APP_INSTALL", budget_mode: "BUDGET_MODE_INFINITE" });
  assert.equal(campaign.code, 0);
  const campaignId = (campaign.data as { campaign_id: string }).campaign_id;
  const s = validateLaunchSettings(app(), 500);
  const good = { advertiser_id: adv, campaign_id: campaignId, adgroup_name: "g", ...adGroupBody(s, plan(s), null, { app_id: FAKE_APP_ID }) };
  const refusal = async (body: Record<string, unknown>) => { const r = await fakeTransport.post("/adgroup/create/", "fake-token", body); assert.notEqual(r.code, 0, JSON.stringify(body)); return r.message; };
  assert.match(await refusal({ ...good, adgroup_name: "a", app_id: undefined }), /app_id is required/);
  assert.match(await refusal({ ...good, adgroup_name: "b", app_id: "7290000000000000999" }), /not an app of this advertiser/);
  assert.match(await refusal({ ...good, adgroup_name: "c", operating_systems: undefined }), /operating_systems is required/);
  // The pixel rule speaks first (pixel_id off CONVERT); the app rule would say the same in its own words.
  assert.match(await refusal({ ...good, adgroup_name: "d", pixel_id: "1790000000000000001" }), /pixel_id is not supported/);
  const ok = await fakeTransport.post("/adgroup/create/", "fake-token", { ...good, adgroup_name: "e" });
  assert.equal(ok.code, 0, ok.message);
  // A website campaign takes no app and no INSTALL.
  const web = await fakeTransport.post("/campaign/create/", "fake-token", { advertiser_id: adv, campaign_name: "web", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_INFINITE" });
  const webId = (web.data as { campaign_id: string }).campaign_id;
  assert.match(await refusal({ ...good, campaign_id: webId, adgroup_name: "f" }), /INSTALL is not supported by objective TRAFFIC|app_id is not supported/);
});

// ---- the driver ----------------------------------------------------------------------------------------------

function context(settings: LaunchSettings, businessId = "bc-1"): DriverContext {
  const campaign: LaunchCampaign = {
    id: "row-1", run_id: "run-1", index: 1, connection_id: "connection-1", advertiser_id: "7000000000000000001", name: "app-a1b2c3d4e5f6-001",
    campid: "app-a1b2c3d4e5f6-001",
    content: [{ kind: "spark", value: "good-one" }], budget_cents: 12000, daily_budget_cents: 3000,
    status: "running", state: {}, error: null, snapshot: null,
  };
  const run: LaunchRun = {
    id: "run-1", external_id: "lr_a1b2c3d4e5f6", producer_id: FIXTURE_PRODUCER_ID, round: 1, parent_run_id: null, status: "running", revision: 1,
    snapshot_hash: null, approved_by: "approver-1", approved_at: new Date().toISOString(), approval_note: null,
    created_by: "approver-1", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mode: "fake", error: null,
    campaigns: [campaign], lease_owner: "worker", lease_until: new Date(Date.now() + 60_000).toISOString(),
    draft: { ...defaultLaunchDraft("tiktok"), name: "App launch", account_ids: ["connection-1"], content_per_campaign: 1, content: campaign.content,
      destination_url: "", total_budget_cents: 12000, daily_budget_cents: 3000, start_paused: true, tiktok_settings: settings },
  };
  run.connections = [{ id: "connection-1", producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: campaign.advertiser_id, name: "TikTok test", currency: "USD", timezone: "", page_id: null, instagram_id: null, business_id: businessId, assigned_by: "staff-1", verified_at: "", enabled: true }];
  run.snapshot_hash = launchHash(run.draft, run.connections, run.campaigns);
  return { run, campaign, connection: run.connections[0],
    checkpoint: async (patch) => { campaign.state = { ...campaign.state, ...structuredClone(patch) }; }, assertActive: async () => {} };
}

test("an App install launch resolves the app, sends APP_PROMOTION / APP_INSTALL on the campaign, the app on the ad group, and no link on the ad", async () => {
  const ctx = context(app());
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  fakeTransport.post = async (path, token, body) => { writes.push({ path, body: structuredClone(body) }); return originalPost(path, token, body); };
  await tiktokSparkDriver.launch(ctx);
  assert.deepEqual(ctx.campaign.state.app, { package: CRAZYDRAMAS_ANDROID_PACKAGE, platform: "ANDROID", app_id: FAKE_APP_ID });
  assert.equal(ctx.campaign.state.pixel, undefined, "no pixel on an app launch");
  const campaign = writes.find((w) => w.path === "/campaign/create/")!.body;
  assert.deepEqual([campaign.objective_type, campaign.app_promotion_type, campaign.virtual_objective_type], ["APP_PROMOTION", "APP_INSTALL", undefined]);
  const group = writes.find((w) => w.path === "/adgroup/create/")!.body;
  assert.deepEqual([group.promotion_type, group.app_id, group.optimization_goal, group.billing_event, group.operating_systems, group.pixel_id], ["APP_ANDROID", FAKE_APP_ID, "INSTALL", "OCPM", ["ANDROID"], undefined]);
  const ads = fakeTikTokSnapshot().ads;
  assert.equal(ads.length, 1);
  assert.equal(ads[0].body.landing_page_url, undefined, "the ad opens the app's store listing");
  assert.equal(ads[0].body.page_id, undefined);
  assert.equal(ads[0].body.call_to_action, "INSTALL_NOW");
  assert.equal(writes.some((w) => w.path.startsWith("/page/")), false, "no Instant Page is built");
});

test("refused for the permission with TIKTOK_PROMOTED_APP_ID set, the driver launches with that id, recorded unverified; without it nothing is written", async () => {
  process.env.TIKTOK_FAKE_APP = "unreadable";
  process.env.TIKTOK_PROMOTED_APP_ID = HAND_SET_APP;
  const ctx = context(app());
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  fakeTransport.post = async (path, token, body) => { writes.push({ path, body: structuredClone(body) }); return originalPost(path, token, body); };
  await tiktokSparkDriver.launch(ctx);
  assert.deepEqual(ctx.campaign.state.app, { package: CRAZYDRAMAS_ANDROID_PACKAGE, platform: "ANDROID", app_id: HAND_SET_APP, unverified: true });
  assert.equal(writes.find((w) => w.path === "/adgroup/create/")!.body.app_id, HAND_SET_APP);
  resetFakeTikTok();
  delete process.env.TIKTOK_PROMOTED_APP_ID;
  const refused = context(app());
  writes.length = 0;
  await assert.rejects(tiktokSparkDriver.launch(refused), /doesn't have the app permission/);
  assert.deepEqual(writes, []);
});

// ---- the data layer -------------------------------------------------------------------------------------------

const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");
async function tiktokAccounts(count: number): Promise<LaunchConnection[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => getData().assignLaunchConnection(staff(), {
    producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: `700000000000000000${i + 1}`, name: `TikTok ${i + 1}`,
    currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true,
  })));
}
function appDraft(accounts: LaunchConnection[]): LaunchDraft {
  return { ...defaultLaunchDraft("tiktok"), name: "App launch", account_ids: accounts.map((a) => a.id), content_per_campaign: 1, allocation: "shared",
    content: [{ kind: "spark", value: "good-one" }], title_id: null, destination_url: "https://example.com/typed", total_budget_cents: 20000, daily_budget_cents: 3000,
    tiktok_settings: defaultAppInstallSettings() };
}

test("the planner takes an App install draft with no title and no link", () => {
  const connection: LaunchConnection = { id: "c1", producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: "7000000000000000001", name: "TikTok", currency: "USD", timezone: "", page_id: null, instagram_id: null, business_id: null, assigned_by: "staff-1", verified_at: "", enabled: true };
  const draft = { ...appDraft([connection]), destination_url: "" };
  const built = buildLaunchPlan(draft, [connection]);
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0].tracking_url, undefined, "no link to track");
  assert.throws(() => buildLaunchPlan({ ...draft, tiktok_settings: defaultWebsitePurchaseSettings() }, [connection]), /crazydramas page/, "a website launch still needs its link");
});

test("save keeps an App install draft free of links and pixel; preview resolves the app on every account; approval passes; a missing app refuses in plain words", async () => {
  const accounts = await tiktokAccounts(2);
  const saved = await getData().saveLaunchDraft(producer(), appDraft(accounts));
  assert.equal(saved.draft.destination_url, "", "no link on an app launch");
  assert.equal(saved.draft.tiktok_settings.pixel_code, undefined);
  assert.ok(saved.draft.content.every((c) => c.landing_url === undefined));
  const preview = await getData().previewLaunchRun(producer(), saved.id);
  assert.equal(preview.tiktok_pixel, undefined);
  assert.deepEqual(preview.tiktok_app, { package: CRAZYDRAMAS_ANDROID_PACKAGE, platform: "ANDROID", store_url: playStoreUrl(CRAZYDRAMAS_ANDROID_PACKAGE),
    accounts: accounts.map((a) => ({ connection_id: a.id, app_id: FAKE_APP_ID })) });
  assert.ok(preview.rows.every((row) => row.tracking_url === undefined && row.content.every((c) => c.landing_url === undefined)));
  const approved = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  assert.equal(approved.status, "pending");
  // The app is read again at approval: an app unregistered in between stops here.
  process.env.TIKTOK_FAKE_APP = "missing";
  const again = await getData().saveLaunchDraft(producer(), appDraft(accounts));
  await assert.rejects(getData().previewLaunchRun(producer(), again.id), /no Google Play app registered for com\.crazydrama\.app/);
});

test("refused for the permission with TIKTOK_PROMOTED_APP_ID set, preview and approval pass and say the id is set by hand", async () => {
  process.env.TIKTOK_FAKE_APP = "unreadable";
  process.env.TIKTOK_PROMOTED_APP_ID = HAND_SET_APP;
  const accounts = await tiktokAccounts(1);
  const saved = await getData().saveLaunchDraft(producer(), appDraft(accounts));
  const preview = await getData().previewLaunchRun(producer(), saved.id);
  assert.deepEqual(preview.tiktok_app?.accounts, [{ connection_id: accounts[0].id, app_id: HAND_SET_APP, unverified: true }]);
  assert.ok(planAppNote(en, preview.tiktok_app)?.includes(HAND_SET_APP));
  const approved = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  assert.equal(approved.status, "pending");
  delete process.env.TIKTOK_PROMOTED_APP_ID;
  const refused = await getData().saveLaunchDraft(producer(), appDraft(accounts));
  await assert.rejects(getData().previewLaunchRun(producer(), refused.id), /doesn't have the app permission/);
});
