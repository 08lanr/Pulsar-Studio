// The only module allowed to fetch crazydramas.com (decision 2026-09-23,
// "the crazydramas connection"; plan A1–A2), and — since phase 5, "Upload to
// crazydramas" — the only one that reads CRAZYDRAMAS_STUDIO_TOKEN and the
// only one that sends bytes to a Mux upload URL. Modelled on
// lib/meta/transport.ts: server-only, one base URL, sanitised errors that
// carry no URL, no body and no header, a timeout on every request.
//
// Public reads (phase 3a), no credential:
//   GET /api/dramas            Cookie: pulsar_mock=0 (the edge cache ignores
//                              it, so `mock-*` slugs are dropped after the
//                              parse as well); cache: 'no-store' (Next 14
//                              caches server fetches otherwise); up to 60 s of
//                              lag after a publish (public max-age)
//   GET /api/dramas/<slug>     404 = "not live" (not uploaded, or a draft)
//
// The Studio API (crazydramas docs/STUDIO_API.md), `Authorization: Bearer
// <CRAZYDRAMAS_STUDIO_TOKEN>`:
//   reads   GET /api/studio/series/:series, GET /api/studio/uploads/:id —
//           Supabase mode, or fixture mode with the engineer's
//           CRAZYDRAMAS_LIVE_READ=1; the phase 3a series read upgrades to the
//           authenticated one when the token is set (spec §7), and falls back
//           to the public read when the token is refused (401/403/503)
//   writes  PUT / POST — only with DATA_SOURCE=supabase AND
//           CRAZYDRAMAS_LIVE_WRITES=enabled (spec §6, the META_LIVE_WRITES
//           pattern); the Mux chunk PUT is a write too
//   tests   refused before any request, whatever the environment says
//
// The token is read in exactly one function (`studioToken`, not exported),
// put in one header, and never logged, returned, stored or put in an error:
// callers learn only whether it is configured (the lib/tiktok/tokens.ts
// rule). An upload URL is a capability (anyone holding it can send bytes):
// it is used here and never logged or put in an error either.
//
// Nothing outside lib/crazydramas imports this file for a transport:
// pick.ts chooses the reads, studio-client.ts the Studio API.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dataSource } from "@/lib/data-source";
import { type CatalogEntry, parseCatalog, parseSeries, parseStudioSeries, type SeriesRead, CRAZYDRAMAS_SLUG } from "./types";

export interface CrazydramasTransport {
  readonly mode: "fake" | "live";
  /** `GET /api/dramas`: the published catalog, whitelisted, the mock series dropped. */
  catalog(): Promise<CatalogEntry[]>;
  /**
   * One series, or a 404 as a value. With the Studio token the authenticated
   * read (`read_via: "studio"`: drafts, archived series and unpublished
   * episodes seen, a 404 is "not uploaded"); without it the public read
   * (`read_via: "public"`: published episodes only). Anything else throws.
   */
  series(slug: string): Promise<SeriesRead>;
  /**
   * The PUBLIC read of one series, always (`GET /api/dramas/<slug>`, what a
   * viewer's browser gets, up to 60 s behind a publish): published series
   * and episodes only, a 404 for anything else. The publish progress polls it
   * to say when the public page shows the series (2026-09-24). Optional so a
   * test's stand-in need not have it; callers fall back to `series`.
   */
  publicSeries?(slug: string): Promise<SeriesRead>;
}

/** One answer of the Studio API: its status and JSON body, whatever the status (crazydramas' error codes pass through verbatim). */
export type StudioHttpAnswer = { status: number; body: unknown };

/** One chunk of a resumable upload: bytes first..last of total (inclusive, as Content-Range says). */
export type ChunkRange = { first: number; last: number; total: number };

/**
 * A resumable PUT's answer: `status` (308 = send the next chunk, 200/201 =
 * complete) and `acked`, the bytes the storage has persisted so far (the
 * 308's `Range: bytes=0-N` is N+1; null when the 308 carried no Range —
 * nothing persisted yet — or on any other status).
 */
export type ChunkAnswer = { status: number; acked: number | null };

/** Does an address answer 200 with an image (spec §4, the poster)? */
export type ImageCheck = { ok: boolean; status: number | null; content_type: string | null; reason: string | null };

