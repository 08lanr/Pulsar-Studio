import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { DriverContext, LaunchCampaign, LaunchConnection, LaunchContent, LaunchRun } from "@/lib/launch/types";
import { defaultLaunchSettings } from "@/lib/tiktok/settings";
import { putStoredBytes, resolveUploadPath } from "@/lib/data/storage";
import { launchHash } from "@/lib/data/launch";
import { createMetaDriver } from "@/lib/meta/driver";
import { FakeMetaTransport } from "@/lib/meta/fake";
import { metaTransport } from "@/lib/meta";
import { liveMetaTransport } from "@/lib/meta/transport";

const originalSource = process.env.DATA_SOURCE;
const originalWrites = process.env.META_LIVE_WRITES;
const originalFetch = globalThis.fetch;
const storedFiles: string[] = [];
afterEach(async () => {
  if (originalSource === undefined) delete process.env.DATA_SOURCE; else process.env.DATA_SOURCE = originalSource;
  if (originalWrites === undefined) delete process.env.META_LIVE_WRITES; else process.env.META_LIVE_WRITES = originalWrites;
  globalThis.fetch = originalFetch;
  await Promise.all(storedFiles.splice(0).map(file => rm(resolveUploadPath(file), { force: true })));
});

function context(content: LaunchContent[] = [{ kind: "facebook_post", value: "demo-page_123" }], opts: { paused?: boolean; daily?: number | null } = {}): DriverContext {
  process.env.DATA_SOURCE = "fixture";
  const connection: LaunchConnection = { id: "connection", producer_id: "company", provider: "meta", advertiser_id: "demo-meta", name: "Meta Demo", currency: "USD", timezone: "America/Los_Angeles", page_id: "demo-page", instagram_id: "demo-instagram", business_id: null, assigned_by: "staff", verified_at: new Date().toISOString(), enabled: true };
  const campaign: LaunchCampaign = { id: "campaign-row", run_id: "run", index: 1, connection_id: connection.id, advertiser_id: connection.advertiser_id, name: "Campaign", content, budget_cents: 10000, daily_budget_cents: opts.daily ?? null, status: "running", state: {}, error: null, snapshot: null };
  const run: LaunchRun = {
    id: "run", external_id: "lr_test", producer_id: "company", round: 1, parent_run_id: null, status: "running", revision: 1, snapshot_hash: null, approved_by: "approver", approved_at: new Date().toISOString(), approval_note: null, created_by: "producer", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mode: "fake", error: null, campaigns: [campaign], connections: [connection], lease_owner: "worker", lease_until: null,
    draft: { provider: "meta", name: "Round", account_ids: [connection.id], campaigns_per_account: 1, content_per_campaign: content.length, allocation: "shared", content, destination_url: "https://example.com/watch", total_budget_cents: 10000, daily_budget_cents: opts.daily ?? null, start_paused: opts.paused ?? true, tiktok_settings: defaultLaunchSettings(), meta_settings: { countries: ["US"], placements: ["facebook", "instagram"], optimization_goal: "LINK_CLICKS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cents: null, call_to_action: "WATCH_MORE", start_time: "2030-01-01T00:00:00Z", end_time: "2030-01-08T00:00:00Z" } },
  };
  run.snapshot_hash = launchHash(run.draft, run.connections!);
  return { run, campaign, connection, checkpoint: async patch => { Object.assign(campaign.state, structuredClone(patch)); }, assertActive: async () => {} };
}

async function uploadContent(): Promise<LaunchContent> {
  const bytes = Buffer.from("the exact approved video file");
  const path = `meta-test/${Date.now()}-${Math.random()}.mp4`;
  await putStoredBytes(path, bytes, "video/mp4"); storedFiles.push(path);
  return { kind: "video", value: "creative-1", creative_id: "creative-1", file_path: path, sha256: createHash("sha256").update(bytes).digest("hex"), text: "Full approved Meta copy.", headline: "Watch this story" };
}

test("fixture forces fake even with live writes enabled; direct live transport cannot fetch", async () => {
  process.env.DATA_SOURCE = "fixture";
  process.env.META_LIVE_WRITES = "enabled";
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("No network allowed"); };
  assert.equal(metaTransport().mode, "fake");
  await assert.rejects(liveMetaTransport.get("me"), /fixture mode/);
  const transport = new FakeMetaTransport();
  await createMetaDriver(transport).launch(context());
  assert.equal(calls, 0);
});

test("live writes remain blocked without explicit deployment toggle", async () => {
  process.env.DATA_SOURCE = "supabase";
  delete process.env.META_LIVE_WRITES;
  await assert.rejects(liveMetaTransport.post("act_1/campaigns", { status: "PAUSED" }), /live writes are disabled/);
});

test("a fixture approval cannot be reused in the live environment", async () => {
  const ctx = context();
  await assert.rejects(createMetaDriver(liveMetaTransport).launch(ctx), /environment differs/);
});

test("both existing post types follow paused-first hierarchy and preserve separate references", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context([{ kind: "facebook_post", value: "demo-page_123" }, { kind: "instagram_post", value: "178900001" }]);
  const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  const rows = transport.snapshot();
  assert.equal(rows.filter(row => row.edge === "ads").length, 2);
  assert.ok(rows.filter(row => ["campaigns", "adsets", "ads"].includes(row.edge)).every(row => row.status === "PAUSED"));
  const creatives = rows.filter(row => row.edge === "adcreatives");
  assert.equal(creatives[0].object_story_id, "demo-page_123");
  assert.equal(creatives[1].source_instagram_media_id, "178900001");
  assert.equal((creatives[1].call_to_action as { value: { link: string } }).value.link, ctx.run.draft.destination_url);
  assert.equal((await driver.monitor(ctx)).delivery, "paused");
  await driver.control(ctx, { action: "resume" });
  assert.equal((await driver.monitor(ctx)).delivery, "live");
  assert.equal((await driver.monitor(ctx)).conversions, null);
  await driver.launch(ctx);
  assert.equal(transport.snapshot().length, rows.length, "retry creates no additional paid objects");
});

