// The shapes of "Upload to crazydramas" (phase 5, publish spec §1–10;
// crazydramas docs/STUDIO_API.md is the contract on the other side): the
// bodies Studio's own routes accept and the answers they give, as zod, so
// the routes (lib + app/api/titles/[id]/crazydramas/*) and the screens
// (components/producer/CrazydramasPublish.tsx and its parts) read one
// definition. Studio's routes, not crazydramas's:
//
//   GET  /api/titles/[id]/crazydramas/publish          → PublishState
//   PUT  /api/titles/[id]/crazydramas/series           SeriesBody → SeriesReply
//   POST /api/titles/[id]/crazydramas/uploads          UploadsBody → UploadsReply
//   POST /api/titles/[id]/crazydramas/uploads/cancel   CancelBody → CancelReply
//   POST /api/titles/[id]/crazydramas/publish          PublishBody → PublishReply
//   POST /api/titles/[id]/crazydramas/unpublish        UnpublishBody → UnpublishReply
//   POST /api/titles/[id]/crazydramas/poster-check     PosterCheckBody → PosterCheckReply
//
// Every refusal is `{ error, code, ...details }` (PublishError): the
// crazydramas codes pass through with their own words (409
// series_title_exists with `existing`, 403 series_not_studio, 409
// iap_product_id_taken, 400 bad_request with `issues`), and Studio adds its
// own (409 paid_needs_confirm with `paid`, 409 writes_disabled with
// `reason`). Nothing here carries a token, an upload URL or a playback id:
// those never leave the server (STUDIO_API.md "Auth"; the paywall leak).
//
// Pure: no import of the data layer or the transport, so a client component
// may import it.

import { z } from "zod";

// ---- vocabulary -----------------------------------------------------------------------------------

/** Where the title's series stands, as Studio may act on it (spec §5, §7). */
export const SERIES_STATES = ["not_linked", "not_uploaded", "draft", "published", "cms_managed"] as const;
export type CdSeriesState = (typeof SERIES_STATES)[number];

/**
 * One ledger row's step (`studio.cd_publications`, spec §8, plan A6):
 * planned → upload_created → bytes_sent → asset_ready → verified → published,
 * or failed / superseded. The UI reads them as queued, uploading x%,
 * processing, ready, verified (ready to publish), published, failed.
 */
export const LEDGER_STEPS = ["planned", "upload_created", "bytes_sent", "asset_ready", "verified", "published", "failed", "superseded"] as const;
export type CdLedgerStep = (typeof LEDGER_STEPS)[number];

/** Steps in which the background uploader still owns the episode: the screens poll while any episode is in one. */
export const ACTIVE_LEDGER_STEPS: readonly CdLedgerStep[] = ["planned", "upload_created", "bytes_sent", "asset_ready"];

/** crazydramas' episode status enum (STUDIO_API.md, GET series). */
export const CD_EPISODE_STATUSES = ["uploading", "processing", "ready", "failed"] as const;

/** A crazydramas slug: lowercase letters and digits joined by single hyphens, at most 80 (STUDIO_API.md, PUT series). */
export const CD_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `iap_product_id`: at most 40 characters of [a-z0-9_.] starting with a letter or digit (STUDIO_API.md "Before any live use" 4). */
export const IAP_PRODUCT_ID = /^[a-z0-9][a-z0-9_.]{0,39}$/;

/** The IAP id Studio suggests for a slug: `cd.series.<short_name>`, the short name the slug with underscores, cut to fit 40 characters without a trailing `_` or `.`. */
export function suggestIapProductId(slug: string): string {
  const short = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `cd.series.${short}`.slice(0, 40).replace(/[._]+$/, "");
}

/** The poster Studio suggests (spec §4): Jayden commits every live series' poster to the site's own /posters/. */
export function suggestPosterUrl(slug: string, base = "https://crazydramas.com"): string {
  return `${base.replace(/\/+$/, "")}/posters/${slug}.jpg`;
}

// ---- the series as crazydramas returns it (the contract's fields, nothing else) --------------------

/** STUDIO_API.md GET /api/studio/series/:series → `series`, whitelisted (no playback id lives on a series; `poster_blurhash` is harmless). */
export const CdSeriesSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  original_title: z.string().nullable().optional(),
  tagline: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  genre: z.array(z.string()).default([]),
  language: z.string().nullable().optional(),
  status: z.string(),
  free_episode_count: z.number().int().nonnegative(),
  series_price_cents: z.number().int().nonnegative().nullable(),
  iap_product_id: z.string().nullable().optional(),
  cta_mode: z.string().nullable().optional(),
  poster_url: z.string().nullable().optional(),
  poster_blurhash: z.string().nullable().optional(),
  managed_by: z.enum(["studio", "cms"]).or(z.string()),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type CdSeries = z.infer<typeof CdSeriesSchema>;

