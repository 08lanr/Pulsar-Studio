// The three picture passes over a small slice of lbl-e02 (tests/fixtures/narrated:
// one minute-sheet, ep9's lines N1 and N2 with their frame sheets, ep9's one
// join), with a fake gateway and the REAL pipeline scripts synced from the
// drama-remix checkout: frame_claims.py / cut_joins.py `status` write the
// pending items, the synced workflows run through the shim, and `record`
// takes the verdict files Studio writes — the round trip the stage makes.
// Skipped without the checkout or its Python.

import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { LlmError, type StructuredCall, type StructuredResult } from "@/lib/llm";
import { dramaRemixRoot, pythonAvailable } from "@/lib/python";
import { runFramePass, type FramePassResult } from "@/lib/segment/narrated/picture/frames";
import { runJoinPass, type JoinPassResult } from "@/lib/segment/narrated/picture/joins";
import { frameClaimsStatus, verdictFileName } from "@/lib/segment/narrated/picture/recorders";
import { flattenSheetRead, groupSpan, runSheetPass, sheetEntriesProblem, sheetGroups, type SheetEntry, type SheetPassResult } from "@/lib/segment/narrated/picture/sheets";
import { isWorkflowUnavailable, type FfmpegRun } from "@/lib/segment/workflow-shim";

const SKIP_THROUGH = path.join(dramaRemixRoot(), "scripts", "skip-through");
const SYNCED = ["frame_claims.py", "cut_joins.py", "jev.py", "sheet_read.workflow.js", "frame_verify.workflow.js", "cut_verify.workflow.js"];
const ready = SYNCED.every((f) => existsSync(path.join(SKIP_THROUGH, f))) && pythonAvailable();
const skipWhy = `no skip-through scripts at ${SKIP_THROUGH} or no python`;
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "narrated");
const RUN_ID = "0c0ffee0-1111-4222-8333-444455556666";
const N1_TEXT = "Governor Qin takes me into his lounge, so I ask my questions before he can ask his.";
const JOIN = "783.92-791.32";

const temps: string[] = [];
const saved = { replay: process.env.DEMO_REPLAY, source: process.env.DATA_SOURCE, anthropic: process.env.ANTHROPIC_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY, vision: process.env.ADS_VISION_PROVIDER, model: process.env.ADS_VISION_MODEL };

beforeEach(() => {
  resetFixtureStore();
  process.env.DEMO_REPLAY = "0";
  delete process.env.DATA_SOURCE;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ADS_VISION_PROVIDER;
  delete process.env.ADS_VISION_MODEL;
});

