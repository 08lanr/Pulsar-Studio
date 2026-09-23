// The one place Studio spawns a script (decision 2026-09-23, "segment a film
// in Studio"; plan B1): the transcription and alignment helpers
// (scripts/*.py) and the pipeline's cut-only scripts, which the segment
// worker runs INSIDE a film's cut/ folder as background jobs. What every run
// gets, the same way:
//
//   - line-streamed stdout and stderr (`onLine`), plus a tail of each kept
//     for the result, because cut_episodes.py prints "REFUSED" on stdout and
//     a refusal is shown verbatim;
//   - PYTHONIOENCODING=utf-8 in the environment, so a Chinese line never
//     trips a Windows console codepage, and PYTHONUNBUFFERED=1, because
//     Python block-buffers stdout into a pipe and a render's per-episode
//     lines would otherwise all arrive when the script exits;
//   - a wall-clock timeout that kills the whole process tree (Windows:
//     `taskkill /T /F`, which is the only thing that reaches a script's
//     ffmpeg children; elsewhere SIGKILL on the process group) and a `cancel`
//     the caller may pull for the same effect;
//   - below-normal priority on the child (the scripts lower their own too);
//   - an optional heartbeat, at most every `everyMs`, cleared when the
//     process ends, for a job row's heartbeat_at;
//   - a result, never a throw, for an exit code: the caller decides what an
//     exit 1 means (the pipeline's refusals are exit 1 with the reason in
//     the tail). Only a process that could not be started rejects.
//
// `pipelinePython()` names the interpreter for the pipeline's scripts:
// STUDIO_PIPELINE_PYTHON, else `python` on PATH (the pipeline's README: the
// system Python 3.12 with faster-whisper, opencv and numpy; it does not use
// a venv). `dramaRemixRoot()` names the drama-remix checkout the scripts are
// synced from (lib/segment/scripts-sync.ts) and run from for a one-off
// strip (lib/segment/strips.ts). `gitBashPath()` finds Git for Windows' bash
// for index_cut.sh.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** An environment-shaped record, so the selectors can be tested without touching process.env. */
export type Env = Record<string, string | undefined>;

export type RunOptions = {
  cwd?: string;
  /** Merged over process.env; PYTHONIOENCODING=utf-8 and PYTHONUNBUFFERED=1 are always set. */
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, then stdin is closed. Without it stdin is closed at once. */
  stdin?: string;
  /** Every complete line of either stream, in arrival order (a trailing partial line is flushed at the end). */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
  /** Kill the process tree after this long; the result then carries `timedOut: true`. No timeout when absent. */
  timeoutMs?: number;
  /** Default below_normal: a render or a whisper run never starves the dev server or the desktop. */
  priority?: "below_normal" | "normal";
  /** Called at most every `everyMs` while the process runs (a job heartbeat); a rejection is swallowed. */
  heartbeat?: { cb: () => void | Promise<void>; everyMs: number };
  /** How much of each stream's tail the result keeps (default 4000 chars). */
  tailChars?: number;
  /** Keep the whole stdout in `stdout` (the transcription script answers JSON there); default off, the tail suffices. */
  captureStdout?: boolean;
};

export type RunResult = {
  /** The exit code, or null when the process was killed (timeout, cancel). */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The whole stdout when `captureStdout` was set, else "". */
  stdout: string;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
};

/** A running (or finished) process: its pid, the result to await, and a cancel that kills the whole tree. */
export interface ProcessRun {
  pid: number | null;
  done: Promise<RunResult>;
  /** Kill the process tree; resolves once the process has exited. Idempotent; a no-op after exit. */
  cancel(): Promise<void>;
}

export const DEFAULT_TAIL_CHARS = 4000;

/** The interpreter the pipeline's scripts run under: STUDIO_PIPELINE_PYTHON, else `python` on PATH. */
export function pipelinePython(env: Env = process.env): string {
  return env.STUDIO_PIPELINE_PYTHON?.trim() || "python";
}

/** Where the drama-remix checkout sits relative to this repo when nothing names it: the sibling workspace's copy. */
export const SIBLING_DRAMA_REMIX = ["..", "Pulsar-Workspace", "mini-drama-system", "drama-remix"] as const;

/**
 * The drama-remix checkout (its own git repo): DRAMA_REMIX_ROOT when set;
 * else `<the folder above WORKSPACE_ROOT>/drama-remix` (the pipeline's own
 * layout, mini-drama-system/{projects,drama-remix}) when that folder exists;
 * else the sibling checkout `../Pulsar-Workspace/mini-drama-system/drama-remix`
 * of this repo. Never null: a caller that needs the folder to exist checks
 * (scripts-sync refuses with `no_repo`).
 */
export function dramaRemixRoot(env: Env = process.env): string {
  const configured = env.DRAMA_REMIX_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const ws = env.WORKSPACE_ROOT?.trim();
  if (ws) {
    const beside = path.join(path.dirname(path.resolve(ws)), "drama-remix");
    if (existsSync(beside)) return beside;
  }
  return path.resolve(process.cwd(), ...SIBLING_DRAMA_REMIX);
}

