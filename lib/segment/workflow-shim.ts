// The Workflow shim (narrated spec N0.2; amendment 6, 2026-09-23): the three
// picture checks of the skip-through route — sheet_read, frame_verify and
// cut_verify — run from Studio through lib/llm.ts instead of a Claude Code
// Workflow, and their prompts, lenses and schemas stay in drama-remix. The
// shim evaluates the film's SYNCED `<film>/scripts/<name>.workflow.js` under
// the exact signature `checks.py` compiles it with (skip-through
// checks.py:148-151: the leading `export ` dropped, the body an async
// function of `args, agent, pipeline, parallel, phase, log, budget,
// workflow`), so there is one source of truth and nothing is ported.
//
// What each hook does here:
//
//   agent(prompt, {label, schema})   one structured call on the frame judge's
//                     model (VISION_DEFAULT_MODELS, ADS_VISION_MODEL; `auto`
//                     tool choice so the model thinks first) with the
//                     workflow's OWN JSON schema, converted to zod once
//                     (jsonSchemaToZod) and validated on our side as every
//                     call is. The images the prompt names by path are
//                     attached (the caller maps each path to its attachments:
//                     the sheet, an API-sized copy, the 2x caption-band crop
//                     that stands in for the agents' Bash zoom). A prompt that
//                     names an image the caller did not map fails the call
//                     instead of sending a model a path it cannot open. Every
//                     call is one studio.jobs row through runJob (the caller
//                     names its kind and idempotency key), retried once on a
//                     transport failure; at most PICTURE_CALL_CONCURRENCY (2)
//                     calls run at once in the process (amendment 2). Like the
//                     Workflow tool, a call that fails resolves to null — the
//                     workflows' own `.filter(Boolean)` then drops it — and the
//                     shim lists it in `failed`, so the picture modules never
//                     record an item with a reader missing.
//   pipeline / parallel   the Workflow tool's semantics: every item through
//                     every stage with no barrier, a throwing stage drops its
//                     item to null; parallel is a barrier whose throwing thunk
//                     resolves to null.
//   phase / log       lines for the run's log (`onLog`).
//   budget            no token target: total null, remaining Infinity. The
//                     spend cap is the shim's own `max_usd`.
//   workflow          refused: none of the three nests a workflow.
//
// Nothing here writes into a film folder; the crop and the JPEG copies land
// in the caller's work directory (STUDIO_WORK_DIR/<run>).

import { createHash } from "node:crypto";
import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { z, type ZodTypeAny } from "zod";
import { systemSession, type Session } from "@/lib/auth";
import { ffmpegBin } from "@/lib/clips/cut";
import { runJob, type RunJobResult } from "@/lib/jobs";
import { LlmError, LlmUnavailableError, callStructured, costUsd, type Effort, type JsonSchema, type LlmImageMediaType, type LlmProvider, type StructuredCall, type TurnTrace } from "@/lib/llm";
import { runProcess } from "@/lib/python";
import { ANNOTATE_JPEG_OVER_BYTES, jpegArgs } from "@/lib/segment/annotate";
import { FILM_RUN_TARGET, isTransientLlmFailure, resolveJudgeModel, visionUnavailableReason, type LlmFn } from "@/lib/segment/vision";
import type { JobKind, Json } from "@/lib/types";

// ---- job kinds ------------------------------------------------------------------------------------

/** The studio.jobs kind of each picture check's calls: one row per API call. */
export const PICTURE_JOB_KINDS = {
  sheet_read: "sheet_read",
  frame_verify: "frame_verify",
  cut_verify: "cut_verify",
} as const satisfies Record<string, JobKind>;
export type PictureJobKind = (typeof PICTURE_JOB_KINDS)[keyof typeof PICTURE_JOB_KINDS];

/** The target_type of every row: the film run whose id is `target_id` (as the cut-only judge's rows). */
export const PICTURE_TARGET = FILM_RUN_TARGET;

/** At most this many picture-check calls in flight in the process (amendment 2: "at most 2 API picture-check calls concurrently"). */
export const PICTURE_CALL_CONCURRENCY = 2;

// ---- compile ---------------------------------------------------------------------------------------

/** The parameter names checks.py compiles a workflow with, in its order. */
export const WORKFLOW_SIGNATURE = ["args", "agent", "pipeline", "parallel", "phase", "log", "budget", "workflow"] as const;

export type WorkflowMeta = { name: string; description: string; phases: { title: string; detail?: string }[] };

export class WorkflowShimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowShimError";
  }
}

type WorkflowBody = (...hooks: unknown[]) => Promise<unknown>;

