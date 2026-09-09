import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { DEMO_TITLES, demoCampaignId, demoTitleId } from "@/data/fixture/demo-catalog";
import { assessTitle, BENCHMARK, type AssessmentInput } from "@/lib/research/assessment";
import { experimentStage, loadWorkspace } from "@/lib/research/workspace";
import { campaignWorkflow } from "@/lib/research/workflow";
import { resetMarketCache } from "@/lib/research/snapshot";
import { resetFakeTikTok } from "@/lib/tiktok/fake";
import { runLaunch } from "@/lib/tiktok/launch";

afterEach(() => {
  resetFixtureStore();
  resetMarketCache();
});

const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");
const reviewer = () => ({ ...fixtureSession("producer"), producerRole: "reviewer" as const });
const viewer = () => ({ ...fixtureSession("producer"), producerRole: "viewer" as const });
const other = () => ({ ...fixtureSession("producer"), producerId: "00000000-0000-4000-8000-00000000ffff" });

// ---- the demo seed ------------------------------------------------------------------

test("the demo seed fills every workspace surface and stays company-scoped", async () => {
  resetFixtureStore("demo");
  const titles = await fixtureData.listTitles(producer());
  assert.equal(titles.length, DEMO_TITLES.length);
  const t1 = await fixtureData.getTitle(producer(), demoTitleId(1));
  assert.equal(t1.episodes.filter((e) => e.version_status === "approved").length, 2, "two finalized episodes");
  assert.equal(t1.episodes.filter((e) => e.has_video).length, 6);
  assert.ok((await fixtureData.getResearchProfile(producer()))?.goal);
  assert.equal((await fixtureData.listWatchlist(producer())).length, 3);
  assert.equal((await fixtureData.listReportRows(producer())).length, 6);
  assert.equal((await fixtureData.listPromoCampaigns(producer())).length, 4);
  assert.equal((await fixtureData.listCompanyAccounts(producer())).length, 4);
  const results = await fixtureData.listCreativeResults(producer());
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.source === "demo"), "seeded results are labelled demo");
  assert.deepEqual(await fixtureData.listTitles(other()), []);
  assert.deepEqual(await fixtureData.listCreativeResults(other()), []);
  assert.deepEqual(await fixtureData.listCompanyAccounts(other()), []);
});

test("the empty seed is still empty", async () => {
  resetFixtureStore("empty");
  assert.deepEqual(await fixtureData.listTitles(producer()), []);
  assert.deepEqual(await fixtureData.listCompanyAccounts(producer()), []);
});

// ---- the assessment ----------------------------------------------------------------

test("the workspace scores every demo title with reasons; bands and next actions are explained", async () => {
  resetFixtureStore("demo");
  const ws = await loadWorkspace(producer(), { today: "2026-09-08" });
  assert.equal(ws.titles.length, DEMO_TITLES.length);
  for (const x of ws.titles) {
    assert.ok(x.assessment.score >= 0 && x.assessment.score <= 100);
    assert.equal(x.assessment.components.length, 5);
    assert.equal(x.assessment.components.reduce((a, c) => a + c.points, 0), x.assessment.score);
    assert.ok(x.assessment.next.length > 0);
    for (const c of x.assessment.components) assert.ok(c.points <= c.max);
  }
  const t1 = ws.titles.find((x) => x.summary.id === demoTitleId(1))!;
  assert.equal(t1.assessment.band, "test_first", "approved subtitles, video, reports, demo results, US target");
  assert.ok(t1.assessment.score > 60);
  const own = t1.assessment.components.find((c) => c.key === "own_evidence")!;
  assert.ok(own.facts.some((f) => f.key === "ws.fact.resultsDemo"), "demo results are named as demo");
  const t2 = ws.titles.find((x) => x.summary.id === demoTitleId(2))!;
  assert.equal(t2.assessment.band, "hold", "expired license holds the title regardless of story match");
  assert.ok(t2.assessment.next.includes("ws.next.renew"));
  const t13 = ws.titles.find((x) => x.summary.id === demoTitleId(13))!;
  assert.ok(t13.assessment.score < t1.assessment.score);
  assert.equal(ws.titles[0].assessment.score, Math.max(...ws.titles.map((x) => x.assessment.score)), "sorted by score");
});

