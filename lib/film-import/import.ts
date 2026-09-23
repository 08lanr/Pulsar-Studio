// The import job (decision 2026-09-22, "the workspace import"; spec §3.6): a
// READY film under WORKSPACE_ROOT becomes a title with one video-only episode
// per delivered window, its pipeline transcript attached as the episode's
// script, and the pipeline's index files recorded as film assets. It is a
// `studio.jobs` row of kind `import_film` (cost 0, one running per film,
// heartbeat after every episode) that runs as the SYSTEM actor — the caller's
// role is checked by the route, the caller's user id is what the adaptation
// records as its creator — and it never calls scheduleClipCut: an imported
// episode is born with auto_cut false and the ad engine cuts it.
//
// The one rule that keeps a running render safe, enforced here and in
// lib/data/storage.ts: nothing opens `cut/eps/epNN.mp4` at its own path.
// Each episode is HARDLINKED into the local media tier first, the link is
// hashed (streamed) and probed (ffprobe), and the link is what the episode
// row points at. Holding the original open would make the pipeline's
// os.replace fail and crash cut_episodes.py.
//
// Two entry points: `startImport` does the checks that can refuse (the film
// is READY, the title exists or does not, no import is already running),
// records the job row, creates the title when the mode is import, and hands
// the long part to the background; `importFilm` awaits the whole thing (the
// tests and a script). The running import's progress lives in a process-wide
// registry the listing route reads (`listFilms`), the way the ffmpeg gate
// lives on globalThis, so the page's progress line can poll it.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, promises as fsp, renameSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { cuesToVtt, restoreMachineLines, transcriptToCues, type AsrSegment, type AsrWord } from "@/lib/asr";
import { systemSession, type Session } from "@/lib/auth";
import { DataError, getData, isDataError, type NewJob } from "@/lib/data";
import { normalizeSourceRef } from "@/lib/data/film-import";
import { linkIntoLocalTier, localPathOf, localStoredPath, mediaUrl, putStoredBytes, uploadImport, workspaceRoot } from "@/lib/data/storage";
import { ingestEpisodeFile } from "@/lib/ingest";
import type { AdRules, Episode, FilmAsset, FilmAssetKind, Job, JobKind, Json, Title } from "@/lib/types";
import { POSTER_FILE, listBandFixFiles, loadFilmIndex, sha256Hex } from "./manifest";
import { applyImportState, nodeScanFs, scanFilm, scanWorkspace, workspacePath, type ProbeFn, type ScanOptions } from "./scan";
import type { BoundaryNote, DeliveredEpisode, FilmIndex, FilmScan, FilmScanState, ScanReason, WhisperIndex } from "./types";

export const IMPORT_JOB_KIND: Extract<JobKind, "import_film"> = "import_film";

/** The version of the import record written beside the film (a Studio-made `delivered_plan` asset). */
export const IMPORT_RECORD_VERSION = 1;

const log = (m: string) => console.log(`[film-import] ${m}`);

// ---- configuration --------------------------------------------------------------------------------

/**
 * The scanner's quiet period: STUDIO_IMPORT_QUIET_MS when set (0 switches the
 * rule off — the e2e server reads a fixture workspace whose files git just
 * wrote), else the scanner's default of five minutes.
 */
