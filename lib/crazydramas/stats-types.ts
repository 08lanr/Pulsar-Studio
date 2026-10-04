// crazydramas' stats report (GET /api/studio/stats, crazydramas
// docs/STUDIO_API.md "GET /api/studio/stats"), as Studio reads it: a zod
// whitelist, so nothing outside these fields survives a parse. Counts, plus
// (since 2026-09-26) each buyer's payments and steps under crazydramas' short
// person and browser codes: no account ids, emails, user agents or playback ids.
// Client-safe (no server imports): the stats screens and the pure sums in
// ./stats-summary.ts share these types.

import { z } from "zod";

const count = z.number().int().nonnegative();
const counts = z.array(count);
/** A field crazydramas added later: absent in an older report, read as 0 / empty. */
const later = count.default(0);
const answers = z.record(count).default({});
/** A timing histogram over the report's timing_edges_s (bins: below each edge, the last bin the rest). */
const hist = counts.default([]);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CdStatsDaySchema = z.object({
  day,
  visitors: count,
  watchers: count,
  new_watchers: count,
  wau: count,
  mau: count,
  robots: count,
  /** Browsers whose pages were never really on screen that day (not visitors; since 2026-09-25). */
  unseen: later,
  payments: count,
  first_purchases: count,
  renewals: count,
  revenue_cents: count,
});

export const CdStatsCohortSchema = z.object({
  day,
  opened: count,
  /** Not in opened (2026-09-25): the page was never really on screen; only saw the series in the feed or its page. */
  unseen: later,
  browsed: later,
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
  /** Of checkouts, came back from Stripe unpaid (crazydramas since 2026-09-30; 0 in an older report). */
  checkout_cancelled: later,
  buyers: count,
  revenue_cents: count,
  returned: later,
  errors: later,
  /** The player started a stopped video again by itself (and went on muted doing it); sound refused without a tap. */
  restarted: later,
  restarted_muted: later,
  blocked: later,
  /** The tap to the player on screen, the tap to the first frame, how long the people who left before any video waited. */
  load_hist: hist,
  start_hist: hist,
  wait_hist: hist,
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

/**
 * Episode views added up from crazydramas' playback report (since 2026-09-25; docs/STUDIO_API.md "Playback"):
 * views and first frames, the landing's start in three parts, freezes, the phone's pauses, restarts, errors,
 * time watched per picture rung, connections, and how the views ended. An older report reads as empty.
 */
export const CdStatsPlaybackSchema = z.object({
  views: later,
  started: later,
  start_hist: hist,
  landing_split: later,
  landing_page_ms: later,
  landing_player_ms: later,
  landing_video_ms: later,
  stall_views: later,
  stalls: later,
  stall_ms: later,
  watched_ms: later,
  phone_pause_views: later,
  phone_pauses: later,
  phone_pauses_sound: later,
  phone_pauses_early: later,
  viewer_pause_views: later,
  restart_views: later,
  error_views: later,
  quality_ms: answers,
  conn: answers,
  ends: answers,
});
const noPlayback = () => CdStatsPlaybackSchema.parse({});

/** One episode view that ended early, for the drill-down (a 6-character code, never the viewer's id). */
export const CdStatsDropSchema = z.object({
  code: z.string().max(12),
  at: z.string(),
  drama_id: z.string(),
  episode: count,
  device: z.string(),
  country: z.string().nullable().default(null),
  source: z.enum(["ad", "stored_copy", "no_ad"]),
  ended: z.string().max(40),
  first_frame_ms: z.number().nonnegative().nullable(),
  stalls: count,
  stall_ms: count,
  phone_pauses: count,
  phone_pauses_sound: count,
  viewer_pauses: count,
  restarts: count,
  watched_s: z.number().nonnegative(),
  on_screen_s: z.number().nonnegative(),
  position_s: z.number().nonnegative(),
  duration_s: z.number().nonnegative().nullable(),
  quality: z.string().nullable(),
  conn: z.string().nullable(),
  bw_kbps: z.number().nonnegative().nullable(),
  timeline: z.array(z.tuple([z.number(), z.string().max(20), z.number()])).max(40).default([]),
});

/** The people of one source (platform × campaign × ad × kind of browser × place) who first opened a series on a day. */
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
  /** Where the people were (ISO codes, "US" / "CA"); null before crazydramas recorded places (2026-09-25) or unplaced. */
  country: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
  region: z.string().regex(/^[A-Z0-9]{1,3}$/).nullable().default(null),
  opened: count,
  unseen: later,
  no_events: later,
  never_started: later,
  left_waiting: later,
  left_waiting_seconds: later,
  started_ep1: count,
  ep1_25: later,
  ep1_50: later,
  ep1_75: later,
  finished_ep1: count,
  watched_ep2: count,
  watched_ep3: count,
  ep1_sound_known: later,
  ep1_sound_on: later,
  paywall: count,
  paywall_watched: later,
  paywall_skipped: later,
  checkouts: count,
  /** Of checkouts, came back from Stripe unpaid (crazydramas since 2026-09-30; 0 in an older report). */
  checkout_cancelled: later,
  buyers: count,
  revenue_cents: count,
  /** Of revenue_cents, what came in by the end of the people's first day, and within 7 days (since 2026-09-28). */
  revenue_d0_cents: later,
  revenue_d7_cents: later,
  returned: later,
  errors: later,
  restarted: later,
  restarted_muted: later,
  blocked: later,
  survey_ep1_shown: later,
  survey_ep1: answers,
  survey_paywall_shown: later,
  survey_paywall: answers,
  load_hist: hist,
  start_hist: hist,
  wait_hist: hist,
  play_ep1: CdStatsPlaybackSchema.default(noPlayback),
  play_later: CdStatsPlaybackSchema.default(noPlayback),
  robots: count,
});

