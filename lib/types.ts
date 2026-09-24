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

import type { ResearchProfile } from "@/lib/research/types";
import type { LaunchSettings } from "@/lib/tiktok/settings";

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
export type ScriptFormat = "srt" | "vtt" | "ass" | "txt" | "docx" | "asr";

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
/** How a clip's moment was chosen: from the script (find_clips) or from footage signals alone. */
export type ClipSource = "script" | "footage";
/** What the clip is for: the trailer-style opening of the drama, or a peak moment (decision 2026-09-14). */
export type ClipMoment = "opening" | "peak";
export type ClipRenderStatus = "pending" | "rendered" | "failed";

// ---- Promote enums -----------------------------------------------------------

/** Promote is a sibling product to adaptation. Its rows never depend on an
 * adaptation or subtitle version; both products only share core titles and episodes. */
/**
 * The campaign lifecycle. Up to `approved` the producer is preparing; from
 * `launching` the record is TikTok's (decision 2026-09-09 "TikTok launch"):
 *   launching  the launch job is creating objects on TikTok
 *   submitted  created on TikTok, ads awaiting TikTok's review
 *   live       at least one ad delivering
 *   paused     switched off (by staff or on TikTok)
 *   ended      the schedule closed or the budget was spent
 *   failed     the launch job could not complete, or TikTok rejected every ad
 */
export type PromoCampaignStatus =
  | "draft"
  | "generating"
  | "review"
  | "approved"
  | "submitted"
  | "launching"
  | "live"
  | "paused"
  | "ended"
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
  | "cut_clips"
  | "parse_subtitles"
  | "transcribe_episode"
  | "import_film"
  | "segment_film"
  | "verify_boundaries"
  // The narrated route (decision 2026-09-23 "Narrated mode in Studio"; migration 0018). The three
  // picture checks are one row per API call (lib/segment/workflow-shim.ts names them after the
  // drama-remix Workflow each call stands in for); `tts_line` is one row per new tts_ledger.json
  // row (cost = chars × ELEVENLABS_CENTS_PER_1K_CHARS / 1000); `jev_check` one row per Jev-calling
  // script run (cost null, "unmetered", until jev.py logs usage); `claude_session` one row per
  // headless Claude Code writing session Studio launched (cost null: it runs on the subscription
  // login, never the API key — lib/claude-session.ts strips ANTHROPIC_API_KEY from its env).
  | "sheet_read"
  | "frame_verify"
  | "cut_verify"
  | "tts_line"
  | "jev_check"
  | "claude_session"
  // The series text of "Upload to crazydramas" (decision 2026-09-23 "Upload automation"; migration 0020): one row per
  // draft of a title's tagline, description and genres from its transcript, on ADS_TEXT_PROVIDER, keyed by title,
  // transcript hash and attempt ("Draft again" is a new attempt).
  | "draft_series_text";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** studio.film_assets.kind: the pipeline files that come with an imported film (migration 0015). */
export type FilmAssetKind =
  | "transcript"
  | "shots"
  | "motion"
  | "candidates"
  | "source_facts"
  | "delivered_plan"
  | "vision_notes"
  | "film_meta"
  | "poster"
  // A narrated (skip-through) delivery (migration 0018; narrated spec N3/N7): the shipped .srt/.ass,
  // narration.json with its manifest, the gate report (.gate.md/.json, USER-REVIEW.md), the script
  // read (SCRIPT-<src>.md, glossary.json) and DELIVERED-narrated.json itself.
  | "narrated_captions"
  | "narration"
  | "gate_report"
  | "script_doc"
  | "delivery_manifest";
/** Where a film asset came from: linked from the workspace, or made by Studio. */
export type FilmAssetOrigin = "workspace" | "studio";

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
  /** Onboarding answers for the market desk (lib/research/types ResearchProfile); null until the producer fills it in. */
  research_profile: ResearchProfile | null;
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
  // The workspace import (migration 0015). Optional in the type so the seeds
  // written before it still compile; every row the data layer creates carries
  // them (null / default) and the fixture store fills them on rows it loads,
  // so a reader may treat `undefined` exactly like null.
  /** The film this title was imported from (`<group>/<film>` under WORKSPACE_ROOT); unique per producer. Null = not imported. */
  source_ref?: string | null;
  /** Storage path of the cover art (the live poster, thumbnails only); served by GET /api/media/[...path]. */
  cover_path?: string | null;
  /** The crazydramas.com slug the title plays under. */
  crazydramas_slug?: string | null;
  /** The ad engine's rules for this title: the spoiler line and the review-added exclusions. */
  ad_rules?: AdRules | null;
};

