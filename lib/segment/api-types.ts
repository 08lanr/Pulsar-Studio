// The wire contract between the segmenting screens (task 2d) and the staff
// routes that serve them (task 2c) — decision 2026-09-23, "segment a film in
// Studio", plan B2/B3. One module, type-only for the replies (the served
// shapes are the ones `lib/segment/view.ts` builds; repeating them here
// would drift) and zod for the request bodies, kept in step with the routes'
// own parsers so a screen's body is exactly what a route accepts.
//
// Routes (staff only, same-origin guard, zod, JSON):
//   GET  /api/admin/films/sources?dir=<downloads|onedrive|workspace|path>&probe=1 → SourcesReply
//   POST /api/admin/films/runs                                                  → RunReply (201; NewRunBody; admin)
//   GET  /api/admin/films/runs[?producer_id=]                                   → RunsReply
//   GET  /api/admin/films/runs/[runId]                                          → RunDetailReply
//   POST /api/admin/films/runs/[runId]/decide                                   → RunReply (DecisionBody; admin; a refusal is 409 with the reason)
//   POST /api/admin/films/runs/[runId]/cancel                                   → RunReply
//   GET  /api/film-runs/[runId]/evidence/<review|index|work>/<path>.<png|json|mp4> → the file (Range honoured; a proxy is made on first request)
//
// Every image or clip URL a screen renders comes ready-made in the stage
// view (`strip_url`, `proxy_url`, `image_urls`, `sheets[].url`); a screen
// never composes an evidence path.

import { z } from "zod";
import type { FilmMetaForm } from "@/lib/segment/handoff";
import type { SourceEntry, SourceListing, SourceRoot } from "@/lib/segment/intake";
import type { BoundaryReview, BoundaryStatus, ReviewReason, ReviewState } from "@/lib/segment/plan";
import type { QaEpisode, QaReport } from "@/lib/segment/qa";
import type { Waiting } from "@/lib/segment/stages";
import type { BoundaryView, StageView } from "@/lib/segment/view";
import type { WorkflowRecord } from "@/lib/segment/vision";
import type { FilmRun, FilmRunMode } from "@/lib/types";

// ---- shared pieces ------------------------------------------------------------------------------------

/** The film folder name under its bucket (`lib/data/film-runs.ts` FILM_SLUG, repeated so this module stays dependency-free); one leading `_` marks a scratch folder. */
export const RUN_SLUG = /^_?[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** Buckets a run may be created in today: the cut-only route lives under `low-quality/`. */
export const RUN_BUCKETS = ["low-quality"] as const;

/** The modes the intake offers; `narrated` is shown disabled ("coming soon") and refused by both backends. */
export const RUN_MODES_OPEN = ["by_eye_2min", "source_episodes"] as const satisfies readonly FilmRunMode[];

// ---- GET /api/admin/films/sources -----------------------------------------------------------------------

export type SourcesReply = SourceListing;
export type { SourceEntry, SourceRoot };

// ---- POST /api/admin/films/runs -------------------------------------------------------------------------

/** `film_runs.settings` as the create route accepts it (its own `Settings` parser, mirrored). */
export const NewRunSettingsSchema = z
  .object({
    allow_dirty: z.boolean().optional(),
    no_delogo: z.boolean().optional(),
    target_s: z.number().positive().optional(),
    band: z.tuple([z.number().positive(), z.number().positive()]).optional(),
    threads: z.number().int().positive().optional(),
    /** Index only the first `to_s` seconds (the README's first proof, `--to 900`); null or absent = the whole film. */
    to_s: z.number().positive().nullish(),
    /** `x0,y0,x1,y1` fractions for watermark.py --region. */
    watermark_region: z.string().regex(/^\s*\d*\.?\d+\s*(,\s*\d*\.?\d+\s*){3}$/).nullish(),
    vision: z.enum(["api", "handoff"]).optional(),
    film_notes: z.string().max(2000).nullish(),
    /** The explicit claim of a film folder no Studio run made (B0); the intake refuses such a folder without it. */
    claim_existing: z.boolean().optional(),
    /** Cut the rest of a delivered film (a first proof) under its pinned episodes; a delivered film is refused at intake without it. */
    extend: z.boolean().optional(),
  })
  .strict();

export const NewRunBodySchema = z.object({
  /** The company the run (and later its title) belongs to. */
  producer_id: z.string().uuid(),
  source_path: z.string().trim().min(1).max(1024),
  bucket: z.enum(RUN_BUCKETS),
  slug: z.string().trim().regex(RUN_SLUG).max(80),
  mode: z.enum(RUN_MODES_OPEN),
  /** Whisper's `--lang`. */
  lang: z.string().trim().min(2).max(12).default("en"),
  settings: NewRunSettingsSchema.optional(),
});
export type NewRunBody = z.input<typeof NewRunBodySchema>;

export type RunReply = { run: FilmRun };
export type RunsReply = { runs: FilmRun[] };

// ---- POST /api/admin/films/runs/[runId]/decide ----------------------------------------------------------

/** A search region for a new watermark detection, as FRACTIONS of the frame (the route refuses anything outside 0..1). */
export const WatermarkRegionSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1) });
export type WatermarkRegion = z.infer<typeof WatermarkRegionSchema>;

