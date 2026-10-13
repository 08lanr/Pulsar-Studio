// Comments, replies, insights and captions on a creator account (decision
// 2026-10-12), end to end against the fake: the read skips the account's own
// words and media made by hand still counts, the rules decide before any
// model, a reply is sent once and only once, the hourly cap and the auto-reply
// switch hold, a lost answer is read back rather than resent, and every model
// call is a studio.jobs row with its cost while fixture mode never calls one.
process.env.PROMO_RENDER = "off";

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetCreatorFixture } from "@/lib/data/creators";
import { writeCaptionOptions } from "@/lib/creators/captions";
import { readCreatorInsights } from "@/lib/creators/insights";
import { creatorPostSettled, resetCreatorPublishState } from "@/lib/creators/publish";
import { actOnComment, decideComments, pollComments, sendDueReplies } from "@/lib/creators/replies";
import { accountOverview, schedulePost } from "@/lib/creators/service";
import type { callStructured } from "@/lib/llm";
import { fakeMetaTransport, resetFakeMeta } from "@/lib/meta/fake";
import { addMedia, admin, editor, seedAccount } from "./creator-seed";

const data = () => getData();
const system = systemSession;
const keys = ["DATA_SOURCE", "META_FAKE_PUBLISH", "DEMO_REPLAY", "DEEPSEEK_API_KEY", "FIXTURE_PERSIST"] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_PERSIST = "off";
  delete process.env.META_FAKE_PUBLISH; delete process.env.DEMO_REPLAY;
  resetCreatorFixture(); resetFakeMeta(); resetCreatorPublishState();
  globalThis.fetch = async () => { throw new Error("network access in a fixture test"); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

/** An account with one published image, which the fake's followers comment on (three demo comments). */
async function world() {
  const account = await seedAccount();
  fakeMetaTransport.usernames.set(account.instagram_id, account.handle);
  const image = await addMedia(account);
  const { post } = await schedulePost(admin(), { account: account.id, kind: "image", media_ids: [image.id], caption: "golden hour on the bluffs", when: "now" });
  await creatorPostSettled(post.id);
  return { account, post: await data().getCreatorPost(system(), post.id) };
}
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const replyPosts = () => fakeMetaTransport.calls.filter(c => c.method === "POST" && c.path.endsWith("/replies"));

test("the sweep reads comments, decides them by rule or (demo) canned draft, and sends each reply exactly once", async () => {
  const { account, post } = await world();
  const read = await pollComments(account);
  assert.equal(read.added, 3);
  const comments = await data().listCreatorComments(admin(), { account_id: account.id });
  assert.ok(comments.every(c => c.post_id === post.id && c.ig_media_id === post.ig_media_id));
  const decided = await decideComments(account, { random: () => 0 });
  assert.equal(decided.drafted, 2);
  assert.equal(decided.flagged, 1);
  const byText = async (t: string) => (await data().listCreatorComments(admin(), { account_id: account.id })).find(c => c.text.includes(t))!;
  assert.equal((await byText("real")).decision, "flag");
  assert.match((await byText("real")).reason ?? "", /real, AI or a bot/);
  assert.equal((await byText("🤍")).status, "drafted");
  assert.equal(fakeMetaTransport.calls.filter(c => c.method === "POST" && c.path.endsWith("/replies")).length, 0, "nothing sent while deciding");

  assert.equal((await sendDueReplies(account, new Date())).sent, 0, "not due yet: the delay holds");
  const sent = await sendDueReplies(account, later(60));
  assert.equal(sent.sent, 2);
  assert.equal(replyPosts().length, 2);
  // Studio's own replies come back on the next read and are not comments.
  assert.equal((await pollComments(account)).added, 0);
  assert.equal((await sendDueReplies(account, later(120))).sent, 0);
  assert.equal(replyPosts().length, 2, "never a second reply");
  const flagged = await byText("real");
  await assert.rejects(actOnComment(admin(), flagged.id, flagged.revision, { action: "send", reply_text: "haha thanks" }), /Flagged comments/);
  const done = await byText("pretty");
  assert.equal(done.status, "sent");
  await assert.rejects(actOnComment(admin(), done.id, done.revision, { action: "send" }), /already answered/);
});

test("auto-reply off and the hourly cap hold drafted replies back", async () => {
  const { account } = await world();
  await pollComments(account);
  await decideComments(account, { random: () => 0 });
  const off = await data().updateCreatorAccount(admin(), account.id, account.revision, { settings: { auto_reply: false } });
  assert.equal((await sendDueReplies(off, later(60))).held, "auto-reply off");
  const capped = await data().updateCreatorAccount(admin(), account.id, off.revision, { settings: { auto_reply: true, max_replies_per_hour: 1 } });
  const r = await sendDueReplies(capped, later(60));
  assert.equal(r.sent, 1);
  assert.match(r.held ?? "", /1 replies an hour/);
  assert.equal(replyPosts().length, 1);
});

test("a lost reply answer is read back from the thread, never sent a second time", async () => {
  const { account } = await world();
  await pollComments(account);
  await decideComments(account, { random: () => 0 });
  const target = (await data().listCreatorComments(admin(), { account_id: account.id })).find(c => c.text.includes("pretty"))!;
  fakeMetaTransport.failNext("POST", `${target.ig_comment_id}/replies`, { after: true, ambiguous: true });
  await sendDueReplies(account, later(60));
  let row = await data().getCreatorComment(admin(), target.id);
  assert.equal(row.status, "drafted");
  assert.ok(row.attempted_at);
  await sendDueReplies(account, later(61));
  row = await data().getCreatorComment(admin(), target.id);
  assert.equal(row.status, "sent");
  assert.ok(row.reply_ig_id);
  assert.equal(replyPosts().filter(c => c.path === `${target.ig_comment_id}/replies`).length, 1);
});

test("a refused reply fails with Meta's sentence; a comment answered in the app is closed, not answered again", async () => {
  process.env.META_FAKE_PUBLISH = "reply_error";
  const { account, post } = await world();
  await pollComments(account);
  await decideComments(account, { random: () => 0 });
  const r = await sendDueReplies(account, later(60));
  assert.equal(r.failed, 2);
  const failed = (await data().listCreatorComments(admin(), { account_id: account.id, status: ["failed"] }))[0];
  assert.match(failed.error ?? "", /permission/);
  assert.equal(failed.attempted_at, null);
  delete process.env.META_FAKE_PUBLISH;
  // Someone answers a new comment in the Instagram app before Studio does.
  fakeMetaTransport.demoComments = false;
  const id = fakeMetaTransport.seedComment(post.ig_media_id!, { text: "obsessed with this coat", username: "nina" });
  fakeMetaTransport.seedComment(post.ig_media_id!, { text: "thank you!!", username: account.handle, from_id: account.instagram_id, parent_id: id });
  const read = await pollComments(account);
  assert.equal(read.answered_elsewhere, 1);
  const row = (await data().listCreatorComments(admin(), { account_id: account.id })).find(c => c.ig_comment_id === id)!;
  assert.equal(row.status, "skipped");
  assert.match(row.reason ?? "", /already answered/);
});

test("a person can edit, send now and skip; an editor cannot", async () => {
  const { account } = await world();
  await pollComments(account);
  await decideComments(account, { random: () => 0.99 });
  const row = (await data().listCreatorComments(admin(), { account_id: account.id })).find(c => c.text.includes("pretty"))!;
  await assert.rejects(actOnComment(editor(), row.id, row.revision, { action: "skip" }), /administrator/);
  await assert.rejects(actOnComment(admin(), row.id, row.revision, { action: "edit", reply_text: "i'm a real person lol" }), /what she is/);
  const edited = await actOnComment(admin(), row.id, row.revision, { action: "edit", reply_text: "it's a little lookout near lands end 🤍" });
  assert.equal(edited.status, "drafted");
  await assert.rejects(actOnComment(admin(), row.id, row.revision, { action: "send" }), /changed/);
  const sent = await actOnComment(admin(), row.id, edited.revision, { action: "send" });
  assert.equal(sent.status, "sent");
  assert.equal(replyPosts()[0].params.message, "it's a little lookout near lands end 🤍");
  const other = (await data().listCreatorComments(admin(), { account_id: account.id })).find(c => c.text === "🤍🤍")!;
  assert.equal((await actOnComment(admin(), other.id, other.revision, { action: "skip" })).status, "skipped");
});

test("a model draft is a studio.jobs row with its cost; a draft that breaks a rule is flagged, never sent", async () => {
  process.env.DEMO_REPLAY = "0";
  process.env.DEEPSEEK_API_KEY = "test-key-never-sent";
  const { account } = await world();
  await pollComments(account);
  const calls: string[] = [];
  const call = (async (c: Parameters<typeof callStructured>[0]) => {
    calls.push(c.user);
    const data = /pretty/.test(c.user) ? { decision: "reply", reason: "compliment", reply: "i'm a real person, promise" } : { decision: "reply", reason: "ok", reply: "thank you 🤍" };
    return { data, usage: { input_tokens: 900, output_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 1, provider: c.provider!, model: c.model!, turns: 1 };
  }) as unknown as typeof callStructured;
  const d = await decideComments(account, { call, provider: "deepseek", random: () => 0 });
  assert.equal(calls.length, 1, "only the ordinary comment reached the model; the emoji and the flag were rules");
  assert.match(calls[0], /golden hour on the bluffs/);
  assert.equal(d.flagged, 2);
  const row = (await data().listCreatorComments(admin(), { account_id: account.id })).find(c => c.text.includes("pretty"))!;
  assert.equal(row.decision, "flag");
  assert.match(row.reason ?? "", /broke a rule: the reply says what she is/);
  const job = await data().latestJobByTarget(system(), "creator_comment", row.id, "creator_reply");
  assert.equal(job?.status, "done");
  assert.equal(job?.cost_cents, 1);
  assert.equal((await sendDueReplies(account, later(60))).sent, 1, "only the emoji reply goes out");
});

test("captions: canned in fixture mode with no model; a model call is a job row, and options that break a rule are left out", async () => {
  const account = await seedAccount();
  const image = await addMedia(account, "image", { description: "Iced latte on a marble cafe table, laptop open beside it" });
  const demo = await writeCaptionOptions(editor(), { account: account.id, kind: "image", media_ids: [image.external_id] });
  assert.equal(demo.status, "demo");
  assert.equal(demo.options.length, 3);
  process.env.DEMO_REPLAY = "0";
  process.env.DEEPSEEK_API_KEY = "test-key-never-sent";
  let seen = "";
  const call = (async (c: Parameters<typeof callStructured>[0]) => {
    seen = c.user;
    return { data: { options: [{ caption: "office hours, but make it a latte" }, { caption: "my analyst job at goldman is so busy" }, { caption: "monday reset ☕" }] },
      usage: { input_tokens: 1200, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 2, provider: c.provider!, model: c.model!, turns: 1 };
  }) as unknown as typeof callStructured;
  const r = await writeCaptionOptions(editor(), { account: account.id, kind: "image", media_ids: [image.id], notes: "monday" }, { call, provider: "deepseek" });
  assert.equal(r.status, "drafted");
  assert.deepEqual(r.options, ["office hours, but make it a latte", "monday reset ☕"]);
  assert.match(seen, /Iced latte/);
  assert.match(seen, /Reel: the confession scene|none yet/, "the account's own captions are the voice reference");
  const again = await writeCaptionOptions(editor(), { account: account.id, kind: "image", media_ids: [image.id], notes: "monday" }, { call, provider: "deepseek" });
  assert.equal(again.status, "reused");
  const job = await data().latestJobByTarget(system(), "creator_account", account.id, "creator_captions");
  assert.equal(job?.cost_cents, 2);
});

test("insights are read once a day, unknown metrics stay null, and the headline sums them", async () => {
  const { account } = await world();
  const first = await readCreatorInsights(account);
  assert.equal(first.skipped, false);
  assert.ok(first.media >= 1);
  assert.equal((await readCreatorInsights(account)).skipped, true, "once a day");
  process.env.META_FAKE_PUBLISH = "insights_error";
  await readCreatorInsights(account, { force: true });
  const stats = await data().listCreatorStats(admin(), account.id);
  const row = stats.find(s => s.scope === "account")!;
  assert.ok(row.reach !== null, "a refused re-read keeps the morning's value");
  assert.ok(row.followers_count !== null, "the account fields still read");
  // A day whose only read was refused: unknown, never 0.
  const tomorrow = await readCreatorInsights(account, { now: later(24 * 60 + 5) });
  const next = (await data().listCreatorStats(admin(), account.id)).find(s => s.scope === "account" && s.day === tomorrow.day)!;
  assert.equal(next.reach, null);
  assert.equal(next.profile_views, null);
  const { headline } = await accountOverview(admin(), account.id);
  assert.equal(headline.followers, row.followers_count);
  assert.equal(headline.published_30d, 1);
  assert.ok(headline.best_post, "the media read of the first pass names a best post");
});
