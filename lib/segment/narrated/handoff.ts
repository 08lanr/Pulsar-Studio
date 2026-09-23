// The narrated run's last two stages (narrated spec N1 stages 7–8, N7; with
// amendment 5: import into the existing season title, numbering continued,
// NO rights or licence gate anywhere, no OneDrive copy).
//
//   film_meta ✋  the season's display title, the crazydramas slug and the
//                 episodes' names, written to `<film>/film-meta.json` through
//                 the project writer (the cut-only stage's `writeFilmMeta`
//                 writes directly; this one keeps the snapshot and the record).
//   handoff      `<film>/DELIVERED-narrated.json` from the gated files — values
//                read (the shipped file's SHA-256 is the one the build stored
//                on the episode row; the source's is computed once and kept
//                on the run), nothing re-derived — then the scanner's narrated
//                branch polled until READY, then `{kind: "import_now"}` starts
//                the import (into `settings.season.title_source_ref`'s title
//                when the season names one).

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { importQuietMs, startImport } from "@/lib/film-import/import";
import { NARRATED_MANIFEST_FILE, NarratedManifestSchema, type NarratedManifest } from "@/lib/film-import/manifest";
import { narratedOf, scanFilm } from "@/lib/film-import/scan";
import type { FilmRun, FilmRunDecision, FilmRunEpisode, Json } from "@/lib/types";
import { fail, next, readJson, sourceRefOf, type StageOutcome } from "../stages";
import { readGate } from "./gate";
import { narrationLines, pyLen } from "./voice";
import { dataOf, epDir, fileSha256, NARRATED_DECISION, narratedWait, pendingRunDecisions, writeProjectFile, type NarratedContext } from "./stages";

const READY_POLL_MS = 30_000;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---- film_meta ------------------------------------------------------------------------------------------------------

export type NarratedFilmMeta = {
  display_title_en: string;
  crazydramas_slug: string | null;
  language: string;
  series_key: string;
  episodes: { n: number; title: string; subtitle: string | null }[];
  intro: { src: string; ss: number; t: number } | null;
  notes: string | null;
};

/** The film-meta a decision asks for, checked; a string says why not. Pure. */
export function filmMetaFrom(data: Record<string, Json | undefined>, run: Pick<FilmRun, "lang">, eps: Pick<FilmRunEpisode, "n" | "title" | "subtitle" | "stage">[], seriesKey: string, intro: NarratedFilmMeta["intro"]): NarratedFilmMeta | string {
  const title = typeof data.display_title_en === "string" ? data.display_title_en.trim() : "";
  if (!title) return "the season needs its English display title";
  const slug = typeof data.crazydramas_slug === "string" && data.crazydramas_slug.trim() ? data.crazydramas_slug.trim() : null;
  if (slug && !SLUG.test(slug)) return "a crazydramas slug is lowercase words joined by hyphens";
  const names = new Map<number, { title?: unknown; subtitle?: unknown }>();
  if (Array.isArray(data.episodes)) for (const e of data.episodes as Record<string, unknown>[]) if (e && typeof e.n === "number") names.set(e.n, e);
  return {
    display_title_en: title,
    crazydramas_slug: slug,
    language: run.lang,
    series_key: seriesKey,
    episodes: eps
      .filter((e) => e.stage === "shipped")
      .map((e) => {
        const x = names.get(e.n);
        return { n: e.n, title: typeof x?.title === "string" && x.title.trim() ? x.title.trim() : e.title, subtitle: typeof x?.subtitle === "string" ? x.subtitle.trim() || null : e.subtitle };
      }),
    intro,
    notes: typeof data.notes === "string" && data.notes.trim() ? data.notes.trim() : null,
  };
}

export async function runNarratedFilmMetaStage(ctx: NarratedContext): Promise<StageOutcome> {
  const eps = await ctx.data.listRunEpisodes(ctx.session, ctx.run.id);
  const decision = pendingRunDecisions(ctx.run, NARRATED_DECISION.film_meta).pop() ?? null;
  const existing = readJson<NarratedFilmMeta>(path.join(ctx.paths.film, "film-meta.json"));
  if (!decision) return narratedWait("film_meta", { film_meta: (existing as unknown as Json) ?? null, film_meta_default: { display_title_en: ctx.settings.season.series_title ?? ctx.run.slug, crazydramas_slug: null, episodes: eps.filter((e) => e.stage === "shipped").map((e) => ({ n: e.n, title: e.title, subtitle: e.subtitle })) } as unknown as Json });
  const meta = filmMetaFrom(dataOf(decision), ctx.run, eps, ctx.settings.season.series_key ?? ctx.run.slug, ctx.settings.intro);
  if (typeof meta === "string") return narratedWait("film_meta", { film_meta_error: meta, film_meta: (existing as unknown as Json) ?? null });
  writeProjectFile(ctx, "film-meta.json", `${JSON.stringify(meta, null, 1)}\n`, { by: decision.by, why: "the season's titles and slug (film_meta)", decision_at: decision.at });
  return next("handoff", { film_meta: meta as unknown as Json, decisions_seen: ctx.run.decisions.length });
}

