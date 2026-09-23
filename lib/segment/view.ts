// The read side of a run for the screens (`stage_view`), and the route-level
// rules of the three writes a person makes on one: create a run, record a
// decision, cancel. The view reads the film folder as it is (options,
// strips, records, decisions, the plan, the QA report, film-meta, the
// scanner's state) and hands the screens URLs on the evidence route; it
// never writes. A decision is validated against that same state before it
// is appended — a move must be a legal cut in band, an apply needs every
// required decision, a join needs a delivered render — and the worker acts
// on it at its next tick.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Session } from "@/lib/auth";
import { getData, type NewFilmRun } from "@/lib/data";
import { conflict, invalid, notFound } from "@/lib/data/errors";
import { importProgress, importQuietMs, scannerProbe } from "@/lib/film-import/import";
import { parseDeliveredPlan } from "@/lib/film-import/manifest";
import { scanFilm } from "@/lib/film-import/scan";
import { visionProviderStatus } from "@/lib/llm";
import { lastLogLine } from "@/lib/segment/index";
import { loadCandidates, legalCutsNear } from "@/lib/segment/strips";
import { readLock, studioRunLock, studioRunLockPath, LockHeldError, type StudioRunLock } from "@/lib/locks";
import type { FilmRun, FilmRunSettings, Json } from "@/lib/types";
import { cutRelUrl, evidenceUrl, proxyUrl } from "./evidence";
import { defaultFilmMeta, readFilmMeta, type FilmMetaForm } from "./handoff";
import { resolveSourcePath } from "./intake";
import { lengthsAround, moveRefusal, reviewStateOf, type BoundaryReview, type ReviewState } from "./plan";
import { readQa, type QaEpisode } from "./qa";
import { readPlan } from "./render";
import { DECISION, decisionData, decisionOf, fakePipeline, isTerminal, newestDelivered, pendingDecision, readJson, runDirs, sourceFacts, sourceRefOf, visionLabel, waitingOf, type Env } from "./stages";
import { validRegion, watermarkView, isUnmarkAction, type Region } from "./watermark";

// ---- the view ------------------------------------------------------------------------------------------------------------------

export type BoundaryView = Omit<BoundaryReview, "record"> & {
  record: BoundaryReview["record"];
  options: { key: string; t: number; is_dp_pick: boolean; line_before: string | null; line_after: string | null; strip_url: string | null; tiles: number[]; cols: number; step: number }[];
  /** The legal cuts within 30 s, for the move picker. */
  legal_cuts: { t: number; line_before: string; line_after: string }[];
  proxy_url: string;
  lengths: { before: number; after: number };
  dialogue: { before: { t: number; text: string }[]; after: { t: number; text: string }[] };
};

/** The source's facts as intake recorded them on the run (else the index's source.json). */
export type SourceView = { path: string; width: number; height: number; fps: number; duration_s: number | null; bytes: number | null; placed: string | null };

