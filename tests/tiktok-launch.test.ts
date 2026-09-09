// The TikTok launch inside Studio (decision 2026-09-09): the readiness gate,
// the idempotent launch engine against the fake TikTok, the review poll, the
// metrics read-back with its provenance, the staff controls and the account
// request flow. Everything runs on the empty fixture seed and the fake
// transport: no request leaves the process.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { FIXTURE_PRODUCER_ID, systemSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { putStoredBytes } from "@/lib/data/storage";
import { blockerMessage, isReadyLaunchAccount, launchReadiness } from "@/lib/promote/launch-gate";
import { launchMode } from "@/lib/tiktok";
import { fakeTikTokSnapshot, resetFakeTikTok } from "@/lib/tiktok/fake";
import { runLaunch, scheduleDays } from "@/lib/tiktok/launch";
import { resultsFromReport, syncCampaignResults } from "@/lib/tiktok/metrics";
import { normalizeReview, pollCampaignReview } from "@/lib/tiktok/review";
import { tick } from "@/lib/tiktok/scheduler";
import { switchCampaign } from "@/lib/tiktok/controls";
import type { CompanyAccount } from "@/lib/types";
import { producer, staff } from "./seed-minute";

const ADV = "7000000000000000001";
const IDENTITY = "7000000000000000101";

beforeEach(() => { resetFixtureStore(); resetFakeTikTok(); delete process.env.TIKTOK_FAKE_REVIEW; });
afterEach(() => { resetFixtureStore(); resetFakeTikTok(); delete process.env.TIKTOK_FAKE_REVIEW; });

/** Title + tiny video + campaign with destination and budget; the account is assigned separately so tests can test its absence. */
async function prepared(opts: { budget?: number; destination?: string | null } = {}) {
  const title = await fixtureData.createTitle(producer(), { name_zh: "向园", name_en: "Xiang Yuan", producer_id: "ignored" });
  const videoPath = `${title.id}/episode-1/source.mp4`;
  await putStoredBytes(videoPath, Buffer.from("bytes the fake TikTok accepts as a video"), "video/mp4");
  await fixtureData.addVideoOnlyEpisode(producer(), title.id, 1, videoPath);
  const campaign = await fixtureData.createPromoCampaign(producer(), {
    title_id: title.id, name: "Round 1", target_market: "US", destination_url: opts.destination === undefined ? "https://example.com/watch" : opts.destination,
    objective: "views", spoiler_level: "low",
    experiment: { budget_usd: opts.budget ?? 100, hypothesis: "The reversal opening wins.", audience: "US women 25-44", first_batch: 2, signal: "views" },
  });
  await fixtureData.generatePromoDrafts(producer(), campaign.id);
  await fixtureData.approveAllPromoCreatives(producer(), campaign.id);
  await fixtureData.approvePromoCampaign(producer(), campaign.id);
  await fixtureData.approveExperiment(producer(), campaign.id);
  return { title, campaign };
}

const assign = () => fixtureData.assignLaunchAccount(staff(), FIXTURE_PRODUCER_ID, { advertiser_id: ADV, name: "Xinghai US Ads", identity_id: IDENTITY, identity_type: "BC_AUTH_TT" });

async function launched() {
  const { campaign } = await prepared();
  await assign();
  const sent = await fixtureData.submitPromoCampaign(producer(), campaign.id);
  const outcome = await runLaunch(sent.launch!.id);
  assert.equal(outcome.status, "done");
  return campaign.id;
}

test("fixture mode always launches into the fake TikTok, whatever TIKTOK_MODE says", () => {
  const saved = process.env.TIKTOK_MODE;
  process.env.TIKTOK_MODE = "production";
  assert.equal(launchMode(), "fake");
  if (saved === undefined) delete process.env.TIKTOK_MODE; else process.env.TIKTOK_MODE = saved;
});

