// The fixture's fake pipeline (STUDIO_FAKE_PIPELINE=1): every cut-only
// script the stages call, stood in by plausible artifacts derived from the
// checked-in fixture film (tests/fixtures/workspace/low-quality/fixture-film),
// so the whole run — intake to import — goes through in the e2e server and
// the worker test without Python, ffmpeg or a model key. It writes the same
// files at the same paths the real scripts write, keeps the two rules that
// matter for the review (apply_vision.py's three rules via lib/segment/vision
// applyVision, boundary_frames.py --verify via verifyOptions), refuses what
// the real scripts refuse where a stage relies on it (no watermark box
// without --no-delogo, an existing box without --force), and judges from a
// table: one boundary the pass is sure of, one it is not (a low confidence
// and a skeptic override), so the review has something to decide.
//
// The film it makes is 15 s long with a 4–6 s band (the fixture's plan), a
// stand-in for a two-hour film with the 95–150 s band; the stages pass the
// run's own band flags and the fake reads them when given.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { VideoFacts } from "@/lib/film-import/import";
import type { RunResult } from "@/lib/python";
import type { SyncResult } from "@/lib/segment/scripts-sync";
import { OptionsDocSchema, verifyOptions, type OptionsDoc } from "@/lib/segment/strips";
import { WorkflowOutputSchema, applyVision, type BandFixResult, type JudgeResult, type JudgeUnavailable, type WorkflowRecord } from "@/lib/segment/vision";
import type { BandFixRequest, JudgeRequest, PipelineRunner, RunnerContext, ScriptStep } from "./stages";

/** The fixture film the fake derives its index and episode files from. */
export function fixtureFilmDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.STUDIO_FAKE_FIXTURE_FILM?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), "tests", "fixtures", "workspace", "low-quality", "fixture-film");
}

export const FAKE_SHA = "f".repeat(40);
const FAKE_DURATION = 15;
const FAKE_BAND: [number, number] = [4, 6];
const FAKE_FPS = 30;

/** The fake's legal cuts: shot changes clear of the fixture transcript's words. */
const FAKE_CANDIDATES = [
  { t: 3.5, line_before: "Where is she?", line_after: "She is gone.", line_before_end: 1.6, line_after_start: 4.4 },
  { t: 4.0, line_before: "Where is she?", line_after: "She is gone.", line_before_end: 1.6, line_after_start: 4.4 },
  { t: 8.5, line_before: "You knew.", line_after: "I did not.", line_before_end: 8.1, line_after_start: 9.5 },
  { t: 9.0, line_before: "You knew.", line_after: "I did not.", line_before_end: 8.1, line_after_start: 9.5 },
  { t: 9.2, line_before: "You knew.", line_after: "I did not.", line_before_end: 8.1, line_after_start: 9.5 },
  { t: 12.0, line_before: "I did not.", line_after: "Run.", line_before_end: 10.4, line_after_start: 13.2 },
];
/** The DP's preferred picks: episodes of 4, 5 and 6 s over the whole film. */
const FAKE_DP = [4.0, 9.0];

/**
 * The fake's DP: a chain of legal cuts from `from` (the last pinned end) to
 * `duration` with every episode in band, FAKE_DP's picks preferred, so a
 * first proof (`--duration 9` → [4]) and its extension (`--pin-from` the
 * delivered 0–9 → [9]) come out as the real pick_cuts would; null when no
 * partition exists (the real script's refusal).
 */
export function fakeBoundaries(from: number, duration: number, band: [number, number]): number[] | null {
  const times = FAKE_CANDIDATES.map((c) => c.t).filter((t) => t > from + 1e-9 && t < duration - 1e-9);
  const ordered = [...times.filter((t) => FAKE_DP.includes(t)), ...times.filter((t) => !FAKE_DP.includes(t))];
  const inBand = (len: number) => len >= band[0] - 1e-9 && len <= band[1] + 1e-9;
  const walk = (prev: number): number[] | null => {
    if (inBand(duration - prev)) return [];
    for (const t of ordered) {
      if (t <= prev || !inBand(t - prev)) continue;
      const rest = walk(t);
      if (rest) return [t, ...rest];
    }
    return null;
  };
  return walk(from);
}

/** The delivered plan `--pin-from` names: its pinned ends (every end but the last, unless `final_end_is_boundary`) and the last pin. */
function pinsFrom(cut: string, pinFrom: string | null): { ends: number[]; last: number } {
  if (!pinFrom) return { ends: [], last: 0 };
  const plan = readJson<{ episodes?: { end: number }[]; final_end_is_boundary?: boolean }>(path.join(cut, pinFrom));
  const eps = plan?.episodes ?? [];
  const pinned = plan?.final_end_is_boundary ? eps : eps.slice(0, -1);
  const ends = pinned.map((e) => e.end);
  return { ends, last: ends.length ? Math.max(...ends) : 0 };
}