/**
 * The Studio API and the Mux upload, as Studio's uploader sees them
 * (lib/crazydramas/studio-client.ts wraps it with the contract's zod shapes;
 * lib/crazydramas/fake.ts implements it in memory for fixture mode and tests).
 */
export interface CrazydramasStudioTransport {
  readonly mode: "fake" | "live";
  /** An authenticated call to `/api/studio/*`. Every HTTP answer is a value; only "no answer" throws (CrazydramasApiError). */
  request(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<StudioHttpAnswer>;
  /**
   * One PUT to a Mux direct-upload URL: a chunk with its Content-Range, or —
   * with `chunk` null — the empty status query `Content-Range: bytes * /total`
   * that asks how much has been persisted. Throws only for "no answer".
   */
  putUploadChunk(uploadUrl: string, chunk: Uint8Array | null, range: ChunkRange | { total: number }): Promise<ChunkAnswer>;
  /** HEAD (then a ranged GET) on an https address; never throws. */
  checkImage(url: string): Promise<ImageCheck>;
}

/** Sanitised diagnostics: a sentence and, when there was one, the HTTP status. Never a URL, a body, a header or a credential. */
export class CrazydramasApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CrazydramasApiError";
  }
}

export const DEFAULT_BASE_URL = "https://crazydramas.com";
const TIMEOUT_MS = 20_000;
/** A chunk of up to 16 MiB on a slow line: generous, still bounded. */
const CHUNK_TIMEOUT_MS = 5 * 60_000;
/** crazydramas answers 503 not_configured for a token shorter than this (STUDIO_API.md "Auth"); Studio treats it as not set. */
export const STUDIO_TOKEN_MIN_LENGTH = 32;

function serverOnly(): void {
  if (typeof window !== "undefined") throw new Error("crazydramas reads are server-only.");
}

/** `CRAZYDRAMAS_BASE_URL` (not a secret), default https://crazydramas.com; an http(s) origin, no path. */
export function crazydramasBaseUrl(): string {
  const raw = process.env.CRAZYDRAMAS_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CrazydramasApiError("CRAZYDRAMAS_BASE_URL is not a URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CrazydramasApiError("CRAZYDRAMAS_BASE_URL must be http(s).");
  return url.origin;
}

/** The public page of a series, for the screens' link. */
export function crazydramasPublicUrl(slug: string): string {
  return `${crazydramasBaseUrl()}/drama/${encodeURIComponent(slug)}`;
}

/** True under node:test: the live transport refuses before any request, so a test that forgot the fake fails loudly instead of reaching the site. */
function underTest(): boolean {
  return !!process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test";
}

// ---- the token (read here, and only here) --------------------------------------------------------------

/** The one read of the secret. Not exported: callers ask `studioTokenConfigured()`. */
function studioToken(): string | null {
  const raw = process.env.CRAZYDRAMAS_STUDIO_TOKEN?.trim();
  return raw && raw.length >= STUDIO_TOKEN_MIN_LENGTH ? raw : null;
}

/** Whether a usable CRAZYDRAMAS_STUDIO_TOKEN is set ("configured: yes/no" is all a screen may say). */
export function studioTokenConfigured(): boolean {
  return studioToken() !== null;
}

/**
 * Why the authenticated READS may not run live, by setting NAME, or null.
 * Supabase mode reads live; fixture mode only with the engineer's
 * CRAZYDRAMAS_LIVE_READ=1. (Tests are refused separately, in the request.)
 */
export function studioReadRefusal(): string | null {
  if (dataSource() !== "supabase" && process.env.CRAZYDRAMAS_LIVE_READ !== "1") return "Fixture mode does not read the live Studio API (CRAZYDRAMAS_LIVE_READ=1 is the engineer's override).";
  if (!studioTokenConfigured()) return "CRAZYDRAMAS_STUDIO_TOKEN is not set.";
  return null;
}

/**
 * Why a live WRITE may not be sent (spec §6), by setting NAME, or null:
 * DATA_SOURCE=supabase AND CRAZYDRAMAS_LIVE_WRITES=enabled AND the token.
 * Fixture mode never writes to crazydramas.com, CRAZYDRAMAS_LIVE_READ=1
 * included. (Tests are refused separately, in the request.)
 */
export function studioWriteRefusal(): string | null {
  if (dataSource() !== "supabase") return "Fixture mode never writes to crazydramas.com: real uploads need DATA_SOURCE=supabase and CRAZYDRAMAS_LIVE_WRITES=enabled.";
  if (!studioTokenConfigured()) return "CRAZYDRAMAS_STUDIO_TOKEN is not set.";
  if (process.env.CRAZYDRAMAS_LIVE_WRITES !== "enabled") return "CRAZYDRAMAS_LIVE_WRITES is not set to enabled.";
  return null;
}

// ---- public reads -------------------------------------------------------------------------------------

/** Only this function sends public reads to crazydramas. */
async function get(path: string): Promise<{ status: number; body: unknown }> {
  serverOnly();
  if (underTest()) throw new CrazydramasApiError("Live crazydramas reads are refused in tests; use the fake transport.");
  if (dataSource() !== "supabase" && process.env.CRAZYDRAMAS_LIVE_READ !== "1") {
    throw new CrazydramasApiError("Live crazydramas reads are disabled in fixture mode (CRAZYDRAMAS_LIVE_READ=1 is the engineer's override).");
  }
  const url = new URL(path, crazydramasBaseUrl());
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", cookie: "pulsar_mock=0" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new CrazydramasApiError("crazydramas did not answer (timeout, DNS or a refused connection).");
  }
  if (response.status === 404) return { status: 404, body: null };
  if (!response.ok) throw new CrazydramasApiError(`crazydramas answered HTTP ${response.status}.`, response.status);
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    throw new CrazydramasApiError("crazydramas answered something that is not JSON.", response.status);
  }
}

