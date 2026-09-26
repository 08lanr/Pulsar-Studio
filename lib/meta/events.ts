// The pure half of the Meta pixel contract (decision 2026-09-25, "Meta
// conversions"): the pixel id, the events an ad set may optimize toward, what
// Meta calls those events when it reports them back, and the attribution
// window. No transport, no process.env, so the settings panel and the preview
// can import it into the browser bundle; `lib/meta/pixel.ts` holds the parts
// that read the server's environment or talk to Meta.
//
// The two spellings are the trap here, and they are Meta's, not ours:
//
//   what crazydramas fires   InitiateCheckout        ViewContent
//   what the AD SET takes    INITIATED_CHECKOUT      CONTENT_VIEW
//   what INSIGHTS reports    offsite_conversion      offsite_conversion
//                             .fb_pixel_initiate      .fb_pixel_view
//                             _checkout               _content
//
// `promoted_object.custom_event_type` takes the middle column and nothing else
// (Marketing API reference, ad-promoted-object): INITIATE_CHECKOUT and
// VIEW_CONTENT are refused with code 100. META_ACTION_TYPES below is keyed by
// the ad set's spelling and valued by insights', so a reader never has to know
// which one it is holding.

/** The pixel crazydramas.com loads. Public by nature: every page view ships it. */
export const CRAZYDRAMAS_META_PIXEL_ID = "2634408510362983";

/** Meta's pixel id shape: a numeric id, 10 to 20 digits. */
export const META_PIXEL_ID_SHAPE = /^\d{10,20}$/;

/**
 * The standard events crazydramas.com fires that an ad set may optimize
 * toward, spelled the way `promoted_object.custom_event_type` takes them.
 */
export const META_CONVERSION_EVENTS = ["PURCHASE", "INITIATED_CHECKOUT", "ADD_TO_CART", "CONTENT_VIEW", "COMPLETE_REGISTRATION"] as const;
export type MetaConversionEvent = (typeof META_CONVERSION_EVENTS)[number];

/**
 * The event a new conversions draft starts on. NOT Purchase: crazydramas.com's
 * pixel fired 2 purchases in the 28 days to 2026-09-25, far under the ~50 a
 * week Meta's optimizer needs to leave the learning phase, so a Purchase ad set
 * would spend the budget without ever learning. Checkout started is the
 * densest event on the way to a sale.
 */
export const DEFAULT_META_CONVERSION_EVENT: MetaConversionEvent = "INITIATED_CHECKOUT";

/**
 * What Meta's insights call each event: `actions[].action_type`. Keyed by the
 * ad set's spelling, so the monitor reads back exactly what the run optimizes
 * toward without a second mapping to get wrong.
 */
export const META_ACTION_TYPES: Record<MetaConversionEvent, string> = {
  PURCHASE: "offsite_conversion.fb_pixel_purchase",
  INITIATED_CHECKOUT: "offsite_conversion.fb_pixel_initiate_checkout",
  ADD_TO_CART: "offsite_conversion.fb_pixel_add_to_cart",
  CONTENT_VIEW: "offsite_conversion.fb_pixel_view_content",
  COMPLETE_REGISTRATION: "offsite_conversion.fb_pixel_complete_registration",
};

/**
 * Meta's 7-day click / 1-day view attribution, sent explicitly on every
 * conversions ad set so a change to the account default never silently moves
 * what the Monitor is counting. The same window TikTok's launches send.
 */
export const META_ATTRIBUTION_SPEC = [
  { event_type: "CLICK_THROUGH", window_days: 7 },
  { event_type: "VIEW_THROUGH", window_days: 1 },
] as const;

/**
 * The same window in words, for anywhere the chrome is English. One source, so
 * the label can never disagree with the spec. Producer-facing Chinese uses the
 * `lmx.attribution` locale key instead.
 */
export const META_ATTRIBUTION_LABEL = `${META_ATTRIBUTION_SPEC[0].window_days}-day click, ${META_ATTRIBUTION_SPEC[1].window_days}-day view`;
