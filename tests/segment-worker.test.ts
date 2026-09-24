// The segment worker over the fake pipeline (STUDIO_FAKE_PIPELINE=1) in
// fixture mode, no Python, no model key: a run goes intake → watermark (a
// person accepts the box) → index → plan → vision (the fake pass) → review
// (one boundary needs a decision) → render → QA → film-meta → hand-off →
// import → done, with the run lock taken and released, a job row per
// stage, the review snapshot, the override file and the title with its
// episodes at the end; a cancel stops a waiting run; a landscape source is
// refused at intake with the reason; a band-breaking move is refused at the
// route; a run set back a stage resumes from its artifacts; a first proof
// is extended under its pins by a run that says so, and a delivered film or
// a session's folder is refused otherwise (at create time, and again by the
// worker before it writes anything into the folder); a run cancelled at its
// review leaves a folder a new run on the same slug takes over with fresh
// options; a film delivered to its end has nothing to extend; a re-judged
// boundary waits for the person; an Import now pressed before READY still
// applies; a cancel leaves the run lock to a worker whose lease is live; the
// join clips are cut from the built episodes.

process.env.PROMO_RENDER = "off";
process.env.STUDIO_FAKE_PIPELINE = "1";
process.env.STUDIO_SEGMENT_WORKER = "off";

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession, systemSession } from "@/lib/auth";
import { isDataError } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { resetImportRegistry } from "@/lib/film-import/import";
import { studioRunLockPath } from "@/lib/locks";
import { ensureJoinProxy } from "@/lib/segment/evidence";
import { FakePipelineRunner } from "@/lib/segment/fake-runner";
import { reviewStateOf } from "@/lib/segment/plan";
import { runDirs, visionLabel, waitingOf } from "@/lib/segment/stages";
import { cancelRun, createRun, decideRun, stageView } from "@/lib/segment/view";
import { executeRun, runTick } from "@/lib/segment/worker";
import type { FilmRun } from "@/lib/types";

const staff = () => fixtureSession("staff");
let root: string;
let sources: string;
let sourceFile: string;

beforeEach(() => {
  resetFixtureStore();
  resetImportRegistry();
  root = mkdtempSync(path.join(tmpdir(), "studio-segment-run-"));
  sources = path.join(root, "downloads");
  mkdirSync(sources);
  sourceFile = path.join(sources, "YTDown.com_YouTube_FULL-A-Fixture-Film_Media_abcdefghijk_001_720p.mp4");
  copyFileSync(path.join(process.cwd(), "tests", "fixtures", "workspace", "low-quality", "fixture-film", "cut", "eps", "ep01.mp4"), sourceFile);
  process.env.STUDIO_WORK_DIR = path.join(root, "work");
  process.env.STUDIO_LOCAL_MEDIA_DIR = path.join(root, "local");
  process.env.STUDIO_SOURCE_ROOTS = sources;
  delete process.env.WORKSPACE_ROOT;
});

afterEach(() => {
  resetFixtureStore();
  rmSync(root, { recursive: true, force: true });
});

const runner = () => new FakePipelineRunner({ delayMs: 0 });
const opts = () => ({ runner: runner(), awaitRuns: true, progressEveryMs: 0, log: () => undefined, owner: "test-host:1" });

async function tick(): Promise<void> {
  await runTick(opts());
}

async function get(id: string): Promise<FilmRun> {
  return fixtureData.getFilmRun(staff(), id);
}

/** Tick until the run waits or ends (a bounded loop; the fake is fast). */
async function settle(id: string): Promise<FilmRun> {
  for (let i = 0; i < 40; i++) {
    await tick();
    const run = await get(id);
    if (waitingOf(run) || run.stage === "done" || run.stage === "failed" || run.stage === "cancelled") return run;
  }
  throw new Error("the run did not settle");
}

async function newRun(overrides: Partial<Parameters<typeof createRun>[1]> = {}): Promise<FilmRun> {
  return createRun(staff(), { producer_id: FIXTURE_PRODUCER_ID, source_path: sourceFile, bucket: "low-quality", slug: "a-fixture-film", mode: "by_eye_2min", lang: "en", settings: {}, ...overrides });
}

async function expectCode(code: string, fn: () => Promise<unknown>, what: string, message?: RegExp): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (isDataError(e) && e.code === code) {
      if (message) assert.match(e.message, message, what);
      return;
    }
    throw e;
  }
  assert.fail(`${what}: expected ${code}`);
}

/** Tick (with a short pause, for a readiness poll's retry_after) until `until` holds or the run ends. */
async function settleUntil(id: string, until: (run: FilmRun) => boolean): Promise<FilmRun> {
  for (let i = 0; i < 60; i++) {
    await tick();
    const run = await get(id);
    if (until(run) || run.stage === "done" || run.stage === "failed" || run.stage === "cancelled") return run;
    await new Promise<void>((r) => setTimeout(r, 60));
  }
  throw new Error("the run did not settle");
}