// ---- a PNG big enough for --verify's "not empty" rule ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A flat grey `w`×`h` RGB PNG whose bytes carry `seed` (so two strips differ); a few KB. */
export function fakePng(w: number, h: number, seed = 0): Buffer {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = (seed * 37 + x * 5) & 0xff;
    row[2 + x * 3] = (seed * 11 + x * 3) & 0xff;
    row[3 + x * 3] = (seed * 7 + x) & 0xff;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---- the runner ---------------------------------------------------------------------------------------------------------

type Say = (stream: "stdout" | "stderr", line: string) => void;

function result(code: number, out: string[], err: string[] = [], started = Date.now()): RunResult {
  return { code, signal: null, stdout: "", stdoutTail: out.join("\n") + (out.length ? "\n" : ""), stderrTail: err.join("\n") + (err.length ? "\n" : ""), durationMs: Date.now() - started, timedOut: false, cancelled: false };
}

function arg(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`, "utf8");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** cuts.json from boundary times: episodes between 0, the boundaries and the duration, with the pipeline's fields. */
function planFrom(boundaries: number[], opts: { duration: number; band: [number, number]; target: number; pinFrom: string | null; pinned?: number; moves: { from: number; to: number }[]; skips?: [number, number][] }) {
  const points = [0, ...boundaries.slice().sort((a, b) => a - b), opts.duration];
  const whisper = { segments: [] as { start: number; text: string }[] };
  const episodes = points.slice(1).map((end, i) => {
    const start = points[i];
    const before = whisper.segments.filter((s) => s.start < end).pop();
    const after = whisper.segments.find((s) => s.start >= end);
    return { n: i + 1, start: round3(start), end: round3(end), dur: Math.round((end - start) * 100) / 100, ends_after_line: before?.text ?? "", next_opens_on: after?.text ?? "" };
  });
  return {
    source_duration: opts.duration,
    target: opts.target,
    fps: FAKE_FPS,
    band: opts.band,
    pinned: opts.pinned ?? 0,
    pin_from: opts.pinFrom,
    moves: opts.moves,
    final_end_is_boundary: false,
    ...(opts.skips?.length ? { skips: opts.skips.map(([s, e]) => ({ start: s, end: e })) } : {}),
    episodes,
  };
}

function bandOf(args: string[]): [number, number] {
  const lo = arg(args, "--min");
  const hi = arg(args, "--max");
  return lo && hi ? [Number(lo), Number(hi)] : FAKE_BAND;
}

export class FakePipelineRunner implements PipelineRunner {
  readonly fake = true;
  private readonly fixture: string;
  private readonly delayMs: number;

  constructor(opts: { fixtureFilm?: string; delayMs?: number } = {}) {
    this.fixture = opts.fixtureFilm ?? fixtureFilmDir();
    this.delayMs = opts.delayMs ?? 20;
  }

  private async pause(): Promise<void> {
    if (this.delayMs > 0) await new Promise<void>((r) => setTimeout(r, this.delayMs));
  }

  async probe(file: string): Promise<VideoFacts | null> {
    if (!existsSync(file)) return null;
    const landscape = /landscape/i.test(path.basename(file));
    return { width: landscape ? 1280 : 720, height: landscape ? 720 : 1280, fps: FAKE_FPS, frames: FAKE_DURATION * FAKE_FPS, duration_s: FAKE_DURATION };
  }

  sync(cutDir: string, _opts: { allowDirty: boolean }): SyncResult {
    const scripts = path.join(cutDir, "scripts");
    mkdirSync(scripts, { recursive: true });
    const files = [".route", "README.md", "apply_vision.py", "boundary_frames.py", "candidates.py", "cards.py", "checks.py", "cut_episodes.py", "index_cut.sh", "motion.py", "pick_by_eye.workflow.js", "pick_cuts.py", "qa_episodes.py", "unmark.py", "watermark.py"];
    for (const f of files) writeFileSync(path.join(scripts, f), f === ".route" ? "cut-only\n" : `# fake ${f} (STUDIO_FAKE_PIPELINE)\n`, "utf8");
    const record = { sha: FAKE_SHA, dirty: false, dirty_paths: [], synced_at: new Date().toISOString(), files, source: "fake-pipeline" };
    writeJson(path.join(cutDir, ".studio-scripts.json"), record);
    return { ...record, scripts_dir: scripts, record_file: path.join(cutDir, ".studio-scripts.json") };
  }

  async proxy(src: string, _at: number, out: string): Promise<void> {
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(src, `${out}.part`);
    renameSync(`${out}.part`, out);
  }

  /** The fake's join proxy is the first episode's bytes (4 s of fixture film); the real runner joins the last 2 s of one to the first 2 s of the next. */
  async joinProxy(before: string, _after: string, out: string): Promise<void> {
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(before, `${out}.part`);
    renameSync(`${out}.part`, out);
  }

  /** The table: boundary 1 is sure; boundary 2 is low confidence and the skeptic names a better time. A re-judge (attempt > 1) is sure. */
  async judge(req: JudgeRequest): Promise<JudgeResult | JudgeUnavailable> {
    const attempt = req.opts.attempt ?? 1;
    const records: WorkflowRecord[] = [];
    const wanted = req.opts.boundaries ?? req.doc.boundaries.map((b) => b.boundary_s);
    for (const [i, b] of req.doc.boundaries.entries()) {
      if (!wanted.some((w) => Math.abs(w - b.boundary_s) <= 0.0015)) continue;
      const dp = b.options.find((o) => o.is_dp_pick) ?? b.options[0];
      const sure = i === 0 || attempt > 1;
      const better = b.options.find((o) => o.t > dp.t) ?? null;
      records.push({
        boundary_s: b.boundary_s,
        pick: { chosen_key: dp.key, chosen_t: dp.t, ends_on: "A close-up, the line lands.", opens_on: "A wide shot of the next room.", why: sure ? "The payoff is inside the episode and the next opens clean." : "Two options look alike at this size.", rejected: "the earlier option cuts before the payoff", payoff_in_episode: true, confidence: sure ? 0.9 : 0.55 },
        verdict: sure || !better ? { agree: true, fault: "", better_key: "", reason: "Checked every strip; the pick holds." } : { agree: false, fault: "rule 4: the aftermath is cut short", better_key: better.key, better_t: better.t, reason: `${better.t}s leaves the reaction in the episode.` },
      });
      req.opts.onBoundary?.(records[records.length - 1], records.length, wanted.length);
      await this.pause();
    }
    const outFile = req.opts.out_file ?? path.join(req.run.cut_dir, "review", "vision", `${req.opts.label}.json`);
    const output = { summary: "fake vision pass", source: "pulsar-studio-fake", rule_version: "fake", provider: "fake", model: "fake-vision", run_id: req.run.id, label: req.opts.label, attempt, logs: [`${records.length} boundaries judged by the fake`], result: records, errors: [], retries: [], jobs: [], cost_cents: 0, totalTokens: 0 };
    WorkflowOutputSchema.parse(output);
    writeJson(outFile, output);
    return { file: outFile, output, records, errors: [], retries: [], jobs: [], cost_cents: 0, provider: "deepseek", model: "fake-vision" };
  }

  async bandFix(_req: BandFixRequest): Promise<BandFixResult | JudgeUnavailable> {
    return { unavailable: "the fake pipeline has no band-fix judge: move a boundary of the group" };
  }

  async run(step: ScriptStep, ctx: RunnerContext): Promise<RunResult> {
    const started = Date.now();
    const out: string[] = [];
    const err: string[] = [];
    const say: Say = (stream, line) => {
      (stream === "stdout" ? out : err).push(line);
      step.onLine?.(stream, line);
    };
    await this.pause();
    if (ctx.signal.aborted) return { ...result(null as unknown as number, out, err, started), code: null, cancelled: true };
    const cut = ctx.cutDir;
    try {
      const code = this.dispatch(step, cut, say);
      return result(code, out, err, started);
    } catch (e) {
      say("stderr", `Traceback: ${(e as Error).message}`);
      return result(2, out, err, started);
    }
  }

  private dispatch(step: ScriptStep, cut: string, say: Say): number {
    const a = step.args;
    const index = (name: string) => path.join(cut, "index", name);
    const review = (name: string) => path.join(cut, "review", name);
    switch (step.script) {
      case "checks.py":
        say("stdout", "=== is this the copy that runs? (2026-09-22) ===");
        say("stdout", "     in sync with the canonical skill copy (fake)");
        return 0;

      case "watermark.py": {
        if (!a.includes("--detect")) {
          say("stderr", "nothing to do: pass --detect and/or --strip");
          return 1;
        }
        const box = index("watermark.json");
        if (existsSync(box) && !a.includes("--force")) {
          say("stderr", `REFUSED: ${"index/watermark.json"} exists and delivered episodes used it. Detect to another --box to compare, or pass --force to replace it.`);
          return 1;
        }
        const region = arg(a, "--region") ?? "0,0,0.5,0.25";
        writeJson(box, { source: "original.mp4", video: { w: 720, h: 1280 }, box: { x: 18, y: 28, w: 94, h: 89 }, frames_sampled: 60, threshold: 152, presence: 0.35, pct: 99, merge_gap: 50, region, note: "fake detector", parts: 2 });
        writeFileSync(index("watermark-found.png"), fakePng(240, 120, 1));
        writeFileSync(index("watermark-median.png"), fakePng(120, 120, 2));
        say("stdout", `box x=18 y=28 w=94 h=89 (region ${region}) -> index/watermark.json`);
        return 0;
      }

      case "unmark.py": {
        mkdirSync(index("unmark"), { recursive: true });
        if (a.includes("--find")) {
          writeFileSync(index("unmark-found.png"), fakePng(200, 100, 3));
          say("stdout", 'boxes: "300,500,120,40;300,900,120,40"');
          return 0;
        }
        if (a.includes("--fit")) {
          const boxes = arg(a, "--boxes");
          if (!boxes) {
            say("stderr", "--fit needs --boxes");
            return 1;
          }
          if (existsSync(index("unmark/mark_model.json")) && !a.includes("--force")) {
            say("stderr", "REFUSED: index/unmark/ exists; pass --force to refit");
            return 1;
          }
          writeJson(index("unmark/mark_model.json"), { boxes, fitted: "fake", size: [720, 1280] });
          say("stdout", `fitted ${boxes.split(";").length} marks -> index/unmark/`);
          return 0;
        }
        if (a.includes("--test")) {
          writeFileSync(index("unmark-test.png"), fakePng(200, 100, 4));
          say("stdout", "PASS - luma and chroma, every band under 2.5 levels");
          return 0;
        }
        if (a.includes("--edge-fill")) {
          writeJson(index("unmark/edge_fill.json"), { columns: 12 });
          say("stdout", "edge fill: 12 columns rebuilt");
          return 0;
        }
        say("stderr", "nothing to do");
        return 1;
      }

      case "index_cut.sh": {
        if (a.includes("--from")) {
          say("stderr", "index_cut.sh: --from refused - it would give segment-relative times. Re-index from 0 with --to.");
          return 1;
        }
        mkdirSync(index(""), { recursive: true });
        // `--to` cuts the audio: the transcript covers that much (a first proof); the source facts are the whole film's.
        const to = Math.min(Number(arg(a, "--to") ?? FAKE_DURATION) || FAKE_DURATION, FAKE_DURATION);
        if (existsSync(index("whisper.json"))) say("stdout", "== previous index kept in index/prev-fake");
        writeJson(index("source.json"), { source: "../source/original.mp4", fps: FAKE_FPS, width: 720, height: 1280, duration: FAKE_DURATION });
        say("stdout", "== source facts");
        say("stdout", `== source ../source/original.mp4  from 0s${to < FAKE_DURATION ? ` to ${to}s` : ""}`);
        say("stdout", "== audio 00:00:00");
        writeFileSync(index("scdet.txt"), ["2.0", "3.5", "4.0", "6.5", "8.5", "9.0", "9.2", "12.0"].filter((t) => Number(t) < to).join("\n") + "\n", "utf8");
        say("stdout", "== scdet 00:00:01");
        say("stdout", "   8 shot cuts");
        say("stdout", "== whisper 00:00:01");
        const whisper = readJson<{ duration?: number; segments?: { start: number }[] }>(path.join(this.fixture, "cut", "index", "whisper.json")) ?? {};
        writeJson(index("whisper.json"), { ...whisper, duration: to, segments: (whisper.segments ?? []).filter((s) => s.start < to) });
        writeFileSync(index("whisper.log"), ["faster-whisper medium, 2 threads", "  25%  3.8s", "  50%  7.5s", ` 100% ${to.toFixed(1)}s`, "5 segments -> index/whisper.json"].join("\n") + "\n", "utf8");
        say("stdout", "5 segments -> index/whisper.json");
        say("stdout", "INDEX DONE 00:00:02");
        return 0;
      }

      case "motion.py": {
        const motion = readJson<Record<string, unknown>>(path.join(this.fixture, "cut", "index", "motion.json")) ?? {};
        writeJson(index("motion.json"), { ...motion, from: 0, to: Number(arg(a, "--to") ?? 0) || 0 });
        say("stdout", "3 beats -> index/motion.json");
        return 0;
      }

      case "candidates.py": {
        const fixture = readJson<Record<string, unknown>>(path.join(this.fixture, "cut", "index", "candidates.json")) ?? {};
        writeJson(index("candidates.json"), {
          ...fixture,
          shot_cuts: 8,
          legal: FAKE_CANDIDATES.length,
          candidates: FAKE_CANDIDATES.map((c) => ({ t: c.t, in_action: false, motion: 2, since_action: 1, until_action: 5, action_energy: 0, gap_before: round3(c.t - c.line_before_end), gap_after: round3(c.line_after_start - c.t), settle: 1.5, line_before: c.line_before, line_after: c.line_after, line_before_end: c.line_before_end, line_after_start: c.line_after_start, exception: null })),
        });
        say("stdout", `${FAKE_CANDIDATES.length} legal cuts of 8 -> index/candidates.json`);
        return 0;
      }

      case "cards.py": {
        if (a.includes("--plan")) {
          const skips = readJson<{ skips: { start: number; end: number }[] }>(index("skips.json"));
          if (!skips) {
            say("stderr", "no index/skips.json: run --templates first");
            return 1;
          }
          const ends = skips.skips.map((s) => s.start);
          writeJson(path.join(cut, "cuts.json"), planFrom(ends, { duration: FAKE_DURATION, band: FAKE_BAND, target: 0, pinFrom: null, moves: [], skips: skips.skips.map((s) => [s.start, s.end] as [number, number]) }));
          say("stdout", `${ends.length + 1} episodes from ${ends.length} cards -> cuts.json`);
          return 0;
        }
        const templates = arg(a, "--templates");
        if (!templates) {
          say("stderr", "--templates: give one source time per card lettering style, with the text fully on screen");
          return 1;
        }
        writeJson(index("skips.json"), { skips: [{ start: 13.0, end: 14.0, text_from: 13.1, text_to: 13.9 }], fps: 10, band: "0.80,1.0,0.42,0.90", templates, min_score: 0.5 });
        writeFileSync(index("skips-evidence.png"), fakePng(240, 80, 5));
        say("stdout", "1 cards, 1.0 s to trim -> index/skips.json");
        return 0;
      }

      case "pick_cuts.py": {
        const band = bandOf(a);
        const target = Number(arg(a, "--target") ?? 5);
        const duration = Number(arg(a, "--duration") ?? FAKE_DURATION);
        mkdirSync(path.join(cut, "review"), { recursive: true });
        const delivered = readdirSync(path.join(cut, "review")).filter((n) => /^cuts-0-.*-DELIVERED\.json$/.test(n)).sort();
        const pinFrom = arg(a, "--pin-from");
        if (delivered.length && !pinFrom && !a.includes("--no-pin")) {
          say("stderr", `REFUSED: this film has delivered cuts (review/${delivered[delivered.length - 1]}). Add\n  --pin-from review/${delivered[delivered.length - 1]}\nto every pick_cuts.py call.`);
          return 1;
        }
        const pins = pinsFrom(cut, pinFrom);
        const open = fakeBoundaries(pins.last, duration, band);
        const emit = arg(a, "--emit-options");
        if (emit) {
          if (!open) {
            say("stderr", `no partition of ${duration}s into episodes of ${band[0]}-${band[1]}s exists over ${FAKE_CANDIDATES.length} legal boundaries. Widen --min/--max or lower --min-clear.`);
            return 1;
          }
          if (pinFrom) say("stdout", `pinned ${pins.ends.length} delivered boundaries from ${pinFrom}; its final end is re-planned`);
          const boundaries = open.map((t) => ({
            boundary_s: t,
            dp_pick: t,
            before: [{ t: t - 2, text: FAKE_CANDIDATES.find((c) => c.t === t)?.line_before ?? "" }],
            after: [{ t: t + 1, text: FAKE_CANDIDATES.find((c) => c.t === t)?.line_after ?? "" }],
            options: FAKE_CANDIDATES.filter((c) => Math.abs(c.t - t) <= 1).map((c, i) => ({ key: `opt${i + 1}`, t: c.t, in_action: false, since_action: 1, until_action: 5, line_before: c.line_before, line_after: c.line_after, is_dp_pick: c.t === t })),
          }));
          writeJson(path.join(cut, emit), { duration, band, strips_stale: true, boundaries });
          say("stdout", `${boundaries.length} boundaries, ${boundaries.reduce((s, b) => s + b.options.length, 0)} options -> ${emit}`);
          say("stdout", "  STRIPS ARE STALE: run boundary_frames.py --options before any visual pass");
          return 0;
        }
        const repins = a.flatMap((x, i) => (x === "--repin" ? [a[i + 1]] : []));
        if (repins.length) {
          const plan = readJson<ReturnType<typeof planFrom>>(path.join(cut, "cuts.json"));
          if (!plan) {
            say("stderr", "no cuts.json to repin");
            return 1;
          }
          const moves = repins.map((r) => {
            const [from, to] = r.split("=").map(Number);
            return { from, to };
          });
          let ends = plan.episodes.slice(0, -1).map((e) => e.end);
          for (const m of moves) ends = ends.map((e) => (Math.abs(e - m.from) <= 0.0015 ? m.to : e));
          writeJson(path.join(cut, "cuts.json"), planFrom(ends, { duration, band, target, pinFrom, moves: [...plan.moves, ...moves] }));
          for (const m of moves) say("stdout", `  ${m.from.toFixed(1)}s -> ${m.to.toFixed(1)}s  (repin)`);
          say("stdout", `${ends.length + 1} episodes -> cuts.json`);
          return 0;
        }
        const choicesFile = arg(a, "--choices");
        if (!choicesFile) {
          say("stderr", "the fake pick_cuts needs --emit-options, --choices or --repin");
          return 1;
        }
        const choices = readJson<Record<string, number>>(path.join(cut, choicesFile));
        if (!choices) {
          say("stderr", `REFUSED: ${choicesFile} is missing`);
          return 1;
        }
        if (!open) {
          say("stderr", `no partition of ${duration}s into episodes of ${band[0]}-${band[1]}s exists over ${FAKE_CANDIDATES.length} legal boundaries.`);
          return 1;
        }
        // Every key must name an OPEN boundary of this partition (a pinned one is settled), and every open boundary needs a choice.
        const stray = Object.keys(choices).filter((k) => !open.some((t) => Math.abs(Number(k) - t) <= 0.001));
        const unreviewed = open.filter((t) => !Object.keys(choices).some((k) => Math.abs(Number(k) - t) <= 0.001));
        if (stray.length || unreviewed.length) {
          say("stderr", `REFUSED: ${choicesFile} does not match this partition.\n  keys naming no open boundary (stale file?): ${JSON.stringify(stray)}\n  open boundaries with no reviewed choice:    ${JSON.stringify(unreviewed)}`);
          return 1;
        }
        for (const [k, v] of Object.entries(choices)) if (!FAKE_CANDIDATES.some((c) => Math.abs(c.t - v) <= 0.05)) {
          say("stderr", `choice ${v}s for boundary ${k}s is not a legal candidate`);
          return 1;
        }
        const ends = [...pins.ends, ...Object.values(choices)].map(round3);
        const plan = planFrom(ends, { duration, band, target, pinFrom, pinned: pins.ends.length, moves: [] });
        const off = plan.episodes.filter((e) => e.dur < band[0] - 1e-9 || e.dur > band[1] + 1e-9).map((e) => `ep${e.n}: ${e.dur}s`);
        say("stdout", `applied ${ends.length} visual choices`);
        if (off.length) {
          say("stderr", `FAIL: episodes outside the ${band[0]}-${band[1]}s band after choices: ${JSON.stringify(off)}`);
          return 1;
        }
        if (a.includes("--dry-run")) {
          writeJson(path.join(cut, "work", "dry-run.json"), plan);
          say("stdout", `${plan.episodes.length} episodes, ${Math.min(...plan.episodes.map((e) => e.dur))}-${Math.max(...plan.episodes.map((e) => e.dur))}s -> work/dry-run.json (dry run)`);
          return 0;
        }
        writeJson(path.join(cut, "cuts.json"), plan);
        say("stdout", `${plan.episodes.length} episodes, ${Math.min(...plan.episodes.map((e) => e.dur))}-${Math.max(...plan.episodes.map((e) => e.dur))}s -> cuts.json`);
        return 0;
      }

      case "boundary_frames.py": {
        const verify = arg(a, "--verify");
        if (verify) {
          const doc = readJson(path.join(cut, verify));
          const parsed = OptionsDocSchema.safeParse(doc);
          if (!parsed.success) {
            say("stdout", `NOT READY - ${verify} is not an options document`);
            return 1;
          }
          // The same checks the real --verify makes (lib/segment/strips.ts), run synchronously here through a cached answer.
          const faults = verifySync(cut, parsed.data);
          if (faults.length) {
            say("stdout", `NOT READY - ${faults.length} fault(s) across ${parsed.data.boundaries.reduce((s, b) => s + b.options.length, 0)} options:`);
            for (const f of faults) say("stdout", `  ${f}`);
            return 1;
          }
          say("stdout", `READY - ${parsed.data.boundaries.reduce((s, b) => s + b.options.length, 0)} options across ${parsed.data.boundaries.length} boundaries, every strip current`);
          say("stdout", `boundaries for the vision pass: ${JSON.stringify(parsed.data.boundaries.map((b) => b.boundary_s))}`);
          return 0;
        }
        const options = arg(a, "--options");
        if (options) {
          const file = path.join(cut, options);
          const doc = readJson<OptionsDoc>(file);
          if (!doc) {
            say("stderr", `${options}: not found`);
            return 1;
          }
          const outDir = arg(a, "--out-dir") ?? "review/frames";
          mkdirSync(path.join(cut, outDir), { recursive: true });
          let n = 0;
          for (const b of doc.boundaries) {
            for (const o of b.options) {
              const name = `b${Math.round(b.boundary_s)}_${o.key}`;
              const png = path.join(cut, outDir, `${name}.png`);
              const tiles = Array.from({ length: 11 }, (_, i) => round3(o.t - 2.5 + i * 0.5));
              writeFileSync(png, fakePng(6 * 40, 2 * 70, n + 10));
              writeJson(path.join(cut, outDir, `${name}.json`), { source: "../source/original.mp4", from: tiles[0], to: tiles[tiles.length - 1], step: 0.5, cols: 6, rows: 2, tiles_in_reading_order: tiles });
              o.strip = `${outDir}/${name}.png`;
              o.strip_tiles = tiles;
              n += 1;
              say("stdout", `  ${o.strip}  centre ${o.t.toFixed(1)}s`);
            }
          }
          doc.strips_stale = false;
          doc.strip = { window: 5, step: 0.5, cols: 6 };
          writeJson(file, doc);
          say("stdout", `${n} option strips -> ${outDir}, paths written back into ${options}`);
          return 0;
        }
        // A single dense strip (--at … --out …), as renderDenseStrip asks.
        const outFile = arg(a, "--out");
        const at = Number(arg(a, "--at") ?? 0);
        if (outFile) {
          const tiles = Array.from({ length: 31 }, (_, i) => round3(at - 1.5 + i * 0.1));
          writeFileSync(outFile, fakePng(10 * 30, 4 * 40, 99));
          writeJson(outFile.replace(/\.png$/i, ".json"), { source: "../source/original.mp4", from: tiles[0], to: tiles[tiles.length - 1], step: 0.1, cols: 10, rows: 4, tiles_in_reading_order: tiles });
          say("stdout", `${outFile}  31 tiles`);
          return 0;
        }
        say("stderr", "the fake boundary_frames needs --options, --verify or --at/--out");
        return 1;
      }

      case "apply_vision.py": {
        const sources = a.flatMap((x, i) => (x === "--from" ? [a[i + 1]] : []));
        const label = arg(a, "--label") ?? "run";
        const outFile = path.join(cut, "review", "choices.json");
        if (existsSync(outFile)) renameSync(outFile, outFile.replace(/\.json$/, ".prev.json"));
        const passes: WorkflowRecord[][] = [];
        for (const s of sources) {
          const raw = readJson<unknown>(path.join(cut, s));
          const parsed = WorkflowOutputSchema.safeParse(raw);
          if (!parsed.success) {
            say("stderr", `${s}: expected a list of boundary records (or an object with 'result')`);
            return 1;
          }
          passes.push(parsed.data.result);
        }
        const applied = applyVision(...passes);
        const stamp = new Date().toISOString().slice(0, 10);
        const auditDir = path.join(cut, "review", "vision");
        mkdirSync(auditDir, { recursive: true });
        let audit = path.join(auditDir, `${stamp}_${label}.json`);
        let n = 1;
        while (existsSync(audit)) {
          n += 1;
          audit = path.join(auditDir, `${stamp}_${label}_${n}.json`);
        }
        if (sources.length === 1) copyFileSync(path.join(cut, sources[0]), audit);
        else writeJson(audit, { sources, result: passes.flat() });
        say("stdout", " boundary  reviewer   applied  source            conf");
        for (const r of applied.rows) say("stdout", `${r.boundary_s.toFixed(2).padStart(9)} ${r.reviewer_t.toFixed(2).padStart(9)} ${r.applied_t.toFixed(2).padStart(9)}  ${r.source.padEnd(17)} ${r.confidence.toFixed(2)}`);
        say("stdout", "");
        say("stdout", `audit copy -> ${path.relative(cut, audit).replace(/\\/g, "/")}`);
        if (applied.faults.length) {
          say("stdout", "");
          say("stdout", "FAIL - these boundaries have no usable answer; choices.json NOT written:");
          for (const f of applied.faults) say("stdout", `  ${f}`);
          return 1;
        }
        writeJson(outFile, applied.choices);
        say("stdout", `${Object.keys(applied.choices).length} choices -> review/choices.json`);
        const optionsFile = path.join(cut, arg(a, "--options") ?? "review/options.json");
        const doc = readJson<Record<string, unknown>>(optionsFile);
        if (doc) {
          doc.applied = { label, on: stamp, audit: path.relative(cut, audit).replace(/\\/g, "/") };
          writeJson(optionsFile, doc);
          say("stdout", "review/options.json stamped as applied - it cannot be sent to a vision pass again");
        }
        return 0;
      }

      case "cut_episodes.py": {
        const plan = readJson<ReturnType<typeof planFrom>>(path.join(cut, "cuts.json"));
        if (!plan) {
          say("stderr", "no cuts.json");
          return 1;
        }
        const refuse: string[] = [];
        if (!a.includes("--no-delogo") && !existsSync(index("watermark.json"))) refuse.push("no index/watermark.json - run watermark.py --detect, or pass --no-delogo if the film has no logo");
        if (refuse.length) {
          say("stdout", "REFUSED - nothing rendered:");
          for (const r of refuse) say("stdout", `  ${r}`);
          return 1;
        }
        const eps = path.join(cut, "eps");
        mkdirSync(eps, { recursive: true });
        const fixtureEps = readdirSync(path.join(this.fixture, "cut", "eps")).filter((n) => /^ep\d+\.mp4$/.test(n)).sort();
        say("stdout", `${plan.episodes.length} episodes, delogo${a.includes("--no-delogo") ? " off" : ""}`);
        const moves = new Set(plan.moves.map((m) => m.to));
        // An episode the pinned delivery already built with the same window is kept (the real cut_episodes.py's rule under --pin-from).
        const delivered = plan.pin_from ? readJson<{ episodes?: { n: number; start: number; end: number }[] }>(path.join(cut, plan.pin_from)) : null;
        const unchanged = (e: { n: number; start: number; end: number }) => (delivered?.episodes ?? []).some((d) => d.n === e.n && Math.abs(d.start - e.start) <= 0.0015 && Math.abs(d.end - e.end) <= 0.0015);
        for (const e of plan.episodes) {
          const out = path.join(eps, `ep${String(e.n).padStart(2, "0")}.mp4`);
          const touched = moves.size && plan.episodes.some((x) => moves.has(x.end) && (x.n === e.n || x.n + 1 === e.n));
          if (existsSync(out) && !touched && (plan.moves.length || unchanged(e))) {
            say("stdout", `  ep${String(e.n).padStart(2, "0")} ${e.dur.toFixed(2).padStart(6)}s  kept (delivered, unchanged)`);
            continue;
          }
          const part = out.replace(/\.mp4$/, ".part.mp4");
          copyFileSync(path.join(this.fixture, "cut", "eps", fixtureEps[(e.n - 1) % fixtureEps.length]), part);
          renameSync(part, out);
          say("stdout", `  ep${String(e.n).padStart(2, "0")} ${e.dur.toFixed(2).padStart(6)}s`);
        }
        say("stdout", "");
        say("stdout", "verify");
        say("stdout", `PASS: ${plan.episodes.length} episodes, continuous from 0, nothing lost`);
        const end = plan.episodes[plan.episodes.length - 1].end;
        const name = `cuts-0-${String(round3(end)).replace(/\.?0+$/, "")}-DELIVERED.json`;
        const dst = review(name);
        if (existsSync(dst)) {
          mkdirSync(review("superseded"), { recursive: true });
          const old = review(path.join("superseded", name.replace(/\.json$/, `.${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}.json`)));
          renameSync(dst, old);
          say("stdout", `previous record for the same span moved to review/superseded/`);
        }
        cpSync(path.join(cut, "cuts.json"), dst);
        say("stdout", `delivered: review/${name}`);
        return 0;
      }

      case "qa_episodes.py": {
        const plan = readJson<ReturnType<typeof planFrom>>(path.join(cut, "cuts.json"));
        if (!plan) {
          say("stderr", "no cuts.json");
          return 1;
        }
        const only = (arg(a, "--only") ?? "").split(",").map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);
        const qaDir = review("qa");
        mkdirSync(qaDir, { recursive: true });
        // As the real script: `--only k` measures episode k and k+1 and writes a report of ONLY those (lib/segment/qa.ts merges the rest back).
        const measured = only.length ? plan.episodes.filter((e) => only.includes(e.n) || only.includes(e.n - 1)) : plan.episodes;
        const episodes = measured.map((e) => {
          writeFileSync(path.join(qaDir, `ep${String(e.n).padStart(2, "0")}.png`), fakePng(300, 200, 40 + e.n));
          const rec: Record<string, unknown> = { n: e.n, start: e.start, end: e.end, faults: [], notes: [], last_frame_offset: -1, last_psnr: 41.7, sheet: `review/qa/ep${String(e.n).padStart(2, "0")}.png` };
          if (e.n > 1) Object.assign(rec, { first_frame_offset: 0, first_psnr: 42.1 });
          say("stdout", `ep${String(e.n).padStart(2, "0")} join first 0/42.1dB last -1/41.7dB`);
          return rec;
        });
        writeJson(path.join(qaDir, "qa.json"), { fps: FAKE_FPS, regions: [["logo", 18, 28, 94, 89]], episodes });
        say("stdout", "");
        say("stdout", `${episodes.length} episodes checked, 0 with measured faults -> review/qa/qa.json`);
        say("stdout", "sheets for the reviewers: review/qa/epNN.png (1 logo areas cropped)");
        return 0;
      }

      default:
        say("stderr", `the fake pipeline has no ${step.script}`);
        return 2;
    }
  }
}

