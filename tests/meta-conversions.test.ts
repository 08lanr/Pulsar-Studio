import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { DriverContext, LaunchCampaign, LaunchConnection, LaunchContent, LaunchRun, MetaLaunchSettings } from "@/lib/launch/types";
import { defaultLaunchSettings } from "@/lib/tiktok/settings";
import { launchHash } from "@/lib/data/launch";
import { createMetaDriver } from "@/lib/meta/driver";
import { FakeMetaTransport } from "@/lib/meta/fake";
import { CRAZYDRAMAS_META_PIXEL_ID, DEFAULT_META_CONVERSION_EVENT, META_ACTION_TYPES, META_ATTRIBUTION_LABEL, META_CONVERSION_EVENTS, metaPixelId } from "@/lib/meta/pixel";
import { draftSchema, metaConversionIssues, metaObjectiveSettings } from "@/lib/launch/plan";
import { crazydramasAdUrlFor } from "@/lib/tiktok/ad-url";

// Meta conversions (decision 2026-09-25): a Sales campaign optimizes toward a
// crazydramas pixel event. The pixel is resolved on the ad account before any
// paid object exists, the ad set names it, and the Monitor counts that event
// alone. Fixture mode never reaches Meta: the fake models what Meta refuses.

const LINK = crazydramasAdUrlFor("reborn-as-the-ceos-first-love", "meta");
const originalSource = process.env.DATA_SOURCE;
const originalPixel = process.env.META_PIXEL_ID;
afterEach(() => {
  if (originalSource === undefined) delete process.env.DATA_SOURCE; else process.env.DATA_SOURCE = originalSource;
  if (originalPixel === undefined) delete process.env.META_PIXEL_ID; else process.env.META_PIXEL_ID = originalPixel;
});

function salesSettings(over: Partial<MetaLaunchSettings> = {}): MetaLaunchSettings {
  return { countries: ["US"], placements: ["facebook"], objective: "OUTCOME_SALES", optimization_goal: "OFFSITE_CONVERSIONS",
    conversion_event: "INITIATED_CHECKOUT", pixel_id: CRAZYDRAMAS_META_PIXEL_ID, bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    bid_cents: null, call_to_action: "WATCH_MORE", start_time: "2030-01-01T00:00:00Z", end_time: "2030-01-08T00:00:00Z", ...over };
}
function trafficSettings(): MetaLaunchSettings {
  return { ...salesSettings(), objective: "OUTCOME_TRAFFIC", optimization_goal: "LINK_CLICKS", conversion_event: null, pixel_id: null };
}

function context(settings: MetaLaunchSettings, content: LaunchContent[] = [{ kind: "facebook_post", value: "demo-page_123" }]): DriverContext {
  process.env.DATA_SOURCE = "fixture";
  const connection: LaunchConnection = { id: "connection", producer_id: "company", provider: "meta", advertiser_id: "demo-meta", name: "Meta Demo", currency: "USD", timezone: "America/Los_Angeles", page_id: "demo-page", instagram_id: "demo-instagram", business_id: null, assigned_by: "staff", verified_at: new Date().toISOString(), enabled: true };
  const campaign: LaunchCampaign = { id: "campaign-row", run_id: "run", index: 1, connection_id: connection.id, advertiser_id: connection.advertiser_id, name: "Campaign", content, budget_cents: 10000, daily_budget_cents: null, status: "running", state: {}, error: null, snapshot: null };
  const run: LaunchRun = {
    id: "run", external_id: "lr_conv", producer_id: "company", round: 1, parent_run_id: null, status: "running", revision: 1, snapshot_hash: null, approved_by: "approver", approved_at: new Date().toISOString(), approval_note: null, created_by: "producer", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mode: "fake", error: null, campaigns: [campaign], connections: [connection], lease_owner: "worker", lease_until: null,
    draft: { provider: "meta", name: "Round", account_ids: [connection.id], campaigns_per_account: 1, content_per_campaign: content.length, allocation: "shared", content, destination_url: LINK, total_budget_cents: 10000, daily_budget_cents: null, start_paused: true, tiktok_settings: defaultLaunchSettings(), meta_settings: settings },
  };
  run.snapshot_hash = launchHash(run.draft, run.connections!);
  return { run, campaign, connection, checkpoint: async patch => { Object.assign(campaign.state, structuredClone(patch)); }, assertActive: async () => {} };
}

