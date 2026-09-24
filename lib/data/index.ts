// The data layer both backends implement. Route handlers and server
// components call getData() and never know whether rows come from the
// in-memory fixture (DATA_SOURCE=fixture, the default: no Supabase project,
// no API key) or from the shared Supabase project under RLS.
//
// Every method takes the caller's Session first. In supabase mode RLS and the
// SECURITY DEFINER functions are the enforcement and the session is mostly
// informational; in fixture mode the same guards are re-implemented in TS so
// a route behaves identically (a producer cannot see a draft, a frozen
// version cannot be edited, an on-behalf approval needs an admin and a
// note). Failures are DataError (lib/data/errors.ts) with a code the route
// maps to a status.
//
// Composite return shapes are lib/types.ts; input shapes are defined here.
// Methods beyond the V1 contract's route list (writeFirstPass,
// setSceneContext, upsertCharacters, updateTitle, getExportSnapshot) exist
// because the AI routes and the export route need a write/read path the
// contract's method list left implicit.

import type { AnalyticsLink, AnalyticsListing, AnalyticsRange, AnalyticsWindow, TitleAnalytics, TitlePerformanceRow } from "@/lib/analytics/types";
import type { Session } from "@/lib/auth";
import type { CdPublicationUpdate, ClaimCdPublicationInput, NewCdPublicationInput } from "@/lib/crazydramas/ledger";
import type { NewPlatformLinkInput, NewPlatformSnapshotInput } from "@/lib/crazydramas/types";
import { dataSource } from "@/lib/data-source";
import type { IngestResult } from "@/lib/ingest";
import type { CatalogRow } from "@/lib/research/engine";
import type { MarketView } from "@/lib/research/snapshot";
import type { ReportBatch, ReportRow, ResearchProfile, WatchRow } from "@/lib/research/types";
import type { LaunchSettings } from "@/lib/tiktok/settings";
import type {
  AccountRequest,
  AdAngle,
  AdRules,
  CompanyAccount,
  FilmAsset,
  FilmAssetKind,
  FilmAssetOrigin,
  EpisodeGateCounts,
  EpisodePictureStage,
  EpisodeStage,
  EpisodeWordsStage,
  FilmRun,
  FilmRunDecision,
  FilmRunEpisode,
  FilmRunMode,
  FilmRunSettings,
  FilmRunStage,
  PlatformLink,
  PlatformName,
  PlatformSnapshot,
  CdPublication,
  CreativeResult,
  LaunchPreset,
  InstantPageTemplate,
  PromoLaunch,
  AdaptTag,
  AdaptedLine,
  AuditChannel,
  AuditEvent,
  AuthorKind,
  ChangeType,
  Character,
  Clip,
  ClipMoment,
  ClipRenderStatus,
  ClipSource,
  ClipStatus,
  Episode,
  FeedbackDisposition,
  Job,
  JobKind,
  JobStatus,
  JobUsage,
  Json,
  LineAlternative,
  Producer,
  PromoCampaign,
  PromoCampaignDetail,
  PromoCampaignSummary,
  PromoCreative,
  PromoCreativeStatus,
  ProducerReviewPayload,
  ProducerTitleSummary,
  Scene,
  SceneDecision,
  SceneDecisionKind,
  SceneStatus,
  ScriptFormat,
  Title,
  TitleDetail,
  TitleStatus,
  TitleSummary,
  TranslationMemoryExample,
  Variant,
  VariantKind,
  Version,
  VersionSnapshot,
  WorkbenchPayload,
} from "@/lib/types";

export { DataError, DATA_ERROR_STATUS, dataErrorStatus, isDataError } from "./errors";
export type { DataErrorCode } from "./errors";

// ---- inputs ----------------------------------------------------------------------------

export type CreateTitleInput = {
  name_zh: string;
  name_en?: string | null;
  producer_id: string;
  genre?: string | null;
  synopsis_zh?: string | null;
  synopsis_en?: string | null;
  character_notes?: string | null;
  /** Locale of the source script. The tables default to zh-CN; a workspace import says en-US. */
  source_locale?: string | null;
  /**
   * Who the adaptation records as its creator; the session's user when absent.
   * The system actor has no core.profiles row and adaptations.created_by is a
   * foreign key to it, so a job running as the system names the real caller
   * here (or the row keeps null).
   */
  created_by?: string | null;
};

export type UpdateTitleInput = Partial<
  Pick<
    Title,
    | "name_zh"
    | "name_en"
    | "genre"
    | "synopsis_zh"
    | "synopsis_en"
    | "character_notes"
    | "logline_zh"
    | "logline_en"
    | "localization_effort"
    | "episode_count"
    | "notes"
  >
> & { status?: TitleStatus };

export type CreateProducerInput = {
  name_zh: string;
  name_en?: string | null;
  contact_email?: string | null;
  contact_wechat?: string | null;
};

// ---- the workspace import (decision 2026-09-22; migration 0015) ----------------------------------

/** What the import creates a title from: a finished film of the pipeline. */
export type ImportedTitleInput = {
  producer_id: string;
  /** `<group>/<film>` under WORKSPACE_ROOT (`low-quality/mafia-king`); unique per producer — a second import is a conflict. */
  source_ref: string;
  /** The film's English display title: name_en, name_zh (the column is NOT NULL) and adaptations.display_title_en all carry it. */
  display_title_en: string;
  crazydramas_slug?: string | null;
  /** Storage path of the live poster (thumbnails only). */
  cover_path?: string | null;
  synopsis_en?: string | null;
  genre?: string | null;
  /** Who the adaptation records as its creator: the real caller when the job runs as the system actor. */
  created_by?: string | null;
  /** Locale of the film's dialogue, from the language the scan found (`sourceLocaleOf`); en-US when absent. */
  source_locale?: string | null;
};

/** Update mode: what a re-import may refresh on an imported title. A missing key is left alone. */
export type ImportedTitlePatch = {
  display_title_en?: string;
  crazydramas_slug?: string | null;
  cover_path?: string | null;
};

/**
 * The import fields of an episode (core.episodes, migration 0015). A missing
 * key is left alone; `video_path` travels with them so a new file and its
 * hash land in one write.
 */
export type EpisodeImportInput = {
  video_path?: string;
  source_ref?: string | null;
  /** 64 hex chars, or invalid. */
  video_sha256?: string | null;
  video_bytes?: number | null;
  video_frames?: number | null;
  film_start_ms?: number | null;
  film_end_ms?: number | null;
  end_note?: Json | null;
  /** False keeps the upload-time clip run away from the episode (the ad engine cuts it). */
  auto_cut?: boolean;
  /** The measured length of the file (ffprobe on the link), set before a transcript attaches so the last cue never stands in for it. */
  duration_ms?: number | null;
};

