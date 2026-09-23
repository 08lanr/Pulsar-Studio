// The pure pieces of the segment worker (lib/segment/*): the downloader's
// file name, the picker's roots and the typed-path refusal, which decisions
// wake a waiting run, a script's refusal kept verbatim, the evidence
// route's path rules and proxy names, the review state (who needs a
// decision, what a move may do), the override file apply_vision.py reads,
// the hand-off command, the watermark region, the fake's PNG, and the
// film-meta file.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkflowOutputSchema, applyVision, type WorkflowRecord } from "@/lib/segment/vision";
import type { OptionsDoc } from "@/lib/segment/strips";
import type { FilmRun, FilmRunDecision } from "@/lib/types";
import { cutRelUrl, evidencePathOf, evidenceUrl, proxyName, proxyTimeOf, proxyUrl } from "@/lib/segment/evidence";
import { fakePng } from "@/lib/segment/fake-runner";
import { defaultFilmMeta, readFilmMeta, writeFilmMeta } from "@/lib/segment/handoff";
import { isPlaceholder, linkOrCopy, parseMediaName, resolveSourceDir, resolveSourcePath, sourceRoots, suggestSlug } from "@/lib/segment/intake";
import { lengthsAround, listRunVisionFiles, moveRefusal, overrideRecord, reviewState, writeOverrideFile } from "@/lib/segment/plan";
import { CONFIDENCE_GATE, DECISION, consumed, filmRoot, handoffCommand, isActionable, pendingDecision, pendingDecisions, refusalOf, runDirs, visionLabel, waitingOf } from "@/lib/segment/stages";
import { regionArg, validRegion } from "@/lib/segment/watermark";

function withDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "studio-segment-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ---- intake -------------------------------------------------------------------------------------------------------------------------------

test("parseMediaName reads the downloader's _Media_<id>_<nnn>_<height>p name, ids with _ and - included; suggestSlug makes a folder name", () => {
  assert.deepEqual(parseMediaName("YTDown.com_YouTube_FULL-He-Hated-All-Women-Until-He-Met-The_Media_jjj7SudNGT4_002_720p.mp4"), { video_id: "jjj7SudNGT4", part: 2, height_p: 720 });
  assert.deepEqual(parseMediaName("C:\\Users\\ruobi\\Downloads\\YTDown.com_YouTube_FULL-My-Boyfriend-Sold-Me-to-a-Mafia-Kin_Media_K8D_WbCYJiI_002_720p.mp4"), { video_id: "K8D_WbCYJiI", part: 2, height_p: 720 });
  assert.deepEqual(parseMediaName("x_Media_EuGNXYhUV_Y_003_480p.mp4"), { video_id: "EuGNXYhUV_Y", part: 3, height_p: 480 });
  assert.equal(parseMediaName("original.mp4"), null);
  assert.equal(suggestSlug("YTDown.com_YouTube_FULL-He-Hated-All-Women-Until-He-Met-The_Media_jjj7SudNGT4_002_720p.mp4"), "he-hated-all-women-until-he");
  assert.equal(suggestSlug("ep01.mp4"), "ep01");
});

