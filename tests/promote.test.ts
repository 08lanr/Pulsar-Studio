import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { FIXTURE_PRODUCER_ID } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { putStoredBytes } from "@/lib/data/storage";
import { resetFakeTikTok } from "@/lib/tiktok/fake";
import { runLaunch } from "@/lib/tiktok/launch";
import { producer, staff } from "./seed-minute";

afterEach(() => { resetFixtureStore(); resetFakeTikTok(); });

/** A title with one (tiny, fake) video, a campaign with a destination and a budget, and a launch account assigned by staff. */
async function campaignWithVideo() {
  resetFixtureStore();
  resetFakeTikTok();
  const title = await fixtureData.createTitle(producer(), { name_zh: "向园", name_en: "Xiang Yuan", producer_id: "ignored" });
  const videoPath = `${title.id}/episode-1/source.mp4`;
  await putStoredBytes(videoPath, Buffer.from("not really an mp4, but bytes the fake TikTok accepts"), "video/mp4");
  await fixtureData.addVideoOnlyEpisode(producer(), title.id, 1, videoPath);
  const campaign = await fixtureData.createPromoCampaign(producer(), {
    title_id: title.id,
    name: "US launch",
    target_market: "US",
    destination_url: "https://example.com/watch/xiang-yuan",
    objective: "subscriptions",
    spoiler_level: "medium",
    experiment: { budget_usd: 100, hypothesis: "The reversal opening beats the romance opening.", audience: "US women 25-44", first_batch: 2, signal: "views" },
  });
  await fixtureData.assignLaunchAccount(staff(), FIXTURE_PRODUCER_ID, { advertiser_id: "7000000000000000001", name: "Test ad account", identity_id: "7000000000000000101", identity_type: "BC_AUTH_TT" });
  return { title, campaign };
}

test("Promote shares the title video and creates a varied five-concept review batch", async () => {
  const { campaign } = await campaignWithVideo();
  const creatives = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  assert.equal(creatives.length, 5, "one testable round at a time");
  assert.ok(creatives.some((x) => x.kind === "direct_clip"));
  assert.ok(creatives.some((x) => x.kind === "ugc_story"));
  assert.ok(creatives.every((x) => x.source_episode_id && x.source_end_ms! > x.source_start_ms!));
  const detail = await fixtureData.getPromoCampaign(producer(), campaign.id);
  assert.equal(detail.campaign.status, "review");
  assert.equal(detail.episodes.length, 1, "Promote reads the shared core episode");
});

test("approval freezes the selected creative manifest and the launch is idempotent on it", async () => {
  const { campaign } = await campaignWithVideo();
  const [first, second] = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  await fixtureData.reviewPromoCreative(producer(), first.id, { status: "approved" });
  await assert.rejects(
    fixtureData.reviewPromoCreative(producer(), second.id, { status: "rejected" }),
    /tell us what to change/
  );
  await fixtureData.reviewPromoCreative(producer(), second.id, { status: "rejected", rejection_note: "Use a less revealing opening." });
  const approved = await fixtureData.approvePromoCampaign(producer(), campaign.id);
  assert.equal(approved.campaign.status, "approved");
  assert.match(approved.approval!.manifest_sha256, /^[0-9a-f]{64}$/);
  assert.equal((approved.approval!.manifest as { creatives: unknown[] }).creatives.length, 1);
  assert.equal(approved.creatives.find((x) => x.id === second.id)?.status, "not_selected");

  await assert.rejects(fixtureData.submitPromoCampaign(producer(), campaign.id), /sign the budget/);
  await fixtureData.approveExperiment(producer(), campaign.id);
  const sent = await fixtureData.submitPromoCampaign(producer(), campaign.id);
  const retried = await fixtureData.submitPromoCampaign(producer(), campaign.id);
  assert.equal(sent.campaign.status, "launching");
  assert.ok(sent.launch && sent.launch.status === "pending");
  assert.equal(retried.launch?.id, sent.launch?.id, "a second press resumes the same launch record");
  assert.equal(retried.handoffs.length, 1, "retry does not create a second submission record");
  assert.equal(retried.handoffs[0].status, "accepted");
  const outcome = await runLaunch(sent.launch!.id);
  assert.equal(outcome.status, "done");
  const launched = await fixtureData.getPromoCampaign(producer(), campaign.id);
  assert.equal(launched.campaign.status, "submitted", "created on TikTok, awaiting TikTok's review");
  assert.match(launched.campaign.grow_campaign_id ?? "", /^\d{17}$/);
  assert.equal(Object.keys(launched.launch!.ad_ids).length, 1, "one ad per approved creative");
});