/** One pipeline file (or a Studio-made one) recorded beside an imported title. */
export type NewFilmAsset = {
  title_id: string;
  kind: FilmAssetKind;
  /** `local/<title_id>/ws/<slug>/<file>` for a linked workspace file; a bucket path for a Studio-made one. */
  storage_path: string;
  /** 64 hex chars, or invalid. */
  sha256: string;
  bytes: number;
  origin: FilmAssetOrigin;
  source_ref?: string | null;
  meta?: Json;
};

// ---- film runs (decision 2026-09-23, "segment a film in Studio"; migration 0016) ----------------

/** What intake records: the film, where it goes, how it is cut. Staff only (the phase is staff-gated). */
export type NewFilmRun = {
  producer_id: string;
  /** The source video as picked at intake (absolute path; stored with forward slashes). */
  source_path: string;
  /** The workspace bucket (`low-quality`) and the film folder (`she-returned-with-her-son`): the film is `<bucket>/<slug>`. */
  bucket: string;
  slug: string;
  /** `narrated` only in the `high-quality` bucket (amendment 4): both backends refuse it elsewhere (`invalid`). */
  mode: FilmRunMode;
  /** Whisper's `--lang`; `en` when absent. */
  lang?: string | null;
  settings?: FilmRunSettings | null;
  /** The first stage; `queued` when absent. */
  stage?: FilmRunStage;
  drama_remix_sha?: string | null;
  drama_remix_dirty?: boolean;
  title_id?: string | null;
};

/** A worker's claim on a run: the row's revision as it read it, its own name, and how long it wants. */
export type ClaimFilmRunInput = {
  owner: string;
  revision: number;
  /** Default ten minutes (FILM_RUN_LEASE_MS). */
  leaseMs?: number;
};

/** A stage write, revision-conditional; `owner` (the lease holder) makes a foreign live lease a conflict too. */
export type FilmRunStageInput = {
  stage: FilmRunStage;
  stage_detail?: Json;
  error_text?: string | null;
  revision: number;
  owner?: string;
  /** The drama-remix commit the scripts were synced from, recorded by the intake stage. */
  drama_remix_sha?: string | null;
  drama_remix_dirty?: boolean;
  title_id?: string | null;
};

/** A decision as the review screen records it; `at` and `by` are stamped by the data layer. */
export type NewFilmRunDecision = Omit<FilmRunDecision, "at" | "by"> & { by?: string };

export { FILM_RUN_LEASE_MS } from "./film-runs";

// ---- narrated episodes (decision 2026-09-23, "Narrated mode in Studio"; migration 0018) ----------------

/** One episode of an approved plan: its season number, its source window, its card. */
export type NewRunEpisode = {
  n: number;
  src_in: number;
  src_out: number;
  /** `EPISODE N` when absent. */
  title?: string | null;
  subtitle?: string | null;
  /** What the plan knew of it (the hook, the story paragraph the prep brief is filled with). */
  stage_detail?: Json;
};

/** The approved episode plan of a narrated run; `source_duration_s` (when known) bounds every window. */
export type CreateRunEpisodesInput = {
  series_key: string;
  episodes: NewRunEpisode[];
  source_duration_s?: number | null;
};

/** An episode write, revision-conditional; `owner` (the lease holder) makes a foreign live lease a conflict too. Absent fields are left alone. */
export type RunEpisodeStageInput = {
  revision: number;
  owner?: string;
  words_stage?: EpisodeWordsStage;
  picture_stage?: EpisodePictureStage;
  stage?: EpisodeStage;
  stage_detail?: Json;
  error_text?: string | null;
  variant?: string | null;
  gate?: EpisodeGateCounts | null;
  body_sha256?: string | null;
  shipped_sha256?: string | null;
  title?: string;
  subtitle?: string | null;
  /** true stamps approved_by (the session, or `approved_by`) and approved_at; false clears both (a send-back after the final watch). */
  approved?: boolean;
  approved_by?: string;
};

export { RUN_EPISODE_LEASE_MS } from "./film-runs";

// ---- platform links and snapshots (decision 2026-09-23, "the crazydramas connection"; migration 0017) ----

/** The link the first 200 read makes: which drama on the platform the title is. */
export type NewPlatformLink = NewPlatformLinkInput;

/** One public read of one slug, as the sweep or Check now records it; validated by lib/crazydramas/types.ts platformSnapshotRow. */
export type NewPlatformSnapshot = NewPlatformSnapshotInput;

export { PLATFORM_SNAPSHOTS_KEEP } from "@/lib/crazydramas/types";

// ---- the crazydramas ledger (phase 5, "Upload to crazydramas"; migration 0019) ----

/** One episode's planned upload; validated by lib/crazydramas/ledger.ts cdPublicationRow. */
export type NewCdPublication = NewCdPublicationInput;
export type { CdPublicationUpdate, ClaimCdPublicationInput };
export { CD_LEASE_MS } from "@/lib/crazydramas/ledger";

/** Storage paths (lib/data/storage.ts) of what the ingest route stored; both optional. */
export type IngestFiles = {
  subtitlePath: string | null;
  videoPath: string | null;
};

/** Staff hand edit (PATCH .../lines/[id]); also what a rewrite job writes with `UpdateLineOptions`. */
export type AdaptedLinePatch = Partial<
  Pick<
    AdaptedLine,
    | "text_en"
    | "key_phrase_en"
    | "back_translation_zh"
    | "rationale_en"
    | "rationale_zh"
    | "tone_note_en"
    | "tone_note_zh"
    | "tags"
    | "change_type"
    | "is_major"
    | "syllables_est"
  >
>;

/**
 * Default (no options) is a hand edit: authored_by flips to 'editor', the
 * ai_* columns stay. A rewrite job passes authored_by 'ai' with its model
 * and prompt_version so the chip stays honest.
 */
export type UpdateLineOptions = {
  authored_by?: AuthorKind;
  model?: string | null;
  prompt_version?: string | null;
};

export type NewAlternative = {
  text_en: string;
  back_translation_zh?: string | null;
  rationale_zh: string;
  rationale_en?: string | null;
  tags?: AdaptTag[];
  syllables_est?: number | null;
  model: string;
  prompt_version: string;
  job_id?: string | null;
};

/** One source line's first pass: the literal baseline plus the adapted row. */
export type FirstPassLine = {
  line_id: string;
  literal_en: string | null;
  text_en: string | null;
  key_phrase_en?: string | null;
  back_translation_zh: string | null;
  change_type: ChangeType;
  is_major: boolean;
  rationale_en: string | null;
  rationale_zh: string | null;
  tone_note_en?: string | null;
  tone_note_zh?: string | null;
  tags?: AdaptTag[];
  syllables_est?: number | null;
  model: string;
  prompt_version: string;
};