test("the launch gate names every blocker, and a producer-recorded account is never a launch account", async () => {
  const { campaign } = await prepared({ destination: null, budget: 10 });
  const detail = await fixtureData.getPromoCampaign(producer(), campaign.id);
  const r = launchReadiness({ campaign: detail.campaign, approval: detail.approval, creatives: detail.creatives, account: null, mode: "production" });
  assert.deepEqual(r.blockers, ["budget_below_minimum", "no_destination", "unrendered_creatives", "no_launch_account"]);
  assert.match(blockerMessage("no_launch_account"), /no TikTok ad account/);
  // The producer records a "connected" ad account themselves: it must not route Pulsar's token anywhere.
  const self = await fixtureData.upsertCompanyAccount(producer(), { provider: "tiktok", kind: "ad_account", name: "Mine", external_ref: "7009999999999999999", state: "connected", access: "owner_operated" });
  assert.equal(isReadyLaunchAccount(self), false);
  assert.equal(await fixtureData.getLaunchAccount(producer(), FIXTURE_PRODUCER_ID), null);
  await assert.rejects(fixtureData.submitPromoCampaign(producer(), campaign.id), /at least \$20/);
  // In fake mode unrendered creatives pass (the source file stands in); everything else still gates.
  const fake = launchReadiness({ campaign: detail.campaign, approval: detail.approval, creatives: detail.creatives, account: self, mode: "fake" });
  assert.deepEqual(fake.blockers, ["budget_below_minimum", "no_destination", "no_launch_account"]);
});

test("staff assign the launch account; the producer cannot edit it afterwards", async () => {
  await assert.rejects(fixtureData.assignLaunchAccount(producer(), FIXTURE_PRODUCER_ID, { advertiser_id: ADV, name: "x", identity_id: null, identity_type: null }), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.assignLaunchAccount(staff(), FIXTURE_PRODUCER_ID, { advertiser_id: "abc", name: "x", identity_id: null, identity_type: null }), /numeric/);
  const account = await assign();
  assert.equal(account.state, "connected");
  assert.equal(account.assigned_by, staff().userId);
  assert.ok(isReadyLaunchAccount(account));
  const ready = await fixtureData.getLaunchAccount(producer(), FIXTURE_PRODUCER_ID);
  assert.equal(ready?.id, account.id);
  await assert.rejects(fixtureData.upsertCompanyAccount(producer(), { id: account.id, provider: "tiktok", kind: "ad_account", name: "Hijack", external_ref: "7001111111111111111", state: "connected", access: "partner" }), (e: Error & { code?: string }) => e.code === "frozen");
  // A second assignment updates the same row rather than adding one.
  await assign();
  const rows = (await fixtureData.listCompanyAccounts(producer())).filter((a: CompanyAccount) => a.provider === "tiktok" && a.kind === "ad_account");
  assert.equal(rows.length, 1);
});

test("the engine creates campaign → ad group → ads once, with the approved budget as the ceiling, and never twice", async () => {
  const { campaign } = await prepared({ budget: 100 });
  await assign();
  const sent = await fixtureData.submitPromoCampaign(producer(), campaign.id);
  assert.equal(sent.campaign.status, "launching");
  assert.equal(sent.launch?.mode, "fake");
  assert.equal(sent.launch?.budget_usd, 100);
  assert.equal(sent.launch?.destination_url, "https://example.com/watch");
  const first = await runLaunch(sent.launch!.id);
  assert.equal(first.status, "done");
  let snap = fakeTikTokSnapshot();
  assert.equal(snap.campaigns.length, 1);
  assert.equal(snap.adgroups.length, 1);
  assert.equal(snap.adgroups[0].budget, 100, "the ad group's lifetime budget is exactly the approved budget");
  assert.equal(snap.ads.length, 5, "every approved creative became one ad");
  const detail = await fixtureData.getPromoCampaign(producer(), campaign.id);
  assert.equal(detail.campaign.status, "submitted");
  assert.equal(detail.campaign.grow_campaign_id, snap.campaigns[0].campaignId);
  assert.equal(detail.campaign.advertiser_id, ADV);
  assert.ok(detail.campaign.launched_at);
  assert.equal(detail.launch?.identity_id, IDENTITY);
  // Running the same launch again, or submitting again, creates nothing new on TikTok.
  await runLaunch(sent.launch!.id);
  await fixtureData.submitPromoCampaign(producer(), campaign.id);
  snap = fakeTikTokSnapshot();
  assert.equal(snap.campaigns.length, 1);
  assert.equal(snap.ads.length, 5);
  assert.equal(scheduleDays(100), 5);
  assert.equal(scheduleDays(20), 1);
  assert.equal(scheduleDays(10_000), 30);
});

