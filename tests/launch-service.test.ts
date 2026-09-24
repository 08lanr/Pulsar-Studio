import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_PRODUCER_ID, fixtureSession, systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { renameLaunchRun, resetLaunchFixture } from "@/lib/data/launch";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import { defaultLaunchSettings } from "@/lib/tiktok/settings";
import { scanLaunchAccounts } from "@/lib/launch/account-scan";
import { controlLaunch, executeLaunch, monitorLaunch, monitorState, needsFirstSweep } from "@/lib/launch/service";
import type { LaunchConnection, LaunchContent, LaunchProvider, LaunchRun } from "@/lib/launch/types";
import { fakeMetaTransport, fakeMetaSnapshot, resetFakeMeta } from "@/lib/meta/fake";
import { fakeTransport, fakeTikTokSnapshot, resetFakeTikTok } from "@/lib/tiktok/fake";
import type { MetaObject } from "@/lib/meta/transport";
import { launchTitle, LIVE_AD_URL } from "./launch-title";

const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");
const originalFetch = globalThis.fetch;
const originalMetaPost = fakeMetaTransport.post;
const originalTikTokPost = fakeTransport.post;
const env = { DATA_SOURCE: process.env.DATA_SOURCE, FIXTURE_SEED: process.env.FIXTURE_SEED, FIXTURE_PERSIST: process.env.FIXTURE_PERSIST };
let networkCalls = 0;

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  resetFixtureStore(); resetLaunchFixture(); resetFakeMeta(); resetFakeTikTok(); networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("Fixture integration attempted network access"); };
});
afterEach(() => {
  globalThis.fetch = originalFetch; fakeMetaTransport.post = originalMetaPost; fakeTransport.post = originalTikTokPost;
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
});

async function connections(provider: LaunchProvider, count: number): Promise<LaunchConnection[]> {
  return Promise.all(Array.from({ length: count }, (_, index) => getData().assignLaunchConnection(staff(), {
    producer_id: FIXTURE_PRODUCER_ID, provider, advertiser_id: provider === "meta" ? `act_900000000000000${index + 1}` : `700000000000000000${index + 1}`,
    name: `Test ${provider} ${index + 1}`, currency: "USD", timezone: "America/Los_Angeles", page_id: provider === "meta" ? "9000000000000010" : null,
    instagram_id: provider === "meta" ? "9000000000000020" : null, business_id: null, enabled: true,
  })));
}

async function approved(provider: LaunchProvider = "meta", options: { count?: number; paused?: boolean; content?: LaunchContent[]; unique?: boolean; copies?: number } = {}) {
  const accounts = await connections(provider, options.count ?? 2);
  const draft = defaultLaunchDraft(provider);
  if (provider === "tiktok") { draft.tiktok_settings = defaultLaunchSettings(); draft.daily_budget_cents = null; draft.title_id = (await launchTitle()).id; }
  Object.assign(draft, {
    name: "Integration launch", account_ids: accounts.map(a => a.id), destination_url: provider === "tiktok" ? LIVE_AD_URL : "https://example.com/watch", total_budget_cents: 20000,
    start_paused: options.paused ?? true, allocation: options.unique ? "unique" : "shared", content_per_campaign: 1,
    content: options.content || [{ kind: provider === "meta" ? "facebook_post" : "spark", value: provider === "meta" ? "9000000000000010_123" : "valid-spark-code" }],
  });
  if (options.copies !== undefined) draft.tiktok_settings.duplicate_copies = options.copies;
  const saved = await getData().saveLaunchDraft(producer(), draft);
  const plan = await getData().previewLaunchRun(producer(), saved.id);
  assert.equal(plan.rows.reduce((sum, row) => sum + row.budget_cents, 0), 20000);
  const run = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  return { run, accounts };
}
async function current(run: LaunchRun) { return getData().getLaunchRun(producer(), run.id); }

for (const provider of ["tiktok", "meta"] as const) test(`${provider} signed campaign ceiling rejects a $100,000 control on a $200 approval`, async () => {
  const { run } = await approved(provider, { count: 1 });
  await executeLaunch(run.id);
  const before = provider === "tiktok" ? fakeTikTokSnapshot() : fakeMetaSnapshot();
  await assert.rejects(controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "budget", budget_cents: 10_000_000 }), /signed.*budget|approved.*budget|ceiling/i);
  const after = await current(run);
  assert.equal(after.snapshot_hash, run.snapshot_hash);
  assert.equal(after.campaigns[0].budget_cents, 20000);
  assert.deepEqual(provider === "tiktok" ? fakeTikTokSnapshot() : fakeMetaSnapshot(), before);
  assert.equal(networkCalls, 0);
});

