// Launch settings — what overlord's ad group presets and Mass Launch
// campaign settings hardcoded or chose per launch, as one typed record on a
// Studio campaign (decision 2026-09-16, "launch settings, controls and the
// monitor"). Values travel: the record is snapshotted onto the launch row
// at submit, so editing a preset later never changes what a running launch
// created.
//
// The budget AMOUNT is never here — it is the approved experiment budget,
// the one number the approver signs. What IS here is the budget SHAPE:
//
//   lifetime   the campaign stays uncapped; every ad group (the original and
//              its auto-duplicates) gets an equal share of the approved
//              budget as a lifetime ceiling — the sum is exactly the signed
//              number, as before.
//   daily      every ad group gets `daily_budget_usd` per day; the campaign
//              itself carries the approved budget as a LIFETIME CAP, so the
//              signed number still bounds the whole launch however many
//              copies run.
//
// Client-safe: pure functions and zod only.

import { z } from "zod";
import { SALES_MASTER_SHA256, SALES_MASTER_VERSION } from "./instant-page-master";
import {
  AGE_OPTIONS,
  BUDGET_MODE_OPTIONS,
  CTA_OPTIONS,
  DEFAULT_LOCATION_IDS,
  GENDER_OPTIONS,
  GOAL_OPTIONS,
  MAX_DURATION_DAYS,
  MAX_DUPLICATE_COPIES,
  MIN_ADGROUP_BUDGET_USD,
  MIN_CAMPAIGN_BUDGET_USD,
  OS_OPTIONS,
  PACING_OPTIONS,
  goalOption,
} from "./options";

const values = (opts: { value: string }[]) => opts.map((o) => o.value) as [string, ...string[]];
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const launchSettingsSchema = z.object({
  /** Absent on old saved rows: preserve their Traffic/Clicks behavior. */
  objective_type: z.enum(["TRAFFIC", "WEB_CONVERSIONS"]).optional(),
  /** Frozen local design and immutable bundled master version for Sales. */
  instant_page_template: z.object({
    id: z.string().uuid(), name: z.string().min(1).max(60),
    button_text: z.string().min(1).max(40), background: z.enum(["white", "black"]),
    hand_cursor: z.boolean(), master_version: z.string().min(1),
    master_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  // targeting
  location_ids: z.array(z.string().regex(/^\d+$/, "TikTok location ids are numeric")).min(1, "Pick at least one location").max(50),
  age_groups: z.array(z.enum(values(AGE_OPTIONS))).max(AGE_OPTIONS.length),
  gender: z.enum(values(GENDER_OPTIONS)),
  languages: z.array(z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, "language code")).max(20),
  operating_systems: z.array(z.enum(values(OS_OPTIONS))).max(1, "Pick one operating system, or none for all"),
  placement: z.enum(["tiktok", "automatic"]),
  // budget shape and schedule
  budget_mode: z.enum(values(BUDGET_MODE_OPTIONS)),
  daily_budget_usd: z.number().min(MIN_ADGROUP_BUDGET_USD).max(100_000).nullable(),
  duration_days: z.number().int().min(1).max(MAX_DURATION_DAYS).nullable(),
  schedule_start: isoDay.nullable(),
  schedule_end: isoDay.nullable(),
  // bidding
  optimization_goal: z.enum(values(GOAL_OPTIONS)),
  bid_strategy: z.enum(["LOWEST_COST", "COST_CAP"]),
  bid_usd: z.number().positive().max(10_000).nullable(),
  pacing: z.enum(values(PACING_OPTIONS)),
  comments_disabled: z.boolean(),
  // ads
  call_to_action: z.enum(values(CTA_OPTIONS)),
  // launch
  start_paused: z.boolean(),
  duplicate_copies: z.number().int().min(0).max(MAX_DUPLICATE_COPIES),
  campaign_name_prefix: z.string().trim().max(40).nullable(),
});

export type LaunchSettings = z.infer<typeof launchSettingsSchema>;

/** The new 1 Geo Sales shape; the budget amount stays on the launch draft. */
export function defaultSalesLaunchSettings(): LaunchSettings {
  return {
    ...defaultLaunchSettings(),
    objective_type: "WEB_CONVERSIONS",
    location_ids: ["6252001"],
    placement: "tiktok",
    optimization_goal: "CONVERT",
    bid_strategy: "COST_CAP",
    bid_usd: 0.20,
    pacing: "PACING_MODE_SMOOTH",
    comments_disabled: true,
    budget_mode: "BUDGET_MODE_DAY",
    daily_budget_usd: 20,
    instant_page_template: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "(default)", button_text: "Watch now", background: "white", hand_cursor: false,
      master_version: SALES_MASTER_VERSION, master_sha256: SALES_MASTER_SHA256,
    },
  };
}

