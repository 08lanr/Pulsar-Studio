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