/** A window of the film (film time, seconds) an ad may never use, and why. */
export type AdExclusion = {
  from_s: number;
  to_s: number;
  why: string;
  /** Who added it: the film's hand-written film-meta, or a person in review. */
  source?: "film_meta" | "review";
};

/** core.titles.ad_rules (jsonb): what the ad engine must respect for the title. */
export type AdRules = {
  /** Film time (seconds) from which every moment is a spoiler; null = no line. */
  spoiler_from_s: number | null;
  exclusions: AdExclusion[];
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
  /**
   * Storage path (bucket studio-media), a path under .uploads/, or a local-tier
   * path `local/<title_id>/ws/<slug>/<file>` (an imported episode's hardlink,
   * lib/data/storage.ts localPathOf); served by GET /api/media/[...path].
   */
  video_path: string | null;
  /** When video_path is a dub, the original it was mixed from — re-dubs read this, never the dub. */
  created_at: string;
  // The workspace import (migration 0015); optional in the type for the same
  // reason as on Title. `auto_cut` absent reads as true.
  /** The pipeline file this episode is (`<source_ref of the title>/cut/eps/epNN.mp4`). */
  source_ref?: string | null;
  /** SHA-256 of the imported file, streamed through the local-tier link. */
  video_sha256?: string | null;
  video_bytes?: number | null;
  /** Frames counted by ffprobe on the link (Mafia King has +1 cases the plan must not see). */
  video_frames?: number | null;
  /** The episode's window in the film, film time. */
  film_start_ms?: number | null;
  film_end_ms?: number | null;
  /** The pipeline's record of why the episode ends where it does (the vision pick, the skeptic, a band_fix flag). */
  end_note?: Json | null;
  /**
   * False on an imported episode: the ad engine cuts it, the upload-time
   * clip run (lib/clips/run.ts, the fixture's starter cuts) skips it. True
   * (the default) for every uploaded episode.
   */
  auto_cut?: boolean;
};

/**
 * studio.film_assets — a file that came with an imported film (origin
 * 'workspace', linked into the local tier) or was made from it by Studio.
 * Append-only; the newest row per (title, kind) is the one that counts.
 */
export type FilmAsset = {
  id: string;
  title_id: string;
  kind: FilmAssetKind;
  /** `local/<title_id>/ws/<slug>/<file>` for a linked workspace file; a bucket path for a Studio-made one. */
  storage_path: string;
  sha256: string;
  bytes: number;
  origin: FilmAssetOrigin;
  /** The workspace file it was linked from (relative to WORKSPACE_ROOT), when origin is 'workspace'. */
  source_ref: string | null;
  meta: Json;
  created_at: string;
};

// ---- studio.film_runs (decision 2026-09-23, "segment a film in Studio"; migration 0016) ----

/**
 * How a film is cut. `by_eye_2min` is the cut-only route (continuous ~2-minute
 * episodes, boundaries judged by the vision pass); `source_episodes` keeps the
 * source's own episode breaks (cards.py, `index/skips.json`); `narrated` is
 * the high-quality skip-through route (decision 2026-09-23 "Narrated mode in
 * Studio"): one run per source episode under `high-quality/<slug>`, its
 * episodes rows of `studio.film_run_episodes` (migration 0018). Both
 * backends refuse a narrated run in any other bucket.
 */
export type FilmRunMode = "by_eye_2min" | "source_episodes" | "narrated";

/**
 * Where a run is. Plan B2's stages in order, plus the terminal ones; the
 * column is plain text so a later stage needs no migration — extend this
 * union when one is added. A stage the worker cannot finish is `failed`
 * with `error_text` (the script's refusal, verbatim).
 */
export type FilmRunStage =
  | "queued"
  | "intake"
  | "watermark"
  | "index"
  | "cards"
  | "plan"
  | "vision"
  | "review"
  | "render"
  | "qa"
  // The narrated route's run-level stages (narrated spec N1): the minute-sheet vision log, build_script.py,
  // the script read (a writing session, approved by a person), the episode plan (approved), then the
  // per-episode lanes on studio.film_run_episodes until every episode is shipped or dropped.
  | "sheets"
  | "script_raw"
  | "script"
  | "episodes"
  | "episode_work"
  | "film_meta"
  | "handoff"
  | "done"
  | "failed"
  | "cancelled";