test("invalid post creates no campaign or ad set", async () => {
  const transport = new FakeMetaTransport();
  transport.rejectSource("demo-page_bad");
  await assert.rejects(createMetaDriver(transport).launch(context([{ kind: "facebook_post", value: "demo-page_bad" }])), /unavailable/);
  assert.equal(transport.snapshot().length, 0);
});

test("approved uploads check hashes, persist processing IDs and resume without another upload", async () => {
  process.env.DATA_SOURCE = "fixture";
  const transport = new FakeMetaTransport();
  const content = await uploadContent();
  const ctx = context([content]);
  const driver = createMetaDriver(transport);
  transport.videoStatus = "processing";
  await assert.rejects(driver.launch(ctx), /processing the clip/);
  assert.equal(transport.snapshot().filter(row => row.edge === "advideos").length, 1);
  assert.equal(transport.snapshot().filter(row => row.edge === "campaigns").length, 0);
  const video = transport.snapshot().find(row => row.edge === "advideos")!;
  transport.objects.get(video.id)!.status = { video_status: "ready" };
  await driver.launch(ctx);
  assert.equal(transport.calls.filter(call => call.method === "UPLOAD").length, 1);
  const creative = transport.snapshot().find(row => row.edge === "adcreatives")!;
  assert.equal(((creative.object_story_spec as Record<string, unknown>).video_data as Record<string, unknown>).message, content.text);
  const changed = context([{ ...content, sha256: "wrong" }]);
  await assert.rejects(driver.launch(changed), /changed after approval/);
});

