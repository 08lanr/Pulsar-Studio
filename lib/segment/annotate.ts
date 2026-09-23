// Annotated strips (decision 2026-09-23, "The frame judge, second pass").
// The diagnosis of the first calibration found the model binding tiles to
// the wrong times and strips to the wrong options: after-cut tiles described
// as the ending, ends_on and opens_on swapped, another option's content
// described. The pipeline's PNG is a bare grid; this burns the facts onto a
// COPY of it with ffmpeg (drawtext, drawbox, pad) so every tile says what it
// is: a header naming the option and the cut time, the time on every tile,
// END on the tiles before the cut and NEXT from the cut tile on, and a red
// frame on the cut tile. The copy lands under STUDIO_WORK_DIR, never in the
// film folder, and the pipeline's own boundary_frames.py is not changed
// (that repo is read-only from Studio). SEGMENT_STRIP_ANNOTATE=off sends
// the raw PNGs instead (the fallback the eval can compare against).
//
// The geometry is boundary_frames.py's `tile=<cols>x<rows>:margin=4:padding=4`
// read back from the PNG's own size, so a strip rendered at another width
// still labels the right tiles.

import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { ffmpegBin } from "@/lib/clips/cut";
import { runProcess } from "@/lib/python";
import { SegmentError, cutIndexOf, type StripImage } from "./strips";

type Env = Record<string, string | undefined>;

/** boundary_frames.py's tile filter: `margin=4:padding=4`. */
export const TILE_MARGIN_PX = 4;
export const TILE_PADDING_PX = 4;
/** The black band added above the grid for the header line. */
export const HEADER_PX = 36;
export const FONT_PX = 20;

export type PngSize = { width: number; height: number };

/** The width and height from a PNG's IHDR chunk (bytes 16-24, big-endian); refuses anything that is not a PNG. */
export async function pngSize(file: string): Promise<PngSize> {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(24);
    const { bytesRead } = await fh.read(buf, 0, 24, 0);
    if (bytesRead < 24 || buf.toString("latin1", 1, 4) !== "PNG") throw new SegmentError("strips", `${file}: not a PNG`);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    await fh.close();
  }
}

/** Where a tile sits in the grid, in the PADDED image (the header is above the grid). */
export type TileBox = { index: number; x: number; y: number; w: number; h: number };

/** The tile boxes of a strip from the PNG size and the layout: `tile=<cols>x<rows>:margin=4:padding=4`, rows = ceil(n / cols). */
export function tileBoxes(size: PngSize, n: number, cols: number, header = HEADER_PX): TileBox[] {
  const rows = Math.max(1, Math.ceil(n / cols));
  const w = (size.width - 2 * TILE_MARGIN_PX - (cols - 1) * TILE_PADDING_PX) / cols;
  const h = (size.height - 2 * TILE_MARGIN_PX - (rows - 1) * TILE_PADDING_PX) / rows;
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    x: TILE_MARGIN_PX + (i % cols) * (w + TILE_PADDING_PX),
    y: header + TILE_MARGIN_PX + Math.floor(i / cols) * (h + TILE_PADDING_PX),
    w,
    h,
  }));
}

