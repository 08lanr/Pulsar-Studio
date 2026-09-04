// Bracket-stamped transcripts ("[00:00:01.00] 台词") ingest as TIMED
// episodes: stamps lifted into start_ms, ends derived from the next line,
// stamp stripped from the text. Found via the founder's real upload, which
// hit "subtitles need a timed episode" with the times sitting in the text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestEpisodeFile } from "@/lib/ingest";

const STAMPED = [
  "[00:00:01.00] 你奶奶走了以后",
  "[00:00:02.00] 我就没喝过一口热汤",
  "[00:00:06.00] 原来董事长在这儿",
  "[00:00:09.50] 杨总：久仰久仰",
].join("\n");

test("stamped transcript becomes a timed episode", () => {
  const r = ingestEpisodeFile(STAMPED, "ep1.txt");
  assert.equal(r.hasTimecodes, true);
  assert.equal(r.lines.length, 4);
  // Whole-second stamps read as frame-sampled: everything lands 500ms early.
  assert.deepEqual(
    r.lines.map((l) => l.start_ms),
    [500, 1500, 5500, 9000]
  );
  assert.equal(r.lines[0].end_ms, 1500, "end comes from the next line's start");
  assert.equal(r.lines[1].end_ms, 5500);
  assert.equal(r.lines[3].end_ms, 11500, "the last line gets a default length");
  assert.equal(r.lines[0].text_zh, "你奶奶走了以后", "the stamp leaves the text");
  assert.equal(r.lines[3].speaker, "杨总", "speaker splitting still applies");
  assert.ok(r.warnings.some((w) => w.includes("stamps")), "the derivation is disclosed");
});

test("a long silence caps the derived cue at 7s", () => {
  const r = ingestEpisodeFile("[00:00:01] 第一句\n[00:00:30] 第二句", "ep.txt");
  assert.equal(r.lines[0].start_ms, 500, "sampling latency corrected");
  assert.equal(r.lines[0].end_ms, 7500);
});

test("a genuinely plain script stays untimed", () => {
  const r = ingestEpisodeFile("向园：这是普通剧本\n杨总：没有时间码", "ep.txt");
  assert.equal(r.hasTimecodes, false);
  assert.equal(r.lines[0].start_ms, null);
});
