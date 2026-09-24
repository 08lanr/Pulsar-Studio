// Phase 5, "Upload to crazydramas": the client for crazydramas' Studio API
// against the fake, which models every route and every error code of the
// contract (crazydramas docs/STUDIO_API.md). Every route answers its success
// shape through the client's zod (whitelists: no playback id survives), every
// error code comes back verbatim with its details, the Mux upload URL takes
// resumable chunk PUTs the way a Google Cloud Storage session does, the
// live-write gate refuses before any call, and the live transport never
// reaches the network under node:test. No request leaves the process.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { FAKE_UPLOAD_QUANTUM, fakeCrazydramasTransport as fake } from "@/lib/crazydramas/fake";
import { StudioClient, cdWriteGate, crazydramasStudioMode, type StudioFail, type StudioResult } from "@/lib/crazydramas/studio-client";
import { ackedFromRange, liveCrazydramasStudioTransport, liveCrazydramasTransport, studioTokenConfigured, studioWriteRefusal, CrazydramasApiError } from "@/lib/crazydramas/transport";

const Q = FAKE_UPLOAD_QUANTUM;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ENV_KEYS = ["DATA_SOURCE", "CRAZYDRAMAS_LIVE_READ", "CRAZYDRAMAS_LIVE_WRITES", "CRAZYDRAMAS_STUDIO_TOKEN"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  fake.reset();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  fake.reset();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const client = () => new StudioClient({ transport: fake, writeGate: () => ({ enabled: true, reason: null }) });

function failOf<T>(r: StudioResult<T>): StudioFail {
  assert.equal(r.ok, false, `expected a refusal, got ${JSON.stringify(r)}`);
  return r as StudioFail;
}

function okOf<T>(r: StudioResult<T>): T {
  if (!r.ok) assert.fail(`expected success, got ${r.status} ${r.code}: ${r.error}`);
  return r.data;
}

/** A Studio draft with one uploaded, ready episode per file; answers the upload ids. */
async function studioSeries(c: StudioClient, slug: string, files: Uint8Array[], opts: { title?: string } = {}): Promise<{ id: string; uploads: string[] }> {
  const put = okOf(await c.putSeries(slug, { title: opts.title ?? `Series ${slug}` }));
  const uploads: string[] = [];
  for (const [i, bytes] of files.entries()) {
    const up = okOf(await c.createUpload(slug, i + 1, { sha256: sha(bytes), bytes: bytes.byteLength, frames: 120 }));
    await sendAll(c, up.upload_url!, bytes);
    okOf(await c.getUpload(up.upload_id)); // Mux processing: one read and the asset is ready
    uploads.push(up.upload_id);
  }
  return { id: put.series.id, uploads };
}

async function sendAll(c: StudioClient, url: string, bytes: Uint8Array, chunk = Q): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(offset + chunk, bytes.byteLength);
    const a = await c.putChunk(url, bytes.subarray(offset, end), { first: offset, last: end - 1, total: bytes.byteLength });
    if (a.status === 200 || a.status === 201) return;
    assert.equal(a.status, 308);
    offset = a.acked ?? 0;
  }
}

// ---- the gate and the live transport ----------------------------------------------------------------------------------

test("the live-write gate (spec §6): fixture mode writes to the fake only; CRAZYDRAMAS_LIVE_READ=1 writes nowhere; Supabase mode needs the token and CRAZYDRAMAS_LIVE_WRITES=enabled, each named when missing", () => {
  delete process.env.DATA_SOURCE;
  delete process.env.CRAZYDRAMAS_LIVE_READ;
  assert.deepEqual(crazydramasStudioMode(), { read: "fake", write: "fake", read_refusal: null, write_refusal: null });
  assert.equal(cdWriteGate().enabled, true);

  process.env.CRAZYDRAMAS_LIVE_READ = "1";
  const liveRead = cdWriteGate();
  assert.equal(liveRead.enabled, false, "fixture mode reading the live site writes nowhere");
  assert.match(liveRead.reason!, /DATA_SOURCE=supabase/);
  delete process.env.CRAZYDRAMAS_LIVE_READ;

  process.env.DATA_SOURCE = "supabase";
  delete process.env.CRAZYDRAMAS_STUDIO_TOKEN;
  assert.match(studioWriteRefusal()!, /CRAZYDRAMAS_STUDIO_TOKEN is not set/);
  process.env.CRAZYDRAMAS_STUDIO_TOKEN = "short";
  assert.equal(studioTokenConfigured(), false, "a token shorter than 32 characters is not a token (crazydramas answers 503 for one)");
  process.env.CRAZYDRAMAS_STUDIO_TOKEN = "b".repeat(64);
  delete process.env.CRAZYDRAMAS_LIVE_WRITES;
  assert.match(studioWriteRefusal()!, /CRAZYDRAMAS_LIVE_WRITES is not set to enabled/);
  process.env.CRAZYDRAMAS_LIVE_WRITES = "yes";
  assert.match(studioWriteRefusal()!, /CRAZYDRAMAS_LIVE_WRITES/, "only the word enabled opens it");
  process.env.CRAZYDRAMAS_LIVE_WRITES = "enabled";
  assert.equal(studioWriteRefusal(), null);
  assert.equal(crazydramasStudioMode().write, "live");
});

