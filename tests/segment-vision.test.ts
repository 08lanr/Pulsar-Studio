// The vision pass as an API module (lib/segment/vision, lib/segment/strips,
// lib/prompts/boundary-*, lib/prompts/band-fix) without a network: the
// options document and the strip checks `boundary_frames.py --verify`
// makes; deterministic prompt builders whose checks refuse what the
// pipeline would refuse; a fake llm driving judgeBoundaries into a file in
// the Workflow's output shape, one job row per call, idempotent on a
// re-run; apply_vision.py's three rules as a pure function (and, when the
// drama-remix checkout and its Python are on this machine, the real
// apply_vision.py accepting the file); evaluate() against the recorded
// pass; the band-fix path. The fixture under tests/fixtures/segment is two
// real boundaries of He Hated All Women (strips at half size) plus four of
// its recorded vision records and the legal cuts around them.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resetFixtureStore } from "@/lib/data/fixture";
import { parseBandFixNotes, parseVisionRecordFile, VisionRecordFileSchema } from "@/lib/film-import/manifest";
import type { StructuredCall, StructuredResult } from "@/lib/llm";
import {
  BandFixPickSchema,
  BandFixVerdictSchema,
  bandFaults,
  bandFixNote,
  bandFixToVisionRecords,
  buildBandFixJudge,
  buildBandFixSkeptic,
  describeGroup,
  episodeLengths,
  findBandConflicts,
  resolveBandFix,
  type BandFixGroup,
  type BandFixPick,
  type BandFixVerdict,
} from "@/lib/prompts/band-fix";
import { BOUNDARY_RULES, BOUNDARY_RULE_VERSION, BoundaryPickSchema, buildBoundaryReview, type BoundaryPick } from "@/lib/prompts/boundary-review";
import { BoundaryVerdictSchema, buildBoundarySkeptic, type BoundaryVerdict } from "@/lib/prompts/boundary-skeptic";
import {
  DENSE_COLS,
  DENSE_STEP_S,
  SegmentError,
  boundaryStrips,
  denseStripArgs,
  dramaRemixRoot,
  findBoundary,
  legalCutsNear,
  loadCandidates,
  loadOptionsDoc,
  optionsSha,
  parseOptionsDoc,
  pipelinePython,
  readStripSidecar,
  stripLayoutOf,
  stripTiles,
  verifyOptions,
  type OptionsDoc,
  type StripImage,
} from "@/lib/segment/strips";
import {
  WorkflowOutputSchema,
  WorkflowRecordSchema,
  applyVision,
  appliedTimeOf,
  evaluate,
  isUnavailable,
  judgeBandFix,
  judgeBoundaries,
  mergeVisionPasses,
  type EvalRecord,
  type WorkflowRecord,
} from "@/lib/segment/vision";

const FIXTURE_CUT = path.join(process.cwd(), "tests", "fixtures", "segment", "cut");
const RUN_ID = "11111111-2222-4333-8444-555555555555";

const temps: string[] = [];
const saved = { replay: process.env.DEMO_REPLAY, source: process.env.DATA_SOURCE, anthropic: process.env.ANTHROPIC_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY, vision: process.env.ADS_VISION_PROVIDER };

beforeEach(() => {
  resetFixtureStore();
  process.env.DEMO_REPLAY = "0";
  delete process.env.DATA_SOURCE;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ADS_VISION_PROVIDER;
});

