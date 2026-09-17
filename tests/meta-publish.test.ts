// The organic publishing engine (docs/meta-organic-plan.md §3): every step is
// persisted before the next external call, a crash between a create and its
// persistence is closed by the stored or adopted id, a transient refusal leaves
// the row for the sweep and a permanent one fails it with the reason. Fixture
// mode never reaches Meta and never derives a Page token.
process.env.PROMO_RENDER = "off";

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture } from "@/lib/data/launch";
import { readClipBytes } from "@/lib/launch/clip-bytes";
import type { ClipPost } from "@/lib/launch/clip-posts";
import { metaTransport } from "@/lib/meta";
import { fakeMetaTransport, resetFakeMeta } from "@/lib/meta/fake";
import { clipPostSettled, defaultCaption, facebookVideoTitle, listMetaPagePosts, publishClip, publishTiming, resetMetaPagePostCache, retryClipPost, runClipPost, tickClipPosts } from "@/lib/meta/publish";
import { approver, assignMeta, ownCompany, seedClipTitle, viewer } from "./clip-seed";
import { staff } from "./seed-minute";

const data = () => getData();
const system = systemSession;
const env = { DATA_SOURCE: process.env.DATA_SOURCE, FIXTURE_SEED: process.env.FIXTURE_SEED, FIXTURE_PERSIST: process.env.FIXTURE_PERSIST, META_FAKE_PUBLISH: process.env.META_FAKE_PUBLISH };
const timing = { ...publishTiming };
const originalFetch = globalThis.fetch;
let networkCalls = 0;

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  delete process.env.META_FAKE_PUBLISH;
  resetFixtureStore(); resetLaunchFixture(); resetFakeMeta(); resetMetaPagePostCache(); networkCalls = 0;
  Object.assign(publishTiming, timing, { facebookPostPollMs: 0, instagramPollMs: 0 });
  globalThis.fetch = async () => { networkCalls++; throw new Error("Fixture publishing attempted network access"); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(publishTiming, timing);
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  resetFixtureStore();
});

async function world() {
  const own = await seedClipTitle(approver(), ownCompany, "Own title", { clipsPerEpisode: 2 });
  const connection = await assignMeta(ownCompany);
  const clips = await data().listClipLibrary(approver(), {});
  return { own, connection, clips };
}
const uploads = () => fakeMetaTransport.calls.filter(call => call.method === "UPLOAD");
const posted = (edge: string) => fakeMetaTransport.calls.filter(call => call.method === "POST" && call.path.endsWith(`/${edge}`));
async function start(clipId: string, connectionId: string, platform: "facebook" | "instagram" = "facebook"): Promise<ClipPost> {
  const created = await publishClip(approver(), { clip_id: clipId, platform, connection_id: connectionId });
  await clipPostSettled(created.id);
  return data().getClipPost(system(), created.id);
}

test("fixture publishing uses the fake, never the live transport and never a Page token", async () => {
  const { clips, connection } = await world();
  assert.equal(metaTransport().mode, "fake");
  const post = await start(clips[0].id, connection.id);
  assert.equal(post.status, "published");
  assert.equal(networkCalls, 0);
  // forPage returns the fake itself, so no ?fields=access_token is ever asked for.
  assert.equal(fakeMetaTransport.calls.filter(call => String(call.params.fields ?? "").includes("access_token")).length, 0);
  assert.ok(!JSON.stringify(post).includes("token"));
});

