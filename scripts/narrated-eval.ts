// Calibration of the narrated route's picture readers through the API
// (narrated spec N8, C2 and C3; amendment 6): runs the synced
// frame_verify and cut_verify workflows through the Workflow shim on a
// shipped project's EXISTING items — every narration line of its
// review/frame_claims.json on the sheet it was judged on, every join of its
// review/cut_joins_prepared.json — records the verdicts with the pipeline's
// own recorders in a COPY under STUDIO_WORK_DIR, and scores the recorded
// outcome against the project's recorded verdicts (frame_check.json,
// cut_joins.json). The project folder is only read: no status, no prepare,
// no verdict file, no record there.
//
//   npx tsx scripts/narrated-eval.ts --project lbl-e02 --dry-run
//   npx tsx scripts/narrated-eval.ts --project lbl-e02 --max-usd 15
//   npx tsx scripts/narrated-eval.ts --project lbl-e02 --eps 9,12 --what frames --max-usd 3 --model claude-sonnet-5
//
//   --project   a folder under WORKSPACE_ROOT (the projects folder; default the sibling
//               ../Pulsar-Workspace/mini-drama-system/projects). lbl-e03 and lbl-e04 are refused:
//               a session is running them.
//   --eps       7-16 or 9,12 (numbers); default every epN that is a real folder (the junctioned
//               earlier episodes belong to another project)
//   --what      frames,joins (default both)
//   --max-usd   the spend cap, required unless --dry-run: no call starts once the exact spend
//               reaches it (the two calls in flight finish, so it can be passed by two calls)
//   --dry-run   list the items, the calls and an estimate of the spend; no call
//   --model     a vision model of the judge's family in place of claude-opus-5-5
//   --no-crop   send the sheets without the 2x caption-band crop (an A/B arm)
//   --label     the work folder's name (default eval-<timestamp>)
//
// What the numbers mean (N8): the shipped lines were all recorded
// `supported` and the shipped joins all fine, so on them this measures FALSE
// ALARMS only (bar: at most 5% of lines flagged, at most 1 join called
// lost). Misses need the labelled negative set (the frame_eval fail items,
// the seeded falsehoods, ep11's old cut), which is not built yet; the one
// line flagged in the project's recorded verdict rounds is reported beside.
//
// Reads .env.local like the worker (@next/env): ANTHROPIC_API_KEY (or the
// vision provider's key), DRAMA_REMIX_ROOT (the scripts and workflows come
// from its skip-through folder, the version under test), python, ffmpeg.
// Fixture data source, empty seed, no persistence: the job rows live only
// for this process; the spend is printed.

process.env.DATA_SOURCE = process.env.DATA_SOURCE ?? "fixture";
process.env.FIXTURE_SEED = "empty";
process.env.FIXTURE_PERSIST = "off";
process.env.PROMO_RENDER = "off";
// Real model calls from the fixture data source need the explicit override (lib/data-source.ts).
process.env.DEMO_REPLAY = "0";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeSourceSize } from "@/lib/clips/cut";
import { costUsd, visionProviderStatus } from "@/lib/llm";
import { dramaRemixRoot } from "@/lib/python";
import { FRAME_SHEET_COLS, runFramePass, type FramePassResult, type PendingItem } from "@/lib/segment/narrated/picture/frames";
import { JOIN_SHEET_COLS, joinSourceVideo, runJoinPass, type JoinPassResult } from "@/lib/segment/narrated/picture/joins";
import { dramaRemixState } from "@/lib/segment/scripts-sync";
import { CAPTION_BAND, CAPTION_COLS, CAPTION_SCALE, imageSize, isWorkflowUnavailable, tileGrid, type ShimCallRecord } from "@/lib/segment/workflow-shim";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function workDir(): string {
  const configured = process.env.STUDIO_WORK_DIR?.trim();
  return configured ? path.resolve(process.cwd(), configured) : path.join(tmpdir(), "studio-work");
}

const readJson = <T = unknown>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

/** Session-run projects this eval never reads (narrated amendment 4: they stay session-run). */
const LIVE_PROJECTS = new Set(["lbl-e03", "lbl-e04"]);

