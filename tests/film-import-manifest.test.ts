// The pipeline's files, parsed (lib/film-import/manifest): the delivered
// plan and the newest-by-numeric-end rule, the index files, the vision
// records (split files merged, superseded ones skipped), the band-fix notes
// and how each delivered boundary is explained, film-meta.json, and
// loadFilmIndex over the checked-in fixture film. The tests at the end read
// the three real films under WORKSPACE_ROOT (or ../Pulsar-Workspace) and
// skip with a note when they are not on this machine; they only ever read
// JSON and text there, never cut/eps.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DELIVERED_FILE,
  explainBoundaries,
  loadFilmIndex,
  mergeVisionRecords,
  parseBandFixNotes,
  parseCandidates,
  parseDeliveredPlan,
  parseFilmMeta,
  parseMotion,
  parseScdet,
  parseSourceFacts,
  parseWhisper,
  pickNewestDelivered,
} from "@/lib/film-import/manifest";
import { nodeScanFs } from "@/lib/film-import/scan";
import { playedPieces, skippedWithin } from "@/lib/film-import/manifest";
import type { DeliveredPlan, VisionBoundary } from "@/lib/film-import/types";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "workspace");
const FIXTURE_CUT = path.join(FIXTURE_ROOT, "low-quality", "fixture-film", "cut");
const REAL_ROOT = process.env.WORKSPACE_ROOT?.trim() || path.resolve(process.cwd(), "..", "Pulsar-Workspace", "mini-drama-system", "projects");

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const realCut = (film: string) => {
  const p = path.join(REAL_ROOT, "low-quality", film, "cut");
  return existsSync(path.join(p, "review")) ? p : null;
};
const SKIP_NOTE = (film: string) => `real film ${film} is not under ${REAL_ROOT}; set WORKSPACE_ROOT to run this`;

// ---- the plan -----------------------------------------------------------------------------------

test("the newest delivered plan is the largest numeric end, not the last name", () => {
  const mk = ["choices.json", "cuts-0-900-verified.json", "cuts-0-1800-DELIVERED.json", "cuts-0-5959.067-DELIVERED.json", "cuts-0-1936.533-DELIVERED.json", "options.json"];
  assert.deepEqual(pickNewestDelivered(mk), { file: "cuts-0-5959.067-DELIVERED.json", end: 5959.067 });
  assert.deepEqual(pickNewestDelivered(["cuts-0-9-DELIVERED.json", "cuts-0-15-DELIVERED.json"]), { file: "cuts-0-15-DELIVERED.json", end: 15 });
  assert.equal(pickNewestDelivered([]), null);
  assert.equal(pickNewestDelivered(["cuts-0-7259.533-DELIVERED.20260922-224340.json"]), null, "a superseded copy's dated name never matches");
  assert.ok(!DELIVERED_FILE.test("cuts-0-900-verified.json"));
});

test("the delivered plan parses the pipeline's shape and refuses a broken one", () => {
  const plan = parseDeliveredPlan(readJson(path.join(FIXTURE_CUT, "review", "cuts-0-15-DELIVERED.json")));
  assert.equal(plan.episodes.length, 3);
  assert.equal(plan.fps, 30);
  assert.deepEqual(plan.band, [4, 6]);
  assert.equal(plan.episodes[2].ends_after_line, "Run.");

  const first = parseDeliveredPlan(readJson(path.join(FIXTURE_CUT, "review", "cuts-0-9-DELIVERED.json")));
  assert.equal(first.fps, null, "the first delivery of a film has no fps / pinned / moves");
  assert.equal(first.pin_from, null);
  assert.deepEqual(first.moves, []);

  const base = readJson(path.join(FIXTURE_CUT, "review", "cuts-0-15-DELIVERED.json"));
  // A QA re-pin declares its moves (pick_cuts.py --repin writes {from, to}); anything else there is a broken plan.
  assert.deepEqual(parseDeliveredPlan({ ...base, moves: [{ from: 4, to: 4.5, why: "extra keys pass" }] }).moves, [{ from: 4, to: 4.5 }]);
  assert.throws(() => parseDeliveredPlan({ ...base, moves: [{ from: "4", to: 4.5 }] }));
  assert.throws(() => parseDeliveredPlan({ ...base, moves: [4.5] }));
  assert.throws(() => parseDeliveredPlan({ ...base, episodes: [base.episodes[0], base.episodes[2]] }), /numbered 3/);
  assert.throws(() => parseDeliveredPlan({ ...base, episodes: [base.episodes[0], { ...base.episodes[1], start: 4.5 }, base.episodes[2]] }), /starts at 4.5/);
  assert.throws(() => parseDeliveredPlan({ ...base, episodes: [] }));
  assert.equal(plan.target, 5);
  assert.deepEqual(plan.skips, []);
  assert.equal(plan.source_breaks, null);
  assert.equal(plan.episodes[0].play, null);
});

