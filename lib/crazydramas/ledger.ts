// The one set of rules both backends apply to studio.cd_publications (phase 5,
// "Upload to crazydramas"; publish spec §8, plan A6; migration 0019): what a
// new ledger row must carry, the idempotency key, how a lease is judged, and
// the pure transitions of claim / renew / update / release / cancel. The
// fixture store applies them in memory; the Supabase layer applies them to
// the row it read and writes revision-conditionally as the service role, so
// a stale revision is a `conflict` DataError in both modes, never a Postgres
// error with other words (the lib/data/film-runs.ts pattern).
//
// Never in a row: an upload URL (a capability — anyone holding it can send
// bytes) or a playback id (the paywall leak on crazydramas). The columns
// below have no place for either, and `verify` is checked for both keys.

import { conflict, invalid } from "@/lib/data/errors";
import { CD_ACTIVE_STEPS, CD_PUBLICATION_STEPS, type CdPublication, type CdPublicationStep, type Json } from "@/lib/types";

/** How long a claim holds a row before another worker may adopt it (spec §8: ten minutes, as on launch runs). */
export const CD_LEASE_MS = 10 * 60 * 1000;

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A Mux id: letters and digits (crazydramas answers 400 bad_upload_id otherwise). */
const MUX_ID = /^[A-Za-z0-9]{1,128}$/;

/** `cd:<title_id>:ep<k>:<sha8>` (spec §8). */
export function cdIdempotencyKey(titleId: string, episodeNumber: number, sha256: string): string {
  return `cd:${titleId}:ep${episodeNumber}:${sha256.slice(0, 8)}`;
}

export function isActiveStep(step: CdPublicationStep): boolean {
  return CD_ACTIVE_STEPS.includes(step);
}

/** What a new row carries (the uploader plans it; everything else starts empty). */
export type NewCdPublicationInput = {
  title_id: string;
  episode_id: string | null;
  episode_number: number;
  cd_drama_id: string;
  slug: string;
  sha256: string;
  bytes: number;
  frames?: number | null;
  fps?: number | null;
  /** The local-tier stored path (`local/<title_id>/ws/…`), read through `localPathOf` only. */
  source_path: string;
  replace?: boolean;
  created_by?: string | null;
};

/** The fields a row write may set (every one optional); `revision` is the CAS the caller read, `owner` the lease it holds. */
export type CdPublicationUpdate = {
  revision: number;
  /** The lease holder writing; a write by anyone else while a live lease is held is a conflict. Omit only for a write no worker is in (a Retry of a failed row). */
  owner?: string;
  step?: CdPublicationStep;
  cd_episode_id?: string | null;
  replace?: boolean;
  upload_id?: string | null;
  asset_id?: string | null;
  previous_asset_id?: string | null;
  previous_upload_id?: string | null;
  bytes_acked?: number;
  duration_s?: number | null;
  verify?: Json | null;
  error?: string | null;
  error_code?: string | null;
  cancel_requested?: boolean;
  attempts?: number;
  attempted_at?: string | null;
  next_attempt_at?: string | null;
  published_at?: string | null;
  /** Renew the writer's lease with the write (a progress write keeps the row held): true for CD_LEASE_MS, or the lease in ms the worker claimed with. */
  renew?: boolean | number;
};

export type ClaimCdPublicationInput = { owner: string; revision: number; leaseMs?: number };

