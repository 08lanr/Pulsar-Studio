// Sync the pipeline's cut-only scripts into a film (decision 2026-09-23,
// "segment a film in Studio"; drama-remix scripts/cut-only/README.md,
// "Starting a new film" and "Running under Pulsar Studio"): copy
// `<drama-remix>/scripts/cut-only/*` — every file, the `.route` dotfile
// included, `__pycache__` left out — into `<film>/cut/scripts/`, exactly as
// `cp -r <skill>/scripts/cut-only/. cut/scripts/` does, and record which
// commit the copy came from. Studio runs the film's own copy (the pipeline's
// scripts resolve index/, review/ and eps/ against the cut/ folder) and the
// run row remembers `drama_remix_sha` + `drama_remix_dirty`.
//
// The narrated route (decision 2026-09-23 "Narrated mode in Studio"; narrated
// spec N1 intake) syncs `<drama-remix>/scripts/skip-through/*` the same way
// into `<film>/scripts/` — the skip-through scripts find their project root
// from their own location, so the copy sits at the film root, not in a cut/
// folder — with the record at `<film>/.studio-scripts.json`. That folder has
// no `.route` file yet (checks.py reads a missing one as skip-through), and
// its record carries a SHA-256 per file: the prep brief Studio fills is READ
// from the synced PREP-BRIEF.md, and the brief's sha names the text it came from;
// `verifySyncedScripts` re-hashes the copy against it before Studio runs or
// compiles anything from it (a writing session can write there).
//
// A dirty working tree (`git status --porcelain` lists anything) is refused
// unless the run's settings say `allow_dirty`: a session edited a script and
// did not commit, and a build from a copy no commit describes cannot be
// reproduced. The record beside the copy, `cut/.studio-scripts.json`, is NOT
// inside scripts/ — `checks.py --project . --strict` flags any extra file
// there as drift.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dramaRemixRoot } from "@/lib/python";

export const CUT_ONLY_SCRIPTS = path.join("scripts", "cut-only");
export const SKIP_THROUGH_SCRIPTS = path.join("scripts", "skip-through");

/** Which of the pipeline's routes a copy is: the folder it is synced from. */
export type ScriptsRoute = "cut-only" | "skip-through";

const ROUTE_DIR: Record<ScriptsRoute, string> = { "cut-only": CUT_ONLY_SCRIPTS, "skip-through": SKIP_THROUGH_SCRIPTS };
export const SYNC_RECORD_FILE = ".studio-scripts.json";

// The checkout is named by lib/python.ts's `dramaRemixRoot()` (DRAMA_REMIX_ROOT, else beside WORKSPACE_ROOT's parent, else the sibling checkout); this module checks it is a git checkout with the scripts.
export { dramaRemixRoot };

export type RepoState = {
  /** HEAD's commit, 40 hex. */
  sha: string;
  /** True when `git status --porcelain` listed anything (modified, staged or untracked). */
  dirty: boolean;
  /** The porcelain lines, as git printed them (`" M scripts/cut-only/cards.py"`). */
  dirty_paths: string[];
};

export type SyncRecord = {
  sha: string;
  dirty: boolean;
  dirty_paths: string[];
  synced_at: string;
  /** The files copied, sorted. */
  files: string[];
  source: string;
  /** The route the copy was synced from; absent on a record written before the narrated route (cut-only). */
  route?: ScriptsRoute;
  /** SHA-256 of every file copied, by its relative path (the skip-through sync records it; the prep brief's sha comes from it). */
  file_sha256?: Record<string, string>;
};

export class ScriptsSyncError extends Error {
  readonly code: "no_repo" | "no_git" | "dirty" | "no_scripts";
  readonly state: RepoState | null;
  constructor(code: ScriptsSyncError["code"], message: string, state: RepoState | null = null) {
    super(message);
    this.name = "ScriptsSyncError";
    this.code = code;
    this.state = state;
  }
}