export type CompiledWorkflow = {
  file: string;
  sha256: string;
  meta: WorkflowMeta;
  /** `const READER_VERSION = '...'` when the script declares one (fv-2, cv-2), else null. */
  reader_version: string | null;
  body: WorkflowBody;
};

/** The body the runner (and checks.py) compiles: the source with its first `export ` removed. Pure. */
export function workflowBody(source: string): string {
  return source.replace(/^export /m, "");
}

/** The `export const meta = {...}` literal, evaluated alone (the Workflow tool requires it to be a pure literal). */
export function workflowMeta(source: string, file = "<workflow>"): WorkflowMeta {
  const at = source.search(/^export const meta = \{/m);
  if (at < 0) throw new WorkflowShimError(`${file}: no \`export const meta = {...}\``);
  const open = source.indexOf("{", at);
  let depth = 0;
  let quote: string | null = null;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new WorkflowShimError(`${file}: the meta literal never closes`);
  let meta: unknown;
  try {
    meta = new Function(`return (${source.slice(open, end + 1)});`)();
  } catch (e) {
    throw new WorkflowShimError(`${file}: the meta literal does not evaluate: ${(e as Error).message}`);
  }
  const m = meta as Partial<WorkflowMeta>;
  if (!m || typeof m.name !== "string") throw new WorkflowShimError(`${file}: meta has no name`);
  return { name: m.name, description: typeof m.description === "string" ? m.description : "", phases: Array.isArray(m.phases) ? m.phases : [] };
}

/** The script's READER_VERSION constant (frame_verify fv-2, cut_verify cv-2), read from the synced file itself. Pure. */
export function workflowReaderVersion(source: string): string | null {
  const m = source.match(/^const READER_VERSION = ['"]([^'"]+)['"]/m);
  return m ? m[1] : null;
}

/** Compile a workflow the way checks.py does; a syntax error is a WorkflowShimError naming the file. */
export function compileWorkflow(source: string, file = "<workflow>"): CompiledWorkflow {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => WorkflowBody;
  let body: WorkflowBody;
  try {
    body = new AsyncFunction(...WORKFLOW_SIGNATURE, workflowBody(source));
  } catch (e) {
    throw new WorkflowShimError(`${file} does not compile: ${(e as Error).message}`);
  }
  return { file, sha256: createHash("sha256").update(source, "utf8").digest("hex"), meta: workflowMeta(source, file), reader_version: workflowReaderVersion(source), body };
}

/** Read and compile a synced workflow file. */
export function loadWorkflow(file: string): CompiledWorkflow {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (e) {
    throw new WorkflowShimError(`${file}: not readable (${(e as Error).message}); sync the skip-through scripts into the film first`);
  }
  return compileWorkflow(source, file.replace(/\\/g, "/"));
}

// ---- the workflow's JSON schema as zod ---------------------------------------------------------------
//
// The workflows state their output as JSON Schema (the Workflow tool's
// StructuredOutput contract). lib/llm.ts takes zod and derives the tool's
// strict schema from it (zodToJsonSchema), so the conversion here covers
// exactly the keywords the three workflows use — object / properties /
// required, array / items, string (with enum), integer, number, boolean,
// description — and refuses anything else rather than guessing. A property
// the schema does not require is sent as nullable (strict output requires
// every key) and a null is dropped from the answer (`dropNulls`), so the
// workflow sees an absent key, as the Workflow tool would give it.

export function jsonSchemaToZod(schema: JsonSchema, at = "(root)"): ZodTypeAny {
  const s = schema as {
    type?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: unknown[];
    description?: string;
  };
  const desc = (t: ZodTypeAny) => (typeof s.description === "string" ? t.describe(s.description) : t);
  if (Array.isArray(s.enum)) {
    if (!s.enum.length || !s.enum.every((v): v is string => typeof v === "string")) throw new WorkflowShimError(`schema ${at}: only string enums are supported`);
    return desc(z.enum(s.enum as [string, ...string[]]));
  }
  switch (s.type) {
    case "object": {
      const props = s.properties ?? {};
      const required = new Set(s.required ?? []);
      for (const r of required) if (!(r in props)) throw new WorkflowShimError(`schema ${at}: required key ${r} has no property`);
      const shape: Record<string, ZodTypeAny> = {};
      for (const [k, v] of Object.entries(props)) {
        const inner = jsonSchemaToZod(v, `${at}.${k}`);
        shape[k] = required.has(k) ? inner : inner.nullable();
      }
      return desc(z.object(shape));
    }
    case "array":
      if (!s.items) throw new WorkflowShimError(`schema ${at}: an array needs items`);
      return desc(z.array(jsonSchemaToZod(s.items, `${at}[]`)));
    case "string":
      return desc(z.string());
    case "integer":
      return desc(z.number().int());
    case "number":
      return desc(z.number());
    case "boolean":
      return desc(z.boolean());
    default:
      throw new WorkflowShimError(`schema ${at}: type ${JSON.stringify(s.type)} is not supported by the shim`);
  }
}

/** Remove null-valued keys (the optional properties the model answered as null), recursively. Pure. */
export function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = dropNulls(x);
    return out;
  }
  return v;
}

