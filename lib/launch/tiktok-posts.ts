// The TikTok reads the Launch and Monitor screens make for their content
// (decision 2026-09-25, "TikTok ads from Studio clips"):
//
//   a Spark code's post   its cover, caption and account, so each pasted
//                         code shows a picture and the person can match it
//                         to its title (kept 10 minutes; the code is not used)
//
//   the account's posts   the TikTok account Business Center links to the
//                         chosen ad account, and its newest posts, for the
//                         content picker's "From @account" tab (cached 60 s)
//   an ad's preview       TikTok's own preview of one launched ad, so a person
//                         can watch the ad that exists, whatever it was made
//                         from; the link lasts 30 days and is kept 20
//
// Scoped like every launch read: a producer session reaches its own company's
// accounts and launches only, staff any company's; a foreign one is not found.

import type { Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { invalid, notFound } from "@/lib/data/errors";
import { accessTokenFor, tiktokTransport } from "@/lib/tiktok";
import { createAdPreviewLink, linkedAccountHandle, linkedAccountMissing, listLinkedAccounts, listLinkedPosts, pickLinkedAccount, sparkCodePreview, type SparkCodePreview } from "@/lib/tiktok/linked-account";
import type { TikTokAccountPostList } from "./clip-posts";

const POSTS_CACHE_MS = 60_000;
const PREVIEW_CACHE_MS = 20 * 86_400_000;
const cache = globalThis as unknown as {
  __studioTikTokPosts?: Map<string, { at: number; value: TikTokAccountPostList }>;
  __studioTikTokPreviews?: Map<string, { at: number; link: string }>;
};
const postCache = () => (cache.__studioTikTokPosts ??= new Map());
const previewCache = () => (cache.__studioTikTokPreviews ??= new Map());
const reason = (e: unknown) => (e instanceof Error ? e.message : "TikTok did not answer");

/** The linked account of one of the company's TikTok ad accounts, and its newest posts. Reads only. */
export async function listTikTokAccountPosts(session: Session, producerId: string, connectionId: string): Promise<TikTokAccountPostList> {
  const connection = (await getData().getLaunchConnections(session, producerId, "tiktok", false)).find((c) => c.id === connectionId && c.enabled);
  if (!connection) throw notFound("Advertising account");
  const tt = tiktokTransport();
  const key = `${tt.mode}:${connection.advertiser_id}`;
  const cached = postCache().get(key);
  if (cached && Date.now() - cached.at < POSTS_CACHE_MS) return cached.value;
  const empty = (note: string): TikTokAccountPostList => ({ account: null, posts: [], more: false, notes: [note] });
  const token = accessTokenFor(connection.advertiser_id);
  if (!token) return empty(`No TikTok connection covers ad account ${connection.name}. Reconnect TikTok on the TikTok page.`);
  let value: TikTokAccountPostList;
  try {
    const linked = await listLinkedAccounts(tt, token, connection.advertiser_id);
    // The account clips would run as when one allows both; else the one whose posts may be used.
    const account = pickLinkedAccount(linked, ["push", "pull"]) ?? pickLinkedAccount(linked, ["pull"]);
    if (!account) return empty(linkedAccountMissing(["pull"], connection.name));
    const described = { name: account.name, handle: linkedAccountHandle(account), ads_only: account.ads_only, can_push: account.can_push, can_pull: account.can_pull };
    try {
      const { posts, more } = await listLinkedPosts(tt, token, connection.advertiser_id, account);
      value = { account: described, posts: posts.map(({ item_id, text, cover_url, duration_s, status }) => ({ item_id, text, cover_url, duration_s, status })), more, notes: [] };
    } catch (e) { value = { account: described, posts: [], more: false, notes: [reason(e)] }; }
  } catch (e) { return empty(reason(e)); }
  postCache().set(key, { at: Date.now(), value });
  return value;
}

/**
 * TikTok's preview link for one ad of a launch this session may read. The ad
 * must be one the launch's own record created; anything else is not found.
 */
export async function tiktokAdPreviewLink(session: Session, runId: string, adId: string): Promise<string> {
  if (!/^\d{1,30}$/.test(adId)) throw notFound("Ad");
  const run = await getData().getLaunchRun(session, runId);
  if (run.draft.provider !== "tiktok") throw notFound("Ad");
  const campaign = run.campaigns.find((c) => ((c.state.groups ?? []) as { ads?: Record<string, string> }[]).some((g) => Object.values(g.ads ?? {}).includes(adId)));
  if (!campaign) throw notFound("Ad");
  const tt = tiktokTransport();
  if ((run.mode === "fake") !== (tt.mode === "fake")) throw invalid("This launch was made in another TikTok environment, so TikTok cannot show its ads from here.");
  const key = `${tt.mode}:${campaign.advertiser_id}:${adId}`;
  const cached = previewCache().get(key);
  if (cached && Date.now() - cached.at < PREVIEW_CACHE_MS) return cached.link;
  const token = accessTokenFor(campaign.advertiser_id);
  if (!token) throw invalid("No TikTok connection covers this ad account. Reconnect TikTok on the TikTok page.");
  const link = await createAdPreviewLink(tt, token, campaign.advertiser_id, adId).catch((e: unknown) => { throw invalid(reason(e)); });
  previewCache().set(key, { at: Date.now(), link });
  return link;
}

const SPARK_CACHE_MS = 10 * 60_000;
const sparkCache = () => ((cache as { __studioTikTokSparkPreviews?: Map<string, { at: number; value: SparkCodePreview }> }).__studioTikTokSparkPreviews ??= new Map());

/**
 * The post behind each pasted Spark code (its cover, caption and account),
 * read through one of the company's TikTok ad accounts, so step 3 can show a
 * picture beside every code and the person knows which title it belongs to.
 * Reads only: no code is authorized by it. At most 50 codes per call.
 */
export async function sparkCodePreviews(session: Session, producerId: string, connectionId: string, codes: readonly string[]): Promise<Record<string, SparkCodePreview>> {
  const connection = (await getData().getLaunchConnections(session, producerId, "tiktok", false)).find((c) => c.id === connectionId && c.enabled);
  if (!connection) throw notFound("Advertising account");
  const tt = tiktokTransport();
  const token = accessTokenFor(connection.advertiser_id);
  if (!token) throw invalid(`No TikTok connection covers ad account ${connection.name}. Reconnect TikTok on the TikTok page.`);
  const out: Record<string, SparkCodePreview> = {};
  for (const code of [...new Set(codes.map((c) => c.trim()).filter(Boolean))].slice(0, 50)) {
    const key = `${tt.mode}:${connection.advertiser_id}:${code}`;
    const hit = sparkCache().get(key);
    if (hit && Date.now() - hit.at < SPARK_CACHE_MS) { out[code] = hit.value; continue; }
    try {
      const value = await sparkCodePreview(tt, token, connection.advertiser_id, code);
      out[code] = value;
      // A refusal is remembered only briefly: a code fixed on TikTok's side reads again soon.
      sparkCache().set(key, { at: value.error ? Date.now() - SPARK_CACHE_MS + 30_000 : Date.now(), value });
    } catch (e) { out[code] = { cover_url: null, text: "", account: null, error: reason(e) }; }
  }
  return out;
}

/** Tests start from empty caches. */
export function resetTikTokPostCaches(): void { postCache().clear(); previewCache().clear(); sparkCache().clear(); }
