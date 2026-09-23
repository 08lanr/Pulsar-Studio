// The workspace scanner (lib/film-import/scan): the READY rules of spec §3.3
// on a temp workspace built per test, the checked-in fixture workspace, the
// junction dedupe, the quiet-period clock, the probe that only ever sees a
// hardlink, the cloud-placeholder guard, and the states the caller adds from
// what it stored. The last test walks the real workspace when it is on this
// machine: it reads names, sizes and JSON there, never an episode's bytes.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseDeliveredPlan } from "@/lib/film-import/manifest";
import { DEFAULT_QUIET_MS, EMPTY_ARTIFACTS, applyImportState, choicesConsumed, listProjects, nodeScanFs, optionsApplied, pipelineStage, pipelineStageOf, planMatchesDelivered, scanFilm, scanWorkspace, titleFromFolder, type StageFacts } from "@/lib/film-import/scan";
import type { FilmScan, PipelineArtifacts, PipelineStage, ScanFs } from "@/lib/film-import/types";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "workspace");
const REAL_ROOT = process.env.WORKSPACE_ROOT?.trim() || path.resolve(process.cwd(), "..", "Pulsar-Workspace", "mini-drama-system", "projects");

// ---- a temp workspace ------------------------------------------------------------------------------

const EP_BYTES = 8192; // above the placeholder floor, so a real file reports allocated blocks
const T0 = Date.UTC(2026, 8, 23, 12, 0, 0); // every fixture file is written "at noon"; tests move the clock

type FilmSpec = {
  /** File names in cut/eps (absent: no eps folder). */
  eps?: string[];
  /** Episode count of the plan(s) to write; a name → count map writes several. */
  plan?: number | Record<string, number> | null;
  source?: boolean;
  meta?: unknown;
  /** Extra text files, relative to the film folder. */
  files?: Record<string, string>;
};

function plan(count: number, end?: number): string {
  const step = (end ?? count * 100) / count;
  const episodes = Array.from({ length: count }, (_, i) => ({ n: i + 1, start: i * step, end: (i + 1) * step, dur: step, ends_after_line: "x", next_opens_on: "y" }));
  return JSON.stringify({ source_duration: end ?? count * 100, target: 100, fps: 30, band: [95, 150], pinned: 0, pin_from: null, moves: [], final_end_is_boundary: false, episodes });
}