export type NewCharacter = {
  name_zh: string;
  name_en?: string | null;
  notes?: string | null;
};

export type NewVariant = {
  kind: VariantKind;
  text_en: string;
  text_zh?: string | null;
  rationale_en?: string | null;
  rationale_zh?: string | null;
  tags?: AdAngle[];
  /** null model = typed in by staff (created_by is then the session). */
  model?: string | null;
  prompt_version?: string | null;
  job_id?: string | null;
};

export type NewClip = {
  /** Preferred rank; the next free rank is used when a kept row holds it. */
  rank?: number;
  start_ms: number;
  end_ms: number;
  scene_ids: string[];
  hook_en: string;
  why_en: string;
  why_zh: string;
  opening_text_en?: string | null;
  cut_length_s?: number | null;
  angle?: AdAngle | null;
  model?: string | null;
  prompt_version?: string | null;
  job_id?: string | null;
  /** Defaults: script / peak / none (decision 2026-09-14). */
  source?: ClipSource;
  moment?: ClipMoment;
};

/** The finished (or failed) 9:16 file of an auto-cut clip. */
export type ClipRenderInput = {
  render_status: ClipRenderStatus;
  render_path?: string | null;
  render_sha256?: string | null;
  render_note?: string | null;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
};

/**
 * A finished ad file the partner supplied (decision 2026-09-24). The bytes are
 * stored and hashed exactly as delivered and never re-encoded, so a graded ad
 * keeps its own framing and quality. Created 'shortlisted' and 'rendered' by
 * the data layer, so a later re-cut (which replaces 'suggested' rows) can
 * never delete it.
 */
export type UploadedClipInput = {
  render_path: string;
  /** Over the exact bytes stored; the launch path re-verifies it before upload. */
  render_sha256: string;
  hook_en: string;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
};

export type NewJob = {
  kind: JobKind;
  title_id: string | null;
  episode_id?: string | null;
  version_id?: string | null;
  target_type: string;
  target_id: string;
  idempotency_key: string;
  provider?: string | null;
  model?: string | null;
  input?: Json | null;
};

export type JobResult = {
  status: Extract<JobStatus, "done" | "failed" | "cancelled">;
  usage?: JobUsage | null;
  cost_cents?: number | null;
  output?: Json | null;
  error?: string | null;
};

/** What the brief form posts for the structured experiment record. */
export type ExperimentInput = {
  budget_usd: number;
  hypothesis: string;
  audience: string;
  first_batch: number;
  signal: "views" | "clicks" | "landing";
};

export type CompanyAccountInput = {
  id?: string;
  provider: CompanyAccount["provider"];
  kind: CompanyAccount["kind"];
  name: string;
  external_ref?: string | null;
  state: CompanyAccount["state"];
  access: CompanyAccount["access"];
  note?: string | null;
};

export type CreatePromoCampaignInput = {
  title_id: string;
  name: string;
  target_market: string;
  destination_url?: string | null;
  objective: PromoCampaign["objective"];
  spoiler_level: PromoCampaign["spoiler_level"];
  creative_direction?: string | null;
  exclusions?: string | null;
  experiment?: ExperimentInput | null;
};

/** `ready` puts a chosen creative back (unselect) so the pick can fit the budget. */
export type PromoCreativeReviewInput = {
  status: Extract<PromoCreativeStatus, "approved" | "rejected" | "ready">;
  rejection_note?: string | null;
};

/** Staff answer to a producer's change request: a new creative version. */
export type RevisePromoCreativeInput = {
  hypothesis?: string | null;
  hook: string;
  caption: string;
  ad_description: string;
  source_start_ms?: number | null;
  source_end_ms?: number | null;
  revision_note?: string | null;
};

/** Staff override of a campaign's launch status (troubleshooting only; the engine and the scheduler write the normal path). */
export type AdvancePromoCampaignInput = {
  status: Extract<PromoCampaign["status"], "launching" | "live" | "failed">;
  grow_campaign_id?: string | null;
  note?: string | null;
};

// ---- TikTok launch (decision 2026-09-09) --------------------------------------------------------

/** What the launch engine records after a step. Only the system session may write these. */
export type PromoLaunchPatch = Partial<
  Pick<PromoLaunch, "status" | "identity_id" | "identity_type" | "uploaded_videos" | "covers" | "tiktok_campaign_id" | "tiktok_adgroup_id" | "ad_ids" | "paused" | "bid_usd" | "schedule_end" | "duplicates" | "retired_adgroups" | "duplicated_at" | "activated_at" | "error" | "attempts" | "started_at" | "heartbeat_at" | "finished_at">
>;

/** The scheduler's and the engine's view of a launched campaign. */
export type LaunchedCampaign = {
  campaign: PromoCampaign;
  launch: PromoLaunch;
  /** The creatives that became ads (approved in the manifest). */
  creatives: PromoCreative[];
};

/**
 * What a control records after TikTok accepted it (decision 2026-09-16):
 * the new signed budget, the cap, the schedule end, the copies made and the
 * groups retired. Staff or the company's approver; the system for the
 * auto-duplicate pass. Never the write-once creation ids.
 */
export type LaunchChangeInput = {
  budget_usd?: number;
  daily_budget_usd?: number;
  bid_usd?: number | null;
  schedule_end?: string | null;
  duplicates?: Record<string, string[]>;
  retired_adgroups?: string[];
  duplicated_at?: string | null;
  activated_at?: string | null;
  paused?: boolean;
  note?: string | null;
};

export type LaunchPresetInput = {
  id?: string;
  name: string;
  settings: LaunchSettings;
  note?: string | null;
};

export type InstantPageTemplateInput = { id?: string; name: string; button_text: string; background: "white" | "black"; hand_cursor: boolean };

/** The engine and the scheduler move a campaign along TikTok's lifecycle; staff may pause/resume. */
export type DeliveryInput = {
  status: Extract<PromoCampaign["status"], "launching" | "submitted" | "live" | "paused" | "ended" | "failed">;
  status_note?: string | null;
  grow_campaign_id?: string | null;
  tiktok_adgroup_id?: string | null;
  advertiser_id?: string | null;
  launched_at?: string | null;
};

/** One creative's numbers for one window, as read from a reporting source. Upserted on (creative, window, source). */
export type NewCreativeResult = Omit<CreativeResult, "id">;

export type RenderInput = {
  render_path: string;
  render_sha256: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  render_settings?: Json;
};

/** Staff assign a Business Center to a producer: launches pick a ready account inside it. */
export type AssignBusinessCenterInput = {
  bc_id: string;
  name: string;
  note?: string | null;
  request_id?: string | null;
};

