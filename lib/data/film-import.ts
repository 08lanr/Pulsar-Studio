// The one set of rules both backends apply to the workspace import's writes
// (decision 2026-09-22; migration 0015): what a source_ref looks like, which
// episode import fields are well formed, what an ad rule is, what a film
// asset row must carry. The fixture store re-implements the SQL checks with
// these; the Supabase layer runs them before the insert so a bad value is an
// `invalid` DataError in both modes, never a Postgres check-constraint error
// with a different message.

import type { AdExclusion, AdRules, Episode, FilmAsset, FilmAssetKind, FilmAssetOrigin } from "@/lib/types";
import { invalid } from "./errors";
import type { EpisodeImportInput, NewFilmAsset } from "./index";

export const FILM_ASSET_KINDS: readonly FilmAssetKind[] = ["transcript", "shots", "motion", "candidates", "source_facts", "delivered_plan", "vision_notes", "film_meta", "poster"];
export const FILM_ASSET_ORIGINS: readonly FilmAssetOrigin[] = ["workspace", "studio"];
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A source_ref is the film's folder under WORKSPACE_ROOT, forward slashes,
 * no leading or trailing slash, no `.` / `..` segment: `low-quality/mafia-king`.
 */
export function normalizeSourceRef(ref: string): string {
  const cleaned = (ref ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!cleaned) throw invalid("source_ref is required");
  if (cleaned.split("/").some((s) => !s || s === "." || s === "..")) throw invalid("source_ref must be a plain relative path");
  return cleaned;
}

const nonNegativeInt = (v: number | null | undefined, name: string): number | null => {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < 0) throw invalid(`${name} must be a non-negative integer`);
  return v;
};

/** The columns a patch writes, validated; keys absent from `patch` are absent here too. */
export function episodeImportPatch(patch: EpisodeImportInput, current?: Pick<Episode, "film_start_ms" | "film_end_ms">): Partial<Episode> {
  const out: Partial<Episode> = {};
  if (patch.video_path !== undefined) {
    if (typeof patch.video_path !== "string" || !patch.video_path.trim()) throw invalid("video_path must be a stored path");
    out.video_path = patch.video_path;
  }
  if (patch.source_ref !== undefined) out.source_ref = patch.source_ref === null ? null : normalizeSourceRef(patch.source_ref);
  if (patch.video_sha256 !== undefined) {
    if (patch.video_sha256 !== null && !SHA256_HEX.test(patch.video_sha256)) throw invalid("video_sha256 must be 64 hex characters");
    out.video_sha256 = patch.video_sha256;
  }
  if (patch.video_bytes !== undefined) out.video_bytes = nonNegativeInt(patch.video_bytes, "video_bytes");
  if (patch.video_frames !== undefined) out.video_frames = nonNegativeInt(patch.video_frames, "video_frames");
  if (patch.film_start_ms !== undefined) out.film_start_ms = nonNegativeInt(patch.film_start_ms, "film_start_ms");
  if (patch.film_end_ms !== undefined) out.film_end_ms = nonNegativeInt(patch.film_end_ms, "film_end_ms");
  const start = out.film_start_ms !== undefined ? out.film_start_ms : current?.film_start_ms ?? null;
  const end = out.film_end_ms !== undefined ? out.film_end_ms : current?.film_end_ms ?? null;
  if (start !== null && end !== null && end < start) throw invalid("film_end_ms must not be before film_start_ms");
  if (patch.end_note !== undefined) out.end_note = patch.end_note;
  if (patch.auto_cut !== undefined) {
    if (typeof patch.auto_cut !== "boolean") throw invalid("auto_cut must be a boolean");
    out.auto_cut = patch.auto_cut;
  }
  return out;
}

/** A clean copy of the rules, or `invalid`: a spoiler line at or after 0, exclusions with from < to and a reason. */
export function validateAdRules(rules: AdRules): AdRules {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw invalid("ad_rules must be an object");
  const spoiler = rules.spoiler_from_s ?? null;
  if (spoiler !== null && (typeof spoiler !== "number" || !Number.isFinite(spoiler) || spoiler < 0)) throw invalid("spoiler_from_s must be a non-negative number of seconds");
  if (!Array.isArray(rules.exclusions)) throw invalid("exclusions must be a list");
  const exclusions: AdExclusion[] = rules.exclusions.map((x, i) => {
    if (!x || typeof x !== "object") throw invalid(`exclusion ${i + 1} must be an object`);
    const { from_s, to_s, why, source } = x;
    if (typeof from_s !== "number" || typeof to_s !== "number" || !Number.isFinite(from_s) || !Number.isFinite(to_s) || from_s < 0 || to_s <= from_s) {
      throw invalid(`exclusion ${i + 1} needs from_s < to_s, both in seconds`);
    }
    if (typeof why !== "string" || !why.trim()) throw invalid(`exclusion ${i + 1} needs a reason`);
    if (source !== undefined && source !== "film_meta" && source !== "review") throw invalid(`exclusion ${i + 1} has an unknown source`);
    return source === undefined ? { from_s, to_s, why: why.trim() } : { from_s, to_s, why: why.trim(), source };
  });
  return { spoiler_from_s: spoiler, exclusions };
}

/** The row a film asset insert writes, validated. */
export function filmAssetRow(input: NewFilmAsset): Omit<FilmAsset, "id" | "created_at"> {
  if (!FILM_ASSET_KINDS.includes(input.kind)) throw invalid(`unknown film asset kind: ${String(input.kind)}`);
  if (!FILM_ASSET_ORIGINS.includes(input.origin)) throw invalid(`unknown film asset origin: ${String(input.origin)}`);
  if (typeof input.storage_path !== "string" || !input.storage_path.trim()) throw invalid("storage_path is required");
  if (!SHA256_HEX.test(input.sha256 ?? "")) throw invalid("sha256 must be 64 hex characters");
  if (!Number.isInteger(input.bytes) || input.bytes < 0) throw invalid("bytes must be a non-negative integer");
  return {
    title_id: input.title_id,
    kind: input.kind,
    storage_path: input.storage_path,
    sha256: input.sha256,
    bytes: input.bytes,
    origin: input.origin,
    source_ref: input.source_ref === undefined || input.source_ref === null ? null : normalizeSourceRef(input.source_ref),
    meta: input.meta ?? {},
  };
}
