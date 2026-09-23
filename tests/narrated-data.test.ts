// The narrated run's rows (decision 2026-09-23 "Narrated mode in Studio";
// migration 0018), pinned in fixture mode so both backends share them: a
// narrated run lives in the high-quality bucket only; its settings are typed
// (the N2 keys) and resolved with the defaults and the intake answer; the
// episode rows are written once from the approved plan (numbers contiguous
// from the season's first, windows in order), a number another live run of
// the season holds is refused, a producer reads none and writes none; a
// claim is a CAS plus a lease, a lane write is revision-conditional and the
// final watch stamps who approved; a decision can name its episode.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { isDataError } from "@/lib/data";
import { FILM_ASSET_KINDS } from "@/lib/data/film-import";
import { decisionRow, filmRunRow, heldNumbersConflict, runEpisodeRows, validateFilmRunSettings } from "@/lib/data/film-runs";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { NARRATED_DEFAULTS, intakePatch, missingNarratedSettings, resolveNarratedSettings, sourceLabelOf } from "@/lib/segment/settings";
import type { FilmRun } from "@/lib/types";
import { producer, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

async function expectCode(code: string, fn: () => unknown, what: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (isDataError(e) && e.code === code) return;
    throw e;
  }
  assert.fail(`${what}: expected ${code}`);
}

const season = { series_key: "love-between-lines", first_episode_n: 36, prior_projects: ["lbl-e04"], series_title: "Love Between Lines" };

async function narratedRun(overrides: Partial<Parameters<typeof fixtureData.createFilmRun>[1]> = {}): Promise<FilmRun> {
  return fixtureData.createFilmRun(staff(), {
    producer_id: producer().producerId!,
    source_path: "C:/Users/ruobi/Downloads/Love Between Lines/s01e05.mp4",
    bucket: "high-quality",
    slug: "lbl-s01e05",
    mode: "narrated",
    lang: "zh",
    settings: { season, sheet_premise: "Hu Xiu, a Shanghai office worker…", narrator: "Hu Xiu" },
    ...overrides,
  });
}

// ---- the run ------------------------------------------------------------------------------------------------

test("a narrated run is created in the high-quality bucket only, with its N2 settings typed", async () => {
  resetFixtureStore();
  const run = await narratedRun();
  assert.equal(run.mode, "narrated");
  assert.equal(run.bucket, "high-quality");
  assert.deepEqual(run.settings.season, season);
  await expectCode("invalid", () => narratedRun({ bucket: "low-quality", slug: "lbl-x" }), "narrated outside high-quality");
  await expectCode("invalid", () => narratedRun({ slug: "b", settings: { season: { ...season, series_key: "Love Between" } } }), "a series key with a space");
  await expectCode("invalid", () => narratedRun({ slug: "c", settings: { season: { ...season, first_episode_n: 0 } } }), "a first number of 0");
  await expectCode("invalid", () => narratedRun({ slug: "d", settings: { season: { ...season, prior_projects: ["../escape"] } } }), "a prior project that walks out");
  await expectCode("invalid", () => narratedRun({ slug: "e", settings: { voice_id: "sk_0123456789abcdef0123456789abcdef0123" } }), "a key where the voice id goes");
  await expectCode("invalid", () => narratedRun({ slug: "f", settings: { creative: "robot" as never } }), "an unknown creative mode");
  await expectCode("invalid", () => narratedRun({ slug: "g", settings: { deliver_to: "C:/OneDrive" as never } }), "a OneDrive copy");
  await expectCode("invalid", () => narratedRun({ slug: "h", settings: { reframe_review: "sometimes" as never } }), "an unknown reframe review");
  await expectCode("invalid", () => narratedRun({ slug: "i", settings: { scan: { t0: 50, t1: 10 } } }), "a scan that ends before it starts");
  await expectCode("invalid", () => narratedRun({ slug: "j", settings: { episode_target: [260, 165] } }), "a band the wrong way round");
  await expectCode("invalid", () => narratedRun({ slug: "k", settings: { tts_char_budget: -1 } }), "a negative budget");
  // The cut-only rules are unchanged.
  assert.throws(() => filmRunRow({ producer_id: "p", source_path: "/x.mp4", bucket: "low-quality", slug: "x", mode: "by_eye_2min", settings: { band: [150, 95] } }));
});

