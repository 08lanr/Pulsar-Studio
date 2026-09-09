import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { demoTitleId } from "@/data/fixture/demo-catalog";
import { adCtr, adSpend, adStatus, isAdvertising, isOnPlatform, matchesQuickFilter, platformStatus } from "@/lib/research/title-status";
import { loadTitleWorkspace } from "@/lib/research/title-workspace";
import type { CreativeResult, PromoCampaignSummary } from "@/lib/types";

afterEach(() => resetFixtureStore());

const producer = () => fixtureSession("producer");

function campaign(over: Partial<PromoCampaignSummary>): PromoCampaignSummary {
  return { id: "c", external_id: "pb_c", title_id: "t", producer_id: "p", name: "x", target_market: "US", destination_url: null, objective: "views", spoiler_level: "low", creative_direction: null, exclusions: null, experiment: null, status: "draft", grow_campaign_id: null, advertiser_id: null, tiktok_adgroup_id: null, status_note: null, launched_at: null, created_by: "u", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", title_name_zh: "x", title_name_en: null, producer_name_zh: "p", producer_name_en: null, creative_count: 0, approved_count: 0, pending_count: 0, change_count: 0, ...over };
}
const result = (campaign_id: string, over: Partial<CreativeResult> = {}): CreativeResult => ({ id: `r-${campaign_id}`, campaign_id, creative_id: "cr", source: "demo", window_start: "2026-09-01", window_end: "2026-09-06", impressions: 10_000, video_views: 5_000, hook_hold_rate: 0.3, clicks: 120, spend_usd: 50, landing_actions: null, observed_at: "2026-09-06T00:00:00.000Z", ...over });

test("platform status is read from the analytics state; a link is not publication and no link is unknown", () => {
  assert.equal(platformStatus("available"), "reporting");
  assert.equal(platformStatus("partial"), "reporting");
  assert.equal(platformStatus("stale"), "stale");
  assert.equal(platformStatus("sync_failed"), "sync_failed");
  assert.equal(platformStatus("linked_awaiting_data"), "awaiting_data");
  assert.equal(platformStatus("needs_listing_link"), "not_linked");
  assert.equal(platformStatus(null), "not_linked");
  assert.equal(isOnPlatform("awaiting_data"), false, "a linked listing without data does not prove publication");
  assert.equal(isOnPlatform("stale"), true, "data was delivered once: the title is on the platform");
});

test("ad status follows the latest campaign record and its results; submitted is not running", () => {
  assert.equal(adStatus([], []).status, "none");
  assert.equal(adStatus([campaign({ status: "draft" })], []).status, "preparing");
  assert.equal(adStatus([campaign({ status: "review", creative_count: 5 })], []).status, "preparing");
  assert.equal(adStatus([campaign({ status: "review", creative_count: 5, approved_count: 2 })], []).status, "awaiting_approval");
  assert.equal(adStatus([campaign({ status: "approved" })], []).status, "awaiting_approval");
  const approvedBudget = { budget_usd: 100, currency: "USD" as const, hypothesis: "", audience: "", first_batch: 2, signal: "views" as const, approved_by: "u", approved_at: "2026-09-02T00:00:00.000Z", version: 1, updated_at: "2026-09-02T00:00:00.000Z" };
  assert.equal(adStatus([campaign({ status: "approved", experiment: approvedBudget })], []).status, "ready_to_launch");
  assert.equal(adStatus([campaign({ status: "submitted" })], []).status, "submitted");
  assert.equal(adStatus([campaign({ status: "submitted" })], [result("c")]).status, "results");
  assert.equal(adStatus([campaign({ status: "live" })], []).status, "running");
  assert.equal(adStatus([campaign({ status: "failed" })], []).status, "failed");
  // the latest round decides
  const rounds = [campaign({ id: "old", status: "live", updated_at: "2026-09-01T00:00:00.000Z" }), campaign({ id: "new", status: "draft", updated_at: "2026-09-05T00:00:00.000Z" })];
  const r = adStatus(rounds, [result("old")]);
  assert.equal(r.status, "preparing");
  assert.equal(r.campaign?.id, "new");
  assert.equal(r.rounds, 2);
  assert.equal(isAdvertising("submitted"), true);
  assert.equal(isAdvertising("ready_to_launch"), false);
});

test("quick filters overlap by definition and 'preparing' means neither", () => {
  assert.equal(matchesQuickFilter("on_tiktok", "reporting", "none"), true);
  assert.equal(matchesQuickFilter("ads_active", "reporting", "results"), true);
  assert.equal(matchesQuickFilter("on_tiktok", "reporting", "results"), true, "a title can be in both groups");
  assert.equal(matchesQuickFilter("preparing", "reporting", "none"), false);
  assert.equal(matchesQuickFilter("preparing", "awaiting_data", "preparing"), true);
  assert.equal(matchesQuickFilter("preparing", "not_linked", "submitted"), false);
  assert.equal(matchesQuickFilter("all", "not_linked", "none"), true);
});

test("ad spend and CTR aggregate every reported row, and are null without rows or impressions", () => {
  assert.equal(adSpend([]), null);
  assert.equal(adSpend([result("a"), result("b", { spend_usd: 25.5 })]), 75.5);
  assert.equal(adCtr([]), null);
  assert.equal(adCtr([result("a", { impressions: 0, clicks: 0 })]), null);
  const c = adCtr([result("a"), result("b", { impressions: 30_000, clicks: 240 })])!;
  assert.equal(c.impressions, 40_000);
  assert.equal(c.clicks, 360);
  assert.equal(c.ctr, 0.009);
});

test("the title workspace loader agrees with the catalog on both statuses and scopes to the company", async () => {
  resetFixtureStore("demo");
  const w = await loadTitleWorkspace(producer(), demoTitleId(1));
  assert.equal(w.platform, "reporting");
  assert.equal(w.ads.status, "results");
  assert.equal(w.ads.rounds, 1);
  assert.equal(w.tiktok?.title_id, demoTitleId(1));
  const unlinked = await loadTitleWorkspace(producer(), demoTitleId(3));
  assert.equal(unlinked.platform, "not_linked");
  assert.equal(unlinked.ads.status, "none");
  const other = { ...fixtureSession("producer"), producerId: "00000000-0000-4000-8000-00000000ffff" };
  await assert.rejects(loadTitleWorkspace(other, demoTitleId(1)), /NEXT_NOT_FOUND|not found/i);
  assert.equal((await fixtureData.listTitlePerformance(other)).length, 0);
});