test("no synopsis, no reports, no tests → insufficient, with the synopsis as the first action", () => {
  const base: AssessmentInput = {
    summary: { id: "t", external_id: "ttl_x", name_zh: "x", name_en: null, producer_id: "p", producer_name_zh: "p", producer_name_en: null, genre: null, status: "candidate", episode_count: 0, episodes_ingested: 0, percent_adapted: 0, cost_cents: 0, updated_at: "2026-09-08T00:00:00Z" },
    row: { id: "t", name_zh: "x", name_en: null, genre: null, synopsis_zh: null, synopsis_en: null },
    detail: { license_start: null, license_end: null, approved_episodes: 0, episodes_with_video: 0, china_metrics: null },
    market: { titles: [], scores: new Map(), stats: [], observed_at: null, hasHistory: false },
    reports: [],
    campaigns: [],
    results: [],
    accounts: [],
    profile: null,
    today: "2026-09-08",
  };
  const a = assessTitle(base);
  assert.equal(a.band, "insufficient");
  assert.equal(a.score, 0);
  assert.equal(a.next[0], "ws.next.synopsis");
  assert.ok(a.components.find((c) => c.key === "market_signal")!.facts[0].key === "ws.fact.noHistory");
});

// ---- experiments --------------------------------------------------------------------

test("experiment records are typed and versioned; approval needs the approver; submitted rounds freeze", async () => {
  resetFixtureStore("demo");
  const c2 = demoCampaignId(2);
  const saved = await fixtureData.setExperiment(reviewer(), c2, { budget_usd: 150, hypothesis: "A sharper hook beats the contract-bride framing for this audience.", audience: "US women 18-34", first_batch: 2, signal: "views" });
  assert.equal(saved.experiment?.budget_usd, 150);
  assert.equal(saved.experiment?.version, 2);
  assert.equal(saved.experiment?.approved_at, null, "a save clears approval");
  await assert.rejects(fixtureData.approveExperiment(reviewer(), c2), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.setExperiment(viewer(), c2, saved.experiment!), (e: Error & { code?: string }) => e.code === "forbidden");
  const approved = await fixtureData.approveExperiment(producer(), c2);
  assert.ok(approved.experiment?.approved_at);
  await assert.rejects(fixtureData.setExperiment(producer(), demoCampaignId(1), saved.experiment!), (e: Error & { code?: string }) => e.code === "frozen");
  await assert.rejects(fixtureData.setExperiment(other(), c2, saved.experiment!), (e: Error & { code?: string }) => e.code === "not_found" || e.code === "forbidden");
});

test("demo results are labelled, idempotent, and only follow a submitted campaign", async () => {
  resetFixtureStore("demo");
  await assert.rejects(fixtureData.simulateDemoResults(producer(), demoCampaignId(2)), (e: Error & { code?: string }) => e.code === "conflict");
  const before = (await fixtureData.listCreativeResults(producer())).length;
  const detail = await fixtureData.simulateDemoResults(producer(), demoCampaignId(1));
  assert.equal(detail.results.length, 2, "the seeded results stand; nothing is added twice");
  assert.equal((await fixtureData.listCreativeResults(producer())).length, before);
  // A fresh submitted campaign gets deterministic demo rows, one per selected creative.
  resetFakeTikTok();
  const c4 = await fixtureData.submitPromoCampaign(producer(), demoCampaignId(4));
  assert.equal(c4.campaign.status, "launching");
  await runLaunch(c4.launch!.id);
  assert.equal((await fixtureData.getPromoCampaign(producer(), demoCampaignId(4))).campaign.status, "submitted");
  const d4 = await fixtureData.simulateDemoResults(producer(), demoCampaignId(4));
  assert.equal(d4.results.length, 2);
  assert.ok(d4.results.every((r) => r.source === "demo"));
  assert.equal(d4.campaign.status, "live");
  const again = await fixtureData.simulateDemoResults(producer(), demoCampaignId(4));
  assert.equal(again.results.length, 2);
  await assert.rejects(fixtureData.simulateDemoResults(staff(), demoCampaignId(4)));
});

