// The one set of rules both backends apply to a film run's writes (decision
// 2026-09-23, "segment a film in Studio"; migration 0016): what a new run
// must carry, which modes exist (a narrated run in the high-quality bucket
// only, decision "Narrated mode in Studio"), how a lease is judged live or
// free, and the pure state transitions of claim / renew / stage / decision /
// release — and the same for a narrated run's episode rows (migration 0018).
// The fixture store applies them in memory; the Supabase
// layer applies them to the row it read and then writes revision-conditionally
// as the service role, so a stale revision is a `conflict` DataError in both
// modes, never a Postgres error with a different message.

import { NARRATED_BUCKET, validateFilmRunSettings } from "@/lib/segment/settings";
import type { EpisodeGateCounts, EpisodePictureStage, EpisodeStage, EpisodeWordsStage, FilmRun, FilmRunDecision, FilmRunEpisode, FilmRunMode, FilmRunSettings, FilmRunStage, Json } from "@/lib/types";
import { EPISODE_PICTURE_STAGES, EPISODE_STAGES, EPISODE_WORDS_STAGES, FILM_RUN_STAGES } from "@/lib/types";
import { conflict, invalid } from "./errors";
import type { ClaimFilmRunInput, FilmRunStageInput, NewFilmRun, NewFilmRunDecision, NewRunEpisode, RunEpisodeStageInput } from "./index";

// The settings validator lives with the narrated defaults (lib/segment/settings.ts); re-exported for the callers that always read it here.
export { validateFilmRunSettings };

/** How long a claim holds a run before another worker may adopt it (plan B1: STALE_RUN_MS is ten minutes). */
export const FILM_RUN_LEASE_MS = 10 * 60 * 1000;

export const FILM_RUN_MODES: readonly FilmRunMode[] = ["by_eye_2min", "source_episodes", "narrated"];

/** The modes a run may be created with (decision 2026-09-23 "Narrated mode in Studio" opened `narrated`, in the high-quality bucket only). */
export const FILM_RUN_MODES_OPEN: readonly FilmRunMode[] = ["by_eye_2min", "source_episodes", "narrated"];

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
  if (!FILM_RUN_MODES_OPEN.includes(input.mode)) throw invalid(`mode ${input.mode} is not open`);
  // Amendment 4 (2026-09-23): new narrated sources only, under projects/high-quality/<slug>/.
  if (input.mode === "narrated" && bucket !== NARRATED_BUCKET) throw invalid(`a narrated run lives in the ${NARRATED_BUCKET} bucket (projects/${NARRATED_BUCKET}/<slug>), not ${bucket}`);
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

