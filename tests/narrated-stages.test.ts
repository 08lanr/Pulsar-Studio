// The narrated stage machine end to end over fakes (decision 2026-09-23
// "Narrated mode in Studio"; narrated spec N1 with Ruobin's amendments): a
// run walks intake (waiting for what the source cannot default) → index →
// sheets (the Workflow hand-off, flattened into ONE file) → script_raw →
// script (a writing session Studio launches, then the approval) → episodes
// (the plan, then the approval, then the rows) → episode_work (per episode:
// the prep session, the prep review that alone allows voice and GPU, the
// paid voice with ELEVEN_MODEL always passed, the frame and join checks, the
// picture lane under the heavy lock, the build in order after the episode
// before has shipped, the final watch) → film_meta → handoff
// (DELIVERED-narrated.json, the scanner READY). The pipeline's scripts are
// stood in by a fake runner that writes plausible artifacts; the writing
// sessions by the fake launcher. Then the refusals: voice and GPU before the
// approval, a missing Claude Code CLI, a usage limit that resumes the same
// session, the W-id rule, the build's stop lines, the ordering rule.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { CLI_MISSING_MESSAGE, FakeClaudeLauncher, takeWritingLock, type FakeCall, type FakeSessionScript } from "@/lib/claude-session";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import type { RunResult } from "@/lib/python";
import { NARRATED_MANIFEST_FILE } from "@/lib/film-import/manifest";
import { narratedOf, scanFilm } from "@/lib/film-import/scan";
import { EPISODE_PLAN_FILE } from "@/lib/segment/narrated/briefs";
import { dropRefusal, orderingRefusal, planEpisodeSteps, STEP_CAPACITY } from "@/lib/segment/narrated/build";
import { firstNumberRefusal } from "@/lib/segment/narrated/intake";
import { statusSays } from "@/lib/segment/narrated/narration";
import { wIdViolation } from "@/lib/segment/narrated/prep";
import { EPISODE_WAKES, isNarratedActionable, narratedRefusal, runNarratedStage, type FilmStep, type NarratedDeps, type NarratedScriptRunner, type PictureOutcome } from "@/lib/segment/narrated/stages";
import { ttsSig } from "@/lib/segment/narrated/voice";
import type { StageContext, StageOutcome } from "@/lib/segment/stages";
import type { SyncResult } from "@/lib/segment/scripts-sync";
import type { FilmRun, FilmRunDecision, Json } from "@/lib/types";
import { producer, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

const sys = systemSession();
const VOICE = "cgSgspJ2msm6clMCkdW9";
const DURATION = 600;

const PREP_BRIEF = [
  "# PREP-BRIEF (test copy)",
  "",
  "The header paragraph, in the shape the generator wrote it:",
  "",
  '> You are preparing ONE episode of the narrated "Love Between Lines" remix, up to (not including) voice',
  "> rendering and the build. Episode: **ep{N}** (source S01E04), {window}. Story in this window: {story}",
  "",
  "## The brief",
  "",
  "```text",
  "PROJECT: C:/Users/ruobi/Github/Pulsar-Workspace/mini-drama-system/projects/{PROJ}. Run everything from there, in bash. The source is source/{SRCFILE}.",
  "READ FIRST: ../../drama-remix/references/skip-through-pipeline.md and {SCRIPTS}.",
  "5. The worked example: ../lbl-e03/ep24/PREP.md",
  "NAMES: canon spellings are in glossary.json.",
  "- Hu Xiu tells the story afterwards.",
  "",
  "STEPS",
  "1. Write edl/ep{N}.json; the previous episode is ep{P}.",
  "10. `touch ep{N}/READY_GPU`",
  "```",
  "",
].join("\n");

type Env = {
  root: string;
  work: string;
  canonical: string;
  film: string;
  calls: FilmStep[];
  launcher: FakeClaudeLauncher;
  deps: Partial<NarratedDeps>;
  failScript?: (step: FilmStep) => RunResult | null;
};

const ok = (stdout = "PASS"): RunResult => ({ code: 0, signal: null, stdout: "", stdoutTail: stdout, stderrTail: "", durationMs: 1, timedOut: false, cancelled: false });

function write(file: string, text: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** The pipeline, faked: each script writes what the real one would, from the film root. */
function fakeRunner(env: Env): NarratedScriptRunner {
  return {
    fake: true,
    async run(step, ctx) {
      env.calls.push(step);
      const forced = env.failScript?.(step);
      if (forced) return forced;
      const f = (rel: string) => path.join(ctx.film, ...rel.split("/"));
      const name = path.basename(step.script);
      const epArg = (i = step.args.indexOf("--ep")) => (i >= 0 ? step.args[i + 1] : "");
      switch (name) {
        case "checks.py":
          return ok("in sync with the canonical skill copy");
        case "index_chain.sh": {
          assert.equal(step.env?.T0, "0", "T0 is always passed (the scans default to 50 s)");
          assert.equal(step.env?.T1, String(DURATION));
          write(f("index/audio16k.wav"), "wav");
          write(f("index/scdet.txt"), "1.0\n");
          write(f("index/whisper.json"), JSON.stringify({ language: "zh", duration: DURATION, segments: Array.from({ length: 20 }, (_, k) => ({ start: k * 30, end: k * 30 + 5, text: `line ${k}` })) }));
          write(f("index/captions_zh.json"), "[]");
          write(f("index/lyric_cues.json"), "[]");
          for (let m = 0; m < DURATION / 60; m++) write(f(`index/sheets/min-${m}.png`), "png");
          return ok("INDEX DONE");
        }
        case "build_script.py":
          write(f("index/script_raw.md"), "# raw\n");
          return ok();
        case "make_ep.py": {
          const n = step.args[step.args.indexOf("--ep") + 1];
          write(f(`ep${n}/base.mp4`), "base");
          write(f(`ep${n}/base.wav`), "wav");
          write(f(`ep${n}/cues_base.json`), "[]");
          write(f(`ep${n}/edl.json`), JSON.stringify({ title: `EPISODE ${n}`, subtitle: "x" }));
          write(f(`ep${n}/base.mp4.pieces.json`), JSON.stringify({ pieces: [{ id: "P1", src_in: 140, src_out: 200, mode: "kept" }, { id: "P2", src_in: 205, src_out: 260, mode: "bridge" }] }));
          return ok("plan: 2 pieces");
        }
        case "transcript.py":
          write(f(`${step.args[0]}/review/transcript.txt`), "the transcript");
          return ok();
        case "clean_lbl.py":
          write(f(step.args[step.args.indexOf("--out") + 1]), "clean");
          return ok();
        case "residue_fix.py":
          write(f(`${epArg()}/clean2.mp4`), "clean2");
          return ok();
        case "track_faces.py":
          write(f(step.args[step.args.indexOf("--out") + 1]), JSON.stringify({ shots: [] }));
          return ok();
        case "reframe.py":
          write(f(step.args[step.args.indexOf("--out") + 1]), "vertical");
          return ok();
        case "tts_narration.py": {
          assert.equal(step.env?.ELEVEN_MODEL, "eleven_v3", "ELEVEN_MODEL is always passed");
          assert.deepEqual(step.keys, ["ELEVENLABS_API_KEY"], "the ElevenLabs key reaches this step only");
          const nfRel = step.args[1];
          const voice = step.args[2];
          const nf = JSON.parse(readFileSync(f(nfRel), "utf8")) as { lines: { id: string; text: string }[] };
          const takes = f(nfRel.replace(/\.json$/, ""));
          const ledger = f("tts_ledger.json");
          const rows = existsSync(ledger) ? (JSON.parse(readFileSync(ledger, "utf8")) as unknown[]) : [];
          for (const l of nf.lines.filter((x) => x.id.startsWith("N"))) {
            const sig = ttsSig(voice, String(step.env?.ELEVEN_MODEL), l.text);
            const mp3 = path.join(takes, `${l.id}.mp3`);
            if (existsSync(`${mp3}.sig`) && readFileSync(`${mp3}.sig`, "utf8") === sig) continue;
            write(mp3, "mp3");
            write(`${mp3}.sig`, sig);
            rows.push({ tag: l.id, voice, chars: l.text.length, file: path.relative(ctx.film, mp3).split(path.sep).join("/"), request_id: "r", time: "2026-09-23 20:00:00" });
          }
          write(ledger, JSON.stringify(rows));
          write(path.join(takes, "manifest.json"), JSON.stringify({ voice, model: step.env?.ELEVEN_MODEL, lines: [] }));
          return ok();
        }
        case "frame_claims.py":
          if (step.args[0] === "status") write(f(`${epArg()}/review/frame_check.json`), JSON.stringify({ N1: {}, N2: {} }));
          return ok();
        case "cut_joins.py":
          if (step.args[0] === "status") write(f(`${epArg()}/review/cut_joins.json`), JSON.stringify({ "200.00-205.00": {} }));
          return ok();
        case "build_ep.sh": {
          const [n, v] = step.args;
          const dir = f(`ep${n}/variants/${v}`);
          write(path.join(dir, "body.mp4"), `body ${n} ${v}`);
          write(path.join(dir, `ep${n}.mp4`), `shipped ${n} ${v}`);
          write(path.join(dir, "intro.mp4"), "intro");
          write(path.join(dir, `ep${n}.srt`), "1\n");
          write(path.join(dir, `ep${n}.mp4.gate.json`), JSON.stringify({ counts: { PASS: 27, WARN: 5, FAIL: 0 }, items: [] }));
          write(path.join(dir, `ep${n}.mp4.gate.md`), "# Gate\n");
          return ok(`gate exit 0\nshipped with title card: ep${n}/variants/${v}/ep${n}.mp4`);
        }
        default:
          if (step.what.startsWith("stems")) {
            write(f(`${step.args[0].split("/")[0]}/stems/a.wav`), "a");
            write(f(`${step.args[0].split("/")[0]}/stems/b.wav`), "b");
          }
          return ok();
      }
    },
  };
}

/** The writing sessions, faked: the script read writes the script, glossary, premise and the plan; a prep writes the episode's files. */
function sessionScript(env: Env, plan: { n: number; src_in: number; src_out: number }[]) {
  return (call: FakeCall): FakeSessionScript => {
    const label = path.basename(call.req.logFile, ".jsonl");
    if (label === "script") {
      return {
        writes: {
          "SCRIPT-S01E05.md": `# SCRIPT S01E05\n\n${"The story, beat by beat. ".repeat(20)}`,
          "glossary.json": JSON.stringify({ canon: ["Hu Xiu", "Boss Yu"], banned: { "Hu Siu": "Hu Xiu" } }),
          "frame_premise.txt": "Hu Xiu tells the story afterwards; Boss Yu rents her house.",
          [path.join(call.req.additionalDirectories?.[0] ?? env.work, EPISODE_PLAN_FILE)]: JSON.stringify({ episodes: plan.map((p) => ({ ...p, title: `EPISODE ${p.n}`, subtitle: `Part ${p.n}`, hook: "the last line", story: `The beats of ep${p.n}.` })) }),
        },
      };
    }
    const n = Number(/prep-ep(\d+)/.exec(label)?.[1]);
    assert.ok(n, `a prep session is labelled prep-epN, not ${label}`);
    assert.match(call.req.prompt, new RegExp(`Episode: \\*\\*ep${n}\\*\\*`), "the filled prep brief is the prompt");
    assert.doesNotMatch(call.req.prompt, /\{(N|P|PROJ|SRCFILE|SCRIPTS|window|story)\}/);
    return {
      writes: {
        [`edl/ep${n}.json`]: JSON.stringify({ episode: n, pieces: [] }),
        [`ep${n}/narration.json`]: JSON.stringify({ lines: [{ id: "N1", text: `Episode ${n} opens.`, window: [0, 3] }, { id: "N2", text: "I didn't know yet.", window: [10, 12] }] }),
        [`ep${n}/en.json`]: "{}",
        [`ep${n}/PREP.md`]: "# PREP\n\n## For you to decide\n- the cut at 2:10\n",
        // The brief's step 8: the agent writes its own waivers. They are proposals until the prep review.
        [`ep${n}/waivers.json`]: JSON.stringify({ N9_x: "the agent's own reason", N2_sowhat: "the agent's reason" }),
      },
    };
  };
}

function setup(plan = [{ n: 36, src_in: 140, src_out: 392 }, { n: 37, src_in: 392, src_out: 600 }]): Env {
  const root = mkdtempSync(path.join(tmpdir(), "studio-narr-ws-"));
  const work = mkdtempSync(path.join(tmpdir(), "studio-narr-work-"));
  const canonical = path.join(root, "..", `canonical-${path.basename(root)}`);
  mkdirSync(canonical, { recursive: true });
  // The prior project: ep35 shipped (gate FAIL 0) with a narration manifest naming the voice.
  const prior = path.join(root, "lbl-e04", "ep35");
  write(path.join(prior, "variants", "v1", "ep35.mp4"), "prior");
  write(path.join(prior, "variants", "v1", "ep35.mp4.gate.json"), JSON.stringify({ counts: { PASS: 27, WARN: 5, FAIL: 0 } }));
  write(path.join(prior, "narration", "manifest.json"), JSON.stringify({ voice: VOICE, model: "eleven_v3" }));
  const source = path.join(root, "..", `src-${path.basename(root)}-s01e05.mp4`);
  writeFileSync(source, "source bytes");
  const env = { root, work, canonical, film: path.join(root, "high-quality", "lbl-s01e05"), calls: [] } as unknown as Env;
  env.launcher = new FakeClaudeLauncher(sessionScript(env, plan));
  const sync = (film: string): SyncResult => {
    write(path.join(film, "scripts", "PREP-BRIEF.md"), PREP_BRIEF);
    write(path.join(film, "scripts", "build_ep.sh"), "echo");
    const record = { sha: "c".repeat(40), dirty: false, dirty_paths: [], synced_at: new Date().toISOString(), files: ["PREP-BRIEF.md", "build_ep.sh"], source: "canonical", route: "skip-through" as const };
    write(path.join(film, ".studio-scripts.json"), JSON.stringify(record));
    return { ...record, scripts_dir: path.join(film, "scripts"), record_file: path.join(film, ".studio-scripts.json") };
  };
  env.deps = { launcher: env.launcher, scripts: fakeRunner(env), sync, canonicalScripts: canonical, readers: null };
  (env as unknown as { source: string }).source = source;
  return env;
}

function teardown(env: Env): void {
  for (const d of [env.root, env.work, env.canonical, (env as unknown as { source: string }).source]) rmSync(d, { recursive: true, force: true });
}

async function createRun(env: Env, settings: FilmRun["settings"] = {}): Promise<FilmRun> {
  return fixtureData.createFilmRun(staff(), {
    producer_id: producer().producerId!,
    source_path: (env as unknown as { source: string }).source,
    bucket: "high-quality",
    slug: "lbl-s01e05",
    mode: "narrated",
    lang: "zh",
    settings: { season: { series_key: "love-between-lines", first_episode_n: 36, prior_projects: ["lbl-e04"], series_title: "Love Between Lines", title_source_ref: "love-between-lines" }, narrator: "Hu Xiu", ...settings },
  });
}

/** The worker's loop, as far as a narrated run needs it: one stage at a time, the outcome written like the worker writes it. */
async function drive(env: Env, runId: string, max = 60): Promise<FilmRun> {
  for (let i = 0; i < max; i++) {
    let run = await fixtureData.getFilmRun(sys, runId);
    if (["done", "failed", "cancelled"].includes(run.stage) || !isNarratedActionable(run)) return run;
    if (run.stage === "queued") {
      await fixtureData.setFilmRunStage(sys, run.id, { stage: "intake", revision: run.revision });
      continue;
    }
    const logs: string[] = [];
    const ctx: StageContext = {
      run,
      session: sys,
      data: fixtureData,
      runner: {
        fake: true,
        probe: async (file: string) => (file.endsWith(".mp4") ? { width: 1920, height: 1080, fps: 25, duration_s: file.includes("intro") ? 6.04 : DURATION, frames: 15000 } : null),
      } as unknown as StageContext["runner"],
      owner: "test:1",
      env: { HEAVY_LOCK_ROOT: env.work, PATH: process.env.PATH },
      dirs: { root: env.root, film: env.film, cut: path.join(env.film, "cut"), source: path.join(env.film, "source", "original.mp4"), work: path.join(env.work, run.id) },
      log: (l) => logs.push(l),
      progress: async (detail) => {
        const fresh = await fixtureData.getFilmRun(sys, runId);
        run = await fixtureData.setFilmRunStage(sys, runId, { stage: fresh.stage, stage_detail: { ...(fresh.stage_detail as Record<string, Json>), ...(detail as Record<string, Json>) }, revision: fresh.revision });
      },
      beat: async () => undefined,
      signal: new AbortController().signal,
      lock: () => undefined,
    };
    const out: StageOutcome = await runNarratedStage(ctx, env.deps);
    run = await fixtureData.getFilmRun(sys, runId);
    const detail = { ...(run.stage_detail as Record<string, Json>) };
    delete detail.waiting;
    delete detail.progress;
    if (out.kind === "next") {
      await fixtureData.setFilmRunStage(sys, runId, { stage: out.stage, stage_detail: { ...detail, ...(out.detail as Record<string, Json>) }, revision: run.revision, ...(out.row ?? {}) });
    } else if (out.kind === "wait") {
      const waiting = { for: out.for, since: new Date().toISOString(), retry_after: out.retryMs ? new Date(Date.now() + out.retryMs).toISOString() : null };
      await fixtureData.setFilmRunStage(sys, runId, { stage: run.stage, stage_detail: { ...detail, ...((out.detail ?? {}) as Record<string, Json>), waiting, decisions_seen: run.decisions.length }, revision: run.revision });
      return fixtureData.getFilmRun(sys, runId);
    } else {
      await fixtureData.setFilmRunStage(sys, runId, { stage: "failed", stage_detail: { ...detail, ...((out.detail ?? {}) as Record<string, Json>) }, error_text: out.error, revision: run.revision });
      return fixtureData.getFilmRun(sys, runId);
    }
  }
  throw new Error("the run did not settle");
}

const decide = (runId: string, d: Omit<FilmRunDecision, "at" | "by" | "boundary_s"> & { boundary_s?: null }) => fixtureData.appendFilmRunDecision(staff(), runId, { boundary_s: null, ...d });
const waitingFor = (run: FilmRun) => (run.stage_detail as { waiting?: { for?: string } }).waiting?.for ?? null;

test("a narrated run end to end: the four approvals, the writing sessions, both lanes, the build in order, the delivery", async () => {
  resetFixtureStore();
  const env = setup();
  try {
    let run = await createRun(env);
    run = await drive(env, run.id);
    assert.equal(run.stage, "intake");
    assert.equal(waitingFor(run), "intake", "the sheet premise cannot be defaulted");
    assert.deepEqual((run.stage_detail as { intake: { missing: string[] } }).intake.missing, ["sheet_premise"], "the voice comes from the prior project's manifest");

    await decide(run.id, { action: "intake", data: { settings: { sheet_premise: "Hu Xiu (green sweater), Boss Yu (young man, grey suit), present-day Shanghai" } } });
    run = await drive(env, run.id);
    // intake → index → sheets: the readers are a hand-off by default.
    assert.equal(run.stage, "sheets", run.error_text ?? "");
    assert.equal(waitingFor(run), "handoff");
    assert.match(JSON.stringify(run.stage_detail), /sheet_read\.workflow\.js/);
    assert.equal(readFileSync(path.join(env.film, "sheet_premise.txt"), "utf8"), "Hu Xiu (green sweater), Boss Yu (young man, grey suit), present-day Shanghai");
    assert.ok(existsSync(path.join(env.film, "ep35")), "the prior episode is junctioned in");
    assert.equal(run.drama_remix_sha, "c".repeat(40));
    assert.ok(existsSync(path.join(env.film, ".studio-scripts.json")));

    const out = path.join(env.work, "sheet-read.output.json");
    writeFileSync(out, JSON.stringify([{ project: "lbl-s01e05", minutes: [0, 1, 2], entries: [{ start: 60, end: 70, where: "b", who: "x", action: "y", shot: "wide", text_on_screen: "", visual_value: 2 }, { start: 0, end: 9, where: "a", who: "x", action: "y", shot: "wide", text_on_screen: "", visual_value: 2 }] }]));
    await decide(run.id, { action: "handoff_done", data: { stage: "sheets", output_path: out } });
    run = await drive(env, run.id);
    const sheetRead = JSON.parse(readFileSync(path.join(env.film, "index", "sheet_read_0_9.json"), "utf8")) as { start: number }[];
    assert.deepEqual(sheetRead.map((e) => e.start), [0, 60], "ONE file, flattened and sorted");
    // script_raw → script: the session ran, the files check, and the approval is waited for.
    assert.equal(run.stage, "script");
    assert.equal(waitingFor(run), "script");
    assert.deepEqual((run.stage_detail as { script_check: { problems: string[] } }).script_check.problems, []);
    assert.equal(env.launcher.calls.length, 1);
    assert.equal(env.launcher.calls[0].req.cwd, env.film, "the session runs in the film folder");
    assert.deepEqual(env.launcher.calls[0].req.skills, ["drama-remix"]);
    assert.equal(env.launcher.calls[0].req.lock?.holder, `${run.id}/script`, "one writing session on the machine");
    const scriptJobs = (await fixtureData.latestJobByTarget(sys, "film_run", run.id, "claude_session"))!;
    assert.equal(scriptJobs.status, "done");
    assert.equal(scriptJobs.cost_cents, null, "the subscription pays: no API cost");

    await decide(run.id, { action: "script", data: { action: "approve" } });
    run = await drive(env, run.id);
    assert.equal(run.stage, "episodes");
    assert.equal(waitingFor(run), "episodes");
    assert.deepEqual((run.stage_detail as { plan: { problems: string[] } }).plan.problems, []);

    await decide(run.id, { action: "episodes", data: { action: "approve" } });
    run = await drive(env, run.id);
    // episode_work: both preps ran (one at a time), both wait for their review; nothing paid, no GPU.
    assert.equal(run.stage, "episode_work", run.error_text ?? "");
    assert.equal(waitingFor(run), "episode_work");
    let eps = await fixtureData.listRunEpisodes(sys, run.id);
    assert.deepEqual(eps.map((e) => [e.n, e.words_stage, e.picture_stage]), [[36, "prep_review", "waiting"], [37, "prep_review", "waiting"]]);
    assert.equal(env.calls.some((c) => c.script === "tts_narration.py" || c.script === "clean_lbl.py"), false, "no voice and no GPU before the prep review");
    const prompt36 = env.launcher.calls.find((c) => /prep-ep36/.test(c.req.logFile))!.req.prompt;
    assert.match(prompt36, /Do not create ep36\/READY_GPU/);
    assert.match(prompt36, /the FIRST episode of source episode 5/);
    assert.match(prompt36, /Story in this window: The beats of ep36\./);
    assert.ok(existsSync(path.join(env.film, "ep36", "review", "transcript.txt")), "the draft checks ran");
    // The waivers the agent wrote are proposals on the row, not in force: the file is back as it was before the prep.
    assert.equal(existsSync(path.join(env.film, "ep36", "waivers.json")), false, "an agent-written waiver switches no check off before the review");
    assert.deepEqual(
      ((eps[0].stage_detail as { proposed_waivers: { key: string; reason: string; by: string }[] }).proposed_waivers ?? []).map((w) => [w.key, w.reason, w.by]),
      [
        ["N9_x", "the agent's own reason", "prep session"],
        ["N2_sowhat", "the agent's reason", "prep session"],
      ]
    );

    // The approval alone starts voice and the picture lane.
    await decide(run.id, { action: "prep", ep: 36, data: { action: "approve", transcript_read: true, answers: [{ item: "the cut at 2:10", answer: "keep it" }], waivers: [{ key: "N2_sowhat", reason: "the line lands on the picture", accept: true }, { key: "N9_x", reason: "no", accept: false }] } });
    await decide(run.id, { action: "prep", ep: 37, data: { action: "approve", transcript_read: false } });
    run = await drive(env, run.id);
    eps = await fixtureData.listRunEpisodes(sys, run.id);
    const [e36, e37] = eps;
    assert.equal(e36.stage, "ep_review", JSON.stringify(e36.stage_detail));
    assert.equal(e36.variant, "v1");
    assert.deepEqual(e36.gate, { PASS: 27, WARN: 5, FAIL: 0 });
    assert.match(e36.shipped_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(env.film, "ep36", "waivers.json"), "utf8")), { N2_sowhat: "the line lands on the picture" }, "only the accepted waiver is written; the refused one the agent wrote is not in force");
    assert.deepEqual((e36.stage_detail as { proposed_waivers: unknown[] }).proposed_waivers, [], "the proposals were decided");
    assert.equal(e37.words_stage, "prep_review", "an approval without the transcript read is not taken");
    assert.match(JSON.stringify(e37.stage_detail), /transcript read/);
    const tts = (await fixtureData.latestJobByTarget(sys, "film_run", run.id, "tts_line"))!;
    assert.equal(tts.provider, "elevenlabs");
    assert.match(tts.idempotency_key, new RegExp(`^tts:${run.id}:36:N[12]:[0-9a-f]{10}$`));
    assert.equal(tts.cost_cents, null, "no price set: the row says so rather than guessing");
    const credits = JSON.parse(readFileSync(path.join(env.film, "credits-ledger.json"), "utf8")) as { elevenlabs_chars: { chars: number }[] };
    assert.equal(credits.elevenlabs_chars[0].chars, "Episode 36 opens.".length + "I didn't know yet.".length, "nothing paid without a ledger entry");

    await decide(run.id, { action: "prep", ep: 37, data: { action: "approve", transcript_read: true } });
    run = await drive(env, run.id);
    eps = await fixtureData.listRunEpisodes(sys, run.id);
    assert.equal(eps[1].stage, "build", "ep37 is ready but waits for ep36 to ship");
    assert.match(JSON.stringify(eps[1].stage_detail), /builds after ep36 has shipped/);
    assert.equal(env.calls.filter((c) => c.script === "build_ep.sh").length, 1);

    await decide(run.id, { action: "episode", ep: 36, data: { action: "approve" } });
    run = await drive(env, run.id);
    eps = await fixtureData.listRunEpisodes(sys, run.id);
    assert.equal(eps[0].stage, "shipped");
    assert.equal(eps[0].approved_by, staff().userId);
    assert.equal(eps[1].stage, "ep_review", "ep37 built once ep36 shipped");

    await decide(run.id, { action: "episode", ep: 37, data: { action: "approve" } });
    run = await drive(env, run.id);
    assert.equal(run.stage, "film_meta");
    await decide(run.id, { action: "film_meta", data: { display_title_en: "Love Between Lines", crazydramas_slug: "love-between-lines" } });
    run = await drive(env, run.id);
    assert.equal(run.stage, "handoff");
    assert.equal(waitingFor(run), "import", JSON.stringify(run.stage_detail));
    const manifest = JSON.parse(readFileSync(path.join(env.film, NARRATED_MANIFEST_FILE), "utf8")) as { episodes: { n: number; file: string; project: string; approved_at: string | null; pieces: unknown[]; narration: { voice: string } }[]; intro_s: number; title_source_ref: string };
    assert.deepEqual(manifest.episodes.map((e) => e.n), [36, 37]);
    assert.equal(manifest.episodes[0].file, "ep36/variants/v1/ep36.mp4");
    assert.equal(manifest.episodes[0].project, "high-quality/lbl-s01e05");
    assert.equal(manifest.episodes[0].pieces.length, 2);
    assert.equal(manifest.intro_s, 6.04);
    assert.equal(manifest.title_source_ref, "love-between-lines");
    const scan = await scanFilm("high-quality/lbl-s01e05", { root: env.root, quietMs: 0 });
    assert.equal(scan.state, "READY", JSON.stringify(narratedOf(scan)?.problems));

    await decide(run.id, { action: "import_now" });
    run = await drive(env, run.id);
    assert.equal(waitingFor(run), "import");
    assert.match(String((run.stage_detail as { import_error?: string }).import_error), /not ready to import/, "the cut-only import refuses a narrated delivery until it learns the manifest");
  } finally {
    teardown(env);
  }
});