for (const provider of ["tiktok", "meta"] as const) test(`${provider} each account keeps its own signed share and corrupted rows cannot launch`, async () => {
  const { run } = await approved(provider);
  await assert.rejects(controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "budget", budget_cents: 15000 }), /signed campaign ceiling/);
  const owned = (await getData().claimLaunchRun(systemSession(), run.id, "regression-owner"))!;
  owned.campaigns[0].budget_cents = 10_000_000;
  owned.lease_owner = null; owned.lease_until = null;
  await getData().updateLaunchRun(systemSession(), owned, "regression-owner");
  const done = await executeLaunch(run.id);
  assert.equal(done?.campaigns[0].status, "failed");
  assert.match(done?.campaigns[0].error || "", /signed campaign ceiling/);
  assert.equal(done?.campaigns[1].status, "done");
  const campaigns = provider === "tiktok" ? fakeTikTokSnapshot().campaigns : fakeMetaSnapshot().filter(row => row.edge === "campaigns");
  assert.equal(campaigns.length, 1);
  // Bad monetary state must never prevent a stop request.
  const stopped = await controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "end" });
  assert.equal(stopped.campaigns[0].state.stop_applied, "ended");
  assert.equal(networkCalls, 0);
});

test("a higher budget receives a fresh preview, approval and external objects in a new round", async () => {
  const { run } = await approved("meta", { count: 1 });
  await executeLaunch(run.id);
  const next = await getData().newLaunchRound(producer(), run.id);
  assert.equal(next.snapshot_hash, null);
  const saved = await getData().saveLaunchDraft(producer(), { ...next.draft, total_budget_cents: 40000 }, { id: next.id, expectedRevision: next.revision });
  const preview = await getData().previewLaunchRun(producer(), next.id);
  assert.equal(preview.total_budget_cents, 40000);
  assert.equal(fakeMetaSnapshot().filter(row => row.edge === "campaigns").length, 1);
  const signedNext = await getData().submitLaunchRun(producer(), next.id, saved.revision);
  assert.notEqual(signedNext.snapshot_hash, run.snapshot_hash);
  await executeLaunch(next.id);
  assert.deepEqual(fakeMetaSnapshot().filter(row => row.edge === "adsets").map(row => row.lifetime_budget).sort((a, b) => Number(a) - Number(b)), [20000, 40000]);
  assert.equal((await current(run)).draft.total_budget_cents, 20000);
});

test("Meta multi-account execution is durable and concurrent workers do not duplicate objects", async () => {
  const { run } = await approved();
  const results = await Promise.all([executeLaunch(run.id), executeLaunch(run.id)]);
  assert.equal(results.filter(Boolean).length, 1);
  const done = await current(run);
  assert.equal(done.status, "done");
  assert.equal(done.lease_owner, null);
  assert.ok(done.campaigns.every(c => c.status === "done" && c.snapshot?.delivery === "paused"));
  assert.equal(fakeMetaSnapshot().filter(row => row.edge === "campaigns").length, 2);
  assert.equal(new Set(fakeMetaSnapshot().filter(row => row.edge === "campaigns").map(row => row.account_id)).size, 2);
  await executeLaunch(run.id);
  await monitorLaunch(run.id);
  assert.equal(fakeMetaSnapshot().filter(row => row.edge === "campaigns").length, 2);
  assert.equal(networkCalls, 0);
});

test("Spark multi-account execution redeems each account and preserves exact total cap", async () => {
  const { run } = await approved("tiktok");
  const done = await executeLaunch(run.id);
  assert.equal(done?.status, "done");
  const snapshot = fakeTikTokSnapshot();
  assert.equal(snapshot.campaigns.length, 2);
  assert.equal(snapshot.ads.length, 2);
  assert.deepEqual(snapshot.campaigns.map(c => c.name), run.campaigns.map(c => c.campid));
  for (const ad of snapshot.ads) {
    const campaign = run.campaigns.find(c => c.advertiser_id === ad.advertiserId)!;
    assert.equal(ad.body.landing_page_url, campaign.tracking_url);
  }
  assert.equal(snapshot.adgroups.reduce((sum, row) => sum + Number(row.budget) * 100, 0), 20000);
  await executeLaunch(run.id);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 2);
  assert.equal(networkCalls, 0);
});