/**
 * Where a buyer came from, as crazydramas recorded their landing (since 2026-09-26). A landing with only
 * TikTok's click id is platform "tiktok" with campaign null (it read "organic" before). `device` is
 * crazydramas' kind of browser (tiktok_android, iphone, ...), read as any string.
 */
export const CdStatsTouchSchema = z.object({
  platform: z.string().max(40),
  campaign: z.string().max(64).nullable().default(null),
  ad: z.string().max(64).nullable().default(null),
  stored_copy: z.boolean().default(false),
  device: z.string().max(40).default("unknown"),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
  region: z.string().regex(/^[A-Z0-9]{1,3}$/).nullable().default(null),
});

/** One payment (since 2026-09-26): `person` is crazydramas' short code for the buyer (one code across their browsers), `browser` the browser's. */
export const CdStatsPurchaseSchema = z.object({
  id: z.string().max(64),
  at: z.string(),
  /** Null: a payment crazydramas credits to no series (still money in). */
  drama_id: z.string().nullable(),
  amount_cents: count,
  renewal: z.boolean().default(false),
  person: z.string().max(32),
  /** Null when crazydramas knows no browser for the payment (its source is then null too). */
  browser: z.string().max(32).nullable(),
  source: CdStatsTouchSchema.nullable().default(null),
  first_seen_at: z.string().nullable().default(null),
  paid_after_s: z.number().nonnegative().nullable().default(null),
});

export const JOURNEY_KINDS = ["landing", "ep_start", "ep_finish", "paywall", "checkout", "paid", "left"] as const;

/**
 * One step of a buyer's way through crazydramas (since 2026-09-26). `ep_finish` is the end of the episode or its
 * 75% mark; a visit is a browser's events with no gap over 30 minutes.
 */
export const CdStatsJourneyStepSchema = z.object({
  at: z.string(),
  drama_id: z.string().nullable(),
  kind: z.enum(JOURNEY_KINDS),
  episode: count.optional(),
  platform: z.string().max(40).optional(),
  campaign: z.string().max(64).nullable().optional(),
  ad: z.string().max(64).nullable().optional(),
  amount_cents: count.optional(),
});

/** What a payment bought (since 2026-09-28): a series, a coin pack, the first-week VIP deal, a new VIP, a VIP renewal. */
export const PAYMENT_KINDS = ["series", "coins", "vip_intro", "vip", "vip_renewal"] as const;