test("voice and the picture lane refuse to start before the decide-list approval", async () => {
  resetFixtureStore();
  const env = setup([{ n: 36, src_in: 140, src_out: 392 }]);
  try {
    const run = await createRun(env, { sheet_premise: "cast" });
    const [ep] = await fixtureData.createRunEpisodes(sys, run.id, { series_key: "love-between-lines", episodes: [{ n: 36, src_in: 140, src_out: 392 }] });
    const { narratedContext } = await import("@/lib/segment/narrated/stages");
    const { runVoiceStep } = await import("@/lib/segment/narrated/voice");
    const { runPictureStep } = await import("@/lib/segment/narrated/gpu");
    const ctx = narratedContext({ run, session: sys, data: fixtureData, runner: { fake: true } as never, owner: "t", env: { HEAVY_LOCK_ROOT: env.work }, dirs: { root: env.root, film: env.film, cut: "", source: "", work: env.work }, log: () => undefined, progress: async () => undefined, beat: async () => undefined, signal: new AbortController().signal, lock: () => undefined }, env.deps);
    const v = await runVoiceStep(ctx, ep, [ep]);
    assert.equal(v.kind, "refused");
    assert.match(v.kind === "refused" ? v.error : "", /does not start before the episode's decide list and transcript read are approved/);
    const p = await runPictureStep(ctx, ep);
    assert.equal(p.kind, "refused");
    assert.equal(env.calls.length, 0, "nothing ran");
    // The planner never offers the picture lane before the approval either.
    assert.deepEqual(planEpisodeSteps(run, ep).map((s) => s.name), ["prep"]);
  } finally {
    teardown(env);
  }
});

test("no Claude Code on the machine is a clean wait with the words to fix it; a usage limit waits for its reset and resumes the same session", async () => {
  resetFixtureStore();
  const env = setup();
  try {
    let run = await createRun(env, { sheet_premise: "cast" });
    // A folder an earlier Studio run of this source made (its sync record at the root), indexed and sheet-read already.
    write(path.join(env.film, ".studio-scripts.json"), JSON.stringify({ sha: "c".repeat(40), files: [] }));
    for (const f of ["audio16k.wav", "scdet.txt", "captions_zh.json", "lyric_cues.json"]) write(path.join(env.film, "index", f), "x");
    write(path.join(env.film, "index", "whisper.json"), JSON.stringify({ duration: DURATION, segments: [] }));
    for (let m = 0; m < 10; m++) write(path.join(env.film, "index", "sheets", `min-${m}.png`), "p");
    write(path.join(env.film, "index", "sheet_read_0_9.json"), "[]");
    let n = 0;
    env.deps.launcher = new FakeClaudeLauncher((call) => {
      n++;
      if (n === 1) return { outcome: { status: "unavailable", reason: "cli_missing" } };
      if (n === 2) return { outcome: { status: "limited", resets_at: new Date(Date.now() - 1000).toISOString() } };
      assert.equal(call.kind, "resume", "after a limit the same session is resumed");
      return sessionScript(env, [{ n: 36, src_in: 140, src_out: 392 }])(call);
    });
    run = await drive(env, run.id);
    assert.equal(run.stage, "script", run.error_text ?? "");
    assert.equal(waitingFor(run), "session");
    assert.match(String((run.stage_detail as { session_problem?: string }).session_problem), new RegExp(CLI_MISSING_MESSAGE));
    await decide(run.id, { action: "retry" });
    run = await drive(env, run.id);
    assert.equal(waitingFor(run), "session", "the limit");
    const limited = (run.stage_detail as { session: { status: string; session_id: string } }).session;
    assert.equal(limited.status, "limited");
    assert.equal(limited.session_id, "fake-2");
    const retryAfter = Date.parse(String((run.stage_detail as { waiting: { retry_after: string } }).waiting.retry_after));
    assert.ok(retryAfter > Date.now(), "the run looks again after the reset (a minute at least), by itself");
    // Retry (or the reset poll) resumes the same session by its id.
    await decide(run.id, { action: "retry" });
    run = await drive(env, run.id);
    assert.equal(waitingFor(run), "script");
    const calls = (env.deps.launcher as FakeClaudeLauncher).calls;
    assert.equal(calls[calls.length - 1].session_id, "fake-2");
  } finally {
    teardown(env);
  }
});

test("the pure rules: the W-id rule, the build's stop lines verbatim, the ordering rule, the wakes", () => {
  const rows = (k: number) => Array.from({ length: k }, (_, i) => ({ start: i * 10, end: i * 10 + 5, hash: `h${i}` }));
  assert.equal(wIdViolation(rows(5), rows(5), { n: 36, src_in: 0, src_out: 20 }), null);
  assert.match(wIdViolation(rows(5), rows(4), { n: 36, src_in: 0, src_out: 20 }) ?? "", /had 5 rows and now has 4: W ids are positional/);
  const changed = rows(5);
  changed[4] = { ...changed[4], hash: "other" };
  assert.match(wIdViolation(rows(5), changed, { n: 36, src_in: 0, src_out: 20 }) ?? "", /outside its window .*W5/);
  const inside = rows(5);
  inside[1] = { ...inside[1], hash: "retimed" };
  assert.equal(wIdViolation(rows(5), inside, { n: 36, src_in: 0, src_out: 20 }), null, "a cue fix inside the window is the prep's own");

  const gate = narratedRefusal({ script: "build_ep.sh" }, { code: 1, stdoutTail: "  FAIL [assembly] no caption residue: 3 frames\ngate exit 1\nGATE FAILED - no shipped file written. The un-gated body is at ep9/variants/v2/ep9.mp4\nRead ep9/variants/v2/ep9.mp4.gate.md, fix, and rebuild.\n", stderrTail: "", timedOut: false, cancelled: false });
  assert.match(gate, /^build_ep\.sh exited 1\n {2}FAIL \[assembly\] no caption residue: 3 frames\nGATE FAILED - no shipped file written/);
  assert.match(gate, /Read ep9\/variants\/v2\/ep9\.mp4\.gate\.md, fix, and rebuild\./, "the line after GATE FAILED names the report");
  assert.match(narratedRefusal({ script: "build_ep.sh" }, { code: 1, stdoutTail: "x\nPICTURE IS STALE - re-run the GPU chain for ep9 (see above). Nothing built.\n", stderrTail: "", timedOut: false, cancelled: false }), /PICTURE IS STALE/);
  assert.match(narratedRefusal({ script: "build_ep.sh" }, { code: 1, stdoutTail: "some output\n", stderrTail: "", timedOut: false, cancelled: false }, "continuity.py"), /the step that stopped: continuity\.py/);

  const film = mkdtempSync(path.join(tmpdir(), "studio-order-"));
  try {
    assert.match(orderingRefusal({ n: 37 }, [{ n: 36, stage: "ep_review" }], film) ?? "", /builds after ep36 has shipped/);
    assert.equal(orderingRefusal({ n: 37 }, [{ n: 36, stage: "shipped" }], film), null);
    assert.match(orderingRefusal({ n: 36 }, [], film) ?? "", /ep35 .* has none/);
    write(path.join(film, "ep35", "variants", "v2", "ep35.mp4"), "x");
    write(path.join(film, "ep35", "variants", "v2", "ep35.mp4.gate.json"), JSON.stringify({ counts: { PASS: 1, WARN: 0, FAIL: 0 } }));
    assert.equal(orderingRefusal({ n: 36 }, [], film), null, "the prior project's shipped episode counts");
    assert.equal(orderingRefusal({ n: 1 }, [], film), null);
  } finally {
    rmSync(film, { recursive: true, force: true });
  }

  const waiting = (w: string, seen: number, decisions: FilmRunDecision[]) => isNarratedActionable({ stage: "script", stage_detail: { waiting: { for: w }, decisions_seen: seen }, decisions });
  const d = (action: string): FilmRunDecision => ({ at: "", by: "x", action, boundary_s: null });
  assert.equal(waiting("script", 0, []), false);
  assert.equal(waiting("script", 0, [d("script")]), true);
  assert.equal(waiting("script", 1, [d("script")]), false, "a decision already seen does not wake it again");
  assert.equal(waiting("episode_work", 0, [d("prep")]), true);
  assert.equal(waiting("import", 0, [d("prep")]), false);
});

test("a prep that breaks the W-id rule is refused with the words to fix it, and the episode stays in its prep", async () => {
  resetFixtureStore();
  const env = setup([{ n: 36, src_in: 0, src_out: 100 }]);
  try {
    const run = await createRun(env, { sheet_premise: "cast" });
    write(path.join(env.film, "scripts", "PREP-BRIEF.md"), PREP_BRIEF);
    write(path.join(env.film, "index", "whisper.json"), JSON.stringify({ duration: DURATION, segments: [{ start: 10, end: 12, text: "a" }, { start: 300, end: 302, text: "b" }] }));
    const [ep] = await fixtureData.createRunEpisodes(sys, run.id, { series_key: "love-between-lines", episodes: [{ n: 36, src_in: 0, src_out: 100 }] });
    env.deps.launcher = new FakeClaudeLauncher(() => ({ writes: { "index/whisper.json": JSON.stringify({ duration: DURATION, segments: [{ start: 10, end: 12, text: "a" }] }), "ep36/narration.json": "{}" } }));
    const { narratedContext } = await import("@/lib/segment/narrated/stages");
    const { runPrepStep } = await import("@/lib/segment/narrated/prep");
    const ctx = narratedContext({ run, session: sys, data: fixtureData, runner: { fake: true } as never, owner: "t", env: { HEAVY_LOCK_ROOT: env.work }, dirs: { root: env.root, film: env.film, cut: "", source: "", work: env.work }, log: () => undefined, progress: async () => undefined, beat: async () => undefined, signal: new AbortController().signal, lock: () => undefined }, env.deps);
    const out = await runPrepStep(ctx, ep, [ep]);
    assert.equal(out.kind, "refused");
    assert.match(out.kind === "refused" ? out.error : "", /had 2 rows and now has 1: W ids are positional/);
    assert.equal(env.calls.some((c) => c.script === "make_ep.py"), false, "no draft check runs on a broken index");
  } finally {
    teardown(env);
  }
});

// ---- phase 4a review fixes ------------------------------------------------------------------------------------------

async function directCtx(env: Env, run: FilmRun) {
  const { narratedContext } = await import("@/lib/segment/narrated/stages");
  return narratedContext({ run, session: sys, data: fixtureData, runner: { fake: true } as never, owner: "t", env: { HEAVY_LOCK_ROOT: env.work, PATH: process.env.PATH }, dirs: { root: env.root, film: env.film, cut: "", source: "", work: env.work }, log: () => undefined, progress: async () => undefined, beat: async () => undefined, signal: new AbortController().signal, lock: () => undefined }, env.deps);
}

const APPROVED = { prep_approved: { by: "u", at: "2026-09-23T00:00:00.000Z", answers: [], waivers: [] } };

test("the prep review decides every waiver: one the agent wrote is a proposal until accepted, and a refused key is removed whoever wrote it", async () => {
  resetFixtureStore();
  const env = setup([{ n: 36, src_in: 0, src_out: 100 }]);
  try {
    const run = await createRun(env, { sheet_premise: "cast" });
    write(path.join(env.film, "scripts", "PREP-BRIEF.md"), PREP_BRIEF);
    const file = path.join(env.film, "ep36", "waivers.json");
    // An earlier review accepted one waiver; the prep adds its own beside it.
    const before = JSON.stringify({ N1_old: "accepted at the last review" });
    write(file, before);
    const [row] = await fixtureData.createRunEpisodes(sys, run.id, { series_key: "love-between-lines", episodes: [{ n: 36, src_in: 0, src_out: 100 }] });
    env.deps.launcher = new FakeClaudeLauncher(() => ({ writes: { "ep36/narration.json": JSON.stringify({ lines: [{ id: "N1", text: "x" }] }), "ep36/waivers.json": JSON.stringify({ N1_old: "accepted at the last review", N3_agent: "the agent thinks the check is wrong", N4_agent: "another" }) } }));
    const { runPrepStep, runPrepReviewStep } = await import("@/lib/segment/narrated/prep");
    const out = await runPrepStep(await directCtx(env, run), row, [row]);
    assert.equal(out.kind, "moved", JSON.stringify(out));
    assert.equal(readFileSync(file, "utf8"), before, "the file is back byte for byte: no agent waiver is in force");
    const detail = (out.kind === "moved" ? out.patch.stage_detail : {}) as { proposed_waivers: { key: string; reason: string }[] };
    assert.deepEqual(
      detail.proposed_waivers.map((w) => w.key),
      ["N3_agent", "N4_agent"]
    );
    assert.match(readFileSync(path.join(env.work, "project-writes.jsonl"), "utf8"), /wrote waivers\.json itself \(N3_agent, N4_agent\)/, "the take-back is recorded like every project write");

    // Refuse the agent's N3 and the earlier N1, accept N4 without a reason of the person's (the prep's reason stands).
    const decided = await fixtureData.appendFilmRunDecision(staff(), run.id, { action: "prep", ep: 36, boundary_s: null, data: { action: "approve", transcript_read: true, waivers: [{ key: "N3_agent", accept: false }, { key: "N1_old", accept: false }, { key: "N4_agent", accept: true }] } });
    const r = await runPrepReviewStep(await directCtx(env, decided), { ...row, words_stage: "prep_review", stage_detail: detail as unknown as Json });
    assert.equal(r.kind, "moved");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { N4_agent: "another" }, "a refused waiver is not in waivers.json after the approval, whoever wrote it");
    const approval = (r.kind === "moved" ? (r.patch.stage_detail as { prep_approved: { refused: string[]; waivers_removed: string[] } }).prep_approved : null)!;
    assert.deepEqual(approval.refused, ["N3_agent", "N1_old"]);
    assert.deepEqual(approval.waivers_removed, ["N1_old"]);
  } finally {
    teardown(env);
  }
});

