// Creator-account tools on Studio's one MCP endpoint (/api/mcp, lib/launch/mcp.ts
// lists them after the launch tools; decision 2026-10-12). Built so an agent —
// Meta's Muse, later, through a connector — can run a creator account with the
// same rules a person has on /creators: every tool calls lib/creators/service.ts,
// lib/creators/replies.ts or the data layer, never a table, and the session's
// role decides (reads: any staff; writes: a staff administrator).
//
// Descriptions are factual and say plainly which tools publish to Instagram or
// send a reply there: those are the sensitive writes.

import { z } from "zod";
import type { Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { writeCaptionOptions } from "./captions";
import { actOnComment } from "./replies";
import { accountOverview, cancelPost, schedulePost, updateAccountSettings, updatePost } from "./service";
import { CREATOR_POST_KINDS, type CreatorAccount, type CreatorComment, type CreatorMedia, type CreatorPost } from "./types";

type Params = Record<string, unknown>;
export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown>; parse: z.ZodType<Params> };

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const ref = z.string().trim().min(1).max(120);
const account = { account: { type: "string", description: "Creator account: its cr_ id, uuid or Instagram handle (e.g. chloelin.diary)" } };
const revision = { revision: { type: "integer", minimum: 1, description: "The row's current revision, from the last read; a stale one is refused (no silent overwrite)" } };
const kinds = { type: "string", enum: [...CREATOR_POST_KINDS], description: "image (one JPEG), carousel (2-10 images or short videos, in order) or reel (one video, 3 s to 15 min)" };
const mediaIds = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10, description: "Media from the account's library (cm_ ids), in post order" };
const iso = z.string().datetime({ offset: true });
const commentFilters = ["all", "new", "drafted", "sent", "skipped", "flagged", "failed"] as const;
const personaPatch = z.object({
  summary: z.string().max(2000).optional(), age: z.number().int().min(18).max(99).nullable().optional(), city: z.string().max(120).optional(),
  interests: z.array(z.string().max(60)).max(30).optional(), voice: z.string().max(2000).optional(),
  do: z.array(z.string().max(300)).max(30).optional(), dont: z.array(z.string().max(300)).max(30).optional(), banned_topics: z.array(z.string().max(120)).max(30).optional(),
}).strict();

