// Which crazydramas the app reads (decision 2026-09-23, "the crazydramas
// connection"; plan A2), the way lib/meta/index.ts and lib/tiktok/index.ts
// choose:
//
//   fixture mode    the fake, always: no network, the fixture catalog that
//                   mirrors tests/fixtures/workspace. One exception for
//                   engineers: CRAZYDRAMAS_LIVE_READ=1 allows the public
//                   reads from fixture mode (they cost nothing and write
//                   nothing on crazydramas; the snapshots land in the
//                   in-memory store).
//   supabase mode   the live transport against CRAZYDRAMAS_BASE_URL.
//
// Every caller asks here; nothing imports transport.ts or fake.ts for a
// transport directly. The reading the screens call (crazydramasStatusFor)
// and the rule constants are re-exported from match.ts.

import { dataSource } from "@/lib/data-source";
import { fakeCrazydramasTransport } from "./fake";
import { liveCrazydramasTransport, type CrazydramasTransport } from "./transport";

export type CrazydramasReadMode = "fake" | "live";

export function crazydramasReadMode(): CrazydramasReadMode {
  if (dataSource() === "fixture") return process.env.CRAZYDRAMAS_LIVE_READ === "1" ? "live" : "fake";
  return "live";
}

/** A base URL or an override can never make a test reach crazydramas: the live transport refuses under node:test. */
export function crazydramasTransport(): CrazydramasTransport {
  if (typeof window !== "undefined") throw new Error("crazydramas reads are server-only.");
  return crazydramasReadMode() === "fake" ? fakeCrazydramasTransport : liveCrazydramasTransport;
}

export { CrazydramasApiError, crazydramasBaseUrl, crazydramasPublicUrl, DEFAULT_BASE_URL } from "./transport";
export type { CrazydramasTransport } from "./transport";
export { FAKE_SLUGS } from "./fake";
export {
  CLOSE_FRAME_OFFSETS,
  CRAZYDRAMAS_STATES,
  EPISODE_VERDICTS,
  FRAME_RULE,
  MUX_FRAME_OFFSET,
  NOT_READY_STATUSES,
  crazydramasStatusFor,
  frameDelta,
  inferFps,
  isHotState,
  matchEpisodes,
  stateFromMatch,
  verdictForDelta,
} from "./match";
export type { CrazydramasSeriesFacts, CrazydramasState, CrazydramasStatus, EpisodeReading, EpisodeVerdict, LedgerRow, MatchOptions, MatchResult, StatusOptions, StudioEpisodeForMatch, VerdictCounts } from "./match";
export { CRAZYDRAMAS_SLUG, PLATFORM, PLATFORM_SNAPSHOTS_KEEP, isMockSlug, parseCatalog, parseSeries } from "./types";
export type { CatalogEntry, SeriesRead } from "./types";
export {
  CHECK_MIN_AGE_MS,
  SWEEP_EVERY_MS,
  SWEEP_HOT_EVERY_MS,
  checkAfterImport,
  checkCrazydramasTitle,
  crazydramasSweepStatus,
  listUnmatchedCrazydramas,
  loadCrazydramasStatus,
  loadCrazydramasStatuses,
  resolveReadSlug,
  sweepCrazydramas,
  tickCrazydramas,
} from "./sweep";
export type { CheckOptions, CheckResult, ReadSlug, SweepSummary, TickResult, UnmatchedSeries } from "./sweep";
