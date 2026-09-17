// Organic clip posting on Meta (docs/meta-organic-plan.md §3).
//
// The promote.clip_posts row is the source of truth for "posted"; nothing is
// inferred from Meta on the fly. The row's `step` is persisted before every
// external call, exactly like a launch run's campaign checkpoints, so a crash
// between a create and its persistence is closed on resume by the stored id —
// never by a second upload, container or publish.
//
// Gates that do not move: fixture mode always uses lib/meta/fake.ts; a live
// POST still needs META_LIVE_WRITES=enabled in the transport; a clip must be
// rendered with a stored SHA-256, and that hash is re-verified on the exact
// bytes Studio uploads. The Page access token is derived per call by
// transport.forPage() and never stored, logged, returned or put in an error.

import { createHash, randomUUID } from "node:crypto";
import { systemSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { DataError, notFound } from "@/lib/data/errors";
import { assertMayPublishClip } from "@/lib/data/launch";
import { MAX_CLIP_BYTES, readClipBytes, signedClipUrl } from "@/lib/launch/clip-bytes";
import type { ClipLibraryRow, ClipPost, MetaPagePost, MetaPagePostList, PublishClipInput } from "@/lib/launch/clip-posts";
import type { ClipPostPatch, LaunchConnection } from "@/lib/launch/types";
import { metaTransport } from "./index";
import { MetaApiError, type MetaObject, type MetaTransport } from "./transport";

/** Overridable so tests do not wait out a real Meta poll. */
export const publishTiming = {
  facebookPostPollMs: 10_000, facebookPostPolls: 5,
  instagramPollMs: 5_000, instagramRunMs: 5 * 60_000,
  staleAfterMs: 10 * 60_000, leaseMs: 10 * 60_000,
};

// Meta's "come back later" codes: unknown, service, application/user rate
// limits, Page rate limit and temporary posting limits. Anything else is a
// refusal we must show the poster instead of retrying forever.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613]);
const PAGE_POST_MISSING = "Facebook accepted the video but has not created the post yet. Retry in a minute.";

/**
 * A refusal no retry can fix. It is a DataError so that the same message is a
 * 400 with a sanitized body when a person hits it through a route, instead of
 * a logged 500 from the shared handler.
 */
class PermanentPublishError extends DataError {
  constructor(message: string) { super("invalid", message); }
}
const permanent = (message: string) => new PermanentPublishError(message);

function isTransient(error: unknown): boolean {
  if (error instanceof PermanentPublishError) return false;
  if (error instanceof MetaApiError) {
    if (error.ambiguous) return true;
    if (error.code !== undefined && TRANSIENT_CODES.has(error.code)) return true;
    return /HTTP 5\d\d/.test(error.message) || /verifiable response/.test(error.message);
  }
  // A DataError (a lost CAS race, a vanished clip) is not a Meta condition.
  return false;
}
/** Never a token, a URL or a response body: MetaApiError is already sanitized. */
function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : "Meta publishing failed.";
  return text.slice(0, 500);
}

// Rows this process is working on now, and rows it left `publishing` after a
// transient refusal. The scheduler resumes the second group at once and any
// other stale row by its `updated_at`, which is how a dead process is adopted.
const inFlight = new Set<string>();
const resumable = new Set<string>();

const system = systemSession;
const data = () => getData();

function label(clip: ClipLibraryRow): string {
  return `${clip.title_name} · ${clip.label}`.slice(0, 200);
}
/**
 * The uploaded video's title. It carries the post row's id because Meta stores
 * a video title verbatim, which makes the read-back after a dropped upload
 * response identify exactly one row's own upload and nobody else's.
 */
export function facebookVideoTitle(clip: ClipLibraryRow, postId: string): string {
  return `${label(clip).slice(0, 140)} · studio:${postId}`;
}
/**
 * Hook on the first line, title (and episode) on the second
 * (docs/meta-organic-plan.md §0). A clip with no hook falls back to the title
 * alone: `clip.label` can be the internal `clip_…` reference, which must never
 * become the caption of a public post.
 */
