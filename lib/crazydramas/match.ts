// The matching rule (decision 2026-09-23, "the crazydramas connection"; plan
// A3): Studio's episodes against one public read of the series, paired by
// episode number, judged by FRAMES. Pure and derived — never stored, like
// lib/research/title-status.ts and lib/clips/state.ts: the snapshot row is
// the record, the reading is recomputed from it.
//
// What a duration match proves: "same length". Never "same file". A true
// "identical" needs a record of what Studio itself uploaded (the ledger of
// plan A6, not built), so the verdict exists in the type and is never
// produced in v1. The three series that are live today were uploaded by
// hand through the crazydramas CMS: for them the answer stays at "same
// length".
//
// The frame rule. d = round(durationSeconds × fps) − video_frames, with fps
// from the file and video_frames from Studio's own ffprobe count on the
// imported link (lib/film-import/import.ts). d == MUX_FRAME_OFFSET (+2) is
// "same length": all 52 Mafia King files from cut/eps.zip give exactly +2
// against the lengths Mux reports. +1, +3 and +4 are "close" — the current
// re-renders show +3 and +4 against live, so this reads as "probably an
// older render". Anything else is "different length". NEVER ±0.1 s: it
// misfires on 69 of 169 live episodes. The offset is CALIBRATED ON ONE FILM
// and must be confirmed on the first Studio-made upload before it may block
// anything (`FRAME_RULE.confirmed` stays false until then).

import type { Episode, PlatformEpisode, PlatformLink, PlatformSnapshot, Title } from "@/lib/types";

/** The measured Mux offset: round(mux_duration × fps) is the file's frame count plus two. Calibrated on one film (Mafia King, 52 files); confirm before it gates anything. */
export const MUX_FRAME_OFFSET = 2;

/** Offsets that read as "probably an older render" rather than another cut. */
export const CLOSE_FRAME_OFFSETS: readonly number[] = [1, 3, 4];

export const FRAME_RULE = {
  offset: MUX_FRAME_OFFSET,
  close: CLOSE_FRAME_OFFSETS,
  /** The one film the offset was measured on, and how many of its files agreed. */
  calibrated_on: "forced-to-marry-the-mafia-boss",
  calibrated_files: 52,
  /** Flips only after the first Studio-made upload confirms the offset (plan A3, A6). */
  confirmed: false,
} as const;

export type CrazydramasState =
  | "not_linked"
  | "not_checked"
  | "not_live"
  | "read_failed"
  | "live_complete"
  | "live_partial"
  | "live_differs"
  | "live_unverified"
  | "local_newer";

export const CRAZYDRAMAS_STATES: readonly CrazydramasState[] = ["not_linked", "not_checked", "not_live", "read_failed", "live_complete", "live_partial", "live_differs", "live_unverified", "local_newer"];

export type EpisodeVerdict = "missing" | "extra" | "not_ready" | "same_length" | "close" | "different_length" | "unknown" | "identical";

export const EPISODE_VERDICTS: readonly EpisodeVerdict[] = ["missing", "extra", "not_ready", "same_length", "close", "different_length", "unknown", "identical"];

/** Mux statuses under which an episode is not playable yet (or failed): the verdict is `not_ready` whatever its length says. */
export const NOT_READY_STATUSES: readonly string[] = ["uploading", "processing", "failed", "errored", "preparing"];

/** What the rule needs of a Studio episode: its number, the measured frame count, the measured length (for fps) and the hash (for a ledger, later). */
export type StudioEpisodeForMatch = Pick<Episode, "number"> & Partial<Pick<Episode, "video_frames" | "duration_ms" | "video_sha256">>;

/** A ledger row as plan A6 would record it. Not built; typed so the rule has its shape. */
export type LedgerRow = { episode_number: number; uploaded_sha256: string; mux_duration_s: number | null };

export type EpisodeReading = {
  n: number;
  verdict: EpisodeVerdict;
  /** round(duration_s × fps) − video_frames; null when either side is missing. */
  d_frames: number | null;
  /** Studio's side: null when Studio has no episode with this number. */
  studio: { frames: number | null; fps: number | null; duration_s: number | null } | null;
  /** The platform's side: null when the read did not list this number. */
  live: { duration_s: number | null; status: string; is_published: boolean } | null;
  /** Paid on crazydramas (past freeEpisodeCount); null when the series has no read. */
  paid: boolean | null;
};

export type VerdictCounts = Record<EpisodeVerdict, number>;

export type MatchOptions = {
  /** The film's frame rate when the caller knows it (index/source.json); inferred from frames and length otherwise. */
  fps?: number | null;
  /** The platform's freeEpisodeCount, for the free/paid flag. */
  free_episode_count?: number | null;
  /** Plan A6's ledger, when it exists. Null in v1. */
  ledger?: readonly LedgerRow[] | null;
};

