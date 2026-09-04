// Hand-written to mirror supabase/migrations/0001_init.sql; replace with
// supabase gen types when a project exists.
//
// One file holds every row shape the app reads, the enums as string-literal
// unions, the tag vocabularies (a const array, not a table — see
// docs/data-model.md § 2 on adapted_lines.tags / variants.tags), and the
// composite view types the screens and the API contract are built from. The
// fixture (data/fixture) is typed from here, so the fixture path and the
// Supabase path cannot drift in shape. Row types carry uuids; the composite
// types that leave the repo (exports, the snapshot) carry external ids only.
//
// Column names are the database's (snake_case); content columns say which
// language they hold (_zh / _en) and the UI locale never translates them.

// ---- json ---------------------------------------------------------------------

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ---- enums (string-literal unions; labels go through t()) -----------------------

export type UserKind = "staff" | "producer";
export type StaffRole = "admin" | "editor";
export type ProducerRole = "approver" | "reviewer" | "viewer";
export type ActorKind = "staff" | "producer" | "service";

export type TitleStatus =
  | "candidate"
  | "selected"
  | "ingesting"
  | "adapting"
  | "in_review"
  | "approved"
  | "live"
  | "ended"
  | "dropped";

/** 'asr' arrives with the v1.1 migration; not a V1 value. */
export type ScriptFormat = "srt" | "vtt" | "ass" | "txt" | "docx";

/** The STAFF working status of a scene (never written by the partner). */
export type SceneStatus = "draft" | "approved";

/** 'superseded' is bookkeeping only: never shown, never visible to the partner. */
export type VersionStatus = "draft" | "in_review" | "approved" | "superseded";
export type ApprovalMode = "in_app" | "on_behalf";

export type ChangeType =
  | "keep"
  | "literal"
  | "rewrite"
  | "tighten"
  | "tone"
  | "cultural"
  | "pacing"
  | "cut"
  | "add";

/** 'producer' joins Later with dubbing; V1 is ai | editor. */
export type AuthorKind = "ai" | "editor";

/** The partner's per-scene gate on one submitted version. Change requests are anchored to a source line. */
export type SceneDecisionKind = "approved" | "needs_alternative";
export type DecidedKind = "producer" | "staff_on_behalf";
export type FeedbackDisposition = "agreed" | "partially_agreed" | "disagreed";

export type VariantKind =
  | "title"
  | "hook"
  | "description"
  | "thumbnail_concept"
  | "ad_angle";
export type VariantStatus = "candidate" | "dismissed";

export type ClipStatus = "suggested" | "shortlisted" | "dismissed";

// ---- Promote enums -----------------------------------------------------------

/** Promote is a sibling product to adaptation. Its rows never depend on an
 * adaptation or subtitle version; both products only share core titles and episodes. */
export type PromoCampaignStatus =
  | "draft"
  | "generating"
  | "review"
  | "approved"
  | "submitted"
  | "launching"
  | "live"
  | "failed";
export type PromoCreativeKind = "direct_clip" | "ugc_story" | "ugc_reaction";
export type PromoCreativeStatus = "draft" | "ready" | "approved" | "rejected" | "not_selected" | "superseded";
export type PromoObjective = "installs" | "subscriptions" | "views";
export type PromoSpoilerLevel = "low" | "medium" | "high";

/**
 * Identifiers are the lib/llm module names verbatim. 'parse_subtitles' is the
 * cost-0 bookkeeping row per ingest. 'transcribe_episode' is the v1.1 ASR job:
 * it is NOT in the studio.job_kind enum until 0002_transcribe.sql adds it, so
 * no V1 code may write a jobs row with it; it is listed only so lib/asr.ts
 * (which returns "unavailable") can name the job it will become.
 */
export type JobKind =
  | "understand_title"
  | "understand_scene"
  | "first_pass"
  | "alternatives"
  | "rewrite"
  | "propose_variants"
  | "find_clips"
  | "parse_subtitles"
  | "transcribe_episode";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** Audit channel: how the recorded action reached us. */
export type AuditChannel = "in_app" | "wechat" | "email" | "script";

// ---- vocabularies -------------------------------------------------------------

