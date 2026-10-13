// Publishing a creator post to Instagram (decision 2026-10-12), modelled on
// lib/meta/publish.ts: the promote.creator_posts row is the only record of
// "posted"; its `step` and every container id are persisted before the next
// external call; a ten-minute row lease keeps two workers off one row; a retry
// resumes from the stored ids and never makes a second container for media
// that already has one, nor a second media_publish for a row that sent one.
//
//   image     POST /{ig}/media {image_url, caption} → status FINISHED → POST /{ig}/media_publish {creation_id} → GET permalink
//   carousel  one child per item {image_url | media_type VIDEO + video_url, is_carousel_item} → every child FINISHED
//             → parent {media_type CAROUSEL, children, caption} → FINISHED → publish
//   reel      {media_type REELS, video_url, caption, share_to_feed} → FINISHED → publish
//
// The media URLs are 15-minute signed storage URLs, minted only after the
// stored bytes were re-hashed against the row. The account's 24-hour
// publishing allowance (content_publishing_limit) is read before the first
// container. A transient refusal (Meta codes 1/2/4/17/32/613, 5xx, a lost
// response, the allowance used up) leaves the row `publishing` for the sweep;
// a permanent one fails it with Meta's sentence. A container Instagram ended in
// ERROR or EXPIRED is dead — never publishable — so the failed row forgets it
// and the person's Retry starts fresh containers; nothing else is ever re-sent.
//
// The transport is the publish token's (lib/meta/index.ts metaPublishTransport):
// an account with no Facebook Page (Chloe) is called as /{instagram_id}/...
// directly; one with a Page goes through forPage, as clip posting does.
// Fixture mode is the fake; a live POST still needs META_LIVE_WRITES=enabled.

import { randomUUID } from "node:crypto";
import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { DataError } from "@/lib/data/errors";
import { metaPublishTransport } from "@/lib/meta";
import { MetaApiError, type MetaObject, type MetaTransport } from "@/lib/meta/transport";
import { signedCreatorMediaUrl, verifiedMediaBytes } from "./media";
import type { CreatorAccount, CreatorMedia, CreatorPost, CreatorPostPatch } from "./types";

/** Overridable so tests do not wait out a real poll. */
export const creatorTiming = { pollMs: 5_000, runMs: 5 * 60_000, leaseMs: 10 * 60_000, staleAfterMs: 10 * 60_000 };

const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613]);

class PermanentError extends DataError { constructor(message: string) { super("invalid", message); } }
/** A container Instagram will never publish: the row forgets it so a Retry starts over. */
class DeadContainerError extends PermanentError {}
/** The 24-hour allowance is used up: wait, do not fail. */
class QuotaWait extends Error {}

export function isTransient(error: unknown): boolean {
  if (error instanceof QuotaWait) return true;
  if (error instanceof PermanentError) return false;
  if (error instanceof MetaApiError) {
    if (error.ambiguous) return true;
    if (error.code !== undefined && TRANSIENT_CODES.has(error.code)) return true;
    return /HTTP 5\d\d/.test(error.message) || /verifiable response/.test(error.message);
  }
  return false;
}
function reason(error: unknown): string {
  return (error instanceof Error ? error.message : "Instagram publishing failed.").slice(0, 500);
}

/** The publish token's transport for one account: its Page when it has one, the Instagram id directly when not. */
export function creatorTransport(account: Pick<CreatorAccount, "page_id">): MetaTransport {
  const transport = metaPublishTransport();
  return account.page_id ? transport.forPage(account.page_id) : transport;
}

const system = systemSession;
const data = () => getData();
const inFlight = new Set<string>();
const resumable = new Set<string>();
const pending = new Map<string, Promise<unknown>>();

/** Durable state is saved before starting; the sweep recovers a restart. */
export function queueCreatorPost(id: string): void {
  const work = runCreatorPost(id).catch(error => console.error("[creator-post] worker", id, reason(error)));
  pending.set(id, work);
  void work.finally(() => { if (pending.get(id) === work) pending.delete(id); });
}
/** Awaits the detached publish this process started for a row, if one is running. */
export async function creatorPostSettled(id: string): Promise<void> { await pending.get(id); }
/** Tests start clean. */
export function resetCreatorPublishState(): void { inFlight.clear(); resumable.clear(); pending.clear(); }

