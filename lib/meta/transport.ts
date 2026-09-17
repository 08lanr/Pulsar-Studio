import { dataSource } from "@/lib/data-source";

export type MetaObject = Record<string, unknown>;
export type MetaFile = { bytes: Uint8Array; filename: string; contentType: string };
export interface MetaTransport {
  readonly mode: "fake" | "live";
  get<T extends MetaObject = MetaObject>(path: string, params?: MetaObject): Promise<T>;
  post<T extends MetaObject = MetaObject>(path: string, params: MetaObject): Promise<T>;
  upload<T extends MetaObject = MetaObject>(path: string, params: MetaObject, files: Record<string, MetaFile>): Promise<T>;
}

/** Sanitized diagnostics never include URLs, response bodies or credentials. */
export class MetaApiError extends Error {
  constructor(message: string, readonly code?: number, readonly ambiguous = false) {
    super(message);
    this.name = "MetaApiError";
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

function value(value: unknown): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Only this transport sends HTTP to Meta. Never retries an uncertain write. */
async function request<T extends MetaObject>(method: "GET" | "POST", path: string, params: MetaObject, files?: Record<string, MetaFile>): Promise<T> {
  serverOnly();
  if (dataSource() !== "supabase") throw new MetaApiError("Live Meta access is disabled in fixture mode.");
  if (method === "POST" && process.env.META_LIVE_WRITES !== "enabled") throw new MetaApiError("Meta live writes are disabled. Set META_LIVE_WRITES=enabled only in the approved deployment.");
  const token = process.env.META_ACCESS_TOKEN?.trim();
  if (!token) throw new MetaApiError("META_ACCESS_TOKEN is not configured.");
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
    throw new MetaApiError(`Meta rejected the request (HTTP ${response.status}${code === undefined ? "" : `, code ${code}`}).`, code, method === "POST" && response.status >= 500);
  }
  return json as T;
}

export const liveMetaTransport: MetaTransport = {
  mode: "live",
  get: (path, params = {}) => request("GET", path, params),
  post: (path, params) => request("POST", path, params),
  upload: (path, params, files) => request("POST", path, params, files),
};

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
