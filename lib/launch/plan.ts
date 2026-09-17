import { z } from "zod";
import { defaultLaunchSettings, defaultSalesLaunchSettings, launchSettingsSchema, validateLaunchSettings } from "@/lib/tiktok/settings";
import type { LaunchConnection, LaunchDraft, LaunchPlan, LaunchProvider } from "./types";

const cents = z.number().int().min(1).max(100_000_000);
export const contentSchema = z.object({
  kind: z.enum(["spark", "facebook_post", "instagram_post", "video"]),
  value: z.string().trim().min(1).max(2000), label: z.string().max(200).optional(),
  text: z.string().max(2200).optional(), headline: z.string().max(200).optional(),
}); // File paths, hashes and ownership are resolved from the data layer, never from the client.
export const draftSchema = z.object({
  provider: z.enum(["tiktok", "meta"]), name: z.string().trim().min(1).max(80),
  account_ids: z.array(z.string().min(1).max(150)).max(50),
  campaigns_per_account: z.number().int().min(1).max(50), content_per_campaign: z.number().int().min(1).max(50),
  allocation: z.enum(["unique", "shared"]), content: z.array(contentSchema).max(500),
  destination_url: z.string().trim().max(2000), total_budget_cents: cents,
  daily_budget_cents: cents.nullable(), start_paused: z.boolean(), tiktok_settings: launchSettingsSchema,
  meta_settings: z.object({
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(50),
    placements: z.array(z.enum(["facebook", "instagram"])).min(1).max(2),
    optimization_goal: z.enum(["LINK_CLICKS", "LANDING_PAGE_VIEWS"]),
    bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP"]),
    bid_cents: cents.nullable(), call_to_action: z.enum(["LEARN_MORE", "WATCH_MORE"]),
    start_time: z.string().datetime({ offset: true }), end_time: z.string().datetime({ offset: true }),
  }),
});

export function defaultLaunchDraft(provider: LaunchProvider = "tiktok"): LaunchDraft {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 86400000);
  return { provider, name: "Launch", account_ids: [], campaigns_per_account: 1, content_per_campaign: provider === "tiktok" ? 5 : 1,
    allocation: "unique", content: [], destination_url: "", total_budget_cents: 50000,
    daily_budget_cents: provider === "tiktok" ? 2000 : null, start_paused: true, tiktok_settings: { ...(provider === "tiktok" ? defaultSalesLaunchSettings() : defaultLaunchSettings()), start_paused: true },
    meta_settings: { countries: ["US"], placements: ["facebook"], optimization_goal: "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cents: null, call_to_action: "LEARN_MORE",
      start_time: start.toISOString(), end_time: end.toISOString() } };
}

/** Whole-cent allocation is stable, and sums exactly to the signed total. */
export function splitBudget(total: number, count: number): number[] {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isInteger(count) || count < 1 || total < count) throw new Error("Invalid budget allocation.");
  const base = Math.floor(total / count), remainder = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

export function parseContentList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean))];
}

/** The saved run owns this ID, so preview, approval and retries use one campaign name. */
export function campidForRun(externalId: string, index: number, launchName: string): string {
  if (!/^lr_[0-9a-f]{12}$/.test(externalId) || !Number.isInteger(index) || index < 1 || index > 100)
    throw new Error("Invalid saved launch campaign identifier.");
  const slug = launchName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24).replace(/-$/, "") || "launch";
  return `${slug}-${externalId.slice(3)}-${String(index).padStart(3, "0")}`;
}

export function trackingUrlForCampaign(destination: string, campid: string): string {
  const url = new URL(destination);
  url.searchParams.set("campid", campid);
  return url.toString();
}