test("a source-episodes plan (cards.py --plan, She Returned With Her Son): no target, band null, the skips the renderer trims out (plan B4)", () => {
  const src = {
    source_duration: 5527.301, fps: 30.0, band: null, pinned: 0, pin_from: null, moves: [], final_end_is_boundary: true, source_breaks: true,
    skips: [[100.3, 102.167], [253.1, 254.933]],
    cards: [[100.3, 102.167], [253.1, 254.933]],
    episodes: [
      { n: 1, start: 0.0, end: 102.167, dur: 102.17, play: 100.3, ends_after_line: "", next_opens_on: "" },
      { n: 2, start: 102.167, end: 254.933, dur: 152.77, play: 150.93, ends_after_line: "", next_opens_on: "" },
    ],
  };
  const plan = parseDeliveredPlan(src);
  assert.equal(plan.target, null);
  assert.equal(plan.band, null);
  assert.equal(plan.source_breaks, true);
  assert.deepEqual(plan.skips, [[100.3, 102.167], [253.1, 254.933]]);
  assert.equal(plan.episodes[1].play, 150.93);
  assert.throws(() => parseDeliveredPlan({ ...src, skips: [[102.167, 100.3]] }), /before it starts/);
  assert.throws(() => parseDeliveredPlan({ ...src, skips: [[100.3, 102.167], [101, 103]] }), /inside the previous one/);
  assert.throws(() => parseDeliveredPlan({ ...src, skips: [[100.3]] }));
  assert.deepEqual(playedPieces(plan.episodes[0], plan.skips), [[0, 100.3]], "a card at the end of the episode leaves one piece");
  assert.deepEqual(playedPieces(plan.episodes[1], plan.skips), [[102.167, 253.1]]);
  assert.deepEqual(playedPieces({ start: 0, end: 300 }, [[100, 102], [200, 202]]), [[0, 100], [102, 200], [202, 300]], "two cards inside: three pieces");
  assert.deepEqual(playedPieces({ start: 0, end: 300 }, [[400, 402]]), [[0, 300]], "a skip elsewhere changes nothing");
  assert.deepEqual(playedPieces({ start: 100, end: 200 }, [[90, 110]]), [[110, 200]], "a card straddling the start");
  assert.equal(skippedWithin(0, 300, [[100, 102], [200, 202]]), 4);
  assert.equal(skippedWithin(0, 101, [[100, 102]]), 1, "only the part inside the window");
  assert.equal(skippedWithin(0, 100, [[100, 102]]), 0);
});

// ---- index/ -------------------------------------------------------------------------------------