export function defaultCaption(clip: ClipLibraryRow): string {
  const hook = clip.label && clip.label !== clip.external_id ? clip.label : "";
  const title = clip.episode_label ? `${clip.title_name} · Episode ${clip.episode_label}` : clip.title_name;
  return [hook, title].filter(Boolean).join("\n").trim();
}

async function connectionFor(session: Session, producerId: string, connectionId: string): Promise<LaunchConnection> {
  const connection = (await data().getLaunchConnections(session, producerId, "meta")).find(c => c.id === connectionId);
  if (!connection) throw notFound("Meta account");
  if (!connection.enabled || !connection.page_id) throw permanent("This Meta account no longer has an assigned Facebook Page.");
  return connection;
}

/**
 * Every Meta object any post row already holds. An adoption candidate that
 * appears here belongs to another post — two ad accounts can share one Page,
 * and two clips can share a caption, so a read-back match is never proof of
 * ownership on its own.
 */
async function claimedElsewhere(exceptPostId: string): Promise<Set<string>> {
  const rows = await data().listClipPosts(system());
  const claimed = new Set<string>();
  for (const row of rows) {
    if (row.id === exceptPostId) continue;
    if (row.external_video_id) claimed.add(row.external_video_id);
    if (row.external_post_id) claimed.add(row.external_post_id);
  }
  return claimed;
}

async function clipFor(session: Session, producerId: string, clipId: string): Promise<ClipLibraryRow> {
  const clip = (await data().listClipLibrary(session, { producer_id: producerId })).find(row => row.id === clipId);
  if (!clip?.file_path) throw permanent("This finished clip is no longer available. Render it again.");
  return clip;
}

/**
 * Creates the row (status `publishing`) and returns it at once; the work runs
 * detached, the same way queueLaunch starts executeLaunch. The screen polls
 * GET …/clips/posts/[id].
 */
export async function publishClip(session: Session, input: PublishClipInput): Promise<ClipPost> {
  const clip = (await data().listClipLibrary(session, {})).find(row => row.id === input.clip_id);
  if (!clip) throw notFound("Clip");
  const post = await data().createClipPost(session, {
    ...input,
    caption: (input.caption ?? defaultCaption(clip)).trim(),
    sha256: clip.sha256 ?? "",
  });
  queueClipPost(post.id);
  return post;
}

const pending = new Map<string, Promise<unknown>>();
/** Durable state is saved before starting; the scheduler sweep recovers restarts. */
export function queueClipPost(id: string): void {
  const work = runClipPost(id).catch(error => console.error("[clip-post] worker", id, reason(error)));
  pending.set(id, work);
  void work.finally(() => { if (pending.get(id) === work) pending.delete(id); });
}
/** Awaits the detached publish this process started for a row, if one is still running. */
export async function clipPostSettled(id: string): Promise<void> { await pending.get(id); }

/**
 * Re-arms a failed row and resumes from its stored step — the stored ids make
 * that safe. Publishing public content is approver (or staff administrator)
 * work, exactly as creating the row was.
 */
export async function retryClipPost(session: Session, id: string): Promise<ClipPost> {
  const existing = await data().getClipPost(session, id);
  assertMayPublishClip(session, existing.producer_id);
  if (existing.status === "published") return existing;
  if (existing.status === "publishing") { queueClipPost(existing.id); return existing; }
  // `attempted_at` survives on purpose: it is what lets the resumed row adopt
  // the object its interrupted attempt may already have created.
  const post = await data().updateClipPost(system(), existing.id, existing.revision,
    { status: "publishing", error: null, lease_owner: null, leased_until: null }, { action: "clip_post_retried", actor: session });
  queueClipPost(post.id);
  return post;
}

// ---- the step machine --------------------------------------------------------

type Runner = { post: ClipPost; clip: ClipLibraryRow; connection: LaunchConnection; transport: MetaTransport; owner: string };

