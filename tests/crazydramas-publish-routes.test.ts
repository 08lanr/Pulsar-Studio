// Phase 5, "Upload to crazydramas": what each of the six routes under
// /api/titles/[id]/crazydramas/ does, through the lib functions the routes
// call (the routes are the house's thin guard + zod + call + JSON): the
// state the section polls in every series state; the series PUT and each
// refusal (not_linked, writes_disabled, series_not_studio before any call,
// series_title_exists from the working-name table and passed through,
// iap_product_id_taken, poster_unreachable, series_not_draft); uploads and
// their skipped reasons; the paid-episode confirm and CRAZYDRAMAS_PAYWALL_LIVE;
// the partial episodes_changed; unpublish; who may act; and the token never
// appearing in anything Studio serialises or logs. No network.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fixtureSession, systemSession } from "@/lib/auth";
import { FAKE_UPLOAD_QUANTUM, fakeCrazydramasTransport as fake } from "@/lib/crazydramas/fake";
import {
  cancelUploads,
  getPublishState,
  isCdPublishError,
  KNOWN_LIVE_SERIES,
  PAID_WARNING,
  publishEpisodes,
  queueUploads,
  resetCrazydramasUploads,
  runTitleUploads,
  saveSeries,
  unpublishEpisodes,
  type UploaderOptions,
} from "@/lib/crazydramas/publish";
import { PublishStateSchema } from "@/lib/crazydramas/publish-types";
import { checkCrazydramasTitle, resetCrazydramasSweep } from "@/lib/crazydramas/sweep";
import { CrazydramasApiError, liveCrazydramasStudioTransport } from "@/lib/crazydramas/transport";
import { PLATFORM } from "@/lib/crazydramas/types";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { localPathOf } from "@/lib/data/storage";
import type { Title } from "@/lib/types";
import { producer, staff } from "./seed-minute";

const Q = FAKE_UPLOAD_QUANTUM;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sys = systemSession();
const temps: string[] = [];
const RUN: UploaderOptions & { maxPasses: number } = { chunkBytes: Q, pollMs: 0, sleep: async () => undefined, syncAfterMs: 0, maxPasses: 60 };
const ENV_KEYS = ["CRAZYDRAMAS_LIVE_READ", "CRAZYDRAMAS_PAYWALL_LIVE", "CRAZYDRAMAS_STUDIO_TOKEN", "DATA_SOURCE"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  resetFixtureStore();
  resetCrazydramasSweep();
  resetCrazydramasUploads();
  fake.reset();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = mkdtempSync(path.join(tmpdir(), "cd-routes-"));
  temps.push(dir);
  process.env.STUDIO_LOCAL_MEDIA_DIR = dir;
});

afterEach(() => {
  resetFixtureStore();
  resetCrazydramasUploads();
  fake.reset();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

async function seriesTitle(slug: string | null, opts: { name?: string; episodes?: { n: number; bytes: number; frames: number }[]; ref?: string } = {}): Promise<Title> {
  const who = producer();
  const title = await fixtureData.createImportedTitle(sys, { producer_id: who.producerId!, source_ref: opts.ref ?? `low-quality/${slug ?? `no-slug-${Math.random().toString(36).slice(2, 8)}`}`, display_title_en: opts.name ?? `Studio ${slug ?? "untitled"}`, crazydramas_slug: slug, created_by: who.userId });
  for (const e of opts.episodes ?? [{ n: 1, bytes: Q + 11, frames: 120 }, { n: 2, bytes: Q + 22, frames: 150 }, { n: 3, bytes: Q + 33, frames: 180 }]) {
    const buf = randomBytes(e.bytes);
    const digest = sha(buf);
    const stored = `local/${title.id}/ws/${slug ?? "film"}/ep${String(e.n).padStart(2, "0")}-${digest.slice(0, 8)}.mp4`;
    const abs = localPathOf(stored);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    await fixtureData.addVideoOnlyEpisode(sys, title.id, e.n, stored, { video_sha256: digest, video_bytes: e.bytes, video_frames: e.frames, duration_ms: Math.round((e.frames / 30) * 1000), auto_cut: false });
  }
  return title;
}

async function refusal(p: Promise<unknown>, status: number, code: string): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    if (!isCdPublishError(e)) throw e;
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.equal(e.status, status, `${code}: status`);
    return e.body();
  }
  assert.fail(`expected ${code}, the call succeeded`);
}

