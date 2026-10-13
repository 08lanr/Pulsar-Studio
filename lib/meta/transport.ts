import { dataSource } from "@/lib/data-source";

export type MetaObject = Record<string, unknown>;
export type MetaFile = { bytes: Uint8Array; filename: string; contentType: string };
export interface MetaTransport {
  readonly mode: "fake" | "live";
  get<T extends MetaObject = MetaObject>(path: string, params?: MetaObject): Promise<T>;
  post<T extends MetaObject = MetaObject>(path: string, params: MetaObject): Promise<T>;
  upload<T extends MetaObject = MetaObject>(path: string, params: MetaObject, files: Record<string, MetaFile>): Promise<T>;
  /**
   * A transport bound to a Page access token, derived at call time from the
   * configured token. Organic publishing (a Page video post, an Instagram
   * Reel on the Page's linked account) is the only caller. The Page token is
   * never stored, logged, seeded or returned; the fake returns itself.
   */
  forPage(pageId: string): MetaTransport;
}

/** Sanitized diagnostics never include URLs, response bodies or credentials. */
export class MetaApiError extends Error {
  /** Meta's `error_subcode`, when it sent one: a bare code 100 and 100/33 are different refusals. */
  readonly subcode?: number;
  constructor(message: string, readonly code?: number, readonly ambiguous = false, subcode?: number) {
    super(message);
    this.name = "MetaApiError";
    this.subcode = subcode;
  }
}

function serverOnly() {
  if (typeof window !== "undefined") throw new Error("Meta credentials are server-only.");
}

export function metaApiVersion(): string {
  const version = process.env.META_API_VERSION || "v26.0";
  if (!/^v\d+\.0$/.test(version)) throw new Error("Invalid META_API_VERSION.");
  return version;
}

/**
 * Which configured token a transport sends (decision 2026-10-12, "Creator
 * accounts"). Two Meta apps, two System User tokens:
 *   ads      META_ACCESS_TOKEN — app "CrazyDramas Ads", Marketing API only:
 *            launches, controls, the monitor, pixels, the "From the Page" list.
 *   publish  META_PUBLISH_TOKEN — app "Pulsar Entertainment", the Instagram and
 *            Page use cases: every organic post (clips and creator accounts),
 *            comments, replies and insights. Falls back to META_ACCESS_TOKEN
 *            when unset, so a deployment without it behaves as before.
 * Only the variable's NAME ever leaves this module; the value is read per call.
 */
export type MetaTokenKind = "ads" | "publish";
export function metaTokenSource(kind: MetaTokenKind): "META_ACCESS_TOKEN" | "META_PUBLISH_TOKEN" | null {
  if (kind === "publish" && process.env.META_PUBLISH_TOKEN?.trim()) return "META_PUBLISH_TOKEN";
  return process.env.META_ACCESS_TOKEN?.trim() ? "META_ACCESS_TOKEN" : null;
}
function configuredToken(kind: MetaTokenKind): string {
  const source = metaTokenSource(kind);
  const token = source ? process.env[source]?.trim() : "";
  if (!token) throw new MetaApiError(kind === "publish" ? "META_PUBLISH_TOKEN (or META_ACCESS_TOKEN) is not configured." : "META_ACCESS_TOKEN is not configured.");
  return token;
}

