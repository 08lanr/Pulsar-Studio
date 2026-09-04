// Who is asking. One Session shape for both user kinds — Pulsar staff and a
// producer's people (core.profiles is the role model, see docs/data-model.md
// § 3) — resolved from whichever data source is live:
//
//   DATA_SOURCE=supabase  the Supabase auth cookie (RLS-backed user) plus the
//                         caller's core.profiles row
//   DATA_SOURCE=fixture   a plain cookie naming one of two fixture personas, so
//                         the whole UI runs with no Supabase project at all
//
// Cookie names live here because middleware.ts, the login flow and the route
// helpers all have to agree on them. RLS is the real enforcement in supabase
// mode; everything in this file is routing and defense in depth.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiError } from "@/lib/api-guard";
import { dataSource } from "@/lib/data-source";
import type { Locale } from "@/lib/i18n";

export type UserKind = "staff" | "producer";
export type StaffRole = "admin" | "editor";
export type ProducerRole = "approver" | "reviewer" | "viewer";

export type Session = {
  userId: string;
  kind: UserKind;
  staffRole?: StaffRole;
  producerId?: string;
  producerRole?: ProducerRole;
  displayName: string;
  locale: Locale;
};

/** Fixture mode only: which persona the browser is. Value: 'staff' | 'producer'. */
export const DEV_SESSION_COOKIE = "studio_dev_session";

/**
 * Supabase mode: the profile kind, written by the login flow after it read
 * core.profiles, so the middleware can route without a database round trip.
 * ROUTING ONLY — a forged value gets a producer to a staff URL whose every
 * query then fails under RLS. Never trust it for data access.
 */
export const KIND_COOKIE = "studio_kind";

const IS_PROD = process.env.NODE_ENV === "production";
const KIND_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // matches the refresh-token horizon
const DEV_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export function parseUserKind(value: string | undefined | null): UserKind | null {
  return value === "staff" || value === "producer" ? value : null;
}

export function kindCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: IS_PROD,
    path: "/",
    maxAge: KIND_COOKIE_MAX_AGE,
  };
}

export function devCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: IS_PROD,
    path: "/",
    maxAge: DEV_COOKIE_MAX_AGE,
  };
}

/** Where a signed-in user lands: the staff title list or the producer home. */
export function homeFor(kind: UserKind): string {
  return kind === "staff" ? "/titles" : "/producer";
}

/**
 * A post-login destination is honoured only when it is a local path. An
 * absolute URL or a protocol-relative one (//evil) would be an open redirect.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

// ---- fixture personas --------------------------------------------------------

// Must match data/fixture/ids.ts. Keeping this literal here avoids importing
// the whole fixture graph into auth middleware, but the value is one shared
// identity contract: a mismatched digit makes the real producer login see
// every submitted episode as "Not submitted" while staff preview still works.
export const FIXTURE_PRODUCER_ID = "00000000-0000-4000-8000-000000000001";

const FIXTURE_SESSIONS: Record<UserKind, Session> = {
  staff: {
    userId: "00000000-0000-4000-8000-0000000000f1",
    kind: "staff",
    staffRole: "admin",
    displayName: "Ruobin",
    locale: "en",
  },
  producer: {
    userId: "00000000-0000-4000-8000-0000000000f2",
    kind: "producer",
    producerId: FIXTURE_PRODUCER_ID,
    producerRole: "approver",
    displayName: "陈总",
    locale: "zh",
  },
};

export function fixtureSession(kind: UserKind): Session {
  return { ...FIXTURE_SESSIONS[kind] };
}

// ---- supabase profile --------------------------------------------------------

/** The columns of core.profiles the app reads. `core` must be an exposed schema. */
export type ProfileRow = {
  id: string;
  kind: UserKind;
  staff_role: StaffRole | null;
  producer_id: string | null;
  producer_role: ProducerRole | null;
  display_name: string;
  locale: string;
};

export const PROFILE_COLUMNS =
  "id, kind, staff_role, producer_id, producer_role, display_name, locale";

export function sessionFromProfile(p: ProfileRow): Session {
  return {
    userId: p.id,
    kind: p.kind,
    staffRole: p.kind === "staff" ? p.staff_role ?? "editor" : undefined,
    producerId: p.kind === "producer" ? p.producer_id ?? undefined : undefined,
    producerRole: p.kind === "producer" ? p.producer_role ?? "viewer" : undefined,
    displayName: p.display_name,
    locale: p.locale === "en" ? "en" : "zh",
  };
}

