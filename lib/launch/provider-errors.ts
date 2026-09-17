// What the monitor says instead of a code (docs/launch-ux-round-2.md §1.7, §1.8).
//
// Two pure derivations live here, and nothing else: the plain-language hint for
// a provider refusal, and the plain-language state of one campaign. Both are
// imported by the monitor (a client component) as well as by the server, so
// this module must stay free of `@/lib/data`, node built-ins and provider
// transports. `lib/launch/service.ts` re-exports `monitorState` so the
// derivation is part of the launch service's surface.
//
// Every hint is a LOCALE KEY, never an English sentence: the monitor renders it
// through `tt()` so a producer reads it in Chinese (CLAUDE.md, "UI and
// localization"). The provider's own sentence is shown beneath the hint exactly
// as the transport produced it.

import type { DeliveryState, LaunchCampaign, LaunchDraft, LaunchProvider } from "./types";

export type ProviderErrorExplanation = { hint: string | null; code?: string };

/**
 * `Meta rejected the request (HTTP 400, code 100/1885183): <sentence>` is the
 * shape `lib/meta/transport.ts` emits. Returns "100/1885183", "100", or
 * undefined when the message carries no code at all.
 */
export function providerErrorCode(message: string): string | undefined {
  const found = /\(HTTP\s+\d{3}(?:,\s*code\s+(\d+)(?:\/(\d+))?)?\)/i.exec(message || "");
  if (!found?.[1]) return undefined;
  return found[2] ? `${found[1]}/${found[2]}` : found[1];
}

// Codes Ruobin has actually hit, plus the families Meta documents around them.
// An unknown code deliberately has no hint: a guessed next step is worse than
// the provider's own words.
const META_HINTS: Record<string, string> = {
  "100/1885183": "mr2.hint.meta.devMode",
  "10": "mr2.hint.meta.appPermission",
  "190": "mr2.hint.meta.token",
  "368": "mr2.hint.meta.policyBlock",
  "100/1487194": "mr2.hint.meta.funding",
  "100/1487742": "mr2.hint.meta.spendLimit",
  "100/1487390": "mr2.hint.meta.accountDisabled",
};
/** Meta's 1487xxx subcodes are all "this ad account will not run right now". */
const META_AD_ACCOUNT_FAMILY = "mr2.hint.meta.adAccount";
/** Rate limits and transient refusals: waiting is the whole next step. */
const META_TRANSIENT = new Set(["1", "2", "4", "17", "32", "613"]);

export function explainProviderError(provider: LaunchProvider, message: string): ProviderErrorExplanation {
  const code = providerErrorCode(message);
  if (provider !== "meta" || !code) return { hint: null, ...(code ? { code } : {}) };
  const exact = META_HINTS[code];
  if (exact) return { hint: exact, code };
  const [primary, subcode] = code.split("/");
  if (subcode?.startsWith("1487")) return { hint: META_AD_ACCOUNT_FAMILY, code };
  if (META_HINTS[primary]) return { hint: META_HINTS[primary], code };
  if (META_TRANSIENT.has(primary)) return { hint: "mr2.hint.meta.transient", code };
  return { hint: null, code };
}

// ---- the plain-language state of one campaign -------------------------------

/**
 * The monitor's state words. `not_checked` and `created_paused` are Studio's
 * own: they replace the two placeholders Ruobin read as noise ("Checking",
 * "Switch unknown"). Everything else is the sweep's `DeliveryState`.
 */
export type MonitorState = DeliveryState | "not_checked" | "created_paused" | "waiting";

/** ENABLE/ACTIVE = on, DISABLE/PAUSED/ARCHIVED/DELETED = off, anything else = not read yet. */
export function switchState(value?: string | null): boolean | null {
  const status = value?.toUpperCase();
  if (status === "ENABLE" || status === "ACTIVE") return true;
  if (["DISABLE", "PAUSED", "ARCHIVED", "DELETED"].includes(status ?? "")) return false;
  return null;
}

/**
 * The provider campaign id, wherever that provider's driver keeps it: TikTok
 * writes a flat `campaign_id`, Meta nests its whole state under `meta`.
 */
export function providerCampaignId(campaign: Pick<LaunchCampaign, "state">): string | null {
  const flat = campaign.state.campaign_id;
  if (typeof flat === "string" && flat) return flat;
  const meta = campaign.state.meta as { campaign_id?: unknown } | undefined;
  return typeof meta?.campaign_id === "string" && meta.campaign_id ? meta.campaign_id : null;
}

