// The import job (lib/film-import/import): a READY fixture film becomes an
// en-US title with hardlinked, hashed, probed episodes, the pipeline
// transcript as each episode's script, film-meta's rules on the title and
// the index files as assets; a second run of the same bytes skips them; the
// listing reads IMPORTED / K_CHANGED from the record and a stat of the disk;
// the refusals; the plan changing under a running import; and the pure
// pieces (the whisper slice, ffprobe's JSON, the planned frame count). The
// checked-in fixture workspace is never written to: the tests that move a
// file work on a temp copy.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fixtureSession, systemSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { isLocalTierPath, localPathOf } from "@/lib/data/storage";
import {
  ffprobeBin,
  ffprobeFacts,
  importFilm,
  importProgress,
  latestImportRecord,
  listFilms,
  mergeAdRules,
  parseProbeJson,
  plannedFrames,
  readPoster,
  resetImportRegistry,
  sliceTranscript,
  startImport,
  stateAgainstRecord,
  type VideoFacts,
} from "@/lib/film-import/import";
import { scanFilm } from "@/lib/film-import/scan";
import type { AdRules, Json } from "@/lib/types";
import { producer, staff } from "./seed-minute";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "workspace");
const FILM = "low-quality/fixture-film";
const PLAN_FRAMES: Record<number, number> = { 1: 120, 2: 150, 3: 180 };

let mediaDir = "";
const temps: string[] = [];

beforeEach(() => {
  resetFixtureStore();
  resetImportRegistry();
  mediaDir = mkdtempSync(path.join(tmpdir(), "studio-local-"));
  process.env.STUDIO_LOCAL_MEDIA_DIR = mediaDir;
  process.env.STUDIO_WORK_DIR = path.join(mediaDir, "work");
  temps.push(mediaDir);
});

afterEach(() => {
  resetFixtureStore();
  resetImportRegistry();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  delete process.env.STUDIO_WORK_DIR;
});

/** A copy of the fixture workspace a test may write to. */
function tempWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "studio-ws-"));
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  temps.push(root);
  return root;
}

/** A probe table: the plan's frame count per episode, episode 2 one frame long (Mafia King's +1 case). */
const fakeProbe = async (link: string): Promise<VideoFacts | null> => {
  const n = Number(path.basename(link).match(/^ep(\d+)/)?.[1]);
  assert.ok(!link.includes(FIXTURE_ROOT) && !link.includes(`${path.sep}cut${path.sep}eps${path.sep}`), `the probe only ever sees a link: ${link}`);
  return { width: 720, height: 1280, fps: 30, frames: PLAN_FRAMES[n] + (n === 2 ? 1 : 0), duration_s: PLAN_FRAMES[n] / 30 };
};

const opts = (root = FIXTURE_ROOT) => ({ root, quietMs: 0, probe: fakeProbe });
const who = () => ({ producer_id: producer().producerId!, created_by: producer().userId });
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// ---- the import ------------------------------------------------------------------------------------------

