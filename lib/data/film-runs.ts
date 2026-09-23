// The one set of rules both backends apply to a film run's writes (decision
// 2026-09-23, "segment a film in Studio"; migration 0016): what a new run
// must carry, which modes exist and which is reserved, how a lease is judged
// live or free, and the pure state transitions of claim / renew / stage /
// decision / release. The fixture store applies them in memory; the Supabase
// layer applies them to the row it read and then writes revision-conditionally
// as the service role, so a stale revision is a `conflict` DataError in both
// modes, never a Postgres error with a different message.

import type { FilmRun, FilmRunDecision, FilmRunMode, FilmRunSettings, FilmRunStage, Json } from "@/lib/types";
import { FILM_RUN_STAGES } from "@/lib/types";
import { conflict, invalid } from "./errors";
import type { ClaimFilmRunInput, FilmRunStageInput, NewFilmRun, NewFilmRunDecision } from "./index";

/** How long a claim holds a run before another worker may adopt it (plan B1: STALE_RUN_MS is ten minutes). */
export const FILM_RUN_LEASE_MS = 10 * 60 * 1000;

export const FILM_RUN_MODES: readonly FilmRunMode[] = ["by_eye_2min", "source_episodes", "narrated"];

/** The modes a run may be created with today; `narrated` is the next phase's. */
export const FILM_RUN_MODES_OPEN: readonly FilmRunMode[] = ["by_eye_2min", "source_episodes"];

/** A film folder name as the pipeline makes them: lowercase words joined by `-` or `_`; one leading `_` marks a scratch folder (`_studio-smoke`). */
export const FILM_SLUG = /^_?[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The row an insert writes (everything but id / created_at / updated_at), validated. */
export function filmRunRow(input: NewFilmRun): Omit<FilmRun, "id" | "created_at" | "updated_at"> & { created_by: string | null } {
  if (typeof input.producer_id !== "string" || !input.producer_id.trim()) throw invalid("producer_id is required");
  const sourcePath = typeof input.source_path === "string" ? input.source_path.trim().replace(/\\/g, "/") : "";
  if (!sourcePath) throw invalid("source_path is required: the source video picked at intake");
  const bucket = typeof input.bucket === "string" ? input.bucket.trim() : "";
  if (!FILM_SLUG.test(bucket)) throw invalid("bucket must be a plain folder name (low-quality)");
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (!FILM_SLUG.test(slug)) throw invalid("slug must be lowercase words joined by hyphens (she-returned-with-her-son; a leading _ for a scratch folder)");
  if (!FILM_RUN_MODES.includes(input.mode)) throw invalid(`unknown mode: ${String(input.mode)}`);
  if (!FILM_RUN_MODES_OPEN.includes(input.mode)) throw invalid(`mode ${input.mode} is reserved for the narrated route (next phase)`);
  const lang = (input.lang ?? "en").trim().toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(lang)) throw invalid("lang must be a language code (en, zh)");
  const settings = validateFilmRunSettings(input.settings ?? {});
  const stage = input.stage ?? "queued";
  if (!FILM_RUN_STAGES.includes(stage)) throw invalid(`unknown stage: ${String(stage)}`);
  const sha = input.drama_remix_sha ?? null;
  if (sha !== null && !GIT_SHA.test(sha)) throw invalid("drama_remix_sha must be a 40-hex git sha");
  return {
    producer_id: input.producer_id,
    title_id: input.title_id ?? null,
    source_path: sourcePath,
    bucket,
    slug,
    mode: input.mode,
    lang,
    settings,
    stage,
    stage_detail: {},
    drama_remix_sha: sha,
    drama_remix_dirty: input.drama_remix_dirty === true,
    lease_owner: null,
    leased_until: null,
    revision: 1,
    error_text: null,
    decisions: [],
    created_by: null,
  };
}

