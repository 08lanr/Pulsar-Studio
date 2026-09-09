// TikTok Business API transport — ported from Pulsar Grow (lib/tiktok.ts),
// which ported it from overlord, where it has run real money. Pacing, a
// timeout, the big-integer quoting and the sandbox/production switch live
// here and nowhere else: no other file in Studio may fetch against TikTok.
//
// The launch engine, the review poll and the metrics sync talk to a
// `TikTokTransport` interface so fixture mode can substitute lib/tiktok/fake.ts
// (lib/tiktok/index.ts chooses). Callers never import this file directly for
// a transport; they call tiktokTransport().

import { loadConnections } from "./tokens";

const SANDBOX_BASE = "https://sandbox-ads.tiktok.com/open_api/v1.3";
const PRODUCTION_BASE = "https://business-api.tiktok.com/open_api/v1.3";

export type TikTokMode = "sandbox" | "production";

/** TIKTOK_MODE in .env.local; sandbox unless production is spelled out (safety default, CLAUDE.md). */
export function tiktokMode(): TikTokMode {
  return (process.env.TIKTOK_MODE || "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
}

export function tiktokBase(): string {
  return tiktokMode() === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
}

// Give up rather than hanging a request forever if TikTok stops responding.
const TIMEOUT_MS = 20_000;
// Uploads carry whole video files; give them room.
const UPLOAD_TIMEOUT_MS = 180_000;

/** TikTok's envelope: code 0 means success. Transport failures reuse the shape with a negative code. */
export type TikTokResponse = {
  code: number;
  message: string;
  data?: Record<string, unknown> & { list?: unknown[] };
};

export type UploadField = string | { data: Buffer; filename: string };

export interface TikTokTransport {
  /** Which environment the objects land in; "fake" never leaves the process. */
  readonly mode: TikTokMode | "fake";
  get(pathname: string, accessToken: string, params?: Record<string, string | number>): Promise<TikTokResponse>;
  post(pathname: string, accessToken: string, body: Record<string, unknown>): Promise<TikTokResponse>;
  upload(pathname: string, accessToken: string, fields: Record<string, UploadField>): Promise<TikTokResponse>;
}

// ---------------------------------------------------------------------------
// Pacing — the single rate limiter for every public-API call in the app.
// Two margins (per-endpoint, global), reserved-slot design rather than a
// lock: reading and advancing the map has no await between them, so
// concurrent callers on Node's single thread cannot double-book a slot.
// Kept on globalThis because Next bundles this module separately into each
// route — module-level state would give every route its own pacer.
//
// Sandbox allows about one request a second (Pulsar's briefing tripped it at
// 50 ms gaps); production tolerates far more. The gaps follow the mode.
// ---------------------------------------------------------------------------
const GLOBAL_KEY = "__global__";

const paceStore = globalThis as unknown as { __studioTtNextFreeSlot?: Map<string, number> };
const nextFreeSlot: Map<string, number> = paceStore.__studioTtNextFreeSlot ?? new Map();
paceStore.__studioTtNextFreeSlot = nextFreeSlot;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gaps(): { endpoint: number; global: number } {
  return tiktokMode() === "sandbox" ? { endpoint: 1100, global: 1100 } : { endpoint: 50, global: 25 };
}

async function paceEndpoint(pathname: string) {
  const now = Date.now();
  const g = gaps();
  const at = Math.max(now, nextFreeSlot.get(pathname) ?? 0, nextFreeSlot.get(GLOBAL_KEY) ?? 0);
  nextFreeSlot.set(pathname, at + g.endpoint);
  nextFreeSlot.set(GLOBAL_KEY, at + g.global);
  if (at > now) await sleep(at - now);
}

// 40100 is TikTok's throttle code; the "QPS limit" text is how the same
// condition shows up on some endpoints. One retry absorbs boundary jitter —
// anything past that is a real suspension and should surface, not spin.
function isThrottled(r: TikTokResponse): boolean {
  return r.code === 40100 || /QPS limit|too many request/i.test(r.message || "");
}

async function paced(pathname: string, doCall: () => Promise<TikTokResponse>): Promise<TikTokResponse> {
  await paceEndpoint(pathname);
  let res = await doCall();
  if (isThrottled(res)) {
    await sleep(2500);
    await paceEndpoint(pathname);
    res = await doCall();
  }
  return res;
}

// ---------------------------------------------------------------------------
// The one fetch. A timeout, a dropped connection or an HTML error page
// becomes a normal error response instead of an unhandled exception.
// ---------------------------------------------------------------------------
async function callTikTok(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<TikTokResponse> {
  let res: Response;
  let body: string;
  try {
    // no-store: live, paced API calls; Next must not try to persist them.
    res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    body = await res.text();
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      code: -1,
      message: timedOut ? "TikTok did not respond in time. Please try again." : "Could not reach TikTok. Check the connection and try again.",
    };
  }
  try {
    // TikTok serialises SOME ids as bare JSON numbers beyond
    // Number.MAX_SAFE_INTEGER — JSON.parse silently mangles the tail digits
    // (verified live in overlord). Quote every 15+ digit integer before
    // parsing; real metrics never reach 15 integer digits.
    const safe = body.replace(/([:[,]\s*)(\d{15,})(?=\s*[,}\]])/g, '$1"$2"');
    return JSON.parse(safe) as TikTokResponse;
  } catch {
    return { code: -1, message: `TikTok returned an unreadable response (HTTP ${res.status}). This is usually a temporary outage on their side.` };
  }
}

/**
 * Swap in the token that OWNS this advertiser when the caller's does not.
 * TikTok scopes a token to the assets its consent screen granted; resolving
 * the mismatch here fixes every call site at once.
 */
function tokenFor(accessToken: string, params: Record<string, unknown>): string {
  const raw = params.advertiser_id ?? params.adv_id;
  if (raw === undefined || raw === null) return accessToken;
  const id = String(raw);
  if (!id) return accessToken;
  const connections = loadConnections();
  if (connections.length < 2) return accessToken;
  const current = connections.find((c) => c.access_token === accessToken);
  if (current && (current.advertiser_ids ?? []).includes(id)) return accessToken;
  const owner = connections.find((c) => (c.advertiser_ids ?? []).includes(id));
  return owner ? owner.access_token : accessToken;
}

/** The live transport: real HTTP against the mode's host. */
export const liveTransport: TikTokTransport = {
  get mode() {
    return tiktokMode();
  },
  async get(pathname, accessToken, params = {}) {
    const url = new URL(tiktokBase() + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const token = tokenFor(accessToken, params);
    return paced(pathname, () => callTikTok(url.toString(), { headers: { "Access-Token": token } }));
  },
  async post(pathname, accessToken, body) {
    const token = tokenFor(accessToken, body);
    return paced(pathname, () =>
      callTikTok(tiktokBase() + pathname, {
        method: "POST",
        headers: { "Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  },
  async upload(pathname, accessToken, fields) {
    // fetch sets the multipart boundary header itself — never set Content-Type here.
    const form = new FormData();
    const plain: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "string") {
        form.append(k, v);
        plain[k] = v;
      } else {
        form.append(k, new Blob([v.data as unknown as BlobPart]), v.filename);
      }
    }
    const token = tokenFor(accessToken, plain);
    return paced(pathname, () => callTikTok(tiktokBase() + pathname, { method: "POST", headers: { "Access-Token": token }, body: form }, UPLOAD_TIMEOUT_MS));
  },
};
