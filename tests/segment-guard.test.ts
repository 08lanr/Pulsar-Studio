// The frame judge's second pass (decision 2026-09-23): the guard on a
// skeptic override (a time it never saw, a band break, a card span, an
// illegal cut), the blind tie-break and what each outcome writes into the
// record and shows the review; the annotated strips (the ffmpeg filter and
// the copy, with a fake ffmpeg); the scoring against the delivered cuts
// with its hard-rule checks; the eval CLI's selection, film notes and bar.
// No network, no ffmpeg, no Python: the fake llm answers from a script and
// the annotator's runner is injected.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resetFixtureStore } from "@/lib/data/fixture";
import type { StructuredCall, StructuredResult } from "@/lib/llm";
import type { BoundaryPick } from "@/lib/prompts/boundary-review";
import type { BoundaryVerdict } from "@/lib/prompts/boundary-skeptic";
import type { TiebreakVerdict } from "@/lib/prompts/boundary-tiebreak";
import { HEADER_PX, annotateArgs, annotateFilter, annotateFont, annotateStrip, cutIndexOf, filterQuote, fontfileArg, pngSize, tileBoxes } from "@/lib/segment/annotate";
import { reviewState } from "@/lib/segment/plan";
import {
  SEEN_TOLERANCE_S,
  allowedRange,
  cutTileOf,
  deliveredFixedStart,
  findBoundary,
  inBand,
  inCardSpan,
  isSeenTime,
  legalCutsInView,
  lengthsAt,
  loadCardSpans,
  loadOptionsDoc,
  neighboursOf,
  parseOptionsDoc,
  seenIn,
  stripTiles,
  type OptionsDoc,
  type StripImage,
} from "@/lib/segment/strips";
import {
  UNVERIFIED_OUTCOMES,
  applyVision,
  deliveredTruth,
  evidenceTiles,
  guardOverride,
  isUnavailable,
  judgeBoundaries,
  readGuard,
  resolveJudgeModel,
  scoreAgainstTruth,
  type GuardInput,
  type WorkflowRecord,
} from "@/lib/segment/vision";
import { calibrationBar, filmNotesFromState, selectBoundaries } from "@/lib/segment/calibration";

const FIXTURE_CUT = path.join(process.cwd(), "tests", "fixtures", "segment", "cut");
const RUN_ID = "22222222-3333-4444-8555-666666666666";

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

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "studio-guard-"));
  temps.push(root);
  return root;
}

/** A copy of the fixture cut folder, its strips touched so they are newer than candidates.json. */
function tempCut(): string {
  const cut = path.join(tempDir(), "cut");
  cpSync(FIXTURE_CUT, cut, { recursive: true });
  const now = new Date();
  for (const name of ["b424_opt1.png", "b424_opt2.png", "b4550_opt1.png", "b4550_opt2.png"]) utimesSync(path.join(cut, "review", "frames", name), now, now);
  return cut;
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** The fixture doc with filler boundaries so the planner's neighbours give real ranges: 4550.267 between `prev` and `next`. */
function withFillers(doc: OptionsDoc, prev = 4450, next = 4680): OptionsDoc {
  const template = doc.boundaries[0].options[0];
  const fillers = [300, 550, prev, next].map((t) => ({ boundary_s: t, dp_pick: t, before: [], after: [], options: [{ ...template, key: "opt1", t, is_dp_pick: true, strip_tiles: stripTiles(t, 5, 0.5) }] }));
  return parseOptionsDoc({ ...doc, boundaries: [...doc.boundaries, ...fillers].sort((a, b) => a.boundary_s - b.boundary_s) });
}

const seenEntry = (key: string) => ({ key, ends_on: "e", opens_on: "o", caption_across_cut: false, card_or_flare: "none" as const, physical_action_across_cut: null });

type Script = {
  verdict?: (b: number) => Partial<BoundaryVerdict>;
  tiebreak?: number | "neither";
  /** The gateway's check is asserted unless off (the guard tests feed the judge what a repaired call could not). */
  strict?: boolean;
};

const boundaryOf = (call: StructuredCall<unknown>) => Number(call.user.match(/^BOUNDARY (\d+(?:\.\d+)?)s/m)?.[1]);

function fakeLlm(script: Script = {}) {
  const calls: StructuredCall<unknown>[] = [];
  const llm = async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
    calls.push(call as StructuredCall<unknown>);
    const b = boundaryOf(call as StructuredCall<unknown>);
    const doc = parseOptionsDoc(readJson(path.join(FIXTURE_CUT, "review", "options.json")));
    const entry = findBoundary(doc, b);
    let data: unknown;
    if (call.name === "verify_boundaries_look") {
      const dp = entry?.options.find((o) => o.is_dp_pick) ?? entry?.options[0];
      const pick: BoundaryPick = { options_seen: (entry?.options ?? []).map((o) => seenEntry(o.key)), chosen_key: dp?.key ?? "opt1", chosen_t: dp?.t ?? 0, ends_on: "A close-up.", opens_on: "A wide shot.", why: "Fake: the DP pick.", rejected: null, payoff_in_episode: true, confidence: 0.8 };
      data = pick;
    } else if (call.name === "verify_boundaries_verify") {
      const v: BoundaryVerdict = { chosen_strip_shows: "Fake.", agree: true, fault: null, fault_image: null, fault_tile_t: null, fault_tile_shows: null, better_key: null, better_t: null, reason: "Fake: holds.", ...(script.verdict?.(b) ?? {}) };
      data = v;
    } else if (call.name === "verify_boundaries_tiebreak") {
      const aT = Number(call.user.match(/^CUT A at (\d+(?:\.\d+)?)s/m)?.[1]);
      const bT = Number(call.user.match(/^CUT B at (\d+(?:\.\d+)?)s/m)?.[1]);
      const want = script.tiebreak ?? "neither";
      const winner = want === "neither" ? "neither" : Math.abs(want - aT) <= 0.0015 ? "A" : Math.abs(want - bT) <= 0.0015 ? "B" : "neither";
      const tv: TiebreakVerdict = { a_shows: "A's frames.", b_shows: "B's frames.", winner, evidence_image: null, evidence_tile_t: null, reason: `Fake: ${winner}.` };
      data = tv;
    } else {
      throw new Error(`fake llm: unexpected call ${call.name}`);
    }
    const parsed = call.schema.parse(data);
    if (script.strict !== false) {
      const problem = call.check?.(parsed);
      assert.equal(problem, null, `the fake's answer for ${call.name} at ${b} must pass the call's own check: ${problem}`);
    }
    return { data: parsed, usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 2, provider: call.provider ?? "anthropic", model: call.model ?? "claude-sonnet-5", turns: 1 };
  };
  return { llm, calls };
}

