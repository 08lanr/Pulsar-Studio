// What the pipeline's `pick_cuts.py --emit-options` and `boundary_frames.py`
// leave in a film's `cut/review/`, read as they really are (He Hated All
// Women, 2026-09-23): the options document, the option strips (a grid of
// frames 0.5 s apart, 6 per row, the cut at the centre tile) with their JSON
// sidecars, and the checks `boundary_frames.py --verify` makes before any
// vision pass. Nothing here judges anything and nothing here writes into the
// film folder: a dense 10 fps strip for the skeptic is rendered by the
// pipeline's own script into a folder the caller names (STUDIO_WORK_DIR).
//
// The pipeline is run by its own interpreter, never an assumed global one:
// `STUDIO_PIPELINE_PYTHON` (default `python`, the system Python 3.12 the
// cut-only README requires) and `DRAMA_REMIX_ROOT` (default the sibling
// checkout `../Pulsar-Workspace/mini-drama-system/drama-remix`).

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseCandidates, pickNewestDelivered } from "@/lib/film-import/manifest";
import type { CandidatesIndex, CutCandidate } from "@/lib/film-import/types";
import type { LlmImage } from "@/lib/llm";
import { dramaRemixRoot, pipelinePython } from "@/lib/python";

/** An environment-shaped record, so the selectors can be tested without touching process.env. */
type Env = Record<string, string | undefined>;

// ---- the strip layout the prompts describe ----------------------------------------------------

/** `boundary_frames.py --options` defaults; the vision prompt tells its reviewers exactly this grid. */
export const STRIP_COLS = 6;
export const STRIP_STEP_S = 0.5;
export const STRIP_WINDOW_S = 5;
export const STRIP_WIDTH_PX = 200;

/** The skeptic's dense strip (plan B2, stage 4 v2): `--at t --window 3 --step 0.1 --cols 10`. */
export const DENSE_WINDOW_S = 3;
export const DENSE_STEP_S = 0.1;
export const DENSE_COLS = 10;

/** A strip smaller than this is empty (`--verify`'s own threshold). */
export const MIN_STRIP_BYTES = 1000;

/** A pipeline refusal Studio reproduces: the message is shown verbatim, never routed around. */
export class SegmentError extends Error {
  readonly code: "strips" | "options" | "python";
  readonly faults: string[];
  constructor(code: SegmentError["code"], message: string, faults: string[] = []) {
    super(message);
    this.name = "SegmentError";
    this.code = code;
    this.faults = faults;
  }
}

// ---- review/options.json ------------------------------------------------------------------------

const LineSchema = z.object({ t: z.number(), text: z.string() }).passthrough();

export const OptionSchema = z
  .object({
    key: z.string().min(1),
    t: z.number(),
    in_action: z.boolean().nullish(),
    since_action: z.number().nullish(),
    until_action: z.number().nullish(),
    line_before: z.string().nullish(),
    line_after: z.string().nullish(),
    is_dp_pick: z.boolean().nullish(),
    /** Written by `boundary_frames.py --options`; relative to the film's `cut/`, forward slashes. */
    strip: z.string().nullish(),
    strip_tiles: z.array(z.number()).nullish(),
  })
  .passthrough();

