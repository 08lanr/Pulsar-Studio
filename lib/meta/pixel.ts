// The server half of the Meta pixel contract (decision 2026-09-25, "Meta
// conversions"). The pure constants live in `./events` so the settings panel
// can import them; this module reads the environment and talks to Meta, so it
// must never be imported from a client component.
//
// crazydramas.com fires the pixel itself and Studio sends no events and holds
// no Conversions API token — the same split the TikTok pixel has. What Studio
// needs is the pixel's id and the proof that the ad account may optimize
// toward it.
//
// Meta answers `GET act_<id>/adspixels?fields=id,name,is_unavailable` with the
// pixels the ad account may use. A pixel the account cannot see is not in the
// list at all, and `is_unavailable` marks one the account has lost access to;
// either way the person reads one plain sentence naming Business settings.
//
// While Meta refuses that read for want of the permission, the configured id
// stands in, marked UNVERIFIED and said so in plain words — the same fallback
// TikTok's 40001 path takes (decision 2026-09-24). When the list answers, it
// wins: a configured id the list does not carry is refused rather than sent,
// because a promoted_object Meta rejects fails the ad set create after the
// campaign already exists.

import { MetaApiError, metaList, type MetaObject, type MetaTransport } from "./transport";
import { META_PIXEL_ID_SHAPE, CRAZYDRAMAS_META_PIXEL_ID } from "./events";

export * from "./events";

/**
 * META_PIXEL_ID, trimmed; blank means crazydramas.com's pixel. Server-only,
 * not a secret. Throws on a value that is not a pixel id, before anything is
 * read: a typo must not reach a promoted_object.
 */
export function metaPixelId(): string {
  const configured = process.env.META_PIXEL_ID?.trim();
  if (!configured) return CRAZYDRAMAS_META_PIXEL_ID;
  if (!META_PIXEL_ID_SHAPE.test(configured)) throw new Error("META_PIXEL_ID must be a numeric Meta pixel id of 10 to 20 digits.");
  return configured;
}

export type MetaPixelResolution =
  | { ok: true; pixel_id: string; verified: boolean; note: string | null }
  | { ok: false; reason: string };

/**
 * The refusals that mean "this token may not read this account's pixels", as
 * opposed to "this account has no such pixel". Meta answers a missing
 * permission on an edge in two shapes: the OAuth family (10 "permission
 * denied", 200 "permissions error", 272, 3 "unknown method"), and the generic
 * 100 carrying subcode 33, which is what `act_<id>/adspixels` returns when the
 * app has not been granted the pixel. Only these fall back; a bare 100 does
 * not, because that is Meta's everyday "you asked for something wrong" and
 * treating it as a permission problem would launch an unverified pixel on what
 * is really a bug.
 */
function isPermissionRefusal(error: unknown): boolean {
  if (!(error instanceof MetaApiError)) return false;
  if ([10, 200, 272, 3].includes(error.code ?? 0)) return true;
  return error.code === 100 && error.subcode === 33;
}

/**
 * The pixel this ad account may optimize toward, or the sentence saying why it
 * may not. Read-only, and made before any paid object exists.
 */
export async function resolveMetaPixel(transport: MetaTransport, accountId: string): Promise<MetaPixelResolution> {
  const wanted = metaPixelId();
  const account = `act_${accountId.replace(/^act_/, "")}`;
  let rows: MetaObject[];
  try {
    rows = await metaList(transport, `${account}/adspixels`, { fields: "id,name,is_unavailable" });
  } catch (error) {
    // Anything that is not the permission family (a dead token, a disabled
    // account, a network refusal) is the launch's problem to report.
    if (isPermissionRefusal(error))
      return { ok: true, pixel_id: wanted, verified: false, note: `Meta would not list this account's pixels, so pixel ${wanted} is unverified. Grant the app access to the pixel in Business settings, or check the first paused ad set in Ads Manager.` };
    throw error;
  }
  const match = rows.find(row => String(row.id) === wanted);
  if (!match) {
    const names = rows.map(row => String(row.id)).filter(Boolean);
    return { ok: false, reason: names.length
      ? `Pixel ${wanted} is not shared with this ad account. Share it in Business settings, or set META_PIXEL_ID to one of: ${names.join(", ")}.`
      : `This ad account has no pixel. Share pixel ${wanted} with it in Business settings before launching for conversions.` };
  }
  if (match.is_unavailable) return { ok: false, reason: `Pixel ${wanted} is unavailable to this ad account, so its conversions would not be counted. Restore access in Business settings.` };
  return { ok: true, pixel_id: wanted, verified: true, note: null };
}
