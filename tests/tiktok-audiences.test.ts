// TikTok launches target custom audiences (decision 2026-10-01). Ruobin: "allow me to target them in pulsar studio so
// i can launch myself" — the retargeting audiences made in Ads Manager (buyers, viewers who didn't buy, checkouts
// that didn't pay) are picked per launch, reached or left out, and every ad group carries them. Fixture mode only:
// the fake TikTok lists FAKE_AUDIENCES and refuses an audience id it does not have.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession } from "@/lib/auth";
import { FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture } from "@/lib/data/launch";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import { executeLaunch } from "@/lib/launch/service";
import { audienceGate } from "@/lib/launch/tiktok-gate";
import { listTikTokAudiences, resetTikTokPostCaches } from "@/lib/launch/tiktok-posts";
import type { LaunchConnection, LaunchDraft } from "@/lib/launch/types";
import { audiencesFromList, listCustomAudiences } from "@/lib/tiktok/audiences";
import { FAKE_ACCOUNT_POSTS, FAKE_AUDIENCES, fakeTikTokSnapshot, fakeTransport, resetFakeTikTok } from "@/lib/tiktok/fake";
import { adGroupBody, defaultLaunchSettings, defaultWebsitePurchaseSettings, normalizeLaunchSettings, planAdGroup, summarizeLaunchSettings, validateLaunchSettings, type LaunchSettings } from "@/lib/tiktok/settings";
import { builtInPresetOf } from "@/lib/tiktok/preset-match";
import { launchTitle } from "./launch-title";

const [BUYERS, VIEWERS, CHECKOUT] = FAKE_AUDIENCES.map((a) => ({ id: a.audience_id, name: a.name }));
const retargeting = (): LaunchSettings => ({ ...defaultWebsitePurchaseSettings(), audiences: { include: [VIEWERS, CHECKOUT], exclude: [BUYERS] } });
const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  for (const name of ["TIKTOK_LIVE", "TIKTOK_FAKE_IDENTITY", "TIKTOK_FAKE_PIXEL", "TIKTOK_FAKE_AUDIENCES", "TIKTOK_PIXEL_CODE"]) delete process.env[name];
  resetFixtureStore(); resetLaunchFixture(); resetFakeTikTok(); resetTikTokPostCaches();
});
afterEach(() => { delete process.env.TIKTOK_FAKE_AUDIENCES; resetFakeTikTok(); });

let advertiser = 7000000000000000001n;
async function account(name = "TikTok 1"): Promise<LaunchConnection> {
  return getData().assignLaunchConnection(staff(), {
    producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: String(advertiser++), name,
    currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true,
  });
}

test("every ad group reaches the chosen audiences and leaves the excluded ones out; none chosen sends neither field", () => {
  const plan = planAdGroup(retargeting(), 100);
  const body = adGroupBody(retargeting(), plan, { pixel_id: "7686323395218259976" });
  assert.deepEqual(body.audience_ids, [VIEWERS.id, CHECKOUT.id]);
  assert.deepEqual(body.excluded_audience_ids, [BUYERS.id]);
  assert.equal("smart_audience_enabled" in body, false, "smart audience stays off: only the named audiences");

  const plain = adGroupBody(defaultWebsitePurchaseSettings(), plan, { pixel_id: "7686323395218259976" });
  assert.equal("audience_ids" in plain, false, "TikTok rejects empty lists, so an unused side is left out");
  assert.equal("excluded_audience_ids" in plain, false);
  const excludeOnly = adGroupBody({ ...defaultWebsitePurchaseSettings(), audiences: { include: [], exclude: [BUYERS] } }, plan, { pixel_id: "7686323395218259976" });
  assert.equal("audience_ids" in excludeOnly, false);
  assert.deepEqual(excludeOnly.excluded_audience_ids, [BUYERS.id]);
});