export const FILM_RUN_STAGES: readonly FilmRunStage[] = ["queued", "intake", "watermark", "index", "cards", "plan", "vision", "review", "render", "qa", "sheets", "script_raw", "script", "episodes", "episode_work", "film_meta", "handoff", "done", "failed", "cancelled"];

/**
 * What a run was asked for (settings jsonb). Every key is optional; the
 * worker reads the pipeline's defaults for a missing one (target 120 s in a
 * 95–150 s band, 2 whisper threads, delogo on). `allow_dirty` lets a run
 * proceed on a drama-remix working tree with uncommitted changes.
 */
export type FilmRunSettings = {
  target_s?: number;
  band?: [number, number];
  threads?: number;
  /** Index only up to this film time (a first proof); null or absent = the whole film. */
  to_s?: number | null;
  no_delogo?: boolean;
  /** `x0,y0,x1,y1` fractions for watermark.py --region; absent = the detector's default. */
  watermark_region?: string | null;
  allow_dirty?: boolean;
  /** How the vision pass runs: through the API (lib/llm) or as a Claude Code Workflow hand-off. */
  vision?: "api" | "handoff";
  /** The explicit claim B0 asks for: drive a film folder no Studio run made (a session's work). Without it the intake refuses such a folder. */
  claim_existing?: boolean;
  /** Cut the rest of a delivered film (a first proof) under its pinned episodes; without it a delivered, ready or imported film is refused at intake. */
  extend?: boolean;

  // ---- the narrated route (narrated spec N2; lib/segment/settings.ts validates and fills the defaults) ----
  /** The picture readers' model (one per pass; the stamp `fv-2+api:<model>` names it); absent = the frame judge's default. */
  reader_model?: string | null;
  /** Who writes the script read and the episode prep: `session` (Studio launches a headless Claude Code session, the default) or `handoff` (a person runs it in Claude Code; "Run it yourself"). */
  creative?: "session" | "handoff";
  /** The Claude Code session's model for the writing steps; absent = `claude-opus-5-5` (Ruobin asked for Opus on the script read). */
  writer_model?: string | null;
  /** Turn cap of one writing session (the prep agents ran 143–261 turns); absent = 400. */
  session_max_turns?: number;
  /** The narrator's name (the heroine telling the story afterwards: "Hu Xiu"); the script check asks frame_premise.txt to name her. */
  narrator?: string | null;
  /** Cast, place and era for the minute-sheet readers; written to `<film>/sheet_premise.txt` at intake. */
  sheet_premise?: string | null;
  /** The ElevenLabs voice id (never a key); absent = the voice of the last prior project's narration manifest. */
  voice_id?: string | null;
  /** Always passed as ELEVEN_MODEL (the script's own default is eleven_multilingual_v2); absent = `eleven_v3`. */
  tts_model?: string;
  /** Characters the whole run may bill; absent = 20,000. */
  tts_char_budget?: number;
  /** Characters one episode renders before the voice stage asks a person; absent = 3,000. */
  tts_episode_soft_cap?: number;
  /** The season this source continues: numbering, prior episodes (junctioned in), the title the import updates. */
  season?: NarratedSeason;
  /** The source episode's label in the briefs (`S01E05`); absent = read from the source file name. */
  source_label?: string | null;
  /** Episode body length band in seconds; absent = [165, 260] (2:45–4:20). */
  episode_target?: [number, number];
  /** The caption and lyric scan bounds passed to index_chain.sh as T0/T1; absent = 0 to the source's length. */
  scan?: { t0: number; t1: number | null };
  /** The title card's source shot, chosen at film_meta; null = the project source's own shot. */
  intro?: { src: string; ss: number; t: number } | null;
  /** `required` makes the reframe glance block the picture lane; absent = `optional`. */
  reframe_review?: "optional" | "required";
  /** Always null: Studio never writes deliver_to.txt, so build_ep.sh copies nothing to OneDrive. */
  deliver_to?: null;
  /** Per-source overrides of the prep brief's story-specific parts (PREP-BRIEF.md: "a new source needs its own NAMES section and its own worked example"). */
  brief?: NarratedBriefOverrides;
  [key: string]: Json | undefined;
};

