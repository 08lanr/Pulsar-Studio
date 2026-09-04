import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, guardApiRequest } from "@/lib/api-guard";
import {
  KIND_COOKIE,
  externalOrigin,
  homeFor,
  kindCookieOptions,
  loadProfile,
  safeNextPath,
} from "@/lib/auth";
import { dataSource } from "@/lib/data-source";

// Supabase sign-in, both shapes the login card offers:
//   mode=password  signInWithPassword; the session cookies land through the
//                  server client's adapter and studio_kind is stamped from
//                  core.profiles so the middleware can route without a query.
//   mode=magic     signInWithOtp with the callback URL; nothing is set here —
//                  /auth/callback finishes the job when the link is clicked.
// Errors are statuses the form maps to sentences: 401 bad credentials, 403
// an auth user with no profile (we sign them out again so the wall cannot
// loop them). Fixture mode has no passwords; it 404s and the card never
// draws this form.

const Body = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("password"),
    email: z.string().trim().email(),
    password: z.string().min(1),
    next: z.string().nullish(),
  }),
  z.object({
    mode: z.literal("magic"),
    email: z.string().trim().email(),
    next: z.string().nullish(),
  }),
]);

export async function POST(req: NextRequest) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  if (dataSource() !== "supabase") return apiError("Not found", undefined, 404);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError("Invalid request", parsed.error.flatten(), 400);
  }
  const body = parsed.data;
  const next = safeNextPath(body.next);

  const { createServerSupabase } = await import("@/lib/supabase/server");
  const supabase = createServerSupabase();

  if (body.mode === "magic") {
    const callback = new URL("/auth/callback", externalOrigin(req));
    if (next) callback.searchParams.set("next", next);
    const { error } = await supabase.auth.signInWithOtp({
      email: body.email,
      options: { emailRedirectTo: callback.toString(), shouldCreateUser: false },
    });
    // shouldCreateUser=false: a stranger's email must not mint an auth user.
    // Supabase answers such requests with an error we deliberately flatten —
    // the form shows "check your inbox" either way, so the endpoint cannot
    // be used to probe which emails exist.
    if (error) console.warn("[auth] magic link refused", error.message);
    return NextResponse.json({ sent: true });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: body.email,
    password: body.password,
  });
  if (error || !data.user) return apiError("Wrong email or password", undefined, 401);

  const profile = await loadProfile(supabase, data.user.id);
  if (!profile) {
    await supabase.auth.signOut();
    return apiError("No Studio profile for this account", undefined, 403);
  }

  const res = NextResponse.json({ ok: true, home: next ?? homeFor(profile.kind) });
  res.cookies.set(KIND_COOKIE, profile.kind, kindCookieOptions());
  return res;
}