export function importQuietMs(): number | undefined {
  const raw = process.env.STUDIO_IMPORT_QUIET_MS?.trim();
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Scratch for the scanner's probe links: STUDIO_WORK_DIR, else the OS temp dir. */
export function importWorkDir(): string {
  const configured = process.env.STUDIO_WORK_DIR?.trim();
  return configured ? path.resolve(process.cwd(), configured) : path.join(tmpdir(), "studio-work");
}

/** The ffprobe binary: FFPROBE_PATH, else the one beside FFMPEG_PATH, else the one on PATH. */
export function ffprobeBin(): string {
  const explicit = process.env.FFPROBE_PATH?.trim();
  if (explicit) return explicit;
  const ffmpeg = process.env.FFMPEG_PATH?.trim();
  if (ffmpeg && /ffmpeg(\.exe)?$/i.test(ffmpeg)) return ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  return "ffprobe";
}

// ---- ffprobe --------------------------------------------------------------------------------------

export type VideoFacts = { width: number; height: number; fps: number; frames: number | null; duration_s: number | null };

/** What the import asks of a video file: pixel size, frame rate and the frame count. Always called on a LINK. */
export type VideoProbe = (linkPath: string) => Promise<VideoFacts | null>;

const PROBE_TIMEOUT_MS = 2 * 60 * 1000;

function parseRate(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] ? Number(m[2]) : 1;
  if (!den || !Number.isFinite(num / den) || num / den <= 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/** Parses ffprobe's `-of json` answer; exported for the tests. */
export function parseProbeJson(text: string): VideoFacts | null {
  let parsed: { streams?: Record<string, unknown>[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const s = parsed.streams?.[0];
  if (!s) return null;
  const width = Number(s.width);
  const height = Number(s.height);
  const fps = parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate);
  if (!width || !height || !fps) return null;
  const packets = Number(s.nb_read_packets);
  const declared = Number(s.nb_frames);
  const frames = Number.isInteger(packets) && packets > 0 ? packets : Number.isInteger(declared) && declared > 0 ? declared : null;
  const duration = Number(s.duration);
  return { width, height, fps, frames, duration_s: Number.isFinite(duration) && duration > 0 ? duration : null };
}

/**
 * ffprobe on a linked file: `-count_packets` counts one packet per access
 * unit without decoding, which is the frame count for the pipeline's H.264
 * MP4s and takes a fraction of a second per episode. Null when ffprobe is
 * missing or the file has no video stream; the import proceeds and flags it.
 */
export const ffprobeFacts: VideoProbe = (file) =>
  new Promise((resolve) => {
    const args = ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_read_packets,nb_frames,duration", "-of", "json", file];
    let out = "";
    const p = spawn(ffprobeBin(), args);
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", () => undefined);
    const timer = setTimeout(() => {
      p.kill();
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? parseProbeJson(out) : null);
    });
  });

/** The scanner's probe (pixel size when index/source.json is missing), on the same ffprobe. */
export const scannerProbe: ProbeFn = async (link) => {
  const f = await ffprobeFacts(link);
  return f ? { width: f.width, height: f.height, fps: f.fps, duration_s: f.duration_s } : null;
};

// ---- pure pieces ------------------------------------------------------------------------------------

/** SHA-256 of a file, streamed (the link, never the original). */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The frames the plan expects of an episode: the pipeline cuts on frame boundaries, `round(t * fps)` at each end. */
export function plannedFrames(ep: Pick<DeliveredEpisode, "start" | "end">, fps: number): number {
  return Math.round(ep.end * fps) - Math.round(ep.start * fps);
}

/**
 * The whisper words inside one delivered window `[start_s, end_s)`, shifted
 * to episode time in ms, in the shape transcriptToCues reads (lib/asr.ts). A
 * word belongs to the episode whose window holds its midpoint, so a word
 * that straddles a boundary is written once. A whisper segment with no word
 * inside the window contributes nothing (its whole text would be wrong).
 */
export function sliceTranscript(whisper: Pick<WhisperIndex, "segments">, startS: number, endS: number): AsrSegment[] {
  const out: AsrSegment[] = [];
  const lengthMs = Math.round((endS - startS) * 1000);
  const toMs = (s: number) => Math.min(lengthMs, Math.max(0, Math.round((s - startS) * 1000)));
  for (const seg of whisper.segments) {
    if (seg.end <= startS || seg.start >= endS) continue;
    const words: AsrWord[] = [];
    for (const w of seg.words) {
      const mid = (w.s + w.e) / 2;
      if (mid < startS || mid >= endS) continue;
      words.push({ w: w.w, start_ms: toMs(w.s), end_ms: Math.max(toMs(w.e), toMs(w.s)) });
    }
    if (!words.length) continue;
    const text = words.map((w) => w.w).join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push({ start_ms: words[0].start_ms, end_ms: words[words.length - 1].end_ms, text, words });
  }
  return out;
}

/** What the episode row records about why it ends where it does (the pipeline's vision record, the band-fix flag). */
export function endNoteFor(ep: DeliveredEpisode, boundary: BoundaryNote | null, isLast: boolean): Json {
  if (isLast) return { decision: "film_end", planned_end_s: ep.end, ends_after_line: ep.ends_after_line, next_opens_on: ep.next_opens_on };
  const note = {
    decision: boundary?.decision ?? "none",
    band_fix: boundary?.decision === "band_fix",
    band_fix_note: boundary?.band_fix_note ?? null,
    planned_end_s: ep.end,
    ends_after_line: ep.ends_after_line,
    next_opens_on: ep.next_opens_on,
    vision: boundary?.vision
      ? { boundary_s: boundary.vision.boundary_s, pick: boundary.vision.pick, verdict: boundary.vision.verdict, source_file: boundary.vision.source_file }
      : null,
  };
  return JSON.parse(JSON.stringify(note)) as Json;
}

/** film-meta's rules merged over the title's own: the review-added exclusions stay, the film_meta ones are replaced. */
export function mergeAdRules(current: AdRules | null | undefined, meta: FilmIndex["meta"]): AdRules | null {
  if (!meta) return current ?? null;
  const review = (current?.exclusions ?? []).filter((x) => x.source === "review");
  const fromMeta = meta.exclusions.map((x) => ({ from_s: x.from_s, to_s: x.to_s, why: x.kind ? `${x.kind}: ${x.why}` : x.why, source: "film_meta" as const }));
  return { spoiler_from_s: meta.spoiler_from_s ?? current?.spoiler_from_s ?? null, exclusions: [...fromMeta, ...review] };
}

// ---- the import record ----------------------------------------------------------------------------------

/** One imported episode as the record remembers it: what the listing compares the disk against without hashing. */
export type ImportedEpisodeFacts = {
  n: number;
  bytes: number;
  mtime_ms: number;
  sha256: string;
  frames: number | null;
  planned_frames: number | null;
  video_path: string;
};

export type ImportCounts = { added: number; updated: number; unchanged: number; flagged: number; transcripts: number; transcripts_skipped: number };

const zeroCounts = (): ImportCounts => ({ added: 0, updated: 0, unchanged: 0, flagged: 0, transcripts: 0, transcripts_skipped: 0 });

/**
 * What one import wrote, kept as a Studio-made `delivered_plan` asset beside
 * the linked plan (origin 'studio', newest first in listFilmAssets): the plan
 * hash the import used and each episode's size, mtime and hash. The listing
 * decides IMPORTED / K_CHANGED from this and a stat of the disk, never from a
 * hash of the originals.
 */
export type ImportRecord = {
  version: number;
  imported_at: string;
  job_id: string;
  source_ref: string;
  delivered_file: string;
  delivered_sha256: string;
  meta_sha256: string | null;
  episodes: ImportedEpisodeFacts[];
  counts: ImportCounts;
  flags: string[];
};

function isImportRecordMeta(meta: Json | null | undefined): meta is Record<string, Json> & { import_record: true } {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) && (meta as Record<string, unknown>).import_record === true;
}

/** The newest import record among a title's assets, or null when the title was never imported to the end. */
export function latestImportRecord(assets: FilmAsset[]): ImportRecord | null {
  for (const a of assets) {
    if (a.kind !== "delivered_plan" || a.origin !== "studio" || !isImportRecordMeta(a.meta)) continue;
    const m = a.meta as unknown as { record?: ImportRecord };
    if (m.record && Array.isArray(m.record.episodes) && typeof m.record.delivered_sha256 === "string") return m.record;
  }
  return null;
}

/**
 * IMPORTED / K_CHANGED for a scanned film against its record: the plan hash,
 * then each file's size (applyImportState), then each file's mtime — a
 * re-render replaces the file, and the new one carries a new mtime even when
 * its size happens to match. The update run confirms by hashing the link.
 */
export function stateAgainstRecord(scan: FilmScan, record: ImportRecord | null): FilmScan {
  if (!record) return scan;
  const s = applyImportState(scan, { delivered_sha256: record.delivered_sha256, episodes: record.episodes.map((e) => ({ n: e.n, bytes: e.bytes })) });
  if (s.state !== "IMPORTED") return s;
  const known = new Map(record.episodes.map((e) => [e.n, e]));
  const moved = scan.episodes.filter((e) => known.get(e.n)?.mtime_ms !== e.mtime_ms).map((e) => e.n);
  return moved.length ? { ...s, state: "K_CHANGED", reason: { code: "files_changed", episodes: moved } } : s;
}

// ---- progress (process-wide) ----------------------------------------------------------------------------

export type ImportMode = "import" | "update";
export type ImportStep = "scan" | "title" | "episodes" | "transcripts" | "assets" | "finish" | "done" | "failed";

export type ImportResult = {
  title_id: string;
  job_id: string;
  counts: ImportCounts;
  /** Per-episode notes: a frame count off the plan, a transcript kept, a probe that failed. */
  flags: string[];
  /** The DELIVERED file changed while the import ran: the film reads K_CHANGED and wants an update. */
  changed_during_import: boolean;
  state: Extract<FilmScanState, "IMPORTED" | "K_CHANGED">;
  warnings: string[];
};

export type ImportProgress = {
  key: string;
  producer_id: string;
  source_ref: string;
  mode: ImportMode;
  job_id: string;
  title_id: string;
  started_at: string;
  updated_at: string;
  step: ImportStep;
  /** The episode being worked on, 1-based, during `episodes` and `transcripts`. */
  episode: number | null;
  total: number;
  what: "link" | "hash" | "probe" | null;
  counts: ImportCounts;
  error: string | null;
  result: ImportResult | null;
};

type Registry = Map<string, ImportProgress>;
const registryHolder = globalThis as unknown as { __studioFilmImports?: Registry };
const registry = (): Registry => (registryHolder.__studioFilmImports ??= new Map());

export function progressKey(producerId: string, sourceRef: string): string {
  return `${producerId}:${sourceRef}`;
}

/** The progress of the import of one film for one company, running or finished, or null. */
export function importProgress(producerId: string, sourceRef: string): ImportProgress | null {
  const p = registry().get(progressKey(producerId, sourceRef));
  return p ? { ...p, counts: { ...p.counts } } : null;
}

export function importIsRunning(p: ImportProgress | null | undefined): boolean {
  return !!p && p.step !== "done" && p.step !== "failed";
}

/** Tests only: forget every import this process ran. */
export function resetImportRegistry(): void {
  registry().clear();
}

// ---- options ------------------------------------------------------------------------------------------------

export type ImportOptions = {
  /** WORKSPACE_ROOT override. */
  root?: string;
  /** The scanner's quiet period; STUDIO_IMPORT_QUIET_MS / the default when absent. */
  quietMs?: number;
  /** The video probe (ffprobe by default); the tests inject a table. */
  probe?: VideoProbe;
  now?: () => number;
  /** Test hooks: run between the episode loop and the transcripts (a plan rewritten mid-import). */
  hooks?: { afterEpisodes?: () => Promise<void> };
};

/** The body both import routes take (a route file may export only Next's own fields, so the schema lives here). */
export const ImportRequestSchema = z.object({
  source_ref: z.string().trim().min(1).max(200),
  mode: z.enum(["import", "update"]),
  /** Default on: the pipeline's whisper words become each episode's script. */
  attach_transcript: z.boolean().optional(),
  /** The display title the person typed before importing; film-meta's, then the folder's, when absent. */
  display_title: z.string().trim().min(1).max(200).nullish(),
});

export type ImportRequest = z.infer<typeof ImportRequestSchema>;

/**
 * Who the import is for: the company that owns the title (the producer's own
 * for a producer session; staff name one) and the real caller the adaptation
 * records as its creator (the session's user unless a route says otherwise).
 */
export type ImportContext = { producer_id?: string | null; created_by?: string | null };

function contextOf(caller: Session, ctx: ImportContext): { producer_id: string; created_by: string } {
  const producerId = caller.kind === "producer" ? caller.producerId : ctx.producer_id;
  if (!producerId) throw new DataError("invalid", "producer_id is required: which company imports the film");
  return { producer_id: producerId, created_by: ctx.created_by ?? caller.userId };
}

function scanOptions(root: string, opts: ImportOptions): ScanOptions {
  const quiet = opts.quietMs ?? importQuietMs();
  return {
    root,
    ...(quiet !== undefined ? { quietMs: quiet } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    probe: opts.probe ? async (link) => {
      const f = await opts.probe!(link);
      return f ? { width: f.width, height: f.height, fps: f.fps, duration_s: f.duration_s } : null;
    } : scannerProbe,
    linkDir: importWorkDir(),
  };
}

function resolveRoot(opts: ImportOptions): string {
  const root = opts.root ?? workspaceRoot();
  if (!root) throw new DataError("invalid", "WORKSPACE_ROOT is not set: Studio has no film workspace to read");
  return root;
}

// ---- the listing ------------------------------------------------------------------------------------------------

export type FilmRow = {
  source_ref: string;
  folder: string;
  display_title: string;
  source_title: string | null;
  crazydramas_slug: string | null;
  state: FilmScanState;
  reason: ScanReason | null;
  episodes: number;
  bytes: number;
  video: { width: number; height: number; fps: number } | null;
  language: string | null;
  /** The poster under the workspace, as a source ref (served by the poster route); null when the film has none. */
  poster_ref: string | null;
  delivered: { file: string; end: number; count: number } | null;
  /** Set once the company has a title for this film. `imported_at` is null when no import finished (a torn first run). */
  imported: { title_id: string; name: string; imported_at: string | null; cover_url: string | null; episodes: number } | null;
  /** Episodes whose files moved since the record (K_CHANGED files_changed), else empty. */
  changed: number[];
  progress: ImportProgress | null;
  warnings: string[];
};

export type FilmListing = { configured: boolean; films: FilmRow[] };

function toRow(scan: FilmScan, title: Title | null, record: ImportRecord | null, progress: ImportProgress | null): FilmRow {
  const state = title ? stateAgainstRecord(scan, record) : scan;
  return {
    source_ref: scan.source_ref,
    folder: scan.folder,
    display_title: title?.name_en ?? scan.display_title,
    source_title: scan.meta?.source_title_en ?? null,
    crazydramas_slug: title?.crazydramas_slug ?? scan.meta?.crazydramas_slug ?? null,
    state: state.state,
    reason: state.reason,
    episodes: scan.totals.count,
    bytes: scan.totals.bytes,
    video: scan.video ? { width: scan.video.width, height: scan.video.height, fps: scan.video.fps } : null,
    language: scan.language,
    poster_ref: scan.poster,
    delivered: scan.delivered ? { file: scan.delivered.file, end: scan.delivered.end, count: scan.delivered.count } : null,
    imported: title
      ? { title_id: title.id, name: title.name_en ?? title.name_zh, imported_at: record?.imported_at ?? null, cover_url: mediaUrl(title.cover_path ?? null), episodes: record?.episodes.length ?? 0 }
      : null,
    changed: state.reason?.code === "files_changed" ? state.reason.episodes : [],
    progress,
    warnings: scan.warnings,
  };
}

/**
 * Every film under the workspace with its state for one company: the scan
 * (stat and JSON only — no episode is opened), IMPORTED / K_CHANGED from the
 * company's own records, and the progress of an import that is running or
 * just finished. Without a company (staff before picking one) the states are
 * the disk's alone. `configured` is false when WORKSPACE_ROOT is unset.
 */
export async function listFilms(session: Session, producerId: string | null, opts: ImportOptions = {}): Promise<FilmListing> {
  const root = opts.root ?? workspaceRoot();
  if (!root) return { configured: false, films: [] };
  const data = getData();
  const scans = await scanWorkspace(scanOptions(root, opts));
  const films: FilmRow[] = [];
  for (const scan of scans) {
    let title: Title | null = null;
    let record: ImportRecord | null = null;
    if (producerId) {
      title = await data.findTitleBySourceRef(session, producerId, scan.source_ref);
      if (title) record = latestImportRecord(await data.listFilmAssets(session, title.id));
    }
    // A finished import's progress belongs to the title it made; after a demo reset (fixture) the title is gone and so is the line.
    const progress = producerId ? importProgress(producerId, scan.source_ref) : null;
    films.push(toRow(scan, title, record, progress && (importIsRunning(progress) || progress.title_id === title?.id) ? progress : null));
  }
  return { configured: true, films };
}

/**
 * The bytes of a poster under the workspace for the listing's thumbnail:
 * only a `<film>/poster/final/*.jpg|png` ref, resolved inside the root. A
 * poster is not an episode; reading it in place is allowed.
 */
export async function readPoster(ref: string, opts: ImportOptions = {}): Promise<{ bytes: Buffer; contentType: string } | null> {
  const root = opts.root ?? workspaceRoot();
  if (!root) return null;
  let clean: string;
  try {
    clean = normalizeSourceRef(ref);
  } catch {
    return null;
  }
  const parts = clean.split("/");
  const file = parts[parts.length - 1];
  if (parts.length < 4 || parts[parts.length - 3] !== "poster" || parts[parts.length - 2] !== "final" || !POSTER_FILE.test(file)) return null;
  const abs = path.resolve(root, ...parts);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    const bytes = await fsp.readFile(abs);
    return { bytes, contentType: /\.png$/i.test(file) ? "image/png" : "image/jpeg" };
  } catch {
    return null;
  }
}

// ---- the job ------------------------------------------------------------------------------------------------

type Prepared = {
  root: string;
  ref: string;
  slug: string;
  scan: FilmScan;
  title: Title;
  created: boolean;
  job: Job;
  progress: ImportProgress;
  request: ImportRequest;
  ctx: { producer_id: string; created_by: string };
  opts: ImportOptions;
};

function reasonText(reason: ScanReason | null): string {
  if (!reason) return "not ready";
  switch (reason.code) {
    case "part_file":
      return `a render is writing ${reason.file}`;
    case "recent_write":
      return `${reason.file} was written ${reason.seconds_ago} s ago; the render may not be finished`;
    case "bad_delivered":
      return `${reason.file} does not parse: ${reason.detail}`;
    case "episode_gap":
      return `the episode files are not 1..N (missing ${reason.missing.join(", ") || "none"}; duplicated ${reason.duplicates.join(", ") || "none"})`;
    case "count_mismatch":
      return `the plan has ${reason.planned} episodes and ${reason.found} files were found`;
    case "placeholder":
      return `${reason.file} is a cloud placeholder whose bytes are not on disk`;
    default:
      return reason.code.replace(/_/g, " ");
  }
}

/**
 * The checks that can refuse, then the job row and (in import mode) the
 * title. Throws a DataError the route maps: `not_found` for a film that is
 * not there, `conflict` when it is not READY, already imported (import mode),
 * never imported (update mode) or being imported right now.
 */
async function prepare(caller: Session, request: ImportRequest, context: ImportContext, opts: ImportOptions): Promise<Prepared> {
  const ctx = contextOf(caller, context);
  const root = resolveRoot(opts);
  const ref = normalizeSourceRef(request.source_ref);
  const data = getData();
  const sys = systemSession();
  if (!(await nodeScanFs.stat(workspacePath(root, ref)))?.is_directory) throw new DataError("not_found", `film ${ref} not found under the workspace`);

  const key = progressKey(ctx.producer_id, ref);
  if (importIsRunning(registry().get(key))) throw new DataError("conflict", `an import of ${ref} is already running`);

  const scan = await scanFilm(ref, scanOptions(root, opts));
  if (scan.state !== "READY" || !scan.delivered) throw new DataError("conflict", `${ref} is not ready to import: ${reasonText(scan.reason)}`);

  const existing = await data.findTitleBySourceRef(sys, ctx.producer_id, ref);
  if (request.mode === "import" && existing) throw new DataError("conflict", `${ref} is already imported as ${existing.external_id}; update it instead`);
  if (request.mode === "update" && !existing) throw new DataError("not_found", `${ref} has not been imported for this company yet`);

  const displayTitle = request.display_title?.trim() || scan.display_title;
  let title: Title;
  let created = false;
  if (existing) {
    title = existing;
    const patch: { display_title_en?: string; crazydramas_slug?: string | null } = {};
    if (request.display_title?.trim() && request.display_title.trim() !== (existing.name_en ?? "")) patch.display_title_en = request.display_title.trim();
    if (scan.meta?.crazydramas_slug && scan.meta.crazydramas_slug !== (existing.crazydramas_slug ?? null)) patch.crazydramas_slug = scan.meta.crazydramas_slug;
    if (Object.keys(patch).length) title = await data.setTitleImport(sys, existing.id, patch);
  } else {
    title = await data.createImportedTitle(sys, {
      producer_id: ctx.producer_id,
      source_ref: ref,
      display_title_en: displayTitle,
      crazydramas_slug: scan.meta?.crazydramas_slug ?? null,
      created_by: ctx.created_by,
    });
    created = true;
  }

  // One job per film and plan; a second run of the same plan (an update after a re-render) is its own row.
  const baseKey = `import:${ref}:${scan.delivered.sha256}`;
  const jobInput = (key: string): NewJob => ({
    kind: IMPORT_JOB_KIND,
    title_id: title.id,
    target_type: "title",
    target_id: title.id,
    idempotency_key: key,
    provider: null,
    model: null,
    input: { source_ref: ref, delivered_file: scan.delivered!.file, delivered_sha256: scan.delivered!.sha256, mode: request.mode, attach_transcript: request.attach_transcript !== false, caller: ctx.created_by },
  });
  let job = await data.recordJob(sys, jobInput(baseKey));
  if (job.status === "done") job = await data.recordJob(sys, jobInput(`${baseKey}:u${Date.now().toString(36)}`));

  const at = new Date().toISOString();
  const progress: ImportProgress = {
    key,
    producer_id: ctx.producer_id,
    source_ref: ref,
    mode: request.mode,
    job_id: job.id,
    title_id: title.id,
    started_at: at,
    updated_at: at,
    step: "scan",
    episode: null,
    total: scan.delivered.count,
    what: null,
    counts: zeroCounts(),
    error: null,
    result: null,
  };
  registry().set(key, progress);
  return { root, ref, slug: scan.folder, scan, title, created, job, progress, request, ctx, opts };
}

function touch(p: ImportProgress, patch: Partial<ImportProgress>): void {
  Object.assign(p, patch, { updated_at: new Date().toISOString() });
}

type EpisodeState = { row: Episode; lines: number };

async function existingEpisodes(titleId: string): Promise<Map<number, EpisodeState>> {
  const data = getData();
  const sys = systemSession();
  const out = new Map<number, EpisodeState>();
  const detail = await data.getTitle(sys, titleId);
  for (const e of detail.episodes) {
    const wb = await data.getWorkbench(sys, titleId, e.number);
    out.set(e.number, { row: wb.episode, lines: wb.lines.length });
  }
  return out;
}

/** Link one workspace file into the tier under a hashed name and record it as a film asset. */
async function linkAsset(p: Prepared, kind: FilmAssetKind, relFile: string, meta: Json): Promise<FilmAsset> {
  const abs = path.join(p.root, ...relFile.split("/"));
  const bytes = await fsp.readFile(abs);
  const sha = sha256Hex(bytes);
  const ext = path.extname(relFile);
  const stem = path.basename(relFile, ext);
  const stored = localStoredPath(p.title.id, p.slug, `${stem}-${sha.slice(0, 8)}${ext}`);
  linkIntoLocalTier(abs, stored);
  return getData().putFilmAsset(systemSession(), { title_id: p.title.id, kind, storage_path: stored, sha256: sha, bytes: bytes.length, origin: "workspace", source_ref: relFile, meta });
}

async function run(p: Prepared): Promise<ImportResult> {
  const data = getData();
  const sys = systemSession();
  const { root, ref, slug, scan, title, job, progress, request, opts } = p;
  const probe = opts.probe ?? ffprobeFacts;
  const plan = scan.delivered!.plan;
  const counts = progress.counts;
  const flags: string[] = [];
  const warnings: string[] = [];
  const beat = () => data.heartbeatJob(sys, job.id).catch(() => undefined);

  // Step 1 happened in prepare (the re-scan); the whole index is read now, once.
  const index = await loadFilmIndex(nodeScanFs, root, ref);
  warnings.push(...index.problems);
  const fps = plan.fps ?? index.source?.fps ?? scan.video?.fps ?? null;
  const known = p.created ? new Map<number, EpisodeState>() : await existingEpisodes(title.id);
  const facts: ImportedEpisodeFacts[] = [];
  const boundaries = new Map(index.boundaries.map((b) => [b.n, b]));

  // Step 3: every episode, in plan order.
  touch(progress, { step: "episodes" });
  for (const ep of plan.episodes) {
    const file = scan.episodes.find((e) => e.n === ep.n);
    if (!file) throw new DataError("conflict", `episode ${ep.n} has no file in cut/eps (the film changed since the scan)`);
    const original = path.join(root, ...file.file.split("/"));
    const nn = String(ep.n).padStart(2, "0");
    touch(progress, { episode: ep.n, what: "link" });

    // The hardlink first, under a pending name; the hash names the final link.
    const pendingStored = localStoredPath(title.id, slug, `ep${nn}.pending-${randomUUID().slice(0, 8)}.mp4`);
    const pending = linkIntoLocalTier(original, pendingStored);
    let finalStored: string;
    let finalAbs: string;
    let sha: string;
    try {
      touch(progress, { what: "hash" });
      sha = await sha256File(pending.abs);
      finalStored = localStoredPath(title.id, slug, `ep${nn}-${sha.slice(0, 8)}.mp4`);
      finalAbs = localPathOf(finalStored);
      if (existsSync(finalAbs)) {
        const have = statSync(finalAbs);
        if (have.size !== file.bytes) throw new DataError("conflict", `${finalStored} exists with another size`);
        unlinkSync(pending.abs);
      } else {
        renameSync(pending.abs, finalAbs);
      }
    } catch (e) {
      try {
        if (existsSync(pending.abs)) unlinkSync(pending.abs);
      } catch {
        // the pending link is harmless; the next run makes a new one
      }
      throw e;
    }

    const window = { film_start_ms: Math.round(ep.start * 1000), film_end_ms: Math.round(ep.end * 1000) };
    const endNote = endNoteFor(ep, boundaries.get(ep.n) ?? null, ep.n === plan.episodes.length);
    const have = known.get(ep.n);
    const planned = fps ? plannedFrames(ep, fps) : null;

    if (have && have.row.video_sha256 === sha && have.row.video_path === finalStored) {
      // Same bytes: skipped, unless the plan moved this episode's window under the same file.
      if (have.row.film_start_ms !== window.film_start_ms || have.row.film_end_ms !== window.film_end_ms) {
        const row = await data.setEpisodeImport(sys, have.row.id, { ...window, end_note: endNote, auto_cut: false });
        known.set(ep.n, { row, lines: have.lines });
        counts.updated += 1;
      } else {
        counts.unchanged += 1;
      }
      facts.push({ n: ep.n, bytes: file.bytes, mtime_ms: file.mtime_ms, sha256: sha, frames: have.row.video_frames ?? null, planned_frames: planned, video_path: finalStored });
      await beat();
      continue;
    }

    touch(progress, { what: "probe" });
    const probed = await probe(finalAbs);
    const frames = probed?.frames ?? null;
    if (!probed) flags.push(`ep${nn}: ffprobe could not read the file; the frame count is not recorded`);
    else if (planned !== null && frames !== null && frames !== planned) {
      flags.push(`ep${nn}: ${frames} frames on disk, the plan expects ${planned} (${frames - planned > 0 ? "+" : ""}${frames - planned})`);
      counts.flagged += 1;
    }
    const patch = { source_ref: file.file, video_sha256: sha, video_bytes: file.bytes, video_frames: frames, ...window, end_note: endNote, auto_cut: false as const };
    let row: Episode;
    if (have) {
      row = await data.setEpisodeImport(sys, have.row.id, { video_path: finalStored, ...patch });
      counts.updated += 1;
    } else {
      row = await data.addVideoOnlyEpisode(sys, title.id, ep.n, finalStored, patch);
      counts.added += 1;
    }
    known.set(ep.n, { row, lines: have?.lines ?? 0 });
    facts.push({ n: ep.n, bytes: file.bytes, mtime_ms: file.mtime_ms, sha256: sha, frames, planned_frames: planned, video_path: finalStored });
    await beat();
  }
  touch(progress, { episode: null, what: null });
  await opts.hooks?.afterEpisodes?.();

  // Step 4: the pipeline transcript as each episode's script (never over existing lines).
  if (request.attach_transcript !== false) {
    touch(progress, { step: "transcripts" });
    if (!index.whisper) {
      warnings.push("index/whisper.json is missing: no transcript was attached");
    } else {
      const note = `Pulsar Studio pipeline transcript (asr) | faster-whisper/${index.whisper.model} | ${index.whisper.language}`;
      for (const ep of plan.episodes) {
        const state = known.get(ep.n);
        if (!state) continue;
        touch(progress, { episode: ep.n });
        if (state.lines > 0) {
          counts.transcripts_skipped += 1;
          flags.push(`ep${String(ep.n).padStart(2, "0")}: kept its ${state.lines} existing lines (a script is never replaced)`);
          continue;
        }
        const cues = transcriptToCues({ segments: sliceTranscript(index.whisper, ep.start, ep.end) });
        if (!cues.length) {
          counts.transcripts_skipped += 1;
          continue;
        }
        const vtt = cuesToVtt(cues, note);
        const bytes = new TextEncoder().encode(vtt);
        const ingest = restoreMachineLines(ingestEpisodeFile(bytes, "transcript.vtt"), cues);
        const subtitlePath = await uploadImport(title.id, state.row.id, `ep${String(ep.n).padStart(2, "0")}-transcript.vtt`, bytes);
        const row = await data.attachIngestToEpisode(sys, title.id, ep.n, ingest, { subtitlePath, scriptFormat: "asr" });
        known.set(ep.n, { row, lines: ingest.lines.length });
        counts.transcripts += 1;
        await beat();
      }
    }
    touch(progress, { episode: null });
  }

  // Step 5: the pipeline's files beside the title, linked into the tier; the poster becomes the cover; film-meta's rules the title's.
  touch(progress, { step: "assets" });
  await linkAsset(p, "delivered_plan", `${ref}/cut/${index.delivered_file}`, { end: scan.delivered!.end, episodes: plan.episodes.length });
  if (index.whisper) await linkAsset(p, "transcript", `${ref}/cut/index/whisper.json`, { model: index.whisper.model, language: index.whisper.language, segments: index.whisper.segments.length });
  if (index.shot_cuts) await linkAsset(p, "shots", `${ref}/cut/index/scdet.txt`, { cuts: index.shot_cuts.length });
  if (index.motion) await linkAsset(p, "motion", `${ref}/cut/index/motion.json`, { fps: index.motion.fps, beats: index.motion.beats.length });
  if (index.candidates) await linkAsset(p, "candidates", `${ref}/cut/index/candidates.json`, { legal: index.candidates.legal, allowed: index.candidates.allowed.length });
  if (index.source) await linkAsset(p, "source_facts", `${ref}/cut/index/source.json`, { fps: index.source.fps, width: index.source.width, height: index.source.height });
  for (const name of [...new Set(index.vision.map((v) => v.source_file))].sort()) {
    await linkAsset(p, "vision_notes", `${ref}/cut/review/vision/${name}`, { file: name, role: "record", boundaries: index.vision.filter((v) => v.source_file === name).length });
  }
  for (const name of await listBandFixFiles(nodeScanFs, path.join(root, ...ref.split("/"), "cut"))) {
    await linkAsset(p, "vision_notes", `${ref}/cut/review/vision/${name}`, { file: name, role: "band_fix_note" });
  }
  let metaSha: string | null = null;
  if (index.meta) {
    const asset = await linkAsset(p, "film_meta", `${ref}/cut/film-meta.json`, { display_title_en: index.meta.display_title_en, crazydramas_slug: index.meta.crazydramas_slug });
    metaSha = asset.sha256;
  }
  let coverPath: string | null = title.cover_path ?? null;
  if (scan.poster) {
    const asset = await linkAsset(p, "poster", scan.poster, { live: scan.meta?.live_poster ?? null, file: path.posix.basename(scan.poster) });
    coverPath = asset.storage_path;
  }
  if (coverPath !== (title.cover_path ?? null)) await data.setTitleImport(sys, title.id, { cover_path: coverPath });
  const rules = mergeAdRules(title.ad_rules ?? null, index.meta);
  if (rules) await data.setTitleAdRules(sys, title.id, rules);
  await beat();

  // Step 6: the plan again; a change under the import is the film's K_CHANGED, not a failure.
  touch(progress, { step: "finish" });
  const again = await scanFilm(ref, scanOptions(root, { ...opts, quietMs: 0 }));
  const changedDuringImport = again.delivered?.sha256 !== scan.delivered!.sha256;
  if (changedDuringImport) warnings.push("the DELIVERED plan changed while the import ran; the film wants an update");

  // Step 7: the record and the counts.
  const record: ImportRecord = {
    version: IMPORT_RECORD_VERSION,
    imported_at: new Date().toISOString(),
    job_id: job.id,
    source_ref: ref,
    delivered_file: scan.delivered!.file,
    delivered_sha256: scan.delivered!.sha256,
    meta_sha256: metaSha,
    episodes: facts,
    counts: { ...counts },
    flags,
  };
  const recordBytes = new TextEncoder().encode(JSON.stringify(record, null, 1));
  const recordSha = sha256Hex(recordBytes);
  const recordStored = localStoredPath(title.id, slug, `import-${record.imported_at.replace(/[:.]/g, "-")}-${recordSha.slice(0, 8)}.json`);
  await putStoredBytes(recordStored, recordBytes, "application/json");
  await data.putFilmAsset(sys, {
    title_id: title.id,
    kind: "delivered_plan",
    storage_path: recordStored,
    sha256: recordSha,
    bytes: recordBytes.length,
    origin: "studio",
    source_ref: null,
    meta: { import_record: true, record: JSON.parse(JSON.stringify(record)) as Json },
  });

  const result: ImportResult = {
    title_id: title.id,
    job_id: job.id,
    counts: { ...counts },
    flags,
    changed_during_import: changedDuringImport,
    state: changedDuringImport ? "K_CHANGED" : "IMPORTED",
    warnings,
  };
  await data.finishJob(sys, job.id, {
    status: "done",
    cost_cents: 0,
    output: { ...result, record_path: recordStored } as unknown as Json,
  });
  touch(progress, { step: "done", result });
  log(`${ref} → ${title.external_id}: ${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.flagged} flagged, ${counts.transcripts} transcripts${changedDuringImport ? " (plan changed during the import)" : ""}`);
  return result;
}

async function runGuarded(p: Prepared): Promise<ImportResult> {
  try {
    return await run(p);
  } catch (e) {
    const message = isDataError(e) || e instanceof Error ? (e as Error).message : String(e);
    await getData().finishJob(systemSession(), p.job.id, { status: "failed", error: message, cost_cents: 0 }).catch(() => undefined);
    touch(p.progress, { step: "failed", error: message });
    console.error(`[film-import] ${p.ref}: ${message}`);
    throw e;
  }
}

/** The whole import, awaited: the checks, the title, the episodes, the transcripts, the assets, the record. */
export async function importFilm(caller: Session, request: ImportRequest, ctx: ImportContext = {}, opts: ImportOptions = {}): Promise<ImportResult> {
  return runGuarded(await prepare(caller, request, ctx, opts));
}

export type ImportStarted = { job_id: string; title_id: string; key: string; created: boolean };

/**
 * What the routes call: the refusals and the title happen now, the linking,
 * hashing, probing and writing continue in the background; the page follows
 * through `listFilms` (progress on the film's row).
 */
export async function startImport(caller: Session, request: ImportRequest, ctx: ImportContext = {}, opts: ImportOptions = {}): Promise<ImportStarted> {
  const p = await prepare(caller, request, ctx, opts);
  void runGuarded(p).catch(() => undefined);
  return { job_id: p.job.id, title_id: p.title.id, key: p.progress.key, created: p.created };
}