const writes = () => fake.requests.filter((r) => r.method !== "GET");

// ---- GET …/publish -------------------------------------------------------------------------------------------------

test("the state the section polls, in every series state: not_linked, not_uploaded (the form's defaults suggested), draft, published, cms_managed — each parsing as the shared contract", async () => {
  const none = await seriesTitle(null, { episodes: [] });
  const s0 = await getPublishState(producer(), none.id);
  assert.equal(s0.series_state, "not_linked");
  assert.equal(s0.form_defaults.slug, null);
  assert.equal(s0.form_defaults.iap_product_id, null);

  const t = await seriesTitle("a-brand-new-studio-series-with-a-very-long-name");
  const s1 = await getPublishState(producer(), t.id);
  assert.equal(s1.series_state, "not_uploaded");
  assert.equal(s1.series, null);
  assert.equal(s1.writes_enabled, true, "fixture mode writes to the fake");
  assert.equal(s1.writes_disabled_reason, undefined);
  assert.equal(s1.paywall_live, false);
  assert.equal(s1.can_write, true);
  assert.deepEqual(
    { ...s1.form_defaults },
    {
      slug: "a-brand-new-studio-series-with-a-very-long-name",
      title: "Studio a-brand-new-studio-series-with-a-very-long-name",
      tagline: null,
      description: null,
      genre: [],
      language: "en",
      free_episode_count: 5,
      series_price_cents: 999,
      iap_product_id: "cd.series.a_brand_new_studio_series_with",
      poster_url: "https://crazydramas.com/posters/a-brand-new-studio-series-with-a-very-long-name.jpg",
    }
  );
  assert.ok(s1.form_defaults.iap_product_id!.length <= 40, "the IAP id fits Google Play's 40 characters");
  assert.deepEqual(s1.episodes.map((e) => [e.n, e.studio_frames, e.ledger_step, e.cd_status, e.is_published, e.is_free]), [[1, 120, null, null, false, true], [2, 150, null, null, false, true], [3, 180, null, null, false, true]]);
  PublishStateSchema.parse(s1);

  await saveSeries(producer(), t.id, { title: "A Brand New Studio Series", free_episode_count: 1, series_price_cents: 499 });
  const s2 = await getPublishState(producer(), t.id);
  assert.equal(s2.series_state, "draft");
  assert.equal(s2.series?.managed_by, "studio");
  assert.equal(s2.series?.free_episode_count, 1);
  assert.equal(s2.form_defaults.series_price_cents, 499, "the form now starts from the series itself");
  assert.deepEqual(s2.episodes.map((e) => e.is_free), [true, false, false]);
  PublishStateSchema.parse(s2);

  await queueUploads(producer(), t.id, { episodes: [1] }, { schedule: false });
  const s3 = await getPublishState(producer(), t.id);
  assert.equal(s3.uploading, true);
  assert.equal(s3.episodes[0].ledger_step, "planned");
  assert.equal(s3.episodes[0].bytes_sent, 0);
  assert.equal(s3.episodes[0].bytes_total, Q + 11);
  await runTitleUploads(t.id, RUN);
  const s4 = await getPublishState(producer(), t.id);
  assert.equal(s4.episodes[0].ledger_step, "verified");
  assert.equal(s4.episodes[0].cd_status, "ready");
  assert.equal(s4.episodes[0].verdict, "identical", "the ledger's own record of the file makes the verdict identical, not just the same length");
  assert.equal(s4.episodes[1].verdict, "missing");
  await publishEpisodes(producer(), t.id, { episodes: [1], publish_series: true });
  const s5 = await getPublishState(producer(), t.id);
  assert.equal(s5.series_state, "published");
  assert.equal(s5.episodes[0].ledger_step, "published");
  assert.equal(s5.episodes[0].is_published, true);
  assert.doesNotMatch(JSON.stringify(s5), /fake-mux:|playback/i, "no upload URL and no playback id reach the screens");

  const cms = await seriesTitle("fixture-film", { ref: "low-quality/fixture-film-cms" });
  const s6 = await getPublishState(producer(), cms.id);
  assert.equal(s6.series_state, "cms_managed");
  assert.equal(s6.series?.managed_by, "cms");
  PublishStateSchema.parse(s6);

  const viewer = { ...producer(), producerRole: "viewer" as const };
  const s7 = await getPublishState(viewer, t.id);
  assert.equal(s7.can_write, false, "a viewer reads the state; the buttons are not theirs");
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  await assert.rejects(getPublishState(fixtureSession("producer", other.id), t.id), { code: "not_found" }, "a foreign title is not found");
});

