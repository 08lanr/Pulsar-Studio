// The series poster, hosted by Studio itself (decision 2026-09-23 "Upload
// automation: poster, slug, series text"). crazydramas needs `poster_url` to
// be a permanent public https address that answers 200 with an image
// (STUDIO_API.md "Before any live use" 3: a 3:4 portrait JPG, about
// 1200×1600). Studio has no public host of its own, so the poster goes into a
// PUBLIC bucket of Studio's own Supabase project, `public-posters`, at
// `<title_external_id>/<sha8>.jpg`, and its public URL is what crazydramas
// gets:
//
//   1. the source — the title's cover (core.titles.cover_path: the imported
//      poster, local tier) or an image a person picked in the form — is
//      normalised with ffmpeg to a 1200×1600 JPEG: scaled to fit exactly when
//      it is already 3:4, cover-fit with a centred crop when it is not;
//      quality about 85 (mjpeg q 3); every bit of metadata stripped; bit-exact,
//      so the same source gives the same bytes and the same name;
//   2. the bucket is made on first use through the Storage API with the
//      service role (created public when missing, made public when it is
//      not; idempotent; nothing for a person to run);
//   3. the file is stored (content-addressed, so a repeat overwrites the same
//      bytes) and its public URL checked to answer 200 image/jpeg before it is
//      handed on.
//
// Fixture mode never reaches Supabase: the bucket is a folder under .uploads/
// served by GET /api/public-posters/…, under a made-up https origin (the
// `.invalid` TLD: nothing can resolve it) that the screens map back to the
// same-origin route (lib/crazydramas/publish-types.ts fixturePosterPreview).
// A pasted address is not re-hosted: it is checked as before and sent as it
// is.

import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeSourceSize, runFfmpeg, type SourceSize } from "@/lib/clips/cut";
import { dataSource } from "@/lib/data-source";
import { readStoredBytes, uploadsDir } from "@/lib/data/storage";
import { getData } from "@/lib/data";
import type { Session } from "@/lib/auth";
import { shownPosterUrl } from "./pick";
import { CdPublishError } from "./publish";
import { FIXTURE_POSTER_ORIGIN, POSTER_ROUTE, type PosterReply } from "./publish-types";
import { crazydramasStudioMode, studioClient } from "./studio-client";

// ---- the shape ---------------------------------------------------------------------------------------------

export const POSTER_BUCKET = "public-posters";
export const POSTER_WIDTH = 1200;
export const POSTER_HEIGHT = 1600;
/** mjpeg's qscale: 2 is the best; 3 is about quality 85. */
export const POSTER_QSCALE = 3;
/** The largest image a person may hand the poster route. */
export const POSTER_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** What the bucket accepts (its own limit, set when Studio makes it). */
export const POSTER_BUCKET_LIMIT_BYTES = 10 * 1024 * 1024;

/** Is the picture already 3:4 portrait (within half a percent)? */
export function isThreeByFour(size: SourceSize | null): boolean {
  if (!size || size.width <= 0 || size.height <= 0) return false;
  return Math.abs(size.width / size.height - 0.75) <= 0.75 * 0.005;
}

/** The filter: a 3:4 source is scaled to fit exactly; anything else is cover-fit and centre-cropped (never letterboxed). Pure. */
export function posterFilter(size: SourceSize | null): string {
  const scale = isThreeByFour(size)
    ? `scale=${POSTER_WIDTH}:${POSTER_HEIGHT}`
    : `scale=${POSTER_WIDTH}:${POSTER_HEIGHT}:force_original_aspect_ratio=increase,crop=${POSTER_WIDTH}:${POSTER_HEIGHT}`;
  return `${scale},setsar=1`;
}

/**
 * The ffmpeg arguments that turn one image into the poster: the first frame
 * only, the filter above, a full-range 4:2:0 JPEG at q 3, no metadata, no
 * encoder tag (bit-exact, so the same source always gives the same bytes).
 * Pure.
 */
