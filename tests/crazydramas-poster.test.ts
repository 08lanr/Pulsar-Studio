// The poster Studio hosts itself (decision 2026-09-23 "Upload automation:
// poster, slug, series text"; lib/crazydramas/poster.ts): the ffmpeg
// arguments that make a 1200×1600 portrait JPEG (a straight scale for a 3:4
// source, cover-fit and a centred crop otherwise, quality ~85, no metadata,
// bit-exact), the bucket made on first use and idempotent against a fake
// Storage API, the object path and the public URL's shape, the fixture
// bucket's made-up https address mapped back to the same-origin route, the
// title's cover as the default source (and a title with none said so), the
// "Set poster" action on an existing Studio series (a live one needs its
// confirm; a CMS one is refused before any write), and the form's poster
// defaults. No network, no Supabase: a memory store and fixture mode's fake.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { fakeCrazydramasTransport as fake } from "@/lib/crazydramas/fake";
import { shownPosterUrl } from "@/lib/crazydramas/pick";
import {
  ensureOnce,
  ensurePosterBucket,
  ffmpegEncoder,
  fixturePosterFile,
  fixturePublicPosterUrl,
  imageExt,
  isJpeg,
  isThreeByFour,
  normalisePoster,
  POSTER_BUCKET,
  posterAddressRefusal,
  posterFfmpegArgs,
  posterFilter,
  posterForTitle,
  posterObjectPath,
  resetPosterBucket,
  storePoster,
  supabasePublicPosterUrl,
  type BucketApi,
  type PosterEncoder,
  type PosterStore,
} from "@/lib/crazydramas/poster";
import { getPublishState, isCdPublishError, resetCrazydramasUploads, saveSeries, setSeriesPoster } from "@/lib/crazydramas/publish";
import { fixturePosterPreview, PublishStateSchema } from "@/lib/crazydramas/publish-types";
import { resetCrazydramasSweep } from "@/lib/crazydramas/sweep";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { localPathOf } from "@/lib/data/storage";
import type { Title } from "@/lib/types";
import { producer } from "./seed-minute";

const sys = systemSession();
const FIXTURE_POSTER = path.join(process.cwd(), "tests", "fixtures", "workspace", "low-quality", "fixture-film", "poster", "final", "fixture-film-a.jpg");
const temps: string[] = [];

beforeEach(() => {
  resetFixtureStore();
  resetCrazydramasSweep();
  resetCrazydramasUploads();
  resetPosterBucket();
  fake.reset();
  const dir = mkdtempSync(path.join(tmpdir(), "cd-poster-"));
  temps.push(dir);
  process.env.STUDIO_LOCAL_MEDIA_DIR = path.join(dir, "local");
  process.env.STUDIO_WORK_DIR = path.join(dir, "work");
});

afterEach(() => {
  resetFixtureStore();
  resetPosterBucket();
  fake.reset();
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  delete process.env.STUDIO_WORK_DIR;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

async function refusal(p: Promise<unknown>, status: number, code: string): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    if (!isCdPublishError(e)) throw e;
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.equal(e.status, status);
    return e.body();
  }
  assert.fail(`expected ${code}, the call succeeded`);
}

/** A bucket in memory, the way a test stands in for Studio's Supabase project. */
function memoryStore(opts: { refuse?: boolean } = {}): PosterStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    kind: "fixture",
    objects,
    async put(p, bytes) {
      objects.set(p, bytes);
    },
    publicUrl: (p) => `https://example.supabase.co/storage/v1/object/public/${POSTER_BUCKET}/${p}`,
    previewUrl: (p) => `/preview/${p}`,
    async check(p) {
      if (opts.refuse) return { ok: false, status: 403, content_type: "text/html", reason: "It answers HTTP 403, not 200." };
      return objects.has(p) && isJpeg(objects.get(p)!) ? { ok: true, status: 200, content_type: "image/jpeg", reason: null } : { ok: false, status: 404, content_type: null, reason: "missing" };
    },
  };
}

/** ffmpeg stood in for: the probe answers a size, the run writes a small JPEG to the output (the last argument). */
function fakeEncoder(size = { width: 120, height: 160 }): PosterEncoder & { runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    probe: async () => size,
    run: async (args) => {
      runs.push(args);
      // Deterministic, as ffmpeg's bit-exact output is: the bytes depend on the filter, never on the scratch paths.
      writeFileSync(args[args.length - 1], Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`poster ${args[args.indexOf("-vf") + 1]}`)]));
    },
  };
}

