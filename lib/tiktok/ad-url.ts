// The one link every TikTok website ad carries (decision 2026-09-23, "TikTok
// launch: crazydramas link contract + pixel + one account"). crazydramas.com
// reads `source`, `campaign`, `adgroup` and `creative` off the landing URL
// (its packages/shared/src/attribution.ts; README "Attribution contract") and,
// since 2026-10-12 (decision "Acquisition routes A/B/C"), `route`; it ignores
// anything else, `campid` included. TikTok fills the three macros in at click
// time:
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
// A launch's acquisition route (launch setting `acquisition_route`, decision
// 2026-10-12 "Acquisition routes A/B/C") changes the bytes in exactly three
// ways, and `none` (the default) changes nothing:
//
//   store   (A) App install ad: the App Link becomes
//           .../watch/<slug>?source=tiktok&route=store (no macros: TikTok fills
//           none in a deep link)
//   lander  (B) website ad to the landing page: https://crazydramas.com/try/<slug>?
//           then the same four parameters, macros literal
//   web     (C) website ad to the player: today's link + `&route=web`
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
/** crazydramas' landing page for a title: the series and a "Get the app" button to Google Play (route B). */
export const CRAZYDRAMAS_TRY_BASE = "https://crazydramas.com/try/";

/**
 * The three ways into the Android app a launch can be compared on (decision 2026-10-12, "Acquisition routes A/B/C"),
 * plus `none`, every launch before them: A `store` (App install ad → Google Play), B `lander` (website ad →
 * crazydramas.com/try/<slug> → Google Play), C `web` (website ad → the web player, which hands off to the app).
 */
export const ACQUISITION_ROUTES = ["none", "store", "lander", "web"] as const;
export type AcquisitionRoute = (typeof ACQUISITION_ROUTES)[number];
/** The routes the stats compare, in their letters' order (A, B, C). */
export const COMPARED_ROUTES = ["store", "lander", "web"] as const;
export type ComparedRoute = (typeof COMPARED_ROUTES)[number];
/** What C (`web`) appends to today's link: crazydramas reads `route` beside the four parameters. */
export const WEB_ROUTE_SUFFIX = "&route=web";

/** The query crazydramas' attribution contract reads, with TikTok's own macros as the values. */
export const TIKTOK_AD_QUERY = `source=tiktok&campaign=${TIKTOK_CAMPAIGN_ID_MACRO}&adgroup=${TIKTOK_ADGROUP_ID_MACRO}&creative=${TIKTOK_AD_ID_MACRO}`;

/**
 * Meta's half of the same contract (2026-09-25). crazydramas reads `source`
 * as a free string and stores it verbatim as acquisition_sessions.platform
 * (its apps/web/app/api/session/route.ts, packages/shared/src/attribution.ts
 * parseAttribution: no enum, no allow-list), so `source=meta` needs nothing
 * on its side and is what makes a Meta click stop counting as organic.
 *
 * Deliberately NO macros. Meta's own are {{campaign.id}} / {{adset.id}} /
 * {{ad.id}} and they belong in the ad's `url_tags`, which Studio does not
 * send and which Meta documents for page-post ads — unconfirmed for the
 * creatives Studio builds (decision 2026-09-23). An unsubstituted macro is
 * not dropped by crazydramas: `read()` accepts any non-empty string, so it
 * would be INSERTed as a literal id and poison the attribution table. The
 * campaign is instead named by Studio's own campid, added per campaign by
 * trackingUrlForCampaign, which is a value we can join on.
 */
export const META_AD_QUERY = "source=meta";

/** The crazydramas query each provider's ads carry. */
export const CRAZYDRAMAS_AD_QUERY: Record<"tiktok" | "meta", string> = { tiktok: TIKTOK_AD_QUERY, meta: META_AD_QUERY };

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
  return crazydramasAdUrlFor(slug, "tiktok");
}

/** The same link for either platform. TikTok's bytes are the frozen constant above. */
export function crazydramasAdUrlFor(slug: string, provider: "tiktok" | "meta"): string {
  const problem = crazydramasSlugProblem(slug);
  if (problem === "missing") throw new Error("The title has no crazydramas slug.");
  if (problem === "mock") throw new Error(`"${slug}" is a crazydramas design mock, not a real series.`);
  if (problem === "shape") throw new Error(`"${slug}" is not a crazydramas slug (lowercase words joined by hyphens).`);
  return `${CRAZYDRAMAS_WATCH_BASE}${slug.trim()}?${CRAZYDRAMAS_AD_QUERY[provider]}`;
}

/**
 * The deep link a TikTok App install ad carries for its title (decision 2026-10-10, "App install ads open the app on
 * the ad's series"): the series' crazydramas App Link. An installed app opens its player on it at once (Android
 * verifies crazydramas.com/watch for the app); after an install TikTok hands it to AppsFlyer, which hands it to the
 * app on the first launch (crazydramas docs/WEB_TO_APP.md, `deferredTarget`). No ad macros: TikTok fills none in a
 * deep link. On route A (`store`, decision 2026-10-12) it also says `route=store`.
 */
