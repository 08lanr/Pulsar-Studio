// Derived fields, computed the same way from either backend. Nothing here
// touches a store: every function takes plain rows (lib/types.ts shapes) and
// returns the composite view the screens read, so the fixture layer and the
// Supabase layer cannot disagree on what "adapting" or "% adapted" means.
//
// The rules (docs/data-model.md § 4, lib/types.ts composite types):
//   current version   the open draft, else the in_review row, else the newest
//                     approved one; superseded rows are bookkeeping and never
//                     "current"
//   episode status    ingested / adapting / in_review / approved, from the
//                     current version and whether it has adapted lines
//   percent_adapted   adapted lines (of each episode's current version) over
//                     source lines, across the title's episodes
//   partner version   the in_review row when one exists (it needs a decision),
//                     else the approved one; never a draft, never superseded

import type {
  AdaptedLine,
  Episode,
  EpisodeStatus,
  EpisodeSummary,
  Line,
  Producer,
  ProducerEpisodeSummary,
  ProducerReviewLine,
  ProducerReviewPayload,
  ProducerReviewScene,
  Scene,
  SceneDecision,
  Title,
  TitleStatus,
  TitleSummary,
  Version,
  VersionSnapshot,
} from "@/lib/types";

// ---- versions ------------------------------------------------------------------------

/** The version the workbench opens: draft > in_review > newest approved; null before a first pass. */
export function pickCurrentVersion(versions: Version[]): Version | null {
  const live = versions.filter((v) => v.status !== "superseded");
  const draft = live.find((v) => v.status === "draft");
  if (draft) return draft;
  const inReview = live.find((v) => v.status === "in_review");
  if (inReview) return inReview;
  const approved = live.filter((v) => v.status === "approved").sort((a, b) => b.number - a.number);
  return approved[0] ?? null;
}

/** The version a producer session sees for an episode: in_review first, else the approved one. */
export function pickProducerVersion(versions: Version[]): Version | null {
  const inReview = versions.find((v) => v.status === "in_review");
  if (inReview) return inReview;
  const approved = versions.filter((v) => v.status === "approved").sort((a, b) => b.number - a.number);
  return approved[0] ?? null;
}

export function deriveEpisodeStatus(version: Version | null, linesAdapted: number): EpisodeStatus {
  if (!version) return "ingested";
  if (version.status === "approved") return "approved";
  if (version.status === "in_review") return "in_review";
  return linesAdapted > 0 ? "adapting" : "ingested";
}

// ---- episode / title summaries ---------------------------------------------------------------

export type EpisodeRows = {
  episode: Episode;
  scenes: Scene[];
  lines: Line[];
  /** Every version of the episode (any status). */
  versions: Version[];
  /** Adapted lines of any version of the episode (filtered to the current one here). */
  adapted_lines: Pick<
    AdaptedLine,
    "version_id" | "scene_id" | "line_id" | "text_en" | "change_type" | "rationale_zh" | "back_translation_zh"
  >[];
  decisions?: Pick<SceneDecision, "version_id" | "scene_id" | "decision">[];
};