/** The behaviour the engine had before settings existed: US, everyone, lifetime budget, clicks, lowest cost, live. */
export function defaultLaunchSettings(): LaunchSettings {
  return {
    location_ids: [...DEFAULT_LOCATION_IDS],
    age_groups: [],
    gender: "GENDER_UNLIMITED",
    languages: [],
    operating_systems: [],
    placement: "automatic",
    budget_mode: "BUDGET_MODE_TOTAL",
    daily_budget_usd: null,
    duration_days: null,
    schedule_start: null,
    schedule_end: null,
    optimization_goal: "CLICK",
    bid_strategy: "LOWEST_COST",
    bid_usd: null,
    pacing: "PACING_MODE_SMOOTH",
    comments_disabled: false,
    call_to_action: "WATCH_NOW",
    start_paused: false,
    duplicate_copies: 0,
    campaign_name_prefix: null,
  };
}

/** Fill a partial (an old row, a preset without every field) with the defaults; unknown keys dropped. */
export function normalizeLaunchSettings(raw: unknown): LaunchSettings {
  const base = defaultLaunchSettings();
  if (!raw || typeof raw !== "object") return base;
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as (keyof LaunchSettings)[]) {
    const v = (raw as Record<string, unknown>)[key];
    if (v !== undefined) merged[key] = v;
  }
  const source = raw as Record<string, unknown>;
  if (source.objective_type !== undefined) merged.objective_type = source.objective_type;
  if (source.instant_page_template !== undefined) merged.instant_page_template = source.instant_page_template;
  const parsed = launchSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
}

export class LaunchSettingsError extends Error {}

/**
 * Cross-field rules the schema cannot express, checked against the budget
 * the launch will carry. Throws LaunchSettingsError with the first problem;
 * returns the settings with derived fields filled (a lifetime launch always
 * knows its duration).
 */
export function validateLaunchSettings(input: LaunchSettings, budgetUsd: number): LaunchSettings {
  const s = { ...input };
  if (s.objective_type === "WEB_CONVERSIONS") {
    if (s.optimization_goal !== "CONVERT") throw new LaunchSettingsError("Sales Instant Pages require button conversion optimization.");
    if (!s.instant_page_template) throw new LaunchSettingsError("Choose an Instant Page template before previewing a Sales launch.");
    if (s.instant_page_template.master_version !== SALES_MASTER_VERSION || s.instant_page_template.master_sha256 !== SALES_MASTER_SHA256) throw new LaunchSettingsError("The selected Instant Page master is unavailable; choose a current template and preview again.");
  } else if (s.optimization_goal === "CONVERT" || s.instant_page_template) {
    throw new LaunchSettingsError("Instant Page conversion settings require the Sales objective.");
  }
  const groups = s.duplicate_copies + 1;
  if (s.budget_mode === "BUDGET_MODE_TOTAL") {
    const share = Math.floor((budgetUsd / groups) * 100) / 100;
    if (share < MIN_ADGROUP_BUDGET_USD) {
      throw new LaunchSettingsError(
        groups === 1
          ? `The approved budget ($${budgetUsd}) is below TikTok's ad group minimum of $${MIN_ADGROUP_BUDGET_USD}.`
          : `$${budgetUsd} split across ${groups} ad groups is $${share} each, below TikTok's minimum of $${MIN_ADGROUP_BUDGET_USD}; use fewer copies or a larger budget.`
      );
    }
    if (!s.duration_days) s.duration_days = scheduleDays(share);
    s.daily_budget_usd = null;
  } else {
    if (!s.daily_budget_usd) throw new LaunchSettingsError("A daily budget needs an amount per ad group.");
    if (budgetUsd < MIN_CAMPAIGN_BUDGET_USD) throw new LaunchSettingsError(`A daily launch caps the campaign at the approved budget, and TikTok's campaign minimum is $${MIN_CAMPAIGN_BUDGET_USD}.`);
    if (s.daily_budget_usd > budgetUsd) throw new LaunchSettingsError(`The daily budget ($${s.daily_budget_usd}) exceeds the approved budget ($${budgetUsd}) that caps the campaign.`);
  }
  if (s.bid_strategy === "COST_CAP" && !(s.bid_usd && s.bid_usd > 0)) throw new LaunchSettingsError("A cost cap needs a target cost above 0.");
  if (s.bid_strategy === "LOWEST_COST") s.bid_usd = null;
  if (s.schedule_start && s.schedule_end && s.schedule_end < s.schedule_start) throw new LaunchSettingsError("The end date is before the start date.");
  if (s.schedule_end) {
    const today = new Date().toISOString().slice(0, 10);
    if (s.schedule_end < today) throw new LaunchSettingsError("The end date is in the past.");
  }
  return s;
}