type Runner = { post: CreatorPost; account: CreatorAccount; media: CreatorMedia[]; transport: MetaTransport; owner: string };

async function step(runner: Runner, patch: CreatorPostPatch, action?: string): Promise<void> {
  runner.post = await data().updateCreatorPost(system(), runner.post.id, runner.post.revision,
    { leased_until: new Date(Date.now() + creatorTiming.leaseMs).toISOString(), ...patch }, action ? { action } : undefined);
}
const sleep = (ms: number) => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());

async function assertQuota(runner: Runner): Promise<void> {
  const response = await runner.transport.get(`${runner.account.instagram_id}/content_publishing_limit`, { fields: "quota_usage,config" });
  const row = (Array.isArray(response.data) ? (response.data[0] as MetaObject) : undefined) ?? {};
  const used = Number(row.quota_usage ?? 0), total = Number((row.config as MetaObject | undefined)?.quota_total ?? 0);
  if (Number.isFinite(used) && Number.isFinite(total) && total > 0 && used >= total) {
    throw new QuotaWait(`Instagram has used all ${total} of this account's posts for the last 24 hours; Studio tries again later.`);
  }
}

async function urlFor(media: CreatorMedia): Promise<string> {
  await verifiedMediaBytes(media); // the hash is checked on the stored bytes before any URL exists
  return signedCreatorMediaUrl(media, 900);
}

async function createContainer(runner: Runner, params: MetaObject): Promise<string> {
  const response = await runner.transport.post(`${runner.account.instagram_id}/media`, params);
  const id = typeof response.id === "string" ? response.id : "";
  if (!id) throw new MetaApiError("Instagram returned no container id.", undefined, true);
  return id;
}

/** FINISHED → true; still working → false; ERROR / EXPIRED → a dead container. */
async function containerFinished(runner: Runner, id: string): Promise<boolean> {
  const status = await runner.transport.get(id, { fields: "status_code,status" });
  const code = String(status.status_code ?? "");
  if (code === "FINISHED" || code === "PUBLISHED") return true;
  if (code === "ERROR" || code === "EXPIRED") throw new DeadContainerError(`Instagram could not process this post (${code}): ${String(status.status ?? code)}`.slice(0, 500));
  return false;
}

/** Waits for every id to finish within this run's budget; false when the sweep must come back. */
async function waitFinished(runner: Runner, ids: string[]): Promise<boolean> {
  const deadline = Date.now() + creatorTiming.runMs;
  const left = new Set(ids);
  for (;;) {
    for (const id of [...left]) if (await containerFinished(runner, id)) left.delete(id);
    if (!left.size) return true;
    if (Date.now() + creatorTiming.pollMs > deadline) return false;
    await sleep(creatorTiming.pollMs);
  }
}

async function claimedElsewhere(postId: string): Promise<Set<string>> {
  const rows = await data().listCreatorPosts(system());
  return new Set(rows.filter(r => r.id !== postId && r.ig_media_id).map(r => r.ig_media_id as string));
}

/**
 * A media THIS row already published but never recorded: only consulted on a
 * row whose `attempted_at` says media_publish was sent, matched on the exact
 * caption and a time after the attempt, never one another row holds. More than
 * one match is a person's to reconcile.
 */
async function adoptPublished(runner: Runner): Promise<{ id: string; permalink: string | null } | null> {
  const response = await runner.transport.get(`${runner.account.instagram_id}/media`, { fields: "id,caption,permalink,timestamp", limit: 25 });
  const rows = Array.isArray(response.data) ? (response.data as MetaObject[]) : [];
  const since = Date.parse(runner.post.attempted_at ?? runner.post.created_at) - 60_000;
  const matches = rows.filter(r => String(r.caption ?? "") === runner.post.caption && (!r.timestamp || Date.parse(String(r.timestamp)) >= since));
  if (!matches.length) return null;
  if (matches.length > 1) throw new PermanentError("Instagram shows more than one post matching this one. Check the account before retrying.");
  if ((await claimedElsewhere(runner.post.id)).has(String(matches[0].id))) return null;
  return { id: String(matches[0].id), permalink: typeof matches[0].permalink === "string" ? matches[0].permalink : null };
}