export function posterFfmpegArgs(input: string, output: string, size: SourceSize | null): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", input,
    "-frames:v", "1",
    "-vf", posterFilter(size),
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-pix_fmt", "yuvj420p",
    "-c:v", "mjpeg",
    "-q:v", String(POSTER_QSCALE),
    "-f", "image2",
    "-update", "1",
    output,
  ];
}

export type NormalisedPoster = { bytes: Buffer; sha256: string; width: number; height: number; source: SourceSize | null; cropped: boolean };

/** Scratch for the conversion: STUDIO_WORK_DIR, else the OS temp dir. */
function workDir(): string {
  const configured = process.env.STUDIO_WORK_DIR?.trim();
  return path.join(configured ? path.resolve(process.cwd(), configured) : path.join(tmpdir(), "studio-work"), "posters");
}

const JPEG_SOI = [0xff, 0xd8, 0xff];

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && JPEG_SOI.every((b, i) => bytes[i] === b);
}

/** The extension an image's first bytes say it is (ffmpeg reads by content, a name helps it); `.img` when unknown. */
export function imageExt(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (isJpeg(bytes)) return ".jpg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  if (head.subarray(0, 3).toString("latin1") === "GIF") return ".gif";
  return ".img";
}

/** What the conversion needs of ffmpeg (tests inject a stand-in). */
export type PosterEncoder = { probe: (file: string) => Promise<SourceSize | null>; run: (args: string[]) => Promise<unknown> };

export const ffmpegEncoder: PosterEncoder = {
  probe: (file) => probeSourceSize(file),
  run: (args) => runFfmpeg(args, { timeoutMs: 60_000 }),
};

