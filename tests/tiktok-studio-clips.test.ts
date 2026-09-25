// TikTok ads from Studio clips and from the linked account's own posts
// (decision 2026-09-25, "TikTok ads from Studio clips"). Ruobin: "build it,
// it doesn't matter with me that it doesn't show up on the profile, but I
// need to know it exists." So: a clip is uploaded once, gets TikTok's cover
// and runs as the TikTok account Business Center links to the ad account,
// shown only as an ad; a post of that account runs with no Spark code; the
// preview says which account; the monitor names it, says the clip stays off
// the profile, and links to TikTok's own preview of every ad. Fixture mode
// only: nothing leaves the process.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURE_PRODUCER_ID, fixtureSession } from "@/lib/auth";
import { FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { getData } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture } from "@/lib/data/launch";
import { putStoredBytes } from "@/lib/data/storage";
import { ingestEpisodeFile } from "@/lib/ingest";
import { buildLaunchPlan, defaultLaunchDraft, metaDraftIssues, tiktokAdText } from "@/lib/launch/plan";
import { executeLaunch } from "@/lib/launch/service";
import { resetTikTokPostCaches, sparkCodePreviews, tiktokAdPreviewLink } from "@/lib/launch/tiktok-posts";
import type { LaunchConnection, LaunchDraft } from "@/lib/launch/types";
import { crazydramasAdUrl } from "@/lib/tiktok/ad-url";
import { FAKE_ACCOUNT_POSTS, FAKE_BC_ID, fakeLinkedIdentityId, fakeTikTokSnapshot, fakeTransport, resetFakeTikTok } from "@/lib/tiktok/fake";
import { defaultLaunchSettings } from "@/lib/tiktok/settings";
import { launchTitle } from "./launch-title";
import { seedRenderedClips } from "./seed-minute";

const ADVERTISER = "7000000000000000001";
const A_LINK = crazydramasAdUrl(FAKE_SLUGS.complete);
const B_LINK = crazydramasAdUrl(FAKE_SLUGS.partial);
const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");
const original = { upload: fakeTransport.upload, get: fakeTransport.get };
let uploads = 0;

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  for (const name of ["TIKTOK_LIVE", "TIKTOK_FAKE_IDENTITY", "TIKTOK_FAKE_COVER", "TIKTOK_FAKE_PIXEL", "TIKTOK_PIXEL_CODE"]) delete process.env[name];
  resetFixtureStore(); resetLaunchFixture(); resetFakeTikTok(); resetTikTokPostCaches();
  uploads = 0;
  fakeTransport.upload = async (...args) => { uploads++; return original.upload(...args); };
});
afterEach(() => {
  fakeTransport.upload = original.upload; fakeTransport.get = original.get;
  delete process.env.TIKTOK_FAKE_IDENTITY; delete process.env.TIKTOK_FAKE_COVER;
  resetFakeTikTok();
});

async function account(): Promise<LaunchConnection> {
  return getData().assignLaunchConnection(staff(), {
    producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: ADVERTISER, name: "TikTok 1",
    currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true,
  });
}
/** A live title with one episode and `n` finished clips. */
async function titleWithClips(slug: string, n = 1) {
  const title = await launchTitle(slug);
  const ingest = ingestEpisodeFile(new Uint8Array(readFileSync(path.join(process.cwd(), "docs", "demo", "xiangyuan-ep1.srt"))), "xiangyuan-ep1.srt");
  const episode = await fixtureData.addEpisodeFromIngest(staff(), title.id, 1, ingest, { subtitlePath: null, videoPath: null });
  return { title, clips: await seedRenderedClips(title.id, episode.id, n) };
}
function draftOf(titleId: string, accountId: string, content: LaunchDraft["content"]): LaunchDraft {
  return { ...defaultLaunchDraft("tiktok"), name: "Studio clips", account_ids: [accountId], content_per_campaign: content.length, allocation: "shared",
    content, title_id: titleId, destination_url: "", total_budget_cents: 20000, daily_budget_cents: 3000,
    tiktok_settings: { ...defaultLaunchSettings(), budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 30, start_paused: true } };
}
async function approvedRun(draft: LaunchDraft) {
  const saved = await getData().saveLaunchDraft(producer(), draft);
  const plan = await getData().previewLaunchRun(producer(), saved.id);
  const run = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  return { saved, plan, run };
}
const current = (id: string) => getData().getLaunchRun(producer(), id);

