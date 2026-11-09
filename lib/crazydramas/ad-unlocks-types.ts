// crazydramas' ad-unlocks report, `POST /api/studio/ad-unlocks` (decision 2026-11-09, "Ad unlocks in Studio";
// plans/ad-unlocks-studio-contract.md Part 1): the whitelist Studio reads it through. Version 1. Every count is a
// whole number; days are Pacific dates (America/Los_Angeles), the stats report's day. Unknown fields are dropped;
// a count that is missing reads 0 only where the contract lists it inside an object Studio sums (the refusals),
// everything else is required, so a report of another shape is refused whole rather than half-read.

import { z } from "zod";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A count: a finite number, rounded and never below zero. */
const Count = z.number().finite().transform((v) => Math.max(0, Math.round(v)));

export const AD_PLATFORMS = ["ios", "android", "web"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];
export const AD_PROVIDERS = ["admob", "gam", "house"] as const;
export type AdProvider = (typeof AD_PROVIDERS)[number];
export const REFUSE_REASONS = ["too_fast", "expired", "cap", "duplicate", "already_open", "unknown"] as const;
export type RefuseReason = (typeof REFUSE_REASONS)[number];

const Refused = z.object({
  too_fast: Count.default(0),
  expired: Count.default(0),
  cap: Count.default(0),
  duplicate: Count.default(0),
  already_open: Count.default(0),
  unknown: Count.default(0),
});

export const AdUnlockDaySchema = z.object({
  day: Day,
  platform: z.enum(AD_PLATFORMS),
  provider: z.enum(AD_PROVIDERS),
  /** Ads started that day. */
  opened: Count,
  /** Episodes unlocked by an ad. */
  granted: Count,
  refused: Refused,
  /** Still "opened" past the 600 s window: closed early, no fill, the app left. */
  unfinished: Count,
  /** Distinct viewers who opened an ad that day (never add these across days). */
  viewers: Count,
  granted_viewers: Count,
  /** Distinct viewers who reached the daily cap at a grant that day. */
  capped_viewers: Count,
  /** Grants verified by AdMob's server-side callback, and by the app alone. */
  ssv: Count,
  client: Count,
});
export type AdUnlockDay = z.infer<typeof AdUnlockDaySchema>;

export const AdUnlockSeriesSchema = z.object({
  slug: z.string(),
  title: z.string(),
  granted: Count,
  opened: Count,
  viewers: Count,
  top_episode: Count.nullable(),
});
export type AdUnlockSeries = z.infer<typeof AdUnlockSeriesSchema>;

export const AdUnlockFailureSchema = z.object({
  day: Day,
  platform: z.string(),
  reason: z.string(),
  count: Count,
});
export type AdUnlockFailure = z.infer<typeof AdUnlockFailureSchema>;

export const AdUnlocksReportSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  tz: z.string(),
  window: z.object({ from: Day, to: Day }),
  switch: z.object({
    on: z.boolean(),
    web: z.enum(["gam", "house"]).nullable(),
    admob_units: Count,
    daily_cap: Count,
  }),
  days: z.array(AdUnlockDaySchema),
  series: z.array(AdUnlockSeriesSchema),
  failures: z.array(AdUnlockFailureSchema),
  after: z.object({
    /** Distinct viewers with at least one granted ad over the window. */
    ad_viewers: Count,
    /** Of those, viewers who paid after their first granted ad. */
    bought_after: Count,
    revenue_cents_after: Count,
    /** Paid before their first ad and never after. */
    bought_before_only: Count,
  }),
});
export type AdUnlocksReport = z.infer<typeof AdUnlocksReportSchema>;