test("a Facebook clip post uploads once, waits for the Page post and ends published with pageID_postID", async () => {
  const { own, clips, connection } = await world();
  const clip = clips[0];
  const post = await start(clip.id, connection.id);
  assert.equal(post.status, "published");
  assert.equal(post.step, "published");
  assert.equal(uploads().length, 1);
  assert.equal(uploads()[0].path, `${connection.page_id}/videos`);
  assert.ok(post.external_post_id?.startsWith(`${connection.page_id}_`), post.external_post_id ?? "no post id");
  assert.equal(post.permalink, `https://www.facebook.com/${post.external_post_id}`);
  assert.ok(post.published_at);
  assert.equal(post.error, null);
  // The exact rendered bytes were the thing uploaded.
  const bytes = await readClipBytes(clip.file_path!, 32 * 1024 * 1024);
  assert.equal(fakeMetaTransport.objects.get(post.external_video_id!)!.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(post.caption, defaultCaption(clip));
  assert.equal(post.caption.split("\n")[1], `${own.title.name_en} · Episode 1`);
  assert.equal(post.audit?.at(-1)?.action, "clip_post_published");
});

test("an Instagram clip post polls its container to FINISHED, then publishes exactly once", async () => {
  const { clips, connection } = await world();
  const post = await start(clips[0].id, connection.id, "instagram");
  assert.equal(post.status, "published");
  assert.equal(posted("media").length, 1);
  assert.equal(posted("media_publish").length, 1);
  const container = fakeMetaTransport.calls.find(call => call.method === "POST" && call.path.endsWith("/media"))!;
  assert.equal(container.params.media_type, "REELS");
  assert.equal(container.params.share_to_feed, true);
  assert.ok(String(container.params.video_url).length > 0);
  assert.equal(String(posted("media_publish")[0].params.creation_id), post.external_video_id, "the recorded container is the one published");
  assert.equal(post.permalink, `https://www.instagram.com/reel/${post.external_post_id}/`);
  // Three status reads: IN_PROGRESS, IN_PROGRESS, FINISHED.
  assert.equal(fakeMetaTransport.calls.filter(call => String(call.params.fields ?? "").includes("status_code")).length, 3);
});

test("META_FAKE_PUBLISH=ig_error fails the row with Meta's reason and never publishes the container", async () => {
  process.env.META_FAKE_PUBLISH = "ig_error";
  const { clips, connection } = await world();
  const post = await start(clips[0].id, connection.id, "instagram");
  assert.equal(post.status, "failed");
  assert.match(post.error ?? "", /could not process/i);
  assert.equal(posted("media").length, 1);
  assert.equal(posted("media_publish").length, 0);
  assert.equal(post.audit?.at(-1)?.action, "clip_post_failed");
});

test("a crash after /videos and before persistence is closed on retry with no second upload", async () => {
  const { clips, connection } = await world();
  fakeMetaTransport.failNext("UPLOAD", `${connection.page_id}/videos`, { after: true });
  const failed = await start(clips[0].id, connection.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.external_video_id, null, "the id was never recorded");
  assert.equal(uploads().length, 1);
  const rearmed = await retryClipPost(approver(), failed.id);
  await clipPostSettled(rearmed.id);
  const post = await data().getClipPost(system(), failed.id);
  assert.equal(post.status, "published");
  assert.equal(uploads().length, 1, "the orphaned upload was adopted, not repeated");
  assert.equal(fakeMetaTransport.objects.get(post.external_video_id!)!.edge, "videos");
  assert.ok(post.audit?.some(entry => entry.action === "clip_post_retried"));
});

test("META_FAKE_PUBLISH=fb_throttle leaves the row publishing at its step and the scheduler tick completes it", async () => {
  process.env.META_FAKE_PUBLISH = "fb_throttle";
  const { clips, connection } = await world();
  const throttled = await start(clips[0].id, connection.id);
  assert.equal(throttled.status, "publishing");
  assert.equal(throttled.step, "uploading");
  assert.equal(throttled.external_video_id, null);
  assert.match(throttled.error ?? "", /request limit/i);
  assert.equal(uploads().length, 1);
  await tickClipPosts();
  const post = await data().getClipPost(system(), throttled.id);
  assert.equal(post.status, "published");
  assert.equal(post.error, null);
  assert.equal(uploads().length, 2, "the throttled upload never happened, so the sweep performs it");
});

test("a clip whose bytes no longer match the row is refused before any Meta call", async () => {
  const { clips, connection } = await world();
  const created = await data().createClipPost(approver(), { clip_id: clips[0].id, platform: "facebook", connection_id: connection.id, caption: "Hook", sha256: clips[0].sha256! });
  await data().updateClipPost(system(), created.id, created.revision, { sha256: createHash("sha256").update("a different render").digest("hex") });
  fakeMetaTransport.calls.length = 0;
  await runClipPost(created.id);
  const post = await data().getClipPost(system(), created.id);
  assert.equal(post.status, "failed");
  assert.match(post.error ?? "", /changed after it was rendered/);
  assert.equal(fakeMetaTransport.calls.length, 0);
});

test("an exhausted Instagram publishing quota refuses with the number and creates no container", async () => {
  const { clips, connection } = await world();
  fakeMetaTransport.publishingQuota = { used: 50, total: 50 };
  const post = await start(clips[0].id, connection.id, "instagram");
  assert.equal(post.status, "failed");
  assert.match(post.error ?? "", /all 50 of its posts/);
  assert.equal(posted("media").length, 0);
});

test("a retry of a row that already has a post id only re-reads the permalink", async () => {
  const { clips, connection } = await world();
  const published = await start(clips[0].id, connection.id);
  const calls = fakeMetaTransport.calls.length;
  const again = await retryClipPost(approver(), published.id);
  assert.equal(again.status, "published");
  assert.equal(fakeMetaTransport.calls.length, calls, "a published row is not published again");
  // A row interrupted after Meta created the post settles on its stored id.
  const created = await data().createClipPost(approver(), { clip_id: clips[1].id, platform: "facebook", connection_id: connection.id, caption: "Hook", sha256: clips[1].sha256! });
  const stranded = await data().updateClipPost(system(), created.id, created.revision, { step: "uploaded", external_post_id: `${connection.page_id}_424242` });
  await runClipPost(stranded.id);
  const settled = await data().getClipPost(system(), stranded.id);
  assert.equal(settled.status, "published");
  assert.equal(settled.external_post_id, `${connection.page_id}_424242`);
  assert.equal(uploads().length, 1, "no upload for a post that already exists");
});

test("Facebook that never creates the post fails with a retryable sentence after five reads", async () => {
  const { clips, connection } = await world();
  const created = await data().createClipPost(approver(), { clip_id: clips[0].id, platform: "facebook", connection_id: connection.id, caption: "Hook", sha256: clips[0].sha256! });
  // An uploaded video Facebook never turns into a Page post.
  const stranded = await data().updateClipPost(system(), created.id, created.revision, { step: "uploaded", external_video_id: "999999999999999" });
  await runClipPost(stranded.id);
  const post = await data().getClipPost(system(), created.id);
  assert.equal(post.status, "failed");
  assert.match(post.error ?? "", /has not created the post yet/);
  assert.equal(fakeMetaTransport.calls.filter(call => String(call.params.fields ?? "").includes("post_id")).length, publishTiming.facebookPostPolls);
});

test("the Page listing returns the fake's posts and Reels, is cached for a minute, and carries no token", async () => {
  const { connection } = await world();
  const listed = await listMetaPagePosts(staff(), ownCompany, connection.id);
  assert.equal(listed.facebook.length, 2);
  assert.equal(listed.instagram.length, 2);
  assert.ok(listed.facebook.every(row => row.platform === "facebook" && row.id.startsWith(`${connection.page_id}_`) && row.permalink?.startsWith("https://")));
  assert.ok(listed.instagram.every(row => row.platform === "instagram" && row.caption.length > 0));
  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes("access_token") && !serialized.includes("fixture-page-token"));
  const calls = fakeMetaTransport.calls.length;
  await listMetaPagePosts(staff(), ownCompany, connection.id);
  assert.equal(fakeMetaTransport.calls.length, calls, "the 60 s cache answers the second read");
  // A company that was never assigned that account cannot read its Page.
  await assert.rejects(listMetaPagePosts(approver(), ownCompany, "not-an-account"), { code: "not_found" });
  assert.equal(networkCalls, 0);
});