/** The account the launch resolved for this campaign (lib/tiktok/business-centers.ts pickLaunchAccount). */
export type ResolvedLaunchAccount = {
  advertiser_id: string;
  identity_id: string;
  identity_type: "BC_AUTH_TT" | "TT_USER";
  source: "account" | "business_center";
  bc_id: string | null;
};

/** Staff assign a launch account from Pulsar's Business Center to a producer (explicit override of the BC pick). */
export type AssignLaunchAccountInput = {
  advertiser_id: string;
  name: string;
  identity_id: string | null;
  identity_type: "BC_AUTH_TT" | "TT_USER" | null;
  note?: string | null;
  /** Which request this fulfils, if any; it is marked assigned. */
  request_id?: string | null;
};

export type AccountRequestInput = {
  contact_name: string;
  contact_email: string;
  /** Mock opt-in only: never a card number. */
  payment?: { brand: string; last4: string; holder: string } | null;
  note?: string | null;
};

export type ResolveAccountRequestInput = {
  status: Extract<AccountRequest["status"], "provisioning" | "declined">;
  staff_note?: string | null;
};

export type ApproveOptions = {
  /** 'producer' = the partner in their portal (SQL in_app); 'on_behalf' = staff admin with evidence. */
  mode: "producer" | "on_behalf";
  evidenceNote?: string | null;
  note?: string | null;
  channel?: AuditChannel;
};

/** What the onboarding form posts; `updated_at` is stamped by the data layer. */
export type ResearchProfileInput = Omit<ResearchProfile, "updated_at">;

export type CatalogForMatching = {
  rows: CatalogRow[];
  total: number;
  truncated: boolean;
};

export type CommitReportInput = {
  filename: string;
  column_map: Record<string, string>;
  rows: Omit<ReportRow, "id" | "batch_id" | "producer_id">[];
  skipped_count: number;
};

/** Title analytics reads (lib/analytics): the range is bookmarkable; `today` is a test hook (fixture mode uses the demo clock). */
export type AnalyticsOptions = { range?: AnalyticsRange; today?: string; /** An explicit from/to window; when set the record's range is "custom". */ window?: AnalyticsWindow | null };

export type ExportSource = "approved" | "in_review" | "draft";

/** What GET /api/titles/[id]/export renders from; `source` goes in the file header. */
export type ExportSnapshot = {
  version: Version;
  snapshot: VersionSnapshot;
  source: ExportSource;
  /** The stored hash for frozen versions; null for a live draft snapshot. */
  sha256: string | null;
};

// ---- the interface ------------------------------------------------------------------------

export interface DataLayer {
  // titles and producers (staff)
  listTitles(session: Session): Promise<TitleSummary[]>;
  getTitle(session: Session, titleId: string): Promise<TitleDetail>;
  createTitle(session: Session, input: CreateTitleInput): Promise<Title>;
  /**
   * The edit check on its own — staff, the system actor, or the title's own
   * approver/reviewer — so a route can refuse BEFORE it writes to storage. A
   * foreign title is not found, a viewer is forbidden: the same answers every
   * write below gives (requireTitleEditor / core.can_edit_title).
   */
  assertTitleEditable(session: Session, titleId: string): Promise<Title>;
  updateTitle(session: Session, titleId: string, patch: UpdateTitleInput): Promise<Title>;
  listProducers(session: Session): Promise<Producer[]>;
  createProducer(session: Session, input: CreateProducerInput): Promise<Producer>;

  // ingest and the workbench (staff)
  addEpisodeFromIngest(
    session: Session,
    titleId: string,
    episodeNumber: number,
    ingest: IngestResult,
    files: IngestFiles
  ): Promise<Episode>;
  /**
   * Promote intake: register a shared episode master before any subtitle/script
   * exists. The workspace import passes its fields (`imported`) so the row is
   * born with its hash, its film window and auto_cut false, in one write —
   * with `imported`, staff or the system only (both backends; 0015 grants a
   * producer session none of those columns on insert).
   */
  addVideoOnlyEpisode(session: Session, titleId: string, episodeNumber: number, videoPath: string, imported?: EpisodeImportInput): Promise<Episode>;
  /**
   * Attach a parsed script to an EXISTING episode that has none yet (the
   * video came first; the transcribe run or a later subtitle upload fills
   * it). Writes scenes + lines + the cost-0 parse job and opens the draft
   * version exactly like addEpisodeFromIngest; refuses an episode that
   * already has lines — a script is never silently replaced.
   * `scriptFormat` overrides the parsed format ('asr' for transcriptions).
   */
  attachIngestToEpisode(
    session: Session,
    titleId: string,
    episodeNumber: number,
    ingest: IngestResult,
    files: { subtitlePath: string | null; scriptFormat?: ScriptFormat }
  ): Promise<Episode>;
  getWorkbench(session: Session, titleId: string, episodeNumber: number): Promise<WorkbenchPayload>;
  /** Studio-wide approved bilingual pairs; server-only prompt context, never a route payload. */
  listApprovedTranslationMemory(session: Session, titleId: string): Promise<TranslationMemoryExample[]>;
  upsertCharacters(session: Session, titleId: string, characters: NewCharacter[]): Promise<Character[]>;
  setSceneContext(
    session: Session,
    sceneId: string,
    context: { context_zh: string | null; context_en: string | null }
  ): Promise<Scene>;
  writeFirstPass(session: Session, versionId: string, sceneId: string, lines: FirstPassLine[]): Promise<AdaptedLine[]>;
  updateAdaptedLine(
    session: Session,
    adaptedLineId: string,
    patch: AdaptedLinePatch,
    opts?: UpdateLineOptions
  ): Promise<AdaptedLine>;
  addAlternatives(session: Session, adaptedLineId: string, alternatives: NewAlternative[]): Promise<LineAlternative[]>;
  chooseAlternative(session: Session, adaptedLineId: string, alternativeId: string): Promise<AdaptedLine>;
  setSceneStatus(session: Session, sceneId: string, status: SceneStatus): Promise<Scene>;
  /**
   * Point the episode at a (new) stored video (attach or replace). Conflict
   * on an imported episode (`source_ref` set): its file, hash, frame count,
   * film window and end note describe the workspace snapshot, so the film is
   * updated through the import instead, never one episode's file by hand.
   */
  setEpisodeVideo(session: Session, titleId: string, episodeNumber: number, storedPath: string): Promise<Episode>;

