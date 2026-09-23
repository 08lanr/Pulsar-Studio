// The film-run rows (decision 2026-09-23; migration 0016), pinned in fixture
// mode so both backends share them: a run is created by staff with the
// input validated (narrated refused, the slug plain, the settings typed); a
// producer reads their own company's runs only and writes nothing; a claim is
// a CAS on the revision plus a ten-minute lease, lost races answer null; a
// renewal needs the lease and leaves the revision alone; a stage write is
// revision-conditional and respects a foreign live lease; a decision appends
// with who and when; a release clears the lease; the run survives the
// fixture store's persistence round trip; and the newest job by target.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fixtureSession, systemSession } from "@/lib/auth";
import { FILM_RUN_LEASE_MS, isDataError } from "@/lib/data";
import { claimFields, filmRunRow, leaseHeldBy, leaseHeldByOther, releaseFields, renewFields, stageFields, validateFilmRunSettings } from "@/lib/data/film-runs";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import type { FilmRun } from "@/lib/types";
import { producer, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

const viewer = () => ({ ...producer(), producerRole: "viewer" as const });

async function newRun(overrides: Partial<Parameters<typeof fixtureData.createFilmRun>[1]> = {}): Promise<FilmRun> {
  return fixtureData.createFilmRun(staff(), {
    producer_id: producer().producerId!,
    source_path: "C:\\Users\\ruobi\\Downloads\\film_Media_(abcdefghijk)_(001)_(1080)p.mp4",
    bucket: "low-quality",
    slug: "she-returned-with-her-son",
    mode: "by_eye_2min",
    ...overrides,
  });
}

async function expectCode(code: string, fn: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (isDataError(e) && e.code === code) return;
    throw e;
  }
  assert.fail(`${what}: expected ${code}`);
}

// ---- create and read ------------------------------------------------------------------------------

test("staff create a run with the row born queued, revision 1, no lease; the input is validated the same way in both backends", async () => {
  resetFixtureStore();
  const run = await newRun({ settings: { target_s: 120, band: [95, 150], threads: 2, allow_dirty: true }, lang: "EN" });
  assert.match(run.id, /^[0-9a-f-]{36}$/);
  assert.equal(run.stage, "queued");
  assert.equal(run.revision, 1);
  assert.equal(run.lease_owner, null);
  assert.equal(run.leased_until, null);
  assert.equal(run.lang, "en", "the language code is lowercased");
  assert.equal(run.source_path, "C:/Users/ruobi/Downloads/film_Media_(abcdefghijk)_(001)_(1080)p.mp4", "stored with forward slashes");
  assert.deepEqual(run.settings, { target_s: 120, band: [95, 150], threads: 2, allow_dirty: true });
  assert.deepEqual(run.stage_detail, {});
  assert.deepEqual(run.decisions, []);
  assert.equal(run.drama_remix_sha, null);
  assert.equal(run.drama_remix_dirty, false);
  assert.equal(run.title_id, null);
  assert.equal(run.error_text, null);
  assert.equal(run.created_by, staff().userId);

  const sys = await fixtureData.createFilmRun(systemSession(), { producer_id: producer().producerId!, source_path: "/x/y.mp4", bucket: "low-quality", slug: "the-cold-ceo", mode: "source_episodes", stage: "intake" });
  assert.equal(sys.created_by, null, "the system actor has no profile row");
  assert.equal(sys.stage, "intake");

  await expectCode("invalid", () => newRun({ mode: "narrated" }), "narrated is reserved for the next phase");
  await expectCode("invalid", () => newRun({ mode: "cut" as never }), "an unknown mode");
  await expectCode("invalid", () => newRun({ slug: "She Returned" }), "a slug with spaces");
  await expectCode("invalid", () => newRun({ slug: "../escape" }), "a slug that walks out");
  await expectCode("invalid", () => newRun({ bucket: "low quality" }), "a bucket with a space");
  await expectCode("invalid", () => newRun({ source_path: "  " }), "no source path");
  await expectCode("invalid", () => newRun({ settings: { band: [150, 95] } }), "a band the wrong way round");
  await expectCode("invalid", () => newRun({ settings: { threads: 0 } }), "zero threads");
  await expectCode("invalid", () => newRun({ settings: { vision: "magic" as never } }), "an unknown vision mode");
  await expectCode("invalid", () => newRun({ settings: { watermark_region: "left" } }), "a region that is not four fractions");
  await expectCode("invalid", () => newRun({ drama_remix_sha: "abc" }), "a short sha");
  await expectCode("not_found", () => newRun({ producer_id: "00000000-0000-4000-8000-00000000dead" }), "a company that does not exist");
  await expectCode("forbidden", () => fixtureData.createFilmRun(producer(), { producer_id: producer().producerId!, source_path: "/x.mp4", bucket: "low-quality", slug: "x", mode: "by_eye_2min" }), "a producer session creates nothing");
});

