import assert from "node:assert/strict";
import test from "node:test";
import type { TranslationMemoryExample, Version } from "@/lib/types";
import {
  examplesFromApprovedVersions,
  rankTranslationMemory,
  translationMemoryBlock,
  translationMemoryFingerprint,
} from "@/lib/translation-memory";

function approvedVersion(status: Version["status"] = "approved"): Version {
  const at = "2026-09-04T12:00:00.000Z";
  return {
    id: "version-1",
    external_id: "ver_approved",
    title_id: "title-1",
    adaptation_id: "adaptation-1",
    episode_id: "episode-1",
    number: 1,
    parent_version_id: null,
    status,
    submitted_at: at,
    submitted_by: "producer-1",
    approved_at: status === "approved" ? at : null,
    approved_by: status === "approved" ? "producer-1" : null,
    approval_mode: status === "approved" ? "in_app" : null,
    approval_evidence: null,
    approval_note: null,
    created_at: at,
    updated_at: at,
    snapshot_sha256: "hash",
    snapshot: {
      schema: 1,
      version: {
        id: "version-1",
        external_id: "ver_approved",
        number: 1,
        adaptation_id: "adaptation-1",
        adaptation_external_id: "ad_approved",
        target_locale: "en-US",
        display_title_en: "The Deal",
      },
      title: {
        id: "title-1",
        external_id: "ttl_approved",
        name_zh: "交易",
        name_en: "The Deal",
        producer_id: "producer-1",
      },
      episode: {
        id: "episode-1",
        external_id: "ep_approved",
        number: 1,
        name_zh: null,
        name_en: null,
        duration_ms: 10_000,
        has_timecodes: true,
      },
      characters: [{ id: "character-1", name_zh: "林晚", name_en: "Lynn", notes: "Dry and direct." }],
      scenes: [
        {
          id: "scene-1",
          external_id: "sc_approved",
          number: 1,
          start_ms: 0,
          end_ms: 2_000,
          context_zh: null,
          context_en: null,
          status: "approved",
          lines: [
            {
              id: "line-1",
              external_id: "ln_approved",
              seq: 1,
              speaker: "林晚",
              character_id: "character-1",
              start_ms: 0,
              end_ms: 2_000,
              text_zh: "我只想听真话。",
              literal_en: "I only want to hear the truth.",
            },
          ],
          adapted_lines: [
            {
              id: "adapted-1",
              external_id: "rw_approved",
              line_id: "line-1",
              merges: [],
              seq: 1,
              start_ms: 0,
              end_ms: 2_000,
              text_en: "Just tell me the truth.",
              key_phrase_en: "Just tell me",
              back_translation_zh: "直接告诉我真相。",
              change_type: "rewrite",
              is_major: false,
              rationale_en: "Natural confrontation dialogue.",
              rationale_zh: "更像争执中的口语。",
              tone_note_en: null,
              tone_note_zh: null,
              tags: ["more_direct"],
              syllables_est: 6,
              authored_by: "editor",
              model: "claude-opus-5",
              prompt_version: "v1",
            },
          ],
        },
      ],
    },
  };
}

test("approved snapshots become bilingual translation-memory examples", () => {
  const examples = examplesFromApprovedVersions([approvedVersion(), approvedVersion("draft")]);
  assert.equal(examples.length, 1);
  assert.equal(examples[0].text_zh, "我只想听真话。");
  assert.equal(examples[0].text_en, "Just tell me the truth.");
  assert.equal(examples[0].character_name_en, "Lynn");
  assert.equal(examples[0].authored_by, "editor");
});

test("retrieval prefers exact and same-character approved lines", () => {
  const exact = examplesFromApprovedVersions([approvedVersion()])[0];
  const unrelated: TranslationMemoryExample = {
    ...exact,
    version_id: "version-2",
    text_zh: "明天董事会见。",
    text_en: "See you at the board meeting tomorrow.",
    speaker: "沈总",
  };
  const ranked = rankTranslationMemory([unrelated, exact], "title-1", [
    { text_zh: "我只想听真话！", speaker: "林晚" },
  ]);
  assert.equal(ranked[0].version_id, exact.version_id);
});

test("memory prompts identify approvals as style evidence, not story facts", () => {
  const examples = examplesFromApprovedVersions([approvedVersion()]);
  const block = translationMemoryBlock(examples);
  assert.match(block ?? "", /approved in Pulsar Studio/i);
  assert.match(block ?? "", /not plot facts/i);
  assert.equal(translationMemoryFingerprint(examples), translationMemoryFingerprint(examples));
  assert.notEqual(
    translationMemoryFingerprint(examples),
    translationMemoryFingerprint([{ ...examples[0], text_en: "Tell me the truth." }])
  );
});