export function buildEpisodeSummary(r: EpisodeRows): EpisodeSummary {
  const version = pickCurrentVersion(r.versions);
  const adapted = version ? r.adapted_lines.filter((a) => a.version_id === version.id) : [];
  const adaptedSceneIds = new Set(adapted.map((a) => a.scene_id));
  const adaptedLineIds = new Set(adapted.map((a) => a.line_id).filter((id): id is string => id !== null));
  const readyLineIds = new Set(
    adapted
      .filter((line) =>
        (line.change_type === "cut" || !!line.text_en?.trim()) &&
        (line.change_type === "keep" || !!line.rationale_zh?.trim()) &&
        (line.change_type === "keep" || line.change_type === "cut" || !!line.back_translation_zh?.trim())
      )
      .map((line) => line.line_id)
      .filter((id): id is string => id !== null)
  );
  const sourceLines = r.lines.filter((l) => l.merged_into_id === null);
  const decisions = version ? (r.decisions ?? []).filter((decision) => decision.version_id === version.id) : [];
  return {
    id: r.episode.id,
    external_id: r.episode.external_id,
    number: r.episode.number,
    name_zh: r.episode.name_zh,
    name_en: r.episode.name_en,
    has_timecodes: r.episode.has_timecodes,
    has_video: r.episode.video_path !== null,
    duration_ms: r.episode.duration_ms,
    status: deriveEpisodeStatus(version, adaptedLineIds.size),
    scenes_total: r.scenes.length,
    scenes_adapted: r.scenes.filter((s) => adaptedSceneIds.has(s.id)).length,
    scenes_approved: r.scenes.filter((s) => s.status === "approved").length,
    lines_total: sourceLines.length,
    lines_adapted: readyLineIds.size,
    partner_scenes_decided: decisions.length,
    partner_scenes_needing_alternative: decisions.filter((decision) => decision.decision === "needs_alternative").length,
    version_id: version?.id ?? null,
    version_external_id: version?.external_id ?? null,
    version_status: version?.status ?? null,
  };
}

/**
 * in_review and approved are derived from the episodes (docs/data-model.md
 * § 4); the staff-moved values are kept as stored. A stored derived value
 * that the episodes no longer support falls back to the nearest staff state.
 */
export function deriveTitleStatus(title: Title, episodes: EpisodeSummary[]): TitleStatus {
  if (episodes.length && episodes.every((e) => e.status === "approved")) return "approved";
  if (episodes.some((e) => e.status === "in_review")) return "in_review";
  if (title.status === "in_review" || title.status === "approved") {
    if (episodes.some((e) => e.status === "adapting" || e.status === "approved")) return "adapting";
    return episodes.length ? "ingesting" : "selected";
  }
  return title.status;
}

export function percentAdapted(episodes: EpisodeSummary[]): number {
  const total = episodes.reduce((n, e) => n + e.lines_total, 0);
  if (!total) return 0;
  const adapted = episodes.reduce((n, e) => n + e.lines_adapted, 0);
  return Math.min(100, Math.round((100 * adapted) / total));
}

export function buildTitleSummary(i: {
  title: Title;
  producer: Producer;
  episodes: EpisodeSummary[];
  cost_cents: number;
}): TitleSummary {
  return {
    id: i.title.id,
    external_id: i.title.external_id,
    name_zh: i.title.name_zh,
    name_en: i.title.name_en,
    producer_id: i.title.producer_id,
    producer_name_zh: i.producer.name_zh,
    producer_name_en: i.producer.name_en,
    genre: i.title.genre,
    status: deriveTitleStatus(i.title, i.episodes),
    episode_count: Math.max(i.title.episode_count ?? 0, i.episodes.length),
    episodes_ingested: i.episodes.length,
    percent_adapted: percentAdapted(i.episodes),
    cost_cents: i.cost_cents,
    updated_at: i.title.updated_at,
  };
}

// ---- partner views -----------------------------------------------------------------------------

export function buildProducerEpisodeSummary(i: {
  episode: Episode;
  version: Version;
  scenes_total: number;
  decisions: SceneDecision[];
}): ProducerEpisodeSummary {
  const mine = i.decisions.filter((d) => d.version_id === i.version.id);
  return {
    id: i.episode.id,
    external_id: i.episode.external_id,
    number: i.episode.number,
    name_zh: i.episode.name_zh,
    name_en: i.episode.name_en,
    version_id: i.version.id,
    version_external_id: i.version.external_id,
    version_status: i.version.status === "approved" ? "approved" : "in_review",
    submitted_at: i.version.submitted_at,
    approved_at: i.version.approved_at,
    approval_mode: i.version.approval_mode,
    scenes_total: i.scenes_total,
    scenes_decided: mine.length,
    scenes_needing_alternative: mine.filter((d) => d.decision === "needs_alternative").length,
  };
}

/**
 * The partner's read of one submitted version, from the frozen snapshot and
 * nothing else: per scene the source zh, the back-translation, the English,
 * the zh rationale — is_major lines first, seq order within each group — and
 * the decision so far. Alternatives, jobs, variants and clips never appear.
 */
