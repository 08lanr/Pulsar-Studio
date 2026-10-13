// A creator's media library (decision 2026-10-12). One import path for the
// Library tab's upload, the MCP-less import script and the tests:
//
//   1. hash the file as given; the same file already in the account is the
//      existing row (re-importing is a no-op, nothing is stored again);
//   2. images: Instagram takes JPEG only, so a PNG or WebP is re-encoded once
//      to a high-quality JPEG (ffmpeg, FFMPEG_PATH as elsewhere); an image
//      outside the feed's 4:5..1.91:1 is refused here, because the feed is the
//      only place an image can go;
//   3. videos (MP4 / MOV): probed with ffprobe for size and length, stored as
//      they are; whether one fits a Reel or a carousel is checked when it is
//      scheduled (lib/creators/validate.ts);
//   4. stored in the studio-media bucket under `creators/<account>/<sha16>.<ext>`
//      (fixture: the same path under .uploads/), with the stored bytes' hash,
//      which the publishing engine re-verifies before any URL is handed to Meta.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { invalid } from "@/lib/data/errors";
import { putStoredBytes, readStoredBytes } from "@/lib/data/storage";
import { MAX_PUBLISH_BYTES, signedClipUrl } from "@/lib/launch/clip-bytes";
import type { CreatorMedia } from "./types";
import { feedRatioIssue } from "./validate";