test("Meta account failure preserves successful rows and retry creates only missing work", async () => {
  const { run } = await approved();
  fakeMetaTransport.failNext("POST", "act_9000000000000002/ads");
  const failed = await executeLaunch(run.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.campaigns[0].status, "done");
  assert.equal(failed?.campaigns[1].status, "failed");
  assert.ok(fakeMetaSnapshot().filter(row => row.edge === "campaigns").every(row => row.status === "PAUSED"));
  await getData().retryLaunchRun(producer(), run.id);
  const done = await executeLaunch(run.id);
  assert.equal(done?.status, "done");
  assert.equal(fakeMetaSnapshot().filter(row => row.edge === "campaigns").length, 2);
  assert.equal(fakeMetaSnapshot().filter(row => row.edge === "ads").length, 2);
});

test("invalid Spark row creates no campaign while another account succeeds", async () => {
  const { run } = await approved("tiktok", { unique: true, content: [{ kind: "spark", value: "invalid-code" }, { kind: "spark", value: "valid-code" }] });
  const result = await executeLaunch(run.id);
  assert.equal(result?.status, "failed");
  assert.equal(result?.campaigns[0].status, "failed");
  assert.equal(result?.campaigns[1].status, "done");
  assert.equal(fakeTikTokSnapshot().campaigns.length, 1);
  assert.equal(fakeTikTokSnapshot().ads.length, 1);
});

test("pause, resume, end and a fresh round preserve approval and use new external objects", async () => {
  const { run } = await approved("meta", { count: 1 });
  await executeLaunch(run.id);
  const campaignId = run.campaigns[0].id;
  let controlled = await controlLaunch(producer(), run.id, campaignId, { action: "resume" });
  assert.equal(controlled.campaigns[0].snapshot?.delivery, "live");
  controlled = await controlLaunch(producer(), run.id, campaignId, { action: "pause" });
  assert.equal(controlled.campaigns[0].snapshot?.delivery, "paused");
  controlled = await controlLaunch(producer(), run.id, campaignId, { action: "end" });
  assert.equal(controlled.campaigns[0].snapshot?.delivery, "ended");
  await assert.rejects(controlLaunch(producer(), run.id, campaignId, { action: "resume" }), /ended/);
  const next = await getData().newLaunchRound(producer(), run.id);
  assert.equal(next.round, 2); assert.equal(next.parent_run_id, run.id); assert.equal(next.approved_by, null);
  await getData().submitLaunchRun(producer(), next.id, next.revision);
  await executeLaunch(next.id);
  assert.equal(fakeMetaSnapshot().filter(row => row.edge === "campaigns").length, 2);
  assert.equal(new Set(fakeMetaSnapshot().filter(row => row.edge === "campaigns").map(row => row.id)).size, 2);
});

test("reviewers and foreign producers cannot control; reassignment blocks unsent writes", async () => {
  const { run, accounts } = await approved("meta", { count: 1 });
  const reviewer = { ...producer(), producerRole: "reviewer" as const };
  await assert.rejects(controlLaunch(reviewer, run.id, run.campaigns[0].id, { action: "resume" }), /approver/);
  const foreign = { ...producer(), producerId: "another-company" };
  await assert.rejects(controlLaunch(foreign, run.id, run.campaigns[0].id, { action: "pause" }), /Launch/);
  const { id: _id, assigned_by: _assigned, verified_at: _verified, ...input } = accounts[0];
  await getData().assignLaunchConnection(staff(), { ...input, enabled: false });
  const result = await executeLaunch(run.id);
  assert.equal(result?.campaigns[0].status, "failed");
  assert.match(result?.campaigns[0].error || "", /assignment changed/);
  assert.equal(fakeMetaSnapshot().length, 0);
});

test("budget reductions and restorations stay within the original approval", async () => {
  const { run } = await approved("meta", { count: 1 });
  await executeLaunch(run.id);
  const changed = await controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "budget", budget_cents: 15000 });
  assert.equal(changed.snapshot_hash, run.snapshot_hash);
  assert.equal(changed.draft.total_budget_cents, 20000);
  assert.equal(changed.campaigns[0].budget_cents, 15000);
  assert.equal(fakeMetaSnapshot().find(row => row.edge === "adsets")?.lifetime_budget, 15000);
  assert.ok(changed.audit?.some(event => event.action === "control_authorized"));
  assert.ok(changed.audit?.some(event => event.action === "control_applied"));
  await controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "budget", budget_cents: 20000 });
  assert.equal(fakeMetaSnapshot().find(row => row.edge === "adsets")?.lifetime_budget, 20000);
  await assert.rejects(controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "budget", budget_cents: 25000 }), /signed campaign ceiling/);
  await assert.rejects(controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "budget", budget_cents: -1 }), /Invalid budget/);
});

