// The episode picker's sorting rule (lib/ingest/episode-slots): a dropped
// file that names its episode lands on that episode and nowhere else.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assignFiles, emptySlot, type EpisodeSlot } from "@/lib/ingest/episode-slots";

const f = (name: string) => ({ name }) as File;
const numbers = (slots: EpisodeSlot[]) => slots.map((s) => s.number);

test("a file that names an episode with no row gets its own row, never another episode's open slot", () => {
  const slots = assignFiles([emptySlot(1), emptySlot(2)], [f("ep30.mp4")], 1);
  assert.deepEqual(numbers(slots), [1, 2, 30]);
  assert.equal(slots[0].video, null, "episode 1 did not receive episode 30's video");
  assert.equal(slots[2].video?.name, "ep30.mp4");
});

test("a named file joins the row of its number, and the latest pick wins that slot", () => {
  let slots = assignFiles([emptySlot(1), emptySlot(2)], [f("第2集.srt"), f("第2集.mp4")], 1);
  assert.deepEqual(numbers(slots), [1, 2]);
  assert.equal(slots[1].subtitle?.name, "第2集.srt");
  assert.equal(slots[1].video?.name, "第2集.mp4");
  slots = assignFiles(slots, [f("第2集 v2.mp4")], 1);
  assert.equal(slots[1].video?.name, "第2集 v2.mp4");
  assert.equal(slots[0].video, null);
});

test("a named file whose row is already uploaded becomes a visible duplicate, not a silent renumber", () => {
  const done: EpisodeSlot = { ...emptySlot(3), status: "ok" };
  const slots = assignFiles([done], [f("ep03.mp4")], 1);
  assert.deepEqual(numbers(slots), [3, 3]);
  assert.equal(slots[0].status, "ok");
  assert.equal(slots[1].video?.name, "ep03.mp4");
});

test("a nameless file takes the first open slot of its kind, then a new row from the start number", () => {
  let slots = assignFiles([emptySlot(4), emptySlot(5)], [f("final.srt"), f("footage.mp4")], 4);
  assert.deepEqual(numbers(slots), [4, 5]);
  assert.equal(slots[0].subtitle?.name, "final.srt");
  assert.equal(slots[0].video?.name, "footage.mp4");
  slots = assignFiles(slots, [f("more.mp4"), f("extra.mp4")], 4);
  assert.deepEqual(numbers(slots), [4, 5, 6]);
  assert.equal(slots[1].video?.name, "more.mp4");
  assert.equal(slots[2].video?.name, "extra.mp4");
});

test("partial renders and foreign files are ignored", () => {
  const before = [emptySlot(1)];
  const same = assignFiles(before, [f("ep30.part.mp4"), f("notes.docx")], 1);
  assert.equal(same, before, "nothing usable: the same array comes back");
});