/** One durable write, extending this worker's lease with it. */
async function step(runner: Runner, patch: ClipPostPatch, action?: string): Promise<void> {
  runner.post = await data().updateClipPost(system(), runner.post.id, runner.post.revision,
    { leased_until: new Date(Date.now() + publishTiming.leaseMs).toISOString(), ...patch },
    action ? { action } : undefined);
}
/** Marks the current step as sent. Persisted before the call, cleared when the step advances. */
const markAttempt = (runner: Runner) => step(runner, { attempted_at: new Date().toISOString() });

const sleep = (ms: number) => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

/** The exact rendered bytes, re-hashed against the row before anything is sent. */
async function verifiedBytes(runner: Runner): Promise<Buffer> {
  const bytes = await readClipBytes(runner.clip.file_path!, MAX_CLIP_BYTES);
  if (createHash("sha256").update(bytes).digest("hex") !== runner.post.sha256) {
    throw permanent("This clip changed after it was rendered. Render it again before posting.");
  }
  return bytes;
}

/**
 * A video THIS row already uploaded but never recorded. Only ever consulted on
 * a row whose `attempted_at` says the upload was sent, matched on a title that
 * carries the row's own id, and refused when another post row already holds the
 * candidate. More than one match is reconciled by a person, never guessed.
 */
async function adoptPageVideo(runner: Runner, title: string): Promise<string | null> {
  const page = runner.connection.page_id!;
  const response = await runner.transport.get(`${page}/videos`, { fields: "id,title,description,created_time", limit: 25 });
  const rows = Array.isArray(response.data) ? response.data as MetaObject[] : [];
  const since = Date.parse(runner.post.created_at) - 60_000;
  const matches = rows.filter(row => String(row.title ?? "") === title && String(row.description ?? "") === runner.post.caption
    && (!row.created_time || Date.parse(String(row.created_time)) >= since));
  if (!matches.length) return null;
  if (matches.length > 1) throw permanent("Facebook shows more than one matching upload for this clip. Check the Page before retrying.");
  const claimed = await claimedElsewhere(runner.post.id);
  return claimed.has(String(matches[0].id)) ? null : String(matches[0].id);
}

async function runFacebook(runner: Runner): Promise<void> {
  const page = runner.connection.page_id!;
  const title = facebookVideoTitle(runner.clip, runner.post.id);
  if (runner.post.step === "uploading") {
    // Adoption only closes an upload this row already sent; a brand-new row
    // uploads its own video, even when the Page already shows a similar one.
    const adopted = runner.post.attempted_at ? await adoptPageVideo(runner, title) : null;
    let videoId = adopted ?? "";
    if (!videoId) {
      const bytes = await verifiedBytes(runner);
      if (!runner.post.attempted_at) await markAttempt(runner);
      videoId = String((await runner.transport.upload(`${page}/videos`, { description: runner.post.caption, title },
        { source: { bytes, filename: "studio-clip.mp4", contentType: "video/mp4" } })).id ?? "");
    }
    if (!videoId) throw new MetaApiError("Facebook returned no video id; read the Page back before retrying.", undefined, true);
    await step(runner, { external_video_id: videoId, step: "uploaded", attempted_at: null, error: null });
  }
  for (let attempt = 0; attempt < publishTiming.facebookPostPolls; attempt++) {
    const video = await runner.transport.get(runner.post.external_video_id!, { fields: "post_id,permalink_url" });
    const postId = typeof video.post_id === "string" ? video.post_id : "";
    if (postId) {
      // The id lands on the row before the invariant is consulted: Studio never
      // creates a public post it then cannot record.
      await step(runner, {
        external_post_id: postId, permalink: typeof video.permalink_url === "string" ? video.permalink_url : `https://www.facebook.com/${postId}`,
        step: "published", attempted_at: null, error: null,
      });
      await markPublished(runner);
      return;
    }
    if (attempt < publishTiming.facebookPostPolls - 1) await sleep(publishTiming.facebookPostPollMs);
  }
  throw permanent(PAGE_POST_MISSING);
}

/**
 * The last two writes of a successful publish: the row it replaces steps aside
 * (a "Post again" row), then this row becomes the published one. In that order,
 * so the one-published-post invariant can never refuse a post that exists.
 */