test("the index files parse from the fixture", () => {
  const whisper = parseWhisper(readJson(path.join(FIXTURE_CUT, "index", "whisper.json")));
  assert.equal(whisper.language, "en");
  assert.equal(whisper.model, "medium");
  assert.equal(whisper.segments.length, 5);
  assert.equal(whisper.segments[0].words[0].w, " Where", "a whisper word keeps its leading space");

  assert.deepEqual(parseScdet(readFileSync(path.join(FIXTURE_CUT, "index", "scdet.txt"), "utf8")), [2, 4, 6.5, 9, 12]);
  assert.deepEqual(parseScdet("1.5\r\n\r\n2.5\r\n"), [1.5, 2.5]);
  assert.throws(() => parseScdet("1.5\nabc\n"), /not a time/);
  assert.throws(() => parseScdet("3\n2\n"), /not ascending/);

  const motion = parseMotion(readJson(path.join(FIXTURE_CUT, "index", "motion.json")));
  assert.equal(motion.fps, 10);
  assert.equal(motion.beats.length, 3);
  assert.equal(motion.track, null);

  const candidates = parseCandidates(readJson(path.join(FIXTURE_CUT, "index", "candidates.json")));
  assert.equal(candidates.candidates.length, 3);
  assert.deepEqual(candidates.allowed, [{ t: 12, why: "test allow" }]);
  assert.equal(candidates.candidates[2].exception, "test allow", "an --allow cut carries its reason");
  assert.equal(candidates.candidates[0].exception, null);

  const source = parseSourceFacts(readJson(path.join(FIXTURE_CUT, "index", "source.json")));
  assert.deepEqual(source, { source: "../source/original.mp4", fps: 30, width: 720, height: 1280, duration: 15 });
});

// ---- vision -------------------------------------------------------------------------------------

function visionFiles(cut: string): { name: string; json: unknown }[] {
  const dir = path.join(cut, "review", "vision");
  return require("node:fs")
    .readdirSync(dir)
    .filter((n: string) => n.endsWith(".json"))
    .sort()
    .map((name: string) => ({ name, json: readJson(path.join(dir, name)) }));
}

test("vision records merge across files, skipping superseded and options-shaped ones", () => {
  const { boundaries, skipped } = mergeVisionRecords(visionFiles(FIXTURE_CUT));
  assert.deepEqual(
    boundaries.map((b) => b.pick.chosen_t),
    [4, 8.5],
    "the superseded first pass (chosen 3.5) is not merged"
  );
  assert.deepEqual(skipped, ["2026-09-22a_0-end_first-pass_superseded.json", "options-0-end-APPLIED.json"]);
  assert.equal(boundaries[0].source_file, "2026-09-22_0-end.json");
  assert.equal(boundaries[1].verdict?.agree, false);
  assert.equal(boundaries[1].verdict?.better_t, 9);
  assert.equal(boundaries[0].verdict?.fault, "", "an empty fault string passes through as it is");
});

test("a later file wins a boundary judged twice", () => {
  const rec = (chosen: number, why: string) => ({
    result: [{ boundary_s: 100, pick: { chosen_key: "opt1", chosen_t: chosen, ends_on: "", opens_on: "", why, payoff_in_episode: true, confidence: 0.7 }, verdict: { agree: true, reason: "" } }],
  });
  const { boundaries } = mergeVisionRecords([
    { name: "a.json", json: rec(100, "first") },
    { name: "b.json", json: rec(100, "rerun") },
  ]);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].pick.why, "rerun");
});

// ---- band-fix notes ------------------------------------------------------------------------------

const HHAW_NOTE = `# Band fixes after the 0-end vision pass (2026-09-22)

ep12 (was 158.6 s): keep 1194.0 (boundary 1209.033 - its DP pick lies inside the word "interview");
boundary 1325.967 moves 1352.633 -> 1342.067. ep12 now ends on the boss's inner question. Conf 0.72.

ep28 (was 164.4 s): keep 3004.2 (boundary 3033.867 - the source's own break, TO BE CONTINUED card);
boundary 3152.433 goes back to its DP pick 3152.433 (from 3168.567). Lengths 96.0 / 148.2 / 123.9. Conf 0.72.

ep59 (was 84.9 s): boundary 6611.233 goes to the first reviewer's 6612.3 (the skeptic's 6622.567 cannot
fit). Lengths 123.3 / 95.2 / 98.5. Conf 0.70.

Also: boundary 5296.0 takes the skeptic's 5298.0 (after the source's TO BE CONTINUED card) via
\`candidates.py --allow\` - whisper put "Given" at +0.23 s, the voice starts at +0.40 s by the audio.
`;