/** A dense strip the fake makes without ffmpeg: the fixture PNG with 0.1 s tiles around `at`. */
const fakeDense = (at: number): StripImage => ({ key: "dense", t: at, path: path.join(FIXTURE_CUT, "review", "frames", "b4550_opt1.png"), rel: `dense_${at}.png`, media_type: "image/png", tiles: stripTiles(at, 3, 0.1), cols: 10, step: 0.1 });

const SKEPTIC_4550 = { agree: false, fault: "Rule 4: no aftermath", fault_image: 2, fault_tile_t: 4569.567, fault_tile_shows: "the slap", better_key: "opt2", better_t: 4572.067 } as const;

// ---- the pure facts: seen times, neighbours, the range, card spans -----------------------------------------

test("seen times, neighbours, the allowed range, the band arithmetic and card spans are what the guard checks against", async () => {
  const strip = { tiles: stripTiles(100, 5, 0.5) };
  const dense = { tiles: stripTiles(100, 3, 0.1) };
  assert.equal(SEEN_TOLERANCE_S, 0.05);
  assert.ok(isSeenTime(100, [strip]));
  assert.ok(isSeenTime(97.5, [strip]), "the first tile");
  assert.ok(!isSeenTime(97.25, [strip]), "between two 0.5 s tiles is not seen");
  assert.ok(isSeenTime(98.73, [dense]), "a dense strip covers its window to the tenth");
  assert.ok(!isSeenTime(98.73, [strip]), "0.23 s from the nearest 0.5 s tile");
  assert.deepEqual(seenIn(101.5, [dense, strip]), { image: 1, tile_t: 101.5 });
  assert.deepEqual(seenIn(102.5, [dense, strip]), { image: 2, tile_t: 102.5 });
  assert.equal(seenIn(120, [dense, strip]), null);

  const doc = { duration: 600, boundaries: [{ boundary_s: 120, dp_pick: 121 }, { boundary_s: 240, dp_pick: null }, { boundary_s: 360, dp_pick: 362 }] } as unknown as Pick<OptionsDoc, "boundaries" | "duration">;
  assert.deepEqual(neighboursOf(doc, 240), { prev: 121, next: 362 }, "the planner's positions (dp_pick, else boundary_s)");
  assert.deepEqual(neighboursOf(doc, 120), { prev: 0, next: 240 });
  assert.deepEqual(neighboursOf(doc, 120, 30), { prev: 30, next: 240 }, "the fixed start of an extended film");
  assert.deepEqual(neighboursOf(doc, 360), { prev: 240, next: 600 });
  assert.deepEqual(allowedRange(121, 362, [95, 150]), { lo: 216, hi: 267 });
  assert.deepEqual(lengthsAt(250, 121, 362), { before: 129, after: 112 });
  assert.ok(inBand(250, 121, 362, [95, 150]));
  assert.ok(!inBand(215, 121, 362, [95, 150]), "94 s before");
  assert.ok(!inBand(268, 121, 362, [95, 150]), "94 s after");
  assert.ok(allowedRange(0, 4550.267, [95, 150]).lo > allowedRange(0, 4550.267, [95, 150]).hi, "neighbours too far apart: an inverted range, which the judge states as the band alone");

  const spans = [{ from_s: 1797.9, to_s: 1799.9, why: null }];
  assert.ok(inCardSpan(1797.9, spans), "the first frame of the card: an episode opening there opens on the card");
  assert.ok(inCardSpan(1798.5, spans));
  assert.equal(inCardSpan(1799.9, spans), null, "the first frame AFTER the card is the right cut");
  assert.equal(inCardSpan(1797.8, spans), null);

  const dir = tempDir();
  const cut = path.join(dir, "cut");
  assert.deepEqual(await loadCardSpans(cut), [], "no film: no spans");
  writeFileSync(path.join(cut, "..", "x"), "");
  cpSync(FIXTURE_CUT, cut, { recursive: true });
  writeFileSync(path.join(cut, "film-meta.json"), JSON.stringify({ display_title_en: "x", language: "en", exclusions: [{ from_s: 1797.9, to_s: 1799.9, kind: "card", why: "a card" }, { from_s: 10, to_s: 20, kind: "recap", why: "not a card" }, { from_s: 5, to_s: 6, kind: "CARD", why: "upper case" }] }));
  writeFileSync(path.join(cut, "index", "skips.json"), JSON.stringify({ skips: [{ start: 1797.9, end: 1799.9 }, { start: 3000, end: 3002 }] }));
  assert.deepEqual(await loadCardSpans(cut), [
    { from_s: 5, to_s: 6, why: "upper case" },
    { from_s: 1797.9, to_s: 1799.9, why: "a card" },
    { from_s: 3000, to_s: 3002, why: "index/skips.json" },
  ], "film-meta cards (any case) plus the index skips not already listed, in time order; a recap is not a card");
  writeFileSync(path.join(cut, "film-meta.json"), "{not json");
  assert.deepEqual((await loadCardSpans(cut)).map((s) => s.from_s), [1797.9, 3000], "a film-meta that does not parse contributes nothing; the index skips remain");
  assert.equal(await deliveredFixedStart(cut), 0, "no DELIVERED file: the stretch starts at 0");
  writeFileSync(path.join(cut, "review", "cuts-0-900-DELIVERED.json"), JSON.stringify({ episodes: [{ end: 300 }, { end: 600 }, { end: 900 }] }));
  assert.equal(await deliveredFixedStart(cut), 600, "the last PINNED end (the final end is free)");
  writeFileSync(path.join(cut, "review", "cuts-0-900-DELIVERED.json"), JSON.stringify({ episodes: [{ end: 300 }, { end: 600 }, { end: 900 }], final_end_is_boundary: true }));
  assert.equal(await deliveredFixedStart(cut), 900);
  assert.deepEqual(cutTileOf({ window: 5, step: 0.5 }), { index: 5, count: 11 });
  assert.deepEqual(cutTileOf({ window: 3, step: 0.1 }), { index: 15, count: 31 });
});