/** True while any worker holds a live lease on the run (a waiting run holds none; an expired lease is a dead worker's). */
export function leaseLive(run: Pick<FilmRun, "lease_owner" | "leased_until">, nowMs = Date.now()): boolean {
  if (!run.lease_owner) return false;
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
  if (decision.ep !== undefined && decision.ep !== null) {
    if (typeof decision.ep !== "number" || !Number.isInteger(decision.ep) || decision.ep < 1) throw invalid("ep must be an episode number");
    row.ep = decision.ep;
  }
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

// ---- studio.film_run_episodes (decision 2026-09-23 "Narrated mode in Studio"; migration 0018) ----
//
// The same discipline as the run row: both backends apply these pure rules
// to the row they read, then write revision-conditionally, so a stale
// revision is a `conflict` DataError in both modes and a lost claim is null.

/** An episode's lease is a run's: ten minutes, renewed while a lane works. */
export const RUN_EPISODE_LEASE_MS = FILM_RUN_LEASE_MS;

const SERIES_KEY = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VARIANT = /^v\d{1,4}$/;

/** A run stage whose episodes no longer hold their numbers (a failed or cancelled run frees them). */
export function runHoldsNumbers(stage: FilmRunStage): boolean {
  return stage !== "failed" && stage !== "cancelled";
}

/**
 * The rows `createRunEpisodes` writes for a narrated run: numbers contiguous
 * from the first, windows forward, in order and not overlapping, inside the
 * source when its length is given. Titles default to `EPISODE N` (the card
 * the pipeline renders; make_intro shows the subtitle).
 */
export function runEpisodeRows(
  run: Pick<FilmRun, "id" | "mode">,
  input: { series_key: string; episodes: NewRunEpisode[]; source_duration_s?: number | null },
  nowMs = Date.now()
): Omit<FilmRunEpisode, "id">[] {
  if (run.mode !== "narrated") throw invalid(`run ${run.id} is a ${run.mode} run: only a narrated run has episode rows`);
  const key = typeof input.series_key === "string" ? input.series_key.trim() : "";
  if (!SERIES_KEY.test(key)) throw invalid("series_key must be lowercase words joined by hyphens (love-between-lines)");
  if (!Array.isArray(input.episodes) || !input.episodes.length) throw invalid("an episode plan needs at least one episode");
  const dur = typeof input.source_duration_s === "number" && Number.isFinite(input.source_duration_s) ? input.source_duration_s : null;
  const at = new Date(nowMs).toISOString();
  const first = input.episodes[0]?.n;
  return input.episodes.map((e, i) => {
    if (!e || typeof e !== "object") throw invalid(`episode ${i + 1} must be an object`);
    if (typeof e.n !== "number" || !Number.isInteger(e.n) || e.n < 1) throw invalid(`episode ${i + 1}: n must be a whole number from 1`);
    if (e.n !== first + i) throw invalid(`episode numbers must be contiguous from ${first}: number ${i + 1} of the plan is ${e.n}`);
    if (typeof e.src_in !== "number" || typeof e.src_out !== "number" || !Number.isFinite(e.src_in) || !Number.isFinite(e.src_out) || e.src_in < 0 || e.src_out <= e.src_in) {
      throw invalid(`episode ${e.n}: src_in and src_out must be source seconds with src_in < src_out`);
    }
    const prev = i > 0 ? input.episodes[i - 1] : null;
    if (prev && e.src_in < prev.src_out - 0.001) throw invalid(`episode ${e.n} starts at ${e.src_in} s, inside episode ${prev.n} (which ends at ${prev.src_out} s)`);
    if (dur !== null && e.src_out > dur + 0.5) throw invalid(`episode ${e.n} ends at ${e.src_out} s, past the source's ${dur} s`);
    const title = typeof e.title === "string" && e.title.trim() ? e.title.trim() : `EPISODE ${e.n}`;
    const subtitle = typeof e.subtitle === "string" && e.subtitle.trim() ? e.subtitle.trim() : null;
    if (title.length > 120 || (subtitle?.length ?? 0) > 200) throw invalid(`episode ${e.n}: the title is at most 120 characters and the subtitle 200`);
    const detail = e.stage_detail === undefined ? {} : e.stage_detail;
    if (!isPlainObject(detail)) throw invalid(`episode ${e.n}: stage_detail must be an object`);
    return {
      run_id: run.id,
      series_key: key,
      n: e.n,
      src_in: e.src_in,
      src_out: e.src_out,
      title,
      subtitle,
      words_stage: "prep" as const,
      picture_stage: "waiting" as const,
      stage: "lanes" as const,
      variant: null,
      gate: null,
      body_sha256: null,
      shipped_sha256: null,
      stage_detail: JSON.parse(JSON.stringify(detail)) as Json,
      error_text: null,
      approved_by: null,
      approved_at: null,
      lease_owner: null,
      leased_until: null,
      revision: 1,
      created_at: at,
      updated_at: at,
    };
  });
}

/**
 * Why these numbers may not be taken, or null: another live run's episode
 * (its run neither failed nor cancelled, the episode not dropped) already
 * holds one of them under the same series key. `others` are the key's rows
 * outside this run, `stageOf` the stage of their runs (null: the run is gone).
 */
export function heldNumbersConflict(ns: number[], others: Pick<FilmRunEpisode, "run_id" | "n" | "stage">[], stageOf: (runId: string) => FilmRunStage | null): string | null {
  const want = new Set(ns);
  const held = others.filter((o) => {
    const stage = stageOf(o.run_id);
    return want.has(o.n) && o.stage !== "dropped" && stage !== null && runHoldsNumbers(stage);
  });
  if (!held.length) return null;
  const list = held.sort((a, b) => a.n - b.n).map((h) => `ep${h.n} (run ${h.run_id.slice(0, 8)})`);
  return `episode numbers already held in this season by a live run: ${list.join(", ")}`;
}

/** The fields a successful episode claim writes, or null when the race is lost (the revision moved, or another live lease holds the row). */
export function episodeClaimFields(ep: FilmRunEpisode, input: ClaimFilmRunInput, nowMs = Date.now()): Pick<FilmRunEpisode, "lease_owner" | "leased_until" | "revision" | "updated_at"> | null {
  const owner = ownerOf(input.owner);
  if (!Number.isInteger(input.revision)) throw invalid("revision must be an integer");
  if (ep.revision !== input.revision) return null;
  if (leaseHeldByOther(ep, owner, nowMs)) return null;
  const ms = leaseMsOf(input.leaseMs);
  return { lease_owner: owner, leased_until: new Date(nowMs + ms).toISOString(), revision: ep.revision + 1, updated_at: new Date(nowMs).toISOString() };
}

/** The fields an episode lease renewal writes; conflict when `owner` does not hold a live lease (the revision is untouched). */
export function episodeRenewFields(ep: FilmRunEpisode, input: { owner: string; leaseMs?: number }, nowMs = Date.now()): Pick<FilmRunEpisode, "leased_until" | "updated_at"> {
  const owner = ownerOf(input.owner);
  if (!leaseHeldBy(ep, owner, nowMs)) throw conflict(ep.lease_owner ? `episode ${ep.n} is leased by ${ep.lease_owner}, not ${owner}` : `episode ${ep.n} is not leased; claim it first`);
  return { leased_until: new Date(nowMs + leaseMsOf(input.leaseMs)).toISOString(), updated_at: new Date(nowMs).toISOString() };
}

/** The fields an episode release writes; conflict while another owner's lease is live. */
export function episodeReleaseFields(ep: FilmRunEpisode, input: { owner: string }, nowMs = Date.now()): Pick<FilmRunEpisode, "lease_owner" | "leased_until" | "revision" | "updated_at"> {
  const owner = ownerOf(input.owner);
  if (leaseHeldByOther(ep, owner, nowMs)) throw conflict(`episode ${ep.n} is leased by ${ep.lease_owner} until ${ep.leased_until}`);
  return { lease_owner: null, leased_until: null, revision: ep.revision + 1, updated_at: new Date(nowMs).toISOString() };
}

function gateOf(v: unknown): EpisodeGateCounts | null {
  if (v === null) return null;
  if (!isPlainObject(v)) throw invalid("gate must be {PASS, WARN, FAIL} counts");
  const n = (k: string) => {
    const x = v[k];
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0) throw invalid(`gate.${k} must be a count`);
    return x;
  };
  return { PASS: n("PASS"), WARN: n("WARN"), FAIL: n("FAIL") };
}