test("a Studio clip is an ad by itself: uploaded once, TikTok's cover, run as the linked account and shown only as an ad", async () => {
  const one = await account();
  const a = await titleWithClips(FAKE_SLUGS.complete);
  const other = await launchTitle(FAKE_SLUGS.partial);
  const clip = a.clips[0];
  // A row that names another title is overruled: a clip promotes its own title.
  const { saved, plan, run } = await approvedRun(draftOf(other.id, one.id, [{ kind: "video", value: clip.id, title_id: other.id, text: "  She signed the papers.\nHe had no idea.  " }]));
  const item = saved.draft.content[0];
  assert.equal(item.title_id, a.title.id, "a clip promotes its own title");
  assert.equal(item.landing_url, A_LINK, "and carries its own title's link");
  assert.equal(item.clip_id, clip.id);
  assert.equal(item.sha256, clip.render_sha256, "the approved file is pinned by its hash");
  assert.deepEqual(plan.tiktok_identity, { clips: 1, posts: 0, accounts: [{ connection_id: one.id, name: "Pulsar Dramas", handle: "@pulsar.dramas", ads_only: true }] });

  await executeLaunch(run.id);
  const after = await current(run.id);
  assert.equal(after.campaigns[0].status, "done", after.campaigns[0].error ?? "");
  assert.equal(uploads, 1, "the clip is uploaded once");
  const ads = fakeTikTokSnapshot().ads;
  assert.equal(ads.length, 1);
  const body = ads[0].body;
  assert.equal(body.identity_type, "BC_AUTH_TT");
  assert.equal(body.identity_id, fakeLinkedIdentityId(ADVERTISER));
  assert.equal(body.identity_authorized_bc_id, FAKE_BC_ID);
  assert.equal(body.dark_post_status, "ON", "shown only as an ad, never on the profile");
  assert.equal(body.ad_text, "She signed the papers. He had no idea.", "the clip's text on one line");
  assert.equal(body.landing_page_url, A_LINK);
  assert.ok(body.video_id && Array.isArray(body.image_ids) && (body.image_ids as unknown[]).length === 1, "the uploaded video and TikTok's cover");
  const uploaded = (after.campaigns[0].state.uploads as Record<string, { video_id: string; image_id: string }>)[clip.id];
  assert.equal(uploaded.video_id, body.video_id, "the upload is recorded, so a resumed launch never sends it twice");

  // "I need to know it exists": the monitor names the account, says the clip stays off the profile, and TikTok's preview opens it.
  const seen = after.campaigns[0].snapshot?.ads?.[0];
  assert.ok(seen);
  assert.equal(seen.runs_as, "@pulsar.dramas");
  assert.equal(seen.ads_only, true);
  assert.equal(seen.content_value, clip.id);
  assert.match(seen.post_url ?? "", /^https:\/\/www\.tiktok\.com\/@pulsar\.dramas\/video\/\d+$/);
  assert.equal(await tiktokAdPreviewLink(producer(), run.id, seen.id), `https://fake.tiktok.invalid/ad_preview_tool?ad_preview_id=${seen.id}`);
  await assert.rejects(tiktokAdPreviewLink(producer(), run.id, "1720000000000999999"), (e: unknown) => (e as { code?: string }).code === "not_found", "an ad this launch did not create is not found");
});

test("TikTok still making a clip's cover is a wait: the upload is kept and never sent twice", async () => {
  const one = await account();
  const a = await titleWithClips(FAKE_SLUGS.complete);
  const { run } = await approvedRun(draftOf(a.title.id, one.id, [{ kind: "video", value: a.clips[0].id }]));
  process.env.TIKTOK_FAKE_COVER = "pending";
  await executeLaunch(run.id);
  const waiting = await current(run.id);
  assert.equal(waiting.campaigns[0].status, "pending");
  assert.match(String((waiting.campaigns[0].state.waiting as { reason: string }).reason), /still processing/);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0, "nothing that runs is created while the clip is processing");
  delete process.env.TIKTOK_FAKE_COVER;
  await executeLaunch(run.id);
  const done = await current(run.id);
  assert.equal(done.campaigns[0].status, "done", done.campaigns[0].error ?? "");
  assert.equal(uploads, 1, "the wait never re-uploads the clip");
  assert.equal(fakeTikTokSnapshot().ads.length, 1);
  assert.equal(fakeTikTokSnapshot().ads[0].body.ad_text, "Hook 1: the line that needs no setup", "with no edit, the clip's hook is the text");
});