/** A clean copy of the settings, or `invalid`: known keys typed, unknown keys kept as JSON. */
export function validateFilmRunSettings(settings: FilmRunSettings | null | undefined): FilmRunSettings {
  if (settings === null || settings === undefined) return {};
  if (!isPlainObject(settings)) throw invalid("settings must be an object");
  const out: FilmRunSettings = { ...(settings as FilmRunSettings) };
  const num = (k: keyof FilmRunSettings, min: number) => {
    const v = out[k];
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw invalid(`settings.${String(k)} must be a number >= ${min}`);
  };
  num("target_s", 1);
  num("threads", 1);
  num("to_s", 1);
  if (out.band !== undefined) {
    const b = out.band;
    if (!Array.isArray(b) || b.length !== 2 || !b.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0) || b[0] >= b[1]) throw invalid("settings.band must be [low, high] seconds with low < high");
  }
  for (const k of ["no_delogo", "allow_dirty", "claim_existing", "extend"] as const) {
    if (out[k] !== undefined && typeof out[k] !== "boolean") throw invalid(`settings.${k} must be a boolean`);
  }
  if (out.vision !== undefined && out.vision !== "api" && out.vision !== "handoff") throw invalid("settings.vision must be api or handoff");
  if (out.watermark_region !== undefined && out.watermark_region !== null && !/^\s*\d*\.?\d+\s*(,\s*\d*\.?\d+\s*){3}$/.test(String(out.watermark_region))) {
    throw invalid("settings.watermark_region must be x0,y0,x1,y1 fractions");
  }
  return JSON.parse(JSON.stringify(out)) as FilmRunSettings;
}

/** True while someone else's lease is still running. */
export function leaseHeldByOther(run: Pick<FilmRun, "lease_owner" | "leased_until">, owner: string, nowMs = Date.now()): boolean {
  if (!run.lease_owner || run.lease_owner === owner) return false;
  const until = Date.parse(run.leased_until ?? "");
  return Number.isFinite(until) && until > nowMs;
}

/** True while `owner` holds a live lease on the run. */
export function leaseHeldBy(run: Pick<FilmRun, "lease_owner" | "leased_until">, owner: string, nowMs = Date.now()): boolean {
  if (run.lease_owner !== owner) return false;
  const until = Date.parse(run.leased_until ?? "");
  return Number.isFinite(until) && until > nowMs;
}

const leaseMsOf = (ms: number | undefined): number => {
  if (ms === undefined) return FILM_RUN_LEASE_MS;
  if (!Number.isInteger(ms) || ms <= 0) throw invalid("leaseMs must be a positive integer");
  return ms;
};

const ownerOf = (owner: string): string => {
  if (typeof owner !== "string" || !owner.trim()) throw invalid("owner is required");
  return owner.trim();
};

/** The fields a successful claim writes, or null when the race is lost (the revision moved, or another live lease holds the row). */
export function claimFields(run: FilmRun, input: ClaimFilmRunInput, nowMs = Date.now()): Pick<FilmRun, "lease_owner" | "leased_until" | "revision" | "updated_at"> | null {
  const owner = ownerOf(input.owner);
  if (!Number.isInteger(input.revision)) throw invalid("revision must be an integer");
  if (run.revision !== input.revision) return null;
  if (leaseHeldByOther(run, owner, nowMs)) return null;
  const ms = leaseMsOf(input.leaseMs);
  return { lease_owner: owner, leased_until: new Date(nowMs + ms).toISOString(), revision: run.revision + 1, updated_at: new Date(nowMs).toISOString() };
}

/** The fields a renewal writes; conflict when `owner` does not hold a live lease (the revision is untouched). */
export function renewFields(run: FilmRun, input: { owner: string; leaseMs?: number }, nowMs = Date.now()): Pick<FilmRun, "leased_until" | "updated_at"> {
  const owner = ownerOf(input.owner);
  if (!leaseHeldBy(run, owner, nowMs)) throw conflict(run.lease_owner ? `run ${run.id} is leased by ${run.lease_owner}, not ${owner}` : `run ${run.id} is not leased; claim it first`);
  return { leased_until: new Date(nowMs + leaseMsOf(input.leaseMs)).toISOString(), updated_at: new Date(nowMs).toISOString() };
}

