// The only module allowed to fetch crazydramas.com (decision 2026-09-23,
// "the crazydramas connection"; plan A1–A2). Modelled on lib/meta/transport.ts:
// server-only, one base URL, sanitised errors that carry no URL, no body and
// no header, a timeout on every request. Read-only v1 — the two public
// endpoints, no credential of any kind. When credentials are added later
// (CRAZYDRAMAS_STUDIO_TOKEN, a Mux read token) this file is the only one
// that reads them, and they never enter a row, a log, a fixture or a
// response (the lib/tiktok/tokens.ts rule).
//
//   Cookie: pulsar_mock=0   the edge cache ignores it, so `mock-*` slugs are
//                           dropped after the parse as well
//   cache: 'no-store'       Next 14 caches server fetches otherwise
//   60 s of lag             the public max-age after a publish on crazydramas
//
// Nothing imports this file for a transport; lib/crazydramas/index.ts picks
// the fake or the live one.

import { dataSource } from "@/lib/data-source";
import { type CatalogEntry, parseCatalog, parseSeries, type SeriesRead, CRAZYDRAMAS_SLUG } from "./types";

export interface CrazydramasTransport {
  readonly mode: "fake" | "live";
  /** `GET /api/dramas`: the published catalog, whitelisted, the mock series dropped. */
  catalog(): Promise<CatalogEntry[]>;
  /** `GET /api/dramas/<slug>`: the series and its published episodes, or a 404 as a value. Anything else throws. */
  series(slug: string): Promise<SeriesRead>;
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

/** Only this function sends HTTP to crazydramas. */
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
    const { status, body } = await get(`/api/dramas/${encodeURIComponent(slug)}`);
    if (status === 404) return { http_status: 404, drama: null, episodes: null };
    try {
      return parseSeries(body);
    } catch {
      throw new CrazydramasApiError("crazydramas answered a series Studio cannot read (the shape changed).", status);
    }
  },
};