export const FilmMetaExclusionSchema = z.object({ from_s: z.number().nonnegative(), to_s: z.number().nonnegative(), why: z.string().min(1), kind: z.string().nullish() });

export const BoundaryActionSchema = z.enum(["accept", "move", "reject", "remove"]);
export type BoundaryAction = z.infer<typeof BoundaryActionSchema>;

/** The decision bodies, one per `kind`, exactly as the decide route parses them. */
export const DecisionBodySchema = z.discriminatedUnion("kind", [
  /** One of `accept`, `region`, `no_delogo`. */
  z.object({ kind: z.literal("watermark"), accept: z.boolean().optional(), region: WatermarkRegionSchema.optional(), no_delogo: z.boolean().optional() }),
  z.object({ kind: z.literal("unmark"), action: z.enum(["find", "fit", "test", "edge_fill"]), boxes: z.string().nullish() }),
  /** Source-episodes mode: the film times of the "to be continued" cards to template from. */
  z.object({ kind: z.literal("cards"), templates: z.array(z.number().nonnegative()).min(1) }),
  /** `move` names `to_t` (a listed option or a legal cut within ±30 s); `reject` says why; `remove` is refused by the pipeline (a choice is needed for every open boundary). */
  z.object({ kind: z.literal("boundary"), boundary_s: z.number(), action: BoundaryActionSchema, to_t: z.number().nullish(), reason: z.string().max(2000).nullish() }),
  z.object({ kind: z.literal("apply_review") }),
  /** After the render: move the join after episode `join_index` (`cut_episodes.py --repin OLD=NEW`). */
  z.object({ kind: z.literal("join"), join_index: z.number().int().positive(), to_t: z.number(), reason: z.string().max(2000).nullish() }),
  z.object({
    kind: z.literal("film_meta"),
    display_title_en: z.string().trim().min(1).max(200),
    crazydramas_slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).nullish(),
    spoiler_from_s: z.number().nonnegative().nullish(),
    exclusions: z.array(FilmMetaExclusionSchema).optional(),
    live_poster: z.string().trim().max(200).nullish(),
  }),
  z.object({ kind: z.literal("import_now") }),
  /** Without `output_path`: hand the vision pass to Claude Code; with it: the Workflow's `.output` file to apply. */
  z.object({ kind: z.literal("handoff_vision"), output_path: z.string().trim().max(1024).nullish() }),
  /** A failed run goes back to the stage that failed. */
  z.object({ kind: z.literal("retry") }),
  z.object({ kind: z.literal("note"), text: z.string().trim().min(1).max(2000) }),
]);
export type DecisionBody = z.infer<typeof DecisionBodySchema>;
export type WatermarkDecision = Extract<DecisionBody, { kind: "watermark" }>;
export type BoundaryDecision = Extract<DecisionBody, { kind: "boundary" }>;
export type JoinDecision = Extract<DecisionBody, { kind: "join" }>;
export type FilmMetaDecision = Extract<DecisionBody, { kind: "film_meta" }>;

// ---- GET /api/admin/films/runs/[runId] ------------------------------------------------------------------

/** The run row plus the stage view `lib/segment/view.ts` builds from the film folder as it is. */
export type RunDetailReply = { run: FilmRun; stage_view: StageView };

/** The watermark part of the stage view, as `view.ts` builds it from `watermarkView()` plus the served URLs. */
export type WatermarkJson = {
  box: { x: number; y: number; w: number; h: number } | null;
  video: { w: number; h: number } | null;
  parts: number | null;
  /** `index/watermark-found.png`, `index/watermark-median.png`: the ones that exist, relative to `cut/`. */
  images: string[];
  /** The same files as URLs on the evidence route, in the same order. */
  image_urls: string[];
  unmark?: { found: string | null; fit: boolean; test: string | null };
  unmark_urls?: { found: string | null; test: string | null };
  review_error?: string;
};

export type { BoundaryReview, BoundaryStatus, BoundaryView, FilmMetaForm, QaEpisode, QaReport, ReviewReason, ReviewState, StageView, Waiting, WorkflowRecord };
