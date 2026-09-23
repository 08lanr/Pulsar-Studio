// The platform link and snapshot rows (decision 2026-09-23; migration 0017),
// pinned in fixture mode so both backends share them: a link is made by the
// system or staff, one per title × platform and one title per drama id, and
// read by whoever reads the title; a snapshot is validated (a 200 carries a
// body, nothing else does, a failed read carries its error, never a playback
// id), read newest first by the title's producer and, when it names no
// title, by staff alone; the prune keeps the last twenty per slug; the
// titles with a slug and the episode rows read under the same visibility.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fixtureSession, systemSession } from "@/lib/auth";
import { PLATFORM_SNAPSHOTS_KEEP } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import type { PlatformDrama, PlatformEpisode, Title } from "@/lib/types";
import { producer, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

const viewer = () => ({ ...producer(), producerRole: "viewer" as const });
const DRAMA_A = "01e0f703-725e-4b7c-8770-57a87cc75cff";
const DRAMA_B = "b03e20e3-dac1-4c20-9903-5f37664aeda9";

const drama = (slug: string, id = DRAMA_A): PlatformDrama => ({ id, slug, title: "A Series", status: "published", language: "en", free_episode_count: 5, series_price_cents: 999, iap_product_id: null, poster_url: `https://crazydramas.com/posters/${slug}.jpg`, poster_blurhash: null, episode_count: 1, cta_mode: "web_checkout" });
const episodes: PlatformEpisode[] = [{ n: 1, duration_s: 116.567, status: "ready", is_published: true }];

async function importedTitle(slug: string | null = "forced-to-marry-the-mafia-boss", ref = "low-quality/mafia-king"): Promise<Title> {
  const who = producer();
  return fixtureData.createImportedTitle(systemSession(), { producer_id: who.producerId!, source_ref: ref, display_title_en: "Mafia King", crazydramas_slug: slug, created_by: who.userId });
}

async function stranger() {
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  return { other, session: fixtureSession("producer", other.id) };
}

// ---- links ------------------------------------------------------------------------------------------------

test("a link is made by the system or staff, one per title and one title per drama; a move updates it; the producer reads it, a stranger sees nothing, a producer never writes", async () => {
  resetFixtureStore();
  const title = await importedTitle();
  assert.equal(await fixtureData.getPlatformLink(producer(), title.id, "crazydramas"), null);

  const link = await fixtureData.upsertPlatformLink(systemSession(), { title_id: title.id, platform: "crazydramas", slug: "forced-to-marry-the-mafia-boss", cd_drama_id: DRAMA_A.toUpperCase() });
  assert.equal(link.title_id, title.id);
  assert.equal(link.cd_drama_id, DRAMA_A, "the drama id is kept lowercase");
  assert.equal(link.linked_by, null, "the system actor has no profile row");
  assert.match(link.linked_at, /^\d{4}-/);
  assert.equal((await fixtureData.getPlatformLink(producer(), title.id, "crazydramas"))?.id, link.id, "the title's producer reads it");
  assert.equal((await fixtureData.getPlatformLink(viewer(), title.id, "crazydramas"))?.id, link.id);
  assert.equal((await fixtureData.upsertPlatformLink(staff(), { title_id: title.id, platform: "crazydramas", slug: "forced-to-marry-the-mafia-boss", cd_drama_id: DRAMA_A })).id, link.id, "the same link again is the same row");

  const moved = await fixtureData.upsertPlatformLink(staff(), { title_id: title.id, platform: "crazydramas", slug: "forced-to-marry-renamed", cd_drama_id: DRAMA_A });
  assert.equal(moved.id, link.id, "one link per title: a rename moves it");
  assert.equal(moved.slug, "forced-to-marry-renamed");
  assert.equal(moved.linked_by, staff().userId);
  assert.equal((await fixtureData.listPlatformLinks(staff(), "crazydramas")).length, 1);

  const second = await importedTitle("my-new-billionaire-husband", "low-quality/reclaiming-her-world");
  await assert.rejects(fixtureData.upsertPlatformLink(systemSession(), { title_id: second.id, platform: "crazydramas", slug: "my-new-billionaire-husband", cd_drama_id: DRAMA_A }), { code: "conflict" }, "one title per drama");
  assert.equal(await fixtureData.getPlatformLink(staff(), second.id, "crazydramas"), null, "a refused link made nothing");
  await fixtureData.upsertPlatformLink(systemSession(), { title_id: second.id, platform: "crazydramas", slug: "my-new-billionaire-husband", cd_drama_id: DRAMA_B });
  assert.deepEqual((await fixtureData.listPlatformLinks(producer(), "crazydramas")).map((l) => l.title_id), [title.id, second.id], "the company's links, oldest first");

  await assert.rejects(fixtureData.upsertPlatformLink(producer(), { title_id: title.id, platform: "crazydramas", slug: "x-y", cd_drama_id: DRAMA_B }), { code: "forbidden" }, "the company's own approver never writes a link");
  await assert.rejects(fixtureData.upsertPlatformLink(staff(), { title_id: title.id, platform: "crazydramas", slug: "Not A Slug", cd_drama_id: DRAMA_B }), { code: "invalid" });
  await assert.rejects(fixtureData.upsertPlatformLink(staff(), { title_id: title.id, platform: "crazydramas", slug: "a-slug", cd_drama_id: "not-a-uuid" }), { code: "invalid" });
  await assert.rejects(fixtureData.upsertPlatformLink(staff(), { title_id: title.id, platform: "reelshort" as never, slug: "a-slug", cd_drama_id: DRAMA_B }), { code: "invalid" });
  await assert.rejects(fixtureData.upsertPlatformLink(staff(), { title_id: "00000000-0000-0000-0000-000000000000", platform: "crazydramas", slug: "a-slug", cd_drama_id: DRAMA_B }), { code: "not_found" });

  const { session: them } = await stranger();
  await assert.rejects(fixtureData.getPlatformLink(them, title.id, "crazydramas"), { code: "not_found" }, "a foreign title is nothing, never forbidden");
  await assert.rejects(fixtureData.upsertPlatformLink(them, { title_id: title.id, platform: "crazydramas", slug: "a-slug", cd_drama_id: DRAMA_B }), { code: "not_found" });
  assert.deepEqual(await fixtureData.listPlatformLinks(them, "crazydramas"), [], "another company's links read empty");
  assert.equal((await fixtureData.getPlatformLink(staff(), title.id, "crazydramas"))?.slug, "forced-to-marry-renamed", "a refused write changed nothing");
});

// ---- snapshots ----------------------------------------------------------------------------------------------

test("a snapshot is the system's or staff's record of one read, validated: a 200 carries a body, a 404 none, a failed read its error, never a playback id", async () => {
  resetFixtureStore();
  const title = await importedTitle();
  const ok = await fixtureData.recordPlatformSnapshot(systemSession(), { platform: "crazydramas", slug: "forced-to-marry-the-mafia-boss", title_id: title.id, http_status: 200, drama: drama("forced-to-marry-the-mafia-boss"), episodes, read_at: "2026-09-23T07:00:00.000Z" });
  assert.equal(ok.cd_drama_id, DRAMA_A, "the drama id is taken from the body when not given");
  assert.equal(ok.title_id, title.id);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.episodes, episodes);
  const gone = await fixtureData.recordPlatformSnapshot(staff(), { platform: "crazydramas", slug: "forced-to-marry-the-mafia-boss", title_id: title.id, http_status: 404, cd_drama_id: DRAMA_A });
  assert.equal(gone.drama, null);
  const failed = await fixtureData.recordPlatformSnapshot(systemSession(), { platform: "crazydramas", slug: "forced-to-marry-the-mafia-boss", title_id: title.id, error: "  crazydramas did not answer  " });
  assert.equal(failed.http_status, null);
  assert.equal(failed.error, "crazydramas did not answer");
  const unmatched = await fixtureData.recordPlatformSnapshot(systemSession(), { platform: "crazydramas", slug: "he-treated-our-love-like-a-prank", http_status: 200, drama: drama("he-treated-our-love-like-a-prank", DRAMA_B), episodes });
  assert.equal(unmatched.title_id, null);

  const base = { platform: "crazydramas" as const, slug: "forced-to-marry-the-mafia-boss", title_id: title.id };
  await assert.rejects(fixtureData.recordPlatformSnapshot(systemSession(), { ...base, http_status: 200 }), { code: "invalid" }, "a 200 without its body");
  await assert.rejects(fixtureData.recordPlatformSnapshot(systemSession(), { ...base, http_status: 404, drama: drama("x"), episodes }), { code: "invalid" }, "a 404 with a body");
  await assert.rejects(fixtureData.recordPlatformSnapshot(systemSession(), { ...base }), { code: "invalid" }, "no status and no error");
  await assert.rejects(fixtureData.recordPlatformSnapshot(systemSession(), { ...base, http_status: 200, drama: { ...drama("x"), thumbnailUrl: "https://image.mux.com/x/thumbnail.jpg" } as never, episodes }), { code: "invalid" }, "a leaking key");
  await assert.rejects(fixtureData.recordPlatformSnapshot(systemSession(), { ...base, slug: "Bad Slug", http_status: 404 }), { code: "invalid" });
  await assert.rejects(fixtureData.recordPlatformSnapshot(systemSession(), { ...base, http_status: 999, error: "x" }), { code: "invalid" });
  await assert.rejects(fixtureData.recordPlatformSnapshot(systemSession(), { ...base, title_id: "00000000-0000-0000-0000-000000000000", http_status: 404 }), { code: "not_found" });
  await assert.rejects(fixtureData.recordPlatformSnapshot(producer(), { ...base, http_status: 404 }), { code: "forbidden" }, "a producer records nothing");
  await assert.rejects(fixtureData.recordPlatformSnapshot(viewer(), { ...base, http_status: 404 }), { code: "forbidden" });
  assert.equal((await fixtureData.listPlatformSnapshots(staff(), "crazydramas", "forced-to-marry-the-mafia-boss")).length, 3, "a refused write appended nothing");
});