function addFilm(root: string, ref: string, spec: FilmSpec) {
  const film = path.join(root, ...ref.split("/"));
  const cut = path.join(film, "cut");
  mkdirSync(cut, { recursive: true });
  if (spec.eps) {
    mkdirSync(path.join(cut, "eps"), { recursive: true });
    for (const name of spec.eps) {
      const p = path.join(cut, "eps", name);
      writeFileSync(p, Buffer.alloc(EP_BYTES, 1));
      utimesSync(p, new Date(T0), new Date(T0));
    }
  }
  if (spec.plan !== null && spec.plan !== undefined) {
    mkdirSync(path.join(cut, "review"), { recursive: true });
    const plans = typeof spec.plan === "number" ? { [`cuts-0-${spec.plan * 100}-DELIVERED.json`]: spec.plan } : spec.plan;
    for (const [name, count] of Object.entries(plans)) writeFileSync(path.join(cut, "review", name), plan(count, Number(name.match(/cuts-0-([\d.]+)-/)?.[1]) || undefined));
  }
  if (spec.source !== false) {
    mkdirSync(path.join(cut, "index"), { recursive: true });
    writeFileSync(path.join(cut, "index", "source.json"), JSON.stringify({ source: "../source/original.mp4", fps: 30, width: 720, height: 1280, duration: 300 }));
  }
  if (spec.meta !== undefined) writeFileSync(path.join(cut, "film-meta.json"), typeof spec.meta === "string" ? spec.meta : JSON.stringify(spec.meta));
  for (const [rel, text] of Object.entries(spec.files ?? {})) {
    mkdirSync(path.dirname(path.join(film, rel)), { recursive: true });
    writeFileSync(path.join(film, rel), text);
  }
  return film;
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(os.tmpdir(), "film-scan-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The clock ten minutes after the fixture files were written: outside the quiet period. */
const later = () => T0 + 10 * 60 * 1000;

// ---- the checked-in fixture --------------------------------------------------------------------------

test("the fixture workspace: one film ready, one rendering, one not delivered", async () => {
  const films = await scanWorkspace({ root: FIXTURE_ROOT, quietMs: 0 });
  assert.deepEqual(films.map((f) => f.source_ref), ["low-quality/fixture-film", "low-quality/rendering-film", "low-quality/undelivered-film"]);

  const [ready, rendering, undelivered] = films;
  assert.equal(ready.state, "READY");
  assert.equal(ready.reason, null);
  assert.equal(ready.display_title, "Fixture Film");
  assert.equal(ready.language, "en");
  assert.deepEqual(ready.episodes.map((e) => [e.n, e.file]), [
    [1, "low-quality/fixture-film/cut/eps/ep01.mp4"],
    [2, "low-quality/fixture-film/cut/eps/ep02.mp4"],
    [3, "low-quality/fixture-film/cut/eps/ep03.mp4"],
  ]);
  assert.ok(ready.episodes.every((e) => e.bytes > 10_000 && e.bytes < 150_000), "each fixture episode is a real, small mp4");
  assert.equal(ready.totals.count, 3);
  assert.equal(ready.totals.bytes, ready.episodes.reduce((s, e) => s + e.bytes, 0));
  assert.equal(ready.delivered?.file, "review/cuts-0-15-DELIVERED.json", "the stale cuts-0-9 plan sorts after it as text and loses");
  assert.equal(ready.delivered?.end, 15);
  assert.equal(ready.delivered?.count, 3);
  assert.match(ready.delivered?.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(ready.video, { width: 720, height: 1280, fps: 30, duration_s: 15, from: "source.json" });
  assert.equal(ready.poster, "low-quality/fixture-film/poster/final/fixture-film-a.jpg");
  assert.equal(ready.meta?.crazydramas_slug, "fixture-film");
  assert.deepEqual(ready.ignored, []);
  assert.deepEqual(ready.warnings, []);

  assert.equal(rendering.state, "RENDERING");
  assert.deepEqual(rendering.reason, { code: "part_file", file: "ep02.part.mp4" });
  assert.deepEqual(rendering.episodes.map((e) => e.n), [1], "the part file is not an episode");
  assert.equal(rendering.display_title, "Rendering Film", "no film-meta: the folder name, titled");
  assert.equal(rendering.delivered?.count, 2);

  assert.equal(undelivered.state, "NOT_DELIVERED");
  assert.deepEqual(undelivered.reason, { code: "no_delivered" });
  assert.equal(undelivered.totals.count, 2, "the files are still listed");
  assert.equal(undelivered.delivered, null);

  // The pipeline stage read from the artifacts (plan B1), beside the import state.
  assert.deepEqual([ready.pipeline_stage, ready.pipeline_note], ["DELIVERED", null]);
  assert.deepEqual(ready.pipeline, { ...EMPTY_ARTIFACTS, source_facts: true, whisper: true, scdet: true, motion: true, candidates: true, plan: true, delivered: true });
  assert.deepEqual([rendering.pipeline_stage, rendering.pipeline_note], ["RENDERING", "eps/ep02.part.mp4 is being written"]);
  assert.equal(rendering.pipeline.parts, true);
  assert.deepEqual([undelivered.pipeline_stage, undelivered.pipeline_note], ["NOT_INDEXED", "no source/*.mp4; an index was started"], "index/source.json alone: the index was started, no candidates yet");
});

// ---- the pipeline stage (plan B1: read from the artifacts, so a restarted worker resumes from the last finished one) ----

test("the pipeline stage walks the artifacts newest step first, without touching the READY rules", () =>
  withRoot(async (root) => {
    const cut = path.join(root, "film", "cut");
    const stage = async (): Promise<[PipelineStage, string | null, FilmScan["state"]]> => {
      const s = await scanFilm("film", { root, now: later });
      const p = await pipelineStage("film", { root, now: later });
      assert.equal(p.stage, s.pipeline_stage);
      return [s.pipeline_stage, s.pipeline_note, s.state];
    };
    const write = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, "film", rel)), { recursive: true });
      writeFileSync(path.join(root, "film", rel), text);
    };
    const ep = (name: string, at = T0) => {
      mkdirSync(path.join(cut, "eps"), { recursive: true });
      const p = path.join(cut, "eps", name);
      writeFileSync(p, Buffer.alloc(EP_BYTES, 1));
      utimesSync(p, new Date(at), new Date(at));
    };

    mkdirSync(cut, { recursive: true });
    assert.deepEqual(await stage(), ["NO_SOURCE", "no source/*.mp4", "NOT_DELIVERED"], "an empty cut/ folder");
    write("source/original.mp4", "x");
    assert.deepEqual(await stage(), ["NOT_INDEXED", "index/candidates.json is missing", "NOT_DELIVERED"]);
    write("cut/index/source.json", JSON.stringify({ source: "../source/original.mp4", fps: 30, width: 720, height: 1280, duration: 300 }));
    write("cut/index/whisper.json", "{}");
    assert.equal((await stage())[0], "NOT_INDEXED", "whisper done, candidates not yet");
    write("cut/index/candidates.json", "{}");
    assert.deepEqual(await stage(), ["INDEXED", null, "NOT_DELIVERED"]);
    write("cut/review/options.json", JSON.stringify({ boundaries: [] }));
    assert.deepEqual(await stage(), ["OPTIONS_READY", "review/options.json is not applied: a vision pass is due", "NOT_DELIVERED"]);
    write("cut/review/options.json", JSON.stringify({ boundaries: [], applied: { label: "0-end", on: "2026-09-23" } }));
    assert.deepEqual(await stage(), ["OPTIONS_READY", "review/options.json is applied but no choices.json followed", "NOT_DELIVERED"]);
    write("cut/review/choices.json", JSON.stringify({ "100": 100, "200": 200 }));
    assert.deepEqual(await stage(), ["JUDGED", "review/choices.json waits for pick_cuts.py --choices", "NOT_DELIVERED"]);
    write("cut/cuts.json", plan(3));
    assert.deepEqual(await stage(), ["PLANNED", "cut/cuts.json has no DELIVERED render yet", "NOT_DELIVERED"], "the plan carries both choices (100 and 200 are episode ends)");
    write("cut/review/choices.json", JSON.stringify({ "100": 100, "150": 150 }));
    assert.deepEqual(await stage(), ["JUDGED", "review/choices.json is not in cut/cuts.json yet", "NOT_DELIVERED"], "a choice the plan does not carry: pick_cuts.py --choices has not run on it");
    write("cut/review/choices.json", JSON.stringify({ "100": 100, "200": 200 }));

    // The render.
    ep("ep01.mp4");
    ep("ep02.part.mp4");
    assert.deepEqual(await stage(), ["RENDERING", "eps/ep02.part.mp4 is being written", "NOT_DELIVERED"]);
    rmSync(path.join(cut, "eps", "ep02.part.mp4"));
    ep("ep02.mp4");
    ep("ep03.mp4");
    write("cut/review/cuts-0-300-DELIVERED.json", plan(3));
    assert.deepEqual(await stage(), ["DELIVERED", null, "READY"]);
    ep("ep03.mp4", later() - 1000);
    const fresh = await scanFilm("film", { root, now: later });
    assert.deepEqual([fresh.pipeline_stage, fresh.pipeline_note, fresh.state], ["RENDERING", "eps/ep03.mp4 was written inside the quiet period", "RENDERING"], "a write inside the quiet period is a render still going, for the stage and for READY alike");
    ep("ep03.mp4");
    rmSync(path.join(cut, "eps", "ep03.mp4"));
    assert.deepEqual(await stage(), ["PLANNED", "the DELIVERED plan's episode files are not complete: render again", "NOT_DELIVERED"]);
    ep("ep03.mp4");

    // A QA re-pin: cuts.json moves on from the delivery, and declares the move.
    const moved = JSON.parse(plan(3)) as { episodes: { end: number; start: number }[]; moves: { from: number; to: number }[] };
    moved.episodes[0].end = 101;
    moved.episodes[1].start = 101;
    moved.moves = [{ from: 100, to: 101 }];
    write("cut/cuts.json", JSON.stringify(moved));
    assert.deepEqual(await stage(), ["PLANNED", "cut/cuts.json differs from the newest DELIVERED plan", "READY"], "READY is the import's answer about the delivered files; the stage says a re-render is due");
    write("cut/review/cuts-0-300-DELIVERED.json", JSON.stringify(moved));
    assert.deepEqual(await stage(), ["DELIVERED", null, "READY"], "the choice at 100 is consumed through the declared move");

    // A broken small file is a warning, never a crash; the stage falls back to what the other artifacts say.
    write("cut/review/choices.json", "{ not json");
    const broken = await scanFilm("film", { root, now: later });
    assert.ok(broken.warnings.some((w) => w.startsWith("review/choices.json:")), broken.warnings.join("; "));
    assert.equal(broken.pipeline_stage, "DELIVERED");
    assert.equal(broken.pipeline.choices, true, "the file is there, it just does not parse");
  }));

