// Cut one range of an episode into a finished 9:16 ad file (decision
// 2026-09-14): the shared renderer behind auto-cut clips (lib/clips/run.ts)
// and campaign creatives (lib/promote/render.ts). A clean cut — no text is
// burned into the picture (founders, 2026-09-14: "not necessary for now,
// and won't ever be necessary"); the hook is ad copy, shown beside the clip
// and sent as the ad's text. H.264 + AAC, faststart: what both ad platforms
// accept as uploaded.
//
// ffmpeg reads a local file, so the stored source is materialized into a
// temp dir once per run (`withSourceFile`) and every cut of that run reads
// it; the temp dir is removed afterwards whatever happened. A local-tier
// source (an imported episode's hardlink, decision 2026-09-22) is already a
// disk file and is read in place through `localPathOf` — no copy of a film
// per run, and never the pipeline's own path.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isLocalTierPath, localPathOf, putStoredBytes, readStoredBytes } from "@/lib/data/storage";

export const AD_WIDTH = 1080;
export const AD_HEIGHT = 1920;
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

export type RenderedAd = { render_path: string; render_sha256: string; duration_ms: number; width: number; height: number; bytes: number };

/** The ffmpeg binary: `FFMPEG_PATH` when set (a machine whose PATH does not carry it), else the one on PATH. */
export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

