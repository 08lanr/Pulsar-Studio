// Adopt a TikTok campaign (decision 2026-10-04). Ruobin, after copying the
// Sep 29 campaign in TikTok Ads Manager and finding it missing from Studio:
// "can you add the copy campaign to studio", then "build the adopt a tiktok
// campaign feature". A campaign made in Ads Manager by copying one Studio
// launched becomes a Studio record: read from TikTok, never written to it,
// signed by the person who adopts it, and read by the Monitor like a launch.
// Fixture mode only: nothing leaves the process.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURE_PRODUCER_ID, fixtureSession } from "@/lib/auth";
import { FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { getData } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { launchHash, resetLaunchFixture } from "@/lib/data/launch";
import { ingestEpisodeFile } from "@/lib/ingest";
import { buildAdoption } from "@/lib/launch/adopt";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import { executeLaunch, monitorLaunch } from "@/lib/launch/service";
import { resetTikTokPostCaches } from "@/lib/launch/tiktok-posts";
import type { LaunchConnection, LaunchDraft, LaunchRun } from "@/lib/launch/types";
import { readTikTokCampaign } from "@/lib/tiktok/adopt";
import { fakeTikTokSnapshot, fakeTransport, resetFakeTikTok } from "@/lib/tiktok/fake";
import { defaultLaunchSettings } from "@/lib/tiktok/settings";
import { launchTitle } from "./launch-title";
import { seedRenderedClips } from "./seed-minute";

const ADVERTISER = "7000000000000000001";
const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");
const original = { post: fakeTransport.post, get: fakeTransport.get };
let writes: string[] = [];

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  for (const name of ["TIKTOK_LIVE", "TIKTOK_FAKE_IDENTITY", "TIKTOK_FAKE_COVER", "TIKTOK_FAKE_PIXEL", "TIKTOK_PIXEL_CODE"]) delete process.env[name];
  resetFixtureStore(); resetLaunchFixture(); resetFakeTikTok(); resetTikTokPostCaches();
  writes = [];
});
afterEach(() => { fakeTransport.post = original.post; fakeTransport.get = original.get; resetFakeTikTok(); });