// ---- PUT …/series ---------------------------------------------------------------------------------------------------

test("the series PUT: created as a Studio draft with the link recording its id and managed_by, then updated; each refusal before any write where Studio can tell, crazydramas' own passed through with its words", async () => {
  const t = await seriesTitle("new-studio-series");
  const created = await saveSeries(producer(), t.id, { title: "New Studio Series", tagline: "One line.", genre: ["Romance"], iap_product_id: "cd.series.new_studio_series", poster_url: "https://crazydramas.com/posters/new-studio-series.jpg" });
  assert.equal(created.created, true);
  assert.equal(created.series.status, "draft");
  assert.equal(created.series.cta_mode, "web_checkout");
  const link = await fixtureData.getPlatformLink(sys, t.id, PLATFORM);
  assert.equal(link?.cd_drama_id, created.series.id);
  assert.equal(link?.managed_by, "studio");
  const updated = await saveSeries(producer(), t.id, { title: "New Studio Series", tagline: "A better line." });
  assert.equal(updated.created, false);
  assert.deepEqual(updated.changed, ["tagline"]);

  const before = writes().length;
  await refusal(saveSeries(producer(), t.id, { title: "New Studio Series", poster_url: "https://crazydramas.com/posters/missing.jpg" }), 400, "poster_unreachable");
  assert.equal(writes().length, before, "the poster is checked before it is sent");

  fake.setSeriesStatus("new-studio-series", "published");
  const live = await refusal(saveSeries(producer(), t.id, { title: "New Studio Series", tagline: "Live edit." }), 409, "series_not_draft");
  assert.deepEqual(live.would_change, ["tagline"], "crazydramas' details pass through");
  fake.setSeriesStatus("new-studio-series", "draft");

  const unlinked = await seriesTitle(null, { episodes: [] });
  await refusal(saveSeries(producer(), unlinked.id, { title: "Anything" }), 409, "not_linked");

  // A show already live under another name: the working-name table, before any write.
  const cold = await seriesTitle("the-cold-ceo-studio", { name: "The Cold CEO", ref: "low-quality/the-cold-ceo" });
  const twin = await refusal(saveSeries(producer(), cold.id, { title: "The Cold CEO" }), 409, "series_title_exists");
  assert.equal((twin.existing as { slug: string }).slug, KNOWN_LIVE_SERIES.find((k) => k.working === "the cold ceo")!.slug);
  assert.equal(fake.seriesState("the-cold-ceo-studio"), null, "nothing was created");
  // …and the public catalog.
  const dup = await seriesTitle("fixture-copy", { name: "Fixture Film" });
  await refusal(saveSeries(producer(), dup.id, { title: "Fixture Film" }), 409, "series_title_exists");
  // A draft with the same title is not in the catalog: crazydramas' own guard answers, its words passed through.
  const again = await seriesTitle("new-studio-series-two", { name: "Something Else" });
  const remote = await refusal(saveSeries(producer(), again.id, { title: "New Studio Series" }), 409, "series_title_exists");
  assert.match(String(remote.error), /already exists as "new-studio-series"/);
  await refusal(saveSeries(producer(), again.id, { title: "Something Else", iap_product_id: "cd.series.new_studio_series" }), 409, "iap_product_id_taken");
  await refusal(saveSeries(producer(), again.id, { title: "Something Else", iap_product_id: "Not Valid!" }), 400, "bad_request");

  // A series made in the CMS: once a read recorded managed_by on the link, refused before any call at all.
  const cms = await seriesTitle("fixture-film", { ref: "low-quality/fixture-film-cms" });
  await checkCrazydramasTitle(sys, cms.id, { force: true });
  assert.equal((await fixtureData.getPlatformLink(sys, cms.id, PLATFORM))?.managed_by, "cms");
  const calls = fake.requests.length;
  const body = await refusal(saveSeries(producer(), cms.id, { title: "Fixture Film" }), 403, "series_not_studio");
  assert.match(String(body.error), /ask Jayden to hand it over/i);
  await refusal(queueUploads(producer(), cms.id, { episodes: "all" }, { schedule: false }), 403, "series_not_studio");
  await refusal(publishEpisodes(producer(), cms.id, { episodes: [1], publish_series: false }), 403, "series_not_studio");
  await refusal(unpublishEpisodes(producer(), cms.id, { episodes: [1] }), 403, "series_not_studio");
  assert.equal(fake.requests.length, calls, "not one request reached crazydramas");
  // Without that record yet, the read tells: still no write.
  const cms2 = await seriesTitle("fixture-film-partial", { ref: "low-quality/fixture-film-partial-cms" });
  await refusal(saveSeries(producer(), cms2.id, { title: "Fixture Film (partial)" }), 403, "series_not_studio");
  assert.equal(writes().filter((w) => w.path.includes("fixture-film")).length, 0);
});

