// A show already on crazydramas under another name, found by its episodes'
// lengths (decision 2026-09-24 "Match live shows by episode lengths";
// lib/crazydramas/twin-lengths): the pure comparison; a folder import whose
// episodes match a CMS series takes that series' slug (and is linked, never
// duplicated); a title that already has its own slug is refused a second
// series and moved to the live one; a show whose lengths differ is created as
// before. Fixture mode and its fake crazydramas.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { fakeCrazydramasTransport as fake } from "@/lib/crazydramas/fake";
import { getPublishState, isCdPublishError, resetCrazydramasUploads, saveSeries } from "@/lib/crazydramas/publish";
import { checkCrazydramasTitle, resetCrazydramasSweep } from "@/lib/crazydramas/sweep";
import { compareLengths, isLengthTwin } from "@/lib/crazydramas/twin-lengths";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { importFolder, resetFolderImportRegistry } from "@/lib/film-import/folder";
import type { VideoFacts } from "@/lib/film-import/import";
import { producer, staff } from "./seed-minute";

const sys = systemSession();
const temps: string[] = [];
const LBL = [197, 293, 283, 278, 230, 217, 247, 191];

beforeEach(() => {
  resetFixtureStore();
  resetCrazydramasSweep();
  resetCrazydramasUploads();
  resetFolderImportRegistry();
  fake.reset();
  const dir = mkdtempSync(path.join(tmpdir(), "twin-lengths-"));
  temps.push(dir);
  process.env.STUDIO_LOCAL_MEDIA_DIR = path.join(dir, "local");
});

afterEach(() => {
  resetFixtureStore();
  resetFolderImportRegistry();
  fake.reset();
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A folder of `lengths.length` episodes; the probe answers each episode's length by the order its copy is probed. */
async function importWithLengths(name: string, lengths: number[], skipSlug: boolean) {
  const parent = mkdtempSync(path.join(tmpdir(), "twin-folder-"));
  temps.push(parent);
  const dir = path.join(parent, name);
  mkdirSync(dir);
  lengths.forEach((_, i) => writeFileSync(path.join(dir, `ep${i + 1}.mp4`), Buffer.from(`${name} ep${i + 1} ${"x".repeat(100)}`)));
  let n = 0;
  const probe = async (): Promise<VideoFacts> => {
    const s = lengths[n++];
    return { width: 1080, height: 1920, fps: 30, frames: Math.round(s * 30), duration_s: s };
  };
  await importFolder(staff(), { folder: dir }, producer().producerId!, staff().userId, { probe, skipSlug });
  return (await fixtureData.findTitleBySourceRef(sys, producer().producerId!, `_folders/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`))!;
}

test("compareLengths / isLengthTwin: three or more lengths (30 s and up) within 1.5 s, and 80% of those compared", () => {
  assert.deepEqual(compareLengths(LBL, LBL.map((x) => x + 1)), { matched: 6, compared: 6 });
  assert.equal(isLengthTwin(compareLengths(LBL, LBL)), true);
  assert.equal(isLengthTwin(compareLengths(LBL, [197, 293, 999, 278, 230, 217])), true, "one re-cut episode still matches");
  assert.equal(isLengthTwin(compareLengths(LBL, [197, 293, 999, 999, 230, 217])), false, "two of six differ: not the same show");
  assert.equal(isLengthTwin(compareLengths([197, 293, null, null, null, null], LBL)), false, "two lengths are too few to tell");
  assert.equal(isLengthTwin(compareLengths(LBL, LBL.map((x) => x + 3))), false);
  assert.equal(isLengthTwin(compareLengths([4, 5, 6, 7], [4, 5, 6, 7])), false, "episodes of a few seconds say nothing");
});

test("a folder import whose episodes match a CMS series under another name takes that series' slug", async () => {
  fake.addCmsSeries("who-are-you-when-the-game-ends-season-1", "Who Are You When the Game Ends? Season 1", LBL.slice(0, 6));
  const title = await importWithLengths("Lines Between Us", LBL, false);
  assert.equal(title.crazydramas_slug, "who-are-you-when-the-game-ends-season-1");
});

test("creating a series for a title already live under another name is refused, and the title is moved to the live series", async () => {
  // A name no working-name table knows: only the lengths can find it.
  const title = await importWithLengths("Lines Between Us", LBL, true);
  await fixtureData.setTitleImport(sys, title.id, { crazydramas_slug: "lines-between-us" });
  fake.addCmsSeries("who-are-you-when-the-game-ends-season-1", "Who Are You When the Game Ends? Season 1", LBL.slice(0, 6));
  const writes = fake.requests.filter((r) => r.method !== "GET").length;
  let code = "";
  let message = "";
  try {
    await saveSeries(producer(), title.id, { title: "Lines Between Us" });
  } catch (e) {
    assert.ok(isCdPublishError(e), String(e));
    code = e.code;
    message = e.message;
  }
  assert.equal(code, "series_episodes_exist");
  assert.match(message, /Who Are You When the Game Ends\? Season 1.*6 of the first 6 episode lengths match.*linked this title/);
  assert.equal(fake.requests.filter((r) => r.method !== "GET").length, writes, "nothing was sent to crazydramas");
  assert.equal((await fixtureData.getTitle(sys, title.id)).title.crazydramas_slug, "who-are-you-when-the-game-ends-season-1");
  assert.equal((await fixtureData.getPlatformLink(sys, title.id, "crazydramas"))?.slug, "who-are-you-when-the-game-ends-season-1", "the check linked it");
});

test("a show whose lengths differ from every live series is created as before", async () => {
  fake.addCmsSeries("some-other-show", "Some Other Show", [100, 120, 140, 160, 180, 200]);
  const title = await importWithLengths("A New Film", LBL, true);
  await fixtureData.setTitleImport(sys, title.id, { crazydramas_slug: "a-new-film" });
  const r = await saveSeries(producer(), title.id, { title: "A New Film" });
  assert.equal(r.created, true);
  assert.equal(r.series.slug, "a-new-film");
});

test("an episode the CMS put up is not 'replace needed' when crazydramas' copy is the same file; a different copy still is", async () => {
  const title = await importWithLengths("Lines Between Us", LBL.slice(0, 4), true);
  await fixtureData.setTitleImport(sys, title.id, { crazydramas_slug: "lines-between-us" });
  // Mux reads each file two frames long (MUX_FRAME_OFFSET); episode 2 on crazydramas is another cut.
  const live = LBL.slice(0, 4).map((s) => (s * 30 + 2) / 30);
  live[1] = LBL[1] + 20;
  fake.addCmsSeries("lines-between-us", "Lines Between Us", live);
  fake.setManagedBy("lines-between-us", "studio");
  await checkCrazydramasTitle(sys, title.id, { force: true });
  const state = await getPublishState(producer(), title.id);
  const replace = Object.fromEntries(state.episodes.map((e) => [e.n, e.replace_needed]));
  assert.deepEqual(replace, { 1: false, 2: true, 3: false, 4: false });
});