test("the pure stage rules: optionsApplied, choicesConsumed, planMatchesDelivered, pipelineStageOf", () => {
  assert.equal(optionsApplied('{"boundaries": [], "applied": {"label": "0-end"}}'), true);
  assert.equal(optionsApplied('{"boundaries": [{"applied_note": "x"}]}'), false, "only the stamp object counts");

  const base = parseDeliveredPlan(JSON.parse(plan(3)));
  assert.equal(choicesConsumed({ "100": 100, "200": 200 }, base), true);
  assert.equal(choicesConsumed({ "100": 100.001, "300": 300 }, base), true, "the film's end and a 1 ms rounding");
  assert.equal(choicesConsumed({ "150": 150 }, base), false);
  assert.equal(choicesConsumed({ "100": 100 }, null), false, "no plan: nothing consumed");
  const withMove = { ...base, moves: [{ from: 150, to: 152 }] };
  assert.equal(choicesConsumed({ "150": 150 }, withMove), true, "a choice the plan moved on from is consumed through the move");

  assert.equal(planMatchesDelivered(base, parseDeliveredPlan(JSON.parse(plan(3)))), true);
  assert.equal(planMatchesDelivered(base, parseDeliveredPlan(JSON.parse(plan(2)))), false, "a different count");
  const nudged = { ...base, episodes: base.episodes.map((e, i) => (i === 0 ? { ...e, end: e.end + 0.001 } : e)) };
  assert.equal(planMatchesDelivered(nudged, base), true, "a millisecond of float formatting is the same plan");
  const other = { ...base, episodes: base.episodes.map((e, i) => (i === 0 ? { ...e, end: e.end + 0.5 } : e)) };
  assert.equal(planMatchesDelivered(other, base), false);
  assert.equal(planMatchesDelivered({ ...base, skips: [[10, 12]] }, base), false, "a skip is part of the plan");

  const facts = ({ artifacts, ...over }: Partial<Omit<StageFacts, "artifacts">> & { artifacts?: Partial<PipelineArtifacts> }) =>
    pipelineStageOf({ plan: null, delivered: null, choices: null, part: null, recentWrite: null, ready: false, ...over, artifacts: { ...EMPTY_ARTIFACTS, ...artifacts } });
  assert.equal(facts({}).stage, "NO_SOURCE");
  assert.equal(facts({ artifacts: { watermark: true } }).stage, "NOT_INDEXED", "a watermark box means the film was started");
  assert.equal(facts({ artifacts: { source: true, candidates: true } }).stage, "INDEXED");
  assert.equal(facts({ artifacts: { candidates: true, options: true } }).stage, "OPTIONS_READY");
  assert.equal(facts({ artifacts: { options: true }, part: "ep01.part.mp4" }).stage, "RENDERING", "a .part file outranks everything: something is writing");
  assert.equal(facts({ artifacts: { options: true, options_applied: true, delivered: true }, delivered: base, ready: true }).stage, "DELIVERED", "an applied options file behind a complete delivery is history");
  assert.equal(facts({ artifacts: { options: true, delivered: true }, delivered: base, ready: true }).stage, "OPTIONS_READY", "an UNAPPLIED options file in front of a delivery is a new pass waiting (a re-cut)");
  assert.equal(facts({ delivered: base, ready: true, recentWrite: "ep02.mp4" }).stage, "RENDERING");
  assert.equal(facts({ delivered: base, ready: false }).stage, "PLANNED");
  assert.equal(facts({ plan: base, choices: { "150": 150 } }).stage, "JUDGED");
});