test("approval corruption and environment mismatch are rejected before provider calls", async () => {
  const { run } = await approved("meta", { count: 1 });
  let owned = (await getData().claimLaunchRun(systemSession(), run.id, "test-owner"))!;
  owned.mode = "production"; owned.lease_owner = null; owned.lease_until = null;
  await getData().updateLaunchRun(systemSession(), owned, "test-owner");
  await assert.rejects(executeLaunch(run.id), /different environment/);
  assert.equal(fakeMetaSnapshot().length, 0);
  owned = (await getData().claimLaunchRun(systemSession(), run.id, "test-owner"))!;
  owned.mode = "fake"; owned.draft.total_budget_cents = 99999; owned.lease_owner = null; owned.lease_until = null;
  await getData().updateLaunchRun(systemSession(), owned, "test-owner");
  await assert.rejects(executeLaunch(run.id), /approval is missing or changed/);
  assert.equal(fakeMetaSnapshot().length, 0);
  assert.equal(networkCalls, 0);
});

test("pause racing the last activation is reconciled before execute returns", async () => {
  const { run } = await approved("meta", { count: 1, paused: false });
  const original = fakeMetaTransport.post.bind(fakeMetaTransport);
  let intercepted = false;
  fakeMetaTransport.post = (async (path: string, params: MetaObject) => {
    const result = await original(path, params);
    if (!intercepted && params.status === "ACTIVE" && fakeMetaTransport.objects.get(path)?.edge === "campaigns") {
      intercepted = true;
      await getData().requestLaunchStop(producer(), run.id, run.campaigns[0].id, false);
    }
    return result;
  }) as typeof fakeMetaTransport.post;
  const result = await executeLaunch(run.id);
  assert.equal(intercepted, true);
  assert.equal(result?.campaigns[0].snapshot?.delivery, "paused");
  assert.equal(fakeMetaSnapshot().find(row => row.edge === "campaigns")?.status, "PAUSED");
  assert.equal(result?.campaigns[0].state.stop_applied, "paused");
});

test("paused preparation can retry missing work and waits for explicit resume", async () => {
  const { run } = await approved("meta", { count: 1, paused: false });
  await controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "pause" });
  await executeLaunch(run.id);
  await getData().retryLaunchRun(producer(), run.id);
  const prepared = await executeLaunch(run.id);
  assert.equal(prepared?.campaigns[0].state.launch_complete, true);
  assert.equal(prepared?.campaigns[0].snapshot?.delivery, "paused");
  const resumed = await controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "resume" });
  assert.equal(resumed.campaigns[0].snapshot?.delivery, "live");
});

test("a new end request racing resume cannot be erased by the older resume command", async () => {
  const { run } = await approved("meta", { count: 1 });
  await executeLaunch(run.id);
  await controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "pause" });
  const original = fakeMetaTransport.post.bind(fakeMetaTransport);
  let intercepted = false;
  fakeMetaTransport.post = (async (path: string, params: MetaObject) => {
    const result = await original(path, params);
    if (!intercepted && params.status === "ACTIVE" && fakeMetaTransport.objects.get(path)?.edge === "campaigns") {
      intercepted = true;
      await getData().requestLaunchStop(producer(), run.id, run.campaigns[0].id, true);
    }
    return result;
  }) as typeof fakeMetaTransport.post;
  try { await controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "resume" }); } catch { /* Interrupted resume may report a conflict. */ }
  const saved = await current(run);
  assert.equal(intercepted, true);
  assert.equal(saved.campaigns[0].state.desired_status, "ended");
  assert.equal(fakeMetaSnapshot().find(row => row.edge === "campaigns")?.status, "PAUSED");
});