async function titleWithCover(slug: string, cover = true): Promise<Title> {
  const who = producer();
  const title = await fixtureData.createImportedTitle(sys, { producer_id: who.producerId!, source_ref: `low-quality/${slug}`, display_title_en: `Poster ${slug}`, crazydramas_slug: slug, created_by: who.userId });
  if (!cover) return title;
  const stored = `local/${title.id}/ws/${slug}/cover-12345678.jpg`;
  mkdirSync(path.dirname(localPathOf(stored)), { recursive: true });
  writeFileSync(localPathOf(stored), readFileSync(FIXTURE_POSTER));
  return fixtureData.setTitleImport(sys, title.id, { cover_path: stored });
}

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", ["-version"]).status === 0;

// ---- the conversion ---------------------------------------------------------------------------------------------------

test("the normalisation arguments: 1200×1600 JPEG — a straight scale for a 3:4 source, cover-fit and a centred crop otherwise — quality ~85, the first frame, no metadata, no encoder tag", () => {
  assert.equal(isThreeByFour({ width: 120, height: 160 }), true);
  assert.equal(isThreeByFour({ width: 1080, height: 1440 }), true);
  assert.equal(isThreeByFour({ width: 1081, height: 1440 }), true, "within half a percent");
  assert.equal(isThreeByFour({ width: 1080, height: 1920 }), false, "9:16 is not 3:4");
  assert.equal(isThreeByFour({ width: 1600, height: 1200 }), false, "4:3 landscape is not 3:4");
  assert.equal(isThreeByFour(null), false);
  assert.equal(posterFilter({ width: 750, height: 1000 }), "scale=1200:1600,setsar=1");
  assert.equal(posterFilter({ width: 1080, height: 1920 }), "scale=1200:1600:force_original_aspect_ratio=increase,crop=1200:1600,setsar=1");
  assert.equal(posterFilter(null), "scale=1200:1600:force_original_aspect_ratio=increase,crop=1200:1600,setsar=1", "an unknown size is cropped, never letterboxed");
  const args = posterFfmpegArgs("in.png", "out.jpg", { width: 1920, height: 1080 });
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at("-i"), "in.png");
  assert.equal(at("-frames:v"), "1");
  assert.equal(at("-vf"), "scale=1200:1600:force_original_aspect_ratio=increase,crop=1200:1600,setsar=1");
  assert.equal(at("-map_metadata"), "-1", "metadata stripped");
  assert.equal(at("-fflags"), "+bitexact");
  assert.equal(at("-flags:v"), "+bitexact", "no encoder tag, the same bytes every time");
  assert.equal(at("-c:v"), "mjpeg");
  assert.equal(at("-q:v"), "3", "about quality 85");
  assert.equal(at("-pix_fmt"), "yuvj420p");
  assert.equal(args[args.length - 1], "out.jpg");
  assert.equal(imageExt(readFileSync(FIXTURE_POSTER)), ".jpg");
  assert.equal(imageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), ".png");
  assert.equal(imageExt(Buffer.from("not an image at all")), ".img");
});

