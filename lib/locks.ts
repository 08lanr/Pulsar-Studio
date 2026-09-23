// The two lock files a Studio run and a Claude Code session share (decision
// 2026-09-23, "segment a film in Studio"; drama-remix
// scripts/cut-only/README.md, "Running under Pulsar Studio"). Neither side
// can see the other's process, so a file is the only signal:
//
//   <film>/cut/.studio-run.json      Studio is driving this folder. Written
//                                    when a run starts, updated per stage,
//                                    removed when the run ends:
//                                    { run_id, stage, started_at, pid, owner: "pulsar-studio" }.
//   <mini-drama-system>/.heavy-lock.json   one heavy stage on the machine
//                                    (whisper index, a full render, a QA run),
//                                    Studio and sessions alike:
//                                    { owner, what, pid, started_at }.
//
// A lock is STALE when its pid is not alive (tasklist on Windows,
// `kill -0` elsewhere) or its started_at is older than six hours; a stale
// lock is replaced and the replacement says so in its result, never
// deleted quietly. A live lock held by someone else is a LockHeldError
// (`heavyLock`) or a wait (`waitForHeavyLock`). Writes are atomic (a temp
// file renamed over the lock) and a release removes the file only while it
// still holds our own pid and run, so a lock another process took after ours
// went stale is never removed by us. The liveness check and the clock are
// injectable for the tests.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceRoot } from "@/lib/data/storage";

export const STUDIO_RUN_LOCK_FILE = ".studio-run.json";
export const HEAVY_LOCK_FILE = ".heavy-lock.json";
export const STUDIO_LOCK_OWNER = "pulsar-studio";
/** A lock older than this is stale whatever its pid says (a hung process). */
export const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export type StudioRunLock = { run_id: string; stage: string; started_at: string; pid: number; owner: string };
export type HeavyLock = { owner: string; what: string; pid: number; started_at: string };

export type LockOptions = {
  /** Is this pid alive? Default: tasklist (Windows) / kill -0. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
};

/** Why a lock file is not in force: `dead_pid` (its process is gone) or `too_old` (started over six hours ago). */
export type StaleReason = "dead_pid" | "too_old";

export class LockHeldError extends Error {
  readonly file: string;
  readonly holder: HeavyLock | StudioRunLock;
  constructor(file: string, holder: HeavyLock | StudioRunLock, what: string) {
    super(what);
    this.name = "LockHeldError";
    this.file = file;
    this.holder = holder;
  }
}

/** The pid a lock will carry: this process. */
export const ownPid = (): number => process.pid;

/** True when a process with this pid exists. Windows: `tasklist /FI "PID eq N"` (the README's own check); elsewhere `kill -0`. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    try {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
      if (r.status !== 0) return false;
      // A hit is one CSV row whose second field is the pid; "INFO: No tasks are running" is the miss.
      return new RegExp(`^"[^"]*","${pid}",`, "m").test(r.stdout ?? "");
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The lock a file holds, or null when it is absent or not a lock (a broken file is reported as null too: it is replaced, not trusted). */
export function readLock<T extends HeavyLock | StudioRunLock>(file: string): T | null {
  try {
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    if (!isObject(parsed) || typeof parsed.pid !== "number" || typeof parsed.started_at !== "string") return null;
    return parsed as unknown as T;
  } catch {
    return null;
  }
}

/** Null while the lock is in force; the reason when it is stale. */
export function staleReason(lock: { pid: number; started_at: string }, opts: LockOptions = {}): StaleReason | null {
  const now = opts.now ?? Date.now;
  const started = Date.parse(lock.started_at);
  if (!Number.isFinite(started) || now() - started > LOCK_STALE_MS) return "too_old";
  if (!(opts.isAlive ?? pidAlive)(lock.pid)) return "dead_pid";
  return null;
}

function writeAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n", "utf8");
  renameSync(tmp, file);
}

/** Remove the file only while it still holds what `ours` says (pid and, for a run lock, run_id); true when removed. */
function removeIfOurs(file: string, ours: { pid: number; run_id?: string }): boolean {
  const current = readLock<HeavyLock | StudioRunLock>(file);
  if (!current) {
    try {
      if (statSync(file, { throwIfNoEntry: false })) rmSync(file, { force: true });
    } catch {
      // gone already
    }
    return false;
  }
  if (current.pid !== ours.pid) return false;
  if (ours.run_id !== undefined && (current as StudioRunLock).run_id !== ours.run_id) return false;
  rmSync(file, { force: true });
  return true;
}

/** What taking a lock reports: the file, the lock as written, and the stale lock it replaced when there was one. */
export type Held<T> = {
  file: string;
  lock: T;
  /** The stale lock this one replaced, with why it was stale; null when the file was free. Say so to the person, never hide it. */
  replaced: { lock: T; reason: StaleReason } | null;
  /** Rewrite the lock in place (a new stage); a no-op after release. */
  update(patch: Partial<T>): T;
  /** Remove the lock while it is still ours; true when the file was removed. */
  release(): boolean;
};