test("importFilm: an en-US title, three hardlinked episodes hashed and probed through the link, transcripts, rules and assets", async () => {
  const r = await importFilm(producer(), { source_ref: FILM, mode: "import" }, who(), opts());
  assert.deepEqual(r.counts, { added: 3, updated: 0, unchanged: 0, flagged: 1, transcripts: 3, transcripts_skipped: 0 });
  assert.equal(r.state, "IMPORTED");
  assert.equal(r.changed_during_import, false);
  assert.equal(r.flags.length, 1);
  assert.match(r.flags[0], /^ep02: 151 frames on disk, the plan expects 150 \(\+1\)/);

  const detail = await fixtureData.getTitle(staff(), r.title_id);
  const title = detail.title;
  assert.equal(title.source_locale, "en-US");
  assert.equal(title.name_en, "Fixture Film");
  assert.equal(title.source_ref, FILM);
  assert.equal(title.crazydramas_slug, "fixture-film");
  assert.equal(detail.adaptation.created_by, producer().userId, "the system actor names the real caller");
  assert.ok(isLocalTierPath(title.cover_path), `the poster is the cover: ${title.cover_path}`);
  assert.match(title.cover_path!, new RegExp(`^local/${title.id}/ws/fixture-film/fixture-film-a-[0-9a-f]{8}\\.jpg$`));
  assert.equal(statSync(localPathOf(title.cover_path!)).size, statSync(path.join(FIXTURE_ROOT, "low-quality", "fixture-film", "poster", "final", "fixture-film-a.jpg")).size);
  assert.deepEqual(title.ad_rules, { spoiler_from_s: 7.5, exclusions: [{ from_s: 13, to_s: 14, why: "card: a test card", source: "film_meta" }] });
  assert.equal(detail.episodes.length, 3);

  for (const n of [1, 2, 3]) {
    const wb = await fixtureData.getWorkbench(staff(), title.id, n);
    const ep = wb.episode;
    const original = path.join(FIXTURE_ROOT, "low-quality", "fixture-film", "cut", "eps", `ep0${n}.mp4`);
    assert.match(ep.video_path!, new RegExp(`^local/${title.id}/ws/fixture-film/ep0${n}-[0-9a-f]{8}\\.mp4$`));
    assert.equal(ep.video_sha256, sha(original), "the hash of the link is the hash of the file");
    assert.equal(ep.video_path!.slice(-12, -4), ep.video_sha256!.slice(0, 8), "the link is named by its hash");
    const link = localPathOf(ep.video_path!);
    assert.equal(statSync(link).ino, statSync(original).ino, "a hardlink, not a copy");
    assert.equal(ep.video_bytes, statSync(original).size);
    assert.equal(ep.video_frames, PLAN_FRAMES[n] + (n === 2 ? 1 : 0));
    assert.equal(ep.auto_cut, false);
    assert.equal(ep.source_ref, `${FILM}/cut/eps/ep0${n}.mp4`);
    assert.deepEqual([ep.film_start_ms, ep.film_end_ms], [[0, 4000], [4000, 9000], [9000, 15000]][n - 1]);
    const note = ep.end_note as { decision: string; band_fix?: boolean; vision?: { pick?: { chosen_t: number } } | null };
    assert.equal(note.decision, ["chosen", "band_fix", "film_end"][n - 1]);
    if (n === 2) {
      assert.equal(note.band_fix, true);
      assert.equal(note.vision?.pick?.chosen_t, 8.5, "the record the band fix overrode travels with the note");
    }
    // The pipeline transcript, sliced to the window and shifted to episode time.
    assert.equal(ep.script_format, "asr");
    assert.equal(ep.has_timecodes, true);
    assert.ok(wb.lines.length >= 1, `episode ${n} has lines`);
    assert.ok(wb.lines.every((l) => l.speaker === null), "machine lines carry no speaker");
    assert.ok(wb.lines.every((l) => l.start_ms! >= 0 && l.end_ms! <= (ep.film_end_ms! - ep.film_start_ms!)), "cue times sit inside the episode");
    if (n === 1) assert.deepEqual(wb.lines.map((l) => [l.text_zh, l.start_ms, l.end_ms]), [["Where is she?", 500, 1600]]);
    if (n === 2) assert.deepEqual(wb.lines.map((l) => l.text_zh), ["She is gone.", "You knew."]);
    if (n === 2) assert.equal(wb.lines[0].start_ms, 400, "4.4 s in the film is 0.4 s into episode 2");
    // Never cut automatically: no cut_clips job, no clips.
    assert.equal(await fixtureData.latestEpisodeJob(systemSession(), title.id, n, "cut_clips"), null);
    assert.deepEqual(await fixtureData.listEpisodeClips(staff(), title.id, n), []);
  }

  const assets = await fixtureData.listFilmAssets(staff(), title.id);
  const kinds = assets.map((a) => `${a.origin}:${a.kind}`).sort();
  assert.deepEqual(kinds, [
    "studio:delivered_plan",
    "workspace:candidates",
    "workspace:delivered_plan",
    "workspace:film_meta",
    "workspace:motion",
    "workspace:poster",
    "workspace:shots",
    "workspace:source_facts",
    "workspace:transcript",
    "workspace:vision_notes",
    "workspace:vision_notes",
  ]);
  for (const a of assets) {
    assert.ok(isLocalTierPath(a.storage_path), a.storage_path);
    assert.equal(statSync(localPathOf(a.storage_path)).size, a.bytes);
    if (a.origin === "workspace") assert.equal(sha(localPathOf(a.storage_path)), a.sha256);
  }
  const visionFiles = assets.filter((a) => a.kind === "vision_notes").map((a) => (a.meta as { file: string }).file).sort();
  assert.deepEqual(visionFiles, ["2026-09-22_0-end.json", "2026-09-22_0-end_band-fix.md"], "the superseded record and the applied options file are not linked");
  const record = latestImportRecord(assets);
  assert.ok(record);
  assert.equal(record.delivered_sha256, (await scanFilm(FILM, { root: FIXTURE_ROOT, quietMs: 0 })).delivered?.sha256);
  assert.deepEqual(record.episodes.map((e) => [e.n, e.frames, e.planned_frames]), [[1, 120, 120], [2, 151, 150], [3, 180, 180]]);
  assert.equal(record.job_id, r.job_id);
});