async function account(): Promise<LaunchConnection> {
  return getData().assignLaunchConnection(staff(), {
    producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: ADVERTISER, name: "TikTok 1",
    currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true,
  });
}
async function titleWithClips(slug: string, n: number) {
  const title = await launchTitle(slug);
  const ingest = ingestEpisodeFile(new Uint8Array(readFileSync(path.join(process.cwd(), "docs", "demo", "xiangyuan-ep1.srt"))), "xiangyuan-ep1.srt");
  const episode = await fixtureData.addEpisodeFromIngest(staff(), title.id, 1, ingest, { subtitlePath: null, videoPath: null });
  return { title, clips: await seedRenderedClips(title.id, episode.id, n) };
}
/** A launch of `n` Studio clips, live on the fake TikTok. */
async function launched(n = 2): Promise<{ one: LaunchConnection; run: LaunchRun; clipIds: string[] }> {
  const one = await account();
  const a = await titleWithClips(FAKE_SLUGS.complete, n);
  const draft: LaunchDraft = { ...defaultLaunchDraft("tiktok"), name: "CrazyDramas · Sep 29", account_ids: [one.id], content_per_campaign: n, allocation: "shared",
    content: a.clips.map((c) => ({ kind: "video" as const, value: c.id })), title_id: a.title.id, destination_url: "", total_budget_cents: 5000,
    tiktok_settings: { ...defaultLaunchSettings() } };
  const saved = await getData().saveLaunchDraft(producer(), draft);
  await getData().previewLaunchRun(producer(), saved.id);
  const run = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  await executeLaunch(run.id);
  const done = await getData().getLaunchRun(producer(), run.id);
  assert.equal(done.campaigns[0].status, "done", done.campaigns[0].error ?? "");
  return { one, run: done, clipIds: a.clips.map((c) => c.id) };
}
/** What "Copy" in TikTok Ads Manager makes: a new campaign, ad group and ads playing the same videos, with its own budget. */
async function copyInAdsManager(opts: { budget?: number; budgetMode?: string; extraVideo?: string; ages?: string[] } = {}): Promise<string> {
  const snap = fakeTikTokSnapshot();
  const campaign = snap.campaigns[0], group = snap.adgroups[0];
  const post = (p: string, body: Record<string, unknown>) => original.post.call(fakeTransport, p, "fake-token", { advertiser_id: ADVERTISER, ...body });
  const made = await post("/campaign/create/", { campaign_name: `Copy 1 of ${campaign.name}`, objective_type: campaign.objective, budget_mode: "BUDGET_MODE_INFINITE" });
  assert.equal(made.code, 0, made.message);
  const campaignId = String(made.data!.campaign_id);
  const g = await post("/adgroup/create/", { ...group.body, campaign_id: campaignId, budget: opts.budget ?? 500, budget_mode: opts.budgetMode ?? "BUDGET_MODE_TOTAL", ...(opts.ages ? { age_groups: opts.ages } : {}) });
  assert.equal(g.code, 0, g.message);
  const creatives: Record<string, unknown>[] = snap.ads.filter((a) => a.campaignId === campaign.campaignId).map((a) => {
    const { tiktok_item_id: _pushed, ...body } = a.body;
    return { ...body, ad_name: `${a.adName}-copy` };
  });
  if (opts.extraVideo) creatives.push({ ...creatives[0], ad_name: "made-by-hand", video_id: opts.extraVideo });
  const ads = await post("/ad/create/", { adgroup_id: String(g.data!.adgroup_id), creatives });
  assert.equal(ads.code, 0, ads.message);
  return campaignId;
}
/** From here on, any write to TikTok is recorded: adoption must make none. */
function watchWrites() {
  fakeTransport.post = async (pathname, token, body) => { writes.push(pathname); return original.post.call(fakeTransport, pathname, token, body); };
}
const rejectsWith = (pattern: RegExp, code?: string) => (e: unknown) => {
  assert.match((e as Error).message, pattern);
  if (code) assert.equal((e as { code?: string }).code, code);
  return true;
};

