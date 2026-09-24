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