export function crazydramasAppLink(slug: string, route?: AcquisitionRoute | null): string {
  const problem = crazydramasSlugProblem(slug);
  if (problem) throw new Error(`"${slug}" cannot carry an app link (${problem}).`);
  return `${CRAZYDRAMAS_WATCH_BASE}${slug.trim()}?source=tiktok${route === "store" ? "&route=store" : ""}`;
}

/** The slug of an App Link built by crazydramasAppLink (either form), or null for any other string. */
export function slugOfCrazydramasAppLink(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(CRAZYDRAMAS_WATCH_BASE)) return null;
  const rest = url.slice(CRAZYDRAMAS_WATCH_BASE.length);
  const q = rest.indexOf("?");
  if (q < 1) return null;
  const slug = rest.slice(0, q);
  const query = rest.slice(q + 1);
  return crazydramasSlugProblem(slug) === null && (query === "source=tiktok" || query === "source=tiktok&route=store") ? slug : null;
}

/**
 * The link a TikTok website ad carries for a title on an acquisition route (decision 2026-10-12): `none` is
 * crazydramasAdUrl byte for byte; `web` appends `&route=web`; `lander` is the landing page with the same four
 * parameters. Built by hand like crazydramasAdUrlFor, the macros never encoded. `store` has no website link (an App
 * install ad carries crazydramasAppLink), so it throws.
 */
export function crazydramasRouteAdUrl(slug: string, route: AcquisitionRoute | null | undefined): string {
  const r = route ?? "none";
  if (r === "store") throw new Error("An App install ad (route A) carries no website link; it carries the app link.");
  const watch = crazydramasAdUrl(slug);
  if (r === "web") return `${watch}${WEB_ROUTE_SUFFIX}`;
  if (r === "lander") return `${CRAZYDRAMAS_TRY_BASE}${slug.trim()}?${TIKTOK_AD_QUERY}`;
  return watch;
}

/**
 * The tag every App install campaign and ad group name ends with (decision 2026-10-12): `[cd:<slug>]`. TikTok gives
 * no deep link to an app installed from an ad until the ad account is allowlisted for deferred deep links, but
 * AppsFlyer's conversion data carries the campaign and ad group names, so the app reads the series from this tag.
 */
export function crazydramasNameTag(slug: string): string {
  return `[cd:${slug.trim()}]`;
}

/**
 * Studio's longest TikTok object name. TikTok allows 512 characters (campaign_name / adgroup_name; a CJK character
 * counts two); Studio has always cut its names at 100, and finding an object again by its name relies on that.
 */
export const TIKTOK_NAME_MAX = 100;
/** TikTok's own limit on a campaign or ad group name (/campaign/create/, /adgroup/create/: "Length limit: 512 characters"). */
export const TIKTOK_NAME_LIMIT = 512;

/** `name` then ` <tag>`, within `max`: the human part is trimmed, never the tag (nor the space before it). */
export function withNameTag(name: string, tag: string | null | undefined, max = TIKTOK_NAME_MAX): string {
  if (!tag) return name.slice(0, max);
  const room = max - tag.length - 1;
  if (room < 1) throw new Error(`The name tag ${tag} leaves no room for a name within ${max} characters.`);
  return `${name.slice(0, room)} ${tag}`;
}

/** The slug of a link built by crazydramasAdUrl or crazydramasRouteAdUrl, or null for any other string (a query that differs by one byte included). */
export function slugOfCrazydramasAdUrl(url: string | null | undefined): string | null {
  return crazydramasAdUrlParts(url)?.slug ?? null;
}

/**
 * The slug and the platform a crazydramas ad link was built for, and its
 * acquisition route when it has one (`web`, `lander`; absent on today's
 * link), or null for any other string. A query that differs by one byte is
 * not one of ours: the contract is the exact bytes, so a TikTok link is never
 * read as a Meta one.
 */
export function crazydramasAdUrlParts(url: string | null | undefined): { slug: string; provider: "tiktok" | "meta"; route?: "web" | "lander" } | null {
  if (!url) return null;
  const lander = url.startsWith(CRAZYDRAMAS_TRY_BASE);
  if (!lander && !url.startsWith(CRAZYDRAMAS_WATCH_BASE)) return null;
  const rest = url.slice((lander ? CRAZYDRAMAS_TRY_BASE : CRAZYDRAMAS_WATCH_BASE).length);
  const q = rest.indexOf("?");
  if (q < 1) return null;
  const slug = rest.slice(0, q);
  if (crazydramasSlugProblem(slug) !== null) return null;
  const query = rest.slice(q + 1);
  // The landing page and C's suffix are TikTok's alone (Meta is outside the routes this round).
  if (lander) return query === TIKTOK_AD_QUERY ? { slug, provider: "tiktok", route: "lander" } : null;
  if (query === `${TIKTOK_AD_QUERY}${WEB_ROUTE_SUFFIX}`) return { slug, provider: "tiktok", route: "web" };
  for (const provider of ["tiktok", "meta"] as const) if (query === CRAZYDRAMAS_AD_QUERY[provider]) return { slug, provider };
  return null;
}

export function isCrazydramasAdUrl(url: string | null | undefined, provider?: "tiktok" | "meta"): boolean {
  const parts = crazydramasAdUrlParts(url);
  return parts !== null && (!provider || parts.provider === provider);
}