/** The row an insert writes (everything but id / created_at / updated_at), validated. */
export function cdPublicationRow(input: NewCdPublicationInput): Omit<CdPublication, "id" | "created_at" | "updated_at"> {
  if (typeof input.title_id !== "string" || !UUID.test(input.title_id)) throw invalid("title_id must be a title's uuid");
  if (!Number.isInteger(input.episode_number) || input.episode_number < 1 || input.episode_number > 500) throw invalid("episode_number must be 1-500");
  const dramaId = typeof input.cd_drama_id === "string" ? input.cd_drama_id.trim().toLowerCase() : "";
  if (!UUID.test(dramaId)) throw invalid("cd_drama_id must be the platform's uuid");
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (!SLUG.test(slug) || slug.length > 80) throw invalid("slug must be lowercase words joined by hyphens");
  const sha = typeof input.sha256 === "string" ? input.sha256.trim().toLowerCase() : "";
  if (!SHA256.test(sha)) throw invalid("sha256 must be 64 hex characters");
  if (!Number.isInteger(input.bytes) || input.bytes <= 0) throw invalid("bytes must be a positive integer");
  const frames = input.frames ?? null;
  if (frames !== null && (!Number.isInteger(frames) || frames <= 0)) throw invalid("frames must be a positive integer");
  const fps = input.fps ?? null;
  if (fps !== null && !(typeof fps === "number" && Number.isFinite(fps) && fps > 0)) throw invalid("fps must be a positive number");
  const source = typeof input.source_path === "string" ? input.source_path.trim() : "";
  if (!source.startsWith("local/")) throw invalid("source_path must be a local-tier path (local/<title_id>/…): the bytes are read from the link, never the workspace original");
  return {
    title_id: input.title_id,
    episode_id: input.episode_id ?? null,
    episode_number: input.episode_number,
    cd_drama_id: dramaId,
    slug,
    cd_episode_id: null,
    idempotency_key: cdIdempotencyKey(input.title_id, input.episode_number, sha),
    step: "planned",
    sha256: sha,
    bytes: input.bytes,
    frames,
    fps,
    source_path: source,
    replace: input.replace === true,
    upload_id: null,
    asset_id: null,
    previous_asset_id: null,
    previous_upload_id: null,
    bytes_acked: 0,
    duration_s: null,
    verify: null,
    error: null,
    error_code: null,
    cancel_requested: false,
    attempts: 0,
    attempted_at: null,
    next_attempt_at: null,
    lease_owner: null,
    leased_until: null,
    revision: 1,
    created_by: input.created_by ?? null,
    published_at: null,
  };
}

/**
 * The refusal a new row meets against the rows the title already has for
 * that episode, or null: one active row per title × episode, and the same
 * file already on crazydramas is refused as "already on crazydramas" (spec §8).
 */
export function newRowConflict(row: Pick<CdPublication, "episode_number" | "sha256">, existing: readonly Pick<CdPublication, "episode_number" | "sha256" | "step">[]): string | null {
  const same = existing.filter((r) => r.episode_number === row.episode_number);
  const active = same.find((r) => isActiveStep(r.step));
  if (active) return `episode ${row.episode_number} already has an upload in the ledger (${active.step})`;
  if (same.some((r) => r.step === "published" && r.sha256 === row.sha256)) return `episode ${row.episode_number}: this file is already on crazydramas`;
  if (same.some((r) => r.step === "verified" && r.sha256 === row.sha256)) return `episode ${row.episode_number}: this file is already uploaded and verified`;
  return null;
}

/** True while someone else's lease is still running. */
export function cdLeaseHeldByOther(row: Pick<CdPublication, "lease_owner" | "leased_until">, owner: string | undefined, nowMs = Date.now()): boolean {
  if (!row.lease_owner || row.lease_owner === owner) return false;
  const until = Date.parse(row.leased_until ?? "");
  return Number.isFinite(until) && until > nowMs;
}

/** True while any worker holds a live lease on the row. */
export function cdLeaseLive(row: Pick<CdPublication, "lease_owner" | "leased_until">, nowMs = Date.now()): boolean {
  if (!row.lease_owner) return false;
  const until = Date.parse(row.leased_until ?? "");
  return Number.isFinite(until) && until > nowMs;
}

const ownerOf = (owner: string): string => {
  if (typeof owner !== "string" || !owner.trim()) throw invalid("owner is required");
  return owner.trim();
};

const leaseMsOf = (ms: number | undefined): number => {
  if (ms === undefined) return CD_LEASE_MS;
  if (!Number.isInteger(ms) || ms <= 0) throw invalid("leaseMs must be a positive integer");
  return ms;
};

/** The fields a claim writes, or null when the race is lost (the revision moved, or another live lease holds the row). A stale lease is adopted. */
export function cdClaimFields(row: CdPublication, input: ClaimCdPublicationInput, nowMs = Date.now()): Pick<CdPublication, "lease_owner" | "leased_until" | "revision" | "updated_at"> | null {
  const owner = ownerOf(input.owner);
  if (!Number.isInteger(input.revision)) throw invalid("revision must be an integer");
  if (row.revision !== input.revision) return null;
  if (cdLeaseHeldByOther(row, owner, nowMs)) return null;
  if (!isActiveStep(row.step)) throw conflict(`ledger row ${row.id} is ${row.step}: nothing to run`);
  return { lease_owner: owner, leased_until: new Date(nowMs + leaseMsOf(input.leaseMs)).toISOString(), revision: row.revision + 1, updated_at: new Date(nowMs).toISOString() };
}

