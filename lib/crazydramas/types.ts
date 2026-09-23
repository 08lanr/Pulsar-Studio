// What Studio reads from crazydramas.com and what it keeps (decision
// 2026-09-23, "the crazydramas connection"; plan A1–A3). Read-only v1: two
// public endpoints, no credentials.
//
//   GET /api/dramas           the catalog (published series; the edge cache
//                             mixes in `mock-*` series, dropped here)
//   GET /api/dramas/<slug>    one series with its published episodes; 404 is
//                             "not live" — a draft or an archived series also
//                             answers 404, so it never means "not uploaded"
//
// The zod schemas are WHITELISTS: `thumbnailUrl` carries the Mux playback id
// of paid episodes (a paywall leak on crazydramas) and `playbackId` /
// `previewPlaybackId` are the ids themselves, so nothing outside the fields
// named here survives a parse — not into a snapshot row, a log or a response.
// This module is also where both data backends get the one rule set for a
// link and a snapshot row, the way lib/data/film-import.ts is for the import.

import { z } from "zod";
import type { PlatformDrama, PlatformEpisode, PlatformLink, PlatformName, PlatformSnapshot } from "@/lib/types";
import { invalid } from "@/lib/data/errors";

export const PLATFORM: PlatformName = "crazydramas";
export const PLATFORMS: readonly PlatformName[] = ["crazydramas"];

/** How many snapshot rows of a slug the sweep keeps (plan A2). */
export const PLATFORM_SNAPSHOTS_KEEP = 20;

/** A crazydramas slug: lowercase words joined by hyphens (`forced-to-marry-the-mafia-boss`). */
export const CRAZYDRAMAS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Series the edge cache mixes into the catalog for design work; never real. */
export function isMockSlug(slug: string): boolean {
  return slug.startsWith("mock-");
}

// ---- the public API, whitelisted -----------------------------------------------------------------

const nullableString = z.string().nullish().transform((v) => (typeof v === "string" ? v : null));
const nullableNumber = z.number().nullish().transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));

/** `GET /api/dramas` entries and the `drama` object of a series read, minus everything not named. */
export const PublicDramaSchema = z.object({
  id: z.string().regex(UUID),
  slug: z.string().min(1),
  title: z.string(),
  status: z.string(),
  language: nullableString,
  freeEpisodeCount: z.number().int().nonnegative().nullish().transform((v) => v ?? 0),
  seriesPriceCents: nullableNumber,
  iapProductId: nullableString,
  posterUrl: nullableString,
  posterBlurhash: nullableString,
  episodeCount: z.number().int().nonnegative().nullish().transform((v) => v ?? 0),
  ctaMode: nullableString,
});

/** One episode of a series read: the number, the length Mux reported, the processing status and whether it is published. Never `playbackId` or `thumbnailUrl`. */
export const PublicEpisodeSchema = z.object({
  episodeNumber: z.number().int().positive(),
  durationSeconds: nullableNumber,
  status: z.string(),
  isPublished: z.boolean().nullish().transform((v) => v === true),
});

export const CatalogSchema = z.object({ dramas: z.array(PublicDramaSchema) });

export const SeriesSchema = z.object({
  drama: PublicDramaSchema.extend({ episodes: z.array(PublicEpisodeSchema).default([]) }),
});

export type PublicDrama = z.infer<typeof PublicDramaSchema>;
export type PublicEpisode = z.infer<typeof PublicEpisodeSchema>;

/** The catalog as the transport hands it out: parsed, whitelisted, the mock series dropped. */
export type CatalogEntry = PlatformDrama;

/** One series read as the transport hands it out. A 404 is a value, not a throw: "not live" is an answer. */
export type SeriesRead =
  | { http_status: 200; drama: PlatformDrama; episodes: PlatformEpisode[] }
  | { http_status: 404; drama: null; episodes: null };

/** The public object in the row's own field names (snake_case, like every other jsonb Studio keeps). */
export function toPlatformDrama(d: PublicDrama): PlatformDrama {
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    status: d.status,
    language: d.language,
    free_episode_count: d.freeEpisodeCount,
    series_price_cents: d.seriesPriceCents,
    iap_product_id: d.iapProductId,
    poster_url: d.posterUrl,
    poster_blurhash: d.posterBlurhash,
    episode_count: d.episodeCount,
    cta_mode: d.ctaMode,
  };
}

export function toPlatformEpisode(e: PublicEpisode): PlatformEpisode {
  return { n: e.episodeNumber, duration_s: e.durationSeconds, status: e.status, is_published: e.isPublished };
}

/** Parse a catalog body: the whitelist, then the mock series out. Throws a ZodError on a body that is not the catalog. */
export function parseCatalog(body: unknown): CatalogEntry[] {
  return CatalogSchema.parse(body).dramas.filter((d) => !isMockSlug(d.slug)).map(toPlatformDrama);
}

