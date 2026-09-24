// The segmenting screens' pure model (components/admin/segment/model.ts)
// over the review state the run route serves, and the wire contract's zod
// (lib/segment/api-types.ts): which cards need a person and in what order,
// what a move does to the two lengths and when the band refuses it (the
// decide route's own rule, seen first), when Apply opens, the words for a
// stage's progress, the slug the intake proposes, and the decision bodies
// the routes accept.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionBodySchema, NewRunBodySchema, type BoundaryView, type WorkflowRecord } from "@/lib/segment/api-types";
import type { FilmRunDecision } from "@/lib/types";
import {
  applyReady,
  bandConflictGroups,
  buildCards,
  checkMove,
  cutTile,
  episodesOf,
  fixedStartOf,
  fmtT,
  isLegalTarget,
  isRendered,
  neighbours,
  orderCards,
  progressText,
  slugFromFilename,
  sourceFactsOf,
  stageIndex,
  titleFromSlug,
  waitingFor,
  type ReviewLike,
} from "@/components/admin/segment/model";

const record = (boundary_s: number, chosen_t: number, confidence: number, verdict?: WorkflowRecord["verdict"]): WorkflowRecord => ({
  boundary_s,
  pick: { chosen_key: "opt2", chosen_t, ends_on: "a", opens_on: "b", why: "c", payoff_in_episode: true, confidence },
  verdict: verdict ?? { agree: true, fault: "", better_key: "", reason: "fine" },
});

const decision = (action: string, boundary_s: number, extra: Partial<FilmRunDecision> = {}): FilmRunDecision => ({ at: "2026-09-23T10:00:00.000Z", by: "ruobin", action, boundary_s, ...extra });

/** A served boundary as `lib/segment/view.ts` builds it: options 10 s apart around `b`, the legal cuts listed, the state's own fields. */
function boundary(b: number, over: Partial<BoundaryView> = {}): BoundaryView {
  const opts = [b - 10, b, b + 10];
  const rec = over.record === undefined ? record(b, b, 0.9) : over.record;
  const status = over.status ?? "pre_accepted";
  return {
    boundary_s: b,
    dp_pick: b,
    record: rec,
    applied_t: rec ? (rec.verdict && !rec.verdict.agree && rec.verdict.better_t ? rec.verdict.better_t : rec.pick.confidence === 0 ? null : rec.pick.chosen_t) : null,
    applied_source: rec ? (rec.verdict && !rec.verdict.agree && rec.verdict.better_t ? "SKEPTIC OVERRIDE" : "reviewer") : null,
    fault: null,
    reasons: [],
    decision: null,
    rejudges_asked: 0,
    rejudges_done: 0,
    status,
    current_t: b,
    confidence: rec?.pick.confidence ?? null,
    options: opts.map((t, i) => ({ key: `opt${i + 1}`, t, is_dp_pick: t === b, line_before: "Get out", line_after: "Sorry", strip_url: `/api/film-runs/r/evidence/review/frames/b${Math.round(b)}_opt${i + 1}.png`, tiles: Array.from({ length: 11 }, (_, k) => Math.round((t - 2.5 + k * 0.5) * 1000) / 1000), cols: 6, step: 0.5 })),
    legal_cuts: [b - 25, b - 10, b, b + 10, b + 25].map((t) => ({ t, line_before: "", line_after: "" })),
    proxy_url: `/api/film-runs/r/evidence/work/proxies/t${Math.floor(b)}_000.mp4`,
    lengths: { before: 120, after: 120 },
    dialogue: { before: [], after: [] },
    ...over,
  };
}

function review(boundaries: BoundaryView[], over: Partial<ReviewLike> = {}): ReviewLike {
  const duration = over.duration ?? 500;
  const points = [0, ...boundaries.map((b) => b.current_t).sort((a, b) => a - b), duration];
  return {
    band: [95, 150],
    duration,
    lengths: points.slice(1).map((to, i) => ({ from: points[i], to, length: to - points[i], in_band: true })),
    boundaries,
    ...over,
  };
}

const geo = { fixedStart: 0, duration: 500, band: [95, 150] as [number, number], firstN: 1 };

