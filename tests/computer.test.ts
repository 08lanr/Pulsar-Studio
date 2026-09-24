// This computer (lib/computer.ts, lib/computer-setup.ts; decision 2026-09-24,
// "two computers, one database"): the settings file is created with an id
// and kept; the films folder and the Python it names are laid over the
// environment and clearing them gives the server's own values back; a
// disabled file leaves the environment alone and refuses to save; a run
// belongs to the computer that started it (and a run from before the stamp
// to whichever computer has its folder); and a picked folder becomes a
// projects folder only the way the pipeline lays itself out — never by
// filling a folder that holds other things.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  COMPUTER_ID,
  applyComputerSettings,
  filmsFolderSource,
  readComputerFile,
  resetComputerForTests,
  runComputerOf,
  runIsHere,
  saveComputer,
  thisComputer,
  type Env,
} from "@/lib/computer";
import { cleanFolderInput, connectFilmsFolder, countFilms, planFilmsFolder } from "@/lib/computer-setup";
import { isDataError } from "@/lib/data";

let dir: string;
const saved = { file: process.env.STUDIO_COMPUTER_FILE, ws: process.env.WORKSPACE_ROOT };

beforeEach(() => {
  resetComputerForTests();
  dir = mkdtempSync(path.join(tmpdir(), "studio-computer-"));
});

afterEach(() => {
  resetComputerForTests();
  rmSync(dir, { recursive: true, force: true });
  if (saved.file === undefined) delete process.env.STUDIO_COMPUTER_FILE;
  else process.env.STUDIO_COMPUTER_FILE = saved.file;
  if (saved.ws === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = saved.ws;
});

test("the file is created with an id on the first read, kept after, and replaced when it has no valid id", () => {
  const file = path.join(dir, "computer.json");
  const env: Env = { STUDIO_COMPUTER_FILE: file };
  const first = readComputerFile(env);
  assert.match(first.id, COMPUTER_ID);
  assert.ok(first.name.length > 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).id, first.id, "written to disk");
  resetComputerForTests();
  assert.equal(readComputerFile(env).id, first.id, "the same id on the next process");
  writeFileSync(file, JSON.stringify({ id: "not-an-id", films_folder: "/x" }));
  resetComputerForTests();
  const replaced = readComputerFile(env);
  assert.notEqual(replaced.id, first.id);
  assert.equal(replaced.films_folder, undefined, "a file without a valid id keeps none of its other keys");
});

test("the films folder and the Python are laid over the environment; clearing them brings the server's values back", () => {
  const env: Env = { STUDIO_COMPUTER_FILE: path.join(dir, "c.json"), WORKSPACE_ROOT: "/server/projects" };
  applyComputerSettings(env);
  assert.equal(env.WORKSPACE_ROOT, "/server/projects", "nothing in the file: the server's value stands");
  assert.equal(filmsFolderSource(env), "server");
  saveComputer({ films_folder: "/mine/projects", python: "/usr/bin/python3.12", name: "  Andrew's   Mac  " }, env);
  assert.equal(env.WORKSPACE_ROOT, "/mine/projects");
  assert.equal(env.STUDIO_PIPELINE_PYTHON, "/usr/bin/python3.12");
  assert.equal(filmsFolderSource(env), "computer");
  assert.equal(thisComputer(env).name, "Andrew's Mac", "the name is trimmed");
  saveComputer({ films_folder: null, python: null }, env);
  assert.equal(env.WORKSPACE_ROOT, "/server/projects", "cleared: the server's own value again");
  assert.equal(env.STUDIO_PIPELINE_PYTHON, undefined);
  saveComputer({ name: "x".repeat(200) }, env);
  assert.equal(thisComputer(env).name.length, 60);
});

test("a disabled file names a fixed computer, leaves the environment alone and refuses to save", () => {
  const env: Env = { STUDIO_COMPUTER_FILE: "off", WORKSPACE_ROOT: "/server/projects" };
  const a = thisComputer(env);
  resetComputerForTests();
  assert.deepEqual(thisComputer(env), a, "the same computer on every read");
  assert.match(a.id, COMPUTER_ID);
  applyComputerSettings(env);
  assert.equal(env.WORKSPACE_ROOT, "/server/projects");
  assert.throws(() => saveComputer({ name: "x" }, env), (e: unknown) => isDataError(e) && e.code === "conflict");
});

