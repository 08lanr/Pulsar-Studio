// The TikTok pixel a Website purchases launch optimizes toward (decision
// 2026-09-23, "TikTok launch: crazydramas link contract + pixel + one
// account"). crazydramas.com fires the pixel and sends the Events API copy
// itself; Studio sends no events and holds no Events API token. What Studio
// needs is the pixel's numeric id on the ad account it launches from:
//
//   the code  DALLBMJC77U250DBQUR0, what crazydramas.com loads (public).
//             Server setting TIKTOK_PIXEL_CODE; blank means this default.
//   the id    what /adgroup/create/ takes as pixel_id, per ad account, from
//             GET /open_api/v1.3/pixel/list/?advertiser_id=…&code=…
//             (https://business-api.tiktok.com/portal/docs?id=1740858697598978),
//             read-only, cached on the launch's campaign record.
//
// /pixel/list/ answers `data.pixels[]`, each with `pixel_id`, `pixel_code`
// and `asset_ownership.asset_relation_status`:
//   null / absent  the ad account owns the pixel (not in a Business Center)
//   TRANSFERRED    moved into a Business Center, still owned by this account
//   SHARED         shared with this account by a Business Center
//   UNBOUND        was shared, has been unbound: "will not be counted" in
//                  reporting, so a launch on it is refused
// A pixel the account cannot see is not in the list at all. Either way the
// person reads one plain sentence: the pixel isn't shared with this ad
// account in Business Center. A refusal of the read itself for want of the
// permission (40001) says what to do in the TikTok developer portal and that
// Traffic needs no pixel meanwhile.
//
// Every call goes through the transport lib/tiktok/index.ts picks: the fake
// in fixture mode (lib/tiktok/fake.ts models /pixel/list/), TikTok otherwise.

import type { TikTokTransport } from "./transport";

/** The pixel crazydramas.com loads (NEXT_PUBLIC_TIKTOK_PIXEL_ID there). Public by nature: every page view ships it. */
export const CRAZYDRAMAS_PIXEL_CODE = "DALLBMJC77U250DBQUR0";
/** Events Manager's pixel code shape. */
export const PIXEL_CODE_SHAPE = /^[A-Z0-9]{8,40}$/;

/** TIKTOK_PIXEL_CODE, trimmed; blank means crazydramas.com's pixel. Server-only. */
export function tiktokPixelCode(): string {
  return process.env.TIKTOK_PIXEL_CODE?.trim() || CRAZYDRAMAS_PIXEL_CODE;
}

export type PixelRelation = "OWNED" | "TRANSFERRED" | "SHARED" | "UNBOUND";

export type PixelResolution =
  | { ok: true; code: string; pixel_id: string; relation: PixelRelation; name: string | null }
  | { ok: false; code: string; reason: "not_found" | "not_linked" | "no_permission" | "unreadable" | "bad_code"; message: string };

type Row = Record<string, unknown>;
const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** One sentence per reason, the words the preview, the driver and /tiktok all print. */
export function pixelRefusal(reason: Exclude<PixelResolution, { ok: true }>["reason"], code: string, advertiserId: string, detail = ""): string {
  switch (reason) {
    case "bad_code": return `TIKTOK_PIXEL_CODE "${code}" is not a TikTok pixel code (8–40 capital letters and digits).`;
    // TikTok answers 40001 "advertiser does not grant you /pixel/list/:GET permission" when the Studio TikTok app
    // itself lacks the pixel permission (seen live 2026-09-23 on a token with scopes [1,2,4,6]). Reconnecting under
    // the app's current permissions brings the same token back, so the app comes first. Traffic needs no pixel.
    case "no_permission": return `TikTok won't let Studio read the pixels of ad account ${advertiserId} yet${detail ? ` (${detail})` : ""}: the Studio app on TikTok doesn't have the pixel permission. To fix it: 1. In the TikTok for Business developer portal, open the Studio app and add the Pixel permission (it may be listed under Measurement). 2. In Studio, open the TikTok page (/tiktok), press Connect a Business Center and approve the same Business Center again. 3. Preview again. Reconnecting before step 1 changes nothing. Until then, launch with Traffic, which needs no pixel: in Ad group settings, press Customize for this launch and choose Traffic · website.`;
    case "unreadable": return `Studio could not read the pixels of ad account ${advertiserId} from TikTok${detail ? ` (${detail})` : ""}. Preview again in a minute. Until it reads, you can launch with Traffic, which needs no pixel: in Ad group settings, press Customize for this launch and choose Traffic · website.`;
    case "not_linked": return `The pixel ${code} isn't shared with ad account ${advertiserId} in Business Center (it was unbound). Share it again in Business Center → Assets → Pixel → Linked accounts, then preview again.`;
    default: return `The pixel ${code} isn't shared with ad account ${advertiserId} in Business Center. Share it in Business Center → Assets → Pixel → Linked accounts, then preview again.`;
  }
}

/** Pure: the pixel of `code` in a /pixel/list/ page, and whether this account may use it. */
export function pixelFromList(rows: readonly Row[], code: string, advertiserId: string): PixelResolution {
  const match = rows.find((r) => text(r.pixel_code) === code);
  if (!match || !text(match.pixel_id)) return { ok: false, code, reason: "not_found", message: pixelRefusal("not_found", code, advertiserId) };
  const ownership = (match.asset_ownership ?? {}) as Row;
  const status = text(ownership.asset_relation_status).toUpperCase();
  const relation: PixelRelation = status === "TRANSFERRED" || status === "SHARED" || status === "UNBOUND" ? status : "OWNED";
  if (relation === "UNBOUND") return { ok: false, code, reason: "not_linked", message: pixelRefusal("not_linked", code, advertiserId) };
  return { ok: true, code, pixel_id: text(match.pixel_id), relation, name: text(match.pixel_name) || null };
}

/**
 * Is a TikTok refusal of /pixel/list/ a missing permission (the app's scopes),
 * not a failed read? 40001 is TikTok's "no permission" code; its words name
 * the permission or the scope either way. Pure.
 */
export function isPermissionRefusal(code: number, message: string | null | undefined): boolean {
  return code === 40001 || /\b(permission|scope)\b/i.test(message ?? "");
}

/**
 * Resolve `code` on one ad account: one read-only GET, filtered by the code
 * (page_size 20 is the endpoint's maximum; a code matches at most one pixel).
 */
export async function resolvePixel(tt: TikTokTransport, token: string, advertiserId: string, code: string): Promise<PixelResolution> {
  if (!PIXEL_CODE_SHAPE.test(code)) return { ok: false, code, reason: "bad_code", message: pixelRefusal("bad_code", code, advertiserId) };
  const res = await tt.get("/pixel/list/", token, { advertiser_id: advertiserId, code, page: 1, page_size: 20 });
  if (res.code !== 0) {
    const reason = isPermissionRefusal(res.code, res.message) ? "no_permission" : "unreadable";
    return { ok: false, code, reason, message: pixelRefusal(reason, code, advertiserId, res.message || `code ${res.code}`) };
  }
  const rows = Array.isArray(res.data?.pixels) ? (res.data!.pixels as Row[]) : [];
  return pixelFromList(rows, code, advertiserId);
}