// ---- the guard -------------------------------------------------------------------------------------------

test("guardOverride refuses a time the skeptic never saw, a band break, a card span and an illegal cut, in that order, and passes a fix that meets all four", () => {
  const strips = [{ tiles: stripTiles(4550.267, 5, 0.5) }, { tiles: stripTiles(4572.067, 5, 0.5) }];
  const dense = { tiles: stripTiles(4550.267, 3, 0.1) };
  const base: GuardInput = { better_t: 4572.067, images: [...strips, dense], prev: 4450, next: 4680, band: [95, 150], card_spans: [], legal_times: [4550.267, 4572.067, 4551, 4600.5] };
  assert.deepEqual(guardOverride(base), { ok: true });
  const unseen = guardOverride({ ...base, better_t: 4600.5 });
  assert.equal(unseen.ok, false);
  assert.match((unseen as { rule: string; detail: string }).detail, /4600.5s is not a tile time of any image the skeptic saw/);
  assert.equal((unseen as { rule: string }).rule, "unseen_time");
  const band = guardOverride({ ...base, next: 4660 });
  assert.deepEqual(band, { ok: false, rule: "band", detail: "4572.067s makes episodes of 122.067s and 87.933s against the neighbours 4450s and 4660s; every episode must be 95-150 s" });
  const card = guardOverride({ ...base, card_spans: [{ from_s: 4571.5, to_s: 4573.5, why: null }] });
  assert.deepEqual(card, { ok: false, rule: "card", detail: "4572.067s is inside the source's card 4571.5-4573.5s: the next episode would open on the card" });
  assert.deepEqual(guardOverride({ ...base, better_t: 4573.5, card_spans: [{ from_s: 4571.5, to_s: 4573.5, why: null }], legal_times: [4573.5] }), { ok: false, rule: "unseen_time", detail: "4573.5s is not a tile time of any image the skeptic saw (a listed option's centre tile or a dense tile within 0.05s)" }, "the checks run in order a, b, c, d");
  const illegal = guardOverride({ ...base, better_t: 4551, legal_times: [4550.267, 4572.067] });
  assert.deepEqual(illegal, { ok: false, rule: "illegal", detail: "4551s is neither a listed option nor a legal cut in index/candidates.json" });
  assert.deepEqual(guardOverride({ ...base, better_t: 4551 }), { ok: true }, "a dense tile that is a legal cut passes");
  assert.deepEqual(UNVERIFIED_OUTCOMES, ["rejected", "no_tiebreak"]);
});

test("a fix the guard refuses writes the reviewer's pick with the skeptic's verdict as a note, and the review asks a person (skeptic_unverified)", async () => {
  const cut = tempCut();
  // Neighbours 4450 and 4660: opt2 at 4572.067 leaves 87.9 s after it, so the skeptic's fix breaks the band.
  const doc = withFillers(await loadOptionsDoc(cut), 4450, 4660);
  // The prompt's own check would already refuse an out-of-range fix (a repair turn); strict off feeds the guard what a repaired call could not.
  const fake = fakeLlm({ verdict: (b) => (b === 4550.267 ? { ...SKEPTIC_4550 } : {}), strict: false });
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "band", llm: fake.llm, boundaries: [4550.267], card_spans: [] });
  assert.ok(!isUnavailable(r));
  assert.equal(fake.calls.length, 2, "no tie-break for a fix the guard refused");
  const rec = r.records[0];
  assert.equal(rec.verdict?.agree, true, "the reviewer's pick is the answer apply_vision.py sees");
  assert.equal("better_t" in (rec.verdict ?? {}), false);
  assert.match(String(rec.verdict?.reason), /skeptic disputed 4550.267s \(Rule 4: no aftermath\) and named 4572.067s, not applied \(band: 4572.067s makes episodes of 122.067s and 87.933s/);
  assert.deepEqual(readGuard(rec.verdict), { outcome: "rejected", rule: "band", detail: "4572.067s makes episodes of 122.067s and 87.933s against the neighbours 4450s and 4660s; every episode must be 95-150 s", better_t: 4572.067 });
  assert.equal((rec.verdict as { skeptic_raw?: { better_t?: number } }).skeptic_raw?.better_t, 4572.067, "the raw verdict is kept for the audit");
  assert.deepEqual(applyVision([rec]).choices, { "4550.267": 4550.267 });
  const state = reviewState(doc, [[rec]], []);
  const b = state.boundaries.find((x) => x.boundary_s === 4550.267)!;
  assert.deepEqual([b.status, b.reasons, b.applied_t, b.applied_source], ["needs_decision", ["skeptic_unverified"], 4550.267, "reviewer"]);
  assert.equal(state.complete, false);
  // The file on disk carries the same.
  const file = readJson(r.file);
  assert.equal(file.result[0].verdict.guard.rule, "band");
  assert.equal(file.card_spans, 0);
  assert.equal(file.tiebreak, true);
});

