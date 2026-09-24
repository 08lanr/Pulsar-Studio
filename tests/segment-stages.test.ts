// The pure pieces of the segment worker (lib/segment/*): the downloader's
// file name, the picker's roots and the typed-path refusal, when an existing
// film folder may be driven (Studio's own, a claimed one, an extended
// delivery), which decisions wake a waiting run, a script's refusal kept
// verbatim, the evidence route's path rules and proxy names, the review
// state (who needs a decision, what a move may do, measured from the pinned
// start), when an applied options file is stale, whether an index file
// covers what a run plans, the override file apply_vision.py reads, the QA
// report merged after an --only run, the hand-off command, the watermark
// region, the fake's PNG, and the film-meta file.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkflowOutputSchema, applyVision, type WorkflowRecord } from "@/lib/segment/vision";
import type { OptionsDoc } from "@/lib/segment/strips";
import type { FilmRun, FilmRunDecision } from "@/lib/types";
import { cutRelUrl, evidencePathOf, evidenceUrl, joinProxyName, joinProxyOf, joinProxyUrl, proxyName, proxyTimeOf, proxyUrl } from "@/lib/segment/evidence";
import { fakePng } from "@/lib/segment/fake-runner";
import { defaultFilmMeta, importNowSince, readFilmMeta, suggestedCrazydramasSlug, writeFilmMeta } from "@/lib/segment/handoff";
import { covers, motionCoverage, whisperCoverage } from "@/lib/segment/index";
import { existingFolderRefusal, folderDelivered, isPlaceholder, linkOrCopy, parseMediaName, resolveSourceDir, resolveSourcePath, sourceRoots, suggestSlug, type FolderFacts } from "@/lib/segment/intake";
import { appliedRunLabel, deliveredToEnd, lengthsAround, listRunVisionFiles, moveRefusal, overrideRecord, reviewState, staleOptionsReason, writeOverrideFile } from "@/lib/segment/plan";
import { mergeQaReports } from "@/lib/segment/qa";
import { CONFIDENCE_GATE, DECISION, consumed, filmRoot, handoffCommand, isActionable, pendingDecision, pendingDecisions, refusalOf, runDirs, visionLabel, waitingOf } from "@/lib/segment/stages";
import { regionArg, validRegion } from "@/lib/segment/watermark";
import { FILM_SLUG, filmRunStageAudited, leaseLive } from "@/lib/data/film-runs";

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