test("one voice render at a time per film, and a render bills only its own episode's new ledger rows", async () => {
  resetFixtureStore();
  const env = setup([{ n: 36, src_in: 0, src_out: 100 }]);
  try {
    const run = await createRun(env, { sheet_premise: "cast", voice_id: VOICE });
    const [row] = await fixtureData.createRunEpisodes(sys, run.id, { series_key: "love-between-lines", episodes: [{ n: 36, src_in: 0, src_out: 100 }] });
    const ep = { ...row, words_stage: "voice" as const, stage_detail: APPROVED as unknown as Json };
    assert.equal(planEpisodeSteps(run, ep).find((s) => s.name === "voice")?.cls, "voice", "voice is its own class");
    assert.equal(STEP_CAPACITY.voice, 1, "one render per film: the ledger is rewritten by read-append-dump and the budget check must see the render before");
    write(path.join(env.film, "ep36", "narration.json"), JSON.stringify({ lines: [{ id: "N1", text: "Ten chars." }] }));
    // The render window also sees a row of another episode (a render outside this step): it is not this episode's bill.
    env.failScript = (step) => {
      if (step.script !== "tts_narration.py") return null;
      const mp3 = path.join(env.film, "ep36", "narration", "N1.mp3");
      write(mp3, "mp3");
      write(`${mp3}.sig`, ttsSig(VOICE, "eleven_v3", "Ten chars."));
      write(path.join(env.film, "tts_ledger.json"), JSON.stringify([{ tag: "N1", voice: VOICE, chars: 10, file: "ep36/narration/N1.mp3" }, { tag: "N4", voice: VOICE, chars: 99, file: "ep37/narration/N4.mp3" }]));
      return ok();
    };
    const { runVoiceStep } = await import("@/lib/segment/narrated/voice");
    const out = await runVoiceStep(await directCtx(env, run), ep, [ep]);
    assert.equal(out.kind, "moved", JSON.stringify(out));
    assert.equal((out.kind === "moved" ? (out.patch.stage_detail as { voice: { chars_billed_total: number } }).voice : null)?.chars_billed_total, 10);
    const credits = JSON.parse(readFileSync(path.join(env.film, "credits-ledger.json"), "utf8")) as { elevenlabs_chars: { chars: number }[] };
    assert.deepEqual(
      credits.elevenlabs_chars.map((c) => c.chars),
      [10]
    );
    const job = (await fixtureData.latestJobByTarget(sys, "film_run", run.id, "tts_line"))!;
    assert.match(job.idempotency_key, new RegExp(`^tts:${run.id}:36:N1:`));
  } finally {
    teardown(env);
  }
});