export function buildProducerReview(i: {
  version: Version;
  snapshot: VersionSnapshot;
  decisions: SceneDecision[];
  previous?: { version: Version; snapshot: VersionSnapshot; decisions: SceneDecision[] } | null;
  can_decide: boolean;
  can_approve: boolean;
  video_url: string | null;
}): ProducerReviewPayload {
  const s = i.snapshot;
  const characterName = new Map(s.characters.map((c) => [c.id, c.name_zh]));
  const scenes: ProducerReviewScene[] = s.scenes.map((sc) => {
    const source = new Map(sc.lines.map((l) => [l.id, l]));
    const lines: ProducerReviewLine[] = sc.adapted_lines.map((a) => {
      const src = a.line_id ? source.get(a.line_id) : undefined;
      return {
        id: a.external_id,
        source_line_id: a.line_id,
        seq: a.seq,
        speaker: src?.speaker ?? null,
        character_name_zh: src?.character_id ? characterName.get(src.character_id) ?? src.speaker ?? null : src?.speaker ?? null,
        start_ms: a.start_ms,
        end_ms: a.end_ms,
        text_zh: src?.text_zh ?? "",
        back_translation_zh: a.back_translation_zh,
        text_en: a.text_en,
        key_phrase_en: a.key_phrase_en,
        rationale_zh: a.rationale_zh,
        tone_note_zh: a.tone_note_zh,
        change_type: a.change_type,
        is_major: a.is_major,
        tags: a.tags,
      };
    });
    lines.sort((a, b) => Number(b.is_major) - Number(a.is_major) || a.seq - b.seq);
    const previousRequest = i.previous?.decisions.find(
      (d) => d.scene_id === sc.id && d.decision === "needs_alternative" && d.line_id && d.note
    );
    const previousScene = i.previous?.snapshot.scenes.find((item) => item.id === sc.id);
    const previousAdapted = previousRequest
      ? previousScene?.adapted_lines.find((item) => item.line_id === previousRequest.line_id)
      : null;
    const revisedLine = previousRequest ? lines.find((item) => item.source_line_id === previousRequest.line_id) : null;
    return {
      id: sc.external_id,
      scene_id: sc.id,
      number: sc.number,
      start_ms: sc.start_ms,
      end_ms: sc.end_ms,
      context_zh: sc.context_zh,
      lines,
      major_count: lines.filter((l) => l.is_major).length,
      decision: i.decisions.find((d) => d.version_id === i.version.id && d.scene_id === sc.id) ?? null,
      revision_request: previousRequest
        ? {
            request_version_id: i.previous!.version.id,
            scene_id: sc.id,
            line_id: previousRequest.line_id!,
            timestamp_ms: previousRequest.timestamp_ms,
            note: previousRequest.note!,
            previous_text_en: previousAdapted?.text_en ?? null,
            revised_text_en: revisedLine?.text_en ?? null,
            revised_rationale_zh: revisedLine?.rationale_zh ?? null,
            resolution_disposition: previousRequest.resolution_disposition,
            resolution_note: previousRequest.resolution_note,
          }
        : null,
    };
  });

  return {
    title: { id: s.title.id, external_id: s.title.external_id, name_zh: s.title.name_zh, name_en: s.title.name_en },
    episode: {
      id: s.episode.id,
      external_id: s.episode.external_id,
      number: s.episode.number,
      name_zh: s.episode.name_zh,
      name_en: s.episode.name_en,
      has_timecodes: s.episode.has_timecodes,
      duration_ms: s.episode.duration_ms,
    },
    version: {
      id: i.version.id,
      external_id: i.version.external_id,
      number: i.version.number,
      status: i.version.status === "approved" ? "approved" : "in_review",
      submitted_at: i.version.submitted_at,
      approved_at: i.version.approved_at,
      approval_mode: i.version.approval_mode,
      snapshot_sha256: i.version.snapshot_sha256,
    },
    scenes,
    can_decide: i.can_decide,
    can_approve: i.can_approve,
    video_url: i.video_url,
  };
}
