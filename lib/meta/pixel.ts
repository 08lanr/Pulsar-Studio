// The Meta pixel a conversions launch optimizes toward. The shape follows
// lib/tiktok/pixel.ts and the decision it records ("TikTok link, pixel and one
// account", 2026-09-23): crazydramas.com fires the pixel itself, Studio sends
// no events and holds no Conversions API token. What Studio needs is the
// pixel's id and the proof that the ad account may optimize toward it.
//
//   the id  2634408510362983, what crazydramas.com loads. Public by nature:
//           every page view ships it. Server setting META_PIXEL_ID; blank
//           means this default.
//
// Meta answers `GET act_<id>/adspixels?fields=id,name,is_unavailable` with the
// pixels the ad account may use. A pixel the account cannot see is not in the
// list at all, and `is_unavailable` marks one the account has lost access to;
// either way the person reads one plain sentence naming Business settings.
//
// While Meta refuses that read for want of the permission (codes 10, 200 and
// 272 are the permission family), the configured id stands in, marked
// UNVERIFIED and said so in plain words — the same fallback TikTok's 40001
// path takes (decision 2026-09-24, "TikTok pixel ID set by hand"). When the
// list answers, it wins: a configured id the list does not carry is refused
// rather than sent, because a promoted_object Meta rejects fails the ad set
// create after the campaign already exists.
//
// Every call goes through the transport lib/meta/index.ts picks: the fake in
// fixture mode, Meta otherwise.

import { MetaApiError, metaList, type MetaObject, type MetaTransport } from "./transport";

/** The pixel crazydramas.com loads. Public by nature: every page view ships it. */
export const CRAZYDRAMAS_META_PIXEL_ID = "2634408510362983";

/** Meta's pixel id shape: a numeric id, 10 to 20 digits. */
export const META_PIXEL_ID_SHAPE = /^\d{10,20}$/;

/**
 * The standard events crazydramas.com fires that an ad set may optimize
 * toward. `custom_event_type` on the ad set's promoted_object takes exactly
 * these strings.
 */
export const META_CONVERSION_EVENTS = ["PURCHASE", "INITIATE_CHECKOUT", "ADD_TO_CART", "VIEW_CONTENT", "COMPLETE_REGISTRATION"] as const;
export type MetaConversionEvent = (typeof META_CONVERSION_EVENTS)[number];

/**
 * The event a new conversions draft starts on. NOT Purchase: crazydramas.com's
 * pixel fired 2 purchases in the 28 days to 2026-09-25, far under the ~50 a
 * week Meta's optimizer needs to leave the learning phase, so a Purchase ad set
 * would spend the budget without ever learning. InitiateCheckout is the
 * densest event on the way to a sale.
 */
export const DEFAULT_META_CONVERSION_EVENT: MetaConversionEvent = "INITIATE_CHECKOUT";

/**
 * What Meta's insights call an ad set's conversions of each event. The reading
 * side of the same contract: `actions[].action_type` carries these strings.
 */
export const META_ACTION_TYPES: Record<MetaConversionEvent, string> = {
  PURCHASE: "offsite_conversion.fb_pixel_purchase",
  INITIATE_CHECKOUT: "offsite_conversion.fb_pixel_initiate_checkout",
  ADD_TO_CART: "offsite_conversion.fb_pixel_add_to_cart",
  VIEW_CONTENT: "offsite_conversion.fb_pixel_view_content",
  COMPLETE_REGISTRATION: "offsite_conversion.fb_pixel_complete_registration",
};

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

/**
 * Meta's 7-day click / 1-day view attribution, sent explicitly on every
 * conversions ad set so a change to the account default never silently moves
 * what the Monitor is counting. The same window TikTok's launches send.
 */
export const META_ATTRIBUTION_SPEC = [
  { event_type: "CLICK_THROUGH", window_days: 7 },
  { event_type: "VIEW_THROUGH", window_days: 1 },
] as const;

/** The same window in words, for the preview and the Monitor. One source, so the label can never disagree with the spec. */
export const META_ATTRIBUTION_LABEL = `${META_ATTRIBUTION_SPEC[0].window_days}-day click, ${META_ATTRIBUTION_SPEC[1].window_days}-day view`;

export type MetaPixelResolution =
  | { ok: true; pixel_id: string; verified: boolean; note: string | null }
  | { ok: false; reason: string };

/** Meta's permission family: the account may not read pixels with this token. */
const PERMISSION_CODES = new Set([10, 200, 272, 3]);

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
    // Only the permission family falls back. Anything else (a dead token, a
    // disabled account, a network refusal) is the launch's problem to report.
    if (error instanceof MetaApiError && PERMISSION_CODES.has(error.code ?? 0))
      return { ok: true, pixel_id: wanted, verified: false, note: `Meta would not list this account's pixels, so pixel ${wanted} is unverified. Grant ads_management on the pixel in Business settings, or check the first paused ad set in Ads Manager.` };
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
