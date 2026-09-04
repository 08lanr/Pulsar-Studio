// Builds the frozen VersionSnapshot the way studio.build_snapshot() does in
// 0001_init.sql, key for key: the version (with its adaptation folded in),
// title, episode, every character of the title, and per scene the source
// lines and the adapted lines of one version. Row uuids ride beside the
// external ids, as in the database. The fixture uses it for ep1 v1; the
// fixture data layer can use the same function when staff submit in
// DATA_SOURCE=fixture, so the two paths freeze identical JSON.
//
// Server-only: sha256 comes from node:crypto. Import from route handlers,
// server components and scripts, never from a client component.

import { createHash } from "node:crypto";
import {
  canonicalJson,
  SNAPSHOT_SCHEMA,
  type AdaptedLine,
  type Adaptation,
  type Character,
  type Episode,
  type Line,
  type Scene,
  type Title,
  type Version,
  type VersionSnapshot,
} from "@/lib/types";

export type SnapshotInput = {
  title: Title;
  adaptation: Adaptation;
  episode: Episode;
  version: Version;
  characters: Character[];
  scenes: Scene[];
  lines: Line[];
  adapted_lines: AdaptedLine[];
};

/** Bytewise (code-point) order, what `collate "C"` gives Postgres; the names are BMP so code units suffice. */
const byNameZh = (a: Character, b: Character) => (a.name_zh < b.name_zh ? -1 : a.name_zh > b.name_zh ? 1 : 0);

export function buildVersionSnapshot(i: SnapshotInput): VersionSnapshot {
  const scenes = i.scenes
    .filter((s) => s.episode_id === i.episode.id)
    .sort((a, b) => a.number - b.number);

  return {
    schema: SNAPSHOT_SCHEMA,
    version: {
      id: i.version.id,
      external_id: i.version.external_id,
      number: i.version.number,
      adaptation_id: i.adaptation.id,
      adaptation_external_id: i.adaptation.external_id,
      target_locale: i.adaptation.target_locale,
      display_title_en: i.adaptation.display_title_en,
    },
    title: {
      id: i.title.id,
      external_id: i.title.external_id,
      name_zh: i.title.name_zh,
      name_en: i.title.name_en,
      producer_id: i.title.producer_id,
    },
    episode: {
      id: i.episode.id,
      external_id: i.episode.external_id,
      number: i.episode.number,
      name_zh: i.episode.name_zh,
      name_en: i.episode.name_en,
      duration_ms: i.episode.duration_ms,
      has_timecodes: i.episode.has_timecodes,
    },
    characters: i.characters
      .filter((c) => c.title_id === i.title.id)
      .slice()
      .sort(byNameZh)
      .map((c) => ({ id: c.id, name_zh: c.name_zh, name_en: c.name_en, notes: c.notes })),
    scenes: scenes.map((s) => ({
      id: s.id,
      external_id: s.external_id,
      number: s.number,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      context_zh: s.context_zh,
      context_en: s.context_en,
      status: s.status,
      lines: i.lines
        .filter((l) => l.scene_id === s.id)
        .sort((a, b) => a.seq - b.seq)
        .map((l) => ({
          id: l.id,
          external_id: l.external_id,
          seq: l.seq,
          speaker: l.speaker,
          character_id: l.character_id,
          start_ms: l.start_ms,
          end_ms: l.end_ms,
          text_zh: l.text_zh,
          literal_en: l.literal_en,
        })),
      adapted_lines: i.adapted_lines
        .filter((a) => a.version_id === i.version.id && a.scene_id === s.id)
        .sort((a, b) => a.seq - b.seq)
        .map((a) => ({
          id: a.id,
          external_id: a.external_id,
          line_id: a.line_id,
          merges: a.merges,
          seq: a.seq,
          start_ms: a.start_ms,
          end_ms: a.end_ms,
          text_en: a.text_en,
          key_phrase_en: a.key_phrase_en,
          back_translation_zh: a.back_translation_zh,
          change_type: a.change_type,
          is_major: a.is_major,
          rationale_en: a.rationale_en,
          rationale_zh: a.rationale_zh,
          tone_note_en: a.tone_note_en,
          tone_note_zh: a.tone_note_zh,
          tags: a.tags,
          syllables_est: a.syllables_est,
          authored_by: a.authored_by,
          model: a.model,
          prompt_version: a.prompt_version,
        })),
    })),
  };
}

/** sha256 hex over canonicalJson(snapshot); what versions.snapshot_sha256 holds (core.canonical_json in SQL). */
export function snapshotSha256(snapshot: VersionSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
}
