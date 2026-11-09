// Google OAuth for the AdMob API (decision 2026-11-09, "Ad unlocks in Studio"). Server-only.
//
// The OAuth client (Google Cloud project crazydrama-play, consent screen Internal to itspulsar.com) is
// ADMOB_OAUTH_CLIENT_ID and ADMOB_OAUTH_CLIENT_SECRET in Studio's env; the client must allow the redirect URI
// `<Studio origin>/api/admin/admob/callback` (http://localhost:3200/api/admin/admob/callback on a dev machine).
// "Connect AdMob" (app/api/admin/admob/connect) sends a staff member to Google with offline access and
// prompt=consent, so Google always hands back a refresh token; the callback exchanges the code here and keeps only
// the refresh token (./connection.ts). Each read trades it for an access token, kept in memory until a minute
// before it expires.
//
// The secret is read in exactly one function (`clientSecret`, not exported) and the tokens never leave this module
// and ./connection.ts: nothing here logs them, and errors carry Google's message only.

export const ADMOB_SCOPE = "https://www.googleapis.com/auth/admob.readonly";
export const ADMOB_ENV_VARS = ["ADMOB_OAUTH_CLIENT_ID", "ADMOB_OAUTH_CLIENT_SECRET"] as const;
/** Holds the CSRF `state` between Connect and the callback. httpOnly, ten minutes. */
export const ADMOB_STATE_COOKIE = "studio_admob_oauth_state";
export const ADMOB_CALLBACK_PATH = "/api/admin/admob/callback";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

function clientId(): string | null {
  return process.env.ADMOB_OAUTH_CLIENT_ID?.trim() || null;
}

/** The one read of the client secret. */
function clientSecret(): string | null {
  return process.env.ADMOB_OAUTH_CLIENT_SECRET?.trim() || null;
}

/** The env variables still to set, by NAME (never a value); empty when the OAuth client is configured. */
export function admobMissingEnv(): string[] {
  const out: string[] = [];
  if (!clientId()) out.push("ADMOB_OAUTH_CLIENT_ID");
  if (!clientSecret()) out.push("ADMOB_OAUTH_CLIENT_SECRET");
  return out;
}

/** Google's consent page: read-only AdMob, offline access, always asking (so a refresh token always comes back). */
export function admobAuthUrl(redirectUri: string, state: string): string {
  const id = clientId();
  if (!id) throw new Error("ADMOB_OAUTH_CLIENT_ID is not set.");
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ADMOB_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

function underTest(): boolean {
  return !!process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test";
}

/** The real fetch, refused under node:test (a test passes its own). */
export function googleFetch(): FetchLike {
  if (typeof window !== "undefined") throw new Error("Google OAuth is server-only.");
  if (underTest()) throw new Error("Live Google calls are refused in tests; pass a fetch.");
  return (url, init) => fetch(url, { ...init, cache: "no-store", redirect: "error" });
}

async function postForm(f: FetchLike, url: string, form: Record<string, string>): Promise<{ status: number; body: unknown }> {
  let res: { status: number; text(): Promise<string> };
  try {
    res = await f(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new AdmobAuthError("Google did not answer (timeout, DNS or a refused connection).", "unreachable");
  }
  let body: unknown = null;
  try {
    const text = await res.text();
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** `code`: unreachable (no answer), revoked (the refresh token no longer works: connect again), google (any other refusal). */
export class AdmobAuthError extends Error {
  constructor(message: string, readonly code: "unreachable" | "revoked" | "google" | "not_configured") {
    super(message);
    this.name = "AdmobAuthError";
  }
}

const describe = (body: unknown, status: number): string => {
  const b = (body ?? {}) as { error?: unknown; error_description?: unknown };
  const parts = [typeof b.error === "string" ? b.error : null, typeof b.error_description === "string" ? b.error_description : null].filter(Boolean);
  return parts.length ? parts.join(": ").slice(0, 300) : `Google answered HTTP ${status}.`;
};

/** The callback's exchange: the code for tokens. Only the refresh token is returned; the access token is cached. */
export async function exchangeAdmobCode(code: string, redirectUri: string, f: FetchLike = googleFetch()): Promise<{ refresh_token: string }> {
  const id = clientId(), secret = clientSecret();
  if (!id || !secret) throw new AdmobAuthError(`Set ${admobMissingEnv().join(" and ")} first.`, "not_configured");
  const { status, body } = await postForm(f, TOKEN_URL, { code, client_id: id, client_secret: secret, redirect_uri: redirectUri, grant_type: "authorization_code" });
  const b = (body ?? {}) as { refresh_token?: unknown; access_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (status !== 200 || typeof b.access_token !== "string") throw new AdmobAuthError(describe(body, status), "google");
  if (typeof b.refresh_token !== "string") throw new AdmobAuthError("Google sent no refresh token. Remove Pulsar Studio's access in your Google account and connect again.", "google");
  if (typeof b.scope === "string" && !b.scope.split(" ").includes(ADMOB_SCOPE)) throw new AdmobAuthError("The AdMob permission was not granted. Connect again and allow it.", "google");
  remember(b.refresh_token, b.access_token, b.expires_in);
  return { refresh_token: b.refresh_token };
}

// ---- access tokens, in memory ------------------------------------------------------------------------------

type Kept = { refresh: string; access: string; until: number };
const holder = globalThis as typeof globalThis & { __studioAdmobAccess?: Kept | null };

function remember(refresh: string, access: string, expiresIn: unknown, now = Date.now()): void {
  const secs = typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : 3600;
  holder.__studioAdmobAccess = { refresh, access, until: now + Math.max(0, secs - 60) * 1000 };
}

/** Forget the kept access token (Disconnect, tests). */
export function clearAdmobAccessToken(): void {
  holder.__studioAdmobAccess = null;
}

/** An access token for the stored refresh token: the kept one until a minute before it expires, else a fresh one. */
export async function admobAccessToken(refreshToken: string, opts: { fetch?: FetchLike; now?: () => number } = {}): Promise<string> {
  const now = opts.now ?? Date.now;
  const kept = holder.__studioAdmobAccess;
  if (kept && kept.refresh === refreshToken && now() < kept.until) return kept.access;
  const id = clientId(), secret = clientSecret();
  if (!id || !secret) throw new AdmobAuthError(`Set ${admobMissingEnv().join(" and ")} first.`, "not_configured");
  const { status, body } = await postForm(opts.fetch ?? googleFetch(), TOKEN_URL, { refresh_token: refreshToken, client_id: id, client_secret: secret, grant_type: "refresh_token" });
  const b = (body ?? {}) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
  if (status !== 200 || typeof b.access_token !== "string") {
    clearAdmobAccessToken();
    throw new AdmobAuthError(describe(body, status), b.error === "invalid_grant" ? "revoked" : "google");
  }
  remember(refreshToken, b.access_token, b.expires_in, now());
  return b.access_token;
}

/** Disconnect's courtesy: ask Google to revoke the token too. Best effort; a failure is ignored. */
export async function revokeAdmobToken(refreshToken: string, f?: FetchLike): Promise<void> {
  try {
    await postForm(f ?? googleFetch(), REVOKE_URL, { token: refreshToken });
  } catch {
    // The stored token is gone either way.
  }
}
