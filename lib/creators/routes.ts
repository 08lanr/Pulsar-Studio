// The staff routes of /creators (decision 2026-10-12), in one place: every
// route file under app/api/admin/creators is a thin call into here. House
// shape (CLAUDE.md): same-origin guard and error mapping by `handle`, staff
// session, zod on every body, then lib/creators/service.ts / replies.ts / the
// data layer. Reads are any staff member's; the service refuses writes that
// need an administrator. Responses carry external ids and app URLs, never a
// storage path or anything credential-shaped.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireStaff, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { notFound } from "@/lib/data/errors";
import { writeCaptionOptions } from "./captions";
import { readCreatorInsights } from "./insights";
import { importCreatorMedia } from "./media";
import { actOnComment, syncCommentsNow } from "./replies";
import { accountOverview, assertCreatorAdmin, cancelPost, postNow, retryPost, schedulePost, updateAccountSettings, updatePost } from "./service";
import { creatorsGate, lastCreatorsRun } from "./sweeps";
import { CREATOR_POST_KINDS, type CreatorMedia, type CreatorPost } from "./types";

const noStore = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

export async function staffOnly(): Promise<{ session: Session; response?: undefined } | { session?: undefined; response: Response }> {
  const g = await requireStaff();
  return g.response ? { response: g.response } : { session: g.session };
}

/** A media row as the browser sees it: its file through the staff route, never the storage path. */
export function mediaJson(m: CreatorMedia, usedIn = 0) {
  const { path: _path, ...rest } = m;
  return { ...rest, url: `/api/admin/creators/${m.account_id}/media/${m.id}`, used_in: usedIn };
}

export async function parse<S extends z.ZodTypeAny>(req: NextRequest, schema: S): Promise<{ data: z.infer<S>; response?: undefined } | { data?: undefined; response: Response }> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw ?? {});
  return parsed.success ? { data: parsed.data } : { response: apiError("Invalid request", parsed.error.flatten(), 400) };
}

const iso = z.string().datetime({ offset: true });
const ids = z.array(z.string().min(1).max(120)).min(1).max(10);

export const settingsBody = z.object({
  revision: z.number().int().positive(),
  display_name: z.string().trim().min(1).max(80).optional(),
  status: z.enum(["active", "paused"]).optional(),
  settings: z.object({
    timezone: z.string().max(60).optional(), auto_reply: z.boolean().optional(),
    reply_delay_min: z.number().int().min(0).max(1440).optional(), reply_delay_max: z.number().int().min(0).max(1440).optional(),
    max_replies_per_hour: z.number().int().min(0).max(60).optional(), reply_window_days: z.number().int().min(1).max(90).optional(),
  }).strict().optional(),
  persona: z.object({
    summary: z.string().max(2000).optional(), age: z.number().int().min(18).max(99).nullable().optional(), city: z.string().max(120).optional(),
    interests: z.array(z.string().max(60)).max(30).optional(), voice: z.string().max(2000).optional(),
    do: z.array(z.string().max(300)).max(30).optional(), dont: z.array(z.string().max(300)).max(30).optional(), banned_topics: z.array(z.string().max(120)).max(30).optional(),
  }).strict().optional(),
}).strict();

export const scheduleBody = z.object({
  kind: z.enum(CREATOR_POST_KINDS), media_ids: ids, caption: z.string().max(2200),
  when: z.enum(["draft", "schedule", "now"]), scheduled_at: iso.nullable().optional(),
}).strict();

export const editBody = z.object({
  revision: z.number().int().positive(), kind: z.enum(CREATOR_POST_KINDS).optional(), media_ids: ids.optional(),
  caption: z.string().max(2200).optional(), scheduled_at: iso.nullable().optional(), when: z.enum(["draft", "schedule"]).optional(),
}).strict();

export const postActionBody = z.object({ action: z.enum(["now", "retry", "cancel"]), revision: z.number().int().positive() }).strict();
export const captionBody = z.object({ kind: z.enum(CREATOR_POST_KINDS), media_ids: ids, notes: z.string().max(500).nullable().optional(), attempt: z.number().int().min(1).max(100).optional() }).strict();
export const mediaPatchBody = z.object({ revision: z.number().int().positive(), description: z.string().max(1000).optional(), tags: z.array(z.string().max(40)).max(20).optional() }).strict();
export const commentBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), revision: z.number().int().positive(), reply_text: z.string().max(150).nullable().optional() }).strict(),
  z.object({ action: z.literal("edit"), revision: z.number().int().positive(), reply_text: z.string().min(1).max(150) }).strict(),
  z.object({ action: z.literal("skip"), revision: z.number().int().positive() }).strict(),
]);

// ---- handlers (each route file calls one inside `handle`) ----------------------------

export async function listAccounts(session: Session) {
  const data = getData();
  const [accounts, posts] = await Promise.all([data.listCreatorAccounts(session), data.listCreatorPosts(session)]);
  return json({
    accounts: accounts.map(a => ({ ...a, scheduled: posts.filter(p => p.account_id === a.id && p.status === "scheduled").length,
      failed: posts.filter(p => p.account_id === a.id && p.status === "failed").length })),
    sweep: { gate: creatorsGate(), last: lastCreatorsRun() },
  });
}