test("lost create response adopts one exact object on retry and never repeats the write", async () => {
  const transport = new FakeMetaTransport();
  transport.failNext("POST", "act_demo-meta/campaigns", { after: true, ambiguous: true });
  const ctx = context(); const driver = createMetaDriver(transport);
  await assert.rejects(driver.launch(ctx), /Injected/);
  await driver.launch(ctx);
  assert.equal(transport.calls.filter(call => call.method === "POST" && call.path.endsWith("/campaigns")).length, 1);
  assert.equal(transport.snapshot().filter(row => row.edge === "campaigns").length, 1);
});

test("an ambiguous create with no matching object stops instead of resending", async () => {
  const transport = new FakeMetaTransport();
  transport.failNext("POST", "act_demo-meta/campaigns", { ambiguous: true });
  const ctx = context(); const driver = createMetaDriver(transport);
  await assert.rejects(driver.launch(ctx));
  await assert.rejects(driver.launch(ctx), /ambiguous \(0 matches\)/);
  assert.equal(transport.calls.filter(call => call.method === "POST" && call.path.endsWith("/campaigns")).length, 1);
});

test("a lost ad-create response reconciles by account, ad set and creative identity", async () => {
  const transport = new FakeMetaTransport();
  transport.failNext("POST", "act_demo-meta/ads", { after: true, ambiguous: true });
  const ctx = context(); const driver = createMetaDriver(transport);
  await assert.rejects(driver.launch(ctx));
  await driver.launch(ctx);
  assert.equal(transport.snapshot().filter(row => row.edge === "ads").length, 1);
});

test("ambiguous matching campaign names require resolution instead of choosing one", async () => {
  const transport = new FakeMetaTransport();
  transport.failNext("POST", "act_demo-meta/campaigns", { after: true, ambiguous: true });
  const ctx = context(); const driver = createMetaDriver(transport);
  await assert.rejects(driver.launch(ctx));
  const original = transport.snapshot().find(row => row.edge === "campaigns")!;
  transport.objects.set("duplicate", { ...original, id: "duplicate" });
  await assert.rejects(driver.launch(ctx), /ambiguous \(2 matches\)/);
  assert.equal(transport.snapshot().filter(row => row.edge === "adsets").length, 0);
});

test("read-back budget or creative destination drift blocks activation", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context(undefined, { daily: 2000 }); const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  const campaign = transport.snapshot().find(row => row.edge === "campaigns")!;
  transport.objects.get(campaign.id)!.spend_cap = 50000;
  await assert.rejects(driver.control(ctx, { action: "resume" }), /lifetime ceiling/);
  transport.objects.get(campaign.id)!.spend_cap = 10000;
  const creative = transport.snapshot().find(row => row.edge === "adcreatives")!;
  transport.objects.get(creative.id)!.call_to_action = { type: "WATCH_MORE", value: { link: "https://wrong.example.com" } };
  await assert.rejects(driver.control(ctx, { action: "resume" }), /destination/);
  assert.equal(transport.objects.get(campaign.id)!.status, "PAUSED");
});

test("Meta rejects a tampered campaign row before any paid creation or retry", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context(); const driver = createMetaDriver(transport);
  ctx.campaign.budget_cents = 100_000;
  await assert.rejects(driver.launch(ctx), /approved|signed|budget|ceiling/i);
  assert.equal(transport.calls.length, 0);
  ctx.campaign.budget_cents = 10_000;
  await driver.launch(ctx);
  const created = transport.snapshot().length;
  ctx.campaign.budget_cents = 100_000;
  await assert.rejects(driver.launch(ctx), /approved|signed|budget|ceiling/i);
  await assert.rejects(driver.control(ctx, { action: "resume" }), /approved|signed|budget|ceiling/i);
  assert.equal(transport.snapshot().length, created);
  assert.equal(transport.snapshot().find(row => row.edge === "campaigns")!.status, "PAUSED");
});