/** The fields a renewal writes; conflict when `owner` does not hold a live lease (the revision is untouched). */
export function cdRenewFields(row: CdPublication, input: { owner: string; leaseMs?: number }, nowMs = Date.now()): Pick<CdPublication, "leased_until"> {
  const owner = ownerOf(input.owner);
  if (row.lease_owner !== owner || !cdLeaseLive(row, nowMs)) throw conflict(`ledger row ${row.id} is not leased by ${owner}`);
  return { leased_until: new Date(nowMs + leaseMsOf(input.leaseMs)).toISOString() };
}

const nullableText = (v: unknown, what: string, max = 500): string | null => {
  if (v === null) return null;
  if (typeof v !== "string") throw invalid(`${what} must be text or null`);
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

const nullableMuxId = (v: unknown, what: string): string | null => {
  if (v === null) return null;
  if (typeof v !== "string" || !MUX_ID.test(v)) throw invalid(`${what} must be a Mux id (letters and digits)`);
  return v;
};

const nullableTime = (v: unknown, what: string): string | null => {
  if (v === null) return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw invalid(`${what} must be a timestamp or null`);
  return new Date(v).toISOString();
};

/** A `verify` object never carries a playback id or an upload URL. */
function assertCleanJson(v: Json | null): void {
  if (v === null) return;
  const text = JSON.stringify(v);
  if (/playback_?id|upload_?url|https?:\/\//i.test(text)) throw invalid("the ledger never stores a playback id or a URL");
}

/** The fields an update writes; conflict on a stale revision or a foreign live lease. A terminal row changes only by a Retry (back to an active step) or a supersede. */
export function cdUpdateFields(row: CdPublication, input: CdPublicationUpdate, nowMs = Date.now()): Partial<CdPublication> {
  if (!Number.isInteger(input.revision)) throw invalid("revision must be an integer");
  if (row.revision !== input.revision) throw conflict(`ledger row ${row.id} changed (revision ${row.revision}, you had ${input.revision}); re-read it`);
  const owner = input.owner === undefined ? undefined : ownerOf(input.owner);
  if (cdLeaseHeldByOther(row, owner, nowMs)) throw conflict(`ledger row ${row.id} is leased by ${row.lease_owner} until ${row.leased_until}`);
  const out: Partial<CdPublication> = { revision: row.revision + 1, updated_at: new Date(nowMs).toISOString() };
  if (input.step !== undefined) {
    if (!CD_PUBLICATION_STEPS.includes(input.step)) throw invalid(`unknown step: ${String(input.step)}`);
    if (row.step === "superseded" && input.step !== "superseded") throw conflict(`ledger row ${row.id} is superseded: a later upload replaced it`);
    out.step = input.step;
  }
  if (input.cd_episode_id !== undefined) {
    if (input.cd_episode_id !== null && !UUID.test(input.cd_episode_id)) throw invalid("cd_episode_id must be the platform's uuid");
    out.cd_episode_id = input.cd_episode_id === null ? null : input.cd_episode_id.toLowerCase();
  }
  if (input.replace !== undefined) out.replace = input.replace === true;
  if (input.upload_id !== undefined) out.upload_id = nullableMuxId(input.upload_id, "upload_id");
  if (input.asset_id !== undefined) out.asset_id = nullableMuxId(input.asset_id, "asset_id");
  if (input.previous_asset_id !== undefined) out.previous_asset_id = nullableMuxId(input.previous_asset_id, "previous_asset_id");
  if (input.previous_upload_id !== undefined) out.previous_upload_id = nullableMuxId(input.previous_upload_id, "previous_upload_id");
  if (input.bytes_acked !== undefined) {
    if (!Number.isInteger(input.bytes_acked) || input.bytes_acked < 0 || input.bytes_acked > row.bytes) throw invalid(`bytes_acked must be 0..${row.bytes}`);
    out.bytes_acked = input.bytes_acked;
  }
  if (input.duration_s !== undefined) {
    if (input.duration_s !== null && !(typeof input.duration_s === "number" && Number.isFinite(input.duration_s) && input.duration_s >= 0)) throw invalid("duration_s must be a length in seconds");
    out.duration_s = input.duration_s;
  }
  if (input.verify !== undefined) {
    if (input.verify !== null && (typeof input.verify !== "object" || Array.isArray(input.verify))) throw invalid("verify must be an object");
    assertCleanJson(input.verify);
    out.verify = input.verify === null ? null : (JSON.parse(JSON.stringify(input.verify)) as Json);
  }
  if (input.error !== undefined) out.error = nullableText(input.error, "error", 1000);
  if (input.error_code !== undefined) out.error_code = nullableText(input.error_code, "error_code", 64);
  if (input.cancel_requested !== undefined) out.cancel_requested = input.cancel_requested === true;
  if (input.attempts !== undefined) {
    if (!Number.isInteger(input.attempts) || input.attempts < 0) throw invalid("attempts must be a non-negative integer");
    out.attempts = input.attempts;
  }
  if (input.attempted_at !== undefined) out.attempted_at = nullableTime(input.attempted_at, "attempted_at");
  if (input.next_attempt_at !== undefined) out.next_attempt_at = nullableTime(input.next_attempt_at, "next_attempt_at");
  if (input.published_at !== undefined) out.published_at = nullableTime(input.published_at, "published_at");
  if (input.renew && owner && row.lease_owner === owner) out.leased_until = new Date(nowMs + (typeof input.renew === "number" ? leaseMsOf(input.renew) : CD_LEASE_MS)).toISOString();
  // A row that leaves the active steps lets its lease go: nobody runs a terminal row.
  const step = out.step ?? row.step;
  if (!isActiveStep(step)) {
    out.lease_owner = null;
    out.leased_until = null;
  }
  return out;
}

/** The fields a release writes; a no-op (null) when `owner` does not hold the row. */
export function cdReleaseFields(row: CdPublication, input: { owner: string }, nowMs = Date.now()): Partial<CdPublication> | null {
  const owner = ownerOf(input.owner);
  if (row.lease_owner !== owner) return null;
  return { lease_owner: null, leased_until: null, revision: row.revision + 1, updated_at: new Date(nowMs).toISOString() };
}

/**
 * A person's Stop (POST …/uploads/cancel): allowed whoever holds the lease —
 * the running worker sees the flag at its next write (its CAS fails on the
 * moved revision, it re-reads and stops before the next chunk). A row that
 * is not running (no live lease) and has sent nothing yet is failed at once.
 * Null when there is nothing to stop (a terminal row, or bytes all sent:
 * Mux has the file, only unpublish can hide it).
 */
export function cdCancelFields(row: CdPublication, nowMs = Date.now()): Partial<CdPublication> | null {
  if (row.step !== "planned" && row.step !== "upload_created") return null;
  if (row.cancel_requested && cdLeaseLive(row, nowMs)) return null;
  const base: Partial<CdPublication> = { cancel_requested: true, revision: row.revision + 1, updated_at: new Date(nowMs).toISOString() };
  if (cdLeaseLive(row, nowMs)) return base;
  return {
    ...base,
    step: "failed",
    error_code: "cancelled",
    error: row.upload_id
      ? "Stopped by a person before the last chunk; the unfinished upload on crazydramas expires within the hour and nothing reached the episode."
      : "Stopped by a person before anything was sent.",
    lease_owner: null,
    leased_until: null,
  };
}

/** A row as either backend hands it out: numbers as numbers (Postgres numeric/bigint arrive as strings). */
export function normalizeCdPublication(row: CdPublication): CdPublication {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    ...row,
    bytes: Number(row.bytes),
    bytes_acked: Number(row.bytes_acked ?? 0),
    frames: num(row.frames),
    fps: num(row.fps),
    duration_s: num(row.duration_s),
    attempts: Number(row.attempts ?? 0),
    revision: Number(row.revision),
    replace: row.replace === true,
    cancel_requested: row.cancel_requested === true,
  };
}

/** Audited moves: a row's birth, and any step change except progress within the uploader's own steps. */
export function cdStepAudited(before: Pick<CdPublication, "step">, after: Pick<CdPublication, "step">): boolean {
  if (before.step === after.step) return false;
  return !isActiveStep(after.step) || after.step === "planned";
}
