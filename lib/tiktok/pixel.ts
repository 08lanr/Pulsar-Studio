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
// The id set by hand (decision 2026-09-24, "TikTok pixel ID set by hand"):
// while TikTok has not approved the app's pixel scopes, /pixel/list/ answers
// 40001 however the Business Center is set up. TIKTOK_PIXEL_ID, the numeric id
// Events Manager shows for the pixel, stands in for the list ONLY then: the
// resolution is ok and marked UNVERIFIED (TikTok has not confirmed the id; the
// first paused launch is the check). When the account's Business Center is
// known, /bc/pixel/get/ is asked too: listing the configured code there names
// the pixel's owner. When /pixel/list/ answers, it wins and the setting is
// ignored, unless the two name different ids, which is refused with both.
// A setting that is not 15–20 digits is refused before anything is read.
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

/** Events Manager's numeric pixel ID, what /adgroup/create/ takes as pixel_id. */
export const PIXEL_ID_SHAPE = /^\d{15,20}$/;

/**
 * TIKTOK_PIXEL_ID, trimmed; blank means none. Server-only, not a secret: the
 * numeric id Events Manager shows for the pixel, used only while TikTok
 * refuses /pixel/list/ for want of the permission.
 */
export function tiktokPixelId(): string | null {
  return process.env.TIKTOK_PIXEL_ID?.trim() || null;
}

export type PixelRelation = "OWNED" | "TRANSFERRED" | "SHARED" | "UNBOUND";

export type PixelResolution =
  /** Read from /pixel/list/: TikTok says this account may use the pixel. */
  | { ok: true; code: string; pixel_id: string; relation: PixelRelation; name: string | null }
  /**
   * TIKTOK_PIXEL_ID while /pixel/list/ is refused for want of the permission:
   * TikTok has not confirmed the id. `owner` names the Business Center whose
   * /bc/pixel/get/ lists the code, when one was asked and answered; `note` is
   * the plain sentence (the screens word it from their own locale keys).
   */
  | { ok: true; code: string; pixel_id: string; relation: "UNVERIFIED"; name: string | null; owner: string | null; note: string }
  | { ok: false; code: string; reason: "not_found" | "not_linked" | "no_permission" | "unreadable" | "bad_code" | "bad_pixel_id" | "pixel_id_differs"; message: string };

type Row = Record<string, unknown>;
const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** The plain words for an id set by hand, in English (the screens word it from lpx.pixelUnverified and lpx.pixelOwner). */
export function pixelUnverifiedNote(pixelId: string, owner: string | null): string {
  const note = `Pixel ID ${pixelId} is set by hand; TikTok can't confirm it yet because the pixel permission is still waiting for TikTok's approval. The launch uses it anyway; the first paused launch is the check.`;
  return owner ? `${note} The pixel is owned by ${owner} — confirmed through the Business Center.` : note;
}

/** Two sources name different ids for one pixel code: both numbers, in words. */
function pixelIdDiffers(code: string, lister: string, listed: string, configured: string): string {
  return `${lister} pixel ${code} as pixel ID ${listed}, but the pixel ID set by hand (TIKTOK_PIXEL_ID) is ${configured}. They must be the same pixel: change the setting to ${listed} or clear it, then preview again.`;
}

