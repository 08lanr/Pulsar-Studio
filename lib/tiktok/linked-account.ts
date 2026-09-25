// The TikTok account an ad account runs ads as, when Studio supplies the
// content itself (decision 2026-09-25, "TikTok ads from Studio clips").
//
// Business Center links a TikTok account (CrazyDramas' @crazydramaus) to the
// ad account; TikTok calls that identity BC_AUTH_TT. Through it Studio can:
//
//   a Studio clip   upload the clip to the ad account and run it as that
//                   account, shown only as an ad (TikTok's "Show through ads
//                   only", dark_post_status ON): it plays in the For You feed
//                   under the account's name and picture, never on the
//                   profile's grid, and has no organic views
//   one of its posts  run a post the account already made as an ad, with no
//                   Spark code to copy (the post stays on the profile)
//
// Nothing here writes anything that runs or spends: the listings are reads,
// and the ad preview link TikTok makes on request only shows an ad that exists.
// Every call goes through the transport the caller hands in (lib/tiktok/index).

import type { TikTokResponse, TikTokTransport } from "./transport";

export type LinkedAccount = {
  identity_id: string;
  /** The Business Center that links the account; TikTok wants it on every ad that uses the identity. */
  bc_id: string;
  name: string;
  /** The @handle without the @, when TikTok names it. */
  username: string | null;
  /** May Studio upload a video and run it as this account? */
  can_push: boolean;
  /** May an ad use this account's own posts? */
  can_pull: boolean;
  /** Business Center's "Only show as ads": every uploaded video stays off the profile. */
  ads_only: boolean;
};

/** What the content needs from the account: to upload clips (`push`) or to use its posts (`pull`). */
export type LinkedNeed = "push" | "pull";