test("a copy made in Ads Manager is adopted: a signed record of what TikTok says, read by the Monitor, with nothing written to TikTok", async () => {
  const { one, run: source, clipIds } = await launched(2);
  const campaignId = await copyInAdsManager({ budget: 500, ages: ["AGE_18_24", "AGE_25_34"] });
  watchWrites();

  const adopted = await getData().adoptLaunchRun(producer(), { campaign_id: campaignId });
  assert.equal(adopted.status, "done");
  assert.equal(adopted.producer_id, FIXTURE_PRODUCER_ID);
  assert.equal(adopted.draft.name, `Copy 1 of ${source.campaigns[0].name}`.slice(0, 80), "named as TikTok names it");
  assert.equal(adopted.draft.total_budget_cents, 50000, "the budget is TikTok's ad group budget");
  assert.deepEqual(adopted.draft.tiktok_settings.age_groups, ["AGE_18_24", "AGE_25_34"], "the ages are TikTok's");
  assert.equal(adopted.draft.tiktok_settings.duplicate_copies, 0, "an adopted campaign is never grown automatically");
  assert.deepEqual(adopted.draft.content.map((c) => c.value).sort(), [...clipIds].sort(), "each ad is the Studio clip its video came from");
  for (const item of adopted.draft.content) {
    const approved = source.draft.content.find((c) => c.value === item.value)!;
    assert.equal(item.title_id, approved.title_id);
    assert.equal(item.landing_url, approved.landing_url, "and promotes what was approved");
    assert.equal(item.sha256, approved.sha256);
  }
  const c = adopted.campaigns[0];
  assert.equal(c.status, "done");
  assert.equal(c.state.campaign_id, campaignId);
  assert.equal(c.budget_cents, 50000);
  const groups = c.state.groups as { id: string; key: string; ads: Record<string, string>; ready: boolean }[];
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "primary");
  assert.deepEqual(Object.keys(groups[0].ads).sort(), [...clipIds].sort());
  const copies = fakeTikTokSnapshot().ads.filter((a) => a.campaignId === campaignId).map((a) => a.adId).sort();
  assert.deepEqual(Object.values(groups[0].ads).sort(), copies, "the record holds the copy's own ad ids");
  assert.deepEqual((c.state.adopted as { source_run_ids: string[] }).source_run_ids, [source.id]);

  // Signed like an approved launch, by the person who adopted it.
  assert.equal(adopted.approved_by, producer().userId);
  assert.equal(adopted.snapshot_hash, launchHash(adopted.draft, adopted.connections ?? []));
  assert.deepEqual(adopted.connections?.map((x) => x.id), [one.id]);
  const entry = adopted.audit?.at(-1);
  assert.equal(entry?.action, "campaign_adopted");
  assert.deepEqual((entry?.detail as { campaign_id: string; ads: number }).campaign_id, campaignId);
  assert.equal((entry?.detail as { ads: number }).ads, 2);

  // The Monitor reads it like any launch: the sweep does not refuse the approval, and names every ad.
  await monitorLaunch(adopted.id);
  const seen = (await getData().getLaunchRun(producer(), adopted.id)).campaigns[0].snapshot;
  assert.ok(seen && seen.note === null, seen?.note ?? "no snapshot");
  assert.equal(seen.ads?.length, 2);
  assert.deepEqual(seen.ads?.map((a) => a.content_value).sort(), [...clipIds].sort());
  assert.equal(seen.groups?.[0].budget_cents, 50000);
  assert.deepEqual(writes, [], "nothing is written to TikTok, by the adoption or by the sweep after it");

  // The source launch is untouched and still verifies.
  await monitorLaunch(source.id);
  assert.equal((await getData().getLaunchRun(producer(), source.id)).campaigns[0].snapshot?.note, null);
});

test("one campaign, one record: a campaign Studio already holds is refused, launched or adopted", async () => {
  const { run } = await launched(1);
  const own = String(run.campaigns[0].state.campaign_id);
  await assert.rejects(getData().adoptLaunchRun(producer(), { campaign_id: own }), rejectsWith(/already tracks this campaign as "CrazyDramas · Sep 29"/, "conflict"));
  const campaignId = await copyInAdsManager();
  await getData().adoptLaunchRun(producer(), { campaign_id: campaignId });
  await assert.rejects(getData().adoptLaunchRun(producer(), { campaign_id: campaignId }), rejectsWith(/already tracks this campaign/, "conflict"));
  assert.equal((await getData().listLaunchRuns(producer())).length, 2);
});

test("only who may launch may adopt: the approver, or a staff administrator with a note", async () => {
  await launched(1);
  const campaignId = await copyInAdsManager();
  const reviewer = { ...producer(), producerRole: "reviewer" as const };
  await assert.rejects(getData().adoptLaunchRun(reviewer, { campaign_id: campaignId }), rejectsWith(/approver/, "forbidden"));
  const viewer = { ...staff(), staffRole: "viewer" as never };
  await assert.rejects(getData().adoptLaunchRun(viewer, { campaign_id: campaignId, note: "why" }), rejectsWith(/staff administrator/, "forbidden"));
  await assert.rejects(getData().adoptLaunchRun(staff(), { campaign_id: campaignId }), rejectsWith(/on-behalf authorization/, "invalid"));
  const adopted = await getData().adoptLaunchRun(staff(), { campaign_id: campaignId, note: "Ruobin copied it in Ads Manager on Oct 3." });
  assert.equal(adopted.approved_by, staff().userId);
  assert.equal(adopted.approval_note, "Ruobin copied it in Ads Manager on Oct 3.");
  assert.equal(adopted.producer_id, FIXTURE_PRODUCER_ID, "staff need not name the company: the ad account that holds the campaign decides it");
});