async function markPublished(runner: Runner): Promise<void> {
  const siblings = (await data().listClipPosts(system(), { clip_id: runner.post.clip_id }))
    .filter(row => row.id !== runner.post.id && row.status === "published" && !row.superseded_by
      && row.platform === runner.post.platform && row.connection_id === runner.post.connection_id);
  for (const previous of siblings) {
    await data().updateClipPost(system(), previous.id, previous.revision, { superseded_by: runner.post.id }, { action: "clip_post_superseded" });
  }
  await step(runner, { status: "published", published_at: new Date().toISOString(), error: null });
}

async function assertInstagramQuota(runner: Runner): Promise<void> {
  const instagram = runner.connection.instagram_id!;
  const response = await runner.transport.get(`${instagram}/content_publishing_limit`, { fields: "quota_usage,config" });
  const row = (Array.isArray(response.data) ? response.data[0] as MetaObject : undefined) ?? {};
  const used = Number(row.quota_usage ?? 0);
  const total = Number((row.config as MetaObject | undefined)?.quota_total ?? 0);
  if (Number.isFinite(used) && Number.isFinite(total) && total > 0 && used >= total) {
    throw permanent(`Instagram has used all ${total} of its posts for the last 24 hours. Try again later.`);
  }
}

/**
 * An Instagram media THIS row already published but never recorded. Instagram
 * has no title field, so a caption match alone proves nothing: this is only
 * consulted on a row whose `attempted_at` says media_publish was sent, and a
 * candidate another post row already holds is refused.
 */
async function adoptInstagramMedia(runner: Runner): Promise<{ id: string; permalink: string | null } | null> {
  const instagram = runner.connection.instagram_id!;
  const response = await runner.transport.get(`${instagram}/media`, { fields: "id,caption,permalink,timestamp", limit: 25 });
  const rows = Array.isArray(response.data) ? response.data as MetaObject[] : [];
  const since = Date.parse(runner.post.created_at) - 60_000;
  const matches = rows.filter(row => String(row.caption ?? "") === runner.post.caption
    && (!row.timestamp || Date.parse(String(row.timestamp)) >= since));
  if (!matches.length) return null;
  if (matches.length > 1) throw permanent("Instagram shows more than one matching Reel for this clip. Check the account before retrying.");
  const claimed = await claimedElsewhere(runner.post.id);
  if (claimed.has(String(matches[0].id))) return null;
  return { id: String(matches[0].id), permalink: typeof matches[0].permalink === "string" ? matches[0].permalink : null };
}

async function runInstagram(runner: Runner): Promise<void> {
  const instagram = runner.connection.instagram_id;
  if (!instagram) throw permanent("This Meta account no longer has an assigned Instagram account.");
  if (runner.post.step === "container") {
    await assertInstagramQuota(runner);
    // The hash is verified on the bytes Studio hands out, before any URL exists.
    await verifiedBytes(runner);
    const videoUrl = await signedClipUrl(runner.clip.file_path!, 900);
    // A container is not a post: an orphan from a dropped response expires on
    // its own and is never published, so this step re-sends rather than adopts.
    await markAttempt(runner);
    const container = await runner.transport.post(`${instagram}/media`, { media_type: "REELS", video_url: videoUrl, caption: runner.post.caption, share_to_feed: true });
    const containerId = typeof container.id === "string" ? container.id : "";
    if (!containerId) throw new MetaApiError("Instagram returned no container id; read the account back before retrying.", undefined, true);
    await step(runner, { external_video_id: containerId, step: "processing", attempted_at: null, error: null });
  }
  if (runner.post.step === "processing") {
    const deadline = Date.now() + publishTiming.instagramRunMs;
    for (;;) {
      const status = await runner.transport.get(runner.post.external_video_id!, { fields: "status_code,status" });
      const code = String(status.status_code ?? "");
      if (code === "FINISHED") break;
      if (code === "ERROR" || code === "EXPIRED") {
        throw permanent(`Instagram could not process this Reel: ${String(status.status ?? code)}`.slice(0, 500));
      }
      if (Date.now() + publishTiming.instagramPollMs > deadline) return; // resumed by the sweep
      await sleep(publishTiming.instagramPollMs);
    }
    await step(runner, { step: "publishing", attempted_at: null, error: null });
  }
  const adopted = runner.post.attempted_at ? await adoptInstagramMedia(runner) : null;
  let mediaId = adopted?.id ?? "";
  if (!mediaId) {
    if (!runner.post.attempted_at) await markAttempt(runner);
    mediaId = String((await runner.transport.post(`${instagram}/media_publish`, { creation_id: runner.post.external_video_id })).id ?? "");
  }
  if (!mediaId) throw new MetaApiError("Instagram returned no media id; read the account back before retrying.", undefined, true);
  // The id lands on the row before the invariant is consulted.
  await step(runner, { external_post_id: mediaId, step: "published", attempted_at: null, error: null });
  // A permalink read that fails is a note on a published post, never a failure.
  if (adopted?.permalink) await step(runner, { permalink: adopted.permalink });
  else {
    try {
      const media = await runner.transport.get(mediaId, { fields: "permalink" });
      if (typeof media.permalink === "string") await step(runner, { permalink: media.permalink });
    } catch { /* the post exists; its link can be read later */ }
  }
  await markPublished(runner);
}

