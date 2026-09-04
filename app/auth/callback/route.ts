import { NextResponse, type NextRequest } from "next/server";
import {
  KIND_COOKIE,
  homeFor,
  kindCookieOptions,
  loadProfile,
  safeNextPath,
  externalOrigin,
} from "@/lib/auth";
import { dataSource } from "@/lib/data-source";

// Where a magic link lands. Supabase sends the browser here with a one-time
// code; exchanging it writes the session cookies (through the server
// client's cookie adapter), then we read the profile once to stamp the
// routing cookie and send the user to their surface. Any failure goes back
// to /login with a flag the form turns into a sentence — never a raw
// provider message on a public page.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = externalOrigin(req);
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  const fail = () => NextResponse.redirect(new URL("/login?error=callback", origin));

  if (dataSource() !== "supabase") return fail();
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return fail();

  const { createServerSupabase } = await import("@/lib/supabase/server");
  const supabase = createServerSupabase();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return fail();

  const profile = await loadProfile(supabase, data.user.id);
  if (!profile) {
    // A real auth user with no Studio profile: sign them back out so the
    // wall does not loop them between / and /login.
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=callback", origin));
  }

  const res = NextResponse.redirect(new URL(next ?? homeFor(profile.kind), origin));
  res.cookies.set(KIND_COOKIE, profile.kind, kindCookieOptions());
  return res;
}
