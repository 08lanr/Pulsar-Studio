// Comments and replies on a creator account (decision 2026-10-12).
//
//   read     every media of the account from the last `reply_window_days` —
//            Studio's posts and the ones made by hand alike — and its comments
//            with their replies; the account's own words are never recorded as
//            comments, they are the proof a comment was already answered
//   decide   lib/creators/reply-policy.ts first (skip / flag / emoji reply),
//            then one model call per remaining comment (a studio.jobs row of kind
//            `creator_reply`), its answer zod-validated and re-checked by
//            `replyProblem`; a reply that breaks a rule is flagged, never sent
//   send     only with auto-reply on and the account active, after the random
//            delay, under `max_replies_per_hour`, through POST /{comment}/replies;
//            `attempted_at` is set before the call, and a resumed send reads the
//            thread back instead of sending again: one comment, one reply, ever
//
// A person may send, edit or skip any comment from the Comments tab or the MCP
// tools — except a flagged one: those are answered in the Instagram app, if at all.

import { systemSession, type Session } from "@/lib/auth";
import { demoReplayActive } from "@/lib/data-source";
import { getData } from "@/lib/data";
import { conflict, forbidden, invalid } from "@/lib/data/errors";
import { runJob } from "@/lib/jobs";
import { LlmUnavailableError, adsTextProvider, callStructured, isLlmAvailable, modelFor, type LlmProvider } from "@/lib/llm";
import { metaList, MetaApiError, type MetaObject } from "@/lib/meta/transport";
import { CREATOR_REPLY_PROMPT_VERSION, ReplyDraftSchema, buildReplyDraft, type ReplyDraftOutput } from "@/lib/prompts/creator";
import { creatorTransport, isTransient } from "./publish";
import { preFilter, replyDueAt, replyProblem } from "./reply-policy";
import type { CreatorAccount, CreatorComment } from "./types";

export const REPLY_JOB_KIND = "creator_reply" as const;
/** Model drafts per account per sweep, so a burst of comments cannot run away with the spend. */
export const DRAFTS_PER_SWEEP = 20;

const system = systemSession;
const data = () => getData();
const text = (v: unknown) => (typeof v === "string" ? v : "");
const isOwn = (account: CreatorAccount, row: MetaObject) => {
  const from = row.from as MetaObject | undefined;
  return text(from?.id) === account.instagram_id || text(row.username).toLowerCase() === account.handle || text(from?.username).toLowerCase() === account.handle;
};

export type CommentSweep = { media: number; read: number; added: number; answered_elsewhere: number };

/** Reads the account's comments into creator_comments. Read-only towards Meta. */
export async function pollComments(account: CreatorAccount, now = new Date()): Promise<CommentSweep> {
  const transport = creatorTransport(account);
  const since = now.getTime() - account.settings.reply_window_days * 86_400_000;
  const listed = await transport.get(`${account.instagram_id}/media`, { fields: "id,caption,timestamp", limit: 50 });
  const media = (Array.isArray(listed.data) ? (listed.data as MetaObject[]) : [])
    .filter(m => typeof m.id === "string" && (!m.timestamp || Date.parse(String(m.timestamp)) >= since));
  const posts = await data().listCreatorPosts(system(), { account_id: account.id });
  const postOf = new Map(posts.filter(p => p.ig_media_id).map(p => [p.ig_media_id as string, p.id]));
  const sweep: CommentSweep = { media: media.length, read: 0, added: 0, answered_elsewhere: 0 };
  for (const m of media) {
    const mediaId = String(m.id);
    const rows = await metaList(transport, `${mediaId}/comments`, { fields: "id,text,timestamp,username,from,replies{id,text,timestamp,username,from}" });
    for (const row of rows) {
      sweep.read += 1;
      const replies = (((row.replies as MetaObject | undefined)?.data) as MetaObject[] | undefined) ?? [];
      if (!isOwn(account, row)) {
        const { comment, created } = await data().recordCreatorComment(system(), {
          account_id: account.id, post_id: postOf.get(mediaId) ?? null, ig_media_id: mediaId, ig_comment_id: String(row.id),
          parent_ig_id: null, username: text(row.username) || text((row.from as MetaObject | undefined)?.username), text: text(row.text),
          commented_at: text(row.timestamp) || now.toISOString(),
        });
        if (created) sweep.added += 1;
        const own = replies.filter(r => isOwn(account, r));
        if (own.length) sweep.answered_elsewhere += await settleAnswered(comment, own);
      }
      for (const reply of replies) {
        if (isOwn(account, reply)) continue;
        sweep.read += 1;
        const { created } = await data().recordCreatorComment(system(), {
          account_id: account.id, post_id: postOf.get(mediaId) ?? null, ig_media_id: mediaId, ig_comment_id: String(reply.id),
          parent_ig_id: String(row.id), username: text(reply.username) || text((reply.from as MetaObject | undefined)?.username), text: text(reply.text),
          commented_at: text(reply.timestamp) || now.toISOString(),
        });
        if (created) sweep.added += 1;
      }
    }
  }
  return sweep;
}