// ---- images --------------------------------------------------------------------------------------------

/** One attachment of a call: the file sent and what the attachment note calls it. */
export type ShimImage = { path: string; media_type: LlmImageMediaType; note: string };

export type ImageSize = { width: number; height: number };

/** The pixel size of a PNG (IHDR) or JPEG (its SOF marker); null for anything else. */
export async function imageSize(file: string): Promise<ImageSize | null> {
  const buf = await fsp.readFile(file);
  if (buf.length >= 24 && buf.toString("latin1", 1, 4) === "PNG") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

export function mediaTypeOf(file: string): LlmImageMediaType {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  throw new WorkflowShimError(`${file}: not an image the API reads (png, jpg, webp, gif)`);
}

export type FfmpegRun = (args: string[]) => Promise<{ code: number | null; stderr: string; timedOut?: boolean }>;

/** ffmpeg at BelowNormal priority with the annotate step's patience (a busy machine starves it; lib/segment/annotate). */
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000;
export const ffmpegRun: FfmpegRun = async (args) => {
  const r = await runProcess(ffmpegBin(), args, { timeoutMs: FFMPEG_TIMEOUT_MS, priority: "below_normal" }).done;
  return { code: r.code, stderr: r.stderrTail, timedOut: r.timedOut };
};

async function runTwice(run: FfmpegRun, args: string[]): Promise<{ code: number | null; stderr: string; timedOut?: boolean }> {
  const first = await run(args);
  return first.code === 0 ? first : run(args);
}

const tailOf = (r: { stderr: string; timedOut?: boolean }) => (r.timedOut ? "timed out at BelowNormal priority" : r.stderr.trim().split(/\r?\n/).slice(-3).join(" | "));

/** A copy is fresh when it exists, is not empty and is newer than its source. */
async function fresh(copy: string, source: string): Promise<boolean> {
  const [c, s] = await Promise.all([fsp.stat(copy).catch(() => null), fsp.stat(source).catch(() => null)]);
  return !!c && !!s && c.size > 0 && c.mtimeMs >= s.mtimeMs;
}

/**
 * The file an image is SENT as: the file itself, or — over
 * ANNOTATE_JPEG_OVER_BYTES, which base64 would carry past the API's 5 MB
 * image limit (a minute sheet is 3.2-5 MB of PNG) — a JPEG copy at `-q:v 2`
 * in `outDir`, made once.
 */
export async function apiImageOf(file: string, outDir: string, deps: { run?: FfmpegRun; over_bytes?: number } = {}): Promise<{ path: string; media_type: LlmImageMediaType; reencoded: boolean }> {
  const over = deps.over_bytes ?? ANNOTATE_JPEG_OVER_BYTES;
  const bytes = (await fsp.stat(file)).size;
  if (bytes <= over) return { path: file, media_type: mediaTypeOf(file), reencoded: false };
  await fsp.mkdir(outDir, { recursive: true });
  const out = path.join(outDir, `${path.basename(file).replace(/\.[^.]+$/, "")}.api.jpg`);
  if (!(await fresh(out, file))) {
    const part = `${out}.part.jpg`;
    const r = await runTwice(deps.run ?? ffmpegRun, jpegArgs(file, part));
    if (r.code !== 0) throw new WorkflowShimError(`ffmpeg could not re-encode ${path.basename(file)} as JPEG (${bytes} bytes; twice): ${tailOf(r)}`);
    await fsp.rename(part, out);
  }
  return { path: out, media_type: "image/jpeg", reencoded: true };
}

// ---- the caption-band crop -------------------------------------------------------------------------------
//
// Nine readers in six frame runs cropped a sheet with PIL to read the
// burned-in subtitles (narrated spec N0.2). An API model cannot zoom, so
// Studio sends a second image beside each frame and join sheet: the bottom
// band of every tile, where the show's subtitles sit, enlarged 2x and laid
// out two bands per row in tile order. The tile grid comes from the
// pipeline's own layout (frame_claims.py: 4 columns of 480 px; cut_joins.py:
// 6 columns of 400 px) and the video's aspect, since a tile's height is
// `int(h * tile_w / w)` of the frame the pipeline grabbed.

/** The share of a tile's height the crop keeps, from the bottom: the subtitle line and some air. */
export const CAPTION_BAND = 0.25;
/** The enlargement. */
export const CAPTION_SCALE = 2;
/** Bands per row of the crop. */
export const CAPTION_COLS = 2;

export type TileGrid = { cols: number; rows: number; tile_w: number; tile_h: number };

/**
 * The tile grid of a contact sheet: `cols` columns across its width, tiles
 * as tall as `int(h * tile_w / w)` of the source frame (16:9 when the
 * video's size is unknown), rows as many as fit. Pure.
 */
export function tileGrid(sheet: ImageSize, cols: number, video: ImageSize | null): TileGrid {
  const tileW = Math.floor(sheet.width / cols);
  const aspect = video && video.width > 0 && video.height > 0 ? video.height / video.width : 9 / 16;
  const tileH = Math.max(1, Math.floor(tileW * aspect));
  return { cols, rows: Math.max(1, Math.round(sheet.height / tileH)), tile_w: tileW, tile_h: tileH };
}

/** The ffmpeg filter graph of the crop: split, one crop+scale per tile, pairs side by side, rows stacked. Pure; the tests pin it. */
export function captionCropFilter(grid: TileGrid, band = CAPTION_BAND, scale = CAPTION_SCALE, perRow = CAPTION_COLS): string {
  const n = grid.cols * grid.rows;
  const bh = Math.max(2, Math.round(grid.tile_h * band));
  const parts: string[] = [];
  const labels = Array.from({ length: n }, (_, i) => `s${i}`);
  parts.push(n === 1 ? `[0:v]null[s0]` : `[0:v]split=${n}${labels.map((l) => `[${l}]`).join("")}`);
  for (let i = 0; i < n; i++) {
    const x = (i % grid.cols) * grid.tile_w;
    const y = Math.floor(i / grid.cols) * grid.tile_h + grid.tile_h - bh;
    parts.push(`[s${i}]crop=${grid.tile_w}:${bh}:${x}:${y},scale=${grid.tile_w * scale}:${bh * scale}:flags=lanczos[b${i}]`);
  }
  const rows: string[] = [];
  for (let r = 0; r * perRow < n; r++) {
    const members = Array.from({ length: Math.min(perRow, n - r * perRow) }, (_, k) => `[b${r * perRow + k}]`);
    const label = `r${r}`;
    if (members.length === perRow && perRow > 1) parts.push(`${members.join("")}hstack=inputs=${perRow}[${label}]`);
    else parts.push(`${members.join("")}${members.length > 1 ? `hstack=inputs=${members.length},` : ""}pad=${grid.tile_w * scale * perRow}:${bh * scale}:0:0:black[${label}]`);
    rows.push(`[${label}]`);
  }
  parts.push(rows.length === 1 ? `${rows[0]}null[out]` : `${rows.join("")}vstack=inputs=${rows.length}[out]`);
  return parts.join(";");
}

/** `ffmpeg -i <sheet> -filter_complex <crop> -map [out] <out>` at JPEG `-q:v 2`. Pure. */
export function captionCropArgs(sheet: string, out: string, grid: TileGrid): string[] {
  return ["-hide_banner", "-y", "-v", "error", "-i", sheet, "-filter_complex", captionCropFilter(grid), "-map", "[out]", "-frames:v", "1", "-q:v", "2", out];
}

/** What the attachment note says of a crop. */
export const CAPTION_CROP_NOTE = `a ${CAPTION_SCALE}x enlargement of the bottom band of every tile of the sheet before it (where the burned-in subtitles sit), in tile order: left to right, then top to bottom, ${CAPTION_COLS} bands per row`;

/**
 * The crop for one sheet in `outDir` (`<sheet name>.captions2x.jpg`), made
 * once and remade when the sheet is newer. `video` is the frame size the
 * pipeline grabbed from (null: 16:9).
 */
export async function renderCaptionCrop(sheet: string, outDir: string, cols: number, video: ImageSize | null, deps: { run?: FfmpegRun } = {}): Promise<string> {
  await fsp.mkdir(outDir, { recursive: true });
  const out = path.join(outDir, `${path.basename(sheet).replace(/\.[^.]+$/, "")}.captions2x.jpg`);
  if (await fresh(out, sheet)) return out;
  const size = await imageSize(sheet);
  if (!size) throw new WorkflowShimError(`${sheet}: not a PNG or JPEG sheet`);
  const part = `${out}.part.jpg`;
  const r = await runTwice(deps.run ?? ffmpegRun, captionCropArgs(sheet, part, tileGrid(size, cols, video)));
  if (r.code !== 0) throw new WorkflowShimError(`ffmpeg could not crop the caption bands of ${path.basename(sheet)} (twice): ${tailOf(r)}`);
  await fsp.rename(part, out);
  return out;
}

// ---- the call gate -------------------------------------------------------------------------------------

type Gate = { active: number; queue: (() => void)[] };
const gg = globalThis as typeof globalThis & { __studioPictureGate?: Gate };
const gate = (): Gate => (gg.__studioPictureGate ??= { active: 0, queue: [] });

/** Hold one of the process's PICTURE_CALL_CONCURRENCY slots for `fn`; a released slot passes straight to the next waiter. */
export async function withPictureSlot<T>(fn: () => Promise<T>): Promise<T> {
  const g = gate();
  if (g.active < PICTURE_CALL_CONCURRENCY) g.active++;
  else await new Promise<void>((resolve) => g.queue.push(resolve));
  try {
    return await fn();
  } finally {
    const next = g.queue.shift();
    if (next) next();
    else g.active--;
  }
}

// ---- running a workflow -----------------------------------------------------------------------------------

/** One agent() call as the caller sees it before it is sent. */
export type WorkflowCall = {
  /** 1-based, in the order the workflow asked. */
  index: number;
  label: string;
  phase: string | null;
  /** The workflow's own words, verbatim. */
  prompt: string;
  schema: JsonSchema;
  images: ShimImage[];
  /** The model and provider the call goes to, and the workflow it belongs to (for the job's key). */
  provider: LlmProvider;
  model: string;
  workflow: { name: string; sha256: string; reader_version: string | null };
};

/** The job row a call is recorded as. */
export type ShimJob = { kind: JobKind; idempotency_key: string; target_id: string; target_type?: string; title_id?: string | null; input?: Json | null };

export type ShimCallStatus = "done" | "failed" | "cancelled" | "unavailable" | "capped";

export type ShimCallRecord = {
  index: number;
  label: string;
  status: ShimCallStatus;
  job_id: string | null;
  idempotency_key: string | null;
  /** A done row for the key already existed; nothing was paid now. */
  reused: boolean;
  cost_cents: number;
  cost_usd: number;
  output_tokens: number;
  trace: TurnTrace[];
  /** Retried once after a transport or non-JSON failure. */
  retried: boolean;
  error: string | null;
};

export type WorkflowShimOptions = {
  /** The synced workflow file (`<film>/scripts/frame_verify.workflow.js`). */
  file: string;
  /** The Workflow's `args`, verbatim (a JSON value). */
  args: unknown;
  /** Refuse a file whose meta.name is not this (a mis-synced or renamed script). */
  expect_name?: string;
  /**
   * Refuse a file whose bytes do not hash to this (the SHA-256 its sync recorded, `.studio-scripts.json`): the file is
   * compiled in this process, and a writing session can write the film's copy — so what is compiled is what was synced,
   * read once, not a copy checked a moment before.
   */
  expect_sha256?: string;
  /** The attachments standing for one path the prompt names, or null when the path is not the caller's (the call then fails). */
  images: (promptPath: string) => ShimImage[] | null;
  /** The image paths the args carry (the sheets), matched whole before the prompt is scanned for others. */
  image_paths?: readonly string[];
  /** The job row of a call (may read the attachments for a digest: callDigest). */
  job: (call: WorkflowCall) => ShimJob | Promise<ShimJob>;
  /** A semantic check on an answer (null = good); a message triggers the gateway's one repair turn. */
  check?: (call: WorkflowCall, data: unknown) => string | null;
  /** callStructured unless a fake is injected (tests, never a network). */
  llm?: LlmFn;
  session?: Session;
  env?: Record<string, string | undefined>;
  /** A vision model of the judge's family in place of its default (the eval's --model). */
  model?: string;
  /** The room for the answer; the gateway adds the thinking's on top. */
  max_tokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
  /** Stop making calls once the exact spend reaches this (USD); the calls in flight finish. */
  max_usd?: number | null;
  onLog?: (line: string) => void;
  onCall?: (record: ShimCallRecord) => void;
};

export type WorkflowRunResult = {
  workflow: { name: string; file: string; sha256: string; reader_version: string | null };
  /** What the workflow returned. */
  result: unknown;
  calls: ShimCallRecord[];
  /** The calls that did not end done, in order. */
  failed: ShimCallRecord[];
  /** Stages or thunks that threw (their item became null), in words. */
  stage_errors: string[];
  logs: string[];
  cost_cents: number;
  cost_usd: number;
  provider: LlmProvider;
  model: string;
};

export type WorkflowUnavailable = { unavailable: string };

export function isWorkflowUnavailable<T extends object>(r: T | WorkflowUnavailable): r is WorkflowUnavailable {
  return "unavailable" in r;
}

/** A call held back before it was sent (not a failure of the call). */
class ShimStop extends Error {
  readonly status: ShimCallStatus;
  constructor(status: ShimCallStatus, message: string) {
    super(message);
    this.name = "ShimStop";
    this.status = status;
  }
}

/** The system block of every call: the shim's framing; the instructions are the workflow's. */
export const SHIM_SYSTEM = "You are one reader in a video pipeline's picture check. Look at the attached images and answer exactly as the instructions ask. The image files the instructions name are attached to the message; there is no Read tool and no other tool but the answer's.";

/** The user turn: the attachment list, then the workflow's prompt unchanged. Pure. */
export function shimUserText(prompt: string, images: ShimImage[]): string {
  if (!images.length) return prompt;
  const list = images.map((im, i) => `  image ${i + 1}: ${im.note}`).join("\n");
  return `[Studio runs this reader through the API. The files the text below names are attached to this message instead of being opened with the Read tool, in this order:\n${list}]\n\n${prompt}`;
}

/** Image paths a prompt names (absolute Windows or POSIX paths ending in an image extension), in order of first mention. Pure. */
export function imagePathsIn(prompt: string): string[] {
  const seen: string[] = [];
  for (const m of prompt.matchAll(/(?:[A-Za-z]:)?[\\/][^\s"'<>|*?`]+?\.(?:png|jpe?g|webp|gif)(?![\w.])/gi)) if (!seen.includes(m[0])) seen.push(m[0]);
  return seen;
}

/**
 * The images of a call: each path the prompt names, mapped by the caller, in
 * order of first mention; an unmapped path is refused. `known` are the paths
 * the caller put in the args (the sheets): they are found by plain search
 * first, so a path with a space in it (a Windows profile folder) is matched
 * whole, and only the rest of the prompt is scanned for other image paths.
 */
export function resolveImages(prompt: string, map: (p: string) => ShimImage[] | null, known: readonly string[] = []): ShimImage[] {
  const found: { at: number; path: string }[] = [];
  let rest = prompt;
  for (const k of [...new Set(known)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const at = prompt.indexOf(k);
    if (at < 0) continue;
    found.push({ at, path: k });
    rest = rest.split(k).join(" ".repeat(k.length));
  }
  for (const p of imagePathsIn(rest)) found.push({ at: rest.indexOf(p), path: p });
  const out: ShimImage[] = [];
  for (const { path: p } of found.sort((a, b) => a.at - b.at)) {
    const got = map(p);
    if (!got) throw new WorkflowShimError(`the prompt names ${p}, which this pass has no image for`);
    out.push(...got);
  }
  return out;
}

/** The exact price of a reused row from the usage it kept (cache writes folded into its input). */
function rowUsd(job: Pick<RunJobResult<unknown>["job"], "model" | "usage">): number {
  const u = job.usage;
  if (!u || !job.model) return 0;
  return costUsd(job.model, { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_tokens: u.cache_read_tokens ?? 0, cache_write_tokens: 0 });
}

const describe = (e: unknown) => (e instanceof LlmError ? `${e.name} (${e.code}): ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** The account-level refusals of the API: no call of the pass can succeed until a person tops up or fixes the key. */
const ACCOUNT_REFUSAL = /credit balance|too low to access|billing|purchase credits|payment required|insufficient (?:balance|funds|quota)/i;

/**
 * Why no call of a pass can succeed, when the provider refused on the
 * account rather than on this call: a missing key, a key refused (401,
 * 403), a payment refusal (402), or the 400 an Anthropic account out of
 * credit answers ("Your credit balance is too low to access the Anthropic
 * API", the eval of 2026-09-23, which exited 0 with 0 of 5 joins judged).
 * The pass stops as it does on a missing key — the calls already queued are
 * not sent — and hands off with the reason. Null for anything else. Pure.
 */
export function accountRefusal(e: unknown): string | null {
  if (e instanceof LlmUnavailableError) return e.message;
  if (!(e instanceof LlmError) || e.code !== "api") return null;
  if (e.status === 401 || e.status === 403) return `the provider refused the key (${e.status}): ${e.message.slice(0, 300)} — check the key in .env.local, then Retry`;
  if (e.status === 402 || (e.status === 400 && ACCOUNT_REFUSAL.test(e.message))) return `the provider account cannot pay for calls: ${e.message.slice(0, 300)} — top up the account's credit, then Retry`;
  return null;
}

/** A short digest of what a call sends: the prompt and each attachment's bytes. Part of every idempotency key, so a changed sheet, premise or prompt is never answered from an old row. */
export async function callDigest(call: Pick<WorkflowCall, "prompt" | "images">): Promise<string> {
  const h = createHash("sha256").update(call.prompt, "utf8");
  for (const im of call.images) h.update("\0").update(await fsp.readFile(im.path));
  return h.digest("hex").slice(0, 12);
}

/**
 * Run one synced workflow through the API. `{unavailable}` before any call
 * when no vision provider can run (or demo replay is on), and when the
 * provider answers mid-run that it cannot (the calls after it are not made).
 * A workflow that throws is a WorkflowShimError; a call that fails is a null
 * the workflow filters, listed in `failed`.
 */
export async function runWorkflow(opts: WorkflowShimOptions): Promise<WorkflowRunResult | WorkflowUnavailable> {
  const env = opts.env ?? process.env;
  const unavailable = visionUnavailableReason(env);
  if (unavailable) return { unavailable };
  const resolved = resolveJudgeModel(env, opts.model);
  if ("unavailable" in resolved) return resolved;
  const { provider, model } = resolved;
  const compiled = loadWorkflow(opts.file);
  if (opts.expect_sha256 && compiled.sha256 !== opts.expect_sha256) {
    throw new WorkflowShimError(`${compiled.file} is not the file Studio synced (SHA-256 ${compiled.sha256.slice(0, 12)}, the sync recorded ${opts.expect_sha256.slice(0, 12)}): nothing is compiled from a changed copy`);
  }
  if (opts.expect_name && compiled.meta.name !== opts.expect_name) {
    throw new WorkflowShimError(`${compiled.file} is the ${compiled.meta.name} workflow, not ${opts.expect_name}`);
  }
  const llm = opts.llm ?? (callStructured as LlmFn);
  const session = opts.session ?? systemSession();
  const toolName = `record_${compiled.meta.name.replace(/[^A-Za-z0-9]+/g, "_")}`;
  const calls: ShimCallRecord[] = [];
  const stageErrors: string[] = [];
  const logs: string[] = [];
  let n = 0;
  let spentUsd = 0;
  let currentPhase: string | null = null;
  let unavailableHit: string | null = null;
  const say = (line: string) => {
    logs.push(line);
    opts.onLog?.(line);
  };

  /** Hold a call back, before it is sent, when the run was cancelled, the provider answered that it cannot run, or the cap is spent. */
  const stopIfDue = () => {
    if (opts.signal?.aborted) throw new ShimStop("cancelled", "cancelled");
    if (unavailableHit) throw new ShimStop("unavailable", unavailableHit);
    if (opts.max_usd != null && spentUsd >= opts.max_usd) throw new ShimStop("capped", `the spend cap of $${opts.max_usd} was reached ($${spentUsd.toFixed(3)} spent)`);
  };

  const agent = async (prompt: unknown, agentOpts?: { label?: string; phase?: string; schema?: JsonSchema }): Promise<unknown> => {
    const index = ++n;
    const label = agentOpts?.label ?? `agent-${index}`;
    const record: ShimCallRecord = { index, label, status: "failed", job_id: null, idempotency_key: null, reused: false, cost_cents: 0, cost_usd: 0, output_tokens: 0, trace: [], retried: false, error: null };
    calls.push(record);
    const finish = (status: ShimCallStatus, error: string | null = null) => {
      record.status = status;
      record.error = error;
      opts.onCall?.(record);
    };
    try {
      if (typeof prompt !== "string") throw new WorkflowShimError("agent() needs a prompt string");
      if (!agentOpts?.schema) throw new WorkflowShimError(`agent(${label}) has no schema; the shim runs structured readers only`);
      const images = resolveImages(prompt, opts.images, opts.image_paths);
      stopIfDue();
      const call: WorkflowCall = { index, label, phase: agentOpts.phase ?? currentPhase, prompt, schema: agentOpts.schema, images, provider, model, workflow: { name: compiled.meta.name, sha256: compiled.sha256, reader_version: compiled.reader_version } };
      const job = await opts.job(call);
      record.idempotency_key = job.idempotency_key;
      const schema = jsonSchemaToZod(agentOpts.schema);
      const structured: StructuredCall<unknown> = {
        name: toolName,
        description: compiled.meta.description || undefined,
        system: SHIM_SYSTEM,
        user: shimUserText(prompt, images),
        images: images.map(({ path: p, media_type }) => ({ path: p, media_type })),
        schema,
        provider,
        model,
        maxTokens: opts.max_tokens ?? 8000,
        effort: opts.effort ?? "medium",
        toolChoice: "auto",
        check: opts.check ? (data) => opts.check!(call, dropNulls(data)) : undefined,
      };
      const once = async (): Promise<unknown> => {
        let trace: TurnTrace[] = [];
        let usd: number | undefined;
        try {
          const r = await runJob<unknown>(session, {
            kind: job.kind,
            title_id: job.title_id ?? null,
            target_type: job.target_type ?? PICTURE_TARGET,
            target_id: job.target_id,
            idempotency_key: job.idempotency_key,
            provider,
            model,
            input: job.input ?? null,
            run: async () => {
              const c = await llm(structured);
              trace = c.trace ?? [];
              usd = costUsd(c.model, c.usage);
              return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model, provider: c.provider };
            },
          });
          record.job_id = r.job.id;
          record.reused = r.skipped;
          record.cost_cents += r.job.cost_cents ?? 0;
          const paid = r.skipped || usd === undefined ? rowUsd(r.job) : usd;
          record.cost_usd += paid;
          spentUsd += r.skipped ? 0 : paid;
          record.output_tokens = r.job.usage?.output_tokens ?? 0;
          record.trace = trace;
          return r.output;
        } catch (e) {
          if (e instanceof LlmError) {
            if (e.job_id) record.job_id = e.job_id;
            record.cost_cents += e.cost_cents ?? 0;
            const lost = e.usage ? costUsd(model, e.usage) : 0;
            record.cost_usd += lost;
            spentUsd += lost;
            record.output_tokens = e.usage?.output_tokens ?? 0;
          }
          record.trace = trace;
          throw e;
        }
      };
      const answer = await withPictureSlot(async () => {
        // Checked again once the slot is ours: every call of a pass is queued at once, so a stop that
        // came while this one waited (a cancel, a provider that cannot run, the cap) must still hold it back.
        stopIfDue();
        try {
          try {
            return await once();
          } catch (e) {
            if (!isTransientLlmFailure(e) || opts.signal?.aborted) throw e;
            record.retried = true;
            say(`retry ${label}: ${describe(e)}`);
            return await once();
          }
        } catch (e) {
          // Marked before the slot passes on, so the next queued call already sees the stop (a missing or refused key,
          // an account out of credit: no queued call could succeed).
          const account = accountRefusal(e);
          if (account && !unavailableHit) unavailableHit = account;
          throw e;
        }
      });
      finish("done");
      return dropNulls(answer);
    } catch (e) {
      if (e instanceof ShimStop) {
        finish(e.status, e.message);
        return null;
      }
      const account = accountRefusal(e);
      if (account && !unavailableHit) unavailableHit = account;
      finish(account ? "unavailable" : "failed", describe(e));
      say(`FAILED ${label}: ${describe(e)}`);
      return null;
    }
  };

  const pipeline = async (items: unknown, ...stages: ((prev: unknown, item: unknown, index: number) => unknown)[]): Promise<unknown[]> => {
    if (!Array.isArray(items)) throw new WorkflowShimError("pipeline() needs an array of items");
    return Promise.all(
      items.map(async (item, i) => {
        let value: unknown = item;
        try {
          for (const stage of stages) value = await stage(value, item, i);
          return value;
        } catch (e) {
          stageErrors.push(`pipeline item ${i}: ${describe(e)}`);
          return null;
        }
      })
    );
  };

  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) throw new WorkflowShimError("parallel() needs an array of functions");
    return Promise.all(
      thunks.map((t, i) =>
        Promise.resolve()
          .then(() => (t as () => unknown)())
          .catch((e) => {
            stageErrors.push(`parallel thunk ${i}: ${describe(e)}`);
            return null;
          })
      )
    );
  };

  const phase = (title: unknown) => {
    currentPhase = String(title);
    say(`phase ${currentPhase}`);
  };
  const log = (message: unknown) => say(String(message));
  const budget = { total: null, spent: () => 0, remaining: () => Infinity };
  const workflow = async () => {
    throw new WorkflowShimError("workflow() is not available in the Studio shim");
  };

  // The args the workflow sees are a JSON copy: nothing it does reaches the caller's objects.
  const args = JSON.parse(JSON.stringify(opts.args ?? null));
  let result: unknown;
  try {
    result = await compiled.body(args, agent, pipeline, parallel, phase, log, budget, workflow);
  } catch (e) {
    throw new WorkflowShimError(`${compiled.file} threw: ${describe(e)}`);
  }
  if (unavailableHit) return { unavailable: unavailableHit };
  return {
    workflow: { name: compiled.meta.name, file: compiled.file, sha256: compiled.sha256, reader_version: compiled.reader_version },
    result,
    calls,
    failed: calls.filter((c) => c.status !== "done"),
    stage_errors: stageErrors,
    logs,
    cost_cents: calls.reduce((s, c) => s + c.cost_cents, 0),
    cost_usd: calls.reduce((s, c) => s + c.cost_usd, 0),
    provider,
    model,
  };
}

/** The reader version Studio stamps on an API verdict: the workflow's own (fv-2, cv-2) plus the model (narrated spec N0.2). Pure. */
export function apiReaderVersion(workflowVersion: string, model: string): string {
  return `${workflowVersion}+api:${model}`;
}