/** One image (any format ffmpeg reads) to the 1200×1600 poster JPEG, in a scratch folder that is removed afterwards. */
export async function normalisePoster(source: Uint8Array, encoder: PosterEncoder = ffmpegEncoder): Promise<NormalisedPoster> {
  const dir = path.join(workDir(), randomUUID().slice(0, 8));
  await mkdir(dir, { recursive: true });
  try {
    const input = path.join(dir, `source${imageExt(source)}`);
    const output = path.join(dir, "poster.jpg");
    await writeFile(input, source);
    const size = await encoder.probe(input);
    if (!size) throw new Error("the image could not be read (not a picture ffmpeg knows)");
    await encoder.run(posterFfmpegArgs(input, output, size));
    const bytes = await readFile(output).catch(() => null);
    if (!bytes || !isJpeg(bytes)) throw new Error("ffmpeg did not produce a JPEG");
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), width: POSTER_WIDTH, height: POSTER_HEIGHT, source: size, cropped: !isThreeByFour(size) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---- where it lives ----------------------------------------------------------------------------------------

/** `<title_external_id>/<sha8>.jpg`: content-addressed, one folder per title. */
export function posterObjectPath(titleExternalId: string, sha256: string): string {
  const folder = titleExternalId.replace(/[^A-Za-z0-9_-]+/g, "_") || "title";
  if (!/^[0-9a-f]{8,}$/.test(sha256)) throw new Error("the poster's sha256 is not hex");
  return `${folder}/${sha256.slice(0, 8)}.jpg`;
}

/** The public URL Supabase serves a public bucket's object at: `<SUPABASE_URL>/storage/v1/object/public/<bucket>/<path>`. Pure. */
export function supabasePublicPosterUrl(supabaseUrl: string, objectPath: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${POSTER_BUCKET}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** The fixture bucket's "public" URL: a made-up https origin the screens map back to the same-origin route. Pure. */
export function fixturePublicPosterUrl(objectPath: string): string {
  return `${FIXTURE_POSTER_ORIGIN}${POSTER_ROUTE}${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

// ---- the bucket --------------------------------------------------------------------------------------------

type StorageError = { message?: string; statusCode?: string | number; status?: number; error?: string } | null;

/** The part of supabase-js's `storage` the bucket needs (tests pass a fake). */
export type BucketApi = {
  getBucket(id: string): Promise<{ data: { id: string; public: boolean } | null; error: StorageError }>;
  createBucket(id: string, options: { public: boolean; fileSizeLimit?: number | string | null; allowedMimeTypes?: string[] | null }): Promise<{ data: unknown; error: StorageError }>;
  updateBucket(id: string, options: { public: boolean; fileSizeLimit?: number | string | null; allowedMimeTypes?: string[] | null }): Promise<{ data: unknown; error: StorageError }>;
};

const statusOf = (e: StorageError) => Number(e?.statusCode ?? e?.status ?? NaN);
const notFound = (e: StorageError) => !!e && (statusOf(e) === 404 || /not.?found/i.test(`${e.message ?? ""} ${e.error ?? ""}`));
const exists = (e: StorageError) => !!e && (statusOf(e) === 409 || /already exists|duplicate/i.test(`${e.message ?? ""} ${e.error ?? ""}`));

const BUCKET_OPTIONS = { public: true, fileSizeLimit: POSTER_BUCKET_LIMIT_BYTES, allowedMimeTypes: ["image/jpeg"] };

/**
 * Make sure the public bucket exists and is public: `exists` when it already
 * is, `created` when Studio made it, `made_public` when it was there but
 * private. A create that loses a race to another Studio server reads as
 * `exists`. Any other refusal throws with Supabase's words.
 */
export async function ensurePosterBucket(api: BucketApi): Promise<"exists" | "created" | "made_public"> {
  const got = await api.getBucket(POSTER_BUCKET);
  if (got.data && !got.error) {
    if (got.data.public) return "exists";
    const up = await api.updateBucket(POSTER_BUCKET, BUCKET_OPTIONS);
    if (up.error) throw new Error(`the ${POSTER_BUCKET} bucket is private and could not be made public: ${up.error.message ?? "refused"}`);
    return "made_public";
  }
  if (got.error && !notFound(got.error)) throw new Error(`the ${POSTER_BUCKET} bucket could not be read: ${got.error.message ?? "refused"}`);
  const made = await api.createBucket(POSTER_BUCKET, BUCKET_OPTIONS);
  if (!made.error) return "created";
  if (exists(made.error)) {
    const again = await api.getBucket(POSTER_BUCKET);
    if (again.data?.public) return "exists";
    if (again.data) {
      const up = await api.updateBucket(POSTER_BUCKET, BUCKET_OPTIONS);
      if (!up.error) return "made_public";
    }
  }
  throw new Error(`the ${POSTER_BUCKET} bucket could not be created: ${made.error.message ?? "refused"}`);
}

// ---- the stores ----------------------------------------------------------------------------------------------

export type PosterCheck = { ok: boolean; status: number | null; content_type: string | null; reason: string | null };

export type PosterStore = {
  readonly kind: "supabase" | "fixture";
  put(objectPath: string, bytes: Uint8Array): Promise<void>;
  publicUrl(objectPath: string): string;
  /** What a browser of Studio may load: the public URL live; the same-origin route in fixture mode. */
  previewUrl(objectPath: string): string;
  /** Does the public URL answer 200 image/jpeg? */
  check(objectPath: string): Promise<PosterCheck>;
};

/** The fixture bucket's folder: `.uploads/public-posters/`. */
export function fixturePosterDir(): string {
  return path.join(uploadsDir(), POSTER_BUCKET);
}

/** The disk file behind a fixture object path, or null when the path would leave the folder. */
export function fixturePosterFile(objectPath: string): string | null {
  const segments = objectPath.split("/");
  if (segments.length !== 2 || segments.some((s) => !s || s === "." || s === ".." || /[\\:\0]/.test(s))) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(segments[0]) || !/^[0-9a-f]{8}\.jpg$/.test(segments[1])) return null;
  return path.join(fixturePosterDir(), ...segments);
}

export const fixturePosterStore: PosterStore = {
  kind: "fixture",
  async put(objectPath, bytes) {
    const file = fixturePosterFile(objectPath);
    if (!file) throw new Error("invalid poster path");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  },
  publicUrl: fixturePublicPosterUrl,
  previewUrl: (objectPath) => `${POSTER_ROUTE}${objectPath.split("/").map(encodeURIComponent).join("/")}`,
  async check(objectPath) {
    const file = fixturePosterFile(objectPath);
    const bytes = file && existsSync(file) ? await readFile(file) : null;
    if (!bytes) return { ok: false, status: 404, content_type: null, reason: "The poster is not in the bucket." };
    if (!isJpeg(bytes)) return { ok: false, status: 200, content_type: "application/octet-stream", reason: "The stored poster is not a JPEG." };
    return { ok: true, status: 200, content_type: "image/jpeg", reason: null };
  },
};

type Holder = { __studioPosterBucket?: Promise<unknown> | null };
const holder = globalThis as unknown as Holder;

/** Tests: forget that the bucket was ensured in this process. */
export function resetPosterBucket(): void {
  holder.__studioPosterBucket = null;
}

/** Ensure once per process (a failure is forgotten, so the next poster tries again). */
export function ensureOnce(api: BucketApi): Promise<unknown> {
  if (!holder.__studioPosterBucket) {
    holder.__studioPosterBucket = ensurePosterBucket(api).then((r) => {
      if (r !== "exists") console.log(`[crazydramas] the ${POSTER_BUCKET} bucket: ${r}`);
      return r;
    });
    holder.__studioPosterBucket.catch(() => {
      holder.__studioPosterBucket = null;
    });
  }
  return holder.__studioPosterBucket;
}

function supabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set, so Studio has no bucket for the poster");
  return url;
}

/** Studio's own Supabase project, the service role (a storage helper: CLAUDE.md allows it). Never in fixture mode. */
export const supabasePosterStore: PosterStore = {
  kind: "supabase",
  async put(objectPath, bytes) {
    const { createServiceSupabase } = await import("@/lib/supabase/server");
    const storage = createServiceSupabase().storage;
    await ensureOnce(storage as unknown as BucketApi);
    const { error } = await storage.from(POSTER_BUCKET).upload(objectPath, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
    if (error) throw new Error(`the poster could not be stored: ${error.message}`);
  },
  publicUrl: (objectPath) => supabasePublicPosterUrl(supabaseUrl(), objectPath),
  previewUrl: (objectPath) => supabasePublicPosterUrl(supabaseUrl(), objectPath),
  async check(objectPath) {
    const url = supabasePublicPosterUrl(supabaseUrl(), objectPath);
    const c = await studioClient().checkImage(url);
    if (c.ok && c.content_type !== "image/jpeg") return { ok: false, status: c.status, content_type: c.content_type, reason: `It answers ${c.content_type ?? "no content type"}, not image/jpeg.` };
    return c;
  },
};

/** The store for the mode: Supabase in live mode, the folder in fixture mode (never Supabase). */
export function posterStore(): PosterStore {
  return dataSource() === "supabase" ? supabasePosterStore : fixturePosterStore;
}

// ---- one poster, stored and checked --------------------------------------------------------------------------

export type StoredPoster = {
  poster_url: string;
  preview_url: string;
  sha256: string;
  object_path: string;
  bytes: number;
  width: number;
  height: number;
  /** The source was not 3:4, so it was centre-cropped. */
  cropped: boolean;
};

/** Normalise, store and check one poster. Throws with the reason in words when any step fails. */
export async function storePoster(titleExternalId: string, source: Uint8Array, opts: { store?: PosterStore; encoder?: PosterEncoder } = {}): Promise<StoredPoster> {
  const store = opts.store ?? posterStore();
  const poster = await normalisePoster(source, opts.encoder);
  const objectPath = posterObjectPath(titleExternalId, poster.sha256);
  await store.put(objectPath, poster.bytes);
  const check = await store.check(objectPath);
  if (!check.ok) throw new Error(`the stored poster does not answer as an image: ${check.reason ?? `HTTP ${check.status ?? "—"}`}`);
  return { poster_url: store.publicUrl(objectPath), preview_url: store.previewUrl(objectPath), sha256: poster.sha256, object_path: objectPath, bytes: poster.bytes.length, width: poster.width, height: poster.height, cropped: poster.cropped };
}

/** The title's cover bytes (local tier or the media bucket), or null when it has none or it cannot be read. */
export async function coverBytes(coverPath: string | null | undefined): Promise<Buffer | null> {
  if (!coverPath) return null;
  try {
    return await readStoredBytes(coverPath);
  } catch {
    return null;
  }
}

// ---- the poster route's work ---------------------------------------------------------------------------------

/**
 * Why an address may not be asked at all (the poster check's rule, shared
 * with POST …/poster-check), or null when it may: https only, no user or
 * password, a named public host on the standard port — never an IP literal,
 * localhost or an internal name, whatever the mode.
 */
export function posterAddressRefusal(url: URL): string | null {
  if (url.protocol !== "https:") return "The poster must be an https:// address.";
  if (url.username || url.password) return "The poster address must not carry a user name or password.";
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "The poster must be on a named public web address.";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return "The poster must be on a named public web address, not an IP address.";
  if (url.port && url.port !== "443") return "The poster must be on the standard https port.";
  return null;
}

export type PosterSource = { kind: "cover" } | { kind: "file"; bytes: Uint8Array } | { kind: "url"; url: string };

/**
 * One poster for the title, ready to send: the cover or a picked image
 * normalised, stored in the public bucket and checked (200 image/jpeg); a
 * pasted address checked (200 image/*) and passed on as it is. Refusals are
 * CdPublishError: `poster_unavailable` (no cover), `poster_unreachable` (the
 * address or the stored file does not answer as an image), `poster_failed`
 * (the image could not be converted or stored). The caller checked who may
 * ask; a foreign title is not found here first.
 */
export async function posterForTitle(session: Session, titleId: string, source: PosterSource, opts: { store?: PosterStore; encoder?: PosterEncoder } = {}): Promise<PosterReply["poster"]> {
  const title = (await getData().getTitle(session, titleId)).title;
  if (source.kind === "url") {
    let url: URL;
    try {
      url = new URL(source.url.trim());
    } catch {
      throw new CdPublishError(400, "poster_unreachable", "That is not a web address. Nothing was sent.");
    }
    const refused = posterAddressRefusal(url);
    if (refused) throw new CdPublishError(400, "poster_unreachable", `${refused} Nothing was sent.`);
    const check = await studioClient().checkImage(url.toString());
    if (!check.ok) throw new CdPublishError(400, "poster_unreachable", `The poster ${check.reason ?? "does not answer with an image"} Nothing was sent.`, { poster: { status: check.status, content_type: check.content_type } });
    const preview = crazydramasStudioMode().read === "fake" ? shownPosterUrl(url.toString()) : url.toString();
    return { poster_url: url.toString(), preview_url: preview, source: "url", sha256: null, bytes: null, width: null, height: null, cropped: false };
  }
  let bytes: Uint8Array | null;
  if (source.kind === "cover") {
    bytes = await coverBytes(title.cover_path);
    if (!bytes) throw new CdPublishError(409, "poster_unavailable", title.cover_path ? "The title's cover could not be read; pick an image or paste an address." : "This title has no cover in Studio; pick an image or paste an address, or create the series without a poster.");
  } else {
    bytes = source.bytes;
    if (!bytes.length) throw new CdPublishError(400, "poster_failed", "The picked file is empty.");
    if (bytes.length > POSTER_MAX_UPLOAD_BYTES) throw new CdPublishError(413, "poster_failed", `The picked file is over ${Math.round(POSTER_MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`);
  }
  let stored: StoredPoster;
  try {
    stored = await storePoster(title.external_id, bytes, opts);
  } catch (e) {
    const why = (e as Error).message;
    throw new CdPublishError(/answer as an image/.test(why) ? 502 : 422, /answer as an image/.test(why) ? "poster_unreachable" : "poster_failed", `The poster could not be made: ${why}. Nothing was sent.`);
  }
  console.log(`[crazydramas] poster for ${title.external_id}: ${stored.object_path} (sha256 ${stored.sha256}, ${stored.bytes} bytes${stored.cropped ? ", centre-cropped to 3:4" : ""})`);
  return { poster_url: stored.poster_url, preview_url: stored.preview_url, source: source.kind, sha256: stored.sha256, bytes: stored.bytes, width: stored.width, height: stored.height, cropped: stored.cropped };
}
