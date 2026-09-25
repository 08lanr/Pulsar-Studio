// The Title details card (decision 2026-09-24 "Rename a title, choose its
// poster"; lib/titles/details): a rename carries the Chinese name when it was
// only the folder's name, moves the slug while no series exists and keeps it
// (saying why) once one does, and renames the title's own series (a live one
// only after its confirm); a picked poster becomes the title's cover and the
// series' poster; a producer session is refused. Fixture mode and its fake
// crazydramas; no network.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { fakeCrazydramasTransport as fake } from "@/lib/crazydramas/fake";
import { isJpeg, POSTER_BUCKET, resetPosterBucket, type PosterEncoder, type PosterStore } from "@/lib/crazydramas/poster";
import { resetCrazydramasUploads, saveSeries } from "@/lib/crazydramas/publish";
import type { SlugReader } from "@/lib/crazydramas/slug";
import { studioClient } from "@/lib/crazydramas/studio-client";
import { resetCrazydramasSweep } from "@/lib/crazydramas/sweep";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { isLocalTierPath, localPathOf } from "@/lib/data/storage";
import { renameTitle, setTitlePoster } from "@/lib/titles/details";
import type { Title } from "@/lib/types";
import { producer, staff } from "./seed-minute";

const sys = systemSession();
const FIXTURE_POSTER = path.join(process.cwd(), "tests", "fixtures", "workspace", "low-quality", "fixture-film", "poster", "final", "fixture-film-a.jpg");
const temps: string[] = [];

beforeEach(() => {
  resetFixtureStore();
  resetCrazydramasSweep();
  resetCrazydramasUploads();
  resetPosterBucket();
  fake.reset();
  const dir = mkdtempSync(path.join(tmpdir(), "title-details-"));
  temps.push(dir);
  process.env.STUDIO_LOCAL_MEDIA_DIR = path.join(dir, "local");
  process.env.STUDIO_WORK_DIR = path.join(dir, "work");
});

afterEach(() => {
  resetFixtureStore();
  resetPosterBucket();
  fake.reset();
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  delete process.env.STUDIO_WORK_DIR;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** The series as Studio's authenticated read sees it (drafts included). */
async function seriesOf(slug: string) {
  const r = await studioClient().getSeries(slug);
  assert.ok(r.ok, `the series ${slug} reads`);
  return r.data.series;
}

/** Every slug is free, except the ones named. */
const reader = (taken: string[] = []): SlugReader => async (slug) => (taken.includes(slug) ? { status: 200, id: `id-${slug}`, title: "Somebody else's show", original_title: null, managed_by: "cms" } : { status: 404 });

function memoryStore(): PosterStore {
  const objects = new Map<string, Uint8Array>();
  return {
    kind: "fixture",
    async put(p, bytes) {
      objects.set(p, bytes);
    },
    publicUrl: (p) => `https://example.supabase.co/storage/v1/object/public/${POSTER_BUCKET}/${p}`,
    previewUrl: (p) => `/preview/${p}`,
    async check(p) {
      return objects.has(p) && isJpeg(objects.get(p)!) ? { ok: true, status: 200, content_type: "image/jpeg", reason: null } : { ok: false, status: 404, content_type: null, reason: "missing" };
    },
  };
}

const encoder: PosterEncoder = {
  probe: async () => ({ width: 1200, height: 1600 }),
  run: async (args) => writeFileSync(args[args.length - 1], Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("poster")])),
};

/** A title the way a folder import makes it: both names the folder's, the slug derived from it. */
async function folderTitle(name: string, slug: string): Promise<Title> {
  const who = producer();
  const t = await fixtureData.createImportedTitle(sys, { producer_id: who.producerId!, source_ref: `_folders/${slug}`, display_title_en: name, crazydramas_slug: slug, created_by: who.userId });
  if (t.name_zh !== name) await fixtureData.updateTitle(staff(), t.id, { name_zh: name });
  return (await fixtureData.getTitle(sys, t.id)).title;
}

