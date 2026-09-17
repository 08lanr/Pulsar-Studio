import { launchHash } from "@/lib/data/launch";
import { invalid } from "@/lib/data/errors";
import { splitBudget } from "./plan";
import type { LaunchCampaign, LaunchRun } from "./types";

/** Derive authority from the frozen approval, never from a control's mutable row. */
export function approvedCampaignBudget(run: LaunchRun, campaign: LaunchCampaign): number {
  if (!run.approved_by || !run.snapshot_hash || launchHash(run.draft, run.connections || [],
    run.campaigns.some(c => c.campid) ? run.campaigns : undefined) !== run.snapshot_hash) {
    throw invalid("Launch approval is missing or changed. Create and approve a new round.");
  }
  const { account_ids, campaigns_per_account, total_budget_cents } = run.draft;
  const count = account_ids.length * campaigns_per_account;
  if (!Number.isSafeInteger(campaigns_per_account) || campaigns_per_account < 1 || count < 1 || count > 100 ||
      new Set(account_ids).size !== account_ids.length || !Number.isInteger(campaign.index) || campaign.index < 1 || campaign.index > count) {
    throw invalid("Campaign does not match the signed budget allocation.");
  }
  const accountId = account_ids[Math.floor((campaign.index - 1) / campaigns_per_account)];
  const account = run.connections?.find(a => a.id === accountId);
  if (!account || account.provider !== run.draft.provider || campaign.connection_id !== accountId || campaign.advertiser_id !== account.advertiser_id) {
    throw invalid("Campaign does not match the signed account allocation.");
  }
  return splitBudget(total_budget_cents, count)[campaign.index - 1];
}

/** A higher ceiling needs a new round's preview and approval. Reductions do not rewrite that ceiling. */
export function assertCampaignBudget(run: LaunchRun, campaign: LaunchCampaign, requested = campaign.budget_cents): number {
  const ceiling = approvedCampaignBudget(run, campaign);
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > ceiling) {
    throw invalid(`Budget exceeds the signed campaign ceiling of $${(ceiling / 100).toFixed(2)}. Create and approve a new round for a higher budget.`);
  }
  return requested;
}
