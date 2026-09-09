// Can this campaign launch right now, and if not, why — one pure rule
// shared by both data-layer backends (they refuse with the first reason)
// and the producer page (it shows every reason). Nothing here reads a
// store or a network.
//
// A launch needs (decision 2026-09-09):
//   - the campaign approved (a frozen manifest exists)
//   - the experiment budget signed by the approver, at or above TikTok's minimum
//   - a destination URL (ads send viewers to a link)
//   - every chosen creative rendered with a checksum — in the live modes; the
//     fake transport accepts the source episode file in its place, so a
//     fixture demo without ffmpeg still walks the pipeline
//   - a ready launch account: a connected TikTok ad account with an
//     advertiser id and a publishing identity assigned by Pulsar staff

import type { CompanyAccount, PromoApproval, PromoCampaign, PromoCreative } from "@/lib/types";

export const MIN_LAUNCH_BUDGET_USD = 20;

export type LaunchBlocker =
  | "not_approved"
  | "budget_unsigned"
  | "budget_below_minimum"
  | "no_destination"
  | "unrendered_creatives"
  | "no_launch_account"
  | "no_identity";

export type LaunchReadiness = { ready: boolean; blockers: LaunchBlocker[] };

/**
 * Only a STAFF-ASSIGNED row can launch: a producer records their own accounts
 * freely, and a self-recorded "connected" ad account must never route
 * Pulsar's token into an advertiser id the producer typed.
 */
export function isReadyLaunchAccount(a: CompanyAccount | null | undefined): a is CompanyAccount {
  return !!a && a.provider === "tiktok" && a.kind === "ad_account" && a.state === "connected" && !!a.assigned_by && !!a.external_ref && /^\d{5,}$/.test(a.external_ref);
}

export function launchReadiness(input: {
  campaign: PromoCampaign;
  approval: PromoApproval | null;
  creatives: PromoCreative[];
  account: CompanyAccount | null;
  mode: "fake" | "sandbox" | "production";
}): LaunchReadiness {
  const { campaign, approval, creatives, account, mode } = input;
  const blockers: LaunchBlocker[] = [];
  if (campaign.status !== "approved" || !approval) blockers.push("not_approved");
  const e = campaign.experiment;
  if (!e || !e.approved_at) blockers.push("budget_unsigned");
  else if (e.budget_usd < MIN_LAUNCH_BUDGET_USD) blockers.push("budget_below_minimum");
  if (!campaign.destination_url) blockers.push("no_destination");
  const chosen = creatives.filter((c) => c.status === "approved");
  if (mode !== "fake" && chosen.some((c) => !c.render_path || !c.render_sha256)) blockers.push("unrendered_creatives");
  if (!isReadyLaunchAccount(account)) blockers.push("no_launch_account");
  else if (!account.identity_id || !account.identity_type) blockers.push("no_identity");
  return { ready: blockers.length === 0, blockers };
}

/** The first blocker as a sentence the data layer can throw. */
export function blockerMessage(b: LaunchBlocker): string {
  switch (b) {
    case "not_approved":
      return "approve the campaign before launch";
    case "budget_unsigned":
      return "the approver must sign the budget before launch";
    case "budget_below_minimum":
      return `the budget must be at least $${MIN_LAUNCH_BUDGET_USD} (TikTok's minimum)`;
    case "no_destination":
      return "set where viewers should go (destination URL) before launch";
    case "unrendered_creatives":
      return "every chosen ad must be rendered before launch; generate the ads again";
    case "no_launch_account":
      return "no TikTok ad account is assigned to this company yet; ask Pulsar to set one up";
    case "no_identity":
      return "the assigned ad account has no TikTok handle (identity) linked; Pulsar staff must link one";
  }
}
