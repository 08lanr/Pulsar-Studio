import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { ADMOB_CALLBACK_PATH, ADMOB_STATE_COOKIE, admobAuthUrl, admobMissingEnv } from "@/lib/admob/oauth";
import { externalBaseUrl } from "@/lib/tiktok/oauth";

// "Connect AdMob" (decision 2026-11-09, "Ad unlocks in Studio"), step 1: send a staff member to Google to allow
// Studio to read AdMob (read-only, offline access, always the consent screen so a refresh token comes back). Staff
// only. A random `state` is remembered in an httpOnly cookie and must come back on the callback, or someone else's
// code could bind their AdMob account to this Studio.

export const dynamic = "force-dynamic";

const backToTab = (req: NextRequest, status: string, detail?: string) => {
  const url = new URL("/crazydramas/stats", externalBaseUrl(req));
  url.searchParams.set("tab", "adunlocks");
  url.searchParams.set("admob", status);
  if (detail) url.searchParams.set("detail", detail.slice(0, 200));
  return NextResponse.redirect(url);
};

export async function GET(req: NextRequest) {
  const g = await requireStaff();
  if (g.response) return g.response;
  const missing = admobMissingEnv();
  if (missing.length) return backToTab(req, "error", `Set ${missing.join(" and ")} in Studio's env first.`);
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(admobAuthUrl(`${externalBaseUrl(req)}${ADMOB_CALLBACK_PATH}`, state));
  res.cookies.set(ADMOB_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/admin/admob", maxAge: 600 });
  return res;
}