test("a rename before any series: both folder names follow, the slug follows the new name (or the next free one)", async () => {
  const t = await folderTitle("Love between lines", "love-between-lines");
  const r = await renameTitle(staff(), t.id, "  I Made My In-Game Killer   Fall in Love With Me ", { slugRead: reader() });
  assert.equal(r.title.name_en, "I Made My In-Game Killer Fall in Love With Me");
  assert.equal(r.title.name_zh, r.title.name_en, "the Chinese name was only the folder's name, so it follows");
  assert.deepEqual([r.slug.from, r.slug.to, r.slug.note], ["love-between-lines", "i-made-my-in-game-killer-fall-in-love-with-me", null]);
  assert.equal(r.title.crazydramas_slug, "i-made-my-in-game-killer-fall-in-love-with-me");
  assert.equal(r.crazydramas, "no_series");

  const u = await folderTitle("Other film", "other-film");
  const taken = await renameTitle(staff(), u.id, "The Summer I Fell for My In-Game Enemy", { slugRead: reader(["the-summer-i-fell-for-my-in-game-enemy"]) });
  assert.equal(taken.slug.to, "the-summer-i-fell-for-my-in-game-enemy-2", "taken on crazydramas: the next free one");

  // A real Chinese name stays.
  await fixtureData.updateTitle(staff(), u.id, { name_zh: "轧戏" });
  const zh = await renameTitle(staff(), u.id, "We Were Only Pretending", { slugRead: reader() });
  assert.equal(zh.title.name_zh, "轧戏");
});

test("a rename once the series exists: the slug stays (with why) and the series is renamed; a live one only after its confirm", async () => {
  const t = await folderTitle("Rename Me", "rename-me");
  await saveSeries(producer(), t.id, { title: "Rename Me" });
  const r = await renameTitle(staff(), t.id, "A Better Name", { slugRead: reader() });
  assert.equal(r.slug.to, "rename-me");
  assert.match(r.slug.note ?? "", /stays crazydramas\.com\/watch\/rename-me/);
  assert.equal(r.crazydramas, "updated");
  assert.equal((await seriesOf("rename-me")).title, "A Better Name");

  fake.setSeriesStatus("rename-me", "published");
  const live = await renameTitle(staff(), t.id, "An Even Better Name", { slugRead: reader() });
  assert.equal(live.crazydramas, "confirm_live");
  assert.equal(live.title.name_en, "An Even Better Name", "Studio's side is saved while crazydramas waits for the confirm");
  assert.equal((await seriesOf("rename-me")).title, "A Better Name", "nothing sent yet");
  const confirmed = await renameTitle(staff(), t.id, "An Even Better Name", { slugRead: reader(), confirmLive: true });
  assert.equal(confirmed.crazydramas, "updated");
  assert.equal((await seriesOf("rename-me")).title, "An Even Better Name");
});

test("a picked poster becomes the title's cover, then the series' poster; not an image, or a producer, is refused", async () => {
  const t = await folderTitle("Poster Title", "poster-title");
  const bytes = readFileSync(FIXTURE_POSTER);
  const first = await setTitlePoster(staff(), t.id, bytes, { store: memoryStore(), encoder });
  assert.ok(first.title.cover_path && isLocalTierPath(first.title.cover_path), "the cover is in the local tier");
  assert.deepEqual(readFileSync(localPathOf(first.title.cover_path!)), bytes, "the cover holds the picked bytes");
  assert.equal(first.crazydramas, "no_series", "no series yet: Create series starts from the cover");

  await saveSeries(producer(), t.id, { title: "Poster Title" });
  const second = await setTitlePoster(staff(), t.id, bytes, { store: memoryStore(), encoder });
  assert.equal(second.crazydramas, "updated");
  assert.match((await seriesOf("poster-title")).poster_url ?? "", new RegExp(`/public-posters/${t.external_id}/[0-9a-f]{8}\\.jpg$`));

  await assert.rejects(setTitlePoster(staff(), t.id, Buffer.from("not an image at all")), /JPG, PNG or WebP/);
  await assert.rejects(setTitlePoster(producer(), t.id, bytes), /only staff/);
  await assert.rejects(renameTitle(producer(), t.id, "Nope"), /only staff/);
});