test("the picker's roots: Downloads, OneDrive/Mini Drama, the workspace, STUDIO_SOURCE_ROOTS and the fake root; a typed path outside them is refused", () =>
  withDir((dir) => {
    const extra = path.join(dir, "extra");
    mkdirSync(extra);
    const env = { WORKSPACE_ROOT: path.join(dir, "ws"), STUDIO_SOURCE_ROOTS: extra, STUDIO_FAKE_PIPELINE: "1", STUDIO_WORK_DIR: path.join(dir, "work") };
    const roots = sourceRoots(env);
    assert.deepEqual(roots.map((r) => r.key), ["downloads", "onedrive", "workspace", "extra1", "fake"]);
    assert.equal(roots.find((r) => r.key === "extra1")!.exists, true);
    assert.equal(roots.find((r) => r.key === "workspace")!.exists, false);
    assert.equal(resolveSourceDir("extra1", env), extra);
    assert.equal(resolveSourcePath(path.join(extra, "film.mp4"), env), path.join(extra, "film.mp4"));
    assert.throws(() => resolveSourcePath(path.join(dir, "elsewhere", "film.mp4"), env), /outside the folders Studio may read/);
    assert.throws(() => resolveSourcePath("relative/film.mp4", env), /absolute path/);
    assert.equal(filmRoot(env), path.join(dir, "work", "fake-workspace"), "the fake pipeline's films live under the work dir, never the fixture tree");
    assert.equal(filmRoot({ WORKSPACE_ROOT: path.join(dir, "ws") }), path.join(dir, "ws"));
    const dirs = runDirs({ id: "r1", bucket: "low-quality", slug: "my-film" }, env);
    assert.equal(dirs.cut, path.join(dir, "work", "fake-workspace", "low-quality", "my-film", "cut"));
    assert.equal(dirs.work, path.join(dir, "work", "r1"));
    assert.equal(isPlaceholder({ size: 10_000, blocks: 0 }), true);
    assert.equal(isPlaceholder({ size: 100, blocks: 0 }), false, "a tiny file lives in the MFT record");
    assert.equal(isPlaceholder({ size: 10_000, blocks: 8 }), false);
  }));

test("linkOrCopy links on one volume and never copies otherwise than across volumes", () =>
  withDir((dir) => {
    const src = path.join(dir, "a.mp4");
    writeFileSync(src, "bytes");
    assert.equal(linkOrCopy(src, path.join(dir, "film", "source", "original.mp4")), "linked");
    assert.equal(readFileSync(path.join(dir, "film", "source", "original.mp4"), "utf8"), "bytes");
  }));

// ---- the wait / wake rules ----------------------------------------------------------------------------------------------------------

const runAt = (stage: FilmRun["stage"], detail: Record<string, unknown>, decisions: FilmRunDecision[] = []): Pick<FilmRun, "stage" | "stage_detail" | "decisions"> => ({ stage, stage_detail: detail as FilmRun["stage_detail"], decisions });
const decision = (action: string, at = "2026-09-23T12:00:00.000Z"): FilmRunDecision => ({ at, by: "ruobin", action, boundary_s: null });

test("a run is actionable when not waiting; a waiting run only once a decision that wakes its wait arrived, or its poll is due; a terminal run never", () => {
  assert.equal(isActionable(runAt("index", {})), true);
  assert.equal(isActionable(runAt("done", {})), false);
  const waiting = { for: "watermark", since: "2026-09-23T12:00:00.000Z" };
  assert.equal(isActionable(runAt("watermark", { waiting, decisions_seen: 1 }, [decision("note")])), false, "the note came before the wait");
  assert.equal(isActionable(runAt("watermark", { waiting, decisions_seen: 1 }, [decision("note"), decision("note")])), false, "a note does not wake the watermark stage");
  assert.equal(isActionable(runAt("watermark", { waiting, decisions_seen: 1 }, [decision("note"), decision("watermark_accept")])), true);
  assert.equal(isActionable(runAt("review", { waiting: { ...waiting, for: "review" }, decisions_seen: 1 }, [decision("note"), decision("accept")])), false, "an accept alone does not apply");
  assert.equal(isActionable(runAt("review", { waiting: { ...waiting, for: "review" }, decisions_seen: 1 }, [decision("note"), decision("apply_review")])), true);
  const poll = { for: "ready", since: "2026-09-23T12:00:00.000Z", retry_after: "2026-09-23T12:00:30.000Z" };
  assert.equal(isActionable(runAt("handoff", { waiting: poll, decisions_seen: 0 }), Date.parse("2026-09-23T12:00:10.000Z")), false);
  assert.equal(isActionable(runAt("handoff", { waiting: poll, decisions_seen: 0 }), Date.parse("2026-09-23T12:00:31.000Z")), true);
  assert.deepEqual(waitingOf(runAt("handoff", { waiting: poll })), { for: "ready", since: "2026-09-23T12:00:00.000Z", retry_after: "2026-09-23T12:00:30.000Z" });
  assert.equal(waitingOf(runAt("index", {})), null);
  const run = runAt("watermark", { waiting, decisions_seen: 1 }, [decision("note"), decision("watermark_region"), decision("watermark_accept")]);
  assert.equal(pendingDecision(run, DECISION.watermark_accept, DECISION.watermark_region)?.action, "watermark_accept", "the newest pending decision wins");
  assert.deepEqual(pendingDecisions(runAt("render", { decisions_seen: 1 }, [decision("note"), decision("join")])).map((d) => d.action), ["join"], "a pending decision survives a stage change until a stage consumes it or a new wait begins");
  assert.deepEqual(consumed({ decisions: [decision("note"), decision("join")] }), { decisions_seen: 2 });
});