test("what Studio cannot name it does not adopt: an unknown ID, an ad whose video no launch uploaded, a daily budget", async () => {
  await launched(1);
  await assert.rejects(getData().adoptLaunchRun(producer(), { campaign_id: "not a number" }), rejectsWith(/TikTok campaign ID/, "invalid"));
  await assert.rejects(getData().adoptLaunchRun(producer(), { campaign_id: "1700000000000999999" }), rejectsWith(/No TikTok ad account assigned to this company has a campaign with that ID/, "invalid"));

  const withStranger = await copyInAdsManager({ extraVideo: "v_not_from_studio" });
  await assert.rejects(getData().adoptLaunchRun(producer(), { campaign_id: withStranger }), rejectsWith(/no record of the video in one ad of this campaign \(made-by-hand\)/, "invalid"));

  resetFakeTikTok(); resetLaunchFixture(); resetFixtureStore();
  await launched(1);
  const daily = await copyInAdsManager({ budget: 30, budgetMode: "BUDGET_MODE_DAY" });
  await assert.rejects(getData().adoptLaunchRun(producer(), { campaign_id: daily }), rejectsWith(/lifetime budget/, "invalid"));
  assert.equal((await getData().listLaunchRuns(producer())).length, 1, "a refusal stores nothing");
});

test("the reading and the decision, on their own: TikTok's campaign as read, and a campaign with no ads", async () => {
  const { one, run } = await launched(1);
  const campaignId = await copyInAdsManager({ budget: 120 });
  const read = await readTikTokCampaign(ADVERTISER, campaignId);
  assert.ok(read);
  assert.equal(read.mode, "fake");
  assert.equal(read.campaign.id, campaignId);
  assert.equal(read.groups.length, 1);
  assert.equal(read.groups[0].budget_cents, 12000);
  assert.equal(read.groups[0].budget_mode, "BUDGET_MODE_TOTAL");
  assert.equal(read.ads.length, 1);
  assert.ok(read.ads[0].video_id);
  assert.equal(await readTikTokCampaign(ADVERTISER, "1700000000000999999"), null);

  const built = buildAdoption(read, [run], one, { name: "  My copy  " });
  assert.ok(built.ok);
  assert.equal(built.draft.name, "My copy");
  assert.equal(built.budget_cents, 12000);
  const empty = buildAdoption({ ...read, ads: [] }, [run], one);
  assert.ok(!empty.ok && /no ads yet/.test(empty.reason));
  const foreign = buildAdoption(read, [], one);
  assert.ok(!foreign.ok && /no record of the video/.test(foreign.reason), "another company's launches never name a video");
});

test("a copy TikTok made a Smart+ campaign refuses the review read: its ads still list with their numbers, and the note says why", async () => {
  const { clipIds } = await launched(2);
  const campaignId = await copyInAdsManager();
  const adopted = await getData().adoptLaunchRun(producer(), { campaign_id: campaignId });
  // Production's answer for such a campaign (read live 2026-10-04).
  fakeTransport.get = async (pathname, token, params) => pathname === "/ad/review_info/"
    ? { code: 40002, message: "This API does not support Upgraded Smart Plus ads.", data: {} }
    : original.get.call(fakeTransport, pathname, token, params);
  await monitorLaunch(adopted.id);
  const seen = (await getData().getLaunchRun(producer(), adopted.id)).campaigns[0].snapshot;
  assert.ok(seen);
  assert.equal(seen.ads?.length, 2, "the ads are listed although their review could not be read");
  assert.deepEqual(seen.ads?.map((a) => a.content_value).sort(), [...clipIds].sort());
  assert.ok(seen.ads?.every((a) => a.stats && a.stats.spend_cents !== undefined), "each with its own numbers");
  assert.ok(seen.ads?.every((a) => a.status !== "rejected"), "a refused review read is never a rejection");
  assert.match(seen.note ?? "", /does not support Upgraded Smart Plus ads/);
  assert.notEqual(seen.spend_cents, undefined);
});