// ---- the Studio API -----------------------------------------------------------------------------------

/** `/api/studio/...` paths only; each segment already encoded by the caller (studio-client.ts). */
const STUDIO_PATH = /^\/api\/studio\/[A-Za-z0-9/_.%-]+$/;

/** Only this function sends the token. Every HTTP answer comes back as a value; no answer throws. */
async function studioCall(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<StudioHttpAnswer> {
  serverOnly();
  if (underTest()) throw new CrazydramasApiError("Live Studio API calls are refused in tests; use the fake transport.");
  if (!STUDIO_PATH.test(path) || path.includes("..")) throw new CrazydramasApiError("Not a Studio API path.");
  const refusal = method === "GET" ? studioReadRefusal() : studioWriteRefusal();
  if (refusal) throw new CrazydramasApiError(refusal);
  const token = studioToken();
  if (!token) throw new CrazydramasApiError("CRAZYDRAMAS_STUDIO_TOKEN is not set.");
  const url = new URL(path, crazydramasBaseUrl());
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new CrazydramasApiError("crazydramas did not answer (timeout, DNS or a refused connection).");
  }
  let parsed: unknown = null;
  try {
    const text = await response.text();
    parsed = text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = { error: `crazydramas answered HTTP ${response.status} with a body that is not JSON`, code: "bad_response" };
  }
  return { status: response.status, body: parsed };
}

// ---- the Mux direct upload ------------------------------------------------------------------------------
//
// Resumable upload semantics, verified 2026-09-23 against the official docs:
//   Mux, "Upload files directly" (https://www.mux.com/docs/guides/upload-files-directly):
//     a PUT per chunk; chunks "a multiple of 256KB (256 * 1024 bytes)"; the
//     header `Content-Range: bytes 0-1048575/10000000`; "If the server
//     responds with a 308, you're good to continue uploading"; 200 OK or
//     201 Created when the upload is complete.
//   The upload URL is a Google Cloud Storage resumable session, whose docs
//   (https://docs.cloud.google.com/storage/docs/performing-resumable-uploads)
//   add the resume rules: the 308's `Range` header "specifies which bytes
//   Cloud Storage has persisted so far" (`bytes=0-N`); with no Range header
//   nothing is persisted yet; the status of an interrupted upload is asked
//   with an empty PUT, `Content-Length: 0`, `Content-Range: bytes */SIZE`;
//   a 5xx means resume; and the server may persist fewer bytes than a chunk
//   sent ("ignores any bytes you send at an offset … already persisted"), so
//   the next chunk always starts at the acknowledged offset, never at the
//   offset the last chunk ended.
// A 308 here is "Resume Incomplete", not a redirect: fetch is called with
// redirect "manual" so Node hands the 308 back as-is (with "error" any 308
// is a network error; with "follow" a 3xx that does carry a Location would
// be followed), and a 3xx with a Location is refused, never followed.