test("a failed launch resumes at its first unfinished step and does not duplicate the TikTok campaign", async () => {
  const { campaign } = await prepared();
  await assign();
  const sent = await fixtureData.submitPromoCampaign(producer(), campaign.id);
  await runLaunch(sent.launch!.id);
  // Simulate a crash after the campaign step: mark the row failed but keep its recorded ids.
  const sys = systemSession();
  const launch = await fixtureData.getPromoLaunch(sys, sent.launch!.id);
  await fixtureData.updatePromoLaunch(sys, launch.id, { status: "failed", error: "simulated crash", ad_ids: {} });
  await fixtureData.setPromoCampaignDelivery(sys, campaign.id, { status: "failed", status_note: "simulated crash" });
  await assert.rejects(fixtureData.retryPromoLaunch(producer(), campaign.id), (e: Error & { code?: string }) => e.code === "forbidden");
  const retried = await fixtureData.retryPromoLaunch(staff(), campaign.id);
  assert.equal(retried.status, "pending");
  const again = await runLaunch(retried.id);
  assert.equal(again.status, "done");
  const snap = fakeTikTokSnapshot();
  assert.equal(snap.campaigns.length, 1, "the recorded campaign id was reused");
  assert.equal(snap.adgroups.length, 1);
  assert.equal(snap.ads.length, 10, "ads were re-created (their ids had been lost); the campaign and ad group were not");
  await assert.rejects(fixtureData.updatePromoLaunch(sys, retried.id, { tiktok_campaign_id: "1" }), (e: Error & { code?: string }) => e.code === "frozen");
  await assert.rejects(fixtureData.updatePromoLaunch(staff(), retried.id, { error: "x" }), (e: Error & { code?: string }) => e.code === "forbidden");
});

test("the review poll settles submitted → live, and every-ad-rejected → failed with TikTok's reasons", async () => {
  const id = await launched();
  const sys = systemSession();
  const rows = () => fixtureData.listLaunchedPromoCampaigns(sys);
  assert.equal((await rows()).length, 1);
  const p1 = await pollCampaignReview((await rows())[0]);
  assert.equal(p1.status, "submitted", "first look: TikTok is still reviewing");
  const p2 = await pollCampaignReview((await rows())[0]);
  assert.equal(p2.status, "live");
  assert.equal((await fixtureData.getPromoCampaign(producer(), id)).campaign.status, "live");
  // A rejection path on a fresh launch.
  resetFixtureStore(); resetFakeTikTok();
  process.env.TIKTOK_FAKE_REVIEW = "reject";
  const id2 = await launched();
  await pollCampaignReview((await rows())[0]);
  const failed = await fixtureData.getPromoCampaign(producer(), id2);
  assert.equal(failed.campaign.status, "failed");
  assert.match(failed.campaign.status_note ?? "", /rejected every ad/);
  assert.equal(normalizeReview("1", { review_status: "ALL_AVAILABLE" }, undefined).state, "not_reviewed", "unreviewed is not approved");
  assert.equal(normalizeReview("1", {}, "AD_STATUS_WEIRD_NEW_VALUE").state, "unknown", "an unknown status never reads as approved");
});

test("metrics read back one row per ad per day, labelled demo in fixture mode, hook hold as the 2-second rate, upserted", async () => {
  const id = await launched();
  const sys = systemSession();
  const row = (await fixtureData.listLaunchedPromoCampaigns(sys))[0];
  await pollCampaignReview(row); // the fake reports only for ads it has ruled on
  const first = await syncCampaignResults(row);
  assert.ok(first.written > 0);
  const results = await fixtureData.listCreativeResults(producer());
  assert.ok(results.every((r) => r.source === "demo"), "fixture read-back is labelled demo, never tiktok");
  assert.ok(results.every((r) => r.hook_hold_rate >= 0 && r.hook_hold_rate <= 1));
  assert.ok(results.every((r) => r.landing_actions === null), "no source observes landing actions: null, never 0");
  assert.equal(results.filter((r) => r.campaign_id === id).length, results.length);
  const second = await syncCampaignResults(row);
  assert.equal((await fixtureData.listCreativeResults(producer())).length, results.length, "a re-read updates rows, it does not duplicate them");
  assert.equal(second.written, first.written);
  // The mapping itself: plays of 0 give a 0 hold (row kept), and unknown ads are ignored.
  const mapped = resultsFromReport(row, [
    { ad_id: Object.values(row.launch.ad_ids)[0], date: "2026-09-09", spend: 10.126, impressions: 1000, clicks: 12, conversion: 0, video_play_actions: 500, video_watched_2s: 200, video_watched_6s: 90 },
    { ad_id: "nope", date: "2026-09-09", spend: 1, impressions: 1, clicks: 0, conversion: 0, video_play_actions: 0, video_watched_2s: 0, video_watched_6s: 0 },
  ], "2026-09-09T12:00:00.000Z");
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].hook_hold_rate, 0.4);
  assert.equal(mapped[0].spend_usd, 10.13);
  assert.equal(mapped[0].video_views, 500);
  await assert.rejects(fixtureData.upsertCreativeResults(staff(), []), (e: Error & { code?: string }) => e.code === "forbidden");
});

