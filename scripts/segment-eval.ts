// Calibration of the API vision pass against a delivered film (plan B5;
// decision 2026-09-23 "The frame judge, second pass"). Runs judgeBoundaries
// on the film's existing review/options.json and strips, writes the result
// under STUDIO_WORK_DIR (never into the film folder), and scores it against
// the DELIVERED cuts (the newest review/cuts-*-DELIVERED.json by its end:
// what was rendered, after the band fix and the QA re-pins), with the
// skeptic's effect reported on its own and the hard-rule checks that need
// no model. Dense strips, annotated strips and the film notes are always on,
// as in production; each has an opt-out for an A/B arm. After the pass the
// band proof runs as the stage runs it (lib/segment/plan.ts runReviewStage):
// each boundary is judged against the planner's neighbours, so two right
// picks can leave an episode out of band (Opus 5.5 on 1-20: 640.733 then
// 729.633, an 88.9 s episode), and production then re-judges those groups
// (judgeBandFix) before it renders; the eval scores the fixed plan, with the
// boundaries it did not judge pinned where the film delivered them, and
// prints the band fix as its own line beside the bar.
//
//   npx tsx scripts/segment-eval.ts --film low-quality/he-hated-all-women --boundaries 1-20
//   npx tsx scripts/segment-eval.ts --film low-quality/he-hated-all-women --boundaries 21-40 --model deepseek-flash
//   npx tsx scripts/segment-eval.ts --film ... --boundaries 115.367,744.6,#38 --truth records
//
//   --boundaries   a-b (1-based index range, inclusive), #n (one index), or a time; comma-separated
//   --first N      the first N boundaries
//   --model        a model of the vision provider's family in place of its fast tier
//   --truth        delivered (default) | records (the recorded first-pass records, the old measure)
//   --no-dense     no dense strip for the skeptic (A/B arm)         --raw-strips   the pipeline's PNGs, unannotated (A/B arm)
//   --no-tiebreak  no blind tie-break (an override that passes the guards then needs a person)
//   --no-card-prompt  the card spans stay out of the prompts and the guard (the production by-eye arm: a new film has
//                  no film-meta.json and no skips.json at vision time); the hard-rule and card checks still score
//                  against the loaded spans
//   --concurrency  boundaries judged at once (3)                    --label        the result file's name
//
// Reads .env.local like the worker (@next/env): WORKSPACE_ROOT (or the
// sibling workspace), a vision provider key (ADS_VISION_PROVIDER;
// DEEPSEEK_API_KEY runs deepseek-flash), STUDIO_PIPELINE_PYTHON /
// DRAMA_REMIX_ROOT for the dense strips (defaults: python, the sibling
// drama-remix checkout), ffmpeg on PATH (or FFMPEG_PATH) for the annotated
// copies. The film notes come from SEGMENT_FILM_NOTES, else the film's
// STATE.md "Film-specific notes"; a film with neither refuses to run, since
// the first calibration ran without them and that was one of its causes.
// Fixture data source, empty seed, no persistence: the job rows live only
// for this process; the spend is printed. The film folder is read only.

process.env.DATA_SOURCE = process.env.DATA_SOURCE ?? "fixture";
process.env.FIXTURE_SEED = "empty";
process.env.FIXTURE_PERSIST = "off";
process.env.PROMO_RENDER = "off";
// Real model calls from the fixture data source need the explicit override (lib/data-source.ts).
process.env.DEMO_REPLAY = "0";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeVisionRecords, pickNewestDelivered } from "@/lib/film-import/manifest";
import { nodeScanFs } from "@/lib/film-import/scan";
import { visionProviderStatus } from "@/lib/llm";
import { findBandConflicts, type FirstPassRecord } from "@/lib/prompts/band-fix";
import { annotateStrip } from "@/lib/segment/annotate";
import { calibrationBar, filmNotesFromState, selectBoundaries } from "@/lib/segment/calibration";
import { loadCardSpans, loadOptionsDoc, renderDenseStrip, type StripImage } from "@/lib/segment/strips";
import { applyVision, deliveredTruth, evaluate, isUnavailable, judgeBandFix, judgeBoundaries, mergeVisionPasses, scoreAgainstTruth, type AnnotateFn, type BandFixResult, type DenseStripFn, type EvalRecord, type WorkflowRecord } from "@/lib/segment/vision";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function workDir(): string {
  const configured = process.env.STUDIO_WORK_DIR?.trim();
  return configured ? path.resolve(process.cwd(), configured) : path.join(tmpdir(), "studio-work");
}