test("refusalOf keeps a script's refusal verbatim: the REFUSED block on stdout, else the sys.exit text on stderr, else the last line", () => {
  const base = { code: 1, signal: null, stdout: "", durationMs: 1, timedOut: false, cancelled: false };
  const step = { script: "cut_episodes.py", args: [], what: "" };
  const onStdout = refusalOf(step, { ...base, stdoutTail: "64 episodes, delogo\n  ep01 115.37s\nREFUSED - nothing rendered:\n  no index/watermark.json - run watermark.py --detect\n", stderrTail: "" });
  assert.equal(onStdout, "cut_episodes.py exited 1\nREFUSED - nothing rendered:\n  no index/watermark.json - run watermark.py --detect");
  const onStderr = refusalOf({ ...step, script: "pick_cuts.py" }, { ...base, stdoutTail: "applied 3 visual choices\n", stderrTail: "REFUSED: this film has delivered cuts (review/cuts-0-900-DELIVERED.json). Add\n  --pin-from review/cuts-0-900-DELIVERED.json\n" });
  assert.match(onStderr, /^pick_cuts\.py exited 1\nREFUSED: this film has delivered cuts/);
  assert.match(onStderr, /--pin-from review\/cuts-0-900-DELIVERED\.json/);
  assert.equal(refusalOf(step, { ...base, stdoutTail: "one\ntwo\n", stderrTail: "" }), "cut_episodes.py exited 1\ntwo");
  assert.match(refusalOf(step, { ...base, code: null, stdoutTail: "", stderrTail: "", timedOut: true }), /ran past its time limit/);
});

// ---- evidence -------------------------------------------------------------------------------------------------------------------------------

test("the evidence route serves png/json/mp4 under review/, index/ and the run's work folder only; a traversal, a bad segment, an episode or the source is null", () => {
  const dirs = { cut: path.join("C:", "ws", "low-quality", "film", "cut"), work: path.join("C:", "work", "run1") };
  assert.deepEqual(evidencePathOf(dirs, ["review", "frames", "b115_opt1.png"]), { area: "review", rel: "frames/b115_opt1.png", abs: path.join(dirs.cut, "review", "frames", "b115_opt1.png") });
  assert.equal(evidencePathOf(dirs, ["index", "watermark-found.png"])!.abs, path.join(dirs.cut, "index", "watermark-found.png"));
  assert.equal(evidencePathOf(dirs, ["work", "proxies", "t9_000.mp4"])!.abs, path.join(dirs.work, "proxies", "t9_000.mp4"));
  assert.equal(evidencePathOf(dirs, ["eps", "ep01.mp4"]), null, "an episode file is never served here");
  assert.equal(evidencePathOf(dirs, ["review", "..", "eps", "ep01.mp4"]), null);
  assert.equal(evidencePathOf(dirs, ["review", "x\\..\\..\\eps\\ep01.png"]), null, "a backslash inside a segment walks out on Windows");
  assert.equal(evidencePathOf(dirs, ["review", "a/b.png"]), null, "Next decodes %2F into one segment");
  assert.equal(evidencePathOf(dirs, ["index", "audio16k.wav"]), null);
  assert.equal(evidencePathOf(dirs, ["review"]), null);
  assert.equal(evidenceUrl("r1", "review", "frames/b115 x.png"), "/api/film-runs/r1/evidence/review/frames/b115%20x.png");
  assert.equal(cutRelUrl("r1", "review\\qa\\ep01.png"), "/api/film-runs/r1/evidence/review/qa/ep01.png");
  assert.equal(cutRelUrl("r1", "eps/ep01.mp4"), null);
  assert.equal(proxyName(9), "t9_000.mp4");
  assert.equal(proxyName(4313.4), "t4313_400.mp4");
  assert.equal(proxyTimeOf("t4313_400.mp4"), 4313.4);
  assert.equal(proxyTimeOf("ep01.mp4"), null);
  assert.equal(proxyUrl("r1", 115.367), "/api/film-runs/r1/evidence/work/proxies/t115_367.mp4");
});

