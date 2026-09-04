import { NextResponse, type NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { DEV_SESSION_COOKIE, KIND_COOKIE, externalOrigin } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";

// Sign out and go to the door. Accepts POST (the Nav's form) and GET (a plain
// link, and the way a producer on a phone gets out of a stuck state): a GET
// sign-out is the one "unsafe" GET worth having — its worst case is having to
// sign in again. In supabase mode signOut() clears the auth cookies through
// the server client's adapter; the routing cookie and the fixture persona
// cookie are cleared explicitly on the redirect response.

export const dynamic = "force-dynamic";

async function signOut(req: NextRequest) {
  if (dataSource() === "supabase") {
    const { createServerSupabase } = await import("@/lib/supabase/server");
    const supabase = createServerSupabase();
    await supabase.auth.signOut().catch(() => undefined);
  }
  const res = NextResponse.redirect(new URL("/login", externalOrigin(req)), 303);
  res.cookies.delete(KIND_COOKIE);
  res.cookies.delete(DEV_SESSION_COOKIE);
  return res;
}

export async function POST(req: NextRequest) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  return signOut(req);
}

export async function GET(req: NextRequest) {
  return signOut(req);
}