const sent = (t: FakeMetaTransport, edge: string) => t.calls
  .filter(c => c.method === "POST" && c.path.endsWith(`/${edge}`) && !(c.params.execution_options as unknown[] | undefined)?.length)
  .map(c => c.params);

test("a Sales campaign names the pixel, the event and the attribution window on every ad set", async () => {
  const transport = new FakeMetaTransport();
  await createMetaDriver(transport).launch(context(salesSettings()));
  const [campaign] = sent(transport, "campaigns");
  assert.equal(campaign.objective, "OUTCOME_SALES");
  const [adset] = sent(transport, "adsets");
  assert.equal(adset.optimization_goal, "OFFSITE_CONVERSIONS");
  assert.deepEqual(adset.promoted_object, { pixel_id: CRAZYDRAMAS_META_PIXEL_ID, custom_event_type: "INITIATED_CHECKOUT" });
  assert.deepEqual(adset.attribution_spec, [{ event_type: "CLICK_THROUGH", window_days: 7 }, { event_type: "VIEW_THROUGH", window_days: 1 }]);
});

test("a Traffic campaign carries no pixel, sends no promoted_object and never reads the pixel list", async () => {
  const transport = new FakeMetaTransport();
  await createMetaDriver(transport).launch(context(trafficSettings()));
  const [campaign] = sent(transport, "campaigns");
  assert.equal(campaign.objective, "OUTCOME_TRAFFIC");
  assert.equal(sent(transport, "adsets")[0].promoted_object, undefined);
  assert.equal(transport.calls.some(c => c.path.endsWith("/adspixels")), false);
});

test("a pixel the ad account cannot use stops the launch before anything is created", async () => {
  const transport = new FakeMetaTransport();
  transport.pixels = [{ id: "9999999999999", name: "Someone else" }];
  await assert.rejects(createMetaDriver(transport).launch(context(salesSettings())), /not shared with this ad account/);
  assert.equal(transport.calls.some(c => c.method === "POST" && c.path.endsWith("/campaigns")), false);
});

test("a pixel the account has lost access to is refused rather than optimized toward", async () => {
  const transport = new FakeMetaTransport();
  transport.pixels = [{ id: CRAZYDRAMAS_META_PIXEL_ID, name: "CrazyDramas", is_unavailable: true }];
  await assert.rejects(createMetaDriver(transport).launch(context(salesSettings())), /unavailable to this ad account/);
});

test("an approved pixel that is no longer the account's pixel needs a new round", async () => {
  process.env.META_PIXEL_ID = "1234567890123";
  const transport = new FakeMetaTransport();
  transport.pixels = [{ id: "1234567890123", name: "Another" }];
  await assert.rejects(createMetaDriver(transport).launch(context(salesSettings())), /Create and approve a new round/);
});

test("Meta refusing the pixel list for want of the permission still launches, marked unverified", async () => {
  const transport = new FakeMetaTransport();
  transport.pixelReadRefused = true;
  const ctx = context(salesSettings());
  await createMetaDriver(transport).launch(ctx);
  assert.deepEqual(sent(transport, "adsets")[0].promoted_object, { pixel_id: CRAZYDRAMAS_META_PIXEL_ID, custom_event_type: "INITIATED_CHECKOUT" });
  assert.equal((ctx.campaign.state.meta as { pixel_id?: string }).pixel_id, CRAZYDRAMAS_META_PIXEL_ID);
});