// ---- the READY rules ----------------------------------------------------------------------------------

test("a .part file means a render is running", () =>
  withRoot(async (root) => {
    addFilm(root, "low-quality/film", { eps: ["ep01.mp4", "ep02.mp4", "ep03.part.mp4"], plan: 3 });
    const s = await scanFilm("low-quality/film", { root, now: later });
    assert.equal(s.state, "RENDERING");
    assert.deepEqual(s.reason, { code: "part_file", file: "ep03.part.mp4" });
    assert.deepEqual(s.episodes.map((e) => e.n), [1, 2]);
  }));

test("gaps, duplicates and a count that differs from the plan", () =>
  withRoot(async (root) => {
    addFilm(root, "gap", { eps: ["ep01.mp4", "ep03.mp4"], plan: 3 });
    addFilm(root, "short", { eps: ["ep01.mp4", "ep02.mp4"], plan: 3 });
    addFilm(root, "long", { eps: ["ep01.mp4", "ep02.mp4", "ep03.mp4"], plan: 2 });
    addFilm(root, "dupe", { eps: ["ep01.mp4", "ep1.mp4", "ep02.mp4"], plan: 2 });
    addFilm(root, "exact", { eps: ["ep01.mp4", "ep02.mp4", "ep03.mp4"], plan: 3 });
    const by = Object.fromEntries((await scanWorkspace({ root, now: later })).map((f) => [f.source_ref, f]));
    assert.deepEqual([by.gap.state, by.gap.reason], ["NOT_DELIVERED", { code: "episode_gap", missing: [2], duplicates: [] }]);
    assert.deepEqual([by.short.state, by.short.reason], ["NOT_DELIVERED", { code: "count_mismatch", planned: 3, found: 2 }]);
    assert.deepEqual([by.long.state, by.long.reason], ["NOT_DELIVERED", { code: "count_mismatch", planned: 2, found: 3 }]);
    assert.deepEqual([by.dupe.state, by.dupe.reason], ["NOT_DELIVERED", { code: "episode_gap", missing: [], duplicates: [1] }]);
    assert.equal(by.exact.state, "READY");
  }));