function contentRange(range: ChunkRange | { total: number }): string {
  return "first" in range ? `bytes ${range.first}-${range.last}/${range.total}` : `bytes */${range.total}`;
}

/** `bytes=0-N` → N+1; anything else → null. */
export function ackedFromRange(header: string | null): number | null {
  const m = header?.match(/^bytes=0-(\d+)$/);
  return m ? Number(m[1]) + 1 : null;
}

async function muxPut(uploadUrl: string, chunk: Uint8Array | null, range: ChunkRange | { total: number }): Promise<ChunkAnswer> {
  serverOnly();
  if (underTest()) throw new CrazydramasApiError("Live Mux uploads are refused in tests; use the fake transport.");
  const refusal = studioWriteRefusal();
  if (refusal) throw new CrazydramasApiError(refusal);
  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new CrazydramasApiError("The upload URL crazydramas answered is not a URL.");
  }
  if (url.protocol !== "https:") throw new CrazydramasApiError("The upload URL crazydramas answered is not https.");
  if (chunk && "first" in range && chunk.byteLength !== range.last - range.first + 1) throw new CrazydramasApiError("A chunk's length does not match its Content-Range.");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { "content-range": contentRange(range) },
      // Undici sends a Uint8Array as it is and sets Content-Length from it (0 for the status query).
      body: (chunk ?? new Uint8Array(0)) as unknown as BodyInit,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(chunk ? CHUNK_TIMEOUT_MS : TIMEOUT_MS),
    });
  } catch {
    throw new CrazydramasApiError("The Mux upload did not answer (timeout, DNS or a refused connection).");
  }
  void response.body?.cancel().catch(() => undefined);
  if (response.status >= 300 && response.status < 400 && response.status !== 308) throw new CrazydramasApiError(`The Mux upload answered a redirect (HTTP ${response.status}); not followed.`, response.status);
  if (response.status === 308 && response.headers.get("location")) throw new CrazydramasApiError("The Mux upload answered a redirect; not followed.", 308);
  return { status: response.status, acked: response.status === 308 ? ackedFromRange(response.headers.get("range")) : null };
}

const IMAGE_TYPE = /^image\//i;

/**
 * Is an IP address on the public internet? Refused: unspecified, loopback,
 * RFC 1918 private, CGNAT (100.64/10), link-local (169.254/16, fe80::/10,
 * and the old site-local fec0::/10), unique-local (fc00::/7), multicast and
 * reserved ranges, the documentation and benchmarking nets, and IPv6 forms
 * that carry an IPv4 address (::ffff:, ::/96, 64:ff9b::/96 NAT64, 2002::/16
 * 6to4) — a poster address must never make Studio's server ask something on
 * its own network.
 */
export function isPublicAddress(address: string): boolean {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(a) === 4) {
    const [p, q, r] = a.split(".").map(Number);
    if (p === 0 || p === 10 || p === 127 || p >= 224) return false;
    if (p === 100 && q >= 64 && q <= 127) return false;
    if (p === 169 && q === 254) return false;
    if (p === 172 && q >= 16 && q <= 31) return false;
    if (p === 192 && q === 168) return false;
    if (p === 192 && q === 0 && (r === 0 || r === 2)) return false;
    if (p === 198 && (q === 18 || q === 19)) return false;
    if (p === 198 && q === 51 && r === 100) return false;
    if (p === 203 && q === 0 && r === 113) return false;
    return true;
  }
  if (isIP(a) === 6) {
    if (a.startsWith("::")) return false; // ::, ::1, ::ffff:a.b.c.d and the other IPv4-carrying forms
    if (/^f[c-d]/.test(a) || /^fe[89a-f]/.test(a) || a.startsWith("ff")) return false;
    if (a.startsWith("64:ff9b:") || a.startsWith("2002:") || a.startsWith("2001:db8:")) return false;
    if (/^0{0,4}:/.test(a)) return false;
    return true;
  }
  return false;
}

/** The host's addresses, every one of them public; a reason in words otherwise. */
async function publicHost(host: string): Promise<string | null> {
  let found: { address: string }[];
  try {
    found = await lookup(host, { all: true });
  } catch {
    return "The address did not answer (DNS).";
  }
  if (!found.length || found.some((f) => !isPublicAddress(f.address))) return "The poster must be on a public web address.";
  return null;
}