test("a Sales launch that names no event or no pixel is refused, never sent as Traffic", async () => {
  await assert.rejects(createMetaDriver(new FakeMetaTransport()).launch(context(salesSettings({ conversion_event: null }))), /names none/);
  await assert.rejects(createMetaDriver(new FakeMetaTransport()).launch(context(salesSettings({ pixel_id: null }))), /names no pixel/);
});

test("the monitor counts the approved event alone, with what it was worth", async () => {
  const transport = new FakeMetaTransport();
  transport.conversions = 12;
  transport.conversionValue = 47.5;
  const ctx = context(salesSettings());
  const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  const snapshot = await driver.monitor(ctx);
  assert.equal(snapshot.conversions, 12);
  assert.equal(snapshot.conversion_value_cents, 4750);
  // The read asked for the actions, not just the click columns.
  const insights = transport.calls.find(c => c.path.endsWith("/insights"));
  assert.match(String(insights?.params.fields), /actions,action_values/);
});

test("a Traffic campaign reports no conversions rather than zero", async () => {
  const transport = new FakeMetaTransport();
  transport.conversions = 9;
  const ctx = context(trafficSettings());
  const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  const snapshot = await driver.monitor(ctx);
  assert.equal(snapshot.conversions, null);
  assert.equal(snapshot.conversion_value_cents, null);
});

test("an action Meta reports that is not the approved event is never counted as one", async () => {
  const transport = new FakeMetaTransport();
  transport.conversions = 30;
  const ctx = context(salesSettings({ conversion_event: "PURCHASE" }));
  const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  assert.notEqual(META_ACTION_TYPES.PURCHASE, META_ACTION_TYPES.INITIATED_CHECKOUT);
  assert.equal((await driver.monitor(ctx)).conversions, 30);
  // The ad set still optimizes toward PURCHASE; a run read as ADD_TO_CART
  // finds no such row and says "not reported", never 0.
  ctx.run.draft.meta_settings = { ...ctx.run.draft.meta_settings, conversion_event: "ADD_TO_CART" };
  assert.equal((await driver.monitor(ctx)).conversions, null);
});

test("the objective and the goal move together, and switching back clears the pixel", () => {
  const sales = metaObjectiveSettings(trafficSettings(), "OUTCOME_SALES");
  assert.equal(sales.optimization_goal, "OFFSITE_CONVERSIONS");
  assert.equal(sales.conversion_event, "INITIATED_CHECKOUT");
  const back = metaObjectiveSettings(salesSettings(), "OUTCOME_TRAFFIC");
  assert.equal(back.optimization_goal, "LINK_CLICKS");
  assert.equal(back.conversion_event, null);
  assert.equal(back.pixel_id, null);
});

test("the plan refuses every conversions combination Meta would reject", () => {
  const codes = (s: MetaLaunchSettings, url = LINK) => metaConversionIssues(s, url).map(i => i.code);
  assert.deepEqual(codes(trafficSettings()), []);
  assert.deepEqual(codes(salesSettings()), []);
  assert.deepEqual(codes({ ...salesSettings(), optimization_goal: "LINK_CLICKS" }), ["conversionGoal"]);
  assert.deepEqual(codes({ ...trafficSettings(), optimization_goal: "OFFSITE_CONVERSIONS" }), ["conversionObjective"]);
  assert.deepEqual(codes(salesSettings({ conversion_event: null })), ["conversionEvent"]);
  // A missing pixel is the server's to resolve, so the panel stays quiet about it.
  assert.deepEqual(codes(salesSettings({ pixel_id: null })), []);
  assert.deepEqual(codes(salesSettings({ pixel_id: "nope" })), ["conversionPixelShape"]);
  assert.deepEqual(codes({ ...trafficSettings(), conversion_event: "PURCHASE", pixel_id: "1234567890123" }), ["conversionEventUnused", "conversionPixelUnused"]);
  // The pixel only fires on crazydramas, so an ad pointing elsewhere can never report one.
  assert.deepEqual(codes(salesSettings(), "https://example.com/watch"), ["conversionLink"]);
  assert.deepEqual(codes(salesSettings(), crazydramasAdUrlFor("reborn-as-the-ceos-first-love", "tiktok")), ["conversionLink"]);
});