  // the workspace import (decision 2026-09-22; migration 0015). The job runs as
  // the system actor; the same calls work for a title editor's own session.
  /**
   * The producer's title for a film, or null. Staff and the system name any
   * producer; a producer only their own company — another company's title
   * reads null, never forbidden.
   */
  findTitleBySourceRef(session: Session, producerId: string, sourceRef: string): Promise<Title | null>;
  /**
   * A title for an imported film: source_locale from the input (en-US when
   * absent), name_en and name_zh both the display title (name_zh is NOT
   * NULL), the adaptation's display_title_en the same, plus the slug, the
   * cover and the source_ref.
   * Conflict when the producer already has a title for that source_ref. The
   * same rights as createTitle (a producer creates under their own company).
   */
  createImportedTitle(session: Session, input: ImportedTitleInput): Promise<Title>;
  /** Update mode: refresh the display title, slug or cover of an imported title. Title editors; a foreign title is not found. */
  setTitleImport(session: Session, titleId: string, patch: ImportedTitlePatch): Promise<Title>;
  /** Title editors or the system: the ad engine's rules for the title (the spoiler line, the exclusions), replaced whole. */
  setTitleAdRules(session: Session, titleId: string, rules: AdRules): Promise<Title>;
  /**
   * The import fields of an episode (and, with them, a new file): the sha256
   * must be hex, auto_cut false keeps the upload-time clip run away. Staff or
   * the system only, in both backends (a producer session could otherwise
   * forge the hash, the window or auto_cut the ad engine trusts; 0015 grants
   * it none of these columns); a foreign title's episode is not found.
   */
  setEpisodeImport(session: Session, episodeId: string, patch: EpisodeImportInput): Promise<Episode>;
  /** Every recorded file of the title, newest first; readable by whoever can read the title (a foreign title is not found). */
  listFilmAssets(session: Session, titleId: string): Promise<FilmAsset[]>;
  /**
   * Append-only and idempotent: a row already recorded for (title, kind,
   * sha256) is returned as is, so a resumed import never duplicates one.
   * System, staff or a title editor; in supabase mode the insert goes through
   * the service role after the edit check (the table takes no session writes).
   */
  putFilmAsset(session: Session, input: NewFilmAsset): Promise<FilmAsset>;
  /** Repair a pre-2026-09-05 ingest: lift [hh:mm:ss] stamps trapped in the
   * line text into real timecodes and mark the episode timed. */
  retimeEpisodeFromStamps(session: Session, titleId: string, episodeNumber: number): Promise<{ timed: number }>;
  /** Shift every timed cue of the episode by offsetMs (lib/subtitle-timing
   * rules: clamp at 0, keep durations, trim introduced overlaps). Draft
   * adapted rows mirror their lines; frozen snapshots are the route's job. */
  applyEpisodeTimingOffset(
    session: Session,
    titleId: string,
    episodeNumber: number,
    offsetMs: number
  ): Promise<{ shifted: number; clamped: number }>;
  /** Millisecond-precise edits to individual cues (validated per cue). */
  updateLineTimings(
    session: Session,
    titleId: string,
    episodeNumber: number,
    updates: { line_id: string; start_ms: number; end_ms: number }[]
  ): Promise<{ updated: number }>;

  // the gate
  submitVersion(session: Session, versionId: string): Promise<Version>;
  /**
   * The self-serve gate: the title's producer (approver role) freezes AND
   * approves their own draft in one action — snapshot + sha256, per-scene
   * sign-off rows, previous approved version superseded. Guards: every scene
   * confirmed and ready. Staff are refused (they submit + approve on behalf).
   */
  finalizeVersion(session: Session, versionId: string): Promise<Version>;
  approveVersion(session: Session, versionId: string, opts: ApproveOptions): Promise<Version>;
  forkVersion(session: Session, versionId: string): Promise<Version>;
  decideScene(
    session: Session,
    versionId: string,
    sceneId: string,
    decision: SceneDecisionKind,
    note?: string | null,
    lineId?: string | null
  ): Promise<SceneDecision>;
  respondToFeedback(
    session: Session,
    versionId: string,
    sceneId: string,
    disposition: FeedbackDisposition,
    note: string
  ): Promise<SceneDecision>;

  // creative pack (staff)
  listVariants(session: Session, titleId: string): Promise<Variant[]>;
  /** Appends a batch; returns every variant of the title afterwards. */
  upsertVariants(session: Session, titleId: string, variants: NewVariant[]): Promise<Variant[]>;
  selectVariant(session: Session, variantId: string): Promise<Variant>;
  dismissVariant(session: Session, variantId: string, dismissed?: boolean): Promise<Variant>;
  listClips(session: Session, titleId: string, episodeNumber?: number): Promise<Clip[]>;
  /** Replaces the episode's `suggested` rows, keeps shortlisted / dismissed; returns the episode's clips. Needs a timed episode or one with video. */
  upsertClips(session: Session, episodeId: string, clips: NewClip[]): Promise<Clip[]>;
  setClipStatus(session: Session, clipId: string, status: ClipStatus): Promise<Clip>;
  // auto-cut ad clips (decision 2026-09-14): readable by the title's producer; a foreign title is not found.
  listEpisodeClips(session: Session, titleId: string, episodeNumber?: number): Promise<Clip[]>;
  /** System, staff or a title editor: the clip's finished file (or why there is none). */
  setClipRender(session: Session, clipId: string, render: ClipRenderInput): Promise<Clip>;
  /** File a partner-supplied finished ad under an episode as a launchable clip. Staff / system actor only. */
  addUploadedClip(session: Session, episodeId: string, input: UploadedClipInput): Promise<Clip>;

  // jobs and cost
  /** Idempotent: an existing 'done' row for the key is returned as is (callers check status). */
  recordJob(session: Session, job: NewJob): Promise<Job>;
  /** The session is the one that recorded the job: the system actor's rows are written through the service role. */
  finishJob(session: Session, jobId: string, result: JobResult): Promise<Job>;
  /** The newest job of a kind on an episode (any status), or null; readable by whoever can read the title. */
  latestEpisodeJob(session: Session, titleId: string, episodeNumber: number, kind: JobKind): Promise<Job | null>;
  /** A long run says it is still alive (lib/clips/state.ts treats a quiet heartbeat as a dead run). */
  heartbeatJob(session: Session, jobId: string): Promise<void>;
  /**
   * The newest job (any status) on a target that is not an episode — a film
   * run's `segment_film` job, keyed by `target_type` / `target_id` — or null.
   * Staff or the system only: a job row is Pulsar's spend record.
   */
  latestJobByTarget(session: Session, targetType: string, targetId: string, kind?: JobKind): Promise<Job | null>;
  sumCostCents(titleId: string): Promise<number>;