// ---- the manifest ----------------------------------------------------------------------------------------------------

/** SHA-256 of a large file, streamed. */
export function streamSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

function countOf(file: string, pick: (j: unknown) => number): number {
  const j = readJson<unknown>(file);
  return j === null ? 0 : pick(j);
}

const entries = (j: unknown): number => (Array.isArray(j) ? j.length : j && typeof j === "object" ? Object.keys(j as object).length : 0);

/** The pieces the built base was cut from (`epN/base.mp4.pieces.json`), as the manifest lists them. */
export function piecesOf(epFolder: string): { id: string; src_in: number; src_out: number; mode: string }[] {
  const j = readJson<{ pieces?: { id?: unknown; src_in?: unknown; src_out?: unknown; mode?: unknown }[] }>(path.join(epFolder, "base.mp4.pieces.json"));
  if (!j || !Array.isArray(j.pieces)) return [];
  return j.pieces.map((p, i) => ({ id: typeof p.id === "string" || typeof p.id === "number" ? String(p.id) : `P${i + 1}`, src_in: Number(p.src_in ?? 0), src_out: Number(p.src_out ?? 0), mode: typeof p.mode === "string" ? p.mode : "kept" }));
}

/**
 * `DELIVERED-narrated.json` for the shipped episodes of the run (N7), from
 * the files on disk and the rows — never a recomputed plan. Throws when a
 * shipped episode lost its file.
 */
export async function buildNarratedManifest(ctx: NarratedContext, eps: FilmRunEpisode[], sourceSha: string | null): Promise<NarratedManifest> {
  const shipped = eps.filter((e) => e.stage === "shipped").sort((a, b) => a.n - b.n);
  const project = sourceRefOf(ctx.run);
  const out: NarratedManifest["episodes"] = [];
  let intro: number | null = null;
  for (const e of shipped) {
    if (!e.variant || !e.shipped_sha256) throw new Error(`ep${e.n} is shipped with no variant or hash on its row`);
    const ep = epDir(e.n);
    const epFolder = path.join(ctx.paths.film, ep);
    const variantRel = `${ep}/variants/${e.variant}`;
    const variantDir = path.join(ctx.paths.film, ...variantRel.split("/"));
    const fileRel = `${variantRel}/${ep}.mp4`;
    const file = path.join(ctx.paths.film, ...fileRel.split("/"));
    if (!existsSync(file)) throw new Error(`${fileRel} is not there any more`);
    const facts = await ctx.runner.probe(file);
    if (intro === null && existsSync(path.join(variantDir, "intro.mp4"))) intro = (await ctx.runner.probe(path.join(variantDir, "intro.mp4")))?.duration_s ?? null;
    const gate = readGate(variantDir, e.n);
    const nf = path.join(epFolder, "narration.json");
    const manifest = readJson<{ voice?: unknown; model?: unknown }>(path.join(epFolder, "narration", "manifest.json"));
    const lines = narrationLines(nf);
    out.push({
      n: e.n,
      project,
      variant: e.variant,
      file: fileRel,
      sha256: e.shipped_sha256,
      bytes: statSync(file).size,
      duration_s: facts?.duration_s ?? null,
      frames: facts?.frames ?? null,
      title: e.title,
      subtitle: e.subtitle,
      srt: existsSync(path.join(variantDir, `${ep}.srt`)) ? `${variantRel}/${ep}.srt` : null,
      ass: existsSync(path.join(variantDir, `${ep}.ass`)) ? `${variantRel}/${ep}.ass` : null,
      gate: { ...(gate?.counts ?? e.gate ?? { PASS: 0, WARN: 0, FAIL: 0 }), file: gate ? `${variantRel}/${ep}.mp4.gate.json` : null },
      user_review: existsSync(path.join(variantDir, "USER-REVIEW.md")) ? `${variantRel}/USER-REVIEW.md` : null,
      pieces: piecesOf(epFolder),
      narration: existsSync(nf) ? { file: `${ep}/narration.json`, sha256: fileSha256(nf), lines: lines.length, chars: lines.reduce((s, l) => s + pyLen(l.text), 0), voice: typeof manifest?.voice === "string" ? manifest.voice : null, model: typeof manifest?.model === "string" ? manifest.model : null } : null,
      // The build refuses unless frame_claims and cut_joins status pass, so a shipped episode has none unwaived.
      frame_check: { lines: countOf(path.join(epFolder, "review", "frame_check.json"), entries), contradicted_unwaived: 0 },
      cut_joins: { joins: countOf(path.join(epFolder, "review", "cut_joins.json"), entries), lost_unwaived: 0 },
      approved_by: e.approved_by,
      approved_at: e.approved_at,
    });
  }
  const m = {
    route: "skip-through" as const,
    version: 1 as const,
    series_key: ctx.settings.season.series_key ?? ctx.run.slug,
    title_source_ref: ctx.settings.season.title_source_ref,
    source: { file: "source/original.mp4", sha256: sourceSha, duration_s: (ctx.run.stage_detail as { source?: { duration_s?: number } }).source?.duration_s ?? null },
    lang: ctx.run.lang,
    caption_lang: "en",
    intro_s: intro,
    drama_remix_sha: ctx.run.drama_remix_sha,
    episodes: out,
  };
  return NarratedManifestSchema.parse(m);
}

