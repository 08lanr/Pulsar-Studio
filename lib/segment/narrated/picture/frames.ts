// The frame check through the API (narrated spec N1 E5, N0.2): every
// narration line of an episode against the frames that play under it, by
// the synced `frame_verify.workflow.js` (fv-2: a claims lens and an identity
// lens per line) run through the Workflow shim, recorded ONLY by
// `frame_claims.py record`.
//
//   1. `frame_claims.py status --ep epN` writes `review/frame_pending.json`,
//      the items in exactly the shape the workflow's args take
//      ({key, ep, id, text, sheet}); Studio reads them, it never rebuilds them.
//   2. Each item's sheet is attached with its 2x caption-band crop (the API
//      model cannot zoom; the crop lands in the run's work folder). The
//      premise is the project's `frame_premise.txt`, as the Workflow call gets it.
//   3. The shim runs the workflow: two calls per line, one studio.jobs row
//      each (kind frame_verify, key fv:<run>:<ep>:<id>:<text_hash>:<lens>:<reader_version>:<digest>).
//   4. A line whose readers did not all answer is NOT recorded (the Workflow
//      would record it with one reader, or with none and no claims, which
//      the gate would then read as checked); it stays pending for a retry.
//      Every recorded item carries `reader_version: "fv-2+api:<model>"`;
//      `text` is the workflow's own copy of the prepared text, unchanged.
//   5. `review/frame_verdicts_studio-<run>-<k>.json`, then
//      `frame_claims.py record`, then `status` again.
//
// The engine (runLensPass) is shared with the join check (./joins).

import { existsSync, promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import type { Session } from "@/lib/auth";
import { probeSourceSize } from "@/lib/clips/cut";
import type { Effort, LlmProvider } from "@/lib/llm";
import { visionUnavailableReason, type LlmFn } from "@/lib/segment/vision";
import {
  CAPTION_CROP_NOTE,
  PICTURE_JOB_KINDS,
  apiImageOf,
  apiReaderVersion,
  callDigest,
  isWorkflowUnavailable,
  renderCaptionCrop,
  runWorkflow,
  type FfmpegRun,
  type ImageSize,
  type PictureJobKind,
  type ShimCallRecord,
  type ShimImage,
  type WorkflowCall,
  type WorkflowUnavailable,
} from "@/lib/segment/workflow-shim";
import type { Json } from "@/lib/types";
import { filmRelative, frameClaimsStatus, recordCutVerdicts, recordFrameVerdicts, writeVerdictFile, type PictureRecorder, type RecorderOptions, type ScriptOutcome, type StatusOutcome } from "./recorders";

/** frame_claims.py lays its tiles 4 to a row, each 480 px wide (`cols = 4`, `cv2.resize(fr, (480, ...))`). */
export const FRAME_SHEET_COLS = 4;

export class PicturePassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PicturePassError";
  }
}

/** An item as the pipeline's pending file holds it: the workflow's args item. */
export type PendingItem = { key: string; ep: string; id: string; sheet: string } & Record<string, unknown>;

/** One item of the workflow's return: what the recorders read. */
export type ReaderResult = { key: string; ep: string; id: string; reader_version: string; readers: unknown[] } & Record<string, unknown>;

export type PassDeps = {
  llm?: LlmFn;
  session?: Session;
  env?: Record<string, string | undefined>;
  /** A vision model of the judge's family in place of its default. */
  model?: string;
  effort?: Effort;
  signal?: AbortSignal;
  max_usd?: number | null;
  onLog?: (line: string) => void;
  onCall?: (record: ShimCallRecord) => void;
  /** ffmpeg for the crop and the JPEG copies (tests inject it). */
  ffmpeg?: FfmpegRun;
  /** The video's frame size for the crop's tile grid; probed from the film when absent (null: 16:9). */
  video_size?: ImageSize | null;
  /** No caption crop (A/B arm of the eval); on by default. */
  no_crop?: boolean;
  python?: string;
};

export type LensPassSpec = {
  film: string;
  ep: string;
  run_id: string;
  /** The run's work folder (STUDIO_WORK_DIR/<run>): crops and copies. */
  work_dir: string;
  workflow_file: string;
  workflow_name: string;
  recorder: PictureRecorder;
  kind: PictureJobKind;
  /** The key's leading tag (fv, cv) and the per-item part of the key after the ep (id and hash / fingerprint). */
  key_tag: string;
  item_key_part: (item: PendingItem) => string;
  premise: string;
  items: PendingItem[];
  /** Tile columns of the item sheets, for the crop. */
  sheet_cols: number;
  /** The video the sheets were grabbed from, for the crop's grid; null when unknown. */
  video_file: string | null;
  max_tokens: number;
  deps: PassDeps;
  /** Record through the pipeline (default); off, the verdict file is written and nothing recorded. */
  record: boolean;
  scripts_dir?: string;
};