afterEach(() => {
  resetFixtureStore();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of [["DEMO_REPLAY", saved.replay], ["DATA_SOURCE", saved.source], ["ANTHROPIC_API_KEY", saved.anthropic], ["DEEPSEEK_API_KEY", saved.deepseek], ["ADS_VISION_PROVIDER", saved.vision]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A copy of the fixture cut folder a test may write to, its strips touched so they are newer than candidates.json. */
function tempCut(): string {
  const root = mkdtempSync(path.join(tmpdir(), "studio-segment-"));
  temps.push(root);
  const cut = path.join(root, "cut");
  cpSync(FIXTURE_CUT, cut, { recursive: true });
  const now = new Date();
  for (const name of ["b424_opt1.png", "b424_opt2.png", "b4550_opt1.png", "b4550_opt2.png"]) utimesSync(path.join(cut, "review", "frames", name), now, now);
  return cut;
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** The recorded pass of the fixture, keyed by boundary_s as evaluate wants it. */
function recordedFixture(): EvalRecord[] {
  return parseVisionRecordFile(readJson(path.join(FIXTURE_CUT, "review", "vision", "2026-09-22_0-end.json")), "fixture").map((r) => ({ boundary_s: r.boundary_s, pick: r.pick, verdict: r.verdict }));
}

// ---- a fake llm ---------------------------------------------------------------------------------------

type Script = { pick?: Partial<BoundaryPick> | ((b: number) => Partial<BoundaryPick>); verdict?: Partial<BoundaryVerdict> | ((b: number) => Partial<BoundaryVerdict>); fail?: number[] };

const boundaryOf = (call: StructuredCall<unknown>) => Number(call.user.match(/^BOUNDARY (\d+(?:\.\d+)?)s/m)?.[1]);

/** Answers every call from a script, validating each answer against the call's own schema and check as the gateway would. */
function fakeLlm(script: Script = {}) {
  const calls: StructuredCall<unknown>[] = [];
  const llm = async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
    calls.push(call as StructuredCall<unknown>);
    const b = boundaryOf(call as StructuredCall<unknown>);
    if (script.fail?.includes(b)) throw new Error(`fake refusal at ${b}`);
    const doc = parseOptionsDoc(readJson(path.join(FIXTURE_CUT, "review", "options.json")));
    const entry = findBoundary(doc, b);
    let data: unknown;
    if (call.name === "verify_boundaries_look") {
      const dp = entry?.options.find((o) => o.is_dp_pick) ?? entry?.options[0];
      const extra = typeof script.pick === "function" ? script.pick(b) : script.pick ?? {};
      data = { chosen_key: dp?.key, chosen_t: dp?.t, ends_on: "A close-up.", opens_on: "A wide shot.", why: "Fake: the DP pick.", rejected: "Fake: the other option cuts mid-action.", payoff_in_episode: true, confidence: 0.8, ...extra };
    } else if (call.name === "verify_boundaries_verify") {
      const extra = typeof script.verdict === "function" ? script.verdict(b) : script.verdict ?? {};
      data = { agree: true, fault: null, better_key: null, better_t: null, reason: "Fake: the pick holds.", ...extra };
    } else {
      throw new Error(`fake llm: unexpected call ${call.name}`);
    }
    const parsed = call.schema.parse(data);
    const problem = call.check?.(parsed);
    assert.equal(problem, null, `the fake's answer for ${call.name} at ${b} must pass the call's own check: ${problem}`);
    return { data: parsed, usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 2, provider: call.provider ?? "anthropic", model: call.model ?? "claude-sonnet-5", turns: 1 };
  };
  return { llm, calls };
}

// ---- the options document and the strips ----------------------------------------------------------------

test("the fixture options document parses, its strips read with their sidecars, and the option sha ignores the applied stamp", async () => {
  const doc = await loadOptionsDoc(FIXTURE_CUT);
  assert.equal(doc.boundaries.length, 2);
  assert.deepEqual(doc.band, [95, 150]);
  assert.deepEqual(stripLayoutOf(doc), { window: 5, step: 0.5, cols: 6 });
  const b = findBoundary(doc, 424.433)!;
  assert.equal(b.options.length, 2);
  assert.equal(b.options[0].is_dp_pick, true);
  const strips = await boundaryStrips(FIXTURE_CUT, b, stripLayoutOf(doc));
  assert.deepEqual(strips.map((s) => s.key), ["opt1", "opt2"]);
  assert.equal(strips[0].tiles.length, 11);
  assert.equal(strips[0].tiles[5], 424.433, "the centre tile is the option time, at the sidecar's precision (the options file rounds strip_tiles to 2 dp)");
  assert.equal(strips[0].rel, "review/frames/b424_opt1.png");
  assert.ok(path.isAbsolute(strips[0].path));
  const side = await readStripSidecar(strips[1].path);
  assert.equal(side?.cols, 6);
  assert.equal(side?.tiles_in_reading_order.length, 11);

  const sha = optionsSha(doc);
  const stamped = parseOptionsDoc({ ...doc, applied: { label: "0-end", on: "2026-09-22" }, boundaries: doc.boundaries.map((x) => ({ ...x, before: [] })) });
  assert.equal(optionsSha(stamped), sha, "the applied stamp and the dialogue windows are not the option set");
  const moved = parseOptionsDoc({ ...doc, boundaries: doc.boundaries.map((x, i) => (i ? x : { ...x, options: x.options.map((o, j) => (j ? o : { ...o, t: o.t + 0.5 })) })) });
  assert.notEqual(optionsSha(moved), sha, "a moved option time is another option set");

  const cands = await loadCandidates(FIXTURE_CUT);
  assert.ok(cands && cands.candidates.length > 50);
  const near = legalCutsNear(cands, 4313.4);
  assert.ok(near.some((c) => Math.abs(c.t - 4316.967) < 0.001), "the skeptic's 4316.967 is a legal cut near 4313.4");
  assert.ok(near.every((c) => Math.abs(c.t - 4313.4) <= 30));
});

test("verifyOptions refuses what boundary_frames.py --verify refuses, and passes a fresh set", async () => {
  const cut = tempCut();
  const doc = await loadOptionsDoc(cut);
  const ok = await verifyOptions(cut, doc);
  assert.deepEqual(ok, { ok: true, faults: [], n_options: 4, boundaries: [424.433, 4550.267] });

  const stale = await verifyOptions(cut, { ...doc, strips_stale: true });
  assert.match(stale.faults.join("\n"), /strips_stale is not false/);
  const applied = await verifyOptions(cut, { ...doc, applied: { label: "0-end", on: "2026-09-22" } });
  assert.match(applied.faults.join("\n"), /already applied \(0-end on 2026-09-22\)/);
  assert.equal((await verifyOptions(cut, { ...doc, applied: { label: "0-end", on: "2026-09-22" } }, { allowApplied: true })).ok, true, "the calibration run may re-judge an applied file");
  const wrongLayout = await verifyOptions(cut, { ...doc, strip: { window: 5, step: 1, cols: 4 } });
  assert.match(wrongLayout.faults.join("\n"), /4 per row at 1 s; the vision pass assumes 6 per row at 0.5 s/);

  const offCentre = JSON.parse(JSON.stringify(doc)) as OptionsDoc;
  offCentre.boundaries[0].options[0].strip_tiles = [1, 2, 3];
  assert.match((await verifyOptions(cut, offCentre)).faults.join("\n"), /424.433s: centre tile is not the option time/);

  rmSync(path.join(cut, "review", "frames", "b4550_opt2.png"));
  assert.match((await verifyOptions(cut, doc)).faults.join("\n"), /4572.067s: no strip on disk/);

  // A strip older than index/candidates.json was made for a previous index (older than the COPY's candidates.json: Windows' copy keeps the fixture's mtime, so "an hour ago" stops being older an hour after the fixture was written).
  const old = new Date(statSync(path.join(cut, "index", "candidates.json")).mtimeMs - 60 * 60 * 1000);
  utimesSync(path.join(cut, "review", "frames", "b424_opt1.png"), old, old);
  assert.match((await verifyOptions(cut, doc)).faults.join("\n"), /424.433s: strip is older than index\/candidates.json/);

  // Every boundary inside the newest delivered cuts is refused (its final end is free unless the plan pins it).
  writeFileSync(path.join(cut, "review", "cuts-0-5000-DELIVERED.json"), JSON.stringify({ episodes: [{ end: 424.433 }, { end: 3000 }, { end: 5000 }] }));
  const inside = await verifyOptions(cut, doc);
  assert.match(inside.faults.join("\n"), /1 boundaries lie inside delivered cuts \(cuts-0-5000-DELIVERED.json, pinned to 3000s\): \[424.433\]/);
  writeFileSync(path.join(cut, "review", "cuts-0-5000-DELIVERED.json"), JSON.stringify({ episodes: [{ end: 424.433 }, { end: 3000 }, { end: 5000 }], final_end_is_boundary: true }));
  assert.match((await verifyOptions(cut, doc)).faults.join("\n"), /2 boundaries lie inside delivered cuts .*pinned to 5000s/);
});

test("the dense-strip request is the exact boundary_frames.py call for a 10 fps strip", () => {
  const env = { DRAMA_REMIX_ROOT: "C:/remix", STUDIO_PIPELINE_PYTHON: "C:/py/python.exe" };
  const req = denseStripArgs({ src: "C:/films/x/source/original.mp4", at: 4314.967, out: "C:/work/dense" }, env);
  assert.deepEqual(req.args, [
    path.join("C:/remix", "scripts", "cut-only", "boundary_frames.py"),
    "--src", "C:/films/x/source/original.mp4",
    "--at", "4314.967",
    "--window", "3",
    "--step", "0.1",
    "--cols", "10",
    "--width", "200",
    "--out", "C:/work/dense.png",
  ]);
  assert.equal(req.png, "C:/work/dense.png");
  assert.equal(req.sidecar, "C:/work/dense.json");
  assert.equal(req.cols, DENSE_COLS);
  assert.equal(req.step, DENSE_STEP_S);
  assert.equal(req.tiles.length, 31, "3 s at 0.1 s, both ends inclusive, as the script counts");
  assert.equal(req.tiles[15], 4314.967, "the chosen cut is the centre tile");
  assert.deepEqual(stripTiles(10, 5, 0.5), [7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5]);
  assert.equal(pipelinePython(env), "C:/py/python.exe");
  assert.equal(pipelinePython({}), "python", "the README's system Python is the default, never an assumed venv");
  assert.equal(dramaRemixRoot({}), path.resolve(process.cwd(), "..", "Pulsar-Workspace", "mini-drama-system", "drama-remix"));
});

// ---- the prompt builders ---------------------------------------------------------------------------------

async function reviewInput(cut = FIXTURE_CUT, boundaryS = 424.433) {
  const doc = await loadOptionsDoc(cut);
  const boundary = findBoundary(doc, boundaryS)!;
  const layout = stripLayoutOf(doc);
  const strips = await boundaryStrips(cut, boundary, layout);
  return { doc, boundary, layout, strips, band: doc.band, film_notes: "A ~1.7 s TO BE CONTINUED card marks the source's own breaks.", provider: "anthropic" as const, model: "claude-sonnet-5" };
}

test("the reviewer prompt is deterministic, carries the standing rules verbatim, attaches every strip in option order, and its check refuses a pick that is not an option", async () => {
  const input = await reviewInput();
  const a = buildBoundaryReview(input);
  const b = buildBoundaryReview(input);
  assert.deepEqual({ system: a.system, user: a.user, images: a.images, name: a.name, model: a.model, provider: a.provider }, { system: b.system, user: b.user, images: b.images, name: b.name, model: b.model, provider: b.provider });
  assert.equal(a.name, "verify_boundaries_look");
  assert.equal(a.prompt_version, BOUNDARY_RULE_VERSION);
  const system = a.system.map((s) => s.text).join("\n");
  assert.ok(system.includes(BOUNDARY_RULES), "the six standing decisions, word for word");
  assert.ok(system.includes("NEVER cut inside a physical action - mid-punch, mid-throw, mid-fall."));
  assert.ok(system.includes("If someone is thrown into a pool, the episode must end AFTER they hit the water and go under"));
  assert.ok(system.includes("HARD PRECONDITION"));
  assert.ok(system.includes("About this film:\nA ~1.7 s TO BE CONTINUED card"));
  assert.ok(system.includes("Judge the options as PAIRS"));
  assert.ok(system.includes("Copy chosen_t EXACTLY"));
  assert.ok(a.system[0].cache, "the rules are the cached prefix; the boundary is the user turn");
  assert.deepEqual(a.images, input.strips.map((s) => ({ media_type: "image/png", path: s.path })));
  assert.match(a.user, /^BOUNDARY 424.433s/);
  assert.match(a.user, /opt1 at 424.433s \[is_dp_pick\] - image 1/);
  assert.match(a.user, /opt2 at 433.1s - image 2/);
  assert.match(a.user, /tiles: 421.933, 422.433, 422.933, 423.433, 423.933, 424.433, 424.933, 425.433, 425.933, 426.433, 426.933/);
  assert.match(a.user, /last action 4.13s before, next 22.17s after/);
  assert.match(a.user, /\[412.7s\] Yet he fathered a child behind our backs/);
  assert.match(a.user, /Choose one of opt1, opt2\./);

  const good: BoundaryPick = { chosen_key: "opt2", chosen_t: 433.1, ends_on: "x", opens_on: "y", why: "z", rejected: null, payoff_in_episode: true, confidence: 0.75 };
  assert.equal(a.check(good), null);
  assert.match(a.check({ ...good, chosen_key: "opt9" })!, /chosen_key "opt9" is not one of opt1, opt2/);
  assert.match(a.check({ ...good, chosen_t: 433 })!, /chosen_t must be exactly 433.1 for opt2/);
  assert.match(a.check({ ...good, confidence: 1.5 })!, /0 to 1/);
  assert.equal(a.check({ ...good, chosen_key: "none", chosen_t: 0, confidence: 0 }), null, "a refusal (confidence 0) chooses nothing and is not repaired");
  assert.ok(BoundaryPickSchema.safeParse(good).success);
  assert.throws(() => buildBoundaryReview({ ...input, strips: input.strips.slice(1) }), /1 strips for 2 options/);
});

test("the skeptic prompt restates the pick, lists the legal cuts, takes the dense strip last, and its check admits only listed times as a fix", async () => {
  const input = await reviewInput(FIXTURE_CUT, 4550.267);
  const pick: BoundaryPick = { chosen_key: "opt1", chosen_t: 4550.267, ends_on: "Helen's half-smile.", opens_on: "The hallway wide shot.", why: "Clean shot change.", rejected: "opt2 is in action.", payoff_in_episode: true, confidence: 0.8 };
  const cands = await loadCandidates(FIXTURE_CUT);
  const legal = legalCutsNear(cands, 4550.267);
  const dense: StripImage = { key: "dense", t: 4550.267, path: path.join(FIXTURE_CUT, "review", "frames", "b4550_opt1.png"), rel: "dense.png", media_type: "image/png", tiles: stripTiles(4550.267, 3, 0.1), cols: 10, step: 0.1 };
  const base = { boundary: input.boundary, strips: input.strips, pick, dense, legal_cuts: legal, layout: input.layout, band: input.band, film_notes: null, provider: "anthropic" as const, model: "claude-sonnet-5" };
  const a = buildBoundarySkeptic(base);
  const b = buildBoundarySkeptic(base);
  assert.deepEqual({ s: a.system, u: a.user, i: a.images }, { s: b.system, u: b.user, i: b.images });
  assert.equal(a.name, "verify_boundaries_verify");
  const system = a.system.map((s) => s.text).join("\n");
  assert.ok(system.includes("Your job is to REFUTE it if you can."));
  assert.ok(system.includes(BOUNDARY_RULES));
  assert.ok(system.includes("- is another listed option strictly better on rules 2-4?"));
  assert.ok(system.includes("Do not manufacture\na disagreement over taste"));
  assert.ok(system.includes("DENSE strip"));
  assert.match(a.user, /The other reviewer chose opt1 at 4550.267s\./);
  assert.match(a.user, /They said the episode ends on: Helen's half-smile\./);
  assert.match(a.user, /LEGAL CUTS within 30 s/);
  assert.match(a.user, /4550.267s \(a listed option\)/);
  assert.match(a.user, /DENSE STRIP around 4550.267s - image 3/);
  assert.equal(a.images.length, 3, "two option strips, then the dense strip");
  assert.equal(a.images[2].path, dense.path);

  const agree: BoundaryVerdict = { agree: true, fault: null, better_key: null, better_t: null, reason: "Holds." };
  assert.equal(a.check(agree), null);
  assert.match(a.check({ ...agree, better_t: 4572.067 })!, /you agreed: better_key and better_t must be null/);
  assert.equal(a.check({ agree: false, fault: "Rule 3", better_key: "opt2", better_t: 4572.067, reason: "..." }), null);
  assert.match(a.check({ agree: false, fault: "Rule 3", better_key: "opt2", better_t: 4572, reason: "..." })!, /better_t must be exactly 4572.067 for opt2/);
  assert.match(a.check({ agree: false, fault: "Rule 3", better_key: "opt1", better_t: 4550.267, reason: "..." })!, /is the option you are disputing/);
  assert.match(a.check({ agree: false, fault: "Rule 3", better_key: "opt7", better_t: 1, reason: "..." })!, /better_key "opt7" is not a listed option/);
  const legalOther = legal.find((c) => Math.abs(c.t - 4550.267) > 1 && Math.abs(c.t - 4572.067) > 1)!;
  assert.equal(a.check({ agree: false, fault: "Rule 4", better_key: null, better_t: legalOther.t, reason: "a legal cut from the list" }), null);
  assert.match(a.check({ agree: false, fault: "Rule 4", better_key: null, better_t: 4551.111, reason: "a bare shot change" })!, /not a listed option or a legal cut from the list/);
  assert.equal(a.check({ agree: false, fault: "Rule 5", better_key: null, better_t: null, reason: "a fault with no fix" }), null, "a dispute without a fix is allowed; apply_vision then reports it");
  assert.ok(BoundaryVerdictSchema.safeParse(agree).success);

  const noDense = buildBoundarySkeptic({ ...base, dense: null, legal_cuts: [] });
  assert.equal(noDense.images.length, 2);
  assert.match(noDense.user, /\(no index here: only the listed options are legal\)/);
  assert.match(noDense.check({ agree: false, fault: "x", better_key: null, better_t: legalOther.t, reason: "..." })!, /not a listed option or a legal cut/);
});

// ---- apply_vision.py's rules ------------------------------------------------------------------------------

const rec = (b: number, t: number, verdict: Partial<WorkflowRecord["verdict"] & object> | null, confidence = 0.8): WorkflowRecord => ({
  boundary_s: b,
  pick: { chosen_key: "opt1", chosen_t: t, ends_on: "e", opens_on: "o", why: "w", payoff_in_episode: true, confidence },
  verdict: verdict === null ? null : { agree: true, reason: "r", fault: "", better_key: "", ...verdict },
});

test("applyVision: a skeptic with a better time wins, a dispute with no fix rejects the pass, confidence 0 applies nothing, a later pass wins", () => {
  const ok = applyVision([rec(100, 101.5, { agree: true }), rec(200, 202, { agree: false, better_t: 205.5, fault: "Rule 3" }), rec(300, 300, null)]);
  assert.deepEqual(ok.faults, []);
  assert.deepEqual(ok.choices, { "100": 101.5, "200": 205.5, "300": 300 });
  assert.deepEqual(ok.rows.map((r) => [r.boundary_s, r.applied_t, r.source]), [[100, 101.5, "reviewer"], [200, 205.5, "SKEPTIC OVERRIDE"], [300, 300, "reviewer"]]);

  const dispute = applyVision([rec(100, 101.5, { agree: true }), rec(200, 202, { agree: false, fault: "Rule 3: the payoff lands next episode", better_t: null })]);
  assert.deepEqual(dispute.choices, {}, "choices.json is NOT written when any boundary faults");
  assert.deepEqual(dispute.faults, ["200s: skeptic disputes 202s and names no fix - Rule 3: the payoff lands next episode"]);
  assert.equal(dispute.rows.length, 1, "the sound boundary is still reported");

  const refused = applyVision([rec(100, 101.5, { agree: true }, 0)]);
  assert.deepEqual(refused.faults, ["100s: reviewer refused or returned nothing - w"]);
  assert.deepEqual(refused.choices, {});
  assert.deepEqual(appliedTimeOf(rec(100, 101.5, { agree: false, better_t: 0 })), { t: null, fault: "100s: skeptic disputes 101.5s and names no fix - r" }, "a better_t of 0 is no fix, as Python's truthiness has it");

  const later = applyVision([rec(100, 101.5, { agree: false, fault: "x", better_t: null })], [rec(100, 101.5, { agree: true })]);
  assert.deepEqual(later.choices, { "100": 101.5 }, "a re-run of one faulted boundary replaces its record");
  assert.deepEqual(mergeVisionPasses([[rec(200, 1, null)], [rec(100, 1, null)]]).map((r) => r.boundary_s), [100, 200]);
  assert.equal(String(5296), "5296", "String(boundary_s) keys match Python's str() of the JSON number");
});

// ---- judgeBoundaries -------------------------------------------------------------------------------------

test("judgeBoundaries writes the Workflow output shape, one job row per call, and a re-run pays for nothing", async () => {
  const cut = tempCut();
  const doc = await loadOptionsDoc(cut);
  const fake = fakeLlm({ verdict: (b) => (b === 4550.267 ? { agree: false, fault: "Rule 4: no aftermath", better_key: "opt2", better_t: 4572.067 } : {}) });
  const seen: number[] = [];
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut, film_notes: null }, doc, { label: "0-end", llm: fake.llm, concurrency: 3, onBoundary: (rec_, done, total) => seen.push(done * 100 + total) });
  assert.ok(!isUnavailable(r));
  assert.equal(r.file, path.join(cut, "review", "vision", "0-end.json"));
  assert.equal(r.provider, "anthropic");
  assert.equal(r.model, "claude-sonnet-5");
  assert.deepEqual(r.errors, []);
  assert.equal(fake.calls.length, 4, "reviewer + skeptic per boundary");
  assert.equal(r.jobs.length, 4);
  assert.ok(r.jobs.every((j) => !j.skipped && j.cost_cents === 2));
  assert.equal(r.cost_cents, 8);
  assert.deepEqual(seen.sort(), [102, 202]);
  for (const c of fake.calls) {
    assert.equal(c.provider, "anthropic");
    assert.equal(c.model, "claude-sonnet-5");
    assert.ok(c.images && c.images.length >= 2, "every call carries the strips");
  }

  // The file: an object with `result`, as apply_vision.py and phase 1's reader both take it.
  const file = readJson(r.file);
  WorkflowOutputSchema.parse(file);
  VisionRecordFileSchema.parse(file);
  const parsed = parseVisionRecordFile(file, "0-end.json");
  assert.deepEqual(parsed.map((p) => [p.boundary_s, p.pick.chosen_t, p.verdict?.agree, p.verdict?.better_t]), [[424.433, 424.433, true, null], [4550.267, 4550.267, false, 4572.067]]);
  assert.equal(file.summary, "Choose each episode boundary by looking at contact strips, then adversarially verify each choice");
  assert.deepEqual(file.logs, ["2 boundaries judged by eye"]);
  assert.equal(file.source, "pulsar-studio");
  assert.equal(file.run_id, RUN_ID);
  assert.equal(file.rule_version, BOUNDARY_RULE_VERSION);
  const agreeRec = file.result[0];
  assert.deepEqual(Object.keys(agreeRec.verdict).sort(), ["agree", "better_key", "fault", "reason"], "no better_t when the skeptic agrees; fault and better_key are empty strings, as the Workflow wrote them");
  assert.equal(agreeRec.verdict.fault, "");
  assert.equal("rejected" in agreeRec.pick, true);
  assert.equal(file.result[1].verdict.better_t, 4572.067);
  const applied = applyVision(file.result);
  assert.deepEqual(applied.choices, { "424.433": 424.433, "4550.267": 4572.067 });

  // A second run: the done rows short-circuit, the fake is never called, the file is rewritten the same.
  const again = await judgeBoundaries({ id: RUN_ID, cut_dir: cut, film_notes: null }, doc, { label: "0-end", llm: fake.llm });
  assert.ok(!isUnavailable(again));
  assert.equal(fake.calls.length, 4, "no new call");
  assert.ok(again.jobs.every((j) => j.skipped));
  assert.deepEqual(again.records, r.records);

  // Another attempt (a person rejected the answer) is another set of rows.
  const attempt2 = await judgeBoundaries({ id: RUN_ID, cut_dir: cut, film_notes: null }, doc, { label: "0-end_2", llm: fake.llm, attempt: 2, boundaries: [4550.267] });
  assert.ok(!isUnavailable(attempt2));
  assert.equal(fake.calls.length, 6);
  assert.equal(attempt2.records.length, 1);
  assert.equal(attempt2.file, path.join(cut, "review", "vision", "0-end_2.json"));
});

test("judgeBoundaries returns unavailable without a call when no vision provider can run, and refuses stale strips before any call", async () => {
  const cut = tempCut();
  const doc = await loadOptionsDoc(cut);
  const fake = fakeLlm();
  delete process.env.ANTHROPIC_API_KEY;
  const noKey = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "x", llm: fake.llm });
  assert.ok(isUnavailable(noKey));
  assert.match(noKey.unavailable, /vision provider unavailable: add ANTHROPIC_API_KEY/);
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  process.env.DEMO_REPLAY = "1";
  const demo = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "x", llm: fake.llm });
  assert.ok(isUnavailable(demo));
  assert.match(demo.unavailable, /off in demo mode/);
  process.env.DEMO_REPLAY = "0";
  assert.equal(fake.calls.length, 0);
  assert.ok(!existsSync(path.join(cut, "review", "vision", "x.json")));

  await assert.rejects(judgeBoundaries({ id: RUN_ID, cut_dir: cut }, { ...doc, strips_stale: true }, { label: "x", llm: fake.llm }), (e: unknown) => e instanceof SegmentError && e.code === "strips" && /strips_stale is not false/.test(e.message));
  await assert.rejects(judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "../x", llm: fake.llm }), /plain file-name token/);
  await assert.rejects(judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "x", llm: fake.llm, boundaries: [999] }), /boundary 999 is not in review\/options.json/);
  assert.equal(fake.calls.length, 0);
});

