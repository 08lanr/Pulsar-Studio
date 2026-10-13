// The creator publishing engine (decision 2026-10-12): image, carousel and Reel
// through the fake, every container id persisted before the next call, a resume
// never makes a second container or a second media_publish, transient refusals
// wait for the sweep, dead containers are forgotten so a Retry starts over, and
// fixture mode never reaches the network. Also: scheduling validation, the
// sweep's gates and the publish-token selection.
process.env.PROMO_RENDER = "off";

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetCreatorFixture } from "@/lib/data/creators";
import { creatorPostSettled, creatorTiming, resetCreatorPublishState, runCreatorPost, tickCreatorPosts } from "@/lib/creators/publish";
import { cancelPost, postNow, retryPost, schedulePost, updatePost } from "@/lib/creators/service";
import { creatorsEnabled, creatorsGate, resetCreatorSweep, tickCreators } from "@/lib/creators/sweeps";
import { checkPost, feedRatioIssue } from "@/lib/creators/validate";
import { fakeMetaTransport, resetFakeMeta } from "@/lib/meta/fake";
import { metaPublishTransport, metaTransport } from "@/lib/meta";
import { MetaApiError, metaTokenSource } from "@/lib/meta/transport";
import { addMedia, admin, editor, seedAccount } from "./creator-seed";