test("a run belongs to the computer that started it; a run from before the stamp to the computer with its folder", () => {
  const me = { id: "cmp_0000000000000001", name: "Ruobin's PC" };
  const other = { id: "cmp_0000000000000002", name: "Andrew's Mac" };
  const base = { bucket: "low-quality", slug: "a-film", stage: "index" };
  assert.equal(runIsHere({ ...base, settings: { computer: me } }, null, me), true);
  assert.equal(runIsHere({ ...base, settings: { computer: other } }, dir, me), false, "another computer's run, whatever this disk holds");
  assert.deepEqual(runComputerOf({ settings: { computer: other } }), other);
  assert.equal(runComputerOf({ settings: { computer: { id: "nope", name: "x" } } }), null);
  assert.equal(runIsHere({ ...base, settings: {} }, dir, me), false, "an old run whose folder is not here");
  mkdirSync(path.join(dir, "low-quality", "a-film"), { recursive: true });
  assert.equal(runIsHere({ ...base, settings: {} }, dir, me), true, "an old run whose folder is here");
  assert.equal(runIsHere({ ...base, stage: "queued", settings: {} }, null, me), true, "an old queued run: its folder is made at intake");
});

test("a picked folder becomes a projects folder the pipeline's way, and a folder with other things in it is refused", () => {
  const cwd = path.join(dir, "studio");
  mkdirSync(cwd);
  const opts = { cwd, home: dir };
  // A projects folder: named so, or holding a bucket.
  const projects = path.join(dir, "ws", "projects");
  mkdirSync(projects, { recursive: true });
  assert.equal(planFilmsFolder(projects, opts).films, projects);
  const bucketed = path.join(dir, "films");
  mkdirSync(path.join(bucketed, "low-quality"), { recursive: true });
  assert.equal(planFilmsFolder(bucketed, opts).films, bucketed);
  // Its parent (mini-drama-system's shape): the projects inside it.
  writeFileSync(path.join(dir, "ws", "SUMMARY.md"), "x");
  assert.equal(planFilmsFolder(path.join(dir, "ws"), opts).films, projects);
  // Empty, or new: a root with projects/ inside; the pipeline's folder does not count as content.
  const empty = path.join(dir, "empty");
  mkdirSync(path.join(empty, "drama-remix"), { recursive: true });
  const plan = planFilmsFolder(empty, opts);
  assert.equal(plan.films, path.join(empty, "projects"));
  assert.equal(plan.root, empty);
  assert.equal(plan.create.length, 3, "projects and its two buckets");
  assert.equal(planFilmsFolder(path.join(dir, "new"), opts).films, path.join(dir, "new", "projects"));
  // Quotes from "Copy as path" and a leading ~.
  assert.equal(cleanFolderInput(`"${projects}"`, dir), projects);
  assert.equal(cleanFolderInput("~/Pulsar Films", dir), path.join(dir, "Pulsar Films"));
  // Refusals.
  const busy = path.join(dir, "documents");
  mkdirSync(busy);
  writeFileSync(path.join(busy, "tax.pdf"), "x");
  for (const [raw, why] of [
    [busy, /already holds other things/],
    ["relative/folder", /whole path/],
    [path.join(busy, "tax.pdf"), /a file, not a folder/],
    [path.join(cwd, "films"), /outside Studio's own folder/],
    ["  ", /Enter a folder/],
  ] as const) {
    assert.throws(() => planFilmsFolder(raw, opts), (e: unknown) => isDataError(e) && e.code === "invalid" && why.test(e.message), String(raw));
  }
});

test("connecting a folder makes the projects folder and its buckets and saves it for this computer", () => {
  process.env.STUDIO_COMPUTER_FILE = path.join(dir, "computer.json");
  const target = path.join(dir, "Pulsar Films");
  const plan = connectFilmsFolder(target);
  for (const p of [plan.films, path.join(plan.films, "low-quality"), path.join(plan.films, "high-quality")]) assert.ok(existsSync(p), p);
  assert.equal(readComputerFile().films_folder, plan.films);
  assert.equal(process.env.WORKSPACE_ROOT, plan.films, "in force at once");
  mkdirSync(path.join(plan.films, "low-quality", "a-film"));
  mkdirSync(path.join(plan.films, "love-between-lines"));
  mkdirSync(path.join(plan.films, "low-quality", "_scratch"));
  assert.equal(countFilms(plan.films), 2, "bucketed films and the older top-level ones; scratch folders left out");
});
