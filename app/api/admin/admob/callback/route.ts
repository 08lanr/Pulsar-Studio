import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { saveAdmobRefreshToken } from "@/lib/admob/connection";
import { ADMOB_CALLBACK_PATH, ADMOB_STATE_COOKIE, AdmobAuthError, exchangeAdmobCode } from "@/lib/admob/oauth";
import { clearAdmobCache } from "@/lib/admob/read";
import { externalBaseUrl } from "@/lib/tiktok/oauth";

// "Connect AdMob" (decision 2026-11-09, "Ad unlocks in Studio"), step 2: Google sends the staff member back here
// with ?code=&state=. The state must match the cookie Connect set; the code is exchanged for tokens and only the
// refresh token is kept, as the shared setting (lib/admob/connection.ts), so every Studio on the same storage reads
// AdMob. Then back to the Ad unlocks tab. No token is logged, put in the address or shown.

export const dynamic = "force-dynamic";

function backToTab(req: NextRequest, status: string, detail?: string) {
  const url = new URL("/crazydramas/stats", externalBaseUrl(req));
  url.searchParams.set("tab", "adunlocks");
  url.searchParams.set("admob", status);
  if (detail) url.searchParams.set("detail", detail.slice(0, 200));
  const res = NextResponse.redirect(url);
  res.cookies.set(ADMOB_STATE_COOKIE, "", { path: "/api/admin/admob", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const g = await requireStaff({ role: "admin" });
  if (g.response) return g.response;
  const q = req.nextUrl.searchParams;
  const returned = q.get("state");
  const expected = req.cookies.get(ADMOB_STATE_COOKIE)?.value;
  if (!expected || !returned || expected !== returned) return backToTab(req, "error", "The sign-in could not be verified (state mismatch). Start again from Connect AdMob.");
  const denied = q.get("error");
  if (denied) return backToTab(req, "error", denied === "access_denied" ? "Access to AdMob was not allowed." : `Google answered: ${denied}`);
  const code = q.get("code");
  if (!code) return backToTab(req, "error", "Google sent no code.");
  try {
    const { refresh_token } = await exchangeAdmobCode(code, `${externalBaseUrl(req)}${ADMOB_CALLBACK_PATH}`);
    await saveAdmobRefreshToken(refresh_token, g.session.displayName || null);
  } catch (e) {
    return backToTab(req, "error", e instanceof AdmobAuthError ? e.message : "The AdMob connection could not be saved.");
  }
  clearAdmobCache();
  console.log(`[admob-oauth] ${g.session.displayName} connected AdMob`);
  return backToTab(req, "connected");
}
