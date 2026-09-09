import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { OAUTH_STATE_COOKIE, externalBaseUrl } from "@/lib/tiktok/oauth";
import { saveToken } from "@/lib/tiktok/tokens";

// Step 2 of TikTok OAuth: TikTok redirects here with ?auth_code=&state=. We
// verify the state, exchange the code for a long-lived access token, store
// it in .tokens.json and land back on the TikTok setup page. The exchange
// always talks to the production host (OAuth has no sandbox).

export const dynamic = "force-dynamic";

function backToSetup(req: NextRequest, status: string, detail?: string) {
  const url = new URL("/tiktok", externalBaseUrl(req));
  url.searchParams.set("connect", status);
  if (detail) url.searchParams.set("detail", detail.slice(0, 200));
  const res = NextResponse.redirect(url);
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  const g = await requireStaff({ role: "admin" });
  if (g.response) return g.response;

  const returnedState = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!expectedState || !returnedState || expectedState !== returnedState) {
    return backToSetup(req, "error", "Authorization could not be verified (state mismatch). Start again from Connect TikTok.");
  }
  const authCode = req.nextUrl.searchParams.get("auth_code");
  if (!authCode) return backToSetup(req, "error", "TikTok returned no auth_code.");

  let tokenData: { code?: number; message?: string; data?: { access_token?: string; advertiser_ids?: string[]; scope?: number[] } };
  try {
    const tokenRes = await fetch("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: process.env.TIKTOK_APP_ID, secret: process.env.TIKTOK_APP_SECRET, auth_code: authCode }),
      signal: AbortSignal.timeout(20_000),
    });
    tokenData = JSON.parse(await tokenRes.text());
  } catch {
    return backToSetup(req, "error", "Could not reach TikTok to complete the authorization. Try again.");
  }
  if (tokenData.code !== 0 || !tokenData.data?.access_token) {
    console.error("[tiktok-oauth] token exchange failed", { code: tokenData.code, message: tokenData.message });
    return backToSetup(req, "error", `Token exchange failed: ${tokenData.message ?? "unknown error"}`);
  }
  saveToken({ access_token: tokenData.data.access_token, advertiser_ids: tokenData.data.advertiser_ids, scope: tokenData.data.scope, savedAt: new Date().toISOString() });
  console.log(`[tiktok-oauth] ${g.session.displayName} authorized ${tokenData.data.advertiser_ids?.length ?? 0} advertiser account(s)`);
  return backToSetup(req, "connected");
}
