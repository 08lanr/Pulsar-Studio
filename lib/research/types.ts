// Market-research record shapes, schema version 2 (docs/market-desk-plan.md,
// phase 1). A snapshot is one validated, published run of the public-catalog
// collectors, normalized with the taxonomy applied. Runs are immutable
// artifacts; publication is a pointer to the newest validated run.
//
// Every number carries its provenance: the platform's own field name, the
// unit as the platform defines it, when it was read, and an evidence label.
// `observed` = read from the platform's page; `inferred` = derived by our
// rules; `estimated` = a model or third-party estimate; `partner_reported`
// = the producer told us. Nothing is displayed without one.
//
// Collection context (an English public web catalog, read from wherever the
// crawler ran) is recorded separately from measured audience geography,
// which for these sources is UNKNOWN: an English page does not establish a
// US audience.

import { z } from "zod";
import type { TropeId } from "./taxonomy";

export const SNAPSHOT_SCHEMA_VERSION = 2;

export type Platform = "reelshort" | "dramabox";

export const PLATFORMS: { id: Platform; name: string; home: string }[] = [
  { id: "reelshort", name: "ReelShort", home: "https://www.reelshort.com/" },
  { id: "dramabox", name: "DramaBox", home: "https://www.dramaboxapp.com/" },
];

export type Evidence = "observed" | "inferred" | "estimated" | "partner_reported";

/**
 * Platform audience positioning (女频 / 男频, F-Drama / M-Drama): how the
 * platform shelves the title, NOT the protagonist's gender and NOT a measured
 * viewer demographic.
 */
export type Audience = "female" | "male";

export type Placement = {
  /** Platform list id (reelshort: top/new/shelf-<id>; dramabox: trending, must-sees, newest, ...). */
  list: string;
  /** The platform's own name for the list. */
  name: string;
  rank: number;
  /** Lists whose rank means "the platform is pushing this now" (charts), as opposed to themed shelves. */
  chart: boolean;
};

export type MetricUnit = "views" | "collects" | "follows" | "rating";

/** One number read from a platform, with where it came from. */
export type Observation = {
  value: number;
  /** The platform's own field name (read_count, viewCount, ...). */
  source_field: string;
  unit: MetricUnit;
  /** When the page was read (ISO timestamp). */
  observed_at: string;
  evidence: Evidence;
};

export type CompanyRole = "publisher" | "platform_original" | "producer" | "rights_holder";

/** A company's relationship to a listing. A publisher label is not "the studio that made it". */
export type CompanyLink = { name: string; role: CompanyRole; evidence: Evidence; via: string };

export type TropeAssignment = { id: TropeId; evidence: "observed" | "inferred"; via: string };

export type MarketTitle = {
  /** `${platform}-${platform_id}`; stable across runs. One platform listing, not an underlying work. */
  key: string;
  platform: Platform;
  platform_id: string;
  title: string;
  blurb: string;
  cover: string | null;
  url: string;
  companies: CompanyLink[];
  audience: Audience | null;
  episode_count: number | null;
  /** First paid episode (the paywall position), when the platform exposes it. */
  paywall_episode: number | null;
  episode_seconds: number | null;
  /** What episode_seconds measures: ReelShort exposes episode 1 only; DramaBox lists every episode. */
  episode_seconds_basis: "episode_1" | "listed_average" | null;
  /** ISO date the platform first listed it, when exposed. */
  released_at: string | null;
  /** The platform's own "new" signal (ReelShort is_new; DramaBox newest list). Not "first seen by us". */
  platform_new: boolean;
  platform_tags: string[];
  tropes: TropeAssignment[];
  metrics: {
    views: Observation | null;
    saves: Observation | null;
    rating: Observation | null;
  };
  placements: Placement[];
};

export type PlatformStatus = "ok" | "partial" | "stale" | "failed";

export type PlatformRun = {
  id: Platform;
  status: PlatformStatus;
  /** When the platform was read for the data in this snapshot (for stale: the original read). */
  fetched_at: string;
  source_urls: string[];
  title_count: number;
  with_views: number;
  collection: {
    surface: "public_web";
    locale: "en";
    /** These sources do not expose where their audience is. */
    audience_geography: "unknown";
  };
  /** Detail pages requested vs fetched (DramaBox), so missing metrics are a known coverage gap. */
  detail_coverage: { requested: number; fetched: number } | null;
  /** For stale rows: the run whose data is being carried forward. */
  stale_from_run: string | null;
  error: string | null;
};

export type MarketSnapshot = {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  /** Immutable run id: the UTC start time, e.g. 2026-09-07T04-38-53Z. */
  run_id: string;
  /** UTC date of the run. */
  observed_at: string;
  taxonomy_version: string;
  platforms: PlatformRun[];
  titles: MarketTitle[];
};