/** Drive a fresh run to the film-meta wait: the box accepted, the one open boundary accepted, the review applied. */
async function toFilmMeta(overrides: Partial<Parameters<typeof createRun>[1]> = {}): Promise<FilmRun> {
  const created = await newRun(overrides);
  let run = await settle(created.id);
  assert.equal(run.stage, "watermark", run.error_text ?? "");
  await decideRun(staff(), run.id, { kind: "watermark", accept: true });
  run = await settle(run.id);
  assert.equal(run.stage, "review", run.error_text ?? "");
  await decideRun(staff(), run.id, { kind: "boundary", boundary_s: 9, action: "accept" });
  await decideRun(staff(), run.id, { kind: "apply_review" });
  run = await settle(run.id);
  assert.equal(run.stage, "film_meta", run.error_text ?? "");
  return run;
}

test("the whole run through the fake pipeline: every stage, every wait, the lock, the job rows, the snapshot, the override file, the title", async () => {
  const created = await newRun();
  assert.equal(created.stage, "queued");
  assert.equal(created.source_path, sourceFile.replace(/\\/g, "/"), "the source is stored with forward slashes");
  const dirs = runDirs(created);

  // intake → watermark: the box is detected and shown; the run waits.
  let run = await settle(created.id);
  assert.equal(run.stage, "watermark", run.error_text ?? "");
  assert.equal(waitingOf(run)?.for, "watermark");
  assert.equal(run.drama_remix_sha, "f".repeat(40));
  assert.equal(run.drama_remix_dirty, false);
  const detail = run.stage_detail as Record<string, unknown>;
  assert.deepEqual((detail.source as { parsed: unknown }).parsed, { video_id: "abcdefghijk", part: 1, height_p: 720 });
  assert.equal((detail.source as { placed: string }).placed, "linked");
  assert.ok(existsSync(dirs.source), "the source is in the film folder");
  assert.ok(existsSync(path.join(dirs.cut, "scripts", ".route")), "the scripts are synced");
  assert.ok(existsSync(path.join(dirs.cut, "index", "watermark-found.png")));
  const lock = JSON.parse(readFileSync(studioRunLockPath(dirs.cut), "utf8")) as { run_id: string; owner: string; stage: string };
  assert.equal(lock.run_id, created.id);
  assert.equal(lock.owner, "pulsar-studio");
  assert.equal(run.lease_owner, null, "a waiting run holds no lease");
  let view = await stageView(run);
  assert.deepEqual((view.watermark as { box: unknown }).box, { x: 18, y: 28, w: 94, h: 89 });
  assert.ok((view.watermark as { image_urls: string[] }).image_urls[0].startsWith(`/api/film-runs/${run.id}/evidence/index/watermark-found.png`));
  assert.equal(await runTick(opts()).then((r) => r.started.length), 0, "nothing wakes it without a decision");

  // A redrawn region re-detects (--force is the person's decision); accept moves on.
  await decideRun(staff(), run.id, { kind: "watermark", region: { x: 0.5, y: 0.7, w: 0.5, h: 0.3 } });
  run = await settle(run.id);
  assert.equal(run.stage, "watermark", run.error_text ?? "");
  assert.equal((run.stage_detail as { region_used: string }).region_used, "0.5,0.7,1,1");
  await decideRun(staff(), run.id, { kind: "watermark", accept: true });

  // index → plan → vision → review: the fake pass leaves the second boundary to a person.
  run = await settle(run.id);
  assert.equal(run.stage, "review", run.error_text ?? "");
  assert.equal(waitingOf(run)?.for, "review");
  assert.ok(existsSync(path.join(dirs.cut, "index", "candidates.json")));
  assert.ok(existsSync(path.join(dirs.cut, "review", "options.json")));
  assert.ok(existsSync(path.join(dirs.cut, "review", "vision", `${visionLabel(run)}.json`)), "the pass file carries the run's label");
  const jobs = await fixtureData.latestJobByTarget(systemSession(), "film_run", run.id, "segment_film");
  assert.equal(jobs?.status, "done");
  const { state } = await reviewStateOf({ run, dirs });
  assert.deepEqual(state.boundaries.map((b) => [b.boundary_s, b.status, b.reasons]), [
    [4, "pre_accepted", []],
    [9, "needs_decision", ["low_confidence", "skeptic_override"]],
  ]);
  assert.equal(state.boundaries[1].applied_t, 9.2, "the skeptic's better time is what apply_vision applies");
  view = await stageView(run);
  assert.equal(view.review?.needs_decision, 1);
  assert.equal(view.review?.boundaries[1].options.length, 3);
  assert.ok(view.review?.boundaries[1].options[0].strip_url?.startsWith(`/api/film-runs/${run.id}/evidence/review/frames/`));
  assert.equal(view.review?.boundaries[1].proxy_url, `/api/film-runs/${run.id}/evidence/work/proxies/t9_200.mp4`);
  assert.deepEqual(view.review?.boundaries[1].legal_cuts.map((c) => c.t), [3.5, 4, 8.5, 9, 9.2, 12]);

  // The decisions: a band-breaking move is refused, a join of two episodes is refused (no pipeline path), apply needs every decision.
  await expectCode("conflict", () => decideRun(staff(), run.id, { kind: "boundary", boundary_s: 9, action: "move", to_t: 8.5 }), "a move that makes the last episode 6.5 s");
  await expectCode("conflict", () => decideRun(staff(), run.id, { kind: "boundary", boundary_s: 9, action: "remove" }), "remove");
  await expectCode("conflict", () => decideRun(staff(), run.id, { kind: "apply_review" }), "apply before the decision");
  await expectCode("not_found", () => decideRun(staff(), run.id, { kind: "boundary", boundary_s: 77, action: "accept" }), "an unknown boundary");
  await decideRun(staff(), run.id, { kind: "boundary", boundary_s: 9, action: "move", to_t: 9, reason: "the DP's cut reads better" });
  await decideRun(staff(), run.id, { kind: "apply_review" });

  // review apply → render → qa → film_meta.
  run = await settle(run.id);
  assert.equal(run.stage, "film_meta", run.error_text ?? "");
  const override = readdirSync(path.join(dirs.cut, "review", "vision")).filter((n) => n.includes("_review"));
  assert.equal(override.length, 1, "one override file, reviewer ruobin");
  const choices = JSON.parse(readFileSync(path.join(dirs.cut, "review", "choices.json"), "utf8")) as Record<string, number>;
  assert.deepEqual(choices, { "4": 4, "9": 9 });
  assert.ok(readdirSync(path.join(dirs.work, "snapshots")).some((n) => n.startsWith("review-")), "review/ was snapshotted before the apply");
  assert.ok(readdirSync(path.join(dirs.work, "snapshots")).some((n) => n.startsWith("render-")), "and before the render");
  assert.deepEqual(readdirSync(path.join(dirs.cut, "eps")).sort(), ["ep01.mp4", "ep02.mp4", "ep03.mp4"]);
  assert.ok(readdirSync(path.join(dirs.cut, "review")).some((n) => /^cuts-0-15-DELIVERED\.json$/.test(n)), "the render recorded its delivery");
  assert.ok(existsSync(path.join(dirs.cut, "review", "qa", "qa.json")));
  view = await stageView(run);
  assert.equal(view.qa?.episodes.length, 3);
  assert.equal(view.joins.length, 2);
  assert.equal(view.film_meta?.default.spoiler_from_s, 7.5);
  assert.equal((run.stage_detail as { render: { episodes: number } }).render.episodes, 3);
  // The join clips are cut from the BUILT episodes through Studio's own links in the work dir, never from the source or the pipeline's path.
  assert.equal(view.joins[0].proxy_url, `/api/film-runs/${run.id}/evidence/work/joins/j01_t4_000.mp4`);
  const joinClip = await ensureJoinProxy(run, 1, 4, runner());
  assert.ok(joinClip && existsSync(joinClip), "the join clip is made on request");
  assert.equal(path.relative(dirs.work, joinClip!).replace(/\\/g, "/"), "joins/j01_t4_000.mp4");
  assert.deepEqual(readdirSync(path.join(dirs.work, "eps")).map((n) => n.replace(/-\d+-\d+\.mp4$/, "")).sort(), ["ep01", "ep02"], "one link per built episode the clip needed");
  assert.equal(await ensureJoinProxy(run, 1, 4.5, runner()), null, "not the plan's end of episode 1");
  assert.equal(await ensureJoinProxy(run, 3, 15, runner()), null, "no join after the last episode");

  // A join moved after the QA: pick_cuts --repin declares the one move, the render re-encodes the two episodes, the QA re-measures them.
  await expectCode("conflict", () => decideRun(staff(), run.id, { kind: "join", join_index: 1, to_t: 3.5 }), "a join that makes ep1 3.5 s");
  await expectCode("conflict", () => decideRun(staff(), run.id, { kind: "join", join_index: 2, to_t: 9.1 }), "not a legal cut");
  await decideRun(staff(), run.id, { kind: "join", join_index: 2, to_t: 9.2, reason: "the reaction belongs to ep2" });
  run = await settle(run.id);
  assert.equal(run.stage, "film_meta", run.error_text ?? "");
  const plan = JSON.parse(readFileSync(path.join(dirs.cut, "cuts.json"), "utf8")) as { episodes: { end: number }[]; moves: { from: number; to: number }[] };
  assert.deepEqual(plan.episodes.map((e) => e.end), [4, 9.2, 15]);
  assert.deepEqual(plan.moves, [{ from: 9, to: 9.2 }]);
  const render = (run.stage_detail as { render: { rendered: number; kept: number; repin: { from: number; to: number; only: number[] } } }).render;
  assert.deepEqual(render.repin, { from: 9, to: 9.2, only: [2, 3] });
  assert.equal(render.kept, 1, "ep01 was kept, the two episodes at the join re-encoded");
  assert.ok(readdirSync(path.join(dirs.cut, "review", "superseded")).length >= 1, "the earlier delivery record moved aside");
  // qa_episodes.py --only 2,3 wrote a report of episodes 2 and 3 alone; the earlier record of episode 1 was merged back.
  const qaAfter = JSON.parse(readFileSync(path.join(dirs.cut, "review", "qa", "qa.json"), "utf8")) as { episodes: { n: number }[] };
  assert.deepEqual(qaAfter.episodes.map((e) => e.n), [1, 2, 3], "the QA report still lists every episode");
  assert.deepEqual((run.stage_detail as { qa: { merged_from_before: number[] } }).qa.merged_from_before, [1]);
  assert.ok(readdirSync(path.join(dirs.work, "qa")).some((n) => n.startsWith("qa-before-")), "the report before the --only run was kept");
  assert.equal((await stageView(run)).qa?.episodes.length, 3);

  // film_meta → handoff (READY at once: the fake scanner has no quiet period) → import_now → done.
  await decideRun(staff(), run.id, { kind: "film_meta", display_title_en: "A Fixture Film", crazydramas_slug: "a-fixture-film", spoiler_from_s: 7.5, exclusions: [{ from_s: 13, to_s: 14, why: "card", kind: "card" }], live_poster: null });
  run = await settle(run.id);
  assert.equal(run.stage, "handoff", run.error_text ?? "");
  assert.equal(waitingOf(run)?.for, "import");
  const meta = JSON.parse(readFileSync(path.join(dirs.cut, "film-meta.json"), "utf8")) as { display_title_en: string; language: string };
  assert.equal(meta.display_title_en, "A Fixture Film");
  assert.equal(meta.language, "en");
  await decideRun(staff(), run.id, { kind: "import_now" });
  run = await settle(run.id);
  assert.equal(run.stage, "done", run.error_text ?? "");
  assert.ok(run.title_id, "the title the episodes became");
  const title = await fixtureData.getTitle(staff(), run.title_id!);
  assert.equal(title.title.name_en, "A Fixture Film");
  assert.equal(title.title.source_ref, "low-quality/a-fixture-film");
  assert.equal(title.episodes.length, 3);
  assert.equal(existsSync(studioRunLockPath(dirs.cut)), false, "the run lock is released when the run ends");
  assert.equal(run.lease_owner, null);
  assert.deepEqual(run.decisions.map((d) => d.action), ["watermark_region", "watermark_accept", "move", "apply_review", "join", "film_meta", "import_now"]);
  assert.ok(run.decisions.every((d) => d.by === "Ruobin"), "decisions carry who made them");
});