test("normalisePoster through ffmpeg: the fixture's 3:4 poster becomes 1200×1600 without a crop, a landscape image is centre-cropped, and the same source gives the same bytes (skipped without ffmpeg)", { skip: hasFfmpeg ? false : "ffmpeg is not on this machine" }, async () => {
  const a = await normalisePoster(readFileSync(FIXTURE_POSTER), ffmpegEncoder);
  assert.equal(a.cropped, false);
  assert.deepEqual(a.source, { width: 120, height: 160 });
  assert.ok(isJpeg(a.bytes));
  const b = await normalisePoster(readFileSync(FIXTURE_POSTER), ffmpegEncoder);
  assert.equal(b.sha256, a.sha256, "bit-exact: the same source, the same poster and name");
  assert.doesNotMatch(a.bytes.toString("latin1"), /Lavc|Exif/, "no encoder tag, no EXIF");
  const probe = spawnSync(process.env.FFPROBE_PATH?.trim() || "ffprobe", ["-v", "error", "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0", "-"], { input: a.bytes });
  if (probe.status === 0) assert.equal(probe.stdout.toString().trim(), "mjpeg,1200,1600");

  const dir = mkdtempSync(path.join(tmpdir(), "cd-poster-src-"));
  temps.push(dir);
  const wide = path.join(dir, "wide.png");
  assert.equal(spawnSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180", "-frames:v", "1", wide]).status, 0);
  const c = await normalisePoster(readFileSync(wide), ffmpegEncoder);
  assert.equal(c.cropped, true);
  assert.equal(c.width, 1200);
  assert.equal(c.height, 1600);
  await assert.rejects(normalisePoster(Buffer.from("not an image"), ffmpegEncoder), /could not be read/);
});

// ---- where it lives ---------------------------------------------------------------------------------------------------------

test("the object path is <title_external_id>/<sha8>.jpg and the public URL is Supabase's public-object URL of the public-posters bucket", () => {
  const sha = "0123abcd".padEnd(64, "e");
  assert.equal(posterObjectPath("ttl_h4qu5cn3c6ogs", sha), "ttl_h4qu5cn3c6ogs/0123abcd.jpg");
  assert.equal(posterObjectPath("ttl/../x", sha), "ttl_x/0123abcd.jpg", "no path separator or dot segment survives in the folder");
  assert.throws(() => posterObjectPath("ttl_x", "not-hex"));
  assert.equal(supabasePublicPosterUrl("https://abcd.supabase.co/", "ttl_x/0123abcd.jpg"), "https://abcd.supabase.co/storage/v1/object/public/public-posters/ttl_x/0123abcd.jpg");
  // Fixture mode: a made-up https address (the .invalid TLD resolves nowhere) the screens show through the same-origin route.
  const fixtureUrl = fixturePublicPosterUrl("ttl_x/0123abcd.jpg");
  assert.equal(fixtureUrl, "https://studio-fixture.invalid/api/public-posters/ttl_x/0123abcd.jpg");
  assert.equal(fixturePosterPreview(fixtureUrl), "/api/public-posters/ttl_x/0123abcd.jpg");
  assert.equal(shownPosterUrl(fixtureUrl), "/api/public-posters/ttl_x/0123abcd.jpg", "the screens load it from Studio, never from the made-up host");
  assert.equal(shownPosterUrl("https://abcd.supabase.co/storage/v1/object/public/public-posters/ttl_x/0123abcd.jpg"), null, "fixture mode fetches no other host");
  assert.ok(fixturePosterFile("ttl_x/0123abcd.jpg")?.endsWith(path.join("public-posters", "ttl_x", "0123abcd.jpg")));
  for (const bad of ["../x/0123abcd.jpg", "ttl_x/../../etc.jpg", "ttl_x/0123abcd.png", "ttl_x/sub/0123abcd.jpg", "ttl_x\\y/0123abcd.jpg"]) assert.equal(fixturePosterFile(bad), null, bad);
  assert.equal(posterAddressRefusal(new URL("https://crazydramas.com/posters/x.jpg")), null);
  assert.match(posterAddressRefusal(new URL("http://crazydramas.com/x.jpg")) ?? "", /https/);
  assert.match(posterAddressRefusal(new URL("https://127.0.0.1/x.jpg")) ?? "", /named public web address/);
  assert.match(posterAddressRefusal(new URL("https://intranet.local/x.jpg")) ?? "", /named public web address/);
});

// ---- the bucket -------------------------------------------------------------------------------------------------------------

type Call = [string, string, unknown?];

function fakeStorage(start: { exists: boolean; public?: boolean }, opts: { raceOnCreate?: boolean; readError?: string } = {}): BucketApi & { calls: Call[]; state: { exists: boolean; public: boolean } } {
  const state = { exists: start.exists, public: start.public ?? false };
  const calls: Call[] = [];
  return {
    calls,
    state,
    async getBucket(id) {
      calls.push(["get", id]);
      if (opts.readError) return { data: null, error: { message: opts.readError, statusCode: "500" } };
      if (!state.exists) return { data: null, error: { message: "Bucket not found", statusCode: "404" } };
      return { data: { id, public: state.public }, error: null };
    },
    async createBucket(id, options) {
      calls.push(["create", id, options]);
      if (state.exists || opts.raceOnCreate) {
        state.exists = true;
        state.public = true;
        return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
      }
      state.exists = true;
      state.public = options.public;
      return { data: { name: id }, error: null };
    },
    async updateBucket(id, options) {
      calls.push(["update", id, options]);
      state.public = options.public;
      return { data: { message: "Successfully updated" }, error: null };
    },
  };
}

test("the bucket is made on first use, public, and every later ensure is a read: missing → created; there and public → nothing; there and private → made public; a lost create race → there", async () => {
  const missing = fakeStorage({ exists: false });
  assert.equal(await ensurePosterBucket(missing), "created");
  assert.deepEqual(missing.calls.map((c) => c[0]), ["get", "create"]);
  assert.deepEqual(missing.calls[1], ["create", "public-posters", { public: true, fileSizeLimit: 10 * 1024 * 1024, allowedMimeTypes: ["image/jpeg"] }]);
  assert.equal(await ensurePosterBucket(missing), "exists", "idempotent: the second ensure only reads");
  assert.deepEqual(missing.calls.map((c) => c[0]), ["get", "create", "get"]);

  const priv = fakeStorage({ exists: true, public: false });
  assert.equal(await ensurePosterBucket(priv), "made_public");
  assert.equal(priv.state.public, true);
  assert.equal(await ensurePosterBucket(priv), "exists");

  const race = fakeStorage({ exists: false }, { raceOnCreate: true });
  assert.equal(await ensurePosterBucket(race), "exists", "another Studio made it first");

  await assert.rejects(ensurePosterBucket(fakeStorage({ exists: false }, { readError: "permission denied" })), /could not be read: permission denied/);

  // Once per process: two posters, one ensure; a failure is forgotten so the next poster tries again.
  const once = fakeStorage({ exists: false });
  await Promise.all([ensureOnce(once), ensureOnce(once)]);
  await ensureOnce(once);
  assert.deepEqual(once.calls.map((c) => c[0]), ["get", "create"]);
  resetPosterBucket();
  const failing = fakeStorage({ exists: false }, { readError: "boom" });
  await assert.rejects(ensureOnce(failing));
  await assert.rejects(ensureOnce(failing));
  assert.equal(failing.calls.length, 2, "a failed ensure is not cached");
});

test("storePoster: normalised, stored under its own sha and checked; a stored file that does not answer as an image is refused", async () => {
  const store = memoryStore();
  const enc = fakeEncoder({ width: 1080, height: 1920 });
  const p = await storePoster("ttl_abc", readFileSync(FIXTURE_POSTER), { store, encoder: enc });
  assert.match(p.object_path, /^ttl_abc\/[0-9a-f]{8}\.jpg$/);
  assert.equal(p.object_path, `ttl_abc/${p.sha256.slice(0, 8)}.jpg`);
  assert.equal(p.poster_url, `https://example.supabase.co/storage/v1/object/public/public-posters/${p.object_path}`);
  assert.equal(p.cropped, true, "a 9:16 source is centre-cropped");
  assert.deepEqual([p.width, p.height], [1200, 1600]);
  assert.ok(store.objects.has(p.object_path));
  assert.match(enc.runs[0].join(" "), /crop=1200:1600/);
  await assert.rejects(storePoster("ttl_abc", readFileSync(FIXTURE_POSTER), { store: memoryStore({ refuse: true }), encoder: fakeEncoder() }), /does not answer as an image: It answers HTTP 403/);
});

// ---- the title's poster -------------------------------------------------------------------------------------------------------

test("posterForTitle: the title's cover by default; a title with no cover says so; a pasted address is checked and passed on as it is", async () => {
  const t = await titleWithCover("poster-series");
  const store = memoryStore();
  const cover = await posterForTitle(producer(), t.id, { kind: "cover" }, { store, encoder: fakeEncoder() });
  assert.equal(cover.source, "cover");
  assert.equal(cover.cropped, false, "the fixture cover is 3:4");
  assert.match(cover.poster_url, new RegExp(`/public-posters/${t.external_id}/[0-9a-f]{8}\\.jpg$`));
  const again = await posterForTitle(producer(), t.id, { kind: "cover" }, { store, encoder: fakeEncoder() });
  assert.equal(again.poster_url, cover.poster_url, "the same cover, the same object");

  const none = await titleWithCover("no-cover-series", false);
  const body = await refusal(posterForTitle(producer(), none.id, { kind: "cover" }, { store, encoder: fakeEncoder() }), 409, "poster_unavailable");
  assert.match(String(body.error), /no cover in Studio.*create the series without a poster/);

  const pasted = await posterForTitle(producer(), t.id, { kind: "url", url: "https://crazydramas.com/posters/poster-series.jpg" });
  assert.deepEqual([pasted.source, pasted.poster_url, pasted.sha256, pasted.preview_url], ["url", "https://crazydramas.com/posters/poster-series.jpg", null, null]);
  await refusal(posterForTitle(producer(), t.id, { kind: "url", url: "https://crazydramas.com/posters/missing.jpg" }), 400, "poster_unreachable");
  await refusal(posterForTitle(producer(), t.id, { kind: "url", url: "http://crazydramas.com/posters/x.jpg" }), 400, "poster_unreachable");
  await refusal(posterForTitle(producer(), t.id, { kind: "file", bytes: new Uint8Array() }, { store, encoder: fakeEncoder() }), 400, "poster_failed");
});

test("Set poster on an existing Studio series: a PUT with the poster alone; a live series needs its confirm (update_live); a CMS series is refused before any write", async () => {
  const t = await titleWithCover("set-poster-series");
  await saveSeries(producer(), t.id, { title: "Set Poster Series" });
  const url = fixturePublicPosterUrl(`${t.external_id}/0123abcd.jpg`);
  const writesBefore = fake.requests.filter((r) => r.method !== "GET").length;
  const r = await setSeriesPoster(producer(), t.id, url);
  assert.equal(r.series.poster_url, url);
  assert.ok(r.changed.includes("poster_url"), r.changed.join(","));
  assert.deepEqual(r.changed.filter((c) => !c.startsWith("poster_")), [], "nothing but the poster changed");
  const puts = fake.requests.filter((q) => q.method !== "GET").slice(writesBefore);
  assert.deepEqual(puts.map((q) => [q.method, q.path]), [["PUT", "/api/studio/series/set-poster-series"]], "one PUT");

  const state = await getPublishState(producer(), t.id);
  assert.equal(state.form_defaults.poster_url, url);
  assert.equal(state.form_defaults.poster_default, "keep", "a series with a poster keeps it unless another is chosen");
  assert.equal(state.form_defaults.poster_preview_url, `/api/public-posters/${t.external_id}/0123abcd.jpg`);
  PublishStateSchema.parse(state);

  fake.setSeriesStatus("set-poster-series", "published");
  const live = await refusal(setSeriesPoster(producer(), t.id, fixturePublicPosterUrl(`${t.external_id}/fedcba98.jpg`)), 409, "series_live_confirm");
  assert.equal(live.series_status, "published");
  // crazydramas refuses a change to a live series without update_live (series_not_draft): the confirmed write went through.
  const confirmed = await setSeriesPoster(producer(), t.id, fixturePublicPosterUrl(`${t.external_id}/fedcba98.jpg`), { confirmLive: true });
  assert.match(confirmed.series.poster_url ?? "", /fedcba98\.jpg$/);
  assert.equal(confirmed.series.status, "published");

  await refusal(setSeriesPoster(producer(), t.id, "http://example.com/x.jpg"), 400, "bad_request");

  const none = await titleWithCover("no-series-yet");
  await refusal(setSeriesPoster(producer(), none.id, url), 409, "series_missing");

  const cms = await titleWithCover("fixture-film");
  const before = fake.requests.filter((q) => q.method !== "GET").length;
  await refusal(setSeriesPoster(producer(), cms.id, url), 403, "series_not_studio");
  assert.equal(fake.requests.filter((q) => q.method !== "GET").length, before, "nothing was sent to a CMS series");
});

test("the form's poster defaults: the title's cover when the series has no poster; none (said so) when the title has no cover", async () => {
  const withCover = await titleWithCover("default-cover");
  const a = await getPublishState(producer(), withCover.id);
  assert.equal(a.series_state, "not_uploaded");
  assert.deepEqual([a.form_defaults.has_cover, a.form_defaults.poster_default, a.form_defaults.poster_url], [true, "cover", null]);
  assert.equal(a.form_defaults.slug_editable, true, "no draft series yet: the slug may still change");
  const without = await titleWithCover("default-none", false);
  const b = await getPublishState(producer(), without.id);
  assert.deepEqual([b.form_defaults.has_cover, b.form_defaults.poster_default], [false, "none"]);
});
