// Intake (plan B2, stage 0): the server-side source picker and the stage
// that turns a picked file into a film folder the pipeline can work in.
//
// The picker lists video files under a few folders Studio may read from —
// the person's Downloads, OneDrive's "Mini Drama", the workspace itself (a
// film already on disk, or the fixture films under the fake pipeline) and
// anything named in STUDIO_SOURCE_ROOTS — and a typed path is accepted only
// inside one of them: a browser never uploads a multi-GB file (decision 6),
// and a route never reads an arbitrary path either.
//
// The stage: parse the `_Media_<id>_<nnn>_<height>p.mp4` name the
// downloader gives a file, ffprobe it, refuse a landscape source (the
// cut-only route has no reframe; asking is the pipeline's rule), refuse a
// OneDrive placeholder (a file with no allocated blocks), warn under 720p,
// hardlink (or copy across volumes) into `<film>/source/original.mp4`, sync
// the cut-only scripts into `cut/scripts/`, run `checks.py --project .
// --strict`, and record the drama-remix commit on the run row.
//
// A film folder that is already there is Studio's to drive only when a
// Studio run made it (`cut/.studio-scripts.json`) or the run claims it in so
// many words (`settings.claim_existing`, a checkbox on the intake): B0 says
// "only a folder it created or explicitly claimed", and a session's folder
// taken over quietly would have its scripts overwritten and its review
// re-applied. A folder the scanner reads as delivered, ready or imported is
// never cut again by a plain run; `settings.extend` is the explicit way to
// cut the rest of a first proof under its pinned episodes. The same check
// runs twice: at create time (`createRun`, so a refused run never has a
// row) and here, before the run lock is taken, so a refused folder is never
// written into, not even the lock file.

import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { invalid } from "@/lib/data/errors";
import { importQuietMs, type VideoFacts } from "@/lib/film-import/import";
import { scanFilm } from "@/lib/film-import/scan";
import type { FilmScan } from "@/lib/film-import/types";
import { LockHeldError, STUDIO_RUN_LOCK_FILE } from "@/lib/locks";
import { readSyncRecord, ScriptsSyncError } from "@/lib/segment/scripts-sync";
import type { FilmRun } from "@/lib/types";
import { fail, fakePipeline, filmRoot, newestDelivered, next, refusalOf, runStep, sourceRefOf, type Env, type StageContext, type StageOutcome } from "./stages";

// ---- the file name --------------------------------------------------------------------------------------------

/** `…_Media_<11-char video id>_<nnn>_<height>p.mp4`, as the downloader names a file. */
export const MEDIA_NAME = /_Media_([A-Za-z0-9_-]{11})_(\d{3})_(\d+)p\.mp4$/i;

export type MediaName = { video_id: string; part: number; height_p: number };

export function parseMediaName(name: string): MediaName | null {
  const m = MEDIA_NAME.exec(path.basename(name));
  return m ? { video_id: m[1], part: Number(m[2]), height_p: Number(m[3]) } : null;
}

/** A slug suggestion from a downloader name: the title words between the site prefix and `_Media_`, lowercased and hyphenated. */
export function suggestSlug(name: string): string {
  const base = path.basename(name).replace(/\.mp4$/i, "");
  const cut = base.indexOf("_Media_");
  let title = cut >= 0 ? base.slice(0, cut) : base;
  title = title.replace(/^YTDown\.com_YouTube_/i, "").replace(/^(FULL|Full)-/, "");
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  return slug || "film";
}

// ---- the picker's roots ---------------------------------------------------------------------------------------

export type SourceRoot = { key: string; label: string; path: string; exists: boolean };

const VIDEO_FILE = /\.(mp4|m4v|mov|mkv)$/i;

/** Windows' OneDrive folder: the OneDrive / OneDriveConsumer variables, else ~/OneDrive. */
function oneDriveDir(env: Env): string {
  const configured = env.OneDrive?.trim() || env.OneDriveConsumer?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), "OneDrive");
}