  // film runs (decision 2026-09-23; migration 0016). Staff-gated for now: staff
  // and the system read and write every run; a producer session reads its own
  // company's runs (RLS) and writes nothing. Refusals are the same in both
  // backends: a foreign run is not_found, a producer write is forbidden, a
  // stale revision is conflict, `narrated` outside the high-quality bucket is invalid.
  /** Staff or the system: the row intake writes. `stage` defaults to `queued`, `settings` to `{}`, `lang` to `en`. */
  createFilmRun(session: Session, input: NewFilmRun): Promise<FilmRun>;
  getFilmRun(session: Session, runId: string): Promise<FilmRun>;
  /** Newest first. Staff: every company's, or one with `producerId`; a producer: their own company's only (another company's `producerId` reads empty). */
  listFilmRuns(session: Session, opts?: { producerId?: string }): Promise<FilmRun[]>;
  /**
   * A worker takes the run: succeeds only when `revision` is still the row's
   * (CAS) and no OTHER owner holds a live lease; then `lease_owner` /
   * `leased_until` (ten minutes) are set and the revision bumps. Null when
   * the race was lost (the revision moved or another live lease holds the
   * row) — never a throw for that, so the worker can move on. Staff or the system.
   */
  claimFilmRun(session: Session, runId: string, input: ClaimFilmRunInput): Promise<FilmRun | null>;
  /** The lease holder extends its lease without touching the revision; conflict when `owner` does not hold the lease. */
  renewFilmRunLease(session: Session, runId: string, input: { owner: string; leaseMs?: number }): Promise<FilmRun>;
  /**
   * Move the run to a stage, revision-conditionally: conflict when `revision`
   * is not the row's (someone wrote since — re-read and decide again) or when
   * `owner` is given and another live lease holds the row. `error_text` is
   * kept as given (null clears it); the revision bumps.
   */
  setFilmRunStage(session: Session, runId: string, input: FilmRunStageInput): Promise<FilmRun>;
  /** Staff or the system: append one decision (stamped `at` now, `by` the session unless given); the revision bumps. */
  appendFilmRunDecision(session: Session, runId: string, decision: NewFilmRunDecision): Promise<FilmRun>;
  /** The lease holder (or anyone once it expired) gives the run back: lease cleared, revision bumped. Conflict when another live lease holds it. */
  releaseFilmRun(session: Session, runId: string, input: { owner: string }): Promise<FilmRun>;

  // narrated episodes (decision 2026-09-23 "Narrated mode in Studio"; migration 0018). Staff only
  // in both backends: staff and the system read and write; a producer session reads no rows (its own
  // run's list is empty, one episode is not_found, as RLS answers) and writes nothing (forbidden); a
  // foreign run is not_found. The same refusals in both: a run that
  // is not narrated, or already has episode rows, is invalid / conflict; a number another live run
  // of the season holds is conflict; a stale revision or a foreign live lease is conflict.
  /** Staff or the system: the approved plan's rows, all at once (born `lanes` / words `prep` / picture `waiting`, revision 1). */
  createRunEpisodes(session: Session, runId: string, input: CreateRunEpisodesInput): Promise<FilmRunEpisode[]>;
  /** A run's episodes by number; [] for a run with none. */
  listRunEpisodes(session: Session, runId: string): Promise<FilmRunEpisode[]>;
  getRunEpisode(session: Session, episodeId: string): Promise<FilmRunEpisode>;
  /** A lane takes the episode: a CAS on `revision` plus a ten-minute lease; null when the race was lost. */
  claimRunEpisode(session: Session, episodeId: string, input: ClaimFilmRunInput): Promise<FilmRunEpisode | null>;
  renewRunEpisodeLease(session: Session, episodeId: string, input: { owner: string; leaseMs?: number }): Promise<FilmRunEpisode>;
  /** Move a lane, the joined stage or the build facts, revision-conditionally (audited when a stage, the refusal, the variant or the approval moved). */
  setRunEpisodeStage(session: Session, episodeId: string, input: RunEpisodeStageInput): Promise<FilmRunEpisode>;
  releaseRunEpisode(session: Session, episodeId: string, input: { owner: string }): Promise<FilmRunEpisode>;

  // platform links and snapshots (decision 2026-09-23, "the crazydramas
  // connection"; migration 0017). Public facts read back from a consumer
  // platform: producers read the rows of their own titles (can_read_title), a
  // series that matches no title is staff's to see, and every write is the
  // system's (the sweep, Check now, the after-import check) or staff's. The
  // same refusals in both backends: a foreign title is not_found, a producer
  // write is forbidden, a bad slug or body is invalid, a drama id already
  // linked to another title is a conflict.
  /** The title's link on the platform, or null; whoever reads the title (a foreign title is not found). */
  getPlatformLink(session: Session, titleId: string, platform: PlatformName): Promise<PlatformLink | null>;
  /** Staff and the system: every link on the platform; a producer: their own titles'. */
  listPlatformLinks(session: Session, platform: PlatformName): Promise<PlatformLink[]>;
  /**
   * System or staff: create the title's link, or move it to another drama id
   * / slug (one link per title × platform). A drama id already linked to a
   * different title is a conflict — one title per drama.
   */
  upsertPlatformLink(session: Session, input: NewPlatformLink): Promise<PlatformLink>;
  /** System or staff: append one read; the row is the record of the check (there is no job kind for a public GET). */
  recordPlatformSnapshot(session: Session, input: NewPlatformSnapshot): Promise<PlatformSnapshot>;
  /**
   * The reads of one slug, newest first, at most `limit` (PLATFORM_SNAPSHOTS_KEEP):
   * staff and the system every row, a producer the rows of their own titles
   * (an unmatched slug's rows read empty, never forbidden).
   */
  listPlatformSnapshots(session: Session, platform: PlatformName, slug: string, opts?: { limit?: number }): Promise<PlatformSnapshot[]>;
  /** The newest read per slug the session may read (the staff mirror's "unmatched" list is the rows with no title). */
  listLatestPlatformSnapshots(session: Session, platform: PlatformName): Promise<PlatformSnapshot[]>;
  /** System or staff: keep the newest `keep` rows per slug (PLATFORM_SNAPSHOTS_KEEP); answers how many went. */
  prunePlatformSnapshots(session: Session, platform: PlatformName, keep?: number): Promise<number>;
  /** The titles carrying a slug on the platform (`crazydramas_slug`), the ones the session may read: staff and the system every company's, a producer their own. */
  listTitlesWithPlatformSlug(session: Session, platform: PlatformName): Promise<Title[]>;
  /** The full episode rows of a title by number (the import fields included), for whoever reads the title; a foreign title is not found. */
  listTitleEpisodes(session: Session, titleId: string): Promise<Episode[]>;

