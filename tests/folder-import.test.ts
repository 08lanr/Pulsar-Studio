// "Upload by folder" (lib/film-import/folder): a folder of ep1..epN.mp4 on
// this computer becomes a title whose episodes are COPIES in the local tier
// (hash-named, hashed, probed), the rows "Upload to CrazyDramas" asks for; a
// second run of the same bytes changes nothing; the folder itself is never
// written; a gap, a repeat or a producer session is refused; and the pure
// pieces (the listing rules, the slug).

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { isLocalTierPath, localPathOf } from "@/lib/data/storage";
import { episodesOfListing, folderSlug, folderSourceRef, importFolder, resetFolderImportRegistry, scanFolder } from "@/lib/film-import/folder";
import type { VideoFacts } from "@/lib/film-import/import";
import type { Episode } from "@/lib/types";
import { producer, staff } from "./seed-minute";

let mediaDir = "";
const temps: string[] = [];

beforeEach(() => {
  resetFixtureStore();
  resetFolderImportRegistry();
  mediaDir = mkdtempSync(path.join(tmpdir(), "studio-local-"));
  process.env.STUDIO_LOCAL_MEDIA_DIR = mediaDir;
  temps.push(mediaDir);
});

afterEach(() => {
  resetFixtureStore();
  resetFolderImportRegistry();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
});

/** A folder named `name` holding the given files (bytes made up per name). */
function folderWith(name: string, files: string[]): string {
  const parent = mkdtempSync(path.join(tmpdir(), "studio-folder-"));
  temps.push(parent);
  const dir = path.join(parent, name);
  mkdirSync(dir);
  for (const f of files) writeFileSync(path.join(dir, f), Buffer.from(`${f}:${"x".repeat(200)}`));
  return dir;
}

const probe = async (link: string): Promise<VideoFacts | null> => {
  assert.ok(isInside(link, mediaDir), `the probe only ever sees the tier copy: ${link}`);
  return { width: 1080, height: 1920, fps: 30, frames: 300, duration_s: 10 };
};
const isInside = (p: string, dir: string) => !path.relative(dir, p).startsWith("..");
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const producerId = () => producer().producerId!;

// ---- the pure pieces -----------------------------------------------------------------------------------------

test("episodesOfListing reads ep1 / EP02 / episode 3 / 4 as episodes 1..4 and leaves unnumbered videos out", () => {
  const files = ["ep1.mp4", "EP02.mp4", "episode 3.mov", "4.mp4", "trailer.mp4", "notes.txt", "poster.jpg"].map((name, i) => ({ name, bytes: 10 + i, mtime_ms: 1 }));
  const r = episodesOfListing(files);
  assert.deepEqual(r.episodes.map((e) => [e.n, e.name]), [[1, "ep1.mp4"], [2, "EP02.mp4"], [3, "episode 3.mov"], [4, "4.mp4"]]);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.ignored, ["trailer.mp4"]);
});

test("episodesOfListing refuses a gap, a repeat, an empty file and a folder with no episodes", () => {
  const f = (name: string, bytes = 10) => ({ name, bytes, mtime_ms: 1 });
  assert.match(episodesOfListing([f("ep1.mp4"), f("ep3.mp4")]).problems.join(";"), /episode 2 missing/);
  assert.match(episodesOfListing([f("ep1.mp4"), f("ep01.mp4")]).problems.join(";"), /episode 1 has 2 files/);
  assert.match(episodesOfListing([f("ep1.mp4", 0)]).problems.join(";"), /ep1\.mp4 is empty/);
  assert.match(episodesOfListing([f("readme.txt")]).problems.join(";"), /no episode files/);
});

test("folderSlug makes a plain slug; the source_ref names no workspace project", () => {
  assert.equal(folderSlug("Love between lines"), "love-between-lines");
  assert.equal(folderSlug("Café  Noir!"), "cafe-noir");
  assert.equal(folderSlug("剧集"), "folder");
  assert.equal(folderSourceRef(path.join(tmpdir(), "Love between lines")), "_folders/love-between-lines");
});

test("scanFolder refuses a relative path and a missing folder", async () => {
  await assert.rejects(scanFolder("Dramas/Love between lines"), /not a full path/);
  await assert.rejects(scanFolder(path.join(tmpdir(), "no-such-folder-studio")), /does not exist/);
});

// ---- the import ---------------------------------------------------------------------------------------------

test("a folder becomes a title with copied, hashed, probed episodes; a second run changes nothing; the folder is not written", async () => {
  const dir = folderWith("Love between lines", ["ep1.mp4", "ep2.mp4", "ep3.mp4", "poster.jpg"]);
  const before = readdirSync(dir).map((f) => [f, statSync(path.join(dir, f)).mtimeMs]);

  const first = await importFolder(staff(), { folder: dir, display_title: "Love Between Lines" }, producerId(), staff().userId, { probe, skipSlug: true });
  assert.equal(first.step, "done");
  assert.deepEqual([first.counts.added, first.counts.updated, first.counts.unchanged], [3, 0, 0]);

  const title = await fixtureData.findTitleBySourceRef(systemSession(), producerId(), "_folders/love-between-lines");
  assert.ok(title, "the title exists under the folder's source_ref");
  assert.equal(title!.name_en, "Love Between Lines");
  assert.ok(title!.cover_path && isLocalTierPath(title!.cover_path), "poster.jpg became the cover");

  for (const n of [1, 2, 3]) {
    const ep: Episode = (await fixtureData.getWorkbench(systemSession(), title!.id, n)).episode;
    assert.ok(isLocalTierPath(ep.video_path), `ep${n} points into the local tier`);
    const abs = localPathOf(ep.video_path!);
    assert.equal(ep.video_sha256, sha(path.join(dir, `ep${n}.mp4`)), `ep${n}'s hash is the file's`);
    assert.equal(sha(abs), ep.video_sha256, `ep${n}'s tier copy holds the same bytes`);
    assert.equal(ep.video_frames, 300);
    assert.equal(ep.video_bytes, statSync(path.join(dir, `ep${n}.mp4`)).size);
    assert.notEqual(statSync(abs).ino, statSync(path.join(dir, `ep${n}.mp4`)).ino, "a copy, not a link to the folder's file");
  }

  const second = await importFolder(staff(), { folder: dir, display_title: "Love Between Lines" }, producerId(), staff().userId, { probe, skipSlug: true });
  assert.deepEqual([second.counts.added, second.counts.updated, second.counts.unchanged], [0, 0, 3]);

  // A changed file is the only one copied again.
  writeFileSync(path.join(dir, "ep2.mp4"), Buffer.from("a new cut of episode two"));
  const third = await importFolder(staff(), { folder: dir }, producerId(), staff().userId, { probe, skipSlug: true });
  assert.deepEqual([third.counts.added, third.counts.updated, third.counts.unchanged], [0, 1, 2]);

  const after = readdirSync(dir).map((f) => [f, f === "ep2.mp4" ? before.find((b) => b[0] === f)![1] : statSync(path.join(dir, f)).mtimeMs]);
  assert.deepEqual(after.sort(), before.sort(), "Studio wrote nothing into the folder");
});

test("the import refuses a producer session and a folder with a gap", async () => {
  const dir = folderWith("Gappy", ["ep1.mp4", "ep3.mp4"]);
  await assert.rejects(importFolder(staff(), { folder: dir }, producerId(), staff().userId, { probe, skipSlug: true }), /episode 2 missing/);
  const ok = folderWith("Fine", ["ep1.mp4"]);
  await assert.rejects(importFolder(producer(), { folder: ok }, producerId(), producer().userId, { probe, skipSlug: true }), /only staff/);
});
