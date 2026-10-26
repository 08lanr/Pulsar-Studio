import type { MetaInventory } from "@/lib/meta/discovery";
import type { LaunchConnection } from "./types";

/** The BC assignment, current BC authorization, and current account access must all agree. */
export function eligibleTikTokBcAccount(assignedBc: string, authorizedBcs: readonly string[], account: { id: string; bcId: string; status?: string }, hasToken: boolean): boolean {
  return authorizedBcs.includes(assignedBc) && account.bcId === assignedBc && account.status === "STATUS_ENABLE" && hasToken;
}

/** A stored assignment is usable only while all selected Meta identities remain accessible. */
export function eligibleMetaAssignment(saved: LaunchConnection, inventory: MetaInventory): boolean {
  const account = inventory.accounts.find(a => a.id === saved.advertiser_id && a.account_status === 1 && a.currency === "USD");
  if (!account || !saved.page_id) return false;
  const page = inventory.pages.find(p => p.id === saved.page_id);
  if (!page) return false;
  return !saved.instagram_id || inventory.instagram.some(i => i.id === saved.instagram_id && i.account_id === account.id);
}

/**
 * Whether an assignment updates an existing connection rather than adding one
 * (decision 2026-10-25, migration 0025): a TikTok connection is its ad
 * account; a Meta connection is its ad account and its Page, so a second Page
 * on the same ad account sits beside the first instead of replacing it.
 */
export function sameConnectionSlot(a: Pick<LaunchConnection, "provider" | "advertiser_id" | "page_id">, b: Pick<LaunchConnection, "provider" | "advertiser_id" | "page_id">): boolean {
  if (a.provider !== b.provider || a.advertiser_id !== b.advertiser_id) return false;
  return a.provider !== "meta" || (a.page_id ?? null) === (b.page_id ?? null);
}

/**
 * The one Meta connection the auto-poster posts a company's proven clips to.
 * A connection marked `auto_post: true` wins; one assigned before the flag
 * existed (absent) is next, so a one-account company keeps posting as before;
 * `auto_post: false` is never used. Ties go to the earliest assignment, then
 * the id, so the answer never depends on storage order. Null when none qualify.
 */
export function autoPostConnection(connections: readonly LaunchConnection[]): LaunchConnection | null {
  const usable = connections.filter(c => c.provider === "meta" && c.enabled && c.assigned_by && c.page_id && c.auto_post !== false);
  const rank = (c: LaunchConnection) => (c.auto_post === true ? 0 : 1);
  const sorted = [...usable].sort((a, b) => rank(a) - rank(b) || a.verified_at.localeCompare(b.verified_at) || a.id.localeCompare(b.id));
  return sorted[0] ?? null;
}

/**
 * The TikTok account a new launch starts on, so a one-account setup needs no
 * click (decision 2026-09-23, "one TikTok account for now"): the operator's
 * TIKTOK_DEFAULT_ADVERTISER_ID when the company's own assignment reaches it,
 * else the company's preferred account inside its Business Center, else its
 * only account. Null when there is a real choice to make. It never adds an
 * account: only a connection the company was assigned can be the answer.
 */
export function defaultLaunchConnectionId(connections: readonly LaunchConnection[], opts: { defaultAdvertiserId?: string | null; preferredAdvertiserId?: string | null } = {}): string | null {
  const tiktok = connections.filter(c => c.provider === "tiktok" && c.enabled && c.assigned_by);
  const byAdvertiser = (id: string | null | undefined) => (id ? tiktok.find(c => c.advertiser_id === id)?.id ?? null : null);
  return byAdvertiser(opts.defaultAdvertiserId) ?? byAdvertiser(opts.preferredAdvertiserId) ?? (tiktok.length === 1 ? tiktok[0].id : null);
}
