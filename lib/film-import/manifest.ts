// Parsers for the pipeline's files (decision 2026-09-22, "the workspace
// import"): zod schemas written against the real files of Mafia King, He
// Hated All Women and Reclaiming Her World (read 2026-09-23), the rule for
// picking the newest delivered plan, the merge of split vision records, the
// band-fix notes, and `loadFilmIndex`, which reads one film's whole index
// through an injected file system. Nothing here opens `cut/eps/*.mp4`.
//
// Lenient where the files are: unknown keys pass through (the pipeline adds
// fields between deliveries), optional ones read as null, a verdict's
// `fault` may be an empty string, `better_t` an int. Strict where it
// matters: a plan must have contiguous episodes 1..N, each `start` equal to
// the previous `end`; an exclusion must be a forward window.

import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type {
  BoundaryNote,
  CandidatesIndex,
  DeliveredPlan,
  FilmIndex,
  FilmMeta,
  MotionIndex,
  ScanFs,
  SourceFacts,
  VisionBoundary,
  WhisperIndex,
} from "./types";

// ---- the plan ------------------------------------------------------------------------------

const EpisodeSchema = z.object({
  n: z.number().int().positive(),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  dur: z.number().nonnegative(),
  ends_after_line: z.string(),
  next_opens_on: z.string(),
});

export const DeliveredPlanSchema = z
  .object({
    source_duration: z.number().positive(),
    target: z.number().positive(),
    fps: z.number().positive().nullish(),
    band: z.tuple([z.number(), z.number()]),
    pinned: z.number().int().nonnegative().nullish(),
    pin_from: z.string().nullish(),
    moves: z.array(z.object({ from: z.number(), to: z.number() }).passthrough()).nullish(),
    final_end_is_boundary: z.boolean().nullish(),
    episodes: z.array(EpisodeSchema).min(1),
  })
  .passthrough()
  .superRefine((plan, ctx) => {
    plan.episodes.forEach((ep, i) => {
      if (ep.n !== i + 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["episodes", i, "n"], message: `episode ${i + 1} is numbered ${ep.n}` });
      if (ep.end <= ep.start) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["episodes", i, "end"], message: `episode ${ep.n} ends before it starts` });
      const prevEnd = i === 0 ? 0 : plan.episodes[i - 1].end;
      if (Math.abs(ep.start - prevEnd) > 0.0015) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["episodes", i, "start"], message: `episode ${ep.n} starts at ${ep.start}, the previous ends at ${prevEnd}` });
      }
    });
  });

export function parseDeliveredPlan(json: unknown): DeliveredPlan {
  const p = DeliveredPlanSchema.parse(json);
  return {
    source_duration: p.source_duration,
    target: p.target,
    fps: p.fps ?? null,
    band: p.band,
    pinned: p.pinned ?? null,
    pin_from: p.pin_from ?? null,
    moves: (p.moves ?? []).map((m) => ({ from: m.from, to: m.to })),
    final_end_is_boundary: p.final_end_is_boundary ?? null,
    episodes: p.episodes.map((e) => ({ ...e })),
  };
}

/** `cuts-0-<end>-DELIVERED.json`, exactly (the pipeline's own name; `cut_episodes.py` writes `%.3f` with trailing zeros stripped). */
export const DELIVERED_FILE = /^cuts-0-(\d+(?:\.\d+)?)-DELIVERED\.json$/;

/**
 * The newest plan among the names of `review/`: the largest numeric end,
 * never the lexicographic one (`cuts-0-900` sorts after `cuts-0-5959.067`
 * as text). Superseded copies live in `review/superseded/` under a dated
 * name and never match.
 */
export function pickNewestDelivered(names: string[]): { file: string; end: number } | null {
  let best: { file: string; end: number } | null = null;
  for (const name of names) {
    const m = name.match(DELIVERED_FILE);
    if (!m) continue;
    const end = Number(m[1]);
    if (!Number.isFinite(end)) continue;
    if (!best || end > best.end) best = { file: name, end };
  }
  return best;
}

// ---- index/ ----------------------------------------------------------------------------------

const WordSchema = z.object({ w: z.string(), s: z.number(), e: z.number(), p: z.number() }).passthrough();
const SegmentSchema = z.object({ start: z.number(), end: z.number(), text: z.string(), words: z.array(WordSchema).default([]) }).passthrough();

export const WhisperSchema = z
  .object({
    language: z.string(),
    duration: z.number(),
    model: z.string(),
    threads: z.number().nullish(),
    segments: z.array(SegmentSchema),
  })
  .passthrough();