/** The permalink is the only thing left to read once a post id exists. */
async function refreshPermalink(runner: Runner): Promise<void> {
  const id = runner.post.external_post_id!;
  const fields = runner.post.platform === "facebook" ? "permalink_url" : "permalink";
  try {
    const media = await runner.transport.get(id, { fields });
    const permalink = typeof media.permalink_url === "string" ? media.permalink_url : typeof media.permalink === "string" ? media.permalink : null;
    if (permalink && permalink !== runner.post.permalink) await step(runner, { permalink });
  } catch { /* nothing to correct */ }
  if (runner.post.status !== "published") {
    await step(runner, { step: "published", attempted_at: null });
    await markPublished(runner);
  }
}

/**
 * Does the work for one row. Safe to call again at any point: every step reads
 * the stored ids first. Returns the row as it now stands.
 */
export async function runClipPost(id: string): Promise<ClipPost | null> {
  if (inFlight.has(id)) return null;
  inFlight.add(id);
  resumable.delete(id);
  let runner: Runner | null = null;
  try {
    const existing = await data().getClipPost(system(), id);
    if (existing.status !== "publishing") return existing;
    // A live lease means another process owns this row; two workers must never
    // both upload, and the CAS below is the second line of that defence.
    if (existing.lease_owner && Date.parse(existing.leased_until ?? "") > Date.now()) return existing;
    const connection = await connectionFor(system(), existing.producer_id, existing.connection_id);
    const clip = await clipFor(system(), existing.producer_id, existing.clip_id);
    const owner = randomUUID();
    runner = { post: existing, clip, connection, transport: metaTransport().forPage(connection.page_id!), owner };
    try { await step(runner, { lease_owner: owner }); }
    catch { return existing; } // another worker claimed it first
    try {
      if (runner.post.external_post_id) await refreshPermalink(runner);
      else if (runner.post.platform === "facebook") await runFacebook(runner);
      else await runInstagram(runner);
    } catch (error) {
      if (isTransient(error)) {
        // Same status, same step: the sweep picks it up and resumes.
        resumable.add(id);
        try { await step(runner, { error: reason(error) }); } catch { /* the row is already newer */ }
        return runner.post;
      }
      // Never drop an id for a post that exists: the row keeps it and says so.
      const note = runner.post.external_post_id
        ? `This clip was posted (${runner.post.external_post_id}) but Studio could not finish recording it: ${reason(error)}`.slice(0, 500)
        : reason(error);
      try { await step(runner, { status: "failed", error: note }); } catch { /* the row is already newer */ }
      return runner.post;
    }
    return runner.post;
  } finally {
    // The lease is this process's, not the row's: hand it back either way.
    if (runner && runner.post.lease_owner === runner.owner) {
      try { await step(runner, { lease_owner: null, leased_until: null }); } catch { /* a newer writer owns it */ }
    }
    inFlight.delete(id);
  }
}

