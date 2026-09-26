import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import type { DriverContext, LaunchCampaign, LaunchRun } from "@/lib/launch/types";
import { fakeTikTokSnapshot, fakeTransport, resetFakeTikTok, seedFakeInstantPages } from "@/lib/tiktok/fake";
import { defaultLaunchSettings, defaultSalesLaunchSettings } from "@/lib/tiktok/settings";
import { reconcileTikTokSparks, redeemSparkCodes, tiktokSparkDriver } from "@/lib/tiktok/spark-driver";
import { launchHash } from "@/lib/data/launch";

beforeEach(() => { process.env.FIXTURE_SEED = "empty"; process.env.DATA_SOURCE = "fixture"; delete process.env.TIKTOK_LIVE; resetFakeTikTok(); });
afterEach(() => { delete process.env.TIKTOK_FAKE_ACCOUNT; delete process.env.TIKTOK_FAKE_REVIEW; resetFakeTikTok(); });

function context(codes = ["spark-one", "spark-two"], options: { copies?: number; paused?: boolean; budget?: number; daily?: number } = {}): DriverContext {
  const campaign: LaunchCampaign = {
    id: "row-1", run_id: "run-1", index: 1, connection_id: "connection-1", advertiser_id: "7000000000000000001", name: "Test launch",
    content: codes.map((value) => ({ kind: "spark", value })), budget_cents: options.budget ?? 12000, daily_budget_cents: options.daily ?? null,
    status: "running", state: {}, error: null, snapshot: null,
  };
  const run: LaunchRun = {
    id: "run-1", external_id: "ln_test", producer_id: "producer-1", round: 1, parent_run_id: null, status: "running", revision: 1,
    snapshot_hash: "approved-hash", approved_by: "approver-1", approved_at: new Date().toISOString(), approval_note: null,
    created_by: "approver-1", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mode: "fake", error: null,
    campaigns: [campaign], lease_owner: "worker", lease_until: new Date(Date.now() + 60_000).toISOString(),
    draft: {
      provider: "tiktok", name: "Test launch", account_ids: ["connection-1"], campaigns_per_account: 1, content_per_campaign: codes.length,
      allocation: "unique", content: campaign.content, destination_url: "https://crazydramas.com/watch", total_budget_cents: campaign.budget_cents,
      daily_budget_cents: campaign.daily_budget_cents, start_paused: options.paused ?? true,
      tiktok_settings: { ...defaultLaunchSettings(), duplicate_copies: options.copies ?? 0 },
      meta_settings: { countries: ["US"], placements: ["facebook", "instagram"], objective: "OUTCOME_TRAFFIC", optimization_goal: "LINK_CLICKS", conversion_event: null, pixel_id: null, bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cents: null,
        call_to_action: "LEARN_MORE", start_time: new Date().toISOString(), end_time: new Date(Date.now() + 86_400_000).toISOString() },
    },
  };
  const connection = { id: "connection-1", producer_id: "producer-1", provider: "tiktok" as const, advertiser_id: campaign.advertiser_id, name: "TikTok test", currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: "bc-1", assigned_by: "staff-1", verified_at: new Date().toISOString(), enabled: true };
  run.connections = [connection];
  run.snapshot_hash = launchHash(run.draft, run.connections);
  return { run, campaign, connection,
    checkpoint: async (patch) => { campaign.state = { ...campaign.state, ...structuredClone(patch) }; }, assertActive: async () => {},
  };
}

test("pasted Spark codes create AUTH_CODE ads with no files, uploads, cover or ad copy", async () => {
  const ctx = context();
  const original = fakeTransport.upload;
  fakeTransport.upload = async () => { throw new Error("Spark flow must not upload"); };
  try { await tiktokSparkDriver.launch(ctx); } finally { fakeTransport.upload = original; }
  const snapshot = fakeTikTokSnapshot();
  assert.equal(snapshot.campaigns.length, 1);
  assert.equal(snapshot.ads.length, 2);
  for (const ad of snapshot.ads) {
    assert.equal(ad.body.identity_type, "AUTH_CODE");
    assert.ok(ad.body.tiktok_item_id);
    assert.equal(ad.body.landing_page_url, ctx.run.draft.destination_url);
    for (const field of ["video_id", "image_ids", "ad_text"]) assert.equal(ad.body[field], undefined);
  }
  assert.equal(snapshot.campaigns[0].status, "DISABLE");
  await tiktokSparkDriver.control(ctx, { action: "resume" });
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "ENABLE");
  assert.equal(fakeTikTokSnapshot().adgroups[0].status, "ENABLE");
});