test("judgeBoundaries keeps a failed boundary out of the result and skips the skeptic for a reviewer that refused", async () => {
  const cut = tempCut();
  const doc = await loadOptionsDoc(cut);
  const fake = fakeLlm({ fail: [424.433], pick: (b) => (b === 4550.267 ? { confidence: 0, chosen_key: "none", chosen_t: 0, why: "strip unreadable" } : {}) });
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "partial", llm: fake.llm });
  assert.ok(!isUnavailable(r));
  assert.deepEqual(r.errors.map((e) => e.boundary_s), [424.433]);
  assert.match(r.errors[0].error, /fake refusal at 424.433/);
  assert.equal(fake.calls.filter((c) => c.name === "verify_boundaries_verify").length, 0, "no skeptic on a refusal");
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].pick.confidence, 0);
  const file = readJson(r.file);
  assert.deepEqual(file.logs, ["1 boundaries judged by eye", "424.433s: Error: fake refusal at 424.433"]);
  const applied = applyVision(file.result);
  assert.match(applied.faults[0], /4550.267s: reviewer refused or returned nothing - strip unreadable/);
  // The failed boundary's job row is failed, not done: a re-run calls it again.
  const before = fake.calls.length;
  const again = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "partial", llm: fakeLlm().llm });
  assert.ok(!isUnavailable(again));
  assert.equal(fake.calls.length, before);
  assert.deepEqual(again.errors, []);
  assert.equal(again.records.length, 2);
});

