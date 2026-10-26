// One ad account, several Pages (decision 2026-10-25, migration 0025): a Meta
// connection is its ad account and its Page, so a second Page on the same ad
// account sits beside the first instead of replacing it; the auto-poster uses
// only the connection marked for it; pickers name the Page and its Instagram.
process.env.PROMO_RENDER = "off";

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture } from "@/lib/data/launch";
import { autoPostConnection, sameConnectionSlot } from "@/lib/launch/account-authority";
import { connectionLabel } from "@/lib/launch/connection-label";
import type { LaunchConnection } from "@/lib/launch/types";
import { clipPostSettled, publishClip, publishTiming } from "@/lib/meta/publish";
import { fakeMetaTransport, resetFakeMeta } from "@/lib/meta/fake";
import { approver, ownCompany, seedClipTitle } from "./clip-seed";
import { staff } from "./seed-minute";

const env = { DATA_SOURCE: process.env.DATA_SOURCE, FIXTURE_SEED: process.env.FIXTURE_SEED, FIXTURE_PERSIST: process.env.FIXTURE_PERSIST };
const timing = { ...publishTiming };
beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  resetFixtureStore(); resetLaunchFixture(); resetFakeMeta();
  Object.assign(publishTiming, timing, { facebookPostPollMs: 0, instagramPollMs: 0 });
});
afterEach(() => {
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  Object.assign(publishTiming, timing);
  resetFixtureStore();
});

const ACCOUNT = "act_9000000000000001";
function assign(page: string, instagram: string, extra: Partial<LaunchConnection> = {}) {
  return getData().assignLaunchConnection(staff(), {
    producer_id: ownCompany, provider: "meta", advertiser_id: ACCOUNT, name: "Crazy Drama US", currency: "USD",
    timezone: "America/Los_Angeles", page_id: page, instagram_id: instagram, business_id: null, enabled: true, ...extra,
  });
}
const metaRows = async () => (await getData().getLaunchConnections(staff(), ownCompany, "meta")).filter(c => c.advertiser_id === ACCOUNT);

test("a second Page on the same ad account is a second connection, not a replacement", async () => {
  const main = await assign("9000000000000011", "9000000000000021");
  const romance = await assign("9000000000000012", "9000000000000022", { auto_post: false });
  assert.notEqual(romance.id, main.id);
  const rows = await metaRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.page_id).sort(), ["9000000000000011", "9000000000000012"]);
  assert.equal(rows.find(r => r.id === main.id)?.instagram_id, "9000000000000021", "the first Page keeps its Instagram account");
});

test("re-assigning the same Page updates it in place and keeps its auto-post choice", async () => {
  const first = await assign("9000000000000011", "9000000000000021", { auto_post: false });
  const again = await assign("9000000000000011", "9000000000000021", { name: "Renamed" });
  assert.equal(again.id, first.id);
  assert.equal(again.auto_post, false, "a re-assignment that does not say otherwise keeps the choice");
  const rows = await metaRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Renamed");
});

test("the Page name and Instagram handle are never stored on the connection", async () => {
  const saved = await assign("9000000000000011", "9000000000000021", { page_name: "CrazyDramas US", instagram_username: "crazydramasus", business_name: "CrazyDramas" });
  assert.equal(saved.page_name, undefined);
  assert.equal(saved.instagram_username, undefined);
  assert.equal(saved.business_name, undefined);
});

test("TikTok connections stay one per ad account", () => {
  const tiktok = (page: string | null) => ({ provider: "tiktok" as const, advertiser_id: "7000000000000000001", page_id: page });
  assert.equal(sameConnectionSlot(tiktok(null), tiktok("1")), true);
  const meta = (page: string | null) => ({ provider: "meta" as const, advertiser_id: ACCOUNT, page_id: page });
  assert.equal(sameConnectionSlot(meta("1"), meta("1")), true);
  assert.equal(sameConnectionSlot(meta("1"), meta("2")), false);
  assert.equal(sameConnectionSlot(meta("1"), { ...meta("1"), advertiser_id: "act_2" }), false);
});

const row = (id: string, extra: Partial<LaunchConnection> = {}): LaunchConnection => ({
  id, producer_id: ownCompany, provider: "meta", advertiser_id: ACCOUNT, name: "Crazy Drama US", currency: "USD", timezone: "",
  page_id: `p-${id}`, instagram_id: `ig-${id}`, business_id: null, assigned_by: "staff", verified_at: "2026-10-01T00:00:00.000Z", enabled: true, ...extra,
});

test("the auto-poster uses the connection marked for it, else an older one, never one switched off", () => {
  assert.equal(autoPostConnection([row("a"), row("b", { auto_post: true })])?.id, "b", "marked wins over a row assigned before the flag");
  assert.equal(autoPostConnection([row("romance", { auto_post: false }), row("main")])?.id, "main", "an unmarked older row still posts");
  assert.equal(autoPostConnection([row("romance", { auto_post: false })]), null, "false is never used");
  assert.equal(autoPostConnection([row("x", { enabled: false, auto_post: true })]), null, "a disabled row is never used");
  assert.equal(autoPostConnection([row("x", { page_id: null })]), null, "no Page, no organic post");
  const tie = [row("z", { verified_at: "2026-10-02T00:00:00.000Z" }), row("y", { verified_at: "2026-10-01T00:00:00.000Z" })];
  assert.equal(autoPostConnection(tie)?.id, "y", "ties go to the earliest assignment");
  assert.equal(autoPostConnection([...tie].reverse())?.id, "y", "storage order never decides");
});

test("pickers name the Page and its Instagram account on Meta, the account alone on TikTok", () => {
  assert.equal(connectionLabel(row("a", { page_name: "CrazyDramas Romance", instagram_username: "crazydramas.romance" })), "Crazy Drama US · CrazyDramas Romance · @crazydramas.romance");
  assert.equal(connectionLabel(row("a")), "Crazy Drama US · p-a · ig-a", "ids stand in until the live names are read");
  assert.equal(connectionLabel({ ...row("t"), provider: "tiktok", name: "TikTok 1" }), "TikTok 1");
});

test("a clip posted through the second Page goes to that Page, not the first", async () => {
  await seedClipTitle(approver(), ownCompany, "Own title", { clipsPerEpisode: 1 });
  const clips = await getData().listClipLibrary(approver(), {});
  await assign("9000000000000011", "9000000000000021");
  const romance = await assign("9000000000000012", "9000000000000022", { auto_post: false });
  const post = await publishClip(approver(), { clip_id: clips[0].id, platform: "facebook", connection_id: romance.id });
  await clipPostSettled(post.id);
  const uploads = fakeMetaTransport.calls.filter(call => call.method === "UPLOAD");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, "9000000000000012/videos");
});