/**
 * The fields an episode stage write makes; conflict on a stale revision or a
 * foreign live lease. `approved: true` stamps `approved_by` (the actor, or
 * `approved_by` when given) and `approved_at`; `approved: false` clears both.
 */
export function episodeStageFields(ep: FilmRunEpisode, input: RunEpisodeStageInput, actor: string, nowMs = Date.now()): Partial<FilmRunEpisode> {
  if (!Number.isInteger(input.revision)) throw invalid("revision must be an integer");
  if (ep.revision !== input.revision) throw conflict(`episode ${ep.n} changed (revision ${ep.revision}, you had ${input.revision}); re-read it`);
  if (input.owner !== undefined && leaseHeldByOther(ep, ownerOf(input.owner), nowMs)) throw conflict(`episode ${ep.n} is leased by ${ep.lease_owner} until ${ep.leased_until}`);
  const out: Partial<FilmRunEpisode> = { revision: ep.revision + 1, updated_at: new Date(nowMs).toISOString() };
  if (input.words_stage !== undefined) {
    if (!EPISODE_WORDS_STAGES.includes(input.words_stage)) throw invalid(`unknown words stage: ${String(input.words_stage)}`);
    out.words_stage = input.words_stage;
  }
  if (input.picture_stage !== undefined) {
    if (!EPISODE_PICTURE_STAGES.includes(input.picture_stage)) throw invalid(`unknown picture stage: ${String(input.picture_stage)}`);
    out.picture_stage = input.picture_stage;
  }
  if (input.stage !== undefined) {
    if (!EPISODE_STAGES.includes(input.stage)) throw invalid(`unknown episode stage: ${String(input.stage)}`);
    out.stage = input.stage;
  }
  if (input.stage_detail !== undefined) {
    if (!isPlainObject(input.stage_detail)) throw invalid("stage_detail must be an object");
    out.stage_detail = JSON.parse(JSON.stringify(input.stage_detail)) as Json;
  }
  if (input.error_text !== undefined) out.error_text = input.error_text === null ? null : String(input.error_text);
  if (input.variant !== undefined) {
    if (input.variant !== null && (typeof input.variant !== "string" || !VARIANT.test(input.variant))) throw invalid("variant must be v<K> (v1, v12)");
    out.variant = input.variant;
  }
  if (input.gate !== undefined) out.gate = gateOf(input.gate);
  for (const k of ["body_sha256", "shipped_sha256"] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (v !== null && (typeof v !== "string" || !SHA256.test(v))) throw invalid(`${k} must be 64 hex characters`);
    out[k] = v;
  }
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 120) throw invalid("title must be text of at most 120 characters");
    out.title = input.title.trim();
  }
  if (input.subtitle !== undefined) {
    if (input.subtitle !== null && (typeof input.subtitle !== "string" || input.subtitle.length > 200)) throw invalid("subtitle must be text of at most 200 characters");
    out.subtitle = input.subtitle === null || !input.subtitle.trim() ? null : input.subtitle.trim();
  }
  if (input.approved === true) {
    out.approved_by = (input.approved_by ?? actor).trim() || actor;
    out.approved_at = new Date(nowMs).toISOString();
  } else if (input.approved === false) {
    out.approved_by = null;
    out.approved_at = null;
  }
  return out;
}