test("the live transport refuses every Studio API call and every Mux PUT under node:test, before any request, whatever the environment says", async () => {
  process.env.DATA_SOURCE = "supabase";
  process.env.CRAZYDRAMAS_STUDIO_TOKEN = "c".repeat(64);
  process.env.CRAZYDRAMAS_LIVE_WRITES = "enabled";
  const before = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    throw new Error("no network in tests");
  }) as typeof fetch;
  try {
    await assert.rejects(liveCrazydramasStudioTransport.request("GET", "/api/studio/series/fixture-film"), (e: unknown) => e instanceof CrazydramasApiError && /tests/.test(e.message));
    await assert.rejects(liveCrazydramasStudioTransport.request("PUT", "/api/studio/series/x", { title: "x" }), (e: unknown) => e instanceof CrazydramasApiError && /tests/.test(e.message));
    await assert.rejects(liveCrazydramasStudioTransport.putUploadChunk("https://storage.googleapis.com/x", new Uint8Array(4), { first: 0, last: 3, total: 4 }), CrazydramasApiError);
    await assert.rejects(liveCrazydramasTransport.series("fixture-film"), (e: unknown) => e instanceof CrazydramasApiError && /tests/.test(e.message));
    const image = await liveCrazydramasStudioTransport.checkImage("https://crazydramas.com/posters/x.jpg");
    assert.equal(image.ok, false);
    assert.equal(fetched, 0, "refused before any request");
  } finally {
    globalThis.fetch = before;
  }
});

test("the client refuses a write before any call: writes disabled (the reason by name), and a series it knows the CMS made", async () => {
  const off = new StudioClient({ transport: fake, writeGate: () => ({ enabled: false, reason: "CRAZYDRAMAS_LIVE_WRITES is not set to enabled." }) });
  const r = failOf(await off.putSeries("new-series", { title: "New" }));
  assert.equal(r.code, "writes_disabled");
  assert.equal(r.local, true);
  assert.equal(r.body.reason, "CRAZYDRAMAS_LIVE_WRITES is not set to enabled.");
  assert.deepEqual(await off.putChunk("fake-mux://upload/UP1", new Uint8Array(1), { first: 0, last: 0, total: 1 }), { status: 0, acked: null }, "a chunk is a write too");
  const cms = failOf(await client().publish("fixture-film", { episodes: [1] }, { managed_by: "cms" }));
  assert.equal(cms.code, "series_not_studio");
  assert.equal(cms.status, 403);
  assert.equal(cms.local, true);
  assert.equal(fake.requests.length, 0, "nothing reached crazydramas");
  const read = okOf(await off.getSeries("fixture-film"));
  assert.equal(read.series.managed_by, "cms", "a read still goes through with writes disabled");
});

// ---- every route, its success shape ------------------------------------------------------------------------------------

