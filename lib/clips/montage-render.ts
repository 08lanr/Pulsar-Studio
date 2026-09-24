// The 60-second ad's render (decision 2026-09-24; the pick is
// lib/clips/montage.ts). One ffmpeg run joins the pieces: each piece is its
// own input, seeked to 0.3 of a frame before its first frame (the frame
// itself is then the first one kept; the cut-only pipeline's lesson of
// 2026-09-22) and trimmed to exactly its frame count, framed for 9:16 the
// way every clip is (lib/clips/cut.ts frameFilter: cover a vertical source,
// keep a landscape one whole over its blurred fill), then the concat filter
// joins them with hard cuts and ONE loudness pass (loudnorm to -14 LUFS, the
// mobile-feed target the narrated pipeline's gate checks) runs over the
// joined sound, which fades out over the last half second. Each piece's
// sound gets a 15 ms fade at both edges so a hard cut does not click.
// Nothing is drawn on the picture: no text, no poster, no end card.
//
// The file is checked before it is kept: the frame count must be the plan's
// (ffprobe counts the packets, as the import does), the size 1080×1920, and
// the length at most 60.0 s; the measured loudness is recorded.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isLocalTierPath, localPathOf, putStoredBytes, readStoredBytes } from "@/lib/data/storage";
import { ffprobeFacts } from "@/lib/film-import/import";
import type { MontagePiece } from "@/lib/types";
import { AD_HEIGHT, AD_WIDTH, frameFilter, runFfmpeg, type SourceSize } from "./cut";
import { framePieces, MONTAGE_MAX_MS, type FramedPiece } from "./montage";

/** The target of the one loudness pass (integrated, LUFS), its true-peak ceiling and range. */
export const MONTAGE_LUFS = -14;
const LOUDNORM = `loudnorm=I=${MONTAGE_LUFS}:TP=-1.5:LRA=11`;
const EDGE_FADE_S = 0.015;
const END_FADE_S = 0.5;
const RENDER_TIMEOUT_MS = 15 * 60 * 1000;

export type SourceFacts = { size: SourceSize | null; fps: number | null; hasAudio: boolean };

/** Pixel size, frame rate and whether there is sound, from ffmpeg's input dump. */
export function parseSourceFacts(stderr: string): SourceFacts {
  const video = stderr.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*/)?.[0] ?? "";
  const size = video.match(/\b(\d{2,5})x(\d{2,5})\b/);
  const fps = video.match(/\b(\d+(?:\.\d+)?) fps\b/) ?? video.match(/\b(\d+(?:\.\d+)?) tbr\b/);
  return {
    size: size ? { width: Number(size[1]), height: Number(size[2]) } : null,
    fps: fps ? Number(fps[1]) : null,
    hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(stderr),
  };
}

/** The rate ffmpeg is given: the NTSC rates as their exact fractions, anything else as measured. */
export function frameRate(fps: number | null): { expr: string; value: number } {
  const f = fps && fps > 0 ? fps : 30;
  for (const [n, d] of [[24000, 1001], [30000, 1001], [60000, 1001]] as const) if (Math.abs(f - n / d) < 0.005) return { expr: `${n}/${d}`, value: n / d };
  const r = Math.round(f * 1000) / 1000;
  return { expr: String(r), value: r };
}

/** Where a piece's input is opened: 0.3 frame before its first frame, so that frame is the first one kept. */
export const seekOf = (frame: number, fps: number) => Math.max(0, (frame - 0.3) / fps).toFixed(6);

export type ArgsPiece = Pick<FramedPiece, "start_frame" | "frames"> & { src: string; facts: SourceFacts };

