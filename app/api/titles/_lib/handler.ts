// The house shape every Studio route shares, in one place so the ~30
// handlers under app/api/{titles,producer,producers,media} read the same:
// guardApiRequest (same-origin) -> requireStaff / requireProducer ->
// zod parse -> data layer / jobs / export -> NextResponse.json, and one
// error mapping: a DataError's code becomes its status (lib/data/errors.ts:
// not_found 404, forbidden 403, invalid 400, frozen/conflict 409), a
// LlmUnavailableError is 503 { code: 'llm_unavailable' } so the UI can draw
// the "set ANTHROPIC_API_KEY" state, an LlmError (the call reached the API
// and came back unusable) is 502, anything else is a logged 500. Lives
// under app/api/titles/_lib (a private folder Next never routes) because
// the api agent owns no lib/ file.

import { NextResponse, type NextRequest } from "next/server";
import type { ZodTypeAny, z } from "zod";
import { apiError, guardApiRequest } from "@/lib/api-guard";
import { DATA_ERROR_STATUS, isDataError } from "@/lib/data";
import { LlmError, LlmUnavailableError } from "@/lib/llm";

/** Any thrown value to the response the client should see. */
export function errorResponse(e: unknown): NextResponse {
  if (isDataError(e)) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: DATA_ERROR_STATUS[e.code] });
  }
  if (e instanceof LlmUnavailableError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
  }
  if (e instanceof LlmError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 502 });
  }
  console.error("[api] unhandled", e);
  return apiError("Internal error", undefined, 500);
}

/**
 * Origin check, then the handler, with every throw mapped. Handlers return a
 * Response (a NextResponse.json, a file, a redirect) and throw for failures.
 */
export async function handle(req: NextRequest, fn: () => Promise<Response>): Promise<Response> {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  try {
    return await fn();
  } catch (e) {
    return errorResponse(e);
  }
}

/** Either the parsed body or the 400 to return; `null` body (no JSON) parses as {} so optional-only schemas pass. */
export type Parsed<S extends ZodTypeAny> = { data: z.infer<S>; response?: undefined } | { data?: undefined; response: NextResponse };

export async function parseJson<S extends ZodTypeAny>(req: NextRequest, schema: S): Promise<Parsed<S>> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return { response: apiError("Invalid request", parsed.error.flatten(), 400) };
  return { data: parsed.data };
}

/** The [n] segment: a positive integer or a 400. */
export function episodeNumber(raw: string): number | NextResponse {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1) {
    return apiError(`Invalid episode number: ${raw}`, undefined, 400);
  }
  return n;
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof Response;
}
