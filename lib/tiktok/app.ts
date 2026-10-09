// The app an App install launch promotes (decision 2026-10-09, "App install
// launches"), resolved on an ad account the way the pixel is (lib/tiktok/pixel.ts):
//
//   GET /open_api/v1.3/app/list/?advertiser_id=…
//
// answers the apps registered to the ad account in Ads Manager (Assets →
// Events → App), each with its `app_id`, the number /adgroup/create/ takes as
// `app_id` for an APP_PROMOTION campaign (docs: "You can get app_id by using
// the /app/list/ endpoint"). The row's other fields name the app and its
// store listing; their exact names are not documented in one place, so the
// match is by the store's package name wherever it appears on the row
// (download_url, package name, bundle id). ASSUMPTION, UNVERIFIED AGAINST THE
// LIVE API: the first live preview with the app permission is the check.
//
// While TikTok refuses /app/list/ for want of the permission (40001, as it
// refused the pixel read until the Pixel scope was approved; the Studio app's
// token answered exactly that on 2026-10-09), TIKTOK_APP_ID stands in and the
// account is marked unverified, exactly as TIKTOK_PIXEL_ID does for the pixel.
// Server-only; reads, never writes.

import { isPermissionRefusal } from "./pixel";
import type { TikTokTransport } from "./transport";

export type AppPlatform = "ANDROID" | "IOS";

/** The Android app's Google Play package (apps/mobile/app.json in crazydramas). Public by nature: it is the store listing's id. */
export const CRAZYDRAMAS_ANDROID_PACKAGE = "com.crazydrama.app";
/** The Play listing for a package. */
export const playStoreUrl = (pkg: string) => `https://play.google.com/store/apps/details?id=${pkg}`;

/** TIKTOK_APP_PACKAGE, trimmed; blank means the crazydramas Android app. Server-only. */
export function tiktokAppPackage(): string {
  return process.env.TIKTOK_APP_PACKAGE?.trim() || CRAZYDRAMAS_ANDROID_PACKAGE;
}

/** Ads Manager's numeric app ID, what /adgroup/create/ takes as app_id. */
export const APP_ID_SHAPE = /^\d{10,20}$/;

/**
 * TIKTOK_APP_ID, trimmed; blank means none. Server-only, not a secret: the
 * number Ads Manager shows for the registered app, used only while TikTok
 * refuses /app/list/ for want of the permission.
 */
export function tiktokAppId(): string | null {
  return process.env.TIKTOK_APP_ID?.trim() || null;
}

export type AppResolution =
  /** Read from /app/list/: TikTok lists this app on the account. */
  | { ok: true; package: string; platform: AppPlatform; app_id: string; name: string | null; relation: "LISTED" }
  /** TIKTOK_APP_ID while /app/list/ is refused for want of the permission: TikTok has not confirmed the id. */
  | { ok: true; package: string; platform: AppPlatform; app_id: string; name: string | null; relation: "UNVERIFIED"; note: string }
  | { ok: false; package: string; platform: AppPlatform; reason: "not_found" | "no_permission" | "unreadable" | "bad_app_id" | "app_id_differs"; message: string };

type Row = Record<string, unknown>;
const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** The plain words for an id set by hand, in English (the screens word it from lpx.appUnverified). */
export function appUnverifiedNote(appId: string, pkg: string): string {
  return `App ID ${appId} is set by hand for ${pkg}; TikTok can't confirm it yet because the app permission is still waiting for TikTok's approval. The launch uses it anyway; the first paused launch is the check.`;
}