test("a first proof is extended by a run that says so: the index is redone to the new length, fresh options come out under the delivered pins, the review measures from the pin, the unchanged episode is kept and the title is updated", async () => {
  // The first proof: the first 9 s of the film (--to 9), one open boundary at 4 s, two episodes, imported as a title.
  const proof = await newRun({ settings: { to_s: 9 } });
  let run = await settle(proof.id);
  assert.equal(run.stage, "watermark", run.error_text ?? "");
  await decideRun(staff(), run.id, { kind: "watermark", accept: true });
  run = await settle(run.id);
  assert.equal(run.stage, "review", run.error_text ?? "");
  const dirs = runDirs(run);
  const whisperDuration = () => (JSON.parse(readFileSync(path.join(dirs.cut, "index", "whisper.json"), "utf8")) as { duration: number }).duration;
  assert.equal(whisperDuration(), 9, "the proof's transcript stops at --to");
  assert.deepEqual((await reviewStateOf({ run, dirs })).state.boundaries.map((b) => b.boundary_s), [4]);
  await decideRun(staff(), run.id, { kind: "apply_review" });
  run = await settle(run.id);
  assert.equal(run.stage, "film_meta", run.error_text ?? "");
  assert.ok(readdirSync(path.join(dirs.cut, "review")).some((n) => n === "cuts-0-9-DELIVERED.json"), "the proof's delivery record");
  assert.deepEqual(readdirSync(path.join(dirs.cut, "eps")).sort(), ["ep01.mp4", "ep02.mp4"]);
  await decideRun(staff(), run.id, { kind: "film_meta", display_title_en: "A Proof", crazydramas_slug: null, spoiler_from_s: null, exclusions: [], live_poster: null });
  run = await settle(run.id);
  assert.equal(waitingOf(run)?.for, "import", run.error_text ?? "");
  await decideRun(staff(), run.id, { kind: "import_now" });
  run = await settle(run.id);
  assert.equal(run.stage, "done", run.error_text ?? "");
  const titleId = run.title_id!;
  assert.equal((await fixtureData.getTitle(staff(), titleId)).episodes.length, 2);

  // A plain run on the delivered film is refused at create time, in words: no row, no lock, nothing of the film touched.
  await expectCode("conflict", () => newRun(), "a plain run on a delivered film", /is imported as a title: a delivered film is not cut again.*"extend a delivered film"/);
  assert.equal(whisperDuration(), 9, "the refusal came before any script ran");
  assert.equal((await fixtureData.listFilmRuns(staff())).length, 1, "the refused run has no row");

  // The extension: the whole film, the delivered pins kept (settings.extend is the explicit word).
  const ext = await newRun({ settings: { extend: true } });
  run = await settle(ext.id);
  assert.equal(run.stage, "watermark", run.error_text ?? "");
  const folder = (run.stage_detail as { folder: { existed: boolean; claimed: boolean; extending: string; imported: boolean } }).folder;
  assert.deepEqual([folder.existed, folder.claimed, folder.extending, folder.imported], [true, false, "cuts-0-9-DELIVERED.json", true]);
  await decideRun(staff(), run.id, { kind: "watermark", accept: true });
  run = await settle(run.id);
  assert.equal(run.stage, "review", run.error_text ?? "");
  assert.equal(whisperDuration(), 15, "index_cut.sh ran again: the proof's transcript did not cover the whole film");
  assert.equal((run.stage_detail as { index: { reindexed: boolean } }).index.reindexed, true);
  const { state, fixedStart } = await reviewStateOf({ run, dirs });
  assert.equal(fixedStart, 4, "the last delivered pin; the proof's final episode is re-planned");
  assert.deepEqual(state.boundaries.map((b) => [b.boundary_s, b.status]), [[9, "pre_accepted"]], "fresh options for the stretch past the pin only");
  assert.deepEqual(state.lengths.map((l) => l.length), [5, 6]);
  const view = await stageView(run);
  assert.deepEqual(view.review?.boundaries[0].lengths, { before: 5, after: 6 }, "measured from the pin at 4 s, not from 0");
  assert.ok(readdirSync(path.join(dirs.cut, "review", "vision")).some((n) => n === `${visionLabel(run)}.json`), "the extension's own pass file");
  // Measured from the pin, 9 → 9.2 makes episodes of 5.2 and 5.8 s (in band); measured from 0 it would read 9.2 s and be refused.
  await decideRun(staff(), run.id, { kind: "boundary", boundary_s: 9, action: "move", to_t: 9.2, reason: "the reaction belongs to the episode" });
  await decideRun(staff(), run.id, { kind: "apply_review" });
  run = await settle(run.id);
  assert.equal(run.stage, "film_meta", run.error_text ?? "");
  const plan = JSON.parse(readFileSync(path.join(dirs.cut, "cuts.json"), "utf8")) as { episodes: { n: number; start: number; end: number }[]; pin_from: string | null; pinned: number };
  assert.deepEqual(plan.episodes.map((e) => [e.start, e.end]), [[0, 4], [4, 9.2], [9.2, 15]]);
  assert.equal(plan.pin_from, "review/cuts-0-9-DELIVERED.json");
  assert.equal(plan.pinned, 1);
  const render = (run.stage_detail as { render: { rendered: number; kept: number; delivered: string } }).render;
  assert.equal(render.kept, 1, "ep01, unchanged from the proof, was kept");
  assert.equal(render.rendered, 2);
  assert.equal(render.delivered, "cuts-0-15-DELIVERED.json");
  assert.deepEqual(readdirSync(path.join(dirs.cut, "eps")).sort(), ["ep01.mp4", "ep02.mp4", "ep03.mp4"]);
  await decideRun(staff(), run.id, { kind: "film_meta", display_title_en: "A Proof, Extended", crazydramas_slug: null, spoiler_from_s: null, exclusions: [], live_poster: null });
  run = await settle(run.id);
  assert.equal(waitingOf(run)?.for, "import", run.error_text ?? "");
  await decideRun(staff(), run.id, { kind: "import_now" });
  run = await settle(run.id);
  assert.equal(run.stage, "done", run.error_text ?? "");
  assert.equal(run.title_id, titleId, "the same title, updated");
  const title = await fixtureData.getTitle(staff(), titleId);
  assert.equal(title.episodes.length, 3);
  assert.equal(title.title.name_en, "A Proof, Extended");

  // The film is delivered to its end: another extension has nothing to plan, and says so instead of "judged outside Studio".
  const again = await newRun({ settings: { extend: true } });
  let nothing = await settle(again.id);
  assert.equal(nothing.stage, "watermark", nothing.error_text ?? "");
  await decideRun(staff(), nothing.id, { kind: "watermark", accept: true });
  nothing = await settle(nothing.id);
  assert.equal(nothing.stage, "failed");
  assert.match(nothing.error_text ?? "", /is delivered to its end \(cuts-0-15-DELIVERED\.json ends at 15 s; this run plans to 15 s\): there is nothing to extend/);
  assert.equal((nothing.stage_detail as { failed_stage: string }).failed_stage, "plan");
});

