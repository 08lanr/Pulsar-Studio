// The V2.1 producer flow over the EMPTY seed: every test builds its state
// through the real pipeline (tests/seed-minute.ts ingests the founder's
// demo SRT; the replay bank adapts it). Guards that must hold: the replay
// covers every line; finalize needs NO scene confirms but full content
// readiness; approved versions freeze; fork reopens; producers stay scoped.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { replayFirstPass } from "@/lib/demo-replay";
import { producer, seedMinute, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

test("the seed is empty and the founder's minute ingests through the real pipeline", async () => {
  resetFixtureStore();
  assert.equal((await fixtureData.listTitles(producer())).length, 0, "V2.1 starts with no titles");
  const t = await seedMinute();
  const titles = await fixtureData.listTitles(producer());
  assert.equal(titles.length, 1);
  const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  assert.equal(wb.lines.length, 24);
  assert.equal(wb.adapted_lines.length, 0, "the seed ships un-adapted; 生成 is the demo's first act");
  assert.ok(wb.version, "an empty draft version exists for the first pass to write into");
});

test("the demo replay adapts every seeded line with rationale and literal", async () => {
  const t = await seedMinute();
  const r = await replayFirstPass(producer(), t.id, 1);
  assert.equal(r.unmatched, 0, "every line of the founder's footage must be in the bank");
  const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  assert.equal(wb.adapted_lines.length, 24);
  const changed = wb.adapted_lines.filter((a) => a.change_type !== "keep");
  assert.ok(changed.every((a) => a.rationale_zh), "every changed line explains itself in Chinese");
  assert.ok(
    wb.lines.some((l) => l.literal_en && l.literal_en.length > 0),
    "the burned subs land as the literal baseline"
  );
  assert.ok(
    wb.adapted_lines.some((a) => a.key_phrase_en),
    "key phrases exist for the sheet highlight"
  );
});

test("finalize needs no scene confirms, freezes a snapshot, and fork reopens", async () => {
  const t = await seedMinute({ adapt: true });
  let wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  assert.ok(wb.scenes.every((s) => s.status === "draft"), "no scene was confirmed");

  const finalized = await fixtureData.finalizeVersion(producer(), wb.version!.id);
  assert.equal(finalized.status, "approved");
  assert.ok(finalized.snapshot_sha256, "approval freezes a hashed snapshot");

  const line = (await fixtureData.getWorkbench(producer(), t.id, 1)).adapted_lines[0];
  await assert.rejects(
    fixtureData.updateAdaptedLine(producer(), line.id, { text_en: "tamper" }),
    (e: unknown) => e instanceof Error && /frozen|fork/.test(e.message),
    "a finalized version refuses edits"
  );

  const draft = await fixtureData.forkVersion(producer(), finalized.id);
  assert.equal(draft.status, "draft");
  wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  assert.equal(wb.version?.id, draft.id);
  const forked = wb.adapted_lines.find((a) => a.version_id === draft.id);
  assert.ok(forked, "adapted lines carry over into the new draft");
  await fixtureData.updateAdaptedLine(producer(), forked!.id, { text_en: "A fresh read." });
});

test("finalize refuses an episode whose lines are not ready", async () => {
  const t = await seedMinute();
  const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  await assert.rejects(
    fixtureData.finalizeVersion(producer(), wb.version!.id),
    (e: unknown) => e instanceof Error && /not ready|adaptation/.test(e.message),
    "an un-adapted episode cannot be finalized"
  );
});

test("staff cannot finalize on the producer's behalf", async () => {
  const t = await seedMinute({ adapt: true });
  const wb = await fixtureData.getWorkbench(staff(), t.id, 1);
  await assert.rejects(
    fixtureData.finalizeVersion(staff(), wb.version!.id),
    (e: unknown) => e instanceof Error && /producer/.test(e.message),
    "finalize records the rights holder's own click"
  );
});

test("a producer's writes stay inside their own titles", async () => {
  await seedMinute();
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  const foreign = await fixtureData.createTitle(staff(), { name_zh: "别家的剧", producer_id: other.id });
  await assert.rejects(
    fixtureData.getTitle(producer(), foreign.id),
    (e: unknown) => e instanceof Error && /not found/i.test(e.message),
    "a foreign title reads as not found, never as forbidden"
  );
  const mine = await fixtureData.createTitle(producer(), { name_zh: "我的新剧", producer_id: other.id });
  assert.notEqual(mine.producer_id, other.id, "a producer's create is forced onto their own company");
});