test("a second run of the same bytes skips every episode; the transcript is never written over existing lines", async () => {
  const first = await importFilm(producer(), { source_ref: FILM, mode: "import" }, who(), opts());
  const again = await importFilm(producer(), { source_ref: FILM, mode: "update" }, who(), opts());
  assert.equal(again.title_id, first.title_id);
  assert.notEqual(again.job_id, first.job_id, "an update of an already imported plan is its own job row");
  assert.deepEqual(again.counts, { added: 0, updated: 0, unchanged: 3, flagged: 0, transcripts: 0, transcripts_skipped: 3 });
  assert.equal(again.flags.filter((f) => /kept its \d+ existing lines/.test(f)).length, 3);
  const wb = await fixtureData.getWorkbench(staff(), first.title_id, 1);
  assert.equal(wb.lines.length, 1, "the lines are the first import's");
  const detail = await fixtureData.getTitle(staff(), first.title_id);
  assert.equal(detail.episodes.length, 3);
  const records = (await fixtureData.listFilmAssets(staff(), first.title_id)).filter((a) => a.origin === "studio");
  assert.equal(records.length, 2, "every finished import leaves its record; the newest is the one that counts");
  assert.equal(latestImportRecord(await fixtureData.listFilmAssets(staff(), first.title_id))?.job_id, again.job_id);
});

test("attach_transcript false imports the episodes without a script; the display title typed before the import wins", async () => {
  const r = await importFilm(producer(), { source_ref: FILM, mode: "import", attach_transcript: false, display_title: "  My Fixture  " }, who(), opts());
  assert.equal(r.counts.transcripts, 0);
  const detail = await fixtureData.getTitle(staff(), r.title_id);
  assert.equal(detail.title.name_en, "My Fixture");
  assert.equal(detail.title.name_zh, "My Fixture");
  assert.equal(detail.adaptation.display_title_en, "My Fixture");
  assert.ok(detail.episodes.every((e) => e.lines_total === 0 && e.has_video));
});

// ---- the listing -----------------------------------------------------------------------------------------

