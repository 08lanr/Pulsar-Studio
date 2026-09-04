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

import type { Session } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import type { IngestResult } from "@/lib/ingest";
import type {
  AdAngle,
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

export type ApproveOptions = {
  /** 'producer' = the partner in their portal (SQL in_app); 'on_behalf' = staff admin with evidence. */
  mode: "producer" | "on_behalf";
  evidenceNote?: string | null;
  note?: string | null;
  channel?: AuditChannel;
};

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

  // exports and audit
  getExportSnapshot(session: Session, titleId: string, episodeNumber: number): Promise<ExportSnapshot>;
  listAuditEvents(session: Session, titleId: string): Promise<AuditEvent[]>;
}

// ---- the switch ------------------------------------------------------------------------------

import { fixtureData } from "./fixture";
import { supabaseData } from "./supabase";

export function getData(): DataLayer {
  return dataSource() === "supabase" ? supabaseData : fixtureData;
}