test("settings: an audience is on one side only, an empty choice is dropped, old rows read as before, the summary names them", () => {
  assert.throws(() => validateLaunchSettings({ ...retargeting(), audiences: { include: [BUYERS], exclude: [BUYERS] } }, 100), /RT Buyers 180d is both targeted and excluded/);
  assert.equal(validateLaunchSettings({ ...defaultWebsitePurchaseSettings(), audiences: { include: [], exclude: [] } }, 100).audiences, undefined);

  // A saved row from before audiences: the key stays absent, so its stored snapshot reads the same.
  const old = normalizeLaunchSettings(JSON.parse(JSON.stringify(defaultLaunchSettings())));
  assert.equal("audiences" in old, false);
  assert.deepEqual(normalizeLaunchSettings(retargeting()).audiences, retargeting().audiences, "a saved choice survives a reload");

  const line = summarizeLaunchSettings(retargeting()).join(" · ");
  assert.match(line, /audiences: RT Viewers 7d no buy, RT Checkout 14d no buy/);
  assert.match(line, /excluding RT Buyers 180d/);
  assert.match(summarizeLaunchSettings({ ...defaultWebsitePurchaseSettings(), audiences: { include: [{ id: "123456789", name: null }], exclude: [] } }).join(" · "), /audiences: audience 123456789/);

  // Audiences are the launch's own, like start paused: the default preset still reads as the default.
  assert.equal(builtInPresetOf(retargeting()), "__default_website__");
});

test("the audience list: TikTok's rows, a refusal in plain words with the way round it", async () => {
  assert.deepEqual(audiencesFromList([{ audience_id: "77", name: "x", cover_num: 5, is_valid: false }, { name: "no id" }]), [{ id: "77", name: "x", size: 5, valid: false, expired: false }]);
  const listed = await listCustomAudiences(fakeTransport, "fake-token", "7000000000000000001");
  assert.ok(listed.ok);
  assert.deepEqual(listed.audiences.map((a) => a.name), ["RT Buyers 180d", "RT Viewers 7d no buy", "RT Checkout 14d no buy"]);

  process.env.TIKTOK_FAKE_AUDIENCES = "unreadable";
  const refused = await listCustomAudiences(fakeTransport, "fake-token", "7000000000000000001");
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.reason === "no_permission");
  assert.match(!refused.ok ? refused.message : "", /Audience Management permission\. You can still add an audience by its ID/);
});

test("a producer reads their own ad account's audiences; another company's account is not found", async () => {
  const one = await account();
  const read = await listTikTokAudiences(producer(), FIXTURE_PRODUCER_ID, one.id);
  assert.ok(read.ok);
  assert.equal(read.account, "TikTok 1");
  assert.equal(read.audiences.length, 3);
  await assert.rejects(listTikTokAudiences(producer(), FIXTURE_PRODUCER_ID, "not-an-account"), /not found/i);
});

test("preview: audiences need one ad account, and must be on it when TikTok lists them; a refused list does not block", async () => {
  const [one, two] = [await account("TikTok 1"), await account("TikTok 2")];
  const chosen = retargeting().audiences;
  await assert.rejects(audienceGate(chosen, [one, two]), /Custom audiences belong to one ad account, and this launch runs on 2/);
  await audienceGate(chosen, [one]);
  await assert.rejects(audienceGate({ include: [{ id: "123456789", name: "Somebody else's" }], exclude: [] }, [one]), /TikTok 1 has no audience Somebody else's/);
  process.env.TIKTOK_FAKE_AUDIENCES = "unreadable";
  await audienceGate({ include: [{ id: "123456789", name: null }], exclude: [] }, [one]);
});

test("end to end: the paused launch's ad group carries the audiences TikTok was asked for", async () => {
  const one = await account();
  const title = await launchTitle(FAKE_SLUGS.complete);
  const draft: LaunchDraft = {
    ...defaultLaunchDraft("tiktok"), name: "Retargeting", account_ids: [one.id], content_per_campaign: 1, allocation: "shared",
    content: [{ kind: "tiktok_post", value: FAKE_ACCOUNT_POSTS[0].item_id }], title_id: title.id, destination_url: "",
    total_budget_cents: 20000, daily_budget_cents: 2000,
    tiktok_settings: { ...retargeting(), budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 20, start_paused: true },
  };
  const saved = await getData().saveLaunchDraft(producer(), draft);
  assert.deepEqual(saved.draft.tiktok_settings.audiences, retargeting().audiences, "the draft keeps the choice, names included");
  await getData().previewLaunchRun(producer(), saved.id);
  const run = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  await executeLaunch(run.id);
  const after = await getData().getLaunchRun(producer(), run.id);
  assert.equal(after.campaigns[0].status, "done", after.campaigns[0].error ?? "");
  const [group] = fakeTikTokSnapshot().adgroups;
  assert.deepEqual(group.body.audience_ids, [VIEWERS.id, CHECKOUT.id]);
  assert.deepEqual(group.body.excluded_audience_ids, [BUYERS.id]);
});