/**
 * adapted_lines.tags / line_alternatives.tags — the 这一版本 chips on slide 7.
 * A const array so the LLM output can be validated against it, a union so
 * the UI cannot render an unknown chip.
 *
 * DELIBERATELY capped at ten (founders, 2026-09-03 evening): a producer
 * should learn the whole vocabulary in one sitting, so the chips read as a
 * system, not free text. Adding an eleventh needs a decisions.md entry.
 */
export const TAGS = [
  "tighter",
  "more_emotional",
  "more_direct",
  "softened",
  "more_casual",
  "cultural_swap",
  "idiom",
  "pacing",
  "clarity",
  "humor",
] as const;
export type AdaptTag = (typeof TAGS)[number];

/** variants.tags and clips.angle — the ad-angle vocabulary. */
export const AD_ANGLES = [
  "betrayal",
  "revenge",
  "secret_identity",
  "romance",
  "cliffhanger",
  "class_gap",
  "forced_proximity",
  "second_chance",
  "power_play",
  "slow_burn",
] as const;
export type AdAngle = (typeof AD_ANGLES)[number];

export type BilingualLabel = { key: string; en: string; zh: string };

/**
 * Labels for the two vocabularies. `key` is the dictionary key: render with
 * t(locale, TAG_LABELS[tag].key) — the en/zh here are the seed values the
 * merge step copies into locales/*.json (locales/_keys/types-fixture.json),
 * kept beside the vocabulary so a new tag cannot ship without a label.
 */
export const TAG_LABELS: Record<AdaptTag, BilingualLabel> = {
  tighter: { key: "tag.tighter", en: "Tighter", zh: "更精炼" },
  more_emotional: { key: "tag.more_emotional", en: "More emotional", zh: "更情感化" },
  more_direct: { key: "tag.more_direct", en: "More direct", zh: "更直接" },
  softened: { key: "tag.softened", en: "Softened", zh: "更缓和" },
  more_casual: { key: "tag.more_casual", en: "More casual", zh: "更口语" },
  cultural_swap: { key: "tag.cultural_swap", en: "Cultural swap", zh: "文化替换" },
  idiom: { key: "tag.idiom", en: "Idiom", zh: "地道表达" },
  pacing: { key: "tag.pacing", en: "Pacing", zh: "节奏调整" },
  clarity: { key: "tag.clarity", en: "Clarity", zh: "更清晰" },
  humor: { key: "tag.humor", en: "Humor", zh: "增加幽默" },
};

export const AD_ANGLE_LABELS: Record<AdAngle, BilingualLabel> = {
  betrayal: { key: "angle.betrayal", en: "Betrayal", zh: "背叛" },
  revenge: { key: "angle.revenge", en: "Revenge", zh: "复仇" },
  secret_identity: { key: "angle.secret_identity", en: "Secret identity", zh: "隐藏身份" },
  romance: { key: "angle.romance", en: "Romance", zh: "爱情" },
  cliffhanger: { key: "angle.cliffhanger", en: "Cliffhanger", zh: "悬念" },
  class_gap: { key: "angle.class_gap", en: "Class gap", zh: "阶层差距" },
  forced_proximity: { key: "angle.forced_proximity", en: "Forced proximity", zh: "被迫同行" },
  second_chance: { key: "angle.second_chance", en: "Second chance", zh: "重新开始" },
  power_play: { key: "angle.power_play", en: "Power play", zh: "权力博弈" },
  slow_burn: { key: "angle.slow_burn", en: "Slow burn", zh: "细水长流" },
};

export function isAdaptTag(value: string): value is AdaptTag {
  return (TAGS as readonly string[]).includes(value);
}

export function isAdAngle(value: string): value is AdAngle {
  return (AD_ANGLES as readonly string[]).includes(value);
}

// ---- core.* rows ----------------------------------------------------------------

export type Producer = {
  id: string;
  external_id: string;
  slug: string;
  name_zh: string;
  name_en: string | null;
  contact_email: string | null;
  contact_wechat: string | null;
  deliverables: Json;
  created_at: string;
};

export type Profile = {
  id: string;
  kind: UserKind;
  staff_role: StaffRole | null;
  producer_id: string | null;
  producer_role: ProducerRole | null;
  display_name: string;
  /** null = the route group decides (decision #8). */
  locale: "zh" | "en" | null;
  created_at: string;
};