const RHW_NOTE = `# Band fix after the 0-end vision pass (2026-09-22)

Kept: 3852.067 (boundary 3867.133) - ends on the father's "It was me." reveal; confidence 0.70, skeptic agreed.
Changed: boundary 3989.9 back to 3989.9 (the DP pick) instead of 4011.667 - the reviewer's own named runner-up. Result: ep33 137.8 s, ep34 122.3 s.
`;

test("band-fix notes name the boundaries a person moved, not the picks they kept", () => {
  assert.deepEqual(parseBandFixNotes(HHAW_NOTE).map((x) => x.t), [1342.067, 3152.433, 6612.3]);
  assert.deepEqual(parseBandFixNotes(RHW_NOTE).map((x) => x.t), [3989.9]);
  assert.match(parseBandFixNotes(RHW_NOTE)[0].note, /named runner-up/);
  assert.deepEqual(parseBandFixNotes("nothing here").length, 0);
});

test("every delivered boundary is explained by the record that set it", () => {
  const plan: DeliveredPlan = {
    source_duration: 500, target: 120, fps: 30, band: [95, 150], pinned: null, pin_from: null, moves: [], final_end_is_boundary: null, source_breaks: null, skips: [],
    episodes: [
      { n: 1, start: 0, end: 100, dur: 100, play: null, ends_after_line: "", next_opens_on: "" },
      { n: 2, start: 100, end: 210, dur: 110, play: null, ends_after_line: "", next_opens_on: "" },
      { n: 3, start: 210, end: 300, dur: 90, play: null, ends_after_line: "", next_opens_on: "" },
      { n: 4, start: 300, end: 400, dur: 100, play: null, ends_after_line: "", next_opens_on: "" },
      { n: 5, start: 400, end: 500, dur: 100, play: null, ends_after_line: "", next_opens_on: "" },
    ],
  };
  const rec = (chosen: number, better: number | null): VisionBoundary => ({
    boundary_s: chosen,
    pick: { chosen_key: "opt1", chosen_t: chosen, ends_on: "", opens_on: "", why: "", payoff_in_episode: true, confidence: 0.7, rejected: null },
    verdict: { agree: better === null, reason: "", fault: null, better_key: null, better_t: better },
    source_file: "x.json",
  });
  const vision = [rec(100, null), rec(205, 210), rec(290, null), rec(400, null)];
  const notes = explainBoundaries(plan, vision, [{ t: 400, note: "boundary 390 -> 400" }]);
  assert.deepEqual(notes.map((n) => [n.n, n.end, n.decision, n.vision?.pick.chosen_t ?? null]), [
    [1, 100, "chosen", 100],
    [2, 210, "skeptic", 205],
    [3, 300, "none", null],
    [4, 400, "band_fix", 400],
  ]);
  assert.equal(notes[3].band_fix_note, "boundary 390 -> 400");
  assert.ok(notes.every((n) => n.move === null));
  assert.equal(notes.length, 4, "the final end is the end of the film, not a boundary");

  // A QA re-pin the plan declares (He Hated All Women's ep29 end went 3276.333 -> 3278.3 on 2026-09-23: an ordinary
  // legal candidate, no --allow, no new vision record): the end is a qa_move carrying the record that judged the time
  // it moved from. A record that names the end itself still wins, and the move rides along on it.
  const moved = explainBoundaries({ ...plan, moves: [{ from: 290, to: 300 }, { from: 99, to: 100 }, { from: 7, to: 210 }] }, vision, [{ t: 400, note: "boundary 390 -> 400" }]);
  assert.deepEqual(moved.map((n) => [n.n, n.end, n.decision, n.vision?.pick.chosen_t ?? null]), [
    [1, 100, "chosen", 100],
    [2, 210, "skeptic", 205],
    [3, 300, "qa_move", 290],
    [4, 400, "band_fix", 400],
  ]);
  assert.deepEqual(moved.map((n) => n.move), [{ from: 99, to: 100 }, { from: 7, to: 210 }, { from: 290, to: 300 }, null]);
  // A move from a time no record judged is still the plan's own word for the end, with no record to carry.
  const blind = explainBoundaries({ ...plan, moves: [{ from: 280, to: 300 }] }, vision, []);
  assert.deepEqual([blind[2].decision, blind[2].vision, blind[2].move], ["qa_move", null, { from: 280, to: 300 }]);
});