export type LensPassResult = {
  ep: string;
  /** The items sent. */
  items: number;
  /** The items whose every reader answered, recorded (or written when `record` is off). */
  complete: string[];
  /** The items left pending: a reader failed, or the workflow dropped the item. */
  incomplete: { key: string; error: string }[];
  verdicts_file: string | null;
  recorded: ScriptOutcome | null;
  calls: ShimCallRecord[];
  cost_cents: number;
  cost_usd: number;
  provider: LlmProvider;
  model: string;
  reader_version: string | null;
  workflow_sha256: string;
};

/** The item key a call's label names: the workflows label every reader `<lens>:<item key>`. Pure. */
export function labelParts(label: string): { lens: string; key: string } | null {
  const at = label.indexOf(":");
  return at > 0 ? { lens: label.slice(0, at), key: label.slice(at + 1) } : null;
}

/** A pending file's items, refusing anything that is not the workflow's item shape. */
export function readPendingItems(file: string): PendingItem[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new PicturePassError(`${file}: not a list of items`);
  return raw.map((it, i) => {
    const o = it as Partial<PendingItem>;
    if (!o || typeof o.key !== "string" || typeof o.ep !== "string" || typeof o.id !== "string" || typeof o.sheet !== "string") throw new PicturePassError(`${file}: item ${i} lacks key, ep, id or sheet`);
    return o as PendingItem;
  });
}

/** The project's premise file, refused when missing or empty (the readers must know who is who). */
export function readPremise(file: string): string {
  const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!text) throw new PicturePassError(`${file} is missing or empty: the readers need the story premise and the cast`);
  return text;
}

async function probeOnce(video: string | null, deps: PassDeps): Promise<ImageSize | null> {
  if (deps.video_size !== undefined) return deps.video_size;
  if (!video || !existsSync(video)) return null;
  return probeSourceSize(video).catch(() => null);
}

/**
 * Run a two-lens reader workflow over pending items, record the complete
 * ones through the pipeline. `{unavailable}` when no vision provider can run.
 */