test("a clip whose file changed after approval uploads nothing and creates nothing", async () => {
  const one = await account();
  const a = await titleWithClips(FAKE_SLUGS.complete);
  const { run } = await approvedRun(draftOf(a.title.id, one.id, [{ kind: "video", value: a.clips[0].id }]));
  await putStoredBytes(a.clips[0].render_path!, Buffer.from("a different file"), "video/mp4");
  await executeLaunch(run.id);
  const failed = await current(run.id);
  assert.equal(failed.campaigns[0].status, "failed");
  assert.match(failed.campaigns[0].error ?? "", /changed after this launch was approved/);
  assert.equal(uploads, 0);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0);
});

test("a post of the linked account runs as an ad with no Spark code; it stays on the profile", async () => {
  const one = await account();
  const a = await launchTitle(FAKE_SLUGS.complete);
  const post = FAKE_ACCOUNT_POSTS[0];
  const { plan, run } = await approvedRun(draftOf(a.id, one.id, [{ kind: "tiktok_post", value: post.item_id, label: "She signed the divorce papers." }]));
  assert.equal(plan.tiktok_identity?.posts, 1);
  await executeLaunch(run.id);
  const after = await current(run.id);
  assert.equal(after.campaigns[0].status, "done", after.campaigns[0].error ?? "");
  const body = fakeTikTokSnapshot().ads[0].body;
  assert.equal(body.identity_type, "BC_AUTH_TT");
  assert.equal(body.identity_authorized_bc_id, FAKE_BC_ID);
  assert.equal(body.tiktok_item_id, post.item_id);
  for (const field of ["video_id", "image_ids", "ad_text", "dark_post_status"]) assert.equal(body[field], undefined, `${field} is the post's own`);
  assert.equal(uploads, 0);
  const seen = after.campaigns[0].snapshot?.ads?.[0];
  assert.equal(seen?.runs_as, "@pulsar.dramas");
  assert.equal(seen?.ads_only, undefined, "a post of the account is not an ads-only video");
});

test("clips, posts and Spark codes share one launch, each ad with its own title's link", async () => {
  const one = await account();
  const a = await titleWithClips(FAKE_SLUGS.complete);
  const b = await launchTitle(FAKE_SLUGS.partial);
  const { plan, run } = await approvedRun(draftOf(a.title.id, one.id, [
    { kind: "video", value: a.clips[0].id },
    { kind: "tiktok_post", value: FAKE_ACCOUNT_POSTS[1].item_id, title_id: b.id },
    { kind: "spark", value: "valid-spark-code" },
  ]));
  assert.deepEqual([plan.tiktok_identity?.clips, plan.tiktok_identity?.posts], [1, 1]);
  await executeLaunch(run.id);
  const after = await current(run.id);
  assert.equal(after.campaigns[0].status, "done", after.campaigns[0].error ?? "");
  const byType = fakeTikTokSnapshot().ads.map((ad) => [ad.body.identity_type, ad.body.video_id ? "clip" : "post", ad.body.landing_page_url]);
  assert.deepEqual(byType.sort(), [["AUTH_CODE", "post", A_LINK], ["BC_AUTH_TT", "clip", A_LINK], ["BC_AUTH_TT", "post", B_LINK]].sort());
  assert.deepEqual((after.campaigns[0].state.posts as { code: string }[]).map((p) => p.code), [a.clips[0].id, FAKE_ACCOUNT_POSTS[1].item_id, "valid-spark-code"], "in the draft's order");
});

