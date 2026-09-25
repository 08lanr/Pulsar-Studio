// crazydramas' stats report (GET /api/studio/stats, crazydramas
// docs/STUDIO_API.md "GET /api/studio/stats"), as Studio reads it: a zod
// whitelist, so nothing outside these fields survives a parse. Counts only:
// the report holds no ids of people, no user agents and no playback ids.
// Client-safe (no server imports): the stats screens and the pure sums in
// ./stats-summary.ts share these types.

import { z } from "zod";

const count = z.number().int().nonnegative();
const counts = z.array(count);
/** A field crazydramas added later: absent in an older report, read as 0 / empty. */
const later = count.default(0);
const answers = z.record(count).default({});
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
  /** Landed, nothing else recorded (TikTok's iPhone browser dropped events until 2026-09-24 18:03 PT). */
  no_events: later,
  /** Events recorded, no episode ever played; left_waiting: their leaving was recorded (+ seconds waited, summed). */
  never_started: later,
  left_waiting: later,
  left_waiting_seconds: later,
  started_ep1: count,
  finished_ep1: count,
  ep1_seconds: count,
  ep1_reached: counts,
  ep1_sound_known: later,
  ep1_sound_on: later,
  episodes: counts,
  episodes_watched: counts,
  paywall: count,
  paywall_watched: count,
  paywall_skipped: count,
  checkouts: count,
  buyers: count,
  revenue_cents: count,
  returned: later,
  errors: later,
  survey_ep1_shown: later,
  survey_ep1: answers,
  survey_paywall_shown: later,
  survey_paywall: answers,
  robots: count,
  team: later,
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

/** The people of one source (platform × campaign × ad × kind of browser) who first opened a series on a day. */
export const CdStatsSourceSchema = z.object({
  day,
  drama_id: z.string(),
  platform: z.string(),
  campaign: z.string().nullable(),
  /** TikTok's ad id (what crazydramas records as the creative); null for no ad, or a stored copy. */
  ad: z.string().nullable(),
  /** TikTok showed its stored copy of the page and the campaign and ad were lost. */
  stored_copy: z.boolean(),
  device: z.string(),
  opened: count,
  no_events: later,
  never_started: later,
  started_ep1: count,
  finished_ep1: count,
  watched_ep2: count,
  watched_ep3: count,
  paywall: count,
  checkouts: count,
  buyers: count,
  revenue_cents: count,
  robots: count,
});

export const CdStatsReportSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  timezone: z.string(),
  from: day,
  to: day,
  ep1_step_s: z.number().int().positive(),
  robots: z.object({ people: count, crawler_ua: count, burst: count, end_jump: count }),
  /** The team's own browsers and live payments, left out of everything else. */
  team: z.object({ people: count, payments: count, revenue_cents: count }).default({ people: 0, payments: 0, revenue_cents: 0 }),
  days: z.array(CdStatsDaySchema),
  series: z.array(CdStatsSeriesSchema),
  sources: z.array(CdStatsSourceSchema).default([]),
});

export type CdStatsDay = z.infer<typeof CdStatsDaySchema>;
export type CdStatsCohort = z.infer<typeof CdStatsCohortSchema>;
export type CdStatsSeries = z.infer<typeof CdStatsSeriesSchema>;
export type CdStatsSource = z.infer<typeof CdStatsSourceSchema>;
export type CdStatsReport = z.infer<typeof CdStatsReportSchema>;