test("a stop during monitor-created Spark copy activation is applied before the sweep returns", async () => {
  const { run } = await approved("tiktok", { count: 1, paused: false, copies: 1 });
  await executeLaunch(run.id);
  const originalGroup = fakeTikTokSnapshot().adgroups[0].adgroupId;
  const original = fakeTransport.post.bind(fakeTransport);
  let intercepted = false;
  fakeTransport.post = async (path, token, body) => {
    const result = await original(path, token, body);
    if (!intercepted && path === "/adgroup/status/update/" && body.operation_status === "ENABLE" && !(body.adgroup_ids as string[]).includes(originalGroup)) {
      intercepted = true;
      await getData().requestLaunchStop(producer(), run.id, run.campaigns[0].id, false);
    }
    return result;
  };
  await monitorLaunch(run.id);
  assert.equal(intercepted, true);
  const saved = await current(run);
  assert.equal(saved.campaigns[0].state.desired_status, "paused");
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
  assert.equal(saved.campaigns[0].state.stop_applied, "paused");
});

test("a new round counts the campid on, so round 2 never collides with round 1 on the account", async () => {
  const accounts = await connections("meta", 1);
  const draft = defaultLaunchDraft("meta");
  Object.assign(draft, {
    name: "Campid rounds", account_ids: accounts.map(a => a.id), destination_url: "https://example.com/watch",
    total_budget_cents: 20000, content_per_campaign: 1, campid_start: "rlapple01",
    content: [{ kind: "facebook_post", value: "9000000000000010_123" }],
  });
  const saved = await getData().saveLaunchDraft(producer(), draft);
  const first = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  assert.deepEqual(first.campaigns.map(c => c.campid), ["rlapple01"]);
  assert.equal((await executeLaunch(first.id))?.status, "done");

  const next = await getData().newLaunchRound(producer(), first.id);
  assert.equal(next.draft.campid_start, "rlapple02");
  const plan = await getData().previewLaunchRun(producer(), next.id);
  assert.deepEqual(plan.rows.map(row => row.campid), ["rlapple02"]);
  assert.deepEqual(plan.rows.map(row => row.tracking_url), ["https://example.com/watch?campid=rlapple02"]);
  const signed = await getData().submitLaunchRun(producer(), next.id, next.revision);
  assert.deepEqual(signed.campaigns.map(c => c.campid), ["rlapple02"]);
  // The account already holds rlapple01, so a repeat would be refused at launch.
  const done = await executeLaunch(signed.id);
  assert.equal(done?.campaigns[0].error, null);
  assert.equal(done?.status, "done");
  assert.deepEqual(fakeMetaSnapshot().filter(row => row.edge === "campaigns").map(row => String(row.name)).sort(), ["rlapple01", "rlapple02"]);
  assert.equal(networkCalls, 0);
});

test("the monitor's state words come from the campaign itself, before and after the first sweep", async () => {
  const { run } = await approved("meta", { count: 1 });
  const fresh = await current(run);
  // Approved, nothing created, nothing swept: the monitor says so and sweeps.
  assert.equal(fresh.campaigns[0].snapshot, null);
  assert.equal(monitorState(fresh.campaigns[0]), "not_checked");
  assert.equal(needsFirstSweep(fresh.campaigns), true);
  await executeLaunch(run.id);
  const launched = await current(run);
  assert.equal(needsFirstSweep(launched.campaigns), false);
  assert.equal(monitorState(launched.campaigns[0]), "paused");
  // Objects exist but no sweep has read the campaign's switch yet.
  const owned = (await getData().claimLaunchRun(systemSession(), run.id, "state-owner"))!;
  owned.campaigns[0].snapshot = { ...owned.campaigns[0].snapshot!, delivery: "submitted", configured_status: undefined };
  owned.lease_owner = null; owned.lease_until = null;
  await getData().updateLaunchRun(systemSession(), owned, "state-owner");
  assert.equal(monitorState((await current(run)).campaigns[0]), "created_paused");
  assert.equal(networkCalls, 0);
});