export const OptionsBoundarySchema = z
  .object({
    boundary_s: z.number(),
    dp_pick: z.number().nullish(),
    before: z.array(LineSchema).default([]),
    after: z.array(LineSchema).default([]),
    options: z.array(OptionSchema).min(1),
  })
  .passthrough()
  .superRefine((b, ctx) => {
    const keys = new Set<string>();
    for (const [i, o] of b.options.entries()) {
      if (keys.has(o.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options", i, "key"], message: `option key ${o.key} repeats at boundary ${b.boundary_s}` });
      keys.add(o.key);
    }
  });

export const OptionsDocSchema = z
  .object({
    duration: z.number().positive(),
    band: z.tuple([z.number(), z.number()]),
    strips_stale: z.boolean().nullish(),
    strip: z.object({ window: z.number(), step: z.number(), cols: z.number().int() }).passthrough().nullish(),
    applied: z.object({ label: z.string().nullish(), on: z.string().nullish(), audit: z.string().nullish() }).passthrough().nullish(),
    boundaries: z.array(OptionsBoundarySchema),
  })
  .passthrough();

export type StripOption = z.infer<typeof OptionSchema>;
export type OptionsBoundary = z.infer<typeof OptionsBoundarySchema>;
export type OptionsDoc = z.infer<typeof OptionsDocSchema>;
export type StripLayout = { window: number; step: number; cols: number };

export function parseOptionsDoc(json: unknown): OptionsDoc {
  return OptionsDocSchema.parse(json);
}

/** `<cut>/review/options.json`, parsed. */
export async function loadOptionsDoc(cutDir: string): Promise<OptionsDoc> {
  const file = path.join(cutDir, "review", "options.json");
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (e) {
    throw new SegmentError("options", `${file}: ${(e as Error).message}`);
  }
  try {
    return parseOptionsDoc(JSON.parse(raw));
  } catch (e) {
    throw new SegmentError("options", `review/options.json is not an options document: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** The layout the strips were rendered in (the doc's `strip`, else the pipeline defaults). */
export function stripLayoutOf(doc: Pick<OptionsDoc, "strip">): StripLayout {
  return { window: doc.strip?.window ?? STRIP_WINDOW_S, step: doc.strip?.step ?? STRIP_STEP_S, cols: doc.strip?.cols ?? STRIP_COLS };
}

/** The boundary entry for `boundary_s` (3 ms tolerance: the pipeline rounds to 3 decimals). */
export function findBoundary(doc: Pick<OptionsDoc, "boundaries">, boundaryS: number): OptionsBoundary | null {
  return doc.boundaries.find((b) => Math.abs(b.boundary_s - boundaryS) <= 0.0015) ?? null;
}

/**
 * What identifies THIS option set for an idempotency key: the boundaries,
 * their option keys and times and the strip layout. Not the whole file: the
 * `applied` stamp and the dialogue windows may change without the options
 * changing, and a re-emit that moves one option time must invalidate.
 */
export function optionsSha(doc: OptionsDoc): string {
  const canonical = {
    duration: doc.duration,
    band: doc.band,
    strip: stripLayoutOf(doc),
    boundaries: doc.boundaries.map((b) => ({ boundary_s: b.boundary_s, options: b.options.map((o) => ({ key: o.key, t: o.t, strip: o.strip ?? null })) })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ---- strips and their sidecars --------------------------------------------------------------------

export const StripSidecarSchema = z
  .object({
    source: z.string().nullish(),
    from: z.number(),
    to: z.number(),
    step: z.number(),
    cols: z.number().int(),
    rows: z.number().int().nullish(),
    tiles_in_reading_order: z.array(z.number()).min(1),
  })
  .passthrough();

export type StripSidecar = z.infer<typeof StripSidecarSchema>;

/** One strip image the prompts attach: where it is, which option it shows and the time of every tile. */
export type StripImage = {
  key: string;
  /** The option time (the centre tile). */
  t: number;
  /** Absolute path of the PNG. */
  path: string;
  /** The path as the options file wrote it (relative to `cut/`), for the record and the job input. */
  rel: string;
  media_type: "image/png";
  /** Tile times in reading order (left to right, then top to bottom). */
  tiles: number[];
  cols: number;
  step: number;
};

export function sidecarPathOf(pngPath: string): string {
  return pngPath.replace(/\.png$/i, "") + ".json";
}

/** The `.json` sidecar `boundary_frames.py` writes beside a strip; null when there is none. */
export async function readStripSidecar(pngPath: string): Promise<StripSidecar | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(sidecarPathOf(pngPath), "utf8");
  } catch {
    return null;
  }
  const parsed = StripSidecarSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

/** Absolute path of an option's strip (the options file keeps them relative to `cut/`). */
export function stripPath(cutDir: string, rel: string): string {
  return path.isAbsolute(rel) ? rel : path.resolve(cutDir, rel);
}

/** The strip of one option as an image the prompts can attach; refuses a missing or empty strip. */
export async function optionStrip(cutDir: string, option: StripOption, layout: StripLayout): Promise<StripImage> {
  if (!option.strip) throw new SegmentError("strips", `${option.t}s: no strip path - run boundary_frames.py --options first`);
  const abs = stripPath(cutDir, option.strip);
  let st: fs.Stats;
  try {
    st = await fsp.stat(abs);
  } catch {
    throw new SegmentError("strips", `${option.t}s: no strip on disk (${option.strip})`);
  }
  if (st.size < MIN_STRIP_BYTES) throw new SegmentError("strips", `${option.t}s: strip is empty (${option.strip})`);
  const side = await readStripSidecar(abs);
  const tiles = side?.tiles_in_reading_order ?? option.strip_tiles ?? [];
  if (!tiles.length) throw new SegmentError("strips", `${option.t}s: strip has no tile times (no sidecar and no strip_tiles)`);
  return {
    key: option.key,
    t: option.t,
    path: abs,
    rel: option.strip,
    media_type: "image/png",
    tiles,
    cols: side?.cols ?? layout.cols,
    step: side?.step ?? layout.step,
  };
}

/** The images of every option of a boundary, in option order. */
export async function boundaryStrips(cutDir: string, boundary: OptionsBoundary, layout: StripLayout): Promise<StripImage[]> {
  const out: StripImage[] = [];
  for (const o of boundary.options) out.push(await optionStrip(cutDir, o, layout));
  return out;
}

export function asLlmImage(s: StripImage): LlmImage {
  return { media_type: s.media_type, path: s.path };
}

// ---- boundary_frames.py --verify, reproduced ------------------------------------------------------

export type VerifyOptionsResult = {
  ok: boolean;
  faults: string[];
  n_options: number;
  /** The boundary list the vision pass takes, as `--verify` prints it. */
  boundaries: number[];
};

export type VerifyOptionsOpts = {
  /** The calibration run re-judges an APPLIED options file on purpose (scripts/segment-eval.ts); a real run never does. */
  allowApplied?: boolean;
  /** With `allowApplied`: the delivered-pins check is skipped too (every boundary of a delivered film lies inside its cuts). */
  allowDelivered?: boolean;
};

const DeliveredEndsSchema = z.object({ episodes: z.array(z.object({ end: z.number() }).passthrough()).min(1), final_end_is_boundary: z.boolean().nullish() }).passthrough();

/**
 * The checks `boundary_frames.py --verify` makes before ANY vision pass, so a
 * Studio run refuses exactly what a session's run refuses: an options file
 * already applied, stale strips, a layout the prompt does not describe, a
 * boundary inside delivered cuts, a strip missing, empty, mis-centred or
 * older than `index/candidates.json`. A pass once launched with no strips and
 * judged blind; this is what stops that.
 */
export async function verifyOptions(cutDir: string, doc: OptionsDoc, opts: VerifyOptionsOpts = {}): Promise<VerifyOptionsResult> {
  const faults: string[] = [];
  if (doc.applied && !opts.allowApplied) {
    faults.push(`already applied (${doc.applied.label ?? "?"} on ${doc.applied.on ?? "?"}) - these boundaries are decided; emit fresh options for the new stretch`);
  }
  if (doc.strips_stale !== false) faults.push("strips_stale is not false - run boundary_frames.py --options first");
  const lay = doc.strip;
  if (lay && (lay.cols !== STRIP_COLS || Math.abs(lay.step - STRIP_STEP_S) > 1e-9)) {
    faults.push(`strips are ${lay.cols} per row at ${lay.step} s; the vision pass assumes ${STRIP_COLS} per row at ${STRIP_STEP_S} s - re-run --options with the defaults`);
  }

  if (!(opts.allowApplied && opts.allowDelivered)) {
    const review = path.join(cutDir, "review");
    let names: string[] = [];
    try {
      names = await fsp.readdir(review);
    } catch {
      names = [];
    }
    const newest = pickNewestDelivered(names);
    if (newest) {
      try {
        const plan = DeliveredEndsSchema.parse(JSON.parse(await fsp.readFile(path.join(review, newest.file), "utf8")));
        const eps = plan.episodes;
        const pinned = plan.final_end_is_boundary ? eps : eps.slice(0, -1);
        const lastPin = Math.max(0, ...pinned.map((e) => e.end));
        const inside = doc.boundaries.map((b) => b.boundary_s).filter((b) => b <= lastPin + 0.05);
        if (inside.length) {
          faults.push(`${inside.length} boundaries lie inside delivered cuts (${newest.file}, pinned to ${lastPin}s): ${JSON.stringify(inside.slice(0, 6))} - re-emit with --pin-from review/${newest.file}`);
        }
      } catch (e) {
        faults.push(`review/${newest.file}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }

  let candidatesMtime: number | null = null;
  try {
    candidatesMtime = (await fsp.stat(path.join(cutDir, "index", "candidates.json"))).mtimeMs;
  } catch {
    candidatesMtime = null;
  }
  for (const b of doc.boundaries) {
    for (const o of b.options) {
      if (!o.strip) {
        faults.push(`${o.t}s: no strip on disk`);
        continue;
      }
      const abs = stripPath(cutDir, o.strip);
      let st: fs.Stats;
      try {
        st = await fsp.stat(abs);
      } catch {
        faults.push(`${o.t}s: no strip on disk`);
        continue;
      }
      if (st.size < MIN_STRIP_BYTES) faults.push(`${o.t}s: strip is empty`);
      const tiles = o.strip_tiles ?? [];
      if (!tiles.length || Math.abs(tiles[Math.floor(tiles.length / 2)] - o.t) > 0.01) faults.push(`${o.t}s: centre tile is not the option time`);
      if (candidatesMtime !== null && st.mtimeMs < candidatesMtime) faults.push(`${o.t}s: strip is older than index/candidates.json`);
    }
  }
  const n = doc.boundaries.reduce((s, b) => s + b.options.length, 0);
  return { ok: faults.length === 0, faults, n_options: n, boundaries: doc.boundaries.map((b) => b.boundary_s) };
}

// ---- index/candidates.json: the legal cuts the skeptic may name ------------------------------------

/** `<cut>/index/candidates.json`, parsed; null when the film has no index yet. */
export async function loadCandidates(cutDir: string): Promise<CandidatesIndex | null> {
  try {
    return parseCandidates(JSON.parse(await fsp.readFile(path.join(cutDir, "index", "candidates.json"), "utf8")));
  } catch {
    return null;
  }
}

/** The legal cuts within `windowS` of `t`, nearest-first is not wanted: in time order, as a reviewer reads them. */
export function legalCutsNear(candidates: CandidatesIndex | null, t: number, windowS = 30): CutCandidate[] {
  if (!candidates) return [];
  return candidates.candidates.filter((c) => Math.abs(c.t - t) <= windowS).sort((a, b) => a.t - b.t);
}

/** True when `t` is one of `times` (3 ms tolerance: the pipeline rounds to 3 decimals). */
export function isListedTime(t: number, times: number[]): boolean {
  return times.some((x) => Math.abs(x - t) <= 0.0015);
}

// ---- the dense strip for the skeptic --------------------------------------------------------------

export type DenseStripRequest = {
  /** The source film, absolute (`<film>/source/original.mp4`). */
  src: string;
  /** The centre time: the reviewer's chosen cut. */
  at: number;
  /** The PNG to write, absolute, under STUDIO_WORK_DIR - never under the film folder. */
  out: string;
  width?: number;
};

export type DenseStripArgs = {
  /** Arguments after the interpreter: `[boundary_frames.py, --src, ...]`. */
  args: string[];
  png: string;
  sidecar: string;
  /** The tile times the script will write, in reading order (`--at` minus half the window, every 0.1 s). */
  tiles: number[];
  cols: number;
  step: number;
};

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The tiles `boundary_frames.py` renders for a window: `t0 .. t1` inclusive, every `step`. */
export function stripTiles(at: number, windowS: number, step: number): number[] {
  const n = Math.round(windowS / step);
  return Array.from({ length: n + 1 }, (_, i) => round3(at - windowS / 2 + i * step));
}

/**
 * The exact `boundary_frames.py` call for a 10 fps strip around one time
 * (plan B2, stage 4 v2). Pure: the runner spawns it, the result's `png` and
 * `sidecar` are where the script writes.
 */
export function denseStripArgs(req: DenseStripRequest, env: Env = process.env): DenseStripArgs {
  const png = req.out.toLowerCase().endsWith(".png") ? req.out : `${req.out}.png`;
  return {
    args: [
      boundaryFramesScript(env),
      "--src",
      req.src,
      "--at",
      String(req.at),
      "--window",
      String(DENSE_WINDOW_S),
      "--step",
      String(DENSE_STEP_S),
      "--cols",
      String(DENSE_COLS),
      "--width",
      String(req.width ?? STRIP_WIDTH_PX),
      "--out",
      png,
    ],
    png,
    sidecar: sidecarPathOf(png),
    tiles: stripTiles(req.at, DENSE_WINDOW_S, DENSE_STEP_S),
    cols: DENSE_COLS,
    step: DENSE_STEP_S,
  };
}

// The interpreter and the drama-remix checkout are lib/python.ts's (the one runner every pipeline script goes through); re-exported so the eval CLI and the tests keep their import.
export { dramaRemixRoot, pipelinePython };

export function boundaryFramesScript(env: Env = process.env): string {
  return path.join(dramaRemixRoot(env), "scripts", "cut-only", "boundary_frames.py");
}

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ code: number | null; stderr: string }>;

const spawnCollect: SpawnFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += String(d);
    });
    p.on("error", (e) => reject(new SegmentError("python", `could not run ${cmd}: ${e.message}`)));
    p.on("close", (code) => resolve({ code, stderr }));
  });