/** The font drawtext uses: STUDIO_ANNOTATE_FONT, else Windows' Arial when it is there, else fontconfig's default (no fontfile). */
export function annotateFont(env: Env = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  const configured = env.STUDIO_ANNOTATE_FONT?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    for (const candidate of ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/consola.ttf"]) if (exists(candidate)) return candidate;
  }
  for (const candidate of ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Helvetica.ttc"]) if (exists(candidate)) return candidate;
  return null;
}

/** A value inside a filtergraph option: quoted, with the quote and backslash escaped (drawtext reads the quoted text literally). */
export function filterQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A file path for `fontfile=`: forward slashes, the drive colon escaped for the option parser (`C\:/…`), quoted. */
export function fontfileArg(font: string): string {
  return `fontfile='${font.replace(/\\/g, "/").replace(/'/g, "").replace(/:/g, "\\:")}'`;
}

export type AnnotateSpec = {
  /** The tile times in reading order. */
  tiles: number[];
  cols: number;
  /** The tile the cut falls on (0-based); the tiles before it are END, this one and after are NEXT. */
  cut_index: number;
  /** The header's first words: the option key, or `dense`. */
  label: string;
  /** The cut time the header names. */
  cut_t: number;
  size: PngSize;
  font: string | null;
};

const fmt = (t: number) => String(Math.round(t * 1000) / 1000);

/**
 * The ffmpeg video filter that annotates one strip: pad a header band above
 * the grid, the header line, the time and END/NEXT label on every tile, the
 * red frame on the cut tile. Pure; the tests pin it.
 */
export function annotateFilter(spec: AnnotateSpec): string {
  const font = spec.font ? `${fontfileArg(spec.font)}:` : "";
  const boxes = tileBoxes(spec.size, spec.tiles.length, spec.cols);
  const parts: string[] = [`pad=iw:ih+${HEADER_PX}:0:${HEADER_PX}:color=black`];
  const header = `${spec.label}   cut at ${fmt(spec.cut_t)} s   |   tiles before the red frame = END of this episode   |   red frame and after = START of the next episode`;
  parts.push(`drawtext=${font}text=${filterQuote(header)}:x=8:y=8:fontsize=${FONT_PX}:fontcolor=white`);
  for (const b of boxes) {
    const t = spec.tiles[b.index];
    const time = `drawtext=${font}text=${filterQuote(fmt(t))}:x=${b.x + 6}:y=${b.y + 6}:fontsize=${FONT_PX}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`;
    const isNext = b.index >= spec.cut_index;
    const tag = `drawtext=${font}text=${filterQuote(isNext ? "NEXT" : "END")}:x=${b.x + b.w - 6}-text_w:y=${b.y + 6}:fontsize=${FONT_PX}:fontcolor=black:box=1:boxcolor=${isNext ? "0xffa040" : "0x5fd35f"}@0.9:boxborderw=4`;
    parts.push(time, tag);
  }
  const cut = boxes[spec.cut_index];
  if (cut) parts.push(`drawbox=x=${cut.x}:y=${cut.y}:w=${cut.w}:h=${cut.h}:color=red@1:t=6`);
  return parts.join(",");
}

/** The ffmpeg call for one strip: `-i <png> -vf <filter> <out>`. Pure. */
export function annotateArgs(src: string, out: string, spec: AnnotateSpec): string[] {
  return ["-hide_banner", "-y", "-v", "error", "-i", src, "-vf", annotateFilter(spec), "-frames:v", "1", out];
}

/** The cut tile of a strip: the tile at `cutT`, else the centre tile (lib/segment/strips; the prompts' reading block uses the same rule for the dense strip). */
export { cutIndexOf };

/**
 * A copy over this size is re-encoded as JPEG: the Anthropic API refuses an
 * image over 5 MB, and an annotated dense strip's PNG reaches 3.05 MB, 4.07 MB
 * once base64-encoded, so a busier frame could cross the line and 400 the
 * skeptic's or the tie-break's call.
 */
export const ANNOTATE_JPEG_OVER_BYTES = 3_500_000;

/** The ffmpeg call that re-encodes a PNG copy as JPEG at `-q:v 2` (about quality 90). Pure. */
export function jpegArgs(src: string, out: string): string[] {
  return ["-hide_banner", "-y", "-v", "error", "-i", src, "-q:v", "2", "-frames:v", "1", out];
}

export type AnnotateDeps = {
  env?: Env;
  /** Runs ffmpeg; injected by the tests. Resolves with the exit code. */
  run?: (args: string[]) => Promise<{ code: number | null; stderr: string }>;
  /** The PNG size above which the copy is re-encoded as JPEG (ANNOTATE_JPEG_OVER_BYTES); the tests lower it. */
  jpeg_over_bytes?: number;
};

const ffmpegRun = async (args: string[]) => {
  const r = await runProcess(ffmpegBin(), args, { timeoutMs: 2 * 60 * 1000, priority: "below_normal" }).done;
  return { code: r.code, stderr: r.stderrTail };
};

/** True when SEGMENT_STRIP_ANNOTATE is not `off`: annotated copies are the default. */
export function annotateEnabled(env: Env = process.env): boolean {
  return (env.SEGMENT_STRIP_ANNOTATE ?? "").trim().toLowerCase() !== "off";
}

const stderrTail = (s: string) => s.trim().split(/\r?\n/).slice(-3).join(" | ");

/**
 * The annotated copy of one strip in `outDir` (made once; remade when the
 * source PNG is newer), as a StripImage whose `path` is the copy and whose
 * `rel` still names the pipeline's file. `cutT` says which tile is the cut
 * (the option time for an option strip, the centre of a dense strip). A copy
 * over ANNOTATE_JPEG_OVER_BYTES is re-encoded as JPEG, and `media_type` says
 * which the copy is.
 */
export async function annotateStrip(strip: StripImage, cutT: number, outDir: string, deps: AnnotateDeps = {}): Promise<StripImage> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? ffmpegRun;
  const jpegOver = deps.jpeg_over_bytes ?? ANNOTATE_JPEG_OVER_BYTES;
  await fsp.mkdir(outDir, { recursive: true });
  const base = path.basename(strip.path).replace(/\.png$/i, "");
  const outPng = path.join(outDir, `${base}.annotated.png`);
  const outJpg = path.join(outDir, `${base}.annotated.jpg`);
  // The copy already on disk, JPEG or PNG, when it is newer than the source.
  const sourceMtime = await fsp.stat(strip.path).then((s) => s.mtimeMs).catch(() => null);
  if (sourceMtime !== null) {
    for (const [out, media_type] of [[outJpg, "image/jpeg"], [outPng, "image/png"]] as const) {
      const copy = await fsp.stat(out).catch(() => null);
      if (copy && copy.size > 0 && copy.mtimeMs >= sourceMtime) return { ...strip, path: out, media_type, annotated: true };
    }
  }
  const size = await pngSize(strip.path);
  const spec: AnnotateSpec = { tiles: strip.tiles, cols: strip.cols, cut_index: cutIndexOf(strip.tiles, cutT), label: strip.key, cut_t: cutT, size, font: annotateFont(env) };
  const part = `${outPng}.part.png`;
  const r = await run(annotateArgs(strip.path, part, spec));
  if (r.code !== 0) throw new SegmentError("python", `ffmpeg could not annotate ${path.basename(strip.path)}: ${stderrTail(r.stderr)}`);
  const bytes = (await fsp.stat(part)).size;
  if (bytes > jpegOver) {
    const partJpg = `${outJpg}.part.jpg`;
    const j = await run(jpegArgs(part, partJpg));
    if (j.code !== 0) throw new SegmentError("python", `ffmpeg could not re-encode ${path.basename(strip.path)} as JPEG (${bytes} bytes, over ${jpegOver}): ${stderrTail(j.stderr)}`);
    await fsp.rm(part, { force: true });
    await fsp.rm(outPng, { force: true });
    await fsp.rename(partJpg, outJpg);
    return { ...strip, path: outJpg, media_type: "image/jpeg", annotated: true };
  }
  await fsp.rm(outJpg, { force: true });
  await fsp.rename(part, outPng);
  return { ...strip, path: outPng, media_type: "image/png", annotated: true };
}