/** True when `python` (or the given interpreter) starts and answers `--version`; the tests skip without one. */
export function pythonAvailable(python = pipelinePython()): boolean {
  try {
    const r = spawnSync(python, ["--version"], { stdio: "ignore", timeout: 15_000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Git for Windows' bash: STUDIO_BASH when set; else the `usr/bin/bash.exe`
 * beside git (`git --exec-path` is `<git>/mingw64/libexec/git-core`), else
 * the usual install folders, else `bash` on PATH when it is not the WSL
 * launcher (System32\bash.exe, which cannot run a script in this file
 * system). Null when nothing is found. On another OS, `bash`.
 */
export function gitBashPath(): string | null {
  const configured = process.env.STUDIO_BASH?.trim();
  if (configured) return configured;
  if (process.platform !== "win32") return "bash";
  const candidates: string[] = [];
  try {
    const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    const p = exec.status === 0 ? exec.stdout.trim() : "";
    if (p) candidates.push(path.resolve(p, "..", "..", "..", "usr", "bin", "bash.exe"));
  } catch {
    // git is not on PATH; the fixed folders below still apply
  }
  const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")].filter((x): x is string => !!x);
  for (const base of programFiles) candidates.push(path.join(base, "Git", "usr", "bin", "bash.exe"), path.join(base, "Git", "bin", "bash.exe"));
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const where = spawnSync("where", ["bash"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    for (const line of (where.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (!/\\System32\\bash\.exe$/i.test(line) && existsSync(line)) return line;
    }
  } catch {
    // no `where`
  }
  return null;
}

// ---- the runner ------------------------------------------------------------------------------------

/** Keep the last `max` characters of a growing string. */
function appendTail(tail: string, chunk: string, max: number): string {
  const joined = tail + chunk;
  return joined.length > max ? joined.slice(joined.length - max) : joined;
}

/** Split a stream's chunks into lines, keeping a partial last line until the next chunk. */
function lineSplitter(emit: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let rest = "";
  return {
    push(chunk) {
      rest += chunk;
      let at: number;
      while ((at = rest.indexOf("\n")) >= 0) {
        emit(rest.slice(0, at).replace(/\r$/, ""));
        rest = rest.slice(at + 1);
      }
    },
    flush() {
      if (rest) emit(rest.replace(/\r$/, ""));
      rest = "";
    },
  };
}

/** Kill a process and everything it started. Returns once the kill command has been issued. */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 30_000, windowsHide: true });
    } catch {
      // taskkill missing or refused: fall through to the plain kill
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    return;
  }
  // The child is its own process group leader (detached), so a negative pid reaches its children too.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Start `command args...` and follow it to the end. Rejects only when the
 * process could not be started (`could not run <command>: <reason>`, the
 * message lib/asr.ts and lib/align.ts always gave); an exit code, a timeout
 * and a cancel all resolve.
 */
export function runProcess(command: string, args: string[], opts: RunOptions = {}): ProcessRun {
  const started = Date.now();
  const tailMax = opts.tailChars ?? DEFAULT_TAIL_CHARS;
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // A process group of its own on POSIX, so a cancel reaches ffmpeg children; Windows uses taskkill /T instead.
    detached: process.platform !== "win32",
  });

  if ((opts.priority ?? "below_normal") === "below_normal" && child.pid !== undefined) {
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // not permitted or the process is already gone: the scripts lower their own priority as well
    }
  }

  let stdout = "";
  let stdoutTail = "";
  let stderrTail = "";
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  const out = lineSplitter((line) => opts.onLine?.("stdout", line));
  const err = lineSplitter((line) => opts.onLine?.("stderr", line));
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (opts.captureStdout) stdout += chunk;
    stdoutTail = appendTail(stdoutTail, chunk, tailMax);
    out.push(chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = appendTail(stderrTail, chunk, tailMax);
    err.push(chunk);
  });

  const timer = opts.timeoutMs && opts.timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, opts.timeoutMs)
    : null;
  const beat = opts.heartbeat
    ? setInterval(() => {
        void Promise.resolve()
          .then(() => opts.heartbeat!.cb())
          .catch(() => undefined);
      }, Math.max(1000, opts.heartbeat.everyMs))
    : null;
  beat?.unref?.();

  const done = new Promise<RunResult>((resolve, reject) => {
    const finish = () => {
      if (timer) clearTimeout(timer);
      if (beat) clearInterval(beat);
      settled = true;
    };
    child.on("error", (e) => {
      if (settled) return;
      finish();
      reject(new Error(`could not run ${command}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      finish();
      out.flush();
      err.flush();
      resolve({ code, signal, stdout, stdoutTail, stderrTail, durationMs: Date.now() - started, timedOut, cancelled });
    });
    if (child.stdin) {
      child.stdin.on("error", () => undefined); // EPIPE when the child exits before reading: the exit code tells the story
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin, "utf-8");
      child.stdin.end();
    }
  });

  return {
    pid: child.pid ?? null,
    done,
    async cancel() {
      if (settled) return;
      cancelled = true;
      killProcessTree(child);
      await done.catch(() => undefined);
    },
  };
}

/** A Python script (or `-c`) under the pipeline's interpreter: `runPython(["scripts/motion.py", "--src", ...], {cwd: cutDir})`. */
export function runPython(args: string[], opts: RunOptions & { python?: string } = {}): ProcessRun {
  const { python, ...rest } = opts;
  return runProcess(python ?? pipelinePython(), args, rest);
}

/**
 * A bash script through Git Bash (index_cut.sh): `runBashScript("scripts/index_cut.sh", ["--src", ...], {cwd: cutDir})`.
 * Rejects when no bash is found (the message names STUDIO_BASH). The script
 * path may be relative to `cwd`; a Windows path is handed to bash with
 * forward slashes, which Git Bash reads.
 */
export function runBashScript(script: string, args: string[], opts: RunOptions = {}): ProcessRun {
  const bash = gitBashPath();
  if (!bash) {
    const failed = Promise.reject(new Error("could not run bash: Git for Windows' bash.exe was not found (set STUDIO_BASH to its path)"));
    return { pid: null, done: failed, cancel: async () => undefined };
  }
  return runProcess(bash, [script.replace(/\\/g, "/"), ...args], opts);
}

/** The last non-empty line of a tail, for a one-line summary of what a script said. */
export function lastLine(tail: string): string {
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}
