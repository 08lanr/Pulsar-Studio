// QC preflight rules (lib/qc.ts): the numbers a subtitle house checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runQc } from "@/lib/qc";
import type { AdaptedLine, Line } from "@/lib/types";

let seq = 0;
function line(start: number | null, end: number | null, id?: string): Line {
  seq += 1;
  return {
    id: id ?? `l${seq}`,
    external_id: `ln_test${seq}`,
    title_id: "t",
    scene_id: "s",
    seq,
    speaker: null,
    character_id: null,
    start_ms: start,
    end_ms: end,
    duration_ms: start !== null && end !== null ? end - start : null,
    text_zh: "中文",
    literal_en: null,
    merged_into_id: null,
    created_at: "2026-09-04T00:00:00.000Z",
  };
}
function adapted(l: Line, text: string | null, extra: Partial<AdaptedLine> = {}): AdaptedLine {
  return {
    id: `a${l.id}`,
    external_id: `rw_test${l.seq}`,
    title_id: "t",
    version_id: "v",
    scene_id: "s",
    line_id: l.id,
    merges: [],
    seq: l.seq,
    start_ms: l.start_ms,
    end_ms: l.end_ms,
    text_en: text,
    key_phrase_en: null,
    back_translation_zh: "回译",
    change_type: "rewrite",
    is_major: false,
    rationale_en: null,
    rationale_zh: "理由",
    tone_note_en: null,
    tone_note_zh: null,
    tags: [],
    syllables_est: null,
    authored_by: "ai",
    model: null,
    prompt_version: null,
    ai_text_en: text,
    ai_rationale_zh: null,
    edited_by: null,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    ...extra,
  };
}

test("clean cues pass", () => {
  const l1 = line(0, 2000);
  const l2 = line(2200, 4200);
  const r = runQc({ lines: [l1, l2], adapted: [adapted(l1, "Short and easy."), adapted(l2, "Also fine here.")] });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.lines, 2);
});

test("missing and empty translations are errors", () => {
  const l1 = line(0, 2000);
  const l2 = line(2200, 4200);
  const r = runQc({ lines: [l1, l2], adapted: [adapted(l2, "  ")] });
  assert.deepEqual(r.errors.map((i) => i.code).sort(), ["empty_line", "missing_translation"]);
});

test("reading speed: warn above 17 cps, error above 20 cps", () => {
  const slow = line(0, 3000);
  const brisk = line(3200, 4200); // 1s
  const flood = line(4400, 5400); // 1s
  const r = runQc({
    lines: [slow, brisk, flood],
    adapted: [
      adapted(slow, "Twelve chars"),
      adapted(brisk, "Eighteen characters!!"), // 18 non-space chars -> 18 cps
      adapted(flood, "This sentence is far too long for one second."), // ~38 cps
    ],
  });
  assert.equal(r.errors.filter((i) => i.code === "reading_speed").length, 1);
  assert.equal(r.warnings.filter((i) => i.code === "reading_speed").length, 1);
});

test("overlap is an error; a hairline gap is a warning; cut lines are exempt from text checks", () => {
  const a = line(0, 2000);
  const b = line(1900, 3900); // overlaps a
  const c = line(3940, 6000); // 40ms gap after b
  const r = runQc({
    lines: [a, b, c],
    adapted: [adapted(a, "One."), adapted(b, "Two."), adapted(c, null, { change_type: "cut" })],
  });
  assert.equal(r.errors.filter((i) => i.code === "overlap").length, 1);
  assert.equal(r.warnings.filter((i) => i.code === "tiny_gap").length, 1);
  assert.ok(!r.errors.some((i) => i.code === "empty_line"), "a cut line needs no text");
});

test("shape: >2 rendered lines errors, wide line warns, short cue warns", () => {
  const a = line(0, 500); // 500ms -> too short
  const b = line(1000, 6000);
  const r = runQc({
    lines: [a, b],
    adapted: [
      adapted(a, "Hi."),
      adapted(b, "one\ntwo\nthree" + " ", { change_type: "rewrite" }),
    ],
  });
  assert.ok(r.warnings.some((i) => i.code === "cue_too_short"));
  assert.ok(r.errors.some((i) => i.code === "too_many_lines"));
  const wide = line(7000, 12000);
  const r2 = runQc({ lines: [wide], adapted: [adapted(wide, "x".repeat(50))] });
  assert.ok(r2.warnings.some((i) => i.code === "line_too_long"));
});

test("name consistency: a squashed character name warns", () => {
  const a = line(0, 3000);
  const r = runQc({
    lines: [a],
    adapted: [adapted(a, "So you're XiangYuan.")],
    characterNames: new Map([["c1", "Xiang Yuan"]]),
  });
  assert.ok(r.warnings.some((i) => i.code === "name_inconsistent"));
});
