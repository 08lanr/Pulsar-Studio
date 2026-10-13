// What a person (staff UI) or an agent (the MCP tools) may do to a creator
// account, in one place so both doors behave the same (decision 2026-10-12).
// Every write here is a staff administrator's; reads are any staff member's.
// Posts are validated by lib/creators/validate.ts with exactly the rules the
// publishing engine would apply, and every change is revision-checked (CAS).

import { systemSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { conflict, forbidden, invalid } from "@/lib/data/errors";
import { dayIn } from "./insights";
import { queueCreatorPost } from "./publish";
import { creatorHeadline, type CreatorHeadline } from "./stats";
import type { CreatorAccount, CreatorAccountPatch, CreatorMedia, CreatorPost, CreatorPostKind, CreatorPostSource } from "./types";
import { checkPost } from "./validate";

const data = () => getData();
const system = systemSession;

export function assertCreatorAdmin(session: Session): void {
  if (session.kind !== "staff") throw forbidden("Staff only.");
  if (session.staffRole !== "admin") throw forbidden("A staff administrator schedules, publishes and changes creator accounts.");
}

async function resolveMedia(session: Session, account: CreatorAccount, refs: string[]): Promise<CreatorMedia[]> {
  const library = await data().listCreatorMedia(session, account.id);
  return refs.map(ref => {
    const found = library.find(m => m.id === ref || m.external_id === ref);
    if (!found) throw invalid(`${ref} is not in @${account.handle}'s library.`);
    return found;
  });
}

export type ScheduleInput = {
  account: string;
  kind: CreatorPostKind;
  media_ids: string[];
  caption: string;
  /** ISO time; required for `schedule`. */
  scheduled_at?: string | null;
  when: "draft" | "schedule" | "now";
  source?: CreatorPostSource;
};
export type ScheduleResult = { post: CreatorPost; warnings: string[] };

/** A new post: a draft, scheduled for a time, or published now (in the background). */
export async function schedulePost(session: Session, input: ScheduleInput, now = new Date()): Promise<ScheduleResult> {
  assertCreatorAdmin(session);
  const account = await data().getCreatorAccount(session, input.account);
  const media = await resolveMedia(session, account, input.media_ids);
  const caption = input.caption.trim();
  const check = checkPost({ kind: input.kind, media, caption, scheduled_at: input.scheduled_at ?? null, when: input.when }, now);
  if (check.errors.length) throw invalid(check.errors.join(" "));
  if (input.when !== "draft" && account.status !== "active") throw conflict(`@${account.handle} is paused. Resume it on the Character tab first.`);
  const post = await data().createCreatorPost(session, {
    account_id: account.id, kind: input.kind, media_ids: media.map(m => m.id), caption,
    scheduled_at: input.when === "schedule" ? new Date(input.scheduled_at as string).toISOString() : input.when === "now" ? now.toISOString() : input.scheduled_at ?? null,
    status: input.when === "draft" ? "draft" : input.when === "schedule" ? "scheduled" : "publishing",
    source: input.source ?? "human",
  });
  if (post.status === "publishing") queueCreatorPost(post.id);
  return { post, warnings: check.warnings };
}

export type PostEdit = { kind?: CreatorPostKind; media_ids?: string[]; caption?: string; scheduled_at?: string | null; when?: "draft" | "schedule" };

/** Changes a draft, a scheduled or a failed post (never one publishing or published). */
export async function updatePost(session: Session, ref: string, revision: number, edit: PostEdit, now = new Date()): Promise<ScheduleResult> {
  assertCreatorAdmin(session);
  const post = await data().getCreatorPost(session, ref);
  if (post.revision !== revision) throw conflict("This post changed. Reload and try again.");
  if (!["draft", "scheduled", "failed"].includes(post.status)) throw conflict(`A ${post.status} post cannot be edited.`);
  if (post.status === "failed" && (post.containers.parent || Object.keys(post.containers.children ?? {}).length || post.attempted_at)) {
    throw conflict("Instagram already holds part of this post. Retry it, or cancel it and make a new one.");
  }
  const account = await data().getCreatorAccount(session, post.account_id);
  const kind = edit.kind ?? post.kind;
  const media = await resolveMedia(session, account, edit.media_ids ?? post.media_ids);
  const caption = (edit.caption ?? post.caption).trim();
  const when = edit.when ?? (post.status === "draft" ? "draft" : "schedule");
  const scheduledAt = edit.scheduled_at !== undefined ? edit.scheduled_at : post.scheduled_at;
  const check = checkPost({ kind, media, caption, scheduled_at: scheduledAt, when }, now);
  if (check.errors.length) throw invalid(check.errors.join(" "));
  const updated = await data().updateCreatorPost(session, post.id, post.revision, {
    kind, media_ids: media.map(m => m.id), caption, error: null,
    scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
    status: when === "draft" ? "draft" : "scheduled",
  }, { action: "creator_post_updated" });
  return { post: updated, warnings: check.warnings };
}

export async function cancelPost(session: Session, ref: string, revision: number): Promise<CreatorPost> {
  assertCreatorAdmin(session);
  const post = await data().getCreatorPost(session, ref);
  if (post.revision !== revision) throw conflict("This post changed. Reload and try again.");
  if (post.status === "publishing") throw conflict("This post is being published right now.");
  if (post.status === "published") throw conflict("This post is on Instagram; delete it there if it must go.");
  if (post.status === "cancelled") return post;
  return data().updateCreatorPost(session, post.id, post.revision, { status: "cancelled" });
}

/** Publish a draft or scheduled post now. */
export async function postNow(session: Session, ref: string, revision: number, now = new Date()): Promise<CreatorPost> {
  assertCreatorAdmin(session);
  const post = await data().getCreatorPost(session, ref);
  if (post.revision !== revision) throw conflict("This post changed. Reload and try again.");
  if (!["draft", "scheduled"].includes(post.status)) throw conflict(`A ${post.status} post cannot be posted now${post.status === "failed" ? "; use Retry" : ""}.`);
  const account = await data().getCreatorAccount(session, post.account_id);
  if (account.status !== "active") throw conflict(`@${account.handle} is paused.`);
  const check = checkPost({ kind: post.kind, media: await resolveMedia(session, account, post.media_ids), caption: post.caption, scheduled_at: null, when: "now" }, now);
  if (check.errors.length) throw invalid(check.errors.join(" "));
  const next = await data().updateCreatorPost(session, post.id, post.revision, { status: "publishing", scheduled_at: now.toISOString(), error: null }, { action: "creator_post_now" });
  queueCreatorPost(next.id);
  return next;
}

/**
 * Re-arms a failed post and resumes it from its stored containers. The person
 * looked at the account: an earlier media_publish whose answer was lost no
 * longer blocks a resend (Instagram publishes one container once).
 */
export async function retryPost(session: Session, ref: string): Promise<CreatorPost> {
  assertCreatorAdmin(session);
  const post = await data().getCreatorPost(session, ref);
  if (post.status === "published") return post;
  if (post.status === "publishing") { queueCreatorPost(post.id); return post; }
  if (post.status !== "failed") throw conflict(`A ${post.status} post has nothing to retry.`);
  const next = await data().updateCreatorPost(system(), post.id, post.revision,
    { status: "publishing", error: null, lease_owner: null, leased_until: null, attempted_at: null }, { action: "creator_post_retried", actor: session });
  queueCreatorPost(next.id);
  return next;
}

export async function updateAccountSettings(session: Session, ref: string, revision: number, patch: CreatorAccountPatch): Promise<CreatorAccount> {
  assertCreatorAdmin(session);
  const account = await data().getCreatorAccount(session, ref);
  return data().updateCreatorAccount(session, account.id, revision, patch);
}

export type AccountOverview = { account: CreatorAccount; headline: CreatorHeadline; today: string };

/** The account with its headline numbers (Stats tab, creator_get / creator_stats). */
export async function accountOverview(session: Session, ref: string, now = new Date()): Promise<AccountOverview> {
  const account = await data().getCreatorAccount(session, ref);
  const today = dayIn(account.settings.timezone, now);
  const [stats, posts, comments] = await Promise.all([
    data().listCreatorStats(session, account.id, { since: new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10) }),
    data().listCreatorPosts(session, { account_id: account.id }),
    data().listCreatorComments(session, { account_id: account.id }),
  ]);
  const headline = creatorHeadline(stats, posts, comments, today, iso => dayIn(account.settings.timezone, new Date(iso)));
  return { account, headline, today };
}