/** The fields a stage write makes; conflict on a stale revision or a foreign live lease. */
export function stageFields(run: FilmRun, input: FilmRunStageInput, nowMs = Date.now()): Partial<FilmRun> {
  if (!Number.isInteger(input.revision)) throw invalid("revision must be an integer");
  if (!FILM_RUN_STAGES.includes(input.stage)) throw invalid(`unknown stage: ${String(input.stage)}`);
  if (run.revision !== input.revision) throw conflict(`run ${run.id} changed (revision ${run.revision}, you had ${input.revision}); re-read it`);
  if (input.owner !== undefined && leaseHeldByOther(run, ownerOf(input.owner), nowMs)) throw conflict(`run ${run.id} is leased by ${run.lease_owner} until ${run.leased_until}`);
  const out: Partial<FilmRun> = { stage: input.stage, revision: run.revision + 1, updated_at: new Date(nowMs).toISOString() };
  if (input.stage_detail !== undefined) {
    if (!isPlainObject(input.stage_detail)) throw invalid("stage_detail must be an object");
    out.stage_detail = JSON.parse(JSON.stringify(input.stage_detail)) as Json;
  }
  if (input.error_text !== undefined) out.error_text = input.error_text === null ? null : String(input.error_text);
  if (input.drama_remix_sha !== undefined) {
    if (input.drama_remix_sha !== null && !GIT_SHA.test(input.drama_remix_sha)) throw invalid("drama_remix_sha must be a 40-hex git sha");
    out.drama_remix_sha = input.drama_remix_sha;
  }
  if (input.drama_remix_dirty !== undefined) {
    if (typeof input.drama_remix_dirty !== "boolean") throw invalid("drama_remix_dirty must be a boolean");
    out.drama_remix_dirty = input.drama_remix_dirty;
  }
  if (input.title_id !== undefined) out.title_id = input.title_id;
  return out;
}

/**
 * Whether a stage write is an audit event: the stage, the refusal text or
 * the title moved. A progress write (`stage_detail` alone, up to one a
 * second while whisper, the judge or the render report) is not; both
 * backends apply this one rule, so neither writes hundreds of rows per film.
 */
export function filmRunStageAudited(before: Pick<FilmRun, "stage" | "error_text" | "title_id">, after: Pick<FilmRun, "stage" | "error_text" | "title_id">): boolean {
  return before.stage !== after.stage || (before.error_text ?? null) !== (after.error_text ?? null) || (before.title_id ?? null) !== (after.title_id ?? null);
}

/** One decision as the row stores it. */
export function decisionRow(decision: NewFilmRunDecision, by: string, nowMs = Date.now()): FilmRunDecision {
  if (!isPlainObject(decision)) throw invalid("a decision must be an object");
  if (typeof decision.action !== "string" || !decision.action.trim()) throw invalid("a decision needs an action");
  const boundary = decision.boundary_s ?? null;
  if (boundary !== null && (typeof boundary !== "number" || !Number.isFinite(boundary) || boundary < 0)) throw invalid("boundary_s must be a film time in seconds");
  const to = decision.to_s === undefined ? undefined : decision.to_s;
  if (to !== undefined && to !== null && (typeof to !== "number" || !Number.isFinite(to) || to < 0)) throw invalid("to_s must be a film time in seconds");
  const row: FilmRunDecision = { at: new Date(nowMs).toISOString(), by: (decision.by ?? by).trim() || by, action: decision.action.trim(), boundary_s: boundary };
  if (to !== undefined) row.to_s = to;
  if (decision.why !== undefined) row.why = decision.why === null ? null : String(decision.why);
  if (decision.data !== undefined) row.data = JSON.parse(JSON.stringify(decision.data)) as Json;
  return row;
}

/** The fields a release writes; conflict while another owner's lease is live. */
export function releaseFields(run: FilmRun, input: { owner: string }, nowMs = Date.now()): Pick<FilmRun, "lease_owner" | "leased_until" | "revision" | "updated_at"> {
  const owner = ownerOf(input.owner);
  if (leaseHeldByOther(run, owner, nowMs)) throw conflict(`run ${run.id} is leased by ${run.lease_owner} until ${run.leased_until}`);
  return { lease_owner: null, leased_until: null, revision: run.revision + 1, updated_at: new Date(nowMs).toISOString() };
}

/** A row as either backend hands it out: decisions always an array, settings always an object. */
export function normalizeFilmRun(row: FilmRun): FilmRun {
  return {
    ...row,
    settings: isPlainObject(row.settings) ? (row.settings as FilmRunSettings) : {},
    stage_detail: isPlainObject(row.stage_detail) ? row.stage_detail : {},
    decisions: Array.isArray(row.decisions) ? row.decisions : [],
    drama_remix_dirty: row.drama_remix_dirty === true,
  };
}