export function parseWhisper(json: unknown): WhisperIndex {
  const w = WhisperSchema.parse(json);
  return {
    language: w.language,
    duration: w.duration,
    model: w.model,
    threads: w.threads ?? null,
    segments: w.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, words: s.words.map((x) => ({ w: x.w, s: x.s, e: x.e, p: x.p })) })),
  };
}

/** `index/scdet.txt`: one shot-cut time per line. Blank lines are skipped; a non-number is an error. */
export function parseScdet(text: string): number[] {
  const out: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const t = Number(line);
    if (!Number.isFinite(t) || t < 0) throw new Error(`scdet.txt: not a time: "${line}"`);
    out.push(t);
  }
  for (let i = 1; i < out.length; i++) if (out[i] < out[i - 1]) throw new Error(`scdet.txt: not ascending at ${out[i]}`);
  return out;
}

export const MotionSchema = z
  .object({
    fps: z.number().positive(),
    width: z.number().nullish(),
    from: z.number().nullish(),
    to: z.number().nullish(),
    threshold: z.number(),
    percentile: z.number().nullish(),
    beats: z.array(z.object({ t: z.number(), energy: z.number() }).passthrough()),
    track: z.array(z.number()).nullish(),
  })
  .passthrough();

export function parseMotion(json: unknown): MotionIndex {
  const m = MotionSchema.parse(json);
  return {
    fps: m.fps,
    width: m.width ?? null,
    from: m.from ?? null,
    to: m.to ?? null,
    threshold: m.threshold,
    percentile: m.percentile ?? null,
    beats: m.beats.map((b) => ({ t: b.t, energy: b.energy })),
    track: m.track ?? null,
  };
}

const CandidateSchema = z
  .object({
    t: z.number(),
    in_action: z.boolean(),
    motion: z.number(),
    since_action: z.number(),
    until_action: z.number(),
    action_energy: z.number(),
    gap_before: z.number(),
    gap_after: z.number(),
    settle: z.number(),
    line_before: z.string(),
    line_after: z.string(),
    line_before_end: z.number(),
    line_after_start: z.number(),
    exception: z.string().nullish(),
  })
  .passthrough();

export const CandidatesSchema = z
  .object({
    source_whisper: z.string().nullish(),
    shot_cuts: z.number().int(),
    legal: z.number().int(),
    rejected: z.record(z.number()).default({}),
    min_clear: z.number(),
    allowed: z.array(z.object({ t: z.number(), why: z.string() }).passthrough()).nullish(),
    beats_used: z.number().nullish(),
    candidates: z.array(CandidateSchema),
  })
  .passthrough();

export function parseCandidates(json: unknown): CandidatesIndex {
  const c = CandidatesSchema.parse(json);
  return {
    source_whisper: c.source_whisper ?? null,
    shot_cuts: c.shot_cuts,
    legal: c.legal,
    rejected: c.rejected,
    min_clear: c.min_clear,
    allowed: (c.allowed ?? []).map((a) => ({ t: a.t, why: a.why })),
    beats_used: c.beats_used ?? null,
    candidates: c.candidates.map((x) => ({
      t: x.t,
      in_action: x.in_action,
      motion: x.motion,
      since_action: x.since_action,
      until_action: x.until_action,
      action_energy: x.action_energy,
      gap_before: x.gap_before,
      gap_after: x.gap_after,
      settle: x.settle,
      line_before: x.line_before,
      line_after: x.line_after,
      line_before_end: x.line_before_end,
      line_after_start: x.line_after_start,
      exception: x.exception ?? null,
    })),
  };
}

export const SourceFactsSchema = z
  .object({
    source: z.string().nullish(),
    fps: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    duration: z.number().positive(),
  })
  .passthrough();

export function parseSourceFacts(json: unknown): SourceFacts {
  const s = SourceFactsSchema.parse(json);
  return { source: s.source ?? null, fps: s.fps, width: s.width, height: s.height, duration: s.duration };
}

// ---- review/vision -----------------------------------------------------------------------------

const PickSchema = z
  .object({
    chosen_key: z.string(),
    chosen_t: z.number(),
    ends_on: z.string(),
    opens_on: z.string(),
    why: z.string(),
    payoff_in_episode: z.boolean(),
    confidence: z.number(),
    rejected: z.string().nullish(),
  })
  .passthrough();

