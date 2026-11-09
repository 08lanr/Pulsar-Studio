// Reading AdMob's network report (decision 2026-11-09, "Ad unlocks in Studio"): one POST networkReport:generate
// for the days asked (Pacific), by day, app and platform, through the stored connection (./connection.ts) and an
// access token (./oauth.ts), parsed by ./report.ts and kept fifteen minutes, so the Ad unlocks tab reloaded or
// opened twice asks Google once. Server-only.
//
// Mode: fixture mode answers invented rows (lib/crazydramas/fake-ad-unlocks.ts) unless the engineer sets
// ADMOB_LIVE_READ=1; DATA_SOURCE=supabase reads Google. A failure is a value with a plain message (Google's own
// where it sent one), never a throw, and never carries a token.

import { dataSource } from "@/lib/data-source";
import { fakeAdmobRows } from "@/lib/crazydramas/fake-ad-unlocks";
import { readAdmobConnection, readAdmobRefreshToken, type AdmobConnection } from "./connection";
import { AdmobAuthError, admobAccessToken, admobMissingEnv, googleFetch, type FetchLike } from "./oauth";
import { admobPublisherId, admobReportSpec, admobReportUrl, googleErrorMessage, parseAdmobReport, type AdmobRow } from "./report";

export const ADMOB_CACHE_MS = 15 * 60_000;

export type AdmobMode = "fake" | "live";

export type AdmobRead =
  | { ok: true; rows: AdmobRow[]; from: string; to: string; read_at: string; mode: AdmobMode; warnings: string[]; connection: AdmobConnection | null }
  /** The OAuth client is not set up: `missing` names the env variables. */
  | { ok: false; code: "not_configured"; missing: string[]; error: string; mode: AdmobMode }
  /** No refresh token stored, or Google no longer accepts it (`revoked`): the tab offers Connect. */
  | { ok: false; code: "not_connected" | "revoked"; error: string; mode: AdmobMode }
  /** Connected, but the read failed: Google's message, or no answer. */
  | { ok: false; code: "google_error" | "unreachable" | "bad_response"; error: string; mode: AdmobMode; connection: AdmobConnection };

export function admobMode(): AdmobMode {
  return dataSource() === "fixture" && process.env.ADMOB_LIVE_READ !== "1" ? "fake" : "live";
}

type Cached = { at: number; read: Extract<AdmobRead, { ok: true }> };
const holder = globalThis as typeof globalThis & { __studioAdmobCache?: Map<string, Cached> };
const cache = (holder.__studioAdmobCache ??= new Map<string, Cached>());

/** Forget the kept reads (Connect, Disconnect, tests; the page's Refresh passes `fresh`). */
export function clearAdmobCache(): void {
  cache.clear();
}

export async function readAdmobReport(span: { from: string; to: string }, opts: { fresh?: boolean; mode?: AdmobMode; fetch?: FetchLike; now?: () => number } = {}): Promise<AdmobRead> {
  const now = opts.now ?? Date.now;
  const mode = opts.mode ?? admobMode();
  const key = `${mode}|${span.from}|${span.to}`;
  const kept = cache.get(key);
  if (!opts.fresh && kept && now() - kept.at < ADMOB_CACHE_MS) return kept.read;

  if (mode === "fake") {
    const read = { ok: true as const, rows: fakeAdmobRows(span.from, span.to), from: span.from, to: span.to, read_at: new Date(now()).toISOString(), mode, warnings: [], connection: null };
    cache.set(key, { at: now(), read });
    return read;
  }

  const missing = admobMissingEnv();
  if (missing.length) return { ok: false, code: "not_configured", missing, error: `Set ${missing.join(" and ")} in Studio's env.`, mode };
  const refresh = await readAdmobRefreshToken();
  if (!refresh) return { ok: false, code: "not_connected", error: "AdMob is not connected.", mode };
  const connection = await readAdmobConnection();

  let access: string;
  try {
    access = await admobAccessToken(refresh, { fetch: opts.fetch, now });
  } catch (e) {
    if (e instanceof AdmobAuthError && e.code === "revoked") return { ok: false, code: "revoked", error: `Google no longer accepts the AdMob connection (${e.message}). Connect again.`, mode };
    if (e instanceof AdmobAuthError && e.code === "not_configured") return { ok: false, code: "not_configured", missing: admobMissingEnv(), error: e.message, mode };
    return { ok: false, code: e instanceof AdmobAuthError && e.code === "unreachable" ? "unreachable" : "google_error", error: e instanceof Error ? e.message : "Google refused the sign-in.", mode, connection };
  }

  const f = opts.fetch ?? googleFetch();
  let status: number;
  let body: unknown = null;
  try {
    const res = await f(admobReportUrl(admobPublisherId()), {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(admobReportSpec(span.from, span.to)),
      signal: AbortSignal.timeout(30_000),
    });
    status = res.status;
    try {
      const text = await res.text();
      body = text.trim() ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
  } catch {
    return { ok: false, code: "unreachable", error: "AdMob did not answer (timeout, DNS or a refused connection).", mode, connection };
  }
  if (status !== 200) return { ok: false, code: "google_error", error: googleErrorMessage(body) ?? `AdMob answered HTTP ${status}.`, mode, connection };
  const parsed = parseAdmobReport(body);
  if (!parsed.ok) return { ok: false, code: "bad_response", error: parsed.error, mode, connection };
  if (parsed.currency && parsed.currency !== "USD") return { ok: false, code: "bad_response", error: `AdMob answered in ${parsed.currency}, not US dollars.`, mode, connection };
  const read = { ok: true as const, rows: parsed.rows, from: span.from, to: span.to, read_at: new Date(now()).toISOString(), mode, warnings: parsed.warnings, connection };
  cache.set(key, { at: now(), read });
  return read;
}
