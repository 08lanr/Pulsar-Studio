// One dispatcher for the launch controls, shared by the staff route
// (/api/promote/[id]/controls) and the producer route
// (/api/producer/promote/[id]/controls) — decision 2026-09-16: producers
// manage their own campaigns; the data layer decides who may record what.
// The schema is the API contract; every action invalidates the monitor.

import { z } from "zod";
import { conflict, isHistoricalPromoSeed } from "@/lib/data/errors";
import type { Session } from "@/lib/auth";
import { changeBid, changeBudget, changeDailyBudget, changeScheduleEnd, duplicateAdGroups, endCampaign, switchAdGroup, switchCampaign } from "./controls";
import { invalidateMonitor } from "./monitor";
import { MAX_DUPLICATE_COPIES } from "./options";

export const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("end"), note: z.string().trim().max(400).nullable().optional() }),
  z.object({ action: z.literal("budget"), budget_usd: z.number().positive().max(1_000_000), note: z.string().trim().max(400).nullable().optional() }),
  z.object({ action: z.literal("daily_budget"), daily_budget_usd: z.number().positive().max(100_000) }),
  z.object({ action: z.literal("bid"), bid_usd: z.number().positive().max(10_000) }),
  z.object({ action: z.literal("schedule_end"), end_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ action: z.literal("duplicate"), copies: z.number().int().min(1).max(MAX_DUPLICATE_COPIES) }),
  z.object({ action: z.literal("adgroup_switch"), adgroup_id: z.string().regex(/^\d{5,}$/), on: z.boolean() }),
]);

export type ControlInput = z.infer<typeof controlSchema>;

/** Which actions a producer gets (everything but nothing more); staff get them all. */
export const PRODUCER_ACTIONS: ReadonlyArray<ControlInput["action"]> = ["pause", "resume", "end", "budget", "daily_budget", "bid", "schedule_end", "duplicate", "adgroup_switch"];

function assertLegacyStopControl(input: ControlInput): void {
  if (isHistoricalPromoSeed()) return;
  if (input.action !== "pause" && input.action !== "end" && !(input.action === "adgroup_switch" && !input.on)) {
    throw conflict("Earlier campaigns allow stop controls only. Start a new launch to change delivery.");
  }
}

export async function runControl(session: Session, campaignId: string, input: ControlInput): Promise<Record<string, unknown>> {
  try {
    assertLegacyStopControl(input);
    switch (input.action) {
      case "pause":
        return await switchCampaign(session, campaignId, false);
      case "resume":
        return await switchCampaign(session, campaignId, true);
      case "end":
        return await endCampaign(session, campaignId, input.note ?? null);
      case "budget":
        return await changeBudget(session, campaignId, input.budget_usd, input.note ?? null);
      case "daily_budget":
        return await changeDailyBudget(session, campaignId, input.daily_budget_usd);
      case "bid":
        return await changeBid(session, campaignId, input.bid_usd);
      case "schedule_end":
        return await changeScheduleEnd(session, campaignId, input.end_day);
      case "duplicate":
        return await duplicateAdGroups(session, campaignId, input.copies);
      case "adgroup_switch":
        return await switchAdGroup(session, campaignId, input.adgroup_id, input.on);
    }
  } finally {
    invalidateMonitor();
  }
}