const data = () => getData();
const system = systemSession;
const keys = ["DATA_SOURCE", "META_LIVE_WRITES", "CREATORS_DISABLED", "META_FAKE_PUBLISH", "META_PUBLISH_TOKEN", "META_ACCESS_TOKEN", "FIXTURE_PERSIST"] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const timing = { ...creatorTiming };
const originalFetch = globalThis.fetch;
let network = 0;

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_PERSIST = "off";
  delete process.env.META_FAKE_PUBLISH; delete process.env.META_LIVE_WRITES; delete process.env.CREATORS_DISABLED;
  resetCreatorFixture(); resetFakeMeta(); resetCreatorPublishState(); resetCreatorSweep(); network = 0;
  fakeMetaTransport.demoComments = false;
  Object.assign(creatorTiming, timing, { pollMs: 0 });
  globalThis.fetch = async () => { network++; throw new Error("creator publishing attempted network access"); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(creatorTiming, timing);
  for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const posts = (edge: string) => fakeMetaTransport.calls.filter(c => c.method === "POST" && c.path.endsWith(`/${edge}`));
async function publishNow(account: Awaited<ReturnType<typeof seedAccount>>, kind: "image" | "carousel" | "reel", mediaIds: string[], caption = "a slow morning ☕") {
  const { post } = await schedulePost(admin(), { account: account.id, kind, media_ids: mediaIds, caption, when: "now" });
  await creatorPostSettled(post.id);
  return data().getCreatorPost(system(), post.id);
}

test("an image post makes one container, publishes once and records the media id and permalink", async () => {
  const account = await seedAccount();
  const image = await addMedia(account);
  const post = await publishNow(account, "image", [image.external_id]);
  assert.equal(post.status, "published", post.error ?? "");
  assert.equal(post.step, "published");
  assert.ok(post.ig_media_id);
  assert.match(post.permalink ?? "", /^https:\/\/www\.instagram\.com\/p\//);
  assert.equal(posts("media").length, 1);
  assert.equal(posts("media")[0].path, `${account.instagram_id}/media`);
  assert.ok(String(posts("media")[0].params.image_url).startsWith("fixture://"));
  assert.equal(posts("media_publish").length, 1);
  // No Page: the account is called directly, never through a Page token.
  assert.equal(fakeMetaTransport.calls.filter(c => String(c.params.fields ?? "").includes("access_token")).length, 0);
  assert.equal(network, 0);
});

test("a carousel makes one child per item, then one parent, then one publish", async () => {
  const account = await seedAccount();
  const a = await addMedia(account), b = await addMedia(account), c = await addMedia(account);
  const post = await publishNow(account, "carousel", [a.id, b.id, c.id], "weekend in three");
  assert.equal(post.status, "published", post.error ?? "");
  const children = posts("media").filter(call => call.params.is_carousel_item);
  assert.equal(children.length, 3);
  assert.ok(children.every(call => String(call.params.image_url).startsWith("fixture://") && call.params.caption === undefined));
  assert.equal(posts("media").filter(call => call.params.media_type === "CAROUSEL").length, 1);
  assert.equal(posts("media_publish").length, 1);
  const parent = fakeMetaTransport.objects.get(post.containers.parent as string)!;
  assert.deepEqual(parent.children, [a.id, b.id, c.id].map(id => post.containers.children![id]), "children in post order");
  assert.equal(fakeMetaTransport.objects.get(post.ig_media_id!)!.media_type, "CAROUSEL_ALBUM");
});

test("a carousel interrupted at its parent resumes from the stored child ids, never remaking one", async () => {
  const account = await seedAccount();
  const a = await addMedia(account), video = await addMedia(account, "video", { width: 1080, height: 1350 });
  const original = fakeMetaTransport.post.bind(fakeMetaTransport);
  let lose = true;
  fakeMetaTransport.post = (async (path: string, params: Record<string, unknown>) => {
    if (lose && params.media_type === "CAROUSEL") { lose = false; throw new MetaApiError("Meta request did not return a verifiable response; read back before retrying.", undefined, true); }
    return original(path, params);
  }) as typeof fakeMetaTransport.post;
  try {
    const first = await publishNow(account, "carousel", [a.id, video.id], "two");
    assert.equal(first.status, "publishing");
    assert.equal(Object.keys(first.containers.children ?? {}).length, 2, "both children recorded before the parent");
    assert.equal(first.containers.parent ?? null, null);
    const videoChild = posts("media").find(call => call.params.media_type === "VIDEO")!;
    assert.equal(videoChild.params.is_carousel_item, true);
    await runCreatorPost(first.id);
    const post = await data().getCreatorPost(system(), first.id);
    assert.equal(post.status, "published", post.error ?? "");
    assert.equal(posts("media").filter(call => call.params.is_carousel_item).length, 2, "no second child");
    assert.equal(posts("media_publish").length, 1);
  } finally {
    fakeMetaTransport.post = original;
  }
});

test("a lost media_publish answer is adopted from the account, never published twice", async () => {
  const account = await seedAccount();
  const image = await addMedia(account);
  fakeMetaTransport.failNext("POST", `${account.instagram_id}/media_publish`, { after: true, ambiguous: true });
  const { post: created } = await schedulePost(admin(), { account: account.id, kind: "image", media_ids: [image.id], caption: "golden hour walk", when: "now" });
  await creatorPostSettled(created.id);
  let post = await data().getCreatorPost(system(), created.id);
  assert.equal(post.status, "publishing");
  assert.ok(post.attempted_at, "the attempt is on the row");
  assert.equal(post.ig_media_id, null);
  await runCreatorPost(post.id);
  post = await data().getCreatorPost(system(), post.id);
  assert.equal(post.status, "published");
  assert.ok(post.ig_media_id);
  assert.equal(posts("media_publish").length, 1, "adopted, not published again");
  assert.equal(posts("media").length, 1, "one container");
});

test("a Reel waits for processing, and a rate-limited publish is retried by the sweep without a second container", async () => {
  process.env.META_FAKE_PUBLISH = "ig_throttle";
  const account = await seedAccount();
  const video = await addMedia(account, "video");
  const post1 = await publishNow(account, "reel", [video.id], "morning pilates 🎧");
  assert.equal(post1.status, "publishing");
  assert.equal(post1.attempted_at, null, "a definite refusal clears the attempt");
  assert.equal(posts("media")[0].params.media_type, "REELS");
  assert.equal(posts("media")[0].params.share_to_feed, true);
  await runCreatorPost(post1.id);
  const post = await data().getCreatorPost(system(), post1.id);
  assert.equal(post.status, "published", post.error ?? "");
  assert.equal(posts("media").length, 1);
  assert.equal(posts("media_publish").length, 2); // the throttled one and the one that worked
  assert.match(post.permalink ?? "", /\/reel\//);
});

test("a container that ends in ERROR fails the post and is forgotten, so Retry starts fresh", async () => {
  process.env.META_FAKE_PUBLISH = "ig_error";
  const account = await seedAccount();
  const image = await addMedia(account);
  const failed = await publishNow(account, "image", [image.id]);
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /ERROR/);
  assert.deepEqual(failed.containers, {});
  assert.equal(failed.step, "container");
  delete process.env.META_FAKE_PUBLISH;
  const retried = await retryPost(admin(), failed.id);
  await creatorPostSettled(retried.id);
  const post = await data().getCreatorPost(system(), failed.id);
  assert.equal(post.status, "published", post.error ?? "");
  assert.equal(posts("media").length, 2);
  assert.equal(posts("media_publish").length, 1);
});

test("an exhausted publishing allowance waits instead of failing, and makes no container", async () => {
  process.env.META_FAKE_PUBLISH = "ig_quota";
  const account = await seedAccount();
  const image = await addMedia(account);
  const post = await publishNow(account, "image", [image.id]);
  assert.equal(post.status, "publishing");
  assert.match(post.error ?? "", /last 24 hours/);
  assert.equal(posts("media").length, 0);
});

test("bytes that changed after import are never handed to Instagram", async () => {
  const account = await seedAccount();
  const image = await addMedia(account, "image", { stored_sha256: "0".repeat(64) });
  const post = await publishNow(account, "image", [image.id]);
  assert.equal(post.status, "failed");
  assert.match(post.error ?? "", /changed after it was imported/);
  assert.equal(posts("media").length, 0);
});

test("a live lease keeps a second worker off the row", async () => {
  const account = await seedAccount();
  const image = await addMedia(account);
  const { post } = await schedulePost(admin(), { account: account.id, kind: "image", media_ids: [image.id], caption: "x", when: "draft" });
  const leased = await data().updateCreatorPost(system(), post.id, post.revision,
    { status: "publishing", lease_owner: "someone-else", leased_until: new Date(Date.now() + 60_000).toISOString() });
  await runCreatorPost(leased.id);
  assert.equal(posts("media").length, 0);
  assert.equal((await data().getCreatorPost(system(), post.id)).lease_owner, "someone-else");
});

test("the sweep starts due scheduled posts on active accounts only", async () => {
  const active = await seedAccount(), paused = await seedAccount();
  const a = await addMedia(active), p = await addMedia(paused);
  const due = new Date(Date.now() + 120_000).toISOString();
  const { post: one } = await schedulePost(admin(), { account: active.id, kind: "image", media_ids: [a.id], caption: "due", scheduled_at: due, when: "schedule" });
  const { post: two } = await schedulePost(admin(), { account: paused.id, kind: "image", media_ids: [p.id], caption: "held", scheduled_at: due, when: "schedule" });
  await data().updateCreatorAccount(admin(), paused.id, paused.revision, { status: "paused" });
  assert.equal((await tickCreatorPosts(new Date())).started, 0, "not due yet");
  const later = new Date(Date.now() + 180_000);
  const sweep = await tickCreatorPosts(later);
  assert.equal(sweep.started, 1);
  assert.equal((await data().getCreatorPost(system(), one.id)).status, "published");
  assert.equal((await data().getCreatorPost(system(), two.id)).status, "scheduled");
});

test("scheduling validation refuses what the engine would refuse", async () => {
  const account = await seedAccount();
  const image = await addMedia(account), video = await addMedia(account, "video");
  const tall = await addMedia(account, "image", { width: 1080, height: 1920 });
  const png = await addMedia(account, "image", { mime: "image/png" as never });
  const bad = async (input: Parameters<typeof schedulePost>[1], pattern: RegExp) =>
    assert.rejects(schedulePost(admin(), input), (e: Error) => pattern.test(e.message));
  const base = { account: account.id, caption: "hi", when: "now" as const };
  await bad({ ...base, kind: "carousel", media_ids: [image.id] }, /2 to 10/);
  await bad({ ...base, kind: "reel", media_ids: [image.id] }, /Reel is a video/);
  await bad({ ...base, kind: "image", media_ids: [video.id] }, /cannot carry a video/);
  await bad({ ...base, kind: "image", media_ids: [tall.id] }, /taller than 4:5/);
  await bad({ ...base, kind: "image", media_ids: [png.id] }, /JPEG/);
  await bad({ ...base, kind: "image", media_ids: [image.id], caption: "watch it on CrazyDramas" }, /never mentions CrazyDramas/);
  await bad({ ...base, kind: "image", media_ids: [image.id], caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") }, /30 hashtags/);
  await bad({ ...base, kind: "carousel", media_ids: [image.id, image.id] }, /twice/);
  await bad({ ...base, when: "schedule", kind: "image", media_ids: [image.id], scheduled_at: new Date(Date.now() - 3600_000).toISOString() }, /passed/);
  await bad({ ...base, kind: "image", media_ids: ["cm_nothere"] }, /not in @/);
  const other = await seedAccount();
  const foreign = await addMedia(other);
  await bad({ ...base, kind: "image", media_ids: [foreign.id] }, /not in @/);
  assert.equal(fakeMetaTransport.calls.length, 0);
  assert.equal(feedRatioIssue(1122, 1402), null, "Chloe's 1122×1402 is inside 4:5");
  assert.deepEqual(checkPost({ kind: "image", media: [image], caption: "", scheduled_at: null, when: "now" }).warnings, ["The post has no caption."]);
});

test("only a staff administrator schedules; edits and cancels are revision-checked", async () => {
  const account = await seedAccount();
  const image = await addMedia(account);
  await assert.rejects(schedulePost(editor(), { account: account.id, kind: "image", media_ids: [image.id], caption: "x", when: "draft" }), /administrator/);
  const { post } = await schedulePost(admin(), { account: account.id, kind: "image", media_ids: [image.id], caption: "x", when: "draft" });
  const { post: edited } = await updatePost(admin(), post.id, post.revision, { caption: "y" });
  assert.equal(edited.caption, "y");
  await assert.rejects(updatePost(admin(), post.id, post.revision, { caption: "z" }), /changed/);
  await assert.rejects(cancelPost(admin(), post.id, post.revision), /changed/);
  const cancelled = await cancelPost(admin(), post.id, edited.revision);
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(postNow(admin(), post.id, cancelled.revision), /cannot be posted now/);
});

test("the sweep runs only with Supabase, live writes and no kill switch", async () => {
  assert.equal(creatorsEnabled(), false);
  assert.match(creatorsGate() ?? "", /fixture/);
  assert.equal(await tickCreators(), null, "fixture mode never runs by itself");
  process.env.DATA_SOURCE = "supabase";
  assert.match(creatorsGate() ?? "", /META_LIVE_WRITES/);
  process.env.META_LIVE_WRITES = "enabled";
  assert.equal(creatorsEnabled(), true);
  process.env.CREATORS_DISABLED = "1";
  assert.equal(creatorsEnabled(), false);
  assert.match(creatorsGate() ?? "", /CREATORS_DISABLED/);
  process.env.DATA_SOURCE = "fixture";
});

test("organic posting uses the publish token, ads keep the ads token; fixture uses the fake for both", () => {
  process.env.META_ACCESS_TOKEN = "ads-token-value";
  delete process.env.META_PUBLISH_TOKEN;
  assert.equal(metaTokenSource("publish"), "META_ACCESS_TOKEN", "falls back when unset");
  process.env.META_PUBLISH_TOKEN = "publish-token-value";
  assert.equal(metaTokenSource("publish"), "META_PUBLISH_TOKEN");
  assert.equal(metaTokenSource("ads"), "META_ACCESS_TOKEN");
  delete process.env.META_ACCESS_TOKEN;
  assert.equal(metaTokenSource("ads"), null);
  assert.equal(metaPublishTransport().mode, "fake");
  assert.equal(metaTransport().mode, "fake");
});

test("the live publish transport sends the publish token and never puts it in an error", async () => {
  process.env.DATA_SOURCE = "supabase";
  process.env.META_ACCESS_TOKEN = "ads-token-value";
  process.env.META_PUBLISH_TOKEN = "publish-token-value";
  const seen: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>).Authorization));
    return new Response(JSON.stringify({ error: { message: "nope", code: 190 } }), { status: 400 });
  }) as typeof fetch;
  await assert.rejects(metaPublishTransport().get("17841416495486333", { fields: "username" }), (e: Error) => !e.message.includes("publish-token-value"));
  await assert.rejects(metaTransport().get("act_1", { fields: "name" }), (e: Error) => !e.message.includes("ads-token-value"));
  assert.deepEqual(seen, ["Bearer publish-token-value", "Bearer ads-token-value"]);
  // A live write still needs META_LIVE_WRITES=enabled, whichever token.
  await assert.rejects(metaPublishTransport().post("17841416495486333/media", { image_url: "x" }), /live writes are disabled/);
  process.env.DATA_SOURCE = "fixture";
});