test("listFilms: the three fixture states, then IMPORTED after the import, with the title behind the row", async () => {
  const before = await listFilms(producer(), producer().producerId!, opts());
  assert.equal(before.configured, true);
  assert.deepEqual(before.films.map((f) => [f.source_ref, f.state, f.reason?.code ?? null, f.imported]), [
    [FILM, "READY", null, null],
    ["low-quality/rendering-film", "RENDERING", "part_file", null],
    ["low-quality/undelivered-film", "NOT_DELIVERED", "no_delivered", null],
  ]);
  const fixture = before.films[0];
  assert.equal(fixture.display_title, "Fixture Film");
  assert.equal(fixture.source_title, "The Fixture Film");
  assert.equal(fixture.episodes, 3);
  assert.deepEqual(fixture.video, { width: 720, height: 1280, fps: 30 });
  assert.equal(fixture.language, "en");
  assert.equal(fixture.poster_ref, `${FILM}/poster/final/fixture-film-a.jpg`);
  assert.equal(fixture.crazydramas_slug, "fixture-film");

  const r = await importFilm(producer(), { source_ref: FILM, mode: "import" }, who(), opts());
  const after = await listFilms(producer(), producer().producerId!, opts());
  const row = after.films[0];
  assert.equal(row.state, "IMPORTED");
  assert.deepEqual(row.reason, { code: "imported" });
  assert.equal(row.imported?.title_id, r.title_id);
  assert.equal(row.imported?.episodes, 3);
  assert.match(row.imported?.cover_url ?? "", /^\/api\/media\/local\//);
  assert.equal(row.progress?.step, "done");

  // Another company sees the film as never imported: the title is not theirs.
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  const theirs = await listFilms(fixtureSession("producer", other.id), other.id, opts());
  assert.equal(theirs.films[0].state, "READY");
  assert.equal(theirs.films[0].imported, null);
  // Staff with no company chosen read the disk's states alone.
  const staffView = await listFilms(staff(), null, opts());
  assert.equal(staffView.films[0].state, "READY");
  assert.equal(staffView.films[0].imported, null);
  // Without a workspace there is nothing to list, and no crash.
  assert.deepEqual(await listFilms(producer(), producer().producerId!, { root: path.join(mediaDir, "nowhere"), quietMs: 0 }), { configured: true, films: [] });
});

test("K_CHANGED from a stat of the disk: a re-rendered file (mtime) or a new plan, confirmed by the update run without touching the original", async () => {
  const root = tempWorkspace();
  const r = await importFilm(producer(), { source_ref: FILM, mode: "import" }, who(), opts(root));
  const ep2 = path.join(root, "low-quality", "fixture-film", "cut", "eps", "ep02.mp4");
  const later = new Date(statSync(ep2).mtimeMs + 60_000);
  utimesSync(ep2, later, later);
  let row = (await listFilms(producer(), producer().producerId!, opts(root))).films[0];
  assert.equal(row.state, "K_CHANGED");
  assert.deepEqual(row.reason, { code: "files_changed", episodes: [2] });
  assert.deepEqual(row.changed, [2]);

  const update = await importFilm(producer(), { source_ref: FILM, mode: "update" }, who(), opts(root));
  assert.equal(update.title_id, r.title_id);
  assert.deepEqual([update.counts.added, update.counts.updated, update.counts.unchanged], [0, 0, 3], "the same bytes under a new mtime are confirmed unchanged by the hash");
  row = (await listFilms(producer(), producer().producerId!, opts(root))).films[0];
  assert.equal(row.state, "IMPORTED", "the record now carries the new mtime");

  // A new plan file: the same windows written again is a new hash and therefore K_CHANGED, and the update reads it.
  const planFile = path.join(root, "low-quality", "fixture-film", "cut", "review", "cuts-0-15-DELIVERED.json");
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  plan.episodes[0].ends_after_line = "Where is she? (revised)";
  writeFileSync(planFile, JSON.stringify(plan, null, 1));
  row = (await listFilms(producer(), producer().producerId!, opts(root))).films[0];
  assert.equal(row.state, "K_CHANGED");
  assert.deepEqual(row.reason, { code: "plan_changed" });
  const again = await importFilm(producer(), { source_ref: FILM, mode: "update" }, who(), opts(root));
  assert.equal(again.counts.unchanged, 3);
  row = (await listFilms(producer(), producer().producerId!, opts(root))).films[0];
  assert.equal(row.state, "IMPORTED");

  // A moved window under the same file is an update of that episode's window, not a new file.
  plan.episodes[0].end = 4.5;
  plan.episodes[1].start = 4.5;
  writeFileSync(planFile, JSON.stringify(plan, null, 1));
  const moved = await importFilm(producer(), { source_ref: FILM, mode: "update" }, who(), opts(root));
  assert.deepEqual([moved.counts.updated, moved.counts.unchanged], [2, 1]);
  const wb = await fixtureData.getWorkbench(staff(), r.title_id, 1);
  assert.equal(wb.episode.film_end_ms, 4500);
  assert.equal(wb.lines.length, 1, "the existing lines stay (never replaced), and the run says so");
  assert.ok(moved.flags.some((f) => f.startsWith("ep01: kept its 1 existing lines")));
});

test("the plan changing under a running import ends in K_CHANGED, not a failure", async () => {
  const root = tempWorkspace();
  const planFile = path.join(root, "low-quality", "fixture-film", "cut", "review", "cuts-0-15-DELIVERED.json");
  const r = await importFilm(producer(), { source_ref: FILM, mode: "import" }, who(), {
    ...opts(root),
    hooks: {
      afterEpisodes: async () => {
        const plan = JSON.parse(readFileSync(planFile, "utf8"));
        plan.episodes[2].ends_after_line = "Run. Now.";
        writeFileSync(planFile, JSON.stringify(plan, null, 1));
      },
    },
  });
  assert.equal(r.changed_during_import, true);
  assert.equal(r.state, "K_CHANGED");
  assert.equal(r.counts.added, 3, "what was imported stays imported");
  const row = (await listFilms(producer(), producer().producerId!, opts(root))).films[0];
  assert.equal(row.state, "K_CHANGED");
  assert.deepEqual(row.reason, { code: "plan_changed" });
});

// ---- refusals ----------------------------------------------------------------------------------------------

test("refusals: not READY, unknown, already imported, never imported, already running", async () => {
  await assert.rejects(importFilm(producer(), { source_ref: "low-quality/rendering-film", mode: "import" }, who(), opts()), (e: Error & { code?: string }) => e.code === "conflict" && /ep02\.part\.mp4/.test(e.message));
  await assert.rejects(importFilm(producer(), { source_ref: "low-quality/undelivered-film", mode: "import" }, who(), opts()), { code: "conflict" });
  await assert.rejects(importFilm(producer(), { source_ref: "low-quality/no-such-film", mode: "import" }, who(), opts()), { code: "not_found" });
  await assert.rejects(importFilm(producer(), { source_ref: "../outside", mode: "import" }, who(), opts()), { code: "invalid" });
  await assert.rejects(importFilm(producer(), { source_ref: FILM, mode: "update" }, who(), opts()), { code: "not_found" });
  assert.equal((await fixtureData.listTitles(staff())).length, 0, "a refusal creates nothing");

  await importFilm(producer(), { source_ref: FILM, mode: "import" }, who(), opts());
  await assert.rejects(importFilm(producer(), { source_ref: FILM, mode: "import" }, who(), opts()), { code: "conflict" });
  assert.equal((await fixtureData.listTitles(staff())).length, 1);

  // A staff caller must name the company; a producer's own company is implied.
  await assert.rejects(importFilm(staff(), { source_ref: FILM, mode: "import" }, {}, opts()), { code: "invalid" });
});

test("startImport returns once the title exists; the registry reports the progress until the episodes land; a second start is refused meanwhile", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slowProbe = async (link: string) => {
    await gate;
    return fakeProbe(link);
  };
  const started = await startImport(producer(), { source_ref: FILM, mode: "import" }, who(), { ...opts(), probe: slowProbe });
  assert.ok(started.title_id);
  assert.equal(started.created, true);
  assert.equal((await fixtureData.getTitle(staff(), started.title_id)).episodes.length, 0, "the episodes are still to come");
  const running = importProgress(producer().producerId!, FILM);
  assert.equal(running?.job_id, started.job_id);
  assert.notEqual(running?.step, "done");
  await assert.rejects(startImport(producer(), { source_ref: FILM, mode: "import" }, who(), opts()), (e: Error & { code?: string }) => e.code === "conflict" && /already running/.test(e.message));
  await assert.rejects(startImport(producer(), { source_ref: FILM, mode: "update" }, who(), opts()), { code: "conflict" });
  release();
  for (let i = 0; i < 200 && importProgress(producer().producerId!, FILM)?.step !== "done"; i++) await new Promise((r) => setTimeout(r, 25));
  const done = importProgress(producer().producerId!, FILM);
  assert.equal(done?.step, "done");
  assert.deepEqual(done?.result?.counts, { added: 3, updated: 0, unchanged: 0, flagged: 1, transcripts: 3, transcripts_skipped: 0 });
  assert.equal((await fixtureData.getTitle(staff(), started.title_id)).episodes.length, 3);
});