test("every route answers its contract shape through the client, and no playback id survives a parse", async () => {
  const c = client();
  const cms = okOf(await c.getSeries("fixture-film"));
  assert.equal(cms.series.managed_by, "cms");
  assert.equal(cms.episodes.length, 3);
  assert.equal(cms.episodes[0].status, "ready");
  assert.doesNotMatch(JSON.stringify(cms), /playback/, "the episode's playback_id is not in the whitelist");

  const created = okOf(await c.putSeries("brand-new-series", { title: "Brand New Series", free_episode_count: 1, series_price_cents: 999, iap_product_id: "cd.series.brand_new_series", cta_mode: "web_checkout" }));
  assert.equal(created.created, true);
  assert.equal(created.series.status, "draft");
  assert.equal(created.series.managed_by, "studio");
  assert.equal(created.series.cta_mode, "web_checkout");
  const same = okOf(await c.putSeries("brand-new-series", { title: "Brand New Series" }));
  assert.deepEqual(same.changed, [], "a repeat writes nothing");
  const renamed = okOf(await c.putSeries("brand-new-series", { tagline: "One line." }));
  assert.deepEqual(renamed.changed, ["tagline"]);

  const bytes = randomBytes(Q + 1000);
  const up = okOf(await c.createUpload("brand-new-series", 1, { sha256: sha(bytes), bytes: bytes.byteLength, frames: 120 }));
  assert.equal(up.reused, false);
  assert.equal(up.status, "uploading");
  assert.ok(up.upload_url?.startsWith("fake-mux://upload/"));
  const again = okOf(await c.createUpload("brand-new-series", 1, { sha256: sha(bytes), bytes: bytes.byteLength, frames: 120 }));
  assert.equal(again.reused, true, "the same sha while waiting: the same upload");
  assert.equal(again.upload_id, up.upload_id);
  assert.equal(again.upload_url, up.upload_url);

  const waiting = okOf(await c.getUpload(up.upload_id));
  assert.equal(waiting.upload.status, "waiting");
  assert.equal(waiting.episode_is_current, true);
  assert.equal(waiting.ready, false);
  await sendAll(c, up.upload_url!, bytes);
  const ready = okOf(await c.getUpload(up.upload_id));
  assert.equal(ready.upload.status, "asset_created");
  assert.equal(ready.asset?.status, "ready");
  assert.equal(ready.asset?.meta?.external_id, sha(bytes));
  assert.equal(ready.ready, true);
  assert.equal(ready.webhook_pending, false);
  assert.doesNotMatch(JSON.stringify(ready), /playback/, "the asset's playback_ids are not in the whitelist");
  assert.equal(fake.getUpload(up.upload_id)?.received_sha256, sha(bytes), "the bytes Mux holds are the file's");

  const synced = okOf(await c.syncUpload(up.upload_id));
  assert.deepEqual(synced.changed, [], "sync is idempotent once the webhook applied");

  const published = okOf(await c.publish("brand-new-series", { episodes: [1], publish_series: true }));
  assert.deepEqual(published.published, [1]);
  assert.equal(published.series.status, "published");
  const repeat = okOf(await c.publish(created.series.id, { episodes: [1] }));
  assert.deepEqual(repeat.already_published, [1], "a repeat by drama id changes nothing");
  const hidden = okOf(await c.unpublish("brand-new-series", { episodes: [1], unpublish_series: true }));
  assert.deepEqual(hidden.unpublished, [1]);
  assert.equal(hidden.series.status, "draft");

  const other = randomBytes(1000);
  const up2 = okOf(await c.createUpload("brand-new-series", 2, { sha256: sha(other), bytes: other.byteLength }));
  fake.takeOver("brand-new-series", 2);
  const cancelled = okOf(await c.cancelUpload(up2.upload_id));
  assert.equal(cancelled.cancelled, true, "an upload another took over is cancelled");
  const cancelledAgain = okOf(await c.cancelUpload(up2.upload_id));
  assert.equal(cancelledAgain.cancelled, false, "a repeat changes nothing");

  const img = await c.checkImage("https://crazydramas.com/posters/brand-new-series.jpg");
  assert.deepEqual(img, { ok: true, status: 200, content_type: "image/jpeg", reason: null });
  assert.equal((await c.checkImage("https://crazydramas.com/posters/missing.jpg")).status, 404);
});

// ---- every error code, verbatim -----------------------------------------------------------------------------------------