/** The two sheets of crazydramas' paywall test (its lib/paywall-test.ts): Weekly VIP first, or the series first. */
export const PAYWALL_ARMS = ["vip", "series"] as const;
export type PaywallArm = (typeof PAYWALL_ARMS)[number];

/**
 * Every live payment in the report's days (since 2026-09-28, docs/COINS.md; no cap): cash the day it was paid,
 * before Stripe's fees. `first`: the person's first payment of all. `refunded`: refunded or disputed since,
 * still on the day it was paid. `placement`: the screen that sold it (sheet, store, gift, retention).
 */
export const CdStatsPaymentSchema = z.object({
  day,
  person: z.string().max(32),
  kind: z.enum(PAYMENT_KINDS).catch("series"),
  // Text a payment names is read leniently (`.catch(null)`): a long series id must not refuse the whole report.
  product: z.string().max(200).nullable().default(null).catch(null),
  cents: count,
  first: z.boolean().default(false),
  refunded: z.boolean().default(false),
  offer: z.string().max(40).nullable().default(null).catch(null),
  placement: z.string().max(20).nullable().default(null).catch(null),
  drama_id: z.string().max(64).nullable().default(null).catch(null),
  platform: z.string().max(40).nullable().default(null).catch(null),
  campaign: z.string().max(64).nullable().default(null).catch(null),
  // The rest of the paying browser's origin, as its source row has it (crazydramas after 2026-09-28; absent before,
  // and then payments are filtered by platform and campaign only).
  ad: z.string().max(64).nullable().optional().catch(null),
  stored_copy: z.boolean().optional().catch(undefined),
  device: z.string().max(40).nullable().optional().catch(null),
  country: z.string().max(8).nullable().optional().catch(null),
  paid_after_s: z.number().nonnegative().nullable().default(null),
  // The paywall test's sheet the paying browser was last shown before it paid (crazydramas since 2026-10-04; absent
  // before, null for a renewal or a payment with no sheet on record).
  arm: z.enum(PAYWALL_ARMS).nullable().optional().catch(null),
});

/** Coins in and out of every wallet on a day (sign-in moves left out: they only change hands). */
export const CdStatsCoinDaySchema = z.object({
  day,
  bought: later,
  bonus: later,
  reward: later,
  spent_paid: later,
  spent_bonus: later,
  expired: later,
  clawed_back: later,
  unlocks: later,
});

export const CdStatsCoinsSchema = z.object({
  /** Absent on reports that valued each paid coin at a nominal cent. Never infer this from the prices. */
  value_basis: z.literal("purchase_cost").optional(),
  /** Paid coins whose original purchase cost cannot be recovered; excluded from dollar attribution. */
  unpriced_spent_paid: count.optional(),
  unpriced_unspent_paid: count.optional(),
  days: z.array(CdStatsCoinDaySchema).default([]),
  /** Now: paid coins not yet spent and what viewers paid for them; bonus coins not yet spent or expired. */
  unspent_paid: later,
  unspent_paid_cents: later,
  unspent_bonus: later,
  /** Coins spent per series and day and their allocated purchase cost; bonus and reward coins credit nothing. */
  series_days: z.array(z.object({ day, drama_id: z.string(), spent_paid: later, spent_bonus: later, cents: later, unlocks: later })).default([]),
});

/**
 * Every viewer's VIP as it stands: its plan, whether its current period is the first-week deal, whether it is on, and
 * (crazydramas since 2026-09-29) what its current period paid and how long a period is: a subscriber keeps the price
 * they signed up at when crazydramas changes its prices.
 */
export const CdStatsVipSchema = z.object({
  plan: z.string().max(40).nullable().default(null),
  intro: z.boolean().default(false),
  active: z.boolean(),
  expires_day: day.nullable().default(null),
  cents: later.optional().catch(undefined),
  interval: z.enum(["week", "month", "year"]).optional().catch(undefined),
  /** Cancelled in Stripe: still on, but stops instead of renewing when its paid time ends (crazydramas since 2026-09-29). */
  cancelling: z.boolean().optional().catch(undefined),
});