export type StageView = {
  film: { source_ref: string; dir: string; cut_dir: string; exists: boolean };
  /** The film's `cut/` folder, forward slashes (the same as `film.cut_dir`). */
  cut_dir: string;
  evidence_base: string;
  waiting: ReturnType<typeof waitingOf>;
  source: SourceView | null;
  /** The film's length in seconds when known (the probe, else index/source.json). */
  duration_s: number | null;
  /** The last line of `index/whisper.log` while the index runs. */
  index_log_tail: string | null;
  /** lib/llm's frame judge: available or not, and why; the fake pipeline reports itself available. */
  vision_provider: { available: boolean; provider: string; model: string; reason: string | null };
  /** The Claude Code hand-off, once the vision stage waits for one: the exact Workflow call, the boundaries, and the `.output` file named so far. */
  handoff: { command: string; boundaries: number[]; output_file: string | null; found: boolean } | null;
  watermark: Json;
  /** review/options.json as emitted: the boundaries and their options, without the review's judgement (that is `review`). */
  options: { band: [number, number]; duration: number; applied: boolean; boundaries: { boundary_s: number; dp_pick: number | null; options: { key: string; t: number; is_dp_pick: boolean }[] }[] } | null;
  review: (Omit<ReviewState, "boundaries"> & { boundaries: BoundaryView[]; problems: string[] }) | null;
  plan: { episodes: { n: number; start: number; end: number; dur: number; file_exists: boolean; bytes: number | null; ends_after_line: string | null; next_opens_on: string | null }[]; delivered: string | null; moves: { from: number; to: number }[] } | null;
  /** The newest DELIVERED record under review/ (what a render recorded), when there is one. */
  delivered: { file: string; end: number; episodes: { n: number; start: number; end: number; dur: number }[] } | null;
  joins: { index: number; end: number; proxy_url: string }[];
  qa: (ReturnType<typeof readQa> & { sheets: (QaEpisode & { url: string | null })[] }) | null;
  film_meta: { current: Json; default: FilmMetaForm } | null;
  /** The hand-off: the scanner's state of the film folder (read at the hand-off and after), the title once imported, the import's progress. */
  import: { title_id: string | null; state: string | null; reason: string | null; progress: Json };
  run_lock: StudioRunLock | null;
};

function sourceViewOf(run: FilmRun, cut: string): SourceView | null {
  const d = (run.stage_detail as { source?: Record<string, unknown> } | null)?.source;
  if (d && typeof d.width === "number" && typeof d.height === "number" && typeof d.fps === "number") {
    return { path: run.source_path, width: d.width, height: d.height, fps: d.fps, duration_s: typeof d.duration_s === "number" ? d.duration_s : null, bytes: typeof d.bytes === "number" ? d.bytes : null, placed: typeof d.placed === "string" ? d.placed : null };
  }
  const facts = sourceFacts(cut);
  return facts ? { path: run.source_path, width: facts.width, height: facts.height, fps: facts.fps, duration_s: facts.duration, bytes: null, placed: null } : null;
}

function handoffViewOf(run: FilmRun): StageView["handoff"] {
  const h = (run.stage_detail as { handoff?: { command?: unknown; boundaries?: unknown } } | null)?.handoff;
  if (!h || typeof h.command !== "string") return null;
  const pending = pendingDecision(run, DECISION.handoff_vision);
  const named = typeof decisionData(pending).output_path === "string" ? String(decisionData(pending).output_path) : null;
  return { command: h.command, boundaries: Array.isArray(h.boundaries) ? (h.boundaries as number[]) : [], output_file: named, found: named ? existsSync(named) : false };
}

function reasonText(reason: unknown): string | null {
  if (!reason || typeof reason !== "object") return null;
  const r = reason as { code?: string; file?: string; detail?: string; missing?: number[]; planned?: number; found?: number };
  const bits = [r.code, r.file, r.detail, r.missing?.length ? `missing ${r.missing.join(", ")}` : null, r.planned !== undefined ? `planned ${r.planned}, found ${r.found}` : null].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
}