test("cards follow the served status: needs_decision and rejudging need a person, decided is settled, pre_accepted is neither", () => {
  const cards = buildCards(review([
    boundary(120),
    boundary(240, { status: "needs_decision", reasons: ["low_confidence", "skeptic_override"], record: record(240, 240, 0.55, { agree: false, fault: "mid-fall", better_key: "opt3", better_t: 250, reason: "r" }), applied_t: 250, applied_source: "SKEPTIC OVERRIDE", current_t: 250 }),
    boundary(360, { status: "decided", decision: decision("move", 360, { to_s: 350 }), current_t: 350 }),
    boundary(480, { status: "rejudging", rejudges_asked: 1 }),
  ]));
  assert.deepEqual(cards.map((c) => [c.required, c.settled, c.rejudging]), [[false, false, false], [true, false, false], [false, true, false], [true, false, true]]);
  assert.deepEqual(cards[1].reasons, ["low_confidence", "skeptic"]);
  assert.ok(cards[1].skeptic_override);
  assert.deepEqual(cards[1].applied, { t: 250, source: "skeptic" });
  assert.equal(cards[2].current_t, 350);
  assert.deepEqual(cards[3].reasons, ["rejudging"]);
});

test("a fault or a missing record reads as one", () => {
  const cards = buildCards(review([
    boundary(120, { status: "needs_decision", reasons: ["fault"], record: record(120, 120, 0), applied_t: null, applied_source: null, fault: "the reviewer judged blind (confidence 0)" }),
    boundary(240, { status: "needs_decision", reasons: ["no_record"], record: null, applied_t: null, applied_source: null, confidence: null }),
  ]));
  assert.deepEqual(cards[0].applied, { t: null, fault: "the reviewer judged blind (confidence 0)" });
  assert.deepEqual(cards[1].reasons, ["no_record"]);
  assert.equal(cards[1].applied, null);
});

test("episode lengths follow the current cuts; a move recomputes both neighbours and the band refuses a break, as the route does", () => {
  const cards = buildCards(review([boundary(120), boundary(240), boundary(360)]));
  assert.deepEqual(episodesOf(cards, 0, 500).map((e) => [e.n, e.start, e.end, e.dur]), [[1, 0, 120, 120], [2, 120, 240, 120], [3, 240, 360, 120], [4, 360, 500, 140]]);
  const nb = neighbours(cards, cards[1], geo);
  assert.deepEqual(nb, { before: { n: 2, dur: 120 }, after: { n: 3, dur: 120 } });
  const ok = checkMove(cards, cards[1], 230, geo);
  assert.deepEqual([ok.ok, ok.before, ok.after], [true, 110, 130]);
  // 215 is a listed legal cut and keeps both episodes in band (95 s is the band's floor).
  const edge = checkMove(cards, cards[1], 215, geo);
  assert.deepEqual([edge.ok, edge.before, edge.after], [true, 95, 145]);
  // 218 is neither an option nor a listed legal cut: refused for that alone.
  const notLegal = checkMove(cards, cards[1], 218, geo);
  assert.equal(isLegalTarget(cards[1], 218), false);
  assert.equal(notLegal.ok, false);
  assert.deepEqual(notLegal.refusals, ["3:38.0 is not a listed option or a legal cut"]);
  // A legal cut that breaks the band is refused with the episode named.
  const broken = checkMove(cards, cards[1], 265, { ...geo, band: [100, 140] });
  assert.equal(broken.ok, false);
  assert.ok(broken.refusals.some((r) => /episode 2 would be 145\.0 s, outside 100–140 s/.test(r)));
  // The trailing episode is band-checked too (the route's lengthsAround checks both sides).
  const last = checkMove(cards, cards[2], 350, geo);
  assert.equal(last.ok, true);
  assert.equal(last.after, 150);
  const far = checkMove(cards, cards[2], 335, geo);
  assert.ok(far.refusals.some((r) => /episode 4 would be 165\.0 s/.test(r)));
});

test("the fixed start is the last delivered end and numbers the first new episode after the delivered ones", () => {
  const r = review([boundary(400), boundary(520)], { duration: 700, lengths: [{ from: 300, to: 400, length: 100, in_band: true }, { from: 400, to: 520, length: 120, in_band: true }, { from: 520, to: 700, length: 180, in_band: false }] });
  assert.equal(fixedStartOf(r), 300);
  const eps = episodesOf(buildCards(r), 300, 700, 4);
  assert.deepEqual(eps.map((e) => [e.n, e.start, e.end]), [[4, 300, 400], [5, 400, 520], [6, 520, 700]]);
});

