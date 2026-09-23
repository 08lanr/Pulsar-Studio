// Film-meta and the hand-off (plan B2, stages 8–9). The film-meta stage
// waits for the form — display title, crazydramas slug, the spoiler line
// (default half the runtime), exclusions, the live poster — and writes
// `cut/film-meta.json`, the one file Studio may hand-write; a join move
// recorded here goes back through the render. The hand-off stage waits
// until the phase-1 scanner reads the film READY (no `.part`, five quiet
// minutes, the delivered files exactly 1..N), then for "Import now", which
// runs the phase-1 import for the run's company (an update when the film
// was imported before), follows its progress and puts the title on the run.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { importIsRunning, importProgress, importQuietMs, scannerProbe, startImport, type ImportProgress } from "@/lib/film-import/import";
import { parseFilmMeta } from "@/lib/film-import/manifest";
import { scanFilm } from "@/lib/film-import/scan";
import type { FilmMeta, FilmScan } from "@/lib/film-import/types";
import type { FilmRun, Json } from "@/lib/types";
import { readPlan } from "./render";
import { DECISION, decisionData, fail, fakePipeline, next, pendingDecision, readJson, sourceRefOf, wait, type StageContext, type StageOutcome } from "./stages";

// ---- film-meta -------------------------------------------------------------------------------------------------------

export type FilmMetaForm = {
  display_title_en: string;
  crazydramas_slug: string | null;
  spoiler_from_s: number | null;
  exclusions: { from_s: number; to_s: number; why: string; kind?: string | null }[];
  live_poster: string | null;
  source_title_en?: string | null;
  notes?: string | null;
};

/** The current `cut/film-meta.json`, or null. */
export function readFilmMeta(cutDir: string): FilmMeta | null {
  const raw = readJson(path.join(cutDir, "film-meta.json"));
  if (!raw) return null;
  try {
    return parseFilmMeta(raw);
  } catch {
    return null;
  }
}

/** What the form starts from: the file when there is one, else the folder's title, the run's slug and the spoiler line at half the runtime. */
export function defaultFilmMeta(run: Pick<FilmRun, "slug" | "lang">, cutDir: string): FilmMetaForm {
  const have = readFilmMeta(cutDir);
  const plan = readPlan(cutDir);
  const runtime = plan ? plan.episodes[plan.episodes.length - 1]?.end ?? null : null;
  const title = run.slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  return {
    display_title_en: have?.display_title_en ?? title,
    crazydramas_slug: have?.crazydramas_slug ?? run.slug.replace(/_/g, "-"),
    spoiler_from_s: have?.spoiler_from_s ?? (runtime ? Math.round((runtime / 2) * 1000) / 1000 : null),
    exclusions: have?.exclusions.map((e) => ({ from_s: e.from_s, to_s: e.to_s, why: e.why, kind: e.kind })) ?? [],
    live_poster: have?.live_poster ?? null,
    source_title_en: have?.source_title_en ?? null,
    notes: have?.notes ?? null,
  };
}

/** Write `cut/film-meta.json` from the form, keeping what the form does not carry (source title, notes) from the file that was there. */
export function writeFilmMeta(cutDir: string, form: FilmMetaForm, lang: string): FilmMeta {
  const have = readFilmMeta(cutDir);
  const out = {
    display_title_en: form.display_title_en.trim(),
    source_title_en: form.source_title_en ?? have?.source_title_en ?? null,
    crazydramas_slug: form.crazydramas_slug?.trim() || null,
    language: have?.language ?? lang,
    spoiler_from_s: form.spoiler_from_s,
    live_poster: form.live_poster?.trim() || null,
    notes: form.notes ?? have?.notes ?? `Written by Pulsar Studio on ${new Date().toISOString().slice(0, 10)} (segment run).`,
    exclusions: form.exclusions.map((e) => ({ from_s: e.from_s, to_s: e.to_s, kind: e.kind ?? null, why: e.why })),
  };
  const meta = parseFilmMeta(out);
  writeFileSync(path.join(cutDir, "film-meta.json"), `${JSON.stringify(out, null, 1)}\n`, "utf8");
  return meta;
}