test("snapshots read newest first with a limit; the producer reads their own titles' rows, staff every row including the title-less ones, a stranger nothing", async () => {
  resetFixtureStore();
  const title = await importedTitle();
  const slug = "forced-to-marry-the-mafia-boss";
  for (let i = 0; i < 3; i++) {
    await fixtureData.recordPlatformSnapshot(systemSession(), { platform: "crazydramas", slug, title_id: title.id, http_status: 200, drama: drama(slug), episodes, read_at: `2026-09-23T0${i}:00:00.000Z` });
  }
  await fixtureData.recordPlatformSnapshot(systemSession(), { platform: "crazydramas", slug: "ever-since-i-played-that-game-paranormal", http_status: 200, drama: drama("ever-since-i-played-that-game-paranormal", DRAMA_B), episodes, read_at: "2026-09-23T05:00:00.000Z" });
  await fixtureData.recordPlatformSnapshot(systemSession(), { platform: "crazydramas", slug: "ever-since-i-played-that-game-paranormal", http_status: 404, cd_drama_id: DRAMA_B, read_at: "2026-09-23T06:00:00.000Z" });

  const all = await fixtureData.listPlatformSnapshots(producer(), "crazydramas", slug);
  assert.deepEqual(all.map((s) => s.read_at), ["2026-09-23T02:00:00.000Z", "2026-09-23T01:00:00.000Z", "2026-09-23T00:00:00.000Z"]);
  assert.equal((await fixtureData.listPlatformSnapshots(viewer(), "crazydramas", slug, { limit: 1 })).length, 1);
  assert.deepEqual(await fixtureData.listPlatformSnapshots(producer(), "crazydramas", "ever-since-i-played-that-game-paranormal"), [], "a series with no title is not the producer's to see");
  assert.equal((await fixtureData.listPlatformSnapshots(staff(), "crazydramas", "ever-since-i-played-that-game-paranormal")).length, 2);
  assert.deepEqual(await fixtureData.listPlatformSnapshots(staff(), "crazydramas", "never-read"), []);

  const latest = await fixtureData.listLatestPlatformSnapshots(staff(), "crazydramas");
  assert.deepEqual(latest.map((s) => [s.slug, s.read_at, s.http_status]), [["ever-since-i-played-that-game-paranormal", "2026-09-23T06:00:00.000Z", 404], [slug, "2026-09-23T02:00:00.000Z", 200]], "the newest per slug, by slug");
  assert.deepEqual((await fixtureData.listLatestPlatformSnapshots(producer(), "crazydramas")).map((s) => s.slug), [slug]);

  const { session: them } = await stranger();
  assert.deepEqual(await fixtureData.listPlatformSnapshots(them, "crazydramas", slug), [], "another company's title's rows read empty, never forbidden");
  assert.deepEqual(await fixtureData.listLatestPlatformSnapshots(them, "crazydramas"), []);
  await assert.rejects(fixtureData.listPlatformSnapshots(staff(), "reelshort" as never, slug), { code: "invalid" });
});