/**
 * The caller's profile row under RLS (a user can always read their own row).
 * Null when the auth user exists but nobody has created a profile for them
 * yet — the login flow turns that into a readable error instead of a blank
 * app.
 */
export async function loadProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .schema("core")
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("[auth] profile lookup failed", error.message);
    return null;
  }
  return (data as ProfileRow | null) ?? null;
}

// ---- getSession ----------------------------------------------------------------

/** The current user, or null. Server components and route handlers only. */
export async function getSession(): Promise<Session | null> {
  if (dataSource() === "fixture") {
    const kind = parseUserKind(cookies().get(DEV_SESSION_COOKIE)?.value);
    return kind ? fixtureSession(kind) : null;
  }
  // Imported lazily so the module graph stays light for callers that never
  // take this branch (fixture mode, and the middleware bundle).
  const { createServerSupabase } = await import("@/lib/supabase/server");
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const profile = await loadProfile(supabase, user.id);
  return profile ? sessionFromProfile(profile) : null;
}

// ---- route-handler guards -------------------------------------------------------

/**
 * Either the session or the response to return. Callers:
 *   const g = await requireStaff(); if (g.response) return g.response;
 */
export type Guard =
  | { session: Session; response?: undefined }
  | { session?: undefined; response: NextResponse };

export async function requireSession(): Promise<Guard> {
  const session = await getSession();
  if (!session) return { response: apiError("Not signed in", undefined, 401) };
  return { session };
}

export async function requireStaff(opts?: { role?: StaffRole }): Promise<Guard> {
  const g = await requireSession();
  if (g.response) return g;
  if (g.session.kind !== "staff") {
    return { response: apiError("Pulsar staff only", undefined, 403) };
  }
  if (opts?.role === "admin" && g.session.staffRole !== "admin") {
    return { response: apiError("Admin only", undefined, 403) };
  }
  return g;
}

const PRODUCER_RANK: Record<ProducerRole, number> = {
  viewer: 0,
  reviewer: 1,
  approver: 2,
};

/** `minRole` is inclusive: requireProducer({ minRole: "reviewer" }) admits approvers too. */
export async function requireProducer(opts?: {
  minRole?: ProducerRole;
}): Promise<Guard> {
  const g = await requireSession();
  if (g.response) return g;
  if (g.session.kind !== "producer" || !g.session.producerId) {
    return { response: apiError("Producer accounts only", undefined, 403) };
  }
  const min = opts?.minRole ?? "viewer";
  const have = g.session.producerRole ?? "viewer";
  if (PRODUCER_RANK[have] < PRODUCER_RANK[min]) {
    return {
      response: apiError(`Requires the ${min} role`, undefined, 403),
    };
  }
  return g;
}

/**
 * Staff, or a producer who can WORK (reviewer/approver — a viewer stays
 * read-only). The self-serve routes use this: which titles the producer may
 * actually touch is the data layer's per-title check (requireTitleEditor in
 * lib/data/fixture.ts; RLS + SQL guards in supabase mode), so this guard
 * only answers "may this kind of account edit anything at all".
 */
export async function requireMember(): Promise<Guard> {
  const g = await requireSession();
  if (g.response) return g;
  if (g.session.kind === "staff") return g;
  const role = g.session.producerRole ?? "viewer";
  if (role === "viewer") {
    return { response: apiError("Requires the reviewer role", undefined, 403) };
  }
  return g;
}

/**
 * Mirrors core.can_read_title(): staff see everything, a producer sees only
 * their own titles. Handlers call this before returning fixture data, where
 * there is no RLS to catch a wrong id.
 */
export function canReadTitle(
  session: Session,
  producerIdOfTitle: string | null | undefined
): boolean {
  if (session.kind === "staff") return true;
  return !!producerIdOfTitle && session.producerId === producerIdOfTitle;
}

/**
 * The origin the browser is on, from the proxy-forwarded headers — behind
 * Caddy `req.url` is the internal bind address and a magic link built from
 * it would land on a dead local port (the sibling's first go-live bug).
 */
export function externalOrigin(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3200";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
