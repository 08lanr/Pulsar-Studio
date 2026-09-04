// Small helpers for talking to OUR OWN backend from the browser.
// Ported from overlord.

export type ApiErrorBody = {
  error?: string;
  detail?: { message?: string };
};

/**
 * Turn an error response from our API into one readable sentence.
 * In development the server also attaches the provider's raw payload as `detail`,
 * whose message usually explains exactly what the provider disliked.
 */
export function describeError(data: ApiErrorBody): string {
  const base = data.error || "Something went wrong";
  const extra = data.detail?.message;
  return extra && extra !== base ? `${base} — ${extra}` : base;
}

// A 401 means the session expired: every screen's next fetch lands here, so
// this is the one place to route people to the door. The never-resolving
// promise is deliberate — the page is navigating away, and letting callers
// proceed with a JSON error would spray error messages over a page that is
// about to disappear.
function redirectToLogin<T>(): Promise<T> {
  window.location.href = "/login";
  return new Promise<T>(() => {});
}

/**
 * Ceiling on any GET to our own API. Bounded on purpose: an unbounded
 * request that never receives response bytes holds a "refreshing" flag up
 * forever (seen live in overlord — one quietly-dead connection froze a
 * dashboard for an hour while the server was healthy).
 */
export const GET_TIMEOUT_MS = 120_000;

/** A non-2xx from our own API, with the status and envelope attached. */
export class ApiRequestError extends Error {
  status: number;
  body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(describeError(body));
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

/**
 * GETs THROW on any non-2xx (besides the 401 redirect): a page that treats
 * `{error: "Not found"}` as data renders a permanent skeleton or a blank —
 * with no message and no retry. Callers put real error states in `.catch`.
 * (POSTs keep resolving with the envelope — their callers read `.error`.)
 */
export async function getJson<T>(
  url: string,
  timeoutMs: number = GET_TIMEOUT_MS
): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401) return redirectToLogin<T>();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiRequestError(res.status, data as ApiErrorBody);
  return data as T;
}

export async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  /**
   * POSTs default to UNBOUNDED on purpose: a launch runs long and its
   * server-side work survives a hung-up client — aborting early buys
   * nothing. Pass a bound only where the caller wants one.
   */
  timeoutMs?: number
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (res.status === 401) return redirectToLogin<T>();
  return res.json();
}

/** Multipart POST for file uploads (product photos, creative files). */
export async function postForm<T>(url: string, form: FormData): Promise<T> {
  const res = await fetch(url, { method: "POST", body: form });
  if (res.status === 401) return redirectToLogin<T>();
  return res.json();
}