export function buildLaunchPlan(input: LaunchDraft, connections: LaunchConnection[], savedRunExternalId?: string): LaunchPlan {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const d = parsed.data;
  if (!d.account_ids.length) throw new Error("Select at least one assigned advertising account.");
  if (new Set(d.account_ids).size !== d.account_ids.length) throw new Error("Select each account only once.");
  let destination: URL;
  try { destination = new URL(d.destination_url); } catch { throw new Error("Enter a complete destination URL."); }
  if (!["https:", "http:"].includes(destination.protocol) || destination.username || destination.password) throw new Error("Destination must be an HTTP(S) URL without credentials.");
  const chosen = d.account_ids.map(id => {
    const a = connections.find(c => c.id === id && c.provider === d.provider && c.enabled && c.assigned_by);
    if (!a) throw new Error("An account is unassigned, unavailable or belongs to a different platform.");
    if (a.currency !== "USD") throw new Error("This release supports USD advertising accounts.");
    if (d.provider === "meta" && (!a.page_id || (d.meta_settings.placements.includes("instagram") && !a.instagram_id))) throw new Error("Assign a Facebook Page and the Instagram identity required by these placements.");
    return a;
  });
  const count = chosen.length * d.campaigns_per_account;
  if (new Set(chosen.map(a => a.advertiser_id.replace(/^act_/, ""))).size !== chosen.length) throw new Error("The same advertising account was assigned more than once. Select one assignment per account.");
  if (count > 100) throw new Error("A launch may contain up to 100 campaigns.");
  const needed = d.allocation === "shared" ? d.content_per_campaign : count * d.content_per_campaign;
  if (d.content.length !== needed) throw new Error(`Need exactly ${needed} content entries; ${d.content.length} provided.`);
  if (new Set(d.content.map(c => `${c.kind}:${c.value}`)).size !== d.content.length) throw new Error("Remove duplicate content entries. Use shared allocation to reuse content.");
  for (const c of d.content) {
    if ((d.provider === "tiktok") !== (c.kind === "spark")) throw new Error("TikTok takes Spark codes; Meta takes posts or finished clips.");
    if (c.kind === "facebook_post" && !/^\d+_\d+$/.test(c.value)) throw new Error("Facebook post reference must be pageID_postID.");
    if (c.kind === "instagram_post" && !/^\d+$/.test(c.value)) throw new Error("Instagram post reference must be a media ID.");
    if (c.kind === "instagram_post" && chosen.some(a => !a.instagram_id)) throw new Error("Assign an Instagram identity before using Instagram posts.");
  }
  const shares = splitBudget(d.total_budget_cents, count);
  if (d.provider === "meta") {
    const s = d.meta_settings, start = Date.parse(s.start_time), end = Date.parse(s.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Meta needs a valid start and end time.");
    if (s.bid_strategy === "LOWEST_COST_WITH_BID_CAP" && !s.bid_cents) throw new Error("Set the Meta bid cap.");
    if (shares.some(b => b < 100)) throw new Error("Each Meta campaign needs at least $1 of allocated budget; account-specific minimums are checked by Meta.");
  } else {
    for (const share of shares) {
      const groups = d.tiktok_settings.duplicate_copies + 1;
      if (d.daily_budget_cents !== null && Math.floor(d.daily_budget_cents / groups) < 2000) throw new Error("TikTok's daily minimum is $20 per ad group, including planned copies.");
      const s = { ...d.tiktok_settings, start_paused: d.start_paused,
        budget_mode: d.daily_budget_cents === null ? "BUDGET_MODE_TOTAL" : "BUDGET_MODE_DAY",
        daily_budget_usd: d.daily_budget_cents === null ? null : Math.floor(d.daily_budget_cents / groups) / 100 };
      validateLaunchSettings(s, share / 100);
    }
  }
  const rows = chosen.flatMap(connection => Array.from({ length: d.campaigns_per_account }, () => connection)).map((connection, index) => ({
    index: index + 1, connection_id: connection.id, advertiser_id: connection.advertiser_id,
    name: savedRunExternalId ? campidForRun(savedRunExternalId, index + 1, d.name) : `${d.name}-${index + 1}`,
    ...(savedRunExternalId ? {
      campid: campidForRun(savedRunExternalId, index + 1, d.name),
      tracking_url: trackingUrlForCampaign(d.destination_url, campidForRun(savedRunExternalId, index + 1, d.name)),
    } : {}),
    content: structuredClone(d.allocation === "shared" ? input.content : input.content.slice(index * d.content_per_campaign, (index + 1) * d.content_per_campaign)),
    budget_cents: shares[index], daily_budget_cents: d.daily_budget_cents,
  }));
  return { rows, total_budget_cents: d.total_budget_cents, daily_total_cents: d.daily_budget_cents === null ? null : count * d.daily_budget_cents,
    campaign_count: count, account_count: chosen.length, content_count: d.content.length,
    warnings: d.provider === "tiktok" && d.tiktok_settings.duplicate_copies > 0 ? ["The approved budget includes all planned ad group copies."] : [] };
}