test("band conflicts group the adjacent boundaries of an out-of-band episode and block Apply", () => {
  // The second boundary sits at 210: episode 2 is 90 s (out), episode 3 is 150 s (in).
  const cards = buildCards(review([boundary(120), boundary(240, { current_t: 210, status: "decided", decision: decision("move", 240, { to_s: 210 }) }), boundary(360)]));
  assert.deepEqual(bandConflictGroups(cards, geo), [[120, 240]]);
  const order = orderCards(cards, geo);
  assert.equal(order.attention.length, 0);
  assert.deepEqual(order.conflicts[0].map((c) => c.boundary_s), [120, 240]);
  assert.deepEqual(order.rest.map((c) => c.boundary_s), [360]);
  assert.deepEqual(applyReady(cards, geo), { ok: false, undecided: 0, conflicts: 1 });
  // Two out-of-band episodes in a row chain their three boundaries into one group.
  const chained = buildCards(review([boundary(120), boundary(240, { current_t: 180 }), boundary(360)]));
  assert.deepEqual(bandConflictGroups(chained, geo), [[120, 240, 360]]);
});

test("the order: skeptic overrides and faults first, then rising confidence, then the rest; every card in exactly one group", () => {
  const cards = buildCards(review([
    boundary(120, { status: "needs_decision", reasons: ["low_confidence"], record: record(120, 120, 0.6), confidence: 0.6 }),
    boundary(240, { status: "needs_decision", reasons: ["skeptic_override"], record: record(240, 240, 0.8, { agree: false, fault: "x", better_key: "opt3", better_t: 250, reason: "r" }), applied_t: 250, applied_source: "SKEPTIC OVERRIDE", current_t: 250, confidence: 0.8 }),
    boundary(360, { status: "needs_decision", reasons: ["low_confidence"], record: record(360, 360, 0.3), confidence: 0.3 }),
    boundary(480),
  ]));
  const order = orderCards(cards, { ...geo, duration: 600 });
  assert.deepEqual(order.attention.map((c) => c.boundary_s), [240, 360, 120]);
  assert.deepEqual(order.rest.map((c) => c.boundary_s), [480]);
  const all = [...order.attention, ...order.conflicts.flat(), ...order.rest].map((c) => c.key).sort();
  assert.deepEqual(all, cards.map((c) => c.key).sort());
  assert.deepEqual(applyReady(cards, { ...geo, duration: 600 }), { ok: false, undecided: 3, conflicts: 0 });
});

test("the cut tile is the centre tile of a 6-wide strip: index 5 = row 0, column 5 of 2 rows", () => {
  const tiles = [105.2, 105.7, 106.2, 106.7, 107.2, 107.7, 108.2, 108.7, 109.2, 109.7, 110.2];
  assert.deepEqual(cutTile(tiles, 107.7, 6), { index: 5, row: 0, col: 5, rows: 2 });
  assert.deepEqual(cutTile([], 1, 6), { index: 0, row: 0, col: 0, rows: 1 });
});

test("stages: the order the timeline walks, cards only in source-episodes mode, rendered from qa on, the wait read from stage_detail", () => {
  assert.equal(stageIndex("review"), 5);
  assert.equal(stageIndex("review", "source_episodes"), 6);
  assert.equal(stageIndex("failed"), -2);
  assert.ok(isRendered("qa"));
  assert.ok(isRendered("done"));
  assert.equal(isRendered("render"), false);
  assert.equal(isRendered("failed"), false);
  assert.equal(waitingFor({ waiting: { for: "review", since: "", decisions_seen: 2 } }), "review");
  assert.equal(waitingFor({ progress: { step: "whisper" } }), null);
  assert.deepEqual(sourceFactsOf({ source: { width: 720, height: 1280, fps: 30, duration_s: 900, placed: "linked" } }), { width: 720, height: 1280, fps: 30, duration_s: 900 });
  assert.equal(sourceFactsOf({}), null);
});

