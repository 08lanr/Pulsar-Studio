import { NextRequest, NextResponse } from "next/server";

const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Same-origin gate for every API route. Ported from overlord.
 *
 * Blocks cross-origin requests: browsers always send an `Origin` header on
 * cross-site POSTs, so comparing it to our own host shuts the classic CSRF
 * door — any website a signed-in editor or producer happened to visit could otherwise
 * POST through their cookie. Authentication itself lives in middleware.ts
 * plus per-route session checks (lib/auth.ts); this guard is only the
 * origin check.
 */
export function guardApiRequest(req: NextRequest): NextResponse | null {
  const origin = req.headers.get("origin");

  if (origin) {
    const host = req.headers.get("host");
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return NextResponse.json(
        { error: "Cross-origin requests are not allowed." },
        { status: 403 }
      );
    }
  }

  return null;
}

/**
 * Build an error response.
 *
 * `detail` is the upstream raw payload (usually a provider's) — priceless while
 * developing (their messages list every legal enum value) but it can leak
 * account internals, so it is stripped in production builds and logged
 * server-side instead.
 */
export function apiError(message: string, detail?: unknown, status = 400) {
  if (detail !== undefined && !IS_PROD) {
    return NextResponse.json({ error: message, detail }, { status });
  }
  if (detail !== undefined) {
    console.error(`[api] ${message}`, JSON.stringify(detail));
  }
  return NextResponse.json({ error: message }, { status });
}