test("Meta budget controls reject requests above the signed ceiling, including daily pacing", async () => {
  for (const daily of [null, 2_000]) {
    const transport = new FakeMetaTransport();
    const ctx = context(undefined, { daily }); const driver = createMetaDriver(transport);
    await driver.launch(ctx);
    const posts = transport.calls.filter(call => call.method === "POST").length;
    await assert.rejects(driver.control(ctx, { action: "budget", budget_cents: 100_000 }), /approved|signed|budget|ceiling/i);
    assert.equal(transport.calls.filter(call => call.method === "POST").length, posts);
    ctx.campaign.budget_cents = 100_000;
    await assert.rejects(driver.control(ctx, { action: "daily_budget", daily_budget_cents: 3_000 }), /approved|signed|budget|ceiling/i);
    assert.equal(transport.calls.filter(call => call.method === "POST").length, posts);
    await driver.control(ctx, { action: "pause" });
    assert.equal(transport.snapshot().find(row => row.edge === "campaigns")!.status, "PAUSED");
  }
});

test("a budget reduction within the signed ceiling remains controllable and resumable", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context(); const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  ctx.campaign.budget_cents = 9_000;
  await driver.control(ctx, { action: "budget", budget_cents: 9_000 });
  assert.equal(transport.snapshot().find(row => row.edge === "adsets")!.lifetime_budget, 9_000);
  await driver.control(ctx, { action: "resume" });
  assert.equal((await driver.monitor(ctx)).delivery, "live");
});

test("incomplete ad assembly stays paused and retry creates only missing ads", async () => {
  const transport = new FakeMetaTransport();
  transport.failNext("POST", "act_demo-meta/ads");
  const ctx = context(undefined, { paused: false }); const driver = createMetaDriver(transport);
  await assert.rejects(driver.launch(ctx));
  assert.equal(transport.snapshot().find(row => row.edge === "campaigns")!.status, "PAUSED");
  await driver.launch(ctx);
  assert.equal(transport.snapshot().filter(row => row.edge === "campaigns").length, 1);
  assert.equal((await driver.monitor(ctx)).delivery, "live");
});

test("daily pacing has a verified lifetime campaign cap; controls cannot erase it", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context(undefined, { daily: 2000 }); const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  assert.equal(transport.snapshot().find(row => row.edge === "campaigns")!.spend_cap, 10000);
  await driver.control(ctx, { action: "daily_budget", daily_budget_cents: 3000 });
  assert.equal(transport.snapshot().find(row => row.edge === "campaigns")!.spend_cap, 10000);
  assert.equal(transport.snapshot().find(row => row.edge === "adsets")!.daily_budget, 3000);
  await driver.control(ctx, { action: "end" });
  assert.equal((await driver.monitor(ctx)).delivery, "ended");
  await assert.rejects(driver.control(ctx, { action: "resume" }), /new round/);
});

test("stop before parent activation prevents serving; foreign identity/account is rejected", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context(undefined, { paused: false }); const driver = createMetaDriver(transport);
  ctx.assertActive = async () => {
    if (transport.snapshot().find(row => row.edge === "adsets")?.status === "ACTIVE") throw new Error("Stop requested");
  };
  await assert.rejects(driver.launch(ctx), /Stop requested/);
  assert.equal(transport.snapshot().find(row => row.edge === "campaigns")!.status, "PAUSED");
  const foreign = context(); foreign.connection.producer_id = "another-company";
  await assert.rejects(driver.launch(foreign), /does not belong/);
});

test("pause before creation persists intent without calls; retry preparation still waits for explicit resume", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context(undefined, { paused: false }); const driver = createMetaDriver(transport);
  await driver.control(ctx, { action: "pause" });
  assert.equal(transport.calls.length, 0);
  await assert.rejects(driver.control(ctx, { action: "resume" }), /Retry preparation/);
  await driver.launch(ctx);
  assert.equal((await driver.monitor(ctx)).delivery, "paused");
  await driver.control(ctx, { action: "resume" });
  assert.equal((await driver.monitor(ctx)).delivery, "live");
});