test("a picture pass that judged nothing waits for a Retry, not for a line decision; the Retry runs it again", async () => {
  resetFixtureStore();
  const env = setup([{ n: 36, src_in: 0, src_out: 100 }]);
  try {
    const run = await createRun(env, { sheet_premise: "cast", vision: "api" });
    const [row] = await fixtureData.createRunEpisodes(sys, run.id, { series_key: "love-between-lines", episodes: [{ n: 36, src_in: 0, src_out: 100 }] });
    const ep = { ...row, words_stage: "frames" as const, stage_detail: APPROVED as unknown as Json };
    const answers: PictureOutcome[] = [
      { status: "done", detail: { errors: ["ep36-N1: LlmError (api): Claude API 400: Your credit balance is too low to access the Anthropic API"] }, contradicted: [], incomplete: 2 },
      { status: "done", detail: { errors: [] }, contradicted: [], incomplete: 0 },
    ];
    let passes = 0;
    env.deps.readers = { sheets: async () => ({ status: "unavailable", reason: "-" }), frames: async () => answers[passes++], joins: async () => ({ status: "unavailable", reason: "-" }) };
    let statusRuns = 0;
    env.failScript = (step) => (step.script === "frame_claims.py" && step.args[0] === "status" && ++statusRuns <= 3 ? { ...ok("   ep36: 2 line(s) not yet checked against the picture: ['N1', 'N2'] -> ep36/review/frame_pending.json"), code: 1 } : null);
    const { runFramesStep } = await import("@/lib/segment/narrated/narration");
    const out = await runFramesStep(await directCtx(env, run), ep);
    assert.equal(out.kind, "wait");
    assert.equal(out.kind === "wait" ? out.for : null, "retry", "no line needs a decision");
    const detail = (out.kind === "wait" ? out.patch?.stage_detail : {}) as { frames: { incomplete: number; errors: string[] }; note: string };
    assert.equal(detail.frames.incomplete, 2);
    assert.match(detail.frames.errors[0], /credit balance is too low/);
    assert.match(detail.note, /no decision is due; Retry runs the check again/);

    // The words lane is planned again by a Retry about this episode, not before.
    const waiting = { ...ep, stage_detail: { ...APPROVED, waits: { words: { for: "retry", since: "", retry_after: null } }, seen: { words: 0 } } as unknown as Json };
    assert.deepEqual(
      planEpisodeSteps(run, waiting)
        .filter((s) => s.lane === "words")
        .map((s) => s.name),
      []
    );
    const retried = await decide(run.id, { action: "retry", ep: 36 });
    assert.deepEqual(
      planEpisodeSteps(retried, waiting)
        .filter((s) => s.lane === "words")
        .map((s) => s.name),
      ["frames"]
    );
    const again = await runFramesStep(await directCtx(env, retried), ep);
    assert.equal(again.kind, "moved", JSON.stringify(again));
    assert.equal(again.kind === "moved" ? again.patch.words_stage : null, "joins");
    assert.equal(passes, 2);

    // A contradiction still waits for its decision (a Retry wakes that wait too, for what the pass left); the status is read as printed.
    assert.ok(EPISODE_WAKES.line.includes("retry") && EPISODE_WAKES.join.includes("retry"));
    assert.deepEqual(statusSays("frames", "   CONTRADICTED ep36 N2: she smiles\n        frames: she frowns"), { pending: false, person: true });
    assert.deepEqual(statusSays("joins", "   ep36: 1 join(s) not yet reviewed: ['1.00-2.00'] -> ep36/review/cut_pending.json"), { pending: true, person: false });
    assert.deepEqual(statusSays("joins", "   ep36: the cut at 3:10 (1.00-2.00) loses the viewer - restore the footage, narrate the jump, or waive cut_join_1.00-2.00"), { pending: false, person: true });
  } finally {
    teardown(env);
  }
});