test("keep-all approves every creative still waiting, and nothing else", async () => {
  const { campaign } = await campaignWithVideo();
  const [first] = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  await fixtureData.reviewPromoCreative(producer(), first.id, { status: "rejected", rejection_note: "Too much of the twist." });
  const detail = await fixtureData.approveAllPromoCreatives(producer(), campaign.id);
  const active = detail.creatives.filter((c) => c.status !== "superseded");
  assert.equal(active.filter((c) => c.status === "approved").length, 4);
  assert.equal(active.find((c) => c.id === first.id)?.status, "rejected", "a change request is not silently kept");
  await fixtureData.approvePromoCampaign(producer(), campaign.id);
  await assert.rejects(fixtureData.approveAllPromoCreatives(producer(), campaign.id), /review is closed/);
});

test("Pulsar answers a change request with a new version; the producer sees only the revision", async () => {
  const { campaign } = await campaignWithVideo();
  const [first] = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  await fixtureData.reviewPromoCreative(producer(), first.id, { status: "rejected", rejection_note: "Open later, after the slap." });
  await assert.rejects(
    fixtureData.revisePromoCreative(producer(), first.id, { hook: "x", caption: "y", ad_description: "z" }),
    (e: Error) => /staff only/.test(e.message)
  );
  const revision = await fixtureData.revisePromoCreative(staff(), first.id, {
    hook: "It starts with the slap.", caption: "New caption", ad_description: "New description", source_start_ms: 6_000, source_end_ms: 20_000, revision_note: "Moved the cut 6s later, past the slap.",
  });
  assert.equal(revision.version, 2);
  assert.equal(revision.parent_creative_id, first.id);
  assert.equal(revision.status, "ready");
  assert.equal(revision.rejection_note, null);
  assert.equal(revision.revision_note, "Moved the cut 6s later, past the slap.");
  const detail = await fixtureData.getPromoCampaign(producer(), campaign.id);
  assert.equal(detail.creatives.find((c) => c.id === first.id)?.status, "superseded");
  assert.equal(detail.creatives.filter((c) => c.status !== "superseded").length, 5, "the round still has five live concepts");
  const summary = (await fixtureData.listPromoCampaigns(staff())).find((c) => c.id === campaign.id)!;
  assert.equal(summary.change_count, 0, "answering the request clears Pulsar's queue");
  assert.equal(summary.pending_count, 5);
  await assert.rejects(fixtureData.revisePromoCreative(staff(), first.id, { hook: "a", caption: "b", ad_description: "c" }), /awaiting review or change/);
});

test("staff may override a launched campaign's status, in order, and only staff", async () => {
  const { campaign } = await campaignWithVideo();
  await fixtureData.generatePromoDrafts(producer(), campaign.id);
  await fixtureData.approveAllPromoCreatives(producer(), campaign.id);
  await assert.rejects(fixtureData.advancePromoCampaign(staff(), campaign.id, { status: "live" }), /cannot move/);
  await fixtureData.approvePromoCampaign(producer(), campaign.id);
  await fixtureData.approveExperiment(producer(), campaign.id);
  const sent = await fixtureData.submitPromoCampaign(producer(), campaign.id);
  await runLaunch(sent.launch!.id);
  await assert.rejects(fixtureData.advancePromoCampaign(producer(), campaign.id, { status: "launching" }), (e: Error) => /staff only/.test(e.message));
  const live = await fixtureData.advancePromoCampaign(staff(), campaign.id, { status: "live", note: "Checked in Ads Manager." });
  assert.equal(live.campaign.status, "live");
  assert.match(live.campaign.status_note ?? "", /Staff override/);
  await assert.rejects(fixtureData.advancePromoCampaign(staff(), campaign.id, { status: "failed" }), /cannot move/);
  const summary = (await fixtureData.listPromoCampaigns(staff())).find((c) => c.id === campaign.id)!;
  assert.equal(summary.producer_name_zh.length > 0, true);
});