test("who may act: the title's approver or a staff administrator; a reviewer, a staff editor and a viewer are refused; a foreign title is not found", async () => {
  const t = await seriesTitle("who-series");
  const reviewer = { ...producer(), producerRole: "reviewer" as const };
  await assert.rejects(saveSeries(reviewer, t.id, { title: "Who" }), { code: "forbidden" });
  await assert.rejects(queueUploads({ ...staff(), staffRole: "editor" as const }, t.id, { episodes: "all" }, { schedule: false }), { code: "forbidden" });
  await assert.rejects(cancelUploads({ ...producer(), producerRole: "viewer" as const }, t.id, {}), { code: "forbidden" });
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  await assert.rejects(saveSeries(fixtureSession("producer", other.id), t.id, { title: "Who" }), { code: "not_found" });
  const r = await saveSeries(staff(), t.id, { title: "Who Series" });
  assert.equal(r.created, true, "a staff administrator may send it");
});

test("writes disabled in fixture mode without the fake (CRAZYDRAMAS_LIVE_READ=1): every write refused with the setting's name, nothing sent anywhere", async () => {
  const t = await seriesTitle("disabled-series");
  process.env.CRAZYDRAMAS_LIVE_READ = "1";
  const before = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    throw new Error("no network in tests");
  }) as typeof fetch;
  try {
    const body = await refusal(saveSeries(producer(), t.id, { title: "Disabled" }), 409, "writes_disabled");
    assert.match(String(body.reason), /DATA_SOURCE=supabase/);
    await refusal(queueUploads(producer(), t.id, { episodes: "all" }, { schedule: false }), 409, "writes_disabled");
    await refusal(publishEpisodes(producer(), t.id, { episodes: [1], publish_series: true }), 409, "writes_disabled");
    await refusal(unpublishEpisodes(producer(), t.id, { unpublish_series: true }), 409, "writes_disabled");
    const state = await getPublishState(producer(), t.id);
    assert.equal(state.writes_enabled, false);
    assert.match(state.writes_disabled_reason!, /CRAZYDRAMAS_LIVE_WRITES|DATA_SOURCE/);
    assert.equal(fake.requests.length, 0, "the fake is not written either");
    assert.equal(fetched, 0, "and nothing went to the network");
  } finally {
    globalThis.fetch = before;
  }
});

// ---- uploads ----------------------------------------------------------------------------------------------------------