// ---- the review ----------------------------------------------------------------------------------------------------------------------------

function doc(): OptionsDoc {
  const opt = (key: string, t: number, dp = false) => ({ key, t, is_dp_pick: dp, strip: `review/frames/b${Math.round(t)}_${key}.png`, strip_tiles: [t] });
  return {
    duration: 600,
    band: [95, 150],
    strips_stale: false,
    strip: { window: 5, step: 0.5, cols: 6 },
    boundaries: [
      { boundary_s: 120, dp_pick: 120, before: [], after: [], options: [opt("opt1", 115), opt("opt2", 120, true), opt("opt3", 126)] },
      { boundary_s: 240, dp_pick: 240, before: [], after: [], options: [opt("opt1", 236), opt("opt2", 240, true)] },
      { boundary_s: 360, dp_pick: 360, before: [], after: [], options: [opt("opt1", 360, true), opt("opt2", 372)] },
      { boundary_s: 480, dp_pick: 480, before: [], after: [], options: [opt("opt1", 480, true)] },
    ],
  };
}

const rec = (b: number, t: number, conf: number, verdict: WorkflowRecord["verdict"] = { agree: true, fault: "", better_key: "", reason: "holds" }): WorkflowRecord => ({
  boundary_s: b,
  pick: { chosen_key: "opt2", chosen_t: t, ends_on: "x", opens_on: "y", why: "z", payoff_in_episode: true, confidence: conf },
  verdict,
});

test("reviewState: sure and agreed is pre-accepted; below the gate, a skeptic override or a fault needs a person; decisions settle it; a reject makes it rejudging", () => {
  const passes = [[rec(120, 120, 0.9), rec(240, 240, 0.5), rec(360, 360, 0.8, { agree: false, fault: "rule 4", better_key: "opt2", better_t: 372, reason: "aftermath" }), rec(480, 480, 0, { agree: false, fault: "", better_key: "", reason: "refused" })]];
  const s0 = reviewState(doc(), passes, []);
  assert.deepEqual(s0.boundaries.map((b) => [b.boundary_s, b.status, b.reasons, b.current_t]), [
    [120, "pre_accepted", [], 120],
    [240, "needs_decision", ["low_confidence"], 240],
    [360, "needs_decision", ["skeptic_override"], 372],
    [480, "needs_decision", ["fault", "low_confidence"], 480],
  ]);
  assert.equal(s0.complete, false);
  assert.deepEqual(s0.missing, [240, 360, 480]);
  assert.equal(CONFIDENCE_GATE, 0.65);
  assert.deepEqual(s0.lengths.map((l) => l.length), [120, 120, 132, 108, 120]);

  const at = (i: number) => `2026-09-23T12:00:0${i}.000Z`;
  const decided: FilmRunDecision[] = [
    { at: at(1), by: "ruobin", action: "accept", boundary_s: 240 },
    { at: at(2), by: "ruobin", action: "move", boundary_s: 360, to_s: 360 },
    { at: at(3), by: "ruobin", action: "rejudge", boundary_s: 480, why: "it cuts the fall" },
  ];
  const s1 = reviewState(doc(), passes, decided);
  assert.deepEqual(s1.boundaries.map((b) => [b.status, b.current_t]), [["pre_accepted", 120], ["decided", 240], ["decided", 360], ["rejudging", 480]]);
  assert.equal(s1.complete, false, "a re-judge is outstanding");
  // The re-judge ran (a second pass file) and the person accepted it.
  const s2 = reviewState(doc(), [...passes, [rec(480, 480, 0.85)]], [...decided, { at: at(4), by: "ruobin", action: "accept", boundary_s: 480 }], { "480": 1 });
  assert.deepEqual(s2.boundaries.map((b) => b.status), ["pre_accepted", "decided", "decided", "decided"]);
  assert.equal(s2.complete, true);
  // A decision made BEFORE a reject no longer counts for that boundary; a confident re-judge is pre-accepted, an unsure one needs a person again.
  const s3 = reviewState(doc(), [...passes, [rec(480, 480, 0.5)]], [{ at: at(0), by: "ruobin", action: "accept", boundary_s: 480 }, { at: at(3), by: "ruobin", action: "rejudge", boundary_s: 480, why: "x" }], { "480": 1 });
  assert.equal(s3.boundaries[3].status, "needs_decision");
  assert.equal(s3.boundaries[3].decision, null);
  const s4 = reviewState(doc(), [...passes, [rec(480, 480, 0.9)]], [{ at: at(0), by: "ruobin", action: "accept", boundary_s: 480 }, { at: at(3), by: "ruobin", action: "rejudge", boundary_s: 480, why: "x" }], { "480": 1 });
  assert.equal(s4.boundaries[3].status, "pre_accepted");
});

