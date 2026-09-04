// Short-cue pairing (lib/subtitle-timing mergeShortCues) and the sampled-
// stamp detector behind the studio's offset suggestion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksFrameSampled, mergeShortCues } from "@/lib/subtitle-timing";

test("two short neighbors pair into a two-row cue spanning both windows", () => {
  const merged = mergeShortCues([
    { start_ms: 1000, end_ms: 2000, text: "Hey." },
    { start_ms: 2100, end_ms: 3200, text: "You made it." },
    { start_ms: 9000, end_ms: 10500, text: "Far away line." },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { start_ms: 1000, end_ms: 3200, text: "Hey.\nYou made it." });
  assert.equal(merged[1].text, "Far away line.");
});

test("pairs never chain into three rows", () => {
  const merged = mergeShortCues([
    { start_ms: 0, end_ms: 900, text: "One." },
    { start_ms: 1000, end_ms: 1900, text: "Two." },
    { start_ms: 2000, end_ms: 2900, text: "Three." },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "One.\nTwo.");
  assert.equal(merged[1].text, "Three.");
});

test("wide gaps, long spans and long text refuse to pair", () => {
  const gap = mergeShortCues([
    { start_ms: 0, end_ms: 1000, text: "A." },
    { start_ms: 1500, end_ms: 2500, text: "B." },
  ]);
  assert.equal(gap.length, 2, "a 500ms gap stays separate");
  const long = mergeShortCues([
    { start_ms: 0, end_ms: 3500, text: "x".repeat(40) },
    { start_ms: 3600, end_ms: 7000, text: "y".repeat(40) },
  ]);
  assert.equal(long.length, 2, "80 combined chars stays separate");
  const multiline = mergeShortCues([
    { start_ms: 0, end_ms: 1000, text: "already\ntwo rows" },
    { start_ms: 1100, end_ms: 2000, text: "short" },
  ]);
  assert.equal(multiline.length, 2, "a two-row cue never takes a third");
});

test("whole-second starts read as frame-sampled; mixed ones do not", () => {
  assert.equal(looksFrameSampled([1000, 2000, 6000, 9000, 13000]), true);
  assert.equal(looksFrameSampled([1017, 2483, 6250, 9101, 13733]), false);
  assert.equal(looksFrameSampled([1000, 2000]), false, "too few cues to judge");
});
