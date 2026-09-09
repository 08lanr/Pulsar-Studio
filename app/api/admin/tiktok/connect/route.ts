import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { requireStaff } from "@/lib/auth";
import { OAUTH_STATE_COOKIE, redirectUriFor } from "@/lib/tiktok/oauth";

// Step 1 of TikTok OAuth: send the operator to TikTok to approve access to
// Pulsar's Business Center — ported from Pulsar Grow. Staff admin only; the
// producer portal never touches ad-account plumbing.
//
// The authorization portal is production-only; there is no sandbox consent
// screen (sandbox tokens are pasted into .env.local).

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const g = await requireStaff({ role: "admin" });
  if (g.response) return g.response;
  const appId = process.env.TIKTOK_APP_ID;
  if (!appId) return apiError("TIKTOK_APP_ID is not set. Put the TikTok developer app's App ID and Secret in .env.local.", undefined, 500);

  // CSRF: a random value remembered in an httpOnly cookie; TikTok must hand
  // the same value back on the callback, or an attacker could feed us their
  // own auth_code and bind their ad account to this deployment.
  const state = crypto.randomUUID();
  const authUrl = new URL("https://business-api.tiktok.com/portal/auth");
  authUrl.searchParams.set("app_id", appId);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("redirect_uri", redirectUriFor(req));
  const res = NextResponse.redirect(authUrl.toString());
  res.cookies.set(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 });
  return res;
}