function value(value: unknown): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Only this transport sends HTTP to Meta. Never retries an uncertain write. */
async function request<T extends MetaObject>(method: "GET" | "POST", path: string, params: MetaObject, files: Record<string, MetaFile> | undefined, actAs: string | undefined, kind: MetaTokenKind): Promise<T> {
  serverOnly();
  if (dataSource() !== "supabase") throw new MetaApiError("Live Meta access is disabled in fixture mode.");
  if (method === "POST" && process.env.META_LIVE_WRITES !== "enabled") throw new MetaApiError("Meta live writes are disabled. Set META_LIVE_WRITES=enabled only in the approved deployment.");
  const configured = configuredToken(kind);
  // Derived per call, held only for this request, never assigned to anything
  // that outlives it. A failure here says the Page is unavailable, never why.
  const token = actAs ? await pageToken(actAs, configured) : configured;
  if (!/^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/.test(path)) throw new MetaApiError("Invalid Meta endpoint.");
  const url = new URL(`https://graph.facebook.com/${metaApiVersion()}/${path}`);
  const headers = { Authorization: `Bearer ${token}` };
  let body: URLSearchParams | FormData | undefined;
  if (method === "GET") {
    for (const [key, val] of Object.entries(params)) if (val !== undefined) url.searchParams.set(key, value(val));
  } else if (files) {
    body = new FormData();
    for (const [key, val] of Object.entries(params)) if (val !== undefined) body.set(key, value(val));
    for (const [key, file] of Object.entries(files)) body.set(key, new Blob([file.bytes as BlobPart], { type: file.contentType }), file.filename);
  } else {
    body = new URLSearchParams();
    for (const [key, val] of Object.entries(params)) if (val !== undefined) body.set(key, value(val));
  }
  let response: Response;
  let json: MetaObject;
  try {
    response = await fetch(url, { method, headers, body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(files ? 180_000 : 25_000) });
    json = await response.json() as MetaObject;
  } catch {
    throw new MetaApiError("Meta request did not return a verifiable response; read back before retrying.", undefined, method === "POST");
  }
  const error = json.error as MetaObject | undefined;
  if (!response.ok || error) {
    const code = typeof error?.code === "number" ? error.code : undefined;
    const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : undefined;
    // Meta's own sentence is what makes a refusal fixable, and it carries no
    // credential: only `message`, the user-facing pair and the codes are taken,
    // never the response body, the request URL or Meta's paging links.
    const said = [error?.error_user_title, error?.error_user_msg ?? error?.message]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join(" — ").slice(0, 300);
    const where = `HTTP ${response.status}${code === undefined ? "" : `, code ${code}`}${subcode === undefined ? "" : `/${subcode}`}`;
    throw new MetaApiError(`Meta rejected the request (${where})${said ? `: ${said}` : ""}`, code, method === "POST" && response.status >= 500, subcode);
  }
  return json as T;
}

/**
 * GET /{page_id}?fields=access_token with the configured token. The value is
 * returned to the single request that asked for it and to nothing else: it is
 * not cached, not written to a row, not logged and not part of any error.
 */
async function pageToken(pageId: string, configured: string): Promise<string> {
  if (!/^[A-Za-z0-9_]+$/.test(pageId)) throw new MetaApiError("Invalid Facebook Page reference.");
  const url = new URL(`https://graph.facebook.com/${metaApiVersion()}/${pageId}`);
  url.searchParams.set("fields", "access_token");
  let json: MetaObject;
  try {
    const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${configured}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(25_000) });
    json = await response.json() as MetaObject;
    if (!response.ok || json.error) throw new MetaApiError(`Meta refused the Page access token (HTTP ${response.status}).`, typeof (json.error as MetaObject | undefined)?.code === "number" ? (json.error as MetaObject).code as number : undefined);
  } catch (error) {
    if (error instanceof MetaApiError) throw error;
    throw new MetaApiError("Meta did not return a usable Page access token.");
  }
  const token = typeof json.access_token === "string" ? json.access_token.trim() : "";
  if (!token) throw new MetaApiError("This Page did not return an access token. Check pages_manage_posts on the configured token.");
  return token;
}

function liveTransport(kind: MetaTokenKind, actAs?: string): MetaTransport {
  return {
    mode: "live",
    get: (path, params = {}) => request("GET", path, params, undefined, actAs, kind),
    post: (path, params) => request("POST", path, params, undefined, actAs, kind),
    upload: (path, params, files) => request("POST", path, params, files, actAs, kind),
    forPage: (pageId: string) => liveTransport(kind, pageId),
  };
}

/** The ads token: launches, controls, the monitor, pixels. */
export const liveMetaTransport: MetaTransport = liveTransport("ads");
/**
 * The publish token: organic posts, comments, replies and insights. An
 * Instagram account with no linked Page is called directly
 * (`/{instagram_id}/...`); with a Page, `forPage` derives the Page token from
 * this same token, as before.
 */
export const liveMetaPublishTransport: MetaTransport = liveTransport("publish");

/** Use cursor values, never Meta's next URL (which may contain a token). */
export async function metaList(transport: MetaTransport, path: string, params: MetaObject = {}): Promise<MetaObject[]> {
  const rows: MetaObject[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await transport.get(path, { ...params, limit: 100, ...(after ? { after } : {}) });
    if (!Array.isArray(response.data)) throw new MetaApiError("Meta returned an invalid list.");
    rows.push(...response.data as MetaObject[]);
    const paging = response.paging as { next?: string; cursors?: { after?: string } } | undefined;
    if (!paging?.next) return rows;
    after = paging.cursors?.after;
    if (!after || seen.has(after)) throw new MetaApiError("Meta pagination could not be completed.");
    seen.add(after);
  }
  throw new MetaApiError("Meta pagination safety limit reached.");
}
