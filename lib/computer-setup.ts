// What the "This computer" card does (decision 2026-09-24, "two computers,
// one database"): connect a films folder, get and update the pipeline, check
// that the computer can cut films and fix what it can itself, and report the
// cloud copy. Everything here acts on THIS computer's disk and tools only;
// the choices land in .studio-computer.json (lib/computer.ts), never in the
// shared database.
//
// The films folder follows the pipeline's own layout, `<root>/projects`
// (the films, by bucket) beside `<root>/drama-remix` (the pipeline's repo):
// a person may pick the root, the projects folder itself, or an empty or new
// folder, which becomes a root. A folder already holding other things is
// refused rather than filled. The pipeline is cloned from its GitHub repo
// with this computer's own git sign-in (never a token of ours), updated only
// by a fast-forward, and never over changes of its own. The Python packages
// the cut-only route needs are installed by pip when a person asks. Each of
// the three runs as one background task at a time, its output kept for the
// card, so a slow download never holds a request open.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpegBin } from "@/lib/clips/cut";
import { cloudSummary, type CloudSummary } from "@/lib/cloud-copy";
import { computerFilePath, filmsFolderSource, readComputerFile, saveComputer, thisComputer, type Computer } from "@/lib/computer";
import { dataSource } from "@/lib/data-source";
import { conflict, invalid } from "@/lib/data/errors";
import { workspaceRoot } from "@/lib/data/storage";
import { ffprobeBin } from "@/lib/film-import/import";
import { dramaRemixRoot, gitBashPath, pipelinePython, runProcess, type ProcessRun } from "@/lib/python";
import { visionUnavailableReason } from "@/lib/segment/vision";

export const FILM_BUCKETS = ["low-quality", "high-quality"] as const;

/** The pipeline's repository (private; the person's GitHub account needs access). */
export function pipelineRepo(env: Record<string, string | undefined> = process.env): string {
  return env.DRAMA_REMIX_REPO?.trim() || "https://github.com/08lanr/drama-remix.git";
}

/** The Python packages the cut-only route imports (scripts/cut-only/README.md "Needs"), by pip name and import name. */
export const PIPELINE_PACKAGES = [
  { pip: "faster-whisper", module: "faster_whisper" },
  { pip: "opencv-python", module: "cv2" },
  { pip: "numpy", module: "numpy" },
] as const;

/** The ffmpeg filters the cut-only scripts use. */
export const PIPELINE_FILTERS = ["scdet", "delogo", "tile"] as const;

// ---- the films folder ----------------------------------------------------------------------------------------

/** A pasted path as a path: surrounding quotes (Explorer's "Copy as path") gone, `~` expanded. */
export function cleanFolderInput(raw: string, home: string = os.homedir()): string {
  let p = String(raw ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
  if (p === "~") p = home;
  else if (/^~[\\/]/.test(p)) p = path.join(home, p.slice(2));
  return p;
}

/** Things a folder may hold and still count as empty. */
const IGNORABLE = /^(\..*|desktop\.ini|thumbs\.db|drama-remix)$/i;

function inside(parent: string, child: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export type FolderPlan = { films: string; root: string; create: string[] };

/**
 * Where a picked folder puts the films: the folder itself when it is a
 * projects folder (named so, or holding a bucket), its `projects` when it
 * has one, else — empty or new — `<folder>/projects`. Refuses a relative
 * path, a file, a folder inside Studio's own, and a folder with other things
 * in it. `create` lists the folders to make (projects and its two buckets).
 */
export function planFilmsFolder(raw: string, opts: { cwd?: string; home?: string } = {}): FolderPlan {
  const input = cleanFolderInput(raw, opts.home);
  if (!input) throw invalid("Enter a folder.");
  if (!path.isAbsolute(input)) throw invalid("Enter the whole path of the folder, from the drive (C:\\…) or, on a Mac, from /.");
  const abs = path.resolve(input);
  if (inside(path.resolve(opts.cwd ?? process.cwd()), abs)) throw invalid("Pick a folder outside Studio's own folder.");
  const st = statSync(abs, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) throw invalid("That is a file, not a folder.");
  const entries = st ? readdirSync(abs, { withFileTypes: true }) : [];
  const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase()));
  let films: string;
  if (path.basename(abs).toLowerCase() === "projects" || FILM_BUCKETS.some((b) => dirs.has(b))) films = abs;
  else if (dirs.has("projects")) films = path.join(abs, "projects");
  else {
    if (entries.some((e) => !IGNORABLE.test(e.name))) throw invalid("This folder already holds other things. Pick an empty or new folder, or the folder that holds your films.");
    films = path.join(abs, "projects");
  }
  const create = [films, ...FILM_BUCKETS.map((b) => path.join(films, b))].filter((p) => !existsSync(p));
  return { films, root: path.dirname(films), create };
}

