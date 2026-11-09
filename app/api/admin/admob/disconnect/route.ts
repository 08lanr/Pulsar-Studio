import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { clearAdmobRefreshToken, readAdmobRefreshToken } from "@/lib/admob/connection";
import { clearAdmobAccessToken, revokeAdmobToken } from "@/lib/admob/oauth";
import { clearAdmobCache } from "@/lib/admob/read";
import { externalBaseUrl } from "@/lib/tiktok/oauth";
import { handle } from "../../../titles/_lib/handler";

// Disconnect AdMob (decision 2026-11-09, "Ad unlocks in Studio"): staff only, a same-origin POST from the Ad unlocks
// tab's form. Forgets the stored refresh token for every Studio on the same storage, asks Google to revoke it (best
// effort) and drops the kept access token and reads; then back to the tab, which offers Connect again.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const token = await readAdmobRefreshToken();
    await clearAdmobRefreshToken(g.session.displayName || null);
    clearAdmobAccessToken();
    clearAdmobCache();
    if (token) await revokeAdmobToken(token);
    const url = new URL("/crazydramas/stats", externalBaseUrl(req));
    url.searchParams.set("tab", "adunlocks");
    url.searchParams.set("admob", "disconnected");
    return NextResponse.redirect(url, 303);
  });
}