test("experiment stages follow the loop", async () => {
  resetFixtureStore("demo");
  const campaigns = await fixtureData.listPromoCampaigns(producer());
  const results = await fixtureData.listCreativeResults(producer());
  const stage = (n: number) => experimentStage(campaigns.find((c) => c.id === demoCampaignId(n))!, results);
  assert.deepEqual(stage(3), { stage: "brief", waiting: "generate" });
  assert.deepEqual(stage(2), { stage: "concepts", waiting: "select" });
  assert.deepEqual(stage(4), { stage: "submitted", waiting: "submit" });
  assert.deepEqual(stage(1), { stage: "decide", waiting: "decide" });
});

test("workflow actions follow actual approval and handoff transitions", async () => {
  resetFixtureStore("demo");
  const id = demoCampaignId(2);
  const flow = async () => {
    const c = (await fixtureData.listPromoCampaigns(producer())).find(c => c.id === id)!;
    return campaignWorkflow(c, await fixtureData.listCreativeResults(producer()));
  };
  assert.equal((await flow()).step, "choose");
  const detail = await fixtureData.getPromoCampaign(producer(),id);
  await fixtureData.reviewPromoCreative(producer(),detail.creatives[0].id,{status:"approved"});
  assert.equal((await flow()).step,"approveAds", "choosing an ad is not final campaign approval");
  await fixtureData.approvePromoCampaign(producer(),id);
  assert.equal((await flow()).step,"budget");
  await fixtureData.approveExperiment(producer(),id);
  assert.equal((await flow()).step,"launch");
  assert.equal((await flow()).waiting,false,"ready for a real user action");
  resetFakeTikTok();
  const sent = await fixtureData.submitPromoCampaign(producer(),id);
  assert.equal((await flow()).waiting,true,"a launching campaign must not request another approval");
  assert.equal((await flow()).hint,"workflow.hint.launching");
  await runLaunch(sent.launch!.id);
  assert.equal((await flow()).hint,"workflow.hint.submitted","created on TikTok, in TikTok's review");
  assert.ok((await flow()).href.endsWith("#launch-status"),"waiting links target a visible status, not a closed archive");
  await fixtureData.simulateDemoResults(producer(),id);
  assert.equal((await flow()).step,"results");
  const c = (await fixtureData.listPromoCampaigns(producer())).find(c => c.id === id)!;
  const failed = campaignWorkflow({...c,status:"failed"},[]);
  assert.equal(failed.step,"launch");
  assert.equal(failed.hint,"workflow.hint.failed");
  assert.equal(failed.waiting,true,"staff must recover a failed launch");
});

// ---- accounts ----------------------------------------------------------------------

test("company accounts are recorded, never created elsewhere; editors only; tenant-scoped", async () => {
  resetFixtureStore("demo");
  const created = await fixtureData.upsertCompanyAccount(reviewer(), { provider: "tiktok", kind: "pixel", name: "Site pixel", state: "unconnected", access: "none" });
  assert.equal(created.state, "unconnected");
  const updated = await fixtureData.upsertCompanyAccount(producer(), { id: created.id, provider: "tiktok", kind: "pixel", name: "Site pixel", state: "invited", access: "partner", note: "invite sent" });
  assert.equal(updated.state, "invited");
  await assert.rejects(fixtureData.upsertCompanyAccount(viewer(), { provider: "meta", kind: "ad_account", name: "x", state: "unconnected", access: "none" }), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.upsertCompanyAccount(staff(), { provider: "meta", kind: "ad_account", name: "x", state: "unconnected", access: "none" }), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.upsertCompanyAccount(other(), { id: created.id, provider: "tiktok", kind: "pixel", name: "stolen", state: "connected", access: "partner" }), (e: Error & { code?: string }) => e.code === "not_found");
  assert.equal((await fixtureData.listCompanyAccounts(producer())).length, 5);
  assert.ok(BENCHMARK.hook_hold_rate > 0);
});
