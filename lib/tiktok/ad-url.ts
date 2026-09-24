// The one link every TikTok website ad carries (decision 2026-09-23, "TikTok
// launch: crazydramas link contract + pixel + one account"). crazydramas.com
// reads `source`, `campaign`, `adgroup` and `creative` off the landing URL
// (its packages/shared/src/attribution.ts; README "Attribution contract") and
// ignores anything else, `campid` included. TikTok fills the three macros in
// at click time:
//
//   __CAMPAIGN_ID__  the campaign id        (TikTok "URL parameters" macros:
//   __AID__          the ad group id         ad/create doc, utm_params.value,
//   __CID__          the ad (creative) id    https://business-api.tiktok.com/portal/docs?id=1739953377508354;
//                                            ads.tiktok.com/help/article/track-offsite-web-events-with-utm-parameters)
//
// so Studio sends them LITERALLY: never its own ids, never URL-encoded (a
// `%5F%5F` would reach crazydramas as text TikTok never replaced), never with
// `campid` or anything else appended. The string is built by hand for that
// reason; URLSearchParams would be safe for underscores today, but the
// contract is the exact bytes, so nothing re-serialises it.
//
// Upgraded Smart+ campaigns name the ad `__ADID_V2__` and `__CID__` is then
// not the ad id; Studio does not create Smart+ campaigns (docs only).
//
// Pure and client-safe: the Launch screen and the confirm dialog print the
// same string the driver sends.

import { CRAZYDRAMAS_SLUG, isMockSlug } from "@/lib/crazydramas/slug";

export const TIKTOK_CAMPAIGN_ID_MACRO = "__CAMPAIGN_ID__";
export const TIKTOK_ADGROUP_ID_MACRO = "__AID__";
export const TIKTOK_AD_ID_MACRO = "__CID__";

/** Where crazydramas serves a title. */
export const CRAZYDRAMAS_WATCH_BASE = "https://crazydramas.com/watch/";

/** The query crazydramas' attribution contract reads, with TikTok's own macros as the values. */
export const TIKTOK_AD_QUERY = `source=tiktok&campaign=${TIKTOK_CAMPAIGN_ID_MACRO}&adgroup=${TIKTOK_ADGROUP_ID_MACRO}&creative=${TIKTOK_AD_ID_MACRO}`;

/** Why a slug cannot carry an ad, or null when it can. The live check (is the series published?) is the data layer's. */
export function crazydramasSlugProblem(slug: string | null | undefined): "missing" | "mock" | "shape" | null {
  const value = slug?.trim() ?? "";
  if (!value) return "missing";
  if (isMockSlug(value)) return "mock";
  if (!CRAZYDRAMAS_SLUG.test(value) || value.length > 200) return "shape";
  return null;
}

/**
 * `https://crazydramas.com/watch/<slug>?source=tiktok&campaign=__CAMPAIGN_ID__&adgroup=__AID__&creative=__CID__`,
 * exactly. Throws on a missing, `mock-` or malformed slug: a link to a page
 * that is not a real series would spend money on a 404.
 */
export function crazydramasAdUrl(slug: string): string {
  const problem = crazydramasSlugProblem(slug);
  if (problem === "missing") throw new Error("The title has no crazydramas slug.");
  if (problem === "mock") throw new Error(`"${slug}" is a crazydramas design mock, not a real series.`);
  if (problem === "shape") throw new Error(`"${slug}" is not a crazydramas slug (lowercase words joined by hyphens).`);
  return `${CRAZYDRAMAS_WATCH_BASE}${slug.trim()}?${TIKTOK_AD_QUERY}`;
}

/** The slug of a link built by crazydramasAdUrl, or null for any other string (a query that differs by one byte included). */
export function slugOfCrazydramasAdUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(CRAZYDRAMAS_WATCH_BASE)) return null;
  const rest = url.slice(CRAZYDRAMAS_WATCH_BASE.length);
  const q = rest.indexOf("?");
  if (q < 1) return null;
  const slug = rest.slice(0, q);
  if (crazydramasSlugProblem(slug) !== null) return null;
  return rest.slice(q + 1) === TIKTOK_AD_QUERY ? slug : null;
}

export function isCrazydramasAdUrl(url: string | null | undefined): boolean {
  return slugOfCrazydramasAdUrl(url) !== null;
}