test("a producer reads their own company's runs only; a foreign run is not found, never forbidden; a producer writes nothing", async () => {
  resetFixtureStore();
  const mine = await newRun();
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家" });
  const theirs = await newRun({ producer_id: other.id, slug: "their-film" });

  assert.equal((await fixtureData.getFilmRun(producer(), mine.id)).id, mine.id);
  assert.equal((await fixtureData.getFilmRun(viewer(), mine.id)).id, mine.id, "a viewer reads too");
  await expectCode("not_found", () => fixtureData.getFilmRun(producer(), theirs.id), "another company's run");
  await expectCode("not_found", () => fixtureData.getFilmRun(staff(), "00000000-0000-4000-8000-00000000dead"), "a run that does not exist");

  assert.deepEqual((await fixtureData.listFilmRuns(producer())).map((r) => r.id), [mine.id]);
  assert.deepEqual((await fixtureData.listFilmRuns(producer(), { producerId: other.id })), [], "asking for another company reads empty");
  assert.deepEqual((await fixtureData.listFilmRuns(staff())).map((r) => r.id).sort(), [mine.id, theirs.id].sort(), "staff see every company");
  assert.deepEqual((await fixtureData.listFilmRuns(staff(), { producerId: other.id })).map((r) => r.id), [theirs.id]);
  assert.deepEqual((await fixtureData.listFilmRuns(systemSession())).length, 2);

  for (const [what, fn] of [
    ["claim", () => fixtureData.claimFilmRun(producer(), mine.id, { owner: "me", revision: 1 })],
    ["renew", () => fixtureData.renewFilmRunLease(producer(), mine.id, { owner: "me" })],
    ["stage", () => fixtureData.setFilmRunStage(producer(), mine.id, { stage: "index", revision: 1 })],
    ["decision", () => fixtureData.appendFilmRunDecision(producer(), mine.id, { action: "accept", boundary_s: 115.367 })],
    ["release", () => fixtureData.releaseFilmRun(producer(), mine.id, { owner: "me" })],
  ] as const) {
    await expectCode("forbidden", fn, `a producer ${what}s nothing`);
  }
});

test("listFilmRuns is newest first", async () => {
  resetFixtureStore();
  const a = await newRun({ slug: "film-a" });
  await new Promise((r) => setTimeout(r, 2));
  const b = await newRun({ slug: "film-b" });
  assert.deepEqual((await fixtureData.listFilmRuns(staff())).map((r) => r.id), [b.id, a.id]);
});

// ---- claim, renew, release --------------------------------------------------------------------------------

test("a claim is a CAS on the revision plus a ten-minute lease; a lost race answers null, never a throw", async () => {
  resetFixtureStore();
  const run = await newRun();
  const before = Date.now();
  const claimed = await fixtureData.claimFilmRun(systemSession(), run.id, { owner: "host:1", revision: run.revision });
  assert.ok(claimed, "the first claim wins");
  assert.equal(claimed.lease_owner, "host:1");
  assert.equal(claimed.revision, 2, "the claim bumps the revision");
  const until = Date.parse(claimed.leased_until!);
  assert.ok(until >= before + FILM_RUN_LEASE_MS - 50 && until <= Date.now() + FILM_RUN_LEASE_MS + 50, "ten minutes from now");

  assert.equal(await fixtureData.claimFilmRun(systemSession(), run.id, { owner: "host:2", revision: run.revision }), null, "a stale revision loses");
  assert.equal(await fixtureData.claimFilmRun(systemSession(), run.id, { owner: "host:2", revision: claimed.revision }), null, "a live lease of another worker refuses");
  const again = await fixtureData.claimFilmRun(staff(), run.id, { owner: "host:1", revision: claimed.revision });
  assert.ok(again, "the holder may re-claim (a restarted loop with the same name)");
  assert.equal(again.revision, 3);
  assert.equal((await fixtureData.getFilmRun(staff(), run.id)).lease_owner, "host:1");
  await expectCode("not_found", () => fixtureData.claimFilmRun(staff(), "00000000-0000-4000-8000-00000000dead", { owner: "x", revision: 1 }), "a run that does not exist");
  await expectCode("invalid", () => fixtureData.claimFilmRun(staff(), run.id, { owner: " ", revision: 3 }), "no owner");
});