export type Title = {
  id: string;
  external_id: string;
  producer_id: string;
  name_zh: string;
  name_en: string | null;
  genre: string | null;
  synopsis_zh: string | null;
  synopsis_en: string | null;
  /** Free text from /titles/new: who is who, relationships, register. The title bible with the synopsis. */
  character_notes: string | null;
  logline_zh: string | null;
  logline_en: string | null;
  episode_count: number | null;
  source_locale: string;
  status: TitleStatus;
  china_metrics: Json;
  localization_effort: string | null;
  deliverables: Json;
  notes: string | null;
  license_start: string | null;
  license_end: string | null;
  created_at: string;
  updated_at: string;
};

export type Episode = {
  id: string;
  external_id: string;
  title_id: string;
  number: number;
  name_zh: string | null;
  name_en: string | null;
  duration_ms: number | null;
  source_script_path: string | null;
  script_format: ScriptFormat | null;
  has_timecodes: boolean;
  /** Storage path (bucket studio-media) or a path under .uploads/; served by GET /api/media/[...path]. */
  video_path: string | null;
  /** When video_path is a dub, the original it was mixed from — re-dubs read this, never the dub. */
  created_at: string;
};

export type AuditEvent = {
  id: number;
  at: string;
  actor_id: string | null;
  actor_kind: ActorKind;
  product: string;
  action: string;
  table_name: string;
  row_id: string | null;
  title_id: string | null;
  producer_id: string | null;
  before: Json | null;
  after: Json | null;
  note: string | null;
  channel: AuditChannel | null;
};

// ---- studio.* rows --------------------------------------------------------------

export type Character = {
  id: string;
  title_id: string;
  name_zh: string;
  name_en: string | null;
  notes: string | null;
  created_at: string;
};

export type Scene = {
  id: string;
  external_id: string;
  title_id: string;
  episode_id: string;
  number: number;
  /** null only when the episode has_timecodes = false. */
  start_ms: number | null;
  end_ms: number | null;
  context_zh: string | null;
  context_en: string | null;
  status: SceneStatus;
  status_by: string | null;
  status_at: string | null;
  created_at: string;
};

export type Line = {
  id: string;
  external_id: string;
  title_id: string;
  scene_id: string;
  /** lib/ingest seq; unique within the episode. */
  seq: number;
  speaker: string | null;
  character_id: string | null;
  start_ms: number | null;
  end_ms: number | null;
  duration_ms: number | null;
  text_zh: string;
  /** The literal translation: the diff baseline, written by first_pass. */
  literal_en: string | null;
  merged_into_id: string | null;
  created_at: string;
};

export type Adaptation = {
  id: string;
  external_id: string;
  title_id: string;
  target_locale: string;
  label: string;
  /** Mirrors the selected kind='title' variant; shown in staff export headers. */
  display_title_en: string | null;
  created_by: string | null;
  created_at: string;
};

export type Version = {
  id: string;
  external_id: string;
  title_id: string;
  adaptation_id: string;
  episode_id: string;
  number: number;
  parent_version_id: string | null;
  status: VersionStatus;
  submitted_at: string | null;
  submitted_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  approval_mode: ApprovalMode | null;
  approval_evidence: string | null;
  approval_note: string | null;
  /** Written once by submit_version(); what the partner reviews and every export renders from. */
  snapshot: VersionSnapshot | null;
  snapshot_sha256: string | null;
  created_at: string;
  updated_at: string;
};

export type AdaptedLine = {
  id: string;
  external_id: string;
  title_id: string;
  version_id: string;
  scene_id: string;
  /** null = an added line (Later). V1 writes 1:1 rows only. */
  line_id: string | null;
  merges: string[];
  seq: number;
  start_ms: number | null;
  end_ms: number | null;
  /** null when change_type = 'cut'. */
  text_en: string | null;
  /** The exact substring of text_en that carries the change — highlighted in
   * the script sheet as the visible face of "why this change". */
  key_phrase_en: string | null;
  /** 回译 — what the producer actually judges. */
  back_translation_zh: string | null;
  change_type: ChangeType;
  is_major: boolean;
  rationale_en: string | null;
  rationale_zh: string | null;
  tone_note_en: string | null;
  tone_note_zh: string | null;
  tags: AdaptTag[];
  syllables_est: number | null;
  authored_by: AuthorKind;
  model: string | null;
  prompt_version: string | null;
  /** The AI first pass, retained when an editor overwrites; never regenerated. */
  ai_text_en: string | null;
  ai_rationale_zh: string | null;
  edited_by: string | null;
  created_at: string;
  updated_at: string;
};