/** verifyOptions is async over fs promises; the fake needs the answer inside a synchronous dispatch, so it re-checks the two file rules itself. */
function verifySync(cut: string, doc: OptionsDoc): string[] {
  const faults: string[] = [];
  if (doc.applied) faults.push(`already applied (${doc.applied.label ?? "?"} on ${doc.applied.on ?? "?"}) - these boundaries are decided; emit fresh options for the new stretch`);
  if (doc.strips_stale !== false) faults.push("strips_stale is not false - run --options first");
  for (const b of doc.boundaries) {
    for (const o of b.options) {
      if (!o.strip) {
        faults.push(`${o.t}s: no strip on disk`);
        continue;
      }
      const abs = path.isAbsolute(o.strip) ? o.strip : path.join(cut, o.strip);
      try {
        if (statSync(abs).size < 1000) faults.push(`${o.t}s: strip is empty`);
      } catch {
        faults.push(`${o.t}s: no strip on disk`);
      }
    }
  }
  return faults;
}

/** Tests: the real `verifyOptions` (lib/segment/strips.ts) over a fake film, so the fake's strips pass the same checks the pipeline makes. */
export async function realVerify(cut: string, doc: OptionsDoc): Promise<{ ok: boolean; faults: string[] }> {
  const r = await verifyOptions(cut, doc);
  return { ok: r.ok, faults: r.faults };
}

/** Remove a fake film folder (tests). */
export function removeFakeFilm(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