test("Sales saves and publishes one Instant Page before creating ads, then reuses it on retry", async () => {
  const ctx = context(["good-one"]);
  const originalPost = fakeTransport.post;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  fakeTransport.post = async (path, token, body) => {
    if (path === "/campaign/create/" || path === "/adgroup/create/") writes.push({ path, body: structuredClone(body) });
    return originalPost(path, token, body);
  };
  ctx.campaign.campid = "sales-test-a1b2c3d4e5f6-001";
  ctx.campaign.name = ctx.campaign.campid;
  ctx.campaign.tracking_url = `https://crazydramas.com/watch?campid=${ctx.campaign.campid}`;
  ctx.run.draft.tiktok_settings = defaultSalesLaunchSettings();
  ctx.run.draft.daily_budget_cents = 2000;
  ctx.campaign.daily_budget_cents = 2000;
  ctx.run.snapshot_hash = launchHash(ctx.run.draft, ctx.run.connections!, ctx.run.campaigns);
  const checkpoint = ctx.checkpoint;
  const phases: string[] = [];
  ctx.checkpoint = async (patch) => {
    const page = patch.instant_page as { phase: string } | undefined;
    if (page) phases.push(page.phase);
    await checkpoint(patch);
  };
  try { await tiktokSparkDriver.launch(ctx); } finally { fakeTransport.post = originalPost; }
  const page = ctx.campaign.state.instant_page as { id: string; phase: string };
  assert.deepEqual(phases, ["created", "published"], "fixture mode creates a deterministic page without network");
  assert.equal(page.phase, "published");
  assert.match(page.id, /^fake-tip-/);
  const first = fakeTikTokSnapshot();
  const campaignWrite = writes.find(write => write.path === "/campaign/create/")?.body;
  assert.ok(campaignWrite);
  assert.equal(campaignWrite.objective_type, "WEB_CONVERSIONS");
  assert.equal(campaignWrite.virtual_objective_type, "SALES");
  assert.equal(campaignWrite.sales_destination, "WEBSITE");
  assert.equal(campaignWrite.budget_mode, "BUDGET_MODE_TOTAL");
  assert.equal(campaignWrite.budget, 120, "the signed lifetime campaign cap remains in force");
  const groupWrite = writes.find(write => write.path === "/adgroup/create/")?.body;
  assert.ok(groupWrite);
  assert.equal(groupWrite.promotion_website_type, "TIKTOK_NATIVE_PAGE");
  assert.equal(groupWrite.optimization_event, "BUTTON");
  assert.equal(groupWrite.optimization_goal, "CONVERT");
  assert.equal(groupWrite.billing_event, "OCPM");
  assert.equal(groupWrite.conversion_bid_price, 0.2);
  assert.equal(groupWrite.bid_price, undefined);
  assert.equal(groupWrite.budget_mode, "BUDGET_MODE_DAY");
  assert.equal(groupWrite.budget, 20);
  assert.deepEqual(groupWrite.location_ids, ["6252001"]);
  assert.deepEqual(groupWrite.placements, ["PLACEMENT_TIKTOK"]);
  assert.equal(groupWrite.comment_disabled, true);
  assert.equal(first.ads.length, 1);
  assert.equal(first.ads[0].body.page_id, page.id);
  assert.equal(first.ads[0].body.landing_page_url, undefined);
  await tiktokSparkDriver.launch(ctx);
  assert.equal((ctx.campaign.state.instant_page as { id: string }).id, page.id);
  assert.equal(fakeTikTokSnapshot().ads.length, 1);
  assert.deepEqual(phases, ["created", "published"]);
});