/**
 * Called from the TikTok scheduler tick. Adopts `publishing` rows nobody is
 * working on: never one under a live lease; at once when this process left one
 * behind after a transient refusal or when a worker died holding an expired
 * lease; otherwise once `updated_at` is older than ten minutes.
 */
export async function tickClipPosts(): Promise<void> {
  const rows = (await data().listClipPosts(system())).filter(p => p.status === "publishing");
  for (const row of rows) {
    if (inFlight.has(row.id)) continue;
    if (row.lease_owner && Date.parse(row.leased_until ?? "") > Date.now()) continue;
    const abandoned = !!row.lease_owner || resumable.has(row.id);
    if (!abandoned && Date.now() - Date.parse(row.updated_at) < publishTiming.staleAfterMs) continue;
    try { await runClipPost(row.id); }
    catch (error) { console.error("[clip-post] sweep", row.id, reason(error)); }
  }
}

// ---- the "From the Page" listing ---------------------------------------------

type CacheEntry = { at: number; value: MetaPagePostList };
const pagePostCache = new Map<string, CacheEntry>();
const PAGE_POST_CACHE_MS = 60_000;

function text(value: unknown, max = 300): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
function link(value: unknown): string | null {
  return typeof value === "string" && /^https:\/\//.test(value) ? value : null;
}

/**
 * The newest 25 Page posts and 25 Instagram media, read only, for the launch
 * popup's "From the Page" tab. Nothing here is written and no token is read,
 * returned or cached — only ids, captions, links and dates.
 */
export async function listMetaPagePosts(session: Session, producerId: string, connectionId: string): Promise<MetaPagePostList> {
  const connection = await connectionFor(session, producerId, connectionId);
  const key = `${connection.id}:${connection.page_id}:${connection.instagram_id ?? ""}`;
  const cached = pagePostCache.get(key);
  if (cached && Date.now() - cached.at < PAGE_POST_CACHE_MS) return cached.value;
  const transport = metaTransport().forPage(connection.page_id!);
  const rows = async (path: string, fields: string) => {
    const response = await transport.get(path, { fields, limit: 25 });
    return Array.isArray(response.data) ? (response.data as MetaObject[]).slice(0, 25) : [];
  };
  // A refusal here used to read as "no posts", which is indistinguishable from
  // an empty Page and hides a missing permission. Each side reports its own
  // reason instead, and one side failing never blanks the other.
  const notes: string[] = [];
  const side = async (name: string, path: string, fields: string) => {
    try { return await rows(path, fields); }
    catch (e) { notes.push(`${name}: ${reason(e)}`); return [] as MetaObject[]; }
  };
  const [facebookRows, instagramRows] = await Promise.all([
    side("Facebook", `${connection.page_id}/posts`, "id,message,created_time,permalink_url,full_picture"),
    connection.instagram_id
      ? side("Instagram", `${connection.instagram_id}/media`, "id,caption,media_type,permalink,thumbnail_url,timestamp")
      : Promise.resolve([] as MetaObject[]),
  ]);
  const value = {
    facebook: facebookRows.filter(row => typeof row.id === "string").map(row => ({
      platform: "facebook" as const, id: String(row.id), caption: text(row.message),
      permalink: link(row.permalink_url), thumbnail_url: link(row.full_picture), created_at: text(row.created_time, 40),
    })),
    instagram: instagramRows.filter(row => typeof row.id === "string").map(row => ({
      platform: "instagram" as const, id: String(row.id), caption: text(row.caption),
      permalink: link(row.permalink), thumbnail_url: link(row.thumbnail_url), created_at: text(row.timestamp, 40),
    })),
    notes,
  };
  pagePostCache.set(key, { at: Date.now(), value });
  return value;
}

/** Tests and the demo reset start from an empty cache. */
export function resetMetaPagePostCache(): void { pagePostCache.clear(); resumable.clear(); }