test("a run cancelled at its review leaves a folder Studio judged: a new run on the same slug takes it over with fresh options under its own label", async () => {
  const first = await newRun();
  let a = await settle(first.id);
  await decideRun(staff(), a.id, { kind: "watermark", accept: true });
  a = await settle(a.id);
  assert.equal(a.stage, "review", a.error_text ?? "");
  const dirs = runDirs(a);
  const options = path.join(dirs.cut, "review", "options.json");
  assert.match(JSON.parse(readFileSync(options, "utf8")).applied.label, new RegExp(`^${visionLabel(a)}$`), "the fake apply_vision stamped the options with run A's label");
  await cancelRun(staff(), a.id);

  // Run B: the intake adopts Studio's own folder, the index is reused, and the plan re-emits the options A's cancelled review had applied.
  const second = await newRun();
  let b = await settle(second.id);
  assert.equal(b.stage, "watermark", b.error_text ?? "");
  await decideRun(staff(), b.id, { kind: "watermark", accept: true });
  b = await settle(b.id);
  assert.equal(b.stage, "review", b.error_text ?? "");
  const vision = readdirSync(path.join(dirs.cut, "review", "vision"));
  assert.ok(vision.includes(`${visionLabel(a)}.json`), "A's pass file stays under A's label");
  assert.ok(vision.includes(`${visionLabel(b)}.json`), "B judged the fresh options under its own label");
  assert.equal(JSON.parse(readFileSync(options, "utf8")).applied.label, visionLabel(b));
  const { state } = await reviewStateOf({ run: b, dirs });
  assert.deepEqual(state.boundaries.map((x) => x.boundary_s), [4, 9]);
  await decideRun(staff(), b.id, { kind: "boundary", boundary_s: 9, action: "accept" });
  await decideRun(staff(), b.id, { kind: "apply_review" });
  b = await settle(b.id);
  assert.equal(b.stage, "film_meta", b.error_text ?? "");
});

