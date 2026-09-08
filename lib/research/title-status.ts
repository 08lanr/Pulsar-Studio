// A title's two lifecycles, read from the records that exist (decision
// 2026-09-09, "one title workspace"). Publication on TikTok and advertising
// through Pulsar are SEPARATE statuses: a title can be either, both or
// neither, and neither proves the other.
//
// - Platform status comes from the analytics state of the linked listing.
//   Data delivered for a listing is the only evidence the title is live on
//   the platform; a link alone is "linked, awaiting data"; no link means
//   publication is unknown, never "unpublished".
// - Ad status comes from the title's latest campaign record and its results,
//   through the same workflow resolver the campaign pages use. A submitted
//   campaign is "submitted" (a demo handoff until a provider exists), never
//   "running"; only a `live` record is running.

import type { AnalyticsState } from "@/lib/analytics/types";
import type { CreativeResult, PromoCampaignSummary } from "@/lib/types";
import { campaignWorkflow } from "./workflow";

export type PlatformStatus = "reporting" | "stale" | "sync_failed" | "awaiting_data" | "not_linked";

export function platformStatus(state: AnalyticsState | null | undefined): PlatformStatus {
  switch (state) {
    case "available":
    case "partial":
      return "reporting";
    case "stale":
      return "stale";
    case "sync_failed":
      return "sync_failed";
    case "linked_awaiting_data":
      return "awaiting_data";
    default:
      return "not_linked";
  }
}

/** Data has been delivered for the listing: the title is live on the platform. */
export function isOnPlatform(s: PlatformStatus): boolean {
  return s === "reporting" || s === "stale" || s === "sync_failed";
}

export type AdStatus = "none" | "preparing" | "awaiting_approval" | "ready_to_launch" | "submitted" | "running" | "results" | "failed";

export type AdReading = {
  status: AdStatus;
  campaign: PromoCampaignSummary | null;
  flow: ReturnType<typeof campaignWorkflow> | null;
  rounds: number;
};

export function adStatus(campaigns: PromoCampaignSummary[], results: CreativeResult[]): AdReading {
  if (!campaigns.length) return { status: "none", campaign: null, flow: null, rounds: 0 };
  const latest = [...campaigns].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const flow = campaignWorkflow(latest, results);
  const hasResults = results.some((r) => r.campaign_id === latest.id);
  let status: AdStatus;
  if (latest.status === "failed") status = "failed";
  else if (latest.status === "live") status = hasResults ? "results" : "running";
  else if (latest.status === "submitted" || latest.status === "launching") status = hasResults ? "results" : "submitted";
  else if (latest.status === "approved") status = latest.experiment?.approved_at ? "ready_to_launch" : "awaiting_approval";
  else if (latest.approved_count > 0) status = "awaiting_approval";
  else status = "preparing";
  return { status, campaign: latest, flow, rounds: campaigns.length };
}

/** Advertising has left the producer's hands: submitted, running or reporting results. */
export function isAdvertising(s: AdStatus): boolean {
  return s === "submitted" || s === "running" || s === "results";
}

export type QuickFilter = "all" | "on_tiktok" | "ads_active" | "preparing";
export const QUICK_FILTERS: QuickFilter[] = ["all", "on_tiktok", "ads_active", "preparing"];

/**
 * Quick filters may overlap. Definitions (also written in the UI):
 * - on_tiktok: the linked listing has delivered data.
 * - ads_active: a campaign is submitted, running or has results.
 * - preparing: neither of the above.
 */
export function matchesQuickFilter(f: QuickFilter, platform: PlatformStatus, ads: AdStatus): boolean {
  if (f === "all") return true;
  if (f === "on_tiktok") return isOnPlatform(platform);
  if (f === "ads_active") return isAdvertising(ads);
  return !isOnPlatform(platform) && !isAdvertising(ads);
}

/** Reported ad spend across every round, or null when nothing has been reported. */
export function adSpend(results: CreativeResult[]): number | null {
  return results.length ? Math.round(results.reduce((a, r) => a + r.spend_usd, 0) * 100) / 100 : null;
}

/** Click-through rate across every reported row (clicks ÷ impressions), null without impressions. */
export function adCtr(results: CreativeResult[]): { ctr: number; clicks: number; impressions: number } | null {
  const impressions = results.reduce((a, r) => a + r.impressions, 0);
  const clicks = results.reduce((a, r) => a + r.clicks, 0);
  return impressions > 0 ? { ctr: clicks / impressions, clicks, impressions } : null;
}
