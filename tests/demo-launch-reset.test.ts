import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture, resetLaunchFixtureForProducer } from "@/lib/data/launch";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import { fakeMetaSnapshot, fakeMetaTransport, resetFakeMeta, resetFakeMetaForRuns } from "@/lib/meta/fake";
import { fakeTikTokSnapshot, fakeTransport, resetFakeTikTok, resetFakeTikTokForDemo } from "@/lib/tiktok/fake";

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture";
  process.env.FIXTURE_SEED = "empty";
  process.env.FIXTURE_PERSIST = "off";
  resetFixtureStore("empty"); resetLaunchFixture(); resetFakeMeta(); resetFakeTikTok();
});

test("demo launch reset retains another company's run and assigned connection", async () => {
  const data = getData();
  const staff = fixtureSession("staff");
  const foreign = await data.createProducer(staff, { name_zh: "其他公司", name_en: "Other company" });
  const save = async (producerId: string) => {
    const account = await data.assignLaunchConnection(staff, {
      producer_id: producerId, provider: "meta", advertiser_id: `act_${producerId.slice(-12)}`,
      name: "Assigned Meta account", currency: "USD", timezone: "America/Los_Angeles",
      page_id: "123", instagram_id: null, business_id: null, enabled: true,
    });
    const input = defaultLaunchDraft("meta");
    input.account_ids = [account.id]; input.destination_url = "https://example.com/watch";
    input.content = [{ kind: "facebook_post", value: "123_456" }];
    input.total_budget_cents = 10000;
    return data.saveLaunchDraft(fixtureSession("producer", producerId), input);
  };
  const demoRun = await save(FIXTURE_PRODUCER_ID);
  const foreignRun = await save(foreign.id);
  const removed = resetLaunchFixtureForProducer(FIXTURE_PRODUCER_ID);
  assert.deepEqual(removed.runs.map(run => run.id), [demoRun.id]);
  assert.deepEqual(removed.clipPosts, []);
  assert.equal((await data.getLaunchWorkspace(fixtureSession("producer", foreign.id))).runs[0].id, foreignRun.id);
  assert.equal((await data.getLaunchWorkspace(fixtureSession("producer", foreign.id))).connections.length, 1);
  assert.equal((await data.getLaunchWorkspace(fixtureSession("producer"))).runs.length, 0);
  assert.equal((await data.getLaunchWorkspace(fixtureSession("producer"))).connections.length, 0);
});

test("demo TikTok reset removes only demo campaigns and their groups and ads", async () => {
  const create = async (name: string) => {
    const advertiser_id = "7000000000000000001"; // Sharing an account must not make ownership account-wide.
    const campaign = await fakeTransport.post("/campaign/create/", "fake", { advertiser_id, campaign_name: name, budget_mode: "BUDGET_MODE_INFINITE", operation_status: "DISABLE" });
    assert.equal(campaign.code, 0);
    const campaignId = String(campaign.data?.campaign_id);
    const group = await fakeTransport.post("/adgroup/create/", "fake", { advertiser_id, campaign_id: campaignId, adgroup_name: `${name}-group`, budget: 50, operation_status: "DISABLE" });
    assert.equal(group.code, 0);
    const groupId = String(group.data?.adgroup_id);
    const ad = await fakeTransport.post("/ad/create/", "fake", { advertiser_id, adgroup_id: groupId, creatives: [{ ad_name: `${name}-ad`, identity_id: "identity", video_id: "video", image_ids: ["cover"], landing_page_url: "https://example.com" }] });
    assert.equal(ad.code, 0);
    return campaignId;
  };
  const demoId = await create("studio-demo-run-1-title");
  const foreignId = await create("studio-foreign-run-1-title");
  resetFakeTikTokForDemo([demoId], ["demo-run"], "empty");
  const snapshot = fakeTikTokSnapshot();
  assert.deepEqual(snapshot.campaigns.map(c => c.campaignId), [foreignId]);
  assert.deepEqual(snapshot.adgroups.map(g => g.campaignId), [foreignId]);
  assert.deepEqual(snapshot.ads.map(ad => ad.campaignId), [foreignId]);
  resetFakeTikTokForDemo([], [], "demo");
  assert.equal(fakeTikTokSnapshot().campaigns.some(c => c.campaignId === foreignId), true);
  assert.equal(fakeTikTokSnapshot().campaigns.filter(c => c.name.startsWith("studio-demo-c")).length, 2);
});

test("demo Meta reset removes checkpointed and interrupted objects without touching another run", async () => {
  const demo = await fakeMetaTransport.post("act_1/campaigns", { name: "lr_demo/1", status: "PAUSED" });
  const interrupted = await fakeMetaTransport.upload("act_1/advideos", { title: "lr_demo/1/video", description: "approved clip" }, { source: { bytes: Buffer.from("video"), filename: "approved.mp4", contentType: "video/mp4" } });
  const foreign = await fakeMetaTransport.post("act_1/campaigns", { name: "lr_foreign/1", status: "PAUSED" });
  // Simulate Next retaining an instance created before removeForRuns existed.
  Object.defineProperty(fakeMetaTransport, "removeForRuns", { value: undefined, configurable: true });
  try {
    resetFakeMetaForRuns([{ external_id: "lr_demo", campaigns: [{ state: { meta: { campaign_id: demo.id } } }] } as never]);
  } finally {
    Reflect.deleteProperty(fakeMetaTransport, "removeForRuns");
  }
  assert.deepEqual(fakeMetaSnapshot().map(row => row.id), [foreign.id]);
  assert.equal(fakeMetaSnapshot().some(row => row.id === interrupted.id), false);
  const next = await fakeMetaTransport.post("act_1/campaigns", { name: "lr_foreign/2", status: "PAUSED" });
  assert.notEqual(next.id, foreign.id, "selective reset keeps the fake ID counter monotonic");
});