export async function runLensPass(spec: LensPassSpec): Promise<LensPassResult | WorkflowUnavailable> {
  // No provider, no crops: the shim would refuse before any call anyway.
  const unavailable = visionUnavailableReason(spec.deps.env ?? process.env);
  if (unavailable) return { unavailable };
  const byKey = new Map(spec.items.map((it) => [it.key, it]));
  const video = spec.deps.no_crop ? null : await probeOnce(spec.video_file, spec.deps);
  const cropDir = path.join(spec.work_dir, "picture", spec.ep, spec.recorder === "frame_claims" ? "frames" : "joins");

  // Attachments per sheet path: the sheet (an API-sized copy when too big) and its caption crop. Made before the pass.
  const attachments = new Map<string, ShimImage[]>();
  for (const it of spec.items) {
    if (attachments.has(it.sheet)) continue;
    if (!existsSync(it.sheet)) throw new PicturePassError(`${it.key}: its sheet ${it.sheet} is missing; run prepare again`);
    const sent = await apiImageOf(it.sheet, cropDir, { run: spec.deps.ffmpeg });
    const list: ShimImage[] = [{ path: sent.path, media_type: sent.media_type, note: `${it.sheet}${sent.reencoded ? " (sent as a JPEG copy)" : ""}` }];
    if (!spec.deps.no_crop) {
      const crop = await renderCaptionCrop(it.sheet, cropDir, spec.sheet_cols, video, { run: spec.deps.ffmpeg });
      list.push({ path: crop, media_type: "image/jpeg", note: CAPTION_CROP_NOTE });
    }
    attachments.set(it.sheet, list);
  }

  const job = async (call: WorkflowCall) => {
    const parts = labelParts(call.label);
    const item = parts ? byKey.get(parts.key) : undefined;
    const lens = parts?.lens ?? `call${call.index}`;
    const readerVersion = apiReaderVersion(call.workflow.reader_version ?? call.workflow.name, call.model);
    const digest = await callDigest(call);
    const itemPart = item ? spec.item_key_part(item) : `unmatched:${call.label}`;
    return {
      kind: spec.kind,
      target_id: spec.run_id,
      idempotency_key: `${spec.key_tag}:${spec.run_id}:${spec.ep}:${itemPart}:${lens}:${readerVersion}:${digest}`,
      input: {
        workflow: call.workflow.name,
        workflow_sha: call.workflow.sha256.slice(0, 12),
        ep: spec.ep,
        key: parts?.key ?? null,
        id: item?.id ?? null,
        lens,
        reader_version: readerVersion,
        sheet: item ? item.sheet : null,
        images: call.images.map((i) => path.basename(i.path)),
        digest,
      } satisfies Json,
    };
  };

  const r = await runWorkflow({
    file: spec.workflow_file,
    expect_name: spec.workflow_name,
    args: { premise: spec.premise, items: spec.items },
    images: (p) => attachments.get(p) ?? null,
    image_paths: [...attachments.keys()],
    job,
    llm: spec.deps.llm,
    session: spec.deps.session,
    env: spec.deps.env,
    model: spec.deps.model,
    effort: spec.deps.effort,
    max_tokens: spec.max_tokens,
    signal: spec.deps.signal,
    max_usd: spec.deps.max_usd,
    onLog: spec.deps.onLog,
    onCall: spec.deps.onCall,
  });
  if (isWorkflowUnavailable(r)) return r;

  // Which items every reader answered: all of an item's calls done, and as many readers returned as calls made.
  const callsByKey = new Map<string, ShimCallRecord[]>();
  for (const c of r.calls) {
    const k = labelParts(c.label)?.key;
    if (k) callsByKey.set(k, [...(callsByKey.get(k) ?? []), c]);
  }
  const returned = new Map<string, ReaderResult>();
  for (const x of Array.isArray(r.result) ? (r.result as ReaderResult[]) : []) if (x && typeof x.key === "string") returned.set(x.key, x);
  const complete: ReaderResult[] = [];
  const incomplete: LensPassResult["incomplete"] = [];
  for (const it of spec.items) {
    const calls = callsByKey.get(it.key) ?? [];
    const got = returned.get(it.key);
    const bad = calls.filter((c) => c.status !== "done");
    if (bad.length) incomplete.push({ key: it.key, error: bad.map((c) => `${c.label}: ${c.error ?? c.status}`).join("; ") });
    else if (!got || !calls.length) incomplete.push({ key: it.key, error: `the workflow returned no result for it${r.stage_errors.length ? ` (${r.stage_errors.join("; ")})` : ""}` });
    else if (!Array.isArray(got.readers) || got.readers.length !== calls.length) incomplete.push({ key: it.key, error: `${got.readers?.length ?? 0} of ${calls.length} readers returned` });
    else complete.push({ ...got, reader_version: apiReaderVersion(got.reader_version, r.model) });
  }

  let verdictsFile: string | null = null;
  let recorded: ScriptOutcome | null = null;
  if (complete.length) {
    verdictsFile = await writeVerdictFile(spec.film, spec.ep, spec.recorder, spec.run_id, complete);
    if (spec.record) {
      const recOpts: RecorderOptions & { ep: string; verdicts: string } = { film: spec.film, ep: spec.ep, verdicts: verdictsFile, scripts_dir: spec.scripts_dir, python: spec.deps.python, signal: spec.deps.signal };
      recorded = spec.recorder === "frame_claims" ? await recordFrameVerdicts(recOpts) : await recordCutVerdicts(recOpts);
      spec.deps.onLog?.(`${filmRelative(spec.film, verdictsFile)}: ${recorded.code === 0 ? recorded.lines.filter(Boolean).slice(-1)[0] ?? "recorded" : `REFUSED ${recorded.refusal}`}`);
    }
  }
  return {
    ep: spec.ep,
    items: spec.items.length,
    complete: complete.map((c) => c.key),
    incomplete,
    verdicts_file: verdictsFile,
    recorded,
    calls: r.calls,
    cost_cents: r.cost_cents,
    cost_usd: r.cost_usd,
    provider: r.provider,
    model: r.model,
    reader_version: r.workflow.reader_version ? apiReaderVersion(r.workflow.reader_version, r.model) : null,
    workflow_sha256: r.workflow.sha256,
  };
}

// ---- the frame pass ------------------------------------------------------------------------------------

export type FrameClaimsLine = { id: string; text: string; text_hash: string; src_span?: [number | null, number | null]; sheet: string };

/** `<ep>/review/frame_claims.json`'s lines by id (prepare's record: the text hash the key carries). */
export function readFrameClaims(film: string, ep: string): Map<string, FrameClaimsLine> {
  const file = path.join(film, ep, "review", "frame_claims.json");
  if (!existsSync(file)) return new Map();
  const doc = JSON.parse(readFileSync(file, "utf8")) as { lines?: FrameClaimsLine[] };
  return new Map((doc.lines ?? []).map((l) => [l.id, l]));
}