export type LineAlternative = {
  id: string;
  external_id: string;
  title_id: string;
  version_id: string;
  adapted_line_id: string;
  seq: number;
  text_en: string;
  back_translation_zh: string | null;
  rationale_zh: string;
  rationale_en: string | null;
  tags: AdaptTag[];
  syllables_est: number | null;
  model: string;
  prompt_version: string;
  job_id: string | null;
  chosen: boolean;
  chosen_by: string | null;
  chosen_at: string | null;
  created_at: string;
};

/** One reusable bilingual pair derived from an immutable approved snapshot. */
export type TranslationMemoryExample = {
  version_id: string;
  approved_at: string | null;
  title_id: string;
  title_name_zh: string;
  episode_number: number;
  scene_number: number;
  speaker: string | null;
  character_name_en: string | null;
  text_zh: string;
  text_en: string;
  rationale_en: string | null;
  tags: AdaptTag[];
  authored_by: AuthorKind;
};

/** A licensed seed pair from Tatoeba. It is reference material, never house style. */
export type ReferenceTranslationMemoryExample = {
  source: "tatoeba";
  source_sentence_id: number;
  translation_sentence_id: number;
  source_owner: string;
  translation_owner: string;
  source_license: "CC BY 2.0 FR" | "CC0 1.0";
  translation_license: "CC BY 2.0 FR" | "CC0 1.0";
  text_zh: string;
  text_en: string;
};

/** Primary key (version_id, scene_id): the only partner write, through decide_scene(). */
export type SceneDecision = {
  version_id: string;
  scene_id: string;
  title_id: string;
  decision: SceneDecisionKind;
  /** Source-line anchor and frozen timecode; required when needs_alternative. */
  line_id: string | null;
  timestamp_ms: number | null;
  /** The producer's requested change; required when needs_alternative. */
  note: string | null;
  /** Pulsar's explicit response, added while preparing the next revision. */
  resolution_disposition: FeedbackDisposition | null;
  resolution_note: string | null;
  responded_by: string | null;
  responded_at: string | null;
  decided_by: string;
  decided_at: string;
  decided_kind: DecidedKind;
  /** The first decision on this (version, scene); decided_at moves on every upsert, this does not. */
  created_at: string;
};

export type Variant = {
  id: string;
  external_id: string;
  title_id: string;
  adaptation_id: string;
  kind: VariantKind;
  text_en: string;
  text_zh: string | null;
  rationale_en: string | null;
  rationale_zh: string | null;
  tags: AdAngle[];
  /** The platform pick; one per (title, kind) for title and hook, never for other kinds. */
  selected: boolean;
  status: VariantStatus;
  model: string | null;
  prompt_version: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** studio.clips — "clip suggestion" in prose only; table, type, API path and payloads all say `clips`. */
export type Clip = {
  id: string;
  external_id: string;
  title_id: string;
  episode_id: string;
  adaptation_id: string | null;
  /** 1 = strongest within the episode. */
  rank: number;
  start_ms: number;
  end_ms: number;
  scene_ids: string[];
  hook_en: string;
  why_en: string;
  why_zh: string;
  opening_text_en: string | null;
  cut_length_s: number | null;
  angle: AdAngle | null;
  status: ClipStatus;
  model: string | null;
  prompt_version: string | null;
  job_id: string | null;
  created_at: string;
};
/** @deprecated prose name; use Clip. */
export type ClipSuggestion = Clip;

export type JobUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  /** ASR minutes (v1.1). */
  audio_minutes?: number;
};