test("progress words: the worker's progress object, then the plain shapes, else key: value", () => {
  assert.equal(progressText({ progress: { step: "whisper", file: "index/whisper.log", line: "  50%  7.5s" } }), "whisper:   50%  7.5s");
  assert.equal(progressText({ progress: { step: "render", t: 3, of: 7, kept: 2 } }), "render: 3 / 7 episodes (2 kept)");
  assert.equal(progressText({ progress: { step: "candidates" } }), "candidates");
  assert.equal(progressText({ t: 65.5, of: 900 }), "1:05.5 / 15:00.0");
  assert.equal(progressText({ episode: 3, of: 7 }), "episode 3 of 7");
  assert.equal(progressText({ file: "index/whisper.log" }), "index/whisper.log");
  assert.equal(progressText({ stage: "index", pid: 12 }), "stage: index · pid: 12");
  assert.equal(progressText({ waiting: { for: "review" } }), "");
  // The worker's bookkeeping is not progress: a finished run's detail reads as nothing, not "started_at: … · worker: …".
  assert.equal(progressText({ started_at: "2026-09-24T14:32:23.243Z", worker: "pc:16432:inproc", decisions_seen: 4 }), "");
  assert.equal(progressText(null), "");
  assert.equal(fmtT(7259.533), "2:00:59.5");
});

test("the slug the intake proposes strips the download suffix and the extension", () => {
  assert.equal(slugFromFilename("He Hated All Women_Media_(AbCdEfGhIjK)_(001)_(1080)p.mp4"), "he-hated-all-women");
  assert.equal(slugFromFilename("C:\\Users\\x\\Downloads\\The Cold CEO (1080p).mp4"), "the-cold-ceo");
  assert.equal(slugFromFilename("ep01.mp4"), "ep01");
  assert.equal(slugFromFilename("___.mp4"), "");
  assert.equal(titleFromSlug("he-hated-all-women"), "He Hated All Women");
});

test("the contract's zod: a new run body and every decision kind, as the routes parse them", () => {
  const body = { producer_id: "00000000-0000-4000-8000-000000000001", source_path: "C:/x/a.mp4", bucket: "low-quality", slug: "the-cold-ceo", mode: "by_eye_2min", lang: "en", settings: { to_s: 900, no_delogo: true, vision: "handoff" } };
  assert.ok(NewRunBodySchema.safeParse(body).success);
  assert.equal(NewRunBodySchema.safeParse({ ...body, mode: "narrated" }).success, false);
  assert.equal(NewRunBodySchema.safeParse({ ...body, slug: "Bad Slug" }).success, false);
  assert.equal(NewRunBodySchema.safeParse({ ...body, bucket: "high-quality" }).success, false);
  assert.equal(NewRunBodySchema.safeParse({ ...body, settings: { unknown: 1 } }).success, false);
  const ok = [
    { kind: "watermark", accept: true },
    { kind: "watermark", region: { x: 0.1, y: 0.8, w: 0.6, h: 0.1 } },
    { kind: "watermark", no_delogo: true },
    { kind: "unmark", action: "find" },
    { kind: "cards", templates: [121.4, 243.9] },
    { kind: "boundary", boundary_s: 115.367, action: "accept" },
    { kind: "boundary", boundary_s: 115.367, action: "move", to_t: 114.333, reason: null },
    { kind: "boundary", boundary_s: 115.367, action: "reject", reason: "before the punch" },
    { kind: "apply_review" },
    { kind: "join", join_index: 3, to_t: 315.533 },
    { kind: "film_meta", display_title_en: "He Hated All Women", crazydramas_slug: "he-hated-all-women", spoiler_from_s: 3600, exclusions: [{ from_s: 0, to_s: 3, why: "stinger", kind: "stinger" }], live_poster: null },
    { kind: "import_now" },
    { kind: "handoff_vision" },
    { kind: "handoff_vision", output_path: "C:/Users/x/task.output" },
    { kind: "retry" },
    { kind: "note", text: "looked at ep 3" },
  ];
  for (const d of ok) assert.ok(DecisionBodySchema.safeParse(d).success, JSON.stringify(d));
  const bad = [
    { kind: "watermark", region: { x: 10, y: 20, w: 100, h: 50 } },
    { kind: "cards", templates: [] },
    { kind: "boundary", boundary_s: 1, action: "drop" },
    { kind: "join", join_index: 0, to_t: 1 },
    { kind: "film_meta", display_title_en: "", crazydramas_slug: null, spoiler_from_s: null, exclusions: [], live_poster: null },
    { kind: "film_meta", display_title_en: "x", crazydramas_slug: "Bad Slug" },
    { kind: "note", text: "" },
    { kind: "nope" },
  ];
  for (const d of bad) assert.equal(DecisionBodySchema.safeParse(d).success, false, JSON.stringify(d));
});