test("every pending line decision is applied in order: a waiver and a reword made before the step ran both land", async () => {
  resetFixtureStore();
  const env = setup([{ n: 36, src_in: 0, src_out: 100 }]);
  try {
    const run0 = await createRun(env, { sheet_premise: "cast" });
    const [row] = await fixtureData.createRunEpisodes(sys, run0.id, { series_key: "love-between-lines", episodes: [{ n: 36, src_in: 0, src_out: 100 }] });
    write(path.join(env.film, "ep36", "narration.json"), JSON.stringify({ lines: [{ id: "N3", text: "old three" }, { id: "N5", text: "old five" }] }));
    await decide(run0.id, { action: "line", ep: 36, why: "the reader misread the sign", data: { action: "waive", id: "N3" } });
    const run = await decide(run0.id, { action: "line", ep: 36, why: "match the frames", data: { action: "reword", id: "N5", text: "new five" } });
    const { runFramesStep } = await import("@/lib/segment/narrated/narration");
    const out = await runFramesStep(await directCtx(env, run), { ...row, words_stage: "frames", stage_detail: APPROVED as unknown as Json });
    assert.equal(out.kind, "moved");
    assert.equal(out.kind === "moved" ? out.patch.words_stage : null, "voice", "the reworded line re-renders");
    assert.deepEqual(JSON.parse(readFileSync(path.join(env.film, "ep36", "waivers.json"), "utf8")), { N3_frames: "the reader misread the sign" }, "the earlier waiver is written too");
    assert.equal((JSON.parse(readFileSync(path.join(env.film, "ep36", "narration.json"), "utf8")) as { lines: { text: string }[] }).lines[1].text, "new five");
    assert.equal(env.calls.filter((c) => c.script === "narr_lint.py").length, 1, "narr_lint once for the batch");
  } finally {
    teardown(env);
  }
});

