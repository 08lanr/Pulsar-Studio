// The two lock files (lib/locks.ts) on a temp dir with a fake pid liveness:
// the run lock's shape, adoption by the same run, refusal of another live
// run, replacement of a stale one (dead pid, or older than six hours) with
// the replacement reported, update and release, a release that never removes
// a lock someone else took; the heavy lock the same way, plus the wait that
// polls until the holder lets go; and the real pid check on this process.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  HEAVY_LOCK_FILE,
  LOCK_STALE_MS,
  LockHeldError,
  STUDIO_LOCK_OWNER,
  STUDIO_RUN_LOCK_FILE,
  heavyLock,
  heavyLockPath,
  heavyLockRoot,
  pidAlive,
  readLock,
  staleReason,
  studioRunLock,
  studioRunLockPath,
  waitForHeavyLock,
  workerName,
  type HeavyLock,
  type StudioRunLock,
} from "@/lib/locks";

const T0 = Date.parse("2026-09-23T12:00:00.000Z");

function withDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "studio-locks-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A liveness table: every pid in `alive` is running. */
const aliveSet = (...alive: number[]) => (pid: number) => alive.includes(pid);

test("the run lock: written with the README's shape, adopted by the same run, refused for another live run", () =>
  withDir((dir) => {
    const cut = path.join(dir, "film", "cut");
    const opts = { isAlive: aliveSet(100, 200), now: () => T0 };
    const held = studioRunLock(cut, { run_id: "run-a", stage: "index", pid: 100 }, opts);
    assert.equal(held.file, path.join(cut, STUDIO_RUN_LOCK_FILE));
    assert.equal(held.file, studioRunLockPath(cut));
    assert.equal(held.replaced, null);
    const onDisk = JSON.parse(readFileSync(held.file, "utf8")) as StudioRunLock;
    assert.deepEqual(onDisk, { run_id: "run-a", stage: "index", started_at: "2026-09-23T12:00:00.000Z", pid: 100, owner: STUDIO_LOCK_OWNER });

    assert.throws(() => studioRunLock(cut, { run_id: "run-b", stage: "plan", pid: 200 }, opts), (e: unknown) => e instanceof LockHeldError && /run run-a/.test(e.message) && (e.holder as StudioRunLock).pid === 100);
    const again = studioRunLock(cut, { run_id: "run-a", stage: "plan", pid: 200 }, opts);
    assert.equal(again.replaced, null, "the same run adopts its own lock (a restarted worker)");
    assert.equal((readLock<StudioRunLock>(held.file) as StudioRunLock).stage, "plan");

    again.update({ stage: "render" });
    assert.equal((readLock<StudioRunLock>(held.file) as StudioRunLock).stage, "render");
    assert.equal(again.release(), true);
    assert.equal(existsSync(held.file), false);
    assert.equal(again.release(), false, "a second release is a no-op");
    again.update({ stage: "qa" });
    assert.equal(existsSync(held.file), false, "an update after release writes nothing");
  }));

test("a stale run lock (dead pid, or older than six hours) is replaced and the replacement says so; a release never removes another holder's lock", () =>
  withDir((dir) => {
    const cut = path.join(dir, "cut");
    const dead = studioRunLock(cut, { run_id: "run-dead", stage: "index", pid: 999 }, { isAlive: aliveSet(999), now: () => T0 });
    const taken = studioRunLock(cut, { run_id: "run-new", stage: "index", pid: 100 }, { isAlive: aliveSet(100), now: () => T0 + 1000 });
    assert.deepEqual(taken.replaced, { lock: dead.lock, reason: "dead_pid" });
    assert.equal(taken.release(), true);

    const old = studioRunLock(cut, { run_id: "run-old", stage: "render", pid: 100 }, { isAlive: aliveSet(100), now: () => T0 });
    const later = studioRunLock(cut, { run_id: "run-later", stage: "index", pid: 100 }, { isAlive: aliveSet(100), now: () => T0 + LOCK_STALE_MS + 1 });
    assert.deepEqual(later.replaced, { lock: old.lock, reason: "too_old" });
    assert.equal(staleReason(old.lock, { isAlive: aliveSet(100), now: () => T0 + LOCK_STALE_MS }), null, "exactly six hours is still in force");

    // run-old's holder comes back and releases: the file now belongs to run-later, so nothing is removed.
    assert.equal(old.release(), false);
    assert.ok(existsSync(later.file));
    assert.equal((readLock<StudioRunLock>(later.file) as StudioRunLock).run_id, "run-later");
    assert.equal(later.release(), true);

    // A broken file is not a lock: replaced, reported as nothing (there was nothing to read).
    writeFileSync(path.join(cut, STUDIO_RUN_LOCK_FILE), "{ not json");
    assert.equal(readLock(path.join(cut, STUDIO_RUN_LOCK_FILE)), null);
    const over = studioRunLock(cut, { run_id: "run-x", stage: "index", pid: 100 }, { isAlive: aliveSet(100), now: () => T0 });
    assert.equal(over.replaced, null);
    assert.equal(over.release(), true);
  }));

