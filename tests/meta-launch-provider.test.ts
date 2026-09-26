import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { DriverContext, LaunchCampaign, LaunchConnection, LaunchContent, LaunchRun } from "@/lib/launch/types";
import { defaultLaunchSettings } from "@/lib/tiktok/settings";
import { putStoredBytes, resolveUploadPath } from "@/lib/data/storage";
import { launchHash } from "@/lib/data/launch";
import { createMetaDriver } from "@/lib/meta/driver";
import { isLaunchWaiting } from "@/lib/launch/waiting";
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
    draft: { provider: "meta", name: "Round", account_ids: [connection.id], campaigns_per_account: 1, content_per_campaign: content.length, allocation: "shared", content, destination_url: "https://example.com/watch", total_budget_cents: 10000, daily_budget_cents: opts.daily ?? null, start_paused: opts.paused ?? true, tiktok_settings: defaultLaunchSettings(), meta_settings: { countries: ["US"], placements: ["facebook", "instagram"], objective: "OUTCOME_TRAFFIC", optimization_goal: "LINK_CLICKS", conversion_event: null, pixel_id: null, bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cents: null, call_to_action: "WATCH_MORE", start_time: "2030-01-01T00:00:00Z", end_time: "2030-01-08T00:00:00Z" } },
  };
  run.snapshot_hash = launchHash(run.draft, run.connections!);
  return { run, campaign, connection, checkpoint: async patch => { Object.assign(campaign.state, structuredClone(patch)); }, assertActive: async () => {} };
}