async function main() {
  const film = arg("film");
  if (!film) {
    console.error("usage: npx tsx scripts/segment-eval.ts --film low-quality/<film> [--first N | --boundaries 1-20,#38,115.367] [--model m] [--truth delivered|records] [--no-dense] [--raw-strips] [--no-tiebreak] [--no-card-prompt] [--concurrency 3] [--label eval]");
    process.exit(2);
  }
  const root = process.env.WORKSPACE_ROOT?.trim() || path.resolve(process.cwd(), "..", "Pulsar-Workspace", "mini-drama-system", "projects");
  const cutDir = path.join(root, ...film.split("/"), "cut");
  if (!existsSync(path.join(cutDir, "review", "options.json"))) {
    console.error(`${cutDir}: no review/options.json (WORKSPACE_ROOT=${root})`);
    process.exit(2);
  }
  const status = visionProviderStatus();
  const model = arg("model") ?? status.model;
  console.log(`vision provider: ${status.provider} ${model}${status.reason ? ` (${status.reason})` : ""}`);

  const doc = await loadOptionsDoc(cutDir);
  const all = doc.boundaries.map((b) => b.boundary_s);
  const first = arg("first");
  const listed = arg("boundaries");
  const selection = listed ? selectBoundaries(all, listed) : first ? { boundaries: all.slice(0, Number(first)), indices: all.slice(0, Number(first)).map((_, i) => i + 1) } : { boundaries: all, indices: all.map((_, i) => i + 1) };
  const label = arg("label") ?? `eval-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  const outDir = path.join(workDir(), "segment-eval", film.replace(/[\\/]/g, "_"));
  await fsp.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${label}.json`);

  // The film notes: the environment, else STATE.md; never none.
  let filmNotes = process.env.SEGMENT_FILM_NOTES?.trim() || null;
  const stateMd = path.join(cutDir, "STATE.md");
  if (!filmNotes && existsSync(stateMd)) filmNotes = filmNotesFromState(readFileSync(stateMd, "utf8"));
  if (!filmNotes) {
    console.error(`no film notes: set SEGMENT_FILM_NOTES or write a "## Film-specific notes" section in ${stateMd} (the first calibration ran without them; that was one of its causes)`);
    process.exit(2);
  }
  console.log(`film notes (${filmNotes.split("\n").length} lines): ${filmNotes.split("\n")[0].slice(0, 100)}`);

  // The recorded pass (the old measure, kept for the reviewer-vs-reviewer comparison) and the delivered cuts (the truth).
  const visionDir = path.join(cutDir, "review", "vision");
  const files: { name: string; json: unknown }[] = [];
  for (const e of await nodeScanFs.readdir(visionDir)) {
    if (e.kind !== "file" || !e.name.endsWith(".json")) continue;
    files.push({ name: e.name, json: JSON.parse(readFileSync(path.join(visionDir, e.name), "utf8")) });
  }
  const recorded: EvalRecord[] = mergeVisionRecords(files).boundaries.map((r) => ({ boundary_s: r.boundary_s, pick: r.pick, verdict: r.verdict }));
  const reviewNames = (await nodeScanFs.readdir(path.join(cutDir, "review"))).filter((e) => e.kind === "file").map((e) => e.name);
  const delivered = pickNewestDelivered(reviewNames);
  const truthMode = arg("truth") ?? "delivered";
  let truth: Record<string, number | null> = {};
  if (truthMode === "delivered") {
    if (!delivered) {
      console.error(`${cutDir}/review has no cuts-*-DELIVERED.json: pass --truth records to score against the recorded pass instead`);
      process.exit(2);
    }
    const plan = JSON.parse(readFileSync(path.join(cutDir, "review", delivered.file), "utf8")) as { episodes: { end: number }[] };
    const mapped = deliveredTruth(doc, plan.episodes.map((e) => e.end));
    truth = mapped.truth;
    console.log(`truth: ${delivered.file} (${plan.episodes.length} episodes${mapped.unmatched.length ? `; no delivered cut for ${JSON.stringify(mapped.unmatched)}` : ""})`);
  } else {
    for (const r of recorded) truth[String(r.boundary_s)] = r.verdict && r.verdict.agree === false && r.verdict.better_t ? r.verdict.better_t : r.pick.confidence > 0 ? r.pick.chosen_t : null;
    console.log(`truth: the recorded pass (${recorded.length} records; --truth records)`);
  }
  const cardSpans = await loadCardSpans(cutDir);
  // A delivered film's card spans were hand-written after delivery and end on the delivered cut, so a prompt that
  // carries them is told the answer at every card boundary; a by-eye run in production has none at vision time.
  const cardPrompt = !flag("no-card-prompt");
  console.log(`card spans: ${cardSpans.length} (film-meta.json exclusions of kind card, index/skips.json); in the prompt: ${cardPrompt ? "yes" : "NO (--no-card-prompt, as a by-eye run in production; the checks still use them)"}`);

  const src = path.join(cutDir, "..", "source", "original.mp4");
  const denseOn = !flag("no-dense");
  const dense: DenseStripFn | null = denseOn ? async (boundary, at) => renderDenseStrip({ src, at, outDir: path.join(outDir, "dense"), name: `b${boundary.boundary_s}_${at}.png` }) : null;
  const annotatedOn = !flag("raw-strips");
  const annotate: AnnotateFn | null = annotatedOn ? (strip: StripImage, cutT: number) => annotateStrip(strip, cutT, path.join(outDir, "annotated")) : null;
  const tiebreak = !flag("no-tiebreak");
  console.log(`dense strips: ${denseOn ? "on" : "OFF"}; annotated strips: ${annotatedOn ? "on" : "OFF (raw PNGs)"}; tie-break: ${tiebreak ? "on" : "OFF"}`);

  console.log(`${selection.boundaries.length} of ${all.length} boundaries (indices ${selection.indices[0]}..${selection.indices[selection.indices.length - 1]}) -> ${outFile}`);
  const t0 = Date.now();
  const run = { id: randomUUID(), cut_dir: cutDir, film_notes: filmNotes };
  const result = await judgeBoundaries(
    run,
    doc,
    {
      label,
      boundaries: selection.boundaries,
      concurrency: Number(arg("concurrency") ?? 3),
      out_file: outFile,
      model: arg("model") ?? undefined,
      allow_applied: true,
      // The recorded pass looked at these strips; a candidates.json rewritten since (a --allow re-index) must not refuse the measurement.
      allow_stale: true,
      dense,
      annotate,
      tiebreak,
      card_spans: cardPrompt ? cardSpans : [],
      // A delivered film's pins cover every boundary; the neighbours are the planner's own.
      fixed_start: 0,
      onBoundary: (r, done, total) => {
        const v = r.verdict as (typeof r.verdict & { guard?: { outcome?: string; better_t?: number | null } }) | null | undefined;
        const g = v?.guard?.outcome ?? "";
        console.log(`  [${done}/${total}] ${r.boundary_s}s -> ${r.pick.chosen_key} ${r.pick.chosen_t}s conf ${r.pick.confidence} payoff ${r.pick.payoff_in_episode}; skeptic ${v?.agree ? "agrees" : `disagrees${v?.better_t != null ? `, better ${v.better_t}` : ""}`}${g ? ` [${g}${v?.guard?.better_t != null && g !== "agreed" ? ` ${v.guard.better_t}` : ""}]` : ""}`);
      },
    }
  );
  if (isUnavailable(result)) {
    console.error(result.unavailable);
    process.exit(3);
  }
  const passWall = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${result.records.length} judged, ${result.errors.length} failed, ${result.retries.length} retried, ${result.jobs.length} job rows, ${result.cost_cents} cents (${result.cost_usd.toFixed(3)} $ exact), ${passWall} s wall (${result.provider} ${result.model})`);
  for (const e of result.errors) console.log(`  FAILED ${e.boundary_s}s: ${e.error}`);
  for (const r of result.retries) console.log(`  RETRIED ${r.boundary_s}s ${r.role}: ${r.error}`);
  // A check that failed after its repair turn is a record now (a refusal, skeptic_failed, no_tiebreak), never a lost boundary: say so.
  for (const r of result.records) {
    const g = (r.verdict as { guard?: { outcome?: string; rule?: string | null; detail?: string } } | null | undefined)?.guard;
    if (g?.outcome === "refused" && g.rule === "check") console.log(`  REFUSED ${r.boundary_s}s: the reviewer's answer failed its check twice (${g.detail})`);
    if (g?.outcome === "skeptic_failed") console.log(`  UNVERIFIED ${r.boundary_s}s: the skeptic's call failed twice, the reviewer's pick stands (${g.detail})`);
  }

  // The band proof, as the stage runs it after the review: the applied picks against each other, the boundaries this eval did not
  // judge (and the faulted ones a person decides) pinned where the film delivered them, and one band-fix round on every group
  // whose episodes left the band. The fixed plan is what production renders, so it is what the bar scores; the raw picks are
  // printed beside it.
  const rawScore = scoreAgainstTruth({ doc, truth, judged: result.records, card_spans: cardSpans, fixed_start: 0, selection: selection.boundaries, errors: result.errors });
  const applied = applyVision(result.records).rows;
  const movable = new Set(applied.map((r) => String(r.boundary_s)));
  const choices = Object.fromEntries(applied.map((r) => [String(r.boundary_s), r.applied_t]));
  const pins = doc.boundaries.filter((b) => !movable.has(String(b.boundary_s))).map((b) => truth[String(b.boundary_s)] ?? b.boundary_s);
  const groups = findBandConflicts({ doc: { ...doc, boundaries: doc.boundaries.filter((b) => movable.has(String(b.boundary_s))) }, choices, pins, records: result.records as unknown as FirstPassRecord[] });
  let records: WorkflowRecord[] = result.records;
  let bandFix: BandFixResult | null = null;
  let bandUnavailable: string | null = null;
  if (groups.length) {
    console.log(`\nband fix: ${groups.length} group${groups.length === 1 ? "" : "s"} out of band with the applied neighbours: ${groups.map((g) => `${g.label} ${JSON.stringify(g.episodes_out_of_band)} boundaries ${g.boundaries.map((b) => `${b.key}s (applied ${b.applied}s)`).join(", ")}`).join("; ")}`);
    const fix = await judgeBandFix(run, doc, groups, { label, model: arg("model") ?? undefined, out_file: path.join(outDir, `${label}_band-fix.json`), first_pass: result.records as unknown as FirstPassRecord[] });
    if (isUnavailable(fix)) {
      bandUnavailable = fix.unavailable;
      console.log(`  band fix not run: ${fix.unavailable}; the raw picks are scored`);
    } else {
      bandFix = fix;
      records = mergeVisionPasses([result.records, fix.output.result]);
      for (const g of fix.groups) {
        const moves = g.group.boundaries.map((b, i) => (g.resolution.times ? `${b.key}s ${b.applied} -> ${g.resolution.times[i]}` : `${b.key}s ${b.applied} (unresolved)`)).join(", ");
        console.log(`  ${g.group.label}: ${g.resolution.times ? `fixed by ${g.resolution.source}, lengths ${g.resolution.lengths?.join(" / ")}` : `NOT FIXED, a person decides (${g.resolution.faults.join("; ")})`}; ${moves}`);
      }
      console.log(`  ${fix.jobs.length} job rows, ${fix.cost_cents} cents (${fix.cost_usd.toFixed(3)} $ exact) -> ${fix.file}`);
    }
  } else {
    console.log("\nband fix: no episode out of band with the applied neighbours; nothing to fix");
  }
  const jobs = [...result.jobs, ...(bandFix?.jobs ?? [])];
  const costCents = result.cost_cents + (bandFix?.cost_cents ?? 0);
  const costUsdTotal = result.cost_usd + (bandFix?.cost_usd ?? 0);
  const wall = Math.round((Date.now() - t0) / 1000);
  // What the rows say of the model's work: the output tokens (thinking included), the failed rows whose spend is kept, and per turn how it stopped and whether it thought first.
  const failedRows = jobs.filter((j) => j.status === "failed");
  const outputTokens = jobs.reduce((s, j) => s + j.output_tokens, 0);
  const turns = jobs.flatMap((j) => j.trace);
  const stops = new Map<string, number>();
  for (const t of turns) stops.set(t.stop_reason ?? "none", (stops.get(t.stop_reason ?? "none") ?? 0) + 1);
  console.log(`\n${outputTokens} output tokens over ${jobs.length} rows (the pass and the band fix); ${failedRows.length} failed rows (${failedRows.reduce((s, j) => s + j.cost_cents, 0)} cents kept on them); ${turns.length} turns traced, ${turns.filter((t) => t.thinking_blocks > 0).length} thought first; stop reasons: ${turns.length ? [...stops].map(([k, v]) => `${k} ${v}`).join(", ") : "none traced (reused rows, or a gateway that traces none)"}`);
  console.log(`spend: ${costCents} cents by the rows (each rounded up to the cent), ${costUsdTotal.toFixed(3)} $ exact from their usage and the price table; ${wall} s wall in all`);

  const score = scoreAgainstTruth({ doc, truth, judged: records, card_spans: cardSpans, fixed_start: 0, selection: selection.boundaries, errors: result.errors });
  const n = score.n;
  const asked = selection.boundaries.length;
  console.log(`\nagainst the ${truthMode === "delivered" ? "DELIVERED cuts" : "recorded pass"} (±${score.tolerance_s} s), ${n} scored of ${asked} asked${result.errors.length ? ` (${result.errors.length} errored: ${result.errors.map((e) => `${e.boundary_s}s`).join(", ")})` : ""}${bandFix ? " - the plan AFTER the band fix" : ""}:`);
  if (bandFix) console.log(`  before the band fix: applied ${rawScore.applied_agree}/${rawScore.n}, hard-rule failures ${rawScore.rule_failures.total} (band ${rawScore.rule_failures.band}), person reviews ${rawScore.person_reviews}`);
  console.log(`  applied time (with the guarded skeptic): ${score.applied_agree}/${n}${result.errors.length ? ` (${score.applied_agree}/${asked} with the errors as misses)` : ""}`);
  console.log(`  reviewer alone (skeptic switched off):   ${score.reviewer_only_agree}/${n}`);
  console.log(`  the measure: truth not a listed option   ${score.truth_not_option}; rule 7 vs the delivered cut ${score.rule7_vs_delivered} (the applied cut is the first frame after a card the delivered cut buries)`);
  console.log(`  hand-offs (faults, unverified fixes):    ${score.handoffs} (${score.false_handoffs} false: the reviewer's pick matched and was handed off)`);
  console.log(`  person reviews (+ picks under ${score.confidence_gate}):   ${score.person_reviews}${result.errors.length ? ` (+ ${result.errors.length} errored = ${score.person_reviews + result.errors.length})` : ""}`);
  console.log(`  DP-pick rate:                            ${score.dp_rate ?? "-"}`);
  console.log(`  card boundaries:                         ${score.cards.agree}/${score.cards.boundaries}${score.cards.errored ? ` (${score.cards.errored} errored, counted as missed)` : ""}`);
  const s = score.skeptic;
  console.log(`\nthe skeptic: agreed ${s.agreed}, disputed ${s.disputed}, fixes named ${s.fixes_named}, applied ${s.applied}`);
  console.log(`  rejected by the guard: ${JSON.stringify(s.rejected)}; uncited ${s.uncited}; fault with no fix ${s.fault_no_fix}; no tie-break ${s.no_tiebreak}`);
  console.log(`  tie-break: skeptic ${s.tiebreak_skeptic}, reviewer ${s.tiebreak_reviewer}, neither ${s.tiebreak_neither}`);
  console.log(`  effect: helped ${s.helped}, hurt ${s.hurt}, bad overrides ${s.bad_overrides}`);
  console.log(`\nhard-rule failures: ${score.rule_failures.total} (card ${score.rule_failures.card}, band ${score.rule_failures.band}, unseen ${score.rule_failures.unseen}; rule 8, a split caption, is checked by eye only)`);
  console.log(`\n${"boundary".padStart(10)} ${"truth".padStart(10)} ${"reviewer".padStart(10)} ${"applied".padStart(10)}  agree  rev  guard             effect         rules`);
  for (const r of score.rows) {
    const notes = [...r.rule_failures, ...(r.truth_is_option === false ? ["truth is not a listed option"] : []), ...(r.rule7_vs_delivered ? ["rule 7 vs the delivered cut"] : [])];
    console.log(
      `${String(r.boundary_s).padStart(10)} ${String(r.truth_t ?? "-").padStart(10)} ${String(r.reviewer_t).padStart(10)} ${String(r.applied_t ?? "fault").padStart(10)}  ${r.applied_agree ? "yes" : "NO "}    ${r.reviewer_agree ? "yes" : "NO "}  ${(r.guard ?? "-").padEnd(17)} ${r.effect.padEnd(14)} ${notes.length ? notes.join("; ") : ""}`
    );
  }
  const evRecorded = evaluate(recorded, records);
  console.log(`\nfor reference, against the recorded first-pass records: applied ${evRecorded.applied_agree}/${evRecorded.matched}, reviewer ${evRecorded.reviewer_agree}/${evRecorded.matched}`);
  const unresolved = bandFix ? bandFix.groups.filter((g) => g.resolution.times === null).length : 0;
  const bandLine = bandFix ? { groups: bandFix.groups.length, faults: unresolved } : undefined;
  console.log(`\ncalibration bar (decision 2026-09-23; ${result.provider} ${result.model}; dense ${denseOn ? "on" : "off"}, annotated ${annotatedOn ? "on" : "off"}, tie-break ${tiebreak ? "on" : "off"}, card spans in the prompt ${cardPrompt ? "on" : "OFF"}; scored after the band fix):`);
  console.log(`  ${bandFix ? `band fixes ${bandFix.groups.length} group${bandFix.groups.length === 1 ? "" : "s"} (${bandFix.groups.reduce((s, g) => s + g.group.boundaries.length, 0)} boundaries re-judged, ${unresolved} unresolved for a person, ${bandFix.jobs.length} calls, ${bandFix.cost_cents} cents)` : bandUnavailable ? `band fix not run (${bandUnavailable})` : "band fixes 0 (no group out of band)"}; each fix is a model pass over its own strips and a possible review`);
  const bar = calibrationBar(score, selection.indices, costCents, { errors: result.errors, card_prompt: cardPrompt, band_fix: bandLine, cost_usd: costUsdTotal });
  for (const b of bar) console.log(`  ${b.pass ? "PASS" : "FAIL"}  ${b.line}`);
  console.log(`  ${bar.every((b) => b.pass) ? "ALL PASS" : `${bar.filter((b) => !b.pass).length} of ${bar.length} not met`}; wall ${wall} s (the pass ${passWall} s)`);

  const evalFile = path.join(outDir, `${label}.eval.json`);
  const bandFixSummary = bandFix
    ? { file: bandFix.file, groups: bandFix.groups.map((g) => ({ label: g.group.label, boundaries: g.group.boundaries.map((b) => b.key), applied_before: g.group.boundaries.map((b) => b.applied), times: g.resolution.times, source: g.resolution.source, faults: g.resolution.faults })), unresolved, jobs: bandFix.jobs.length, cost_cents: bandFix.cost_cents, cost_usd: bandFix.cost_usd }
    : null;
  await fsp.writeFile(
    evalFile,
    `${JSON.stringify({ film, truth: truthMode, delivered_file: delivered?.file ?? null, provider: result.provider, model: result.model, dense: denseOn, annotated: annotatedOn, tiebreak, card_prompt: cardPrompt, film_notes: filmNotes, indices: selection.indices, errors: result.errors, retries: result.retries, cost_cents: costCents, cost_usd: costUsdTotal, pass_cost_cents: result.cost_cents, output_tokens: outputTokens, failed_rows: failedRows.length, turns_thought_first: turns.filter((t) => t.thinking_blocks > 0).length, turns_traced: turns.length, wall_s: wall, pass_wall_s: passWall, band_fix: bandFixSummary, band_fix_unavailable: bandUnavailable, score, score_before_band_fix: bandFix ? { applied_agree: rawScore.applied_agree, n: rawScore.n, rule_failures: rawScore.rule_failures, person_reviews: rawScore.person_reviews } : null, recorded: evRecorded, bar }, null, 1)}\n`,
    "utf8"
  );
  console.log(`\nevaluation -> ${evalFile}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