test("a published Facebook post shows up in the Page listing alongside the seeded ones", async () => {
  const { clips, connection } = await world();
  const post = await start(clips[0].id, connection.id);
  resetMetaPagePostCache();
  const listed = await listMetaPagePosts(staff(), ownCompany, connection.id);
  assert.ok(listed.facebook.some(row => row.id === post.external_post_id));
});

// ---- adoption may never claim a post this row did not make -------------------

test("two clips with the same caption each publish their own Instagram Reel", async () => {
  const { clips, connection } = await world();
  const shared = "Watch the whole thing on the app";
  const first = await publishClip(approver(), { clip_id: clips[0].id, platform: "instagram", connection_id: connection.id, caption: shared });
  await clipPostSettled(first.id);
  const second = await publishClip(approver(), { clip_id: clips[1].id, platform: "instagram", connection_id: connection.id, caption: shared });
  await clipPostSettled(second.id);
  const [a, b] = [await data().getClipPost(system(), first.id), await data().getClipPost(system(), second.id)];
  assert.equal(a.status, "published");
  assert.equal(b.status, "published");
  assert.notEqual(b.external_post_id, a.external_post_id, "the second clip must not claim the first clip's media id");
  assert.equal(posted("media").length, 2);
  assert.equal(posted("media_publish").length, 2);
});