test("all invalid Sparks create no campaign, group or ad; one bad code does not sink good siblings", async () => {
  const none = context(["expired-1", "private-1"]);
  await assert.rejects(tiktokSparkDriver.launch(none), /No Spark code resolved/);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 0);
  const mixed = context(["expired-1", "good-1", "reject-ad-1"]);
  await tiktokSparkDriver.launch(mixed);
  assert.equal(fakeTikTokSnapshot().ads.length, 1);
  assert.equal((mixed.campaign.state.skipped as unknown[]).length, 2);
});

test("redemption paginates and adopts a previously authorized code despite reauthorization refusal", async () => {
  const ctx = context();
  for (let i = 0; i < 101; i++) await fakeTransport.post("/tt_video/authorize/", "fake-token", { advertiser_id: ctx.campaign.advertiser_id, auth_code: `code-${i}` });
  const result = await redeemSparkCodes({ tt: fakeTransport, token: "fake-token", advertiser: ctx.campaign.advertiser_id }, ["code-100"], async () => {});
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].code, "code-100");
  assert.deepEqual(result.skipped, []);
});

test("a crash after remote ad creation adopts it on retry and never doubles campaign, group or ad", async () => {
  const ctx = context();
  const persist = ctx.checkpoint;
  let failOnce = true;
  ctx.checkpoint = async (patch) => {
    if (failOnce && Array.isArray(patch.groups) && patch.groups.some((g: { ads: Record<string, string> }) => Object.keys(g.ads).length)) {
      failOnce = false;
      throw new Error("simulated persistence interruption");
    }
    await persist(patch);
  };
  await assert.rejects(tiktokSparkDriver.launch(ctx), /simulated persistence/);
  assert.equal(fakeTikTokSnapshot().ads.length, 1);
  await tiktokSparkDriver.launch(ctx);
  await tiktokSparkDriver.launch(ctx);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 1);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1);
  assert.equal(fakeTikTokSnapshot().ads.length, 2);
});

test("a throttled second Spark stays pending and cannot activate until retry fills the same group", async () => {
  const ctx = context(["good-one", "good-two"], { paused: false });
  const original = fakeTransport.post;
  let adCreates = 0;
  fakeTransport.post = async (...args) => {
    if (args[0] === "/ad/create/" && ++adCreates === 2) return { code: 40100, message: "QPS limit 1" };
    return original(...args);
  };
  try { await assert.rejects(tiktokSparkDriver.launch(ctx), /pending|retry/i); }
  finally { fakeTransport.post = original; }
  const group = (ctx.campaign.state.groups as Array<{ id: string; ready?: boolean; ads: Record<string, string> }>)[0];
  assert.equal(group.ready, false);
  assert.equal(Object.keys(group.ads).length, 1);
  assert.equal((ctx.campaign.state.skipped as Array<{ code: string }> | undefined)?.some((item) => item.code === "good-two"), false);
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
  assert.equal(fakeTikTokSnapshot().adgroups[0].status, "DISABLE");
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "resume" }), /incomplete|pending/i);
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "group", group_id: group.id, enabled: true }), /incomplete|pending/i);
  await tiktokSparkDriver.launch(ctx);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 1);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1);
  assert.equal(fakeTikTokSnapshot().ads.length, 2);
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "ENABLE");
  assert.equal(fakeTikTokSnapshot().adgroups[0].status, "ENABLE");
});

test("an unfamiliar ad-create error keeps the approved Spark due for retry", async () => {
  const ctx = context(["good-one", "good-two"], { paused: false });
  const original = fakeTransport.post;
  let creates = 0;
  fakeTransport.post = async (...args) => {
    if (args[0] === "/ad/create/" && ++creates === 2) return { code: 47001, message: "unclassified advertiser response" };
    return original(...args);
  };
  try { await assert.rejects(tiktokSparkDriver.launch(ctx), /pending/); }
  finally { fakeTransport.post = original; }
  assert.equal(fakeTikTokSnapshot().ads.length, 1);
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
  assert.equal((ctx.campaign.state.skipped as Array<{ code: string }> | undefined)?.some((item) => item.code === "good-two"), false);
  await tiktokSparkDriver.launch(ctx);
  assert.equal(fakeTikTokSnapshot().ads.length, 2);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1);
});