/** The unlock sheet, coin unlocks, checkouts by the screen that opened them and the pop-ups shown, per day. */
export const CdStatsPaywallDaySchema = z.object({
  day,
  views: later,
  viewers: later,
  unlocks: later,
  unlockers: later,
  checkouts: answers,
  gift_shown: later,
  retention_shown: later,
  not_completed: later,
  // The same sheet views and checkouts by the paywall test's sheet (crazydramas since 2026-10-04; absent before).
  arms: z.record(z.enum(PAYWALL_ARMS), z.object({ views: later, viewers: later, checkouts: later, starters: later })).optional().catch(undefined),
});

export const CdStatsReportSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  timezone: z.string(),
  from: day,
  to: day,
  ep1_step_s: z.number().int().positive(),
  /**
   * Robot browsers over the rows read, by the first rule that names each (crazydramas' docs/STUDIO_API.md "Robot").
   * return_link (2026-09-29) and link_scan (2026-09-30: a scraper opening every episode of a new series by direct
   * link, one browser each) read as zero in a report from before them.
   */
  robots: z.object({ people: count, crawler_ua: count, burst: count, end_jump: count, link_check: later, return_link: later, link_scan: later }),
  /** Upper edges (seconds) of every timing histogram; the last bin is open. */
  timing_edges_s: z.array(z.number().positive()).default([1, 2, 3, 5, 8, 13, 20, 30, 60]),
  /** The team's own browsers and live payments, left out of everything else. */
  team: z.object({ people: count, payments: count, revenue_cents: count }).default({ people: 0, payments: 0, revenue_cents: 0 }),
  days: z.array(CdStatsDaySchema),
  series: z.array(CdStatsSeriesSchema),
  sources: z.array(CdStatsSourceSchema).default([]),
  /** The latest episode views that ended early, newest first (the Playback tab's drill-down). */
  drops: z.array(CdStatsDropSchema).default([]),
  /**
   * Buyer details (since 2026-09-26): every payment, newest first; each buyer's steps by person code; the
   * period's distinct buyers. Absent (not empty) in an older report: the Buyers tab then says they arrive
   * with the next crazydramas release.
   */
  purchases: z.array(CdStatsPurchaseSchema).optional(),
  journeys: z.record(z.array(CdStatsJourneyStepSchema)).optional(),
  people: z.object({ buyers: count, purchases: count, revenue_cents: count }).optional(),
  /**
   * Coins, VIP and offers (since 2026-09-28, docs/COINS.md): every payment, the coin wallets, every VIP, the
   * unlock sheet and pop-ups per day. Absent (not empty) in an older report: those tabs say they arrive with the
   * next crazydramas release.
   */
  payments: z.array(CdStatsPaymentSchema).optional(),
  coins: CdStatsCoinsSchema.optional(),
  vip: z.array(CdStatsVipSchema).optional(),
  paywall_days: z.array(CdStatsPaywallDaySchema).optional(),
});

export type CdStatsDay = z.infer<typeof CdStatsDaySchema>;
export type CdStatsCohort = z.infer<typeof CdStatsCohortSchema>;
export type CdStatsSeries = z.infer<typeof CdStatsSeriesSchema>;
export type CdStatsSource = z.infer<typeof CdStatsSourceSchema>;
export type CdStatsReport = z.infer<typeof CdStatsReportSchema>;
export type CdStatsPlayback = z.infer<typeof CdStatsPlaybackSchema>;
export type CdStatsDrop = z.infer<typeof CdStatsDropSchema>;
export type CdStatsTouch = z.infer<typeof CdStatsTouchSchema>;
export type CdStatsPurchase = z.infer<typeof CdStatsPurchaseSchema>;
export type CdStatsJourneyStep = z.infer<typeof CdStatsJourneyStepSchema>;
export type JourneyKind = (typeof JOURNEY_KINDS)[number];
export type CdStatsPayment = z.infer<typeof CdStatsPaymentSchema>;
export type CdStatsCoins = z.infer<typeof CdStatsCoinsSchema>;
export type CdStatsVip = z.infer<typeof CdStatsVipSchema>;
export type CdStatsPaywallDay = z.infer<typeof CdStatsPaywallDaySchema>;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