async function markPublished(runner: Runner, permalink: string | null): Promise<void> {
  if (permalink && permalink !== runner.post.permalink) await step(runner, { permalink });
  await step(runner, { status: "published", step: "published", published_at: new Date().toISOString(), error: null, attempted_at: null });
}

async function readPermalink(runner: Runner, id: string): Promise<string | null> {
  try {
    const media = await runner.transport.get(id, { fields: "permalink" });
    return typeof media.permalink === "string" ? media.permalink : null;
  } catch { return null; } // the post exists; its link can be read later
}

async function run(runner: Runner): Promise<void> {
  const ig = runner.account.instagram_id;
  const { post } = runner;
  if (post.step === "container") {
    const containers = { ...post.containers };
    if (!containers.parent && !Object.keys(containers.children ?? {}).length) await assertQuota(runner);
    if (post.kind === "carousel") {
      const children = { ...(containers.children ?? {}) };
      for (const media of runner.media) {
        if (children[media.id]) continue; // made by an earlier attempt: never a second one
        const url = await urlFor(media);
        children[media.id] = await createContainer(runner, media.kind === "image"
          ? { image_url: url, is_carousel_item: true }
          : { media_type: "VIDEO", video_url: url, is_carousel_item: true });
        await step(runner, { containers: { ...runner.post.containers, children: { ...children } } });
      }
      const ids = runner.media.map(m => children[m.id]);
      if (!(await waitFinished(runner, ids))) return; // resumed by the sweep
      if (!runner.post.containers.parent) {
        const parent = await createContainer(runner, { media_type: "CAROUSEL", children: ids.join(","), caption: runner.post.caption });
        await step(runner, { containers: { ...runner.post.containers, parent }, step: "processing", error: null });
      } else await step(runner, { step: "processing" });
    } else if (!containers.parent) {
      const media = runner.media[0];
      const url = await urlFor(media);
      const parent = await createContainer(runner, post.kind === "reel"
        ? { media_type: "REELS", video_url: url, caption: runner.post.caption, share_to_feed: true }
        : { image_url: url, caption: runner.post.caption });
      await step(runner, { containers: { ...runner.post.containers, parent }, step: "processing", error: null });
    } else await step(runner, { step: "processing" });
  }
  if (runner.post.step === "processing") {
    if (!(await waitFinished(runner, [runner.post.containers.parent as string]))) return;
    await step(runner, { step: "publishing", error: null });
  }
  if (runner.post.step === "publishing") {
    const adopted = runner.post.attempted_at ? await adoptPublished(runner) : null;
    let mediaId = adopted?.id ?? "";
    if (!mediaId) {
      if (runner.post.attempted_at) {
        // Sent before and nothing to adopt: Instagram's listing can lag, so this
        // is a person's call, never a blind second publish.
        // (A person's Retry clears `attempted_at`: they looked. Sending the same container again cannot
        // make a second post — Instagram publishes a container once.)
        throw new PermanentError("Studio sent this post to Instagram but cannot find it on the account yet. Check the account; Retry only if it is not there.");
      }
      await step(runner, { attempted_at: new Date().toISOString() });
      let response: MetaObject;
      try {
        response = await runner.transport.post(`${ig}/media_publish`, { creation_id: runner.post.containers.parent });
      } catch (error) {
        // A definite refusal (a code, an answer) published nothing: the next attempt may send again.
        // Only a lost answer keeps `attempted_at`, so the next attempt reads the account first.
        if (error instanceof MetaApiError && !error.ambiguous) await step(runner, { attempted_at: null });
        throw error;
      }
      mediaId = typeof response.id === "string" ? response.id : "";
      if (!mediaId) throw new MetaApiError("Instagram returned no media id; read the account back before retrying.", undefined, true);
    }
    // The id lands on the row before anything else can fail.
    await step(runner, { ig_media_id: mediaId, step: "published", error: null });
    await markPublished(runner, adopted?.permalink ?? (await readPermalink(runner, mediaId)));
  }
}