/** `settings.season` of a narrated run (narrated spec N2): continuous numbering across source episodes. */
export type NarratedSeason = {
  /** One season, one key (`love-between-lines`): episode numbers are unique per key across live runs. */
  series_key: string;
  /** This source's first episode number (S01E05 after ep1–35 → 36). */
  first_episode_n: number;
  /** Earlier projects' folders (under WORKSPACE_ROOT) whose epK are junctioned in, read-only, for ledger_check and continuity. */
  prior_projects: string[];
  /** The series' name in the prep brief's header ("Love Between Lines"). */
  series_title?: string | null;
  /** The source_ref of an existing Studio title the import adds episodes to (N7 `title_source_ref`); null = a new title. */
  title_source_ref?: string | null;
};

/** Replacements for the story-specific parts of the prep brief; null or absent keeps the committed text. */
export type NarratedBriefOverrides = {
  /** The whole NAMES section (the bullets after "NAMES:"). */
  names?: string | null;
  /** READ FIRST item 5, the worked example from a previous source. */
  worked_example?: string | null;
  /** `{SCRIPTS}`: the script read(s) the agent treats as ground truth; absent = this source's SCRIPT-<src>.md. */
  scripts?: string | null;
};

/**
 * One human decision recorded on a run (`decisions` jsonb, an array):
 * `action` names it — `accept | move | rejudge | remove` for a boundary,
 * `watermark | region | no_logo` at the watermark stage, `note` for anything
 * else — `boundary_s` the boundary it concerns when one does, `to_s` the
 * time it moved to, `why` the person's reason. `at` and `by` are stamped by
 * the data layer. A narrated run's per-episode decision names its episode
 * in `ep` (the season number, `film_run_episodes.n`).
 */
export type FilmRunDecision = {
  at: string;
  by: string;
  action: string;
  boundary_s: number | null;
  to_s?: number | null;
  why?: string | null;
  data?: Json;
  /** The episode a narrated decision is about (its season number); absent or null for a run-level one. */
  ep?: number | null;
};