// ---- film-meta ------------------------------------------------------------------------------------

test("film-meta.json parses and refuses a bad slug or a backwards window", () => {
  const meta = parseFilmMeta(readJson(path.join(FIXTURE_CUT, "film-meta.json")));
  assert.equal(meta.display_title_en, "Fixture Film");
  assert.equal(meta.crazydramas_slug, "fixture-film");
  assert.equal(meta.spoiler_from_s, 7.5);
  assert.deepEqual(meta.exclusions, [{ from_s: 13, to_s: 14, why: "a test card", kind: "card" }]);
  assert.equal(meta.live_poster, "fixture-film-a");
  assert.equal(meta.notes, null);
  assert.throws(() => parseFilmMeta({ display_title_en: "x", language: "en", crazydramas_slug: "Not A Slug" }), /slug/);
  assert.throws(() => parseFilmMeta({ display_title_en: "x", language: "en", exclusions: [{ from_s: 5, to_s: 5, why: "w" }] }), /after from_s/);
  assert.throws(() => parseFilmMeta({ language: "en" }));
  const bare = parseFilmMeta({ display_title_en: "x", language: "en" });
  assert.deepEqual(bare.exclusions, []);
  assert.equal(bare.spoiler_from_s, null);
});

// ---- loadFilmIndex ------------------------------------------------------------------------------------

test("loadFilmIndex reads the fixture film whole", async () => {
  const index = await loadFilmIndex(nodeScanFs, FIXTURE_ROOT, "low-quality/fixture-film");
  assert.equal(index.delivered_file, "review/cuts-0-15-DELIVERED.json", "the newest by numeric end, not cuts-0-9");
  assert.match(index.delivered_sha256, /^[0-9a-f]{64}$/);
  assert.equal(index.delivered.episodes.length, 3);
  assert.equal(index.whisper?.segments.length, 5);
  assert.deepEqual(index.shot_cuts, [2, 4, 6.5, 9, 12]);
  assert.equal(index.motion?.beats.length, 3);
  assert.equal(index.candidates?.candidates.length, 3);
  assert.equal(index.source?.width, 720);
  assert.deepEqual(index.vision.map((v) => v.pick.chosen_t), [4, 8.5]);
  assert.equal(index.band_fix_notes.length, 1);
  assert.deepEqual(index.boundaries.map((b) => [b.n, b.end, b.decision]), [
    [1, 4, "chosen"],
    [2, 9, "band_fix"],
  ]);
  assert.equal(index.boundaries[1].vision?.pick.chosen_t, 8.5, "the band-fixed boundary still carries the record that judged it (its skeptic named 9.0)");
  assert.deepEqual(index.posters, ["low-quality/fixture-film/poster/final/fixture-film-a.jpg"]);
  assert.equal(index.meta?.display_title_en, "Fixture Film");
  assert.deepEqual(index.problems, []);
});