// ---- the pure pieces ---------------------------------------------------------------------------------------

test("sliceTranscript: a word belongs to the window that holds its midpoint, shifted to episode time; wordless overlap contributes nothing", () => {
  const whisper = {
    segments: [
      { start: 3.0, end: 5.0, text: "one two", words: [{ w: " one", s: 3.0, e: 3.9, p: 1 }, { w: " two", s: 3.9, e: 4.6, p: 1 }] },
      { start: 5.0, end: 6.0, text: "three", words: [{ w: " three", s: 5.0, e: 5.5, p: 1 }] },
      { start: 8.9, end: 9.4, text: "four", words: [{ w: " four", s: 8.9, e: 9.4, p: 1 }] },
      { start: 6.5, end: 7.5, text: "no words", words: [] },
    ],
  };
  const ep2 = sliceTranscript(whisper, 4.0, 9.0);
  assert.deepEqual(ep2, [
    { start_ms: 0, end_ms: 600, text: "two", words: [{ w: " two", start_ms: 0, end_ms: 600 }] },
    { start_ms: 1000, end_ms: 1500, text: "three", words: [{ w: " three", start_ms: 1000, end_ms: 1500 }] },
  ]);
  const ep1 = sliceTranscript(whisper, 0, 4.0);
  assert.deepEqual(ep1.map((s) => s.text), ["one"]);
  assert.deepEqual(ep1[0].words, [{ w: " one", start_ms: 3000, end_ms: 3900 }]);
  const ep3 = sliceTranscript(whisper, 9.0, 15.0);
  assert.deepEqual(ep3.map((s) => [s.text, s.start_ms, s.end_ms]), [["four", 0, 400]], "a word straddling the boundary is written once, clamped into its episode");
  assert.deepEqual(sliceTranscript(whisper, 20, 30), []);
});