/**
 * Days a lifetime ad group runs its share: the budget at no less than the
 * daily minimum, capped. $100 runs five days; $20 runs one.
 */
export function scheduleDays(budgetUsd: number): number {
  return Math.max(1, Math.min(MAX_DURATION_DAYS, Math.floor(budgetUsd / MIN_ADGROUP_BUDGET_USD)));
}

/** UTC "YYYY-MM-DD HH:MM:SS" — the timestamp format TikTok's API expects. */
export function tiktokTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export type AdGroupPlan = {
  /** What one ad group is told to spend: its lifetime share, or its daily amount. */
  budget: number;
  budget_mode: LaunchSettings["budget_mode"];
  /** How many ad groups the launch runs once duplication has happened. */
  groups: number;
  /** The campaign-level lifetime cap, when the daily shape needs one. */
  campaign_budget: number | null;
  schedule_type: "SCHEDULE_START_END" | "SCHEDULE_FROM_NOW";
  schedule_start_time: string;
  schedule_end_time: string | null;
};

/** The budget and schedule numbers one launch sends, from its settings and the signed budget. Pure. */
export function planAdGroup(s: LaunchSettings, budgetUsd: number, now: Date = new Date()): AdGroupPlan {
  const groups = s.duplicate_copies + 1;
  const startsAt = s.schedule_start ? new Date(`${s.schedule_start}T00:00:00Z`) : new Date(now.getTime() + 10 * 60 * 1000);
  const start = startsAt.getTime() < now.getTime() + 10 * 60 * 1000 ? new Date(now.getTime() + 10 * 60 * 1000) : startsAt;
  if (s.budget_mode === "BUDGET_MODE_TOTAL") {
    const share = Math.floor((budgetUsd / groups) * 100) / 100;
    const days = s.duration_days ?? scheduleDays(share);
    const end = s.schedule_end ? new Date(`${s.schedule_end}T23:59:59Z`) : new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
    return { budget: share, budget_mode: "BUDGET_MODE_TOTAL", groups, campaign_budget: null, schedule_type: "SCHEDULE_START_END", schedule_start_time: tiktokTime(start), schedule_end_time: tiktokTime(end) };
  }
  const daily = s.daily_budget_usd ?? MIN_ADGROUP_BUDGET_USD;
  if (s.schedule_end) {
    return { budget: daily, budget_mode: "BUDGET_MODE_DAY", groups, campaign_budget: budgetUsd, schedule_type: "SCHEDULE_START_END", schedule_start_time: tiktokTime(start), schedule_end_time: tiktokTime(new Date(`${s.schedule_end}T23:59:59Z`)) };
  }
  return { budget: daily, budget_mode: "BUDGET_MODE_DAY", groups, campaign_budget: budgetUsd, schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: tiktokTime(start), schedule_end_time: null };
}

