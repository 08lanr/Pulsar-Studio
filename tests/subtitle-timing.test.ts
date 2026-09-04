// The timing desk, top to bottom: the pure offset/validation math
// (lib/subtitle-timing), the fixture data layer's persistence, read-only
// authorization, and the promise that SRT/VTT exports and the burn's SRT
// all speak the adjusted timeline — applied exactly once.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { toSrt, toVtt } from "@/lib/export";
import { applyGlobalOffset, assertValidCue, timingIssues } from "@/lib/subtitle-timing";
import { styledSrt } from "@/lib/subtitle-video";
import { producer, seedMinute } from "./seed-minute";

afterEach(() => resetFixtureStore());

const viewer = (): Session => ({
  userId: "00000000-0000-4000-8000-0000000000f9",
  kind: "producer",
  producerId: "00000000-0000-4000-8000-000000000001",
  producerRole: "viewer",
  displayName: "旁观者",
  locale: "zh",
});

// ---- pure math -------------------------------------------------------------

test("a -500 ms offset shifts 1000 to 500 and keeps durations", () => {
  const r = applyGlobalOffset([{ start_ms: 1000, end_ms: 3000 }], -500);
  assert.deepEqual([r.cues[0].start_ms, r.cues[0].end_ms], [500, 2500]);
  assert.equal(r.shifted, 1);
  assert.equal(r.clamped, 0);
});

test("a 200 ms start clamps to 0 with its duration preserved", () => {
  const r = applyGlobalOffset([{ start_ms: 200, end_ms: 1200 }], -500);
  assert.deepEqual([r.cues[0].start_ms, r.cues[0].end_ms], [0, 1000]);
  assert.equal(r.clamped, 1);
});

test("clamping never creates an overlap: the later cue is pushed after the first", () => {
  const r = applyGlobalOffset(
    [
      { start_ms: 100, end_ms: 900 },
      { start_ms: 400, end_ms: 1400 },
    ],
    -500
  );
  // Both would clamp to 0; the second is pushed to the first's end, both
  // durations intact and the order preserved.
  assert.deepEqual([r.cues[0].start_ms, r.cues[0].end_ms], [0, 800]);
  assert.deepEqual([r.cues[1].start_ms, r.cues[1].end_ms], [800, 1800]);
  assert.equal(r.clamped, 2);
});

test("a pre-existing overlap passes through untouched (QC's business, not the shift's)", () => {
  const r = applyGlobalOffset(
    [
      { start_ms: 5000, end_ms: 8000 },
      { start_ms: 7000, end_ms: 9000 },
    ],
    -500
  );
  assert.deepEqual([r.cues[0].start_ms, r.cues[1].start_ms], [4500, 6500]);
  assert.equal(r.cues[0].end_ms, 7500, "still overlapping, exactly as the source did");
});

test("per-cue validation rejects negatives and reversed ranges", () => {
  assert.throws(() => assertValidCue({ start_ms: -1, end_ms: 100 }), /negative/);
  assert.throws(() => assertValidCue({ start_ms: 500, end_ms: 500 }), /after start/);
  assert.throws(() => assertValidCue({ start_ms: 0.5 as number, end_ms: 100 }), /integer/);
  assertValidCue({ start_ms: 0, end_ms: 1 });
});

test("timingIssues flags overlap, short cues and past-video cues", () => {
  const issues = timingIssues(
    [
      { start_ms: 0, end_ms: 200 }, // too_short
      { start_ms: 100, end_ms: 2000 }, // overlap with previous
      { start_ms: 2500, end_ms: 4000 }, // beyond a 3s video
    ],
    3000
  );
  assert.deepEqual(issues.map((i) => i.code).sort(), ["beyond_video", "overlap", "too_short"]);
});

// ---- data layer ------------------------------------------------------------