/** The files the recorders and the shim need, from the drama-remix checkout's skip-through folder. */
const SCRIPTS = ["frame_claims.py", "cut_joins.py", "jev.py", "frame_verify.workflow.js", "cut_verify.workflow.js"];

type FrameLine = { id: string; text: string; text_hash: string; sheet: string };
type CheckRecord = { text_hash?: string; reader_version?: string | null; claims?: { claim?: string; verdict?: string; evidence?: string; reader?: number }[] };
type JoinRecord = { words_fp?: string; lost?: boolean; at_shipped?: string; readers?: { viewer_lost?: boolean; what_is_confusing?: string }[] };

function parseEps(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) for (let n = Number(m[1]); n <= Number(m[2]); n++) out.push(n);
    else if (/^\d+$/.test(part)) out.push(Number(part));
    else throw new Error(`--eps: ${part} is not a number or a range`);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The API's image scaling (long edge 1568 px, about 1.15 MP) and its token count, for the dry-run estimate. */
function imageTokens(size: { width: number; height: number } | null): number {
  if (!size) return 1600;
  let { width: w, height: h } = size;
  const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)));
  w *= s;
  h *= s;
  return Math.ceil((w * h) / 750);
}

/** The caption crop's size for a sheet (the shim's own grid and band), for the estimate. */
function cropSize(sheet: { width: number; height: number } | null, cols: number): { width: number; height: number } | null {
  if (!sheet) return null;
  const g = tileGrid(sheet, cols, null);
  const band = Math.max(2, Math.round(g.tile_h * CAPTION_BAND)) * CAPTION_SCALE;
  return { width: g.tile_w * CAPTION_SCALE * CAPTION_COLS, height: Math.ceil((g.cols * g.rows) / CAPTION_COLS) * band };
}

/** Say why and set the exit code; returning (not process.exit) lets the ffmpeg and python handles close first. */
function fail(code: number, message: string): void {
  console.error(message);
  process.exitCode = code;
}

