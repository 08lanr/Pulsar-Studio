// The subtitle studio's SRT builder (lib/subtitle-video styledSrt):
// English-only vs bilingual layouts over a snapshot scene.

import { test } from "node:test";
import assert from "node:assert/strict";
import { styledSrt } from "@/lib/subtitle-video";
import type { SnapshotScene } from "@/lib/types";

const scene: SnapshotScene = {
  id: "s1",
  external_id: "sc_test1",
  number: 1,
  title_zh: null,
  summary_zh: null,
  status: "draft",
  start_ms: 0,
  end_ms: 4500,
  context_zh: null,
  context_en: null,
  lines: [
    { id: "l1", external_id: "ln_t1", seq: 1, speaker: null, character_id: null, start_ms: 0, end_ms: 2000, text_zh: "你好。", literal_en: "Hello." },
    { id: "l2", external_id: "ln_t2", seq: 2, speaker: null, character_id: null, start_ms: 2500, end_ms: 4500, text_zh: "再见。", literal_en: "Goodbye." },
  ],
  adapted_lines: [
    {
      id: "a1", external_id: "rw_t1", line_id: "l1", merges: [], seq: 1, start_ms: 0, end_ms: 2000,
      text_en: "Hey there.", key_phrase_en: null, back_translation_zh: "嘿。", change_type: "rewrite", is_major: false,
      rationale_en: null, rationale_zh: "口语化", tone_note_en: null, tone_note_zh: null, tags: [], syllables_est: null,
      authored_by: "ai", model: null, prompt_version: null,
    },
    {
      id: "a2", external_id: "rw_t2", line_id: "l2", merges: [], seq: 2, start_ms: 2500, end_ms: 4500,
      text_en: null, key_phrase_en: null, back_translation_zh: null, change_type: "cut", is_major: false,
      rationale_en: null, rationale_zh: "删去", tone_note_en: null, tone_note_zh: null, tags: [], syllables_est: null,
      authored_by: "ai", model: null, prompt_version: null,
    },
  ],
} as SnapshotScene;

test("english layout: one cue, cut line dropped", () => {
  const srt = styledSrt([scene], "en");
  assert.match(srt, /Hey there\./);
  assert.ok(!srt.includes("你好"), "no Chinese in the English layout");
  assert.ok(!srt.includes("Goodbye"), "the cut line makes no cue");
  assert.equal(srt.trim().split(/\r?\n\r?\n/).length, 1);
});

test("bilingual layout: English above the Chinese original", () => {
  const srt = styledSrt([scene], "en_zh");
  assert.match(srt, /Hey there\.\n你好。/);
});