test("parseProbeJson prefers the counted packets, falls back to nb_frames, refuses a streamless answer", () => {
  assert.deepEqual(parseProbeJson(JSON.stringify({ streams: [{ width: 720, height: 1280, r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_packets: "120", nb_frames: "119", duration: "4.000000" }] })), {
    width: 720,
    height: 1280,
    fps: 30,
    frames: 120,
    duration_s: 4,
  });
  assert.deepEqual(parseProbeJson(JSON.stringify({ streams: [{ width: 1080, height: 1920, r_frame_rate: "30000/1001", nb_frames: "3600" }] })), { width: 1080, height: 1920, fps: 29.97, frames: 3600, duration_s: null });
  assert.equal(parseProbeJson(JSON.stringify({ streams: [] })), null);
  assert.equal(parseProbeJson("not json"), null);
  assert.equal(parseProbeJson(JSON.stringify({ streams: [{ width: 0, height: 10, r_frame_rate: "30/1" }] })), null);
});

test("plannedFrames counts on frame boundaries the way the pipeline cuts; mergeAdRules keeps review exclusions; stateAgainstRecord", async () => {
  assert.equal(plannedFrames({ start: 0, end: 4 }, 30), 120);
  assert.equal(plannedFrames({ start: 1800, end: 1936.533 }, 30), Math.round(1936.533 * 30) - 54000);
  assert.equal(plannedFrames({ start: 0.01, end: 0.015 }, 30), 0, "both ends round to the same frame");

  const current: AdRules = { spoiler_from_s: 100, exclusions: [{ from_s: 1, to_s: 2, why: "old meta", source: "film_meta" }, { from_s: 5, to_s: 6, why: "a card a reviewer saw", source: "review" }] };
  const meta = { display_title_en: "X", source_title_en: null, crazydramas_slug: null, language: "en", spoiler_from_s: null, exclusions: [{ from_s: 10, to_s: 11, why: "stinger", kind: "stinger" }], live_poster: null, notes: null };
  assert.deepEqual(mergeAdRules(current, meta), { spoiler_from_s: 100, exclusions: [{ from_s: 10, to_s: 11, why: "stinger: stinger", source: "film_meta" }, { from_s: 5, to_s: 6, why: "a card a reviewer saw", source: "review" }] });
  assert.equal(mergeAdRules(null, null), null);
  assert.deepEqual(mergeAdRules(current, null), current);

  const scan = await scanFilm(FILM, { root: FIXTURE_ROOT, quietMs: 0 });
  const record = {
    version: 1,
    imported_at: "2026-09-23T00:00:00.000Z",
    job_id: "j",
    source_ref: FILM,
    delivered_file: scan.delivered!.file,
    delivered_sha256: scan.delivered!.sha256,
    meta_sha256: null,
    episodes: scan.episodes.map((e) => ({ n: e.n, bytes: e.bytes, mtime_ms: e.mtime_ms, sha256: "0".repeat(64), frames: null, planned_frames: null, video_path: "x" })),
    counts: { added: 3, updated: 0, unchanged: 0, flagged: 0, transcripts: 0, transcripts_skipped: 0 },
    flags: [],
  };
  assert.equal(stateAgainstRecord(scan, record).state, "IMPORTED");
  assert.equal(stateAgainstRecord(scan, null).state, "READY");
  assert.deepEqual(stateAgainstRecord(scan, { ...record, delivered_sha256: "f".repeat(64) }).reason, { code: "plan_changed" });
  assert.deepEqual(stateAgainstRecord(scan, { ...record, episodes: record.episodes.map((e) => (e.n === 3 ? { ...e, mtime_ms: e.mtime_ms - 1 } : e)) }).reason, { code: "files_changed", episodes: [3] });
  assert.deepEqual(stateAgainstRecord(scan, { ...record, episodes: record.episodes.map((e) => (e.n === 1 ? { ...e, bytes: e.bytes + 1 } : e)) }).reason, { code: "files_changed", episodes: [1] });
  assert.equal(latestImportRecord([]), null);
  assert.equal(latestImportRecord([{ id: "a", title_id: "t", kind: "delivered_plan", storage_path: "local/t/ws/f/x.json", sha256: "0".repeat(64), bytes: 1, origin: "workspace", source_ref: null, meta: {} as Json, created_at: "" }]), null);
});

