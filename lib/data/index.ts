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
import { dataSource } from "@/lib/data-source";
import type { IngestResult } from "@/lib/ingest";
import type { CatalogRow } from "@/lib/research/engine";
import type { MarketView } from "@/lib/research/snapshot";
import type { ReportBatch, ReportRow, ResearchProfile, WatchRow } from "@/lib/research/types";
import type {
  AccountRequest,
  AdAngle,
  CompanyAccount,
  CreativeResult,
  PromoLaunch,
  AdaptTag,
  AdaptedLine,
  AuditChannel,
  AuditEvent,
  AuthorKind,
  ChangeType,
  Character,
  Clip,
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

export type PromoCreativeReviewInput = {
  status: Extract<PromoCreativeStatus, "approved" | "rejected">;
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
  Pick<PromoLaunch, "status" | "identity_id" | "identity_type" | "uploaded_videos" | "covers" | "tiktok_campaign_id" | "tiktok_adgroup_id" | "ad_ids" | "error" | "attempts" | "started_at" | "heartbeat_at" | "finished_at">
>;

/** The scheduler's and the engine's view of a launched campaign. */
export type LaunchedCampaign = {
  campaign: PromoCampaign;
  launch: PromoLaunch;
  /** The creatives that became ads (approved in the manifest). */
  creatives: PromoCreative[];
};

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
  /** Promote intake: register a shared episode master before any subtitle/script exists. */
  addVideoOnlyEpisode(session: Session, titleId: string, episodeNumber: number, videoPath: string): Promise<Episode>;
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
  /** Point the episode at a (new) stored video (attach or replace). */
  setEpisodeVideo(session: Session, titleId: string, episodeNumber: number, storedPath: string): Promise<Episode>;
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
  /** Replaces the episode's `suggested` rows, keeps shortlisted / dismissed; returns the episode's clips. */
  upsertClips(session: Session, episodeId: string, clips: NewClip[]): Promise<Clip[]>;
  setClipStatus(session: Session, clipId: string, status: ClipStatus): Promise<Clip>;

  // jobs and cost
  /** Idempotent: an existing 'done' row for the key is returned as is (callers check status). */
  recordJob(session: Session, job: NewJob): Promise<Job>;
  finishJob(jobId: string, result: JobResult): Promise<Job>;
  sumCostCents(titleId: string): Promise<number>;

  // partner portal
  getProducerTitles(session: Session): Promise<ProducerTitleSummary[]>;
  getProducerReview(session: Session, titleId: string, episodeNumber: number): Promise<ProducerReviewPayload>;

  // Promote (producer-facing sibling product; shares only core titles/episodes)
  listPromoCampaigns(session: Session): Promise<PromoCampaignSummary[]>;
  getPromoCampaign(session: Session, campaignId: string): Promise<PromoCampaignDetail>;
  createPromoCampaign(session: Session, input: CreatePromoCampaignInput): Promise<PromoCampaign>;
  /** Five concept rows per round. With `rendering`, the campaign waits in `generating` until finishPromoGeneration; otherwise it opens for review at once. */
  generatePromoDrafts(session: Session, campaignId: string, opts?: { rendering?: boolean }): Promise<PromoCreative[]>;
  reviewPromoCreative(session: Session, creativeId: string, input: PromoCreativeReviewInput): Promise<PromoCreative>;
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
  /** System/staff: every campaign with TikTok objects whose status can still move (submitted, live, paused, ended). */
  listLaunchedPromoCampaigns(session: Session): Promise<LaunchedCampaign[]>;
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

import { fixtureData } from "./fixture";
import { supabaseData } from "./supabase";

export function getData(): DataLayer {
  return dataSource() === "supabase" ? supabaseData : fixtureData;
}
