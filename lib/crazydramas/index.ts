// The one door to lib/crazydramas (decision 2026-09-23, "the crazydramas
// connection"): every caller outside this folder asks here, and nothing
// imports transport.ts or fake.ts for a transport directly. Which transport
// the app reads — the fake in fixture mode, the live one in Supabase mode,
// CRAZYDRAMAS_LIVE_READ=1 as the engineer's override — is decided in
// pick.ts, which the modules inside this folder import directly: a module
// here never imports "./index" (that cycle broke `next build`). The reading
// the screens call (crazydramasStatusFor) and the rule constants are
// re-exported from match.ts.

export { crazydramasReadMode, crazydramasTransport } from "./pick";
export type { CrazydramasReadMode } from "./pick";
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
  chipReading,
  crazydramasStatusFor,
  frameDelta,
  inferFps,
  isHotState,
  matchEpisodes,
  stateFromMatch,
  verdictForDelta,
} from "./match";
export type { CrazydramasChipReading, CrazydramasSeriesFacts, CrazydramasState, CrazydramasStatus, EpisodeReading, EpisodeVerdict, LedgerRow, MatchOptions, MatchResult, StatusOptions, StudioEpisodeForMatch, VerdictCounts } from "./match";
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