/** One sentence per reason, the words the preview, the driver and /tiktok print. */
export function appRefusal(reason: Exclude<AppResolution, { ok: true }>["reason"], pkg: string, platform: AppPlatform, advertiserId: string, detail = ""): string {
  const store = platform === "ANDROID" ? "Google Play" : "the App Store";
  switch (reason) {
    case "bad_app_id": return `The app ID set by hand (TIKTOK_APP_ID) is "${detail}", which is not a TikTok app ID: that is the 10–20 digit number Ads Manager shows under Assets → Events → App for ${pkg}. Correct it or clear it, then preview again.`;
    case "app_id_differs": return detail;
    case "no_permission": return `TikTok won't let Studio read the apps of ad account ${advertiserId} yet${detail ? ` (${detail})` : ""}: the Studio app on TikTok doesn't have the app permission. To fix it: 1. In the TikTok for Business developer portal, open the Studio app and add the App Management permission. 2. In Studio, open the TikTok page (/tiktok), press Connect a Business Center and approve the same Business Center again. 3. Preview again. Until then, set TIKTOK_APP_ID to the app ID Ads Manager shows for ${pkg} (Assets → Events → App) and preview again; the launch then uses it unverified.`;
    case "unreadable": return `Studio could not read the apps of ad account ${advertiserId} from TikTok${detail ? ` (${detail})` : ""}. Preview again in a minute.`;
    default: return `Ad account ${advertiserId} has no ${store} app registered for ${pkg}. Register it in Ads Manager → Assets → Events → App (paste the ${store} link), connect it to the measurement partner (AppsFlyer) and preview again.`;
  }
}

/** Pure: the row of /app/list/ that names `pkg` for `platform`, and its app_id. */
export function appFromList(rows: readonly Row[], pkg: string, platform: AppPlatform, advertiserId: string): AppResolution {
  const platformOf = (r: Row): string => text(r.platform ?? r.app_platform ?? r.app_platform_id ?? r.os).toUpperCase();
  const namesPackage = (r: Row) => JSON.stringify(r).includes(pkg);
  const match = rows.find((r) => namesPackage(r) && (!platformOf(r) || platformOf(r).includes(platform) || (platform === "ANDROID" && platformOf(r) === "2") || (platform === "IOS" && platformOf(r) === "1")))
    ?? rows.find((r) => namesPackage(r));
  if (!match || !text(match.app_id)) return { ok: false, package: pkg, platform, reason: "not_found", message: appRefusal("not_found", pkg, platform, advertiserId) };
  return { ok: true, package: pkg, platform, app_id: text(match.app_id), name: text(match.app_name) || null, relation: "LISTED" };
}

export type ResolveAppOptions = {
  /** The id set by hand; omitted means TIKTOK_APP_ID, null means none. */
  appId?: string | null;
};

/**
 * Resolve the app on one ad account: one read-only GET of /app/list/. When
 * TikTok lists it, its app_id wins (a hand-set id that disagrees is refused
 * with both numbers); when TikTok refuses the read for want of the
 * permission, the hand-set id stands in, unverified; any other refusal is a
 * failed read, said plainly.
 */
export async function resolveApp(tt: TikTokTransport, token: string, advertiserId: string, pkg: string = tiktokAppPackage(), platform: AppPlatform = "ANDROID", opts: ResolveAppOptions = {}): Promise<AppResolution> {
  const handSet = opts.appId === undefined ? tiktokAppId() : opts.appId;
  if (handSet !== null && !APP_ID_SHAPE.test(handSet)) return { ok: false, package: pkg, platform, reason: "bad_app_id", message: appRefusal("bad_app_id", pkg, platform, advertiserId, handSet) };
  const res = await tt.get("/app/list/", token, { advertiser_id: advertiserId });
  if (res.code !== 0) {
    if (isPermissionRefusal(res.code, res.message)) {
      if (handSet) return { ok: true, package: pkg, platform, app_id: handSet, name: null, relation: "UNVERIFIED", note: appUnverifiedNote(handSet, pkg) };
      return { ok: false, package: pkg, platform, reason: "no_permission", message: appRefusal("no_permission", pkg, platform, advertiserId, res.message) };
    }
    return { ok: false, package: pkg, platform, reason: "unreadable", message: appRefusal("unreadable", pkg, platform, advertiserId, res.message) };
  }
  const rows = ((res.data?.apps ?? res.data?.list ?? []) as Row[]);
  const found = appFromList(rows, pkg, platform, advertiserId);
  if (found.ok && handSet && handSet !== found.app_id) {
    return { ok: false, package: pkg, platform, reason: "app_id_differs", message: `TikTok lists ${pkg} as app ID ${found.app_id}, but the app ID set by hand (TIKTOK_APP_ID) is ${handSet}. They must be the same app: change the setting to ${found.app_id} or clear it, then preview again.` };
  }
  return found;
}