test("a film folder no Studio run made is refused at intake unless the run claims it in so many words, without a lock file ever touching it; the create route refuses it first", async () => {
  const foreign = path.join(runDirs({ id: "x", bucket: "low-quality", slug: "a-fixture-film" }).cut);
  // The folder appears after the row was made (a session started the film between create and the worker's tick).
  const plain = await newRun();
  mkdirSync(path.join(foreign, "index"), { recursive: true });
  writeFileSync(path.join(foreign, "index", "watermark.json"), JSON.stringify({ box: { x: 1, y: 2, w: 3, h: 4 } }));
  const refused = await settle(plain.id);
  assert.equal(refused.stage, "failed");
  assert.match(refused.error_text ?? "", /cut already exists and no Studio run made it \(no cut\/\.studio-scripts\.json\): a session's work/);
  assert.deepEqual(readdirSync(foreign), ["index"], "nothing was written into the session's folder: no lock file, no scripts");

  // With the folder there, the create route refuses the plain run before a row exists.
  await expectCode("conflict", () => newRun(), "a plain run on a session's folder", /no Studio run made it/);
  assert.equal((await fixtureData.listFilmRuns(staff())).length, 1);

  const claimed = await newRun({ settings: { claim_existing: true } });
  const run = await settle(claimed.id);
  assert.equal(run.stage, "watermark", run.error_text ?? "");
  assert.equal((run.stage_detail as { folder: { claimed: boolean } }).folder.claimed, true);
  assert.ok(existsSync(path.join(foreign, ".studio-scripts.json")), "the claim leaves Studio's record: a later run adopts the folder as its own");
  await cancelRun(staff(), run.id);
});

test("a run set back to plan resumes from its artifacts: options and the pass file are reused, not remade", async () => {
  const created = await newRun();
  let run = await settle(created.id);
  assert.equal(run.stage, "watermark", run.error_text ?? "");
  await decideRun(staff(), run.id, { kind: "watermark", accept: true });
  run = await settle(run.id);
  assert.equal(run.stage, "review", run.error_text ?? "");
  const dirs = runDirs(run);
  const optionsBefore = readFileSync(path.join(dirs.cut, "review", "options.json"), "utf8");
  const detail = { ...(run.stage_detail as Record<string, unknown>) };
  delete detail.waiting;
  run = await fixtureData.setFilmRunStage(staff(), run.id, { stage: "plan", stage_detail: detail as FilmRun["stage_detail"], revision: run.revision });
  run = await settle(run.id);
  assert.equal(run.stage, "review", run.error_text ?? "");
  assert.equal(readFileSync(path.join(dirs.cut, "review", "options.json"), "utf8"), optionsBefore, "the same options file");
  assert.equal(readdirSync(path.join(dirs.cut, "review", "vision")).filter((n) => n === `${visionLabel(run)}.json`).length, 1);
});

test("cancel stops a waiting run and removes the run lock; the cancelled run is never picked up again", async () => {
  const created = await newRun();
  let run = await settle(created.id);
  assert.equal(run.stage, "watermark");
  const dirs = runDirs(run);
  run = await cancelRun(staff(), run.id);
  assert.equal(run.stage, "cancelled");
  assert.equal((run.stage_detail as { cancelled_from: string }).cancelled_from, "watermark");
  assert.equal(existsSync(studioRunLockPath(dirs.cut)), false);
  const r = await runTick(opts());
  assert.deepEqual(r.started, []);
  await expectCode("conflict", () => cancelRun(staff(), run.id), "a second cancel");
  await expectCode("conflict", () => decideRun(staff(), run.id, { kind: "watermark", accept: true }), "a decision on a cancelled run");
});

test("cancel leaves the run lock to a worker whose lease is live: its scripts may still be writing, and its own finally removes the file", async () => {
  const created = await newRun();
  let run = await settle(created.id);
  assert.equal(run.stage, "watermark");
  const dirs = runDirs(run);
  assert.ok(existsSync(studioRunLockPath(dirs.cut)));
  // A worker mid-script holds a live lease; the route's cancel must not pull the lock from under its children.
  const leased = await fixtureData.claimFilmRun(systemSession(), run.id, { owner: "other-host:9", revision: run.revision });
  assert.ok(leased);
  run = await cancelRun(staff(), run.id);
  assert.equal(run.stage, "cancelled");
  assert.ok(existsSync(studioRunLockPath(dirs.cut)), "the lock stays while the lease is live");
});

test("Import now recorded while the film is not yet READY applies once the scanner reads READY, without a second press", async () => {
  let run = await toFilmMeta();
  const dirs = runDirs(run);
  // A render still writing: the scanner reads RENDERING, so the hand-off waits for READY and polls.
  writeFileSync(path.join(dirs.cut, "eps", "ep01.part.mp4"), "still encoding");
  await decideRun(staff(), run.id, { kind: "film_meta", display_title_en: "Early Press", crazydramas_slug: null, spoiler_from_s: null, exclusions: [], live_poster: null });
  run = await settle(run.id);
  assert.equal(run.stage, "handoff", run.error_text ?? "");
  assert.equal(waitingOf(run)?.for, "ready");
  await decideRun(staff(), run.id, { kind: "import_now" });
  // The next poll sees the wait again (the decision is marked seen), then the film turns READY: the early press is honoured.
  rmSync(path.join(dirs.cut, "eps", "ep01.part.mp4"));
  run = await settleUntil(run.id, (r) => r.stage !== "handoff" || waitingOf(r)?.for === "import");
  assert.equal(run.stage, "done", run.error_text ?? JSON.stringify(waitingOf(run)));
  assert.ok(run.title_id);
  assert.deepEqual(run.decisions.filter((d) => d.action === "import_now").length, 1, "one press was enough");
});

test("a landscape source is refused at intake with the reason; a second live run on the same film folder is refused at creation; retry sends a failed run back", async () => {
  const landscape = path.join(sources, "landscape_Media_abcdefghijk_001_1080p.mp4");
  copyFileSync(sourceFile, landscape);
  const created = await newRun({ source_path: landscape, slug: "wide-film" });
  const run = await settle(created.id);
  assert.equal(run.stage, "failed");
  assert.match(run.error_text ?? "", /landscape \(1280×720\)/);
  assert.match(run.error_text ?? "", /narrated route's reframe/);
  assert.equal((run.stage_detail as { failed_stage: string }).failed_stage, "intake");
  const job = await fixtureData.latestJobByTarget(systemSession(), "film_run", run.id, "segment_film");
  assert.equal(job?.status, "failed");

  const other = await newRun();
  await expectCode("conflict", () => newRun(), "one live run per film folder");
  await cancelRun(staff(), other.id);
  await newRun();

  const back = await decideRun(staff(), run.id, { kind: "retry" });
  assert.equal(back.stage, "intake");
  assert.equal(back.error_text, null);
  const again = await settle(run.id);
  assert.equal(again.stage, "failed", "the same source fails the same way");
});

test("executeRun on a run another worker leases is skipped; a lost claim is answered, never thrown", async () => {
  const created = await newRun();
  const claimed = await fixtureData.claimFilmRun(systemSession(), created.id, { owner: "other-host:9", revision: created.revision });
  assert.ok(claimed);
  const r = await runTick(opts());
  assert.deepEqual(r.skipped, [created.id]);
  const direct = await executeRun(created.id, opts());
  assert.equal(direct.skipped, "claim lost");
});

test("a run is stamped with this computer; another computer's run is never driven, decided on or cancelled here", async () => {
  const { thisComputer } = await import("@/lib/computer");
  const { elsewhereOf } = await import("@/lib/segment/view");
  const mine = await newRun();
  assert.deepEqual(mine.settings.computer, thisComputer(), "createRun names the computer it runs on");
  assert.equal(elsewhereOf(mine), null);
  await cancelRun(staff(), mine.id);

  const andrew = { id: "cmp_0123456789abcdef", name: "Andrew's Mac" };
  const theirs = await fixtureData.createFilmRun(staff(), { producer_id: FIXTURE_PRODUCER_ID, source_path: "/Users/andrew/Downloads/film.mp4", bucket: "low-quality", slug: "their-film", mode: "by_eye_2min", lang: "en", settings: { computer: andrew } });
  const r = await runTick(opts());
  assert.ok(r.skipped.includes(theirs.id) && !r.started.includes(theirs.id), "the worker leaves it alone");
  assert.equal((await get(theirs.id)).stage, "queued");
  assert.equal((await executeRun(theirs.id, opts())).skipped, "another computer's run");
  assert.deepEqual(elsewhereOf(theirs), andrew);
  await expectCode("conflict", () => decideRun(staff(), theirs.id, { kind: "retry" }), "a decision from here", /being cut on Andrew's Mac/);
  await expectCode("conflict", () => cancelRun(staff(), theirs.id), "a cancel from here", /being cut on Andrew's Mac/);
  await expectCode("invalid", () => fixtureData.createFilmRun(staff(), { producer_id: FIXTURE_PRODUCER_ID, source_path: "/x.mp4", bucket: "low-quality", slug: "bad-computer", mode: "by_eye_2min", lang: "en", settings: { computer: { id: "laptop", name: "x" } } }), "a malformed computer");
});

test("the source picker lists the file with its parsed name and refuses a folder outside the roots", async () => {
  const { listSources } = await import("@/lib/segment/intake");
  const listing = await listSources("extra1");
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.entries[0].suggested_slug, "a-fixture-film");
  assert.deepEqual(listing.entries[0].parsed, { video_id: "abcdefghijk", part: 1, height_p: 720 });
  await expectCode("invalid", () => listSources(path.join(root, "nowhere")), "outside the roots");
});

test("a reject sends one boundary back to the judge; the re-judged answer (a second pass file) is what the review then shows, and the person still closes it", async () => {
  const created = await newRun();
  let run = await settle(created.id);
  await decideRun(staff(), run.id, { kind: "watermark", no_delogo: true });
  run = await settle(run.id);
  assert.equal(run.stage, "review", run.error_text ?? "");
  assert.equal((run.stage_detail as { no_delogo: boolean }).no_delogo, true);
  await expectCode("invalid", () => decideRun(staff(), run.id, { kind: "boundary", boundary_s: 9, action: "reject" }), "a reject without a reason");
  await decideRun(staff(), run.id, { kind: "boundary", boundary_s: 9, action: "reject", reason: "the cut lands before the slap" });
  run = await settle(run.id);
  assert.equal(run.stage, "review", run.error_text ?? "");
  const dirs = runDirs(run);
  assert.ok(existsSync(path.join(dirs.cut, "review", "vision", `${visionLabel(run)}_r1.json`)), "the re-judge is its own record file");
  assert.deepEqual((run.stage_detail as { rejudges_done: Record<string, number> }).rejudges_done, { "9": 1 });
  const { state } = await reviewStateOf({ run, dirs });
  assert.equal(state.boundaries[1].confidence, 0.9, "the fake's second look is sure");
  assert.equal(state.boundaries[1].status, "needs_decision", "sure or not, the answer the person asked for is theirs to accept");
  assert.deepEqual(state.boundaries[1].reasons, ["rejudged"]);
  assert.equal(state.complete, false);
  await expectCode("conflict", () => decideRun(staff(), run.id, { kind: "apply_review" }), "apply before the re-judged boundary is accepted");
  await decideRun(staff(), run.id, { kind: "boundary", boundary_s: 9, action: "accept", reason: "the second look is right" });
  assert.equal((await reviewStateOf({ run: await get(run.id), dirs })).state.complete, true);
  await decideRun(staff(), run.id, { kind: "apply_review" });
  run = await settle(run.id);
  assert.equal(run.stage, "film_meta", run.error_text ?? "");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dirs.cut, "review", "choices.json"), "utf8")), { "4": 4, "9": 9 });
});