/** Instagram's own ceiling for a feed image. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 2 * 60 * 1000;

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type Sniffed =
  | { kind: "image"; mime: "image/jpeg" | "image/png" | "image/webp"; width: number | null; height: number | null }
  | { kind: "video"; mime: "video/mp4" | "video/quicktime" }
  | null;

/** What a file is, from its first bytes, and an image's pixel size from its header. Pure. */
export function sniff(b: Uint8Array): Sniffed {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "image/jpeg", ...jpegSize(b) };
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { kind: "image", mime: "image/png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { kind: "image", mime: "image/webp", ...webpSize(b) };
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") return { kind: "video", mime: ascii(b, 8, 10) === "qt" ? "video/quicktime" : "video/mp4" };
  return null;
}
function ascii(b: Uint8Array, from: number, to: number) { return String.fromCharCode(...b.subarray(from, to)); }
function jpegSize(b: Uint8Array): { width: number | null; height: number | null } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + len;
  }
  return { width: null, height: null };
}
function webpSize(b: Uint8Array): { width: number | null; height: number | null } {
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  if (chunk === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { width: null, height: null };
}

async function ffmpegBinary(): Promise<string> {
  return (await import("@/lib/clips/cut")).ffmpegBin();
}

/** A high-quality JPEG of any image ffmpeg can read (alpha flattened onto white). */
export async function toJpeg(bytes: Uint8Array, quality = 2): Promise<Buffer> {
  const work = path.join(tmpdir(), `studio-creator-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  try {
    const src = path.join(work, "in"), out = path.join(work, "out.jpg");
    await writeFile(src, bytes);
    const bin = await ffmpegBinary();
    await new Promise<void>((resolve, reject) => {
      const p = spawn(bin, ["-v", "error", "-y", "-i", src, "-filter_complex", "color=white,format=rgb24[bg];[bg][0:v]scale2ref[bg2][img];[bg2][img]overlay=format=auto:shortest=1,format=yuvj420p", "-frames:v", "1", "-q:v", String(quality), out]);
      let err = "";
      p.stderr.on("data", d => (err += String(d)));
      const timer = setTimeout(() => p.kill(), FFMPEG_TIMEOUT_MS);
      p.on("error", e => { clearTimeout(timer); reject(invalid(`ffmpeg could not run (${e.message}). Set FFMPEG_PATH.`)); });
      p.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(invalid(`ffmpeg could not convert the image to JPEG: ${err.trim().slice(0, 200)}`)); });
    });
    return await readFile(out);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function probeVideo(bytes: Uint8Array): Promise<{ width: number | null; height: number | null; duration_s: number | null }> {
  const work = path.join(tmpdir(), `studio-creator-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  try {
    const file = path.join(work, "video.mp4");
    await writeFile(file, bytes);
    const { ffprobeFacts } = await import("@/lib/film-import/import");
    const facts = await ffprobeFacts(file);
    if (!facts) throw invalid("ffprobe could not read this video (FFPROBE_PATH / FFMPEG_PATH name the binary).");
    return { width: facts.width, height: facts.height, duration_s: facts.duration_s };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type ImportInput = { bytes: Uint8Array; filename: string; description?: string; tags?: string[] };
export type ImportResult = { media: CreatorMedia; created: boolean; converted: boolean; warnings: string[] };

/** One file into an account's library. The caller checked who may (any staff member). */
export async function importCreatorMedia(session: Session, accountRef: string, input: ImportInput): Promise<ImportResult> {
  const data = getData();
  const account = await data.getCreatorAccount(session, accountRef);
  if (!input.bytes.length) throw invalid("The file is empty.");
  if (input.bytes.length > MAX_PUBLISH_BYTES) throw invalid("The file is larger than 256 MB.");
  const original = sha256(input.bytes);
  const existing = (await data.listCreatorMedia(session, account.id)).find(m => m.sha256 === original);
  if (existing) return { media: existing, created: false, converted: false, warnings: [] };

  const kind = sniff(input.bytes);
  if (!kind) throw invalid("Studio takes JPEG, PNG or WebP images and MP4 or MOV videos.");
  const warnings: string[] = [];
  let stored: Uint8Array = input.bytes, mime: CreatorMedia["mime"], width: number | null, height: number | null, duration: number | null = null, converted = false;
  if (kind.kind === "image") {
    if (kind.mime !== "image/jpeg" || input.bytes.length > IMAGE_MAX_BYTES) {
      stored = await toJpeg(input.bytes, input.bytes.length > IMAGE_MAX_BYTES && kind.mime === "image/jpeg" ? 4 : 2);
      if (stored.length > IMAGE_MAX_BYTES) stored = await toJpeg(input.bytes, 6);
      if (stored.length > IMAGE_MAX_BYTES) throw invalid("This image is larger than Instagram's 8 MB even as a JPEG.");
      converted = true;
    }
    const size = sniff(stored);
    width = size?.kind === "image" ? size.width : kind.width;
    height = size?.kind === "image" ? size.height : kind.height;
    const issue = feedRatioIssue(width, height);
    if (issue) throw invalid(`This image cannot go in the Instagram feed: ${issue}. Crop it to between 4:5 and 1.91:1.`);
    mime = "image/jpeg";
  } else {
    const facts = await probeVideo(input.bytes);
    ({ width, height } = facts);
    duration = facts.duration_s;
    mime = kind.mime;
    if (width && height && Math.abs(width / height - 9 / 16) > 0.02) warnings.push(`A Reel shows best at 9:16; this video is ${width}×${height}.`);
  }
  const ext = mime === "image/jpeg" ? "jpg" : mime === "video/quicktime" ? "mov" : "mp4";
  const storagePath = `creators/${account.id}/${original.slice(0, 16)}.${ext}`;
  await putStoredBytes(storagePath, stored, mime);
  const { media, created } = await data.createCreatorMedia(session, {
    account_id: account.id, kind: kind.kind, path: storagePath, sha256: original, stored_sha256: sha256(stored),
    width, height, duration_s: duration, mime, bytes: stored.length,
    description: input.description ?? "", tags: input.tags ?? [], filename: path.basename(input.filename).slice(0, 200),
  });
  return { media, created, converted, warnings };
}

/** The stored bytes, re-hashed against the row: a file that changed after import is never posted. */
export async function verifiedMediaBytes(media: CreatorMedia): Promise<Buffer> {
  const bytes = await readStoredBytes(media.path);
  if (sha256(bytes) !== media.stored_sha256) throw invalid(`${media.filename || media.external_id} changed after it was imported. Import it again.`);
  return bytes;
}

/** A short-lived URL Instagram fetches the file from (fixture: a fixture:// URL nothing leaves the process with). */
export function signedCreatorMediaUrl(media: CreatorMedia, seconds = 900): Promise<string> {
  return signedClipUrl(media.path, seconds);
}