/** What a producer told us about themselves at onboarding; personalizes the desk. */
export type ResearchProfile = {
  tropes: TropeId[];
  audience: Audience | "both" | null;
  titles_per_year: number | null;
  distribution: ("licensed" | "self" | "youtube" | "none")[];
  target_markets: string[];
  /** One sentence the company gave as its US goal; shown on Overview and Company. */
  goal?: string | null;
  /** What the company is willing to spend on tests per month; a brief, not a control. */
  monthly_test_budget_usd?: number | null;
  updated_at: string;
};

// ---- runtime schema (used by the builder before publication and by the loader) ------

const evidence = z.enum(["observed", "inferred", "estimated", "partner_reported"]);
const isoTimestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a timestamp");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const observation = z.object({
  value: z.number().finite(),
  source_field: z.string().min(1),
  unit: z.enum(["views", "collects", "follows", "rating"]),
  observed_at: isoTimestamp,
  evidence,
});

export const marketTitleSchema = z.object({
  key: z.string().min(3),
  platform: z.enum(["reelshort", "dramabox"]),
  platform_id: z.string().min(1),
  title: z.string().min(1),
  blurb: z.string(),
  cover: z.string().url().nullable(),
  url: z.string().url(),
  companies: z.array(z.object({ name: z.string().min(1), role: z.enum(["publisher", "platform_original", "producer", "rights_holder"]), evidence, via: z.string() })),
  audience: z.enum(["female", "male"]).nullable(),
  episode_count: z.number().int().nonnegative().nullable(),
  paywall_episode: z.number().int().positive().nullable(),
  episode_seconds: z.number().nonnegative().nullable(),
  episode_seconds_basis: z.enum(["episode_1", "listed_average"]).nullable(),
  released_at: isoDate.nullable(),
  platform_new: z.boolean(),
  platform_tags: z.array(z.string()),
  tropes: z.array(z.object({ id: z.string(), evidence: z.enum(["observed", "inferred"]), via: z.string() })),
  metrics: z.object({ views: observation.nullable(), saves: observation.nullable(), rating: observation.nullable() }),
  placements: z.array(z.object({ list: z.string(), name: z.string(), rank: z.number().int().nonnegative(), chart: z.boolean() })),
});

export const platformRunSchema = z.object({
  id: z.enum(["reelshort", "dramabox"]),
  status: z.enum(["ok", "partial", "stale", "failed"]),
  fetched_at: isoTimestamp,
  source_urls: z.array(z.string().url()),
  title_count: z.number().int().nonnegative(),
  with_views: z.number().int().nonnegative(),
  collection: z.object({ surface: z.literal("public_web"), locale: z.literal("en"), audience_geography: z.literal("unknown") }),
  detail_coverage: z.object({ requested: z.number().int(), fetched: z.number().int() }).nullable(),
  stale_from_run: z.string().nullable(),
  error: z.string().nullable(),
});

export const marketSnapshotSchema = z.object({
  schema_version: z.literal(SNAPSHOT_SCHEMA_VERSION),
  run_id: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/),
  observed_at: isoDate,
  taxonomy_version: z.string().min(1),
  platforms: z.array(platformRunSchema).min(1),
  titles: z.array(marketTitleSchema),
});

/** The pointer the loader follows: written only after a run validated. */
export type Publication = {
  latest_run_id: string;
  published_at: string;
  /** Per-day: the run that represents that observed_at date (the latest validated run of the day). */
  days: Record<string, string>;
  /** The most recent run that failed validation, kept for the Data & Sources page; never replaces data. */
  last_failure: { run_id: string; at: string; errors: string[] } | null;
};

export const publicationSchema = z.object({
  latest_run_id: z.string(),
  published_at: isoTimestamp,
  days: z.record(z.string()),
  last_failure: z.object({ run_id: z.string(), at: isoTimestamp, errors: z.array(z.string()) }).nullable(),
});

/** Minimum listings per platform for a run to count as complete for that platform. */
export const MIN_TITLES: Record<Platform, number> = { reelshort: 100, dramabox: 30 };

// ---- company-scoped records (phase 4) --------------------------------------------------

/** A listing the company watches. Scoped to the producer; never visible to another company. */
export type WatchRow = {
  producer_id: string;
  listing_key: string;
  created_by: string;
  created_at: string;
};

export type ReportMetric = "starts" | "views" | "completions" | "payers" | "revenue" | "spend" | "installs" | "impressions" | "clicks";

/** One row of a producer's imported report. Period, currency and metric are kept with the value. */
export type ReportRow = {
  id: string;
  batch_id: string;
  producer_id: string;
  /** Linked catalog title, when the report name matched one. */
  title_id: string | null;
  title_name: string;
  /** Free text as the report names it (ReelShort, YouTube, own app, ...). */
  platform: string;
  period_start: string;
  period_end: string;
  metric: ReportMetric;
  value: number;
  currency: string | null;
  /** 1-based row in the source file, for the error log. */
  source_row: number;
};

/** A reversible import batch. Reverting hides its rows; nothing is deleted. */
export type ReportBatch = {
  id: string;
  producer_id: string;
  filename: string;
  imported_at: string;
  imported_by: string;
  row_count: number;
  skipped_count: number;
  column_map: Record<string, string>;
  reverted_at: string | null;
};