async function main() {
  const project = arg("project");
  if (!project) {
    return fail(2, "usage: npx tsx scripts/narrated-eval.ts --project lbl-e02 (--dry-run | --max-usd N) [--eps 7-16] [--what frames,joins] [--model m] [--no-crop] [--label x]");
  }
  if (LIVE_PROJECTS.has(path.basename(project))) {
    return fail(2, `${project} is session-run and live (narrated amendment 4); the eval does not read it`);
  }
  const dry = flag("dry-run");
  const capArg = arg("max-usd");
  const cap = capArg === null ? null : Number(capArg);
  if (!dry && (cap === null || !Number.isFinite(cap) || cap <= 0)) {
    return fail(2, "--max-usd <dollars> is required for a paid run (or --dry-run for the estimate)");
  }
  const what = new Set((arg("what") ?? "frames,joins").split(",").map((s) => s.trim()));
  const root = process.env.WORKSPACE_ROOT?.trim() || path.resolve(process.cwd(), "..", "Pulsar-Workspace", "mini-drama-system", "projects");
  const proj = path.join(root, ...project.split("/"));
  if (!existsSync(path.join(proj, "frame_premise.txt"))) {
    return fail(2, `${proj}: no frame_premise.txt (WORKSPACE_ROOT=${root})`);
  }
  const premise = readFileSync(path.join(proj, "frame_premise.txt"), "utf8").trim();
  const allEps = readdirSync(proj)
    .filter((d) => /^ep\d+$/.test(d) && !lstatSync(path.join(proj, d)).isSymbolicLink() && lstatSync(path.join(proj, d)).isDirectory())
    .map((d) => Number(d.slice(2)))
    .sort((a, b) => a - b);
  const eps = (arg("eps") ? parseEps(arg("eps")!) : allEps).map((n) => `ep${n}`);
  for (const ep of eps) if (!allEps.includes(Number(ep.slice(2)))) console.warn(`  ${ep}: not a real folder of ${project} (a junction or missing); skipped`);
  const epList = eps.filter((ep) => allEps.includes(Number(ep.slice(2))));

  const remix = dramaRemixRoot();
  const skip = path.join(remix, "scripts", "skip-through");
  for (const f of SCRIPTS) if (!existsSync(path.join(skip, f))) throw new Error(`${path.join(skip, f)} is missing (DRAMA_REMIX_ROOT=${remix})`);
  let remixSha = "unknown";
  try {
    const st = dramaRemixState(remix);
    remixSha = `${st.sha.slice(0, 10)}${st.dirty ? " (dirty)" : ""}`;
  } catch (e) {
    remixSha = `unreadable: ${(e as Error).message}`;
  }

  // The items, exactly as `status` would list them for a first check, and the recorded truth beside each.
  const frameItems = new Map<string, PendingItem[]>();
  const frameTruth = new Map<string, { flagged: boolean; claim: string | null } | null>();
  const joinItems = new Map<string, PendingItem[]>();
  const joinTruth = new Map<string, boolean | null>();
  let imageTok = 0;
  let sheets = 0;
  for (const ep of epList) {
    const review = path.join(proj, ep, "review");
    if (what.has("frames") && existsSync(path.join(review, "frame_claims.json"))) {
      const lines = readJson<{ lines: FrameLine[] }>(path.join(review, "frame_claims.json")).lines;
      const check = existsSync(path.join(review, "frame_check.json")) ? readJson<Record<string, CheckRecord>>(path.join(review, "frame_check.json")) : {};
      const items: PendingItem[] = [];
      for (const l of lines) {
        if (!existsSync(l.sheet)) {
          console.warn(`  ${ep} ${l.id}: its sheet ${l.sheet} is missing; skipped`);
          continue;
        }
        items.push({ key: `${ep}-${l.id}`, ep, id: l.id, text: l.text, sheet: l.sheet });
        const rec = check[l.id];
        const bad = rec && rec.text_hash === l.text_hash ? (rec.claims ?? []).find((c) => c.verdict === "contradicted") : undefined;
        frameTruth.set(`${ep}-${l.id}`, rec && rec.text_hash === l.text_hash ? { flagged: !!bad, claim: bad?.claim ?? null } : null);
        const size = await imageSize(l.sheet);
        imageTok += 2 * (imageTokens(size) + (flag("no-crop") ? 0 : imageTokens(cropSize(size, FRAME_SHEET_COLS))));
        sheets += 1;
      }
      frameItems.set(ep, items);
    }
    if (what.has("joins") && existsSync(path.join(review, "cut_joins_prepared.json"))) {
      const prepared = readJson<PendingItem[]>(path.join(review, "cut_joins_prepared.json"));
      const recorded = existsSync(path.join(review, "cut_joins.json")) ? readJson<Record<string, JoinRecord>>(path.join(review, "cut_joins.json")) : {};
      const items = prepared.filter((i) => existsSync(i.sheet));
      for (const i of items) {
        const rec = recorded[i.id];
        joinTruth.set(i.key, rec && rec.words_fp === i.words_fp ? !!rec.lost : null);
        const size = await imageSize(i.sheet);
        imageTok += 2 * (imageTokens(size) + (flag("no-crop") ? 0 : imageTokens(cropSize(size, JOIN_SHEET_COLS))));
        sheets += 1;
      }
      if (items.length) joinItems.set(ep, items);
    }
  }
  const nLines = [...frameItems.values()].reduce((s, x) => s + x.length, 0);
  const nJoins = [...joinItems.values()].reduce((s, x) => s + x.length, 0);
  const status = visionProviderStatus();
  const model = arg("model") ?? status.model;
  console.log(`project ${project} (${proj}); episodes ${epList.join(", ") || "none"}; drama-remix ${remixSha}`);
  console.log(`items: ${nLines} narration lines, ${nJoins} joins -> ${2 * (nLines + nJoins)} calls on ${status.provider} ${model}${status.reason ? ` (${status.reason})` : ""}`);

  // The line flagged in the project's recorded verdict rounds (any frame_verdicts file), and whether its wording is still the shipped one.
  const history: { ep: string; id: string; file: string; claim: string; still_shipped: boolean }[] = [];
  for (const ep of epList) {
    const review = path.join(proj, ep, "review");
    if (!existsSync(review)) continue;
    const current = existsSync(path.join(review, "frame_claims.json")) ? new Map(readJson<{ lines: FrameLine[] }>(path.join(review, "frame_claims.json")).lines.map((l) => [l.id, l.text])) : new Map<string, string>();
    for (const f of readdirSync(review).filter((n) => /^frame_verdicts.*\.json$/.test(n))) {
      let raw = readJson<unknown>(path.join(review, f));
      if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { result?: unknown }).result)) raw = (raw as { result: unknown[] }).result;
      const list: { id?: string; text?: string; readers?: { claims?: { claim?: string; verdict?: string }[] }[]; claims?: { claim?: string; verdict?: string }[] }[] = Array.isArray(raw)
        ? (raw as never[])
        : Object.entries((raw ?? {}) as Record<string, object>).map(([id, v]) => ({ id, ...(v as object) }));
      for (const r of list) {
        const claims = r.readers ? r.readers.flatMap((x) => x.claims ?? []) : r.claims ?? [];
        const bad = claims.find((c) => c.verdict === "contradicted");
        if (bad && r.id) history.push({ ep, id: r.id, file: f, claim: bad.claim ?? "", still_shipped: current.get(r.id) === r.text });
      }
    }
  }
  for (const h of history) console.log(`  flagged in the recorded rounds: ${h.ep} ${h.id} (${h.file}): ${h.claim.slice(0, 120)}${h.still_shipped ? "" : " — its wording has changed since, so the shipped line is not this one"}`);

  // The estimate: the images at the API's scaling, the prompt, and the answer with the thinking that comes first.
  const promptTok = 1400 + Math.ceil(premise.length / 4);
  const perCallOut = 3000;
  const calls = 2 * (nLines + nJoins);
  const estimate = costUsd(model, { input_tokens: imageTok + calls * promptTok, output_tokens: calls * perCallOut, cache_read_tokens: 0, cache_write_tokens: 0 });
  console.log(`estimate: about $${estimate.toFixed(2)} (${sheets} sheets${flag("no-crop") ? "" : " with their caption crops"}, ~${Math.round(imageTok / Math.max(1, calls))} image tokens and ~${promptTok} prompt tokens in, ~${perCallOut} out with the thinking, per call; the real spend is printed after)`);
  if (dry) {
    for (const [ep, items] of frameItems) console.log(`  ${ep} lines: ${items.map((i) => i.id).join(", ")}`);
    for (const [ep, items] of joinItems) console.log(`  ${ep} joins: ${items.map((i) => i.id).join(", ")}`);
    return;
  }

  // The copy the recorders write into: the prepared records and the scripts; the sheets stay where they are and are only read.
  const label = arg("label") ?? `eval-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  const outDir = path.join(workDir(), "narrated-eval", project.replace(/[\\/]/g, "_"), label);
  const film = path.join(outDir, "proj");
  mkdirSync(path.join(film, "scripts"), { recursive: true });
  for (const f of SCRIPTS) copyFileSync(path.join(skip, f), path.join(film, "scripts", f));
  for (const ep of epList) {
    const from = path.join(proj, ep, "review");
    const to = path.join(film, ep, "review");
    mkdirSync(to, { recursive: true });
    for (const f of ["frame_claims.json", "cut_joins_prepared.json"]) if (existsSync(path.join(from, f))) copyFileSync(path.join(from, f), path.join(to, f));
  }
  const runId = randomUUID();
  // The crop's tile grid needs the frame size the sheets were grabbed from; the copy has no video, the project does.
  const source = joinSourceVideo(proj);
  const videoSize = source ? await probeSourceSize(source).catch(() => null) : null;
  console.log(`source frame ${videoSize ? `${videoSize.width}x${videoSize.height}` : "unknown (16:9 assumed for the crop)"}`);
  const common = { run_id: runId, video_size: videoSize, work_dir: path.join(outDir, "work"), film, premise, status: false, model: arg("model") ?? undefined, no_crop: flag("no-crop"), onLog: (l: string) => (/^(FAILED|retry)/.test(l) ? console.log(`    ${l}`) : undefined) };
  let spent = 0;
  const allCalls: ShimCallRecord[] = [];
  const frameResults: FramePassResult[] = [];
  const joinResults: JoinPassResult[] = [];
  const t0 = Date.now();
  for (const [ep, items] of frameItems) {
    if (!items.length) continue;
    const r = await runFramePass({ ...common, ep, items, max_usd: cap! - spent });
    if (isWorkflowUnavailable(r)) {
      return fail(3, r.unavailable);
    }
    spent += r.cost_usd;
    allCalls.push(...r.calls);
    frameResults.push(r);
    console.log(`  ${ep} frames: ${r.complete.length}/${r.items} recorded${r.incomplete.length ? `, ${r.incomplete.length} not (${r.incomplete.map((i) => i.key).join(", ")})` : ""}; ${r.contradicted.length} contradicted claim(s); $${r.cost_usd.toFixed(3)}${r.recorded && r.recorded.code !== 0 ? `; RECORD REFUSED: ${r.recorded.refusal}` : ""}`);
  }
  for (const [ep, items] of joinItems) {
    const r = await runJoinPass({ ...common, ep, items, max_usd: cap! - spent });
    if (isWorkflowUnavailable(r)) {
      return fail(3, r.unavailable);
    }
    spent += r.cost_usd;
    allCalls.push(...r.calls);
    joinResults.push(r);
    console.log(`  ${ep} joins: ${r.complete.length}/${r.items} recorded; ${r.lost.length} lost; $${r.cost_usd.toFixed(3)}${r.recorded && r.recorded.code !== 0 ? `; RECORD REFUSED: ${r.recorded.refusal}` : ""}`);
  }
  const wall = Math.round((Date.now() - t0) / 1000);

  // The score: what the pipeline's own records say now (in the copy) against what they said when the project shipped.
  type Row = { key: string; truth: boolean | null; ours: boolean | null; note: string };
  const frameRows: Row[] = [];
  for (const [ep, items] of frameItems) {
    const ours = existsSync(path.join(film, ep, "review", "frame_check.json")) ? readJson<Record<string, CheckRecord>>(path.join(film, ep, "review", "frame_check.json")) : {};
    for (const it of items) {
      const rec = ours[it.id];
      const bad = rec ? (rec.claims ?? []).filter((c) => c.verdict === "contradicted") : [];
      const truth = frameTruth.get(it.key);
      frameRows.push({ key: it.key, truth: truth ? truth.flagged : null, ours: rec ? bad.length > 0 : null, note: bad.map((c) => `reader ${c.reader}: ${c.claim} — ${c.evidence}`).join(" | ") });
    }
  }
  const joinRows: Row[] = [];
  for (const [ep, items] of joinItems) {
    const ours = existsSync(path.join(film, ep, "review", "cut_joins.json")) ? readJson<Record<string, JoinRecord>>(path.join(film, ep, "review", "cut_joins.json")) : {};
    for (const it of items) {
      const rec = ours[it.id];
      joinRows.push({ key: it.key, truth: joinTruth.get(it.key) ?? null, ours: rec ? !!rec.lost : null, note: rec?.lost ? (rec.readers ?? []).filter((x) => x.viewer_lost).map((x) => x.what_is_confusing).join(" | ") : "" });
    }
  }
  const tally = (rows: Row[]) => ({
    judged: rows.filter((r) => r.ours !== null).length,
    comparable: rows.filter((r) => r.ours !== null && r.truth !== null).length,
    not_judged: rows.filter((r) => r.ours === null).length,
    agree: rows.filter((r) => r.ours !== null && r.truth !== null && r.ours === r.truth).length,
    false_flags: rows.filter((r) => r.ours === true && r.truth === false).length,
    misses: rows.filter((r) => r.ours === false && r.truth === true).length,
    no_truth: rows.filter((r) => r.truth === null).length,
    shipped_clean: rows.filter((r) => r.truth === false && r.ours !== null).length,
  });
  const f = tally(frameRows);
  const j = tally(joinRows);
  const readerVersion = frameResults.find((r) => r.reader_version)?.reader_version ?? joinResults.find((r) => r.reader_version)?.reader_version ?? null;
  const failedCalls = allCalls.filter((c) => c.status !== "done");
  const cents = allCalls.reduce((s, c) => s + c.cost_cents, 0);
  console.log(`\n${allCalls.length} calls (${failedCalls.length} not done: ${[...new Set(failedCalls.map((c) => c.status))].join(", ") || "none"}), ${cents} cents by the rows, $${spent.toFixed(3)} exact; ${wall} s wall; reader ${readerVersion ?? "-"}`);
  for (const c of failedCalls) console.log(`  ${c.status.toUpperCase()} ${c.label}: ${c.error ?? ""}`);

  console.log(`\nframe check against the recorded verdicts (${frameRows.length} lines; ${f.judged} judged now, ${f.not_judged} not; ${f.no_truth} with no recorded verdict for their wording):`);
  console.log(`  agree ${f.agree}/${f.comparable}; false flags on shipped lines ${f.false_flags}/${f.shipped_clean}; misses of a recorded flag ${f.misses}`);
  for (const r of frameRows.filter((x) => x.ours === true || x.truth === true)) console.log(`  ${r.ours ? "FLAG" : "pass"} (recorded ${r.truth === null ? "-" : r.truth ? "flag" : "pass"}) ${r.key}: ${r.note}`);
  console.log(`\njoin check against the recorded verdicts (${joinRows.length} joins; ${j.judged} judged now):`);
  console.log(`  agree ${j.agree}/${j.comparable}; false "lost" on shipped joins ${j.false_flags}/${j.shipped_clean}; misses ${j.misses}`);
  for (const r of joinRows.filter((x) => x.ours === true || x.truth === true)) console.log(`  ${r.ours ? "LOST" : "fine"} (recorded ${r.truth === null ? "-" : r.truth ? "lost" : "fine"}) ${r.key}: ${r.note}`);

  // N8's bar, the part this set can measure.
  const frameRate = f.shipped_clean ? f.false_flags / f.shipped_clean : null;
  // `nothing`: the line fails because nothing it measures was judged (every call failed or was capped) — not a
  // measurement at all, so the run exits non-zero rather than 0 with 0 of N judged.
  const bar = [
    { pass: frameRate !== null && frameRate <= 0.05, nothing: frameRows.length > 0 && f.judged === 0, line: `false flags on shipped lines at most 5%: ${f.false_flags}/${f.shipped_clean}${frameRate === null ? " (none judged)" : ` = ${(frameRate * 100).toFixed(1)}%`}` },
    { pass: j.shipped_clean > 0 && j.false_flags <= 1, nothing: joinRows.length > 0 && j.judged === 0, line: `at most 1 false "lost" on the shipped joins: ${j.false_flags}/${j.shipped_clean}${joinRows.length > 0 && j.judged === 0 ? " (none judged)" : ""}` },
    { pass: f.not_judged + j.not_judged === 0, nothing: frameRows.length + joinRows.length > 0 && f.judged + j.judged === 0, line: `every item judged: ${f.not_judged + j.not_judged} not (failed or capped calls)` },
  ];
  console.log(`\ncalibration bar, false alarms only (narrated spec N8; ${readerVersion ?? "-"}; misses need the labelled negative set, not built yet):`);
  for (const b of bar) console.log(`  ${b.pass ? "PASS" : "FAIL"}  ${b.line}`);
  const unmeasured = bar.filter((b) => !b.pass && b.nothing);
  if (unmeasured.length) fail(4, `\n${unmeasured.length} bar line(s) failed because nothing was judged (see the calls not done above): this run measured nothing there`);
  console.log(`  flagged in the project's recorded rounds: ${history.length ? history.map((h) => `${h.ep} ${h.id}${h.still_shipped ? " (the shipped wording)" : " (reworded since)"}`).join(", ") : "none"}`);

  const evalFile = path.join(outDir, "eval.json");
  writeFileSync(
    evalFile,
    `${JSON.stringify({ project, eps: epList, drama_remix: remixSha, provider: status.provider, model, reader_version: readerVersion, crop: !flag("no-crop"), cap_usd: cap, spent_usd: spent, cents, wall_s: wall, estimate_usd: estimate, frames: { tally: f, rows: frameRows }, joins: { tally: j, rows: joinRows }, history, failed_calls: failedCalls, bar }, null, 1)}\n`,
    "utf8"
  );
  console.log(`\nevaluation -> ${evalFile}\nrecords (the copy) -> ${film}`);
}

main().catch((e) => fail(1, e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