function take<T extends HeavyLock | StudioRunLock>(file: string, lock: T, opts: LockOptions, sameHolder: (current: T) => boolean, describe: (current: T) => string): Held<T> {
  const current = readLock<T>(file);
  let replaced: Held<T>["replaced"] = null;
  if (current && !sameHolder(current)) {
    const reason = staleReason(current, opts);
    if (!reason) throw new LockHeldError(file, current, describe(current));
    replaced = { lock: current, reason };
  }
  writeAtomic(file, lock);
  let released = false;
  let latest = lock;
  return {
    file,
    lock,
    replaced,
    update(patch) {
      if (released) return latest;
      latest = { ...latest, ...patch };
      writeAtomic(file, latest);
      return latest;
    },
    release() {
      if (released) return false;
      released = true;
      return removeIfOurs(file, { pid: lock.pid, run_id: (lock as StudioRunLock).run_id });
    },
  };
}

/** The lock file of a film's cut/ folder. */
export function studioRunLockPath(filmCutDir: string): string {
  return path.join(filmCutDir, STUDIO_RUN_LOCK_FILE);
}

/**
 * Take `cut/.studio-run.json` for a run: refused (LockHeldError) while
 * another run's live lock is there; adopted when the same run_id holds it
 * (a restarted worker); a stale lock is replaced and reported. `started_at`
 * is now; `update({stage})` moves it along; `release()` removes it.
 */
export function studioRunLock(filmCutDir: string, req: { run_id: string; stage: string; pid?: number }, opts: LockOptions = {}): Held<StudioRunLock> {
  const now = opts.now ?? Date.now;
  const lock: StudioRunLock = { run_id: req.run_id, stage: req.stage, started_at: new Date(now()).toISOString(), pid: req.pid ?? ownPid(), owner: STUDIO_LOCK_OWNER };
  return take(
    studioRunLockPath(filmCutDir),
    lock,
    opts,
    (current) => current.run_id === req.run_id,
    (current) => `${path.basename(filmCutDir)} is being driven by run ${current.run_id} (${current.owner}, pid ${current.pid}, stage ${current.stage}, since ${current.started_at})`
  );
}

/** Where the machine-wide heavy lock lives: HEAVY_LOCK_ROOT, else the folder above WORKSPACE_ROOT (mini-drama-system), else the cwd. */
export function heavyLockRoot(): string {
  const configured = process.env.HEAVY_LOCK_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const ws = workspaceRoot();
  return ws ? path.dirname(ws) : process.cwd();
}

export function heavyLockPath(root = heavyLockRoot()): string {
  return path.join(root, HEAVY_LOCK_FILE);
}

/**
 * Take the machine's one heavy slot for `what` (index, render, qa): refused
 * (LockHeldError) while another process holds a live lock — a session's or
 * another Studio run's; adopted when our own pid holds it; a stale lock is
 * replaced and reported.
 */
export function heavyLock(root: string, req: { owner?: string; what: string; pid?: number }, opts: LockOptions = {}): Held<HeavyLock> {
  const now = opts.now ?? Date.now;
  const lock: HeavyLock = { owner: req.owner ?? STUDIO_LOCK_OWNER, what: req.what, pid: req.pid ?? ownPid(), started_at: new Date(now()).toISOString() };
  return take(
    heavyLockPath(root),
    lock,
    opts,
    (current) => current.pid === lock.pid && current.owner === lock.owner,
    (current) => `the machine's heavy slot is held by ${current.owner} (${current.what}, pid ${current.pid}, since ${current.started_at})`
  );
}

export type WaitOptions = LockOptions & {
  /** How often to look again (default 30 s). */
  pollMs?: number;
  /** Give up after this long (default: never). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called on each refusal with the holder, so a run row can say what it is waiting for. */
  onWait?: (holder: HeavyLock, waitedMs: number) => void;
  /** Injectable sleep (the tests do not wait 30 s). */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Take the heavy lock, waiting while someone else holds it live. Rejects
 * with the last LockHeldError on timeout, or with an AbortError when the
 * signal fires. A stale lock never blocks: it is replaced at once.
 */
export async function waitForHeavyLock(root: string, req: { owner?: string; what: string; pid?: number }, opts: WaitOptions = {}): Promise<Held<HeavyLock>> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 30_000;
  const started = now();
  for (;;) {
    if (opts.signal?.aborted) throw Object.assign(new Error("cancelled while waiting for the heavy lock"), { name: "AbortError" });
    try {
      return heavyLock(root, req, opts);
    } catch (e) {
      if (!(e instanceof LockHeldError)) throw e;
      const waited = now() - started;
      opts.onWait?.(e.holder as HeavyLock, waited);
      if (opts.timeoutMs !== undefined && waited + pollMs > opts.timeoutMs) throw e;
      await sleep(pollMs);
    }
  }
}

/** The name a worker leases and locks under: `<host>:<pid>`. */
export function workerName(pid = ownPid()): string {
  return `${os.hostname()}:${pid}`;
}