test("an episode re-prepped after its picture finished builds again: its own stale picture is marked at the prep, and a build that stops on PICTURE IS STALE re-runs the picture lane", async () => {
  resetFixtureStore();
  const env = setup([{ n: 36, src_in: 0, src_out: 100 }]);
  try {
    const run = await createRun(env, { sheet_premise: "cast" });
    write(path.join(env.film, "scripts", "PREP-BRIEF.md"), PREP_BRIEF);
    const [row] = await fixtureData.createRunEpisodes(sys, run.id, { series_key: "love-between-lines", episodes: [{ n: 36, src_in: 0, src_out: 100 }] });
    // (a) The re-prep re-cut base.mp4: stale_check reads this episode's own clean as older than its cut.
    env.failScript = (step) => (step.script === "stale_check.py" ? { ...ok("STALE ep36: clean.mp4 is older than base.mp4"), code: 1 } : null);
    const reprep = { ...row, picture_stage: "ready" as const, stage: "lanes" as const };
    const { runPrepStep } = await import("@/lib/segment/narrated/prep");
    const p = await runPrepStep(await directCtx(env, run), reprep, [reprep]);
    assert.equal(p.kind, "moved", JSON.stringify(p));
    assert.equal(p.kind === "moved" ? p.patch.picture_stage : null, "stale", "the prep review's approval re-arms it");
    assert.equal(p.kind === "moved" ? p.patch.words_stage : null, "prep_review");

    // (b) A build that stops on PICTURE IS STALE goes back to the lanes with the picture lane to run, not to a Retry that stops the same way.
    const stop = "stale_check ep36\nPICTURE IS STALE - re-run the GPU chain for ep36 (see above). Nothing built.";
    env.failScript = (step) => {
      if (step.script !== "build_ep.sh") return null;
      for (const l of stop.split("\n")) step.onLine?.("stdout", l);
      return { ...ok(stop), code: 1 };
    };
    write(path.join(env.film, "ep35", "variants", "v1", "ep35.mp4"), "prior");
    write(path.join(env.film, "ep35", "variants", "v1", "ep35.mp4.gate.json"), JSON.stringify({ counts: { PASS: 1, WARN: 0, FAIL: 0 } }));
    const ready = { ...row, words_stage: "ready" as const, picture_stage: "ready" as const, stage: "build" as const, stage_detail: APPROVED as unknown as Json };
    const { runBuildStep } = await import("@/lib/segment/narrated/build");
    const b = await runBuildStep(await directCtx(env, run), ready, [ready]);
    assert.equal(b.kind, "moved", JSON.stringify(b));
    assert.deepEqual(b.kind === "moved" ? [b.patch.stage, b.patch.picture_stage] : null, ["lanes", "stale"]);
    assert.match(JSON.stringify(b.kind === "moved" ? b.patch.stage_detail : null), /PICTURE IS STALE/);
    assert.deepEqual(
      planEpisodeSteps(run, { ...ready, stage: "lanes", picture_stage: "stale" }).map((s) => s.name),
      ["picture"]
    );
  } finally {
    teardown(env);
  }
});