export const creatorMcpTools: McpTool[] = [
  { name: "creator_list", description: "List the Instagram creator accounts Studio runs, with status, auto-reply and how many posts are scheduled. Read-only.",
    inputSchema: object({}), parse: z.object({}).strict() },
  { name: "creator_get", description: "Read one creator account: its character bible (persona), reply settings and headline numbers (followers, reach over 7 days, posts, replies sent, best post). Read-only.",
    inputSchema: object(account, ["account"]), parse: z.object({ account: ref }).strict() },
  { name: "creator_media_list", description: "List the account's media library: each picture or video with its id, size, length, description and tags, and how many posts use it. Read-only.",
    inputSchema: object(account, ["account"]), parse: z.object({ account: ref }).strict() },
  { name: "creator_media_describe", description: "Write: set what a library item shows (its description) and its tags. The caption writer reads the description. Changes Studio only, nothing on Instagram.",
    inputSchema: object({ media: { type: "string", description: "cm_ id" }, ...revision, description: { type: "string", maxLength: 1000 }, tags: { type: "array", items: { type: "string" }, maxItems: 20 } }, ["media", "revision"]),
    parse: z.object({ media: ref, revision: z.number().int().positive(), description: z.string().max(1000).optional(), tags: z.array(z.string().max(40)).max(20).optional() }).strict() },
  { name: "creator_queue_list", description: "List the account's posts (drafts, scheduled, publishing, published, failed, cancelled), newest first, with caption, time, Instagram link and any error. Read-only.",
    inputSchema: object({ ...account, status: { type: "array", items: { type: "string", enum: ["draft", "scheduled", "publishing", "published", "failed", "cancelled"] } } }, ["account"]),
    parse: z.object({ account: ref, status: z.array(z.enum(["draft", "scheduled", "publishing", "published", "failed", "cancelled"])).optional() }).strict() },
  { name: "creator_post_schedule", description: "Write, PUBLISHES TO INSTAGRAM: create a post on the creator's public Instagram account. when=now publishes it immediately; when=schedule publishes it automatically at scheduled_at; when=draft saves it without publishing. Studio checks everything Instagram would refuse (JPEG, 4:5-1.91:1 feed shape, carousel 2-10, Reel length, caption limits, no CrazyDramas mention) before accepting it. Staff administrator only.",
    inputSchema: object({ ...account, kind: kinds, media_ids: mediaIds, caption: { type: "string", maxLength: 2200 }, when: { type: "string", enum: ["draft", "schedule", "now"] },
      scheduled_at: { type: "string", format: "date-time", description: "Required for when=schedule" }, source: { type: "string", enum: ["agent", "muse"], description: "Who is asking; recorded on the post" } }, ["account", "kind", "media_ids", "caption", "when"]),
    parse: z.object({ account: ref, kind: z.enum(CREATOR_POST_KINDS), media_ids: z.array(ref).min(1).max(10), caption: z.string().max(2200), when: z.enum(["draft", "schedule", "now"]),
      scheduled_at: iso.optional(), source: z.enum(["agent", "muse"]).optional() }).strict()
      .refine(v => v.when !== "schedule" || !!v.scheduled_at, { message: "scheduled_at is required when when=schedule", path: ["scheduled_at"] }) as unknown as z.ZodType<Params> },
  { name: "creator_post_update", description: "Write: change a draft, scheduled or failed post (kind, media, caption, time; when=draft unschedules it, when=schedule schedules it). A scheduled post is then published automatically at its time. Revision-checked. Staff administrator only.",
    inputSchema: object({ post: { type: "string", description: "cp_ id" }, ...revision, kind: kinds, media_ids: mediaIds, caption: { type: "string", maxLength: 2200 },
      scheduled_at: { type: "string", format: "date-time" }, when: { type: "string", enum: ["draft", "schedule"] } }, ["post", "revision"]),
    parse: z.object({ post: ref, revision: z.number().int().positive(), kind: z.enum(CREATOR_POST_KINDS).optional(), media_ids: z.array(ref).min(1).max(10).optional(),
      caption: z.string().max(2200).optional(), scheduled_at: iso.optional(), when: z.enum(["draft", "schedule"]).optional() }).strict() },
  { name: "creator_post_cancel", description: "Write: cancel a draft, scheduled or failed post so it is never published. Cannot remove a post already on Instagram. Revision-checked. Staff administrator only.",
    inputSchema: object({ post: { type: "string" }, ...revision }, ["post", "revision"]), parse: z.object({ post: ref, revision: z.number().int().positive() }).strict() },
  { name: "creator_caption_options", description: "Write three caption options for a post from the media descriptions, the character bible and her recent captions. Runs a model (recorded with its cost); publishes nothing.",
    inputSchema: object({ ...account, kind: kinds, media_ids: mediaIds, notes: { type: "string", maxLength: 500 }, attempt: { type: "integer", minimum: 1, description: "1 first; a higher number asks for new options" } }, ["account", "kind", "media_ids"]),
    parse: z.object({ account: ref, kind: z.enum(CREATOR_POST_KINDS), media_ids: z.array(ref).min(1).max(10), notes: z.string().max(500).optional(), attempt: z.number().int().positive().max(100).optional() }).strict() },
  { name: "creator_comments_list", description: "List comments on the account's posts with Studio's decision (reply, skip or flag), the reason, the drafted reply and whether it was sent. Read-only.",
    inputSchema: object({ ...account, filter: { type: "string", enum: [...commentFilters] }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["account"]),
    parse: z.object({ account: ref, filter: z.enum(commentFilters).optional(), limit: z.number().int().min(1).max(200).optional() }).strict() },
  { name: "creator_reply_send", description: "Write, SENDS A PUBLIC REPLY ON INSTAGRAM: reply to one comment now, with the drafted reply or reply_text in its place. One reply per comment, ever; flagged comments (real/AI questions, sexual, minors, hostile, meeting, contact, money, DMs) are refused; the reply must pass the voice rules (one short sentence, no links, hashtags, CrazyDramas or claims about what she is). Staff administrator only.",
    inputSchema: object({ comment: { type: "string", description: "Comment id from creator_comments_list" }, ...revision, reply_text: { type: "string", maxLength: 150 } }, ["comment", "revision"]),
    parse: z.object({ comment: ref, revision: z.number().int().positive(), reply_text: z.string().max(150).optional() }).strict() },
  { name: "creator_settings_update", description: "Write: change the account's settings — auto_reply (whether Studio sends drafted replies by itself), reply delays and hourly cap, reply window, time zone, status (paused stops scheduled posts and replies) — and character-bible fields. Revision-checked. Staff administrator only.",
    inputSchema: object({ ...account, ...revision, auto_reply: { type: "boolean" }, reply_delay_min: { type: "integer", minimum: 0 }, reply_delay_max: { type: "integer", minimum: 0 },
      max_replies_per_hour: { type: "integer", minimum: 0, maximum: 60 }, reply_window_days: { type: "integer", minimum: 1, maximum: 90 }, timezone: { type: "string" },
      status: { type: "string", enum: ["active", "paused"] }, persona: { type: "object", description: "Any of summary, age, city, interests, voice, do, dont, banned_topics" } }, ["account", "revision"]),
    parse: z.object({ account: ref, revision: z.number().int().positive(), auto_reply: z.boolean().optional(), reply_delay_min: z.number().int().min(0).max(1440).optional(),
      reply_delay_max: z.number().int().min(0).max(1440).optional(), max_replies_per_hour: z.number().int().min(0).max(60).optional(), reply_window_days: z.number().int().min(1).max(90).optional(),
      timezone: z.string().max(60).optional(), status: z.enum(["active", "paused"]).optional(), persona: personaPatch.optional() }).strict() },
  { name: "creator_stats", description: "Read the account's numbers: followers per day, reach, posts published, replies sent, flagged comments waiting, and per-post reach, likes, comments, saves, shares and views from the daily insights read. Unknown values are null, never 0. Read-only.",
    inputSchema: object(account, ["account"]), parse: z.object({ account: ref }).strict() },
];

function accountView(a: CreatorAccount, posts: CreatorPost[]) {
  return { id: a.id, external_id: a.external_id, handle: a.handle, display_name: a.display_name, instagram_id: a.instagram_id, page_id: a.page_id,
    status: a.status, revision: a.revision, auto_reply: a.settings.auto_reply,
    scheduled: posts.filter(p => p.account_id === a.id && p.status === "scheduled").length,
    published: posts.filter(p => p.account_id === a.id && p.status === "published").length };
}
const mediaView = (m: CreatorMedia, used: number) => ({ id: m.external_id, kind: m.kind, width: m.width, height: m.height, duration_s: m.duration_s,
  description: m.description, tags: m.tags, filename: m.filename, used_in: used, revision: m.revision, created_at: m.created_at });
const postView = (p: CreatorPost, media: CreatorMedia[]) => ({ id: p.external_id, kind: p.kind, status: p.status, step: p.step,
  media_ids: p.media_ids.map(id => media.find(m => m.id === id)?.external_id ?? id), caption: p.caption, scheduled_at: p.scheduled_at,
  published_at: p.published_at, permalink: p.permalink, ig_media_id: p.ig_media_id, error: p.error, source: p.source, revision: p.revision });
const commentView = (c: CreatorComment) => ({ id: c.id, ig_comment_id: c.ig_comment_id, username: c.username, text: c.text, commented_at: c.commented_at,
  decision: c.decision, reason: c.reason, reply_text: c.reply_text, reply_due_at: c.reply_due_at, status: c.status, replied_at: c.replied_at,
  error: c.error, in_thread: !!c.parent_ig_id, revision: c.revision });

export async function invokeCreatorTool(session: Session, name: string, args: Params): Promise<unknown> {
  const data = getData();
  const str = (k: string) => args[k] as string;
  switch (name) {
    case "creator_list": {
      const [accounts, posts] = await Promise.all([data.listCreatorAccounts(session), data.listCreatorPosts(session)]);
      return { accounts: accounts.map(a => accountView(a, posts)) };
    }
    case "creator_get": {
      const o = await accountOverview(session, str("account"));
      const { media: _media, ...headline } = o.headline;
      return { account: { ...accountView(o.account, []), persona: o.account.persona, settings: o.account.settings }, today: o.today, headline };
    }
    case "creator_media_list": {
      const a = await data.getCreatorAccount(session, str("account"));
      const [media, posts] = await Promise.all([data.listCreatorMedia(session, a.id), data.listCreatorPosts(session, { account_id: a.id })]);
      const live = posts.filter(p => p.status !== "cancelled");
      return { media: media.map(m => mediaView(m, live.filter(p => p.media_ids.includes(m.id)).length)) };
    }
    case "creator_media_describe": {
      const m = await data.getCreatorMedia(session, str("media"));
      const next = await data.updateCreatorMedia(session, m.id, args.revision as number, { description: args.description as string | undefined, tags: args.tags as string[] | undefined });
      return mediaView(next, 0);
    }
    case "creator_queue_list": {
      const a = await data.getCreatorAccount(session, str("account"));
      const [posts, media] = await Promise.all([data.listCreatorPosts(session, { account_id: a.id, status: args.status as CreatorPost["status"][] | undefined }), data.listCreatorMedia(session, a.id)]);
      return { posts: posts.map(p => postView(p, media)) };
    }
    case "creator_post_schedule": {
      const r = await schedulePost(session, { account: str("account"), kind: args.kind as CreatorPost["kind"], media_ids: args.media_ids as string[], caption: str("caption"),
        scheduled_at: (args.scheduled_at as string | undefined) ?? null, when: args.when as "draft" | "schedule" | "now", source: (args.source as "agent" | "muse" | undefined) ?? "agent" });
      return { post: postView(r.post, await data.listCreatorMedia(session, r.post.account_id)), warnings: r.warnings };
    }
    case "creator_post_update": {
      const r = await updatePost(session, str("post"), args.revision as number, { kind: args.kind as CreatorPost["kind"] | undefined, media_ids: args.media_ids as string[] | undefined,
        caption: args.caption as string | undefined, scheduled_at: args.scheduled_at as string | undefined, when: args.when as "draft" | "schedule" | undefined });
      return { post: postView(r.post, await data.listCreatorMedia(session, r.post.account_id)), warnings: r.warnings };
    }
    case "creator_post_cancel": {
      const p = await cancelPost(session, str("post"), args.revision as number);
      return { post: postView(p, await data.listCreatorMedia(session, p.account_id)) };
    }
    case "creator_caption_options":
      return writeCaptionOptions(session, { account: str("account"), kind: args.kind as CreatorPost["kind"], media_ids: args.media_ids as string[], notes: args.notes as string | undefined, attempt: args.attempt as number | undefined });
    case "creator_comments_list": {
      const a = await data.getCreatorAccount(session, str("account"));
      const filter = (args.filter as (typeof commentFilters)[number] | undefined) ?? "all";
      const rows = (await data.listCreatorComments(session, { account_id: a.id }))
        .filter(c => filter === "all" || (filter === "flagged" ? c.decision === "flag" : c.status === filter));
      return { comments: rows.slice(0, (args.limit as number | undefined) ?? 50).map(commentView) };
    }
    case "creator_reply_send":
      return commentView(await actOnComment(session, str("comment"), args.revision as number, { action: "send", reply_text: args.reply_text as string | undefined }));
    case "creator_settings_update": {
      const settings = Object.fromEntries(["auto_reply", "reply_delay_min", "reply_delay_max", "max_replies_per_hour", "reply_window_days", "timezone"]
        .filter(k => args[k] !== undefined).map(k => [k, args[k]]));
      const a = await updateAccountSettings(session, str("account"), args.revision as number, {
        settings, ...(args.status ? { status: args.status as "active" | "paused" } : {}), ...(args.persona ? { persona: args.persona as Record<string, never> } : {}),
      });
      return { ...accountView(a, []), persona: a.persona, settings: a.settings };
    }
    case "creator_stats": {
      const o = await accountOverview(session, str("account"));
      return { account: o.account.handle, today: o.today, ...o.headline };
    }
    default: throw new Error("Unknown tool");
  }
}