// ---- GET /api/titles/[id]/crazydramas/publish -----------------------------------------------------

/** What the series form starts from (spec §1a): the title / film-meta, with the suggestions filled in. */
export const FormDefaultsSchema = z.object({
  /** The slug the series is (or will be) created under; null when the title has none (not_linked). */
  slug: z.string().nullable(),
  title: z.string(),
  tagline: z.string().nullable(),
  description: z.string().nullable(),
  genre: z.array(z.string()),
  language: z.string(),
  free_episode_count: z.number().int().nonnegative(),
  series_price_cents: z.number().int().nonnegative(),
  /** `cd.series.<short_name>` from the slug (suggestIapProductId). */
  iap_product_id: z.string().nullable(),
  /** `https://crazydramas.com/posters/<slug>.jpg` (suggestPosterUrl); optional on the PUT. */
  poster_url: z.string().nullable(),
});
export type FormDefaults = z.infer<typeof FormDefaultsSchema>;

export const PublishEpisodeSchema = z.object({
  n: z.number().int().positive(),
  /** Studio's measured frame count of the file it would upload; null when Studio has no episode file. */
  studio_frames: z.number().int().nullable(),
  /** The ledger's step for this episode's live row; null when Studio never planned it. */
  ledger_step: z.enum(LEDGER_STEPS).nullable(),
  /** crazydramas' own status for the episode (`uploading | processing | ready | failed`); null when crazydramas has no row. */
  cd_status: z.string().nullable(),
  is_published: z.boolean(),
  /** 1..free_episode_count of the series (or of the form's default before the series exists). */
  is_free: z.boolean(),
  /** The phase 3a reading's verdict for the pair (same_length, missing, …); null without a read. */
  verdict: z.string().nullable(),
  // Optional extras the screens use when present (the progress column, the failure reason, Retry, Replace).
  /** Bytes the uploader has had acknowledged (Mux's Range) and the file's size: "uploading 42%". */
  bytes_sent: z.number().int().nonnegative().nullable().optional(),
  bytes_total: z.number().int().nonnegative().nullable().optional(),
  /** The ledger row's error, in words, when the step is failed (or a wait's note). */
  error: z.string().nullable().optional(),
  /** crazydramas' length of the ready asset, seconds. */
  duration_s: z.number().nullable().optional(),
  /** Studio's file is not the one on crazydramas (a re-cut): only `replace: true` can send it (spec §10). */
  replace_needed: z.boolean().optional(),
});
export type PublishEpisode = z.infer<typeof PublishEpisodeSchema>;

export const PublishStateSchema = z.object({
  series_state: z.enum(SERIES_STATES),
  series: CdSeriesSchema.nullable(),
  form_defaults: FormDefaultsSchema,
  episodes: z.array(PublishEpisodeSchema),
  /** Real writes need DATA_SOURCE=supabase and CRAZYDRAMAS_LIVE_WRITES=enabled (spec §6); fixture mode writes to the fake. */
  writes_enabled: z.boolean(),
  /** The missing setting, by NAME ("CRAZYDRAMAS_LIVE_WRITES is not set to enabled"); never a value. */
  writes_disabled_reason: z.string().optional(),
  /** CRAZYDRAMAS_PAYWALL_LIVE=1: paid episodes publish without the extra confirm (spec §3). */
  paywall_live: z.boolean(),
  /** Optional: the ledger's uploader is working on this title right now. */
  uploading: z.boolean().optional(),
});
export type PublishState = z.infer<typeof PublishStateSchema>;

// ---- bodies -----------------------------------------------------------------------------------------

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const episodeNumber = z.number().int().min(1).max(500);

/** PUT /api/titles/[id]/crazydramas/series: create the draft, or update Studio's own draft. The slug is the title's; never in the body. */
export const SeriesBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    tagline: optionalText(300),
    description: optionalText(5000),
    genre: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    language: z.string().trim().min(2).max(12).optional(),
    free_episode_count: z.number().int().min(0).max(500).optional(),
    series_price_cents: z.number().int().min(0).max(100_000).optional(),
    iap_product_id: z.string().trim().regex(IAP_PRODUCT_ID, "at most 40 characters of a-z, 0-9, _ and ., starting with a letter or digit").nullable().optional(),
    poster_url: z.string().trim().url().refine((u) => u.startsWith("https://"), "the poster must be an https:// URL").nullable().optional(),
  })
  .strict();
export type SeriesBody = z.infer<typeof SeriesBodySchema>;

export const SeriesReplySchema = z.object({ series: CdSeriesSchema, created: z.boolean().optional(), changed: z.array(z.string()).optional() });
export type SeriesReply = z.infer<typeof SeriesReplySchema>;