test("the newest plan is the largest numeric end; superseded copies and other review files do not count", () =>
  withRoot(async (root) => {
    addFilm(root, "film", {
      eps: Array.from({ length: 52 }, (_, i) => `ep${String(i + 1).padStart(2, "0")}.mp4`),
      plan: { "cuts-0-900-verified.json": 8, "cuts-0-1800-DELIVERED.json": 16, "cuts-0-1936.533-DELIVERED.json": 17, "cuts-0-5959.067-DELIVERED.json": 52 },
      files: { "cut/review/superseded/cuts-0-9999-DELIVERED.20260922-000000.json": plan(60), "cut/eps.zip": "zip", "cut/review/options.json": "{}" },
    });
    const s = await scanFilm("film", { root, now: later });
    assert.equal(s.state, "READY");
    assert.equal(s.delivered?.file, "review/cuts-0-5959.067-DELIVERED.json");
    assert.equal(s.delivered?.end, 5959.067);
    assert.equal(s.delivered?.count, 52);
  }));

test("no eps folder, a plan that does not parse, a stray file in eps/", () =>
  withRoot(async (root) => {
    addFilm(root, "empty", { plan: 2 });
    addFilm(root, "broken", { eps: ["ep01.mp4"], plan: null, files: { "cut/review/cuts-0-100-DELIVERED.json": "{ nope" } });
    addFilm(root, "stray", { eps: ["ep01.mp4", "ep02.mp4", "notes.txt", "EP03.MP4"], plan: 2 });
    const by = Object.fromEntries((await scanWorkspace({ root, now: later })).map((f) => [f.source_ref, f]));
    assert.deepEqual([by.empty.state, by.empty.reason], ["NOT_DELIVERED", { code: "no_episode_files" }]);
    assert.equal(by.broken.state, "NO_MANIFEST");
    assert.equal(by.broken.reason?.code, "bad_delivered");
    assert.equal((by.broken.reason as { file: string }).file, "review/cuts-0-100-DELIVERED.json");
    assert.equal(by.stray.state, "READY");
    assert.deepEqual(by.stray.ignored, ["EP03.MP4", "notes.txt"], "only the pipeline's exact epNN.mp4 counts; the rest is reported, not guessed");
  }));

