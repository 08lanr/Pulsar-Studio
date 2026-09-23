// The script sync (lib/segment/scripts-sync.ts) on a temp git repo shaped
// like drama-remix: every file of scripts/cut-only copied, the .route
// dotfile included and __pycache__ left out, the sha and the dirty flag
// recorded beside the copy (never inside scripts/, which checks.py audits),
// a dirty tree refused unless allowed, the refusals for a missing checkout;
// and, when the real drama-remix is on this machine, its state read without
// touching it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CUT_ONLY_SCRIPTS, SYNC_RECORD_FILE, ScriptsSyncError, dramaRemixRoot, dramaRemixState, listSyncFiles, readSyncRecord, removeSyncedScripts, syncScripts } from "@/lib/segment/scripts-sync";

const gitOk = spawnSync("git", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;

function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A tiny drama-remix: scripts/cut-only with a .route, two scripts, a README, a __pycache__ and a .pyc; one commit. */
function fakeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "studio-remix-"));
  const scripts = path.join(root, CUT_ONLY_SCRIPTS);
  mkdirSync(path.join(scripts, "__pycache__"), { recursive: true });
  writeFileSync(path.join(scripts, ".route"), "cut-only\n");
  writeFileSync(path.join(scripts, "pick_cuts.py"), "print('pick')\n");
  writeFileSync(path.join(scripts, "index_cut.sh"), "echo index\n");
  writeFileSync(path.join(scripts, "README.md"), "# cut-only\n");
  writeFileSync(path.join(scripts, "pick_by_eye.workflow.js"), "// wf\n");
  writeFileSync(path.join(scripts, "__pycache__", "pick_cuts.cpython-312.pyc"), "x");
  writeFileSync(path.join(scripts, "stray.pyc"), "x");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "scripts");
  return root;
}

