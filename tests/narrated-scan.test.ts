// The scanner learns a narrated delivery (decision 2026-09-23 "Narrated mode
// in Studio"; spec N7): a project with DELIVERED-narrated.json and no cut/ is
// READY when every file is there with its size and SHA-256, inside the
// project, numbers run on from the first (not from 1), every gate FAIL is 0,
// nothing unwaived is left and every episode was approved — no licence gate
// (amendment 5). A junctioned episode of another project is never claimed; a
// project without the manifest stays NO_MANIFEST, as before; the skip-through
// scripts sync to the film root with a SHA-256 per file and no .route needed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NARRATED_MANIFEST_FILE, narratedManifestProblems, parseNarratedManifest } from "@/lib/film-import/manifest";
import { listProjects, narratedOf, scanFilm } from "@/lib/film-import/scan";
import { SKIP_THROUGH_SCRIPTS, readSyncRecord, syncScripts, syncSkipThrough, ScriptsSyncError } from "@/lib/segment/scripts-sync";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const OLD = Date.now() / 1000 - 3600;

function episode(n: number, project: string, file: string, bytes: string, over: Record<string, unknown> = {}) {
  return {
    n,
    project,
    variant: "v2",
    file,
    sha256: sha(bytes),
    bytes: Buffer.byteLength(bytes),
    duration_s: 201.5,
    frames: 6045,
    title: `EPISODE ${n}`,
    subtitle: "A plain name",
    srt: null,
    ass: null,
    gate: { PASS: 27, WARN: 5, FAIL: 0, file: null },
    user_review: null,
    pieces: [{ id: "P1", src_in: 140, src_out: 180.5, mode: "kept" }],
    narration: { file: `ep${n}/narration.json`, sha256: null, lines: 7, chars: 912, voice: "jess", model: "eleven_v3" },
    frame_check: { lines: 7, contradicted_unwaived: 0 },
    cut_joins: { joins: 2, lost_unwaived: 0 },
    approved_by: "ruobin",
    approved_at: "2026-09-23T20:00:00.000Z",
    ...over,
  };
}