test("a write in eps/ inside the quiet period holds the film back", () =>
  withRoot(async (root) => {
    addFilm(root, "film", { eps: ["ep01.mp4", "ep02.mp4"], plan: 2 });
    const t2 = T0 + 30_000; // ep02 was written half a minute after ep01: it is the newest write
    utimesSync(path.join(root, "film", "cut", "eps", "ep02.mp4"), new Date(t2), new Date(t2));
    const fresh = await scanFilm("film", { root, now: () => t2 + 60_000 });
    assert.equal(fresh.state, "RENDERING");
    assert.deepEqual(fresh.reason, { code: "recent_write", file: "ep02.mp4", seconds_ago: 60 });
    assert.equal((await scanFilm("film", { root, now: () => t2 + DEFAULT_QUIET_MS - 1 })).state, "RENDERING");
    assert.equal((await scanFilm("film", { root, now: () => t2 + DEFAULT_QUIET_MS })).state, "READY");
    assert.equal((await scanFilm("film", { root, now: () => t2, quietMs: 0 })).state, "READY", "quietMs 0 switches the rule off for a test that just wrote its files");
  }));

// ---- projects, buckets, junctions -------------------------------------------------------------------------

test("a narrated project has no cut/: reported as NO_MANIFEST, never skipped or crashed on", () =>
  withRoot(async (root) => {
    mkdirSync(path.join(root, "love-between-lines", "source"), { recursive: true });
    mkdirSync(path.join(root, "love-between-lines", "ep1"), { recursive: true });
    writeFileSync(path.join(root, "love-between-lines", "SCRIPT-S01E01.md"), "# script");
    mkdirSync(path.join(root, "high-quality"), { recursive: true }); // an empty bucket
    mkdirSync(path.join(root, ".hidden", "cut"), { recursive: true });
    mkdirSync(path.join(root, "loose-folder"), { recursive: true }); // neither a project nor a bucket with projects
    addFilm(root, "low-quality/film", { eps: ["ep01.mp4"], plan: 1 });
    const films = await scanWorkspace({ root, now: later });
    assert.deepEqual(
      films.map((f) => [f.source_ref, f.state, f.reason?.code ?? null]),
      [
        ["love-between-lines", "NO_MANIFEST", "no_cut_dir"],
        ["low-quality/film", "READY", null],
      ]
    );
    assert.equal(films[0].display_title, "Love Between Lines");
    assert.deepEqual(await scanWorkspace({ root: path.join(root, "does-not-exist") }), []);
  }));

test("a junction to a film is the same film once, under its real path", () =>
  withRoot(async (root) => {
    const film = addFilm(root, "low-quality/film-a", { eps: ["ep01.mp4"], plan: 1 });
    symlinkSync(film, path.join(root, "alias"), "junction");
    symlinkSync(film, path.join(root, "low-quality", "film-b"), "junction");
    const projects = await listProjects({ root });
    assert.deepEqual(projects.map((p) => p.source_ref), ["low-quality/film-a"]);
    const films = await scanWorkspace({ root, now: later });
    assert.equal(films.length, 1);
    assert.equal(films[0].source_ref, "low-quality/film-a");
    assert.equal(films[0].state, "READY");
  }));

// ---- the probe and the placeholder guard ----------------------------------------------------------------