test("an adoption lookup failure blocks creation instead of guessing nothing exists", async () => {
  const ctx = context();
  const original = fakeTransport.get;
  fakeTransport.get = async (path, token, params) => path === "/campaign/get/" ? { code: -1, message: "timeout" } : original(path, token, params);
  try { await assert.rejects(tiktokSparkDriver.launch(ctx), /timeout/); } finally { fakeTransport.get = original; }
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
});

test("automatic copies wait for review and divide the signed pot including its spare cents", async () => {
  const ctx = context(["good-one"], { copies: 2, budget: 12001, paused: false });
  await tiktokSparkDriver.launch(ctx);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1);
  assert.equal(fakeTikTokSnapshot().adgroups[0].budget, 40.01);
  await reconcileTikTokSparks(ctx);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1);
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  await reconcileTikTokSparks(ctx);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1, "first review is pending");
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  await reconcileTikTokSparks(ctx);
  await reconcileTikTokSparks(ctx);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 3);
  assert.equal(fakeTikTokSnapshot().ads.length, 3);
  assert.equal(Math.round(fakeTikTokSnapshot().adgroups.reduce((sum, g) => sum + g.budget, 0) * 100), 12001);
});

test("a throttled copy stays disabled and the next reconciliation fills it without another group", async () => {
  const ctx = context(["good-one", "good-two"], { copies: 1, paused: false });
  await tiktokSparkDriver.launch(ctx);
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  const original = fakeTransport.post;
  let creates = 0;
  fakeTransport.post = async (...args) => {
    if (args[0] === "/ad/create/" && ++creates === 2) return { code: 40100, message: "QPS limit 1" };
    return original(...args);
  };
  try { await assert.rejects(reconcileTikTokSparks(ctx), /pending|retry/i); }
  finally { fakeTransport.post = original; }
  assert.equal(fakeTikTokSnapshot().adgroups.length, 2);
  assert.equal(fakeTikTokSnapshot().adgroups[1].status, "DISABLE");
  assert.equal(fakeTikTokSnapshot().ads.length, 3);
  await reconcileTikTokSparks(ctx);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 2);
  assert.equal(fakeTikTokSnapshot().ads.length, 4);
  assert.equal(fakeTikTokSnapshot().adgroups[1].status, "ENABLE");
});

test("daily pacing divides across planned groups while a campaign lifetime cap bounds the signed total", async () => {
  const ctx = context(["good-one"], { copies: 1, budget: 15000, daily: 6000 });
  await tiktokSparkDriver.launch(ctx);
  assert.equal(fakeTikTokSnapshot().campaigns[0].budget, 150);
  assert.equal(fakeTikTokSnapshot().campaigns[0].budgetMode, "BUDGET_MODE_TOTAL");
  assert.equal(fakeTikTokSnapshot().adgroups[0].budget, 30);
  await tiktokSparkDriver.control(ctx, { action: "daily_budget", daily_budget_cents: 5000 });
  assert.equal(fakeTikTokSnapshot().adgroups[0].budget, 25);
  assert.deepEqual(ctx.campaign.state.planned_budgets, [2500, 2500]);
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "budget", budget_cents: 16000 }), /signed campaign ceiling/);
});

test("monitor reports unknown metrics on a failed read and a suspended account cannot fake a successful resume", async () => {
  const ctx = context();
  await tiktokSparkDriver.launch(ctx);
  const original = fakeTransport.get;
  fakeTransport.get = async (path, token, params) => path === "/report/integrated/get/" ? { code: -1, message: "report unavailable" } : original(path, token, params);
  try {
    const snapshot = await tiktokSparkDriver.monitor(ctx);
    assert.equal(snapshot.spend_cents, null);
    assert.equal(snapshot.impressions, null);
    assert.match(snapshot.note ?? "", /report unavailable/);
  } finally { fakeTransport.get = original; }
  process.env.TIKTOK_FAKE_ACCOUNT = "suspended";
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "resume" }), /did not confirm|did not apply|not ready/);
  assert.equal((await tiktokSparkDriver.monitor(ctx)).delivery, "suspended");
});