test("the real apply_vision.py accepts the file (skipped when the drama-remix checkout or its Python is not on this machine)", async (t) => {
  const script = path.join(dramaRemixRoot(), "scripts", "cut-only", "apply_vision.py");
  const probe = existsSync(script) ? spawnSync(pipelinePython(), ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" }) : null;
  if (!probe || probe.status !== 0) {
    t.skip(`no apply_vision.py at ${script} or no ${pipelinePython()}`);
    return;
  }
  const cut = tempCut();
  const doc = await loadOptionsDoc(cut);
  const fake = fakeLlm({ verdict: (b) => (b === 4550.267 ? { agree: false, fault: "Rule 4", better_key: "opt2", better_t: 4572.067 } : {}) });
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "0-end", llm: fake.llm });
  assert.ok(!isUnavailable(r));
  const run = spawnSync(pipelinePython(), [script, "--from", "review/vision/0-end.json", "--label", "0-end"], { cwd: cut, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, `apply_vision.py refused the file:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /SKEPTIC OVERRIDE/);
  assert.deepEqual(readJson(path.join(cut, "review", "choices.json")), { "424.433": 424.433, "4550.267": 4572.067 });
  const stamped = readJson(path.join(cut, "review", "options.json"));
  assert.equal(stamped.applied.label, "0-end");

  // A dispute with no fix: exit 1, choices.json not written (the previous one moved aside).
  const fake2 = fakeLlm({ verdict: (b) => (b === 424.433 ? { agree: false, fault: "Rule 3: the payoff lands in the next episode" } : {}) });
  const r2 = await judgeBoundaries({ id: RUN_ID, cut_dir: cut, film_notes: null }, doc, { label: "dispute", llm: fake2.llm, attempt: 2, allow_applied: true });
  assert.ok(!isUnavailable(r2));
  const run2 = spawnSync(pipelinePython(), [script, "--from", "review/vision/dispute.json", "--label", "dispute"], { cwd: cut, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run2.status, 1);
  assert.match(run2.stdout, /skeptic disputes 424.433s and names no fix - Rule 3/);
  assert.ok(!existsSync(path.join(cut, "review", "choices.json")));
  assert.ok(existsSync(path.join(cut, "review", "choices.prev.json")));
});

// ---- evaluate ---------------------------------------------------------------------------------------------

test("evaluate scores agreement of the applied time (±0.2 s), the reviewer's pick and the payoff flag against the recorded pass", () => {
  const recorded = recordedFixture();
  assert.equal(recorded.length, 4);
  const judged: EvalRecord[] = [
    // 424.433: recorded 433.1 agreed; judged the same time, payoff flipped.
    { boundary_s: 424.433, pick: { chosen_t: 433.1, payoff_in_episode: false, confidence: 0.7 }, verdict: { agree: true } },
    // 4313.4: recorded applied the skeptic's 4316.967; judged the reviewer picks 4316.9 directly (within 0.2 s of the applied time, not of the recorded pick).
    { boundary_s: 4313.4, pick: { chosen_t: 4316.9, payoff_in_episode: true, confidence: 0.8 }, verdict: { agree: true } },
    // 4550.267: recorded 4550.267; judged 4572.067 (a different cut).
    { boundary_s: 4550.267, pick: { chosen_t: 4572.067, payoff_in_episode: true, confidence: 0.6 }, verdict: { agree: true } },
    // 1914.633: judged faulted (skeptic disputes with no fix) where the recorded pass applied.
    { boundary_s: 1914.633, pick: { chosen_t: 1914.633, payoff_in_episode: false, confidence: 0.7 }, verdict: { agree: false, better_t: null, fault: "Rule 5" } },
    // Not in the recorded pass: ignored.
    { boundary_s: 9999, pick: { chosen_t: 9999, payoff_in_episode: true, confidence: 1 }, verdict: null },
  ];
  const ev = evaluate(recorded, judged);
  assert.equal(ev.matched, 4);
  assert.equal(ev.n_judged, 5);
  assert.equal(ev.applied_agree, 2);
  assert.equal(ev.applied_rate, 0.5);
  assert.equal(ev.reviewer_agree, 2, "424.433 and 1914.633 chose the recorded reviewer's time; 4313.4 chose the skeptic's, not the reviewer's 4314.967");
  assert.equal(ev.payoff_agree, 3, "only 424.433 flipped the payoff flag");
  assert.equal(ev.one_sided, 1);
  const byB = new Map(ev.rows.map((r) => [r.boundary_s, r]));
  assert.deepEqual([byB.get(4313.4)!.recorded_t, byB.get(4313.4)!.judged_t, byB.get(4313.4)!.delta_s, byB.get(4313.4)!.applied_agree], [4316.967, 4316.9, -0.067, true]);
  assert.deepEqual([byB.get(1914.633)!.recorded_t, byB.get(1914.633)!.judged_t, byB.get(1914.633)!.applied_agree], [1914.633, null, false]);
  assert.equal(byB.get(4550.267)!.applied_agree, false);
  assert.equal(byB.get(424.433)!.recorded_skeptic_agree, true);
  const identical = evaluate(recorded, recorded);
  assert.deepEqual([identical.applied_rate, identical.reviewer_rate, identical.payoff_rate, identical.one_sided], [1, 1, 1, 0]);
  assert.equal(evaluate(recorded, []).applied_rate, null);
});

// ---- the band-fix path -------------------------------------------------------------------------------------

/** A synthetic options doc: four boundaries near the fixture's, so the fixture strips can stand in for their options. */
function bandDoc(): OptionsDoc {
  const real = parseOptionsDoc(readJson(path.join(FIXTURE_CUT, "review", "options.json")));
  const b424 = findBoundary(real, 424.433)!;
  return parseOptionsDoc({
    duration: 600,
    band: [95, 150],
    strips_stale: false,
    strip: real.strip,
    boundaries: [
      { ...b424, boundary_s: 120, dp_pick: 120, options: [{ ...b424.options[0], t: 120 }, { ...b424.options[1], t: 130 }] },
      { ...b424, boundary_s: 240, dp_pick: 240, options: [{ ...b424.options[0], t: 240 }, { ...b424.options[1], t: 300 }] },
      { ...b424, boundary_s: 360, dp_pick: 360, options: [{ ...b424.options[0], t: 360 }, { ...b424.options[1], t: 350 }] },
      { ...b424, boundary_s: 480, dp_pick: 480, options: [{ ...b424.options[0], t: 480 }, { ...b424.options[1], t: 500 }] },
    ],
  });
}

test("findBandConflicts groups the adjacent boundaries whose applied choices broke the band, with the nearest fixed neighbours", () => {
  const doc = bandDoc();
  // ep2 = 130..300 = 170 s (too long): boundaries 120 and 240 are the group; ep3 = 300..360 = 60 s (too short): 240 and 360 join it. 480 stays.
  const groups = findBandConflicts({ doc, choices: { "120": 130, "240": 300, "360": 360, "480": 480 }, records: [{ boundary_s: 240, pick: { chosen_key: "opt1", chosen_t: 240, ends_on: "", opens_on: "", why: "", rejected: null, payoff_in_episode: true, confidence: 0.6 }, verdict: { agree: false, fault: "x", better_key: null, better_t: 300, reason: "" } }] });
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.deepEqual(g.episodes_out_of_band, { ep2: 170, ep3: 60 });
  assert.equal(g.fixed_before, 0);
  assert.equal(g.fixed_after, 480);
  assert.deepEqual(g.boundaries.map((b) => [b.key, b.applied, b.conf, b.skeptic_agree, b.options]), [[120, 130, 0, true, [120, 130]], [240, 300, 0.6, false, [240, 300]], [360, 360, 0, true, [360, 350]]]);
  assert.deepEqual(findBandConflicts({ doc, choices: { "120": 120, "240": 240, "360": 360, "480": 480 } }), [], "a plan inside the band has no conflict");
  // Two conflicts on either side of a pin are two groups; the pin is the fixed neighbour of both and never a boundary to choose.
  // cuts 0 | 130 240 [300] 350 500 | 600: ep3 (240-300) is 60 s, ep4 (300-350) is 50 s.
  const pinned = findBandConflicts({ doc, choices: { "120": 130, "240": 240, "360": 350, "480": 500 }, pins: [300] });
  assert.equal(pinned.length, 2, JSON.stringify(pinned.map((x) => x.boundaries.map((b) => b.key))));
  assert.deepEqual([pinned[0].boundaries.map((b) => b.key), pinned[0].fixed_before, pinned[0].fixed_after, pinned[0].episodes_out_of_band], [[240], 130, 300, { ep3: 60 }]);
  assert.deepEqual([pinned[1].boundaries.map((b) => b.key), pinned[1].fixed_before, pinned[1].fixed_after, pinned[1].episodes_out_of_band], [[360], 300, 500, { ep4: 50 }]);
  // Two out-of-band episodes that do not touch are two groups, even when their boundaries are neighbours.
  // cuts 0 | 130 300 360 480 | 600: ep2 (130-300) is 170 s, ep5 (480-600) is 120 s - fine; make ep4 short instead: 360 -> 350 is not listed, so use the last episode.
  const apart = findBandConflicts({ doc: { ...doc, duration: 700 }, choices: { "120": 130, "240": 300, "360": 360, "480": 480 } });
  assert.deepEqual(apart.map((x) => [x.boundaries.map((b) => b.key), x.fixed_before, x.fixed_after]), [[[120, 240, 360], 0, 480], [[480], 360, 700]], "ep5 (480-700, 220 s) is its own group: 480 is its only movable boundary");
});

async function bandInput() {
  const doc = bandDoc();
  const group: BandFixGroup = {
    label: "g1-120",
    episodes_out_of_band: { ep2: 170, ep3: 60 },
    fixed_before: 0,
    fixed_after: 480,
    boundaries: [
      { key: 120, applied: 130, conf: 0.8, skeptic_agree: true, options: [120, 130] },
      { key: 240, applied: 300, conf: 0.6, skeptic_agree: false, options: [240, 300] },
      { key: 360, applied: 360, conf: 0.7, skeptic_agree: true, options: [360, 350] },
    ],
  };
  const boundaries = group.boundaries.map((b) => findBoundary(doc, b.key)!);
  const layout = stripLayoutOf(doc);
  const strips: StripImage[][] = [];
  for (const b of boundaries) strips.push(await boundaryStrips(FIXTURE_CUT, b, layout));
  return { doc, group, input: { group, band: doc.band as [number, number], boundaries, strips, layout, legal_cuts: [200, 250, 380], first_pass: [], film_notes: null, provider: "anthropic" as const, model: "claude-sonnet-5" } };
}

test("the band-fix judge and skeptics are deterministic, state the band as a hard rule, and their checks do the arithmetic the Workflow asked the judge to do", async () => {
  const { group, input } = await bandInput();
  const a = buildBandFixJudge(input);
  const b = buildBandFixJudge(input);
  assert.deepEqual({ s: a.system, u: a.user, i: a.images }, { s: b.system, u: b.user, i: b.images });
  const system = a.system.map((s) => s.text).join("\n");
  assert.ok(system.includes("7. HARD: every episode must be 95-150 s long."));
  assert.ok(system.includes("LEGAL CUTS between 0s and 480s"));
  assert.ok(a.user.includes(describeGroup(group)));
  assert.match(a.user, /2\. key 240: first pass applied 300 \(confidence 0.6, skeptic DISAGREED - the applied time is the skeptic's\); listed options \[240,300\]/);
  assert.match(a.user, /Prefer keeping the stronger first-pass choices/);
  assert.equal(a.images.length, 6, "every option strip of every boundary in the group");
  assert.match(a.user, /key 360:\nopt1 at 360s \[is_dp_pick\] - image 5/);

  assert.deepEqual(episodeLengths(0, [120, 240, 360], 480), [120, 120, 120, 120]);
  const good: BandFixPick = { times: [120, 240, 360], lengths: [120, 120, 120, 120], ends_on: ["a", "b", "c"], handed_over: null, why: "back to the DP picks", confidence: 0.7 };
  assert.equal(a.check(good), null);
  assert.match(a.check({ ...good, times: [120, 240] })!, /give exactly 3 times/);
  assert.match(a.check({ ...good, times: [120, 241, 360] })!, /time 2 \(241\) is not a listed option of key 240 or a legal cut/);
  assert.match(a.check({ ...good, times: [130, 300, 360], lengths: [130, 170, 60, 120] })!, /episode 2 of the group would be 170 s; every episode must be 95-150 s/);
  assert.match(a.check({ ...good, lengths: [120, 120, 121, 120] })!, /the lengths do not follow from the times/);
  assert.match(a.check({ ...good, ends_on: ["a"] })!, /one ends_on per chosen cut/);
  assert.equal(a.check({ ...good, times: [120, 250, 380], lengths: [120, 130, 130, 100] }), null, "legal cuts from the list are allowed");
  assert.match(a.check({ ...good, times: [250, 240, 360] })!, /time 2 \(240\) is not after time 1 \(250\)/);
  assert.equal(bandFaults([120, 240, 360], input), null);
  assert.ok(BandFixPickSchema.safeParse(good).success);

  const s0 = buildBandFixSkeptic(input, good, 0);
  const s1 = buildBandFixSkeptic(input, good, 1);
  assert.match(s0.user, /Lens: the physical payoff/);
  assert.match(s1.user, /Lens: the cold open and the open question/);
  assert.match(s0.user, /The judge chose: \[120,240,360\] giving lengths \[120,120,120,120\]\. Their reasons: back to the DP picks Handed over: nothing\./);
  const agree: BandFixVerdict = { agree: true, better_times: null, reason: "stands" };
  assert.equal(s0.check(agree), null);
  assert.match(s0.check({ ...agree, better_times: [120, 250, 380] })!, /you agreed/);
  assert.equal(s0.check({ agree: false, better_times: [120, 250, 380], reason: "better" }), null);
  assert.match(s0.check({ agree: false, better_times: [120, 240, 360], reason: "same" })!, /the judge's own set/);
  assert.match(s0.check({ agree: false, better_times: [130, 300, 360], reason: "out" })!, /would be 170 s/);
  assert.equal(s0.check({ agree: false, better_times: null, reason: "a fault, no set" }), null);
  assert.ok(BandFixVerdictSchema.safeParse(agree).success);
});

test("resolveBandFix follows the apply rules for a group, and the answer becomes Workflow records and a note phase 1 reads back", async () => {
  const { doc, group } = await bandInput();
  const pick: BandFixPick = { times: [120, 240, 360], lengths: [120, 120, 120, 120], ends_on: ["a", "b", "c"], handed_over: null, why: "back to the DP picks", confidence: 0.7 };
  const judge = resolveBandFix(group, { pick, verdicts: [{ agree: true, better_times: null, reason: "ok" }, { agree: true, better_times: null, reason: "ok" }] });
  assert.deepEqual([judge.times, judge.lengths, judge.source, judge.faults], [[120, 240, 360], [120, 120, 120, 120], "judge", []]);
  const skeptic = resolveBandFix(group, { pick, verdicts: [{ agree: true, better_times: null, reason: "ok" }, { agree: false, better_times: [120, 250, 380], reason: "cleaner" }] });
  assert.deepEqual([skeptic.times, skeptic.source], [[120, 250, 380], "skeptic-1"]);
  const both = resolveBandFix(group, { pick, verdicts: [{ agree: false, better_times: [130, 250, 380], reason: "a" }, { agree: false, better_times: [120, 250, 380], reason: "b" }] });
  assert.deepEqual([both.times, both.source], [[130, 250, 380], "skeptic-0"], "the first skeptic with a set wins");
  const dispute = resolveBandFix(group, { pick, verdicts: [{ agree: false, better_times: null, reason: "splits the slap" }] });
  assert.equal(dispute.times, null);
  assert.deepEqual(dispute.faults, ["g1-120: skeptic 0 disputes [120,240,360] and names no better set - splits the slap"]);
  const refused = resolveBandFix(group, { pick: { ...pick, confidence: 0 }, verdicts: [] });
  assert.match(refused.faults[0], /judge refused or returned nothing/);

  const boundaries = group.boundaries.map((b) => findBoundary(doc, b.key)!);
  const records = bandFixToVisionRecords(group, boundaries, skeptic, { pick, verdicts: [{ agree: false, better_times: [120, 250, 380], reason: "cleaner" }] });
  assert.equal(records.length, 3);
  for (const r of records) WorkflowRecordSchema.parse(r);
  assert.deepEqual(records.map((r) => [r.boundary_s, r.pick.chosen_key, r.pick.chosen_t, r.verdict.agree]), [[120, "opt1", 120, true], [240, "legal_cut", 250, true], [360, "legal_cut", 380, true]]);
  assert.deepEqual(applyVision(records).choices, { "120": 120, "240": 250, "360": 380 });
  const first = [rec(120, 130, { agree: true }), rec(240, 240, { agree: false, better_t: 300 }), rec(360, 360, { agree: true }), rec(480, 480, { agree: true })];
  assert.deepEqual(applyVision(first, records).choices, { "120": 120, "240": 250, "360": 380, "480": 480 }, "`--from first --from band-fix`: the later file wins per boundary");

  const note = bandFixNote(group, skeptic, { pick, verdicts: [] });
  assert.match(note, /^ep2 \(was 170 s\), ep3 \(was 60 s\): boundary 120 moves 130 -> 120; boundary 240 moves 300 -> 250; boundary 360 moves 360 -> 380\./);
  assert.match(note, /Lengths 120 \/ 130 \/ 130 \/ 100\. Conf 0\.7\./);
  assert.deepEqual(parseBandFixNotes(note).map((n) => n.t), [120, 250, 380], "phase 1 reads every moved boundary from the note");
  assert.match(bandFixNote(group, dispute, { pick, verdicts: [] }), /NOT FIXED - g1-120: skeptic 0 disputes/);
});

test("judgeBandFix runs judge and two skeptics per group through job rows and writes the records and the note", async () => {
  const cut = tempCut();
  const { doc, group } = await bandInput();
  const calls: string[] = [];
  const llm = async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
    calls.push(call.name);
    let data: unknown;
    if (call.name === "band_fix_judge") data = { times: [120, 240, 360], lengths: [120, 120, 120, 120], ends_on: ["a", "b", "c"], handed_over: null, why: "back to the DP picks", confidence: 0.7 };
    else if (call.name === "band_fix_verify_0") data = { agree: false, better_times: [120, 250, 380], reason: "the slap reads better" };
    else data = { agree: true, better_times: null, reason: "fine" };
    const parsed = call.schema.parse(data);
    assert.equal(call.check?.(parsed), null);
    return { data: parsed, usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 3, provider: "anthropic", model: "claude-sonnet-5", turns: 1 };
  };
  const r = await judgeBandFix({ id: RUN_ID, cut_dir: cut }, doc, [group], { label: "0-end", llm, candidates: { source_whisper: null, shot_cuts: 0, legal: 3, rejected: {}, min_clear: 0.3, allowed: [], beats_used: null, candidates: [200, 250, 380].map((t) => ({ t, in_action: false, motion: 0, since_action: 9, until_action: 9, action_energy: 0, gap_before: 1, gap_after: 1, settle: 1, line_before: "", line_after: "", line_before_end: 0, line_after_start: 0, exception: null })) } });
  assert.ok(!isUnavailable(r));
  assert.deepEqual(calls, ["band_fix_judge", "band_fix_verify_0", "band_fix_verify_1"]);
  assert.equal(r.jobs.length, 3);
  assert.equal(r.cost_cents, 9);
  assert.deepEqual(r.faults, []);
  assert.deepEqual(r.groups[0].resolution.times, [120, 250, 380]);
  assert.equal(r.file, path.join(cut, "review", "vision", "0-end_band-fix.json"));
  assert.equal(r.note_file, path.join(cut, "review", "vision", "0-end_band-fix.md"));
  const file = readJson(r.file);
  WorkflowOutputSchema.parse(file);
  assert.deepEqual(applyVision(file.result).choices, { "120": 120, "240": 250, "360": 380 });
  const note = readFileSync(r.note_file, "utf8");
  assert.deepEqual(parseBandFixNotes(note).map((n) => n.t), [120, 250, 380]);
});