test("without index/source.json the pixel size comes from a probe of ONE hardlinked sample, never the workspace path", () =>
  withRoot(async (root) => {
    addFilm(root, "film", { eps: ["ep01.mp4", "ep02.mp4"], plan: 2, source: false });
    const linkDir = path.join(root, "..", `film-scan-links-${path.basename(root)}`);
    const seen: string[] = [];
    try {
      const s = await scanFilm("film", {
        root,
        now: later,
        linkDir,
        probe: async (p) => {
          seen.push(p);
          assert.ok(require("node:fs").existsSync(p), "the link exists while the probe runs");
          return { width: 1080, height: 1920, fps: 30, duration_s: 120.5 };
        },
      });
      assert.equal(seen.length, 1, "one sample");
      assert.ok(seen[0].startsWith(path.resolve(linkDir)), `the probe saw ${seen[0]}, inside the link dir`);
      assert.ok(!seen[0].startsWith(path.resolve(root)), "never the workspace path");
      assert.ok(!require("node:fs").existsSync(seen[0]), "the link is removed afterwards");
      assert.deepEqual(s.video, { width: 1080, height: 1920, fps: 30, duration_s: 120.5, from: "probe" });
      assert.equal(s.state, "READY");

      const noProbe = await scanFilm("film", { root, now: later });
      assert.equal(noProbe.video, null);
      assert.deepEqual(noProbe.warnings, []);

      const failing = await scanFilm("film", { root, now: later, linkDir, probe: async () => { throw new Error("ffprobe exploded"); } });
      assert.equal(failing.video, null);
      assert.match(failing.warnings[0], /ffprobe exploded/);
      assert.equal(failing.state, "READY", "a failed probe is a warning, not a state");
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  }));

test("a cloud placeholder (bytes not on disk) is not an episode file", () =>
  withRoot(async (root) => {
    addFilm(root, "film", { eps: ["ep01.mp4", "ep02.mp4"], plan: 2 });
    const fake: ScanFs = {
      ...nodeScanFs,
      async stat(p) {
        const s = await nodeScanFs.stat(p);
        return s && path.basename(p) === "ep02.mp4" ? { ...s, blocks: 0 } : s;
      },
    };
    const s = await scanFilm("film", { root, now: later, fs: fake });
    assert.equal(s.state, "NOT_DELIVERED");
    assert.deepEqual(s.reason, { code: "placeholder", file: "ep02.mp4" });
    assert.equal((await scanFilm("film", { root, now: later })).state, "READY", "the real stat reports allocated blocks");
  }));

// ---- film-meta, titles, the caller's states ---------------------------------------------------------------

test("an invalid film-meta.json is a warning; the film still scans under its folder title", () =>
  withRoot(async (root) => {
    addFilm(root, "low-quality/he-hated-all-women", { eps: ["ep01.mp4"], plan: 1, meta: { language: "en" } });
    addFilm(root, "low-quality/mafia-king", { eps: ["ep01.mp4"], plan: 1, meta: { display_title_en: "Forced to Marry the Mafia Boss", language: "en", live_poster: "forced-to-marry-c" }, files: { "poster/final/forced-to-marry-a.jpg": "a", "poster/final/forced-to-marry-c.jpg": "c", "poster/final/sheet.txt": "x" } });
    const by = Object.fromEntries((await scanWorkspace({ root, now: later })).map((f) => [f.folder, f]));
    assert.equal(by["he-hated-all-women"].state, "READY");
    assert.equal(by["he-hated-all-women"].display_title, "He Hated All Women");
    assert.equal(by["he-hated-all-women"].meta, null);
    assert.match(by["he-hated-all-women"].warnings[0], /film-meta\.json/);
    assert.equal(by["mafia-king"].display_title, "Forced to Marry the Mafia Boss");
    assert.equal(by["mafia-king"].poster, "low-quality/mafia-king/poster/final/forced-to-marry-c.jpg", "the live poster named by film-meta");
    assert.deepEqual(by["mafia-king"].posters, ["low-quality/mafia-king/poster/final/forced-to-marry-a.jpg", "low-quality/mafia-king/poster/final/forced-to-marry-c.jpg"]);
  }));

test("titleFromFolder", () => {
  assert.equal(titleFromFolder("mafia-king"), "Mafia King");
  assert.equal(titleFromFolder("she-returned-with-her-son"), "She Returned With Her Son");
  assert.equal(titleFromFolder("lbl_e02"), "Lbl E02");
});

test("IMPORTED and K_CHANGED come from what the caller stored", () =>
  withRoot(async (root) => {
    addFilm(root, "film", { eps: ["ep01.mp4", "ep02.mp4"], plan: 2 });
    const ready = await scanFilm("film", { root, now: later });
    const sha = ready.delivered!.sha256;
    assert.equal(applyImportState(ready, null).state, "READY");
    const same = applyImportState(ready, { delivered_sha256: sha, episodes: ready.episodes.map((e) => ({ n: e.n, bytes: e.bytes })) });
    assert.deepEqual([same.state, same.reason], ["IMPORTED", { code: "imported" }]);
    const moved = applyImportState(ready, { delivered_sha256: "0".repeat(64) });
    assert.deepEqual([moved.state, moved.reason], ["K_CHANGED", { code: "plan_changed" }]);
    const rerendered = applyImportState(ready, { delivered_sha256: sha, episodes: [{ n: 1, bytes: ready.episodes[0].bytes }, { n: 2, bytes: 1 }] });
    assert.deepEqual([rerendered.state, rerendered.reason], ["K_CHANGED", { code: "files_changed", episodes: [2] }]);
    const notReady: FilmScan = { ...ready, state: "RENDERING", reason: { code: "part_file", file: "ep03.part.mp4" } };
    assert.equal(applyImportState(notReady, { delivered_sha256: sha }).state, "RENDERING", "only a READY film can be imported or updated");
  }));

// ---- the real workspace (skipped when absent) --------------------------------------------------------------

test("the real workspace scans without a crash and names every folder", async (t) => {
  if (!require("node:fs").existsSync(path.join(REAL_ROOT, "low-quality"))) return t.skip(`no workspace at ${REAL_ROOT}; set WORKSPACE_ROOT to run this`);
  const films = await scanWorkspace({ root: REAL_ROOT });
  const refs = films.map((f) => f.source_ref);
  assert.equal(new Set(refs).size, refs.length, "no folder twice");
  const by = Object.fromEntries(films.map((f) => [f.source_ref, f]));
  // 52 / 64 / 53 episodes on 2026-09-23; a QA re-cut may move a boundary, so the counts are bounds.
  for (const [ref, atLeast] of [["low-quality/mafia-king", 50], ["low-quality/he-hated-all-women", 60], ["low-quality/reclaiming-her-world", 50]] as const) {
    const f = by[ref];
    assert.ok(f, `${ref} is listed`);
    assert.ok((f.delivered?.count ?? 0) >= atLeast, `${ref}: the newest plan has ${f.delivered?.count} episodes`);
    assert.ok(["READY", "RENDERING", "NOT_DELIVERED"].includes(f.state), `${ref}: ${f.state} ${JSON.stringify(f.reason)}`);
    assert.equal(f.language, "en");
    assert.equal(f.video?.from, "source.json");
    assert.ok(f.poster?.endsWith(".jpg"));
    assert.ok(f.episodes.every((e) => e.file.startsWith(`${ref}/cut/eps/ep`) && e.bytes > 1_000_000));
    if (f.state === "READY") assert.equal(f.totals.count, f.delivered?.count);
  }
  for (const ref of ["low-quality/the-cold-ceo", "low-quality/she-returned-with-her-son"]) {
    if (by[ref]) assert.ok(["NOT_DELIVERED", "RENDERING", "READY"].includes(by[ref].state), `${ref}: ${by[ref].state}`);
  }
  // The narrated (skip-through) projects: not delivered through Studio, so the reason names the narrated manifest they lack.
  for (const ref of ["love-between-lines", "lbl-e02", "lbl-e03", "lbl-e04"]) if (by[ref]) assert.deepEqual([by[ref].state, by[ref].reason], ["NO_MANIFEST", { code: "no_narrated_manifest", file: "DELIVERED-narrated.json" }], ref);
});