  // the crazydramas ledger (phase 5, "Upload to crazydramas"; migration 0019).
  // What Studio uploaded to crazydramas, one row per title × episode × file.
  // Producers read the rows of their own titles (can_read_title); every write
  // is the system's or staff's, revision-conditional (CAS) and, for a worker,
  // under a ten-minute lease (lib/crazydramas/ledger.ts holds the rules both
  // backends apply). The same refusals in both: a foreign title or row is
  // not_found, a producer write is forbidden, a bad field is invalid, a stale
  // revision, a foreign live lease or a second active row per episode is a
  // conflict — as is the same file already on crazydramas.
  /** Every ledger row of the title, by episode number then oldest first; whoever reads the title. */
  getCdPublications(session: Session, titleId: string): Promise<CdPublication[]>;
  /** One row; not found when the session cannot read its title. */
  getCdPublication(session: Session, id: string): Promise<CdPublication>;
  /** System or staff: every row still in an active step (planned … asset_ready), every title — the resume sweep and the machine-wide slot count. */
  listActiveCdPublications(session: Session): Promise<CdPublication[]>;
  /** System or staff: plan one episode's upload (step `planned`). */
  createCdPublication(session: Session, input: NewCdPublication): Promise<CdPublication>;
  /** System or staff: a revision-conditional write of the step and its facts (audited when the step leaves the uploader's own steps). */
  updateCdPublication(session: Session, id: string, input: CdPublicationUpdate): Promise<CdPublication>;
  /** A worker takes the row: CAS on `revision` plus a ten-minute lease (a stale one is adopted); null when the race was lost. */
  claimCdPublication(session: Session, id: string, input: ClaimCdPublicationInput): Promise<CdPublication | null>;
  renewCdPublicationLease(session: Session, id: string, input: { owner: string; leaseMs?: number }): Promise<CdPublication>;
  /** Let the lease go (a no-op when `owner` does not hold it). */
  releaseCdPublication(session: Session, id: string, input: { owner: string }): Promise<CdPublication>;
  /** System or staff: a person's Stop — flags a running row, fails one nobody runs; a no-op on a row past its bytes. */
  requestCdPublicationCancel(session: Session, id: string): Promise<CdPublication>;

  // partner portal
  getProducerTitles(session: Session): Promise<ProducerTitleSummary[]>;
  getProducerReview(session: Session, titleId: string, episodeNumber: number): Promise<ProducerReviewPayload>;

  // Promote (producer-facing sibling product; shares only core titles/episodes)
  listPromoCampaigns(session: Session): Promise<PromoCampaignSummary[]>;
  getPromoCampaign(session: Session, campaignId: string): Promise<PromoCampaignDetail>;
  createPromoCampaign(session: Session, input: CreatePromoCampaignInput): Promise<PromoCampaign>;
  /** One ready creative per finished auto-cut clip of the title; review opens at once. Refuses (conflict, NO_CLIPS_MESSAGE) when the title has no finished clip. */
  generatePromoDrafts(session: Session, campaignId: string): Promise<PromoCreative[]>;
  /** Round in review: ready creatives for finished clips the round does not carry yet; returns only the new rows. */
  appendPromoDraftsFromClips(session: Session, campaignId: string): Promise<PromoCreative[]>;
  reviewPromoCreative(session: Session, creativeId: string, input: PromoCreativeReviewInput): Promise<PromoCreative>;
  /** Producer editor: the TikTok ad text (the hook) of a creative still in review; frozen once the round is approved. */
  setPromoCreativeText(session: Session, creativeId: string, hook: string): Promise<PromoCreative>;
  /** Producer keeps every creative still waiting for a decision. */
  approveAllPromoCreatives(session: Session, campaignId: string): Promise<PromoCampaignDetail>;
  approvePromoCampaign(session: Session, campaignId: string): Promise<PromoCampaignDetail>;
  /**
   * Producer approver: launch the approved manifest. Gates on the approved
   * budget, a destination URL, rendered creatives (live modes) and a ready
   * launch account; records one launch row per manifest (idempotent — a
   * retry returns the same row) and moves the campaign to `launching`. The
   * route then runs the engine (lib/tiktok/launch.ts).
   */
  submitPromoCampaign(session: Session, campaignId: string, resolved?: ResolvedLaunchAccount | null): Promise<PromoCampaignDetail>;
  // Pulsar's Promote desk (staff only): answer change requests; override launch status when troubleshooting.
  revisePromoCreative(session: Session, creativeId: string, input: RevisePromoCreativeInput): Promise<PromoCreative>;
  advancePromoCampaign(session: Session, campaignId: string, input: AdvancePromoCampaignInput): Promise<PromoCampaignDetail>;

  // TikTok launch, review and read-back (decision 2026-09-09). The system
  // session (lib/auth.ts systemSession) is the engine and the scheduler.
  getPromoLaunch(session: Session, launchId: string): Promise<PromoLaunch>;
  /** System/staff: launches still pending or running (the scheduler adopts them). */
  listOpenPromoLaunches(session: Session): Promise<PromoLaunch[]>;
  /** System only: persist a step's output. */
  updatePromoLaunch(session: Session, launchId: string, patch: PromoLaunchPatch): Promise<PromoLaunch>;
  /**
   * System/staff: every campaign with TikTok objects whose status can still
   * move (submitted, live, paused, ended); `all` adds launching and failed
   * rows that already hold a TikTok campaign (the monitor shows those too).
   * A producer gets their own company's rows.
   */
  listLaunchedPromoCampaigns(session: Session, opts?: { all?: boolean }): Promise<LaunchedCampaign[]>;
  /** One launched campaign the session may read, with its done launch, or null when it has no TikTok objects yet. */
  getLaunchedCampaign(session: Session, campaignId: string): Promise<LaunchedCampaign | null>;
  /** Staff, the company's approver, or the system: what a control changed (lib/tiktok/controls.ts). A budget is a new experiment version. */
  recordLaunchChange(session: Session, campaignId: string, input: LaunchChangeInput): Promise<PromoLaunch>;
  /** Title editors (producer reviewer+, staff): the launch's shape, before launch; frozen from `launching` on. */
  setLaunchSettings(session: Session, campaignId: string, settings: LaunchSettings): Promise<PromoCampaign>;
  /** Any member: Pulsar-wide presets, by name. */
  listLaunchPresets(session: Session): Promise<LaunchPreset[]>;
  /** Staff admin: create or update a preset (same id updates). */
  saveLaunchPreset(session: Session, input: LaunchPresetInput): Promise<LaunchPreset>;
  /** Staff admin. */
  deleteLaunchPreset(session: Session, presetId: string): Promise<void>;
  /** Reusable local Instant Page designs; they do not publish to TikTok. */
  listInstantPageTemplates(session: Session): Promise<InstantPageTemplate[]>;
  /** Staff admin only. */
  saveInstantPageTemplate(session: Session, input: InstantPageTemplateInput): Promise<InstantPageTemplate>;
  /** Staff admin only. */
  deleteInstantPageTemplate(session: Session, id: string): Promise<void>;
  /** Producer editor: the ad account inside their assigned Business Center that launches should use (null clears). */
  setPreferredLaunchAccount(session: Session, advertiserId: string | null): Promise<CompanyAccount>;
  /**
   * Staff: a NEW launch of the same manifest on another ad account after the
   * first one ended or failed (a suspended account). Never while the first is
   * alive — that would be a second campaign spending the same budget.
   */
  relaunchOnAccount(session: Session, campaignId: string, resolved: ResolvedLaunchAccount, note?: string | null): Promise<PromoLaunch>;
  /** System/staff: the campaign's TikTok lifecycle state. */
  setPromoCampaignDelivery(session: Session, campaignId: string, input: DeliveryInput): Promise<PromoCampaign>;
  /** Staff: a failed launch runs again from its first unfinished step (never a second TikTok campaign). */
  retryPromoLaunch(session: Session, campaignId: string): Promise<PromoLaunch>;
  /** System: rows read from a reporting source; returns how many were written. */
  upsertCreativeResults(session: Session, rows: NewCreativeResult[]): Promise<number>;
  /** System or a producer editor: the rendered ad file for a creative. */
  setCreativeRender(session: Session, creativeId: string, render: RenderInput): Promise<PromoCreative>;
  /** Generation finished (renders done or skipped): generating -> review. */
  finishPromoGeneration(session: Session, campaignId: string, note?: string | null): Promise<PromoCampaign>;
  /** The producer's explicit TikTok launch account (staff-assigned, connected, with an advertiser id), or null. */
  getLaunchAccount(session: Session, producerId: string): Promise<CompanyAccount | null>;
  /** The producer's staff-assigned Business Center, or null. */
  getLaunchBusinessCenter(session: Session, producerId: string): Promise<CompanyAccount | null>;
  /** Staff admin: assign a Business Center to a producer. */
  assignBusinessCenter(session: Session, producerId: string, input: AssignBusinessCenterInput): Promise<CompanyAccount>;
  /** Staff admin: assign an ad account from Pulsar's Business Center to a producer. */
  assignLaunchAccount(session: Session, producerId: string, input: AssignLaunchAccountInput): Promise<CompanyAccount>;
  /** Staff: every request; producer: their own. */
  listAccountRequests(session: Session): Promise<AccountRequest[]>;
  /** Producer editor: ask Pulsar for an ad account. One open request per company. */
  createAccountRequest(session: Session, input: AccountRequestInput): Promise<AccountRequest>;
  /** Staff: mark a request provisioning or declined (assignment resolves it through assignLaunchAccount). */
  resolveAccountRequest(session: Session, requestId: string, input: ResolveAccountRequestInput): Promise<AccountRequest>;

