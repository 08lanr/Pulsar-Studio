// A provider asked us to come back later — Meta is still transcoding an
// uploaded clip, for example. That is not a failure: the campaign keeps its
// checkpoints, the run stays open, and the worker returns after `retryAfterMs`
// (the scheduler's sweep also picks it up). Nothing is re-uploaded on resume.

export class LaunchWaiting extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 45_000) {
    super(message);
    this.name = "LaunchWaiting";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isLaunchWaiting(error: unknown): error is LaunchWaiting {
  return error instanceof LaunchWaiting || (error instanceof Error && error.name === "LaunchWaiting");
}

/** What a campaign row records while it waits; the monitor reads it. */
export type WaitingState = { reason: string; since: string; retry_after_ms: number };

// Provider refusals that mean "later", not "no": a rate limit, a timeout, a
// 5xx or a lost response. Meta's codes are its documented transient ones (the
// same set lib/meta/publish.ts waits on); TikTok's transport folds a timeout,
// an unreachable host, an unreadable body and a throttle into these sentences.
const META_TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613]);
const TIKTOK_TRANSIENT = /did not respond in time|could not reach tiktok|unreadable response|qps limit|too many request|rate limit/i;
const PROVIDER_RETRY_MS = 60_000;

/** The delay before a provider's "later" is worth another attempt, or null when the refusal is final. */
export function providerRetryDelay(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "MetaApiError") {
    const meta = error as Error & { code?: number; ambiguous?: boolean };
    if (meta.ambiguous || (meta.code !== undefined && META_TRANSIENT_CODES.has(meta.code)) || /HTTP 5\d\d/.test(error.message)) return PROVIDER_RETRY_MS;
    return null;
  }
  return TIKTOK_TRANSIENT.test(error.message) ? PROVIDER_RETRY_MS : null;
}