/** studio.film_runs — one segmenting run of one film (plan B1). Progress lives here, never in process memory. */
export type FilmRun = {
  id: string;
  producer_id: string;
  /** The title the run's episodes became through the import, once it did. */
  title_id: string | null;
  /** The source video as picked at intake (absolute path, forward slashes); the film folder is `<bucket>/<slug>` under WORKSPACE_ROOT. */
  source_path: string;
  bucket: string;
  slug: string;
  mode: FilmRunMode;
  /** The film's dialogue language for whisper (`--lang`). */
  lang: string;
  settings: FilmRunSettings;
  stage: FilmRunStage;
  /** Progress inside the stage, e.g. `{t, of}` for a render, `{file}` for the index log line. */
  stage_detail: Json;
  /** The drama-remix commit the film's `cut/scripts/` were synced from. */
  drama_remix_sha: string | null;
  /** True when that working tree had uncommitted changes at sync time (the run needed `allow_dirty`). */
  drama_remix_dirty: boolean;
  /** The worker holding the run (`<host>:<pid>`), for ten minutes at a time; null when nobody does. */
  lease_owner: string | null;
  leased_until: string | null;
  /** Bumped by every write except a lease renewal: the CAS token of setFilmRunStage. */
  revision: number;
  /** The refusal or error that failed the run, verbatim. */
  error_text: string | null;
  decisions: FilmRunDecision[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// ---- studio.film_run_episodes (decision 2026-09-23, "Narrated mode in Studio"; migration 0018) ----

/**
 * The words lane of a narrated episode (narrated spec N1, E1–E6): the prep
 * writing session, the person's prep review (the decide list and the
 * transcript read — the approval that allows any voice or GPU spend), the
 * paid voice, the frame check of every narration line, the join check of
 * every skip, then ready for the build.
 */
export type EpisodeWordsStage = "prep" | "prep_review" | "voice" | "frames" | "joins" | "ready";
export const EPISODE_WORDS_STAGES: readonly EpisodeWordsStage[] = ["prep", "prep_review", "voice", "frames", "joins", "ready"];

/**
 * The picture lane (E3, E3b): waiting for the prep approval, the GPU chain
 * under the heavy lock, the optional reframe glance, ready — or stale when a
 * later cue fix made the cleaned picture older than its cues (stale_check).
 */
export type EpisodePictureStage = "waiting" | "picture" | "reframe_glance" | "ready" | "stale";
export const EPISODE_PICTURE_STAGES: readonly EpisodePictureStage[] = ["waiting", "picture", "reframe_glance", "ready", "stale"];

/** The joined view: both lanes running, the build (E7), the person's final watch (E8), shipped, or dropped from the season. */
export type EpisodeStage = "lanes" | "build" | "ep_review" | "shipped" | "dropped";
export const EPISODE_STAGES: readonly EpisodeStage[] = ["lanes", "build", "ep_review", "shipped", "dropped"];

/** gate.py's counts, read from `variants/vK/epN.mp4.gate.json`. */
export type EpisodeGateCounts = { PASS: number; WARN: number; FAIL: number };

/**
 * studio.film_run_episodes — one episode of a narrated run (narrated spec N3).
 * Its own lease and CAS revision, so one worker can hold the picture lane of
 * ep9 and the words lane of ep11 at once. Staff only (RLS).
 */
export type FilmRunEpisode = {
  id: string;
  run_id: string;
  /** The run's `settings.season.series_key`, copied at creation: `n` is unique per key across live runs. */
  series_key: string;
  /** The season number (continuous across source episodes). */
  n: number;
  /** The episode's window in the source, seconds (the plan the script session proposed and a person approved). */
  src_in: number;
  src_out: number;
  /** `EPISODE N` by default; the card shows `subtitle`. */
  title: string;
  subtitle: string | null;
  words_stage: EpisodeWordsStage;
  picture_stage: EpisodePictureStage;
  stage: EpisodeStage;
  /** The newest built variant (`v3`); null before the first build. */
  variant: string | null;
  gate: EpisodeGateCounts | null;
  /** SHA-256 of the gated body (`variants/vK/body.mp4`) and of the shipped file (`variants/vK/epN.mp4`, the title card on). */
  body_sha256: string | null;
  shipped_sha256: string | null;
  /** What the lanes found or wait for (documented in docs/segment-a-film.md, "Narrated mode"). */
  stage_detail: Json;
  error_text: string | null;
  /** The final watch (E8): who approved the shipped file, and when. */
  approved_by: string | null;
  approved_at: string | null;
  lease_owner: string | null;
  leased_until: string | null;
  /** Bumped by every write except a lease renewal. */
  revision: number;
  created_at: string;
  updated_at: string;
};

// ---- core.platform_links / core.platform_snapshots (decision 2026-09-23, "the crazydramas connection"; migration 0017) ----

/** The consumer platforms Studio reads back from. One value today; the column is checked, not an enum, so a second platform needs no migration of the type. */
export type PlatformName = "crazydramas";

/**
 * core.platform_links — which drama on the platform a title IS. Written on
 * the first 200 read of the title's slug with the drama id the platform
 * returned; from then on the title is matched by that id, because a slug can
 * be edited in the platform's CMS. One link per title × platform, one title
 * per drama id.
 */
export type PlatformLink = {
  id: string;
  title_id: string;
  platform: PlatformName;
  /** The slug the drama is read under now: follows a CMS rename through the catalog. */
  slug: string;
  /** The title's own `crazydramas_slug` when the link was made or last re-pointed in Studio; a followed rename never changes it, so film-meta still carrying the pre-rename slug is not "the person re-pointed the title". */
  title_slug: string;
  /** The platform's own id of the drama (crazydramas `dramas.id`). */
  cd_drama_id: string;
  linked_at: string;
  /** Null for the system actor (the sweep). */
  linked_by: string | null;
  /**
   * Who may change the series on the platform (migration 0019; crazydramas
   * `dramas.managed_by`): `studio` when Studio created it, `cms` when it was
   * made in the crazydramas CMS (read-only for Studio), null until an
   * authenticated read or Studio's own create said which. Optional in the
   * type: a link written before 0019 has none.
   */
  managed_by?: PlatformManagedBy | null;
};

/** crazydramas `dramas.managed_by` (its migration 0007): Studio writes only the series it created. */
export type PlatformManagedBy = "studio" | "cms";

/** The whitelisted series fields of one public read (`drama` jsonb); never a playback id or a thumbnail URL. */
export type PlatformDrama = {
  id: string;
  slug: string;
  title: string;
  status: string;
  language: string | null;
  free_episode_count: number;
  series_price_cents: number | null;
  iap_product_id: string | null;
  poster_url: string | null;
  poster_blurhash: string | null;
  episode_count: number;
  cta_mode: string | null;
  /**
   * Only on an authenticated read (`GET /api/studio/series/:series`, phase 5,
   * spec §7): who may change the series. The public API never says, so a
   * public read leaves it absent. `status` is then `draft`, `published` or
   * `archived` (a public read only ever sees `published`).
   */
  managed_by?: PlatformManagedBy | null;
};

/** One episode as the public read listed it (`episodes` jsonb entries). */
export type PlatformEpisode = {
  n: number;
  duration_s: number | null;
  status: string;
  is_published: boolean;
};

/**
 * core.platform_snapshots — append-only: one row per public read of one
 * slug (the sweep, Check now, the after-import check). The last twenty per
 * slug are kept. `title_id` is null for a series that matches no title
 * (staff read those; a producer reads the rows of their own titles). A
 * failed read has `http_status` null (or the status) and `error` set, and
 * the screens show the newest good row marked stale.
 */
export type PlatformSnapshot = {
  id: string;
  platform: PlatformName;
  slug: string;
  cd_drama_id: string | null;
  title_id: string | null;
  http_status: number | null;
  drama: PlatformDrama | null;
  episodes: PlatformEpisode[] | null;
  read_at: string;
  error: string | null;
  /**
   * Which read made the row (migration 0019): `studio` = the authenticated
   * `GET /api/studio/series/:series`, which sees drafts and unpublished
   * episodes, so a 404 there means "not uploaded"; `public` = the public API,
   * where a 404 is "not uploaded, or draft". Null on rows written before 0019.
   */
  read_via?: PlatformReadVia | null;
};

export type PlatformReadVia = "public" | "studio";

// ---- studio.cd_publications (phase 5, "Upload to crazydramas"; migration 0019) ----

/**
 * One ledger row's step (publish spec §8, plan A6): planned → upload_created →
 * bytes_sent → asset_ready → verified → published, or failed / superseded.
 * Each step is persisted before the next external call.
 */
export type CdPublicationStep = "planned" | "upload_created" | "bytes_sent" | "asset_ready" | "verified" | "published" | "failed" | "superseded";

export const CD_PUBLICATION_STEPS: readonly CdPublicationStep[] = ["planned", "upload_created", "bytes_sent", "asset_ready", "verified", "published", "failed", "superseded"];

/** Steps in which the background uploader still owns the row (one such row per title × episode). */
export const CD_ACTIVE_STEPS: readonly CdPublicationStep[] = ["planned", "upload_created", "bytes_sent", "asset_ready"];

/**
 * studio.cd_publications — what Studio uploaded to crazydramas, one row per
 * title × episode × file (`idempotency_key` = `cd:<title_id>:ep<k>:<sha8>`).
 * At most one active row (CD_ACTIVE_STEPS) per title × episode number; a
 * re-cut is a new row, and the row it replaces becomes `superseded` once the
 * new one is published. Never an upload URL (a capability) or a playback id
 * (the paywall leak) in any column. Producers read the rows of their own
 * titles; every write is the system's or staff's.
 */
export type CdPublication = {
  id: string;
  title_id: string;
  /** Studio's episode (core.episodes.id); null once that row is gone. */
  episode_id: string | null;
  episode_number: number;
  /** crazydramas `dramas.id` and the slug the series was addressed by. */
  cd_drama_id: string;
  slug: string;
  /** crazydramas `episodes.id` once the upload call answered. */
  cd_episode_id: string | null;
  idempotency_key: string;
  step: CdPublicationStep;
  /** The file sent: SHA-256 (also Mux `meta.external_id`), size, frame count and rate, and its local-tier stored path (`localPathOf`). */
  sha256: string;
  bytes: number;
  frames: number | null;
  fps: number | null;
  source_path: string;
  /** The upload is a re-cut over media crazydramas already holds (`replace: true`, spec §10). */
  replace: boolean;
  /** Mux ids: the direct upload, its asset, the asset a replace put aside, and an upload of this row that died (timed out, errored, cancelled). */
  upload_id: string | null;
  asset_id: string | null;
  previous_asset_id: string | null;
  previous_upload_id: string | null;
  /** Bytes Mux acknowledged (the resumable upload's Range); the uploader resumes from here. */
  bytes_acked: number;
  /** The ready asset's length, seconds (Mux). */
  duration_s: number | null;
  /** The verify step's facts: `{external_id_ok, d_frames, verdict}`. */
  verify: Json | null;
  error: string | null;
  /** A machine code for the error (a crazydramas code passed through, or Studio's own: taken_over, verify_failed, cancelled, …). */
  error_code: string | null;
  /** A person asked Studio to stop (POST …/uploads/cancel); the uploader stops before its next chunk. */
  cancel_requested: boolean;
  /** Transient refusals in a row; reset by a step forward or a Retry. */
  attempts: number;
  /** When the uploader last sent an external call for this row (a lost answer is settled by repeating the idempotent call). */
  attempted_at: string | null;
  /** A transient refusal (episode_busy, 5xx, unreachable) waits until then. */
  next_attempt_at: string | null;
  lease_owner: string | null;
  leased_until: string | null;
  /** Bumped by every write except a lease renewal (CAS). */
  revision: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
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
  // Auto-cut renders (decision 2026-09-14 "ad clips cut after upload"; migration 0010).
  source: ClipSource;
  moment: ClipMoment;
  /** Storage path of the finished 9:16 file, same convention as PromoCreative.render_path. */
  render_path: string | null;
  render_sha256: string | null;
  render_status: ClipRenderStatus;
  /** Why a render failed, or what the producer should know about the file; shown as is. */
  render_note: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
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

/**
 * The structured experiment behind a campaign (decision 2026-09-08, "US
 * launch workspace"): budget, hypothesis, audience, first batch and signal
 * are typed fields, not prose. `approved_*` is the producer approver's
 * budget sign-off. Nothing here spends money: a provider connection enforces
 * budgets; until one exists the record is a brief with an approval history.
 */
export type ExperimentSpec = {
  budget_usd: number;
  currency: "USD";
  hypothesis: string;
  audience: string;
  /** How many creatives go into the first paid batch (generate broadly, select a few). */
  first_batch: number;
  /** The signal the first batch is judged on. */
  signal: "views" | "clicks" | "landing";
  approved_by: string | null;
  approved_at: string | null;
  version: number;
  updated_at: string;
};

/** Measured (or, in fixture mode, demo-labelled) outcome of one creative in one window. */
export type CreativeResult = {
  id: string;
  campaign_id: string;
  creative_id: string;
  /** `demo` rows are generated for the fixture and say so everywhere; `tiktok` rows are read from TikTok's reporting API by Studio's own sync (`grow` is the pre-2026-09-09 name of the same thing, kept for old rows). */
  source: "demo" | "grow" | "tiktok";
  window_start: string;
  window_end: string;
  impressions: number;
  video_views: number;
  /** Share of video plays still watching at 2 s (0-1): TikTok `video_watched_2s / video_play_actions`. */
  hook_hold_rate: number;
  clicks: number;
  spend_usd: number;
  landing_actions: number | null;
  observed_at: string;
};

export type CompanyAccountProvider = "tiktok" | "meta" | "youtube";
export type CompanyAccountKind = "business_center" | "ad_account" | "channel" | "pixel";
export type CompanyAccountState = "unconnected" | "invited" | "connected" | "revoked";

/**
 * An account a producer's ads can run from. Either customer-owned (recorded,
 * never created by Studio) or, for a TikTok ad account, one Pulsar staff
 * assigned from Pulsar's own Business Center (decision 2026-09-09). The
 * launch engine uses the ad account row that is `connected` with a
 * TikTok advertiser id in `external_ref` and a publishing identity.
 */
export type CompanyAccount = {
  id: string;
  producer_id: string;
  provider: CompanyAccountProvider;
  kind: CompanyAccountKind;
  name: string;
  /** For a TikTok ad account: the advertiser id ads launch into. */
  external_ref: string | null;
  state: CompanyAccountState;
  /** What Studio may do: nothing, revocable partner access, or the customer operates it themselves. */
  access: "none" | "partner" | "owner_operated";
  note: string | null;
  /** The TikTok handle the ads are published under (identities are per ad account). Staff-assigned; null until assigned. */
  identity_id: string | null;
  identity_type: "BC_AUTH_TT" | "TT_USER" | null;
  /** Staff who assigned the launch account, when it came from Pulsar's Business Center. */
  assigned_by: string | null;
  assigned_at: string | null;
  /** On a Business Center row: the ad account inside it the producer prefers launches to use (decision 2026-09-16); the pick still requires it ready with a handle. */
  preferred_advertiser_id: string | null;
  updated_at: string;
};

/**
 * A producer's request for an ad account provisioned by Pulsar ("make a new
 * one through us"). Provisioning is manual: staff create the account in
 * Pulsar's Business Center and assign it (a CompanyAccount row). The
 * payment method is a producer opt-in record only; nothing is charged by
 * Studio.
 */
export type AccountRequestStatus = "requested" | "provisioning" | "assigned" | "declined";
export type AccountRequest = {
  id: string;
  producer_id: string;
  status: AccountRequestStatus;
  contact_name: string;
  contact_email: string;
  /** Mock payment opt-in: brand and last four only, never a card number. */
  payment: { method: "card"; brand: string; last4: string; holder: string; opted_in_at: string } | null;
  note: string | null;
  staff_note: string | null;
  /** The CompanyAccount the request resolved to, once assigned. */
  account_id: string | null;
  requested_by: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
};

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
  experiment: ExperimentSpec | null;
  status: PromoCampaignStatus;
  /** The TikTok campaign id once launched (column name predates the in-house launch; `cmp_mock_` values are demo handoffs). */
  grow_campaign_id: string | null;
  /** The TikTok advertiser (ad account) the launch went into. */
  advertiser_id: string | null;
  tiktok_adgroup_id: string | null;
  /** Why the campaign is where it is: the launch error, TikTok's rejection reason, who paused it. */
  status_note: string | null;
  launched_at: string | null;
  /** How the launch is shaped (targeting, budget shape, bidding, launch state); null = the defaults (decision 2026-09-16). */
  launch_settings: LaunchSettings | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type PromoLaunchStatus = "pending" | "running" | "done" | "failed";

/**
 * A saved launch-settings preset, Pulsar-wide (overlord's ad group presets):
 * staff keep the house shapes; a producer picks one or customizes for the
 * launch. Values travel — a launch snapshots the settings it used.
 */
export type LaunchPreset = {
  id: string;
  name: string;
  settings: LaunchSettings;
  note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** Local Instant Page design; a TikTok page is created separately in Ads Manager. */
export type InstantPageTemplate = {
  id: string;
  name: string;
  button_text: string;
  background: "white" | "black";
  hand_cursor: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/**
 * The launch job record — Pulsar's launch engine invariants, kept in the
 * data layer instead of a job file: IDEMPOTENT (a step whose TikTok id is
 * recorded is never re-run; one row per approval manifest, so a retry can
 * never create a second TikTok campaign) and RESUMABLE (persisted after
 * every step; the scheduler adopts a row whose heartbeat went stale).
 */
export type PromoLaunch = {
  id: string;
  campaign_id: string;
  /** `studio:<pb_>:<manifest sha>` — unique, so one manifest launches once. */
  idempotency_key: string;
  manifest_sha256: string;
  status: PromoLaunchStatus;
  /** Which TikTok environment the objects were created in. */
  mode: "sandbox" | "production" | "fake";
  advertiser_id: string;
  identity_id: string | null;
  identity_type: "BC_AUTH_TT" | "TT_USER" | null;
  /** The exact spend ceiling sent to TikTok: the approved experiment budget. */
  budget_usd: number;
  destination_url: string;
  /** Step outputs, keyed by creative id. Presence = step done. */
  uploaded_videos: Record<string, string>;
  covers: Record<string, string>;
  tiktok_campaign_id: string | null;
  tiktok_adgroup_id: string | null;
  /** creative id -> ad id, written once /ad/create/ answers. */
  ad_ids: Record<string, string>;
  /** The settings snapshot this launch was created with (values travel; decision 2026-09-16). */
  settings: LaunchSettings;
  /** Created switched off: nothing delivers until someone turns the campaign on. */
  paused: boolean;
  /** Extra ad groups made after launch — auto-duplicates and cost-cap replacements — each with its ad ids. */
  duplicates: Record<string, string[]>;
  /** Ad groups switched off for good (replaced by a cost-cap copy); never counted as delivering. */
  retired_adgroups: string[];
  /** When the auto-duplicate pass settled (copies made, or decided none), so it runs once. */
  duplicated_at: string | null;
  /** A launch created paused: when it was first switched on (its ad groups came on with it). Null until then, or when it started live. */
  activated_at: string | null;
  /** The cost cap currently on the ad groups, when bidding is capped. */
  bid_usd: number | null;
  /** The schedule end currently on the ad groups (TikTok time), when scheduled. */
  schedule_end: string | null;
  error: string | null;
  attempts: number;
  created_by: string;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
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
  /** The launch job for the approved manifest, once submitted. */
  launch: PromoLaunch | null;
  results: CreativeResult[];
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