/** Everything the run screens need, read from disk; cheap enough to poll every few seconds. */
export async function stageView(run: FilmRun, env: Env = process.env): Promise<StageView> {
  const dirs = runDirs(run, env);
  const cut = dirs.cut;
  const exists = existsSync(cut);
  const status = fakePipeline(env) ? { available: true, provider: "fake", model: "fake-vision", reason: null } : visionProviderStatus(env);
  const source = exists ? sourceViewOf(run, cut) : null;
  const view: StageView = {
    film: { source_ref: sourceRefOf(run), dir: dirs.film.replace(/\\/g, "/"), cut_dir: cut.replace(/\\/g, "/"), exists },
    cut_dir: cut.replace(/\\/g, "/"),
    evidence_base: `/api/film-runs/${run.id}/evidence`,
    waiting: waitingOf(run),
    source,
    duration_s: source?.duration_s ?? null,
    index_log_tail: null,
    vision_provider: { available: status.available, provider: status.provider, model: status.model, reason: status.reason },
    handoff: handoffViewOf(run),
    watermark: null,
    options: null,
    review: null,
    plan: null,
    delivered: null,
    joins: [],
    qa: null,
    film_meta: null,
    import: { title_id: run.title_id, state: null, reason: null, progress: null },
    run_lock: exists ? readLock<StudioRunLock>(studioRunLockPath(cut)) : null,
  };
  if (!exists) return view;
  if (run.stage === "index") view.index_log_tail = lastLogLine(path.join(cut, "index", "whisper.log"));

  const wm = watermarkView(cut) as { images?: string[]; unmark?: { found?: string | null; test?: string | null } } & Record<string, Json>;
  view.watermark = { ...wm, image_urls: (wm.images ?? []).map((rel) => cutRelUrl(run.id, rel)).filter((u): u is string => !!u), unmark_urls: { found: wm.unmark?.found ? cutRelUrl(run.id, wm.unmark.found) : null, test: wm.unmark?.test ? cutRelUrl(run.id, wm.unmark.test) : null } } as Json;

  if (existsSync(path.join(cut, "review", "options.json"))) {
    try {
      const { doc, state, problems } = await reviewStateOf({ run, dirs });
      view.options = { band: doc.band, duration: doc.duration, applied: !!doc.applied, boundaries: doc.boundaries.map((b) => ({ boundary_s: b.boundary_s, dp_pick: b.dp_pick ?? null, options: b.options.map((o) => ({ key: o.key, t: o.t, is_dp_pick: o.is_dp_pick === true })) })) };
      const candidates = await loadCandidates(cut);
      const byKey = new Map(doc.boundaries.map((b) => [Math.round(b.boundary_s * 1000), b]));
      const boundaries: BoundaryView[] = state.boundaries.map((b) => {
        const entry = byKey.get(Math.round(b.boundary_s * 1000))!;
        return {
          ...b,
          options: entry.options.map((o) => ({ key: o.key, t: o.t, is_dp_pick: o.is_dp_pick === true, line_before: o.line_before ?? null, line_after: o.line_after ?? null, strip_url: o.strip ? cutRelUrl(run.id, o.strip) : null, tiles: o.strip_tiles ?? [], cols: doc.strip?.cols ?? 6, step: doc.strip?.step ?? 0.5 })),
          legal_cuts: legalCutsNear(candidates, b.boundary_s).map((c) => ({ t: c.t, line_before: c.line_before, line_after: c.line_after })),
          proxy_url: proxyUrl(run.id, b.current_t),
          lengths: lengthsAround(state, b.boundary_s, b.current_t),
          dialogue: { before: entry.before.map((l) => ({ t: l.t, text: l.text })), after: entry.after.map((l) => ({ t: l.t, text: l.text })) },
        };
      });
      const { boundaries: _drop, ...rest } = state;
      view.review = { ...rest, boundaries, problems };
    } catch (e) {
      view.review = null;
      view.watermark = { ...(view.watermark as Record<string, Json>), review_error: (e as Error).message } as Json;
    }
  }

  const plan = readPlan(cut);
  if (plan) {
    const eps = path.join(cut, "eps");
    view.plan = {
      episodes: plan.episodes.map((e) => {
        const file = path.join(eps, `ep${String(e.n).padStart(2, "0")}.mp4`);
        let bytes: number | null = null;
        try {
          bytes = statSync(file).size;
        } catch {
          bytes = null;
        }
        return { n: e.n, start: e.start, end: e.end, dur: e.dur, file_exists: bytes !== null, bytes, ends_after_line: e.ends_after_line ?? null, next_opens_on: e.next_opens_on ?? null };
      }),
      delivered: plan.pin_from ?? null,
      moves: plan.moves,
    };
    view.joins = plan.episodes.slice(0, -1).map((e) => ({ index: e.n, end: e.end, proxy_url: proxyUrl(run.id, e.end) }));
  }

  const newest = newestDelivered(cut);
  if (newest) {
    const raw = readJson(path.join(cut, "review", newest.file));
    try {
      const d = raw ? parseDeliveredPlan(raw) : null;
      if (d) view.delivered = { file: `review/${newest.file}`, end: newest.end, episodes: d.episodes.map((e) => ({ n: e.n, start: e.start, end: e.end, dur: e.dur })) };
    } catch {
      view.delivered = null;
    }
  }

  const qa = readQa(cut);
  if (qa) view.qa = { ...qa, sheets: qa.episodes.map((e) => ({ ...e, url: e.sheet ? cutRelUrl(run.id, e.sheet) : null })) };

  if (plan || readFilmMeta(cut)) view.film_meta = { current: (readFilmMeta(cut) as unknown as Json) ?? null, default: defaultFilmMeta(run, cut) };
  const progress = importProgress(run.producer_id, sourceRefOf(run));
  let scanState: { state: string; reason: string | null } | null = null;
  if (run.stage === "handoff" || run.stage === "done") {
    const quiet = fakePipeline(env) ? 0 : importQuietMs();
    scanState = await scanFilm(sourceRefOf(run), { root: dirs.root, ...(quiet !== undefined ? { quietMs: quiet } : {}), probe: scannerProbe, linkDir: dirs.work })
      .then((s) => ({ state: s.state, reason: reasonText(s.reason) }))
      .catch((e: Error) => ({ state: "NO_MANIFEST", reason: e.message }));
  }
  view.import = { title_id: run.title_id, state: scanState?.state ?? null, reason: scanState?.reason ?? null, progress: (progress as unknown as Json) ?? null };
  return view;
}

