// Did TikTok approve the ads, and are they delivering? — Pulsar Grow's
// lib/ad-review.ts verdict logic, applied to a Studio campaign.
//
// TWO reads are required and neither is sufficient alone:
//   /ad/review_info/  what the reviewers ruled — but reports a brand-new ad
//                     as ALL_AVAILABLE before anyone has looked at it.
//   /ad/get/          secondary_status, the delivery-pipeline state — where
//                     "actually spending" lives.
//
// The producer sees the campaign status this settles (submitted → live |
// failed, paused when the campaign is switched off); staff see the per-ad
// verdicts on the desk.

import { systemSession } from "@/lib/auth";
import { getData, type LaunchedCampaign } from "@/lib/data";
import { accessTokenFor, tiktokTransport } from "./index";

export type ReviewState = "approved" | "limited" | "in_review" | "not_reviewed" | "rejected" | "unknown";

export type AdReview = { adId: string; state: ReviewState; raw?: string; reasons: string[]; suggestion?: string; secondary?: string };

const PASSED_REVIEW_SECONDARY = new Set([
  "AD_STATUS_DELIVERY_OK",
  "AD_STATUS_PARTIAL_AUDIT_DELIVERY_OK",
  "AD_STATUS_NOT_START",
  "AD_STATUS_TIME_DONE",
  "AD_STATUS_BUDGET_EXCEED",
  "AD_STATUS_BALANCE_EXCEED",
  "AD_STATUS_CAMPAIGN_EXCEED",
  "AD_STATUS_ADGROUP_EXCEED",
]);

function passedReview(secondary?: string): boolean {
  if (!secondary) return false;
  return PASSED_REVIEW_SECONDARY.has(secondary) || /DELIVERY_OK$/.test(secondary);
}

