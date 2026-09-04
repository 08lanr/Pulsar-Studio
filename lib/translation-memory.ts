// Producer-approved bilingual lines are the Studio's translation memory.
// They already live in immutable version snapshots, so this module derives a
// searchable corpus without duplicating or weakening the approval record.
//
// Over time this is the corpus that teaches the platform: every finalized
// episode adds lines in the register the producer actually accepted. Lines
// the producer wrote or edited by hand (authored_by "editor") are the
// strongest signal of all — they are corrections of the AI — so they rank
// higher and are labelled as such in the prompt.

import { createHash } from "node:crypto";
import { BigramIndex } from "@/lib/memory/rank";
import type { TranslationMemoryExample, Version } from "@/lib/types";

type ApprovedVersion = Pick<Version, "id" | "status" | "approved_at" | "snapshot">;

export function examplesFromApprovedVersions(versions: ApprovedVersion[]): TranslationMemoryExample[] {
  const examples: TranslationMemoryExample[] = [];
  for (const version of versions) {
    if (version.status !== "approved" || !version.snapshot) continue;
    const snapshot = version.snapshot;
    const characterById = new Map(snapshot.characters.map((c) => [c.id, c]));
    for (const scene of snapshot.scenes) {
      const sourceById = new Map(scene.lines.map((line) => [line.id, line]));
      const sourceBySeq = new Map(scene.lines.map((line) => [line.seq, line]));
      for (const adapted of scene.adapted_lines) {
        if (!adapted.text_en?.trim()) continue;
        const source = (adapted.line_id ? sourceById.get(adapted.line_id) : undefined) ?? sourceBySeq.get(adapted.seq);
        if (!source?.text_zh.trim()) continue;
        const character = source.character_id ? characterById.get(source.character_id) : undefined;
        examples.push({
          version_id: version.id,
          approved_at: version.approved_at,
          title_id: snapshot.title.id,
          title_name_zh: snapshot.title.name_zh,
          episode_number: snapshot.episode.number,
          scene_number: scene.number,
          speaker: source.speaker,
          character_name_en: character?.name_en ?? null,
          text_zh: source.text_zh,
          text_en: adapted.text_en,
          rationale_en: adapted.rationale_en,
          tags: adapted.tags,
          authored_by: adapted.authored_by,
        });
      }
    }
  }
  return examples;
}

export type TranslationMemoryQueryLine = { text_zh: string; speaker: string | null };

/** Similarity floor: below this an approved line is a different beat, not evidence. */
export const APPROVED_MIN_SCORE = 0.2;

/**
 * Closest approved lines to a scene. Similarity (IDF-weighted bigram cosine,
 * 0-1) is the base; the same title adds a little, the same speaker adds a
 * little, a producer's own hand adds more. Swap for embeddings when the
 * corpus warrants it.
 */
export function rankTranslationMemory(
  examples: TranslationMemoryExample[],
  titleId: string,
  lines: TranslationMemoryQueryLine[],
  limit = 12
): TranslationMemoryExample[] {
  if (!examples.length || !lines.length || limit <= 0) return [];
  const index = new BigramIndex(examples, (e) => e.text_zh);
  const best = new Map<TranslationMemoryExample, number>();
  for (const line of lines) {
    for (const hit of index.queryOne(line.text_zh, limit * 3, APPROVED_MIN_SCORE)) {
      const e = hit.item;
      const score =
        hit.score +
        (e.title_id === titleId ? 0.08 : 0) +
        (e.speaker && e.speaker === line.speaker ? 0.12 : 0) +
        (e.authored_by === "editor" ? 0.1 : 0);
      const prev = best.get(e);
      if (prev === undefined || score > prev) best.set(e, score);
    }
  }
  return [...best]
    .sort((a, b) => b[1] - a[1] || (b[0].approved_at ?? "").localeCompare(a[0].approved_at ?? ""))
    .slice(0, limit)
    .map(([e]) => e);
}

export function translationMemoryFingerprint(examples: TranslationMemoryExample[]): string {
  const stable = examples.map((e) => [e.version_id, e.episode_number, e.scene_number, e.text_zh, e.text_en]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 12);
}

export function translationMemoryBlock(examples: TranslationMemoryExample[]): string | null {
  if (!examples.length) return null;
  const rows = examples.map((e, index) => {
    const who = e.speaker ? ` ${e.speaker}${e.character_name_en ? ` / ${e.character_name_en}` : ""}` : "";
    const hand = e.authored_by === "editor" ? " · producer-edited" : "";
    return `[approved ${index + 1}${hand}]${who}\n  zh: ${e.text_zh}\n  en: ${e.text_en}`;
  });
  return `APPROVED TRANSLATION MEMORY
These lines were approved in Pulsar Studio. Use them as evidence for house style, recurring terminology and character voice. Lines marked producer-edited were written or corrected by the producer's own hand: they show the voice the producer wants — weigh them most. They are examples, not plot facts: copy wording only when the current Chinese and scene support the same meaning. Current source and title bible always win.

${rows.join("\n")}`;
}