export type MatchResult = {
  episodes: EpisodeReading[];
  counts: VerdictCounts & { studio: number; live: number; ready: number };
  /** The platform lists exactly 1..N. */
  numbered_1_to_n: boolean;
};

const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

/**
 * The frame rate from a frame count and a measured length, snapped to a
 * standard rate within half a percent; null when the pair does not name one.
 * The import records `video_frames` and `duration_ms` from the same ffprobe
 * on the link, so the ratio is exact for the pipeline's constant-rate files.
 */
export function inferFps(frames: number | null | undefined, durationMs: number | null | undefined): number | null {
  if (!frames || !durationMs || frames <= 0 || durationMs <= 0) return null;
  const raw = frames / (durationMs / 1000);
  let best: number | null = null;
  let bestErr = Infinity;
  for (const fps of STANDARD_FPS) {
    const err = Math.abs(raw - fps) / fps;
    if (err < bestErr) {
      bestErr = err;
      best = fps;
    }
  }
  return best !== null && bestErr <= 0.005 ? best : null;
}

/** The frame difference the rule judges: round(duration_s × fps) − frames. */
export function frameDelta(durationS: number | null | undefined, fps: number | null | undefined, frames: number | null | undefined): number | null {
  if (durationS === null || durationS === undefined || !fps || frames === null || frames === undefined) return null;
  return Math.round(durationS * fps) - frames;
}

/** The verdict for one frame difference, once both sides exist and the platform's episode is ready. */
export function verdictForDelta(d: number | null): Extract<EpisodeVerdict, "same_length" | "close" | "different_length" | "unknown"> {
  if (d === null) return "unknown";
  if (d === MUX_FRAME_OFFSET) return "same_length";
  if (CLOSE_FRAME_OFFSETS.includes(d)) return "close";
  return "different_length";
}

const zeroCounts = (): VerdictCounts => ({ missing: 0, extra: 0, not_ready: 0, same_length: 0, close: 0, different_length: 0, unknown: 0, identical: 0 });

/**
 * Studio's episodes against the platform's list, paired by number. The
 * platform lists published episodes only, so a Studio number it lacks is
 * `missing`; a platform number Studio lacks is `extra`; a platform episode
 * still uploading, processing or failed is `not_ready` before any length is
 * read; then the frame rule. `identical` needs a ledger row whose sha is the
 * file's own AND whose Mux length passes the frame rule.
 */
export function matchEpisodes(studio: readonly StudioEpisodeForMatch[], live: readonly PlatformEpisode[], opts: MatchOptions = {}): MatchResult {
  const byLive = new Map(live.map((e) => [e.n, e]));
  const byStudio = new Map(studio.map((e) => [e.number, e]));
  const numbers = [...new Set([...byStudio.keys(), ...byLive.keys()])].sort((a, b) => a - b);
  const free = opts.free_episode_count ?? null;
  const ledger = new Map((opts.ledger ?? []).map((r) => [r.episode_number, r]));
  const counts = { ...zeroCounts(), studio: studio.length, live: live.length, ready: 0 };
  const episodes: EpisodeReading[] = [];
  for (const n of numbers) {
    const s = byStudio.get(n) ?? null;
    const l = byLive.get(n) ?? null;
    const fps = s ? opts.fps ?? inferFps(s.video_frames, s.duration_ms) : null;
    const reading: EpisodeReading = {
      n,
      verdict: "unknown",
      d_frames: null,
      studio: s ? { frames: s.video_frames ?? null, fps, duration_s: s.duration_ms ? Math.round(s.duration_ms) / 1000 : null } : null,
      live: l ? { duration_s: l.duration_s, status: l.status, is_published: l.is_published } : null,
      paid: l && free !== null ? n > free : null,
    };
    if (l && !NOT_READY_STATUSES.includes(l.status)) counts.ready += 1;
    if (!l) reading.verdict = "missing";
    else if (!s) reading.verdict = "extra";
    else if (NOT_READY_STATUSES.includes(l.status) || l.duration_s === null) reading.verdict = "not_ready";
    else {
      reading.d_frames = frameDelta(l.duration_s, fps, s.video_frames);
      reading.verdict = verdictForDelta(reading.d_frames);
      const row = ledger.get(n);
      if (row && s.video_sha256 && row.uploaded_sha256 === s.video_sha256 && verdictForDelta(frameDelta(row.mux_duration_s, fps, s.video_frames)) === "same_length" && reading.verdict === "same_length") {
        reading.verdict = "identical";
      }
    }
    counts[reading.verdict] += 1;
    episodes.push(reading);
  }
  const liveNumbers = [...byLive.keys()].sort((a, b) => a - b);
  const numbered = liveNumbers.every((n, i) => n === i + 1);
  return { episodes, counts, numbered_1_to_n: numbered };
}