export type Contradiction = { id: string; claim: string; evidence: string; reader: number | null };

/** The contradicted claims `frame_check.json` holds for these ids (what `status` blocks on, before waivers). */
export async function contradictionsOf(film: string, ep: string, ids: string[]): Promise<Contradiction[]> {
  const file = path.join(film, ep, "review", "frame_check.json");
  const have = JSON.parse(await fsp.readFile(file, "utf8").catch(() => "{}")) as Record<string, { claims?: { claim?: string; verdict?: string; evidence?: string; reader?: number }[] }>;
  const out: Contradiction[] = [];
  for (const id of ids) {
    for (const c of have[id]?.claims ?? []) {
      if (c.verdict === "contradicted") out.push({ id, claim: c.claim ?? "", evidence: c.evidence ?? "", reader: typeof c.reader === "number" ? c.reader : null });
    }
  }
  return out;
}

export type FramePassOptions = PassDeps & {
  /** The film root (a skip-through project folder). */
  film: string;
  /** The episode folder name (`ep9`). */
  ep: string;
  run_id: string;
  work_dir: string;
  /** Default `<film>/frame_premise.txt`'s text. */
  premise?: string;
  /** Default: `status` then `<ep>/review/frame_pending.json`. */
  items?: PendingItem[];
  /** Run `frame_claims.py status` before (to write the pending list) and after (the outcome); default true. */
  status?: boolean;
  /** Record through frame_claims.py record (default true). */
  record?: boolean;
  /** The synced scripts (`<film>/scripts`). */
  scripts_dir?: string;
  /** The synced workflow (`<scripts>/frame_verify.workflow.js`). */
  workflow_file?: string;
};

export type FramePassResult = LensPassResult & {
  status_before: StatusOutcome | null;
  status_after: StatusOutcome | null;
  /** Contradicted claims among the lines this pass recorded. */
  contradicted: Contradiction[];
};

/** The answer room of one frame reader: the people and a few claims with evidence. */
export const FRAME_MAX_TOKENS = 6000;

export async function runFramePass(opts: FramePassOptions): Promise<FramePassResult | WorkflowUnavailable> {
  const scripts = opts.scripts_dir ?? path.join(opts.film, "scripts");
  const doStatus = opts.status !== false;
  const statusOpts = { film: opts.film, ep: opts.ep, scripts_dir: scripts, python: opts.python, signal: opts.signal };
  const before = doStatus ? await frameClaimsStatus(statusOpts) : null;
  if (before && before.code !== 0 && before.code !== 1) throw new PicturePassError(`frame_claims.py status --ep ${opts.ep} failed: ${before.refusal}`);
  const items = opts.items ?? readPendingItems(path.join(opts.film, opts.ep, "review", "frame_pending.json"));
  const claims = readFrameClaims(opts.film, opts.ep);
  const empty = { ep: opts.ep, items: 0, complete: [], incomplete: [], verdicts_file: null, recorded: null, calls: [], cost_cents: 0, cost_usd: 0, status_before: before, status_after: before, contradicted: [] };
  if (!items.length) return { ...empty, provider: "anthropic", model: "", reader_version: null, workflow_sha256: "" };
  const premise = opts.premise ?? readPremise(path.join(opts.film, "frame_premise.txt"));
  const r = await runLensPass({
    film: opts.film,
    ep: opts.ep,
    run_id: opts.run_id,
    work_dir: opts.work_dir,
    workflow_file: opts.workflow_file ?? path.join(scripts, "frame_verify.workflow.js"),
    workflow_name: "frame-verify",
    recorder: "frame_claims",
    kind: PICTURE_JOB_KINDS.frame_verify,
    key_tag: "fv",
    item_key_part: (it) => `${it.id}:${claims.get(it.id)?.text_hash ?? "nohash"}`,
    premise,
    items,
    sheet_cols: FRAME_SHEET_COLS,
    video_file: path.join(opts.film, opts.ep, "base.mp4"),
    max_tokens: FRAME_MAX_TOKENS,
    deps: opts,
    record: opts.record !== false,
    scripts_dir: scripts,
  });
  if (isWorkflowUnavailable(r)) return r;
  const after = doStatus ? await frameClaimsStatus(statusOpts) : null;
  const recordedIds = r.recorded?.code === 0 ? items.filter((it) => r.complete.includes(it.key)).map((it) => it.id) : [];
  return { ...r, status_before: before, status_after: after, contradicted: await contradictionsOf(opts.film, opts.ep, recordedIds) };
}