test("an expired lease is free for anyone; a renewal needs the lease and leaves the revision alone", async () => {
  resetFixtureStore();
  const run = await newRun();
  const claimed = (await fixtureData.claimFilmRun(systemSession(), run.id, { owner: "host:1", revision: 1, leaseMs: 1 }))!;
  await new Promise((r) => setTimeout(r, 5));
  const taken = await fixtureData.claimFilmRun(systemSession(), run.id, { owner: "host:2", revision: claimed.revision });
  assert.ok(taken, "an expired lease is adopted");
  assert.equal(taken.lease_owner, "host:2");

  await expectCode("conflict", () => fixtureData.renewFilmRunLease(systemSession(), run.id, { owner: "host:1" }), "the old holder lost the lease");
  const renewed = await fixtureData.renewFilmRunLease(systemSession(), run.id, { owner: "host:2", leaseMs: FILM_RUN_LEASE_MS * 2 });
  assert.equal(renewed.revision, taken.revision, "a renewal does not touch the CAS token");
  assert.ok(Date.parse(renewed.leased_until!) > Date.parse(taken.leased_until!), "the lease moved on");
  const shorter = await fixtureData.renewFilmRunLease(systemSession(), run.id, { owner: "host:2", leaseMs: 60_000 });
  assert.ok(Date.parse(shorter.leased_until!) < Date.parse(renewed.leased_until!), "a renewal sets the lease from now, whatever it was");
  const fresh = await newRun({ slug: "unleased" });
  await expectCode("conflict", () => fixtureData.renewFilmRunLease(systemSession(), fresh.id, { owner: "host:2" }), "a run nobody leased");
});

test("a release clears the lease while it is ours or expired, and refuses another worker's live lease", async () => {
  resetFixtureStore();
  const run = await newRun();
  const claimed = (await fixtureData.claimFilmRun(systemSession(), run.id, { owner: "host:1", revision: 1 }))!;
  await expectCode("conflict", () => fixtureData.releaseFilmRun(systemSession(), run.id, { owner: "host:2" }), "not the holder");
  const released = await fixtureData.releaseFilmRun(systemSession(), run.id, { owner: "host:1" });
  assert.equal(released.lease_owner, null);
  assert.equal(released.leased_until, null);
  assert.equal(released.revision, claimed.revision + 1);
  const twice = await fixtureData.releaseFilmRun(staff(), run.id, { owner: "host:3" });
  assert.equal(twice.lease_owner, null, "releasing a free run is allowed (a crash recovery)");
});

// ---- stage and decisions ------------------------------------------------------------------------------------

test("a stage write is revision-conditional, respects a foreign live lease, keeps error_text as given and records the sync", async () => {
  resetFixtureStore();
  const run = await newRun();
  const r1 = await fixtureData.setFilmRunStage(systemSession(), run.id, { stage: "intake", stage_detail: { step: "sync" }, revision: run.revision, drama_remix_sha: "a".repeat(40), drama_remix_dirty: true });
  assert.equal(r1.stage, "intake");
  assert.deepEqual(r1.stage_detail, { step: "sync" });
  assert.equal(r1.revision, 2);
  assert.equal(r1.drama_remix_sha, "a".repeat(40));
  assert.equal(r1.drama_remix_dirty, true);
  await expectCode("conflict", () => fixtureData.setFilmRunStage(systemSession(), run.id, { stage: "index", revision: 1 }), "a stale revision");
  await expectCode("invalid", () => fixtureData.setFilmRunStage(systemSession(), run.id, { stage: "flying" as never, revision: 2 }), "an unknown stage");
  await expectCode("invalid", () => fixtureData.setFilmRunStage(systemSession(), run.id, { stage: "index", revision: 2, stage_detail: [1] as never }), "a detail that is not an object");

  const claimed = (await fixtureData.claimFilmRun(systemSession(), run.id, { owner: "host:1", revision: 2 }))!;
  await expectCode("conflict", () => fixtureData.setFilmRunStage(staff(), run.id, { stage: "index", revision: claimed.revision, owner: "host:2" }), "another worker names itself while host:1 holds the lease");
  const byStaff = await fixtureData.setFilmRunStage(staff(), run.id, { stage: "review", revision: claimed.revision });
  assert.equal(byStaff.stage, "review", "without an owner the CAS alone decides (the review screen moving a run on)");
  const failed = await fixtureData.setFilmRunStage(systemSession(), run.id, { stage: "failed", revision: byStaff.revision, owner: "host:1", error_text: "REFUSED: this film has delivered cuts (review/cuts-0-900-DELIVERED.json)." });
  assert.match(failed.error_text ?? "", /^REFUSED/);
  assert.deepEqual(failed.stage_detail, { step: "sync" }, "a stage write without detail keeps the last detail");
  const cleared = await fixtureData.setFilmRunStage(systemSession(), run.id, { stage: "plan", revision: failed.revision, error_text: null, stage_detail: {} });
  assert.equal(cleared.error_text, null);
  assert.deepEqual(cleared.stage_detail, {});
});