test("staff pause and resume on TikTok, read back; the scheduler tick runs clean in fixture mode", async () => {
  const id = await launched();
  const sys = systemSession();
  await pollCampaignReview((await fixtureData.listLaunchedPromoCampaigns(sys))[0]);
  await pollCampaignReview((await fixtureData.listLaunchedPromoCampaigns(sys))[0]);
  assert.equal((await fixtureData.getPromoCampaign(producer(), id)).campaign.status, "live");
  await assert.rejects(switchCampaign(producer(), id, false), (e: Error & { code?: string }) => e.code === "forbidden");
  const paused = await switchCampaign(staff(), id, false);
  assert.equal(paused.applied, true);
  assert.equal((await fixtureData.getPromoCampaign(producer(), id)).campaign.status, "paused");
  const resumed = await switchCampaign(staff(), id, true);
  assert.equal(resumed.status, "submitted", "back to submitted until the poll sees delivery again");
  const summary = await tick({ metrics: true });
  assert.deepEqual(summary.errors, []);
  assert.ok(summary.polled >= 1);
  assert.equal((await fixtureData.getPromoCampaign(producer(), id)).campaign.status, "live");
});

test("account requests: one open per company, payment opt-in is brand/last4/holder only, staff resolve or fulfil", async () => {
  await assert.rejects(fixtureData.createAccountRequest(producer(), { contact_name: "陈总", contact_email: "not-an-email" }), /email/);
  await assert.rejects(fixtureData.createAccountRequest(producer(), { contact_name: "陈总", contact_email: "chen@xinghai.example", payment: { brand: "Visa", last4: "12", holder: "Chen" } }), /last four/);
  const req = await fixtureData.createAccountRequest(producer(), { contact_name: "陈总", contact_email: "chen@xinghai.example", payment: { brand: "Visa", last4: "4242", holder: "Chen Wei" }, note: "US only" });
  assert.equal(req.status, "requested");
  assert.deepEqual(Object.keys(req.payment!).sort(), ["brand", "holder", "last4", "method", "opted_in_at"]);
  await assert.rejects(fixtureData.createAccountRequest(producer(), { contact_name: "陈总", contact_email: "chen@xinghai.example" }), (e: Error & { code?: string }) => e.code === "conflict");
  assert.equal((await fixtureData.listAccountRequests(producer())).length, 1);
  assert.equal((await fixtureData.listAccountRequests(staff())).length, 1);
  await assert.rejects(fixtureData.resolveAccountRequest(producer(), req.id, { status: "provisioning" }), (e: Error & { code?: string }) => e.code === "forbidden");
  const prov = await fixtureData.resolveAccountRequest(staff(), req.id, { status: "provisioning", staff_note: "Creating in BC" });
  assert.equal(prov.status, "provisioning");
  const account = await fixtureData.assignLaunchAccount(staff(), FIXTURE_PRODUCER_ID, { advertiser_id: ADV, name: "Xinghai US Ads", identity_id: IDENTITY, identity_type: "BC_AUTH_TT", request_id: req.id });
  const done = (await fixtureData.listAccountRequests(staff()))[0];
  assert.equal(done.status, "assigned");
  assert.equal(done.account_id, account.id);
  await assert.rejects(fixtureData.createAccountRequest(producer(), { contact_name: "陈总", contact_email: "chen@xinghai.example" }), /already has/);
});