/**
 * Does the work for one row; safe to call again at any point. Returns the row
 * as it now stands, or null when this process is already working on it.
 */
export async function runCreatorPost(id: string): Promise<CreatorPost | null> {
  if (inFlight.has(id)) return null;
  inFlight.add(id);
  resumable.delete(id);
  let runner: Runner | null = null;
  try {
    const existing = await data().getCreatorPost(system(), id);
    if (existing.status !== "publishing") return existing;
    if (existing.lease_owner && Date.parse(existing.leased_until ?? "") > Date.now()) return existing;
    const account = await data().getCreatorAccount(system(), existing.account_id);
    const library = await data().listCreatorMedia(system(), account.id);
    const media = existing.media_ids.map(mid => library.find(m => m.id === mid));
    const owner = randomUUID();
    runner = { post: existing, account, media: media.filter((m): m is CreatorMedia => !!m), transport: creatorTransport(account), owner };
    try { await step(runner, { lease_owner: owner }); }
    catch { return existing; } // another worker claimed it first
    try {
      if (media.some(m => !m)) throw new PermanentError("Media in this post is no longer in the library.");
      if (runner.post.ig_media_id) await markPublished(runner, runner.post.permalink ?? (await readPermalink(runner, runner.post.ig_media_id)));
      else await run(runner);
    } catch (error) {
      if (isTransient(error)) {
        resumable.add(id);
        try { await step(runner, { error: reason(error) }); } catch { /* the row is already newer */ }
        return runner.post;
      }
      const note = runner.post.ig_media_id
        ? `This post is on Instagram (${runner.post.ig_media_id}) but Studio could not finish recording it: ${reason(error)}`.slice(0, 500)
        : reason(error);
      const forget: CreatorPostPatch = error instanceof DeadContainerError ? { containers: {}, step: "container" } : {};
      try { await step(runner, { status: "failed", error: note, ...forget }); } catch { /* the row is already newer */ }
      return runner.post;
    }
    return runner.post;
  } catch (error) {
    if (error instanceof DataError && error.code === "not_found") return null;
    throw error;
  } finally {
    if (runner && runner.post.lease_owner === runner.owner) {
      try { await step(runner, { lease_owner: null, leased_until: null }); } catch { /* a newer writer owns it */ }
    }
    inFlight.delete(id);
  }
}

export type PostSweep = { started: number; resumed: number; errors: string[] };

/**
 * The scheduler's step (lib/creators/sweeps.ts calls it behind the live
 * gates): starts the scheduled posts that are due on active accounts, then
 * adopts `publishing` rows nobody is working on — at once when this process
 * left one after a transient refusal or a worker died holding an expired lease,
 * otherwise once untouched for ten minutes. Never one under a live lease.
 */
export async function tickCreatorPosts(now = new Date()): Promise<PostSweep> {
  const sweep: PostSweep = { started: 0, resumed: 0, errors: [] };
  const rows = await data().listCreatorPosts(system(), { status: ["scheduled", "publishing"] });
  const accounts = new Map((await data().listCreatorAccounts(system())).map(a => [a.id, a]));
  for (const row of rows) {
    try {
      if (row.status === "scheduled") {
        if (!row.scheduled_at || Date.parse(row.scheduled_at) > now.getTime()) continue;
        if (accounts.get(row.account_id)?.status !== "active") continue;
        await data().updateCreatorPost(system(), row.id, row.revision, { status: "publishing", error: null }, { action: "creator_post_due" });
        await runCreatorPost(row.id);
        sweep.started += 1;
        continue;
      }
      if (inFlight.has(row.id)) continue;
      if (row.lease_owner && Date.parse(row.leased_until ?? "") > Date.now()) continue;
      const abandoned = !!row.lease_owner || resumable.has(row.id);
      if (!abandoned && Date.now() - Date.parse(row.updated_at) < creatorTiming.staleAfterMs) continue;
      await runCreatorPost(row.id);
      sweep.resumed += 1;
    } catch (error) {
      sweep.errors.push(`${row.external_id}: ${reason(error)}`);
    }
  }
  return sweep;
}