/**
 * The account already answered this comment on Instagram. Studio's own reply
 * (its id recorded) needs nothing; a reply Studio sent but never recorded is
 * adopted; one made in the app closes the comment so Studio never adds a second.
 */
async function settleAnswered(comment: CreatorComment, own: MetaObject[]): Promise<number> {
  if (comment.reply_ig_id && own.some(r => String(r.id) === comment.reply_ig_id)) return 0;
  if (comment.status === "sent" || comment.status === "skipped") return 0;
  const mine = comment.attempted_at && comment.reply_text ? own.find(r => text(r.text).trim() === comment.reply_text!.trim()) : undefined;
  if (mine) {
    await data().updateCreatorComment(system(), comment.id, comment.revision,
      { status: "sent", reply_ig_id: String(mine.id), replied_at: text(mine.timestamp) || new Date().toISOString(), attempted_at: null, error: null });
    return 0;
  }
  await data().updateCreatorComment(system(), comment.id, comment.revision,
    { decision: "skip", status: "skipped", reason: "already answered on Instagram", attempted_at: null });
  return 1;
}

export type DraftOptions = { call?: typeof callStructured; provider?: LlmProvider; limit?: number; now?: Date; random?: () => number };
export type DraftSweep = { decided: number; drafted: number; flagged: number; skipped: number; waiting: number; note: string | null };

/** The canned reply of fixture mode: warm, short, passes every rule. */
export function cannedReply(comment: string): string {
  return /\?/.test(comment) ? "haha thank you, more of this soon 🤍" : "thank you so much 🤍";
}

/** Decides every pending comment of the account; drafts at most `limit` with the model. */
export async function decideComments(account: CreatorAccount, opts: DraftOptions = {}): Promise<DraftSweep> {
  const now = opts.now ?? new Date();
  const sweep: DraftSweep = { decided: 0, drafted: 0, flagged: 0, skipped: 0, waiting: 0, note: null };
  const pending = (await data().listCreatorComments(system(), { account_id: account.id, status: ["new"] }))
    .filter(c => c.decision === "pending").sort((a, b) => a.commented_at.localeCompare(b.commented_at));
  let budget = opts.limit ?? DRAFTS_PER_SWEEP;
  const provider = opts.provider ?? adsTextProvider();
  const demo = demoReplayActive() && !opts.call;
  const modelReady = demo || !!opts.call || isLlmAvailable(provider);
  const due = (c: CreatorComment) => replyDueAt(c.commented_at, now, account.settings.reply_delay_min, account.settings.reply_delay_max, opts.random);
  for (const comment of pending) {
    const rule = preFilter({ text: comment.text, username: comment.username, own_username: account.handle, parent_ig_id: comment.parent_ig_id,
      commented_at: comment.commented_at, now, window_days: account.settings.reply_window_days, seed: comment.ig_comment_id });
    if (rule.decision === "skip" || rule.decision === "flag") {
      await data().updateCreatorComment(system(), comment.id, comment.revision,
        { decision: rule.decision, reason: rule.reason, status: rule.decision === "skip" ? "skipped" : "new" });
      sweep.decided += 1;
      if (rule.decision === "skip") sweep.skipped += 1; else sweep.flagged += 1;
      continue;
    }
    if (rule.decision === "reply") {
      await data().updateCreatorComment(system(), comment.id, comment.revision,
        { decision: "reply", reason: rule.reason, reply_text: rule.reply_text ?? null, reply_due_at: due(comment), status: "drafted" });
      sweep.decided += 1; sweep.drafted += 1;
      continue;
    }
    if (!modelReady) { sweep.waiting += 1; sweep.note = `No ${provider} key on this server: ordinary comments wait for a person.`; continue; }
    if (budget <= 0) { sweep.waiting += 1; continue; }
    budget -= 1;
    let answer: ReplyDraftOutput;
    try {
      answer = demo ? { decision: "reply", reason: "demo reply", reply: cannedReply(comment.text) } : await draftWithModel(account, comment, provider, opts.call);
    } catch (e) {
      if (e instanceof LlmUnavailableError) { sweep.waiting += 1; sweep.note = e.message; continue; }
      sweep.waiting += 1; sweep.note = `A reply draft failed: ${(e as Error).message.slice(0, 200)}`;
      continue;
    }
    const problem = answer.decision === "reply" ? replyProblem(answer.reply ?? "") : null;
    if (answer.decision === "reply" && !problem) {
      await data().updateCreatorComment(system(), comment.id, comment.revision,
        { decision: "reply", reason: answer.reason.slice(0, 200), reply_text: (answer.reply as string).trim(), reply_due_at: due(comment), status: "drafted" });
      sweep.drafted += 1;
    } else if (answer.decision === "skip") {
      await data().updateCreatorComment(system(), comment.id, comment.revision, { decision: "skip", reason: answer.reason.slice(0, 200), status: "skipped" });
      sweep.skipped += 1;
    } else {
      await data().updateCreatorComment(system(), comment.id, comment.revision, {
        decision: "flag", status: "new", reply_text: answer.reply?.trim() || null,
        reason: (problem ? `the draft broke a rule: ${problem}` : answer.reason).slice(0, 200),
      });
      sweep.flagged += 1;
    }
    sweep.decided += 1;
  }
  return sweep;
}