/** Parse a series body (a 200). The episodes come back sorted by number. */
export function parseSeries(body: unknown): Extract<SeriesRead, { http_status: 200 }> {
  const { drama } = SeriesSchema.parse(body);
  const { episodes, ...rest } = drama;
  return {
    http_status: 200,
    drama: toPlatformDrama(rest),
    episodes: episodes.map(toPlatformEpisode).sort((a, b) => a.n - b.n),
  };
}

// ---- the rows both backends write ---------------------------------------------------------------

export type NewPlatformLinkInput = {
  title_id: string;
  platform: PlatformName;
  /** The slug the drama is read under. */
  slug: string;
  cd_drama_id: string;
  /** The title's own slug at link time; `slug` when absent (a first link, a re-point). A followed CMS rename passes the existing link's so it stays. */
  title_slug?: string | null;
};

/** The link an upsert writes, validated. */
export function platformLinkRow(input: NewPlatformLinkInput): Omit<PlatformLink, "id" | "linked_at" | "linked_by"> {
  if (!PLATFORMS.includes(input.platform)) throw invalid(`unknown platform: ${String(input.platform)}`);
  if (typeof input.title_id !== "string" || !input.title_id.trim()) throw invalid("title_id is required");
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (!CRAZYDRAMAS_SLUG.test(slug)) throw invalid("slug must be lowercase words joined by hyphens");
  const titleSlug = typeof input.title_slug === "string" && input.title_slug.trim() ? input.title_slug.trim() : slug;
  if (!CRAZYDRAMAS_SLUG.test(titleSlug)) throw invalid("title_slug must be lowercase words joined by hyphens");
  const id = typeof input.cd_drama_id === "string" ? input.cd_drama_id.trim().toLowerCase() : "";
  if (!UUID.test(id)) throw invalid("cd_drama_id must be the platform's uuid");
  return { title_id: input.title_id, platform: input.platform, slug, title_slug: titleSlug, cd_drama_id: id };
}

export type NewPlatformSnapshotInput = {
  platform: PlatformName;
  slug: string;
  cd_drama_id?: string | null;
  title_id?: string | null;
  http_status?: number | null;
  drama?: PlatformDrama | null;
  episodes?: PlatformEpisode[] | null;
  error?: string | null;
  /** Test hook; now when absent. */
  read_at?: string;
};

/** The snapshot an insert writes, validated: a good read carries a drama and episodes, a failed one an error. */
export function platformSnapshotRow(input: NewPlatformSnapshotInput): Omit<PlatformSnapshot, "id"> {
  if (!PLATFORMS.includes(input.platform)) throw invalid(`unknown platform: ${String(input.platform)}`);
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (!CRAZYDRAMAS_SLUG.test(slug)) throw invalid("slug must be lowercase words joined by hyphens");
  const id = input.cd_drama_id ?? null;
  if (id !== null && !UUID.test(id)) throw invalid("cd_drama_id must be the platform's uuid");
  const status = input.http_status ?? null;
  if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) throw invalid("http_status must be an HTTP status");
  const error = typeof input.error === "string" && input.error.trim() ? input.error.trim().slice(0, 500) : null;
  const drama = input.drama ?? null;
  const episodes = input.episodes ?? null;
  if (status === 200 && (!drama || !episodes)) throw invalid("a 200 snapshot carries the drama and its episodes");
  if (status !== 200 && (drama || episodes)) throw invalid("only a 200 snapshot carries a body");
  if (status === null && !error) throw invalid("a snapshot without a status is a failed read and needs its error");
  if (drama) assertNoLeak(drama);
  const readAt = input.read_at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(readAt))) throw invalid("read_at must be a timestamp");
  return {
    platform: input.platform,
    slug,
    cd_drama_id: id ? id.toLowerCase() : drama?.id ?? null,
    title_id: input.title_id ?? null,
    http_status: status,
    drama: drama ? { ...drama } : null,
    episodes: episodes ? episodes.map((e) => ({ n: e.n, duration_s: e.duration_s, status: e.status, is_published: e.is_published })) : null,
    read_at: readAt,
    error,
  };
}

/** A body that reached the row through the whitelist has none of these keys; a hand-built one is refused. */
function assertNoLeak(drama: object): void {
  for (const key of ["playbackId", "playback_id", "thumbnailUrl", "thumbnail_url", "previewPlaybackId", "preview_playback_id"]) {
    if (key in drama) throw invalid(`a snapshot never stores ${key}`);
  }
}

/** A row as either backend hands it out: the jsonb columns typed, the episodes sorted. */
export function normalizePlatformSnapshot(row: PlatformSnapshot): PlatformSnapshot {
  const drama = row.drama && typeof row.drama === "object" && !Array.isArray(row.drama) ? row.drama : null;
  const episodes = Array.isArray(row.episodes) ? [...row.episodes].sort((a, b) => a.n - b.n) : null;
  return { ...row, drama, episodes };
}
