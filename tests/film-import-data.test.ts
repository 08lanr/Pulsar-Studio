// The data layer, storage tier and route pieces the workspace import stands
// on (decision 2026-09-22; migration 0015), pinned in fixture mode so both
// backends share them: an imported title is en-US with the display title in
// every name slot and is found by its source_ref by its own company only;
// an imported episode is born with its hash and auto_cut false, and the
// import fields are validated; film assets are append-only, idempotent on the
// hash and newest first; the local tier resolves on disk and refuses a path
// that leaves it or points into the workspace; the media route's streaming
// honours Range; the upload-time clip run skips an imported episode.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { NextRequest } from "next/server";
import { parseRange, streamFile, titleIdOfMediaPath } from "@/app/api/media/_lib/stream";
import { fixtureSession, systemSession } from "@/lib/auth";
import { cutEpisodeClips } from "@/lib/clips/run";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { isLocalTierPath, linkIntoLocalTier, localPathOf, localStoredPath, resolveUploadPath } from "@/lib/data/storage";
import type { Title } from "@/lib/types";
import { producer, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const viewer = () => ({ ...producer(), producerRole: "viewer" as const });

async function importedTitle(): Promise<Title> {
  resetFixtureStore();
  const who = producer();
  return fixtureData.createImportedTitle(systemSession(), {
    producer_id: who.producerId!,
    source_ref: "low-quality/mafia-king",
    display_title_en: "Mafia King",
    crazydramas_slug: "forced-to-marry-the-mafia-boss",
    created_by: who.userId,
  });
}

async function stranger() {
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  return { other, session: fixtureSession("producer", other.id) };
}

// ---- titles ----------------------------------------------------------------------------------------

test("createImportedTitle: en-US, the display title in every name slot, the film's ref, slug and cover; one title per film per company", async () => {
  resetFixtureStore();
  const who = producer();
  const title = await fixtureData.createImportedTitle(systemSession(), {
    producer_id: who.producerId!,
    source_ref: "low-quality\\mafia-king\\",
    display_title_en: " Mafia King ",
    crazydramas_slug: "forced-to-marry-the-mafia-boss",
    cover_path: "local/x/ws/mafia-king/poster-abcdef12.jpg",
    created_by: who.userId,
  });
  assert.equal(title.source_locale, "en-US");
  assert.equal(title.name_en, "Mafia King");
  assert.equal(title.name_zh, "Mafia King", "name_zh is NOT NULL in SQL: it carries the same text");
  assert.equal(title.source_ref, "low-quality/mafia-king", "forward slashes, no trailing slash");
  assert.equal(title.crazydramas_slug, "forced-to-marry-the-mafia-boss");
  assert.equal(title.cover_path, "local/x/ws/mafia-king/poster-abcdef12.jpg");
  assert.equal(title.ad_rules, null);
  assert.equal(title.producer_id, who.producerId);
  const detail = await fixtureData.getTitle(staff(), title.id);
  assert.equal(detail.adaptation.display_title_en, "Mafia King");
  assert.equal(detail.adaptation.created_by, who.userId, "the system actor names the real caller");

  await assert.rejects(
    fixtureData.createImportedTitle(systemSession(), { producer_id: who.producerId!, source_ref: "low-quality/mafia-king", display_title_en: "Again" }),
    { code: "conflict" }
  );
  assert.equal((await fixtureData.listTitles(staff())).length, 1, "a refused duplicate created nothing");

  // Another company may import the same film; a producer creates under their own company whatever the input says.
  const { other, session: them } = await stranger();
  const theirs = await fixtureData.createImportedTitle(them, { producer_id: "ignored", source_ref: "low-quality/mafia-king", display_title_en: "Mafia King" });
  assert.equal(theirs.producer_id, other.id);

  await assert.rejects(fixtureData.createImportedTitle(viewer(), { producer_id: who.producerId!, source_ref: "low-quality/rhw", display_title_en: "x" }), { code: "forbidden" });
  await assert.rejects(fixtureData.createImportedTitle(staff(), { producer_id: who.producerId!, source_ref: "../etc", display_title_en: "x" }), { code: "invalid" });
  await assert.rejects(fixtureData.createImportedTitle(staff(), { producer_id: who.producerId!, source_ref: "low-quality/rhw", display_title_en: "  " }), { code: "invalid" });

  // The film's own language travels in (The Cold CEO's Mandarin dialogue); absent, en-US is the pipeline's default.
  const zh = await fixtureData.createImportedTitle(systemSession(), { producer_id: who.producerId!, source_ref: "low-quality/the-cold-ceo", display_title_en: "The Cold CEO", source_locale: "zh-CN" });
  assert.equal(zh.source_locale, "zh-CN");
  const blank = await fixtureData.createImportedTitle(systemSession(), { producer_id: who.producerId!, source_ref: "low-quality/rhw", display_title_en: "RHW", source_locale: "  " });
  assert.equal(blank.source_locale, "en-US");
});

test("findTitleBySourceRef answers its own company; another company's film reads as nothing, never forbidden", async () => {
  const title = await importedTitle();
  const who = producer();
  assert.equal((await fixtureData.findTitleBySourceRef(staff(), who.producerId!, "low-quality/mafia-king"))?.id, title.id);
  assert.equal((await fixtureData.findTitleBySourceRef(systemSession(), who.producerId!, "low-quality/mafia-king/"))?.id, title.id);
  assert.equal((await fixtureData.findTitleBySourceRef(who, who.producerId!, "low-quality\\mafia-king"))?.id, title.id);
  assert.equal(await fixtureData.findTitleBySourceRef(staff(), who.producerId!, "low-quality/reclaiming-her-world"), null);

  const { other, session: them } = await stranger();
  assert.equal(await fixtureData.findTitleBySourceRef(them, who.producerId!, "low-quality/mafia-king"), null, "another company's title is nothing");
  assert.equal(await fixtureData.findTitleBySourceRef(them, other.id, "low-quality/mafia-king"), null);
  assert.equal(await fixtureData.findTitleBySourceRef(staff(), other.id, "low-quality/mafia-king"), null);
  await assert.rejects(fixtureData.findTitleBySourceRef(staff(), who.producerId!, ""), { code: "invalid" });
});

test("setTitleImport refreshes the display title, slug and cover; setTitleAdRules validates and replaces whole; a stranger sees nothing, a viewer is refused", async () => {
  const title = await importedTitle();
  const renamed = await fixtureData.setTitleImport(producer(), title.id, { display_title_en: "Forced to Marry the Mafia Boss", cover_path: "local/x/ws/mafia-king/poster-12345678.jpg" });
  assert.equal(renamed.name_en, "Forced to Marry the Mafia Boss");
  assert.equal(renamed.name_zh, "Forced to Marry the Mafia Boss");
  assert.equal(renamed.crazydramas_slug, "forced-to-marry-the-mafia-boss", "a key left out is left alone");
  assert.equal(renamed.cover_path, "local/x/ws/mafia-king/poster-12345678.jpg");
  assert.equal((await fixtureData.getTitle(staff(), title.id)).adaptation.display_title_en, "Forced to Marry the Mafia Boss");
  assert.equal((await fixtureData.setTitleImport(staff(), title.id, { crazydramas_slug: null })).crazydramas_slug, null);
  await assert.rejects(fixtureData.setTitleImport(staff(), title.id, { display_title_en: " " }), { code: "invalid" });

  const rules = await fixtureData.setTitleAdRules(producer(), title.id, {
    spoiler_from_s: 4200,
    exclusions: [{ from_s: 1350.6, to_s: 1352.1, why: "TO BE CONTINUED card", source: "film_meta" }],
  });
  assert.deepEqual(rules.ad_rules, { spoiler_from_s: 4200, exclusions: [{ from_s: 1350.6, to_s: 1352.1, why: "TO BE CONTINUED card", source: "film_meta" }] });
  const replaced = await fixtureData.setTitleAdRules(systemSession(), title.id, { spoiler_from_s: null, exclusions: [] });
  assert.deepEqual(replaced.ad_rules, { spoiler_from_s: null, exclusions: [] }, "replaced whole, never merged");
  await assert.rejects(fixtureData.setTitleAdRules(staff(), title.id, { spoiler_from_s: -1, exclusions: [] }), { code: "invalid" });
  await assert.rejects(fixtureData.setTitleAdRules(staff(), title.id, { spoiler_from_s: null, exclusions: [{ from_s: 5, to_s: 5, why: "empty window" }] }), { code: "invalid" });
  await assert.rejects(fixtureData.setTitleAdRules(staff(), title.id, { spoiler_from_s: null, exclusions: [{ from_s: 1, to_s: 2, why: " " }] }), { code: "invalid" });

  const { session: them } = await stranger();
  await assert.rejects(fixtureData.setTitleImport(them, title.id, { cover_path: null }), { code: "not_found" });
  await assert.rejects(fixtureData.setTitleAdRules(them, title.id, { spoiler_from_s: null, exclusions: [] }), { code: "not_found" });
  await assert.rejects(fixtureData.setTitleImport(viewer(), title.id, { cover_path: null }), { code: "forbidden" });
  await assert.rejects(fixtureData.setTitleAdRules(viewer(), title.id, { spoiler_from_s: null, exclusions: [] }), { code: "forbidden" });
  await assert.rejects(fixtureData.setTitleAdRules(staff(), "00000000-0000-0000-0000-000000000000", { spoiler_from_s: null, exclusions: [] }), { code: "not_found" });
});

// ---- episodes --------------------------------------------------------------------------------------

test("an imported episode is born with its hash, its film window and auto_cut false; an uploaded one keeps the defaults", async () => {
  const title = await importedTitle();
  const stored = localStoredPath(title.id, "mafia-king", "ep01-aaaaaaaa.mp4");
  const ep = await fixtureData.addVideoOnlyEpisode(systemSession(), title.id, 1, stored, {
    source_ref: "low-quality/mafia-king/cut/eps/ep01.mp4",
    video_sha256: SHA_A,
    video_bytes: 12_345_678,
    video_frames: 3600,
    film_start_ms: 0,
    film_end_ms: 120_000,
    end_note: { chosen_t: 120, ends_on: "the slap lands", band_fix: false },
    auto_cut: false,
  });
  assert.equal(ep.video_path, stored);
  assert.equal(ep.source_ref, "low-quality/mafia-king/cut/eps/ep01.mp4");
  assert.equal(ep.video_sha256, SHA_A);
  assert.equal(ep.video_bytes, 12_345_678);
  assert.equal(ep.video_frames, 3600);
  assert.equal(ep.film_start_ms, 0);
  assert.equal(ep.film_end_ms, 120_000);
  assert.deepEqual(ep.end_note, { chosen_t: 120, ends_on: "the slap lands", band_fix: false });
  assert.equal(ep.auto_cut, false);

  const plain = await fixtureData.addVideoOnlyEpisode(producer(), title.id, 2, `${title.id}/folder/ep2.mp4`);
  assert.equal(plain.auto_cut, true);
  assert.equal(plain.video_sha256, null);
  assert.equal(plain.source_ref, null);
  assert.equal(plain.film_end_ms, null);

  // A bad field creates nothing.
  await assert.rejects(fixtureData.addVideoOnlyEpisode(systemSession(), title.id, 3, stored, { video_sha256: "not-hex", auto_cut: false }), { code: "invalid" });
  await assert.rejects(fixtureData.getWorkbench(staff(), title.id, 3), { code: "not_found" });

  // The import fields are staff's and the system's alone: the company's own approver is refused with them (0015 grants
  // authenticated none of those columns on insert), the same call without them is the Promote intake and still works.
  await assert.rejects(fixtureData.addVideoOnlyEpisode(producer(), title.id, 3, stored, { video_sha256: SHA_A, auto_cut: false }), { code: "forbidden" });
  await assert.rejects(fixtureData.getWorkbench(staff(), title.id, 3), { code: "not_found" });
  assert.equal((await fixtureData.addVideoOnlyEpisode(staff(), title.id, 3, stored, { video_sha256: SHA_A, auto_cut: false })).video_sha256, SHA_A);
});

test("setEpisodeImport patches the import fields and validates them; a refused patch changes nothing; foreign not found, every producer role forbidden", async () => {
  const title = await importedTitle();
  const first = localStoredPath(title.id, "mafia-king", "ep01-aaaaaaaa.mp4");
  const ep = await fixtureData.addVideoOnlyEpisode(systemSession(), title.id, 1, first, { video_sha256: SHA_A, film_start_ms: 0, film_end_ms: 120_000, auto_cut: false });

  const second = localStoredPath(title.id, "mafia-king", "ep01-bbbbbbbb.mp4");
  const patched = await fixtureData.setEpisodeImport(systemSession(), ep.id, { video_path: second, video_sha256: SHA_B, video_frames: 3601, end_note: { band_fix: true } });
  assert.equal(patched.video_path, second, "a new file and its hash land in one write");
  assert.equal(patched.video_sha256, SHA_B);
  assert.equal(patched.video_frames, 3601);
  assert.equal(patched.film_end_ms, 120_000, "a key left out is left alone");
  assert.equal(patched.auto_cut, false);
  assert.deepEqual(patched.end_note, { band_fix: true });
  assert.equal((await fixtureData.getWorkbench(staff(), title.id, 1)).episode.video_path, second);

  await assert.rejects(fixtureData.setEpisodeImport(staff(), ep.id, { video_sha256: "nope" }), { code: "invalid" });
  await assert.rejects(fixtureData.setEpisodeImport(staff(), ep.id, { video_bytes: -1 }), { code: "invalid" });
  await assert.rejects(fixtureData.setEpisodeImport(staff(), ep.id, { film_start_ms: 200_000 }), { code: "invalid" }, "an end before the start, against the stored window");
  await assert.rejects(fixtureData.setEpisodeImport(staff(), ep.id, { video_path: "" }), { code: "invalid" });
  await assert.rejects(fixtureData.setEpisodeImport(staff(), ep.id, { duration_ms: 1.5 }), { code: "invalid" });
  const untouched = (await fixtureData.getWorkbench(staff(), title.id, 1)).episode;
  assert.equal(untouched.video_sha256, SHA_B);
  assert.equal(untouched.film_start_ms, 0);

  assert.equal((await fixtureData.setEpisodeImport(systemSession(), ep.id, { auto_cut: true })).auto_cut, true);
  assert.equal((await fixtureData.setEpisodeImport(systemSession(), ep.id, { duration_ms: 120_000 })).duration_ms, 120_000, "the measured length travels with the import fields");

  // A producer session never writes what the ad engine trusts, whatever its role (0015: no column grant; the same
  // refusal in both backends); a stranger's company still reads nothing, never forbidden.
  const { session: them } = await stranger();
  await assert.rejects(fixtureData.setEpisodeImport(them, ep.id, { auto_cut: false }), { code: "not_found" });
  await assert.rejects(fixtureData.setEpisodeImport(producer(), ep.id, { video_sha256: SHA_C }), { code: "forbidden" }, "the company's own approver");
  await assert.rejects(fixtureData.setEpisodeImport(viewer(), ep.id, { auto_cut: false }), { code: "forbidden" });
  assert.equal((await fixtureData.getWorkbench(staff(), title.id, 1)).episode.video_sha256, SHA_B, "a refused patch changed nothing");
  await assert.rejects(fixtureData.setEpisodeImport(staff(), "00000000-0000-0000-0000-000000000000", { auto_cut: false }), { code: "not_found" });
});

test("setEpisodeVideo refuses an imported episode (its hash, frames, window and end note describe the snapshot); an uploaded one is replaced", async () => {
  const title = await importedTitle();
  const linked = localStoredPath(title.id, "mafia-king", "ep01-aaaaaaaa.mp4");
  await fixtureData.addVideoOnlyEpisode(systemSession(), title.id, 1, linked, { source_ref: "low-quality/mafia-king/cut/eps/ep01.mp4", video_sha256: SHA_A, video_frames: 3600, film_start_ms: 0, film_end_ms: 120_000, auto_cut: false });
  await fixtureData.addVideoOnlyEpisode(producer(), title.id, 2, `${title.id}/folder/ep2.mp4`);

  await assert.rejects(fixtureData.setEpisodeVideo(producer(), title.id, 1, `${title.id}/ep1/replacement.mp4`), { code: "conflict", message: /film workspace/ });
  await assert.rejects(fixtureData.setEpisodeVideo(staff(), title.id, 1, `${title.id}/ep1/replacement.mp4`), { code: "conflict" }, "staff too: the film is updated through the import");
  const kept = (await fixtureData.getWorkbench(staff(), title.id, 1)).episode;
  assert.equal(kept.video_path, linked);
  assert.equal(kept.video_sha256, SHA_A);
  assert.equal(kept.video_frames, 3600);

  const replaced = await fixtureData.setEpisodeVideo(producer(), title.id, 2, `${title.id}/ep2/replacement.mp4`);
  assert.equal(replaced.video_path, `${title.id}/ep2/replacement.mp4`);
  assert.equal(replaced.source_ref, null);
});

// ---- film assets ----------------------------------------------------------------------------------

test("film assets are append-only, idempotent on the hash and listed newest first; a stranger sees nothing, a viewer may not write", async () => {
  const title = await importedTitle();
  const plan = (sha: string, end: number) => ({
    title_id: title.id,
    kind: "delivered_plan" as const,
    storage_path: localStoredPath(title.id, "mafia-king", `cuts-0-${end}-DELIVERED-${sha.slice(0, 8)}.json`),
    sha256: sha,
    bytes: 4096,
    origin: "workspace" as const,
    source_ref: `low-quality/mafia-king/review/cuts-0-${end}-DELIVERED.json`,
    meta: { end_s: end, episodes: 52 },
  });
  const a1 = await fixtureData.putFilmAsset(systemSession(), plan(SHA_A, 1936.533));
  assert.equal(a1.kind, "delivered_plan");
  assert.equal(a1.source_ref, "low-quality/mafia-king/review/cuts-0-1936.533-DELIVERED.json");
  assert.deepEqual(a1.meta, { end_s: 1936.533, episodes: 52 });
  const again = await fixtureData.putFilmAsset(staff(), plan(SHA_A, 1936.533));
  assert.equal(again.id, a1.id, "the same hash is the same row: a resumed import never duplicates");

  const a2 = await fixtureData.putFilmAsset(producer(), plan(SHA_B, 5959.067));
  const transcript = await fixtureData.putFilmAsset(producer(), { title_id: title.id, kind: "transcript", storage_path: localStoredPath(title.id, "mafia-king", "whisper-cccccccc.json"), sha256: SHA_C, bytes: 99, origin: "workspace" });
  assert.notEqual(a2.id, a1.id);
  const list = await fixtureData.listFilmAssets(producer(), title.id);
  assert.deepEqual(list.map((a) => a.id), [transcript.id, a2.id, a1.id], "newest first; the newest delivered plan is the one that counts");
  assert.deepEqual(transcript.meta, {}, "meta defaults to an empty object");
  assert.equal(list.find((a) => a.kind === "delivered_plan")?.id, a2.id);

  await assert.rejects(fixtureData.putFilmAsset(staff(), { ...plan(SHA_C, 1), kind: "poster_card" as never }), { code: "invalid" });
  await assert.rejects(fixtureData.putFilmAsset(staff(), { ...plan("zz", 1) }), { code: "invalid" });
  await assert.rejects(fixtureData.putFilmAsset(staff(), { ...plan(SHA_C, 1), bytes: -1 }), { code: "invalid" });
  await assert.rejects(fixtureData.putFilmAsset(staff(), { ...plan(SHA_C, 1), origin: "web" as never }), { code: "invalid" });
  assert.equal((await fixtureData.listFilmAssets(staff(), title.id)).length, 3, "a refused write appended nothing");

  const { session: them } = await stranger();
  await assert.rejects(fixtureData.listFilmAssets(them, title.id), { code: "not_found" });
  await assert.rejects(fixtureData.putFilmAsset(them, plan(SHA_C, 2)), { code: "not_found" });
  await assert.rejects(fixtureData.putFilmAsset(viewer(), plan(SHA_C, 2)), { code: "forbidden" });
  assert.equal((await fixtureData.listFilmAssets(viewer(), title.id)).length, 3, "a viewer reads");
  await assert.rejects(fixtureData.listFilmAssets(staff(), "00000000-0000-0000-0000-000000000000"), { code: "not_found" });
});

// ---- the local tier --------------------------------------------------------------------------------

test("localPathOf resolves the tier on disk and refuses a bucket path, an escape and anything under WORKSPACE_ROOT; linkIntoLocalTier snapshots once", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "studio-local-tier-"));
  const before = { media: process.env.STUDIO_LOCAL_MEDIA_DIR, ws: process.env.WORKSPACE_ROOT };
  const tier = path.join(scratch, "tier");
  const workspace = path.join(scratch, "projects");
  process.env.STUDIO_LOCAL_MEDIA_DIR = tier;
  process.env.WORKSPACE_ROOT = workspace;
  try {
    const titleId = "11111111-2222-4333-8444-555555555555";
    const stored = localStoredPath(titleId, "mafia-king", "ep01-abcdef12.mp4");
    assert.equal(stored, `local/${titleId}/ws/mafia-king/ep01-abcdef12.mp4`);
    assert.ok(isLocalTierPath(stored));
    assert.equal(isLocalTierPath(`${titleId}/folder/ep01.mp4`), false);
    assert.equal(localPathOf(stored), path.join(tier, titleId, "ws", "mafia-king", "ep01-abcdef12.mp4"));
    assert.equal(resolveUploadPath(stored), localPathOf(stored), "the fixture route resolves the tier the same way");
    assert.equal(localStoredPath(titleId, "../weird slug", "..\\ep01.mp4"), `local/${titleId}/ws/_weird_slug/ep01.mp4`, "slug and file name are made safe");

    assert.throws(() => localPathOf(`${titleId}/folder/ep01.mp4`), { code: "invalid" }, "a bucket path is not the tier");
    assert.throws(() => localPathOf("local/../ep01.mp4"), { code: "invalid" });
    assert.throws(() => localPathOf(`local/${titleId}/../../ep01.mp4`), { code: "invalid" });
    assert.throws(() => localPathOf(`local/${titleId}`), { code: "invalid" }, "a title alone is not a file");
    assert.throws(() => localPathOf(`local/${titleId}//ep01.mp4`), { code: "invalid" });
    assert.throws(() => localPathOf(`local/${titleId}/ws/${path.resolve(workspace, "x.mp4")}`), { code: "invalid" });
    // A backslash inside a segment (Next decodes %5C before the handler runs) would walk into another title's folder on Windows.
    assert.throws(() => localPathOf(`local/${titleId}/ws\\..\\..\\other-title\\ws\\film\\ep01.mp4`), { code: "invalid" });
    assert.throws(() => localPathOf(`local/${titleId}/ws/C:\\x.mp4`), { code: "invalid" });
    assert.throws(() => resolveUploadPath(`${titleId}\\..\\other-title\\ep\\file.mp4`), { code: "invalid" });
    assert.throws(() => resolveUploadPath(`${titleId}/ep/a:b.mp4`), { code: "invalid" });
    // A decoded %2F inside a route segment joins into a dot segment: staying under .uploads/ is not enough, the file
    // must sit under the title the value names (the other title's folder and the local tier both live in .uploads/).
    assert.equal(resolveUploadPath(`${titleId}/ep/file.mp4`), path.join(process.cwd(), ".uploads", titleId, "ep", "file.mp4"));
    assert.throws(() => resolveUploadPath(`${titleId}/x/../../other-title/ep/file.mp4`), { code: "invalid" });
    assert.throws(() => resolveUploadPath(`${titleId}/x/../../local/other-title/ws/film/ep01.mp4`), { code: "invalid" });
    assert.throws(() => resolveUploadPath(`${titleId}/./ep/file.mp4`), { code: "invalid" });
    assert.throws(() => resolveUploadPath(`${titleId}//ep/file.mp4`), { code: "invalid" });
    assert.throws(() => resolveUploadPath(`local/${titleId}/x/../../other-title/ws/film/ep01.mp4`), { code: "invalid" });

    // A tier configured inside the workspace would read the pipeline's files in place: every path is refused.
    process.env.STUDIO_LOCAL_MEDIA_DIR = path.join(workspace, "low-quality", "mafia-king", "cut", "eps");
    assert.throws(() => localPathOf(stored), { code: "invalid", message: /WORKSPACE_ROOT/ });
    process.env.STUDIO_LOCAL_MEDIA_DIR = tier;

    // The snapshot: a hardlink (same volume) or a copy, once.
    const eps = path.join(workspace, "low-quality", "mafia-king", "cut", "eps");
    mkdirSync(eps, { recursive: true });
    const src = path.join(eps, "ep01.mp4");
    writeFileSync(src, "the first render");
    const first = linkIntoLocalTier(src, stored);
    assert.equal(first.abs, localPathOf(stored));
    assert.ok(first.how === "linked" || first.how === "copied", first.how);
    assert.equal(readFileSync(first.abs, "utf8"), "the first render");
    assert.equal(linkIntoLocalTier(src, stored).how, "existing", "the same file again is the same snapshot");

    // The pipeline re-renders with os.replace: the link keeps the bytes it was made from.
    const fresh = path.join(eps, "ep01.part.mp4");
    writeFileSync(fresh, "the second render, longer");
    renameSync(fresh, src);
    assert.equal(readFileSync(first.abs, "utf8"), "the first render");
    assert.throws(() => linkIntoLocalTier(src, stored), { code: "invalid" }, "another file at the same name is refused, not overwritten");
    const second = localStoredPath(titleId, "mafia-king", "ep01-12345678.mp4");
    assert.equal(readFileSync(linkIntoLocalTier(src, second).abs, "utf8"), "the second render, longer");

    assert.throws(() => linkIntoLocalTier(path.join(eps, "ep99.mp4"), localStoredPath(titleId, "mafia-king", "ep99-00000000.mp4")), { code: "invalid" });
    assert.throws(() => linkIntoLocalTier(src, `${titleId}/folder/ep01.mp4`), { code: "invalid" }, "only into the tier");
  } finally {
    if (before.media === undefined) delete process.env.STUDIO_LOCAL_MEDIA_DIR; else process.env.STUDIO_LOCAL_MEDIA_DIR = before.media;
    if (before.ws === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = before.ws;
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---- the media route -------------------------------------------------------------------------------

test("the media route streams a disk file with Range (whole, a slice, a suffix, an open end, 416) and names the title of a local-tier path", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "studio-media-range-"));
  try {
    const abs = path.join(scratch, "ep01-abcdef12.mp4");
    writeFileSync(abs, "0123456789abcdef");
    const req = (range?: string) => new NextRequest("http://localhost:3200/api/media/local/t/ws/f/ep01-abcdef12.mp4", { headers: range ? { range } : {} });
    const text = async (res: Response) => Buffer.from(await res.arrayBuffer()).toString("utf8");

    const whole = await streamFile(req(), abs);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "video/mp4");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.equal(whole.headers.get("content-length"), "16");
    assert.equal(await text(whole), "0123456789abcdef");

    const slice = await streamFile(req("bytes=4-7"), abs);
    assert.equal(slice.status, 206);
    assert.equal(slice.headers.get("content-range"), "bytes 4-7/16");
    assert.equal(slice.headers.get("content-length"), "4");
    assert.equal(await text(slice), "4567");

    const tail = await streamFile(req("bytes=-3"), abs);
    assert.equal(tail.headers.get("content-range"), "bytes 13-15/16");
    assert.equal(await text(tail), "def");

    const open = await streamFile(req("bytes=10-"), abs);
    assert.equal(open.headers.get("content-range"), "bytes 10-15/16");
    assert.equal(await text(open), "abcdef");

    const past = await streamFile(req("bytes=5-99"), abs);
    assert.equal(past.headers.get("content-range"), "bytes 5-15/16", "an end past the file is clamped");

    const bad = await streamFile(req("bytes=99-"), abs);
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */16");

    assert.equal((await streamFile(req(), path.join(scratch, "none.mp4"))).status, 404);

    assert.deepEqual(parseRange("bytes=0-0", 1), { start: 0, end: 0 });
    assert.equal(parseRange("bytes=-", 16), null);
    assert.equal(parseRange("items=1-2", 16), null);

    assert.equal(titleIdOfMediaPath(["local", "T", "ws", "film", "ep01-abc.mp4"]), "T", "a local-tier path authorizes on its second segment");
    assert.equal(titleIdOfMediaPath(["T", "ep", "file.mp4"]), "T");
    assert.equal(titleIdOfMediaPath(["local", "T"]), null);
    assert.equal(titleIdOfMediaPath(["T"]), null);
    assert.equal(titleIdOfMediaPath(["local", "..", "x", "y"]), null);
    assert.equal(titleIdOfMediaPath(["T", "", "y"]), null);
    assert.equal(titleIdOfMediaPath(["local", "T", "ws\\..\\..\\F\\ws\\slug\\ep01-abc.mp4"]), null, "a decoded %5C (Next decodes each segment) never reaches the disk");
    assert.equal(titleIdOfMediaPath(["T", "ep", "C:\\file.mp4"]), null);
    assert.equal(titleIdOfMediaPath(["T", "ep", "a\0b.mp4"]), null);
    // Next decodes %2F the same way: one segment that is not literally `..` and yet walks into another title once joined.
    assert.equal(titleIdOfMediaPath(["T", "x/../../F/ep/source.mp4"]), null, "a decoded %2F on a bucket path");
    assert.equal(titleIdOfMediaPath(["T", "x/../../local/F/ws/slug/ep01-abc.mp4"]), null, "a decoded %2F into the local tier");
    assert.equal(titleIdOfMediaPath(["local", "T", "ws/../../F/ws/slug/ep01-abc.mp4"]), null, "a decoded %2F on a local-tier path");
    assert.equal(titleIdOfMediaPath(["T", "ep", "a/b.mp4"]), null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---- auto_cut --------------------------------------------------------------------------------------

test("the upload-time clip run skips an imported episode (auto_cut false) and records no job; an uploaded episode is still run", async () => {
  const title = await importedTitle();
  await fixtureData.addVideoOnlyEpisode(systemSession(), title.id, 1, localStoredPath(title.id, "mafia-king", "ep01-aaaaaaaa.mp4"), { video_sha256: SHA_A, auto_cut: false });
  const skipped = await cutEpisodeClips(title.id, 1);
  assert.equal(skipped.outcome, "skipped");
  assert.equal(skipped.job_id, null);
  assert.deepEqual(skipped.failed, []);
  assert.equal(await fixtureData.latestEpisodeJob(staff(), title.id, 1, "cut_clips"), null, "no job row for an episode the engine does not cut");

  await fixtureData.addVideoOnlyEpisode(producer(), title.id, 2, `${title.id}/folder/ep2.mp4`);
  const run = await cutEpisodeClips(title.id, 2);
  assert.notEqual(run.outcome, "skipped", "an uploaded episode (auto_cut true) goes through the run");
  assert.ok(run.job_id, "and records its job");
  assert.equal((await fixtureData.latestEpisodeJob(staff(), title.id, 2, "cut_clips"))?.id, run.job_id);
});