export async function runFilmMetaStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  if (pendingDecision(run, DECISION.join)) return next("render", { note: "a join moves: re-rendering the two episodes it touches" });
  const decision = pendingDecision(run, DECISION.film_meta);
  if (decision) {
    const form = decisionData(decision) as unknown as FilmMetaForm;
    try {
      const meta = writeFilmMeta(dirs.cut, form, run.lang);
      ctx.log(`cut/film-meta.json written: ${meta.display_title_en} (${meta.crazydramas_slug ?? "no slug"})`);
      return next("handoff", { film_meta: meta as unknown as Json });
    } catch (e) {
      return wait("film_meta", { film_meta_error: (e as Error).message, film_meta: (readFilmMeta(dirs.cut) as unknown as Json) ?? null });
    }
  }
  return wait("film_meta", { film_meta: (readFilmMeta(dirs.cut) as unknown as Json) ?? null, film_meta_default: defaultFilmMeta(run, dirs.cut) as unknown as Json });
}

// ---- the hand-off --------------------------------------------------------------------------------------------------------

const READY_POLL_MS = 30_000;

async function scanRun(ctx: StageContext): Promise<FilmScan> {
  const quiet = ctx.runner.fake ? 0 : importQuietMs();
  return scanFilm(sourceRefOf(ctx.run), { root: ctx.dirs.root, ...(quiet !== undefined ? { quietMs: quiet } : {}), probe: scannerProbe, linkDir: ctx.dirs.work });
}

function scanJson(scan: FilmScan): Json {
  return { state: scan.state, reason: (scan.reason as unknown as Json) ?? null, pipeline_stage: scan.pipeline_stage, pipeline_note: scan.pipeline_note, episodes: scan.totals.count, delivered: scan.delivered ? { file: scan.delivered.file, count: scan.delivered.count } : null, warnings: scan.warnings };
}

function progressJson(p: ImportProgress | null): Json {
  if (!p) return null;
  return { step: p.step, episode: p.episode, total: p.total, what: p.what, counts: p.counts as unknown as Json, error: p.error, title_id: p.title_id, result: (p.result as unknown as Json) ?? null };
}

export async function runHandoffStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  if (pendingDecision(run, DECISION.join)) return next("render", { note: "a join moves: re-rendering the two episodes it touches" });
  const scan = await scanRun(ctx);
  const ready = scan.state === "READY" || scan.state === "IMPORTED" || scan.state === "K_CHANGED";
  const importNow = pendingDecision(run, DECISION.import_now);
  if (!importNow) {
    if (!ready) return wait("ready", { scan: scanJson(scan), ready: false }, ctx.runner.fake ? 200 : READY_POLL_MS);
    return wait("import", { scan: scanJson(scan), ready: true });
  }
  if (!ready) return wait("ready", { scan: scanJson(scan), ready: false, note: "the film is not READY yet; Import now applies once it is" }, ctx.runner.fake ? 200 : READY_POLL_MS);

  const data = getData();
  const sys = systemSession();
  const ref = sourceRefOf(run);
  const existing = await data.findTitleBySourceRef(sys, run.producer_id, ref);
  const mode = existing ? "update" : "import";
  const meta = readFilmMeta(dirs.cut);
  ctx.log(`import ${mode}: ${ref} for ${run.producer_id}${existing ? ` (title ${existing.id})` : ""}`);
  let started;
  try {
    started = await startImport(sys, { source_ref: ref, mode, attach_transcript: true, display_title: meta?.display_title_en ?? null }, { producer_id: run.producer_id, created_by: run.created_by ?? sys.userId }, { root: dirs.root, ...(ctx.runner.fake || fakePipeline(ctx.env) ? { quietMs: 0 } : {}) });
  } catch (e) {
    return wait("import", { scan: scanJson(scan), ready: true, import_error: (e as Error).message });
  }
  await ctx.progress({ progress: { step: "import", job_id: started.job_id, title_id: started.title_id } });
  // Follow the import's own progress (its registry is this process's); it is cheap and finishes in seconds for a small film.
  for (;;) {
    await ctx.beat();
    const p = importProgress(run.producer_id, ref);
    if (!p || p.job_id !== started.job_id) break;
    if (!importIsRunning(p)) {
      if (p.step === "failed") return wait("import", { scan: scanJson(scan), ready: true, import_error: p.error ?? "the import failed", import: progressJson(p) });
      return next("done", { import: progressJson(p), progress: null }, { title_id: p.title_id });
    }
    await ctx.progress({ progress: { step: "import", job_id: started.job_id, title_id: started.title_id, import: progressJson(p) } });
    await new Promise<void>((r) => setTimeout(r, ctx.runner.fake ? 50 : 1000));
  }
  // The registry lost the run (another process finished it, or a restart): the title exists either way.
  return next("done", { import: { title_id: started.title_id, note: "the import's progress was not followed to the end; open the title" }, progress: null }, { title_id: started.title_id });
}

/** The pipeline's quiet-period rule applies to the scanner; the fake pipeline switches it off. */
export function handoffFail(message: string): StageOutcome {
  return fail(message);
}