  // experiments, results and customer-owned accounts (decision 2026-09-08)
  /** Editors; refused once the campaign is submitted. Each save bumps the experiment version and clears approval. */
  setExperiment(session: Session, campaignId: string, input: ExperimentInput): Promise<PromoCampaign>;
  /** Producer approver only: signs the budget. Idempotent. */
  approveExperiment(session: Session, campaignId: string): Promise<PromoCampaign>;
  /** Fixture mode only: demo-labelled results for a submitted campaign. Supabase refuses (results come from Grow). */
  simulateDemoResults(session: Session, campaignId: string): Promise<PromoCampaignDetail>;
  listCreativeResults(session: Session, opts?: { titleId?: string }): Promise<CreativeResult[]>;
  listCompanyAccounts(session: Session): Promise<CompanyAccount[]>;
  upsertCompanyAccount(session: Session, input: CompanyAccountInput): Promise<CompanyAccount>;

  // exports and audit
  getExportSnapshot(session: Session, titleId: string, episodeNumber: number): Promise<ExportSnapshot>;
  listAuditEvents(session: Session, titleId: string): Promise<AuditEvent[]>;

  // the market desk (decision 2026-09-06). The snapshot is Studio-wide public
  // data, identical in both modes; the profile is the producer's own row.
  /** Any signed-in member. Never per-producer rows; nothing to leak. */
  getMarket(session: Session): Promise<MarketView>;
  /** The caller's own company's onboarding answers; staff previewing get null. */
  getCompanyIdentity(session: Session): Promise<Pick<Producer, "id" | "external_id" | "name_zh" | "name_en"> | null>;
  getResearchProfile(session: Session): Promise<ResearchProfile | null>;
  /** Producer editors (approver/reviewer) only; staff and viewers are refused. */
  saveResearchProfile(session: Session, input: ResearchProfileInput): Promise<ResearchProfile>;
  /**
   * The caller's own catalog, with the synopsis fields the taxonomy needs,
   * in one read. `truncated` says a limit was hit; nothing is silently cut.
   * Staff previewing get an empty catalog (no company to match).
   */
  listCatalogForMatching(session: Session, opts?: { limit?: number }): Promise<CatalogForMatching>;

  // watchlist and report imports (phase 4): company-scoped, editor-only writes
  listWatchlist(session: Session): Promise<WatchRow[]>;
  addWatch(session: Session, listingKey: string): Promise<WatchRow>;
  removeWatch(session: Session, listingKey: string): Promise<void>;
  listReportBatches(session: Session): Promise<ReportBatch[]>;
  /** Rows of batches that are not reverted; optionally one title's. */
  listReportRows(session: Session, opts?: { titleId?: string }): Promise<ReportRow[]>;
  commitReportBatch(session: Session, input: CommitReportInput): Promise<ReportBatch>;
  revertReportBatch(session: Session, batchId: string): Promise<ReportBatch>;

  // title analytics (lib/analytics): company-scoped reads, editor-only listing links.
  /** One row per title of the caller's company; staff preview and other companies get nothing. */
  listTitlePerformance(session: Session, opts?: AnalyticsOptions): Promise<TitlePerformanceRow[]>;
  /** The full record for the four views. A foreign title is not_found, never forbidden. */
  getTitleAnalytics(session: Session, titleId: string, opts?: AnalyticsOptions): Promise<TitleAnalytics>;
  /** Platform listings the company may link; `[]` in supabase mode until a provider is connected. */
  listAnalyticsListings(session: Session): Promise<AnalyticsListing[]>;
  /** Editors (reviewer/approver) of the title only; a listing linked to another title is a conflict. */
  linkAnalyticsListing(session: Session, titleId: string, listingId: string): Promise<AnalyticsLink>;
  unlinkAnalyticsListing(session: Session, titleId: string): Promise<void>;
}

// ---- the switch ------------------------------------------------------------------------------

import { createLaunchData } from "./launch";
import type { LaunchDataLayer } from "@/lib/launch/types";
import { fixtureData } from "./fixture";
import { supabaseData } from "./supabase";

export function getData(): DataLayer & LaunchDataLayer {
  const core = dataSource() === "supabase" ? supabaseData : fixtureData;
  return { ...core, ...createLaunchData(core) };
}