test("an edit of the episode windows made while the writing slot is busy is kept and made when the slot frees", async () => {
  resetFixtureStore();
  const env = setup([{ n: 36, src_in: 140, src_out: 392 }]);
  try {
    let run = await createRun(env, { sheet_premise: "cast" });
    // A folder an earlier Studio run of this source made, indexed and sheet-read already.
    write(path.join(env.film, ".studio-scripts.json"), JSON.stringify({ sha: "c".repeat(40), files: [] }));
    for (const f of ["audio16k.wav", "scdet.txt", "captions_zh.json", "lyric_cues.json"]) write(path.join(env.film, "index", f), "x");
    write(path.join(env.film, "index", "whisper.json"), JSON.stringify({ duration: DURATION, segments: [] }));
    for (let m = 0; m < 10; m++) write(path.join(env.film, "index", "sheets", `min-${m}.png`), "p");
    write(path.join(env.film, "index", "sheet_read_0_9.json"), "[]");
    run = await drive(env, run.id);
    assert.equal(waitingFor(run), "script", run.error_text ?? JSON.stringify(run.stage_detail));
    await decide(run.id, { action: "script", data: { action: "approve" } });
    run = await drive(env, run.id);
    assert.equal(waitingFor(run), "episodes");
    const calls = env.launcher.calls.length;

    // Another run's prep holds the machine's writing slot.
    const held = takeWritingLock({ root: env.work, holder: "another-run/ep12", what: "prep of ep12 (another run)" });
    try {
      await decide(run.id, { action: "episodes", why: "split ep36 at 260 s", data: { action: "edit" } });
      run = await drive(env, run.id);
      assert.equal(waitingFor(run), "session");
      const busy = (run.stage_detail as { session: { status: string; continuation: string } }).session;
      assert.equal(busy.status, "busy");
      assert.match(busy.continuation, /split ep36 at 260 s/, "the note waits on the record");
      assert.equal(env.launcher.calls.length, calls, "nothing started");
    } finally {
      held.release();
    }
    // The slot frees; the Retry (or the minute's poll) makes the edit — it is not dropped for the old plan.
    await decide(run.id, { action: "retry" });
    run = await drive(env, run.id);
    assert.equal(waitingFor(run), "episodes", JSON.stringify(run.stage_detail));
    const last = env.launcher.calls[env.launcher.calls.length - 1];
    assert.equal(last.kind, "resume", "the script session is resumed");
    assert.match(last.req.prompt, /The episode windows need changing: split ep36 at 260 s/);
    assert.equal((run.stage_detail as { session: { status: string } }).session.status, "done");
    await decide(run.id, { action: "episodes", data: { action: "approve" } });
    run = await drive(env, run.id);
    assert.equal(run.stage, "episode_work", "the plan as it now is is approved");
  } finally {
    teardown(env);
  }
});