test("the hand-off: the run shows the exact Workflow call and waits; the pasted .output file becomes the run's pass", async () => {
  const created = await newRun({ settings: { vision: "handoff", film_notes: "a 1.7 s card at every break" } });
  let run = await settle(created.id);
  await decideRun(staff(), run.id, { kind: "watermark", accept: true });
  run = await settle(run.id);
  assert.equal(run.stage, "vision", run.error_text ?? "");
  assert.equal(waitingOf(run)?.for, "vision");
  const handoff = (run.stage_detail as { handoff: { command: string; boundaries: number[] } }).handoff;
  assert.deepEqual(handoff.boundaries, [4, 9]);
  assert.match(handoff.command, /^Workflow\(\{ scriptPath: ".*pick_by_eye\.workflow\.js", args: \{ base: ".*\/cut", boundaries: \[4,9\], film_notes: "a 1\.7 s card at every break" \} \}\)$/);
  await expectCode("invalid", () => decideRun(staff(), run.id, { kind: "handoff_vision", output_path: path.join(root, "missing.output") }), "a file that is not there");
  const output = path.join(root, "task.output");
  const record = (b: number, t: number, conf: number) => ({ boundary_s: b, pick: { chosen_key: "opt2", chosen_t: t, ends_on: "x", opens_on: "y", why: "seen", payoff_in_episode: true, confidence: conf }, verdict: { agree: true, fault: "", better_key: "", reason: "holds" } });
  writeFileSync(output, JSON.stringify({ summary: "by eye", logs: [], result: [record(4, 4, 0.9), record(9, 9, 0.7)], totalTokens: 1 }));
  await decideRun(staff(), run.id, { kind: "handoff_vision", output_path: output });
  run = await settle(run.id);
  assert.equal(run.stage, "review", run.error_text ?? "");
  const dirs = runDirs(run);
  const pass = JSON.parse(readFileSync(path.join(dirs.cut, "review", "vision", `${visionLabel(run)}.json`), "utf8")) as { source: string; result: unknown[] };
  assert.equal(pass.source, "claude-code-handoff");
  assert.equal(pass.result.length, 2);
  const { state } = await reviewStateOf({ run, dirs });
  assert.equal(state.complete, true, "both boundaries came back sure: nothing to decide");
});