test("a decision appends with who and when, validated, bumping the revision; the audit trail records it", async () => {
  resetFixtureStore();
  const run = await newRun();
  const t0 = Date.now();
  const r1 = await fixtureData.appendFilmRunDecision(staff(), run.id, { action: "move", boundary_s: 214.733, to_s: 213.5, why: "the punch lands at 213.2; leave the aftermath" });
  assert.equal(r1.decisions.length, 1);
  assert.equal(r1.decisions[0].by, staff().userId);
  assert.ok(Date.parse(r1.decisions[0].at) >= t0);
  assert.equal(r1.decisions[0].action, "move");
  assert.equal(r1.decisions[0].to_s, 213.5);
  assert.equal(r1.revision, 2);
  const r2 = await fixtureData.appendFilmRunDecision(systemSession(), run.id, { action: "note", boundary_s: null, data: { stage: "watermark", box: { x: 1, y: 2 } } });
  assert.equal(r2.decisions.length, 2);
  assert.equal(r2.decisions[1].by, "system");
  assert.deepEqual(r2.decisions[1].data, { stage: "watermark", box: { x: 1, y: 2 } });
  const named = await fixtureData.appendFilmRunDecision(systemSession(), run.id, { action: "accept", boundary_s: 115.367, by: "ruobin" });
  assert.equal(named.decisions[2].by, "ruobin", "a decision may name the person the worker applied it for");
  await expectCode("invalid", () => fixtureData.appendFilmRunDecision(staff(), run.id, { action: " ", boundary_s: 1 }), "no action");
  await expectCode("invalid", () => fixtureData.appendFilmRunDecision(staff(), run.id, { action: "move", boundary_s: -1 }), "a negative time");
});

// ---- persistence ----------------------------------------------------------------------------------------------