test("the narrated settings resolve with N2's defaults, and the newest intake answer folds over the row key by key", () => {
  const run = { settings: validateFilmRunSettings({ season: { ...season, prior_projects: ["lbl-e03", "lbl-e04"] }, tts_char_budget: 12_000 }), decisions: [] as FilmRun["decisions"] };
  const s = resolveNarratedSettings(run);
  assert.equal(s.vision, "handoff", "readers stay a hand-off until the N8 bar passes");
  assert.equal(s.creative, "session", "Studio launches the writing sessions itself (amendment 1)");
  assert.equal(s.writer_model, "claude-opus-5-5");
  assert.equal(s.tts_model, "eleven_v3", "always passed as ELEVEN_MODEL");
  assert.equal(s.tts_char_budget, 12_000);
  assert.equal(s.tts_episode_soft_cap, NARRATED_DEFAULTS.tts_episode_soft_cap);
  assert.deepEqual(s.episode_target, [165, 260]);
  assert.deepEqual(s.scan, { t0: 0, t1: null }, "T0 = 0: the scans never skip the first 50 s");
  assert.equal(s.reframe_review, "optional");
  assert.deepEqual(s.season.prior_projects, ["lbl-e03", "lbl-e04"]);
  assert.deepEqual(missingNarratedSettings(s, null), ["sheet_premise", "voice_id"]);
  assert.deepEqual(missingNarratedSettings(s, "cgSgspJ2msm6clMCkdW9"), ["sheet_premise"], "a prior project's manifest gives the voice");

  const answered = { ...run, decisions: [decisionRow({ action: "intake", boundary_s: null, data: { settings: { sheet_premise: "the cast", tts_char_budget: 25_000, season: { ...season, first_episode_n: 40 } } } }, "ruobin")] };
  const s2 = resolveNarratedSettings(answered);
  assert.equal(s2.sheet_premise, "the cast");
  assert.equal(s2.tts_char_budget, 25_000, "a raised budget is an intake answer");
  assert.equal(s2.season.first_episode_n, 40);
  assert.deepEqual(s2.season.prior_projects, ["lbl-e04"], "season merges one level deep: the answer's own list wins");
  assert.deepEqual(intakePatch([decisionRow({ action: "intake", boundary_s: null, data: { settings: { creative: "robot" } } }, "x")]), {}, "an invalid answer folds nothing");
  assert.equal(sourceLabelOf("C:/Downloads/Love.Between.Lines.S01E05.1080p.mp4"), "S01E05");
  assert.equal(sourceLabelOf("C:/Downloads/s1e5.mp4"), "S01E05");
  assert.equal(sourceLabelOf("C:/Downloads/film.mp4"), null);
});

test("a decision can name its episode; anything but a season number is refused", () => {
  const row = decisionRow({ action: "prep", boundary_s: null, ep: 37, data: { action: "approve" } }, "ruobin");
  assert.equal(row.ep, 37);
  assert.equal(decisionRow({ action: "note", boundary_s: null }, "x").ep, undefined);
  assert.throws(() => decisionRow({ action: "prep", boundary_s: null, ep: 0 }, "x"));
  assert.throws(() => decisionRow({ action: "prep", boundary_s: null, ep: 2.5 }, "x"));
});

// ---- the episode rows -----------------------------------------------------------------------------------------

const plan = [
  { n: 36, src_in: 140, src_out: 392, subtitle: "The tenant", stage_detail: { story: "She meets her tenant." } },
  { n: 37, src_in: 392, src_out: 587 },
  { n: 38, src_in: 587, src_out: 820, title: "EPISODE 38" },
];

test("the approved plan becomes the run's episode rows once: born lanes / prep / waiting, revision 1, EPISODE N by default", async () => {
  resetFixtureStore();
  const run = await narratedRun();
  const eps = await fixtureData.createRunEpisodes(systemSession(), run.id, { series_key: "love-between-lines", episodes: plan, source_duration_s: 2577 });
  assert.deepEqual(eps.map((e) => e.n), [36, 37, 38]);
  assert.equal(eps[0].stage, "lanes");
  assert.equal(eps[0].words_stage, "prep");
  assert.equal(eps[0].picture_stage, "waiting");
  assert.equal(eps[0].revision, 1);
  assert.equal(eps[1].title, "EPISODE 37");
  assert.equal(eps[0].subtitle, "The tenant");
  assert.deepEqual(eps[0].stage_detail, { story: "She meets her tenant." });
  assert.equal(eps[0].series_key, "love-between-lines");
  assert.deepEqual((await fixtureData.listRunEpisodes(staff(), run.id)).map((e) => e.n), [36, 37, 38]);
  assert.equal((await fixtureData.getRunEpisode(staff(), eps[2].id)).title, "EPISODE 38");
  await expectCode("conflict", () => fixtureData.createRunEpisodes(systemSession(), run.id, { series_key: "love-between-lines", episodes: plan }), "a plan is written once");

  const cut = await fixtureData.createFilmRun(staff(), { producer_id: producer().producerId!, source_path: "/x.mp4", bucket: "low-quality", slug: "cut-film", mode: "by_eye_2min" });
  await expectCode("invalid", () => fixtureData.createRunEpisodes(systemSession(), cut.id, { series_key: "x", episodes: plan }), "a cut-only run has no episode rows");
});