test("the configured pixel is crazydramas' own, and a typo never reaches a promoted_object", () => {
  delete process.env.META_PIXEL_ID;
  assert.equal(metaPixelId(), CRAZYDRAMAS_META_PIXEL_ID);
  process.env.META_PIXEL_ID = "not-a-pixel";
  assert.throws(() => metaPixelId(), /numeric Meta pixel id/);
  assert.equal(META_ATTRIBUTION_LABEL, "7-day click, 1-day view");
});

test("every event Studio offers is one Meta's promoted_object actually takes", () => {
  // Meta's ad set enum is not the pixel's spelling: InitiateCheckout is sent as
  // INITIATED_CHECKOUT and ViewContent as CONTENT_VIEW. Getting this wrong
  // fails the ad set create after the campaign already exists, so the fake
  // refuses anything outside the enum and this pins the exact strings.
  assert.deepEqual([...META_CONVERSION_EVENTS],
    ["PURCHASE", "INITIATED_CHECKOUT", "ADD_TO_CART", "CONTENT_VIEW", "COMPLETE_REGISTRATION"]);
  assert.equal(DEFAULT_META_CONVERSION_EVENT, "INITIATED_CHECKOUT");
});

test("an event outside Meta's enum is refused by the fake, not sent", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context(salesSettings());
  // Past the typed API the way a stored row written by an older build would
  // be, then re-signed so the run is approved for exactly what it carries.
  (ctx.run.draft.meta_settings as { conversion_event: string }).conversion_event = "INITIATE_CHECKOUT";
  ctx.run.snapshot_hash = launchHash(ctx.run.draft, ctx.run.connections!);
  await assert.rejects(createMetaDriver(transport).launch(ctx), /not a valid custom_event_type/);
});

test("a Meta draft saved before conversions landed still validates, as Traffic", () => {
  const legacy = { countries: ["US"], placements: ["facebook"], optimization_goal: "LINK_CLICKS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cents: null, call_to_action: "LEARN_MORE",
    start_time: "2030-01-01T00:00:00Z", end_time: "2030-01-08T00:00:00Z" };
  const parsed = draftSchema.safeParse({ provider: "meta", name: "Old round", account_ids: ["a"], campaigns_per_account: 1,
    content_per_campaign: 1, allocation: "shared", content: [], destination_url: LINK, total_budget_cents: 10000,
    daily_budget_cents: null, start_paused: true, tiktok_settings: defaultLaunchSettings(), meta_settings: legacy });
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.equal(parsed.data!.meta_settings.objective, "OUTCOME_TRAFFIC");
  assert.equal(parsed.data!.meta_settings.conversion_event, null);
  assert.equal(parsed.data!.meta_settings.pixel_id, null);
});

test("a run approved before conversions landed still names an objective on create", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context(trafficSettings());
  // The stored draft is JSON in the database, never re-validated by zod.
  delete (ctx.run.draft.meta_settings as { objective?: string }).objective;
  ctx.run.snapshot_hash = launchHash(ctx.run.draft, ctx.run.connections!);
  await createMetaDriver(transport).launch(ctx);
  assert.equal(sent(transport, "campaigns")[0].objective, "OUTCOME_TRAFFIC");
});

test("switching objective drops a bid cap priced for the other thing", () => {
  const capped = { ...trafficSettings(), bid_strategy: "LOWEST_COST_WITH_BID_CAP" as const, bid_cents: 40 };
  const sales = metaObjectiveSettings(capped, "OUTCOME_SALES");
  assert.equal(sales.bid_cents, null);
  assert.equal(sales.bid_strategy, "LOWEST_COST_WITHOUT_CAP");
  // Staying on the same objective changes nothing at all.
  assert.equal(metaObjectiveSettings(capped, "OUTCOME_TRAFFIC"), capped);
});