type AuditedEpisodeFields = Pick<FilmRunEpisode, "words_stage" | "picture_stage" | "stage" | "error_text" | "variant" | "approved_at">;

/** Whether an episode write is an audit event: a lane, the joined stage, the refusal, the variant or the approval moved (a progress write is not). */
export function runEpisodeAudited(before: AuditedEpisodeFields, after: AuditedEpisodeFields): boolean {
  return (
    before.words_stage !== after.words_stage ||
    before.picture_stage !== after.picture_stage ||
    before.stage !== after.stage ||
    (before.error_text ?? null) !== (after.error_text ?? null) ||
    (before.variant ?? null) !== (after.variant ?? null) ||
    (before.approved_at ?? null) !== (after.approved_at ?? null)
  );
}

/** An episode row as either backend hands it out: stage_detail always an object, numbers as numbers (Postgres numeric arrives as text). */
export function normalizeRunEpisode(row: FilmRunEpisode): FilmRunEpisode {
  return {
    ...row,
    n: Number(row.n),
    src_in: Number(row.src_in),
    src_out: Number(row.src_out),
    words_stage: EPISODE_WORDS_STAGES.includes(row.words_stage) ? row.words_stage : ("prep" as EpisodeWordsStage),
    picture_stage: EPISODE_PICTURE_STAGES.includes(row.picture_stage) ? row.picture_stage : ("waiting" as EpisodePictureStage),
    stage: EPISODE_STAGES.includes(row.stage) ? row.stage : ("lanes" as EpisodeStage),
    gate: isPlainObject(row.gate) ? (row.gate as EpisodeGateCounts) : null,
    stage_detail: isPlainObject(row.stage_detail) ? row.stage_detail : {},
  };
}
