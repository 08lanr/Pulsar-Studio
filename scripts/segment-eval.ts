// Calibration of the API vision pass against a delivered film's recorded
// pass (plan B5: agreement with past agent picks, not correctness). Runs
// judgeBoundaries on the film's existing review/options.json and strips,
// writes the result under STUDIO_WORK_DIR (never into the film folder), and
// prints evaluate() against the film's review/vision records.
//
//   npx tsx scripts/segment-eval.ts --film low-quality/he-hated-all-women --first 20
//   npx tsx scripts/segment-eval.ts --film low-quality/he-hated-all-women --boundaries 115.367,744.6,4313.4
//   npx tsx scripts/segment-eval.ts --film ... --dense       (skeptic also gets a 10 fps strip, rendered by
//                                                            boundary_frames.py into STUDIO_WORK_DIR)
//
// Needs WORKSPACE_ROOT (or the sibling workspace), a vision provider key
// (ADS_VISION_PROVIDER; DEEPSEEK_API_KEY runs deepseek-flash), and with
// --dense STUDIO_PIPELINE_PYTHON / DRAMA_REMIX_ROOT (defaults: python, the
// sibling drama-remix checkout). Fixture data source, empty seed, no
// persistence: the job rows live only for this process; the spend is printed.

process.env.DATA_SOURCE = process.env.DATA_SOURCE ?? "fixture";
process.env.FIXTURE_SEED = "empty";
process.env.FIXTURE_PERSIST = "off";
process.env.PROMO_RENDER = "off";
// Real model calls from the fixture data source need the explicit override (lib/data-source.ts).
process.env.DEMO_REPLAY = "0";

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeVisionRecords } from "@/lib/film-import/manifest";
import { nodeScanFs } from "@/lib/film-import/scan";
import { visionProviderStatus } from "@/lib/llm";
import { loadOptionsDoc, renderDenseStrip } from "@/lib/segment/strips";
import { evaluate, isUnavailable, judgeBoundaries, type DenseStripFn, type EvalRecord } from "@/lib/segment/vision";

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
    console.error("usage: npx tsx scripts/segment-eval.ts --film low-quality/<film> [--first N | --boundaries a,b,c] [--dense] [--concurrency 3] [--label eval]");
    process.exit(2);
  }
  const root = process.env.WORKSPACE_ROOT?.trim() || path.resolve(process.cwd(), "..", "Pulsar-Workspace", "mini-drama-system", "projects");
  const cutDir = path.join(root, ...film.split("/"), "cut");
  if (!existsSync(path.join(cutDir, "review", "options.json"))) {
    console.error(`${cutDir}: no review/options.json (WORKSPACE_ROOT=${root})`);
    process.exit(2);
  }
  const status = visionProviderStatus();
  console.log(`vision provider: ${status.provider} ${status.model}${status.reason ? ` (${status.reason})` : ""}`);

  const doc = await loadOptionsDoc(cutDir);
  const all = doc.boundaries.map((b) => b.boundary_s);
  const first = arg("first");
  const listed = arg("boundaries");
  const boundaries = listed ? listed.split(",").map(Number) : first ? all.slice(0, Number(first)) : all;
  const label = arg("label") ?? `eval-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  const outDir = path.join(workDir(), "segment-eval", film.replace(/[\\/]/g, "_"));
  await fsp.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${label}.json`);

  // The recorded pass: every record file the pipeline kept (superseded ones skipped), as phase 1 reads them.
  const visionDir = path.join(cutDir, "review", "vision");
  const files: { name: string; json: unknown }[] = [];
  for (const e of await nodeScanFs.readdir(visionDir)) {
    if (e.kind !== "file" || !e.name.endsWith(".json")) continue;
    files.push({ name: e.name, json: JSON.parse(readFileSync(path.join(visionDir, e.name), "utf8")) });
  }
  const recorded = mergeVisionRecords(files).boundaries;
  // The recorded pass is keyed by boundary_s for evaluate; phase 1 keeps the records by chosen_t, so re-key here.
  const recordedByBoundary: EvalRecord[] = recorded.map((r) => ({ boundary_s: r.boundary_s, pick: r.pick, verdict: r.verdict }));

  const src = path.join(cutDir, "..", "source", "original.mp4");
  const dense: DenseStripFn | null = flag("dense")
    ? async (boundary, chosenT) => renderDenseStrip({ src, at: chosenT, outDir: path.join(outDir, "dense"), name: `b${boundary.boundary_s}_${chosenT}.png` })
    : null;

  console.log(`${boundaries.length} of ${all.length} boundaries -> ${outFile}`);
  const t0 = Date.now();
  const result = await judgeBoundaries(
    { id: randomUUID(), cut_dir: cutDir, film_notes: process.env.SEGMENT_FILM_NOTES ?? null },
    doc,
    {
      label,
      boundaries,
      concurrency: Number(arg("concurrency") ?? 3),
      out_file: outFile,
      allow_applied: true,
      dense,
      onBoundary: (r, done, total) => {
        const v = r.verdict;
        console.log(`  [${done}/${total}] ${r.boundary_s}s -> ${r.pick.chosen_key} ${r.pick.chosen_t}s conf ${r.pick.confidence} payoff ${r.pick.payoff_in_episode}; skeptic ${v?.agree ? "agrees" : `disagrees${v?.better_t != null ? `, better ${v.better_t}` : ""}`}`);
      },
    }
  );
  if (isUnavailable(result)) {
    console.error(result.unavailable);
    process.exit(3);
  }
  const wall = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${result.records.length} judged, ${result.errors.length} failed, ${result.jobs.length} job rows, ${result.cost_cents} cents, ${wall} s wall`);
  for (const e of result.errors) console.log(`  FAILED ${e.boundary_s}s: ${e.error}`);

  const ev = evaluate(recordedByBoundary, result.records);
  console.log(`\nagreement with the recorded pass (±${ev.tolerance_s} s), ${ev.matched} matched:`);
  console.log(`  applied time:  ${ev.applied_agree}/${ev.matched} (${ev.applied_rate ?? "-"})`);
  console.log(`  reviewer pick: ${ev.reviewer_agree}/${ev.matched} (${ev.reviewer_rate ?? "-"})`);
  console.log(`  payoff flag:   ${ev.payoff_agree}/${ev.matched} (${ev.payoff_rate ?? "-"})`);
  console.log(`  one-sided faults: ${ev.one_sided}`);
  console.log(`\n${"boundary".padStart(10)} ${"recorded".padStart(10)} ${"judged".padStart(10)} ${"delta".padStart(8)}  agree  payoff  conf(rec/judged)`);
  for (const r of ev.rows) {
    console.log(
      `${String(r.boundary_s).padStart(10)} ${String(r.recorded_t ?? "fault").padStart(10)} ${String(r.judged_t ?? "fault").padStart(10)} ${String(r.delta_s ?? "-").padStart(8)}  ${r.applied_agree ? "yes" : "NO "}    ${r.payoff_agree ? "yes" : "NO "}     ${r.recorded_confidence}/${r.judged_confidence}`
    );
  }
  const evalFile = path.join(outDir, `${label}.eval.json`);
  await fsp.writeFile(evalFile, `${JSON.stringify(ev, null, 1)}\n`, "utf8");
  console.log(`\nevaluation -> ${evalFile}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
