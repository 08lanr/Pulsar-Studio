import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { resolveUploadPath } from "@/lib/data/storage";
import { buildDemoSeed, DEMO_CLIP_MS, demoCampaignId, demoTitleId } from "@/data/fixture/demo-catalog";
import { BENCHMARK } from "@/lib/research/assessment";
import { nextRoundName, readResults } from "@/lib/research/results";
import type { CreativeResult, PromoCreative } from "@/lib/types";

afterEach(() => resetFixtureStore());

const producer = () => fixtureSession("producer");

// ---- the demo journey seed ----------------------------------------------------------------

test("the demo seed is one coherent journey: distinct campaigns, one per title, real media, labelled results", async () => {
  const seed = buildDemoSeed();
  const names = seed.campaigns.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "no duplicate campaign names");
  assert.equal(new Set(seed.campaigns.map((c) => c.title_id)).size, seed.campaigns.length, "one campaign per title");
  assert.ok(names.every((n) => /round 1$/.test(n)), "every seeded campaign is a first round");
  for (const e of seed.episodes) if (e.video_path) assert.equal(e.duration_ms, DEMO_CLIP_MS, "video episodes carry the real clip's duration");
  assert.ok(seed.results.every((r) => r.source === "demo"));
  // the journey title carries the market's launch signal and the campaign with results
  const c1 = seed.campaigns.find((c) => c.id === demoCampaignId(1))!;
  assert.equal(c1.title_id, demoTitleId(1));
  assert.equal(c1.status, "submitted");
  // two finished rounds carry results: campaign 1 (title 1) and campaign 4 (Rise of the Son-in-Law, title 8)
  const c4 = seed.campaigns.find((c) => c.id === demoCampaignId(4))!;
  assert.equal(c4.status, "submitted");
  assert.ok(seed.results.every((r) => r.campaign_id === c1.id || r.campaign_id === c4.id));
  assert.equal(seed.results.filter((r) => r.campaign_id === c1.id).length, 2);
  assert.equal(seed.results.filter((r) => r.campaign_id === c4.id).length, 2);

  // building the store links the clip under .uploads so previews play
  resetFixtureStore("demo");
  const detail = await fixtureData.getTitle(producer(), demoTitleId(1));
  const withVideo = detail.episodes.filter((e) => e.has_video);
  assert.equal(withVideo.length, 6);
  const seeded = seed.episodes.find((e) => e.title_id === demoTitleId(1) && e.number === 1)!;
  assert.ok(existsSync(resolveUploadPath(seeded.video_path!)), "episode 1 video exists on disk");
});

test("a reset restores the seeded rows after a demo action", async () => {
  resetFixtureStore("demo");
  const c2 = demoCampaignId(2);
  await fixtureData.approveAllPromoCreatives(producer(), c2);
  assert.equal((await fixtureData.getPromoCampaign(producer(), c2)).creatives.filter((c) => c.status === "approved").length, 5);
  resetFixtureStore("demo");
  assert.equal((await fixtureData.getPromoCampaign(producer(), c2)).creatives.filter((c) => c.status === "approved").length, 0);
});

// ---- reading results against the benchmarks ------------------------------------------------

function creative(id: string, over: Partial<PromoCreative> = {}): PromoCreative {
  return { id, external_id: `pc_${id}`, campaign_id: "c", title_id: "t", parent_creative_id: null, version: 1, kind: "direct_clip", status: "approved", hypothesis: `H ${id}`, source_episode_id: null, source_start_ms: null, source_end_ms: null, hook: "hook", caption: "", ad_description: "", render_path: null, render_sha256: null, duration_ms: null, width: null, height: null, render_settings: {}, rejection_note: null, revision_note: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", ...over };
}
function result(id: string, creative_id: string, over: Partial<CreativeResult> = {}): CreativeResult {
  return { id, campaign_id: "c", creative_id, source: "demo", window_start: "2026-09-01", window_end: "2026-09-06", impressions: 10_000, video_views: 5_000, hook_hold_rate: 0.35, clicks: 150, spend_usd: 50, landing_actions: 20, observed_at: "2026-09-06T09:00:00.000Z", ...over };
}

test("readResults names the ad that met both benchmarks, derives rates without inventing zeros, and keeps provenance", () => {
  const creatives = [creative("a"), creative("b"), creative("c", { status: "not_selected" })];
  const rows = [
    result("r1", "a", { hook_hold_rate: 0.41, clicks: 159, impressions: 10_000 }), // 1.59% CTR: met both
    result("r2", "b", { hook_hold_rate: 0.27, clicks: 86, impressions: 10_000, landing_actions: null }), // missed both
    result("r3", "c", { hook_hold_rate: 0.5, clicks: 0, impressions: 0, video_views: 0, spend_usd: 0 }), // nothing served
  ];
  const reading = readResults(rows, creatives, BENCHMARK);
  assert.equal(reading.winner?.result.id, "r1");
  assert.equal(reading.rows[0].verdict, "met_both");
  assert.equal(reading.rows[0].ad_number, 1);
  assert.equal(reading.rows[1].verdict, "missed_both");
  assert.equal(reading.rows[1].cost_per_action, null, "unreported landing actions give no cost per action");
  assert.equal(reading.rows[2].verdict, "no_impressions");
  assert.equal(reading.rows[2].ctr, null, "no impressions: CTR is unknown, not 0%");
  assert.equal(reading.rows[2].cpc, null);
  assert.equal(Math.round(reading.rows[0].cpm! * 100) / 100, 5);
  assert.equal(reading.totals.spend_usd, 100);
  assert.deepEqual(reading.window, { start: "2026-09-01", end: "2026-09-06" });
  assert.deepEqual(reading.sources, ["demo"]);
  assert.equal(reading.demo_only, true);
  // one qualifying rule only: hold ≥ 30% AND ctr ≥ 1.2%
  const none = readResults([result("x", "a", { hook_hold_rate: 0.45, clicks: 100 })], creatives, BENCHMARK); // 1.0% CTR
  assert.equal(none.winner, null);
  assert.equal(none.rows[0].verdict, "missed_ctr");
  assert.equal(readResults([], creatives, BENCHMARK).window, null);
});

test("the seeded campaign reads the same way on the page and in the loop test", async () => {
  resetFixtureStore("demo");
  const detail = await fixtureData.getPromoCampaign(producer(), demoCampaignId(1));
  const reading = readResults(detail.results, detail.creatives, BENCHMARK);
  assert.equal(reading.winner?.ad_number, 1);
  assert.equal(reading.rows.filter((x) => x.verdict === "met_both").length, 1);
  assert.equal(reading.demo_only, true);
});

test("round names count the title's rounds, in either language, without stacking markers", () => {
  assert.equal(nextRoundName("Rebirth vs romance opening — US test, round 1", 2), "Rebirth vs romance opening — US test, round 2");
  assert.equal(nextRoundName("Rebirth vs romance opening — US test, round 2", 3), "Rebirth vs romance opening — US test, round 3");
  assert.equal(nextRoundName("Alpha bride hooks", 2), "Alpha bride hooks, round 2");
  assert.equal(nextRoundName("Alpha bride hooks — round 2", 3, "zh"), "Alpha bride hooks，第 3 轮");
  assert.equal(nextRoundName("狼王替嫁，第 2 轮", 3, "zh"), "狼王替嫁，第 3 轮");
});