test("syncScripts copies every file of scripts/cut-only (the .route dotfile too, no __pycache__ or .pyc) and records the sha beside the copy", (t) => {
  if (!gitOk) return t.skip("no git");
  const root = fakeRepo();
  const film = mkdtempSync(path.join(tmpdir(), "studio-film-"));
  try {
    const cut = path.join(film, "cut");
    mkdirSync(cut);
    assert.deepEqual(listSyncFiles(path.join(root, CUT_ONLY_SCRIPTS)), [".route", "README.md", "index_cut.sh", "pick_by_eye.workflow.js", "pick_cuts.py"]);
    const r = syncScripts(cut, { root, now: () => Date.parse("2026-09-23T12:00:00.000Z") });
    assert.equal(r.sha, git(root, "rev-parse", "HEAD").trim());
    assert.equal(r.dirty, false);
    assert.deepEqual(r.dirty_paths, []);
    assert.deepEqual(r.files, [".route", "README.md", "index_cut.sh", "pick_by_eye.workflow.js", "pick_cuts.py"]);
    assert.equal(r.scripts_dir, path.join(cut, "scripts"));
    assert.deepEqual(readdirSync(path.join(cut, "scripts")).sort(), [".route", "README.md", "index_cut.sh", "pick_by_eye.workflow.js", "pick_cuts.py"], "no sidecar and no pycache inside scripts/: checks.py --strict would flag an extra file");
    assert.equal(readFileSync(path.join(cut, "scripts", ".route"), "utf8"), "cut-only\n");
    assert.equal(r.record_file, path.join(cut, SYNC_RECORD_FILE));
    const record = readSyncRecord(cut);
    assert.equal(record?.sha, r.sha);
    assert.equal(record?.synced_at, "2026-09-23T12:00:00.000Z");
    assert.ok(!existsSync(path.join(cut, "scripts", ".tmp")));

    // A second sync after a commit replaces the copy and the record.
    writeFileSync(path.join(root, CUT_ONLY_SCRIPTS, "pick_cuts.py"), "print('pick v2')\n");
    git(root, "commit", "-q", "-am", "v2");
    const r2 = syncScripts(cut, { root });
    assert.notEqual(r2.sha, r.sha);
    assert.equal(readFileSync(path.join(cut, "scripts", "pick_cuts.py"), "utf8"), "print('pick v2')\n");
    assert.equal(readSyncRecord(cut)?.sha, r2.sha);
    removeSyncedScripts(cut);
    assert.equal(existsSync(path.join(cut, "scripts")), false);
    assert.equal(readSyncRecord(cut), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(film, { recursive: true, force: true });
  }
});

test("a dirty working tree is refused with its paths, unless the run allows it; the record then says dirty", (t) => {
  if (!gitOk) return t.skip("no git");
  const root = fakeRepo();
  const film = mkdtempSync(path.join(tmpdir(), "studio-film-"));
  try {
    const cut = path.join(film, "cut");
    mkdirSync(cut);
    writeFileSync(path.join(root, CUT_ONLY_SCRIPTS, "pick_cuts.py"), "print('edited, not committed')\n");
    writeFileSync(path.join(root, "notes.md"), "untracked\n");
    const state = dramaRemixState(root);
    assert.equal(state.dirty, true);
    assert.deepEqual(state.dirty_paths.sort(), [" M scripts/cut-only/pick_cuts.py", "?? notes.md"]);
    assert.throws(() => syncScripts(cut, { root }), (e: unknown) => e instanceof ScriptsSyncError && e.code === "dirty" && /pick_cuts\.py/.test(e.message) && /commit them/.test(e.message));
    assert.equal(existsSync(path.join(cut, "scripts")), false, "a refusal copies nothing");
    const r = syncScripts(cut, { root, allowDirty: true });
    assert.equal(r.dirty, true);
    assert.equal(readSyncRecord(cut)?.dirty, true);
    assert.equal(readFileSync(path.join(cut, "scripts", "pick_cuts.py"), "utf8"), "print('edited, not committed')\n", "the working tree is what is copied, as cp does");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(film, { recursive: true, force: true });
  }
});

test("the refusals: no checkout, a folder that is not a checkout, a checkout without the scripts or the .route file", (t) => {
  if (!gitOk) return t.skip("no git");
  const film = mkdtempSync(path.join(tmpdir(), "studio-film-"));
  const plain = mkdtempSync(path.join(tmpdir(), "studio-plain-"));
  const prevRoot = process.env.DRAMA_REMIX_ROOT;
  const prevWs = process.env.WORKSPACE_ROOT;
  try {
    // Where the checkout is looked for (lib/python.ts): DRAMA_REMIX_ROOT, else beside WORKSPACE_ROOT's parent when that folder exists, else the sibling checkout of this repo.
    delete process.env.DRAMA_REMIX_ROOT;
    process.env.WORKSPACE_ROOT = path.join(plain, "projects");
    assert.equal(dramaRemixRoot(), path.resolve(process.cwd(), "..", "Pulsar-Workspace", "mini-drama-system", "drama-remix"), "no drama-remix beside an unrelated WORKSPACE_ROOT: the sibling checkout");
    mkdirSync(path.join(plain, "drama-remix"));
    assert.equal(dramaRemixRoot(), path.join(plain, "drama-remix"), "a drama-remix folder beside WORKSPACE_ROOT's parent wins over the sibling");
    process.env.DRAMA_REMIX_ROOT = path.join(plain, "missing");
    assert.equal(dramaRemixRoot(), path.join(plain, "missing"), "DRAMA_REMIX_ROOT wins, whether or not it exists");
    assert.throws(() => syncScripts(path.join(film, "cut")), (e: unknown) => e instanceof ScriptsSyncError && e.code === "no_repo" && /no drama-remix checkout at/.test(e.message));
    process.env.DRAMA_REMIX_ROOT = plain;
    assert.equal(dramaRemixRoot(), path.resolve(plain));
    assert.throws(() => syncScripts(path.join(film, "cut")), (e: unknown) => e instanceof ScriptsSyncError && e.code === "no_scripts");
    mkdirSync(path.join(plain, CUT_ONLY_SCRIPTS), { recursive: true });
    writeFileSync(path.join(plain, CUT_ONLY_SCRIPTS, "pick_cuts.py"), "x");
    assert.throws(() => syncScripts(path.join(film, "cut")), (e: unknown) => e instanceof ScriptsSyncError && e.code === "no_repo" && /not a git checkout/.test(e.message));
    git(plain, "init", "-q");
    git(plain, "add", "-A");
    git(plain, "commit", "-q", "-m", "x");
    assert.throws(() => syncScripts(path.join(film, "cut")), (e: unknown) => e instanceof ScriptsSyncError && e.code === "no_scripts" && /\.route/.test(e.message));
  } finally {
    if (prevRoot === undefined) delete process.env.DRAMA_REMIX_ROOT;
    else process.env.DRAMA_REMIX_ROOT = prevRoot;
    if (prevWs === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = prevWs;
    rmSync(film, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("the real drama-remix, when it is on this machine: its state reads, its cut-only scripts list the pipeline's files; nothing is written there", (t) => {
  if (!gitOk) return t.skip("no git");
  const root = process.env.DRAMA_REMIX_ROOT?.trim() || path.resolve(process.cwd(), "..", "Pulsar-Workspace", "mini-drama-system", "drama-remix");
  if (!existsSync(path.join(root, CUT_ONLY_SCRIPTS, "pick_cuts.py"))) return t.skip(`no drama-remix at ${root}; set DRAMA_REMIX_ROOT to run this`);
  const state = dramaRemixState(root);
  assert.match(state.sha, /^[0-9a-f]{40}$/);
  assert.equal(typeof state.dirty, "boolean");
  const files = listSyncFiles(path.join(root, CUT_ONLY_SCRIPTS));
  for (const name of [".route", "README.md", "index_cut.sh", "pick_cuts.py", "cut_episodes.py", "apply_vision.py", "boundary_frames.py", "qa_episodes.py", "checks.py", "cards.py"]) {
    assert.ok(files.includes(name), `${name} is synced`);
  }
  assert.ok(!files.some((f) => f.endsWith(".pyc") || f.includes("__pycache__")));
});