/** What one campaign's content needs: `push` for a Studio clip, `pull` for one of the account's posts. */
export function linkedNeeds(content: readonly { kind: string }[]): LinkedNeed[] {
  return [...(content.some((item) => item.kind === "video") ? ["push" as const] : []), ...(content.some((item) => item.kind === "tiktok_post") ? ["pull" as const] : [])];
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const refused = (res: TikTokResponse, what: string) => new Error(`${what}: ${res.message || "TikTok did not answer"}`);

/** The TikTok accounts Business Center links to this ad account, available ones only. */
export async function listLinkedAccounts(tt: TikTokTransport, token: string, advertiserId: string): Promise<LinkedAccount[]> {
  const res = await tt.get("/identity/get/", token, { advertiser_id: advertiserId, identity_type: "BC_AUTH_TT" });
  if (res.code !== 0) throw refused(res, "Read the TikTok account linked to this ad account");
  return ((res.data?.identity_list ?? []) as Row[])
    .filter((row) => str(row.identity_id) && str(row.identity_authorized_bc_id) && (row.available_status === undefined || row.available_status === "AVAILABLE"))
    .map((row) => ({
      identity_id: str(row.identity_id), bc_id: str(row.identity_authorized_bc_id),
      name: str(row.display_name) || str(row.username) || str(row.identity_id),
      username: str(row.username).replace(/^@/, "") || null,
      can_push: row.can_push_video !== false, can_pull: row.can_pull_video !== false, ads_only: row.ads_only_mode === true,
    }));
}

/**
 * The one account a campaign runs as: the first, by identity id, that allows
 * everything its content needs. One rule for the preview and the driver, so
 * the account the approver was shown is the account the ads run as.
 */
export function pickLinkedAccount(accounts: readonly LinkedAccount[], needs: readonly LinkedNeed[]): LinkedAccount | null {
  return [...accounts].sort((a, b) => a.identity_id.localeCompare(b.identity_id))
    .find((a) => needs.every((need) => (need === "push" ? a.can_push : a.can_pull))) ?? null;
}

/** The sentence a launch without a usable linked account refuses with. */
export function linkedAccountMissing(needs: readonly LinkedNeed[], accountName: string): string {
  const what = needs.includes("push") && needs.includes("pull") ? "that ads can upload Studio clips to and whose posts ads may use"
    : needs.includes("push") ? "that ads can upload Studio clips to" : "whose posts ads may use";
  return `Ad account ${accountName} has no TikTok account linked in Business Center ${what}. In Business Center, link the TikTok account to this ad account with permission to run ads, then preview again.`;
}

/** "@crazydramaus", else the account's name. */
export const linkedAccountHandle = (account: Pick<LinkedAccount, "name" | "username">) => (account.username ? `@${account.username}` : account.name);

export type LinkedPost = {
  item_id: string;
  item_type: string;
  text: string;
  cover_url: string | null;
  duration_s: number | null;
  /** TikTok's word for the post's state, e.g. ITEM_STATUS_HESITATE_RECOMMEND. */
  status: string;
};

function postOf(row: Row): LinkedPost | null {
  const id = str(row.item_id);
  if (!id) return null;
  const video = (row.video_info ?? {}) as Row;
  const cover = str(video.poster_url);
  const duration = Number(video.duration);
  return { item_id: id, item_type: str(row.item_type) || "VIDEO", text: str(row.text).slice(0, 2200),
    cover_url: /^https:\/\//.test(cover) ? cover : null, duration_s: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : null,
    status: str(row.status) };
}

const identityParams = (advertiserId: string, account: LinkedAccount) => ({
  advertiser_id: advertiserId, identity_type: "BC_AUTH_TT", identity_id: account.identity_id, identity_authorized_bc_id: account.bc_id,
});

/** The account's newest posts, as many as `limit` (TikTok pages by cursor, 20 at a time). */
export async function listLinkedPosts(tt: TikTokTransport, token: string, advertiserId: string, account: LinkedAccount, limit = 40): Promise<{ posts: LinkedPost[]; more: boolean }> {
  const posts: LinkedPost[] = [];
  let cursor: string | null = null;
  let more = false;
  for (let page = 0; page < 10 && posts.length < limit; page++) {
    const res = await tt.get("/identity/video/get/", token, { ...identityParams(advertiserId, account), count: 20, ...(cursor ? { cursor } : {}) });
    if (res.code !== 0) throw refused(res, `Read the posts of ${linkedAccountHandle(account)}`);
    for (const row of (res.data?.video_list ?? []) as Row[]) { const post = postOf(row); if (post) posts.push(post); }
    more = res.data?.has_more === true;
    cursor = res.data?.cursor === undefined || res.data?.cursor === null ? null : String(res.data.cursor);
    if (!more || !cursor) break;
  }
  return { posts: posts.slice(0, limit), more: more || posts.length > limit };
}

/**
 * One post of the account, read by id. Null when TikTok says the account does
 * not hold it (deleted, private, or never this account's); any other refusal
 * throws, so a failed read is never taken for a missing post.
 */
export async function findLinkedPost(tt: TikTokTransport, token: string, advertiserId: string, account: LinkedAccount, itemId: string): Promise<LinkedPost | null> {
  const res = await tt.get("/identity/video/info/", token, { ...identityParams(advertiserId, account), item_id: itemId });
  if (res.code === 40000 && /valid item/i.test(res.message || "")) return null;
  if (res.code !== 0) throw refused(res, `Read post ${itemId} of ${linkedAccountHandle(account)}`);
  const detail = (res.data?.video_detail ?? res.data?.video_info ?? null) as Row | null;
  return detail ? postOf(detail) : null;
}

/** What a Spark code's post looks like, so a person can tell which show it is before launching. */
export type SparkCodePreview = { cover_url: string | null; text: string; account: string | null; error?: string };

/**
 * The post behind a Spark code (`/tt_video/info/`): its cover, caption and
 * account. A read: the code is not authorized or used up by it. A code
 * TikTok does not recognise comes back with TikTok's own words in `error`.
 */
export async function sparkCodePreview(tt: TikTokTransport, token: string, advertiserId: string, code: string): Promise<SparkCodePreview> {
  const res = await tt.get("/tt_video/info/", token, { advertiser_id: advertiserId, auth_code: code });
  if (res.code !== 0) return { cover_url: null, text: "", account: null, error: res.message || "TikTok did not recognise this code" };
  const video = (res.data?.video_info ?? {}) as Row;
  const carousel = ((res.data?.carousel_info as Row | undefined)?.image_info ?? []) as Row[];
  const cover = str(video.poster_url) || str(carousel[0]?.image_url);
  const user = (res.data?.user_info ?? {}) as Row;
  return { cover_url: /^https:\/\//.test(cover) ? cover : null, text: str((res.data?.item_info as Row | undefined)?.text).slice(0, 300),
    account: str(user.tiktok_name) || str(user.display_name) || null };
}

/**
 * A link to watch one ad as TikTok will show it (TikTok's ad preview tool,
 * valid for 30 days). Creates nothing that runs or spends.
 */
export async function createAdPreviewLink(tt: TikTokTransport, token: string, advertiserId: string, adId: string): Promise<string> {
  const res = await tt.post("/creative/ads_preview/create/", token, { advertiser_id: advertiserId, preview_type: "AD", ad_id: adId });
  const link = str(res.data?.preview_link);
  if (res.code !== 0 || !/^https:\/\//.test(link)) throw refused(res, "Make a TikTok preview of this ad");
  return link;
}

/** The post's own page on TikTok. An ads-only post opens there for the account's owner, signed in, and for nobody else. */
export function tiktokPostUrl(username: string | null, itemId: string): string | null {
  return username && /^\d+$/.test(itemId) ? `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${itemId}` : null;
}