test("two ad accounts sharing one Page each upload their own video", async () => {
  const { clips, connection } = await world();
  const second = await getData().assignLaunchConnection(staff(), {
    producer_id: ownCompany, provider: "meta", advertiser_id: "act_9000000000000009", name: "Second account",
    currency: "USD", timezone: "America/Los_Angeles", page_id: connection.page_id, instagram_id: connection.instagram_id,
    business_id: null, enabled: true,
  });
  const first = await start(clips[0].id, connection.id);
  assert.equal(first.status, "published");
  const other = await start(clips[0].id, second.id);
  assert.equal(other.status, "published");
  assert.equal(uploads().length, 2, "the second account must not adopt the first account's video");
  assert.notEqual(other.external_video_id, first.external_video_id);
  assert.notEqual(other.external_post_id, first.external_post_id);
});

test("an id another post row already holds is never adopted", async () => {
  const { clips, connection } = await world();
  const first = await start(clips[0].id, connection.id);
  // A second row that did attempt an upload, whose read-back would match the
  // first row's video if ownership were not checked.
  const created = await data().createClipPost(approver(), { clip_id: clips[1].id, platform: "facebook", connection_id: connection.id, caption: first.caption, sha256: clips[1].sha256! });
  fakeMetaTransport.objects.get(first.external_video_id!)!.title = facebookVideoTitle(clips[1], created.id);
  await data().updateClipPost(system(), created.id, created.revision, { attempted_at: new Date().toISOString() });
  await runClipPost(created.id);
  const second = await data().getClipPost(system(), created.id);
  assert.equal(second.status, "published");
  assert.notEqual(second.external_video_id, first.external_video_id, "the first row's video is not up for adoption");
  assert.equal(uploads().length, 2);
});

test("two matching uploads stop the row with a person-readable refusal instead of a guess", async () => {
  const { clips, connection } = await world();
  fakeMetaTransport.failNext("UPLOAD", `${connection.page_id}/videos`, { after: true });
  const failed = await start(clips[0].id, connection.id);
  assert.equal(failed.status, "failed");
  assert.ok(failed.attempted_at, "the attempt marker is what lets the retry adopt at all");
  const title = facebookVideoTitle(clips[0], failed.id);
  fakeMetaTransport.objects.set("duplicate-upload", { id: "duplicate-upload", edge: "videos", account_id: connection.page_id!, title, description: failed.caption, created_time: new Date().toISOString() });
  const rearmed = await retryClipPost(approver(), failed.id);
  await clipPostSettled(rearmed.id);
  const after = await data().getClipPost(system(), failed.id);
  assert.equal(after.status, "failed");
  assert.match(after.error ?? "", /more than one matching upload/i);
  assert.equal(uploads().length, 1, "nothing is uploaded while the Page is ambiguous");
});

// ---- Post again --------------------------------------------------------------

test("Post again publishes a real second post, keeps both ids and supersedes the older row", async () => {
  const { clips, connection } = await world();
  const first = await start(clips[0].id, connection.id);
  assert.equal(first.status, "published");
  // A Post again a day later: the first upload is far outside any read-back window.
  for (const row of fakeMetaTransport.snapshot()) {
    if (row.edge === "videos") fakeMetaTransport.objects.get(row.id)!.created_time = new Date(Date.now() - 86_400_000).toISOString();
  }
  const created = await publishClip(approver(), { clip_id: clips[0].id, platform: "facebook", connection_id: connection.id, again: true });
  await clipPostSettled(created.id);
  const second = await data().getClipPost(system(), created.id);
  const older = await data().getClipPost(system(), first.id);
  assert.equal(second.status, "published", second.error ?? "");
  assert.ok(second.external_post_id && second.external_post_id !== first.external_post_id);
  assert.equal(older.superseded_by, second.id);
  assert.equal(older.status, "published");
  assert.equal(second.superseded_by, null);
  assert.equal(uploads().length, 2);
  assert.equal(older.audit?.at(-1)?.action, "clip_post_superseded");
  // And the slot is taken again: a third post still needs the deliberate action.
  await assert.rejects(publishClip(approver(), { clip_id: clips[0].id, platform: "facebook", connection_id: connection.id }), { code: "conflict" });
});