test("a revoked worker cannot authorize codes or create external objects", async () => {
  const ctx = context();
  ctx.assertActive = async () => { throw new Error("lease revoked"); };
  await assert.rejects(tiktokSparkDriver.launch(ctx), /lease revoked/);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
});

test("an ended campaign cannot be resumed", async () => {
  const ctx = context();
  await tiktokSparkDriver.launch(ctx);
  await tiktokSparkDriver.control(ctx, { action: "end" });
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "resume" }), /has ended/);
  assert.equal((await tiktokSparkDriver.monitor(ctx)).delivery, "ended");
});

test("campaign and group creation survive a checkpoint crash by exact-name adoption", async () => {
  for (const step of ["campaign_id", "groups"] as const) {
    resetFakeTikTok();
    const ctx = context(["good-one"]);
    const persist = ctx.checkpoint;
    let failOnce = true;
    ctx.checkpoint = async (patch) => {
      if (failOnce && step in patch) { failOnce = false; throw new Error("checkpoint crashed"); }
      await persist(patch);
    };
    await assert.rejects(tiktokSparkDriver.launch(ctx), /checkpoint crashed/);
    await tiktokSparkDriver.launch(ctx);
    assert.equal(fakeTikTokSnapshot().campaigns.length, 1, step);
    assert.equal(fakeTikTokSnapshot().adgroups.length, 1, step);
    assert.equal(fakeTikTokSnapshot().ads.length, 1, step);
  }
});

test("restoring a reduced budget before automatic copies reserves their signed shares", async () => {
  const ctx = context(["good-one"], { copies: 2, paused: false, budget: 15000 });
  await tiktokSparkDriver.launch(ctx);
  await tiktokSparkDriver.control(ctx, { action: "budget", budget_cents: 12000 });
  await tiktokSparkDriver.control(ctx, { action: "budget", budget_cents: 15000 });
  assert.equal(fakeTikTokSnapshot().adgroups[0].budget, 50);
  assert.deepEqual(ctx.campaign.state.planned_budgets, [5000, 5000, 5000]);
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  await reconcileTikTokSparks(ctx);
  assert.equal(fakeTikTokSnapshot().adgroups.reduce((sum, g) => sum + g.budget, 0), 150);
});

test("provider state above the signed ceiling cannot fund copies or resume", async () => {
  const ctx = context(["good-one"], { copies: 1, paused: false });
  await tiktokSparkDriver.launch(ctx);
  const before = fakeTikTokSnapshot();
  ctx.campaign.state.budget_cents = 20000;
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "duplicate" }), /signed campaign ceiling/);
  await assert.rejects(tiktokSparkDriver.launch(ctx), /signed campaign ceiling/);
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  await assert.rejects(reconcileTikTokSparks(ctx), /signed campaign ceiling/);
  assert.equal(fakeTikTokSnapshot().adgroups.length, before.adgroups.length);
  await tiktokSparkDriver.control(ctx, { action: "pause" });
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
});

test("resume refuses a remotely inflated lifetime ad group", async () => {
  const ctx = context(["good-one"]);
  await tiktokSparkDriver.launch(ctx);
  fakeTikTokSnapshot().adgroups[0].budget = 200;
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "resume" }), /remote|approved|budget/i);
  assert.equal(fakeTikTokSnapshot().adgroups[0].status, "DISABLE");
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
  await tiktokSparkDriver.control(ctx, { action: "pause" });
});

test("resume refuses a remotely inflated daily campaign lifetime cap", async () => {
  const ctx = context(["good-one"], { daily: 6000 });
  await tiktokSparkDriver.launch(ctx);
  fakeTikTokSnapshot().campaigns[0].budget = 200;
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "resume" }), /remote|approved|budget/i);
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
});

test("cost-cap replacement cannot inherit a remotely inflated old group budget", async () => {
  const ctx = context(["good-one"]);
  await tiktokSparkDriver.launch(ctx);
  fakeTikTokSnapshot().adgroups[0].budget = 200;
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "bid", bid_cents: 65 }), /remote|approved|budget/i);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1);
  assert.equal(fakeTikTokSnapshot().adgroups[0].status, "DISABLE");
});

