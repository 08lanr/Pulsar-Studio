// crazydramas' stats report (GET /api/studio/stats, crazydramas
// docs/STUDIO_API.md "GET /api/studio/stats"), as Studio reads it: a zod
// whitelist, so nothing outside these fields survives a parse. Counts only:
// the report holds no ids of people, no user agents and no playback ids.
// Client-safe (no server imports): the stats screens and the pure sums in
// ./stats-summary.ts share these types.

import { z } from "zod";

const count = z.number().int().nonnegative();
const counts = z.array(count);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CdStatsDaySchema = z.object({
  day,
  visitors: count,
  watchers: count,
  new_watchers: count,
  wau: count,
  mau: count,
  robots: count,
  payments: count,
  first_purchases: count,
  renewals: count,
  revenue_cents: count,
});

export const CdStatsCohortSchema = z.object({
  day,
  opened: count,
  started_ep1: count,
  finished_ep1: count,
  ep1_seconds: count,
  ep1_reached: counts,
  episodes: counts,
  episodes_watched: counts,
  paywall: count,
  paywall_watched: count,
  paywall_skipped: count,
  checkouts: count,
  buyers: count,
  revenue_cents: count,
  robots: count,
});

export const CdStatsSeriesSchema = z.object({
  drama_id: z.string(),
  slug: z.string(),
  title: z.string(),
  status: z.string(),
  free_episodes: count,
  episode_count: count,
  ep1_duration_s: z.number().nonnegative().nullable(),
  cohorts: z.array(CdStatsCohortSchema),
});

export const CdStatsReportSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  timezone: z.string(),
  from: day,
  to: day,
  ep1_step_s: z.number().int().positive(),
  robots: z.object({ people: count, crawler_ua: count, burst: count, end_jump: count }),
  days: z.array(CdStatsDaySchema),
  series: z.array(CdStatsSeriesSchema),
});

export type CdStatsDay = z.infer<typeof CdStatsDaySchema>;
export type CdStatsCohort = z.infer<typeof CdStatsCohortSchema>;
export type CdStatsSeries = z.infer<typeof CdStatsSeriesSchema>;
export type CdStatsReport = z.infer<typeof CdStatsReportSchema>;