test("the post id lands on the row before the one-published-post invariant is consulted", async () => {
  const { clips, connection } = await world();
  const first = await start(clips[0].id, connection.id);
  // A second live row for the same clip, platform and account: the only way it
  // can end published is if its id was persisted first and the older row was
  // superseded before the final transition. Recording is never skipped.
  const created = await data().createClipPost(approver(), { clip_id: clips[0].id, platform: "facebook", connection_id: connection.id, caption: "Second run", sha256: clips[0].sha256!, again: true });
  await runClipPost(created.id);
  const second = await data().getClipPost(system(), created.id);
  assert.equal(second.status, "published", second.error ?? "");
  assert.ok(second.external_post_id && second.external_post_id !== first.external_post_id);
  assert.equal((await data().getClipPost(system(), first.id)).superseded_by, second.id);
});

// ---- who may read and who may publish ----------------------------------------

test("a viewer may read the library and a post but may not publish or retry", async () => {
  const { clips, connection } = await world();
  assert.equal((await data().listClipLibrary(viewer(), {})).length, clips.length);
  const published = await start(clips[0].id, connection.id);
  assert.equal((await data().getClipPost(viewer(), published.id)).id, published.id);
  assert.ok((await listMetaPagePosts(viewer(), ownCompany, connection.id)).facebook.some(row => row.id === published.external_post_id));
  await assert.rejects(publishClip(viewer(), { clip_id: clips[1].id, platform: "facebook", connection_id: connection.id }), { code: "forbidden" });
  await assert.rejects(retryClipPost(viewer(), published.id), { code: "forbidden" });
});

// ---- one worker at a time ----------------------------------------------------

test("a live lease keeps a second worker and the sweep off the row; an expired one is adopted", async () => {
  const { clips, connection } = await world();
  const created = await data().createClipPost(approver(), { clip_id: clips[0].id, platform: "facebook", connection_id: connection.id, caption: "Leased", sha256: clips[0].sha256! });
  const leased = await data().updateClipPost(system(), created.id, created.revision,
    { lease_owner: "another-process", leased_until: new Date(Date.now() + 60_000).toISOString() });
  fakeMetaTransport.calls.length = 0;
  await runClipPost(leased.id);
  await tickClipPosts();
  assert.equal(uploads().length, 0, "a leased row belongs to its worker");
  assert.equal((await data().getClipPost(system(), leased.id)).status, "publishing");
  // The worker died: the lease runs out and the sweep takes the row over.
  const expired = await data().getClipPost(system(), leased.id);
  await data().updateClipPost(system(), expired.id, expired.revision, { leased_until: new Date(Date.now() - 1_000).toISOString() });
  await tickClipPosts();
  const post = await data().getClipPost(system(), leased.id);
  assert.equal(post.status, "published");
  assert.equal(post.lease_owner, null, "a finished worker hands the lease back");
  assert.equal(uploads().length, 1);
});

test("a hook-less clip never pre-fills a public caption with its internal reference", async () => {
  const { clips, connection } = await world();
  const bare = { ...clips[0], label: clips[0].external_id };
  const caption = defaultCaption(bare);
  assert.ok(!caption.includes(bare.external_id), caption);
  assert.equal(caption, `${bare.title_name} · Episode ${bare.episode_label}`);
  await assert.rejects(data().createClipPost(approver(), { clip_id: clips[0].id, platform: "facebook", connection_id: connection.id, caption: clips[0].external_id, sha256: clips[0].sha256! }), { code: "invalid" });
});

test("a Page-less account answers the listing with a refusal, not an internal error", async () => {
  await world();
  const pageless = await assignMeta(ownCompany, { index: 7, page: false });
  await assert.rejects(listMetaPagePosts(approver(), ownCompany, pageless.id), (error: unknown) => {
    assert.equal((error as { name?: string }).name, "DataError");
    assert.equal((error as { code?: string }).code, "invalid");
    assert.match((error as Error).message, /Facebook Page/);
    return true;
  });
});