test("a fix inside a card span is refused (the film's card spans are read from cut/film-meta.json when not given)", async () => {
  const cut = tempCut();
  writeFileSync(path.join(cut, "film-meta.json"), JSON.stringify({ display_title_en: "x", language: "en", exclusions: [{ from_s: 4572.067, to_s: 4574.1, kind: "card", why: "the source's card starts on the cut" }] }));
  const doc = withFillers(await loadOptionsDoc(cut));
  // The skeptic's own check already refuses a fix inside a card (a repair turn); strict off feeds the guard what a repaired call could not.
  const fake = fakeLlm({ verdict: (b) => (b === 4550.267 ? { ...SKEPTIC_4550 } : {}), strict: false });
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "card", llm: fake.llm, boundaries: [4550.267] });
  assert.ok(!isUnavailable(r));
  assert.equal(fake.calls.length, 2);
  const verify = fake.calls[1];
  assert.match(verify.user, /opt2 at 4572.067s - image 2\n(?:[^\n]+\n){2}  ON THE CARD: 4572.067s is inside the source's own card 4572.067-4574.1s/, "the card span read from film-meta.json marks the option");
  assert.match(verify.check!({ chosen_strip_shows: "x", ...SKEPTIC_4550, reason: "r" })!, /opt2 at 4572.067s is inside the source's own card/);
  const guard = readGuard(r.records[0].verdict);
  assert.equal(guard?.outcome, "rejected");
  assert.equal(guard?.rule, "card");
  assert.match(guard!.detail, /4572.067s is inside the source's card 4572.067-4574.1s/);
  assert.equal(r.output.card_spans, 1);
  assert.deepEqual(reviewState(doc, [r.records], []).boundaries.find((x) => x.boundary_s === 4550.267)!.reasons, ["skeptic_unverified"]);
});

test("an illegal fix (a dense tile that is no legal cut) is refused by the guard; an unseen time never reaches it because the prompt's own check refuses it first", async () => {
  const cut = tempCut();
  const doc = withFillers(await loadOptionsDoc(cut));
  const fake = fakeLlm({ verdict: (b) => (b === 4550.267 ? { agree: false, fault: "Rule 4", fault_image: 3, fault_tile_t: 4550.967, fault_tile_shows: "the slap lands", better_key: null, better_t: 4550.967 } : {}), strict: false });
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "illegal", llm: fake.llm, boundaries: [4550.267], dense: async (_b, at) => fakeDense(at), candidates: null, card_spans: [] });
  assert.ok(!isUnavailable(r));
  const guard = readGuard(r.records[0].verdict);
  assert.deepEqual([guard?.outcome, guard?.rule], ["rejected", "illegal"], "seen (a dense tile), in band, no card, but not in the index");
  // The skeptic's check: 4550.967 is not a listed option nor a legal cut it has looked at.
  const verify = fake.calls.find((c) => c.name === "verify_boundaries_verify")!;
  assert.match(verify.check!({ chosen_strip_shows: "x", agree: false, fault: "f", fault_image: 3, fault_tile_t: 4550.967, fault_tile_shows: "s", better_key: null, better_t: 4550.967, reason: "r" })!, /better_t 4550.967 is not a listed option or a legal cut you have looked at/);
  assert.match(verify.check!({ chosen_strip_shows: "x", agree: false, fault: "f", fault_image: 3, fault_tile_t: 4550.967, fault_tile_shows: "s", better_key: null, better_t: 4600, reason: "r" })!, /not a listed option or a legal cut/);
  assert.equal(verify.images?.length, 3, "the dense strip rode along");
});

test("the tie-break decides an override that passed the guards: the skeptic's side applies, the reviewer's side is kept with a note, neither faults the boundary; without a tie-break it needs a person", async () => {
  const cut = tempCut();
  const doc = withFillers(await loadOptionsDoc(cut));
  const denseSeen: number[] = [];
  const dense = async (_b: unknown, at: number) => {
    denseSeen.push(at);
    return fakeDense(at);
  };
  const annotated: [string, number][] = [];
  const annotate = async (s: StripImage, cutT: number) => {
    annotated.push([s.key, cutT]);
    return { ...s, annotated: true };
  };
  const script = (b: number) => (b === 4550.267 ? { ...SKEPTIC_4550 } : {});

  // Skeptic wins.
  const win = fakeLlm({ verdict: script, tiebreak: 4572.067 });
  const r1 = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "tb-skeptic", llm: win.llm, boundaries: [4550.267], dense, annotate, card_spans: [] });
  assert.ok(!isUnavailable(r1));
  assert.deepEqual(win.calls.map((c) => c.name), ["verify_boundaries_look", "verify_boundaries_verify", "verify_boundaries_tiebreak"]);
  assert.deepEqual(denseSeen, [4550.267, 4572.067], "a dense strip at the reviewer's cut for the skeptic, then one at the skeptic's cut for the tie-break");
  assert.deepEqual(annotated, [["opt1", 4550.267], ["opt2", 4572.067], ["dense", 4550.267], ["dense", 4572.067]], "every option strip is annotated with its own cut, each dense strip with its centre");
  const tb = win.calls[2];
  assert.equal(tb.images?.length, 4, "each side: its option strip and its dense strip");
  assert.ok(!/Rule 4|Fake: the DP pick|no aftermath/.test(tb.user), "no reasoning from either side reaches the tie-break");
  const v1 = r1.records[0].verdict!;
  assert.equal(v1.agree, false);
  assert.equal(v1.better_t, 4572.067);
  assert.equal(readGuard(v1)?.outcome, "tiebreak_skeptic");
  assert.deepEqual(applyVision(r1.records).rows[0].source, "SKEPTIC OVERRIDE");
  assert.deepEqual(reviewState(doc, [r1.records], []).boundaries.find((x) => x.boundary_s === 4550.267)!.reasons, ["skeptic_override"], "an applied override still goes to a person, as before");
  assert.deepEqual(evidenceTiles(v1).map((e) => e.tiles.length), [11, 11, 31], "the evidence rebuilds every image's tiles");
  assert.ok(isSeenTime(4572.067, evidenceTiles(v1)));

  // Reviewer wins.
  const keep = fakeLlm({ verdict: script, tiebreak: 4550.267 });
  const r2 = await judgeBoundaries({ id: `${RUN_ID.slice(0, -1)}7`, cut_dir: cut }, doc, { label: "tb-reviewer", llm: keep.llm, boundaries: [4550.267], dense, card_spans: [] });
  assert.ok(!isUnavailable(r2));
  const v2 = r2.records[0].verdict!;
  assert.equal(v2.agree, true);
  assert.equal("better_t" in v2, false);
  assert.equal(readGuard(v2)?.outcome, "tiebreak_reviewer");
  assert.match(String(v2.reason), /the blind tie-break kept 4550.267s/);
  assert.equal((v2 as { tiebreak?: { winner: string } }).tiebreak?.winner, "reviewer");
  assert.deepEqual(reviewState(doc, [r2.records], []).boundaries.find((x) => x.boundary_s === 4550.267)!.status, "pre_accepted");

  // Neither.
  const none = fakeLlm({ verdict: script, tiebreak: "neither" });
  const r3 = await judgeBoundaries({ id: `${RUN_ID.slice(0, -1)}8`, cut_dir: cut }, doc, { label: "tb-neither", llm: none.llm, boundaries: [4550.267], dense, card_spans: [] });
  assert.ok(!isUnavailable(r3));
  const v3 = r3.records[0].verdict!;
  assert.equal(v3.agree, false);
  assert.equal("better_t" in v3, false);
  assert.equal(readGuard(v3)?.outcome, "tiebreak_neither");
  assert.match(applyVision(r3.records).faults[0], /4550.267s: skeptic disputes 4550.267s and names no fix - Rule 4: no aftermath/);
  assert.deepEqual(reviewState(doc, [r3.records], []).boundaries.find((x) => x.boundary_s === 4550.267)!.reasons, ["fault"]);

  // Tie-break off: the guards passed but nobody decided.
  const off = fakeLlm({ verdict: script, tiebreak: 4572.067 });
  const r4 = await judgeBoundaries({ id: `${RUN_ID.slice(0, -1)}9`, cut_dir: cut }, doc, { label: "tb-off", llm: off.llm, boundaries: [4550.267], dense, card_spans: [], tiebreak: false });
  assert.ok(!isUnavailable(r4));
  assert.equal(off.calls.length, 2);
  assert.equal(readGuard(r4.records[0].verdict)?.outcome, "no_tiebreak");
  assert.deepEqual(reviewState(doc, [r4.records], []).boundaries.find((x) => x.boundary_s === 4550.267)!.reasons, ["skeptic_unverified"]);
  assert.equal(r4.output.tiebreak, false);

  // The tie-break order is a hash of the run and the boundary: the two runs above were told the same order for the same run id.
  const a1 = (r1.records[0].verdict as { tiebreak?: { a_side: string } }).tiebreak?.a_side;
  assert.ok(a1 === "reviewer" || a1 === "skeptic");
});