function isAuditing(secondary?: string): boolean {
  return !!secondary && secondary.includes("AUDIT") && !secondary.includes("DENY");
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

/** One ad_review_map entry + the ad's secondary_status → a verdict. An unrecognised status never reads as approved. */
export function normalizeReview(adId: string, v: Record<string, unknown>, secondary?: string): AdReview {
  const raw = v.review_status ? String(v.review_status) : "";
  const rejectInfo = Array.isArray(v.reject_info) ? (v.reject_info as Record<string, unknown>[]) : [];
  const reasons: string[] = [];
  let suggestion: string | undefined;
  for (const r of rejectInfo) {
    for (const reason of strList(r.reasons)) if (!reasons.includes(reason)) reasons.push(reason);
    if (!suggestion && r.suggestion) suggestion = String(r.suggestion);
  }
  const audited = !!v.last_audit_time;
  let state: ReviewState;
  if (raw === "UNAVAILABLE") state = "rejected";
  else if (raw === "PART_AVAILABLE" || raw === "PARTIAL_AVAILABLE") state = "limited";
  else if (passedReview(secondary)) state = "approved";
  else if (raw === "AUDIT" || raw === "IN_AUDIT" || raw === "REAUDIT") state = "in_review";
  else if (isAuditing(secondary)) state = "in_review";
  else if (reasons.length) state = "rejected";
  else if (raw === "ALL_AVAILABLE") state = audited ? "approved" : "not_reviewed";
  else state = "unknown";
  return { adId, state, raw: raw || undefined, reasons, suggestion, secondary };
}

/** Review verdicts for a launched campaign's ads. */
export async function fetchCampaignReviews(row: LaunchedCampaign): Promise<{ reviews: AdReview[]; campaignOn: boolean | null; campaignSecondary: string | null; error?: string }> {
  const { campaign, launch } = row;
  const token = accessTokenFor(launch.advertiser_id);
  const adIds = Object.values(launch.ad_ids);
  if (!token || !adIds.length || !campaign.grow_campaign_id) return { reviews: [], campaignOn: null, campaignSecondary: null };
  const tt = tiktokTransport();
  let error: string | undefined;
  const secondary: Record<string, string> = {};
  const got = await tt.get("/ad/get/", token, { advertiser_id: launch.advertiser_id, filtering: JSON.stringify({ ad_ids: adIds.slice(0, 100) }), page: 1, page_size: 100 });
  if (got.code !== 0) error = got.message || "Could not read ad status";
  else for (const a of (got.data?.list ?? []) as Record<string, unknown>[]) if (a.ad_id && a.secondary_status) secondary[String(a.ad_id)] = String(a.secondary_status);
  const info = await tt.get("/ad/review_info/", token, { advertiser_id: launch.advertiser_id, ad_ids: JSON.stringify(adIds.slice(0, 100)) });
  const map = info.code === 0 ? ((info.data?.ad_review_map ?? {}) as Record<string, Record<string, unknown>>) : {};
  if (info.code !== 0) error = error ?? info.message;
  const reviews = adIds.map((id) => normalizeReview(id, map[id] ?? {}, secondary[id]));
  const check = await tt.get("/campaign/get/", token, { advertiser_id: launch.advertiser_id, filtering: JSON.stringify({ campaign_ids: [campaign.grow_campaign_id] }), page: 1, page_size: 1 });
  const live = ((check.data?.list ?? []) as Record<string, unknown>[])[0];
  const campaignOn = check.code === 0 && live ? live.operation_status !== "DISABLE" : null;
  const campaignSecondary = check.code === 0 && live && live.secondary_status ? String(live.secondary_status) : null;
  return { reviews, campaignOn, campaignSecondary, error };
}

/** TikTok's delivery states that mean "this ad has finished its run": the schedule closed or a lifetime budget was spent. */
const FINISHED_SECONDARY = new Set(["AD_STATUS_TIME_DONE", "AD_STATUS_BUDGET_EXCEED", "AD_STATUS_CAMPAIGN_EXCEED", "AD_STATUS_ADGROUP_EXCEED"]);

/**
 * Settle one campaign's status from TikTok's answer:
 *   any ad delivering            → live
 *   every ad rejected            → failed, with TikTok's reasons
 *   campaign switched off        → paused
 *   otherwise                    → stays submitted (still in review)
 * Guarded by status: a campaign staff ended is not resurrected.
 */
export async function pollCampaignReview(row: LaunchedCampaign): Promise<{ reviews: AdReview[]; status: string; error?: string }> {
  const data = getData();
  const session = systemSession();
  const { campaign, launch } = row;
  const { reviews, campaignOn, campaignSecondary, error } = await fetchCampaignReviews(row);
  if (!reviews.length) return { reviews, status: campaign.status, error };
  const anyLive = reviews.some((r) => r.state === "approved" || r.state === "limited") && campaignOn !== false;
  const allRejected = reviews.every((r) => r.state === "rejected");
  // A lifetime launch whose every ad TikTok reports as finished (schedule closed, budget spent) is over.
  const allFinished = launch.settings?.budget_mode !== "BUDGET_MODE_DAY" && reviews.every((r) => !!r.secondary && FINISHED_SECONDARY.has(r.secondary));
  const suspended = !!campaignSecondary && campaignSecondary.includes("PUNISH");
  let status = campaign.status;
  if (suspended && ["submitted", "live", "paused"].includes(campaign.status) && !(campaign.status_note ?? "").includes("suspended")) {
    // Not a status of ours: the account is TikTok's problem; the note says so and the switch stays where it is.
    await data.setPromoCampaignDelivery(session, campaign.id, { status: campaign.status as "submitted" | "live" | "paused", status_note: "TikTok has suspended this ad account; nothing delivers until it is restored (or the campaign is relaunched on another account)." });
  }
  if (allFinished && ["submitted", "live", "paused"].includes(campaign.status)) {
    status = "ended";
    await data.setPromoCampaignDelivery(session, campaign.id, { status: "ended", status_note: "The schedule closed or the lifetime budget was spent." });
  } else if (campaignOn === false && ["submitted", "live"].includes(campaign.status)) {
    status = "paused";
    await data.setPromoCampaignDelivery(session, campaign.id, { status: "paused", status_note: campaign.status_note ?? "Switched off on TikTok" });
  } else if (anyLive && ["submitted", "paused"].includes(campaign.status)) {
    status = "live";
    await data.setPromoCampaignDelivery(session, campaign.id, { status: "live", status_note: null });
  } else if (allRejected && campaign.status === "submitted") {
    status = "failed";
    const reasons = [...new Set(reviews.flatMap((r) => r.reasons))].join("; ");
    await data.setPromoCampaignDelivery(session, campaign.id, { status: "failed", status_note: `TikTok rejected every ad${reasons ? `: ${reasons}` : ""}` });
  }
  return { reviews, status, error };
}