test("an existing film folder is driven only when Studio made it or the run claims it, and a delivered, ready or imported film only when the run extends it", () => {
  const run = (settings: FilmRun["settings"]) => ({ bucket: "low-quality", slug: "he-hated-all-women", settings });
  const facts = (over: Partial<FolderFacts>): FolderFacts => ({ cut_exists: true, studio_made: true, scan: { state: "NOT_DELIVERED", pipeline_stage: "INDEXED" }, imported: false, ...over });
  assert.equal(existingFolderRefusal(run({}), facts({ cut_exists: false, studio_made: false, scan: null })), null, "a new folder");
  assert.equal(existingFolderRefusal(run({}), facts({})), null, "Studio's own folder, not delivered: a retried or restarted run");
  assert.match(existingFolderRefusal(run({}), facts({ studio_made: false }))!, /no Studio run made it \(no cut\/\.studio-scripts\.json\): a session's work/);
  assert.equal(existingFolderRefusal(run({ claim_existing: true }), facts({ studio_made: false })), null, "the explicit claim");
  const delivered = facts({ scan: { state: "READY", pipeline_stage: "DELIVERED" } });
  assert.match(existingFolderRefusal(run({}), delivered)!, /is DELIVERED \(READY\): a delivered film is not cut again/);
  assert.match(existingFolderRefusal(run({ claim_existing: true }), { ...delivered, studio_made: false })!, /a delivered film is not cut again/, "a claim does not make a delivered film cuttable");
  assert.equal(existingFolderRefusal(run({ extend: true }), delivered), null, "extend is the explicit way");
  assert.match(existingFolderRefusal(run({ extend: true }), { ...delivered, studio_made: false })!, /no Studio run made it/, "extending a session's film still needs the claim");
  assert.equal(existingFolderRefusal(run({ extend: true, claim_existing: true }), { ...delivered, studio_made: false }), null);
  assert.match(existingFolderRefusal(run({}), facts({ imported: true }))!, /is imported as a title/);
  assert.equal(folderDelivered({ scan: { state: "NOT_DELIVERED", pipeline_stage: "PLANNED" }, imported: false }), false);
  for (const state of ["READY", "IMPORTED", "K_CHANGED"] as const) assert.equal(folderDelivered({ scan: { state, pipeline_stage: "PLANNED" }, imported: false }), true, state);
  assert.equal(folderDelivered({ scan: { state: "NOT_DELIVERED", pipeline_stage: "DELIVERED" }, imported: false }), true);
  assert.equal(folderDelivered({ scan: null, imported: true }), true);
});

test("a film slug may start with one underscore (a scratch folder); the audit rule fires only when the stage, the refusal or the title moves", () => {
  for (const ok of ["she-returned-with-her-son", "_studio-smoke", "mafia_king", "ep01"]) assert.ok(FILM_SLUG.test(ok), ok);
  for (const bad of ["__smoke", "-smoke", "Smoke", "smoke-", "a b", "_", "smoke/x"]) assert.equal(FILM_SLUG.test(bad), false, bad);
  const at = { stage: "index" as const, error_text: null, title_id: null };
  assert.equal(filmRunStageAudited(at, { ...at }), false, "a progress write");
  assert.equal(filmRunStageAudited(at, { ...at, stage: "plan" }), true);
  assert.equal(filmRunStageAudited(at, { ...at, error_text: "REFUSED" }), true);
  assert.equal(filmRunStageAudited(at, { ...at, title_id: "t1" }), true);
});

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

test("an Import now counts from the film-meta or join it follows, seen or not: a press before READY is kept, a join or a new film-meta starts over", () => {
  const d = (action: string, at: string): FilmRunDecision => ({ at, by: "ruobin", action, boundary_s: null });
  assert.equal(importNowSince({ decisions: [] }), null);
  assert.equal(importNowSince({ decisions: [d("film_meta", "1")] }), null);
  assert.equal(importNowSince({ decisions: [d("film_meta", "1"), d("import_now", "2")] })?.at, "2", "pressed while waiting for READY: still there after the readiness wait marked it seen");
  assert.equal(importNowSince({ decisions: [d("film_meta", "1"), d("import_now", "2"), d("note", "3")] })?.at, "2");
  assert.equal(importNowSince({ decisions: [d("film_meta", "1"), d("import_now", "2"), d("join", "3")] }), null, "a join re-renders: the earlier press is not for these files");
  assert.equal(importNowSince({ decisions: [d("import_now", "2"), d("film_meta", "3")] }), null, "a new film-meta starts over");
  assert.equal(importNowSince({ decisions: [d("film_meta", "1"), d("import_now", "2"), d("import_now", "4")] })?.at, "4", "the newest press");
  const soon = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(leaseLive({ lease_owner: "host:1", leased_until: soon }), true);
  assert.equal(leaseLive({ lease_owner: "host:1", leased_until: past }), false, "an expired lease is a dead worker's");
  assert.equal(leaseLive({ lease_owner: null, leased_until: null }), false, "a waiting run holds none");
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
  // A join clip is named by the episode it follows and that episode's planned end, so a moved join is a new file.
  assert.equal(joinProxyName(2, 9.2), "j02_t9_200.mp4");
  assert.deepEqual(joinProxyOf("j02_t9_200.mp4"), { k: 2, end: 9.2 });
  assert.deepEqual(joinProxyOf("j14_t1701_233.mp4"), { k: 14, end: 1701.233 });
  assert.equal(joinProxyOf("t9_200.mp4"), null);
  assert.equal(joinProxyUrl("r1", 2, 9.2), "/api/film-runs/r1/evidence/work/joins/j02_t9_200.mp4");
  assert.equal(evidencePathOf(dirs, ["work", "joins", "j02_t9_200.mp4"])!.abs, path.join(dirs.work, "joins", "j02_t9_200.mp4"));
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
  // A decision made BEFORE a reject no longer counts for that boundary; a re-judge, sure or unsure, waits for the person who asked for it.
  const s3 = reviewState(doc(), [...passes, [rec(480, 480, 0.5)]], [{ at: at(0), by: "ruobin", action: "accept", boundary_s: 480 }, { at: at(3), by: "ruobin", action: "rejudge", boundary_s: 480, why: "x" }], { "480": 1 });
  assert.equal(s3.boundaries[3].status, "needs_decision");
  assert.equal(s3.boundaries[3].decision, null);
  assert.deepEqual(s3.boundaries[3].reasons, ["low_confidence", "rejudged"]);
  const s4 = reviewState(doc(), [...passes, [rec(480, 480, 0.9)]], [{ at: at(0), by: "ruobin", action: "accept", boundary_s: 480 }, { at: at(3), by: "ruobin", action: "rejudge", boundary_s: 480, why: "x" }], { "480": 1 });
  assert.equal(s4.boundaries[3].status, "needs_decision", "a confident second answer is shown to the person, never applied unread (decision 5)");
  assert.deepEqual(s4.boundaries[3].reasons, ["rejudged"]);
  assert.equal(s4.complete, false);
  const s5 = reviewState(doc(), [...passes, [rec(480, 480, 0.9)]], [{ at: at(3), by: "ruobin", action: "rejudge", boundary_s: 480, why: "x" }, { at: at(5), by: "ruobin", action: "accept", boundary_s: 480 }], { "480": 1 });
  assert.equal(s5.boundaries[3].status, "decided", "an accept after the re-judge closes it");
});

test("an applied options file names the Studio run that stamped it; a film delivered to its end has nothing to extend", () => {
  assert.equal(appliedRunLabel({ applied: { label: "studio-afe412a9" } }), "studio-afe412a9", "the pass's apply");
  assert.equal(appliedRunLabel({ applied: { label: "studio-afe412a9-review" } }), "studio-afe412a9", "the review's apply");
  assert.equal(appliedRunLabel({ applied: { label: "studio-afe412a9-band" } }), "studio-afe412a9", "the band fix's apply");
  assert.equal(appliedRunLabel({ applied: { label: "0-end" } }), null, "a session's label");
  assert.equal(appliedRunLabel({ applied: { label: "studio-afe412a9-extra" } }), null);
  assert.equal(appliedRunLabel({ applied: null }), null);
  assert.equal(deliveredToEnd({ end: 600.033 }, 600.033), true);
  assert.equal(deliveredToEnd({ end: 600.033 }, 600.05), true, "within the plan's own tolerance");
  assert.equal(deliveredToEnd({ end: 900 }, 7259.5), false, "a first proof: the extension plans past it");
  assert.equal(deliveredToEnd(null, 600), false, "nothing delivered");
  assert.equal(deliveredToEnd({ end: 600 }, null), false, "no known length: not judged here");
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

test("after a first proof the open stretch starts at the pinned end: the first open boundary's length is measured from it, not from 0", () => {
  // The delivered proof ended at 100 s (its last pin); this run's options list only the boundaries past it.
  const stretch: OptionsDoc = { ...doc(), boundaries: doc().boundaries.filter((b) => b.boundary_s >= 240) };
  const passes = [[rec(240, 240, 0.9), rec(360, 360, 0.9), rec(480, 480, 0.9)]];
  const pinned = reviewState(stretch, passes, [], {}, { fixedStart: 100 });
  assert.deepEqual(pinned.lengths.map((l) => [l.from, l.to, l.length]), [[100, 240, 140], [240, 360, 120], [360, 480, 120], [480, 600, 120]]);
  assert.deepEqual(lengthsAround(pinned, 240, 230, 100), { before: 130, after: 130 });
  assert.equal(moveRefusal(pinned, 240, 230, [230], 100), null, "in band from the pin");
  assert.match(moveRefusal(pinned, 240, 230, [230])!, /episode before it 230s/, "measured from 0 the same move is refused: the bug the fixed start closes");
  assert.match(moveRefusal(pinned, 240, 268, [268], 100)!, /episode before it 168s/);
});

test("an applied options file is stale for a run that plans past the delivered stretch, and only then", () => {
  // The newest DELIVERED file names the stretch's end (cuts-0-<end>); the applied options' boundaries all lie inside it.
  const applied = { boundaries: [{ boundary_s: 120 }, { boundary_s: 240 }], duration: 300 };
  const pin = { file: "cuts-0-300-DELIVERED.json", end: 300 };
  assert.match(staleOptionsReason(applied, pin, 600)!, /2 boundaries, all at or under 300 s of cuts-0-300-DELIVERED\.json/);
  assert.equal(staleOptionsReason(applied, pin, 300), null, "the same stretch again is not an extension");
  assert.equal(staleOptionsReason(applied, null, 600), null, "nothing delivered: the options were judged outside Studio");
  assert.equal(staleOptionsReason({ ...applied, boundaries: [{ boundary_s: 120 }, { boundary_s: 400 }] }, pin, 600), null, "a boundary past the delivered end belongs to a stretch judged outside Studio");
  assert.match(staleOptionsReason({ ...applied, duration: 600 }, pin, null)!, /all at or under 300 s/, "without to_s the options' own duration says how far the run plans");
});

test("an index file covers a run when it reaches what the run plans: a first proof's transcript stops short of the whole film", () =>
  withDir((dir) => {
    const cut = path.join(dir, "cut");
    mkdirSync(path.join(cut, "index"), { recursive: true });
    assert.equal(whisperCoverage(cut), null);
    writeFileSync(path.join(cut, "index", "whisper.json"), JSON.stringify({ language: "en", duration: 900.0, segments: [] }));
    assert.equal(whisperCoverage(cut), 900);
    assert.equal(covers(900, 900), true);
    assert.equal(covers(899.5, 900), true, "a second of slack for the last word");
    assert.equal(covers(900, 7259.5), false, "the whole film after a --to 900 proof");
    assert.equal(covers(7259.53, 7259.533), true);
    assert.equal(covers(null, 900), true, "an unreadable file is not judged here");
    assert.equal(covers(900, null), true, "no planned length: nothing to compare");
    writeFileSync(path.join(cut, "index", "motion.json"), JSON.stringify({ fps: 10, from: 0, to: 900, beats: [] }));
    assert.equal(motionCoverage(cut), 900);
    writeFileSync(path.join(cut, "index", "motion.json"), JSON.stringify({ fps: 10, from: 0, to: 0, beats: [], track: new Array(72594).fill(0) }));
    assert.equal(motionCoverage(cut), 7259.4, "the 10 fps track's length");
    writeFileSync(path.join(cut, "index", "motion.json"), JSON.stringify({ fps: 10, from: 0, to: 0, beats: [] }));
    assert.equal(motionCoverage(cut), Number.POSITIVE_INFINITY, "an explicit whole-film run with no track");
  }));

test("after an --only QA run the untouched episodes' records come back verbatim, in episode order; the re-measured ones win", () => {
  const before = { fps: 30, regions: [["logo", 1, 2, 3, 4]], episodes: [{ n: 1, faults: ["missing"], sheet: "review/qa/ep01.png" }, { n: 2, faults: [], sheet: "review/qa/ep02.png" }, { n: 3, faults: ["last frame black"], sheet: "review/qa/ep03.png" }, { n: 4, faults: [], sheet: "review/qa/ep04.png" }, { n: 5, faults: ["logo"], sheet: "review/qa/ep05.png" }] };
  const after = { fps: 30, regions: [["logo", 1, 2, 3, 4]], episodes: [{ n: 2, faults: ["join"], sheet: "review/qa/ep02.png" }, { n: 3, faults: [], sheet: "review/qa/ep03.png" }] };
  const merged = mergeQaReports(before, after);
  assert.deepEqual(merged.episodes!.map((e) => [e.n, (e as { faults: string[] }).faults]), [[1, ["missing"]], [2, ["join"]], [3, []], [4, []], [5, ["logo"]]]);
  assert.equal(merged.fps, 30);
  assert.deepEqual(mergeQaReports(null, after).episodes!.map((e) => e.n), [2, 3], "nothing before: the report as written");
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
    assert.equal(o.pick.ends_on, "x", "an accept of the reviewer's own time keeps its frame description");
    const back = overrideRecord(state.boundaries[2], decisions[1]);
    assert.equal(back.pick.chosen_key, "review");
    assert.equal(back.pick.ends_on, "x", "a move back to the reviewer's own time keeps its frame description");
    const away = overrideRecord(state.boundaries[2], { ...decisions[1], to_s: 372 });
    assert.equal(away.pick.ends_on, "", "a move to another time describes another frame: the reviewer's ends_on / opens_on are not copied");
    assert.equal(away.pick.opens_on, "");
  }));

test("accepting a skeptic override records the skeptic's key, time and reason, not the reviewer's frame at another time", () => {
  const pass = [rec(360, 360, 0.8, { agree: false, fault: "rule 4", better_key: "opt2", better_t: 372, reason: "the aftermath belongs to the episode" })];
  const state = reviewState(doc(), [pass], [{ at: "2026-09-23T12:00:01.000Z", by: "ruobin", action: "accept", boundary_s: 360, why: "agreed" }]);
  const b = state.boundaries.find((x) => x.boundary_s === 360)!;
  assert.equal(b.applied_source, "SKEPTIC OVERRIDE");
  const o = overrideRecord(b, b.decision!);
  assert.equal(o.pick.chosen_t, 372);
  assert.equal(o.pick.chosen_key, "opt2", "the skeptic's better_key, not the reviewer's chosen_key");
  assert.equal(o.pick.ends_on, "");
  assert.equal(o.pick.opens_on, "");
  assert.match(o.pick.why, /accepted by ruobin at 372s, the skeptic's time \(the aftermath belongs to the episode\): agreed/);
  const noKey = overrideRecord({ ...b, record: { ...b.record!, verdict: { ...b.record!.verdict!, better_key: "" } } }, b.decision!);
  assert.equal(noKey.pick.chosen_key, "review", "a skeptic with no listed key: the review's own");
});

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
    assert.equal(d.crazydramas_slug, null, "no slug until the import picks and checks one (a filled-in slug would be taken unchecked)");
    assert.equal(d.spoiler_from_s, 50);
    // A scratch slug's leading underscore never reaches the crazydramas slug (the decide route's rule refuses "-studio-smoke").
    assert.equal(suggestedCrazydramasSlug("_studio-smoke"), "studio-smoke");
    assert.equal(defaultFilmMeta({ slug: "_studio-smoke", lang: "en" }, cut).display_title_en, "Studio Smoke");
    assert.equal(suggestedCrazydramasSlug("mafia_king"), "mafia-king");
    writeFileSync(path.join(cut, "film-meta.json"), JSON.stringify({ display_title_en: "Old", source_title_en: "The Source Title", language: "zh", exclusions: [], notes: "hand-written" }));
    const meta = writeFilmMeta(cut, { display_title_en: "New Title", crazydramas_slug: "new-title", spoiler_from_s: 40, exclusions: [{ from_s: 1, to_s: 2, why: "card", kind: "card" }], live_poster: "new-title-a" }, "en");
    assert.equal(meta.source_title_en, "The Source Title");
    assert.equal(meta.language, "zh", "the language on file stays");
    assert.equal(meta.notes, "hand-written");
    assert.deepEqual(readFilmMeta(cut)?.exclusions, [{ from_s: 1, to_s: 2, why: "card", kind: "card" }]);
    assert.equal(readFilmMeta(cut)?.live_poster, "new-title-a");
  }));