// ---- create ---------------------------------------------------------------------------------------------------------------------

export type CreateRunInput = {
  producer_id: string;
  source_path: string;
  bucket: string;
  slug: string;
  mode: FilmRun["mode"];
  lang?: string | null;
  settings?: FilmRunSettings | null;
};

/** The run a staff administrator starts: the source must be a file under a picker root; one live run per film folder. */
export async function createRun(session: Session, input: CreateRunInput, env: Env = process.env): Promise<FilmRun> {
  const abs = resolveSourcePath(input.source_path, env);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw invalid(`${abs} is not a file`);
  const data = getData();
  const live = (await data.listFilmRuns(session)).find((r) => r.bucket === input.bucket && r.slug === input.slug && !isTerminal(r.stage));
  if (live) throw conflict(`run ${live.id} is already driving ${input.bucket}/${input.slug} (stage ${live.stage}); cancel it first or choose another slug`);
  const row: NewFilmRun = { producer_id: input.producer_id, source_path: abs, bucket: input.bucket, slug: input.slug, mode: input.mode, lang: input.lang ?? "en", settings: input.settings ?? {} };
  return data.createFilmRun(session, row);
}

// ---- decide ----------------------------------------------------------------------------------------------------------------------

export type DecisionInput =
  | { kind: "watermark"; accept?: boolean; region?: Region; no_delogo?: boolean }
  | { kind: "unmark"; action: string; boxes?: string | null }
  | { kind: "cards"; templates: number[] }
  | { kind: "boundary"; boundary_s: number; action: "accept" | "move" | "reject" | "remove"; to_t?: number | null; reason?: string | null }
  | { kind: "apply_review" }
  | { kind: "join"; join_index: number; to_t: number; reason?: string | null }
  | { kind: "film_meta"; display_title_en: string; crazydramas_slug?: string | null; spoiler_from_s?: number | null; exclusions?: FilmMetaForm["exclusions"]; live_poster?: string | null }
  | { kind: "import_now" }
  | { kind: "handoff_vision"; output_path?: string | null }
  | { kind: "retry" }
  | { kind: "note"; text: string };

function requireStage(run: FilmRun, ...stages: FilmRun["stage"][]): void {
  if (!stages.includes(run.stage)) throw conflict(`the run is at ${run.stage}; this decision belongs to ${stages.join(" / ")}`);
}

