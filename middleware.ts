import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import {
  DEV_SESSION_COOKIE,
  KIND_COOKIE,
  PROFILE_COLUMNS,
  homeFor,
  kindCookieOptions,
  parseUserKind,
  type UserKind,
} from "@/lib/auth";
import { dataSource } from "@/lib/data-source";

// The login wall. One place, deny-by-default, ported from the sibling: every
// page and every API route needs a signed-in user except the public surface
// (the door itself, the auth callback, the auth API, static assets). Pages
// bounce to /login?next=…; API calls get a 401 JSON body (a fetch that
// followed a redirect to an HTML login page shows up as a JSON parse error
// far from the cause).
//
// Role gating is by URL surface: /producer/* is the producer's; everything
// else under the wall is Pulsar staff's. A producer on a staff URL is sent
// to /producer; staff may open /producer/* to preview what the producer
// sees. API routes are NOT role-gated here — each handler calls
// requireStaff / requireProducer (lib/auth.ts), and in supabase mode RLS is
// the real enforcement whatever the routing says.
//
// In supabase mode the user comes from @supabase/ssr, which also refreshes
// an expiring session and writes the new cookies onto both the request (so
// server components downstream see them) and the response. The user's KIND
// comes from the studio_kind cookie the login flow set after reading
// core.profiles — routing only; a missing cookie is repaired with one
// profile read. In fixture mode the studio_dev_session cookie names a
// persona and there is nothing to refresh.

const PUBLIC_PATHS = new Set(["/login", "/auth/callback", "/favicon.ico", "/robots.txt"]);
const PUBLIC_PREFIXES = ["/api/auth/", "/_next/", "/fonts/"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function isProducerSurface(pathname: string): boolean {
  return pathname === "/producer" || pathname.startsWith("/producer/");
}

/** Build the redirect from the proxy-forwarded host, not req.nextUrl (Caddy). */
function externalUrl(req: NextRequest, path: string): URL {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return new URL(path, req.nextUrl);
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return new URL(path, `${proto}://${host}`);
}

/** Refreshed auth cookies must ride along on a redirect too, or the next page re-refreshes. */
function carryCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const c of from.cookies.getAll()) to.cookies.set(c);
  return to;
}

type Resolved = { kind: UserKind | null; res: NextResponse };

function resolveFixture(req: NextRequest): Resolved {
  return {
    kind: parseUserKind(req.cookies.get(DEV_SESSION_COOKIE)?.value),
    res: NextResponse.next({ request: req }),
  };
}

async function resolveSupabase(req: NextRequest): Promise<Resolved> {
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(toSet: { name: string; value: string; options: CookieOptions }[]) {
          // The documented @supabase/ssr shape: mutate the request so a fresh
          // NextResponse.next({ request }) forwards the new cookies to server
          // components, then set them on the response for the browser.
          for (const { name, value } of toSet) req.cookies.set(name, value);
          res = NextResponse.next({ request: req });
          for (const { name, value, options } of toSet) {
            res.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  // getUser() validates against the auth server; getSession() would trust
  // the cookie's own claims.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: null, res };

  let kind = parseUserKind(req.cookies.get(KIND_COOKIE)?.value);
  if (!kind) {
    // Signed in but the routing cookie is gone (cleared site data, or a
    // session that predates it). One profile read repairs it.
    const { data } = await supabase
      .schema("core")
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", user.id)
      .maybeSingle();
    kind = parseUserKind((data as { kind?: string } | null)?.kind);
    if (kind) res.cookies.set(KIND_COOKIE, kind, kindCookieOptions());
  }
  return { kind, res };
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const { kind, res } =
    dataSource() === "supabase" ? await resolveSupabase(req) : resolveFixture(req);

  const isApi = pathname.startsWith("/api/");

  if (!kind) {
    if (isApi) {
      return carryCookies(
        res,
        NextResponse.json({ error: "Not signed in" }, { status: 401 })
      );
    }
    const login = externalUrl(req, "/login");
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    return carryCookies(res, NextResponse.redirect(login));
  }

  if (kind === "producer" && !isApi && !isProducerSurface(pathname)) {
    return carryCookies(res, NextResponse.redirect(externalUrl(req, homeFor("producer"))));
  }

  return res;
}

export const config = {
  // Everything except Next's own static assets and the self-hosted fonts.
  // The favicon is public only because browsers fetch it before anyone can
  // log in.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
};
