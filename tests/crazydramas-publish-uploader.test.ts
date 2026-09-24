// Phase 5, "Upload to crazydramas": the per-episode uploader (publish spec
// §8–10; crazydramas docs/STUDIO_API.md "What Studio must do, per episode")
// against the fake. The ledger (studio.cd_publications) through the fixture
// data layer; the bytes read from a real local-tier file; every step
// persisted before the next external call. Resume after a crash at each step
// never creates a second upload and sends bytes from the offset the storage
// acknowledged; a stale lease is adopted, a live one is not; the last-chunk
// check stops on episode_is_current=false; a failed verification blocks the
// publish; a missed webhook is synced; a dead upload is replaced; a Stop
// stops before the next chunk; a transient refusal waits. No network.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { FAKE_UPLOAD_QUANTUM, fakeCrazydramasTransport as fake } from "@/lib/crazydramas/fake";
import { cdIdempotencyKey } from "@/lib/crazydramas/ledger";
import {
  advanceCdPublication,
  getPublishState,
  isCdPublishError,
  publishEpisodes,
  queueUploads,
  resetCrazydramasUploads,
  runTitleUploads,
  saveSeries,
  SimulatedCrash,
  type CrashPoint,
  type UploaderOptions,
} from "@/lib/crazydramas/publish";
import { StudioClient } from "@/lib/crazydramas/studio-client";
import { resetCrazydramasSweep } from "@/lib/crazydramas/sweep";
import type { CrazydramasStudioTransport } from "@/lib/crazydramas/transport";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { localPathOf } from "@/lib/data/storage";
import type { CdPublication, Title } from "@/lib/types";
import { producer, staff } from "./seed-minute";

const Q = FAKE_UPLOAD_QUANTUM;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sys = systemSession();
const temps: string[] = [];
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The uploader in tests: 256 KiB chunks, no real waiting, a missed webhook synced at once. */
const RUN: UploaderOptions & { maxPasses: number } = { chunkBytes: Q, pollMs: 0, sleep: async () => undefined, syncAfterMs: 0, maxPasses: 60 };

beforeEach(() => {
  resetFixtureStore();
  resetCrazydramasSweep();
  resetCrazydramasUploads();
  fake.reset();
  const dir = mkdtempSync(path.join(tmpdir(), "cd-publish-"));
  temps.push(dir);
  process.env.STUDIO_LOCAL_MEDIA_DIR = dir;
});

