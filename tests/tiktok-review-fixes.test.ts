// Regressions for the 2026-09-16 review of the launch controls. Each test
import { withHistoricalPromoSeed } from "@/lib/data/fixture";
const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, () => withHistoricalPromoSeed(fn));
// names the finding it closes; each asserts the correct behaviour against
// what the fake TikTok recorded (spend, switches, budgets), on the empty
// fixture seed. Nothing leaves the process.

import { afterEach, beforeEach, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { renameSync } from "node:fs";

import { FIXTURE_PRODUCER_ID, systemSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { putStoredBytes, resolveUploadPath } from "@/lib/data/storage";
import { autoDuplicatePass } from "@/lib/tiktok/autodup";
import { invalidateBusinessCenters, pickLaunchAccount } from "@/lib/tiktok/business-centers";
import { changeBid, changeBudget, plannedGroupCount, relaunchOnAnotherAccount, switchAdGroup, switchCampaign } from "@/lib/tiktok/controls";
import { tiktokTransport } from "@/lib/tiktok";
import { FAKE_BC_ACCOUNTS, FAKE_BC_ID, fakeTikTokSnapshot, resetFakeTikTok } from "@/lib/tiktok/fake";
import { runLaunch } from "@/lib/tiktok/launch";
import { creativeByAdId, resultsFromReport, syncCampaignResults } from "@/lib/tiktok/metrics";
import { invalidateMonitor } from "@/lib/tiktok/monitor";
import { pollCampaignReview } from "@/lib/tiktok/review";
import { defaultLaunchSettings, type LaunchSettings } from "@/lib/tiktok/settings";
import { producer, seedRenderedClips, staff } from "./seed-minute";

const sys = () => systemSession();
const snap = () => fakeTikTokSnapshot();
const sumBudgets = (campaignId: string) => snap().adgroups.filter((g) => g.campaignId === campaignId && g.status === "ENABLE").reduce((n, g) => n + g.budget, 0);

beforeEach(() => { resetFixtureStore(); resetFakeTikTok(); invalidateBusinessCenters(); invalidateMonitor(); delete process.env.TIKTOK_FAKE_REVIEW; delete process.env.TIKTOK_FAKE_ACCOUNT; });
afterEach(() => { resetFixtureStore(); resetFakeTikTok(); delete process.env.TIKTOK_FAKE_REVIEW; delete process.env.TIKTOK_FAKE_ACCOUNT; });

async function prepared(opts: { budget?: number; settings?: Partial<LaunchSettings> } = {}) {
  const title = await fixtureData.createTitle(producer(), { name_zh: "向园", name_en: "Xiang Yuan", producer_id: "ignored" });
  const videoPath = `${title.id}/episode-1/source.mp4`;
  await putStoredBytes(videoPath, Buffer.from("bytes the fake TikTok accepts as a video"), "video/mp4");
  const episode = await fixtureData.addVideoOnlyEpisode(producer(), title.id, 1, videoPath);
  await seedRenderedClips(title.id, episode.id, 2);
  const campaign = await fixtureData.createPromoCampaign(producer(), {
    title_id: title.id, name: "Round 1", target_market: "US", destination_url: "https://example.com/watch", objective: "views", spoiler_level: "low",
    experiment: { budget_usd: opts.budget ?? 200, hypothesis: "The reversal opening wins.", audience: "US women 25-44", first_batch: 2, signal: "views" },
  });
  const drafts = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  for (const c of drafts.slice(0, 2)) await fixtureData.reviewPromoCreative(producer(), c.id, { status: "approved" });
  if (opts.settings) await fixtureData.setLaunchSettings(producer(), campaign.id, { ...defaultLaunchSettings(), ...opts.settings });
  await fixtureData.approvePromoCampaign(producer(), campaign.id);
  await fixtureData.approveExperiment(producer(), campaign.id);
  await fixtureData.assignBusinessCenter(staff(), FIXTURE_PRODUCER_ID, { bc_id: FAKE_BC_ID, name: "Pulsar BC" });
  return { campaign };
}

async function launched(opts: { budget?: number; settings?: Partial<LaunchSettings> } = {}) {
  const { campaign } = await prepared(opts);
  const pick = await pickLaunchAccount(producer(), FIXTURE_PRODUCER_ID);
  const sent = await fixtureData.submitPromoCampaign(producer(), campaign.id, pick.ok ? pick.pick : null);
  const outcome = await runLaunch(sent.launch!.id);
  assert.equal(outcome.status, "done", outcome.error);
  return campaign.id;
}

const row = (id: string) => fixtureData.getLaunchedCampaign(sys(), id);
async function approvedOnTikTok(id: string) {
  await pollCampaignReview((await row(id))!);
  await pollCampaignReview((await row(id))!);
  assert.equal((await fixtureData.getPromoCampaign(producer(), id)).campaign.status, "live");
}

test("finding 1: a budget change before auto-duplication never lets the groups exceed the new total", async () => {
  const id = await launched({ budget: 200, settings: { duplicate_copies: 1 } });
  assert.equal(snap().adgroups[0].budget, 100, "one pending copy: the original holds half at launch");
  const launch = (await fixtureData.getPromoCampaign(producer(), id)).launch!;
  assert.equal(plannedGroupCount(launch, launch.settings, 1), 2);
  await changeBudget(producer(), id, 300);
  assert.equal(snap().adgroups[0].budget, 150, "the new total is shared across the planned groups, not handed whole to the original");
  await approvedOnTikTok(id);
  const pass = await autoDuplicatePass((await row(id))!);
  assert.equal(pass.created.length, 1);
  assert.deepEqual(snap().adgroups.map((g) => g.budget), [150, 150]);
  assert.equal(sumBudgets(snap().campaigns[0].campaignId), 300, "original + copy = exactly the signed $300");
  // And the other order: a budget change AFTER duplication shares across what exists.
  await changeBudget(producer(), id, 400);
  assert.deepEqual(snap().adgroups.map((g) => g.budget), [200, 200]);
  // The pass re-shares a drifted original before it copies (a budget change that slipped through would still be corrected).
  resetFixtureStore(); resetFakeTikTok(); invalidateMonitor();
  const id2 = await launched({ budget: 300, settings: { duplicate_copies: 2 } });
  await approvedOnTikTok(id2);
  const g0 = snap().adgroups[0];
  g0.budget = 300; // simulate a raise that bypassed the share (an Ads Manager edit)
  await autoDuplicatePass((await row(id2))!);
  assert.deepEqual(snap().adgroups.map((g) => g.budget), [100, 100, 100], "the pass re-shares the original to its planned share first");
});

test("finding 2: relaunch after a partial failure switches the previous campaign off and confirms it before creating another", async () => {
  const { campaign } = await prepared({ budget: 200 });
  const before = await fixtureData.getPromoCampaign(producer(), campaign.id);
  const chosen = before.creatives.filter((c) => c.status === "approved");
  const missingFile = resolveUploadPath(chosen[1].render_path!);
  renameSync(missingFile, `${missingFile}.away`);
  try {
    const pick = await pickLaunchAccount(producer(), FIXTURE_PRODUCER_ID);
    const sent = await fixtureData.submitPromoCampaign(producer(), campaign.id, pick.ok ? pick.pick : null);
    const first = await runLaunch(sent.launch!.id);
    assert.equal(first.status, "failed");
  } finally {
    renameSync(`${missingFile}.away`, missingFile);
  }
  const s1 = snap();
  assert.equal(s1.campaigns.length, 1);
  assert.equal(s1.campaigns[0].status, "ENABLE", "a failed launch can still hold a live campaign with the ad that made it");
  assert.equal(s1.ads.length, 1);
  const other = FAKE_BC_ACCOUNTS[1];
  const resolved = { advertiser_id: other, identity_id: `${other.slice(0, -3)}101`, identity_type: "BC_AUTH_TT" as const, source: "business_center" as const, bc_id: FAKE_BC_ID };
  const r = await relaunchOnAnotherAccount(staff(), campaign.id, resolved, "account suspended");
  assert.equal(r.switched_off, true);
  assert.equal(r.previous_campaign_id, s1.campaigns[0].campaignId);
  assert.equal(snap().campaigns[0].status, "DISABLE", "the previous campaign was switched off before the new launch row existed");
  // The record names what was retired until delivery settles (the engine clears the note once the new launch is created).
  assert.match((await fixtureData.getPromoCampaign(producer(), campaign.id)).campaign.status_note ?? "", new RegExp(`previous campaign ${s1.campaigns[0].campaignId} switched off`));
  const outcome = await runLaunch(r.launch.id);
  assert.equal(outcome.status, "done", outcome.error);
  assert.equal(snap().campaigns.length, 2);
  assert.equal(snap().campaigns.filter((c) => c.status === "ENABLE").length, 1, "exactly one campaign delivers");
  // A suspended account refuses to confirm the switch-off: no relaunch.
  resetFixtureStore(); resetFakeTikTok(); invalidateMonitor();
  const id2 = await launched({ budget: 200 });
  await fixtureData.setPromoCampaignDelivery(sys(), id2, { status: "failed", status_note: "simulated" });
  process.env.TIKTOK_FAKE_ACCOUNT = "suspended";
  await assert.rejects(relaunchOnAnotherAccount(staff(), id2, resolved), /still on according to TikTok/);
  assert.equal(snap().campaigns.length, 1, "nothing new was created");
});

test("finding 3: a cost-cap replacement carries only what the old group has not spent", async () => {
  const id = await launched({ budget: 200 });
  await approvedOnTikTok(id);
  const oldGroup = snap().adgroups[0];
  const spentReport = await syncCampaignResults((await row(id))!);
  assert.ok(spentReport.written > 0);
  const spent = (await fixtureData.listCreativeResults(producer())).reduce((n, r) => n + r.spend_usd, 0);
  assert.ok(spent > 0 && spent < 200, `the fake has spent some of the $200 (${spent})`);
  const r = await changeBid(producer(), id, 0.4);
  assert.equal(r.replaced.length, 1);
  const copy = snap().adgroups.find((g) => g.adgroupId === r.replaced[0].to)!;
  assert.ok(Math.abs(copy.budget - (200 - spent)) < 0.02, `the copy gets the remainder: ${copy.budget} ≈ 200 − ${spent}`);
  assert.equal(r.replaced[0].budget, copy.budget);
  assert.equal(snap().adgroups.find((g) => g.adgroupId === oldGroup.adgroupId)!.status, "DISABLE");
  assert.ok(spent + copy.budget <= 200.01, "spend so far + the copy's ceiling never exceeds the signed budget");
  // Too little left: refused, nothing created.
  resetFixtureStore(); resetFakeTikTok(); invalidateMonitor();
  const id2 = await launched({ budget: 100 });
  await approvedOnTikTok(id2);
  snap().adgroups[0].budget = 22; // a group whose remainder after the fake's first day is below the $20 minimum
  await assert.rejects(changeBid(producer(), id2, 0.4), /below TikTok's \$20 minimum/);
  assert.equal(snap().adgroups.length, 1, "nothing was created");
  assert.equal(snap().adgroups[0].status, "ENABLE", "and the old group was not switched off");
});

test("finding 4: a bid change keeps a paused ad group paused", async () => {
  const id = await launched({ budget: 200 });
  await approvedOnTikTok(id);
  const gid = snap().adgroups[0].adgroupId;
  await switchAdGroup(producer(), id, gid, false);
  assert.equal(snap().adgroups[0].status, "DISABLE");
  const r = await changeBid(producer(), id, 0.4);
  const copy = snap().adgroups.find((g) => g.adgroupId === r.replaced[0].to)!;
  assert.equal(copy.status, "DISABLE", "the replacement inherits the paused state; nothing starts delivering by surprise");
  assert.equal(copy.bidType, "BID_TYPE_CUSTOM");
  await switchAdGroup(producer(), id, copy.adgroupId, true);
  assert.equal(snap().adgroups.find((g) => g.adgroupId === copy.adgroupId)!.status, "ENABLE");
});

test("finding 5: the first switch-on of a launch created paused enables its ad groups; later group pauses stay", async () => {
  const id = await launched({ budget: 200, settings: { start_paused: true } });
  assert.equal(snap().campaigns[0].status, "DISABLE");
  assert.equal(snap().adgroups[0].status, "DISABLE");
  const on = await switchCampaign(producer(), id, true);
  assert.equal(on.applied, true);
  assert.equal(on.groups_enabled, 1);
  assert.equal(snap().campaigns[0].status, "ENABLE");
  assert.equal(snap().adgroups[0].status, "ENABLE", "Resume delivers: the group creation switched off comes on with the campaign");
  const launch = (await fixtureData.getPromoCampaign(producer(), id)).launch!;
  assert.ok(launch.activated_at);
  // A deliberate group pause survives a later campaign pause/resume.
  await switchAdGroup(producer(), id, snap().adgroups[0].adgroupId, false);
  await switchCampaign(producer(), id, false);
  const again = await switchCampaign(producer(), id, true);
  assert.equal(again.groups_enabled, undefined);
  assert.equal(snap().adgroups[0].status, "DISABLE", "the group someone paused on purpose stays paused");
});

test("finding 6: copy ads report into their creatives; nothing a copy spends is dropped", async () => {
  const id = await launched({ budget: 300, settings: { duplicate_copies: 2 } });
  await approvedOnTikTok(id);
  await autoDuplicatePass((await row(id))!);
  const r = (await row(id))!;
  assert.equal(Object.keys(r.launch.duplicates).length, 2);
  const map = creativeByAdId(r);
  assert.equal(map.size, 6, "two original ads and four copy ads all map to a creative");
  const perCreative = new Map<string, number>();
  for (const cid of map.values()) perCreative.set(cid, (perCreative.get(cid) ?? 0) + 1);
  assert.deepEqual([...perCreative.values()], [3, 3]);
  // Six ads reporting $10 each on one day → two creative rows of $30, not $20 total.
  const rows = [...map.keys()].map((ad_id) => ({ ad_id, date: "2026-09-16", spend: 10, impressions: 1000, clicks: 10, conversion: 0, video_play_actions: 500, video_watched_2s: 200, video_watched_6s: 80 }));
  const results = resultsFromReport(r, rows, "2026-09-16T12:00:00.000Z");
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((x) => x.spend_usd), [30, 30]);
  assert.deepEqual(results.map((x) => x.impressions), [3000, 3000]);
  assert.equal(results[0].hook_hold_rate, 0.4);
  // Through the fake: the sync writes every group's spend.
  const sync = await syncCampaignResults(r);
  assert.ok(sync.written > 0);
  const stored = await fixtureData.listCreativeResults(producer());
  const total = stored.reduce((n, x) => n + x.spend_usd, 0);
  // What the fake itself says every group spent, summed: the creative rows must carry all of it, not the original group's share alone.
  const rep = await tiktokTransport().get("/report/integrated/get/", "fake-token", { advertiser_id: r.launch.advertiser_id, report_type: "BASIC", data_level: "AUCTION_ADGROUP", dimensions: JSON.stringify(["adgroup_id"]), metrics: JSON.stringify(["spend"]), start_date: "2026-01-01", end_date: new Date().toISOString().slice(0, 10), filtering: JSON.stringify([{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([r.launch.tiktok_campaign_id]) }]) });
  const groups = (rep.data?.list ?? []) as Array<{ dimensions: { adgroup_id: string }; metrics: { spend: number } }>;
  assert.equal(groups.length, 3, "three groups deliver");
  const fakeTotal = groups.reduce((n, g) => n + g.metrics.spend, 0);
  const originalOnly = groups.find((g) => g.dimensions.adgroup_id === r.launch.tiktok_adgroup_id)!.metrics.spend;
  assert.ok(total > originalOnly + 1, `creative results (${total}) carry more than the original group (${originalOnly})`);
  assert.ok(Math.abs(total - fakeTotal) < 0.05, `creative results (${total}) equal every group's spend (${fakeTotal})`);
});

test("finding 7 (data): manual duplication settles the auto-duplicate question so the pass cannot add on top", async () => {
  const id = await launched({ budget: 300, settings: { duplicate_copies: 2 } });
  await approvedOnTikTok(id);
  const { duplicateAdGroups } = await import("@/lib/tiktok/controls");
  await duplicateAdGroups(producer(), id, 1);
  assert.equal(snap().adgroups.length, 2);
  const pass = await autoDuplicatePass((await row(id))!);
  assert.equal(pass.created.length, 0);
  assert.equal(snap().adgroups.length, 2, "the person chose one copy; the pass does not add its two on top");
});