test("every error code of the contract comes back verbatim, with its status and its details", async () => {
  const c = client();
  const expect = async (r: Promise<StudioResult<unknown>>, status: number, code: string, check?: (f: StudioFail) => void) => {
    const f = failOf(await r);
    assert.equal(f.code, code, `${code}: got ${f.code} (${f.error})`);
    assert.equal(f.status, status, `${code}: status`);
    assert.equal(f.local, false, `${code} came from crazydramas`);
    assert.ok(f.error.length > 0);
    check?.(f);
  };
  const seen = new Set<string>();
  const track = async (r: Promise<StudioResult<unknown>>, status: number, code: string, check?: (f: StudioFail) => void) => {
    await expect(r, status, code, check);
    seen.add(code);
  };

  // Auth, checked before anything else.
  for (const [auth, status, code] of [["not_configured", 503, "not_configured"], ["missing_token", 401, "missing_token"], ["bad_token", 401, "bad_token"], ["backend_not_configured", 503, "backend_not_configured"]] as const) {
    fake.auth = auth;
    await track(c.getSeries("fixture-film"), status, code);
  }
  fake.auth = "read_only";
  okOf(await c.getSeries("fixture-film"));
  await track(c.putSeries("x-series", { title: "X" }), 403, "insufficient_scope");
  fake.auth = "ok";

  // The series routes.
  await track(c.putSeries("fixture-film", { tagline: "mine now" }), 403, "series_not_studio", (f) => assert.equal((f.body.series as { managed_by: string }).managed_by, "cms"));
  const badJson = await fake.request("PUT", "/api/studio/series/x-series", "{not json");
  assert.equal(badJson.status, 400);
  assert.equal((badJson.body as { code: string }).code, "bad_json");
  seen.add("bad_json");
  await track(c.putSeries("x-series", { title: "X", iap_product_id: "Not An Id!" }), 400, "bad_request", (f) => assert.equal((f.body.issues as { path: string }[])[0].path, "iap_product_id"));
  await track(c.putSeries("Not A Slug", { title: "X" }), 400, "bad_slug");
  await track(c.putSeries("f1000000-0000-4000-8000-000000000001", { title: "X" }), 400, "bad_slug");
  await track(c.putSeries("x-series", { tagline: "no title" }), 400, "title_required");
  await track(c.getSeries("no-such-series"), 404, "series_not_found");
  await track(c.putSeries("x-series", { title: "Fixture   FILM!" }), 409, "series_title_exists", (f) => assert.equal((f.body.existing as { slug: string }).slug, "fixture-film"));
  await track(c.putSeries("x-series", { title: "X", iap_product_id: "crazydrama.series.fixture_film" }), 409, "iap_product_id_taken");
  fake.raceNextCreate = true;
  await track(c.putSeries("x-series", { title: "X" }), 409, "conflict_retry");
  okOf(await c.putSeries("x-series", { title: "X" }));
  fake.setSeriesStatus("x-series", "published");
  await track(c.putSeries("x-series", { tagline: "live edit" }), 409, "series_not_draft", (f) => assert.deepEqual(f.body.would_change, ["tagline"]));
  okOf(await c.putSeries("x-series", { tagline: "live edit", update_live: true }));
  fake.setSeriesStatus("x-series", "draft");

  // The upload route's decision table.
  const a = randomBytes(Q + 10);
  const b = randomBytes(2000);
  await track(c.createUpload("x-series", 501, { sha256: sha(a), bytes: a.byteLength }), 400, "bad_episode_number");
  await track(c.createUpload("no-such-series", 1, { sha256: sha(a), bytes: a.byteLength }), 404, "series_not_found");
  await track(c.createUpload("fixture-film", 4, { sha256: sha(a), bytes: a.byteLength }), 403, "series_not_studio");
  fake.raceNextUpload = true;
  await track(c.createUpload("x-series", 7, { sha256: sha(a), bytes: a.byteLength }), 409, "episode_changed", (f) => assert.ok(typeof f.body.cancelled_upload_id === "string"));
  const up1 = okOf(await c.createUpload("x-series", 1, { sha256: sha(a), bytes: a.byteLength, frames: 120 }));
  await track(c.createUpload("x-series", 1, { sha256: sha(b), bytes: b.byteLength }), 409, "upload_in_progress", (f) => assert.equal(f.body.upload_id, up1.upload_id));
  await track(c.cancelUpload(up1.upload_id), 409, "upload_is_current");
  await sendAll(c, up1.upload_url!, a);
  okOf(await c.getUpload(up1.upload_id));
  await track(c.createUpload("x-series", 1, { sha256: sha(b), bytes: b.byteLength }), 409, "replace_required", (f) => assert.equal((f.body.current as { state: string }).state, "ready"));

  // A dead upload on a row touched in the last two minutes: episode_busy; once the two minutes pass, a replace goes through.
  const up2 = okOf(await c.createUpload("x-series", 2, { sha256: sha(b), bytes: b.byteLength }));
  fake.expireUpload(up2.upload_id);
  await track(c.createUpload("x-series", 2, { sha256: sha(b), bytes: b.byteLength, replace: true }), 409, "episode_busy");
  fake.now = () => Date.now() + 3 * 60_000;
  const replaced = okOf(await c.createUpload("x-series", 2, { sha256: sha(b), bytes: b.byteLength, replace: true }));
  assert.equal(replaced.replaced, true);
  fake.now = () => Date.now();

  // webhook_pending: Mux has the file ready, the row never heard; sync, then the same call answers reused.
  fake.webhookMissed = true;
  const c3 = randomBytes(500);
  const up3 = okOf(await c.createUpload("x-series", 3, { sha256: sha(c3), bytes: c3.byteLength, frames: 30 }));
  await sendAll(c, up3.upload_url!, c3);
  const pending = okOf(await c.getUpload(up3.upload_id));
  assert.equal(pending.webhook_pending, true);
  assert.equal(pending.ready, false);
  // Within two minutes of its creation a finished upload whose webhook never came still reads episode_busy (the contract says so).
  await expect(c.createUpload("x-series", 3, { sha256: sha(c3), bytes: c3.byteLength }), 409, "episode_busy");
  fake.now = () => Date.now() + 3 * 60_000;
  await track(c.createUpload("x-series", 3, { sha256: sha(c3), bytes: c3.byteLength }), 409, "webhook_pending", (f) => assert.equal(f.body.upload_id, up3.upload_id));
  fake.now = () => Date.now();
  fake.webhookMissed = false;
  assert.ok(okOf(await c.syncUpload(up3.upload_id)).changed.includes("status"));
  assert.equal(okOf(await c.createUpload("x-series", 3, { sha256: sha(c3), bytes: c3.byteLength })).reused, true);

  // sync and cancel of uploads that are not Studio's, or no longer current, or complete.
  const cmsUpload = fake.takeOver("x-series", 1);
  await track(c.syncUpload(cmsUpload), 409, "not_studio_upload");
  await track(c.cancelUpload(cmsUpload), 409, "not_studio_upload");
  await track(c.syncUpload(up1.upload_id), 409, "upload_not_current");
  await track(c.cancelUpload(up1.upload_id), 409, "upload_complete", (f) => assert.equal(f.body.upload_status, "asset_created"));
  await track(c.getUpload("not-an-id!"), 400, "bad_upload_id");
  await track(c.getUpload("UPnothing"), 404, "upload_not_found");

  // publish and unpublish.
  await track(c.publish("x-series", { episodes: [1] }), 409, "episodes_not_ready", (f) => assert.deepEqual((f.body.not_ready as { episode_number: number }[]).map((x) => x.episode_number), [1]));
  okOf(await c.putSeries("empty-series", { title: "Empty Series" }));
  await track(c.publish("empty-series", { publish_series: true }), 409, "no_published_episodes");
  fake.setSeriesStatus("empty-series", "archived");
  await track(c.publish("empty-series", { publish_series: true }), 409, "series_archived");
  await track(c.unpublish("x-series", { episodes: [9] }), 404, "episodes_not_found", (f) => assert.deepEqual(f.body.missing, [9]));
  const two = await studioSeries(c, "two-series", [randomBytes(300), randomBytes(400)]);
  assert.equal(two.uploads.length, 2);
  fake.flipOnPublish = [2];
  await track(c.publish("two-series", { episodes: [1, 2], publish_series: true }), 409, "episodes_changed", (f) => {
    assert.deepEqual(f.body.published, [1], "the partial result: episode 1 went live");
    assert.deepEqual(f.body.not_published, [2]);
    assert.equal((f.body.series as { status: string }).status, "draft", "a draft is not taken live on a partial result");
  });

  // The 5xx answers.
  fake.failNext("db_error");
  await track(c.getSeries("fixture-film"), 500, "db_error");
  fake.failNext("internal");
  await track(c.getSeries("fixture-film"), 500, "internal");
  fake.failNext("mux_error", { match: /upload$/ });
  await track(c.createUpload("two-series", 3, { sha256: sha(a), bytes: a.byteLength }), 502, "mux_error");

  const contract = ["not_configured", "backend_not_configured", "missing_token", "bad_token", "insufficient_scope", "series_not_studio", "bad_json", "bad_request", "bad_slug", "title_required", "bad_episode_number", "bad_upload_id", "series_not_found", "upload_not_found", "episodes_not_found", "series_not_draft", "conflict_retry", "series_title_exists", "iap_product_id_taken", "upload_in_progress", "episode_busy", "webhook_pending", "replace_required", "episode_changed", "upload_not_current", "not_studio_upload", "upload_is_current", "upload_complete", "episodes_not_ready", "series_archived", "no_published_episodes", "episodes_changed", "db_error", "internal", "mux_error"];
  assert.deepEqual(contract.filter((code) => !seen.has(code)), [], "every code in the contract's table was answered");
});

