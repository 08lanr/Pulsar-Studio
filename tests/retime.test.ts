// The stamp-retime repair (fixture data layer): an episode ingested BEFORE
// the bracket-stamp fix — times trapped in text_zh, has_timecodes false —
// is lifted into a real timeline in place.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import type { IngestResult } from "@/lib/ingest";
import { producer } from "./seed-minute";

afterEach(() => resetFixtureStore());

/** What the old parser produced from a stamped transcript. */
function legacyIngest(): IngestResult {
  const texts = ["[00:00:01.00] 你奶奶走了之后", "[00:00:02.00] 我就没喝过", "[00:00:06.00] 杨总：久仰久仰"];
  return {
    format: "txt",
    hasTimecodes: false,
    lines: texts.map((t, i) => ({ seq: i + 1, start_ms: null, end_ms: null, text_zh: t, speaker: null })),
    scenes: [{ number: 1, start_ms: null, end_ms: null, from_seq: 1, to_seq: texts.length }],
    warnings: [],
  };
}

test("retime lifts stamps from stored text and marks the episode timed", async () => {
  resetFixtureStore();
  const title = await fixtureData.createTitle(producer(), { name_zh: "旧导入", producer_id: "ignored" });
  await fixtureData.addEpisodeFromIngest(producer(), title.id, 1, legacyIngest(), { subtitlePath: null, videoPath: null });

  let wb = await fixtureData.getWorkbench(producer(), title.id, 1);
  assert.equal(wb.episode.has_timecodes, false, "the legacy episode starts untimed");

  const r = await fixtureData.retimeEpisodeFromStamps(producer(), title.id, 1);
  assert.equal(r.timed, 3);

  wb = await fixtureData.getWorkbench(producer(), title.id, 1);
  assert.equal(wb.episode.has_timecodes, true);
  // Whole-second stamps read as frame-sampled: corrected 500ms earlier.
  assert.deepEqual(
    wb.lines.map((l) => l.start_ms),
    [500, 1500, 5500]
  );
  assert.equal(wb.lines[0].end_ms, 1500, "end from the next line's start");
  assert.equal(wb.lines[0].text_zh, "你奶奶走了之后", "the stamp leaves the text");
  assert.equal(wb.lines[2].speaker, "杨总", "the hidden speaker prefix is recovered");
  assert.ok((wb.episode.duration_ms ?? 0) >= 8000, "episode duration follows the last cue");
});

test("retime refuses an episode with no stamps", async () => {
  resetFixtureStore();
  const title = await fixtureData.createTitle(producer(), { name_zh: "普通剧本", producer_id: "ignored" });
  const plain: IngestResult = {
    format: "txt",
    hasTimecodes: false,
    lines: [
      { seq: 1, start_ms: null, end_ms: null, text_zh: "没有时间码的一句", speaker: null },
      { seq: 2, start_ms: null, end_ms: null, text_zh: "另一句", speaker: null },
    ],
    scenes: [{ number: 1, start_ms: null, end_ms: null, from_seq: 1, to_seq: 2 }],
    warnings: [],
  };
  await fixtureData.addEpisodeFromIngest(producer(), title.id, 1, plain, { subtitlePath: null, videoPath: null });
  await assert.rejects(
    fixtureData.retimeEpisodeFromStamps(producer(), title.id, 1),
    (e: unknown) => e instanceof Error && /no per-line/.test(e.message)
  );
});