test("a skeptic fault that cites no image and tile, or names no fix, follows the rules: ignored with a note, or apply_vision's fault", async () => {
  const cut = tempCut();
  const doc = withFillers(await loadOptionsDoc(cut));
  const uncited = fakeLlm({ verdict: (b) => (b === 4550.267 ? { agree: false, fault: "Rule 3: the payoff lands next episode", better_key: "opt2", better_t: 4572.067 } : {}), strict: false });
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "uncited", llm: uncited.llm, boundaries: [4550.267], card_spans: [] });
  assert.ok(!isUnavailable(r));
  assert.equal(uncited.calls.length, 2, "no tie-break for a fault nobody can place");
  const v = r.records[0].verdict!;
  assert.equal(v.agree, true);
  assert.equal(readGuard(v)?.outcome, "uncited");
  assert.match(String(v.reason), /skeptic disputed 4550.267s without citing a frame \(cite both fault_image and fault_tile_t, or neither\); ignored\. Skeptic said: Rule 3/);
  assert.deepEqual(applyVision(r.records).choices, { "4550.267": 4550.267 });
  assert.equal(reviewState(doc, [r.records], []).boundaries.find((x) => x.boundary_s === 4550.267)!.status, "pre_accepted", "recorded, not applied, not a decision for a person");

  const noFix = fakeLlm({ verdict: (b) => (b === 4550.267 ? { agree: false, fault: "Rule 5", fault_image: 1, fault_tile_t: 4550.267, fault_tile_shows: "a stranger's back", better_key: null, better_t: null } : {}) });
  const r2 = await judgeBoundaries({ id: `${RUN_ID.slice(0, -1)}7`, cut_dir: cut }, doc, { label: "nofix", llm: noFix.llm, boundaries: [4550.267], card_spans: [] });
  assert.ok(!isUnavailable(r2));
  assert.equal(readGuard(r2.records[0].verdict)?.outcome, "fault_no_fix");
  assert.match(applyVision(r2.records).faults[0], /skeptic disputes 4550.267s and names no fix - Rule 5/);
  assert.deepEqual(reviewState(doc, [r2.records], []).boundaries.find((x) => x.boundary_s === 4550.267)!.reasons, ["fault"]);

  // A refusal carries the guard's note too; a Workflow record without one reads null.
  assert.equal(readGuard({ agree: true, reason: "the Workflow's" }), null);
  assert.deepEqual(evidenceTiles({ agree: true, reason: "" }), []);
});

test("the model override: a model of the provider's family that reads images runs; another family's or a text-only model is refused before any call", async () => {
  const env = { ANTHROPIC_API_KEY: "k", DEEPSEEK_API_KEY: "d" };
  assert.deepEqual(resolveJudgeModel(env, undefined), { provider: "anthropic", model: "claude-sonnet-5" });
  assert.deepEqual(resolveJudgeModel(env, "claude-opus-5"), { provider: "anthropic", model: "claude-opus-5" });
  assert.deepEqual(resolveJudgeModel(env, "deepseek-flash"), { provider: "deepseek", model: "deepseek-flash" }, "the model names its family; the key is there");
  assert.deepEqual(resolveJudgeModel(env, "deepseek-v4-pro"), { unavailable: "vision provider unavailable: deepseek-v4-pro does not read images" });
  assert.deepEqual(resolveJudgeModel({ ANTHROPIC_API_KEY: "k" }, "deepseek-flash"), { unavailable: "vision provider unavailable: deepseek-flash needs DEEPSEEK_API_KEY in .env.local" });
  const cut = tempCut();
  const doc = withFillers(await loadOptionsDoc(cut));
  const fake = fakeLlm();
  const r = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "model", llm: fake.llm, boundaries: [424.433], model: "claude-opus-5", card_spans: [] });
  assert.ok(!isUnavailable(r));
  assert.equal(r.model, "claude-opus-5");
  assert.ok(fake.calls.every((c) => c.model === "claude-opus-5"));
  const refused = await judgeBoundaries({ id: RUN_ID, cut_dir: cut }, doc, { label: "model2", llm: fake.llm, boundaries: [424.433], model: "deepseek-flash" });
  assert.ok(isUnavailable(refused));
  assert.match(refused.unavailable, /needs DEEPSEEK_API_KEY/);
});