test("resume refuses an untracked ad group under the approved campaign", async () => {
  const ctx = context(["good-one"]);
  await tiktokSparkDriver.launch(ctx);
  const created = await fakeTransport.post("/adgroup/create/", "fake-token", {
    advertiser_id: ctx.campaign.advertiser_id, campaign_id: ctx.campaign.state.campaign_id,
    adgroup_name: "operator-created-extra", budget_mode: "BUDGET_MODE_TOTAL", budget: 20, operation_status: "DISABLE",
  });
  assert.equal(created.code, 0);
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "resume" }), /remote TikTok ad groups differ/i);
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
});

test("retired group spend still counts against the lifetime cap on resume", async () => {
  const ctx = context(["good-one"]);
  await tiktokSparkDriver.launch(ctx);
  const oldId = fakeTikTokSnapshot().adgroups[0].adgroupId;
  const original = fakeTransport.get;
  fakeTransport.get = async (path, token, params) => path === "/report/integrated/get/" && params?.data_level === "AUCTION_ADGROUP"
    ? { code: 0, message: "OK", data: { list: [{ dimensions: { adgroup_id: oldId }, metrics: { spend: "10" } }], page_info: { total_page: 1 } } }
    : original(path, token, params);
  try {
    await tiktokSparkDriver.control(ctx, { action: "bid", bid_cents: 65 });
    fakeTikTokSnapshot().adgroups[1].budget = 120;
    await assert.rejects(tiktokSparkDriver.control(ctx, { action: "resume" }), /remote TikTok ad group budgets exceed/i);
    assert.equal(fakeTikTokSnapshot().adgroups[0].status, "DISABLE");
    assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
  } finally { fakeTransport.get = original; }
});

test("cost-cap replacement carries only the old group's unspent budget and keeps its paused state", async () => {
  const ctx = context(["good-one"]);
  await tiktokSparkDriver.launch(ctx);
  const oldId = fakeTikTokSnapshot().adgroups[0].adgroupId;
  const original = fakeTransport.get;
  fakeTransport.get = async (path, token, params) => path === "/report/integrated/get/" && params?.data_level === "AUCTION_ADGROUP"
    ? { code: 0, message: "OK", data: { list: [{ dimensions: { adgroup_id: oldId }, metrics: { spend: "10" } }], page_info: { total_page: 1 } } }
    : original(path, token, params);
  try { await tiktokSparkDriver.control(ctx, { action: "bid", bid_cents: 65 }); } finally { fakeTransport.get = original; }
  const snapshot = fakeTikTokSnapshot();
  assert.equal(snapshot.adgroups.length, 2);
  assert.equal(snapshot.adgroups[0].status, "DISABLE");
  const replacement = snapshot.adgroups[1];
  assert.equal(replacement.budget, 110);
  assert.equal(replacement.status, "DISABLE");
  assert.equal(replacement.bidType, "BID_TYPE_CUSTOM");
  assert.equal(replacement.bidPrice, 0.65);
  await tiktokSparkDriver.control(ctx, { action: "resume" });
  assert.equal(fakeTikTokSnapshot().adgroups[0].status, "DISABLE");
  assert.equal(fakeTikTokSnapshot().adgroups[1].status, "ENABLE");
});

test("manual copy redistributes the remaining pot and recovers a lost copy checkpoint", async () => {
  const ctx = context(["good-one"], { paused: false });
  await tiktokSparkDriver.launch(ctx);
  const persist = ctx.checkpoint;
  let failOnce = true;
  ctx.checkpoint = async (patch) => {
    if (failOnce && Array.isArray(patch.groups) && patch.groups.some((g: { key: string }) => g.key === "copy-1")) {
      failOnce = false;
      throw new Error("copy save crashed");
    }
    await persist(patch);
  };
  await assert.rejects(tiktokSparkDriver.control(ctx, { action: "duplicate" }), /copy save crashed/);
  await tiktokSparkDriver.control(ctx, { action: "duplicate" });
  const snapshot = fakeTikTokSnapshot();
  assert.equal(snapshot.adgroups.length, 2);
  assert.equal(snapshot.ads.length, 2);
  assert.ok(snapshot.adgroups.reduce((sum, g) => sum + g.budget, 0) <= 120);
  assert.equal(snapshot.campaigns[0].status, "ENABLE");
});