// ---- handoff -----------------------------------------------------------------------------------------------------------

/** The newest `import_now` since the film-meta decision this hand-off follows, seen or not (as the cut-only importNowSince). Pure. */
export function narratedImportNowSince(run: Pick<FilmRun, "decisions">): FilmRunDecision | null {
  let latest: FilmRunDecision | null = null;
  for (const d of run.decisions) {
    if (d.action === NARRATED_DECISION.film_meta) latest = null;
    else if (d.action === NARRATED_DECISION.import_now && (d.ep === undefined || d.ep === null)) latest = d;
  }
  return latest;
}

export async function runNarratedHandoffStage(ctx: NarratedContext): Promise<StageOutcome> {
  const eps = await ctx.data.listRunEpisodes(ctx.session, ctx.run.id);
  if (!eps.some((e) => e.stage === "shipped")) return fail("no shipped episode to deliver");
  const detail = ctx.run.stage_detail as { source_sha256?: unknown };
  let sourceSha = typeof detail.source_sha256 === "string" ? detail.source_sha256 : null;
  if (!sourceSha && existsSync(ctx.paths.source)) {
    sourceSha = await streamSha256(ctx.paths.source);
    await ctx.progress({ source_sha256: sourceSha }, { force: true });
  }
  const manifestFile = path.join(ctx.paths.film, NARRATED_MANIFEST_FILE);
  let manifest: NarratedManifest;
  try {
    manifest = await buildNarratedManifest(ctx, eps, sourceSha);
  } catch (e) {
    return fail(`the delivery manifest cannot be written: ${(e as Error).message}`);
  }
  const text = `${JSON.stringify(manifest, null, 1)}\n`;
  if (!existsSync(manifestFile) || readFileSync(manifestFile, "utf8") !== text) {
    writeProjectFile(ctx, NARRATED_MANIFEST_FILE, text, { by: "studio", why: `the narrated delivery of ep${manifest.episodes[0].n}–ep${manifest.episodes[manifest.episodes.length - 1].n} (N7)` });
  }

  const quiet = ctx.scripts.fake ? 0 : importQuietMs();
  const scan = await scanFilm(sourceRefOf(ctx.run), { root: ctx.paths.projects, ...(quiet !== undefined ? { quietMs: quiet } : {}) });
  const facts = narratedOf(scan);
  const scanJson = { state: scan.state, reason: (scan.reason as unknown as Json) ?? null, problems: facts?.problems ?? [], episodes: scan.totals.count } as unknown as Json;
  const ready = scan.state === "READY" || scan.state === "IMPORTED" || scan.state === "K_CHANGED";
  const importNow = narratedImportNowSince(ctx.run);
  if (!ready) return narratedWait("ready", { scan: scanJson, manifest: NARRATED_MANIFEST_FILE }, ctx.scripts.fake ? 200 : READY_POLL_MS);
  if (!importNow) return narratedWait("import", { scan: scanJson, manifest: NARRATED_MANIFEST_FILE });

  const sys = systemSession();
  const ref = ctx.settings.season.title_source_ref ?? sourceRefOf(ctx.run);
  const existing = await getData().findTitleBySourceRef(sys, ctx.run.producer_id, ref).catch(() => null);
  try {
    const started = await startImport(sys, { source_ref: sourceRefOf(ctx.run), mode: existing ? "update" : "import", attach_transcript: true, display_title: readJson<{ display_title_en?: string }>(path.join(ctx.paths.film, "film-meta.json"))?.display_title_en ?? null }, { producer_id: ctx.run.producer_id, created_by: ctx.run.created_by ?? sys.userId }, { root: ctx.paths.projects, ...(ctx.scripts.fake ? { quietMs: 0 } : {}) });
    return next("done", { import: { job_id: started.job_id, title_id: started.title_id } as unknown as Json, decisions_seen: ctx.run.decisions.length }, { title_id: started.title_id });
  } catch (e) {
    // The narrated import (the .srt as the episode script, numbering from n, the season title) lands with the import's own change; until then its refusal is shown here.
    return narratedWait("import", { scan: scanJson, import_error: (e as Error).message });
  }
}