/** The bidding fields one ad group sends: the cap in the field its billing event keeps it in. */
export function biddingFields(s: LaunchSettings): Record<string, unknown> {
  const goal = goalOption(s.optimization_goal);
  if (s.bid_strategy === "COST_CAP" && s.bid_usd) {
    return { bid_type: "BID_TYPE_CUSTOM", ...(goal.billing === "CPC" ? { bid_price: s.bid_usd } : { conversion_bid_price: s.bid_usd }) };
  }
  return { bid_type: "BID_TYPE_NO_BID" };
}

/** The targeting and placement fields one ad group sends. Unrestricted knobs are omitted: TikTok rejects empty arrays. */
export function targetingFields(s: LaunchSettings): Record<string, unknown> {
  const nativePage = s.objective_type === "WEB_CONVERSIONS" ? { promotion_website_type: "TIKTOK_NATIVE_PAGE" } : {};
  return {
    ...(s.placement === "tiktok"
      ? { promotion_type: "WEBSITE", ...nativePage, placement_type: "PLACEMENT_TYPE_NORMAL", placements: ["PLACEMENT_TIKTOK"] }
      : { promotion_type: "WEBSITE", ...nativePage, placement_type: "PLACEMENT_TYPE_AUTOMATIC" }),
    location_ids: s.location_ids.length ? s.location_ids : DEFAULT_LOCATION_IDS,
    ...(s.age_groups.length ? { age_groups: s.age_groups } : {}),
    ...(s.gender !== "GENDER_UNLIMITED" ? { gender: s.gender } : {}),
    ...(s.languages.length ? { languages: s.languages } : {}),
    ...(s.operating_systems.length ? { operating_systems: s.operating_systems } : {}),
  };
}

/** The whole ad group create body, minus the ids and the name. Pure, so tests can assert on it. */
export function adGroupBody(s: LaunchSettings, plan: AdGroupPlan): Record<string, unknown> {
  const goal = goalOption(s.optimization_goal);
  return {
    ...targetingFields(s),
    optimization_goal: goal.value,
    billing_event: goal.billing,
    ...(s.objective_type === "WEB_CONVERSIONS" ? { optimization_event: "BUTTON" } : {}),
    budget_mode: plan.budget_mode,
    budget: plan.budget,
    schedule_type: plan.schedule_type,
    schedule_start_time: plan.schedule_start_time,
    ...(plan.schedule_end_time ? { schedule_end_time: plan.schedule_end_time } : {}),
    pacing: s.pacing,
    ...biddingFields(s),
    // House policy on every ad group (overlord): nobody may download or reshare the creative.
    video_download_disabled: true,
    share_disabled: true,
    ...(s.comments_disabled ? { comment_disabled: true } : {}),
    operation_status: s.start_paused ? "DISABLE" : "ENABLE",
  };
}

/** One line a person can read: "US · all ages · lifetime · clicks · lowest cost · live". */
export function summarizeLaunchSettings(s: LaunchSettings, locationNames: Record<string, string> = {}): string[] {
  const loc = s.location_ids.map((id) => locationNames[id] ?? (id === "6252001" ? "United States" : id));
  const parts = [
    s.objective_type === "WEB_CONVERSIONS" ? "Sales · Instant Page" : "Traffic · website",
    loc.length <= 3 ? loc.join(", ") : `${loc.length} locations`,
    s.age_groups.length ? `${s.age_groups.length} age band${s.age_groups.length === 1 ? "" : "s"}` : "all ages",
    s.gender === "GENDER_UNLIMITED" ? "everyone" : s.gender === "GENDER_MALE" ? "men" : "women",
    s.placement === "tiktok" ? "TikTok only" : "automatic placement",
    s.budget_mode === "BUDGET_MODE_TOTAL" ? "lifetime budget" : `$${s.daily_budget_usd ?? "?"}/day per ad group`,
    goalOption(s.optimization_goal).label,
    s.bid_strategy === "COST_CAP" ? `cost cap $${s.bid_usd ?? "?"}` : "lowest cost",
    s.pacing === "PACING_MODE_FAST" ? "accelerated" : null,
    s.duplicate_copies > 0 ? `${s.duplicate_copies} auto-duplicate cop${s.duplicate_copies === 1 ? "y" : "ies"}` : null,
    s.start_paused ? "starts paused" : "live on approval",
  ];
  return parts.filter((p): p is string => !!p);
}