afterEach(() => {
  resetFixtureStore();
  resetCrazydramasUploads();
  fake.reset();
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  delete process.env.CRAZYDRAMAS_PAYWALL_LIVE;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

type Seeded = { title: Title; slug: string; files: Map<number, Buffer> };

/** An imported title whose episodes are real files in the local tier (the bytes the uploader reads), with their hash, size and frame count. */
async function seriesTitle(slug: string, episodes: { n: number; bytes: number; frames: number }[] = [{ n: 1, bytes: 2 * Q + 5000, frames: 120 }, { n: 2, bytes: Q + 777, frames: 150 }]): Promise<Seeded> {
  const who = producer();
  const title = await fixtureData.createImportedTitle(sys, { producer_id: who.producerId!, source_ref: `low-quality/${slug}`, display_title_en: `Studio ${slug}`, crazydramas_slug: slug, created_by: who.userId });
  const files = new Map<number, Buffer>();
  for (const e of episodes) {
    const buf = randomBytes(e.bytes);
    const digest = sha(buf);
    const stored = `local/${title.id}/ws/${slug}/ep${String(e.n).padStart(2, "0")}-${digest.slice(0, 8)}.mp4`;
    const abs = localPathOf(stored);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    await fixtureData.addVideoOnlyEpisode(sys, title.id, e.n, stored, { video_sha256: digest, video_bytes: e.bytes, video_frames: e.frames, duration_ms: Math.round((e.frames / 30) * 1000), auto_cut: false });
    files.set(e.n, buf);
  }
  return { title, slug, files };
}

/** The draft series and the queued rows, nothing sent yet. */
async function queued(slug: string, episodes?: { n: number; bytes: number; frames: number }[], freeCount = 1): Promise<Seeded & { rows: CdPublication[] }> {
  const s = await seriesTitle(slug, episodes);
  await saveSeries(producer(), s.title.id, { title: `Studio ${slug}`, free_episode_count: freeCount });
  const q = await queueUploads(producer(), s.title.id, { episodes: "all" }, { schedule: false });
  assert.deepEqual(q.queued, [...s.files.keys()]);
  return { ...s, rows: await fixtureData.getCdPublications(sys, s.title.id) };
}

const rowOf = async (titleId: string, n: number) => (await fixtureData.getCdPublications(sys, titleId)).filter((r) => r.episode_number === n && r.step !== "superseded").at(-1)!;

/** Episode n's file becomes `buf` (a re-cut, or the earlier file brought back), in the local tier, as an import would record it. */
async function setFile(s: Seeded, n: number, buf: Buffer, frames = 120): Promise<void> {
  const ep = (await fixtureData.listTitleEpisodes(sys, s.title.id)).find((e) => e.number === n)!;
  const digest = sha(buf);
  const stored = `local/${s.title.id}/ws/${s.slug}/ep${String(n).padStart(2, "0")}-${digest.slice(0, 8)}.mp4`;
  writeFileSync(localPathOf(stored), buf);
  await fixtureData.setEpisodeImport(sys, ep.id, { video_path: stored, video_sha256: digest, video_bytes: buf.byteLength, video_frames: frames, duration_ms: Math.round((frames / 30) * 1000) });
}

/** A CMS upload takes episode n over and finishes: its asset is ready on the episode. Returns that asset's id. */
async function cmsReupload(slug: string, n: number): Promise<string> {
  const upload = fake.takeOver(slug, n);
  await fake.putUploadChunk(`fake-mux://upload/${upload}`, new Uint8Array(1000), { first: 0, last: 999, total: 1000 });
  fake.settleAll();
  const asset = fake.seriesState(slug)!.episodes.find((e) => e.episode_number === n)!.mux_asset_id;
  assert.ok(asset, "the CMS's asset is on the episode");
  return asset;
}

const plannedRow = async (titleId: string) => (await fixtureData.getCdPublications(sys, titleId)).find((r) => r.step === "planned")!;

// ---- the whole way ----------------------------------------------------------------------------------------------------

test("the whole way: draft series, both episodes uploaded in 256 KiB-multiple chunks from the local tier, verified by external_id and the frame rule, never published by the upload; one Mux upload per episode", async () => {
  const s = await queued("whole-way-series");
  for (const r of s.rows) {
    assert.equal(r.step, "planned");
    assert.equal(r.idempotency_key, cdIdempotencyKey(s.title.id, r.episode_number, r.sha256));
    assert.equal(r.fps, 30);
  }
  const summary = await runTitleUploads(s.title.id, RUN);
  assert.deepEqual(summary.verified.sort(), [1, 2]);
  assert.deepEqual(summary.failed, []);
  for (const [n, buf] of s.files) {
    const row = await rowOf(s.title.id, n);
    assert.equal(row.step, "verified");
    assert.equal(row.bytes_acked, buf.byteLength);
    assert.deepEqual(row.verify, { external_id_ok: true, d_frames: 2, verdict: "same_length" });
    assert.equal(row.lease_owner, null, "a verified row holds no lease");
    const uploads = fake.uploadsFor(s.slug, n);
    assert.equal(uploads.length, 1, `one upload for episode ${n}`);
    assert.equal(uploads[0].received_sha256, sha(buf), "Mux holds exactly the file's bytes");
    for (const c of fake.chunks.filter((x) => x.upload_id === uploads[0].id && x.bytes > 0 && x.last !== null && x.last + 1 !== x.total)) {
      assert.equal(c.bytes % Q, 0, "every chunk but the last is a multiple of 256 KiB");
    }
  }
  const platform = fake.seriesState(s.slug)!;
  assert.equal(platform.drama.status, "draft", "uploading never publishes");
  assert.ok(platform.episodes.every((e) => e.status === "ready" && !e.is_published));
  const ledger = JSON.stringify(await fixtureData.getCdPublications(sys, s.title.id));
  assert.doesNotMatch(ledger, /fake-mux:|upload_url|playback/i, "no upload URL and no playback id in the ledger");
  assert.ok(!fake.requests.some((r) => r.path.endsWith("/publish")), "nothing asked crazydramas to publish");

  const again = await queueUploads(producer(), s.title.id, { episodes: [1] }, { schedule: false });
  assert.deepEqual(again.queued, []);
  assert.match(again.skipped[0].reason, /already uploaded and verified/);
  const published = await publishEpisodes(producer(), s.title.id, { episodes: [1], publish_series: true });
  assert.deepEqual(published.published, [1]);
  const refused = await queueUploads(producer(), s.title.id, { episodes: [1] }, { schedule: false });
  assert.match(refused.skipped[0].reason, /already on crazydramas/, "the same sha already published is refused");
});

// ---- crash and resume ---------------------------------------------------------------------------------------------------

test("a crash at every step resumes from the persisted step: the lease is adopted once stale, no second upload id is created, and bytes resume from the offset the storage acknowledged", async () => {
  const points: CrashPoint[] = ["after_upload_call", "after_chunk", "after_last_chunk", "after_ready", "before_verify"];
  for (const point of points) {
    fake.reset();
    const s = await queued(`crash-${point.replace(/_/g, "-")}`, [{ n: 1, bytes: 2 * Q + 4321, frames: 120 }]);
    const row = s.rows[0];
    let fired = false;
    const crash = (p: CrashPoint) => {
      if (p === point && !fired) {
        fired = true;
        throw new SimulatedCrash(p);
      }
    };
    await assert.rejects(advanceCdPublication(row.id, { ...RUN, owner: "worker-a", leaseMs: 1, crash }), (e: unknown) => e instanceof SimulatedCrash, point);
    const dead = await fixtureData.getCdPublication(sys, row.id);
    assert.equal(dead.lease_owner, "worker-a", `${point}: a dead worker's lease stays until it runs out`);
    const expected: Record<CrashPoint, string> = { after_upload_call: "planned", after_chunk: "upload_created", after_last_chunk: "upload_created", after_ready: "bytes_sent", before_verify: "asset_ready" };
    assert.equal(dead.step, expected[point], `${point}: the persisted step`);
    if (point === "after_upload_call") assert.ok(dead.attempted_at, "the call was recorded as sent before it was sent");
    const serverHad = fake.uploadsFor(s.slug, 1)[0].received;
    const chunksBefore = fake.chunks.length;
    await pause(5);

    const out = await advanceCdPublication(row.id, { ...RUN, owner: "worker-b" });
    assert.equal(out.row.step, "verified", `${point}: worker B finished it`);
    assert.equal(fake.uploadsFor(s.slug, 1).length, 1, `${point}: never a second upload`);
    assert.equal(fake.uploadsFor(s.slug, 1)[0].received_sha256, sha(s.files.get(1)!));
    const resumed = fake.chunks.slice(chunksBefore).filter((c) => c.bytes > 0);
    if (point === "after_chunk") {
      assert.equal(dead.bytes_acked, 0, "the ledger had not heard of the first chunk");
      assert.equal(serverHad, Q, "the storage had");
      assert.equal(resumed[0].first, Q, "worker B's first chunk starts at the acknowledged offset, not at the ledger's");
    }
    if (point === "after_last_chunk" || point === "after_ready" || point === "before_verify") assert.equal(resumed.length, 0, `${point}: no byte sent twice`);
  }
});

test("a live lease is another worker's: the row is skipped with no call; once the lease runs out it is adopted", async () => {
  const s = await queued("lease-series", [{ n: 1, bytes: Q + 10, frames: 120 }]);
  const row = s.rows[0];
  const held = await fixtureData.claimCdPublication(sys, row.id, { owner: "worker-a", revision: row.revision, leaseMs: 60_000 });
  assert.ok(held);
  const skipped = await advanceCdPublication(row.id, { ...RUN, owner: "worker-b" });
  assert.equal(skipped.outcome, "skipped");
  assert.equal(fake.requests.filter((r) => r.path.includes("/episodes/")).length, 0, "no upload call while another worker holds the row");
  assert.equal(await fixtureData.claimCdPublication(sys, row.id, { owner: "worker-c", revision: held!.revision }), null, "the race is lost on a live lease");
  const short = await fixtureData.claimCdPublication(sys, row.id, { owner: "worker-a", revision: held!.revision, leaseMs: 1 });
  assert.ok(short, "the holder renews it");
  await pause(5);
  const adopted = await advanceCdPublication(row.id, { ...RUN, owner: "worker-b" });
  assert.equal(adopted.row.step, "verified");
});

// ---- the last-chunk check ------------------------------------------------------------------------------------------------

test("the last-chunk check: a CMS upload takes the episode over mid-file, so the last chunk is never sent, Studio's upload is cancelled, no asset is made, and the row fails as taken_over", async () => {
  const s = await queued("takeover-series", [{ n: 1, bytes: 2 * Q + 999, frames: 120 }]);
  let taken = false;
  fake.onChunk = () => {
    if (!taken) {
      taken = true;
      fake.takeOver(s.slug, 1);
    }
  };
  const out = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w" });
  assert.equal(out.row.step, "failed");
  assert.equal(out.row.error_code, "taken_over");
  assert.match(out.row.error!, /Tell the operator/);
  const ours = fake.uploadsFor(s.slug, 1)[0];
  assert.equal(ours.status, "cancelled");
  assert.equal(ours.asset_id, null, "no asset: nothing of Studio's reaches the episode");
  const total = s.files.get(1)!.byteLength;
  assert.ok(!fake.chunks.some((c) => c.upload_id === ours.id && c.last === total - 1), "the last chunk was never sent");
});

test("a take-back mid-upload (Jayden sets managed_by back to cms): the last chunk is never sent and nothing is written to the CMS series; taken back after the last chunk, the row is never marked verified", async () => {
  const s = await queued("take-back", [{ n: 1, bytes: 3 * Q + 11, frames: 120 }]);
  const posts = () => fake.requests.filter((r) => r.method !== "GET").length;
  let atTakeBack = -1;
  fake.onChunk = () => {
    if (atTakeBack < 0) {
      atTakeBack = posts();
      fake.setManagedBy(s.slug, "cms"); // after Studio's first chunk
    }
  };
  const out = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w" });
  fake.onChunk = null;
  assert.ok(atTakeBack > 0);
  assert.equal(out.row.step, "failed");
  assert.equal(out.row.error_code, "series_not_studio");
  assert.match(out.row.error!, /expires within the hour/);
  const ours = fake.uploadsFor(s.slug, 1)[0];
  const total = s.files.get(1)!.byteLength;
  assert.ok(!fake.chunks.some((c) => c.upload_id === ours.id && c.last === total - 1), "the last chunk was never sent");
  assert.equal(ours.asset_id, null, "nothing of Studio's reaches the CMS series' episode");
  assert.equal(posts(), atTakeBack, "no cancel, sync or other write reached the series once it was the CMS's");

  // Taken back just after the last chunk: the webhook puts the asset on the episode (the contract leaves that to the
  // operator), but Studio never marks the row verified, so nothing of it can be published there.
  const late = await queued("take-back-late", [{ n: 1, bytes: Q + 5, frames: 120 }]);
  const lateTotal = late.files.get(1)!.byteLength;
  fake.onChunk = (c) => {
    if (c.last === lateTotal - 1) fake.setManagedBy(late.slug, "cms");
  };
  const after = await advanceCdPublication(late.rows[0].id, { ...RUN, owner: "w" });
  fake.onChunk = null;
  assert.equal(after.row.step, "failed");
  assert.equal(after.row.error_code, "series_not_studio");
  assert.match(after.row.error!, /Tell the operator/);
  assert.equal((await fixtureData.getCdPublications(sys, late.title.id)).filter((r) => r.step === "verified" || r.step === "published").length, 0);
});

test("after a take-back no write of the uploader reaches the series: the title's later episodes ask for no upload, a resume asks for no URL, and a missed webhook is not synced — each row fails series_not_studio from the fresh read before the write", async () => {
  const writesNow = () => fake.requests.filter((r) => r.method !== "GET").length;
  // Episode 1 verified; the series is taken back; the runner then meets episodes 2 and 3.
  const many = await queued("take-back-many", [{ n: 1, bytes: Q + 11, frames: 120 }, { n: 2, bytes: Q + 12, frames: 120 }, { n: 3, bytes: Q + 13, frames: 120 }]);
  const first = await advanceCdPublication(many.rows.find((r) => r.episode_number === 1)!.id, { ...RUN, owner: "w" });
  assert.equal(first.row.step, "verified");
  fake.setManagedBy(many.slug, "cms");
  const quiet = writesNow();
  const summary = await runTitleUploads(many.title.id, RUN);
  assert.equal(writesNow(), quiet, "no upload call, sync or cancel reached the CMS series");
  assert.deepEqual(summary.failed, [2, 3]);
  for (const n of [2, 3]) {
    const row = await rowOf(many.title.id, n);
    assert.equal(row.error_code, "series_not_studio");
    assert.match(row.error!, /nothing was sent to the series/);
    assert.equal(fake.uploadsFor(many.slug, n).length, 0);
  }

  // A resume after a crash mid-file: the upload URL is gone, and re-asking for it is a write to the series.
  const resume = await queued("take-back-resume", [{ n: 1, bytes: 2 * Q + 7, frames: 120 }]);
  await assert.rejects(advanceCdPublication(resume.rows[0].id, { ...RUN, owner: "a", leaseMs: 1, crash: (p) => { if (p === "after_chunk") throw new SimulatedCrash(p); } }), SimulatedCrash);
  fake.setManagedBy(resume.slug, "cms");
  await pause(5);
  const beforeResume = writesNow();
  const resumed = await advanceCdPublication(resume.rows[0].id, { ...RUN, owner: "b" });
  assert.equal(resumed.row.error_code, "series_not_studio");
  assert.match(resumed.row.error!, /sent nothing more/);
  assert.equal(writesNow(), beforeResume, "no URL re-request");
  assert.equal(fake.uploadsFor(resume.slug, 1)[0].asset_id, null);

  // Every byte in Mux, the webhook missed, the series taken back before the sync.
  const pending = await queued("take-back-sync", [{ n: 1, bytes: Q + 9, frames: 120 }]);
  fake.webhookMissed = true;
  await assert.rejects(advanceCdPublication(pending.rows[0].id, { ...RUN, owner: "a", leaseMs: 1, crash: (p) => { if (p === "after_last_chunk") throw new SimulatedCrash(p); } }), SimulatedCrash);
  fake.setManagedBy(pending.slug, "cms");
  await pause(5);
  const beforeSync = writesNow();
  const synced = await advanceCdPublication(pending.rows[0].id, { ...RUN, owner: "b" });
  assert.equal(synced.row.error_code, "series_not_studio");
  assert.match(synced.row.error!, /does not ask crazydramas to sync/);
  assert.equal(writesNow(), beforeSync, "no sync");
  assert.ok(!fake.requests.some((r) => r.path.endsWith("/sync")));
});

test("a Retry replaces only Studio's own dead upload: after a takeover it fails replace_required instead of overwriting the CMS's upload; after an errored asset it uploads again with replace", async () => {
  const s = await queued("retry-series", [{ n: 1, bytes: 2 * Q + 1, frames: 120 }, { n: 2, bytes: Q + 2, frames: 150 }]);
  let taken = false;
  fake.onChunk = (c) => {
    if (!taken && c.upload_id === fake.uploadsFor(s.slug, 1)[0]?.id) {
      taken = true;
      fake.takeOver(s.slug, 1);
    }
  };
  assert.equal((await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w" })).row.error_code, "taken_over");
  fake.onChunk = null;
  const cmsUpload = fake.seriesState(s.slug)!.episodes[0].mux_upload_id;
  const retry = await queueUploads(producer(), s.title.id, { episodes: [1] }, { schedule: false });
  assert.deepEqual(retry.queued, [1], "a failed row is always retried where it stopped");
  const again = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w" });
  assert.equal(again.row.step, "failed");
  assert.equal(again.row.error_code, "replace_required");
  assert.match(again.row.error!, /does not replace it on its own/);
  assert.equal(fake.uploadsFor(s.slug, 1).length, 1, "no new Studio upload");
  assert.equal(fake.seriesState(s.slug)!.episodes[0].mux_upload_id, cmsUpload, "the CMS's upload is untouched");

  fake.assetErrors = true;
  const errored = await advanceCdPublication(s.rows[1].id, { ...RUN, owner: "w" });
  assert.equal(errored.row.error_code, "asset_errored");
  await queueUploads(producer(), s.title.id, { episodes: [2] }, { schedule: false });
  const redone = await advanceCdPublication(s.rows[1].id, { ...RUN, owner: "w", now: () => Date.now() + 3 * 60_000 });
  assert.equal(redone.row.step, "verified", "its own errored asset is replaced by a new upload");
  assert.equal(redone.row.replace, true);
  assert.equal(fake.uploadsFor(s.slug, 2).length, 2);
});

test("a replace row after a CMS takeover: a Retry inherits no replace and never overwrites the CMS's newer media; only a person's fresh Replace sends Studio's file over it, as a new upload in the ledger", async () => {
  const s = await queued("replace-takeover", [{ n: 1, bytes: Q + 11, frames: 120 }]);
  await runTitleUploads(s.title.id, RUN);
  assert.deepEqual((await publishEpisodes(producer(), s.title.id, { episodes: [1], publish_series: true })).published, [1]);
  // A re-cut of the published episode, sent with replace; a CMS upload takes the episode over mid-file.
  await setFile(s, 1, randomBytes(2 * Q + 7));
  assert.deepEqual((await queueUploads(producer(), s.title.id, { episodes: [1], replace: true }, { schedule: false })).queued, [1]);
  const row = await plannedRow(s.title.id);
  assert.equal(row.replace, true);
  let cmsUpload = "";
  fake.onChunk = () => {
    if (!cmsUpload) cmsUpload = fake.takeOver(s.slug, 1);
  };
  const first = await advanceCdPublication(row.id, { ...RUN, owner: "w" });
  fake.onChunk = null;
  assert.equal(first.row.error_code, "taken_over");
  const cancelled = first.row.upload_id!;
  // A person's Replace while the CMS upload is still in flight: crazydramas answers upload_in_progress. Someone else's upload
  // holds the episode, so the row offers Replace again, and a plain Retry of it never keeps the replace.
  const inFlight = fake.uploadsFor(s.slug, 1).length;
  assert.deepEqual((await queueUploads(producer(), s.title.id, { episodes: [1], replace: true }, { schedule: false })).queued, [1]);
  const busy = await advanceCdPublication(row.id, { ...RUN, owner: "w" });
  assert.equal(busy.row.step, "failed");
  assert.equal(busy.row.error_code, "upload_in_progress");
  assert.equal(busy.row.replace, true);
  assert.equal(fake.uploadsFor(s.slug, 1).length, inFlight, "no Studio upload while the CMS's is in flight");
  assert.equal((await getPublishState(producer(), s.title.id)).episodes.find((e) => e.n === 1)!.error_code, "upload_in_progress", "the screen offers Replace for it, not Retry");
  // The CMS upload finishes: its asset is what viewers of episode 1 get now.
  await fake.putUploadChunk(`fake-mux://upload/${cmsUpload}`, new Uint8Array(1000), { first: 0, last: 999, total: 1000 });
  fake.settleAll();
  const cmsAsset = fake.seriesState(s.slug)!.episodes[0].mux_asset_id;
  assert.ok(cmsAsset);
  const studioUploads = fake.uploadsFor(s.slug, 1).length;

  const retry = await queueUploads(producer(), s.title.id, { episodes: [1] }, { schedule: false });
  assert.deepEqual(retry.queued, [1], "a plain Retry is still queued");
  assert.equal((await fixtureData.getCdPublication(sys, row.id)).replace, false, "a takeover row never inherits its old replace");
  const again = await advanceCdPublication(row.id, { ...RUN, owner: "w" });
  assert.equal(again.row.step, "failed");
  assert.equal(again.row.error_code, "replace_required");
  assert.equal(fake.uploadsFor(s.slug, 1).length, studioUploads, "no new Studio upload");
  assert.equal(fake.seriesState(s.slug)!.episodes[0].mux_asset_id, cmsAsset, "the CMS's newer asset is untouched");
  const shown = (await getPublishState(producer(), s.title.id)).episodes.find((e) => e.n === 1)!;
  assert.equal(shown.error_code, "replace_required", "the screen offers Replace for it");

  const replace = await queueUploads(producer(), s.title.id, { episodes: [1], replace: true }, { schedule: false });
  assert.deepEqual(replace.queued, [1]);
  const planned = await fixtureData.getCdPublication(sys, row.id);
  assert.equal(planned.step, "planned", "a person's Replace starts a new upload");
  assert.equal(planned.upload_id, null);
  assert.equal(planned.previous_upload_id, cancelled, "the dead upload is kept");
  assert.equal(planned.replace, true);
  const done = await advanceCdPublication(row.id, { ...RUN, owner: "w" });
  assert.equal(done.row.step, "published", "the episode is published, so its replace is live once verified");
  assert.equal(fake.uploadsFor(s.slug, 1).length, studioUploads + 1);
  assert.equal(fake.seriesState(s.slug)!.episodes[0].mux_asset_id, done.row.asset_id, "Studio's verified asset is the episode's now");
  assert.ok(fake.getAsset(cmsAsset!), "the CMS's asset is kept, never deleted");
});

test("the ledger is trusted only while the episode holds the asset Studio verified: an accepted replace supersedes the older rows at once, a file whose replacement failed can be sent again (with replace), and a CMS re-upload after verification is never published as Studio's", async () => {
  const s = await queued("stale-ledger", [{ n: 1, bytes: Q + 11, frames: 120 }, { n: 2, bytes: Q + 22, frames: 150 }]);
  await runTitleUploads(s.title.id, RUN);
  const x = s.files.get(1)!;
  const xRow = await rowOf(s.title.id, 1);
  assert.equal(xRow.step, "verified");

  // Episode 1: X is replaced by a re-cut Y; crazydramas accepts the replace (the episode's asset is cleared), then Y fails verification.
  await setFile(s, 1, randomBytes(Q + 99));
  await queueUploads(producer(), s.title.id, { episodes: [1], replace: true }, { schedule: false });
  fake.durationOffsetFrames = 5;
  const y = await advanceCdPublication((await plannedRow(s.title.id)).id, { ...RUN, owner: "w" });
  fake.durationOffsetFrames = 0;
  assert.equal(y.row.error_code, "verify_failed");
  assert.equal((await fixtureData.getCdPublication(sys, xRow.id)).step, "superseded", "X's row stopped describing crazydramas when the replace was accepted");
  // X brought back: never "already uploaded and verified"; crazydramas holds Y's media, so it goes with replace, which the screen offers.
  await setFile(s, 1, x);
  const plain = await queueUploads(producer(), s.title.id, { episodes: [1] }, { schedule: false });
  assert.deepEqual(plain.queued, []);
  assert.match(plain.skipped[0].reason, /send it again with replace/);
  assert.equal((await getPublishState(producer(), s.title.id)).episodes.find((e) => e.n === 1)!.replace_needed, true);
  assert.deepEqual((await queueUploads(producer(), s.title.id, { episodes: [1], replace: true }, { schedule: false })).queued, [1]);
  const xAgain = await advanceCdPublication((await plannedRow(s.title.id)).id, { ...RUN, owner: "w" });
  assert.equal(xAgain.row.step, "verified");
  assert.equal(xAgain.row.sha256, sha(x));

  // Episode 2: verified, then a CMS re-upload takes it. The verified row proves nothing now: not shown as verified, never published.
  const cmsAsset = await cmsReupload(s.slug, 2);
  await pause(5);
  const shown = (await getPublishState(producer(), s.title.id)).episodes.find((e) => e.n === 2)!;
  assert.equal(shown.ledger_step, null, "the stale verified row is not shown");
  assert.equal(shown.replace_needed, true);
  const before = fake.requests.length;
  await assert.rejects(publishEpisodes(producer(), s.title.id, { episodes: [2], publish_series: true, confirm_paid: true }), (e: unknown) => isCdPublishError(e) && e.code === "not_verified" && /holds another file/.test(e.message + JSON.stringify(e.body())));
  assert.ok(!fake.requests.slice(before).some((r) => r.method === "POST"), "nothing was sent");
  assert.equal(fake.seriesState(s.slug)!.episodes[1].mux_asset_id, cmsAsset);
  // Queueing episode 2 supersedes its stale row; Studio's file needs replace now.
  const two = await queueUploads(producer(), s.title.id, { episodes: [2] }, { schedule: false });
  assert.match(two.skipped[0].reason, /send it again with replace/);
  assert.equal((await fixtureData.getCdPublications(sys, s.title.id)).filter((r) => r.episode_number === 2 && r.step === "verified").length, 0);
  // Episode 1, whose asset is the one Studio verified, publishes.
  assert.deepEqual((await publishEpisodes(producer(), s.title.id, { episodes: [1], publish_series: true })).published, [1]);
});

test("a resume whose upload times out between the status read and the URL re-request creates no upload the ledger does not know: the re-request never sends replace, and the dead upload is replaced through the ledger", async () => {
  const s = await queued("rerequest-series", [{ n: 1, bytes: Q + 3, frames: 120 }]);
  await runTitleUploads(s.title.id, RUN);
  await setFile(s, 1, randomBytes(2 * Q + 5));
  await queueUploads(producer(), s.title.id, { episodes: [1], replace: true }, { schedule: false });
  const row = await plannedRow(s.title.id);
  assert.equal(row.replace, true, "a replace row: the case where a repeated call with replace would make a second upload");
  await assert.rejects(advanceCdPublication(row.id, { ...RUN, owner: "a", leaseMs: 1, crash: (p) => { if (p === "after_chunk") throw new SimulatedCrash(p); } }), SimulatedCrash);
  const waiting = (await fixtureData.getCdPublication(sys, row.id)).upload_id!;
  const calls: { replace?: boolean }[] = [];
  const transport: CrazydramasStudioTransport = {
    mode: "fake",
    async request(method, p, body) {
      if (method === "POST" && /\/episodes\/1\/upload$/.test(p)) {
        calls.push(body as { replace?: boolean });
        fake.expireUpload(waiting); // Mux's hour runs out just as the resume asks for the URL again
      }
      return fake.request(method, p, body);
    },
    putUploadChunk: (url, chunk, range) => fake.putUploadChunk(url, chunk, range),
    checkImage: (url) => fake.checkImage(url),
  };
  const client = new StudioClient({ transport, writeGate: () => ({ enabled: true, reason: null }) });
  await pause(5);
  fake.now = () => Date.now() + 3 * 60_000;
  const before = fake.uploadsFor(s.slug, 1).length;
  const out = await advanceCdPublication(row.id, { ...RUN, client, owner: "b", now: () => Date.now() + 3 * 60_000 });
  assert.equal(calls[0].replace, undefined, "the URL re-request sends no replace");
  assert.equal(out.row.step, "verified");
  const uploads = fake.uploadsFor(s.slug, 1);
  assert.equal(uploads.length, before + 1, "one new upload, the dead one's replacement");
  assert.equal(out.row.previous_upload_id, waiting);
  assert.equal(out.row.upload_id, uploads.at(-1)!.id, "the ledger records the upload that holds the episode");
  assert.equal(fake.seriesState(s.slug)!.episodes[0].mux_upload_id, out.row.upload_id);
});

test("a worker that lost its lease stops: once another worker adopted the row, even one that released it since, the first never carries on without a lease", async () => {
  const s = await queued("lost-lease", [{ n: 1, bytes: Q + 4, frames: 120 }]);
  fake.readyAfterReads = 6;
  let adopted = false;
  const out = await advanceCdPublication(s.rows[0].id, {
    ...RUN,
    owner: "w1",
    leaseMs: 1,
    waitReadyMs: 60_000,
    pollMs: 1,
    sleep: async () => {
      if (adopted) return;
      adopted = true;
      await pause(5); // w1's one-millisecond lease runs out
      const r = await fixtureData.getCdPublication(sys, s.rows[0].id);
      assert.ok(await fixtureData.claimCdPublication(sys, r.id, { owner: "w2", revision: r.revision, leaseMs: 60_000 }), "w2 adopts the stale lease");
      await fixtureData.releaseCdPublication(sys, r.id, { owner: "w2" });
    },
  });
  assert.ok(adopted);
  assert.equal(out.outcome, "skipped", "w1 stops at its next write");
  const row = await fixtureData.getCdPublication(sys, s.rows[0].id);
  assert.equal(row.lease_owner, null);
  assert.equal(row.step, "bytes_sent", "nothing was written after the lease was lost");
});

test("an unexpected failure fails the row only while this worker still holds it: a row another worker adopted, and released since, is left alone", async () => {
  const s = await queued("lost-then-broke", [{ n: 1, bytes: Q + 6, frames: 120 }]);
  const id = s.rows[0].id;
  // w1's upload call is slow: its one-millisecond lease runs out, and w2 adopts the row and lets it go meanwhile.
  const transport: CrazydramasStudioTransport = {
    mode: "fake",
    async request(method, p, body) {
      if (method === "POST" && /\/episodes\/1\/upload$/.test(p)) {
        await pause(5);
        const r = await fixtureData.getCdPublication(sys, id);
        assert.ok(await fixtureData.claimCdPublication(sys, id, { owner: "w2", revision: r.revision, leaseMs: 60_000 }), "w2 adopts the stale lease");
        await fixtureData.releaseCdPublication(sys, id, { owner: "w2" });
      }
      return fake.request(method, p, body);
    },
    putUploadChunk: (url, chunk, range) => fake.putUploadChunk(url, chunk, range),
    checkImage: (url) => fake.checkImage(url),
  };
  const client = new StudioClient({ transport, writeGate: () => ({ enabled: true, reason: null }) });
  const out = await advanceCdPublication(id, {
    ...RUN,
    client,
    owner: "w1",
    leaseMs: 1,
    crash: (p) => {
      if (p === "after_upload_call") throw new Error("something unexpected broke");
    },
  });
  assert.equal(out.outcome, "skipped", "w1 no longer holds the row: it does not judge it");
  const row = await fixtureData.getCdPublication(sys, id);
  assert.equal(row.step, "planned", "not failed by the worker that lost it");
  assert.equal(row.error_code, null);
  // The next worker picks it up where it stands; the repeated upload call answers the same upload.
  const done = await advanceCdPublication(id, { ...RUN, owner: "w3" });
  assert.equal(done.row.step, "verified");
  assert.equal(fake.uploadsFor(s.slug, 1).length, 1);

  // While the worker still holds its row, the same failure fails it with the reason instead of spinning.
  const t = await queued("still-mine-broke", [{ n: 1, bytes: Q + 7, frames: 120 }]);
  const failed = await advanceCdPublication(t.rows[0].id, { ...RUN, owner: "w4", crash: (p) => { if (p === "after_upload_call") throw new Error("something unexpected broke"); } });
  assert.equal(failed.row.step, "failed");
  assert.equal(failed.row.error_code, "internal");
});

test("a takeover after the last chunk: the bytes are in Mux, Studio neither syncs nor publishes and says so", async () => {
  const s = await queued("late-takeover", [{ n: 1, bytes: Q + 5, frames: 120 }]);
  fake.readyAfterReads = 5;
  const total = s.files.get(1)!.byteLength;
  fake.onChunk = (c) => {
    if (c.last === total - 1) fake.takeOver(s.slug, 1);
  };
  const out = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w" });
  assert.equal(out.row.step, "failed");
  assert.equal(out.row.error_code, "taken_over_late");
  assert.ok(!fake.requests.some((r) => r.path.endsWith("/sync")));
});

// ---- verify --------------------------------------------------------------------------------------------------------------

test("a failed verification blocks the publish: another length than the frame rule allows, or an external_id that is not the file's sha", async () => {
  const s = await queued("verify-series", [{ n: 1, bytes: Q + 1, frames: 120 }, { n: 2, bytes: Q + 2, frames: 150 }]);
  fake.durationOffsetFrames = 5;
  const first = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w" });
  assert.equal(first.row.step, "failed");
  assert.equal(first.row.error_code, "verify_failed");
  assert.match(first.row.error!, /frame rule.*\+7, not the \+2/);
  assert.match(first.row.error!, /calibrated on one film/);
  fake.durationOffsetFrames = 0;
  fake.externalIdOverride = "0".repeat(64);
  const second = await advanceCdPublication(s.rows[1].id, { ...RUN, owner: "w" });
  assert.equal(second.row.error_code, "verify_failed");
  assert.match(second.row.error!, /external_id/);
  const before = fake.requests.length;
  await assert.rejects(publishEpisodes(producer(), s.title.id, { episodes: [1, 2], publish_series: true, confirm_paid: true }), (e: unknown) => isCdPublishError(e) && e.code === "not_verified" && e.status === 409);
  assert.ok(!fake.requests.slice(before).some((r) => r.method === "POST"), "no write reached crazydramas");
  assert.equal(fake.seriesState(s.slug)!.drama.status, "draft");
});

// ---- the other ways an upload goes -----------------------------------------------------------------------------------------

test("a missed webhook is synced (STUDIO_API.md step 4), and the upload verifies", async () => {
  const s = await queued("webhook-series", [{ n: 1, bytes: Q + 3, frames: 120 }]);
  fake.webhookMissed = true;
  const out = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w" });
  assert.equal(out.row.step, "verified");
  assert.ok(fake.requests.some((r) => r.method === "POST" && r.path.endsWith("/sync")), "Studio synced the upload");
});

test("an upload that died (timed out) is replaced by a new one with replace: true, once the row's two busy minutes pass; the dead one is recorded", async () => {
  const s = await queued("dead-series", [{ n: 1, bytes: 2 * Q + 1, frames: 120 }]);
  const row = s.rows[0];
  await assert.rejects(advanceCdPublication(row.id, { ...RUN, owner: "a", leaseMs: 1, crash: (p) => { if (p === "after_chunk") throw new SimulatedCrash(p); } }), SimulatedCrash);
  const first = fake.uploadsFor(s.slug, 1)[0].id;
  fake.expireUpload(first);
  await pause(5);
  const busy = await advanceCdPublication(row.id, { ...RUN, owner: "b" });
  assert.equal(busy.outcome, "waiting", "within two minutes crazydramas answers episode_busy");
  assert.equal(busy.row.error_code, "episode_busy");
  assert.ok(busy.row.next_attempt_at);
  fake.now = () => Date.now() + 3 * 60_000;
  const out = await advanceCdPublication(row.id, { ...RUN, owner: "b", now: () => Date.now() + 3 * 60_000 });
  assert.equal(out.row.step, "verified");
  assert.equal(out.row.previous_upload_id, first);
  assert.equal(out.row.replace, true);
  assert.equal(fake.uploadsFor(s.slug, 1).length, 2, "the dead upload, and its replacement");
});

test("a Stop: before the run the rows fail at once and nothing is sent; during the run the uploader stops before its next chunk", async () => {
  const s = await queued("stop-series", [{ n: 1, bytes: 2 * Q + 7, frames: 120 }, { n: 2, bytes: 2 * Q + 8, frames: 150 }]);
  const { cancelUploads } = await import("@/lib/crazydramas/publish");
  const r = await cancelUploads(producer(), s.title.id, { episode: 2 });
  assert.deepEqual(r.cancelled, [2]);
  const two = await rowOf(s.title.id, 2);
  assert.equal(two.step, "failed");
  assert.equal(two.error_code, "cancelled");
  let stopped = false;
  fake.onChunk = () => {
    if (!stopped) {
      stopped = true;
      void fixtureData.requestCdPublicationCancel(sys, s.rows[0].id);
    }
  };
  const out = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w" });
  assert.equal(out.row.step, "failed");
  assert.equal(out.row.error_code, "cancelled");
  const total = s.files.get(1)!.byteLength;
  assert.ok(!fake.chunks.some((c) => c.last === total - 1), "the last chunk was never sent");
  assert.equal(fake.uploadsFor(s.slug, 2).length, 0, "the episode stopped before the run never reached crazydramas");
});

test("the storage persisting fewer bytes than a chunk sent is followed, and a transient refusal waits and is tried again", async () => {
  const s = await queued("transient-series", [{ n: 1, bytes: 3 * Q + 11, frames: 120 }]);
  fake.persistShortOnce = 100;
  fake.failNext("mux_error", { match: /\/upload$/ });
  const first = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w" });
  assert.equal(first.outcome, "waiting");
  assert.equal(first.row.error_code, "mux_error");
  assert.equal(first.row.attempts, 1);
  const early = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w2" });
  assert.equal(early.outcome, "waiting", "not before its wait is over");
  const later = () => Date.now() + 60 * 60_000;
  const out = await advanceCdPublication(s.rows[0].id, { ...RUN, owner: "w", now: later });
  assert.equal(out.row.step, "verified");
  assert.equal(out.row.attempts, 0);
  assert.equal(fake.uploadsFor(s.slug, 1)[0].received_sha256, sha(s.files.get(1)!));
});

test("at most two uploads send at once on the machine: with two other workers' live leases, a title's runner waits and sends nothing", async () => {
  const a = await queued("slot-a", [{ n: 1, bytes: Q + 1, frames: 120 }]);
  const b = await queued("slot-b", [{ n: 1, bytes: Q + 1, frames: 120 }]);
  const c = await queued("slot-c", [{ n: 1, bytes: Q + 1, frames: 120 }]);
  for (const s of [a, b]) assert.ok(await fixtureData.claimCdPublication(sys, s.rows[0].id, { owner: `other-${s.slug}`, revision: s.rows[0].revision, leaseMs: 60_000 }));
  const before = fake.requests.length;
  const summary = await runTitleUploads(c.title.id, { ...RUN, maxPasses: 3 });
  assert.deepEqual(summary.waiting, [1]);
  assert.equal(fake.requests.slice(before).filter((r) => r.path.includes("/episodes/")).length, 0, "no upload started while two others send");
});

test("a row another live worker holds (a second Studio server on the shared database, or this server's previous process within its lease): the runner sleeps between looks instead of spinning, and starts no other episode of the title meanwhile", async () => {
  const s = await queued("held-elsewhere", [{ n: 1, bytes: Q + 1, frames: 120 }, { n: 2, bytes: Q + 2, frames: 150 }]);
  const one = s.rows.find((r) => r.episode_number === 1)!;
  assert.ok(await fixtureData.claimCdPublication(sys, one.id, { owner: "other-host:4242:cd:abcdef", revision: one.revision }), "another server holds episode 1");
  let clock = Date.now();
  let sleeps = 0;
  let reads = 0;
  const list = fixtureData.getCdPublications.bind(fixtureData);
  const before = fake.requests.length;
  fixtureData.getCdPublications = async (...args: Parameters<typeof list>) => {
    reads += 1;
    return list(...args);
  };
  let summary: Awaited<ReturnType<typeof runTitleUploads>>;
  try {
    summary = await runTitleUploads(s.title.id, {
      ...RUN,
      pollMs: 7_000,
      now: () => clock,
      sleep: async (ms) => {
        assert.ok(ms > 0, "a pass that moves nothing never waits zero");
        sleeps += 1;
        clock += ms;
      },
      maxPasses: 200,
      maxRunMs: 60_000,
    });
  } finally {
    fixtureData.getCdPublications = list;
  }
  assert.ok(summary.passes < 200, `the runner ended at its run time, not after ${summary.passes} passes`);
  assert.ok(sleeps >= summary.passes, `it slept between looks: ${sleeps} sleeps in ${summary.passes} passes`);
  assert.ok(reads <= summary.passes + 2, `one ledger read per look (${reads} for ${summary.passes} passes)`);
  assert.deepEqual(summary.waiting, [1, 2]);
  assert.equal(fake.requests.slice(before).filter((r) => r.path.includes("/episodes/")).length, 0, "no upload call: episode 1 is the other server's, and episode 2 waits for it (one upload per title)");
  assert.equal((await fixtureData.getCdPublication(sys, one.id)).lease_owner, "other-host:4242:cd:abcdef", "the other server's row is untouched");
});

test("at most two uploads send at once on the machine when several titles start together (a restart's resume): the slot is reserved before any wait, and this process's own runners are counted once", async () => {
  const titles = [];
  for (const slug of ["conc-one", "conc-two", "conc-three"]) titles.push(await queued(slug, [{ n: 1, bytes: 6 * Q + 11, frames: 120 }]));
  let inFlight = 0;
  let most = 0;
  const transport: CrazydramasStudioTransport = {
    mode: "fake",
    request: (method, p, body) => fake.request(method, p, body),
    async putUploadChunk(url, chunk, range) {
      if (!chunk) return fake.putUploadChunk(url, chunk, range);
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await pause(15);
        return await fake.putUploadChunk(url, chunk, range);
      } finally {
        inFlight -= 1;
      }
    },
    checkImage: (url) => fake.checkImage(url),
  };
  const client = new StudioClient({ transport, writeGate: () => ({ enabled: true, reason: null }) });
  const summaries = await Promise.all(titles.map((t) => runTitleUploads(t.title.id, { ...RUN, client, pollMs: 5, sleep: pause, maxPasses: 500 })));
  for (const s of summaries) assert.deepEqual(s.verified, [1], `${s.title_id} finished`);
  assert.ok(most <= 2, `${most} titles sent chunks at once`);
  assert.equal(most, 2, "two do run side by side");
});

test("the ledger's rules in the data layer: one active row per episode, the same file twice refused, a producer writes nothing, a foreign title is not found", async () => {
  const s = await queued("rules-series", [{ n: 1, bytes: Q + 1, frames: 120 }]);
  const row = s.rows[0];
  const input = { title_id: s.title.id, episode_id: row.episode_id, episode_number: 1, cd_drama_id: row.cd_drama_id, slug: row.slug, sha256: "a".repeat(64), bytes: 10, source_path: row.source_path };
  await assert.rejects(fixtureData.createCdPublication(sys, input), { code: "conflict" }, "one active row per title × episode");
  await assert.rejects(fixtureData.createCdPublication(producer(), { ...input, episode_number: 2, episode_id: null }), { code: "forbidden" });
  await assert.rejects(fixtureData.createCdPublication(sys, { ...input, episode_number: 2, episode_id: null, source_path: "C:/workspace/ep02.mp4" }), { code: "invalid" }, "bytes come from the local tier only");
  await assert.rejects(fixtureData.updateCdPublication(sys, row.id, { revision: row.revision + 5, step: "failed" }), { code: "conflict" }, "a stale revision");
  await assert.rejects(fixtureData.updateCdPublication(sys, row.id, { revision: row.revision, verify: { playback_id: "x" } }), { code: "invalid" }, "never a playback id");
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  const { fixtureSession } = await import("@/lib/auth");
  await assert.rejects(fixtureData.getCdPublications(fixtureSession("producer", other.id), s.title.id), { code: "not_found" });
  assert.equal((await fixtureData.getCdPublications(producer(), s.title.id)).length, 1, "the title's producer reads its rows");
});