/** HEAD, then a one-byte GET when HEAD is refused; no cookie, no credential, no redirect followed; only to a host whose every address is public. */
async function imageCheck(address: string): Promise<ImageCheck> {
  serverOnly();
  if (underTest()) return { ok: false, status: null, content_type: null, reason: "Live checks are refused in tests." };
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, status: null, content_type: null, reason: "That is not a web address." };
  }
  if (url.protocol !== "https:") return { ok: false, status: null, content_type: null, reason: "The poster must be an https:// address." };
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, status: null, content_type: null, reason: "The poster must be on a named public web address." };
  }
  // A name alone can point anywhere (x.lan, 127.0.0.1.nip.io): what it resolves to decides.
  const refused = await publicHost(host);
  if (refused) return { ok: false, status: null, content_type: null, reason: refused };
  const once = (method: "HEAD" | "GET") =>
    fetch(url, { method, headers: method === "GET" ? { accept: "image/*", range: "bytes=0-0" } : { accept: "image/*" }, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10_000) });
  let res: Response;
  try {
    res = await once("HEAD");
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await once("GET");
      void res.body?.cancel().catch(() => undefined);
    }
  } catch {
    return { ok: false, status: null, content_type: null, reason: "The address did not answer (timeout, DNS or a refused connection)." };
  }
  const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || null;
  if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, content_type: type, reason: `It answers a redirect (HTTP ${res.status}); give the final address of the image.` };
  if (res.status !== 200 && res.status !== 206) return { ok: false, status: res.status, content_type: type, reason: `It answers HTTP ${res.status}, not 200.` };
  if (!type || !IMAGE_TYPE.test(type)) return { ok: false, status: 200, content_type: type, reason: `It answers ${type ?? "no content type"}, not an image.` };
  return { ok: true, status: 200, content_type: type, reason: null };
}

export const liveCrazydramasStudioTransport: CrazydramasStudioTransport = {
  mode: "live",
  request: studioCall,
  putUploadChunk: muxPut,
  checkImage: imageCheck,
};

// ---- the read transport -----------------------------------------------------------------------------------

/** The public series read. */
async function readPublicSeries(slug: string): Promise<SeriesRead> {
  const { status, body } = await get(`/api/dramas/${encodeURIComponent(slug)}`);
  if (status === 404) return { http_status: 404, drama: null, episodes: null, read_via: "public" };
  try {
    return parseSeries(body);
  } catch {
    throw new CrazydramasApiError("crazydramas answered a series Studio cannot read (the shape changed).", status);
  }
}

/** The token refused by crazydramas (unset there, rotated, too short): the public read stands in, said once per process. */
let fallbackWarned = false;

export const liveCrazydramasTransport: CrazydramasTransport = {
  mode: "live",
  async catalog() {
    const { status, body } = await get("/api/dramas");
    if (status === 404) throw new CrazydramasApiError("crazydramas has no catalog endpoint at this base URL.", 404);
    try {
      return parseCatalog(body);
    } catch {
      throw new CrazydramasApiError("crazydramas answered a catalog Studio cannot read (the shape changed).", status);
    }
  },
  async series(slug: string) {
    if (!CRAZYDRAMAS_SLUG.test(slug)) throw new CrazydramasApiError("Invalid crazydramas slug.");
    // Spec §7: with the token, the authenticated read (drafts visible); without it, the public one.
    if (!underTest() && studioReadRefusal() === null) {
      const { status, body } = await studioCall("GET", `/api/studio/series/${encodeURIComponent(slug)}`);
      if (status === 404) return { http_status: 404, drama: null, episodes: null, read_via: "studio" };
      if (status === 200) {
        try {
          return parseStudioSeries(body);
        } catch {
          throw new CrazydramasApiError("crazydramas answered a Studio series Studio cannot read (the shape changed).", status);
        }
      }
      if (status === 401 || status === 403 || status === 503) {
        if (!fallbackWarned) {
          fallbackWarned = true;
          console.warn(`[crazydramas] the Studio API refused the token (HTTP ${status}); reading the public API instead`);
        }
        return readPublicSeries(slug);
      }
      throw new CrazydramasApiError(`crazydramas answered HTTP ${status}.`, status);
    }
    return readPublicSeries(slug);
  },
  async publicSeries(slug: string) {
    if (!CRAZYDRAMAS_SLUG.test(slug)) throw new CrazydramasApiError("Invalid crazydramas slug.");
    return readPublicSeries(slug);
  },
};