/**
 * Render the skeptic's dense strip with the pipeline's own script into
 * `outDir` (STUDIO_WORK_DIR; never the film folder) and read it back through
 * its sidecar. The script's `.frames` scratch lands beside the PNG.
 */
export async function renderDenseStrip(
  req: { src: string; at: number; outDir: string; name?: string },
  deps: { env?: Env; spawn?: SpawnFn } = {}
): Promise<StripImage> {
  const env = deps.env ?? process.env;
  const run = deps.spawn ?? spawnCollect;
  await fsp.mkdir(req.outDir, { recursive: true });
  const name = req.name ?? `dense_${String(req.at).replace(/\./g, "_")}.png`;
  const plan = denseStripArgs({ src: req.src, at: req.at, out: path.join(req.outDir, name) }, env);
  const r = await run(pipelinePython(env), plan.args, { cwd: req.outDir, env: { ...process.env, ...env, PYTHONIOENCODING: "utf-8" } });
  if (r.code !== 0) throw new SegmentError("python", `boundary_frames.py exited ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  const side = await readStripSidecar(plan.png);
  return {
    key: "dense",
    t: req.at,
    path: plan.png,
    rel: path.basename(plan.png),
    media_type: "image/png",
    tiles: side?.tiles_in_reading_order ?? plan.tiles,
    cols: side?.cols ?? plan.cols,
    step: side?.step ?? plan.step,
  };
}