test("the smaller rules: only the last open episode can be dropped, a season number a prior project holds waits at the intake, a reframe override is a heavy step", () => {
  assert.match(dropRefusal({ n: 36 }, [{ n: 36, stage: "ep_review" }, { n: 37, stage: "lanes" }]) ?? "", /ep36 cannot be dropped while ep37 stays in the plan/);
  assert.equal(dropRefusal({ n: 37 }, [{ n: 36, stage: "ep_review" }, { n: 37, stage: "ep_review" }]), null);
  assert.equal(dropRefusal({ n: 36 }, [{ n: 36, stage: "ep_review" }, { n: 37, stage: "dropped" }]), null);

  const projects = mkdtempSync(path.join(tmpdir(), "studio-season-"));
  try {
    for (let n = 26; n <= 35; n++) mkdirSync(path.join(projects, "lbl-e04", `ep${n}`), { recursive: true });
    mkdirSync(path.join(projects, "lbl-e03", "ep20"), { recursive: true });
    assert.match(firstNumberRefusal(projects, ["lbl-e03", "lbl-e04"], 30) ?? "", /first_episode_n is 30, but lbl-e04 already holds ep35: the numbers continue at 36/);
    assert.equal(firstNumberRefusal(projects, ["lbl-e03", "lbl-e04"], 36), null);
  } finally {
    rmSync(projects, { recursive: true, force: true });
  }

  const glance = { id: "e", run_id: "r", n: 36, stage: "lanes", words_stage: "joins", picture_stage: "reframe_glance", stage_detail: APPROVED } as unknown as Parameters<typeof planEpisodeSteps>[1];
  const d = (data: Json): FilmRunDecision => ({ at: "", by: "x", action: "reframe", ep: 36, boundary_s: null, data });
  assert.equal(planEpisodeSteps({ decisions: [d({ action: "override", box: [2] })] }, glance).find((s) => s.name === "reframe_glance")?.cls, "heavy", "the GPU re-run never runs beside the run's own picture or build step");
  assert.equal(planEpisodeSteps({ decisions: [d({ action: "accept" })] }, glance).find((s) => s.name === "reframe_glance")?.cls, "light");
});