test("renaming a launch is the approver's or a staff administrator's, never a viewer's, and never mid-launch", async () => {
  const { run } = await approved("meta", { count: 1 });
  await executeLaunch(run.id);
  const viewer = { ...producer(), producerRole: "viewer" as const };
  await assert.rejects(renameLaunchRun(viewer, run.id, "Viewer rename"), /role/);
  const reviewer = { ...producer(), producerRole: "reviewer" as const };
  await assert.rejects(renameLaunchRun(reviewer, run.id, "Reviewer rename"), /approver/);
  const foreign = { ...producer(), producerId: "another-company" };
  await assert.rejects(renameLaunchRun(foreign, run.id, "Foreign rename"), /Launch/);
  await assert.rejects(renameLaunchRun(producer(), run.id, "   "), /name/i);

  const named = await renameLaunchRun(producer(), run.id, "  Xinghai · Sep 16  ");
  assert.equal(named.draft.name, "Xinghai · Sep 16");
  assert.ok(named.audit?.some(event => event.action === "renamed"));
  // The name is re-signed, so every later control still reads a valid approval.
  const controlled = await controlLaunch(producer(), run.id, run.campaigns[0].id, { action: "resume" });
  assert.equal(controlled.campaigns[0].snapshot?.delivery, "live");
  assert.equal(controlled.draft.name, "Xinghai · Sep 16");
  // Staff administrators rename on a company's behalf; Meta objects keep their own names.
  const byStaff = await renameLaunchRun(staff(), run.id, "Desk rename");
  assert.equal(byStaff.draft.name, "Desk rename");
  assert.deepEqual(fakeMetaSnapshot().filter(row => row.edge === "campaigns").map(row => row.name), run.campaigns.map(c => c.campid ?? c.name));

  const owned = (await getData().claimLaunchRun(systemSession(), run.id, "rename-owner"))!;
  owned.status = "running"; owned.lease_owner = null; owned.lease_until = null;
  await getData().updateLaunchRun(systemSession(), owned, "rename-owner");
  await assert.rejects(renameLaunchRun(producer(), run.id, "Mid-flight rename"), /still being created/);
  assert.equal((await current(run)).draft.name, "Desk rename");
  assert.equal(networkCalls, 0);
});

test("account scans reject a producer's foreign company before provider access", async () => {
  const assigned = await connections("meta", 1);
  const before = fakeMetaTransport.calls.length;
  await assert.rejects(scanLaunchAccounts(producer(), "00000000-0000-4000-8000-000000009999", assigned.map(a => a.id), true), /Company|company|not found|Launch/);
  assert.equal(fakeMetaTransport.calls.length, before);
  assert.equal(networkCalls, 0);
});

test("a rate-limited provider makes the campaign wait and resume from its checkpoints, not fail", async () => {
  const { run } = await approved("meta", { count: 1 });
  fakeMetaTransport.failNext("POST", "act_9000000000000001/campaigns", { code: 4 });
  const waiting = await executeLaunch(run.id);
  assert.equal(waiting?.status, "pending");
  assert.equal(waiting?.campaigns[0].status, "pending");
  assert.equal(monitorState(waiting!.campaigns[0]), "waiting");
  assert.equal(waiting?.campaigns[0].state.provider_retries, 1);
  assert.match(String((waiting?.campaigns[0].state.waiting as { reason: string }).reason), /Injected/);
  assert.equal(fakeMetaSnapshot().filter(row => row.edge === "campaigns").length, 0);
  const done = await executeLaunch(run.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.campaigns[0].state.provider_retries, undefined);
  assert.equal(fakeMetaSnapshot().filter(row => row.edge === "campaigns").length, 1);
  // A refusal no wait can fix still fails at once, with its reason.
  const { run: refused } = await approved("meta", { count: 1 });
  fakeMetaTransport.failNext("POST", "act_9000000000000001/campaigns", { code: 100 });
  const result = await executeLaunch(refused.id);
  assert.equal(result?.campaigns[0].status, "failed");
  assert.equal(monitorState(result!.campaigns[0]), "failed");
  assert.equal(networkCalls, 0);
});

test("a TikTok timeout is a wait too, and the wait is bounded", async () => {
  const { run } = await approved("tiktok", { count: 1 });
  fakeTransport.post = async (path, token, body) => path === "/campaign/create/"
    ? { code: -1, message: "TikTok did not respond in time. Please try again." }
    : originalTikTokPost(path, token, body);
  let result = await executeLaunch(run.id);
  assert.equal(result?.campaigns[0].status, "pending");
  assert.equal(monitorState(result!.campaigns[0]), "waiting");
  for (let attempt = 2; attempt <= 12; attempt++) result = await executeLaunch(run.id);
  assert.equal(result?.campaigns[0].state.provider_retries, 12);
  // The thirteenth "later" is a failure a person must look at.
  result = await executeLaunch(run.id);
  assert.equal(result?.campaigns[0].status, "failed");
  assert.match(result?.campaigns[0].error || "", /did not respond/);
  // Retry by hand starts the count over, and a provider that answers finishes the launch.
  fakeTransport.post = originalTikTokPost;
  await getData().retryLaunchRun(producer(), run.id);
  const done = await executeLaunch(run.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.campaigns[0].state.provider_retries, undefined);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 1);
  assert.equal(networkCalls, 0);
});