// ---- the annotated strips ----------------------------------------------------------------------------------

test("the annotation filter labels every tile with its time and END/NEXT, frames the cut tile in red and adds the header, from the PNG's own geometry", async () => {
  assert.deepEqual(await pngSize(path.join(FIXTURE_CUT, "review", "frames", "b424_opt1.png")), { width: 614, height: 362 }, "the fixture strips are half size");
  const boxes = tileBoxes({ width: 1228, height: 724 }, 11, 6);
  assert.equal(boxes.length, 11);
  assert.deepEqual(boxes[0], { index: 0, x: 4, y: HEADER_PX + 4, w: 200, h: 356 }, "margin 4, padding 4: the pipeline's tile filter");
  assert.deepEqual(boxes[5], { index: 5, x: 1024, y: 40, w: 200, h: 356 });
  assert.deepEqual(boxes[6], { index: 6, x: 4, y: 400, w: 200, h: 356 }, "the second row");
  assert.equal(HEADER_PX, 36);
  const tiles = stripTiles(115.367, 5, 0.5);
  const filter = annotateFilter({ tiles, cols: 6, cut_index: 5, label: "opt6", cut_t: 115.367, size: { width: 1228, height: 724 }, font: "C:/Windows/Fonts/arial.ttf" });
  const parts = filter.split(",drawtext=").length - 1 + (filter.startsWith("drawtext=") ? 1 : 0);
  assert.equal(parts, 1 + 11 * 2, "the header, then a time and an END/NEXT label per tile");
  assert.ok(filter.startsWith("pad=iw:ih+36:0:36:color=black,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='opt6   cut at 115.367 s   |   tiles before the red frame = END of this episode   |   red frame and after = START of the next episode':x=8:y=8:fontsize=20:fontcolor=white,"), filter.slice(0, 260));
  assert.ok(filter.includes("drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='112.867':x=10:y=46:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4"), "the first tile's time, top-left");
  assert.ok(filter.includes("text='END':x=198-text_w:y=46:fontsize=20:fontcolor=black:box=1:boxcolor=0x5fd35f@0.9:boxborderw=4"), "END on a tile before the cut, top-right, green");
  assert.ok(filter.includes("text='115.367':x=1030:y=46"), "the cut tile's time");
  assert.ok(filter.includes("text='NEXT':x=1218-text_w:y=46:fontsize=20:fontcolor=black:box=1:boxcolor=0xffa040@0.9:boxborderw=4"), "NEXT from the cut tile on, orange");
  assert.ok(filter.includes("text='115.867':x=10:y=406"), "the second row's first tile");
  assert.ok(filter.endsWith(",drawbox=x=1024:y=40:w=200:h=356:color=red@1:t=6"), "the red frame on the cut tile, last");
  assert.equal((filter.match(/text='END'/g) ?? []).length, 5);
  assert.equal((filter.match(/text='NEXT'/g) ?? []).length, 6);
  const noFont = annotateFilter({ tiles, cols: 6, cut_index: 5, label: "opt6", cut_t: 115.367, size: { width: 1228, height: 724 }, font: null });
  assert.ok(!noFont.includes("fontfile"), "no font file: fontconfig's default");
  const dense = annotateFilter({ tiles: stripTiles(115.367, 3, 0.1), cols: 10, cut_index: 15, label: "dense", cut_t: 115.367, size: { width: 2044, height: 1444 }, font: null });
  assert.ok(dense.includes("drawbox=x=1024:y=400:w=200:h=356"), "a 31-tile dense strip: tile 16 is the sixth of the second row");
  assert.equal(filterQuote("a'b\\c"), "'a\\'b\\\\c'");
  assert.equal(fontfileArg("C:\\Windows\\Fonts\\arial.ttf"), "fontfile='C\\:/Windows/Fonts/arial.ttf'");
  assert.equal(cutIndexOf(tiles, 115.367), 5);
  assert.equal(cutIndexOf(tiles, 116.367), 7);
  assert.equal(cutIndexOf(tiles, 999), 5, "a time no tile shows: the centre");
  assert.deepEqual(annotateArgs("in.png", "out.png", { tiles, cols: 6, cut_index: 5, label: "opt6", cut_t: 115.367, size: { width: 1228, height: 724 }, font: null }).slice(0, 7), ["-hide_banner", "-y", "-v", "error", "-i", "in.png", "-vf"]);
  assert.equal(annotateFont({ STUDIO_ANNOTATE_FONT: "/f/x.ttf" }), "/f/x.ttf");
  assert.equal(annotateFont({}, () => false), null);
});