/** Validate a decision against the run and the film as they are, append it; the worker acts on it. */
export async function decideRun(session: Session, runId: string, input: DecisionInput, env: Env = process.env): Promise<FilmRun> {
  const data = getData();
  const run = await data.getFilmRun(session, runId);
  if (isTerminal(run.stage) && input.kind !== "retry" && input.kind !== "note") throw conflict(`the run is ${run.stage}`);
  const by = session.displayName || session.userId;
  const dirs = runDirs(run, env);

  switch (input.kind) {
    case "watermark": {
      requireStage(run, "watermark");
      if (input.no_delogo) return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.no_logo, { by, why: "the film has no logo: render with --no-delogo" }));
      if (input.region) {
        if (!validRegion(input.region)) throw invalid("region must be {x, y, w, h} fractions of the frame, inside it");
        return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.watermark_region, { by, data: { region: input.region as unknown as Json } }));
      }
      if (input.accept) {
        if (!existsSync(path.join(dirs.cut, "index", "watermark.json"))) throw conflict("there is no box to accept yet");
        return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.watermark_accept, { by }));
      }
      throw invalid("a watermark decision is accept, a region, or no_delogo");
    }
    case "unmark": {
      requireStage(run, "watermark");
      if (!isUnmarkAction(input.action)) throw invalid("unmark action is find, fit, test or edge_fill");
      if (input.action === "fit" && !input.boxes?.trim()) throw invalid("unmark fit needs the boxes --find printed");
      return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.unmark, { by, data: { action: input.action, boxes: input.boxes ?? null } }));
    }
    case "cards": {
      requireStage(run, "cards");
      if (!input.templates.length) throw invalid("name at least one card time");
      return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.cards, { by, data: { templates: input.templates } }));
    }
    case "boundary": {
      requireStage(run, "review");
      const { state } = await reviewStateOf({ run, dirs });
      const b = state.boundaries.find((x) => Math.abs(x.boundary_s - input.boundary_s) <= 0.0015);
      if (!b) throw notFound("boundary", String(input.boundary_s));
      if (input.action === "remove") {
        throw conflict("the pipeline cannot drop a boundary: pick_cuts.py --choices needs a choice for every open boundary of the partition. Move it instead, or, after the render, move the join.");
      }
      if (input.action === "accept") {
        if (b.record && (b.record.pick.confidence ?? 0) === 0) throw conflict(`the reviewer refused ${b.boundary_s}s (confidence 0): there is nothing to accept; move it to a legal cut`);
        if (!b.record) throw conflict(`${b.boundary_s}s has no vision record yet`);
        return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.accept, { by, boundary_s: b.boundary_s, why: input.reason ?? null }));
      }
      if (input.action === "move") {
        if (typeof input.to_t !== "number") throw invalid("a move names to_t");
        const legal = legalCutsNear(await loadCandidates(dirs.cut), b.boundary_s).map((c) => c.t);
        const refusal = moveRefusal(state, b.boundary_s, input.to_t, legal);
        if (refusal) throw conflict(refusal);
        return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.move, { by, boundary_s: b.boundary_s, to_s: input.to_t, why: input.reason ?? null }));
      }
      if (!input.reason?.trim()) throw invalid("a reject says why, so the re-judge can read it");
      return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.rejudge, { by, boundary_s: b.boundary_s, why: input.reason.trim() }));
    }
    case "apply_review": {
      requireStage(run, "review");
      const { state } = await reviewStateOf({ run, dirs });
      if (!state.complete) throw conflict(`${state.missing.length} boundaries still need a decision: ${JSON.stringify(state.missing.slice(0, 12))}`);
      return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.apply_review, { by, data: { decided: state.decided, pre_accepted: state.pre_accepted } }));
    }
    case "join": {
      requireStage(run, "film_meta", "handoff");
      const plan = readPlan(dirs.cut);
      if (!plan) throw conflict("no plan to move a join in");
      const ep = plan.episodes.find((e) => e.n === input.join_index);
      if (!ep || input.join_index >= plan.episodes.length) throw notFound("join", String(input.join_index));
      const legal = legalCutsNear(await loadCandidates(dirs.cut), ep.end).map((c) => c.t);
      if (!legal.some((t) => Math.abs(t - input.to_t) <= 0.0015)) throw conflict(`${input.to_t}s is not a legal cut within 30 s of ${ep.end}s`);
      const [lo, hi] = plan.band ?? [0, Number.POSITIVE_INFINITY];
      const prev = input.join_index > 1 ? plan.episodes[input.join_index - 2].end : 0;
      const nextEnd = plan.episodes[input.join_index].end;
      const before = Math.round((input.to_t - prev) * 1000) / 1000;
      const after = Math.round((nextEnd - input.to_t) * 1000) / 1000;
      if (plan.band && (before < lo || before > hi || after < lo || after > hi)) throw conflict(`moving the join to ${input.to_t}s makes episodes of ${before}s and ${after}s, outside the ${lo}–${hi}s band`);
      return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.join, { by, boundary_s: ep.end, to_s: input.to_t, why: input.reason ?? null, data: { join_index: input.join_index } }));
    }
    case "film_meta": {
      requireStage(run, "film_meta");
      if (!input.display_title_en.trim()) throw invalid("display_title_en is required");
      const form: FilmMetaForm = { display_title_en: input.display_title_en, crazydramas_slug: input.crazydramas_slug ?? null, spoiler_from_s: input.spoiler_from_s ?? null, exclusions: input.exclusions ?? [], live_poster: input.live_poster ?? null };
      return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.film_meta, { by, data: form as unknown as Json }));
    }
    case "import_now": {
      requireStage(run, "handoff");
      return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.import_now, { by }));
    }
    case "handoff_vision": {
      requireStage(run, "vision", "review");
      if (input.output_path) {
        const p = input.output_path.trim().replace(/^"|"$/g, "");
        if (!path.isAbsolute(p) || !existsSync(p)) throw invalid(`${p} is not a file Studio can read`);
        return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.handoff_vision, { by, data: { output_path: p.replace(/\\/g, "/") } }));
      }
      return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.handoff_vision, { by, why: "hand the vision pass to Claude Code" }));
    }
    case "retry": {
      if (run.stage !== "failed" && run.stage !== "vision") throw conflict(`only a failed run (or a vision pass with errors) is retried; the run is at ${run.stage}`);
      const failedStage = (run.stage_detail as { failed_stage?: string }).failed_stage;
      const back = run.stage === "failed" ? (failedStage as FilmRun["stage"] | undefined) ?? "intake" : "vision";
      const detail = { ...(run.stage_detail as Record<string, Json>) };
      delete detail.waiting;
      delete detail.failed_stage;
      const withDecision = await data.appendFilmRunDecision(session, runId, decisionOf(DECISION.retry, { by, data: { from: run.stage, to: back } }));
      return data.setFilmRunStage(session, runId, { stage: back, stage_detail: detail as Json, error_text: null, revision: withDecision.revision });
    }
    case "note":
      return data.appendFilmRunDecision(session, runId, decisionOf(DECISION.note, { by, why: input.text }));
    default:
      throw invalid("unknown decision");
  }
}

// ---- cancel -------------------------------------------------------------------------------------------------------------------------

/** Cancel: the row goes to `cancelled` now (the CAS ignores the lease); a worker mid-script sees it at its next heartbeat and kills the child. */
export async function cancelRun(session: Session, runId: string, env: Env = process.env): Promise<FilmRun> {
  const data = getData();
  const run = await data.getFilmRun(session, runId);
  if (isTerminal(run.stage)) throw conflict(`the run is already ${run.stage}`);
  const detail = { ...(run.stage_detail as Record<string, Json>), cancelled_from: run.stage, waiting: null };
  const out = await data.setFilmRunStage(session, runId, { stage: "cancelled", stage_detail: detail as Json, revision: run.revision });
  try {
    const dirs = runDirs(run, env);
    if (existsSync(dirs.cut)) studioRunLock(dirs.cut, { run_id: run.id, stage: "cancelled" }).release();
  } catch (e) {
    if (!(e instanceof LockHeldError)) throw e;
  }
  return out;
}

/** The evidence URL helpers the routes and screens share. */
export { evidenceUrl, proxyUrl, visionLabel };
