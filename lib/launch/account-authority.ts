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
