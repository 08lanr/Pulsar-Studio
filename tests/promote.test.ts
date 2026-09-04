import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { producer } from "./seed-minute";

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

test("Promote shares the title video and creates a varied six-concept review batch", async () => {
  const { campaign } = await campaignWithVideo();
  const creatives = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  assert.equal(creatives.length, 6);
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