test("annotateStrip writes the copy once under the work dir with the pipeline's PNG still named as the record, and remakes it only when the source is newer", async () => {
  const cut = tempCut();
  const doc = await loadOptionsDoc(cut);
  const b = findBoundary(doc, 424.433)!;
  const strip: StripImage = { key: "opt1", t: 424.433, path: path.join(cut, "review", "frames", "b424_opt1.png"), rel: "review/frames/b424_opt1.png", media_type: "image/png", tiles: b.options[0].strip_tiles!, cols: 6, step: 0.5 };
  const outDir = path.join(tempDir(), "annotated");
  const runs: string[][] = [];
  const run = async (args: string[]) => {
    runs.push(args);
    writeFileSync(args[args.length - 1], readFileSync(strip.path));
    return { code: 0, stderr: "" };
  };
  const out = await annotateStrip(strip, 424.433, outDir, { run, env: { STUDIO_ANNOTATE_FONT: "/f/x.ttf" } });
  assert.equal(out.path, path.join(outDir, "b424_opt1.annotated.png"));
  assert.equal(out.rel, "review/frames/b424_opt1.png", "the record still names the pipeline's file");
  assert.equal(out.annotated, true);
  assert.deepEqual(out.tiles, strip.tiles);
  assert.ok(existsSync(out.path));
  assert.equal(runs.length, 1);
  assert.equal(runs[0][runs[0].length - 1], `${out.path}.part.png`, "rendered beside, then moved into place");
  assert.ok(runs[0][7].includes("fontfile='/f/x.ttf'"));
  assert.ok(runs[0][7].includes("text='opt1   cut at 424.433 s"));
  assert.ok(runs[0][7].includes("drawbox=x=4+".slice(0, 9)));
  const again = await annotateStrip(strip, 424.433, outDir, { run });
  assert.equal(runs.length, 1, "the copy is current: not remade");
  assert.equal(again.path, out.path);
  const later = new Date(statSync(out.path).mtimeMs + 60_000);
  utimesSync(strip.path, later, later);
  await annotateStrip(strip, 424.433, outDir, { run });
  assert.equal(runs.length, 2, "a newer source PNG is annotated again");
  const failing = async (args: string[]) => ({ code: 1, stderr: `ffmpeg: ${args.length} args\nno such filter` });
  rmSync(out.path);
  await assert.rejects(annotateStrip(strip, 424.433, outDir, { run: failing }), /ffmpeg could not annotate b424_opt1.png: ffmpeg: \d+ args \| no such filter/);
});

// ---- scoring against the delivered cuts -----------------------------------------------------------------

const doc4 = (): Pick<OptionsDoc, "boundaries" | "duration" | "band"> => ({
  duration: 640,
  band: [95, 150],
  boundaries: [115.367, 214.733, 323.4, 424.433, 528.9].map((t) => ({ boundary_s: t, dp_pick: t, before: [], after: [], options: [{ key: "opt1", t, is_dp_pick: true }, { key: "opt2", t: t + 8.7 }] })) as unknown as OptionsDoc["boundaries"],
});

const rec = (b: number, t: number, verdict: Record<string, unknown> | null, extra: { confidence?: number; key?: string } = {}): WorkflowRecord => ({
  boundary_s: b,
  pick: { chosen_key: extra.key ?? "opt1", chosen_t: t, ends_on: "e", opens_on: "o", why: "w", payoff_in_episode: true, confidence: extra.confidence ?? 0.8 },
  verdict: verdict === null ? null : { agree: true, reason: "r", fault: "", better_key: "", ...verdict },
});

test("deliveredTruth maps each options boundary to its delivered end inside its own half-window, and a boundary a join removed reads null", () => {
  const { truth, unmatched } = deliveredTruth(doc4(), [115.367, 213.5, 315.533, 433.1, 528.9, 640]);
  assert.deepEqual(truth, { "115.367": 115.367, "214.733": 213.5, "323.4": 315.533, "424.433": 433.1, "528.9": 528.9 });
  assert.deepEqual(unmatched, []);
  const joined = deliveredTruth(doc4(), [115.367, 213.5, 433.1, 528.9]);
  assert.deepEqual([joined.truth["323.4"], joined.unmatched], [null, [323.4]]);
  const nearest = deliveredTruth({ boundaries: [{ boundary_s: 100 }, { boundary_s: 200 }] } as OptionsDoc, [140, 160]);
  assert.deepEqual(nearest.truth, { "100": 140, "200": 160 }, "the midpoint 150 splits the two");
});

test("scoreAgainstTruth scores the applied time with and without the skeptic, the skeptic's effect, the card boundaries and the hard rules", () => {
  const doc = doc4();
  const { truth } = deliveredTruth(doc, [115.367, 213.5, 315.533, 433.1, 528.9, 640]);
  const cards = [{ from_s: 210.433, to_s: 213.5, why: null }, { from_s: 1797.9, to_s: 1799.9, why: null }];
  // The skeptic's images at 323.4 covered 313.1-318.1 only: its applied 323.4 was never seen.
  const evidence = [{ image: 1, key: "opt1", from: 313.1, to: 318.1, step: 0.5, annotated: true }];
  const judged: WorkflowRecord[] = [
    // right, skeptic agreed
    rec(115.367, 115.367, { guard: { outcome: "agreed", rule: null, detail: "", better_t: null } }),
    // reviewer wrong (the DP pick), skeptic's fix right after the tie-break: helped; the applied time is the first frame after the card
    rec(214.733, 214.733, { agree: false, better_key: "opt2", better_t: 213.5, guard: { outcome: "tiebreak_skeptic", rule: null, detail: "", better_t: 213.5 }, evidence: [{ image: 1, key: "opt2", from: 211, to: 216, step: 0.5, annotated: true }] }),
    // reviewer right (315.533 = opt1 is not; use opt2 at 332.1? no: the reviewer picks the truth), skeptic's applied override wrong and never seen: hurt, a bad override, unseen
    rec(323.4, 315.533, { agree: false, better_key: "", better_t: 323.4, guard: { outcome: "tiebreak_skeptic", rule: null, detail: "", better_t: 323.4 }, evidence }, { key: "opt9" }),
    // reviewer wrong, the guard refused the skeptic's fix: a hand-off
    rec(424.433, 424.433, { guard: { outcome: "rejected", rule: "band", detail: "x", better_t: 433.1 } }),
    // a fault with no fix: a hand-off
    rec(528.9, 528.9, { agree: false, fault: "Rule 5", guard: { outcome: "fault_no_fix", rule: null, detail: "", better_t: null } }),
  ];
  const score = scoreAgainstTruth({ doc, truth, judged, card_spans: cards, fixed_start: 0 });
  assert.equal(score.n, 5);
  assert.equal(score.applied_agree, 2, "115.367 and 214.733 (the skeptic's 213.5)");
  assert.equal(score.reviewer_only_agree, 3, "115.367, 323.4 (the reviewer's 315.533) and 528.9, whose reviewer was right before the skeptic faulted it");
  assert.equal(score.handoffs, 2);
  assert.equal(score.dp_rate, 0.8);
  assert.deepEqual(score.rows.map((r) => [r.boundary_s, r.effect]), [[115.367, "neutral"], [214.733, "helped"], [323.4, "hurt"], [424.433, "neutral"], [528.9, "handoff"]]);
  assert.deepEqual(score.skeptic.bad_overrides, 1);
  assert.deepEqual([score.skeptic.agreed, score.skeptic.disputed, score.skeptic.fixes_named, score.skeptic.applied, score.skeptic.rejected, score.skeptic.fault_no_fix, score.skeptic.tiebreak_skeptic, score.skeptic.helped, score.skeptic.hurt], [1, 4, 3, 2, { band: 1 }, 1, 2, 1, 1]);
  assert.deepEqual(score.cards, { boundaries: 1, agree: 1 }, "213.5 is the first frame after a card");
  const byB = new Map(score.rows.map((r) => [r.boundary_s, r]));
  assert.deepEqual(byB.get(323.4)!.rule_failures, ["unseen: the applied override 323.4s is not a tile of any image the skeptic saw"]);
  assert.deepEqual(byB.get(214.733)!.rule_failures, []);
  assert.deepEqual(byB.get(214.733)!.lengths, { before: 98.133, after: 109.9 }, "against the APPLIED neighbours: 115.367 and the override 323.4, not the truth 315.533");
  assert.deepEqual(score.rule_failures, { card: 0, band: 0, unseen: 1, total: 1 });
  // A card failure and a band failure.
  const bad: WorkflowRecord[] = [rec(214.733, 214.733, { agree: false, better_key: "", better_t: 211.5, guard: { outcome: "tiebreak_skeptic", rule: null, detail: "", better_t: 211.5 }, evidence: [{ image: 1, key: "opt1", from: 209, to: 214, step: 0.5, annotated: false }] }), rec(323.4, 323.4, null)];
  const s2 = scoreAgainstTruth({ doc, truth, judged: bad, card_spans: cards });
  assert.deepEqual(s2.rows[0].rule_failures, ["card: 211.5s opens the next episode on the card 210.433-213.5s"]);
  const s3 = scoreAgainstTruth({ doc: { ...doc, band: [100, 105] }, truth, judged: bad, card_spans: [] });
  assert.match(s3.rows[1].rule_failures[0], /^band: 111.9s \/ 109.7s against 211.5s and 433.1s \(100-105 s\)/);
  assert.equal(scoreAgainstTruth({ doc, truth, judged: [], card_spans: [] }).dp_rate, null);
});