/** `git -C <root> ...`, as text; a missing git or a non-repo is a ScriptsSyncError. */
function git(root: string, args: string[]): string {
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  } catch (e) {
    throw new ScriptsSyncError("no_git", `could not run git: ${(e as Error).message}`);
  }
  if (r.error) throw new ScriptsSyncError("no_git", `could not run git: ${r.error.message}`);
  if (r.status !== 0) throw new ScriptsSyncError("no_repo", `git ${args.join(" ")} failed in ${root}: ${String(r.stderr ?? "").trim() || `exit ${r.status}`}`);
  return String(r.stdout ?? "");
}

/** HEAD and the working tree's cleanliness of the drama-remix checkout. */
export function dramaRemixState(root: string): RepoState {
  if (!existsSync(path.join(root, ".git"))) throw new ScriptsSyncError("no_repo", `${root} is not a git checkout (set DRAMA_REMIX_ROOT to the drama-remix repo)`);
  const sha = git(root, ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new ScriptsSyncError("no_repo", `git rev-parse HEAD in ${root} answered "${sha}"`);
  const lines = git(root, ["status", "--porcelain", "--untracked-files=normal"])
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter(Boolean);
  return { sha, dirty: lines.length > 0, dirty_paths: lines };
}

/** The files `cp -r cut-only/.` would copy: every regular file, dotfiles included, `__pycache__` and `*.pyc` left out. */
export function listSyncFiles(sourceDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "__pycache__") continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath);
      else if (e.isFile() && !e.name.endsWith(".pyc")) out.push(relPath);
    }
  };
  walk(sourceDir, "");
  return out.sort();
}

export type SyncOptions = {
  /** The drama-remix checkout; `dramaRemixRoot()` when absent. */
  root?: string;
  /** Proceed on a dirty working tree (the run's `settings.allow_dirty`). */
  allowDirty?: boolean;
  /** The repo state, when the caller already read it (a test, or one read per run). */
  state?: RepoState;
  now?: () => number;
  /** Which route to copy; default cut-only. */
  route?: ScriptsRoute;
};

export type SyncResult = SyncRecord & { scripts_dir: string; record_file: string };

/**
 * Copy the canonical scripts of the route (cut-only by default) into
 * `<filmCutDir>/scripts/` and write `<filmCutDir>/.studio-scripts.json`;
 * for the skip-through route `filmCutDir` is the film root itself. Refuses a dirty checkout unless
 * `allowDirty` (ScriptsSyncError `dirty`, its `state` naming the paths), a
 * missing checkout (`no_repo`) and a checkout without the scripts
 * (`no_scripts`). Each file lands under a temp name and is renamed into
 * place, so a script is never half-written while a stage could start.
 */
export function syncScripts(filmCutDir: string, opts: SyncOptions = {}): SyncResult {
  const root = opts.root ?? dramaRemixRoot();
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new ScriptsSyncError("no_repo", `no drama-remix checkout at ${root}: set DRAMA_REMIX_ROOT (or WORKSPACE_ROOT beside a drama-remix folder)`);
  const route: ScriptsRoute = opts.route ?? "cut-only";
  const sourceDir = path.join(root, ROUTE_DIR[route]);
  if (!statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) throw new ScriptsSyncError("no_scripts", `${sourceDir} is not there: not a drama-remix checkout`);
  const state = opts.state ?? dramaRemixState(root);
  if (state.dirty && !opts.allowDirty) {
    throw new ScriptsSyncError(
      "dirty",
      `drama-remix has uncommitted changes (${state.dirty_paths.length}): ${state.dirty_paths.slice(0, 6).join("; ")}${state.dirty_paths.length > 6 ? "; …" : ""} — commit them (a session edited a script and did not commit), or allow a dirty tree in the run's settings`,
      state
    );
  }
  const files = listSyncFiles(sourceDir);
  // checks.py reads a missing .route as skip-through: only a cut-only copy must carry it.
  if (route === "cut-only" && !files.includes(".route")) throw new ScriptsSyncError("no_scripts", `${sourceDir} has no .route file; checks.py would compare the film against the wrong route`);
  if (!files.length) throw new ScriptsSyncError("no_scripts", `${sourceDir} is empty`);
  const scriptsDir = path.join(filmCutDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const rel of files) {
    const src = path.join(sourceDir, ...rel.split("/"));
    const dst = path.join(scriptsDir, ...rel.split("/"));
    mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.${process.pid}.tmp`;
    copyFileSync(src, tmp);
    renameSync(tmp, dst);
    if (route === "skip-through") hashes[rel] = createHash("sha256").update(readFileSync(dst)).digest("hex");
  }
  const now = opts.now ?? Date.now;
  const record: SyncRecord = { sha: state.sha, dirty: state.dirty, dirty_paths: state.dirty_paths, synced_at: new Date(now()).toISOString(), files, source: sourceDir.replace(/\\/g, "/") };
  if (route === "skip-through") {
    record.route = route;
    record.file_sha256 = hashes;
  }
  const recordFile = path.join(filmCutDir, SYNC_RECORD_FILE);
  const tmp = `${recordFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 1) + "\n", "utf8");
  renameSync(tmp, recordFile);
  return { ...record, scripts_dir: scriptsDir, record_file: recordFile };
}