test("preview refuses in words: no linked account, an account that takes no uploads, a post that is not the account's", async () => {
  const one = await account();
  const a = await titleWithClips(FAKE_SLUGS.complete);
  const clipDraft = await getData().saveLaunchDraft(producer(), draftOf(a.title.id, one.id, [{ kind: "video", value: a.clips[0].id }]));
  process.env.TIKTOK_FAKE_IDENTITY = "none";
  await assert.rejects(getData().previewLaunchRun(producer(), clipDraft.id), /has no TikTok account linked in Business Center that ads can upload Studio clips to/);
  process.env.TIKTOK_FAKE_IDENTITY = "pull_only";
  await assert.rejects(getData().previewLaunchRun(producer(), clipDraft.id), /that ads can upload Studio clips to/);
  const postDraft = await getData().saveLaunchDraft(producer(), draftOf(a.title.id, one.id, [{ kind: "tiktok_post", value: FAKE_ACCOUNT_POSTS[2].item_id }]));
  assert.equal((await getData().previewLaunchRun(producer(), postDraft.id)).tiktok_identity?.posts, 1, "its posts can still run");
  delete process.env.TIKTOK_FAKE_IDENTITY;
  const stranger = await getData().saveLaunchDraft(producer(), draftOf(a.title.id, one.id, [{ kind: "tiktok_post", value: "1730000000000009999" }]));
  await assert.rejects(getData().previewLaunchRun(producer(), stranger.id), /Ad 1 is no longer a post of @pulsar\.dramas/);
  assert.equal(fakeTikTokSnapshot().campaigns.length, 0, "preview writes nothing");
});

test("a launch of Spark codes only never reads the linked account", async () => {
  const one = await account();
  const a = await launchTitle(FAKE_SLUGS.complete);
  const reads: string[] = [];
  fakeTransport.get = async (pathname, token, params) => { reads.push(pathname); return original.get(pathname, token, params); };
  const { plan } = await approvedRun(draftOf(a.id, one.id, [{ kind: "spark", value: "valid-spark-code" }]));
  assert.equal(plan.tiktok_identity, undefined);
  assert.ok(!reads.some((p) => p.startsWith("/identity/")), reads.join(", "));
});

test("each pasted Spark code shows its post's picture and words, read without using the code; a bad code says so", async () => {
  const one = await account();
  const writes: string[] = [];
  const originalPost = fakeTransport.post;
  fakeTransport.post = async (pathname, token, body) => { writes.push(pathname); return originalPost(pathname, token, body); };
  try {
    const previews = await sparkCodePreviews(producer(), FIXTURE_PRODUCER_ID, one.id, ["good-code-123456", " good-code-123456 ", "invalid-code"]);
    assert.deepEqual(Object.keys(previews).sort(), ["good-code-123456", "invalid-code"], "each code once, trimmed");
    assert.match(previews["good-code-123456"].cover_url ?? "", /^https:\/\//);
    assert.equal(previews["good-code-123456"].text, "Fake post for code 123456");
    assert.equal(previews["good-code-123456"].account, "pulsar.dramas");
    assert.match(previews["invalid-code"].error ?? "", /Post code is incorrect/);
    assert.deepEqual(writes, [], "no code is authorized by looking at it");
  } finally { fakeTransport.post = originalPost; }
  await assert.rejects(sparkCodePreviews(producer(), FIXTURE_PRODUCER_ID, "tiktok:someone-else:1", ["good-code"]), (e: unknown) => (e as { code?: string }).code === "not_found");
});

test("the planner's TikTok rules: the ad text, the kinds each provider takes", () => {
  assert.equal(tiktokAdText({ text: "  one\n two  " }), "one two");
  assert.equal(tiktokAdText({ text: "", headline: "Title name" }), "Title name", "no text: the title's name");
  assert.equal(tiktokAdText({ text: "x".repeat(140) }).length, 100, "TikTok's 100 characters");
  const connection: LaunchConnection = { id: "one", producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: ADVERTISER, name: "One", currency: "USD", timezone: "",
    page_id: null, instagram_id: null, business_id: null, assigned_by: "staff", verified_at: "2026-09-25T00:00:00.000Z", enabled: true };
  const base = { ...draftOf("00000000-0000-4000-8000-00000000000a", "one", []), content_per_campaign: 1, destination_url: A_LINK };
  assert.throws(() => buildLaunchPlan({ ...base, content: [{ kind: "tiktok_post", value: "not-a-post" }] }, [connection]), /Ad 1 is not a TikTok post of the linked account/);
  assert.throws(() => buildLaunchPlan({ ...base, content: [{ kind: "instagram_post", value: "123" }] }, [connection]), /Facebook and Instagram posts go to Meta/);
  const meta = { ...defaultLaunchDraft("meta"), account_ids: ["m"], destination_url: "https://crazydramas.com/watch", content: [{ kind: "tiktok_post" as const, value: FAKE_ACCOUNT_POSTS[0].item_id }] };
  assert.ok(metaDraftIssues(meta, []).some((issue) => issue.code === "contentTikTokPost"));
});