/** The folders a source may be picked from, in the order the picker shows them. */
export function sourceRoots(env: Env = process.env): SourceRoot[] {
  const roots: SourceRoot[] = [
    { key: "downloads", label: "Downloads", path: path.join(homedir(), "Downloads"), exists: false },
    { key: "onedrive", label: "OneDrive / Mini Drama", path: path.join(oneDriveDir(env), "Mini Drama"), exists: false },
  ];
  const ws = env.WORKSPACE_ROOT?.trim();
  if (ws) roots.push({ key: "workspace", label: "Workspace (films already on disk)", path: path.resolve(ws), exists: false });
  const extra = env.STUDIO_SOURCE_ROOTS?.trim();
  if (extra) {
    for (const [i, p] of extra.split(path.delimiter).map((s) => s.trim()).filter(Boolean).entries()) {
      roots.push({ key: `extra${i + 1}`, label: p, path: path.resolve(p), exists: false });
    }
  }
  if (fakePipeline(env)) {
    const fake = filmRoot(env);
    if (fake) roots.push({ key: "fake", label: "Fake workspace", path: fake, exists: false });
  }
  return roots.map((r) => ({ ...r, exists: isDir(r.path) }));
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

function under(root: string, abs: string): boolean {
  const rel = path.relative(fold(root), fold(abs));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The folder the picker lists for `dir`: a root's key (`downloads`), or an
 * absolute path inside one of the roots. Anything else is refused (invalid).
 */
export function resolveSourceDir(dir: string, env: Env = process.env): string {
  const roots = sourceRoots(env);
  const byKey = roots.find((r) => r.key === dir.trim().toLowerCase());
  if (byKey) return byKey.path;
  return resolveSourcePath(dir, env);
}

/** A typed absolute path, allowed only under one of the roots. */
export function resolveSourcePath(typed: string, env: Env = process.env): string {
  const raw = typed.trim().replace(/^"|"$/g, "");
  if (!raw || !path.isAbsolute(raw)) throw invalid("a source is an absolute path, or one of the picker's folders");
  const abs = path.resolve(raw);
  const roots = sourceRoots(env);
  if (!roots.some((r) => under(r.path, abs))) {
    throw invalid(`${abs} is outside the folders Studio may read a source from (${roots.map((r) => r.label).join(", ")}; add a folder with STUDIO_SOURCE_ROOTS)`);
  }
  return abs;
}

export type SourceEntry = {
  path: string;
  name: string;
  bytes: number;
  mtime: string;
  /** A cloud placeholder: bytes on record, no blocks on disk — opening it once makes OneDrive download it. */
  placeholder: boolean;
  parsed: MediaName | null;
  suggested_slug: string;
  probe?: { width: number; height: number; fps: number; duration_s: number | null } | null;
};

export type SourceListing = { dir: string; roots: SourceRoot[]; folders: { name: string; path: string }[]; entries: SourceEntry[] };

/** True for a file OneDrive keeps only in the cloud (the scanner's rule: no allocated blocks and not tiny). */
export function isPlaceholder(st: { size: number; blocks?: number | null }): boolean {
  return st.size >= 4096 && st.blocks === 0;
}

/** The video files (and sub-folders) directly inside `dir`, newest first; `probe` adds ffprobe facts per file. */
export async function listSources(dir: string, opts: { env?: Env; probe?: ((file: string) => Promise<VideoFacts | null>) | null } = {}): Promise<SourceListing> {
  const env = opts.env ?? process.env;
  const abs = resolveSourceDir(dir, env);
  const roots = sourceRoots(env);
  const folders: SourceListing["folders"] = [];
  const entries: SourceEntry[] = [];
  let names: import("node:fs").Dirent[] = [];
  try {
    names = readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    throw invalid(`${abs}: ${(e as Error).message}`);
  }
  for (const d of names) {
    if (d.name.startsWith(".")) continue;
    const p = path.join(abs, d.name);
    if (d.isDirectory()) {
      folders.push({ name: d.name, path: p });
      continue;
    }
    if (!d.isFile() || !VIDEO_FILE.test(d.name)) continue;
    let st: import("node:fs").Stats;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    const entry: SourceEntry = {
      path: p,
      name: d.name,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      placeholder: isPlaceholder({ size: st.size, blocks: typeof st.blocks === "number" ? st.blocks : null }),
      parsed: parseMediaName(d.name),
      suggested_slug: suggestSlug(d.name),
    };
    if (opts.probe && !entry.placeholder) {
      const f = await opts.probe(p);
      entry.probe = f ? { width: f.width, height: f.height, fps: f.fps, duration_s: f.duration_s } : null;
    }
    entries.push(entry);
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  entries.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { dir: abs, roots, folders, entries };
}

// ---- an existing film folder -------------------------------------------------------------------------------------

export type FolderFacts = {
  /** `<film>/cut` is there. */
  cut_exists: boolean;
  /** `cut/.studio-scripts.json` is there: a Studio run made (or claimed) this folder before. */
  studio_made: boolean;
  /** The phase-1 scanner's reading of the folder, when `cut` exists. */
  scan: Pick<FilmScan, "state" | "pipeline_stage"> | null;
  /** A title of the run's company was already imported from the folder. */
  imported: boolean;
};

/** True when the folder holds a finished cut: the scanner reads it delivered or ready, or a title was imported from it. */
export function folderDelivered(facts: Pick<FolderFacts, "scan" | "imported">): boolean {
  if (facts.imported) return true;
  const s = facts.scan;
  return !!s && (s.pipeline_stage === "DELIVERED" || s.state === "READY" || s.state === "IMPORTED" || s.state === "K_CHANGED");
}

/**
 * Why the run may not drive an existing film folder, or null when it may.
 * Pure (decision 2026-09-23, B0): a folder no Studio run made needs
 * `settings.claim_existing`; a delivered, ready or imported film needs
 * `settings.extend`, which cuts the stretch past its pinned episodes.
 */
export function existingFolderRefusal(run: Pick<FilmRun, "bucket" | "slug" | "settings">, facts: FolderFacts): string | null {
  if (!facts.cut_exists) return null;
  const ref = sourceRefOf(run);
  if (!facts.studio_made && run.settings.claim_existing !== true) {
    return `${ref}/cut already exists and no Studio run made it (no cut/.studio-scripts.json): a session's work. Start the run with "take over an existing folder" to claim it in so many words, or choose another slug.`;
  }
  if (folderDelivered(facts) && run.settings.extend !== true) {
    const what = facts.imported ? "imported as a title" : `${facts.scan?.pipeline_stage ?? "delivered"} (${facts.scan?.state ?? "?"})`;
    return `${ref} is ${what}: a delivered film is not cut again. Start the run with "extend a delivered film" to cut the rest under its pinned episodes, or choose another slug.`;
  }
  return null;
}

/** True when `cut/` holds anything besides a run's lock file (a restarted run of Studio's own re-takes its lock; a bare lock left by a dead worker is not a session's work). */
export function cutFolderInUse(cutDir: string): boolean {
  try {
    return readdirSync(cutDir).some((n) => n !== STUDIO_RUN_LOCK_FILE && !n.startsWith(`${STUDIO_RUN_LOCK_FILE}.`));
  } catch {
    return false;
  }
}

/** The facts `existingFolderRefusal` judges, read from disk and the data layer; `createRun` calls it before the row exists, with no runner. */
export async function folderFactsOf(ctx: Pick<StageContext, "dirs" | "data" | "session" | "env"> & { run: Pick<FilmRun, "producer_id" | "bucket" | "slug">; runner?: Pick<StageContext["runner"], "fake"> }): Promise<FolderFacts> {
  const { run, dirs } = ctx;
  const cutExists = cutFolderInUse(dirs.cut);
  if (!cutExists) return { cut_exists: false, studio_made: false, scan: null, imported: false };
  const ref = sourceRefOf(run);
  const quiet = ctx.runner?.fake || fakePipeline(ctx.env) ? 0 : importQuietMs();
  const scan = await scanFilm(ref, { root: dirs.root, ...(quiet !== undefined ? { quietMs: quiet } : {}) })
    .then((s) => ({ state: s.state, pipeline_stage: s.pipeline_stage }))
    .catch(() => null);
  const imported = !!(await ctx.data.findTitleBySourceRef(ctx.session, run.producer_id, ref).catch(() => null));
  return { cut_exists: true, studio_made: readSyncRecord(dirs.cut) !== null, scan, imported };
}

// ---- the stage ---------------------------------------------------------------------------------------------------

/** Link `src` to `dst` on the same volume; copy through a `.part` name across volumes (EXDEV only); anything else throws. */
export function linkOrCopy(src: string, dst: string): "linked" | "copied" {
  mkdirSync(path.dirname(dst), { recursive: true });
  try {
    linkSync(src, dst);
    return "linked";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  const part = `${dst}.part`;
  rmSync(part, { force: true });
  copyFileSync(src, part);
  renameSync(part, dst);
  return "copied";
}

export async function runIntakeStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const src = run.source_path.replace(/\//g, path.sep);
  const warnings: string[] = [];

  // 1. The picked file: there, downloaded, a video.
  let st: import("node:fs").Stats;
  try {
    st = statSync(src);
  } catch {
    return fail(`the source ${run.source_path} is not there any more; pick it again`);
  }
  if (!st.isFile()) return fail(`the source ${run.source_path} is not a file`);
  if (isPlaceholder({ size: st.size, blocks: typeof st.blocks === "number" ? st.blocks : null })) {
    return fail(`${run.source_path} is a OneDrive placeholder (${st.size} bytes on record, nothing on disk): open it once so OneDrive downloads it, then retry`);
  }
  const parsed = parseMediaName(src);
  if (!parsed) warnings.push(`the file name does not follow the _Media_<id>_<nnn>_<height>p.mp4 pattern; nothing is read from it`);

  const facts = await ctx.runner.probe(src);
  if (!facts) return fail(`ffprobe could not read ${run.source_path}: not a video Studio can open (FFPROBE_PATH / FFMPEG_PATH name the binary)`);
  if (facts.width > facts.height) {
    return fail(
      `${path.basename(src)} is landscape (${facts.width}×${facts.height}): the cut-only route assumes a vertical 9:16 source and has no reframe step. Say whether this film should go through the narrated route's reframe, or pick the vertical file.`
    );
  }
  if (facts.height < 720) warnings.push(`the source is ${facts.width}×${facts.height}, under 720p; the episodes will be too`);

  // 2. The film folder: created, or an existing one driven only when Studio made it or the run claims it, and never a
  //    delivered film unless the run extends it (B0: only a folder Studio created or explicitly claimed).
  const folder = await folderFactsOf(ctx);
  const refusal = existingFolderRefusal(run, folder);
  if (refusal) return fail(refusal, { folder: { claimed: false, studio_made: folder.studio_made, scan: folder.scan, imported: folder.imported } });
  const claimed = folder.cut_exists && !folder.studio_made;
  const extending = folder.cut_exists && folderDelivered(folder);
  if (claimed) ctx.log(`claiming ${sourceRefOf(run)}: cut/ exists with no Studio record (settings.claim_existing)`);
  if (extending) ctx.log(`extending ${sourceRefOf(run)}: ${folder.scan?.pipeline_stage ?? "delivered"} (${folder.scan?.state ?? "?"}), pinned to ${newestDelivered(dirs.cut)?.file ?? "no DELIVERED file"} (settings.extend)`);
  // The folder is the run's: only now is cut/.studio-run.json written (it creates cut/ when the film is new).
  try {
    ctx.lock();
  } catch (e) {
    if (e instanceof LockHeldError) return fail(e.message);
    throw e;
  }
  mkdirSync(path.dirname(dirs.source), { recursive: true });
  mkdirSync(dirs.cut, { recursive: true });
  mkdirSync(dirs.work, { recursive: true });
  let placed: "linked" | "copied" | "existing";
  if (existsSync(dirs.source)) {
    const have = statSync(dirs.source);
    if (have.size !== st.size) {
      return fail(`${dirs.source} already exists with a different size (${have.size} bytes there, ${st.size} picked): this folder belongs to another film or an earlier import. Choose another slug, or pick that file.`);
    }
    placed = "existing";
  } else {
    try {
      placed = linkOrCopy(src, dirs.source);
    } catch (e) {
      return fail(`could not place the source at ${dirs.source}: ${(e as Error).message}`);
    }
  }
  ctx.log(`source ${placed}: ${dirs.source} (${facts.width}×${facts.height} @ ${facts.fps} fps${facts.duration_s ? `, ${Math.round(facts.duration_s)} s` : ""})`);
  await ctx.progress({ source: { path: run.source_path, placed, bytes: st.size, width: facts.width, height: facts.height, fps: facts.fps, duration_s: facts.duration_s, frames: facts.frames, parsed: parsed as unknown as Record<string, number | string> | null }, warnings });

  // 3. The scripts, from the drama-remix checkout, and the commit they came from.
  let sync;
  try {
    sync = ctx.runner.sync(dirs.cut, { allowDirty: run.settings.allow_dirty === true });
  } catch (e) {
    if (e instanceof ScriptsSyncError) return fail(e.message, { sync_refused: e.code });
    return fail(`could not sync the cut-only scripts: ${(e as Error).message}`);
  }
  ctx.log(`scripts synced from ${sync.source} @ ${sync.sha.slice(0, 12)}${sync.dirty ? " (dirty tree, allowed)" : ""}: ${sync.files.length} files`);

  // 4. The pipeline's own audit of the copy.
  const checks = await runStep(ctx, { script: "checks.py", args: ["--project", ".", "--strict"], what: "checks --strict" });
  if (checks.code !== 0) return fail(refusalOf({ script: "checks.py", args: [], what: "" }, checks));

  return next(
    "watermark",
    {
      source: { path: run.source_path, placed, bytes: st.size, width: facts.width, height: facts.height, fps: facts.fps, duration_s: facts.duration_s, frames: facts.frames, parsed: parsed as unknown as Record<string, number | string> | null },
      warnings,
      scripts: { sha: sync.sha, dirty: sync.dirty, files: sync.files.length, source: sync.source },
      folder: { existed: folder.cut_exists, claimed, extending: extending ? newestDelivered(dirs.cut)?.file ?? true : false, scan: folder.scan, imported: folder.imported },
    },
    { drama_remix_sha: sync.sha, drama_remix_dirty: sync.dirty }
  );
}