afterEach(() => {
  resetFixtureStore();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of [["DEMO_REPLAY", saved.replay], ["DATA_SOURCE", saved.source], ["ANTHROPIC_API_KEY", saved.anthropic], ["DEEPSEEK_API_KEY", saved.deepseek], ["ADS_VISION_PROVIDER", saved.vision], ["ADS_VISION_MODEL", saved.model]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** A project folder from the fixture: the sheets named by absolute path as prepare writes them, the scripts synced, a sheet premise. */
function tempFilm(): { film: string; work: string } {
  const root = mkdtempSync(path.join(tmpdir(), "studio-narrated-"));
  temps.push(root);
  const film = path.join(root, "proj");
  cpSync(FIXTURE, film, { recursive: true });
  const abs = (rel: string) => path.resolve(film, rel).replace(/\\/g, "/");
  const fcFile = path.join(film, "ep9", "review", "frame_claims.json");
  const fc = readJson(fcFile);
  for (const l of fc.lines) l.sheet = abs(l.sheet);
  writeFileSync(fcFile, JSON.stringify(fc, null, 1));
  const cpFile = path.join(film, "ep9", "review", "cut_joins_prepared.json");
  const cp = readJson(cpFile);
  for (const i of cp) i.sheet = abs(i.sheet);
  writeFileSync(cpFile, JSON.stringify(cp, null, 1));
  mkdirSync(path.join(film, "scripts"));
  for (const f of SYNCED) copyFileSync(path.join(SKIP_THROUGH, f), path.join(film, "scripts", f));
  writeFileSync(path.join(film, "sheet_premise.txt"), readFileSync(path.join(film, "frame_premise.txt"), "utf8"));
  return { film, work: path.join(root, "work", RUN_ID) };
}

/** ffmpeg stand-in: copies the input to the output, so a crop or a JPEG copy exists without the binary. */
const copyFfmpeg: FfmpegRun = async (args) => {
  copyFileSync(args[args.indexOf("-i") + 1], args[args.length - 1]);
  return { code: 0, stderr: "" };
};

type Fake = { calls: StructuredCall<unknown>[]; peak: number };

/** Answers the three workflows' calls; `answer` may override or throw per call. */
function fakeLlm(answer: (call: StructuredCall<unknown>) => unknown | undefined = () => undefined): Fake & { llm: <T>(call: StructuredCall<T>) => Promise<StructuredResult<T>> } {
  const state: Fake = { calls: [], peak: 0 };
  let active = 0;
  const llm = async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
    state.calls.push(call as StructuredCall<unknown>);
    active += 1;
    state.peak = Math.max(state.peak, active);
    try {
      await new Promise((r) => setTimeout(r, 4));
      let data = answer(call as StructuredCall<unknown>);
      if (data === undefined) {
        if (call.name === "record_frame_verify") data = { people: "A man in a dark uniform; a woman in a long dark coat.", claims: [{ claim: "Qin is present", verdict: "supported", evidence: "0:06.0" }] };
        else if (call.name === "record_cut_verify") data = { before: "The lounge.", after: "The same lounge.", what_was_cut: "A silence.", viewer_lost: false, what_is_confusing: "Same place, same people.", fix: "none" };
        else if (call.name === "record_sheet_read") {
          const minutes = [...call.user.matchAll(/^- minute (\d+): /gm)].map((m) => Number(m[1]));
          data = { entries: minutes.flatMap((m) => Array.from({ length: 6 }, (_, k) => ({ start: m * 60 + k * 10, end: m * 60 + k * 10 + 9, where: "Qin's lounge", who: "Qin, Anna", action: "They talk.", shot: "medium", text_on_screen: "", visual_value: 2 }))) };
        } else throw new Error(`fake llm: unexpected ${call.name}`);
      }
      const parsed = call.schema.parse(data);
      const problem = call.check?.(parsed);
      if (problem) throw new LlmError("invalid_output", problem);
      return { data: parsed, usage: { input_tokens: 2000, output_tokens: 400, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 2, provider: call.provider ?? "anthropic", model: call.model!, turns: 1 };
    } finally {
      active -= 1;
    }
  };
  return Object.assign(state, { llm });
}

const lensOf = (call: StructuredCall<unknown>) => (call.user.includes("BEFORE judging any claim") ? "identity" : call.user.includes("Look first at the story") ? "story" : call.user.includes("Look first at place and people") ? "picture" : "claims");
const lineOf = (call: StructuredCall<unknown>) => (call.user.includes(N1_TEXT) ? "N1" : "N2");

// ---- frame_verify ------------------------------------------------------------------------------------

test("the frame pass: status writes the pending items, two readers per line through the shim, the verdict file stamped fv-2+api:<model>, frame_claims.py record, status again (skipped without the scripts)", async (t) => {
  if (!ready) return t.skip(skipWhy);
  const { film, work } = tempFilm();
  const fake = fakeLlm((call) => (lineOf(call) === "N2" && lensOf(call) === "identity" ? { people: "Qin; Anna.", claims: [{ claim: "she holds the formula", verdict: "contradicted", evidence: "her hands are empty at 0:30.1" }] } : undefined));
  const r = (await runFramePass({ film, ep: "ep9", run_id: RUN_ID, work_dir: work, llm: fake.llm, ffmpeg: copyFfmpeg })) as FramePassResult;
  assert.ok(!isWorkflowUnavailable(r));
  assert.equal(r.status_before?.code, 1, "status: two lines not yet checked");
  assert.equal(r.status_before?.rewrote, true);
  assert.equal(r.items, 2);
  assert.equal(fake.calls.length, 4, "two lenses per line");
  assert.ok(fake.peak <= 2, `at most two calls at once (saw ${fake.peak})`);
  for (const c of fake.calls) {
    assert.equal(c.model, "claude-opus-5-5");
    assert.equal(c.toolChoice, "auto");
    assert.equal(c.name, "record_frame_verify");
    assert.equal(c.images?.length, 2, "the sheet and its caption crop");
    assert.match(c.images![0].path, /ep9[\\/]review[\\/]frames[\\/]N[12]\.jpg$/);
    assert.match(c.images![1].path, /work.*picture[\\/]ep9[\\/]frames[\\/]N[12]\.captions2x\.jpg$/);
    assert.match(c.user, /^\[Studio runs this reader through the API/);
    assert.match(c.user, /STORY PREMISE \(context only - NOT evidence about any frame\):\nHu Xiu, a present-day Shanghai office worker/, "the premise is the project's frame_premise.txt");
  }
  assert.deepEqual(r.complete.sort(), ["ep9-N1", "ep9-N2"]);
  assert.deepEqual(r.incomplete, []);
  assert.equal(path.basename(r.verdicts_file!), verdictFileName("frame_claims", RUN_ID, 1));
  const written = readJson(r.verdicts_file!);
  assert.ok(Array.isArray(written), "the Workflow's own return list, bare");
  const n1 = written.find((x: { id: string }) => x.id === "N1");
  assert.equal(n1.text, N1_TEXT, "the prepared text, copied through unchanged");
  assert.equal(n1.reader_version, "fv-2+api:claude-opus-5-5");
  assert.equal(n1.readers.length, 2);
  assert.equal(r.recorded?.code, 0, r.recorded?.refusal ?? "");
  assert.ok(r.recorded?.lines.some((l) => /recorded 2 line\(s\); 1 contradicted claim/.test(l)));
  const check = readJson(path.join(film, "ep9", "review", "frame_check.json"));
  assert.equal(check.N1.reader_version, "fv-2+api:claude-opus-5-5", "frame_claims.py record stores the stamp");
  assert.equal(check.N1.text_hash, "fed695306775");
  assert.deepEqual(r.contradicted, [{ id: "N2", claim: "she holds the formula", evidence: "her hands are empty at 0:30.1", reader: 1 }]);
  assert.equal(r.status_after?.code, 1, "N2 is contradicted and not waived");
  assert.ok(r.status_after?.lines.some((l) => /CONTRADICTED ep9 N2/.test(l)));
  assert.equal(r.reader_version, "fv-2+api:claude-opus-5-5");

  // One studio.jobs row per call: kind frame_verify, target the run, the key and the stamp on the row.
  const job = await getData().latestJobByTarget(systemSession(), "film_run", RUN_ID, "frame_verify");
  assert.equal(job?.kind, "frame_verify");
  assert.equal(job?.model, "claude-opus-5-5");
  assert.match(job?.idempotency_key ?? "", new RegExp(`^fv:${RUN_ID}:ep9:N[12]:(fed695306775|a34d3ed0526f):(claims|identity):fv-2\\+api:claude-opus-5-5:[0-9a-f]{12}$`));
  assert.equal((job?.input as { reader_version?: string })?.reader_version, "fv-2+api:claude-opus-5-5");
  assert.equal(r.calls.filter((c) => c.status === "done" && c.job_id).length, 4);

  // Nothing pending now (N2 is contradicted, not unchecked): a second pass sends nothing.
  const fake2 = fakeLlm();
  const again = (await runFramePass({ film, ep: "ep9", run_id: RUN_ID, work_dir: work, llm: fake2.llm, ffmpeg: copyFfmpeg })) as FramePassResult;
  assert.equal(again.items, 0);
  assert.equal(fake2.calls.length, 0);
});

test("a line whose reader failed is not recorded and stays pending; the retry pays only for the failed reader (skipped without the scripts)", async (t) => {
  if (!ready) return t.skip(skipWhy);
  const { film, work } = tempFilm();
  const failing = fakeLlm((call) => {
    if (lineOf(call) === "N2" && lensOf(call) === "claims") throw new LlmError("api", "Claude API 400: fake bad request", 400);
    return undefined;
  });
  const r = (await runFramePass({ film, ep: "ep9", run_id: RUN_ID, work_dir: work, llm: failing.llm, ffmpeg: copyFfmpeg })) as FramePassResult;
  assert.deepEqual(r.complete, ["ep9-N1"]);
  assert.equal(r.incomplete.length, 1);
  assert.equal(r.incomplete[0].key, "ep9-N2");
  assert.match(r.incomplete[0].error, /claims:ep9-N2: LlmError \(api\): Claude API 400/);
  const written = readJson(r.verdicts_file!);
  assert.deepEqual(written.map((x: { id: string }) => x.id), ["N1"], "the verdict file holds only the complete line");
  assert.equal(r.status_after?.code, 1);
  assert.deepEqual(readJson(path.join(film, "ep9", "review", "frame_pending.json")).map((x: { id: string }) => x.id), ["N2"]);

  const good = fakeLlm();
  const retry = (await runFramePass({ film, ep: "ep9", run_id: RUN_ID, work_dir: work, llm: good.llm, ffmpeg: copyFfmpeg })) as FramePassResult;
  assert.equal(retry.items, 1);
  assert.equal(good.calls.length, 1, "N2's identity reader is reused from its done row");
  assert.equal(retry.calls.filter((c) => c.reused).length, 1);
  assert.equal(path.basename(retry.verdicts_file!), verdictFileName("frame_claims", RUN_ID, 2), "the run's next verdict file");
  assert.equal(retry.status_after?.code, 0, retry.status_after?.lines.join("\n"));
});

test("no vision key: the frame pass stops before any call, crop or verdict file (skipped without the scripts)", async (t) => {
  if (!ready) return t.skip(skipWhy);
  const { film, work } = tempFilm();
  delete process.env.ANTHROPIC_API_KEY;
  const fake = fakeLlm();
  const r = await runFramePass({ film, ep: "ep9", run_id: RUN_ID, work_dir: work, llm: fake.llm, ffmpeg: copyFfmpeg });
  assert.ok(isWorkflowUnavailable(r));
  assert.match(r.unavailable, /add ANTHROPIC_API_KEY/);
  assert.equal(fake.calls.length, 0);
  assert.equal(existsSync(work), false);
  assert.deepEqual(readdirSync(path.join(film, "ep9", "review")).filter((f) => f.startsWith("frame_verdicts")), []);
  // status still ran and still says two lines are unchecked
  const s = await frameClaimsStatus({ film, ep: "ep9" });
  assert.equal(s.code, 1);
});

// ---- cut_verify ----------------------------------------------------------------------------------------

test("the join pass: status first, two readers per join, words_fp through unchanged, cut_joins.py record, and a stale pending list is never sent again (skipped without the scripts)", async (t) => {
  if (!ready) return t.skip(skipWhy);
  const { film, work } = tempFilm();
  const fake = fakeLlm();
  const r = (await runJoinPass({ film, ep: "ep9", run_id: RUN_ID, work_dir: work, llm: fake.llm, ffmpeg: copyFfmpeg })) as JoinPassResult;
  assert.ok(!isWorkflowUnavailable(r));
  assert.equal(r.status_before?.code, 1);
  assert.equal(r.status_before?.rewrote, true);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls.map(lensOf).sort(), ["picture", "story"]);
  for (const c of fake.calls) {
    assert.equal(c.name, "record_cut_verify");
    assert.equal(c.images?.length, 2);
    assert.match(c.user, /SKIPPED 7\.4 seconds/);
    assert.match(c.user, /"Governor Qin, I'll be going, then\."/, "the words around the join, from the pending item");
  }
  const written = readJson(r.verdicts_file!);
  assert.equal(path.basename(r.verdicts_file!), verdictFileName("cut_joins", RUN_ID, 1));
  assert.equal(written[0].id, JOIN);
  assert.equal(written[0].words_fp, "0587555a867c", "the prepared fingerprint, unchanged");
  assert.equal(written[0].reader_version, "cv-2+api:claude-opus-5-5");
  assert.equal(r.recorded?.code, 0, r.recorded?.refusal ?? "");
  const joins = readJson(path.join(film, "ep9", "review", "cut_joins.json"));
  assert.equal(joins[JOIN].lost, false);
  assert.equal(joins[JOIN].readers.length, 2);
  assert.equal(r.status_after?.code, 0, r.status_after?.lines.join("\n"));
  assert.deepEqual(r.lost, []);
  const job = await getData().latestJobByTarget(systemSession(), "film_run", RUN_ID, "cut_verify");
  assert.match(job?.idempotency_key ?? "", new RegExp(`^cv:${RUN_ID}:ep9:${JOIN.replace(/\./g, "\\.")}:0587555a867c:(picture|story):cv-2\\+api:claude-opus-5-5:[0-9a-f]{12}$`));
  assert.equal((job?.input as { reader_version?: string })?.reader_version, "cv-2+api:claude-opus-5-5", "cut_joins.py record keeps no version: the job row does");

  // Status writes cut_pending.json every time (drama-remix 2d89b86), empty once the join is recorded,
  // so the pass that recorded it leaves no list behind and the next pass sends nothing.
  assert.deepEqual(readJson(path.join(film, "ep9", "review", "cut_pending.json")), []);
  const fake2 = fakeLlm();
  const again = (await runJoinPass({ film, ep: "ep9", run_id: RUN_ID, work_dir: work, llm: fake2.llm, ffmpeg: copyFfmpeg })) as JoinPassResult;
  assert.equal(again.status_before?.code, 0);
  assert.equal(again.status_before?.rewrote, true);
  assert.equal(again.items, 0);
  assert.equal(fake2.calls.length, 0);
});

test("a join a reader finds lost is recorded lost and blocks status until waived (skipped without the scripts)", async (t) => {
  if (!ready) return t.skip(skipWhy);
  const { film, work } = tempFilm();
  const fake = fakeLlm((call) => (lensOf(call) === "story" ? { before: "The lounge.", after: "A street.", what_was_cut: "The walk out.", viewer_lost: true, what_is_confusing: "We are suddenly outside.", fix: "narrate_the_jump" } : undefined));
  const r = (await runJoinPass({ film, ep: "ep9", run_id: RUN_ID, work_dir: work, llm: fake.llm, ffmpeg: copyFfmpeg })) as JoinPassResult;
  assert.deepEqual(r.lost, [{ id: JOIN, at_shipped: "3:42.4", why: "We are suddenly outside." }]);
  assert.equal(r.status_after?.code, 1);
  assert.ok(r.status_after?.lines.some((l) => l.includes(`waive cut_join_${JOIN}`)));
});

// ---- sheet_read ------------------------------------------------------------------------------------------

test("the sheet pass: three sheets per call, the entries checked against the prompt's own rules, ONE flattened index/sheet_read_<first>_<last>.json (skipped without the scripts)", async (t) => {
  if (!ready) return t.skip(skipWhy);
  const { film, work } = tempFilm();
  const fake = fakeLlm();
  const r = (await runSheetPass({ film, run_id: RUN_ID, work_dir: work, llm: fake.llm, ffmpeg: copyFfmpeg })) as SheetPassResult;
  assert.ok(!isWorkflowUnavailable(r));
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.name, "record_sheet_read");
  assert.equal(call.images?.length, 1, "the minute sheet only: the prompt says to ignore the subtitle line");
  assert.match(call.user, /STORY SO FAR AND CAST[^\n]*\nHu Xiu, a present-day/, "the premise is sheet_premise.txt");
  assert.match(call.user, /- minute 9: .*proj\/index\/sheets\/min-9\.png/);
  assert.equal(r.file, path.join(film, "index", "sheet_read_9_9.json"));
  const entries = readJson(r.file!) as SheetEntry[];
  assert.equal(entries.length, 6);
  assert.deepEqual(Object.keys(entries[0]), ["start", "end", "where", "who", "action", "shot", "text_on_screen", "visual_value"], "the hand-run log's entry shape");
  assert.deepEqual([entries[0].start, entries[5].end], [540, 599]);
  const job = await getData().latestJobByTarget(systemSession(), "film_run", RUN_ID, "sheet_read");
  assert.match(job?.idempotency_key ?? "", new RegExp(`^sr:${RUN_ID}:9-9:sheet-read\\+api:claude-opus-5-5:[0-9a-f]{12}$`));

  // A second log beside it would double every minute build_script.py concatenates: refused.
  writeFileSync(path.join(film, "index", "sheet_read_0_8.json"), "[]");
  await assert.rejects(runSheetPass({ film, run_id: RUN_ID, work_dir: work, llm: fake.llm, ffmpeg: copyFfmpeg }), /already holds sheet_read_0_8\.json/);
});

test("the sheet pass writes nothing when a group's answer fails its check, and names the group (skipped without the scripts)", async (t) => {
  if (!ready) return t.skip(skipWhy);
  const { film, work } = tempFilm();
  const fake = fakeLlm(() => ({ entries: [{ start: 0, end: 59, where: "x", who: "y", action: "z", shot: "wide", text_on_screen: "", visual_value: 1 }] }));
  const r = (await runSheetPass({ film, run_id: RUN_ID, work_dir: work, llm: fake.llm, ffmpeg: copyFfmpeg })) as SheetPassResult;
  assert.equal(r.file, null);
  assert.equal(r.failed_groups.length, 1);
  assert.match(r.failed_groups[0].error, /entry 0-59 is outside these sheets \(seconds 540-599/);
  assert.equal(existsSync(path.join(film, "index", "sheet_read_9_9.json")), false);
});

test("sheet groups, spans, the entries check and the flattening are the workflow's and the prompt's own rules", () => {
  const sheets = [0, 1, 2, 3, 4].map((m) => ({ minute: m, path: `/p/index/sheets/min-${m}.png` }));
  assert.deepEqual(sheetGroups(sheets, "proj").map((g) => g.sheets.map((s) => s.minute)), [[0, 1, 2], [3, 4]]);
  assert.deepEqual(groupSpan([3, 4]), { start: 180, end: 299 });
  const e = (start: number, end: number): SheetEntry => ({ start, end, where: "w", who: "p", action: "a", shot: "wide", text_on_screen: "", visual_value: 1 });
  const span = { start: 180, end: 299 };
  assert.equal(sheetEntriesProblem([e(180, 239), e(240, 299)], span, false), null);
  assert.equal(sheetEntriesProblem([e(240, 299), e(180, 239)], span, false), null, "order is the check's, not the model's");
  assert.match(sheetEntriesProblem([], span, false)!, /no entries/);
  assert.match(sheetEntriesProblem([e(180, 239), e(250, 299)], span, false)!, /seconds 240-249 are not covered/);
  assert.match(sheetEntriesProblem([e(180, 245), e(240, 299)], span, false)!, /overlap/);
  assert.match(sheetEntriesProblem([e(180, 239), e(240, 290)], span, false)!, /cover to second 299/);
  assert.equal(sheetEntriesProblem([e(180, 239), e(240, 290)], span, true), null, "the source's last minute ends before its sheet");
  assert.match(sheetEntriesProblem([e(0, 59)], span, false)!, /outside these sheets/);
  assert.match(sheetEntriesProblem([e(190, 299)], span, false)!, /cover from second 180/);
  assert.deepEqual(flattenSheetRead([{ entries: [e(60, 119)] }, { entries: [e(0, 59)] }, {}]).map((x) => x.start), [0, 60]);
});