test("a plan must number on from the first, keep its windows forward and in order, and stay inside the source", () => {
  const run = { id: "r", mode: "narrated" as const };
  assert.throws(() => runEpisodeRows(run, { series_key: "s", episodes: [{ n: 36, src_in: 0, src_out: 10 }, { n: 38, src_in: 10, src_out: 20 }] }), /contiguous/);
  assert.throws(() => runEpisodeRows(run, { series_key: "s", episodes: [{ n: 1, src_in: 10, src_out: 5 }] }), /src_in < src_out/);
  assert.throws(() => runEpisodeRows(run, { series_key: "s", episodes: [{ n: 1, src_in: 0, src_out: 20 }, { n: 2, src_in: 15, src_out: 30 }] }), /inside episode 1/);
  assert.throws(() => runEpisodeRows(run, { series_key: "s", episodes: [{ n: 1, src_in: 0, src_out: 3000 }], source_duration_s: 2577 }), /past the source/);
  assert.throws(() => runEpisodeRows(run, { series_key: "s", episodes: [] }), /at least one/);
  assert.equal(runEpisodeRows(run, { series_key: "s", episodes: [{ n: 1, src_in: 0, src_out: 2577.3 }], source_duration_s: 2577 }).length, 1, "half a second of slack at the end");
});

test("a number another live run of the season holds is refused; a cancelled run's and a dropped episode's are free", async () => {
  resetFixtureStore();
  const first = await narratedRun();
  await fixtureData.createRunEpisodes(systemSession(), first.id, { series_key: "love-between-lines", episodes: plan });
  const second = await narratedRun({ slug: "lbl-s01e05-again" });
  await expectCode("conflict", () => fixtureData.createRunEpisodes(systemSession(), second.id, { series_key: "love-between-lines", episodes: [{ n: 38, src_in: 0, src_out: 200 }] }), "ep38 is held");
  // Another season is another key.
  const other = await narratedRun({ slug: "other-show", settings: { season: { ...season, series_key: "other-show" } } });
  assert.equal((await fixtureData.createRunEpisodes(systemSession(), other.id, { series_key: "other-show", episodes: [{ n: 38, src_in: 0, src_out: 200 }] })).length, 1);
  // A cancelled run frees its numbers.
  const cancelled = await fixtureData.setFilmRunStage(staff(), first.id, { stage: "cancelled", revision: (await fixtureData.getFilmRun(staff(), first.id)).revision });
  assert.equal(cancelled.stage, "cancelled");
  assert.equal((await fixtureData.createRunEpisodes(systemSession(), second.id, { series_key: "love-between-lines", episodes: [{ n: 38, src_in: 0, src_out: 200 }] })).length, 1);
  assert.equal(heldNumbersConflict([5], [{ run_id: "a", n: 5, stage: "dropped" }], () => "episode_work"), null, "a dropped episode frees its number");
  assert.match(heldNumbersConflict([5], [{ run_id: "abcdef12", n: 5, stage: "lanes" }], () => "episode_work") ?? "", /ep5 \(run abcdef12\)/);
});

test("a producer reads no episode rows and writes none; a foreign run is not found", async () => {
  resetFixtureStore();
  const run = await narratedRun();
  const [ep] = await fixtureData.createRunEpisodes(systemSession(), run.id, { series_key: "love-between-lines", episodes: plan });
  assert.deepEqual(await fixtureData.listRunEpisodes(producer(), run.id), [], "staff only, as RLS: the company's own run lists no rows");
  await expectCode("not_found", () => fixtureData.getRunEpisode(producer(), ep.id), "one episode");
  await expectCode("forbidden", () => fixtureData.claimRunEpisode(producer(), ep.id, { owner: "p", revision: 1 }), "a producer claim");
  await expectCode("forbidden", () => fixtureData.setRunEpisodeStage(producer(), ep.id, { revision: 1, words_stage: "voice" }), "a producer write");
  await expectCode("forbidden", () => fixtureData.createRunEpisodes(producer(), run.id, { series_key: "love-between-lines", episodes: plan }), "a producer plan");
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家" });
  const theirs = await narratedRun({ producer_id: other.id, slug: "their-show", settings: { season: { ...season, series_key: "their-show" } } });
  await expectCode("not_found", () => fixtureData.listRunEpisodes(producer(), theirs.id), "another company's run");
});