// ---- the eval CLI's pure parts ---------------------------------------------------------------------------

test("the eval selects boundaries by index range, index or time, reads the film notes from STATE.md, and states the calibration bar", () => {
  const all = [115.367, 214.733, 323.4, 424.433, 528.9];
  assert.deepEqual(selectBoundaries(all, "2-4"), { boundaries: [214.733, 323.4, 424.433], indices: [2, 3, 4] });
  assert.deepEqual(selectBoundaries(all, "#5,115.367,2-2"), { boundaries: [115.367, 214.733, 528.9], indices: [1, 2, 5] });
  assert.deepEqual(selectBoundaries(all, "4-99").indices, [4, 5], "a range past the end stops at the end");
  assert.throws(() => selectBoundaries(all, "999"), /999 is not a boundary/);
  const state = "# x\n\n## Decisions\n\n- a\n\n## Film-specific notes\n\n- **Watermark:** bottom.\n- The source shows a vertical \"TO BE CONTINUED\" card at each original episode break.\n\n## Delivered\n\n    ep01";
  assert.equal(filmNotesFromState(state), '- **Watermark:** bottom.\n- The source shows a vertical "TO BE CONTINUED" card at each original episode break.');
  assert.equal(filmNotesFromState("# x\n\n## Decisions\n- a\n"), null);
  assert.equal(filmNotesFromState("## Film-specific notes\n- last section\n"), "- last section");
  const score = { n: 20, applied_agree: 15, reviewer_only_agree: 12, handoffs: 2, dp_rate: 0.5, skeptic: { bad_overrides: 1 }, cards: { boundaries: 10, agree: 9 }, rule_failures: { card: 0, band: 0, unseen: 0, total: 0 } } as unknown as Parameters<typeof calibrationBar>[0];
  const bar = calibrationBar(score, Array.from({ length: 20 }, (_, i) => i + 1), 700);
  assert.deepEqual(bar.map((b) => b.pass), [true, true, true, true, true, true]);
  assert.match(bar[0].line, /applied agreement 15\/20 \(bar 15\/20, tuning 15\/20\)/);
  const held = calibrationBar({ ...score, applied_agree: 14 } as typeof score, Array.from({ length: 20 }, (_, i) => i + 21), 900);
  assert.match(held[0].line, /bar 14\/20, held-out 14\/20/);
  assert.deepEqual(held.map((b) => b.pass), [true, true, true, true, true, false], "$0.45 per boundary is over the bar");
  const failing = calibrationBar({ ...score, applied_agree: 10, handoffs: 5, rule_failures: { card: 1, band: 0, unseen: 0, total: 1 }, skeptic: { bad_overrides: 2 } } as typeof score, [1], 10);
  assert.deepEqual(failing.map((b) => b.pass), [false, false, false, false, true, true]);
});

test("legalCutsInView with no range lists every seen legal cut", async () => {
  const doc = await loadOptionsDoc(FIXTURE_CUT);
  const candidates = readJson(path.join(FIXTURE_CUT, "index", "candidates.json"));
  const images = [{ tiles: stripTiles(4550.267, 5, 0.5) }, { tiles: stripTiles(4572.067, 5, 0.5) }];
  assert.deepEqual(legalCutsInView(candidates, images, null).map((c) => c.t), [4550.267, 4572.067]);
  assert.deepEqual(legalCutsInView(candidates, images, { lo: 4560, hi: 4580 }).map((c) => c.t), [4572.067]);
  assert.deepEqual(legalCutsInView(null, images, null), []);
  assert.equal(doc.boundaries.length, 2);
});