test("the heavy lock: one per machine, adopted by the same pid and owner, refused while a session holds it live, stale ones replaced", () =>
  withDir((dir) => {
    const opts = { isAlive: aliveSet(1, 2), now: () => T0 };
    const mine = heavyLock(dir, { what: "index", pid: 1 }, opts);
    assert.equal(mine.file, path.join(dir, HEAVY_LOCK_FILE));
    assert.equal(mine.file, heavyLockPath(dir));
    assert.deepEqual(JSON.parse(readFileSync(mine.file, "utf8")), { owner: STUDIO_LOCK_OWNER, what: "index", pid: 1, started_at: "2026-09-23T12:00:00.000Z" });
    assert.throws(() => heavyLock(dir, { owner: "claude-code:she-returned", what: "render", pid: 2 }, opts), (e: unknown) => e instanceof LockHeldError && /held by pulsar-studio \(index, pid 1/.test(e.message));
    const same = heavyLock(dir, { what: "render", pid: 1 }, opts);
    assert.equal(same.replaced, null);
    assert.equal(same.release(), true);
    assert.equal(existsSync(mine.file), false);

    // A session's lock whose process died is stale: Studio takes the slot and reports what it replaced.
    writeFileSync(path.join(dir, HEAVY_LOCK_FILE), JSON.stringify({ owner: "claude-code:the-cold-ceo", what: "qa", pid: 77, started_at: "2026-09-23T11:00:00.000Z" }));
    const took = heavyLock(dir, { what: "index", pid: 1 }, opts);
    assert.equal(took.replaced?.reason, "dead_pid");
    assert.equal((took.replaced?.lock as HeavyLock).owner, "claude-code:the-cold-ceo");
    assert.equal(took.release(), true);
  }));

test("waitForHeavyLock polls until the holder lets go, reports whom it waits for, and gives up on a timeout", () =>
  withDir(async (dir) => {
    let clock = T0;
    const opts = { isAlive: aliveSet(1, 2), now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 1000 };
    const session = heavyLock(dir, { owner: "claude-code:x", what: "render", pid: 2 }, opts);
    const waits: string[] = [];
    let polls = 0;
    const acquired = waitForHeavyLock(dir, { what: "index", pid: 1 }, {
      ...opts,
      sleep: async (ms) => {
        clock += ms;
        if (++polls === 3) session.release();
      },
      onWait: (holder, waited) => waits.push(`${holder.owner}@${waited}`),
    });
    const held = await acquired;
    assert.deepEqual(waits, ["claude-code:x@0", "claude-code:x@1000", "claude-code:x@2000"]);
    assert.equal(held.lock.what, "index");
    assert.equal(held.replaced, null, "the holder released; nothing was stale");
    held.release();

    const forever = heavyLock(dir, { owner: "claude-code:y", what: "render", pid: 2 }, opts);
    await assert.rejects(waitForHeavyLock(dir, { what: "index", pid: 1 }, { ...opts, timeoutMs: 2500 }), (e: unknown) => e instanceof LockHeldError && /claude-code:y/.test(e.message));
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(waitForHeavyLock(dir, { what: "index", pid: 1 }, { ...opts, signal: ac.signal }), /cancelled/);
    forever.release();
  }));

test("heavyLockRoot: HEAVY_LOCK_ROOT, else the folder above WORKSPACE_ROOT; pidAlive on this process and on a pid that cannot exist; workerName", () => {
  const prevRoot = process.env.HEAVY_LOCK_ROOT;
  const prevWs = process.env.WORKSPACE_ROOT;
  try {
    process.env.HEAVY_LOCK_ROOT = "C:/locks";
    assert.equal(heavyLockRoot(), path.resolve("C:/locks"));
    delete process.env.HEAVY_LOCK_ROOT;
    process.env.WORKSPACE_ROOT = "C:/mds/projects";
    assert.equal(heavyLockRoot(), path.resolve("C:/mds"));
    assert.equal(heavyLockPath(), path.join(path.resolve("C:/mds"), HEAVY_LOCK_FILE));
  } finally {
    if (prevRoot === undefined) delete process.env.HEAVY_LOCK_ROOT;
    else process.env.HEAVY_LOCK_ROOT = prevRoot;
    if (prevWs === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = prevWs;
  }
  assert.equal(pidAlive(process.pid), true, "this process is alive");
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-5), false);
  assert.equal(pidAlive(2147483000), false, "a pid no Windows or Linux process holds");
  assert.match(workerName(4321), /^.+:4321$/);
});