const VerdictSchema = z
  .object({
    agree: z.boolean(),
    reason: z.string().default(""),
    fault: z.string().nullish(),
    better_key: z.string().nullish(),
    better_t: z.number().nullish(),
  })
  .passthrough();

const VisionResultSchema = z.object({ boundary_s: z.number(), pick: PickSchema, verdict: VerdictSchema.nullish() }).passthrough();

/** A pick-by-eye record file: the Workflow's output with a `result` array (the other keys are run bookkeeping). */
export const VisionRecordFileSchema = z.object({ result: z.array(VisionResultSchema) }).passthrough();

/** True when a `review/vision/*.json` name says the record was replaced (Mafia King keeps its first 0-900 pass as `_superseded`). */
export function isSupersededVisionFile(name: string): boolean {
  return /superseded/i.test(name);
}

/** True when the JSON is a record file (has `result[]`), as opposed to an applied options file (`boundaries[]`) kept in the same folder. */
export function isVisionRecordJson(json: unknown): boolean {
  return typeof json === "object" && json !== null && Array.isArray((json as { result?: unknown }).result);
}

export function parseVisionRecordFile(json: unknown, sourceFile: string): VisionBoundary[] {
  const file = VisionRecordFileSchema.parse(json);
  return file.result.map((r) => ({
    boundary_s: r.boundary_s,
    pick: {
      chosen_key: r.pick.chosen_key,
      chosen_t: r.pick.chosen_t,
      ends_on: r.pick.ends_on,
      opens_on: r.pick.opens_on,
      why: r.pick.why,
      payoff_in_episode: r.pick.payoff_in_episode,
      confidence: r.pick.confidence,
      rejected: r.pick.rejected ?? null,
    },
    verdict: r.verdict
      ? {
          agree: r.verdict.agree,
          reason: r.verdict.reason,
          fault: r.verdict.fault ?? null,
          better_key: r.verdict.better_key ?? null,
          better_t: r.verdict.better_t ?? null,
        }
      : null,
    source_file: sourceFile,
  }));
}

const keyOf = (t: number) => Math.round(t * 1000);

/**
 * The film's judged boundaries from every record file, in file order,
 * deduped by `chosen_t` (a later file wins: the checkpoint and the
 * 1936.533-end pass of Mafia King re-judged nothing, but a re-run for
 * faulted boundaries would). Superseded files and non-record JSON are
 * skipped by name and shape; the caller decides the order (sorted by name
 * is the pipeline's own chronology: `2026-09-22a…`, `b…`, `c…`).
 */
export function mergeVisionRecords(files: { name: string; json: unknown }[]): { boundaries: VisionBoundary[]; skipped: string[] } {
  const byChosen = new Map<number, VisionBoundary>();
  const skipped: string[] = [];
  for (const f of files) {
    if (isSupersededVisionFile(f.name) || !isVisionRecordJson(f.json)) {
      skipped.push(f.name);
      continue;
    }
    for (const b of parseVisionRecordFile(f.json, f.name)) byChosen.set(keyOf(b.pick.chosen_t), b);
  }
  const boundaries = [...byChosen.values()].sort((a, b) => a.pick.chosen_t - b.pick.chosen_t);
  return { boundaries, skipped };
}

// ---- band-fix notes ----------------------------------------------------------------------------

/**
 * The boundary times a band-fix note set by hand, with the paragraph that
 * says so. The notes are prose; what marks a moved boundary is one of the
 * pipeline's own phrasings: `A -> B`, `back to its DP pick B`, `back to B`,
 * `goes to the first reviewer's B`. A kept pick ("keep 1194.0") and a
 * skeptic pick taken via `--allow` ("takes the skeptic's 5298.0") are vision
 * decisions and are not matched.
 */