test("uploads: refused before the series exists; each episode that cannot go is skipped with its reason; a re-cut over media crazydramas holds needs replace", async () => {
  const t = await seriesTitle("upload-series");
  await refusal(queueUploads(producer(), t.id, { episodes: "all" }, { schedule: false }), 409, "series_missing");
  await saveSeries(producer(), t.id, { title: "Upload Series" });
  await fixtureData.addVideoOnlyEpisode(sys, t.id, 4, `${t.id}/ep4/upload.mp4`);
  const q = await queueUploads(producer(), t.id, { episodes: [1, 4, 9] }, { schedule: false });
  assert.deepEqual(q.queued, [1]);
  assert.match(q.skipped.find((s) => s.n === 4)!.reason, /not an imported file/);
  assert.match(q.skipped.find((s) => s.n === 9)!.reason, /no episode 9/);
  assert.deepEqual((await queueUploads(producer(), t.id, { episodes: [1] }, { schedule: false })).queued, [1], "asking again for the same file while it waits is the same row");
  await runTitleUploads(t.id, RUN);

  // A re-cut of episode 1: Studio's file changes; crazydramas holds the old one.
  const buf = randomBytes(Q + 99);
  const stored = `local/${t.id}/ws/upload-series/ep01-recut.mp4`;
  mkdirSync(path.dirname(localPathOf(stored)), { recursive: true });
  writeFileSync(localPathOf(stored), buf);
  await fixtureData.setEpisodeImport(sys, (await fixtureData.listTitleEpisodes(sys, t.id))[0].id, { video_path: stored, video_sha256: sha(buf), video_bytes: buf.byteLength, video_frames: 121, duration_ms: Math.round((121 / 30) * 1000) });
  const state = await getPublishState(producer(), t.id);
  assert.equal(state.episodes[0].replace_needed, true);
  const plain = await queueUploads(producer(), t.id, { episodes: [1] }, { schedule: false });
  assert.deepEqual(plain.queued, []);
  assert.match(plain.skipped[0].reason, /replace/);
  const replaced = await queueUploads(producer(), t.id, { episodes: [1], replace: true }, { schedule: false });
  assert.deepEqual(replaced.queued, [1]);
  const summary = await runTitleUploads(t.id, RUN);
  assert.deepEqual(summary.verified, [1]);
  const rows = await fixtureData.getCdPublications(sys, t.id);
  const newest = rows.filter((r) => r.episode_number === 1).at(-1)!;
  assert.equal(newest.replace, true);
  assert.ok(newest.previous_asset_id, "the replaced asset is recorded (never deleted)");
});

// ---- publish -----------------------------------------------------------------------------------------------------------

test("publish: paid episodes need the extra confirm until CRAZYDRAMAS_PAYWALL_LIVE=1, exactly the listed episodes go live, a partial episodes_changed is recorded for what did go, unpublish puts the rows back to verified", async () => {
  const t = await seriesTitle("paid-series");
  await saveSeries(producer(), t.id, { title: "Paid Series", free_episode_count: 1 });
  await queueUploads(producer(), t.id, { episodes: "all" }, { schedule: false });
  await runTitleUploads(t.id, RUN);

  const posts = () => fake.requests.filter((r) => r.path.endsWith("/publish")).length;
  const paid = await refusal(publishEpisodes(producer(), t.id, { episodes: [1, 2], publish_series: true }), 409, "paid_needs_confirm");
  assert.deepEqual(paid.paid, [2]);
  assert.ok(String(paid.error).includes(PAID_WARNING));
  assert.equal(posts(), 0, "nothing was sent without the confirm");
  const first = await publishEpisodes(producer(), t.id, { episodes: [1, 2], publish_series: true, confirm_paid: true });
  assert.deepEqual(first.published, [1, 2]);
  assert.equal(first.series_status, "published");
  assert.deepEqual(fake.seriesState("paid-series")!.episodes.map((e) => e.is_published), [true, true, false], "exactly the listed episodes");

  const hidden = await unpublishEpisodes(producer(), t.id, { episodes: [2] });
  assert.deepEqual(hidden.unpublished, [2]);
  assert.equal((await fixtureData.getCdPublications(sys, t.id)).find((r) => r.episode_number === 2)!.step, "verified");
  process.env.CRAZYDRAMAS_PAYWALL_LIVE = "1";
  assert.equal((await getPublishState(producer(), t.id)).paywall_live, true);
  fake.flipOnPublish = [3];
  const partial = await refusal(publishEpisodes(producer(), t.id, { episodes: [2, 3], publish_series: false }), 409, "episodes_changed");
  assert.deepEqual(partial.published, [2], "with the paywall live no confirm is asked; crazydramas published 2 and not 3");
  assert.deepEqual(partial.not_published, [3]);
  const rows = await fixtureData.getCdPublications(sys, t.id);
  assert.equal(rows.find((r) => r.episode_number === 2)!.step, "published", "what did go live is recorded");
  assert.equal(rows.find((r) => r.episode_number === 3)!.step, "verified");
  await refusal(unpublishEpisodes(producer(), t.id, { episodes: [8] }), 404, "episodes_not_found");
  await refusal(publishEpisodes(producer(), t.id, { episodes: [7], publish_series: false }), 409, "not_verified");
});