/**
 * The series state from one good read, first rule that applies (plan A3,
 * with the two states the table left implicit — a linked title nobody has
 * read yet, and a live series Studio holds no frame counts for):
 *
 *   live_partial     a Studio episode is not on the platform, or is not ready there yet
 *   live_differs     an episode is another length, the platform has an episode Studio does not, or its numbers are not 1..N
 *   local_newer      only with a ledger: Studio's file is not the one it uploaded (never in v1)
 *   live_unverified  every episode is there and ready, but Studio has no frame count for one of them
 *   live_complete    counts equal, numbers 1..N, every episode ready and "same length" (or "close": an older render)
 */
export function stateFromMatch(m: MatchResult, opts: { ledger?: readonly LedgerRow[] | null; studio?: readonly StudioEpisodeForMatch[] } = {}): Extract<CrazydramasState, "live_complete" | "live_partial" | "live_differs" | "live_unverified" | "local_newer"> {
  if (m.counts.missing > 0 || m.counts.not_ready > 0) return "live_partial";
  if (m.counts.different_length > 0 || m.counts.extra > 0 || !m.numbered_1_to_n) return "live_differs";
  if (opts.ledger?.length && opts.studio) {
    const byN = new Map(opts.studio.map((e) => [e.number, e]));
    if (opts.ledger.some((r) => { const s = byN.get(r.episode_number); return !!s?.video_sha256 && s.video_sha256 !== r.uploaded_sha256; })) return "local_newer";
  }
  if (m.counts.unknown > 0) return "live_unverified";
  return "live_complete";
}

/** True when the state asks for the faster sweep (every 15 minutes rather than hourly; plan A5). */
export function isHotState(state: CrazydramasState): boolean {
  return state === "live_partial" || state === "live_differs";
}

// ---- the status the screens read ----------------------------------------------------------------

export type CrazydramasSeriesFacts = {
  id: string;
  title: string;
  status: string;
  language: string | null;
  free_episode_count: number;
  series_price_cents: number | null;
  iap_product_id: string | null;
  /** An IAP product is set (the store builds can sell it); the id itself is beside it. */
  iap_product_set: boolean;
  poster_url: string | null;
  /** The poster URL contains `-placeholder`: the series still shows the stand-in art. */
  poster_placeholder: boolean;
  episode_count: number;
  /** Who may change the series (an authenticated read, phase 5): `cms` series are read-only for Studio. Null when the read did not say (a public read). */
  managed_by: "studio" | "cms" | null;
};

export type CrazydramasStatus = {
  state: CrazydramasState;
  /** The slug Studio reads: the link's (which follows a CMS rename through the catalog), else the title's own. */
  slug: string | null;
  link: { cd_drama_id: string; slug: string; linked_at: string } | null;
  /** When the reading was taken (`read_at` of the snapshot it comes from): the "observed" time the screens label. Null when nothing was read. */
  checked_at: string | null;
  /** The newest read failed and this reading is the last good one. */
  stale: boolean;
  /** The newest read's failure, when it failed. */
  failed_at: string | null;
  error: string | null;
  http_status: number | null;
  /** `slug_reassigned`: the slug now serves another drama than the one linked (a CMS edit); the series is read as not live. */
  note: "slug_reassigned" | null;
  /**
   * Why a series reads `not_live`, when the read can tell (phase 5, spec §7):
   * `not_uploaded` (the authenticated read answered 404: nothing on
   * crazydramas), `draft` or `archived` (the authenticated read sees the
   * series; it is not published). Null otherwise — a public 404 is still
   * "not uploaded, or draft".
   */
  detail: "not_uploaded" | "draft" | "archived" | null;
  /** Which read the reading comes from (`studio` = authenticated, `public`), null when nothing was read or the row predates it. */
  read_via: "public" | "studio" | null;
  series: CrazydramasSeriesFacts | null;
  episodes: EpisodeReading[];
  counts: MatchResult["counts"];
  /** Free is 1..freeEpisodeCount of the platform's list, paid the rest; null without a live read. */
  free_paid: { free: number; paid: number } | null;
  numbered_1_to_n: boolean | null;
  frame_rule: typeof FRAME_RULE;
};

export type StatusOptions = Pick<MatchOptions, "fps" | "ledger">;

/**
 * What a chip needs of a status (the title header, the catalog cell, an
 * Import row): the state, whether the read shown is a stale one, and whether
 * a complete series has episodes that read "close" — older renders, still
 * complete — the one qualifier "complete" carries, in words and never as a
 * count (decision 2026-09-08, "status board").
 */
export type CrazydramasChipReading = { state: CrazydramasState; stale: boolean; older: boolean };

export function chipReading(status: Pick<CrazydramasStatus, "state" | "stale" | "counts">): CrazydramasChipReading {
  return { state: status.state, stale: status.stale, older: status.state === "live_complete" && status.counts.close > 0 };
}

