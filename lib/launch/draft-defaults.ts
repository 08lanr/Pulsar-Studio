// What a new Launch draft starts with once the company's workspace is known
// (decision 2026-09-23, "one TikTok account for now"). Pure and client-safe:
// the Launch screen applies it to the draft and to its untouched baseline.

import { isCrazydramasAdUrl } from "@/lib/tiktok/ad-url";
import type { LaunchDraft, LaunchWorkspace } from "./types";

/** A crazydramas ad link carried over to Meta loses TikTok's macros: Meta has its own URL parameters. */
export const metaDestination = (url: string) => (isCrazydramasAdUrl(url) ? url.split("?")[0] : url);

/**
 * What an untouched new draft starts with once the workspace is known (applied
 * to the baseline as well, so it never counts as an edit). Meta: the last
 * destination. TikTok: the company's default account (one account for now),
 * and the title of its last TikTok launch, or its only title with a link, with
 * that title's crazydramas ad link as the destination.
 */
export function startingDraft(d: LaunchDraft, w: LaunchWorkspace): LaunchDraft {
  if (d.provider !== "tiktok") return { ...d, destination_url: d.destination_url || metaDestination(w.default_destination_url) };
  const titles = (w.titles ?? []).filter(t => t.ad_url);
  const lastTitle = w.runs.find(r => r.draft.provider === "tiktok" && r.draft.title_id)?.draft.title_id;
  const title = d.title_id ? w.titles?.find(t => t.id === d.title_id) : titles.find(t => t.id === lastTitle) ?? (titles.length === 1 ? titles[0] : undefined);
  const accountIds = d.account_ids.length || !w.tiktok_default_connection_id ? d.account_ids : [w.tiktok_default_connection_id];
  return { ...d, account_ids: accountIds, title_id: title?.id ?? d.title_id ?? null, destination_url: title?.ad_url ?? d.destination_url };
}
