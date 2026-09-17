// Launch settings, the post-launch controls, the auto-duplicate pass, the
import { withHistoricalPromoSeed } from "@/lib/data/fixture";
const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, () => withHistoricalPromoSeed(fn));
// monitor, presets and the producer's preferred account (decision
// 2026-09-16). Everything runs on the empty fixture seed and the fake
// TikTok: no request leaves the process, and every number the controls send
// is asserted against what the fake recorded.

import { afterEach, beforeEach, test as nodeTest } from "node:test";
import assert from "node:assert/strict";

import { FIXTURE_PRODUCER_ID, fixtureSession, systemSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { putStoredBytes } from "@/lib/data/storage";
import { launchReadiness } from "@/lib/promote/launch-gate";
import { autoDuplicatePass } from "@/lib/tiktok/autodup";
import { invalidateBusinessCenters, pickLaunchAccount } from "@/lib/tiktok/business-centers";
import { activeAdGroupIds, changeBid, changeBudget, changeDailyBudget, changeScheduleEnd, duplicateAdGroups, endCampaign, switchAdGroup, switchCampaign } from "@/lib/tiktok/controls";
import { FAKE_BC_ACCOUNTS, FAKE_BC_ID, fakeTikTokSnapshot, resetFakeTikTok } from "@/lib/tiktok/fake";
import { launchNames, runLaunch } from "@/lib/tiktok/launch";
import { buildMonitor, invalidateMonitor, rollupReview } from "@/lib/tiktok/monitor";
import { pollCampaignReview } from "@/lib/tiktok/review";
import { tick } from "@/lib/tiktok/scheduler";
import { adGroupBody, defaultLaunchSettings, LaunchSettingsError, normalizeLaunchSettings, planAdGroup, summarizeLaunchSettings, validateLaunchSettings, type LaunchSettings } from "@/lib/tiktok/settings";
import { producer, seedRenderedClips, staff } from "./seed-minute";

const sys = () => systemSession();
const reviewer = () => ({ ...fixtureSession("producer"), producerRole: "reviewer" as const });

beforeEach(() => { process.env.FIXTURE_SEED = "empty"; resetFixtureStore(); resetFakeTikTok(); invalidateBusinessCenters(); invalidateMonitor(); delete process.env.TIKTOK_FAKE_REVIEW; delete process.env.TIKTOK_FAKE_ACCOUNT; });
afterEach(() => { resetFixtureStore(); resetFakeTikTok(); delete process.env.TIKTOK_FAKE_REVIEW; delete process.env.TIKTOK_FAKE_ACCOUNT; });

/** A campaign with two approved rendered ads, a signed budget and the fake BC assigned; `settings` shape the launch. */
async function prepared(opts: { budget?: number; settings?: Partial<LaunchSettings> } = {}) {
  const title = await fixtureData.createTitle(producer(), { name_zh: "向园", name_en: "Xiang Yuan", producer_id: "ignored" });
  const videoPath = `${title.id}/episode-1/source.mp4`;
  await putStoredBytes(videoPath, Buffer.from("bytes the fake TikTok accepts as a video"), "video/mp4");
  const episode = await fixtureData.addVideoOnlyEpisode(producer(), title.id, 1, videoPath);
  await seedRenderedClips(title.id, episode.id, 2);
  const budget = opts.budget ?? 200;
  const campaign = await fixtureData.createPromoCampaign(producer(), {
    title_id: title.id, name: "Round 1", target_market: "US", destination_url: "https://example.com/watch", objective: "views", spoiler_level: "low",
    experiment: { budget_usd: budget, hypothesis: "The reversal opening wins.", audience: "US women 25-44", first_batch: 2, signal: "views" },
  });
  const drafts = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  for (const c of drafts.slice(0, 2)) await fixtureData.reviewPromoCreative(producer(), c.id, { status: "approved" });
  // This historical promotion exercises the original Traffic launch contract.
  // New drafts default to Sales, so make its legacy settings explicit.
  await fixtureData.setLaunchSettings(producer(), campaign.id, { ...defaultLaunchSettings(), ...opts.settings });
  await fixtureData.approvePromoCampaign(producer(), campaign.id);
  await fixtureData.approveExperiment(producer(), campaign.id);
  await fixtureData.assignBusinessCenter(staff(), FIXTURE_PRODUCER_ID, { bc_id: FAKE_BC_ID, name: "Pulsar BC" });
  return { title, campaign };
}

async function launched(opts: { budget?: number; settings?: Partial<LaunchSettings> } = {}) {
  const { campaign } = await prepared(opts);
  const pick = await pickLaunchAccount(producer(), FIXTURE_PRODUCER_ID);
  assert.ok(pick.ok, "the fake BC has a ready account with a handle");
  const sent = await fixtureData.submitPromoCampaign(producer(), campaign.id, pick.pick);
  const outcome = await runLaunch(sent.launch!.id);
  assert.equal(outcome.status, "done", outcome.error);
  return campaign.id;
}

/** Two polls: the fake rules on the second look. */
async function approvedOnTikTok(campaignId: string) {
  const row = () => fixtureData.getLaunchedCampaign(sys(), campaignId);
  await pollCampaignReview((await row())!);
  await pollCampaignReview((await row())!);
  assert.equal((await fixtureData.getPromoCampaign(producer(), campaignId)).campaign.status, "live");
}

test("settings are validated against the signed budget and turned into exactly the ad group TikTok gets", () => {
  const d = defaultLaunchSettings();
  const plan = planAdGroup(d, 100, new Date("2026-09-16T00:00:00Z"));
  assert.equal(plan.budget, 100);
  assert.equal(plan.budget_mode, "BUDGET_MODE_TOTAL");
  assert.equal(plan.campaign_budget, null, "a lifetime launch leaves the campaign uncapped; the ad group carries the ceiling");
  assert.equal(plan.schedule_start_time, "2026-09-16 00:10:00");
  assert.equal(plan.schedule_end_time, "2026-09-21 00:10:00", "$100 at the $20 daily minimum runs five days");
  const body = adGroupBody(d, plan);
  assert.equal(body.bid_type, "BID_TYPE_NO_BID");
  assert.equal(body.operation_status, "ENABLE");
  assert.equal(body.placement_type, "PLACEMENT_TYPE_AUTOMATIC");
  assert.equal("age_groups" in body, false, "unrestricted knobs are omitted, never sent empty");
  // Lifetime split across copies: three groups, $200 → $66.66 each.
  const split = validateLaunchSettings({ ...d, duplicate_copies: 2 }, 200);
  assert.equal(planAdGroup(split, 200).budget, 66.66);
  assert.throws(() => validateLaunchSettings({ ...d, duplicate_copies: 9 }, 100), (e: Error) => e instanceof LaunchSettingsError && /below TikTok's minimum/.test(e.message));
  // Daily shape: each group daily, the campaign capped at the signed number.
  const daily = validateLaunchSettings({ ...d, budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 25 }, 200);
  const dplan = planAdGroup(daily, 200);
  assert.equal(dplan.budget, 25);
  assert.equal(dplan.campaign_budget, 200);
  assert.equal(dplan.schedule_type, "SCHEDULE_FROM_NOW");
  assert.throws(() => validateLaunchSettings({ ...d, budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 25 }, 40), /campaign minimum/);
  assert.throws(() => validateLaunchSettings({ ...d, budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 300 }, 200), /exceeds the approved budget/);
  // Cost cap: the amount lands in the field the billing event keeps it in.
  const cpc = adGroupBody({ ...d, bid_strategy: "COST_CAP", bid_usd: 0.4 }, plan);
  assert.equal(cpc.bid_type, "BID_TYPE_CUSTOM");
  assert.equal(cpc.bid_price, 0.4);
  const ocpm = adGroupBody({ ...d, optimization_goal: "TRAFFIC_LANDING_PAGE_VIEW", bid_strategy: "COST_CAP", bid_usd: 3 }, plan);
  assert.equal(ocpm.billing_event, "OCPM");
  assert.equal(ocpm.conversion_bid_price, 3);
  assert.throws(() => validateLaunchSettings({ ...d, bid_strategy: "COST_CAP", bid_usd: null }, 100), /target cost/);
  // Targeting fields travel; the paused launch state and comments-off reach the body.
  const t = adGroupBody({ ...d, placement: "tiktok", age_groups: ["AGE_18_24"], gender: "GENDER_FEMALE", operating_systems: ["IOS"], start_paused: true, comments_disabled: true }, plan);
  assert.deepEqual(t.placements, ["PLACEMENT_TIKTOK"]);
  assert.deepEqual(t.age_groups, ["AGE_18_24"]);
  assert.equal(t.gender, "GENDER_FEMALE");
  assert.equal(t.operation_status, "DISABLE");
  assert.equal(t.comment_disabled, true);
  assert.ok(summarizeLaunchSettings(d).includes("lowest cost"));
  assert.deepEqual(normalizeLaunchSettings({ gender: "GENDER_NOPE" }), d, "an unknown value falls back to the defaults, never to a partial shape");
  assert.equal(launchNames("pb_x", null, "US").adgroup, "studio-pb_x-US");
  assert.equal(launchNames("pb_x", "Test", "US").copy(2), "Test-pb_x-US-copy2");
});

test("the launch gate refuses a shape that cannot fit the signed budget; settings freeze once launched", async () => {
  const { campaign } = await prepared({ budget: 100, settings: { duplicate_copies: 9 } });
  const detail = await fixtureData.getPromoCampaign(producer(), campaign.id);
  const bc = await fixtureData.getLaunchBusinessCenter(producer(), FIXTURE_PRODUCER_ID);
  const r = launchReadiness({ campaign: detail.campaign, approval: detail.approval, creatives: detail.creatives, account: null, businessCenter: bc, mode: "fake" });
  assert.deepEqual(r.blockers, ["settings_invalid"]);
  const pick0 = await pickLaunchAccount(producer(), FIXTURE_PRODUCER_ID);
  await assert.rejects(fixtureData.submitPromoCampaign(producer(), campaign.id, pick0.ok ? pick0.pick : null), /launch settings/);
  await fixtureData.setLaunchSettings(producer(), campaign.id, { ...defaultLaunchSettings(), duplicate_copies: 1 });
  await assert.rejects(fixtureData.setLaunchSettings(fixtureSession("staff"), campaign.id, { ...defaultLaunchSettings(), gender: "nope" } as unknown as LaunchSettings), (e: Error & { code?: string }) => e.code === "invalid");
  const id = campaign.id;
  const pick = await pickLaunchAccount(producer(), FIXTURE_PRODUCER_ID);
  await fixtureData.submitPromoCampaign(producer(), id, pick.ok ? pick.pick : null);
  await assert.rejects(fixtureData.setLaunchSettings(producer(), id, defaultLaunchSettings()), (e: Error & { code?: string }) => e.code === "frozen");
  const launch = (await fixtureData.getPromoCampaign(producer(), id)).launch!;
  assert.equal(launch.settings.duplicate_copies, 1, "the launch row snapshots the settings it was submitted with");
});

test("a paused launch creates everything switched off; a cost-cap, daily-budget launch caps the campaign", async () => {
  const id = await launched({ budget: 200, settings: { start_paused: true, bid_strategy: "COST_CAP", bid_usd: 0.5, budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 30, placement: "tiktok" } });
  const detail = await fixtureData.getPromoCampaign(producer(), id);
  assert.equal(detail.campaign.status, "paused");
  assert.equal(detail.launch!.paused, true);
  assert.equal(detail.launch!.bid_usd, 0.5);
  const snap = fakeTikTokSnapshot();
  assert.equal(snap.campaigns[0].status, "DISABLE");
  assert.equal(snap.campaigns[0].budgetMode, "BUDGET_MODE_TOTAL");
  assert.equal(snap.campaigns[0].budget, 200, "the signed budget caps the campaign when ad groups run daily");
  assert.equal(snap.adgroups[0].status, "DISABLE");
  assert.equal(snap.adgroups[0].budgetMode, "BUDGET_MODE_DAY");
  assert.equal(snap.adgroups[0].budget, 30);
  assert.equal(snap.adgroups[0].bidType, "BID_TYPE_CUSTOM");
  assert.equal(snap.adgroups[0].bidPrice, 0.5);
  assert.deepEqual(snap.adgroups[0].body.placements, ["PLACEMENT_TIKTOK"]);
  assert.equal(snap.ads[0].body.call_to_action, "WATCH_NOW");
  // Turning it on is the producer approver's call now (decision 2026-09-16); a reviewer may not.
  await assert.rejects(switchCampaign(reviewer(), id, true), (e: Error & { code?: string }) => e.code === "forbidden");
  const on = await switchCampaign(producer(), id, true);
  assert.equal(on.applied, true);
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "ENABLE");
  assert.equal((await fixtureData.getPromoCampaign(producer(), id)).campaign.status, "submitted");
});

test("the producer changes the budget: a lifetime launch re-shares it, a daily launch moves the cap; staff changes are audited overrides", async () => {
  const id = await launched({ budget: 200 });
  const first = await changeBudget(producer(), id, 300);
  assert.equal(first.groups, 1);
  assert.equal(fakeTikTokSnapshot().adgroups[0].budget, 300);
  const d1 = await fixtureData.getPromoCampaign(producer(), id);
  assert.equal(d1.campaign.experiment!.budget_usd, 300);
  assert.equal(d1.campaign.experiment!.version, 2, "a budget change is a new signed experiment version");
  assert.equal(d1.campaign.experiment!.approved_by, producer().userId);
  assert.equal(d1.launch!.budget_usd, 300);
  await assert.rejects(changeBudget(producer(), id, 10), /below TikTok's minimum/);
  await assert.rejects(changeDailyBudget(producer(), id, 40), /lifetime budget/);
  const byStaff = await changeBudget(staff(), id, 250, "cofounder asked");
  assert.equal(byStaff.budget_usd, 250);
  const d2 = await fixtureData.getPromoCampaign(producer(), id);
  assert.match(d2.campaign.status_note ?? "", /Staff override: budget changed to \$250/);
  assert.equal(d2.campaign.experiment!.approved_by, producer().userId, "staff never sign as the approver");
  // Daily shape: the cap moves on the campaign, the daily amount on the groups.
  resetFixtureStore(); resetFakeTikTok(); invalidateMonitor();
  const id2 = await launched({ budget: 200, settings: { budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 25 } });
  await changeBudget(producer(), id2, 400);
  assert.equal(fakeTikTokSnapshot().campaigns[0].budget, 400);
  assert.equal(fakeTikTokSnapshot().adgroups[0].budget, 25, "the daily amount is untouched by a cap change");
  await changeDailyBudget(producer(), id2, 40);
  assert.equal(fakeTikTokSnapshot().adgroups[0].budget, 40);
  assert.equal((await fixtureData.getPromoCampaign(producer(), id2)).launch!.settings.daily_budget_usd, 40);
  await assert.rejects(changeDailyBudget(producer(), id2, 500), /exceeds the approved total/);
});

test("a cost cap edits a capped ad group in place and replaces a lowest-cost one with a capped copy", async () => {
  const id = await launched({ budget: 200 });
  const before = fakeTikTokSnapshot();
  assert.equal(before.adgroups[0].bidType, "BID_TYPE_NO_BID");
  const r = await changeBid(producer(), id, 0.35);
  assert.equal(r.replaced.length, 1, "no-bid groups cannot take a bid: replaced by a capped copy");
  assert.equal(r.edited.length, 0);
  const snap = fakeTikTokSnapshot();
  assert.equal(snap.adgroups.length, 2);
  const copy = snap.adgroups.find((g) => g.adgroupId === r.replaced[0].to)!;
  assert.equal(copy.bidType, "BID_TYPE_CUSTOM");
  assert.equal(copy.bidPrice, 0.35);
  assert.equal(copy.budget, 200, "the copy carries the group's own budget");
  assert.equal(snap.adgroups.find((g) => g.adgroupId === r.replaced[0].from)!.status, "DISABLE", "the original is switched off");
  assert.equal(snap.ads.filter((a) => a.adgroupId === copy.adgroupId).length, 2, "the same two ads run in the copy");
  const detail = await fixtureData.getPromoCampaign(producer(), id);
  assert.deepEqual(detail.launch!.retired_adgroups, [r.replaced[0].from]);
  assert.equal(detail.launch!.bid_usd, 0.35);
  assert.deepEqual(activeAdGroupIds((await fixtureData.getLaunchedCampaign(sys(), id))!), [copy.adgroupId]);
  // Second change: the capped copy is edited in place, nothing new is made.
  const r2 = await changeBid(producer(), id, 0.5);
  assert.deepEqual(r2.edited, [copy.adgroupId]);
  assert.equal(r2.replaced.length, 0);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 2);
  assert.equal(fakeTikTokSnapshot().adgroups.find((g) => g.adgroupId === copy.adgroupId)!.bidPrice, 0.5);
});

test("schedule end, manual copies (re-shared), per-group switch, and end for good", async () => {
  const id = await launched({ budget: 200 });
  const moved = await changeScheduleEnd(producer(), id, "2027-01-15");
  assert.equal(moved.schedule_end, "2027-01-15 23:59:59");
  assert.equal(fakeTikTokSnapshot().adgroups[0].scheduleEnd, "2027-01-15 23:59:59");
  await assert.rejects(changeScheduleEnd(producer(), id, "2020-01-01"), /future/);
  const dup = await duplicateAdGroups(producer(), id, 2);
  assert.equal(dup.created.length, 2);
  assert.deepEqual(dup.errors, []);
  const snap = fakeTikTokSnapshot();
  assert.equal(snap.adgroups.length, 3);
  assert.ok(snap.adgroups.every((g) => g.budget === 66.66), "the signed $200 is re-shared across three groups");
  assert.equal(snap.ads.length, 6);
  const detail = await fixtureData.getPromoCampaign(producer(), id);
  assert.equal(Object.keys(detail.launch!.duplicates).length, 2);
  await assert.rejects(duplicateAdGroups(producer(), id, 19), /below TikTok's minimum/);
  const off = await switchAdGroup(producer(), id, dup.created[0], false);
  assert.equal(off.applied, true);
  assert.equal(fakeTikTokSnapshot().adgroups.find((g) => g.adgroupId === dup.created[0])!.status, "DISABLE");
  await assert.rejects(switchAdGroup(producer(), id, "1719999999999999999", true), (e: Error & { code?: string }) => e.code === "not_found");
  const ended = await endCampaign(producer(), id, "enough");
  assert.equal(ended.applied, true);
  const after = await fixtureData.getPromoCampaign(producer(), id);
  assert.equal(after.campaign.status, "ended");
  assert.match(after.campaign.status_note ?? "", /Ended by .*: enough/);
  assert.equal(fakeTikTokSnapshot().campaigns[0].status, "DISABLE");
  await assert.rejects(switchCampaign(producer(), id, true), /ended campaign/);
  await assert.rejects(changeBudget(producer(), id, 300), /ended campaign/);
});

test("the auto-duplicate pass makes the copies once the ads clear review, with the lifetime shares the launch planned", async () => {
  const id = await launched({ budget: 300, settings: { duplicate_copies: 2 } });
  assert.equal(fakeTikTokSnapshot().adgroups[0].budget, 100, "the original already holds one third of the signed budget");
  const row = () => fixtureData.getLaunchedCampaign(sys(), id);
  const early = await autoDuplicatePass((await row())!);
  assert.equal(early.decided, false, "still in review: nothing happens yet");
  await approvedOnTikTok(id);
  const pass = await autoDuplicatePass((await row())!);
  assert.equal(pass.created.length, 2);
  assert.equal(pass.decided, true);
  const snap = fakeTikTokSnapshot();
  assert.equal(snap.adgroups.length, 3);
  assert.ok(snap.adgroups.every((g) => g.budget === 100 && g.status === "ENABLE"));
  assert.equal(snap.ads.length, 6);
  const launch = (await fixtureData.getPromoCampaign(producer(), id)).launch!;
  assert.ok(launch.duplicated_at, "decided exactly once");
  const again = await autoDuplicatePass((await row())!);
  assert.equal(again.created.length, 0);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 3, "never a fourth group");
  // The scheduler drives the same pass; a rejected launch settles without copies.
  resetFixtureStore(); resetFakeTikTok(); invalidateMonitor();
  process.env.TIKTOK_FAKE_REVIEW = "reject";
  const id2 = await launched({ budget: 300, settings: { duplicate_copies: 2 } });
  await tick({ metrics: false });
  const l2 = (await fixtureData.getPromoCampaign(producer(), id2)).launch!;
  assert.ok(l2.duplicated_at, "every ad rejected: decided, no copies");
  assert.equal(Object.keys(l2.duplicates).length, 0);
  assert.equal(fakeTikTokSnapshot().adgroups.length, 1);
});

test("the monitor reads the campaign, its ad groups, the review and the lifetime numbers; a suspended account is flagged", async () => {
  const id = await launched({ budget: 200 });
  await approvedOnTikTok(id);
  const m = await buildMonitor(staff(), { force: true });
  assert.equal(m.rows.length, 1);
  const r = m.rows[0];
  assert.equal(r.campaign_id, id);
  assert.equal(r.on, true);
  assert.equal(r.review.rollup, "approved");
  assert.equal(r.adgroups.length, 1);
  assert.equal(r.adgroups[0].role, "primary");
  assert.equal(r.adgroups[0].budget, 200);
  assert.ok(r.metrics && r.metrics.spend > 0 && r.metrics.clicks > 0);
  assert.equal(r.account.health, "ready");
  assert.equal(r.sweep_error, null);
  assert.equal(rollupReview([{ adId: "1", state: "approved", reasons: [] }, { adId: "2", state: "rejected", reasons: ["x"] }]), "rejected", "the worst state present leads");
  // The producer sees only their own campaign, through the same sweep.
  const mine = await buildMonitor(producer(), { campaignId: id });
  assert.equal(mine.rows.length, 1);
  await assert.rejects(fixtureData.getLaunchedCampaign({ ...producer(), producerId: "00000000-0000-4000-8000-000000000099" }, id), (e: Error & { code?: string }) => e.code === "not_found");
  // A suspended account: the switch is accepted and ignored, the poll writes the note, the monitor flags it.
  process.env.TIKTOK_FAKE_ACCOUNT = "suspended";
  const flip = await switchCampaign(producer(), id, false);
  assert.equal(flip.applied, false);
  assert.match(flip.note ?? "", /suspended/);
  await pollCampaignReview((await fixtureData.getLaunchedCampaign(sys(), id))!);
  assert.match((await fixtureData.getPromoCampaign(producer(), id)).campaign.status_note ?? "", /suspended/);
  const m2 = await buildMonitor(staff(), { force: true });
  assert.equal(m2.rows[0].account.suspended, true);
  assert.equal(m2.rows[0].account.health, "blocked");
});

test("relaunch on another account: only after end/failure, only inside the company's Business Center, a new launch row", async () => {
  const id = await launched({ budget: 200 });
  const other = FAKE_BC_ACCOUNTS[1];
  const resolved = { advertiser_id: other, identity_id: `${other.slice(0, -3)}101`, identity_type: "BC_AUTH_TT" as const, source: "business_center" as const, bc_id: FAKE_BC_ID };
  await assert.rejects(fixtureData.relaunchOnAccount(staff(), id, resolved), /end it first/);
  await assert.rejects(fixtureData.relaunchOnAccount(producer(), id, resolved), (e: Error & { code?: string }) => e.code === "forbidden");
  await endCampaign(producer(), id);
  await assert.rejects(fixtureData.relaunchOnAccount(staff(), id, { ...resolved, bc_id: "7009999999999999999" }), /inside the company's assigned Business Center/);
  const launch = await fixtureData.relaunchOnAccount(staff(), id, resolved, "first account suspended");
  assert.equal(launch.advertiser_id, other);
  assert.match(launch.idempotency_key, /:relaunch1$/);
  assert.equal((await fixtureData.getPromoCampaign(producer(), id)).campaign.status, "launching");
  const outcome = await runLaunch(launch.id);
  assert.equal(outcome.status, "done", outcome.error);
  const snap = fakeTikTokSnapshot();
  assert.equal(snap.campaigns.length, 2, "a second TikTok campaign, on the other account, after the first was ended");
  assert.equal(snap.campaigns[0].status, "DISABLE");
  assert.equal(snap.campaigns[1].advertiserId, other);
  const detail = await fixtureData.getPromoCampaign(producer(), id);
  assert.equal(detail.campaign.status, "submitted");
  assert.equal(detail.campaign.grow_campaign_id, snap.campaigns[1].campaignId);
});

test("presets are Pulsar-wide, admin-written; the producer's preferred account leads the pick when it is ready", async () => {
  await assert.rejects(fixtureData.saveLaunchPreset(producer(), { name: "x", settings: defaultLaunchSettings() }), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.saveLaunchPreset(staff(), { name: "", settings: defaultLaunchSettings() }), (e: Error & { code?: string }) => e.code === "invalid");
  const p = await fixtureData.saveLaunchPreset(staff(), { name: "US cost cap", settings: { ...defaultLaunchSettings(), bid_strategy: "COST_CAP", bid_usd: 0.4 }, note: "house default" });
  assert.equal((await fixtureData.listLaunchPresets(producer())).length, 1, "producers read presets");
  const p2 = await fixtureData.saveLaunchPreset(staff(), { id: p.id, name: "US cost cap 0.45", settings: { ...p.settings, bid_usd: 0.45 } });
  assert.equal(p2.id, p.id);
  assert.equal(p2.settings.bid_usd, 0.45);
  await fixtureData.deleteLaunchPreset(staff(), p.id);
  assert.equal((await fixtureData.listLaunchPresets(staff())).length, 0);
  // Preferred account.
  await assert.rejects(fixtureData.setPreferredLaunchAccount(producer(), FAKE_BC_ACCOUNTS[1]), /no Business Center/);
  await fixtureData.assignBusinessCenter(staff(), FIXTURE_PRODUCER_ID, { bc_id: FAKE_BC_ID, name: "Pulsar BC" });
  const first = await pickLaunchAccount(producer(), FIXTURE_PRODUCER_ID);
  assert.ok(first.ok && first.pick.advertiser_id === FAKE_BC_ACCOUNTS[0], "without a preference the first ready account wins");
  await fixtureData.setPreferredLaunchAccount(producer(), FAKE_BC_ACCOUNTS[1]);
  await assert.rejects(fixtureData.setPreferredLaunchAccount({ ...producer(), producerRole: "viewer" }, null), (e: Error & { code?: string }) => e.code === "forbidden");
  const second = await pickLaunchAccount(producer(), FIXTURE_PRODUCER_ID);
  assert.ok(second.ok && second.pick.advertiser_id === FAKE_BC_ACCOUNTS[1], "the preferred account leads");
  await fixtureData.setPreferredLaunchAccount(producer(), null);
  const third = await pickLaunchAccount(producer(), FIXTURE_PRODUCER_ID);
  assert.ok(third.ok && third.pick.advertiser_id === FAKE_BC_ACCOUNTS[0]);
});