test("readPoster serves only a poster under the workspace", async () => {
  const ok = await readPoster(`${FILM}/poster/final/fixture-film-a.jpg`, { root: FIXTURE_ROOT });
  assert.equal(ok?.contentType, "image/jpeg");
  assert.equal(ok?.bytes.length, statSync(path.join(FIXTURE_ROOT, "low-quality", "fixture-film", "poster", "final", "fixture-film-a.jpg")).size);
  assert.equal(await readPoster(`${FILM}/cut/eps/ep01.mp4`, { root: FIXTURE_ROOT }), null, "an episode is never read in place");
  assert.equal(await readPoster(`${FILM}/cut/film-meta.json`, { root: FIXTURE_ROOT }), null);
  assert.equal(await readPoster(`../${FILM}/poster/final/fixture-film-a.jpg`, { root: FIXTURE_ROOT }), null);
  assert.equal(await readPoster(`${FILM}/poster/final/missing.jpg`, { root: FIXTURE_ROOT }), null);
  assert.equal(await readPoster("", { root: FIXTURE_ROOT }), null);
});

test("ffprobe on the fixture episode (skipped when ffprobe is not on this machine)", async (t) => {
  const have = spawnSync(ffprobeBin(), ["-version"]).status === 0;
  if (!have) return t.skip("no ffprobe");
  // The probe is only ever pointed at a link; here a copy under the temp dir stands in for one.
  const copy = path.join(mediaDir, "probe-sample.mp4");
  cpSync(path.join(FIXTURE_ROOT, "low-quality", "fixture-film", "cut", "eps", "ep01.mp4"), copy);
  assert.deepEqual(await ffprobeFacts(copy), { width: 720, height: 1280, fps: 30, frames: 120, duration_s: 4 });
  assert.equal(await ffprobeFacts(path.join(mediaDir, "missing.mp4")), null);
});