// ---- the routes themselves ------------------------------------------------------------------------------------------------

test("the six routes load and export their handlers", async () => {
  const publish = await import("@/app/api/titles/[id]/crazydramas/publish/route");
  const series = await import("@/app/api/titles/[id]/crazydramas/series/route");
  const uploads = await import("@/app/api/titles/[id]/crazydramas/uploads/route");
  const cancel = await import("@/app/api/titles/[id]/crazydramas/uploads/cancel/route");
  const unpublish = await import("@/app/api/titles/[id]/crazydramas/unpublish/route");
  for (const fn of [publish.GET, publish.POST, series.PUT, uploads.POST, cancel.POST, unpublish.POST]) assert.equal(typeof fn, "function");
  assert.equal(publish.dynamic, "force-dynamic");
});

// ---- the token -------------------------------------------------------------------------------------------------------------

test("the token never appears in any serialised output or log: state, ledger rows, answers, refusals, errors and every console line of a whole upload", async () => {
  const secret = "5ec2e7".padEnd(64, "a1");
  process.env.CRAZYDRAMAS_STUDIO_TOKEN = secret;
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ["log", "warn", "error", "info"] as const) console[k] = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
  const seen: string[] = [];
  try {
    const t = await seriesTitle("secret-series");
    seen.push(JSON.stringify(await saveSeries(producer(), t.id, { title: "Secret Series", free_episode_count: 5 })));
    seen.push(JSON.stringify(await queueUploads(producer(), t.id, { episodes: "all" }, { schedule: false })));
    seen.push(JSON.stringify(await runTitleUploads(t.id, RUN)));
    seen.push(JSON.stringify(await publishEpisodes(producer(), t.id, { episodes: [1, 2, 3], publish_series: true })));
    seen.push(JSON.stringify(await getPublishState(producer(), t.id)));
    seen.push(JSON.stringify(await fixtureData.getCdPublications(sys, t.id)));
    seen.push(JSON.stringify(await fixtureData.getPlatformLink(sys, t.id, PLATFORM)));
    seen.push(JSON.stringify(await fixtureData.listPlatformSnapshots(sys, PLATFORM, "secret-series")));
    try {
      await saveSeries(producer(), t.id, { title: "Secret Series", poster_url: "https://crazydramas.com/posters/missing.jpg" });
    } catch (e) {
      seen.push(JSON.stringify(isCdPublishError(e) ? e.body() : String(e)), String((e as Error).message));
    }
    try {
      await liveCrazydramasStudioTransport.request("GET", "/api/studio/series/secret-series");
    } catch (e) {
      assert.ok(e instanceof CrazydramasApiError);
      seen.push(e.message, JSON.stringify(e));
    }
    seen.push(JSON.stringify(fake.requests), JSON.stringify(fake.chunks));
  } finally {
    Object.assign(console, orig);
  }
  for (const text of [...seen, ...lines]) {
    assert.ok(!text.includes(secret), `the token leaked into: ${text.slice(0, 120)}`);
    assert.ok(!text.includes("5ec2e7"), "not even a prefix of it");
  }
  assert.ok(seen.length >= 10);
});
