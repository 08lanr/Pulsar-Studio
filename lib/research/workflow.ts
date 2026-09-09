import type { CreativeResult, PromoCampaignSummary } from "@/lib/types";
import type { ExperimentStage } from "./workspace";

// Presentation vocabulary only. Approval and submission rules stay in the data layer.
export const WORKFLOW_STEPS = ["prepare", "choose", "approveAds", "budget", "launch", "results"] as const;
export type WorkflowStep = typeof WORKFLOW_STEPS[number];
export const workflowStepForStage: Record<ExperimentStage, WorkflowStep> = {
  brief: "prepare", concepts: "choose", batch: "approveAds", budget: "budget",
  submitted: "launch", results: "results", decide: "results",
};

/** Statuses from `launching` on belong to TikTok's lifecycle (decision 2026-09-09). */
export const LAUNCHED_STATUSES: ReadonlyArray<PromoCampaignSummary["status"]> = ["launching", "submitted", "live", "paused", "ended", "failed"];

export function campaignWorkflow(c: PromoCampaignSummary, results: CreativeResult[]) {
  const hasResults = results.some(r => r.campaign_id === c.id);
  const handedOff = LAUNCHED_STATUSES.includes(c.status);
  let step: WorkflowStep;
  if (c.status === "failed") step = "launch";
  else if (c.status === "generating") step = "prepare";
  else if (handedOff) step = hasResults ? "results" : "launch";
  else if (c.status === "approved") step = c.experiment?.approved_at ? "launch" : "budget";
  else if (c.approved_count > 0) step = "approveAds";
  else if (c.creative_count > 0) step = "choose";
  else step = "prepare";
  const waiting = c.status === "failed" || c.status === "generating" || (handedOff && !hasResults);
  const anchor = waiting ? "launch-status" : step === "results" ? "results" : ["choose", "approveAds", "launch"].includes(step) ? "ads" : "brief";
  // The hint names the TikTok state the producer is waiting on, not a generic "waiting".
  const hint = c.status === "failed" ? "workflow.hint.failed"
    : c.status === "generating" ? "workflow.hint.generating"
    : c.status === "launching" ? "workflow.hint.launching"
    : c.status === "submitted" && !hasResults ? "workflow.hint.submitted"
    : c.status === "paused" ? "workflow.hint.paused"
    : c.status === "ended" && !hasResults ? "workflow.hint.ended"
    : waiting ? "workflow.hint.waiting" : `workflow.hint.${step}`;
  return { step, number: WORKFLOW_STEPS.indexOf(step) + 1, waiting, hasResults,
    href: `/producer/promote/${c.id}#${anchor}`,
    action: c.status === "generating" ? "workflow.viewProgress" : waiting ? "workflow.viewLaunch" : `workflow.step.${step}`,
    hint };
}