test("the prune keeps the newest twenty rows per slug and answers how many went; producers may not prune", async () => {
  resetFixtureStore();
  const title = await importedTitle();
  const slug = "forced-to-marry-the-mafia-boss";
  for (let i = 0; i < 25; i++) {
    await fixtureData.recordPlatformSnapshot(systemSession(), { platform: "crazydramas", slug, title_id: title.id, http_status: 404, cd_drama_id: DRAMA_A, read_at: new Date(Date.UTC(2026, 8, 23, 0, i)).toISOString() });
  }
  for (let i = 0; i < 3; i++) {
    await fixtureData.recordPlatformSnapshot(systemSession(), { platform: "crazydramas", slug: "he-treated-our-love-like-a-prank", http_status: 404, cd_drama_id: DRAMA_B, read_at: new Date(Date.UTC(2026, 8, 23, 1, i)).toISOString() });
  }
  assert.equal(PLATFORM_SNAPSHOTS_KEEP, 20);
  await assert.rejects(fixtureData.prunePlatformSnapshots(producer(), "crazydramas"), { code: "forbidden" });
  assert.equal(await fixtureData.prunePlatformSnapshots(systemSession(), "crazydramas"), 5);
  const kept = await fixtureData.listPlatformSnapshots(staff(), "crazydramas", slug, { limit: 100 });
  assert.equal(kept.length, 20);
  assert.equal(kept[0].read_at, new Date(Date.UTC(2026, 8, 23, 0, 24)).toISOString(), "the newest stays");
  assert.equal(kept[19].read_at, new Date(Date.UTC(2026, 8, 23, 0, 5)).toISOString(), "the five oldest went");
  assert.equal((await fixtureData.listPlatformSnapshots(staff(), "crazydramas", "he-treated-our-love-like-a-prank")).length, 3, "another slug's three rows are untouched");
  assert.equal(await fixtureData.prunePlatformSnapshots(staff(), "crazydramas"), 0, "nothing more to prune");
  assert.equal(await fixtureData.prunePlatformSnapshots(staff(), "crazydramas", 2), 19, "a smaller keep");
  await assert.rejects(fixtureData.prunePlatformSnapshots(staff(), "crazydramas", 0), { code: "invalid" });
});

