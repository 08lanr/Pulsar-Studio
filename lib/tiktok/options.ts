// The TikTok enums the launch settings choose from — overlord's
// lib/tiktok-options.ts, trimmed to what a Studio launch sends (decision
// 2026-09-16, "launch settings, controls and the monitor"). One table for
// the browser and the server, so the editor can never offer a value the
// engine would remap.
//
// Client-safe: no fs, no TikTok imports.

export type Option = { value: string; label: string };

/** Studio launches are TRAFFIC campaigns to the campaign's destination link (decision 2026-09-09). */
export const OBJECTIVE = "TRAFFIC";

export const AGE_OPTIONS: Option[] = [
  { value: "AGE_13_17", label: "13–17" },
  { value: "AGE_18_24", label: "18–24" },
  { value: "AGE_25_34", label: "25–34" },
  { value: "AGE_35_44", label: "35–44" },
  { value: "AGE_45_54", label: "45–54" },
  { value: "AGE_55_100", label: "55+" },
];

export const GENDER_OPTIONS: Option[] = [
  { value: "GENDER_UNLIMITED", label: "All" },
  { value: "GENDER_MALE", label: "Male" },
  { value: "GENDER_FEMALE", label: "Female" },
];

export const OS_OPTIONS: Option[] = [
  { value: "ANDROID", label: "Android" },
  { value: "IOS", label: "iOS" },
];

/** The handful worth one click; the editor takes any ISO code beside these. */
export const COMMON_LANGUAGES: Option[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "zh", label: "Chinese" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
];

export const PLACEMENT_OPTIONS: Option[] = [
  { value: "tiktok", label: "TikTok only" },
  { value: "automatic", label: "Automatic (TikTok, Pangle, Global App Bundle)" },
];

export const BUDGET_MODE_OPTIONS: Option[] = [
  { value: "BUDGET_MODE_TOTAL", label: "Lifetime (the approved budget, spread over the schedule)" },
  { value: "BUDGET_MODE_DAY", label: "Daily per ad group (the approved budget caps the campaign)" },
];

export const PACING_OPTIONS: Option[] = [
  { value: "PACING_MODE_SMOOTH", label: "Standard — spread evenly" },
  { value: "PACING_MODE_FAST", label: "Accelerated — as fast as possible" },
];

export type GoalOption = Option & { billing: "CPC" | "OCPM"; billingLabel: string };

/**
 * Which optimization goals a TRAFFIC campaign may use, and the billing
 * event each forces (sandbox-verified in overlord). First entry = default.
 * Cost caps live in `bid_price` under CPC and `conversion_bid_price` under
 * oCPM — writing the wrong field is accepted and ignored, so the goal decides.
 */
export const GOAL_OPTIONS: GoalOption[] = [
  { value: "CLICK", label: "Clicks (CPC)", billing: "CPC", billingLabel: "CPC — cost per click" },
  { value: "TRAFFIC_LANDING_PAGE_VIEW", label: "Landing page views (oCPM)", billing: "OCPM", billingLabel: "oCPM — optimized cost per mille" },
  { value: "CONVERT", label: "Instant Page button taps (oCPM)", billing: "OCPM", billingLabel: "oCPM — Instant Page button taps" },
];

export function goalOption(value: string | null | undefined): GoalOption {
  return GOAL_OPTIONS.find((g) => g.value === value) ?? GOAL_OPTIONS[0];
}

export const BID_STRATEGY_OPTIONS: Option[] = [
  { value: "LOWEST_COST", label: "Lowest cost — no cap, maximum delivery" },
  { value: "COST_CAP", label: "Cost cap — a target cost per result" },
];

// The full legal website CTA set, straight from TikTok's own enum rejection
// (probed live 2026-09-07 in overlord). WATCH_NOW leads: the ad sends a
// viewer to a drama.
export const CTA_OPTIONS: Option[] = [
  { value: "WATCH_NOW", label: "Watch Now" },
  { value: "LEARN_MORE", label: "Learn More" },
  { value: "VIEW_NOW", label: "View Now" },
  { value: "READ_MORE", label: "Read More" },
  { value: "EXPERIENCE_NOW", label: "Experience Now" },
  { value: "INTERESTED", label: "Interested" },
  { value: "SIGN_UP", label: "Sign Up" },
  { value: "SUBSCRIBE", label: "Subscribe" },
  { value: "DOWNLOAD_NOW", label: "Download Now" },
  { value: "INSTALL_NOW", label: "Install Now" },
  { value: "PLAY_GAME", label: "Play Game" },
  { value: "SHOP_NOW", label: "Shop Now" },
  { value: "ORDER_NOW", label: "Order Now" },
  { value: "GET_TICKETS_NOW", label: "Get Tickets Now" },
  { value: "GET_SHOWTIMES", label: "Get Showtimes" },
  { value: "WATCH_LIVE", label: "Watch Live" },
  { value: "LISTEN_NOW", label: "Listen Now" },
  { value: "PREORDER_NOW", label: "Preorder Now" },
  { value: "VIEW_PROFILE", label: "View Profile" },
  { value: "VISIT_STORE", label: "Visit Store" },
  { value: "CHECK_AVAILABILITY", label: "Check Availability" },
  { value: "APPLY_NOW", label: "Apply Now" },
  { value: "BOOK_NOW", label: "Book Now" },
  { value: "CALL_NOW", label: "Call Now" },
  { value: "CONTACT_US", label: "Contact Us" },
  { value: "GET_QUOTE", label: "Get Quote" },
  { value: "SEND_MESSAGE", label: "Send Message" },
];

/** TikTok rejects ad group budgets below this (USD, daily or lifetime). */
export const MIN_ADGROUP_BUDGET_USD = 20;
/** TikTok rejects a campaign-level budget below this (USD). */
export const MIN_CAMPAIGN_BUDGET_USD = 50;
/** TikTok rejects more than this many duplications of an ad group at once. */
export const MAX_DUPLICATE_COPIES = 19;
/** The ad group runs the budget over at most this many days. */
export const MAX_DURATION_DAYS = 30;
/** United States. */
export const DEFAULT_LOCATION_IDS = ["6252001"];