export function parseBandFixNotes(markdown: string): { t: number; note: string }[] {
  const out: { t: number; note: string }[] = [];
  const paragraphs = markdown.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const rule = /(?:->|back to(?: its DP pick)?|goes to the first reviewer's)\s*(\d+(?:\.\d+)?)/g;
  for (const note of paragraphs) {
    for (const m of note.matchAll(rule)) {
      const t = Number(m[1]);
      if (Number.isFinite(t) && !out.some((x) => keyOf(x.t) === keyOf(t))) out.push({ t, note });
    }
  }
  return out;
}

/**
 * One note per delivered episode end: which record explains it. The
 * band-fix note wins over a matching vision pick (He Hated All Women's
 * 6612.3 is the first reviewer's time, applied by a person after the skeptic
 * had disagreed), then the reviewer's `chosen_t`, then the skeptic's
 * `better_t`, then a move the plan itself declares (`moves[].to`: a QA
 * re-pin moved the boundary to an ordinary legal candidate, which needs no
 * `--allow` and no new vision record — He Hated All Women's ep29 end went
 * 3276.333 -> 3278.3 on 2026-09-23; the note carries the record that judged
 * the time it moved FROM); an end no record and no move names is `none`.
 */
export function explainBoundaries(plan: DeliveredPlan, vision: VisionBoundary[], bandFix: { t: number; note: string }[]): BoundaryNote[] {
  const byChosen = new Map(vision.map((v) => [keyOf(v.pick.chosen_t), v]));
  const byBetter = new Map<number, VisionBoundary>();
  for (const v of vision) if (v.verdict?.better_t != null) byBetter.set(keyOf(v.verdict.better_t), v);
  const fixes = new Map(bandFix.map((f) => [keyOf(f.t), f.note]));
  const byMove = new Map(plan.moves.map((m) => [keyOf(m.to), m]));
  return plan.episodes.slice(0, -1).map((ep) => {
    const k = keyOf(ep.end);
    const fix = fixes.get(k);
    const chosen = byChosen.get(k) ?? null;
    const better = byBetter.get(k) ?? null;
    const move = byMove.get(k) ?? null;
    if (fix !== undefined) return { n: ep.n, end: ep.end, decision: "band_fix", vision: chosen ?? better, band_fix_note: fix, move };
    if (chosen) return { n: ep.n, end: ep.end, decision: "chosen", vision: chosen, band_fix_note: null, move };
    if (better) return { n: ep.n, end: ep.end, decision: "skeptic", vision: better, band_fix_note: null, move };
    if (move) {
      const from = keyOf(move.from);
      return { n: ep.n, end: ep.end, decision: "qa_move", vision: byChosen.get(from) ?? byBetter.get(from) ?? null, band_fix_note: null, move };
    }
    return { n: ep.n, end: ep.end, decision: "none", vision: null, band_fix_note: null, move: null };
  });
}

// ---- film-meta.json ------------------------------------------------------------------------------

const ExclusionSchema = z
  .object({
    from_s: z.number().nonnegative(),
    to_s: z.number().positive(),
    why: z.string().min(1),
    kind: z.string().nullish(),
  })
  .refine((x) => x.to_s > x.from_s, { message: "to_s must be after from_s" });

export const FilmMetaSchema = z
  .object({
    display_title_en: z.string().min(1),
    source_title_en: z.string().nullish(),
    crazydramas_slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a crazydramas slug is lowercase words joined by hyphens")
      .nullish(),
    language: z.string().min(2),
    spoiler_from_s: z.number().nonnegative().nullish(),
    exclusions: z.array(ExclusionSchema).default([]),
    live_poster: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .passthrough();

export function parseFilmMeta(json: unknown): FilmMeta {
  const m = FilmMetaSchema.parse(json);
  return {
    display_title_en: m.display_title_en,
    source_title_en: m.source_title_en ?? null,
    crazydramas_slug: m.crazydramas_slug ?? null,
    language: m.language,
    spoiler_from_s: m.spoiler_from_s ?? null,
    exclusions: m.exclusions.map((e) => ({ from_s: e.from_s, to_s: e.to_s, why: e.why, kind: e.kind ?? null })),
    live_poster: m.live_poster ?? null,
    notes: m.notes ?? null,
  };
}

// ---- reading one film ----------------------------------------------------------------------------

export const POSTER_FILE = /\.(jpe?g|png)$/i;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A path under the workspace as a source ref: relative to the root, forward slashes. */
export function toSourceRef(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

async function readJson(fs: ScanFs, file: string): Promise<unknown> {
  const text = await fs.readFile(file);
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

async function optional<T>(fs: ScanFs, file: string, parse: (text: string) => T, problems: string[], label: string): Promise<T | null> {
  if (!(await fs.stat(file))) return null;
  try {
    return parse(await fs.readFile(file));
  } catch (e) {
    problems.push(`${label}: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
}

const parseJsonText = <T>(parse: (json: unknown) => T) => (text: string) => parse(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));

/** The names under `review/vision/` that hold a JSON record, sorted (the pipeline's own chronology). */
export async function listVisionFiles(fs: ScanFs, cutDir: string): Promise<string[]> {
  const dir = path.join(cutDir, "review", "vision");
  if (!(await fs.stat(dir))) return [];
  return (await fs.readdir(dir))
    .filter((d) => d.kind === "file" && d.name.toLowerCase().endsWith(".json"))
    .map((d) => d.name)
    .sort();
}

/** The `*.md` notes under `review/vision/`, sorted. */
export async function listBandFixFiles(fs: ScanFs, cutDir: string): Promise<string[]> {
  const dir = path.join(cutDir, "review", "vision");
  if (!(await fs.stat(dir))) return [];
  return (await fs.readdir(dir))
    .filter((d) => d.kind === "file" && d.name.toLowerCase().endsWith(".md"))
    .map((d) => d.name)
    .sort();
}

/** `poster/final/*.jpg|png` of a film as source refs, sorted by name (the film folder, not `cut/`: that is where the pipeline keeps them). */
export async function listPosters(fs: ScanFs, root: string, filmDir: string): Promise<string[]> {
  const dir = path.join(filmDir, "poster", "final");
  if (!(await fs.stat(dir))) return [];
  return (await fs.readdir(dir))
    .filter((d) => d.kind === "file" && POSTER_FILE.test(d.name))
    .map((d) => toSourceRef(root, path.join(dir, d.name)))
    .sort();
}

/**
 * Everything the import needs from one film, parsed. Throws when there is no
 * plan or it does not parse (the scanner reports those states before the
 * import is offered); every other file is optional and a broken one is a
 * problem, not a failure.
 */
export async function loadFilmIndex(fs: ScanFs, root: string, sourceRef: string): Promise<FilmIndex> {
  const filmDir = path.join(root, ...sourceRef.split("/"));
  const cutDir = path.join(filmDir, "cut");
  const review = path.join(cutDir, "review");
  const index = path.join(cutDir, "index");
  const problems: string[] = [];

  const reviewNames = (await fs.stat(review)) ? (await fs.readdir(review)).filter((d) => d.kind === "file").map((d) => d.name) : [];
  const newest = pickNewestDelivered(reviewNames);
  if (!newest) throw new Error(`${sourceRef}: no review/cuts-0-*-DELIVERED.json`);
  const planBytes = await fs.readBytes(path.join(review, newest.file));
  const plan = parseDeliveredPlan(JSON.parse(Buffer.from(planBytes).toString("utf8").replace(/^﻿/, "")));

  const whisper = await optional(fs, path.join(index, "whisper.json"), parseJsonText(parseWhisper), problems, "index/whisper.json");
  const shotCuts = await optional(fs, path.join(index, "scdet.txt"), parseScdet, problems, "index/scdet.txt");
  const motion = await optional(fs, path.join(index, "motion.json"), parseJsonText(parseMotion), problems, "index/motion.json");
  const candidates = await optional(fs, path.join(index, "candidates.json"), parseJsonText(parseCandidates), problems, "index/candidates.json");
  const source = await optional(fs, path.join(index, "source.json"), parseJsonText(parseSourceFacts), problems, "index/source.json");
  const meta = await optional(fs, path.join(cutDir, "film-meta.json"), parseJsonText(parseFilmMeta), problems, "cut/film-meta.json");

  const visionFiles: { name: string; json: unknown }[] = [];
  for (const name of await listVisionFiles(fs, cutDir)) {
    try {
      visionFiles.push({ name, json: await readJson(fs, path.join(cutDir, "review", "vision", name)) });
    } catch (e) {
      problems.push(`review/vision/${name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  let vision: VisionBoundary[] = [];
  try {
    vision = mergeVisionRecords(visionFiles).boundaries;
  } catch (e) {
    problems.push(`review/vision: ${(e as Error).message.split("\n")[0]}`);
  }

  const bandFixNotes: string[] = [];
  for (const name of await listBandFixFiles(fs, cutDir)) bandFixNotes.push(await fs.readFile(path.join(cutDir, "review", "vision", name)));
  const bandFix = bandFixNotes.flatMap(parseBandFixNotes);

  return {
    source_ref: sourceRef,
    delivered: plan,
    delivered_file: `review/${newest.file}`,
    delivered_sha256: sha256Hex(planBytes),
    whisper,
    shot_cuts: shotCuts,
    motion,
    candidates,
    source,
    vision,
    band_fix_notes: bandFixNotes,
    boundaries: explainBoundaries(plan, vision, bandFix),
    meta,
    posters: await listPosters(fs, root, filmDir),
    problems,
  };
}