function workspace(): { root: string; film: string; write: (eps: ReturnType<typeof episode>[], over?: Record<string, unknown>) => void } {
  const root = mkdtempSync(path.join(tmpdir(), "studio-nscan-"));
  const film = path.join(root, "high-quality", "lbl-s01e05");
  mkdirSync(path.join(film, "source"), { recursive: true });
  writeFileSync(path.join(film, "source", "original.mp4"), "source");
  for (const n of [36, 37]) {
    const dir = path.join(film, `ep${n}`, "variants", "v2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `ep${n}.mp4`), `episode ${n} bytes`);
    utimesSync(path.join(dir, `ep${n}.mp4`), OLD, OLD);
  }
  const write = (eps: ReturnType<typeof episode>[], over: Record<string, unknown> = {}) =>
    writeFileSync(
      path.join(film, NARRATED_MANIFEST_FILE),
      JSON.stringify({ route: "skip-through", version: 1, series_key: "love-between-lines", title_source_ref: "love-between-lines", source: { file: "source/original.mp4", sha256: sha("source"), duration_s: 2577 }, lang: "zh", caption_lang: "en", intro_s: 6.04, drama_remix_sha: "a".repeat(40), episodes: eps, ...over })
    );
  return { root, film, write };
}

const ref = "high-quality/lbl-s01e05";
const good = () => [episode(36, ref, "ep36/variants/v2/ep36.mp4", "episode 36 bytes"), episode(37, ref, "ep37/variants/v2/ep37.mp4", "episode 37 bytes")];

test("a narrated delivery with every file, hash, gate and approval in place is READY, numbered from its own first episode", async () => {
  const w = workspace();
  try {
    w.write(good());
    const s = await scanFilm(ref, { root: w.root });
    assert.equal(s.state, "READY", JSON.stringify(narratedOf(s)?.problems));
    assert.equal(s.reason, null);
    assert.equal(s.pipeline_stage, "DELIVERED");
    assert.deepEqual(s.episodes.map((e) => e.n), [36, 37]);
    assert.equal(s.episodes[0].file, `${ref}/ep36/variants/v2/ep36.mp4`);
    assert.equal(s.delivered, null, "no cut-only plan: the import's cut-only path refuses it until it learns the manifest");
    const n = narratedOf(s);
    assert.equal(n?.first_n, 36);
    assert.equal(n?.last_n, 37);
    assert.equal(n?.manifest?.title_source_ref, "love-between-lines");
    assert.equal(s.language, "zh");
    assert.ok((await listProjects({ root: w.root })).some((p) => p.source_ref === ref), "a narrated project is listed under its bucket");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a changed file, a gate FAIL, an unwaived contradiction or lost join, a missing approval each keep it from READY, in words", async () => {
  const w = workspace();
  try {
    w.write([episode(36, ref, "ep36/variants/v2/ep36.mp4", "other bytes"), good()[1]]);
    let s = await scanFilm(ref, { root: w.root });
    assert.equal(s.state, "NOT_DELIVERED");
    assert.equal(s.reason?.code, "bad_delivered");
    assert.match(narratedOf(s)?.problems.join(" ") ?? "", /ep36: .* is 16 bytes, the manifest says 11|SHA-256/);

    w.write([episode(36, ref, "ep36/variants/v2/ep36.mp4", "episode 36 bytes", { sha256: "b".repeat(64) }), good()[1]]);
    s = await scanFilm(ref, { root: w.root });
    assert.match(narratedOf(s)?.problems.join(" ") ?? "", /ep36: .*SHA-256 is not the manifest's/);

    w.write([episode(36, ref, "ep36/variants/v2/ep36.mp4", "episode 36 bytes", { gate: { PASS: 20, WARN: 5, FAIL: 1, file: null }, approved_at: null, frame_check: { lines: 7, contradicted_unwaived: 1 }, cut_joins: { joins: 2, lost_unwaived: 1 } }), good()[1]]);
    s = await scanFilm(ref, { root: w.root });
    const p = narratedOf(s)?.problems.join(" | ") ?? "";
    assert.match(p, /gate has FAIL 1/);
    assert.match(p, /unwaived contradicted/);
    assert.match(p, /unwaived lost join/);
    assert.match(p, /no approval/);
    assert.doesNotMatch(p, /licen[cs]e/i, "no rights gate anywhere (amendment 5)");

    w.write([good()[0], episode(38, ref, "ep38/variants/v2/ep38.mp4", "x")]);
    s = await scanFilm(ref, { root: w.root });
    assert.equal(s.state, "NO_MANIFEST", "numbers must run on");
    assert.equal(s.reason?.code, "bad_delivered");

    w.write([good()[0], episode(37, ref, "ep37/variants/v2/ep37.mp4", "episode 37 bytes"), episode(38, ref, "ep38/variants/v2/ep38.mp4", "missing")]);
    s = await scanFilm(ref, { root: w.root });
    assert.equal(s.state, "NOT_DELIVERED");
    assert.deepEqual(s.reason, { code: "episode_gap", missing: [38], duplicates: [] });
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a render still writing and a fresh write keep it RENDERING; the quiet rule can be switched off", async () => {
  const w = workspace();
  try {
    w.write(good());
    writeFileSync(path.join(w.film, "ep37", "variants", "v2", "ep37.mp4.part"), "x");
    let s = await scanFilm(ref, { root: w.root });
    assert.equal(s.state, "RENDERING");
    assert.equal(s.reason?.code, "part_file");
    rmSync(path.join(w.film, "ep37", "variants", "v2", "ep37.mp4.part"));
    utimesSync(path.join(w.film, "ep37", "variants", "v2", "ep37.mp4"), new Date(), new Date());
    s = await scanFilm(ref, { root: w.root });
    assert.equal(s.state, "RENDERING");
    assert.equal(s.reason?.code, "recent_write");
    s = await scanFilm(ref, { root: w.root, quietMs: 0 });
    assert.equal(s.state, "READY");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("an episode of another project is never claimed: not by its project field, not through a junction", async () => {
  const w = workspace();
  try {
    const prior = path.join(w.root, "lbl-e04", "ep35", "variants", "v1");
    mkdirSync(prior, { recursive: true });
    writeFileSync(path.join(prior, "ep35.mp4"), "prior bytes");
    utimesSync(path.join(prior, "ep35.mp4"), OLD, OLD);
    symlinkSync(path.join(w.root, "lbl-e04", "ep35"), path.join(w.film, "ep35"), process.platform === "win32" ? "junction" : "dir");
    w.write([episode(35, ref, "ep35/variants/v1/ep35.mp4", "prior bytes", { variant: "v1" }), ...good()]);
    let s = await scanFilm(ref, { root: w.root });
    assert.notEqual(s.state, "READY");
    assert.match(narratedOf(s)?.problems.join(" ") ?? "", /ep35: .*resolves outside this project/);
    w.write([episode(36, "lbl-e04", "ep36/variants/v2/ep36.mp4", "episode 36 bytes"), good()[1]]);
    s = await scanFilm(ref, { root: w.root });
    assert.match(narratedOf(s)?.problems.join(" ") ?? "", /ep36 belongs to lbl-e04/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a folder without the manifest is NO_MANIFEST: no_cut_dir, or — a skip-through project — the narrated delivery it lacks; a manifest that does not parse says why", async () => {
  const w = workspace();
  try {
    let s = await scanFilm(ref, { root: w.root });
    assert.equal(s.state, "NO_MANIFEST");
    assert.deepEqual(s.reason, { code: "no_cut_dir" });
    // A skip-through project (lbl-e02..e04, love-between-lines have scripts/build_ep.sh): the note names what it lacks.
    mkdirSync(path.join(w.film, "scripts"), { recursive: true });
    writeFileSync(path.join(w.film, "scripts", "build_ep.sh"), "echo");
    s = await scanFilm(ref, { root: w.root });
    assert.equal(s.state, "NO_MANIFEST");
    assert.deepEqual(s.reason, { code: "no_narrated_manifest", file: NARRATED_MANIFEST_FILE });
    assert.match(s.pipeline_note ?? "", /no DELIVERED-narrated\.json/);
    assert.doesNotMatch(s.pipeline_note ?? "", /candidates\.json/, "not the cut-only index's missing file");
    // Studio's own skip-through sync record says the same without the script.
    rmSync(path.join(w.film, "scripts"), { recursive: true, force: true });
    writeFileSync(path.join(w.film, ".studio-scripts.json"), JSON.stringify({ sha: "c".repeat(40), route: "skip-through", files: [] }));
    s = await scanFilm(ref, { root: w.root });
    assert.equal(s.reason?.code, "no_narrated_manifest");
    writeFileSync(path.join(w.film, NARRATED_MANIFEST_FILE), "{ not json");
    s = await scanFilm(ref, { root: w.root });
    assert.equal(s.state, "NO_MANIFEST");
    assert.equal(s.reason?.code, "bad_delivered");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("the manifest's own rules: from the first n, a route and version, files inside the project", () => {
  const m = parseNarratedManifest({ route: "skip-through", version: 1, series_key: "s", source: { file: "source/original.mp4" }, lang: "zh", caption_lang: "en", episodes: [episode(7, "p", "ep7/variants/v2/ep7.mp4", "x")] });
  assert.equal(m.episodes[0].n, 7, "a season numbers from where it is, not from 1");
  assert.throws(() => parseNarratedManifest({ ...m, route: "cut-only" }));
  assert.throws(() => parseNarratedManifest({ ...m, episodes: [] }));
  assert.deepEqual(narratedManifestProblems(parseNarratedManifest({ ...m, episodes: [episode(7, "p", "../other/ep7.mp4", "x")] }), { source_ref: "p", folder: "p" }), ["ep7's file ../other/ep7.mp4 is not inside the project"]);
});

// ---- the skip-through sync --------------------------------------------------------------------------------------

const gitOk = spawnSync("git", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
function git(root: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

test("the skip-through scripts sync to the film root with the commit and a SHA-256 per file; no .route is needed there (checks.py reads its absence as skip-through)", (t) => {
  if (!gitOk) return t.skip("no git");
  const repo = mkdtempSync(path.join(tmpdir(), "studio-remix-st-"));
  const film = mkdtempSync(path.join(tmpdir(), "studio-film-st-"));
  try {
    const st = path.join(repo, SKIP_THROUGH_SCRIPTS);
    mkdirSync(path.join(st, "__pycache__"), { recursive: true });
    writeFileSync(path.join(st, "PREP-BRIEF.md"), "# brief\n");
    writeFileSync(path.join(st, "build_ep.sh"), "echo build\n");
    writeFileSync(path.join(st, "__pycache__", "x.pyc"), "x");
    mkdirSync(path.join(repo, "scripts", "cut-only"), { recursive: true });
    writeFileSync(path.join(repo, "scripts", "cut-only", "pick_cuts.py"), "x");
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "st");
    const r = syncSkipThrough(film, { root: repo });
    assert.deepEqual(r.files, ["PREP-BRIEF.md", "build_ep.sh"]);
    assert.equal(r.route, "skip-through");
    assert.equal(r.scripts_dir, path.join(film, "scripts"));
    assert.equal(r.file_sha256?.["PREP-BRIEF.md"], sha("# brief\n"));
    assert.equal(readFileSync(path.join(film, "scripts", "build_ep.sh"), "utf8"), "echo build\n");
    assert.equal(readSyncRecord(film)?.route, "skip-through", "the record sits at the film root, beside scripts/");
    // The cut-only sync still insists on its .route.
    assert.throws(() => syncScripts(path.join(film, "cut"), { root: repo }), (e: unknown) => e instanceof ScriptsSyncError && /\.route/.test(e.message));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(film, { recursive: true, force: true });
  }
});