// ---- the titles and their episodes -----------------------------------------------------------------------------

test("the titles with a slug and the episode rows read under the title's visibility: staff every company's, a producer their own, a stranger nothing", async () => {
  resetFixtureStore();
  const linked = await importedTitle();
  await importedTitle(null, "low-quality/the-cold-ceo");
  const blank = await importedTitle("  ", "low-quality/she-returned-with-her-son");
  assert.equal(blank.crazydramas_slug, null);
  const { other, session: them } = await stranger();
  const theirs = await fixtureData.createImportedTitle(them, { producer_id: other.id, source_ref: "low-quality/mafia-king", display_title_en: "Theirs", crazydramas_slug: "forced-to-marry-the-mafia-boss" });

  assert.deepEqual((await fixtureData.listTitlesWithPlatformSlug(staff(), "crazydramas")).map((t) => t.id), [linked.id, theirs.id], "every company's, oldest first");
  assert.deepEqual((await fixtureData.listTitlesWithPlatformSlug(systemSession(), "crazydramas")).map((t) => t.id), [linked.id, theirs.id]);
  assert.deepEqual((await fixtureData.listTitlesWithPlatformSlug(producer(), "crazydramas")).map((t) => t.id), [linked.id]);
  assert.deepEqual((await fixtureData.listTitlesWithPlatformSlug(them, "crazydramas")).map((t) => t.id), [theirs.id]);

  await fixtureData.addVideoOnlyEpisode(systemSession(), linked.id, 2, `local/${linked.id}/ws/mafia-king/ep02-bbbbbbbb.mp4`, { video_frames: 3358, duration_ms: 111_933, auto_cut: false });
  await fixtureData.addVideoOnlyEpisode(systemSession(), linked.id, 1, `local/${linked.id}/ws/mafia-king/ep01-aaaaaaaa.mp4`, { video_frames: 3495, duration_ms: 116_500, auto_cut: false });
  const rows = await fixtureData.listTitleEpisodes(viewer(), linked.id);
  assert.deepEqual(rows.map((e) => [e.number, e.video_frames, e.duration_ms]), [[1, 3495, 116_500], [2, 3358, 111_933]], "by number, with the import fields");
  assert.equal((await fixtureData.listTitleEpisodes(staff(), linked.id)).length, 2);
  await assert.rejects(fixtureData.listTitleEpisodes(them, linked.id), { code: "not_found" });
  await assert.rejects(fixtureData.listTitleEpisodes(staff(), "00000000-0000-0000-0000-000000000000"), { code: "not_found" });
});