// ---- the resumable upload ------------------------------------------------------------------------------------------------

test("the fake Mux upload behaves as a resumable session: the status query, 308 with Range, a non-final chunk persisted to a multiple of 256 KiB, bytes past the persisted end not taken, the last chunk completing it, a dead session 410", async () => {
  const c = client();
  okOf(await c.putSeries("resume-series", { title: "Resume Series" }));
  const bytes = randomBytes(3 * Q + 12345);
  const total = bytes.byteLength;
  const up = okOf(await c.createUpload("resume-series", 1, { sha256: sha(bytes), bytes: total, frames: 120 }));
  const url = up.upload_url!;
  assert.deepEqual(await c.queryUpload(url, total), { status: 308, acked: null }, "nothing persisted yet: a 308 with no Range");
  const odd = await c.putChunk(url, bytes.subarray(0, Q + 100), { first: 0, last: Q + 99, total });
  assert.deepEqual(odd, { status: 308, acked: Q }, "a chunk that is not a multiple of 256 KiB is persisted only to the quantum");
  const ahead = await c.putChunk(url, bytes.subarray(2 * Q, 3 * Q), { first: 2 * Q, last: 3 * Q - 1, total });
  assert.deepEqual(ahead, { status: 308, acked: Q }, "a chunk past the persisted end is not taken");
  const overlap = await c.putChunk(url, bytes.subarray(0, 2 * Q), { first: 0, last: 2 * Q - 1, total });
  assert.deepEqual(overlap, { status: 308, acked: 2 * Q }, "bytes already persisted are ignored, the rest appended");
  fake.persistShortOnce = 10;
  const short = await c.putChunk(url, bytes.subarray(2 * Q, 3 * Q), { first: 2 * Q, last: 3 * Q - 1, total });
  assert.deepEqual(short, { status: 308, acked: 2 * Q }, "the storage may persist fewer bytes than sent: the next chunk starts at the acknowledged offset");
  assert.deepEqual(await c.queryUpload(url, total), { status: 308, acked: 2 * Q });
  const last = await c.putChunk(url, bytes.subarray(2 * Q), { first: 2 * Q, last: total - 1, total });
  assert.equal(last.status, 200, "the chunk that ends the file completes the upload");
  assert.equal((await c.queryUpload(url, total)).status, 200);
  assert.equal(fake.getUpload(up.upload_id)?.received_sha256, sha(bytes));
  assert.equal(fake.getUpload(up.upload_id)?.status, "asset_created");

  const dead = okOf(await c.createUpload("resume-series", 2, { sha256: sha(bytes), bytes: total }));
  fake.expireUpload(dead.upload_id);
  assert.equal((await c.putChunk(dead.upload_url!, bytes.subarray(0, Q), { first: 0, last: Q - 1, total })).status, 410);
  assert.equal(ackedFromRange("bytes=0-262143"), Q);
  assert.equal(ackedFromRange(null), null);
  assert.equal(ackedFromRange("bytes=5-9"), null, "a Range that does not start at 0 is not an acknowledgement");
});