async function draftWithModel(account: CreatorAccount, comment: CreatorComment, provider: LlmProvider, call?: typeof callStructured): Promise<ReplyDraftOutput> {
  const post = comment.post_id ? await data().getCreatorPost(system(), comment.post_id).catch(() => null) : null;
  const recent = (await data().listCreatorComments(system(), { account_id: account.id, status: ["sent"] }))
    .filter(c => c.reply_text).slice(0, 8).map(c => c.reply_text as string);
  const built = buildReplyDraft({ name: account.display_name, handle: account.handle, persona: account.persona,
    caption: post?.caption ?? "", username: comment.username, comment: comment.text, recent });
  const model = modelFor(provider, "fast");
  const invoke = call ?? callStructured;
  const r = await runJob<ReplyDraftOutput>(system(), {
    kind: REPLY_JOB_KIND, title_id: null, target_type: "creator_comment", target_id: comment.id,
    idempotency_key: `creator_reply:${CREATOR_REPLY_PROMPT_VERSION}:${comment.id}`,
    provider, model,
    input: { account: account.external_id, comment: comment.ig_comment_id, prompt_version: CREATOR_REPLY_PROMPT_VERSION },
    run: async () => {
      const res = await invoke({ ...built, provider, model });
      return { output: res.data, usage: res.usage, cost_cents: res.cost_cents, model: res.model, provider: res.provider };
    },
  });
  const valid = ReplyDraftSchema.safeParse(r.output);
  if (!valid.success) throw new Error("the reply draft does not validate");
  return valid.data;
}

/** Sends one reply, or settles one sent before. Returns the row as it now stands. */
async function deliver(account: CreatorAccount, comment: CreatorComment, actor?: Session): Promise<CreatorComment> {
  if (comment.reply_ig_id) return comment;
  const transport = creatorTransport(account);
  if (comment.attempted_at) {
    // Sent before, answer lost: read the thread, never send blindly a second time.
    const replies = (await transport.get(`${comment.ig_comment_id}/replies`, { fields: "id,text,timestamp,username,from" })).data as MetaObject[] | undefined;
    const mine = (replies ?? []).find(r => isOwn(account, r) && text(r.text).trim() === (comment.reply_text ?? "").trim());
    if (mine) return data().updateCreatorComment(system(), comment.id, comment.revision,
      { status: "sent", reply_ig_id: String(mine.id), replied_at: text(mine.timestamp) || new Date().toISOString(), attempted_at: null, error: null }, { actor });
    return data().updateCreatorComment(system(), comment.id, comment.revision,
      { status: "failed", error: "Studio may have sent this reply but cannot see it under the comment yet. Check on Instagram before sending again." }, { actor });
  }
  const problem = replyProblem(comment.reply_text ?? "");
  if (problem) return data().updateCreatorComment(system(), comment.id, comment.revision, { decision: "flag", status: "new", reason: `the draft broke a rule: ${problem}` }, { actor });
  let row = await data().updateCreatorComment(system(), comment.id, comment.revision, { attempted_at: new Date().toISOString(), error: null });
  try {
    const response = await transport.post(`${comment.ig_comment_id}/replies`, { message: (row.reply_text as string).trim() });
    const id = typeof response.id === "string" ? response.id : "";
    if (!id) throw new MetaApiError("Instagram returned no reply id.", undefined, true);
    row = await data().updateCreatorComment(system(), row.id, row.revision,
      { status: "sent", reply_ig_id: id, replied_at: new Date().toISOString(), attempted_at: null, error: null }, { actor });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Instagram refused the reply.").slice(0, 500);
    const ambiguous = error instanceof MetaApiError && error.ambiguous;
    // A definite refusal sent nothing: clear the attempt. A transient one waits for the next sweep; a permanent one fails.
    row = await data().updateCreatorComment(system(), row.id, row.revision, ambiguous
      ? { error: message }
      : isTransient(error) ? { attempted_at: null, error: message } : { attempted_at: null, status: "failed", error: message }, { actor });
  }
  return row;
}