export async function getOverview(session: Session, id: string) { return json(await accountOverview(session, id)); }

export async function patchAccount(session: Session, id: string, body: z.infer<typeof settingsBody>) {
  const { revision, ...patch } = body;
  return json({ account: await updateAccountSettings(session, id, revision, patch) });
}

export async function listMedia(session: Session, id: string) {
  const data = getData();
  const account = await data.getCreatorAccount(session, id);
  const [media, posts] = await Promise.all([data.listCreatorMedia(session, account.id), data.listCreatorPosts(session, { account_id: account.id })]);
  const live = posts.filter(p => p.status !== "cancelled");
  return json({ media: media.map(m => mediaJson(m, live.filter(p => p.media_ids.includes(m.id)).length)) });
}

/** Multipart: one or more `file` fields, an optional `description` and comma-separated `tags` applied to each. */
export async function uploadMedia(session: Session, id: string, req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const files = (form?.getAll("file") ?? []).filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return apiError("Choose a picture or a video.", undefined, 400);
  if (files.length > 20) return apiError("At most 20 files at a time.", undefined, 400);
  const description = String(form?.get("description") ?? "").slice(0, 1000);
  const tags = String(form?.get("tags") ?? "").split(",").map(t => t.trim()).filter(Boolean).slice(0, 20);
  const results = [];
  for (const file of files) {
    try {
      const r = await importCreatorMedia(session, id, { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, description, tags });
      results.push({ name: file.name, ok: true, created: r.created, converted: r.converted, warnings: r.warnings, media: mediaJson(r.media) });
    } catch (e) {
      results.push({ name: file.name, ok: false, error: (e as Error).message.slice(0, 300) });
    }
  }
  // Each file answers for itself (one refused file never hides the others' results).
  return json({ results });
}

export async function patchMedia(session: Session, id: string, mediaId: string, body: z.infer<typeof mediaPatchBody>) {
  const data = getData();
  const account = await data.getCreatorAccount(session, id);
  const media = await data.getCreatorMedia(session, mediaId);
  if (media.account_id !== account.id) throw notFound("Media");
  return json({ media: mediaJson(await data.updateCreatorMedia(session, media.id, body.revision, { description: body.description, tags: body.tags })) });
}

export async function listPosts(session: Session, id: string) {
  const data = getData();
  const account = await data.getCreatorAccount(session, id);
  return json({ posts: await data.listCreatorPosts(session, { account_id: account.id }) });
}

export async function createPost(session: Session, id: string, body: z.infer<typeof scheduleBody>) {
  const r = await schedulePost(session, { account: id, ...body, scheduled_at: body.scheduled_at ?? null, source: "human" });
  return json(r, 201);
}

async function ownPost(session: Session, id: string, postId: string): Promise<CreatorPost> {
  const data = getData();
  const account = await data.getCreatorAccount(session, id);
  const post = await data.getCreatorPost(session, postId);
  if (post.account_id !== account.id) throw notFound("Post");
  return post;
}

export async function editPost(session: Session, id: string, postId: string, body: z.infer<typeof editBody>) {
  const post = await ownPost(session, id, postId);
  const { revision, ...edit } = body;
  return json(await updatePost(session, post.id, revision, edit));
}

export async function actOnPost(session: Session, id: string, postId: string, body: z.infer<typeof postActionBody>) {
  const post = await ownPost(session, id, postId);
  const next = body.action === "now" ? await postNow(session, post.id, body.revision)
    : body.action === "retry" ? await retryPost(session, post.id) : await cancelPost(session, post.id, body.revision);
  return json({ post: next });
}

export async function captions(session: Session, id: string, body: z.infer<typeof captionBody>) {
  return json(await writeCaptionOptions(session, { account: id, ...body }));
}

export async function listComments(session: Session, id: string) {
  const data = getData();
  const account = await data.getCreatorAccount(session, id);
  return json({ comments: await data.listCreatorComments(session, { account_id: account.id }) });
}

export async function syncComments(session: Session, id: string) {
  return json(await syncCommentsNow(session, id));
}

export async function actOnCommentRoute(session: Session, id: string, commentId: string, body: z.infer<typeof commentBody>) {
  const data = getData();
  const account = await data.getCreatorAccount(session, id);
  const comment = await data.getCreatorComment(session, commentId);
  if (comment.account_id !== account.id) throw notFound("Comment");
  const act = body.action === "skip" ? { action: "skip" as const } : body.action === "edit" ? { action: "edit" as const, reply_text: body.reply_text } : { action: "send" as const, reply_text: body.reply_text ?? null };
  return json({ comment: await actOnComment(session, comment.id, body.revision, act) });
}

export async function readStatsNow(session: Session, id: string) {
  assertCreatorAdmin(session);
  const account = await getData().getCreatorAccount(session, id);
  const read = await readCreatorInsights(account, { force: true });
  return json({ read, ...(await accountOverview(session, account.id)) });
}