/** The campid is part of the approved intent, so stamping one re-signs the run. */
function stampCampid(ctx: DriverContext, campid: string): DriverContext {
  ctx.campaign.campid = campid;
  ctx.campaign.name = campid;
  ctx.campaign.tracking_url = `${ctx.run.draft.destination_url}?campid=${campid}`;
  ctx.run.snapshot_hash = launchHash(ctx.run.draft, ctx.run.connections!, ctx.run.campaigns);
  return ctx;
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

test("every campaign declares that its ad sets never share budget", async () => {
  // Meta refuses campaign creation with code 100/4834011 unless this field is
  // present whenever the budget is not on the campaign, and Studio always
  // budgets per ad set. Verified against the live API on 2026-09-24: without
  // it Meta answers "You must specify True or False in the field
  // is_adset_budget_sharing_enabled". False is the only correct value here:
  // the signed per-campaign ceiling is exact, so ad sets may not borrow.
  const transport = new FakeMetaTransport();
  await createMetaDriver(transport).launch(context([{ kind: "facebook_post", value: "demo-page_123" }]));
  const campaigns = transport.snapshot().filter(row => row.edge === "campaigns");
  assert.ok(campaigns.length > 0);
  assert.ok(campaigns.every(row => row.is_adset_budget_sharing_enabled === false));
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
  // Transcoding is a wait, not a failure: the driver signals it with a typed
  // error the service turns into a pending row that resumes by itself.
  await assert.rejects(driver.launch(ctx), (e: unknown) => isLaunchWaiting(e) && /still processing/.test((e as Error).message));
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

// docs/launch-ux-round-2.md §1.2: one ad set per platform inside a campaign,
// each holding only that platform's ads and half the signed budget.
test("a campaign spanning both platforms creates one ad set per platform and lands each ad in its own", async () => {
  const transport = new FakeMetaTransport();
  const content = [{ kind: "facebook_post" as const, value: "demo-page_123" }, { kind: "instagram_post" as const, value: "178900001" }];
  const ctx = context(content);
  ctx.campaign.ad_sets = [
    { platform: "facebook", content: [content[0]], budget_cents: 5_000, daily_budget_cents: null },
    { platform: "instagram", content: [content[1]], budget_cents: 5_000, daily_budget_cents: null },
  ];
  const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  const sets = transport.snapshot().filter(row => row.edge === "adsets");
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map(row => (row.targeting as { publisher_platforms: string[] }).publisher_platforms), [["facebook"], ["instagram"]]);
  assert.deepEqual(sets.map(row => row.lifetime_budget), [5_000, 5_000]);
  const ads = transport.snapshot().filter(row => row.edge === "ads");
  assert.equal(ads.length, 2);
  const creativeOf = (adsetId: string) => transport.objects.get(String((ads.find(ad => ad.adset_id === adsetId)!.creative as { id: string }).id))!;
  assert.equal(creativeOf(sets[0].id).object_story_id, "demo-page_123");
  assert.equal(creativeOf(sets[1].id).source_instagram_media_id, "178900001");
  const snapshot = await driver.monitor(ctx);
  assert.deepEqual(snapshot.groups?.map(group => group.platform), ["facebook", "instagram"]);
  assert.equal(snapshot.delivery, "paused");
  await driver.control(ctx, { action: "resume" });
  assert.equal((await driver.monitor(ctx)).delivery, "live");
  await driver.control(ctx, { action: "group", group_id: sets[1].id, enabled: false });
  assert.equal((await driver.monitor(ctx)).delivery, "paused", "one paused ad set is not a delivering campaign");
});

test("a budget change re-splits across every ad set of the campaign", async () => {
  const transport = new FakeMetaTransport();
  const content = [{ kind: "facebook_post" as const, value: "demo-page_123" }, { kind: "instagram_post" as const, value: "178900001" }];
  const ctx = context(content);
  ctx.campaign.ad_sets = [
    { platform: "facebook", content: [content[0]], budget_cents: 5_000, daily_budget_cents: null },
    { platform: "instagram", content: [content[1]], budget_cents: 5_000, daily_budget_cents: null },
  ];
  const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  ctx.campaign.budget_cents = 9_001;
  await driver.control(ctx, { action: "budget", budget_cents: 9_001 });
  assert.deepEqual(transport.snapshot().filter(row => row.edge === "adsets").map(row => row.lifetime_budget), [4_501, 4_500]);
  await driver.control(ctx, { action: "resume" });
  assert.equal((await driver.monitor(ctx)).delivery, "live");
  await driver.control(ctx, { action: "schedule", end_time: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(new Set(transport.snapshot().filter(row => row.edge === "adsets").map(row => row.end_time)).size, 1);
});

test("a run created before the split still monitors and controls through its one legacy ad set", async () => {
  const transport = new FakeMetaTransport();
  const content = [{ kind: "facebook_post" as const, value: "demo-page_123" }, { kind: "instagram_post" as const, value: "178900001" }];
  const ctx = context(content);
  const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  // Rewrite the saved state into the pre-split shape: one adset_id, ads keyed
  // by content alone, and no record of which platform an ad belongs to.
  const saved = ctx.campaign.state.meta as Record<string, unknown>;
  const legacyGroup = String((saved.adset_ids as Record<string, string>).facebook);
  const adIds = saved.ad_ids as Record<string, string>;
  for (const id of Object.values(saved.adset_ids as Record<string, string>)) if (id !== legacyGroup) transport.objects.delete(id);
  for (const [key, id] of Object.entries(adIds)) {
    const plain = key.replace(/^(facebook|instagram)\//, "");
    delete adIds[key];
    adIds[plain] = id;
    transport.objects.get(id)!.adset_id = legacyGroup;
  }
  transport.objects.get(legacyGroup)!.lifetime_budget = 10_000;
  delete saved.adset_ids; delete saved.ad_platforms; delete saved.ad_content_keys;
  saved.adset_id = legacyGroup;
  delete (ctx.campaign as { ad_sets?: unknown }).ad_sets;

  const snapshot = await driver.monitor(ctx);
  assert.equal(snapshot.groups?.length, 1);
  assert.equal(snapshot.groups?.[0].id, legacyGroup);
  assert.equal(snapshot.delivery, "paused");
  await driver.control(ctx, { action: "resume" });
  assert.equal((await driver.monitor(ctx)).delivery, "live");
  ctx.campaign.budget_cents = 9_000;
  await driver.control(ctx, { action: "budget", budget_cents: 9_000 });
  assert.equal(transport.objects.get(legacyGroup)!.lifetime_budget, 9_000);
  await driver.control(ctx, { action: "end" });
  assert.equal((await driver.monitor(ctx)).delivery, "ended");
});

test("a campid already used on the ad account is refused before anything is created", async () => {
  const transport = new FakeMetaTransport();
  const ctx = stampCampid(context(), "rlapple01");
  transport.objects.set("foreign", { id: "foreign", edge: "campaigns", account_id: "demo-meta", name: "rlapple01", status: "ACTIVE" });
  const driver = createMetaDriver(transport);
  await assert.rejects(driver.launch(ctx), /already used by a campaign/);
  assert.equal(transport.snapshot().filter(row => row.edge === "campaigns").length, 1, "no second campaign was created");
  assert.equal(transport.snapshot().filter(row => row.edge === "adsets").length, 0);
  transport.objects.delete("foreign");
  await driver.launch(ctx);
  assert.equal(transport.snapshot().find(row => row.edge === "campaigns")!.name, "rlapple01");
  // Adoption by name still works: an interrupted create finds its own campaign.
  const resumed = stampCampid(context(), "rlapple02");
  const second = new FakeMetaTransport();
  second.failNext("POST", "act_demo-meta/campaigns", { after: true, ambiguous: true });
  await assert.rejects(createMetaDriver(second).launch(resumed), /Injected/);
  await createMetaDriver(second).launch(resumed);
  assert.equal(second.calls.filter(call => call.method === "POST" && call.path.endsWith("/campaigns")).length, 1);
  assert.equal(second.snapshot().filter(row => row.edge === "campaigns").length, 1);
});

// A campaign is adopted by its exact name, so the account is read on every
// attempt and only an object this run actually sent a POST for may be claimed.
test("a create that never left the process refuses a stranger's campaign of the same campid on resume", async () => {
  const transport = new FakeMetaTransport();
  const ctx = stampCampid(context(), "rlapple01");
  // The lease is lost exactly where the campaign create would have persisted
  // its intent: after the creative check, before the POST leaves the process.
  let live = true, seen = 0;
  ctx.assertActive = async () => { if (!live && ++seen === 2) throw new Error("lease lost"); };
  live = false;
  await assert.rejects(createMetaDriver(transport).launch(ctx), /lease lost/);
  const saved = ctx.campaign.state.meta as { campaign_id?: string; intents?: Record<string, { phase: string }> } | undefined;
  assert.equal(saved?.campaign_id, undefined);
  assert.equal(saved?.intents?.campaign, undefined, "a worker without its lease records no create intent");
  assert.equal(transport.snapshot().filter(row => row.edge === "campaigns").length, 0);

  transport.objects.set("foreign", { id: "foreign", edge: "campaigns", account_id: "demo-meta", name: "rlapple01", objective: "OUTCOME_TRAFFIC", status: "ACTIVE" });
  live = true;
  await assert.rejects(createMetaDriver(transport).launch(ctx), /already used by a campaign/);
  assert.equal((ctx.campaign.state.meta as { campaign_id?: string }).campaign_id, undefined, "the stranger's campaign was not adopted");
  assert.equal(transport.snapshot().filter(row => row.edge === "adsets").length, 0, "nothing hangs off it");
});

test("a rejected campaign create refuses a name a stranger took in the meantime, and never adopts it", async () => {
  const transport = new FakeMetaTransport();
  const ctx = stampCampid(context(), "rlapple03");
  transport.failNext("POST", "act_demo-meta/campaigns");
  await assert.rejects(createMetaDriver(transport).launch(ctx), /Injected/);
  assert.equal((ctx.campaign.state.meta as { intents: Record<string, { phase: string }> }).intents.campaign.phase, "rejected");
  transport.objects.set("foreign", { id: "foreign", edge: "campaigns", account_id: "demo-meta", name: "rlapple03", objective: "OUTCOME_TRAFFIC", status: "ACTIVE" });
  await assert.rejects(createMetaDriver(transport).launch(ctx), /already used by a campaign/);
  assert.equal(transport.snapshot().filter(row => row.edge === "campaigns").length, 1, "no duplicate-named campaign beside the stranger's");
  transport.objects.delete("foreign");
  await createMetaDriver(transport).launch(ctx);
  assert.equal(transport.snapshot().filter(row => row.edge === "campaigns").length, 1);
});

test("our own ambiguous create is still adopted while an id seen before the send never is", async () => {
  const transport = new FakeMetaTransport();
  const ctx = stampCampid(context(), "rlapple04");
  transport.failNext("POST", "act_demo-meta/campaigns", { after: true, ambiguous: true });
  await assert.rejects(createMetaDriver(transport).launch(ctx), /Injected/);
  const ours = transport.snapshot().find(row => row.edge === "campaigns")!.id;
  await createMetaDriver(transport).launch(ctx);
  assert.equal((ctx.campaign.state.meta as { campaign_id?: string }).campaign_id, ours, "our own campaign is adopted, never re-created");
  assert.equal(transport.calls.filter(call => call.method === "POST" && call.path.endsWith("/campaigns")).length, 1);
});

// `campaign.ad_sets` is not covered by the approval hash, so the driver
// re-derives the split and refuses a row that says something else.
test("a tampered ad-set split never reaches Meta: wrong platform or inflated budget is refused before any call", async () => {
  const facebookPost = { kind: "facebook_post" as const, value: "demo-page_123" };
  for (const tampered of [
    [{ platform: "instagram" as const, content: [facebookPost], budget_cents: 10_000, daily_budget_cents: null }],
    [{ platform: "facebook" as const, content: [facebookPost], budget_cents: 500_000, daily_budget_cents: null }],
    [{ platform: "facebook" as const, content: [facebookPost], budget_cents: 5_000, daily_budget_cents: null },
     { platform: "instagram" as const, content: [facebookPost], budget_cents: 5_000, daily_budget_cents: null }],
  ]) {
    const transport = new FakeMetaTransport();
    const ctx = context([facebookPost]);
    ctx.campaign.ad_sets = tampered;
    await assert.rejects(createMetaDriver(transport).launch(ctx), /differ from the approved content/);
    assert.deepEqual(transport.calls, [], "no Meta call was made at all");
  }
});

test("an approved split survives a budget reduction, and the reduced amount is what Meta receives", async () => {
  const transport = new FakeMetaTransport();
  const content = [{ kind: "facebook_post" as const, value: "demo-page_123" }, { kind: "instagram_post" as const, value: "178900001" }];
  const ctx = context(content);
  ctx.campaign.ad_sets = [
    { platform: "facebook", content: [content[0]], budget_cents: 5_000, daily_budget_cents: null },
    { platform: "instagram", content: [content[1]], budget_cents: 5_000, daily_budget_cents: null },
  ];
  const driver = createMetaDriver(transport);
  await driver.launch(ctx);
  ctx.campaign.budget_cents = 6_000;
  await driver.control(ctx, { action: "budget", budget_cents: 6_000 });
  assert.deepEqual(transport.snapshot().filter(row => row.edge === "adsets").map(row => row.lifetime_budget), [3_000, 3_000]);
  await driver.control(ctx, { action: "resume" });
  assert.equal((await driver.monitor(ctx)).delivery, "live");
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

test("a new ad set declines Advantage+ audience and starts no earlier than now; a window that has closed creates nothing", async () => {
  const day = 86_400_000;
  const transport = new FakeMetaTransport();
  const ctx = context();
  ctx.run.draft.meta_settings.start_time = new Date(Date.now() - 3 * day).toISOString();
  ctx.run.draft.meta_settings.end_time = new Date(Date.now() + 4 * day).toISOString();
  ctx.run.snapshot_hash = launchHash(ctx.run.draft, ctx.run.connections!);
  const before = Date.now();
  await createMetaDriver(transport).launch(ctx);
  const set = transport.snapshot().find(row => row.edge === "adsets")!;
  assert.deepEqual((set.targeting as { targeting_automation: unknown }).targeting_automation, { advantage_audience: 0 });
  assert.ok(Date.parse(String(set.start_time)) >= before, "a start behind the clock begins now, not in the past");
  assert.equal(set.end_time, ctx.run.draft.meta_settings.end_time, "the signed end never moves");
  // Once sent, the start time an intent carries is the one a retry compares against.
  const intent = (ctx.campaign.state.meta as { intents: Record<string, { payload: { start_time: string } }> }).intents["adset/facebook"];
  assert.equal(intent.payload.start_time, set.start_time);

  const ended = context();
  ended.run.draft.meta_settings.start_time = new Date(Date.now() - 8 * day).toISOString();
  ended.run.draft.meta_settings.end_time = new Date(Date.now() - day).toISOString();
  ended.run.snapshot_hash = launchHash(ended.run.draft, ended.run.connections!);
  const second = new FakeMetaTransport();
  await assert.rejects(createMetaDriver(second).launch(ended), /end time has already passed/);
  assert.equal(second.snapshot().length, 0, "nothing is created for a window that has closed");
});

test("a refused ad set create is re-sent with a corrected start, while a sent one is frozen", async () => {
  const transport = new FakeMetaTransport();
  const ctx = context();
  // First attempt: Meta refuses the ad set outright (nothing exists), so the
  // intent is rejected and the next attempt may carry a fresh start time.
  transport.failNext("POST", "act_demo-meta/adsets");
  await assert.rejects(createMetaDriver(transport).launch(ctx), /Injected/);
  const state = () => ctx.campaign.state.meta as { intents: Record<string, { phase: string; payload: { start_time: string } }> };
  assert.equal(state().intents["adset/facebook"].phase, "rejected");
  await createMetaDriver(transport).launch(ctx);
  assert.equal(state().intents["adset/facebook"].phase, "confirmed");
  assert.equal(transport.snapshot().filter(row => row.edge === "adsets").length, 1);
});