export type SendSweep = { sent: number; failed: number; held: string | null };

/** Sends the drafted replies that are due, within the hourly ceiling. Only with auto-reply on and the account active. */
export async function sendDueReplies(account: CreatorAccount, now = new Date()): Promise<SendSweep> {
  const sweep: SendSweep = { sent: 0, failed: 0, held: null };
  if (account.status !== "active") { sweep.held = "account paused"; return sweep; }
  if (!account.settings.auto_reply) { sweep.held = "auto-reply off"; return sweep; }
  const rows = await data().listCreatorComments(system(), { account_id: account.id });
  const hourAgo = now.getTime() - 3_600_000;
  let room = account.settings.max_replies_per_hour - rows.filter(c => c.replied_at && Date.parse(c.replied_at) > hourAgo).length;
  const due = rows.filter(c => c.status === "drafted" && c.decision === "reply" && c.reply_due_at && Date.parse(c.reply_due_at) <= now.getTime())
    .sort((a, b) => (a.reply_due_at as string).localeCompare(b.reply_due_at as string));
  for (const comment of due) {
    if (room <= 0) { sweep.held = `${account.settings.max_replies_per_hour} replies an hour reached`; break; }
    const after = await deliver(account, comment);
    if (after.status === "sent") { sweep.sent += 1; room -= 1; }
    else if (after.status === "failed") sweep.failed += 1;
  }
  return sweep;
}

// ---- a person's actions (Comments tab, MCP) ----------------------------------------

function assertAdmin(session: Session) {
  if (session.kind !== "staff") throw forbidden("Staff only.");
  if (session.staffRole !== "admin") throw forbidden("A staff administrator sends and edits replies.");
}

export type CommentAction =
  | { action: "send"; reply_text?: string | null }
  | { action: "edit"; reply_text: string }
  | { action: "skip" };

/**
 * Send now (optionally with the person's own words), edit the draft, or skip.
 * Revision-checked. A flagged comment is not answered through Studio, and a
 * comment answered once is never answered again.
 */
export async function actOnComment(session: Session, id: string, revision: number, act: CommentAction, now = new Date()): Promise<CreatorComment> {
  assertAdmin(session);
  const comment = await data().getCreatorComment(session, id);
  if (comment.revision !== revision) throw conflict("This comment changed. Reload and try again.");
  if (comment.status === "sent" || comment.reply_ig_id) throw conflict("This comment was already answered.");
  const account = await data().getCreatorAccount(session, comment.account_id);
  if (act.action === "skip") {
    return data().updateCreatorComment(system(), comment.id, comment.revision,
      { decision: "skip", status: "skipped", reason: `skipped by ${session.displayName}`.slice(0, 200), attempted_at: comment.attempted_at }, { actor: session, action: "creator_comment_skipped" });
  }
  if (comment.decision === "flag") throw forbidden("Flagged comments are not answered through Studio. Reply in the Instagram app if at all.");
  if (comment.parent_ig_id) throw invalid("Studio answers top-level comments only.");
  const words = (act.reply_text ?? comment.reply_text ?? "").trim();
  const problem = replyProblem(words);
  if (problem) throw invalid(`This reply cannot be sent: ${problem}.`);
  if (act.action === "edit") {
    return data().updateCreatorComment(system(), comment.id, comment.revision, {
      decision: "reply", status: "drafted", reply_text: words, error: null, reason: comment.reason ?? "edited by a person",
      reply_due_at: comment.reply_due_at ?? replyDueAt(comment.commented_at, now, account.settings.reply_delay_min, account.settings.reply_delay_max),
    }, { actor: session, action: "creator_comment_edited" });
  }
  if (comment.attempted_at && comment.status === "failed") {
    // The person looked on Instagram and asks again: read the thread first, all the same.
    const settled = await deliver(account, { ...comment, status: "drafted" }, session);
    if (settled.status === "sent") return settled;
    throw conflict("Studio cannot tell whether its earlier reply went out. Check on Instagram, then Skip, or answer in the app.");
  }
  const ready = await data().updateCreatorComment(system(), comment.id, comment.revision,
    { decision: "reply", status: "drafted", reply_text: words, reply_due_at: now.toISOString(), error: null });
  const sent = await deliver(account, ready, session);
  if (sent.status !== "sent") throw invalid(sent.error ?? "Instagram did not take the reply.");
  return sent;
}

/** "Check comments now": read and decide for one account (no replies are sent here). */
export async function syncCommentsNow(session: Session, accountRef: string, opts: DraftOptions = {}): Promise<{ read: CommentSweep; decided: DraftSweep }> {
  assertAdmin(session);
  const account = await data().getCreatorAccount(session, accountRef);
  const read = await pollComments(account);
  const decided = await decideComments(account, opts);
  return { read, decided };
}
