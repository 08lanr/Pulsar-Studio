// The workspace scanner (decision 2026-09-22, "the workspace import"): what
// is under WORKSPACE_ROOT and whether each film is ready to import. Pure
// over an injected file system (`nodeScanFs` by default, a temp dir or a
// fake in tests) and an injected clock.
//
// It walks `<root>/*` and `<root>/*/*`: a folder with a `cut/` or a
// `source/` is a project; anything else at depth one is a bucket
// (`low-quality/`) whose children are looked at the same way. A narrated
// project (`love-between-lines/`, no `cut/`) is reported as NO_MANIFEST with
// the reason, never skipped, never crashed on. Junctions are followed once:
// two paths with one realpath are one film.
//
// The one rule that keeps a running render safe: nothing here opens
// `cut/eps/*.mp4`. The scanner lists the folder and stats the files; when a
// pixel size is needed and `index/source.json` is missing, it hardlinks ONE
// sample into `linkDir` and hands the injected probe the link (spec §3.1: a
// hardlink held open lets the pipeline's os.replace succeed; the original
// path held open would crash cut_episodes.py).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { isPartialFile, parseWorkspaceEpisodeFile } from "@/lib/ingest/episode-number";
import { listPosters, parseDeliveredPlan, parseFilmMeta, parseSourceFacts, pickNewestDelivered, sha256Hex, toSourceRef } from "./manifest";
import type { DeliveredPlan, FilmMeta, FilmScan, PipelineArtifacts, PipelineStage, ScanDirent, ScanFs, ScanReason, ScanStat, ScannedEpisode, ScannedVideo } from "./types";

/** No write in `eps/` may be younger than this for a film to be READY (spec §3.3). */
export const DEFAULT_QUIET_MS = 5 * 60 * 1000;

/** A file this big with no allocated blocks is a cloud placeholder (smaller files live inside the MFT record and report 0 blocks legitimately). */
const PLACEHOLDER_MIN_BYTES = 4096;

export type ProbeResult = { width: number; height: number; fps: number; duration_s?: number | null };

/** Reads the pixel size and frame rate of the file at `linkPath` (a hardlink, never the workspace path). */
export type ProbeFn = (linkPath: string) => Promise<ProbeResult | null>;

export type ScanOptions = {
  /** WORKSPACE_ROOT: the pipeline's `projects/` folder. */
  root: string;
  fs?: ScanFs;
  /** The clock, for the quiet-period rule. */
  now?: () => number;
  /** Override of DEFAULT_QUIET_MS; 0 or less switches the rule off (a test or an e2e run that just wrote its files). */
  quietMs?: number;
  /** With `linkDir`: called on a hardlinked sample when `index/source.json` is missing. */
  probe?: ProbeFn;
  /** Where the probe's hardlink is made (STUDIO_WORK_DIR); the same volume as the workspace for a true link. */
  linkDir?: string;
  /** Realpaths compare case-insensitively (Windows). Default: the platform. */
  caseInsensitive?: boolean;
};

// ---- the node file system -------------------------------------------------------------------

function direntKind(e: fs.Dirent): ScanDirent["kind"] {
  if (e.isSymbolicLink()) return "symlink";
  if (e.isDirectory()) return "dir";
  if (e.isFile()) return "file";
  return "other";
}

function toStat(s: fs.Stats): ScanStat {
  return { size: s.size, mtime_ms: s.mtimeMs, blocks: typeof s.blocks === "number" ? s.blocks : null, is_directory: s.isDirectory() };
}

export const nodeScanFs: ScanFs = {
  async readdir(dir) {
    return (await fsp.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, kind: direntKind(e) }));
  },
  async stat(p) {
    try {
      return toStat(await fsp.stat(p));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw e;
    }
  },
  async realpath(p) {
    // The native call resolves junctions through the Win32 API; the JS one
    // does too, but only by treating the reparse point as a symlink.
    return fs.realpathSync.native(p);
  },
  readFile: (p) => fsp.readFile(p, "utf8"),
  readBytes: (p) => fsp.readFile(p),
  link: (src, dst) => fsp.link(src, dst),
  copy: (src, dst) => fsp.copyFile(src, dst),
  remove: (p) => fsp.rm(p, { force: true }),
  mkdir: (p) => fsp.mkdir(p, { recursive: true }).then(() => undefined),
};

// ---- the walk ---------------------------------------------------------------------------------