/** A temp copy of a stored video for ffmpeg (a local-tier source is read in place); the dir is removed when `fn` settles. */
export async function withSourceFile<T>(sourcePath: string, fn: (srcAbs: string, workDir: string) => Promise<T>): Promise<T> {
  const work = path.join(tmpdir(), `studio-cut-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  try {
    let src: string;
    if (isLocalTierPath(sourcePath)) {
      src = localPathOf(sourcePath);
    } else {
      src = path.join(work, `source${path.extname(sourcePath) || ".mp4"}`);
      await writeFile(src, await readStoredBytes(sourcePath));
    }
    return await fn(src, work);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type SourceSize = { width: number; height: number };

/** The source's pixel size from ffmpeg's input dump (exit code is irrelevant without an output). */
export async function probeSourceSize(srcAbs: string): Promise<SourceSize | null> {
  const err = await runFfmpeg(["-hide_banner", "-i", srcAbs], { tolerateExit: true });
  const m = err.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export type Framing = { filter: string; /** Top pixel row of the letterboxed picture; null when the picture fills the frame. */ pictureTop: number | null };

/**
 * How the source fills the 9:16 frame. A vertical (or near-vertical) source
 * is scaled to cover and center-cropped: a few pixels off the sides, no
 * quality lost. A landscape source is NOT zoomed into — cropping a 16:9
 * frame to 9:16 keeps a third of the width and blows it up 2.7×, which is
 * the "terrible resolution" a producer sees (2026-09-14). Instead it is
 * scaled to the full width, kept whole, and placed over a blurred copy of
 * itself filling the frame, its bottom on the 35% band so the platform UI
 * never covers it: the standard vertical treatment for landscape footage.
 */
export function frameFilter(size: SourceSize | null, label = ""): Framing {
  const cover = `scale=${AD_WIDTH}:${AD_HEIGHT}:force_original_aspect_ratio=increase,crop=${AD_WIDTH}:${AD_HEIGHT}`;
  if (!size || size.width / size.height <= 0.75) return { filter: cover, pictureTop: null };
  const pictureHeight = Math.round((AD_WIDTH * size.height) / size.width / 2) * 2;
  const pictureTop = Math.max(0, Math.round(AD_HEIGHT * 0.65) - pictureHeight);
  // The blurred fill is built at a quarter of the size and scaled up: the same look, a fraction of the memory.
  const small = `scale=${AD_WIDTH / 4}:${AD_HEIGHT / 4}:force_original_aspect_ratio=increase,crop=${AD_WIDTH / 4}:${AD_HEIGHT / 4},boxblur=6:2,scale=${AD_WIDTH}:${AD_HEIGHT}`;
  // `label` prefixes the inner pad names, so several framed inputs share one graph (the 60-second ad, lib/clips/montage-render.ts).
  const l = (name: string) => `[${label}${name}]`;
  return { filter: `split=2${l("bg")}${l("fg")};${l("bg")}${small}${l("bgb")};${l("fg")}scale=${AD_WIDTH}:-2${l("fgs")};${l("bgb")}${l("fgs")}overlay=(W-w)/2:${pictureTop}`, pictureTop };
}

export type CutInput = {
  /** Absolute path of the materialized source (see withSourceFile). */
  srcAbs: string;
  workDir: string;
  startMs: number;
  endMs: number;
  /** Storage path the finished file is written to. */
  storedPath: string;
  /** The source's pixel size when the caller probed it already (one probe per run); probed here otherwise. */
  sourceSize?: SourceSize | null;
};

export async function cutClip(input: CutInput): Promise<RenderedAd> {
  const { startMs: start, endMs: end } = input;
  if (end <= start) throw new Error("the clip range is empty");
  const out = path.join(input.workDir, `cut-${randomUUID().slice(0, 8)}.mp4`);
  const size = input.sourceSize ?? (await probeSourceSize(input.srcAbs));
  const frame = frameFilter(size);
  await runFfmpeg(["-y", "-ss", (start / 1000).toFixed(3), "-to", (end / 1000).toFixed(3), "-i", input.srcAbs, "-filter_complex", frame.filter, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k", out]);
  const bytes = await readFile(out);
  const render_sha256 = createHash("sha256").update(bytes).digest("hex");
  await putStoredBytes(input.storedPath, bytes, "video/mp4");
  await rm(out, { force: true }).catch(() => undefined);
  return { render_path: input.storedPath, render_sha256, duration_ms: end - start, width: AD_WIDTH, height: AD_HEIGHT, bytes: bytes.length };
}

/**
 * At most this many ffmpeg processes per web-server process, whatever asks
 * (uploads, demo seeds, revisions). A 1080×1920 encode holds close to a
 * gigabyte; an evening of demo resets once spawned dozens at a time
 * (2026-09-14). Callers queue; nothing is refused.
 */
export const FFMPEG_CONCURRENCY = Number(process.env.FFMPEG_CONCURRENCY) > 0 ? Number(process.env.FFMPEG_CONCURRENCY) : 2;
const gate = globalThis as unknown as { __studioFfmpegGate?: { running: number; queue: Array<() => void> } };
const slotState = () => (gate.__studioFfmpegGate ??= { running: 0, queue: [] });

async function withFfmpegSlot<T>(fn: () => Promise<T>): Promise<T> {
  const s = slotState();
  if (s.running >= FFMPEG_CONCURRENCY) await new Promise<void>((resolve) => s.queue.push(resolve));
  s.running += 1;
  try {
    return await fn();
  } finally {
    s.running -= 1;
    s.queue.shift()?.();
  }
}

/** Run ffmpeg to completion; resolves with its stderr (the filters log there), rejects with a readable reason. */
export function runFfmpeg(args: string[], opts: { timeoutMs?: number; tolerateExit?: boolean } = {}): Promise<string> {
  return withFfmpegSlot(() => spawnFfmpeg(args, opts));
}

function spawnFfmpeg(args: string[], opts: { timeoutMs?: number; tolerateExit?: boolean }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(ffmpegBin(), args);
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    const limit = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      p.kill();
      const minutes = Math.round(limit / 60000);
      reject(new Error(`the render timed out after ${minutes} minute${minutes === 1 ? "" : "s"}`));
    }, limit);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg is not installed on this machine" : `could not run ffmpeg: ${e.message}`));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || opts.tolerateExit) resolve(err);
      else reject(new Error(`render failed: ${err.slice(-400) || `exit ${code}`}`));
    });
  });
}