test("loadFilmIndex reports a broken optional file as a problem and refuses a film with no plan", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "film-index-"));
  try {
    cpSync(path.join(FIXTURE_ROOT, "low-quality", "fixture-film"), path.join(tmp, "film"), { recursive: true });
    writeFileSync(path.join(tmp, "film", "cut", "index", "motion.json"), "{ not json");
    writeFileSync(path.join(tmp, "film", "cut", "index", "whisper.json"), JSON.stringify({ language: "en" }));
    const index = await loadFilmIndex(nodeScanFs, tmp, "film");
    assert.equal(index.motion, null);
    assert.equal(index.whisper, null);
    assert.equal(index.problems.length, 2);
    assert.match(index.problems[0], /index\/whisper\.json/);
    assert.match(index.problems[1], /index\/motion\.json/);
    assert.equal(index.delivered.episodes.length, 3, "the plan still loads");

    rmSync(path.join(tmp, "film", "cut", "review"), { recursive: true });
    await assert.rejects(loadFilmIndex(nodeScanFs, tmp, "film"), /no review\/cuts-0-\*-DELIVERED\.json/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- the real films (skipped when absent) ------------------------------------------------------------

test("real Mafia King: three plan files, the whole-film index, four split vision records", async (t) => {
  const cut = realCut("mafia-king");
  if (!cut) return t.skip(SKIP_NOTE("mafia-king"));
  const review = require("node:fs").readdirSync(path.join(cut, "review")) as string[];
  const newest = pickNewestDelivered(review);
  assert.deepEqual(newest, { file: "cuts-0-5959.067-DELIVERED.json", end: 5959.067 });
  const plan = parseDeliveredPlan(readJson(path.join(cut, "review", newest!.file)));
  assert.equal(plan.episodes.length, 52);
  assert.equal(plan.episodes[51].end, 5959.067);
  assert.equal(plan.pin_from, "review/cuts-0-1936.533-DELIVERED.json");
  const first = parseDeliveredPlan(readJson(path.join(cut, "review", "cuts-0-1800-DELIVERED.json")));
  assert.equal(first.episodes.length, 16);
  assert.equal(first.fps, null, "the first delivery predates the fps field");
  const checkpoint = parseDeliveredPlan(readJson(path.join(cut, "review", "cuts-0-1936.533-DELIVERED.json")));
  assert.equal(checkpoint.episodes.length, 17);
  assert.equal(checkpoint.final_end_is_boundary, true);

  const whisper = parseWhisper(readJson(path.join(cut, "index", "whisper.json")));
  assert.equal(whisper.language, "en");
  assert.equal(whisper.model, "medium");
  assert.ok(whisper.segments.length > 1500, "1,631 segments on 2026-09-23");
  assert.ok(whisper.segments.every((s) => s.words.length > 0));
  assert.ok(parseScdet(readFileSync(path.join(cut, "index", "scdet.txt"), "utf8")).length > 3500, "3,769 shot cuts on 2026-09-23");
  const motion = parseMotion(readJson(path.join(cut, "index", "motion.json")));
  assert.ok(motion.beats.length > 500, "728 beats on 2026-09-23");
  assert.ok(motion.track && motion.track.length > 50_000, "the 10 fps energy track comes along");
  const candidates = parseCandidates(readJson(path.join(cut, "index", "candidates.json")));
  assert.ok(candidates.candidates.length > 1500, "1,852 legal cuts on 2026-09-23");
  const source = parseSourceFacts(readJson(path.join(cut, "index", "source.json")));
  assert.deepEqual([source.width, source.height, source.fps], [720, 1280, 30]);

  const { boundaries, skipped } = mergeVisionRecords(visionFiles(cut));
  assert.ok(boundaries.length >= 51, "52 episodes = 51 judged boundaries across the four applied files");
  assert.ok(skipped.includes("2026-09-22a_0-900_first-pass_superseded.json"), "the superseded first pass is skipped by name");
  assert.ok(skipped.includes("options-900-1800-APPLIED.json") && skipped.includes("options-checkpoint-APPLIED.json"), "applied options files are skipped by shape");
  assert.ok(boundaries.filter((b) => b.pick.payoff_in_episode).length >= 40, "44 of 51 on 2026-09-23");

  const index = await checkExplained("mafia-king", { band_fix: [], skeptic: [476.5] });
  assert.equal(index.band_fix_notes.length, 0);
  assert.ok(index.posters.includes("low-quality/mafia-king/poster/final/forced-to-marry-c.jpg"));
});

// The pipeline keeps working on these films (a QA pass on He Hated All Women
// was moving boundaries while this was written, 2026-09-23 00:43, and moved
// ep29's end to a plain legal candidate at 02:01), so what follows checks the
// invariants of the records, not counts a re-cut moves: every delivered end
// is explained by a vision pick, a skeptic override, a band-fix note or a
// move the plan itself declares, or else it is a legal cut of candidates.json
// (a QA `--allow` exception or an ordinary candidate). A legitimate pipeline
// edit must never turn this gate red.
async function checkExplained(film: string, expect: { band_fix: number[]; skeptic: number[] }) {
  const index = await loadFilmIndex(nodeScanFs, REAL_ROOT, `low-quality/${film}`);
  assert.deepEqual(index.problems, [], `${film}: every present file parses`);
  const ends = new Set(index.boundaries.map((b) => b.end));
  const decisionOf = (end: number) => index.boundaries.find((b) => b.end === end)?.decision;
  for (const end of expect.band_fix) if (ends.has(end)) assert.equal(decisionOf(end), "band_fix", `${film}: ${end} is a band-fix boundary`);
  for (const end of expect.skeptic) if (ends.has(end)) assert.equal(decisionOf(end), "skeptic", `${film}: ${end} is the skeptic's time`);
  const allowed = new Set((index.candidates?.allowed ?? []).map((a) => Math.round(a.t * 1000)));
  const legal = (t: number) => allowed.has(Math.round(t * 1000)) || (index.candidates?.candidates ?? []).some((c) => Math.abs(c.t - t) <= 0.02);
  for (const b of index.boundaries) {
    if (b.decision === "none") assert.ok(legal(b.end), `${film}: the unexplained end ${b.end} is a legal cut (a QA --allow or an ordinary candidate)`);
    if (b.decision === "qa_move") {
      assert.equal(b.move?.to, b.end, `${film}: the declared move ends at ${b.end}`);
      assert.ok(legal(b.end), `${film}: the QA-moved end ${b.end} is a legal cut`);
    }
    if (b.decision === "band_fix") assert.match(b.band_fix_note ?? "", new RegExp(String(b.end).replace(".", "\\.")), `${film}: the band-fix note names ${b.end}`);
  }
  for (const m of index.delivered.moves) {
    if (ends.has(m.to)) assert.notEqual(decisionOf(m.to), "none", `${film}: the declared move to ${m.to} is never an unexplained end`);
  }
  for (const a of index.candidates?.allowed ?? []) {
    const row = index.candidates?.candidates.find((c) => Math.abs(c.t - a.t) <= 0.02);
    assert.ok(row?.exception, `${film}: the --allow cut ${a.t} carries its reason on the candidate row`);
  }
  return index;
}

test("real He Hated All Women: the --allow exceptions, the skeptic overrides, the three band-fix boundaries, the QA moves", async (t) => {
  const cut = realCut("he-hated-all-women");
  if (!cut) return t.skip(SKIP_NOTE("he-hated-all-women"));
  const index = await checkExplained("he-hated-all-women", { band_fix: [1342.067, 3152.433, 6612.3], skeptic: [763.267, 4316.967, 5298, 6805.933] });
  // The 02:01 QA session: ep29's end 3276.333 -> 3278.3 is declared in the plan's moves, a plain candidate, and the
  // note carries the reviewer's record for 3276.333 (the two --allow moves at 315.533 and 6390.933 read the same way).
  for (const m of index.delivered.moves) {
    const b = index.boundaries.find((x) => x.end === m.to);
    if (!b) continue;
    assert.equal(b.decision, "qa_move", `${m.from} -> ${m.to} is a declared QA move`);
    assert.equal(b.vision?.pick.chosen_t, m.from, `the record that judged ${m.from} travels with the moved end`);
  }
  assert.ok(index.candidates!.allowed.some((a) => a.t === 5298), "the --allow at 5298.0 (band-fix note)");
  assert.match(index.candidates!.candidates.find((c) => c.t === 5298)?.exception ?? "", /voice starts at \+0\.40 s/);
  const preAllow = parseCandidates(readJson(path.join(cut, "index", "candidates.pre-allow.json")));
  assert.deepEqual(preAllow.allowed, [], "the set before --allow existed");
  assert.ok(index.candidates!.candidates.length >= preAllow.candidates.length + 1);
  assert.ok(index.delivered.episodes.length >= 60);
  assert.ok(index.vision.length >= 63);
  assert.equal(index.band_fix_notes.length, 1);
  assert.ok((index.whisper?.segments.length ?? 0) > 1000);
  assert.ok((index.shot_cuts?.length ?? 0) > 3000);
});

test("real Reclaiming Her World: one skeptic override and the one band-fix boundary", async (t) => {
  const cut = realCut("reclaiming-her-world");
  if (!cut) return t.skip(SKIP_NOTE("reclaiming-her-world"));
  const index = await checkExplained("reclaiming-her-world", { band_fix: [3989.9], skeptic: [1334.933] });
  assert.ok(index.delivered.episodes.length >= 50);
  assert.ok(index.vision.length >= 52);
  assert.equal(index.source?.width, 1080);
  assert.ok((index.whisper?.segments.length ?? 0) > 2000);
});

test("real film-meta.json of the three films: slugs, the spoiler line at 50%, exclusions inside the film", async (t) => {
  const films: [string, string, string][] = [
    ["mafia-king", "forced-to-marry-the-mafia-boss", "forced-to-marry-c"],
    ["he-hated-all-women", "one-night-with-the-billionaire-who-hated-women", "one-night-billionaire-b"],
    ["reclaiming-her-world", "my-new-billionaire-husband", "billionaire-husband-b"],
  ];
  let seen = 0;
  for (const [film, slug, poster] of films) {
    const cut = realCut(film);
    if (!cut || !existsSync(path.join(cut, "film-meta.json"))) continue;
    seen++;
    const index = await loadFilmIndex(nodeScanFs, REAL_ROOT, `low-quality/${film}`);
    const meta = index.meta;
    assert.ok(meta, `${film}: film-meta.json parses`);
    assert.equal(meta.crazydramas_slug, slug);
    assert.equal(meta.language, "en");
    assert.equal(meta.live_poster, poster);
    assert.ok(index.posters.some((p) => p.endsWith(`/${poster}.jpg`)), `${film}: the live poster exists under poster/final`);
    const end = index.delivered.episodes[index.delivered.episodes.length - 1].end;
    assert.ok(Math.abs((meta.spoiler_from_s ?? 0) - end / 2) < 0.001, `${film}: spoiler line at 50% of ${end}`);
    for (const x of meta.exclusions) {
      assert.ok(x.from_s >= 0 && x.to_s > x.from_s && x.to_s <= end, `${film}: exclusion ${x.from_s}-${x.to_s} inside the film`);
      assert.ok(x.why.length > 20, `${film}: exclusion ${x.from_s} names its evidence`);
    }
    if (film === "mafia-king") assert.ok(meta.exclusions.some((x) => x.from_s === 3093.167 && x.to_s === 3094.167), "the red-flash stinger at 3093.167");
    if (film === "he-hated-all-women") assert.ok(meta.exclusions.some((x) => x.from_s === 1350.6), "the TO BE CONTINUED card 8.5 s into ep13");
    if (film === "reclaiming-her-world") assert.deepEqual(meta.exclusions, []);
  }
  if (!seen) t.skip(SKIP_NOTE("any"));
});