/** The film folders under a projects folder: one per `<bucket>/<film>`, plus the older top-level ones. */
export function countFilms(films: string): number {
  let n = 0;
  for (const e of safeDir(films)) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_")) continue;
    if ((FILM_BUCKETS as readonly string[]).includes(e.name)) n += safeDir(path.join(films, e.name)).filter((f) => f.isDirectory() && !f.name.startsWith(".") && !f.name.startsWith("_")).length;
    else n++;
  }
  return n;
}

function safeDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Make the folders, prove Studio can write there, and make it this computer's films folder. */
export function connectFilmsFolder(raw: string): FolderPlan {
  if (!computerFilePath()) throw conflict("This server does not keep settings for the computer.");
  const plan = planFilmsFolder(raw);
  for (const dir of plan.create) mkdirSync(dir, { recursive: true });
  const probe = path.join(plan.films, `.studio-write-check-${process.pid}`);
  try {
    writeFileSync(probe, "ok");
    unlinkSync(probe);
  } catch (e) {
    throw invalid(`Studio cannot write in ${plan.films}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  saveComputer({ films_folder: plan.films });
  return plan;
}

export type FilmsStatus = {
  folder: string | null;
  /** Set on this computer, from the server's own settings, or nowhere. */
  source: "computer" | "server" | null;
  exists: boolean;
  films: number;
  suggested: string;
};

export function filmsStatus(): FilmsStatus {
  const folder = workspaceRoot();
  const exists = !!folder && !!statSync(folder, { throwIfNoEntry: false })?.isDirectory();
  return { folder, source: folder ? filmsFolderSource() : null, exists, films: exists && folder ? countFilms(folder) : 0, suggested: path.join(os.homedir(), "Pulsar Films") };
}

// ---- the pipeline ------------------------------------------------------------------------------------------------

export type PipelineStatus = {
  folder: string;
  state: "no_films_folder" | "missing" | "not_git" | "no_scripts" | "ready";
  sha: string | null;
  dirty: boolean;
  /** Commits the last fetch saw on GitHub that this copy lacks; null when unknown. */
  behind: number | null;
};

/** Where the pipeline goes on this computer: beside the projects folder, as the pipeline lays itself out. */
export function pipelineTarget(): string | null {
  const films = workspaceRoot();
  return films ? path.join(path.dirname(films), "drama-remix") : null;
}

function gitArgs(folder: string, args: string[]): string[] {
  // A checkout another user made (the pipeline folder is Codex's on Ruobin's PC) is fine to read: name it safe for this call only.
  return ["-c", `safe.directory=${folder.replace(/\\/g, "/")}`, "-C", folder, ...args];
}

function run(cmd: string, args: string[], timeoutMs = 20_000, cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    } catch (e) {
      resolve({ ok: false, stdout: "", stderr: (e as Error).message });
    }
  });
}

export async function pipelineStatus(): Promise<PipelineStatus> {
  const found = dramaRemixRoot();
  const target = pipelineTarget();
  const folder = existsSync(found) ? found : target ?? found;
  const base = { folder, sha: null, dirty: false, behind: null };
  if (!existsSync(folder)) return { ...base, state: target ? "missing" : "no_films_folder" };
  if (!existsSync(path.join(folder, ".git"))) return { ...base, state: "not_git" };
  const [head, status, behind] = await Promise.all([
    run("git", gitArgs(folder, ["rev-parse", "HEAD"])),
    run("git", gitArgs(folder, ["status", "--porcelain", "--untracked-files=normal"])),
    run("git", gitArgs(folder, ["rev-list", "--count", "HEAD..@{u}"])),
  ]);
  const sha = head.ok && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
  const out: PipelineStatus = { folder, sha, dirty: status.ok && status.stdout.trim().length > 0, behind: behind.ok && /^\d+$/.test(behind.stdout.trim()) ? Number(behind.stdout.trim()) : null, state: "ready" };
  if (!existsSync(path.join(folder, "scripts", "cut-only"))) out.state = "no_scripts";
  return out;
}

// ---- background tasks ---------------------------------------------------------------------------------------------

export type SetupTaskKind = "clone" | "pull" | "packages";

export type SetupTask = {
  kind: SetupTaskKind;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  /** The last lines the command printed. */
  lines: string[];
  /** One plain sentence when it failed. */
  message: string | null;
};

type TaskState = { task: SetupTask | null; proc: ProcessRun | null };

function taskState(): TaskState {
  const g = globalThis as unknown as { __studioSetupTask?: TaskState };
  if (!g.__studioSetupTask) g.__studioSetupTask = { task: null, proc: null };
  return g.__studioSetupTask;
}

export function currentTask(): SetupTask | null {
  return taskState().task;
}

const MAX_LINES = 40;

function startTask(kind: SetupTaskKind, cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; explain: (tail: string) => string }): SetupTask {
  const st = taskState();
  if (st.task && st.task.finished_at === null) throw conflict("Studio is already busy with a setup step on this computer; wait for it to finish.");
  const task: SetupTask = { kind, started_at: new Date().toISOString(), finished_at: null, ok: null, lines: [], message: null };
  st.task = task;
  const push = (line: string) => {
    const clean = line.replace(/\r/g, "").trimEnd();
    if (!clean) return;
    task.lines.push(clean);
    if (task.lines.length > MAX_LINES) task.lines.splice(0, task.lines.length - MAX_LINES);
  };
  try {
    st.proc = runProcess(cmd, args, { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", PIP_DISABLE_PIP_VERSION_CHECK: "1" }, timeoutMs: opts.timeoutMs, priority: "normal", onLine: (_s, l) => push(l) });
  } catch (e) {
    task.finished_at = new Date().toISOString();
    task.ok = false;
    task.message = opts.explain((e as Error).message);
    return task;
  }
  void st.proc.done
    .then((r) => {
      task.ok = r.code === 0;
      if (!task.ok) task.message = r.timedOut ? "It took too long and was stopped. Try again." : opts.explain(`${r.stdoutTail}\n${r.stderrTail}`);
    })
    .catch((e) => {
      task.ok = false;
      task.message = opts.explain((e as Error).message);
    })
    .finally(() => {
      task.finished_at = new Date().toISOString();
      st.proc = null;
      invalidateReadiness();
    });
  return task;
}

/** Clone the pipeline beside the films folder, with this computer's own git sign-in. */
export function downloadPipeline(): SetupTask {
  const target = pipelineTarget();
  if (!target) throw conflict("Connect a films folder first: the pipeline goes beside it.");
  if (safeDir(target).length > 0) throw conflict(`${target} is already there and not empty.`);
  return startTask("clone", "git", ["clone", pipelineRepo(), target], {
    timeoutMs: 10 * 60 * 1000,
    explain: (tail) =>
      /authentication|could not read username|repository not found|403|permission denied/i.test(tail)
        ? "GitHub said no: sign in to GitHub on this computer with an account that has access to the pipeline (08lanr/drama-remix), then try again."
        : /not recognized|enoent|not found/i.test(tail) && !/repository/i.test(tail)
          ? "Git is not installed on this computer. Install it from git-scm.com, then try again."
          : `The download failed: ${lastLine(tail)}`,
  });
}

/** Fast-forward the pipeline to GitHub's; never over its own changes. */
export async function updatePipeline(): Promise<SetupTask> {
  const status = await pipelineStatus();
  if (status.state !== "ready" && status.state !== "no_scripts") throw conflict("There is no pipeline on this computer to update yet.");
  if (status.dirty) throw conflict("The pipeline on this computer has changes of its own that are not saved in git; Studio will not update over them.");
  return startTask("pull", "git", gitArgs(status.folder, ["pull", "--ff-only"]), {
    timeoutMs: 5 * 60 * 1000,
    explain: (tail) =>
      /not possible to fast-forward|diverg/i.test(tail)
        ? "This copy of the pipeline has commits GitHub does not have; Studio will not merge them. Ask whoever works on the pipeline."
        : /authentication|could not read username|403/i.test(tail)
          ? "GitHub said no: sign in to GitHub on this computer with an account that has access to the pipeline."
          : `The update failed: ${lastLine(tail)}`,
  });
}

/** pip-install the packages the cut-only route needs into the pipeline's Python. */
export async function installPythonPackages(): Promise<SetupTask> {
  const py = await findPython();
  if (!py) throw conflict("Install Python 3.12 from python.org first, then press Check again.");
  return startTask("packages", py.cmd, ["-m", "pip", "install", ...PIPELINE_PACKAGES.map((p) => p.pip)], {
    timeoutMs: 20 * 60 * 1000,
    explain: (tail) =>
      /externally-managed-environment/i.test(tail)
        ? "This Python belongs to the system (or Homebrew) and refuses new packages. Install Python 3.12 from python.org, then try again."
        : `The install failed: ${lastLine(tail)}`,
  });
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "no output";
}

// ---- can this computer cut films? --------------------------------------------------------------------------------------

export type CheckKey = "films" | "pipeline" | "git" | "python" | "packages" | "ffmpeg" | "ffprobe" | "bash" | "ai";
export type Check = { key: CheckKey; ok: boolean; detail: string | null };
export type Readiness = { checks: Check[]; can_import: boolean; can_cut: boolean; checked_at: string };

type Found = { cmd: string; exe: string; version: string };

async function probePython(cmd: string): Promise<Found | null> {
  const r = await run(cmd, ["-c", "import sys, json; print(json.dumps({'v': list(sys.version_info[:3]), 'exe': sys.executable}))"]);
  if (!r.ok) return null;
  try {
    const o = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "") as { v: number[]; exe: string };
    if (o.v[0] !== 3 || o.v[1] < 10) return null;
    return { cmd, exe: o.exe, version: o.v.join(".") };
  } catch {
    return null;
  }
}

/**
 * The Python the pipeline should run under: the one in force if it answers
 * (3.10 or newer), else `python`, else `python3`. A different one that works
 * is remembered for this computer, so the pipeline's scripts use it too.
 */
export async function findPython(): Promise<Found | null> {
  const current = pipelinePython();
  for (const cmd of [...new Set([current, "python", "python3"])]) {
    const found = await probePython(cmd);
    if (!found) continue;
    if (cmd !== current && computerFilePath()) saveComputer({ python: found.exe });
    return found;
  }
  return null;
}

type ReadyCache = { at: number; value: Readiness } | null;
function readyCache(): { value: ReadyCache } {
  const g = globalThis as unknown as { __studioReadiness?: { value: ReadyCache } };
  if (!g.__studioReadiness) g.__studioReadiness = { value: null };
  return g.__studioReadiness;
}

export function invalidateReadiness(): void {
  readyCache().value = null;
}

const READY_TTL_MS = 30_000;

/** Every check at once; answered from a 30-second memory unless `force`. */
export async function readiness(force = false): Promise<Readiness> {
  const cache = readyCache();
  if (!force && cache.value && Date.now() - cache.value.at < READY_TTL_MS) return cache.value.value;
  const films = filmsStatus();
  const [pipeline, git, py, ffmpeg, ffprobe, bash] = await Promise.all([
    pipelineStatus(),
    run("git", ["--version"]),
    findPython(),
    run(ffmpegBin(), ["-hide_banner", "-filters"]),
    run(ffprobeBin(), ["-version"]),
    (async () => {
      const bin = gitBashPath();
      return bin ? run(bin, ["--version"]) : { ok: false, stdout: "", stderr: "" };
    })(),
  ]);
  let packages: Check = { key: "packages", ok: false, detail: null };
  if (py) {
    const probe = await run(py.cmd, ["-c", `import importlib.util, json; print(json.dumps([m for m in ${JSON.stringify(PIPELINE_PACKAGES.map((p) => p.module))} if importlib.util.find_spec(m) is None]))`], 60_000);
    let missing: string[] | null = null;
    try {
      missing = probe.ok ? (JSON.parse(probe.stdout.trim().split(/\r?\n/).pop() ?? "") as string[]) : null;
    } catch {
      missing = null;
    }
    const names = (missing ?? PIPELINE_PACKAGES.map((p) => p.module)).map((m) => PIPELINE_PACKAGES.find((p) => p.module === m)?.pip ?? m);
    packages = { key: "packages", ok: missing !== null && missing.length === 0, detail: names.length ? names.join(", ") : null };
  }
  const missingFilters = ffmpeg.ok ? PIPELINE_FILTERS.filter((f) => !new RegExp(`\\s${f}\\s`).test(ffmpeg.stdout)) : [];
  const checks: Check[] = [
    { key: "films", ok: films.exists, detail: films.folder },
    { key: "pipeline", ok: pipeline.state === "ready", detail: pipeline.state },
    { key: "git", ok: git.ok, detail: git.ok ? git.stdout.trim().replace(/^git version\s*/i, "") : null },
    { key: "python", ok: !!py, detail: py?.version ?? null },
    packages,
    { key: "ffmpeg", ok: ffmpeg.ok && missingFilters.length === 0, detail: ffmpeg.ok ? (missingFilters.length ? missingFilters.join(", ") : null) : null },
    { key: "ffprobe", ok: ffprobe.ok, detail: null },
    { key: "bash", ok: bash.ok, detail: null },
    { key: "ai", ok: visionUnavailableReason() === null, detail: null },
  ];
  const ok = (k: CheckKey) => checks.find((c) => c.key === k)?.ok === true;
  const value: Readiness = { checks, can_import: ok("films") && ok("ffprobe"), can_cut: checks.every((c) => c.ok), checked_at: new Date().toISOString() };
  cache.value = { at: Date.now(), value };
  return value;
}

// ---- the card's whole picture ----------------------------------------------------------------------------------------

export type ComputerSummary = {
  computer: Computer;
  /** False when this server keeps no settings for the computer (tests, a second server on one checkout). */
  settings_on: boolean;
  mode: "fixture" | "supabase";
  films: FilmsStatus;
  pipeline: PipelineStatus;
  readiness: Readiness;
  task: SetupTask | null;
  cloud: CloudSummary;
};

export async function computerSummary(opts: { force?: boolean } = {}): Promise<ComputerSummary> {
  const [pipeline, ready] = await Promise.all([pipelineStatus(), readiness(opts.force)]);
  return {
    computer: thisComputer(),
    settings_on: !!computerFilePath(),
    mode: dataSource() === "supabase" ? "supabase" : "fixture",
    films: filmsStatus(),
    pipeline,
    readiness: ready,
    task: currentTask(),
    cloud: cloudSummary(),
  };
}

/** For the card's switch: whether this computer copies what it imported to the cloud. */
export function setCloudCopy(on: boolean): void {
  if (!computerFilePath()) throw conflict("This server does not keep settings for the computer.");
  saveComputer({ cloud_copy: on });
}

/** Forget the films folder set here (the server's own setting, if any, comes back). */
export function disconnectFilmsFolder(): void {
  if (!readComputerFile().films_folder) return;
  saveComputer({ films_folder: null });
}