/** The last sync's record for a film, or null. */
export function readSyncRecord(filmCutDir: string): SyncRecord | null {
  const file = path.join(filmCutDir, SYNC_RECORD_FILE);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SyncRecord;
    return typeof parsed?.sha === "string" && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

/** How a synced copy differs from its record: changed (hash), added (not in the record), missing. Each sorted. */
export type ScriptsDrift = { changed: string[]; added: string[]; missing: string[] };

/**
 * Re-hash every file of a skip-through copy against the SHA-256 its sync
 * recorded (`.studio-scripts.json` `file_sha256`), and list any file the
 * record does not name (a module dropped beside the scripts shadows an
 * import: the scripts' folder is first on their sys.path). A writing session
 * runs in the film folder with Bash and could "fix" a noisy check by editing
 * the copy; every later check, recorder, build and the `*.workflow.js` Studio
 * compiles in its own process read that copy. Null when it matches; a record
 * with no per-file hashes (or none at all) is a drift of everything, since
 * nothing says what the copy should be.
 */
export function verifySyncedScripts(filmDir: string): ScriptsDrift | null {
  const record = readSyncRecord(filmDir);
  const scriptsDir = path.join(filmDir, "scripts");
  let have: string[] = [];
  try {
    have = listSyncFiles(scriptsDir);
  } catch {
    have = [];
  }
  const hashes = record?.file_sha256;
  if (!record || !hashes || typeof hashes !== "object") return { changed: [], added: have, missing: record?.files ?? [] };
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [rel, sha] of Object.entries(hashes)) {
    let now: string | null = null;
    try {
      now = createHash("sha256").update(readFileSync(path.join(scriptsDir, ...rel.split("/")))).digest("hex");
    } catch {
      now = null;
    }
    if (now === null) missing.push(rel);
    else if (now !== sha) changed.push(rel);
  }
  const added = have.filter((rel) => !(rel in hashes));
  if (!changed.length && !added.length && !missing.length) return null;
  return { changed: changed.sort(), added: added.sort(), missing: missing.sort() };
}

/** Tests: remove a synced copy. */
export function removeSyncedScripts(filmCutDir: string): void {
  rmSync(path.join(filmCutDir, "scripts"), { recursive: true, force: true });
  rmSync(path.join(filmCutDir, SYNC_RECORD_FILE), { force: true });
}

/** The narrated route's sync: `<drama-remix>/scripts/skip-through/*` into `<film>/scripts/`, the record at `<film>/.studio-scripts.json`. */
export function syncSkipThrough(filmDir: string, opts: Omit<SyncOptions, "route"> = {}): SyncResult {
  return syncScripts(filmDir, { ...opts, route: "skip-through" });
}