test("a lane claims its episode with a CAS and a lease, writes revision-conditionally, and lets go; the final watch stamps who approved", async () => {
  resetFixtureStore();
  const run = await narratedRun();
  const [ep] = await fixtureData.createRunEpisodes(systemSession(), run.id, { series_key: "love-between-lines", episodes: plan });
  const sys = systemSession();
  const claimed = await fixtureData.claimRunEpisode(sys, ep.id, { owner: "host:1", revision: ep.revision });
  assert.ok(claimed);
  assert.equal(claimed!.lease_owner, "host:1");
  assert.equal(claimed!.revision, 2);
  assert.equal(await fixtureData.claimRunEpisode(sys, ep.id, { owner: "host:2", revision: claimed!.revision }), null, "another live lease holds it");
  assert.equal(await fixtureData.claimRunEpisode(sys, ep.id, { owner: "host:2", revision: 1 }), null, "a stale revision loses");
  const renewed = await fixtureData.renewRunEpisodeLease(sys, ep.id, { owner: "host:1" });
  assert.equal(renewed.revision, claimed!.revision, "a renewal leaves the revision alone");
  await expectCode("conflict", () => fixtureData.renewRunEpisodeLease(sys, ep.id, { owner: "host:2" }), "a renewal by another owner");

  const moved = await fixtureData.setRunEpisodeStage(sys, ep.id, { revision: claimed!.revision, owner: "host:1", words_stage: "prep_review", stage_detail: { prep_md: "ep36/PREP.md" } });
  assert.equal(moved.words_stage, "prep_review");
  assert.equal(moved.revision, claimed!.revision + 1);
  await expectCode("conflict", () => fixtureData.setRunEpisodeStage(sys, ep.id, { revision: claimed!.revision, words_stage: "voice" }), "a stale revision");
  await expectCode("conflict", () => fixtureData.setRunEpisodeStage(sys, ep.id, { revision: moved.revision, owner: "host:2", words_stage: "voice" }), "a foreign live lease");
  await expectCode("invalid", () => fixtureData.setRunEpisodeStage(sys, ep.id, { revision: moved.revision, words_stage: "flying" as never }), "an unknown lane stage");
  await expectCode("invalid", () => fixtureData.setRunEpisodeStage(sys, ep.id, { revision: moved.revision, variant: "latest" }), "a variant that is not vK");
  await expectCode("invalid", () => fixtureData.setRunEpisodeStage(sys, ep.id, { revision: moved.revision, gate: { PASS: 1, WARN: -1, FAIL: 0 } }), "a negative gate count");
  await expectCode("invalid", () => fixtureData.setRunEpisodeStage(sys, ep.id, { revision: moved.revision, body_sha256: "abc" }), "a short hash");

  const built = await fixtureData.setRunEpisodeStage(sys, ep.id, { revision: moved.revision, stage: "ep_review", variant: "v2", gate: { PASS: 27, WARN: 5, FAIL: 0 }, body_sha256: "a".repeat(64), shipped_sha256: "b".repeat(64) });
  assert.deepEqual(built.gate, { PASS: 27, WARN: 5, FAIL: 0 });
  const approved = await fixtureData.setRunEpisodeStage(staff(), ep.id, { revision: built.revision, stage: "shipped", approved: true });
  assert.equal(approved.approved_by, staff().userId);
  assert.ok(approved.approved_at);
  const onBehalf = await fixtureData.setRunEpisodeStage(sys, ep.id, { revision: approved.revision, approved: true, approved_by: "ruobin" });
  assert.equal(onBehalf.approved_by, "ruobin");
  const cleared = await fixtureData.setRunEpisodeStage(sys, ep.id, { revision: onBehalf.revision, stage: "lanes", approved: false });
  assert.equal(cleared.approved_by, null);
  assert.equal(cleared.approved_at, null);
  const released = await fixtureData.releaseRunEpisode(sys, ep.id, { owner: "host:1" });
  assert.equal(released.lease_owner, null);
  assert.equal(released.revision, cleared.revision + 1);
});

test("the fixture allows the asset kinds migration 0018 allows, the narrated delivery's five included", () => {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", "0018_narrated_runs.sql"), "utf8");
  const check = /film_assets_kind_check check \(kind in \(([^)]*)\)\)/.exec(sql);
  assert.ok(check, "0018 sets the kind check");
  const kinds = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...FILM_ASSET_KINDS].sort(), kinds.sort());
  for (const k of ["narrated_captions", "narration", "gate_report", "script_doc", "delivery_manifest"] as const) assert.ok(FILM_ASSET_KINDS.includes(k), k);
});