/** One sentence per reason, the words the preview, the driver and /tiktok all print. */
export function pixelRefusal(reason: Exclude<PixelResolution, { ok: true }>["reason"], code: string, advertiserId: string, detail = ""): string {
  switch (reason) {
    case "bad_code": return `TIKTOK_PIXEL_CODE "${code}" is not a TikTok pixel code (8–40 capital letters and digits).`;
    // `detail` is the setting as typed.
    case "bad_pixel_id": return `The pixel ID set by hand (TIKTOK_PIXEL_ID) is "${detail}", which is not a TikTok pixel ID: that is the 15–20 digit number Events Manager shows for pixel ${code}. Correct it or clear it, then preview again.`;
    // `detail` is the whole sentence (pixelIdDiffers): it carries both numbers.
    case "pixel_id_differs": return detail;
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

export type ResolvePixelOptions = {
  /** The id set by hand; omitted means TIKTOK_PIXEL_ID, null means none. */
  pixelId?: string | null;
  /** The Business Center the ad account sits in, when known: asked about the pixel's owner only when the id is set by hand. */
  businessCenterId?: string | null;
};

/**
 * Resolve `code` on one ad account: one read-only GET, filtered by the code
 * (page_size 20 is the endpoint's maximum; a code matches at most one pixel).
 * The one resolution the preview gate, /tiktok and the driver share.
 */
export async function resolvePixel(tt: TikTokTransport, token: string, advertiserId: string, code: string, opts: ResolvePixelOptions = {}): Promise<PixelResolution> {
  if (!PIXEL_CODE_SHAPE.test(code)) return { ok: false, code, reason: "bad_code", message: pixelRefusal("bad_code", code, advertiserId) };
  const handSet = opts.pixelId === undefined ? tiktokPixelId() : opts.pixelId?.trim() || null;
  if (handSet && !PIXEL_ID_SHAPE.test(handSet)) return { ok: false, code, reason: "bad_pixel_id", message: pixelRefusal("bad_pixel_id", code, advertiserId, handSet) };
  const res = await tt.get("/pixel/list/", token, { advertiser_id: advertiserId, code, page: 1, page_size: 20 });
  if (res.code !== 0) {
    const permission = isPermissionRefusal(res.code, res.message);
    if (permission && handSet) return handSetPixel(tt, token, code, handSet, opts.businessCenterId ?? null);
    const reason = permission ? "no_permission" : "unreadable";
    return { ok: false, code, reason, message: pixelRefusal(reason, code, advertiserId, res.message || `code ${res.code}`) };
  }
  const rows = Array.isArray(res.data?.pixels) ? (res.data!.pixels as Row[]) : [];
  const found = pixelFromList(rows, code, advertiserId);
  // The list wins; a hand-set id that names another pixel is a mistake to fix, never a silent choice.
  if (found.ok && handSet && found.pixel_id !== handSet)
    return { ok: false, code, reason: "pixel_id_differs", message: pixelRefusal("pixel_id_differs", code, advertiserId, pixelIdDiffers(code, `TikTok lists ad account ${advertiserId}'s`, found.pixel_id, handSet)) };
  return found;
}

/**
 * The hand-set id, unverified. When the Business Center is known, one
 * read-only /bc/pixel/get/ (pages of 20, at most five) looks for the code:
 * listed there, the pixel's owner is named (the BC's name from /bc/get/); a
 * BC that lists the code under another numeric id refuses, as the account's
 * list would. A failed BC read fails soft: the id stays unverified, no owner.
 */
async function handSetPixel(tt: TikTokTransport, token: string, code: string, pixelId: string, bcId: string | null): Promise<PixelResolution> {
  let owner: string | null = null;
  let name: string | null = null;
  if (bcId) {
    let match: Row | undefined;
    for (let page = 1; page <= 5 && !match; page++) {
      const res = await tt.get("/bc/pixel/get/", token, { bc_id: bcId, page, page_size: 20 });
      if (res.code !== 0) break;
      const list = ([res.data?.pixels, res.data?.list, res.data?.pixel_list].find(Array.isArray) ?? []) as Row[];
      match = list.find((r) => text(r.pixel_code) === code);
      const pages = (res.data?.page_info as { total_page?: number } | undefined)?.total_page ?? 1;
      if (page >= pages || list.length < 20) break;
    }
    if (match) {
      const listed = text(match.pixel_id);
      if (PIXEL_ID_SHAPE.test(listed) && listed !== pixelId)
        return { ok: false, code, reason: "pixel_id_differs", message: pixelIdDiffers(code, `Business Center ${bcId} lists`, listed, pixelId) };
      name = text(match.pixel_name ?? match.name) || null;
      const bc = await tt.get("/bc/get/", token, { bc_id: bcId, page: 1, page_size: 50 });
      const info = bc.code === 0 ? ((bc.data?.list ?? []) as Array<{ bc_info?: Row }>).map((b) => b.bc_info ?? {}).find((b) => text(b.bc_id) === bcId) : undefined;
      owner = text(info?.name ?? info?.bc_name) || `Business Center ${bcId}`;
    }
  }
  return { ok: true, code, pixel_id: pixelId, relation: "UNVERIFIED", name, owner, note: pixelUnverifiedNote(pixelId, owner) };
}
