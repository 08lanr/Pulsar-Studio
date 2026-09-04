import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { producer, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

async function campaignWithVideo() {
  resetFixtureStore();
  const title = await fixtureData.createTitle(producer(), { name_zh: "向园", name_en: "Xiang Yuan", producer_id: "ignored" });
  await fixtureData.addVideoOnlyEpisode(producer(), title.id, 1, `${title.id}/episode-1/source.mp4`);
  const campaign = await fixtureData.createPromoCampaign(producer(), {
    title_id: title.id,
    name: "US launch",
    target_market: "US",
    objective: "subscriptions",
    spoiler_level: "medium",
  });
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

test("approval freezes the selected creative manifest and mock handoff is idempotent", async () => {
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

  const sent = await fixtureData.submitPromoCampaignMock(producer(), campaign.id);
  const retried = await fixtureData.submitPromoCampaignMock(producer(), campaign.id);
  assert.equal(sent.campaign.status, "submitted");
  assert.equal(retried.handoffs.length, 1, "retry does not create a second Grow campaign");
  assert.equal(retried.handoffs[0].status, "accepted");
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

test("staff track the Grow launch on a submitted campaign, in order", async () => {
  const { campaign } = await campaignWithVideo();
  await fixtureData.generatePromoDrafts(producer(), campaign.id);
  await fixtureData.approveAllPromoCreatives(producer(), campaign.id);
  await assert.rejects(fixtureData.advancePromoCampaign(staff(), campaign.id, { status: "live" }), /cannot move/);
  await fixtureData.approvePromoCampaign(producer(), campaign.id);
  await fixtureData.submitPromoCampaignMock(producer(), campaign.id);
  await assert.rejects(fixtureData.advancePromoCampaign(producer(), campaign.id, { status: "launching" }), (e: Error) => /staff only/.test(e.message));
  const launching = await fixtureData.advancePromoCampaign(staff(), campaign.id, { status: "launching", grow_campaign_id: "cmp_real_123", note: "Created in Grow." });
  assert.equal(launching.campaign.status, "launching");
  assert.equal(launching.campaign.grow_campaign_id, "cmp_real_123");
  const live = await fixtureData.advancePromoCampaign(staff(), campaign.id, { status: "live" });
  assert.equal(live.campaign.status, "live");
  await assert.rejects(fixtureData.advancePromoCampaign(staff(), campaign.id, { status: "failed" }), /cannot move/);
  const summary = (await fixtureData.listPromoCampaigns(staff())).find((c) => c.id === campaign.id)!;
  assert.equal(summary.producer_name_zh.length > 0, true);
});