/** POST …/uploads: queue episodes for the background uploader (never publishes, spec §2). */
export const UploadsBodySchema = z
  .object({
    episodes: z.union([z.literal("all"), z.array(episodeNumber).min(1).max(500)]),
    /** Send a re-cut over an episode crazydramas already holds (spec §10); only when that episode is ready or errored there. */
    replace: z.boolean().optional(),
  })
  .strict();
export type UploadsBody = z.infer<typeof UploadsBodySchema>;

export const UploadsReplySchema = z.object({
  queued: z.array(z.number().int()),
  /** Episodes not queued, each with why in words (no imported file, already on crazydramas, needs replace, …). */
  skipped: z.array(z.object({ n: z.number().int(), reason: z.string() })).optional(),
});
export type UploadsReply = z.infer<typeof UploadsReplySchema>;

/** POST …/uploads/cancel: stop one episode, or every queued / running one when `episode` is absent. */
export const CancelBodySchema = z.object({ episode: episodeNumber.optional() }).strict();
export type CancelBody = z.infer<typeof CancelBodySchema>;

export const CancelReplySchema = z.object({ cancelled: z.union([z.array(z.number().int()), z.number().int(), z.boolean()]) });
export type CancelReply = z.infer<typeof CancelReplySchema>;

/** POST …/publish: exactly the listed episodes (spec §2); a paid one needs `confirm_paid` until CRAZYDRAMAS_PAYWALL_LIVE=1 (spec §3). */
export const PublishBodySchema = z
  .object({
    episodes: z.array(episodeNumber).max(500),
    publish_series: z.boolean(),
    confirm_paid: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.episodes.length > 0 || b.publish_series, { message: "name at least one episode, or publish the series", path: ["episodes"] });
export type PublishBody = z.infer<typeof PublishBodySchema>;

export const PublishReplySchema = z.object({
  published: z.array(z.number().int()),
  not_published: z.array(z.number().int()),
  already_published: z.array(z.number().int()).optional(),
  series_status: z.string().optional(),
});
export type PublishReply = z.infer<typeof PublishReplySchema>;

/** POST …/unpublish: hide the listed episodes; `unpublish_series` sets a published series back to draft. */
export const UnpublishBodySchema = z
  .object({
    episodes: z.array(episodeNumber).max(500).optional(),
    unpublish_series: z.boolean().optional(),
  })
  .strict()
  .refine((b) => (b.episodes?.length ?? 0) > 0 || b.unpublish_series === true, { message: "name at least one episode, or unpublish the series", path: ["episodes"] });
export type UnpublishBody = z.infer<typeof UnpublishBodySchema>;

export const UnpublishReplySchema = z.object({
  unpublished: z.array(z.number().int()),
  already_unpublished: z.array(z.number().int()).optional(),
  series_status: z.string().optional(),
});
export type UnpublishReply = z.infer<typeof UnpublishReplySchema>;

/** POST …/poster-check: does the URL answer 200 with an image (spec §4)? Studio asks before it sends a poster_url. */
export const PosterCheckBodySchema = z.object({ url: z.string().trim().min(1).max(2000) }).strict();
export type PosterCheckBody = z.infer<typeof PosterCheckBodySchema>;

export const PosterCheckReplySchema = z.object({
  ok: z.boolean(),
  /** The HTTP status the URL answered; null when it did not answer. */
  status: z.number().int().nullable(),
  content_type: z.string().nullable(),
  /** Why it is not usable, in words. */
  reason: z.string().nullable(),
  /** Fixture mode answers from a rule and fetches nothing. */
  fake: z.boolean().optional(),
});
export type PosterCheckReply = z.infer<typeof PosterCheckReplySchema>;

// ---- refusals ----------------------------------------------------------------------------------------

/** Studio's own refusal codes beside the crazydramas ones that pass through. */
export const STUDIO_PUBLISH_CODES = ["writes_disabled", "paid_needs_confirm", "not_linked", "series_missing", "upload_running"] as const;

/** Every refusal: crazydramas' `{error, code, …}` passed through, or Studio's own. */
export const PublishErrorSchema = z
  .object({
    error: z.string(),
    code: z.string().optional(),
    /** series_title_exists: the series that already has the title. */
    existing: z.object({ slug: z.string().optional(), title: z.string().optional(), id: z.string().optional() }).passthrough().nullable().optional(),
    /** bad_request: crazydramas' (or Studio's own zod) issues. */
    issues: z.array(z.object({ path: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).optional(), message: z.string() }).passthrough()).optional(),
    /** paid_needs_confirm: the paid episodes the publish names. */
    paid: z.array(z.number().int()).optional(),
    /** writes_disabled: the missing setting, by name. */
    reason: z.string().optional(),
    /** episodes_not_ready: crazydramas' list. */
    not_ready: z.array(z.object({ episode_number: z.number().int() }).passthrough()).optional(),
  })
  .passthrough();
export type PublishError = z.infer<typeof PublishErrorSchema>;
