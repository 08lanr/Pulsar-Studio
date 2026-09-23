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
import { BOUNDARY_RULES, BOUNDARY_RULE_VERSION, BoundaryPickSchema, OptionSeenSchema, buildBoundaryReview, denseReadingLine, refusalProblem, selfContradiction, type BoundaryPick, type OptionSeen } from "@/lib/prompts/boundary-review";
import { BoundaryVerdictSchema, buildBoundarySkeptic, citationContextOf, citationProblem, faultRuleProblem, verdictContradiction, type BoundaryVerdict } from "@/lib/prompts/boundary-skeptic";
import { TiebreakSchema, buildBoundaryTiebreak, tiebreakLayoutLine, type TiebreakSide, type TiebreakVerdict } from "@/lib/prompts/boundary-tiebreak";
import {
  DENSE_COLS,
  DENSE_STEP_S,
  SegmentError,
  allowedRange,
  boundaryStrips,
  denseStripArgs,
  dramaRemixRoot,
  findBoundary,
  legalCutsInView,
  legalCutsNear,
  loadCandidates,
  neighboursOf,
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
  tiebreakOrder,
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

/**
 * The fixture's two boundaries are 4126 s apart, so the planner's neighbours
 * give no in-band range. Four filler boundaries (never judged) around them
 * make the neighbours real: 424.433 lies between 300 and 550, 4550.267
 * between 4450 and 4680, so opt2 at 4572.067 is inside its range.
 */
function withFillers(doc: OptionsDoc): OptionsDoc {
  const template = doc.boundaries[0].options[0];
  const fillers = [300, 550, 4450, 4680].map((t) => ({ boundary_s: t, dp_pick: t, before: [], after: [], options: [{ ...template, key: "opt1", t, is_dp_pick: true, strip_tiles: stripTiles(t, 5, 0.5) }] }));
  return parseOptionsDoc({ ...doc, boundaries: [...doc.boundaries, ...fillers].sort((a, b) => a.boundary_s - b.boundary_s) });
}

// ---- a fake llm ---------------------------------------------------------------------------------------

type Script = {
  pick?: Partial<BoundaryPick> | ((b: number) => Partial<BoundaryPick>);
  verdict?: Partial<BoundaryVerdict> | ((b: number) => Partial<BoundaryVerdict>);
  /** The tie-break's winner as a cut time (the fake maps it to A or B), or "neither"; A when unscripted. */
  tiebreak?: number | "neither" | ((b: number) => number | "neither");
  fail?: number[];
};

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
      const seen = (entry?.options ?? []).map((o) => ({ key: o.key, ends_on: "A close-up.", opens_on: "A wide shot.", caption_across_cut: false, card_or_flare: "none", physical_action_across_cut: null }));
      data = { options_seen: seen, chosen_key: dp?.key, chosen_t: dp?.t, ends_on: "A close-up.", opens_on: "A wide shot.", why: "Fake: the DP pick.", rejected: "Fake: the other option cuts mid-action.", payoff_in_episode: true, confidence: 0.8, ...extra };
    } else if (call.name === "verify_boundaries_verify") {
      const extra = typeof script.verdict === "function" ? script.verdict(b) : script.verdict ?? {};
      data = { chosen_strip_shows: "Fake: a close-up, then a wide shot.", chosen_caption_across_cut: false, chosen_card_or_flare: "none", chosen_action_across_cut: null, agree: true, fault: null, fault_rule: null, fault_image: null, fault_tile_t: null, fault_tile_shows: null, better_key: null, better_t: null, reason: "Fake: the pick holds.", ...extra };
    } else if (call.name === "verify_boundaries_tiebreak") {
      const want = typeof script.tiebreak === "function" ? script.tiebreak(b) : script.tiebreak ?? null;
      const aT = Number(call.user.match(/^CUT A at (\d+(?:\.\d+)?)s/m)?.[1]);
      const bT = Number(call.user.match(/^CUT B at (\d+(?:\.\d+)?)s/m)?.[1]);
      const winner = want === "neither" ? "neither" : want === null ? "A" : Math.abs(want - aT) <= 0.0015 ? "A" : Math.abs(want - bT) <= 0.0015 ? "B" : "neither";
      // The losing side's fault tile is its own cut tile (a tile of its option strip and of its dense strip), a rule-4 fault; both for "neither"; the winner carries none.
      data = { a_shows: "Fake: cut A's frames.", b_shows: "Fake: cut B's frames.", a_fault_tile_t: winner === "A" ? null : aT, a_fault_rule: winner === "A" ? null : "4", b_fault_tile_t: winner === "B" ? null : bT, b_fault_rule: winner === "B" ? null : "4", winner, evidence_image: null, evidence_tile_t: null, reason: `Fake: ${winner} satisfies the payoff rule.` };
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

test("the reviewer prompt is deterministic, carries the standing rules verbatim with the two second-pass rules, the reading block, the neighbours and the range, attaches every strip in option order, and its check refuses a pick that is not an option or is out of range", async () => {
  const input = await reviewInput();
  const range = { prev: 315.533, next: 528.9, ...allowedRange(315.533, 528.9, [95, 150]) };
  assert.deepEqual(range, { prev: 315.533, next: 528.9, lo: 410.533, hi: 433.9 });
  const a = buildBoundaryReview({ ...input, range });
  const b = buildBoundaryReview({ ...input, range });
  assert.deepEqual({ system: a.system, user: a.user, images: a.images, name: a.name, model: a.model, provider: a.provider }, { system: b.system, user: b.user, images: b.images, name: b.name, model: b.model, provider: b.provider });
  assert.equal(a.name, "verify_boundaries_look");
  assert.equal(a.prompt_version, BOUNDARY_RULE_VERSION);
  assert.equal(BOUNDARY_RULE_VERSION, "by-eye-v5", "the calibration fixes changed rules 7-8, the schema descriptions and the reading block, the second round the skeptic's schema, and the Claude arms the card-elsewhere rule and the grab definition: a new rule version, new idempotency keys");
  assert.equal(a.toolChoice, "auto", "the judge thinks before it answers: a forced tool call skips the thinking");
  const system = a.system.map((s) => s.text).join("\n");
  assert.ok(system.includes(BOUNDARY_RULES), "the standing decisions, word for word");
  assert.ok(system.includes("NEVER cut inside a physical action - mid-punch, mid-throw, mid-fall."));
  assert.ok(system.includes("If someone is thrown into a pool, the episode must end AFTER they hit the water and go under"));
  // The two rules the second pass adds, restated after the calibration: rule 7 names its target positively (the model read "do not leave the card inside an episode" as "a card anywhere is forbidden"), rule 8 says the SAME line (the model read any two captions as a split).
  assert.ok(
    system.includes(
      '7. If the source shows its own episode break - a flare or light leak with a vertical "TO BE CONTINUED" card, or a fade to black - that is where the original episode ended. The best cut is the FIRST frame after the source\'s card: the option whose END tiles finish on the card and whose cut tile is already the next shot. The card belongs at the END of this episode, so a card before the cut is the target, not a fault. Only two things are faults: a cut tile that still shows the card, flare or fade (the next episode opens on it), and a cut a second or more after the card ends (the card is buried inside an episode with more story after it).'
    )
  );
  assert.ok(
    system.includes(
      "8. If the SAME subtitle line (the same words) shows on the last tile before the cut AND on the cut tile, the cut splits a spoken line; do not choose it, whatever the dialogue list says: the transcript misses voice-overs and shouted lines, the burned captions do not. One line ending before the cut and a different line starting after it is not a split."
    )
  );
  assert.ok(!system.includes("do not leave the card inside an episode"), "the clause the model read backwards is gone");
  // The reading block: the cut tile of the OPTION strips (a dense strip gets its own line), which tiles are this episode and which the next, the motion flag as a detector reading, the dialogue list as no evidence of the picture.
  assert.ok(system.includes("READING THE STRIPS AND THE FACTS"));
  assert.ok(system.includes("- In every OPTION strip the cut is tile 6, the LAST tile of the FIRST row. Tiles 1-5 are the last 2.5 s of THIS episode; tile 6 and the whole second row are the first 3 s of the NEXT one. ends_on describes only tiles 1-5 of the chosen option's own image, opens_on only tile 6 onward. Describe only what that image shows - never what another option's image or the dialogue list shows."));
  assert.ok(!system.includes("In the DENSE strip"), "the reviewer sees no dense strip, so no dense line");
  assert.ok(system.includes("Your choice must agree with your own entry for it"));
  assert.match(OptionSeenSchema.shape.card_or_flare.description ?? "", /before_cut = the card ends before the cut and the cut tile is the next shot \(what rule 7 asks for\)/);
  assert.match(OptionSeenSchema.shape.caption_across_cut.description ?? "", /the SAME burned-in subtitle line \(the same words\) shows on the last tile before the cut AND on the cut tile/);
  assert.ok(system.includes('- "motion" comes from a motion detector, not a person. It also fires on flares, card transitions, fades, camera moves and walking. Only a punch, slap, push, grab, throw, fall, collision or something flying counts as a physical action for rules 2-4; a blink, a head turn, a hand gesture, a walk or a camera move does not. A grab means seizing a person (an arm, a collar, hair) or snatching something by force; handing over, receiving, holding or reading an object is not a physical action for rules 2-4. Judge from the frames; the motion numbers are never the time of an impact.'));
  assert.match(OptionSeenSchema.shape.physical_action_across_cut.description ?? "", /a grab seizes a person - an arm, a collar, hair - or snatches something by force; handing over, receiving, holding or reading an object is not one/, "the grab defined where the action is recorded (3983.433: a document handed over was called a grab)");
  assert.ok(system.includes("When ANY option's entry shows the card, flare or fade, the source's break is at this boundary and the cut belongs on the first frame after it"));
  assert.ok(system.includes("- The dialogue list is whisper's transcript: times are where lines START, it misses voice-overs and shouting, and a line can be many seconds from the cut. It is never evidence of what is on screen."));
  assert.ok(!system.includes("Every strip is labelled"), "raw strips: no labelling note");
  assert.ok(system.includes("HARD PRECONDITION"));
  assert.ok(system.includes("About this film:\nA ~1.7 s TO BE CONTINUED card"));
  assert.ok(system.includes("First fill options_seen"));
  assert.ok(system.includes("Judge the options as PAIRS"));
  assert.ok(system.includes("Copy chosen_t EXACTLY"));
  assert.ok(a.system[0].cache, "the rules are the cached prefix; the boundary is the user turn");
  assert.ok(!system.includes("315.533"), "the neighbours are in the user turn, not the cached prefix");
  assert.deepEqual(a.images, input.strips.map((s) => ({ media_type: "image/png", path: s.path })));
  assert.match(a.user, /^BOUNDARY 424.433s/);
  assert.ok(a.user.includes("Every episode must be 95-150 s long. The planner's neighbouring boundaries are at 315.533s and 528.9s, so this cut must lie between 410.533s and 433.9s."), "the band as a range with the neighbours (the diagnosis's sentence)");
  assert.match(a.user, /opt1 at 424.433s \[is_dp_pick\] - image 1/);
  assert.match(a.user, /opt2 at 433.1s - image 2/);
  assert.match(a.user, /tiles: 421.933, 422.433, 422.933, 423.433, 423.933, 424.433, 424.933, 425.433, 425.933, 426.433, 426.933/);
  assert.match(a.user, /motion detector: still at the cut \(motion 4.13s before, 22.17s after\)/);
  assert.ok(!/line before:/.test(a.user), "the option block no longer repeats the dialogue lines without their times");
  assert.ok(!/INSIDE an action/.test(a.user));
  assert.match(a.user, /\[412.7s\] Yet he fathered a child behind our backs/);
  assert.match(a.user, /Choose one of opt1, opt2\./);
  // An option inside the source's card is marked, and the check refuses it (rule 7); the first frame after the card is not.
  const carded = buildBoundaryReview({ ...input, range, card_spans: [{ from_s: 433.1, to_s: 435.1, why: null }] });
  assert.match(carded.user, /opt2 at 433.1s - image 2\n  tiles: [^\n]+\n  motion detector[^\n]+\n  ON THE CARD: 433.1s is inside the source's own card 433.1-435.1s; the next episode would open on the card \(rule 7\)\. The first frame after it is 435.1s\./);
  assert.ok(!/ON THE CARD/.test(buildBoundaryReview({ ...input, range, card_spans: [{ from_s: 431.1, to_s: 433.1, why: null }] }).user), "a cut on the first frame after the card is the right cut");
  // An option outside the range is marked, and the check refuses it.
  const tight = { prev: 315.533, next: 500, ...allowedRange(315.533, 500, [95, 150]) };
  const marked = buildBoundaryReview({ ...input, range: tight });
  assert.match(marked.user, /opt2 at 433.1s - image 2\n  tiles: [^\n]+\n  motion detector[^\n]+\n  OUT OF RANGE: 433.1s is outside 410.533-405s/);

  const seen = (key: string) => ({ key, ends_on: "e", opens_on: "o", caption_across_cut: false, card_or_flare: "none" as const, physical_action_across_cut: null });
  const good: BoundaryPick = { options_seen: [seen("opt1"), seen("opt2")], chosen_key: "opt2", chosen_t: 433.1, ends_on: "x", opens_on: "y", why: "z", rejected: null, payoff_in_episode: true, confidence: 0.75 };
  assert.equal(a.check(good), null);
  assert.match(a.check({ ...good, chosen_key: "opt9" })!, /chosen_key "opt9" is not one of opt1, opt2/);
  assert.match(a.check({ ...good, chosen_t: 433 })!, /chosen_t must be exactly 433.1 for opt2/);
  assert.match(a.check({ ...good, confidence: 1.5 })!, /0 to 1/);
  assert.match(a.check({ ...good, options_seen: [seen("opt1")] })!, /options_seen must have exactly one entry per option \(opt1, opt2\): missing \["opt2"\]/);
  assert.match(a.check({ ...good, options_seen: [seen("opt1"), seen("opt2"), seen("opt2")] })!, /repeated \["opt2"\]/);
  assert.match(marked.check(good)!, /opt2 at 433.1s is outside the allowed range 410.533-405s/);
  assert.match(carded.check(good)!, /opt2 at 433.1s is inside the source's own card 433.1-435.1s: the next episode would open on the card \(rule 7\)/);
  assert.equal(carded.check({ ...good, chosen_key: "opt1", chosen_t: 424.433 }), null);
  // A refusal (confidence 0) chooses nothing, but it must be a real one: every strip was attached, so the why names the image it could not read (the calibration recorded a why of "placeholder" as a refusal).
  const refused = { ...good, chosen_key: "none", chosen_t: 0, confidence: 0 };
  assert.equal(a.check({ ...refused, why: "image 2 (opt2) is blank: none of its tiles rendered" }), null, "a refusal that names the unreadable image is not repaired");
  assert.match(a.check(refused)!, /^confidence 0 is a refusal to judge: every option strip was rendered and attached to this call before it was made, so why must say which image is missing or unreadable/);
  assert.match(a.check({ ...refused, why: "placeholder" })!, /confidence 0 is a refusal/);
  assert.match(a.check({ ...refused, why: "I could not decide between the two options here" })!, /confidence 0 is a refusal/, "twenty characters that name no image");
  assert.match(a.check({ ...refused, why: "image 2 (opt2) is blank: none of its tiles rendered", options_seen: [seen("opt1")] })!, /options_seen must have exactly one entry per option/, "a refusal still covers every option");
  assert.equal(refusalProblem("opt3's strip is garbled below the first row"), null);
  assert.match(refusalProblem("n/a")!, /confidence 0 is a refusal/);
  // A pick the reviewer's own options_seen contradicts is refused (the calibration had cap=true chosen at 2429, a real split): a caption across the cut, the card on or after the cut tile, an action across the cut.
  const contradicted = (entry: Partial<OptionSeen>) => ({ ...good, options_seen: [seen("opt1"), { ...seen("opt2"), ...entry }] });
  assert.match(a.check(contradicted({ caption_across_cut: true }))!, /^your own options_seen says opt2 shows the same subtitle line on the last tile before the cut and on the cut tile, a split spoken line \(rule 8\); choose another option or refuse with confidence 0$/);
  assert.match(a.check(contradicted({ card_or_flare: "across_cut" }))!, /your own options_seen says opt2 still shows the card, flare or fade on its cut tile, so the next episode would open on it \(rule 7\); choose another option or refuse with confidence 0/);
  assert.match(a.check(contradicted({ card_or_flare: "after_cut" }))!, /your own options_seen says opt2 shows the card after its cut, so the cut comes before the source's break and buries the card \(rule 7\); choose another option/);
  assert.match(a.check(contradicted({ physical_action_across_cut: "a slap landing" }))!, /your own options_seen says opt2 cuts inside a physical action \(a slap landing; rule 2\); choose another option/);
  assert.equal(a.check(contradicted({ card_or_flare: "before_cut" })), null, "the card ending before the cut is what rule 7 asks for");
  assert.equal(a.check(contradicted({ physical_action_across_cut: "none" })), null, '"none" written for null is not an action');
  assert.equal(a.check({ ...good, options_seen: [{ ...seen("opt1"), caption_across_cut: true }, seen("opt2")] }), null, "a fault on another option does not touch the choice");
  assert.equal(selfContradiction({ options_seen: [], chosen_key: "opt2" }), null);
  assert.equal(a.check({ ...contradicted({ caption_across_cut: true }), confidence: 0, why: "opt2 splits a line and opt1 cuts mid-throw: no option is clean" }), null, "refusing with confidence 0, saying why, is the way out the message names");
  // Rule 7's target among the options: a chosen option marked before_cut while an EARLIER choosable option is marked the same, clean, is refused (2324.933 chose opt6 two seconds after the card over opt5).
  const afterCard = (key: string) => ({ ...seen(key), card_or_flare: "before_cut" as const });
  assert.match(a.check({ ...good, options_seen: [afterCard("opt1"), afterCard("opt2")] })!, /^your own options_seen says opt1 is also after the card and earlier; rule 7's target is the FIRST frame after the card; choose it or explain with confidence 0$/);
  assert.equal(a.check({ ...good, options_seen: [afterCard("opt1"), afterCard("opt2")], chosen_key: "opt1", chosen_t: 424.433 }), null, "the earliest one is the target");
  assert.equal(a.check({ ...good, options_seen: [{ ...afterCard("opt1"), caption_across_cut: true }, afterCard("opt2")] }), null, "an earlier option that splits a line is no target");
  assert.equal(a.check({ ...good, options_seen: [{ ...afterCard("opt1"), physical_action_across_cut: "a slap" }, afterCard("opt2")] }), null);
  const tightBefore = { prev: 315.533, next: 528.9, ...allowedRange(315.533, 528.9, [95, 150]) };
  const early = buildBoundaryReview({ ...input, range: { ...tightBefore, lo: 430 } });
  assert.equal(early.check({ ...good, options_seen: [afterCard("opt1"), afterCard("opt2")] }), null, "an earlier option outside the range cannot be chosen, so it is no target");
  // The shape of 2324.933: seven options, opt5 and opt6 both marked before_cut, opt6 chosen.
  const seven = ["opt1", "opt2", "opt3", "opt4", "opt5", "opt6", "opt7"].map((k, i) => ({ key: k, t: 2310 + i * 3 }));
  const shape = { options_seen: seven.map((o) => (o.key === "opt5" || o.key === "opt6" ? afterCard(o.key) : seen(o.key))), chosen_key: "opt6" };
  assert.match(selfContradiction(shape, seven)!, /^your own options_seen says opt5 is also after the card and earlier/);
  assert.equal(selfContradiction({ ...shape, chosen_key: "opt5" }, seven), null);
  assert.equal(selfContradiction(shape, seven.filter((o) => o.key !== "opt5")), null, "opt5 not choosable (out of range or on a card): opt6 stands");
  assert.match(selfContradiction(shape)!, /opt5 is also after the card and earlier/, "without the times, option order is time order");
  // The Claude arms' miss: the chosen option's entry shows no card while another option's does, so the cut is on the wrong side of the source's break.
  // 3276.333 (Sonnet chose 3265.967; the card showed after the later options' cuts): the break plays inside the next episode.
  const cardAfter = { options_seen: seven.map((o) => (o.key === "opt5" ? { ...seen(o.key), card_or_flare: "after_cut" as const } : seen(o.key))), chosen_key: "opt2" };
  assert.match(selfContradiction(cardAfter, seven, seven)!, /^your own options_seen says opt5 \(after_cut\) shows the source's card, flare or fade while opt2 shows none: the card lands after your cut at 2313s, so the source's break would play inside the next episode \(rule 7: the best cut is the first frame after the card\); no listed option is marked as the first frame after the card, so refuse with confidence 0 and name the option whose strip shows the card and where the card ends$/);
  // 4313.4 (Opus chose 4334.7, eighteen seconds after the card): the card buried inside this episode.
  const cardBefore = { options_seen: seven.map((o) => (o.key === "opt2" ? { ...seen(o.key), card_or_flare: "across_cut" as const } : seen(o.key))), chosen_key: "opt7" };
  assert.match(selfContradiction(cardBefore, seven, seven)!, /opt2 \(across_cut\) shows the source's card, flare or fade while opt7 shows none: the card lands before your cut at 2328s, so the card would be buried inside this episode with more story after it/);
  // When an entry marks the first frame after the card, the message names it.
  const target = { options_seen: seven.map((o) => (o.key === "opt3" ? afterCard(o.key) : o.key === "opt2" ? { ...seen(o.key), card_or_flare: "across_cut" as const } : seen(o.key))), chosen_key: "opt6" };
  assert.match(selfContradiction(target, seven, seven)!, /the card lands before your cut at 2325s[^;]+; choose opt3, which your entries mark as the first frame after the card$/);
  assert.match(selfContradiction(cardAfter)!, /the card lands near your cut/, "without the times the direction is left open");
  assert.equal(selfContradiction({ ...target, chosen_key: "opt3" }, seven, seven), null, "the first frame after the card is the target");
  assert.match(a.check({ ...good, options_seen: [{ ...seen("opt1"), card_or_flare: "across_cut" }, seen("opt2")] })!, /opt1 \(across_cut\) shows the source's card, flare or fade while opt2 shows none: the card lands before your cut at 433.1s/, "through the reviewer's check");
  assert.equal(a.check({ ...good, options_seen: [{ ...seen("opt1"), card_or_flare: "across_cut" }, seen("opt2")], confidence: 0, chosen_key: "none", chosen_t: 0, why: "opt1's strip shows the card across its cut and it ends between opt1 and opt2: no listed option is the first frame after the card" }), null, "the honest refusal names the card");
  assert.equal(refusalProblem("the card ends at 4316.9s, between the listed options"), null, "a refusal may name the card instead of an unreadable image");
  assert.ok(BoundaryPickSchema.safeParse(good).success);
  assert.deepEqual(Object.keys(BoundaryPickSchema.shape)[0], "options_seen", "what each strip shows is recorded before the choice");
  assert.throws(() => buildBoundaryReview({ ...input, strips: input.strips.slice(1) }), /1 strips for 2 options/);

  // Annotated strips: the prompt says so.
  const labelled = buildBoundaryReview({ ...input, range, strips: input.strips.map((s) => ({ ...s, annotated: true })) });
  assert.ok(labelled.system.map((s) => s.text).join("\n").includes("- Every strip is labelled: the header names the option and its cut time, each tile carries its own time in the top-left corner, tiles before the cut are marked END and tiles from the cut on are marked NEXT, and the cut tile has a red frame."));
  // The fixture's own neighbours (two boundaries 4000 s apart): the range comes out inverted and the prompt still states it.
  const own = neighboursOf(input.doc, 424.433, 0);
  assert.deepEqual(own, { prev: 0, next: 4550.267 });
});

test("the skeptic prompt restates the pick, lists only the legal cuts it has seen, takes the dense strip last, asks for a cited fault, and its check admits only seen, in-range times as a fix", async () => {
  const input = await reviewInput(FIXTURE_CUT, 4550.267);
  const seen = (key: string) => ({ key, ends_on: "e", opens_on: "o", caption_across_cut: false, card_or_flare: "none" as const, physical_action_across_cut: null });
  const pick: BoundaryPick = { options_seen: [seen("opt1"), seen("opt2")], chosen_key: "opt1", chosen_t: 4550.267, ends_on: "Helen's half-smile.", opens_on: "The hallway wide shot.", why: "Clean shot change.", rejected: "opt2 is in action.", payoff_in_episode: true, confidence: 0.8 };
  const cands = await loadCandidates(FIXTURE_CUT);
  const dense: StripImage = { key: "dense", t: 4550.267, path: path.join(FIXTURE_CUT, "review", "frames", "b4550_opt1.png"), rel: "dense.png", media_type: "image/png", tiles: stripTiles(4550.267, 3, 0.1), cols: 10, step: 0.1 };
  const range = { prev: 4450, next: 4680, ...allowedRange(4450, 4680, [95, 150]) };
  assert.deepEqual(range, { prev: 4450, next: 4680, lo: 4545, hi: 4585 });
  const legal = legalCutsInView(cands, [...input.strips, dense], range);
  assert.deepEqual(legal.map((c) => c.t), [4550.267, 4572.067], "of the four legal cuts within 30 s only the two option centres are tiles of an image; 4520.767 and 4524.567 were never seen");
  assert.deepEqual(legalCutsNear(cands, 4550.267).map((c) => c.t), [4520.767, 4524.567, 4550.267, 4572.067]);
  const base = { boundary: input.boundary, strips: input.strips, pick, dense, legal_cuts: legal, layout: input.layout, band: input.band, range, film_notes: null, provider: "anthropic" as const, model: "claude-sonnet-5" };
  const a = buildBoundarySkeptic(base);
  const b = buildBoundarySkeptic(base);
  assert.deepEqual({ s: a.system, u: a.user, i: a.images }, { s: b.system, u: b.user, i: b.images });
  assert.equal(a.name, "verify_boundaries_verify");
  const system = a.system.map((s) => s.text).join("\n");
  assert.ok(system.includes("Your job is to REFUTE it if you can."));
  assert.ok(system.includes(BOUNDARY_RULES));
  assert.ok(system.includes("READING THE STRIPS AND THE FACTS"));
  assert.ok(system.includes("- is another listed option strictly better on rules 2-4?"));
  assert.ok(system.includes("- does their reasoning rest on something the frames do not show?"));
  assert.ok(system.includes("Disagree only for a fault you can SEE: name the image number and the tile time where it shows, and what is in that tile. A fault taken from the other reviewer's description, from the dialogue list or from the motion numbers is not a fault. Do not manufacture a disagreement over taste: if the choice is sound, or the frames do not settle it, set agree=true and say what is uncertain in reason."));
  assert.ok(!system.includes("Default to agree=false"), "the first pass's close is gone");
  assert.ok(system.includes("A fix must be a time you have looked at: a listed option (better_key and its exact t) or a legal cut inside one of the attached images"));
  assert.ok(system.includes("DENSE strip"));
  // The reading block names the dense strip's cut tile from its own layout: 31 tiles, 10 per row, the cut at tile 16, so tile 6 is a second BEFORE it (the tie-break at 4099.367 read the card off tile 6 as the cut tile).
  assert.ok(system.includes("- In every OPTION strip the cut is tile 6"));
  assert.ok(system.includes("- In the DENSE strip (31 tiles 0.1 s apart, 10 per row) the cut is tile 16 (row 2, tile 6 of that row, the centre tile); its tile 6 is 1 s BEFORE the cut. Its tiles 1-15 are THIS episode, tile 16 on the NEXT."));
  assert.ok(system.includes("the chosen cut at the tile the READING block names for it (not tile 6)"));
  assert.equal(denseReadingLine(dense, 6, { annotated: true }), "- In the DENSE strip (31 tiles 0.1 s apart, 10 per row) the cut is tile 16 (row 2, tile 6 of that row, the red-framed tile); its tile 6 is 1 s BEFORE the cut. Its tiles 1-15 are THIS episode, tile 16 on the NEXT.");
  assert.equal(denseReadingLine({ tiles: stripTiles(10, 1, 0.1), cols: 6, step: 0.1, t: 10 }, 6), "- In the DENSE strip (11 tiles 0.1 s apart, 6 per row) the cut is tile 6 (row 1, tile 6 of that row, the centre tile); its tile 6 is the cut. Its tiles 1-5 are THIS episode, tile 6 on the NEXT.");
  assert.ok(!buildBoundarySkeptic({ ...base, dense: null, legal_cuts: [] }).system.map((s) => s.text).join("\n").includes("In the DENSE strip"), "no dense strip, no dense line");
  assert.ok(system.includes("- does the SAME subtitle line show on the last tile before the cut and on the cut tile (rule 8)? One line ending before the cut and a different line starting after it is not a split."));
  assert.ok(system.includes("A card that ends before the cut, with the cut tile already the next shot, is the target, not a fault."));
  assert.ok(a.user.includes("A fix must be a time you have looked at: a listed option (better_key and its exact t) or a legal cut inside one of the attached images, and it must keep this cut between 4545s and 4585s. If the only fix is a time you have not seen, give no fix - the boundary then goes to a person."));
  assert.match(a.user, /The other reviewer chose opt1 at 4550.267s \(its own strip is image 1; the dense strip is image 3\)\./);
  assert.match(a.user, /They said the episode ends on: Helen's half-smile\./);
  assert.match(a.user, /LEGAL CUTS you have looked at/);
  assert.match(a.user, /4550.267s \(a listed option\)/);
  assert.ok(!a.user.includes("4524.567"), "a legal cut no image shows is not offered");
  assert.match(a.user, /DENSE STRIP around 4550.267s - image 3/);
  assert.equal(a.images.length, 3, "two option strips, then the dense strip");
  assert.equal(a.images[2].path, dense.path);
  assert.deepEqual(Object.keys(BoundaryVerdictSchema.shape).slice(0, 5), ["chosen_strip_shows", "chosen_caption_across_cut", "chosen_card_or_flare", "chosen_action_across_cut", "agree"], "what the chosen strip shows, and what its own images say for rules 8, 7 and 2, are recorded before the verdict");
  assert.match(a.user, /The other reviewer chose opt1 at 4550.267s \(its own strip is image 1; the dense strip is image 3\)\./);
  assert.ok(system.includes("A fault names the rule it breaks (fault_rule) and shows on an image of the CHOSEN cut"));
  assert.ok(system.includes("an observed split caption, a card on or after the cut tile, or an action across the cut is a fault you must dispute, never waive"));

  const agree: BoundaryVerdict = { chosen_strip_shows: "a half-smile, then the hallway", chosen_caption_across_cut: false, chosen_card_or_flare: "none", chosen_action_across_cut: null, agree: true, fault: null, fault_rule: null, fault_image: null, fault_tile_t: null, fault_tile_shows: null, better_key: null, better_t: null, reason: "Holds." };
  // A fault on the chosen cut's own strip (image 1, opt1 at 4550.267): rule 3, whose tile may lie anywhere on that image.
  const dispute = (extra: Partial<BoundaryVerdict>): BoundaryVerdict => ({ ...agree, agree: false, fault: "Rule 3", fault_rule: "3", fault_image: 1, fault_tile_t: 4551.267, fault_tile_shows: "the slap still to come", better_key: null, better_t: null, reason: "...", ...extra });
  assert.equal(a.check(agree), null);
  assert.match(a.check({ ...agree, better_t: 4572.067 })!, /you agreed: better_key and better_t must be null/);
  assert.equal(a.check(dispute({ better_key: "opt2", better_t: 4572.067 })), null);
  assert.match(a.check(dispute({ better_key: "opt2", better_t: 4572 }))!, /better_t must be exactly 4572.067 for opt2/);
  assert.match(a.check(dispute({ better_key: "opt1", better_t: 4550.267 }))!, /is the option you are disputing/);
  assert.match(a.check(dispute({ better_key: "opt7", better_t: 1 }))!, /better_key "opt7" is not a listed option/);
  assert.match(a.check(dispute({ better_t: 4524.567 }))!, /better_t 4524.567 is not a listed option or a legal cut you have looked at/);
  assert.match(a.check(dispute({ better_t: 4551.111 }))!, /not a listed option or a legal cut you have looked at/);
  assert.equal(a.check(dispute({})), null, "a cited fault without a fix is allowed; apply_vision then reports it");
  // The citation: both fields or neither, an attached image, a tile of that image.
  assert.match(a.check(dispute({ fault_image: null }))!, /cite both fault_image and fault_tile_t, or neither/);
  assert.match(a.check(dispute({ fault_image: 4 }))!, /fault_image 4 is not an attached image \(1-3\)/);
  assert.match(a.check(dispute({ fault_image: 1, fault_tile_t: 4569.567 }))!, /fault_tile_t 4569.567 is not a tile of image 1/);
  assert.equal(a.check(dispute({ fault_image: 3, fault_tile_t: 4550.967 })), null, "a dense tile");
  assert.equal(citationProblem({ fault_image: null, fault_tile_t: null }, a.images.map(() => ({ tiles: [] }))), null, "no citation is not a repair; the guard ignores the fault instead");
  assert.ok(BoundaryVerdictSchema.safeParse(agree).success);
  // The citation must show the CHOSEN cut (2662.667 cited opt1's strip against the chosen opt6) and the tile must carry the rule: rule 7 at or after the cut (3033.867 cited an END tile under the card, rule 7's own target), rule 8 on the last tile before the cut or the cut tile, rules 2 and 4 within 1.5 s.
  assert.deepEqual(citationContextOf(input.strips, 4550.267, true), { chosen_image: 1, dense_image: 3, cut_t: 4550.267 });
  assert.deepEqual(citationContextOf(input.strips, 4572.067, false), { chosen_image: 2, dense_image: null, cut_t: 4572.067 });
  assert.equal(citationContextOf(input.strips, 4560, true), null);
  assert.match(a.check(dispute({ fault_image: 2, fault_tile_t: 4569.567 }))!, /^fault_image 2 does not show the chosen cut at 4550.267s: a fault must show on the chosen option's own strip \(image 1\) or the dense strip \(image 3\), not on another option's strip, whose cut is another time$/);
  assert.match(a.check(dispute({ fault_rule: null }))!, /^name fault_rule: the standing decision \(2, 3, 4, 5, 6, 7, 8\) the fault breaks$/);
  assert.match(a.check(dispute({ fault_rule: "7", fault_tile_t: 4549.767, chosen_card_or_flare: "across_cut" }))!, /^fault_tile_t 4549.767 is an END tile, before the cut at 4550.267s: a rule-7 fault is the card, flare or fade still on the CUT tile, or on a tile after it, so cite a tile at or after the cut\. A card that ends before the cut, with the cut tile already the next shot, is the target: the card belongs at the END of this episode, so a card before the cut is the target, not a fault$/);
  assert.equal(a.check(dispute({ fault_rule: "7", fault_tile_t: 4550.267, chosen_card_or_flare: "across_cut" })), null, "the card on the cut tile");
  assert.equal(a.check(dispute({ fault_rule: "7", fault_image: 3, fault_tile_t: 4550.367, chosen_card_or_flare: "across_cut" })), null, "a dense tile after the cut");
  assert.match(a.check(dispute({ fault_rule: "8", fault_tile_t: 4551.267, chosen_caption_across_cut: true }))!, /^fault_tile_t 4551.267 cannot show a split line: a rule-8 fault is the SAME subtitle line on the last tile before the cut AND on the cut tile, so cite one of those two tiles of that image \(4549.767 or 4550.267\)$/);
  assert.equal(a.check(dispute({ fault_rule: "8", fault_tile_t: 4549.767, chosen_caption_across_cut: true })), null, "the last tile before the cut");
  assert.equal(a.check(dispute({ fault_rule: "8", fault_image: 3, fault_tile_t: 4550.167, chosen_caption_across_cut: true })), null, "the dense strip's last tile before the cut");
  assert.match(a.check(dispute({ fault_rule: "8", fault_image: 3, fault_tile_t: 4549.767, chosen_caption_across_cut: true }))!, /cite one of those two tiles of that image \(4550.167 or 4550.267\)/);
  assert.match(a.check(dispute({ fault_rule: "2", fault_tile_t: 4552.267, chosen_action_across_cut: "a slap" }))!, /^fault_tile_t 4552.267 is 2 s from the cut at 4550.267s: a rule-2 fault \(a cut inside a physical action\) shows within 1.5 s of the cut$/);
  assert.match(a.check(dispute({ fault_rule: "4", fault_tile_t: 4548.267 }))!, /a rule-4 fault \(no aftermath after an impact\) shows within 1.5 s of the cut/);
  assert.equal(a.check(dispute({ fault_rule: "4", fault_tile_t: 4551.767 })), null, "1.5 s away");
  assert.equal(a.check(dispute({ fault_rule: "5", fault_tile_t: 4552.767 })), null, "rules 3, 5 and 6 have no tile-position rule");
  assert.equal(faultRuleProblem(null, 1, { tiles: [1] }, 1), null);
  // The verdict must agree with the skeptic's own chosen_* observations (2541.067 saw the split caption and waived it).
  assert.match(a.check({ ...agree, chosen_caption_across_cut: true })!, /^your own chosen_caption_across_cut says the same subtitle line shows on the last tile before the chosen cut and on its cut tile, a split spoken line \(rule 8\); set agree=false and cite the tile \(fault_image, fault_tile_t, fault_rule\)$/);
  assert.match(a.check({ ...agree, chosen_card_or_flare: "across_cut" })!, /your own chosen_card_or_flare says the cut tile still shows the card, flare or fade, so the next episode would open on it \(rule 7\); set agree=false/);
  assert.match(a.check({ ...agree, chosen_card_or_flare: "after_cut" })!, /your own chosen_card_or_flare says the card shows after the chosen cut, so the cut comes before the source's break and buries the card \(rule 7\); set agree=false/);
  assert.match(a.check({ ...agree, chosen_action_across_cut: "a punch landing" })!, /your own chosen_action_across_cut says the chosen cut is inside a physical action \(a punch landing; rule 2\); set agree=false/);
  assert.equal(a.check({ ...agree, chosen_card_or_flare: "before_cut" }), null, "the card ending before the cut is what rule 7 asks for");
  assert.equal(a.check({ ...agree, chosen_action_across_cut: "none" }), null);
  assert.match(a.check(dispute({ fault_rule: "8", fault_tile_t: 4550.267 }))!, /^your own chosen_caption_across_cut says no subtitle line runs across the chosen cut, which contradicts a rule-8 fault/);
  assert.match(a.check(dispute({ fault_rule: "7", fault_tile_t: 4550.267 }))!, /^your own chosen_card_or_flare says no card, flare or fade shows in the chosen cut's images, which contradicts a rule-7 fault/);
  assert.match(a.check(dispute({ fault_rule: "7", fault_tile_t: 4550.267, chosen_card_or_flare: "before_cut" }))!, /your own chosen_card_or_flare says the card ends before the cut and the cut tile is already the next shot, which is what rule 7 asks for/);
  assert.equal(verdictContradiction({ agree: false, fault_rule: "3", chosen_caption_across_cut: false, chosen_card_or_flare: "none", chosen_action_across_cut: null }), null);
  // A fix outside the range is refused even when listed; so is one inside the source's card.
  const narrow = buildBoundarySkeptic({ ...base, range: { prev: 4450, next: 4660, ...allowedRange(4450, 4660, [95, 150]) } });
  assert.match(narrow.check(dispute({ better_key: "opt2", better_t: 4572.067 }))!, /opt2 at 4572.067s is outside the allowed range 4545-4565s/);
  const carded = buildBoundarySkeptic({ ...base, card_spans: [{ from_s: 4572.067, to_s: 4574.1, why: null }] });
  assert.match(carded.user, /opt2 at 4572.067s - image 2\n(?:[^\n]+\n){2}  ON THE CARD: 4572.067s is inside the source's own card 4572.067-4574.1s/);
  assert.match(carded.check(dispute({ better_key: "opt2", better_t: 4572.067 }))!, /opt2 at 4572.067s is inside the source's own card 4572.067-4574.1s: the next episode would open on the card \(rule 7\); name a fix outside it, or no fix/);
  assert.match(carded.check(dispute({ better_t: 4572.067 }))!, /better_t 4572.067 is inside the source's own card/);

  const noDense = buildBoundarySkeptic({ ...base, dense: null, legal_cuts: [] });
  assert.equal(noDense.images.length, 2);
  assert.match(noDense.user, /\(none beyond the listed options: only a listed option can be a fix\)/);
  assert.match(noDense.check(dispute({ better_t: 4520.767 }))!, /not a listed option or a legal cut you have looked at/);
});

test("the tie-break prompt shows both cuts blind, in the order the hash gives, with their images and no reasoning from either side", async () => {
  const input = await reviewInput(FIXTURE_CUT, 4550.267);
  const denseAt = (t: number, rel: string): StripImage => ({ key: "dense", t, path: path.join(FIXTURE_CUT, "review", "frames", "b4550_opt1.png"), rel, media_type: "image/png", tiles: stripTiles(t, 3, 0.1), cols: 10, step: 0.1, annotated: true });
  const strips = input.strips.map((s) => ({ ...s, annotated: true }));
  const sides: [TiebreakSide, TiebreakSide] = [
    { label: "A", t: 4572.067, option_key: "opt2", images: [strips[1], denseAt(4572.067, "dense_b.png")] },
    { label: "B", t: 4550.267, option_key: "opt1", images: [strips[0], denseAt(4550.267, "dense_a.png")] },
  ];
  const range = { prev: 4450, next: 4680, ...allowedRange(4450, 4680, [95, 150]) };
  const a = buildBoundaryTiebreak({ boundary: input.boundary, sides, layout: input.layout, band: input.band, range, film_notes: "A card marks the breaks.", provider: "anthropic", model: "claude-sonnet-5" });
  assert.equal(a.name, "verify_boundaries_tiebreak");
  assert.equal(a.prompt_version, `${BOUNDARY_RULE_VERSION}:tiebreak-v4`, "the fault tiles changed the schema, then the fault rules, then the grab definition");
  assert.equal(a.toolChoice, "auto");
  assert.match(TiebreakSchema.shape.a_fault_tile_t.description ?? "", /grab of a person, throw or fall; handing over or holding an object is none/);
  const system = a.system.map((s) => s.text).join("\n");
  assert.ok(system.includes("You are not told who proposed which, and you are given no reasoning from either side."));
  assert.ok(system.includes(BOUNDARY_RULES));
  assert.ok(system.includes("Every strip is labelled"));
  assert.ok(system.includes("About this film:\nA card marks the breaks."));
  // The strip layouts come from the attached images, not a hardcoded "0.1s apart, 10 per row", and the reading block names the dense strip's own cut tile.
  assert.ok(system.includes("An option strip shows 11 frames 0.5s apart, 6 per row, the cut at tile 6. A DENSE strip shows 31 frames 0.1s apart, 10 per row, the cut at tile 16. Each side's images are listed with their tile times."));
  assert.ok(system.includes("- In the DENSE strip (31 tiles 0.1 s apart, 10 per row) the cut is tile 16 (row 2, tile 6 of that row, the red-framed tile); its tile 6 is 1 s BEFORE the cut."));
  assert.ok(!system.includes("0.1s apart, 10 per row, with the cut at its centre tile"));
  assert.equal(tiebreakLayoutLine([{ key: "dense", t: 10, tiles: stripTiles(10, 2, 0.1), cols: 7, step: 0.1 }], input.layout), "An option strip shows frames 0.5s apart, 6 per row, the cut at tile 6. A DENSE strip shows 21 frames 0.1s apart, 7 per row, the cut at tile 11. Each side's images are listed with their tile times.");
  assert.ok(system.includes("The losing side must carry a fault tile"));
  assert.ok(system.includes("The winner carries none: a cut whose own fault tile you have cited cannot win. Pick neither only when both cuts break a rule, each with its fault tile cited."));
  assert.match(a.user, /^BOUNDARY 4550.267s/);
  assert.match(a.user, /CUT A at 4572.067s \(listed option opt2; motion detector: moving at the cut/);
  assert.match(a.user, /  image 1: option strip, 0.5s steps, cut at tile 6; tiles: 4569.567/);
  assert.match(a.user, /  image 2: dense strip, 0.1s steps, cut at tile 16; tiles: 4570.567/);
  assert.match(a.user, /CUT B at 4550.267s \(listed option opt1; motion detector: still at the cut \(motion 31.67s before, 15.83s after\)\)/);
  assert.match(a.user, /  image 3: option strip/);
  assert.match(a.user, /  image 4: dense strip/);
  assert.ok(!/Helen|Clean shot change|reviewer|skeptic/i.test(a.user), "no reasoning and no side named");
  const carded = buildBoundaryTiebreak({ boundary: input.boundary, sides, layout: input.layout, band: input.band, range, card_spans: [{ from_s: 4572.067, to_s: 4574.1, why: null }], film_notes: null, provider: "anthropic", model: "claude-sonnet-5" });
  assert.match(carded.user, /CUT A at 4572.067s \(listed option opt2[^\n]+\n  ON THE CARD: 4572.067s is inside the source's own card 4572.067-4574.1s/);
  assert.ok(!/CUT B at 4550.267s[^\n]+\n  ON THE CARD/.test(carded.user));
  assert.equal(a.images.length, 4);
  assert.deepEqual(Object.keys(TiebreakSchema.shape).slice(0, 7), ["a_shows", "b_shows", "a_fault_tile_t", "a_fault_rule", "b_fault_tile_t", "b_fault_rule", "winner"], "what each side shows, where each breaks a rule and which rule are recorded before the verdict");
  const good: TiebreakVerdict = { a_shows: "x", b_shows: "y", a_fault_tile_t: 4572.067, a_fault_rule: "4", b_fault_tile_t: null, b_fault_rule: null, winner: "B", evidence_image: 3, evidence_tile_t: 4550.267, reason: "r" };
  assert.equal(a.check(good), null);
  assert.match(a.check({ ...good, a_shows: " " })!, /a_shows and b_shows must each describe/);
  assert.match(a.check({ ...good, evidence_image: 9 })!, /evidence_image 9 is not an attached image \(1-4\)/);
  assert.match(a.check({ ...good, evidence_image: 1, evidence_tile_t: 4550.267 })!, /evidence_tile_t 4550.267 is not a tile of image 1/);
  // The losing side carries a fault tile of its OWN images; "neither" carries one on each side (the calibration's "neither" at 3152.433 cited nothing and handed off the delivered cut).
  assert.match(a.check({ ...good, a_fault_tile_t: null, a_fault_rule: null })!, /^winner B: cite a_fault_tile_t, the tile of cut A's own images where A breaks a rule; if A breaks none, it is not the loser$/);
  assert.match(a.check({ ...good, a_fault_tile_t: 4550.267 })!, /^a_fault_tile_t 4550.267 is not a tile of cut A's own images \(its tiles: 4569.567..4574.567, 4570.567..4573.567\)$/);
  assert.match(a.check({ ...good, winner: "A", a_fault_tile_t: null, a_fault_rule: null })!, /^winner A: cite b_fault_tile_t/);
  assert.equal(a.check({ ...good, winner: "A", a_fault_tile_t: null, a_fault_rule: null, b_fault_tile_t: 4550.767, b_fault_rule: "4" }), null, "a dense tile of B's own strip");
  assert.match(a.check({ ...good, winner: "A", a_fault_tile_t: null, a_fault_rule: null, b_fault_tile_t: 4569.567, b_fault_rule: "4" })!, /b_fault_tile_t 4569.567 is not a tile of cut B's own images/);
  assert.match(a.check({ ...good, winner: "neither", evidence_image: null, evidence_tile_t: null })!, /^neither: cite a_fault_tile_t AND b_fault_tile_t/);
  assert.equal(a.check({ ...good, winner: "neither", b_fault_tile_t: 4550.267, b_fault_rule: "4", evidence_image: null, evidence_tile_t: null }), null);
  // A winner with its own fault tile cited (2212.567: "Cut B ... splitting a spoken line", winner B, a real rule-8 split applied) is refused: both break a rule, or the winner's tile is cleared.
  assert.match(a.check({ ...good, a_fault_tile_t: 4573.067, b_fault_tile_t: 4551.267, b_fault_rule: "4" })!, /^winner B but b_fault_tile_t cites B's own rule break; if both cuts break a rule answer neither, else clear the winner's fault tile$/);
  assert.match(a.check({ ...good, winner: "A", a_fault_tile_t: 4573.067, b_fault_tile_t: 4551.267, b_fault_rule: "4" })!, /^winner A but a_fault_tile_t cites A's own rule break; if both cuts break a rule answer neither, else clear the winner's fault tile$/);
  assert.equal(a.check({ ...good, winner: "neither", a_fault_tile_t: 4573.067, b_fault_tile_t: 4551.267, b_fault_rule: "4", evidence_image: null, evidence_tile_t: null }), null, "repaired to neither: both cuts break a rule, each with its tile");
  assert.equal(a.check({ ...good, a_fault_tile_t: 4573.067, b_fault_tile_t: null, b_fault_rule: null }), null, "repaired to B with its tile cleared");
  // Each fault tile names its rule, and the tile must carry it against that side's cut (2114.267's tie-break called a card on an END tile "buried").
  assert.match(a.check({ ...good, a_fault_rule: null })!, /^a_fault_tile_t 4572.067 is cited without a_fault_rule: name the standing decision \(2-8\) that tile shows cut A breaking$/);
  assert.match(a.check({ ...good, a_fault_tile_t: null })!, /^a_fault_rule 4 names a rule cut A breaks but a_fault_tile_t is null; cite the tile of A's own images that shows it, or clear the rule$/);
  assert.match(a.check({ ...good, a_fault_tile_t: 4571.567, a_fault_rule: "7" })!, /^a_fault_tile_t 4571.567 is an END tile, before the cut at 4572.067s: a rule-7 fault is the card, flare or fade still on the CUT tile/);
  assert.equal(a.check({ ...good, a_fault_tile_t: 4572.067, a_fault_rule: "7" }), null, "the card on A's cut tile");
  assert.match(a.check({ ...good, a_fault_tile_t: 4573.567, a_fault_rule: "8" })!, /^a_fault_tile_t 4573.567 cannot show a split line: a rule-8 fault is the SAME subtitle line on the last tile before the cut AND on the cut tile, so cite one of those two tiles of that image \(4571.567 or 4572.067\)$/);
  assert.equal(a.check({ ...good, a_fault_tile_t: 4571.967, a_fault_rule: "8" }), null, "the dense strip's last tile before A's cut");
  assert.match(a.check({ ...good, a_fault_tile_t: 4574.567, a_fault_rule: "2" })!, /is 2.5 s from the cut at 4572.067s: a rule-2 fault/);
  assert.throws(() => buildBoundaryTiebreak({ boundary: input.boundary, sides: [sides[0], { ...sides[1], images: [] }], layout: input.layout, band: input.band, film_notes: null, provider: "anthropic", model: "claude-sonnet-5" }), /every side needs at least one image/);
  // The order: a hash of the run, the boundary and the attempt, so a re-run repeats it and another run may differ.
  assert.equal(tiebreakOrder(RUN_ID, 4550.267, 1), tiebreakOrder(RUN_ID, 4550.267, 1));
  const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((n) => tiebreakOrder(`run-${n}`, 4550.267, 1)));
  assert.equal(orders.size, 2, "both orders occur across runs");
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
  const doc = withFillers(await loadOptionsDoc(cut));
  const fake = fakeLlm({ verdict: (b) => (b === 4550.267 ? { agree: false, fault: "Rule 4: no aftermath", fault_rule: "4", fault_image: 1, fault_tile_t: 4550.267, fault_tile_shows: "the slap", better_key: "opt2", better_t: 4572.067 } : {}), tiebreak: 4572.067 });
  const seen: number[] = [];
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut, film_notes: null }, doc, { label: "0-end", llm: fake.llm, concurrency: 3, boundaries: [424.433, 4550.267], onBoundary: (rec_, done, total) => seen.push(done * 100 + total) });
  assert.ok(!isUnavailable(r));
  assert.equal(r.file, path.join(cut, "review", "vision", "0-end.json"));
  assert.equal(r.provider, "anthropic");
  assert.equal(r.model, "claude-opus-5-5", "the judge's own default (decision 2026-09-23, 'The frame judge on Claude, measured'), not the fast tier");
  assert.deepEqual(r.errors, []);
  assert.equal(fake.calls.length, 5, "reviewer + skeptic per boundary, and the tie-break where the skeptic's fix passed the guards");
  assert.deepEqual(r.jobs.map((j) => j.role).sort(), ["look", "look", "tiebreak", "verify", "verify"]);
  assert.ok(r.jobs.every((j) => !j.skipped && j.cost_cents === 2));
  assert.equal(r.cost_cents, 10);
  // The exact price beside the rounded rows: the fake answers as the pass's model (claude-opus-5-5, $4 in and $20 out per million) with 1000 in and 200 out, $0.008 a call.
  assert.ok(r.jobs.every((j) => Math.abs(j.cost_usd - 0.008) < 1e-9), JSON.stringify(r.jobs.map((j) => j.cost_usd)));
  assert.ok(Math.abs(r.cost_usd - 0.04) < 1e-9);
  assert.deepEqual(seen.sort(), [102, 202]);
  for (const c of fake.calls) {
    assert.equal(c.provider, "anthropic");
    assert.equal(c.model, "claude-opus-5-5");
    assert.equal(c.toolChoice, "auto", "every call of the judge asks for tool_choice auto, so the model thinks first");
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
  assert.deepEqual(Object.keys(agreeRec.verdict).sort(), ["agree", "better_key", "evidence", "fault", "guard", "reason", "skeptic_raw"], "no better_t when the skeptic agrees; fault and better_key are empty strings, as the Workflow wrote them; the guard's note, the raw verdict and the evidence ride along");
  assert.equal(agreeRec.verdict.fault, "");
  assert.equal(agreeRec.verdict.guard.outcome, "agreed");
  assert.equal("rejected" in agreeRec.pick, true);
  assert.equal(agreeRec.pick.options_seen.length, 2, "what each strip showed is kept in the audit");
  assert.equal(file.result[1].verdict.better_t, 4572.067);
  assert.equal(file.result[1].verdict.guard.outcome, "tiebreak_skeptic");
  assert.deepEqual([file.result[1].verdict.tiebreak.winner, file.result[1].verdict.tiebreak.a_t, file.result[1].verdict.tiebreak.b_t].sort(), [4550.267, 4572.067, "skeptic"]);
  assert.deepEqual(file.result[1].verdict.evidence.map((e: { image: number; key: string }) => [e.image, e.key]), [[1, "opt1"], [2, "opt2"]]);
  const applied = applyVision(file.result);
  assert.deepEqual(applied.choices, { "424.433": 424.433, "4550.267": 4572.067 });

  // A second run: the done rows short-circuit, the fake is never called, the file is rewritten the same.
  const again = await judgeBoundaries({ id: RUN_ID, cut_dir: cut, film_notes: null }, doc, { label: "0-end", llm: fake.llm, boundaries: [424.433, 4550.267] });
  assert.ok(!isUnavailable(again));
  assert.equal(fake.calls.length, 5, "no new call");
  assert.ok(again.jobs.every((j) => j.skipped));
  assert.deepEqual(again.records, r.records);

  // Another attempt (a person rejected the answer) is another set of rows.
  const attempt2 = await judgeBoundaries({ id: RUN_ID, cut_dir: cut, film_notes: null }, doc, { label: "0-end_2", llm: fake.llm, attempt: 2, boundaries: [4550.267] });
  assert.ok(!isUnavailable(attempt2));
  assert.equal(fake.calls.length, 8);
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
  const fake = fakeLlm({ fail: [424.433], pick: (b) => (b === 4550.267 ? { confidence: 0, chosen_key: "none", chosen_t: 0, why: "image 1 (opt1) is unreadable: its tiles are blank" } : {}) });
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
  assert.match(applied.faults[0], /4550.267s: reviewer refused or returned nothing - image 1 \(opt1\) is unreadable/);
  // The failed boundary's job row is failed, not done: a re-run calls it again.
  const before = fake.calls.length;
  const again = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "partial", llm: fakeLlm().llm });
  assert.ok(!isUnavailable(again));
  assert.equal(fake.calls.length, before);
  assert.deepEqual(again.errors, []);
  assert.equal(again.records.length, 2);
});

test("a cancelled run stops the pass and the band fix between calls: nothing further is called or paid for, and the boundaries not reached read cancelled", async () => {
  const cut = tempCut();
  const doc = await loadOptionsDoc(cut);
  const controller = new AbortController();
  controller.abort();
  const fake = fakeLlm();
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "cancelled", llm: fake.llm, signal: controller.signal });
  assert.ok(!isUnavailable(r));
  assert.equal(fake.calls.length, 0, "no model call after the cancel");
  assert.deepEqual(r.records, []);
  assert.deepEqual(r.errors.map((e) => e.error), ["cancelled", "cancelled"]);
  assert.equal(r.cost_cents, 0);
  // Aborted after the reviewer's call: the skeptic is not paid for; the reviewer's row is done and reused by a retry.
  const later = new AbortController();
  const seen = fakeLlm();
  const llm = async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
    const out = await seen.llm(call);
    later.abort();
    return out;
  };
  const partial = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "cancelled-late", llm, signal: later.signal, concurrency: 1 });
  assert.ok(!isUnavailable(partial));
  assert.equal(seen.calls.length, 1, "one reviewer call, no skeptic, nothing for the second boundary");
  assert.deepEqual(partial.errors.map((e) => e.error), ["cancelled", "cancelled"]);
  const { doc: bdoc, group } = await bandInput();
  const band = fakeLlm();
  await assert.rejects(judgeBandFix({ id: RUN_ID, cut_dir: cut }, bdoc, [group], { label: "0-end", llm: band.llm, signal: controller.signal, candidates: null }), /the band fix was cancelled before its next call/);
  assert.equal(band.calls.length, 0);
});

test("the real apply_vision.py accepts the file (skipped when the drama-remix checkout or its Python is not on this machine)", async (t) => {
  const script = path.join(dramaRemixRoot(), "scripts", "cut-only", "apply_vision.py");
  const probe = existsSync(script) ? spawnSync(pipelinePython(), ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" }) : null;
  if (!probe || probe.status !== 0) {
    t.skip(`no apply_vision.py at ${script} or no ${pipelinePython()}`);
    return;
  }
  const cut = tempCut();
  const doc = withFillers(await loadOptionsDoc(cut));
  const fake = fakeLlm({ verdict: (b) => (b === 4550.267 ? { agree: false, fault: "Rule 4", fault_rule: "4", fault_image: 1, fault_tile_t: 4550.267, fault_tile_shows: "the slap", better_key: "opt2", better_t: 4572.067 } : {}), tiebreak: 4572.067 });
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "0-end", llm: fake.llm, boundaries: [424.433, 4550.267] });
  assert.ok(!isUnavailable(r));
  const run = spawnSync(pipelinePython(), [script, "--from", "review/vision/0-end.json", "--label", "0-end"], { cwd: cut, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, `apply_vision.py refused the file:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /SKEPTIC OVERRIDE/);
  assert.deepEqual(readJson(path.join(cut, "review", "choices.json")), { "424.433": 424.433, "4550.267": 4572.067 });
  const stamped = readJson(path.join(cut, "review", "options.json"));
  assert.equal(stamped.applied.label, "0-end");

  // A dispute with no fix: exit 1, choices.json not written (the previous one moved aside).
  const fake2 = fakeLlm({ verdict: (b) => (b === 424.433 ? { agree: false, fault: "Rule 3: the payoff lands in the next episode", fault_rule: "3", fault_image: 1, fault_tile_t: 424.933, fault_tile_shows: "the reaction" } : {}) });
  const r2 = await judgeBoundaries({ id: RUN_ID, cut_dir: cut, film_notes: null }, doc, { label: "dispute", llm: fake2.llm, attempt: 2, allow_applied: true, boundaries: [424.433, 4550.267] });
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