export type Job = {
  id: string;
  title_id: string | null;
  episode_id: string | null;
  version_id: string | null;
  kind: JobKind;
  target_type: string;
  target_id: string;
  /** e.g. first_pass:{version_id}:{scene_id}:{prompt_version} */
  idempotency_key: string;
  status: JobStatus;
  provider: string | null;
  model: string | null;
  input: Json | null;
  output: Json | null;
  error: string | null;
  usage: JobUsage | null;
  cost_cents: number | null;
  heartbeat_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

// ---- promote.* rows ----------------------------------------------------------

export type PromoCampaign = {
  id: string;
  external_id: string;
  title_id: string;
  producer_id: string;
  name: string;
  target_market: string;
  destination_url: string | null;
  objective: PromoObjective;
  spoiler_level: PromoSpoilerLevel;
  creative_direction: string | null;
  exclusions: string | null;
  status: PromoCampaignStatus;
  grow_campaign_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** Every revision is a new row. Approved rows are immutable and the parent is
 * retained so review can show exactly what changed. */
export type PromoCreative = {
  id: string;
  external_id: string;
  campaign_id: string;
  title_id: string;
  parent_creative_id: string | null;
  version: number;
  kind: PromoCreativeKind;
  status: PromoCreativeStatus;
  hypothesis: string;
  source_episode_id: string | null;
  source_start_ms: number | null;
  source_end_ms: number | null;
  hook: string;
  caption: string;
  ad_description: string;
  render_path: string | null;
  render_sha256: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  render_settings: Json;
  rejection_note: string | null;
  /** Staff's note on a revision: what changed in this version versus its parent. */
  revision_note: string | null;
  created_at: string;
  updated_at: string;
};

export type PromoApproval = {
  id: string;
  campaign_id: string;
  producer_id: string;
  approved_by: string;
  manifest: Json;
  manifest_sha256: string;
  created_at: string;
};

export type PromoHandoff = {
  id: string;
  campaign_id: string;
  idempotency_key: string;
  request_sha256: string;
  status: "pending" | "accepted" | "failed" | "unknown";
  grow_campaign_id: string | null;
  response: Json | null;
  error: string | null;
  attempted_at: string;
};

export type PromoCampaignSummary = PromoCampaign & {
  title_name_zh: string;
  title_name_en: string | null;
  producer_name_zh: string;
  producer_name_en: string | null;
  creative_count: number;
  approved_count: number;
  /** Creatives still waiting for the producer's keep/change decision. */
  pending_count: number;
  /** Producer change requests with no revision yet — Pulsar's queue. */
  change_count: number;
};

export type PromoCampaignDetail = {
  campaign: PromoCampaign;
  title: Title;
  episodes: Episode[];
  creatives: PromoCreative[];
  approval: PromoApproval | null;
  handoffs: PromoHandoff[];
};

// ---- the frozen snapshot ----------------------------------------------------------
//
// Written once by submit_version() into versions.snapshot (studio.build_snapshot
// in 0001_init.sql is the source of truth for the shape; this mirrors it key
// for key); approve_version() never rewrites it. What the partner reviews and
// what every export renders from. Row uuids ride along beside the external
// ids because the partner review UI addresses decide_scene by scene uuid;
// exports print external ids only, never a uuid. Never alternatives, never
// jobs, never decisions (they are per version and live in scene_decisions).
// snapshot_sha256 is sha256 over canonicalJson(snapshot): object keys sorted
// bytewise, recursively, no whitespace, UTF-8 — core.canonical_json() in the
// migration produces the same bytes, so a fixture hash and a database hash
// are computed the same way.

export const SNAPSHOT_SCHEMA = 1 as const;

export type SnapshotCharacter = {
  /** uuid (lines.character_id points here). */
  id: string;
  name_zh: string;
  name_en: string | null;
  notes: string | null;
};

export type SnapshotLine = {
  /** uuid */
  id: string;
  /** ln_ */
  external_id: string;
  seq: number;
  speaker: string | null;
  /** uuid of a snapshot character, or null when unresolved. */
  character_id: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text_zh: string;
  literal_en: string | null;
};

export type SnapshotAdaptedLine = {
  /** uuid */
  id: string;
  /** rw_ */
  external_id: string;
  /** uuid of the anchor source line; null = added. */
  line_id: string | null;
  /** uuids of source lines absorbed by a merge. */
  merges: string[];
  seq: number;
  start_ms: number | null;
  end_ms: number | null;
  text_en: string | null;
  key_phrase_en: string | null;
  back_translation_zh: string | null;
  change_type: ChangeType;
  is_major: boolean;
  rationale_en: string | null;
  rationale_zh: string | null;
  tone_note_en: string | null;
  tone_note_zh: string | null;
  tags: AdaptTag[];
  syllables_est: number | null;
  authored_by: AuthorKind;
  model: string | null;
  prompt_version: string | null;
};

export type SnapshotScene = {
  /** uuid (what POST .../scenes/[sceneId]/decide takes). */
  id: string;
  /** sc_ */
  external_id: string;
  number: number;
  start_ms: number | null;
  end_ms: number | null;
  context_zh: string | null;
  context_en: string | null;
  /** The staff status at submit time (always 'approved' — submit requires it — but recorded). */
  status: SceneStatus;
  /** In seq order. */
  lines: SnapshotLine[];
  /** In seq order. */
  adapted_lines: SnapshotAdaptedLine[];
};

export type VersionSnapshot = {
  schema: typeof SNAPSHOT_SCHEMA;
  /** The version row plus its adaptation (one per title in V1, so it is folded in). */
  version: {
    /** uuid */
    id: string;
    /** ver_ */
    external_id: string;
    number: number;
    /** uuid */
    adaptation_id: string;
    /** ad_ */
    adaptation_external_id: string;
    target_locale: string;
    /** The platform-pick title at submit time; export headers use it. */
    display_title_en: string | null;
  };
  title: {
    /** uuid */
    id: string;
    /** ttl_ */
    external_id: string;
    name_zh: string;
    name_en: string | null;
    /** uuid */
    producer_id: string;
  };
  episode: {
    /** uuid */
    id: string;
    /** ep_ */
    external_id: string;
    number: number;
    name_zh: string | null;
    name_en: string | null;
    duration_ms: number | null;
    has_timecodes: boolean;
  };
  /** Every character of the title, ordered by name_zh (bytewise). */
  characters: SnapshotCharacter[];
  /** Every scene of the episode, ordered by number. */
  scenes: SnapshotScene[];
};

/**
 * The canonical serialisation the snapshot hash is taken over: keys sorted
 * bytewise (keys are ASCII, so code-unit order is byte order), recursively,
 * arrays in order, no whitespace; the same bytes core.canonical_json()
 * produces in Postgres. Pure so it can run in a route handler, a script, or
 * a test without a crypto import.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

// ---- composite views (what the screens and the API contract carry) ----------------

/**
 * Derived, never stored: where an episode is in the pipeline.
 *   ingested   lines exist, no version yet (or a draft with no first pass)
 *   adapting   a draft version with adapted lines
 *   in_review  the current version is in_review
 *   approved   the current version is approved
 */
export type EpisodeStatus = "ingested" | "adapting" | "in_review" | "approved";

/** GET /api/titles -> { titles: TitleSummary[] }; the /titles list row. */
export type TitleSummary = {
  id: string;
  external_id: string;
  name_zh: string;
  name_en: string | null;
  producer_id: string;
  producer_name_zh: string;
  producer_name_en: string | null;
  genre: string | null;
  status: TitleStatus;
  episode_count: number;
  episodes_ingested: number;
  /** Scenes with a first pass over scenes, 0–100. */
  percent_adapted: number;
  /** sum(jobs.cost_cents) for the title: "API cost to date". */
  cost_cents: number;
  updated_at: string;
};

export type EpisodeSummary = {
  id: string;
  external_id: string;
  number: number;
  name_zh: string | null;
  name_en: string | null;
  has_timecodes: boolean;
  has_video: boolean;
  duration_ms: number | null;
  status: EpisodeStatus;
  scenes_total: number;
  /** Scenes with at least one adapted line. */
  scenes_adapted: number;
  /** Scenes with scenes.status = 'approved' (staff). */
  scenes_approved: number;
  lines_total: number;
  /** Source lines with every required English/adaptation field complete. */
  lines_adapted: number;
  /** Producer decisions on the current submitted/approved version. */
  partner_scenes_decided: number;
  partner_scenes_needing_alternative: number;
  /** The current (newest non-superseded) version, if any. */
  version_id: string | null;
  version_external_id: string | null;
  version_status: VersionStatus | null;
};

/** GET /api/titles/[id] -> TitleDetail. */
export type TitleDetail = {
  title: Title;
  producer: Producer;
  adaptation: Adaptation;
  characters: Character[];
  episodes: EpisodeSummary[];
  /** Every version of the title (snapshots omitted); one row per submission. */
  versions: Omit<Version, "snapshot">[];
  cost_cents: number;
  /** The platform picks, when made. */
  selected_title: Variant | null;
  selected_hook: Variant | null;
};

/** GET /api/titles/[id]/episodes/[n] -> WorkbenchPayload; the Adaptation workbench. */
export type WorkbenchPayload = {
  title: Title;
  adaptation: Adaptation;
  episode: Episode;
  characters: Character[];
  scenes: Scene[];
  lines: Line[];
  /** The current draft, or the in_review / approved version when no draft is open; null before a first pass. */
  version: Version | null;
  adapted_lines: AdaptedLine[];
  alternatives: LineAlternative[];
  /** Partner decisions on `version`, or on its parent while staff edits a requested revision. */
  decisions: SceneDecision[];
  /** /api/media/... URL for episodes.video_path, else null (the no-video state). */
  video_url: string | null;
  /** False when the selected LLM provider's API key is unset. */
  ai_available: boolean;
};

// ---- partner portal views ------------------------------------------------------------

export type ProducerEpisodeSummary = {
  id: string;
  external_id: string;
  number: number;
  name_zh: string | null;
  name_en: string | null;
  version_id: string;
  version_external_id: string;
  /** Only in_review | approved ever reach a producer session. */
  version_status: "in_review" | "approved";
  submitted_at: string | null;
  approved_at: string | null;
  approval_mode: ApprovalMode | null;
  scenes_total: number;
  scenes_decided: number;
  scenes_needing_alternative: number;
};

/** GET /api/producer/titles -> { titles: ProducerTitleSummary[] }. */
export type ProducerTitleSummary = {
  id: string;
  external_id: string;
  name_zh: string;
  name_en: string | null;
  genre: string | null;
  episode_count: number;
  episodes: ProducerEpisodeSummary[];
  updated_at: string;
};

/** One adapted line as the partner reads it: source zh, back-translation, English, the zh rationale. */
export type ProducerReviewLine = {
  /** rw_ */
  id: string;
  /** Stable studio.lines id used to anchor timestamped review feedback across versions. */
  source_line_id: string | null;
  seq: number;
  speaker: string | null;
  character_name_zh: string | null;
  start_ms: number | null;
  end_ms: number | null;
  /** The source line (text_zh), joined from the snapshot. */
  text_zh: string;
  back_translation_zh: string | null;
  text_en: string | null;
  key_phrase_en: string | null;
  rationale_zh: string | null;
  tone_note_zh: string | null;
  change_type: ChangeType;
  is_major: boolean;
  tags: AdaptTag[];
};

export type ProducerReviewScene = {
  /** sc_ */
  id: string;
  /** The uuid, needed for POST .../scenes/[sceneId]/decide. */
  scene_id: string;
  number: number;
  start_ms: number | null;
  end_ms: number | null;
  context_zh: string | null;
  /** In seq order; the UI lists is_major lines first using `major_count`. */
  lines: ProducerReviewLine[];
  major_count: number;
  /** The decision so far on this version, or null while undecided. */
  decision: SceneDecision | null;
  /** A request made on the parent version, paired with Pulsar's revised line and response. */
  revision_request: ProducerRevisionRequest | null;
};

export type ProducerRevisionRequest = {
  request_version_id: string;
  scene_id: string;
  line_id: string;
  timestamp_ms: number | null;
  note: string;
  previous_text_en: string | null;
  revised_text_en: string | null;
  revised_rationale_zh: string | null;
  resolution_disposition: FeedbackDisposition | null;
  resolution_note: string | null;
};

/** GET /api/producer/titles/[id]/episodes/[n] -> ProducerReviewPayload, rendered from the frozen snapshot. */
export type ProducerReviewPayload = {
  title: { id: string; external_id: string; name_zh: string; name_en: string | null };
  episode: {
    id: string;
    external_id: string;
    number: number;
    name_zh: string | null;
    name_en: string | null;
    has_timecodes: boolean;
    duration_ms: number | null;
  };
  version: {
    id: string;
    external_id: string;
    number: number;
    status: "in_review" | "approved";
    submitted_at: string | null;
    approved_at: string | null;
    approval_mode: ApprovalMode | null;
    snapshot_sha256: string | null;
  };
  scenes: ProducerReviewScene[];
  /** Whether the caller may decide / approve (producer approver or reviewer per lib/auth). */
  can_decide: boolean;
  can_approve: boolean;
  video_url: string | null;
};