test("actual advertiser currency and status are verified before any Spark authorization or object creation", async () => {
  const originalGet = fakeTransport.get;
  const originalPost = fakeTransport.post;
  let writes = 0;
  fakeTransport.post = async (...args) => { writes++; return originalPost(...args); };
  try {
    for (const account of [
      { currency: "EUR", status: "STATUS_ENABLE" },
      { currency: "USD", status: "STATUS_PENDING_VERIFIED" },
      { currency: "USD", status: "UNRECOGNIZED_STATUS" },
      { currency: undefined, status: "STATUS_ENABLE" },
    ]) {
      const ctx = context();
      fakeTransport.get = async (path, token, params) => path === "/advertiser/info/"
        ? { code: 0, message: "OK", data: { list: [{ advertiser_id: ctx.campaign.advertiser_id, ...account }] } }
        : originalGet(path, token, params);
      await assert.rejects(tiktokSparkDriver.launch(ctx), /currency|not ready/);
    }
  } finally { fakeTransport.get = originalGet; fakeTransport.post = originalPost; }
  assert.equal(writes, 0);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
});

test("the driver independently rejects daily pacing below the minimum after dividing planned copies", async () => {
  const ctx = context(["good-one"], { copies: 2, budget: 12000, daily: 5999 });
  await assert.rejects(tiktokSparkDriver.launch(ctx), /minimum \$20/);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
});

test("paused preparation completes external objects without activating even when original settings said live", async () => {
  const ctx = context(["good-one"], { paused: false });
  ctx.campaign.state = { desired_status: "paused", prepare_while_paused: true };
  await tiktokSparkDriver.launch(ctx);
  assert.equal(fakeTikTokSnapshot().ads.length, 1);
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
  assert.equal(fakeTikTokSnapshot().adgroups[0].status, "DISABLE");
  assert.notEqual(ctx.campaign.state.activated, true);
  await tiktokSparkDriver.control(ctx, { action: "resume" });
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "ENABLE", "explicit resume can activate after preparation");
});

test("a stop noticed immediately before activation cannot enable groups or the campaign", async () => {
  const ctx = context(["good-one"], { paused: false });
  let writes = 0;
  ctx.assertActive = async () => {
    writes++;
    if (writes === 5) ctx.campaign.state = { ...ctx.campaign.state, desired_status: "paused", prepare_while_paused: true };
  };
  await assert.rejects(tiktokSparkDriver.launch(ctx), /Activation stopped/);
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
  assert.equal(fakeTikTokSnapshot().adgroups[0].status, "DISABLE");
});

test("pause and end before any campaign exists are harmless persisted controls", async () => {
  const ctx = context();
  await tiktokSparkDriver.control(ctx, { action: "pause" });
  assert.equal(ctx.campaign.state.paused, true);
  await tiktokSparkDriver.control(ctx, { action: "end" });
  assert.equal(ctx.campaign.state.ended, true);
  assert.equal((await tiktokSparkDriver.monitor(ctx)).delivery, "ended");
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
});

test("review-delayed copies move their start into the future without extending the approved end", async () => {
  const ctx = context(["good-one"], { copies: 1, paused: false });
  await tiktokSparkDriver.launch(ctx);
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  ctx.campaign.snapshot = await tiktokSparkDriver.monitor(ctx);
  const plan = ctx.campaign.state.plan as { schedule_start_time: string; schedule_end_time: string };
  plan.schedule_start_time = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const expectedEnd = plan.schedule_end_time;
  await reconcileTikTokSparks(ctx);
  const copy = fakeTikTokSnapshot().adgroups[1];
  assert.ok(Date.parse(String(copy.body.schedule_start_time).replace(" ", "T") + "Z") > Date.now() + 9 * 60_000);
  assert.equal(copy.scheduleEnd, expectedEnd);
});