const emptyCounts = (studio: number): MatchResult["counts"] => ({ ...zeroCounts(), studio, live: 0, ready: 0 });

function seriesFacts(d: NonNullable<PlatformSnapshot["drama"]>): CrazydramasSeriesFacts {
  return {
    id: d.id,
    title: d.title,
    status: d.status,
    language: d.language,
    free_episode_count: d.free_episode_count,
    series_price_cents: d.series_price_cents,
    iap_product_id: d.iap_product_id,
    iap_product_set: !!d.iap_product_id,
    poster_url: d.poster_url,
    poster_placeholder: !!d.poster_url && d.poster_url.includes("-placeholder"),
    episode_count: d.episode_count,
    managed_by: d.managed_by === "studio" || d.managed_by === "cms" ? d.managed_by : null,
  };
}

function isGoodRead(s: PlatformSnapshot): boolean {
  return s.error === null && (s.http_status === 200 || s.http_status === 404);
}

/**
 * The one reading every screen calls (the catalog column, the title header
 * chip, the crazydramas section, the import page), from what the data layer
 * holds: the title, its episode rows, its snapshots NEWEST FIRST (or the one
 * newest snapshot) and its link. Pure; the same input gives the same status
 * on both backends.
 */
export function crazydramasStatusFor(
  title: Pick<Title, "crazydramas_slug">,
  episodes: readonly StudioEpisodeForMatch[],
  snapshot: PlatformSnapshot | readonly PlatformSnapshot[] | null | undefined,
  link: PlatformLink | null | undefined,
  opts: StatusOptions = {}
): CrazydramasStatus {
  const list = (Array.isArray(snapshot) ? snapshot : snapshot ? [snapshot as PlatformSnapshot] : []) as PlatformSnapshot[];
  const slug = link?.slug ?? title.crazydramas_slug?.trim() ?? null;
  const base: CrazydramasStatus = {
    state: "not_linked",
    slug: slug || null,
    link: link ? { cd_drama_id: link.cd_drama_id, slug: link.slug, linked_at: link.linked_at } : null,
    checked_at: null,
    stale: false,
    failed_at: null,
    error: null,
    http_status: null,
    note: null,
    detail: null,
    read_via: null,
    series: null,
    episodes: [],
    counts: emptyCounts(episodes.length),
    free_paid: null,
    numbered_1_to_n: null,
    frame_rule: FRAME_RULE,
  };
  if (!base.slug) return base;
  if (!list.length) return { ...base, state: "not_checked" };

  const newest = list[0];
  const good = list.find(isGoodRead) ?? null;
  const failed = !isGoodRead(newest);
  if (failed) {
    base.state = "read_failed";
    base.failed_at = newest.read_at;
    base.error = newest.error ?? "the read failed";
    base.http_status = newest.http_status;
    base.stale = !!good;
    if (!good) return base;
  }
  const read = good!;
  base.checked_at = read.read_at;
  base.read_via = read.read_via ?? null;
  if (!failed) base.http_status = read.http_status;
  if (read.http_status !== 200 || !read.drama || !read.episodes) {
    if (!failed) base.state = "not_live";
    // The authenticated read sees drafts: its 404 is "nothing uploaded" (spec §7); a public 404 cannot tell.
    if (read.http_status === 404 && read.read_via === "studio") base.detail = "not_uploaded";
    return base;
  }
  // The link names the drama; a 200 for another drama under the same slug is a CMS rename, not this series.
  if (link && read.drama.id !== link.cd_drama_id) {
    if (!failed) base.state = "not_live";
    base.note = "slug_reassigned";
    return base;
  }
  // The authenticated read sees a series that is not published (a draft, or archived): not live, with the reason, and its
  // episodes read against Studio's so the screens can say which are there. A published series is judged, as in v1, on the
  // episodes viewers see: an unpublished one reads missing.
  const status = read.drama.status;
  const notPublished = status === "draft" || status === "archived";
  const liveEpisodes = notPublished ? read.episodes : read.episodes.filter((e) => e.is_published);
  const match = matchEpisodes(episodes, liveEpisodes, { fps: opts.fps, free_episode_count: read.drama.free_episode_count, ledger: opts.ledger });
  const free = liveEpisodes.filter((e) => e.n <= read.drama!.free_episode_count).length;
  return {
    ...base,
    state: failed ? "read_failed" : notPublished ? "not_live" : stateFromMatch(match, { ledger: opts.ledger, studio: episodes }),
    detail: notPublished ? (status as "draft" | "archived") : null,
    series: seriesFacts(read.drama),
    episodes: match.episodes,
    counts: match.counts,
    free_paid: { free, paid: liveEpisodes.length - free },
    numbered_1_to_n: match.numbered_1_to_n,
  };
}