test("a move must be a legal cut within 30 s that keeps both episodes in band; lengthsAround computes them from the others' current times", () => {
  const s = reviewState(doc(), [[rec(120, 120, 0.9), rec(240, 240, 0.9), rec(360, 360, 0.9), rec(480, 480, 0.9)]], []);
  assert.deepEqual(lengthsAround(s, 240, 250), { before: 130, after: 110 });
  assert.equal(moveRefusal(s, 240, 250, [250]), null);
  assert.match(moveRefusal(s, 240, 250, [251])!, /not a legal cut/);
  assert.match(moveRefusal(s, 240, 290, [290])!, /more than 30 s/);
  assert.match(moveRefusal(s, 240, 212, [212])!, /episode before it 92s, outside the 95–150s band/);
  assert.match(moveRefusal(s, 240, 268, [268])!, /episode after it 92s/);
  assert.match(moveRefusal(s, 999, 1000, [1000])!, /not in review\/options\.json/);
});

test("the override file: one Workflow-shaped record per decided boundary, reviewer ruobin, applied over the pass so apply_vision's rules make the person's time win", () =>
  withDir((dir) => {
    const cut = path.join(dir, "cut");
    mkdirSync(path.join(cut, "review", "vision"), { recursive: true });
    const run = { id: "0123456789abcdef0123456789abcdef", bucket: "low-quality", slug: "x" };
    const label = visionLabel(run);
    assert.equal(label, "studio-01234567");
    const pass = [rec(120, 120, 0.9), rec(240, 240, 0.5), rec(360, 360, 0.8, { agree: false, fault: "rule 4", better_key: "opt2", better_t: 372, reason: "aftermath" })];
    writeFileSync(path.join(cut, "review", "vision", `${label}.json`), JSON.stringify({ result: pass }));
    writeFileSync(path.join(cut, "review", "vision", `2026-09-23_${label}.json`), JSON.stringify({ result: pass }), "utf8"); // apply_vision's audit copy: not a run file
    const decisions: FilmRunDecision[] = [
      { at: "2026-09-23T12:00:01.000Z", by: "ruobin", action: "accept", boundary_s: 240, why: "the punch has landed" },
      { at: "2026-09-23T12:00:02.000Z", by: "ruobin", action: "move", boundary_s: 360, to_s: 360, why: "keep the DP's" },
    ];
    const state = reviewState(doc(), [pass], decisions);
    const file = writeOverrideFile(cut, label, run.id, state);
    assert.equal(path.basename(file), `${label}_review1.json`);
    const out = WorkflowOutputSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    assert.equal((out as { reviewer?: string }).reviewer, "ruobin");
    assert.deepEqual(out.result.map((r) => [r.boundary_s, r.pick.chosen_t, r.pick.confidence, r.verdict?.agree]), [[240, 240, 1, true], [360, 360, 1, true]]);
    assert.match(out.result[0].pick.why, /accepted by ruobin at 240s: the punch has landed/);
    assert.match(out.result[1].pick.why, /moved by ruobin to 360s: keep the DP's/);
    const applied = applyVision(pass, out.result);
    assert.deepEqual(applied.choices, { "120": 120, "240": 240, "360": 360 }, "the skeptic's 372 is overruled by the person's 360; 120 stands from the pass");
    assert.deepEqual(listRunVisionFiles(cut, label).map((f) => [f.name, f.role]), [[`${label}.json`, "pass"], [`${label}_review1.json`, "review"]]);
    const second = writeOverrideFile(cut, label, run.id, state);
    assert.equal(path.basename(second), `${label}_review2.json`);
    const o = overrideRecord(state.boundaries[1], decisions[0]);
    assert.equal(o.pick.chosen_key, "opt2");
  }));

// ---- small things ---------------------------------------------------------------------------------------------------------------------------

test("the hand-off command is the exact Workflow call with the cut folder, the boundaries and the film notes", () => {
  const cmd = handoffCommand("C:\\ws\\low-quality\\film\\cut", [115.367, 214.733], "a ~1.7 s card", "C:\\remix");
  assert.equal(cmd, 'Workflow({ scriptPath: "C:/remix/scripts/cut-only/pick_by_eye.workflow.js", args: { base: "C:/ws/low-quality/film/cut", boundaries: [115.367,214.733], film_notes: "a ~1.7 s card" } })');
  assert.doesNotMatch(handoffCommand("/x/cut", [1], null, "/remix"), /film_notes/);
});

test("a watermark region is {x, y, w, h} fractions inside the frame and becomes watermark.py's x0,y0,x1,y1", () => {
  assert.equal(validRegion({ x: 0, y: 0, w: 0.5, h: 0.25 }), true);
  assert.equal(validRegion({ x: 0.6, y: 0, w: 0.5, h: 0.25 }), false);
  assert.equal(validRegion({ x: 0, y: 0, w: 0, h: 0.25 }), false);
  assert.equal(regionArg({ x: 0.3, y: 0.9, w: 0.7, h: 0.1 }), "0.3,0.9,1,1");
});

test("the fake's PNG is a real PNG over the --verify size floor", () => {
  const png = fakePng(240, 140, 3);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(png.length >= 1000, `${png.length} bytes`);
  assert.notDeepEqual(fakePng(240, 140, 4), png);
});

test("film-meta: the default form starts from the folder name, the slug and half the runtime; writing keeps what the form does not carry", () =>
  withDir((dir) => {
    const cut = path.join(dir, "cut");
    mkdirSync(cut, { recursive: true });
    writeFileSync(path.join(cut, "cuts.json"), JSON.stringify({ source_duration: 100, target: 120, fps: 30, band: [95, 150], pinned: 0, pin_from: null, moves: [], final_end_is_boundary: false, episodes: [{ n: 1, start: 0, end: 50, dur: 50, ends_after_line: "a", next_opens_on: "b" }, { n: 2, start: 50, end: 100, dur: 50, ends_after_line: "c", next_opens_on: "" }] }));
    const d = defaultFilmMeta({ slug: "she-returned-with-her-son", lang: "en" }, cut);
    assert.equal(d.display_title_en, "She Returned With Her Son");
    assert.equal(d.crazydramas_slug, "she-returned-with-her-son");
    assert.equal(d.spoiler_from_s, 50);
    writeFileSync(path.join(cut, "film-meta.json"), JSON.stringify({ display_title_en: "Old", source_title_en: "The Source Title", language: "zh", exclusions: [], notes: "hand-written" }));
    const meta = writeFilmMeta(cut, { display_title_en: "New Title", crazydramas_slug: "new-title", spoiler_from_s: 40, exclusions: [{ from_s: 1, to_s: 2, why: "card", kind: "card" }], live_poster: "new-title-a" }, "en");
    assert.equal(meta.source_title_en, "The Source Title");
    assert.equal(meta.language, "zh", "the language on file stays");
    assert.equal(meta.notes, "hand-written");
    assert.deepEqual(readFilmMeta(cut)?.exclusions, [{ from_s: 1, to_s: 2, why: "card", kind: "card" }]);
    assert.equal(readFilmMeta(cut)?.live_poster, "new-title-a");
  }));