test("adoption refuses a remotely edited group whose budget differs from the approved share", async () => {
  const ctx = context(["good-one"]);
  const persist = ctx.checkpoint;
  let failOnce = true;
  ctx.checkpoint = async (patch) => {
    if (failOnce && Array.isArray(patch.groups)) { failOnce = false; throw new Error("group save crashed"); }
    await persist(patch);
  };
  await assert.rejects(tiktokSparkDriver.launch(ctx), /group save crashed/);
  fakeTikTokSnapshot().adgroups[0].budget = 999;
  await assert.rejects(tiktokSparkDriver.launch(ctx), /budget differs/);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1);
  assert.equal(fakeTikTokSnapshot().ads.length, 0);
});

test("automatic copies require a running campaign and one passed review without waiting for rejected siblings", async () => {
  const ctx = context(["one", "two"], { copies: 1 });
  await tiktokSparkDriver.launch(ctx);
  const ads = fakeTikTokSnapshot().ads;
  ctx.campaign.snapshot = { delivery: "paused", note: null, checked_at: new Date().toISOString(), spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, cpc_cents: null,
    ads: [{ id: ads[0].adId, status: "approved" }, { id: ads[1].adId, status: "rejected" }] };
  await reconcileTikTokSparks(ctx);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1);
  await tiktokSparkDriver.control(ctx, { action: "resume" });
  await reconcileTikTokSparks(ctx);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 2);
});

test("campaign adoption refuses a changed objective or budget cap", async () => {
  const ctx = context(["good-one"]);
  const persist = ctx.checkpoint;
  let failOnce = true;
  ctx.checkpoint = async (patch) => {
    if (failOnce && patch.campaign_id) { failOnce = false; throw new Error("campaign save crashed"); }
    await persist(patch);
  };
  await assert.rejects(tiktokSparkDriver.launch(ctx), /campaign save crashed/);
  fakeTikTokSnapshot().campaigns[0].objective = "REACH";
  await assert.rejects(tiktokSparkDriver.launch(ctx), /objective or budget cap differs/);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 1);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 0);
});

test("a Sales page whose create answer was lost is settled by TikTok's own page list, never duplicated", async () => {
  const sales = () => {
    const ctx = context(["good-one"]);
    ctx.run.draft.tiktok_settings = defaultSalesLaunchSettings();
    ctx.run.draft.daily_budget_cents = 2000; ctx.campaign.daily_budget_cents = 2000;
    ctx.campaign.campid = "sales-lost-a1b2c3d4e5f6-001"; ctx.campaign.name = ctx.campaign.campid;
    ctx.campaign.tracking_url = `https://crazydramas.com/watch?campid=${ctx.campaign.campid}`;
    ctx.run.snapshot_hash = launchHash(ctx.run.draft, ctx.run.connections!, ctx.run.campaigns);
    return ctx;
  };
  const name = "studio-tip-run-1-1";
  // Listed under its name: adopted, no second page.
  const adopted = sales();
  adopted.campaign.state.instant_page = { name, phase: "creating" };
  seedFakeInstantPages([{ advertiserId: adopted.campaign.advertiser_id, pageId: "9900000000000001", title: name }]);
  await tiktokSparkDriver.launch(adopted);
  assert.deepEqual(adopted.campaign.state.instant_page, { name, phase: "published", id: "9900000000000001" });
  assert.equal(fakeTikTokSnapshot().ads[0].body.page_id, "9900000000000001");
  // Not listed: the create never landed, so it is sent again.
  resetFakeTikTok();
  const fresh = sales();
  fresh.campaign.state.instant_page = { name, phase: "creating" };
  await tiktokSparkDriver.launch(fresh);
  const page = fresh.campaign.state.instant_page as { id: string; phase: string };
  assert.equal(page.phase, "published");
  assert.match(page.id, /^fake-tip-/);
  // Two pages of that name: a person reconciles, nothing is created.
  resetFakeTikTok();
  const twice = sales();
  twice.campaign.state.instant_page = { name, phase: "creating" };
  seedFakeInstantPages([{ advertiserId: twice.campaign.advertiser_id, pageId: "1", title: name }, { advertiserId: twice.campaign.advertiser_id, pageId: "2", title: name }]);
  await assert.rejects(tiktokSparkDriver.launch(twice), /uncertain result/);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
});
