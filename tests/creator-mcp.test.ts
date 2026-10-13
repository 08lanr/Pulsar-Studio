// The creator tools on Studio's MCP endpoint (decision 2026-10-12): listed on
// the one server after the launch tools, arguments validated before anything
// runs, the session's role decides, the publishing and sending tools say so in
// their descriptions, and nothing internal (storage paths, tokens) comes back.
process.env.PROMO_RENDER = "off";

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpMessage } from "@/lib/launch/mcp";
import { resetCreatorFixture } from "@/lib/data/creators";
import { creatorMcpTools } from "@/lib/creators/mcp";
import { creatorPostSettled, resetCreatorPublishState } from "@/lib/creators/publish";
import { resetFakeMeta } from "@/lib/meta/fake";
import { addMedia, admin, editor, producer, seedAccount } from "./creator-seed";

const saved = { DATA_SOURCE: process.env.DATA_SOURCE, FIXTURE_PERSIST: process.env.FIXTURE_PERSIST };
beforeEach(() => { process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_PERSIST = "off"; resetCreatorFixture(); resetFakeMeta(); resetCreatorPublishState(); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

let n = 0;
const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } });
type Result = { result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content: { text: string }[] }; error?: { code: number; message: string } };
const run = async (session: Parameters<typeof handleMcpMessage>[0], name: string, args: Record<string, unknown>) => (await handleMcpMessage(session, call(name, args))) as Result;

test("every creator tool is listed with a JSON schema, and the publishing ones say so", async () => {
  const list = (await handleMcpMessage(admin(), { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; description: string; inputSchema: { type: string } }[] } };
  const names = list.result.tools.map(t => t.name);
  for (const name of ["creator_list", "creator_get", "creator_media_list", "creator_media_describe", "creator_queue_list", "creator_post_schedule", "creator_post_update",
    "creator_post_cancel", "creator_caption_options", "creator_comments_list", "creator_reply_send", "creator_settings_update", "creator_stats"]) assert.ok(names.includes(name), name);
  assert.ok(names.includes("launch_list"), "one endpoint for both");
  const desc = (name: string) => list.result.tools.find(t => t.name === name)!.description;
  assert.match(desc("creator_post_schedule"), /PUBLISHES TO INSTAGRAM/);
  assert.match(desc("creator_reply_send"), /SENDS A PUBLIC REPLY/);
  for (const t of creatorMcpTools) {
    assert.equal(t.inputSchema.type, "object");
    if (/^Write/.test(t.description) || t.name === "creator_caption_options") continue;
    assert.match(t.description, /Read-only/, t.name);
  }
});

test("arguments are validated before anything runs", async () => {
  assert.equal((await run(admin(), "creator_post_schedule", { account: "x", kind: "story", media_ids: ["a"], caption: "", when: "now" })).error?.code, -32602);
  assert.equal((await run(admin(), "creator_post_schedule", { account: "x", kind: "image", media_ids: ["a"], caption: "", when: "schedule" })).error?.code, -32602, "schedule needs a time");
  assert.equal((await run(admin(), "creator_get", { account: "x", extra: 1 })).error?.code, -32602);
  assert.equal((await run(admin(), "creator_reply_send", { comment: "c" })).error?.code, -32602, "a revision is required");
});

test("an agent schedules, lists, describes and publishes through the same rules as a person", async () => {
  const account = await seedAccount({ handle: "chloelin.diary" });
  const image = await addMedia(account);
  const media = await run(admin(), "creator_media_list", { account: "chloelin.diary" });
  const item = (media.result!.structuredContent!.media as { id: string; revision: number; used_in: number }[])[0];
  assert.match(item.id, /^cm_/);
  assert.ok(!JSON.stringify(media).includes("creators/"), "no storage path");
  const described = await run(editor(), "creator_media_describe", { media: item.id, revision: item.revision, description: "latte on a marble table", tags: ["cafe"] });
  assert.equal((described.result!.structuredContent as { description: string }).description, "latte on a marble table");
  const stale = await run(editor(), "creator_media_describe", { media: item.id, revision: item.revision, description: "stale" });
  assert.equal(stale.result?.isError, true);
  assert.match(stale.result!.content[0].text, /changed/);

  const refused = await run(admin(), "creator_post_schedule", { account: "chloelin.diary", kind: "image", media_ids: [item.id], caption: "now on CrazyDramas", when: "now" });
  assert.equal(refused.result?.isError, true);
  assert.match(refused.result!.content[0].text, /never mentions CrazyDramas/);
  const byEditor = await run(editor(), "creator_post_schedule", { account: "chloelin.diary", kind: "image", media_ids: [item.id], caption: "x", when: "draft" });
  assert.match(byEditor.result!.content[0].text, /administrator/);
  const by = await run(producer(), "creator_list", {});
  assert.equal(by.result?.isError, true, "producers never see creator accounts");

  const at = new Date(Date.now() + 86_400_000).toISOString();
  const scheduled = await run(admin(), "creator_post_schedule", { account: "chloelin.diary", kind: "image", media_ids: [item.id], caption: "sunday reset", when: "schedule", scheduled_at: at, source: "muse" });
  const post = (scheduled.result!.structuredContent as { post: { id: string; status: string; revision: number } }).post;
  assert.equal(post.status, "scheduled");
  const queue = await run(admin(), "creator_queue_list", { account: account.id, status: ["scheduled"] });
  assert.equal((queue.result!.structuredContent!.posts as unknown[]).length, 1);
  const cancelled = await run(admin(), "creator_post_cancel", { post: post.id, revision: post.revision });
  assert.equal((cancelled.result!.structuredContent as { post: { status: string } }).post.status, "cancelled");

  const now = await run(admin(), "creator_post_schedule", { account: "chloelin.diary", kind: "image", media_ids: [image.external_id], caption: "hi from sf", when: "now" });
  const live = (now.result!.structuredContent as { post: { id: string } }).post;
  const { getData } = await import("@/lib/data");
  const row = await getData().getCreatorPost(admin(), live.id);
  await creatorPostSettled(row.id);
  assert.equal((await getData().getCreatorPost(admin(), live.id)).source, "agent");
  const stats = await run(editor(), "creator_get", { account: "chloelin.diary" });
  const shown = stats.result!.structuredContent as { account: { persona: unknown; settings: { auto_reply: boolean } }; headline: { published_30d: number } };
  assert.equal(shown.account.settings.auto_reply, true);
  assert.equal(shown.headline.published_30d, 1);
  assert.ok(!JSON.stringify(stats).toLowerCase().includes("token"));
});

test("settings: CAS on the revision, and validation of the delays", async () => {
  const account = await seedAccount();
  const ok = await run(admin(), "creator_settings_update", { account: account.id, revision: account.revision, auto_reply: false, persona: { city: "San Francisco" } });
  const after = ok.result!.structuredContent as { settings: { auto_reply: boolean }; persona: { city: string }; revision: number };
  assert.equal(after.settings.auto_reply, false);
  assert.equal(after.persona.city, "San Francisco");
  const stale = await run(admin(), "creator_settings_update", { account: account.id, revision: account.revision, auto_reply: true });
  assert.match(stale.result!.content[0].text, /changed/);
  const bad = await run(admin(), "creator_settings_update", { account: account.id, revision: after.revision, reply_delay_min: 30, reply_delay_max: 5 });
  assert.match(bad.result!.content[0].text, /minimum/);
});