/** One project under the root; `realpath` is its folded (case as the OS compares it) real path, the identity junctions and casing share. */
export type Project = { folder: string; source_ref: string; abs: string; realpath: string };

const foldFor = (opts: ScanOptions) => ((opts.caseInsensitive ?? process.platform === "win32") ? (s: string) => s.toLowerCase() : (s: string) => s);

async function isDir(sfs: ScanFs, p: string): Promise<boolean> {
  return (await sfs.stat(p))?.is_directory === true;
}

/** A project folder has the pipeline's `cut/` (a cut-only film) or a `source/` (any film, narrated ones included). */
async function isProject(sfs: ScanFs, abs: string): Promise<boolean> {
  return (await isDir(sfs, path.join(abs, "cut"))) || (await isDir(sfs, path.join(abs, "source")));
}

async function childDirs(sfs: ScanFs, dir: string): Promise<{ name: string; abs: string }[]> {
  const out: { name: string; abs: string }[] = [];
  for (const e of await sfs.readdir(dir)) {
    if (e.name.startsWith(".") || (e.kind !== "dir" && e.kind !== "symlink")) continue;
    const abs = path.join(dir, e.name);
    if (await isDir(sfs, abs)) out.push({ name: e.name, abs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The project folders under the root, at depth one or two, each realpath once. */
export async function listProjects(opts: ScanOptions): Promise<Project[]> {
  const sfs = opts.fs ?? nodeScanFs;
  const fold = foldFor(opts);
  // One entry per realpath. When a junction and the folder it points at are
  // both under the root, the folder itself is the film (`alias` sorts before
  // `low-quality/`, so the order of the walk cannot decide).
  const byKey = new Map<string, Project & { real: boolean }>();
  const consider = async (name: string, abs: string, sourceRef: string): Promise<boolean> => {
    if (!(await isProject(sfs, abs))) return false;
    const real = fold(await sfs.realpath(abs));
    const isReal = real === fold(path.resolve(abs));
    const have = byKey.get(real);
    if (!have || (isReal && !have.real)) byKey.set(real, { folder: name, source_ref: sourceRef, abs, realpath: real, real: isReal });
    return true;
  };
  if (!(await isDir(sfs, opts.root))) return [];
  for (const d of await childDirs(sfs, opts.root)) {
    if (await consider(d.name, d.abs, d.name)) continue;
    for (const e of await childDirs(sfs, d.abs)) await consider(e.name, e.abs, `${d.name}/${e.name}`);
  }
  return [...byKey.values()].map(({ real: _real, ...p }) => p).sort((a, b) => a.source_ref.localeCompare(b.source_ref));
}

/**
 * The project a source ref names, by the same identity the listing uses:
 * `Low-Quality/Mafia-King` on a case-insensitive disk, or a junction alias,
 * resolves to the film's canonical entry (its own folder, its own ref), so
 * one film can never become two titles for one company (spec §3.2). Null
 * when the ref is not a project folder under the root.
 */
export async function resolveProject(sourceRef: string, opts: ScanOptions): Promise<Project | null> {
  const sfs = opts.fs ?? nodeScanFs;
  const abs = workspacePath(opts.root, sourceRef);
  if (!(await isDir(sfs, abs))) return null;
  let real: string;
  try {
    real = foldFor(opts)(await sfs.realpath(abs));
  } catch {
    return null;
  }
  return (await listProjects(opts)).find((p) => p.realpath === real) ?? null;
}

// ---- one film -----------------------------------------------------------------------------------

/** `mafia-king` → `Mafia King`; the display title when no film-meta names one. */
export function titleFromFolder(folder: string): string {
  return folder
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function firstLine(e: unknown): string {
  return String((e as Error)?.message ?? e).split("\n")[0];
}

/** The language whisper detected, read cheaply off the head of `index/whisper.json` (the key is first in the file). */
async function whisperLanguage(sfs: ScanFs, cutDir: string): Promise<string | null> {
  const file = path.join(cutDir, "index", "whisper.json");
  if (!(await sfs.stat(file))) return null;
  const text = stripBom(await sfs.readFile(file));
  const m = text.slice(0, 2048).match(/"language"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  try {
    const lang = (JSON.parse(text) as { language?: unknown }).language;
    return typeof lang === "string" ? lang : null;
  } catch {
    return null;
  }
}

async function probeViaLink(sfs: ScanFs, opts: ScanOptions, original: string, folder: string, warnings: string[]): Promise<ScannedVideo | null> {
  if (!opts.probe || !opts.linkDir) return null;
  await sfs.mkdir(opts.linkDir);
  const link = path.join(opts.linkDir, `probe-${folder}-${randomUUID()}.mp4`);
  try {
    try {
      await sfs.link(original, link);
    } catch (e) {
      // A copy holds the original open for its whole length; only another volume justifies it (EXDEV). Anything else is a warning, not a read of the original.
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      await sfs.copy(original, link);
    }
    const r = await opts.probe(link);
    if (!r) return null;
    return { width: r.width, height: r.height, fps: r.fps, duration_s: r.duration_s ?? null, from: "probe" };
  } catch (e) {
    warnings.push(`probe: ${firstLine(e)}`);
    return null;
  } finally {
    await sfs.remove(link).catch(() => undefined);
  }
}

// ---- the pipeline stage (plan B1, "artifact-derived stage") -----------------------------------------

export const EMPTY_ARTIFACTS: PipelineArtifacts = {
  source: false,
  source_facts: false,
  watermark: false,
  unmark: false,
  whisper: false,
  scdet: false,
  motion: false,
  candidates: false,
  skips: false,
  options: false,
  options_applied: false,
  choices: false,
  plan: false,
  delivered: false,
  parts: false,
};

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** True when `cut/cuts.json` is the plan the newest DELIVERED file records: the same episode windows and the same skips (formatting aside). */
export function planMatchesDelivered(plan: DeliveredPlan, delivered: DeliveredPlan): boolean {
  if (plan.episodes.length !== delivered.episodes.length || plan.skips.length !== delivered.skips.length) return false;
  if (!plan.episodes.every((e, i) => near(e.start, delivered.episodes[i].start, 0.0015) && near(e.end, delivered.episodes[i].end, 0.0015))) return false;
  return plan.skips.every((s, i) => near(s[0], delivered.skips[i][0], 0.0015) && near(s[1], delivered.skips[i][1], 0.0015));
}

/**
 * True when the plan already carries every choice of `review/choices.json`
 * (`pick_cuts.py --choices` ran after apply_vision): each chosen time is an
 * episode end, the film's end, or the `from` of a move the plan declares (a
 * QA re-pin moved the boundary on after it was chosen — He Hated All Women's
 * 3276.333 → 3278.3). False when there is no plan.
 */
export function choicesConsumed(choices: Record<string, number>, plan: DeliveredPlan | null): boolean {
  if (!plan) return false;
  const ends = plan.episodes.map((e) => e.end);
  return Object.values(choices).every((t) => ends.some((e) => near(e, t, 0.002)) || plan.moves.some((m) => near(m.from, t, 0.05)));
}

export type StageFacts = {
  artifacts: PipelineArtifacts;
  /** `cut/cuts.json`, parsed, when it is there and parses. */
  plan: DeliveredPlan | null;
  /** The newest DELIVERED plan, parsed, when it is there and parses. */
  delivered: DeliveredPlan | null;
  /** `review/choices.json` when it is there and parses. */
  choices: Record<string, number> | null;
  /** The first `.part` file in `eps/`, when a render is writing. */
  part: string | null;
  /** A write in `eps/` inside the quiet period (the scanner's own rule), as its file name. */
  recentWrite: string | null;
  /** The disk-only import state: READY means the delivered files are exactly 1..N. */
  ready: boolean;
};

/** The stage the artifacts say, newest step first, with the file that decided it (see PipelineStage). Pure; the scanner feeds it. */
export function pipelineStageOf(f: StageFacts): { stage: PipelineStage; note: string | null } {
  const a = f.artifacts;
  if (f.part) return { stage: "RENDERING", note: `eps/${f.part} is being written` };
  if (a.options && !a.options_applied) return { stage: "OPTIONS_READY", note: "review/options.json is not applied: a vision pass is due" };
  if (f.choices && !choicesConsumed(f.choices, f.plan)) return { stage: "JUDGED", note: f.plan ? "review/choices.json is not in cut/cuts.json yet" : "review/choices.json waits for pick_cuts.py --choices" };
  if (f.plan) {
    if (!f.delivered) return { stage: "PLANNED", note: "cut/cuts.json has no DELIVERED render yet" };
    if (!planMatchesDelivered(f.plan, f.delivered)) return { stage: "PLANNED", note: "cut/cuts.json differs from the newest DELIVERED plan" };
    if (f.recentWrite) return { stage: "RENDERING", note: `eps/${f.recentWrite} was written inside the quiet period` };
    if (f.ready) return { stage: "DELIVERED", note: null };
    return { stage: "PLANNED", note: "the DELIVERED plan's episode files are not complete: render again" };
  }
  if (f.delivered) {
    if (f.recentWrite) return { stage: "RENDERING", note: `eps/${f.recentWrite} was written inside the quiet period` };
    return f.ready ? { stage: "DELIVERED", note: null } : { stage: "PLANNED", note: "the DELIVERED plan's episode files are not complete: render again" };
  }
  if (a.options) return { stage: "OPTIONS_READY", note: "review/options.json is applied but no choices.json followed" };
  if (a.candidates) return { stage: "INDEXED", note: null };
  if (a.source || a.source_facts || a.whisper || a.scdet || a.motion || a.watermark) return { stage: "NOT_INDEXED", note: a.source ? "index/candidates.json is missing" : "no source/*.mp4; an index was started" };
  return { stage: "NO_SOURCE", note: "no source/*.mp4" };
}

/** True when a `review/options.json` text carries apply_vision.py's `applied` stamp (a cheap regex; the file is ~300 KB and the stamp is its last key). */
export function optionsApplied(text: string): boolean {
  return /"applied"\s*:\s*\{/.test(text);
}

async function readSmallJson(sfs: ScanFs, file: string): Promise<unknown> {
  return JSON.parse(stripBom(await sfs.readFile(file)));
}

/** The film's source video: `source/original.mp4` (the pipeline's name), else any `.mp4` in `source/`. */
async function hasSource(sfs: ScanFs, filmDir: string): Promise<boolean> {
  const dir = path.join(filmDir, "source");
  if (!(await isDir(sfs, dir))) return false;
  if (await sfs.stat(path.join(dir, "original.mp4"))) return true;
  return (await sfs.readdir(dir)).some((e) => e.kind === "file" && /\.mp4$/i.test(e.name));
}

function choosePoster(posters: string[], meta: FilmMeta | null): string | null {
  if (!posters.length) return null;
  const want = meta?.live_poster?.toLowerCase();
  if (want) {
    const hit = posters.find((p) => path.posix.basename(p).replace(/\.[^.]+$/, "").toLowerCase() === want);
    if (hit) return hit;
  }
  return posters[0];
}

/** Scan one project folder. `sourceRef` is `<folder>` or `<bucket>/<folder>`. */
export async function scanFilm(sourceRef: string, opts: ScanOptions): Promise<FilmScan> {
  const sfs = opts.fs ?? nodeScanFs;
  const now = opts.now ?? Date.now;
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const root = opts.root;
  const abs = path.join(root, ...sourceRef.split("/"));
  const folder = sourceRef.split("/").pop() ?? sourceRef;
  const cutDir = path.join(abs, "cut");
  const warnings: string[] = [];
  const ignored: string[] = [];

  const posters = await listPosters(sfs, root, abs);
  let meta: FilmMeta | null = null;
  const metaFile = path.join(cutDir, "film-meta.json");
  if (await sfs.stat(metaFile)) {
    try {
      meta = parseFilmMeta(JSON.parse(stripBom(await sfs.readFile(metaFile))));
    } catch (e) {
      warnings.push(`cut/film-meta.json: ${firstLine(e)}`);
    }
  }

  const artifacts: PipelineArtifacts = { ...EMPTY_ARTIFACTS, source: await hasSource(sfs, abs) };
  const facts: StageFacts = { artifacts, plan: null, delivered: null, choices: null, part: null, recentWrite: null, ready: false };

  const scan: FilmScan = {
    source_ref: sourceRef,
    folder,
    display_title: meta?.display_title_en ?? titleFromFolder(folder),
    state: "NO_MANIFEST",
    reason: null,
    pipeline_stage: "NO_SOURCE",
    pipeline_note: null,
    pipeline: artifacts,
    episodes: [],
    delivered: null,
    totals: { count: 0, bytes: 0 },
    video: null,
    language: meta?.language ?? null,
    poster: choosePoster(posters, meta),
    posters,
    meta,
    ignored,
    warnings,
  };
  const done = (state: FilmScan["state"], reason: ScanReason | null): FilmScan => {
    facts.ready = state === "READY";
    const staged = pipelineStageOf(facts);
    return { ...scan, state, reason, pipeline_stage: staged.stage, pipeline_note: staged.note, pipeline: { ...artifacts } };
  };

  if (!(await isDir(sfs, cutDir))) return done("NO_MANIFEST", { code: "no_cut_dir" });

  // The pipeline's artifacts: presence only, plus the three small files the stage turns on.
  const present = async (rel: string) => !!(await sfs.stat(path.join(cutDir, ...rel.split("/"))));
  artifacts.source_facts = await present("index/source.json");
  artifacts.watermark = await present("index/watermark.json");
  artifacts.unmark = await present("index/unmark/mark_model.json");
  artifacts.whisper = await present("index/whisper.json");
  artifacts.scdet = await present("index/scdet.txt");
  artifacts.motion = await present("index/motion.json");
  artifacts.candidates = await present("index/candidates.json");
  artifacts.skips = await present("index/skips.json");
  if (await present("review/options.json")) {
    artifacts.options = true;
    try {
      artifacts.options_applied = optionsApplied(await sfs.readFile(path.join(cutDir, "review", "options.json")));
    } catch (e) {
      warnings.push(`review/options.json: ${firstLine(e)}`);
    }
  }
  if (await present("review/choices.json")) {
    artifacts.choices = true;
    try {
      const raw = await readSmallJson(sfs, path.join(cutDir, "review", "choices.json"));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not an object of boundary -> time");
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`choice ${k} is not a time`);
        out[k] = v;
      }
      facts.choices = out;
    } catch (e) {
      warnings.push(`review/choices.json: ${firstLine(e)}`);
    }
  }
  if (await present("cuts.json")) {
    artifacts.plan = true;
    try {
      facts.plan = parseDeliveredPlan(await readSmallJson(sfs, path.join(cutDir, "cuts.json")));
    } catch (e) {
      warnings.push(`cut/cuts.json: ${firstLine(e)}`);
    }
  }

  // The episode files: names and stats only.
  const epsDir = path.join(cutDir, "eps");
  const parts: string[] = [];
  let placeholder: string | null = null;
  let newestWrite: { name: string; mtime_ms: number } | null = null;
  const byNumber = new Map<number, ScannedEpisode[]>();
  if (await isDir(sfs, epsDir)) {
    for (const e of await sfs.readdir(epsDir)) {
      if (e.kind === "dir") continue;
      const file = path.join(epsDir, e.name);
      const st = await sfs.stat(file);
      if (!st || st.is_directory) continue;
      if (!newestWrite || st.mtime_ms > newestWrite.mtime_ms) newestWrite = { name: e.name, mtime_ms: st.mtime_ms };
      if (isPartialFile(e.name)) {
        parts.push(e.name);
        continue;
      }
      const n = parseWorkspaceEpisodeFile(e.name);
      if (n === null) {
        ignored.push(e.name);
        continue;
      }
      if (st.size >= PLACEHOLDER_MIN_BYTES && st.blocks === 0) placeholder = placeholder ?? e.name;
      const row: ScannedEpisode = { n, file: `${sourceRef}/cut/eps/${e.name}`, name: e.name, bytes: st.size, mtime_ms: st.mtime_ms };
      byNumber.set(n, [...(byNumber.get(n) ?? []), row]);
    }
  }
  parts.sort();
  ignored.sort();
  artifacts.parts = parts.length > 0;
  facts.part = parts[0] ?? null;
  if (quietMs > 0 && newestWrite && now() - newestWrite.mtime_ms < quietMs) facts.recentWrite = newestWrite.name;
  scan.episodes = [...byNumber.values()].flat().sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  scan.totals = { count: scan.episodes.length, bytes: scan.episodes.reduce((s, e) => s + e.bytes, 0) };

  // Language, pixel size.
  if (!scan.language) scan.language = await whisperLanguage(sfs, cutDir).catch(() => null);
  const sourceFile = path.join(cutDir, "index", "source.json");
  if (await sfs.stat(sourceFile)) {
    try {
      const s = parseSourceFacts(JSON.parse(stripBom(await sfs.readFile(sourceFile))));
      scan.video = { width: s.width, height: s.height, fps: s.fps, duration_s: s.duration, from: "source.json" };
    } catch (e) {
      warnings.push(`index/source.json: ${firstLine(e)}`);
    }
  }
  if (!scan.video && scan.episodes.length) {
    scan.video = await probeViaLink(sfs, opts, path.join(epsDir, scan.episodes[0].name), folder, warnings);
  }

  // The plan.
  const review = path.join(cutDir, "review");
  const reviewNames = (await isDir(sfs, review)) ? (await sfs.readdir(review)).filter((d) => d.kind === "file").map((d) => d.name) : [];
  const newest = pickNewestDelivered(reviewNames);
  if (!newest) return done("NOT_DELIVERED", { code: "no_delivered" });
  artifacts.delivered = true;
  try {
    const bytes = await sfs.readBytes(path.join(review, newest.file));
    const plan = parseDeliveredPlan(JSON.parse(stripBom(Buffer.from(bytes).toString("utf8"))));
    scan.delivered = { file: `review/${newest.file}`, end: newest.end, count: plan.episodes.length, sha256: sha256Hex(bytes), plan };
    facts.delivered = plan;
  } catch (e) {
    return done("NO_MANIFEST", { code: "bad_delivered", file: `review/${newest.file}`, detail: firstLine(e) });
  }

  // READY, or why not (spec §3.3).
  if (parts.length) return done("RENDERING", { code: "part_file", file: parts[0] });
  if (newestWrite && facts.recentWrite) {
    return done("RENDERING", { code: "recent_write", file: newestWrite.name, seconds_ago: Math.max(0, Math.round((now() - newestWrite.mtime_ms) / 1000)) });
  }
  if (placeholder) return done("NOT_DELIVERED", { code: "placeholder", file: placeholder });
  if (!scan.episodes.length) return done("NOT_DELIVERED", { code: "no_episode_files" });
  const maxN = Math.max(...byNumber.keys());
  const missing: number[] = [];
  for (let n = 1; n <= maxN; n++) if (!byNumber.has(n)) missing.push(n);
  const duplicates = [...byNumber.entries()].filter(([, rows]) => rows.length > 1).map(([n]) => n);
  if (missing.length || duplicates.length) return done("NOT_DELIVERED", { code: "episode_gap", missing, duplicates });
  if (maxN !== scan.delivered.count) return done("NOT_DELIVERED", { code: "count_mismatch", planned: scan.delivered.count, found: maxN });
  return done("READY", null);
}

/** Every project under the root, scanned, in path order. */
export async function scanWorkspace(opts: ScanOptions): Promise<FilmScan[]> {
  const out: FilmScan[] = [];
  for (const p of await listProjects(opts)) out.push(await scanFilm(p.source_ref, opts));
  return out;
}

/** What the caller has stored for a film it imported: the plan's hash and, optionally, each episode's file size. */
export type StoredImport = { delivered_sha256: string; episodes?: { n: number; bytes: number }[] };

/**
 * The two states only the caller can decide: a READY film that is already
 * imported from the same plan and the same files is IMPORTED; one whose plan
 * hash or file sizes moved since is K_CHANGED (update). Anything not READY
 * is returned as it is.
 */
export function applyImportState(scan: FilmScan, stored: StoredImport | null): FilmScan {
  if (scan.state !== "READY" || !stored || !scan.delivered) return scan;
  if (stored.delivered_sha256 !== scan.delivered.sha256) return { ...scan, state: "K_CHANGED", reason: { code: "plan_changed" } };
  if (stored.episodes) {
    const size = new Map(stored.episodes.map((e) => [e.n, e.bytes]));
    const changed = scan.episodes.filter((e) => size.get(e.n) !== e.bytes).map((e) => e.n);
    if (changed.length) return { ...scan, state: "K_CHANGED", reason: { code: "files_changed", episodes: changed } };
  }
  return { ...scan, state: "IMPORTED", reason: { code: "imported" } };
}

/** The workspace path of a source ref (for the import's hardlink source; never for reading). */
export function workspacePath(root: string, sourceRef: string): string {
  return path.join(root, ...sourceRef.split("/"));
}

/** The pipeline stage of one film, read from its artifacts (the scan without the import state). */
export async function pipelineStage(sourceRef: string, opts: ScanOptions): Promise<{ stage: PipelineStage; note: string | null; artifacts: PipelineArtifacts }> {
  const s = await scanFilm(sourceRef, opts);
  return { stage: s.pipeline_stage, note: s.pipeline_note, artifacts: s.pipeline };
}

export { toSourceRef };