test("a persisted -500 offset moves the stored lines and mirrors adapted rows once", async () => {
  const t = await seedMinute({ adapt: true });
  const before = await fixtureData.getWorkbench(producer(), t.id, 1);
  const firstStart = before.lines[0].start_ms!;

  const r = await fixtureData.applyEpisodeTimingOffset(producer(), t.id, 1, -500);
  assert.equal(r.shifted, before.lines.length);

  const after = await fixtureData.getWorkbench(producer(), t.id, 1);
  assert.equal(after.lines[0].start_ms, Math.max(0, firstStart - 500));
  const adapted = after.adapted_lines.find((a) => a.line_id === after.lines[0].id);
  assert.equal(adapted?.start_ms, after.lines[0].start_ms, "adapted rows track their line");

  // The offset lives in the rows: exporting twice yields identical bytes —
  // nothing re-applies it.
  const srt1 = toSrt(after.adapted_lines, after.lines);
  const srt2 = toSrt(after.adapted_lines, after.lines);
  assert.equal(srt1, srt2);
});

test("exact per-cue edits persist with millisecond precision", async () => {
  const t = await seedMinute({ adapt: true });
  const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  const target = wb.lines[2];
  await fixtureData.updateLineTimings(producer(), t.id, 1, [{ line_id: target.id, start_ms: 6543, end_ms: 8321 }]);
  const after = await fixtureData.getWorkbench(producer(), t.id, 1);
  const line = after.lines.find((l) => l.id === target.id)!;
  assert.equal(line.start_ms, 6543);
  assert.equal(line.end_ms, 8321);
  assert.equal(line.duration_ms, 1778);
});

test("viewer-role producers cannot touch timing", async () => {
  const t = await seedMinute({ adapt: true });
  await assert.rejects(fixtureData.applyEpisodeTimingOffset(viewer(), t.id, 1, -500), /edit|forbidden|editor/i);
  const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  await assert.rejects(
    fixtureData.updateLineTimings(viewer(), t.id, 1, [{ line_id: wb.lines[0].id, start_ms: 0, end_ms: 1000 }]),
    /edit|forbidden|editor/i
  );
});

// ---- exports and the burn --------------------------------------------------

test("SRT and VTT exports speak the adjusted timeline", async () => {
  const t = await seedMinute({ adapt: true });
  await fixtureData.applyEpisodeTimingOffset(producer(), t.id, 1, -500);
  const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  const srt = toSrt(wb.adapted_lines, wb.lines);
  const vtt = toVtt(wb.adapted_lines, wb.lines);
  const first = wb.lines.filter((l) => l.start_ms !== null).sort((a, b) => a.start_ms! - b.start_ms!)[0];
  const h = Math.floor(first.start_ms! / 3600000);
  const m = Math.floor(first.start_ms! / 60000) % 60;
  const s = Math.floor(first.start_ms! / 1000) % 60;
  const ms = first.start_ms! % 1000;
  const srtStamp = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  assert.ok(srt.includes(srtStamp), `srt carries ${srtStamp}`);
  assert.ok(vtt.includes(srtStamp.replace(",", ".")), "vtt carries the same instant");
});

test("the burn's SRT comes from the refinalized snapshot with adjusted times", async () => {
  const t = await seedMinute({ adapt: true });
  let wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  await fixtureData.finalizeVersion(producer(), wb.version!.id);

  // The offset route's flow: shift rows, fork the approved version, refinalize.
  await fixtureData.applyEpisodeTimingOffset(producer(), t.id, 1, -500);
  wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  const draft = await fixtureData.forkVersion(producer(), wb.version!.id);
  await fixtureData.finalizeVersion(producer(), draft.id);

  const snap = await fixtureData.getExportSnapshot(producer(), t.id, 1);
  assert.equal(snap.source, "approved");
  const lines = snap.snapshot.scenes.flatMap((sc) => sc.lines);
  const stored = await fixtureData.getWorkbench(producer(), t.id, 1);
  assert.deepEqual(
    lines.map((l) => l.start_ms).slice(0, 3),
    stored.lines.map((l) => l.start_ms).slice(0, 3),
    "the frozen snapshot carries the shifted rows"
  );
  const enSrt = styledSrt(snap.snapshot.scenes, "en");
  const zhSrt = styledSrt(snap.snapshot.scenes, "en_zh");
  const firstTimed = lines.filter((l) => l.start_ms !== null)[0];
  const sec = Math.floor(firstTimed.start_ms! / 1000) % 60;
  const stamp = `00:00:${String(sec).padStart(2, "0")},${String(firstTimed.start_ms! % 1000).padStart(3, "0")}`;
  assert.ok(enSrt.includes(stamp), "english burn uses adjusted times");
  assert.ok(zhSrt.includes(stamp), "bilingual burn stays on the same clock");
});