/**
 * One campaign's state as a person would say it.
 *
 * - No snapshot at all: the sweep has never run for this campaign — **not
 *   checked yet**, and the monitor starts a sweep rather than printing a word
 *   that sounds like a verdict.
 * - Objects exist but the campaign's switch could not be read: every provider
 *   creates a launch paused, so **created paused** is what actually happened,
 *   and the On/Off pill stays disabled until a read settles it.
 * - Otherwise the sweep's own delivery word, with `unknown` folded back into
 *   "not checked yet" (it only ever meant "this sweep told us nothing").
 */
export function monitorState(campaign: Pick<LaunchCampaign, "status" | "state" | "snapshot">): MonitorState {
  // An operator's End wins over everything the sweep last wrote: a campaign
  // that failed to launch and was then ended is ended, not "failed to launch".
  if (campaign.state.stop_applied === "ended" || campaign.state.desired_status === "ended") return "ended";
  // A provider asked us to come back (Meta still transcoding a clip): the
  // row keeps its checkpoints and the worker returns by itself.
  if (campaign.status === "pending" && campaign.state.waiting) return "waiting";
  if (campaign.status === "failed" && !campaign.snapshot) return "failed";
  const snapshot = campaign.snapshot;
  if (!snapshot) return "not_checked";
  if (["failed", "rejected", "suspended", "ended"].includes(snapshot.delivery)) return snapshot.delivery;
  // A launch that failed before the provider held anything: a sweep can only
  // say "unknown" about an object that does not exist, and that is the failure
  // itself, not a check that has not happened yet.
  if (campaign.status === "failed" && !providerCampaignId(campaign)) return "failed";
  if (providerCampaignId(campaign) && switchState(snapshot.configured_status) === null) return "created_paused";
  return snapshot.delivery === "unknown" ? "not_checked" : snapshot.delivery;
}

/** True once a sweep has read this campaign's own on/off switch. */
export function switchIsKnown(campaign: Pick<LaunchCampaign, "status" | "state" | "snapshot">): boolean {
  return switchState(campaign.snapshot?.configured_status) !== null;
}

/** A launch nobody has swept yet; the monitor sweeps it once on mount. */
export function needsFirstSweep(campaigns: Pick<LaunchCampaign, "status" | "state" | "snapshot">[]): boolean {
  return campaigns.some(c => monitorState(c) === "not_checked");
}

// ---- which platforms a campaign's ad sets run on -----------------------------

export type AdPlatform = "facebook" | "instagram";

/**
 * Which platforms a campaign's ad sets run on, in order of authority: the
 * approved ad-set plan, then the ad set ids the driver recorded per platform,
 * then the content model itself (a Facebook post is a Facebook ad, an Instagram
 * post is an Instagram ad, an uploaded clip runs on the draft's placements —
 * docs/launch-ux-round-2.md §1.1). The last step is what carries campaigns
 * approved before the plan grew ad sets.
 */
export function campaignPlatforms(draft: LaunchDraft, campaign: Pick<LaunchCampaign, "content" | "state"> & { ad_sets?: { platform: AdPlatform }[] }): AdPlatform[] {
  if (draft.provider !== "meta") return [];
  const order: AdPlatform[] = ["facebook", "instagram"];
  const planned = order.filter(platform => campaign.ad_sets?.some(set => set.platform === platform));
  if (planned.length) return planned;
  const recorded = adSetPlatforms(campaign);
  const fromState = order.filter(platform => Object.values(recorded).includes(platform));
  if (fromState.length) return fromState;
  const found = new Set<AdPlatform>();
  for (const item of campaign.content) {
    if (item.kind === "facebook_post") found.add("facebook");
    else if (item.kind === "instagram_post") found.add("instagram");
    else if (item.kind === "video") for (const placement of draft.meta_settings.placements) found.add(placement);
  }
  return order.filter(platform => found.has(platform));
}

/** Ad set id → platform, from the driver's own record; empty before that field exists. */
export function adSetPlatforms(campaign: Pick<LaunchCampaign, "state">): Record<string, AdPlatform> {
  const meta = campaign.state.meta as { adset_ids?: Record<string, unknown>; adset_id?: unknown } | undefined;
  const out: Record<string, AdPlatform> = {};
  for (const [platform, id] of Object.entries(meta?.adset_ids ?? {})) {
    if ((platform === "facebook" || platform === "instagram") && typeof id === "string" && id) out[id] = platform;
  }
  return out;
}