/** The whole ffmpeg command line (pure; the tests read it). */
export function montageArgs(pieces: readonly ArgsPiece[], rate: { expr: string; value: number }, out: string): string[] {
  const args = ["-hide_banner", "-y"];
  for (const p of pieces) args.push("-ss", seekOf(p.start_frame, rate.value), "-i", p.src);
  const graph: string[] = [];
  const total = pieces.reduce((n, p) => n + p.frames, 0);
  pieces.forEach((p, i) => {
    const d = (p.frames / rate.value).toFixed(6);
    const sameRate = p.facts.fps !== null && Math.abs(p.facts.fps - rate.value) < 0.01;
    const frame = frameFilter(p.facts.size, `m${i}`).filter;
    graph.push(`[${i}:v:0]${sameRate ? "" : `fps=${rate.expr},`}trim=end_frame=${p.frames},setpts=PTS-STARTPTS,${frame},setsar=1,format=yuv420p[v${i}]`);
    const edges = `afade=t=in:d=${EDGE_FADE_S},afade=t=out:st=${Math.max(0, Number(d) - EDGE_FADE_S).toFixed(6)}:d=${EDGE_FADE_S}`;
    graph.push(p.facts.hasAudio
      ? `[${i}:a:0]atrim=end=${d},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${d},${edges}[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=end=${d},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  });
  const seconds = total / rate.value;
  graph.push(`${pieces.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${pieces.length}:v=1:a=1[vout][joined]`);
  const fade = Math.min(END_FADE_S, seconds / 4);
  graph.push(`[joined]${LOUDNORM},aresample=48000,afade=t=out:st=${Math.max(0, seconds - fade).toFixed(6)}:d=${fade.toFixed(6)},atrim=end=${seconds.toFixed(6)}[aout]`);
  args.push(
    "-filter_complex", graph.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-frames:v", String(total),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
    out,
  );
  return args;
}

/** The integrated loudness from the ebur128 filter's summary, or null. */
export function parseIntegratedLoudness(stderr: string): number | null {
  const m = stderr.match(/Integrated loudness:\s*[\r\n]+\s*I:\s*(-?[0-9.]+|-inf)\s*LUFS/);
  if (!m || m[1] === "-inf") return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** The encoder's own last count ("frame=  210"), when ffprobe is not there to count the file. */
export function parseEncodedFrames(stderr: string): number | null {
  const all = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

export type RenderedMontage = {
  render_path: string;
  render_sha256: string;
  duration_ms: number;
  width: number;
  height: number;
  bytes: number;
  frames: number;
  fps: string;
  /** Measured on the finished file; null when it could not be read. */
  lufs: number | null;
  pieces: MontagePiece[];
};

export type MontageRenderInput = {
  pieces: readonly MontagePiece[];
  /** Each piece's episode's stored video path, by episode id. */
  videoPaths: ReadonlyMap<string, string>;
  /** Storage path the finished file is written to. */
  storedPath: string;
  maxMs?: number;
  /** Called between the steps, so the build's heartbeat keeps going. */
  onStep?: (step: "probing" | "rendering" | "checking" | "storing") => void | Promise<void>;
};

/** Materialize every stored source once (a local-tier file is read in place); the temp dir goes when `fn` settles. */
async function withSources<T>(stored: readonly string[], fn: (abs: Map<string, string>, work: string) => Promise<T>): Promise<T> {
  const work = path.join(tmpdir(), `studio-montage-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  try {
    const abs = new Map<string, string>();
    let n = 0;
    for (const s of new Set(stored)) {
      if (isLocalTierPath(s)) abs.set(s, localPathOf(s));
      else {
        const file = path.join(work, `source-${n++}${path.extname(s) || ".mp4"}`);
        await writeFile(file, await readStoredBytes(s));
        abs.set(s, file);
      }
    }
    return await fn(abs, work);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function renderMontage(input: MontageRenderInput): Promise<RenderedMontage> {
  if (!input.pieces.length) throw new Error("the ad has no pieces");
  const stored = input.pieces.map((p) => {
    const v = input.videoPaths.get(p.episode_id);
    if (!v) throw new Error(`episode ${p.episode_number} has no video`);
    return v;
  });
  return withSources(stored, async (abs, work) => {
    await input.onStep?.("probing");
    const facts = new Map<string, SourceFacts>();
    for (const s of new Set(stored)) facts.set(s, parseSourceFacts(await runFfmpeg(["-hide_banner", "-i", abs.get(s)!], { tolerateExit: true })));
    const rate = frameRate(facts.get(stored[0])!.fps);
    const framed = framePieces(input.pieces, rate.value, input.maxMs ?? MONTAGE_MAX_MS);
    const total = framed.reduce((n, p) => n + p.frames, 0);
    const out = path.join(work, `ad60-${randomUUID().slice(0, 8)}.mp4`);
    await input.onStep?.("rendering");
    const log = await runFfmpeg(montageArgs(framed.map((p, i) => ({ ...p, src: abs.get(stored[i])!, facts: facts.get(stored[i])! })), rate, out), { timeoutMs: RENDER_TIMEOUT_MS });

    // The checks: the frames the plan holds, the ad's size, at most 60.0 s, and the loudness it came out at.
    await input.onStep?.("checking");
    const probe = await ffprobeFacts(out);
    const counted = probe?.frames ?? parseEncodedFrames(log);
    if (counted !== total) throw new Error(`the finished ad has ${counted ?? "an unknown number of"} frames; the plan has ${total}`);
    if (probe && (probe.width !== AD_WIDTH || probe.height !== AD_HEIGHT)) throw new Error(`the finished ad is ${probe.width}×${probe.height}, not ${AD_WIDTH}×${AD_HEIGHT}`);
    const durationMs = Math.round((total * 1000) / rate.value);
    if (total / rate.value > (input.maxMs ?? MONTAGE_MAX_MS) / 1000 + 1e-9) throw new Error(`the finished ad runs ${(total / rate.value).toFixed(3)} s, over the ${(input.maxMs ?? MONTAGE_MAX_MS) / 1000} s limit`);
    const loud = await runFfmpeg(["-hide_banner", "-nostats", "-i", out, "-map", "0:a:0", "-af", "ebur128=peak=none", "-f", "null", "-"], { tolerateExit: true });

    await input.onStep?.("storing");
    const bytes = await readFile(out);
    const render_sha256 = createHash("sha256").update(bytes).digest("hex");
    await putStoredBytes(input.storedPath, bytes, "video/mp4");
    return {
      render_path: input.storedPath,
      render_sha256,
      duration_ms: durationMs,
      width: AD_WIDTH,
      height: AD_HEIGHT,
      bytes: bytes.length,
      frames: total,
      fps: rate.expr,
      lufs: parseIntegratedLoudness(loud),
      pieces: framed.map(({ start_frame: _f, ...p }) => p),
    };
  });
}