test("the fixture store persists film runs and reads them back", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "studio-film-runs-"));
  const file = path.join(dir, "state.json");
  const prevPersist = process.env.FIXTURE_PERSIST;
  const prevFile = process.env.FIXTURE_STATE_FILE;
  const prevSeed = process.env.FIXTURE_SEED;
  process.env.FIXTURE_PERSIST = "on";
  process.env.FIXTURE_STATE_FILE = file;
  delete process.env.FIXTURE_SEED; // persistence only runs on the demo seed
  try {
    resetFixtureStore("demo");
    const demoProducer = (await fixtureData.listProducers(staff()))[0];
    const run = await fixtureData.createFilmRun(staff(), { producer_id: demoProducer.id, source_path: "/x.mp4", bucket: "low-quality", slug: "persisted-film", mode: "by_eye_2min" });
    // The debounced writer runs 1.5 s after the last access; wait for it.
    for (let i = 0; i < 40 && !require("node:fs").existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
    const saved = JSON.parse(readFileSync(file, "utf8")) as { db: { film_runs: FilmRun[] } };
    assert.ok(saved.db.film_runs.some((r) => r.id === run.id), "the run is in the saved state");
  } finally {
    if (prevPersist === undefined) delete process.env.FIXTURE_PERSIST;
    else process.env.FIXTURE_PERSIST = prevPersist;
    if (prevFile === undefined) delete process.env.FIXTURE_STATE_FILE;
    else process.env.FIXTURE_STATE_FILE = prevFile;
    if (prevSeed === undefined) delete process.env.FIXTURE_SEED;
    else process.env.FIXTURE_SEED = prevSeed;
    resetFixtureStore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- jobs by target -----------------------------------------------------------------------------------------------

test("latestJobByTarget: the newest job on a run, by kind, staff or the system only", async () => {
  resetFixtureStore();
  const run = await newRun();
  assert.equal(await fixtureData.latestJobByTarget(systemSession(), "film_run", run.id), null);
  const j1 = await fixtureData.recordJob(systemSession(), { kind: "segment_film", title_id: null, target_type: "film_run", target_id: run.id, idempotency_key: `segment:${run.id}:1`, input: { stage: "index" } });
  await fixtureData.finishJob(systemSession(), j1.id, { status: "done", cost_cents: 0 });
  await new Promise((r) => setTimeout(r, 2));
  const j2 = await fixtureData.recordJob(systemSession(), { kind: "segment_film", title_id: null, target_type: "film_run", target_id: run.id, idempotency_key: `segment:${run.id}:2` });
  assert.equal((await fixtureData.latestJobByTarget(systemSession(), "film_run", run.id, "segment_film"))?.id, j2.id);
  assert.equal((await fixtureData.latestJobByTarget(staff(), "film_run", run.id))?.id, j2.id);
  assert.equal(await fixtureData.latestJobByTarget(staff(), "film_run", run.id, "import_film"), null, "another kind");
  await expectCode("forbidden", () => fixtureData.latestJobByTarget(producer(), "film_run", run.id), "a producer never reads a job by target");
});

// ---- the pure rules (what the Supabase layer applies to the row it read) -----------------------------------------------

test("the shared rules: lease liveness, claim / renew / stage / release fields, settings", () => {
  const base: FilmRun = {
    id: "r", producer_id: "p", title_id: null, source_path: "/x.mp4", bucket: "low-quality", slug: "x", mode: "by_eye_2min", lang: "en", settings: {}, stage: "queued", stage_detail: {},
    drama_remix_sha: null, drama_remix_dirty: false, lease_owner: null, leased_until: null, revision: 4, error_text: null, decisions: [], created_by: null, created_at: "2026-09-23T00:00:00.000Z", updated_at: "2026-09-23T00:00:00.000Z",
  };
  const t = Date.parse("2026-09-23T12:00:00.000Z");
  const live: FilmRun = { ...base, lease_owner: "a", leased_until: new Date(t + 60_000).toISOString() };
  const expired: FilmRun = { ...base, lease_owner: "a", leased_until: new Date(t - 1).toISOString() };
  assert.equal(leaseHeldByOther(live, "b", t), true);
  assert.equal(leaseHeldByOther(live, "a", t), false);
  assert.equal(leaseHeldByOther(expired, "b", t), false);
  assert.equal(leaseHeldBy(live, "a", t), true);
  assert.equal(leaseHeldBy(expired, "a", t), false);

  assert.equal(claimFields(base, { owner: "b", revision: 3 }, t), null, "a stale revision");
  assert.equal(claimFields(live, { owner: "b", revision: 4 }, t), null, "a live foreign lease");
  assert.deepEqual(claimFields(expired, { owner: "b", revision: 4 }, t), { lease_owner: "b", leased_until: new Date(t + FILM_RUN_LEASE_MS).toISOString(), revision: 5, updated_at: new Date(t).toISOString() });
  assert.throws(() => renewFields(live, { owner: "b" }, t), /leased by a/);
  assert.equal(renewFields(live, { owner: "a", leaseMs: 1000 }, t).leased_until, new Date(t + 1000).toISOString());
  assert.throws(() => stageFields(base, { stage: "index", revision: 3 }, t), /changed/);
  assert.throws(() => stageFields(live, { stage: "index", revision: 4, owner: "b" }, t), /leased by a/);
  assert.equal(stageFields(live, { stage: "index", revision: 4, owner: "a" }, t).revision, 5);
  assert.throws(() => releaseFields(live, { owner: "b" }, t), /leased by a/);
  assert.deepEqual(releaseFields(expired, { owner: "b" }, t), { lease_owner: null, leased_until: null, revision: 5, updated_at: new Date(t).toISOString() });

  assert.deepEqual(validateFilmRunSettings(undefined), {});
  assert.deepEqual(validateFilmRunSettings({ to_s: 900, extra: "kept" }), { to_s: 900, extra: "kept" });
  assert.throws(() => validateFilmRunSettings([] as never), /object/);
  const row = filmRunRow({ producer_id: "p", source_path: "C:\\a\\b.mp4", bucket: "low-quality", slug: "a-b_c", mode: "source_episodes", lang: "zh" });
  assert.equal(row.source_path, "C:/a/b.mp4");
  assert.equal(row.stage, "queued");
  assert.equal(row.revision, 1);
});
