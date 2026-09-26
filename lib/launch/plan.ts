import { z } from "zod";
import { defaultLaunchSettings, defaultTikTokLaunchSettings, launchSettingsSchema, launchShape, validateLaunchSettings, type LaunchShape } from "@/lib/tiktok/settings";
import { isCrazydramasAdUrl } from "@/lib/tiktok/ad-url";
import type { LaunchAdSetPlan, LaunchConnection, LaunchContent, LaunchDraft, LaunchPlan, LaunchPlanIssue, LaunchProvider, MetaLaunchSettings, MetaPlatform } from "./types";
import { DEFAULT_META_CONVERSION_EVENT, META_CONVERSION_EVENTS, META_PIXEL_ID_SHAPE } from "@/lib/meta/events";

const cents = z.number().int().min(1).max(100_000_000);
export const contentSchema = z.object({
  kind: z.enum(["spark", "tiktok_post", "facebook_post", "instagram_post", "video"]),
  value: z.string().trim().min(1).max(2000), label: z.string().max(200).optional(),
  text: z.string().max(2200).optional(), headline: z.string().max(200).optional(),
  // Provenance for the preview, the confirm dialog and the monitor: which Studio
  // clip this content is, and which post record published it. Both are verified
  // against the company's own clip library before saving, never trusted as sent.
  clip_id: z.string().uuid().optional(), post_id: z.string().uuid().optional(),
  // The title this ad promotes (TikTok: one per Spark code row). Checked
  // against the company's titles and its crazydramas series at preview; its
  // link (`landing_url`) is written by the server, never read from here.
  title_id: z.string().uuid().optional(),
}); // File paths, hashes, landing links and ownership are resolved from the data layer, never from the client.
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
    // Defaulted, not required: a draft saved before Meta conversions landed
    // carries none of these, and it must still save, preview and start a
    // second round rather than failing validation.
    objective: z.enum(["OUTCOME_TRAFFIC", "OUTCOME_SALES"]).default("OUTCOME_TRAFFIC"),
    optimization_goal: z.enum(["LINK_CLICKS", "LANDING_PAGE_VIEWS", "OFFSITE_CONVERSIONS"]),
    conversion_event: z.enum(META_CONVERSION_EVENTS).nullable().default(null),
    pixel_id: z.string().regex(META_PIXEL_ID_SHAPE).nullable().default(null),
    bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP"]),
    bid_cents: cents.nullable(), call_to_action: z.enum(["LEARN_MORE", "WATCH_MORE"]),
    start_time: z.string().datetime({ offset: true }), end_time: z.string().datetime({ offset: true }),
  }),
  campid_start: z.string().trim().max(60).nullable().optional(),
  title_id: z.string().uuid().nullable().optional(),
});

export function defaultLaunchDraft(provider: LaunchProvider = "tiktok"): LaunchDraft {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 86400000);
  // A TikTok launch starts as Website purchases at $30 a day per ad group
  // (lib/tiktok/settings.ts defaultWebsitePurchaseSettings); the daily total
  // here is that figure times the one ad group a new draft plans.
  const tiktok = provider === "tiktok" ? defaultTikTokLaunchSettings() : null;
  return { provider, name: "Launch", account_ids: [], campaigns_per_account: 1, content_per_campaign: provider === "tiktok" ? 5 : 1,
    allocation: "unique", content: [], destination_url: "", total_budget_cents: 50000,
    daily_budget_cents: tiktok ? Math.round((tiktok.daily_budget_usd ?? 20) * 100) : null, start_paused: true, campid_start: null, title_id: null,
    tiktok_settings: { ...(tiktok ?? defaultLaunchSettings()), start_paused: true },
    meta_settings: { countries: ["US"], placements: ["facebook"], objective: "OUTCOME_TRAFFIC", optimization_goal: "LINK_CLICKS",
      conversion_event: null, pixel_id: null,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cents: null, call_to_action: "LEARN_MORE",
      start_time: start.toISOString(), end_time: end.toISOString() } };
}

/** Whole-cent allocation is stable, and sums exactly to the signed total. */
export function splitBudget(total: number, count: number): number[] {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isInteger(count) || count < 1 || total < count) throw new Error("Invalid budget allocation.");
  const base = Math.floor(total / count), remainder = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** TikTok's limit on an ad's text, the words under an uploaded video. */
export const TIKTOK_AD_TEXT_MAX = 100;
/**
 * The text a TikTok ad made from a Studio clip carries: its own text (the
 * clip's hook unless edited), else the title's name, on one line and cut to
 * TikTok's 100 characters. A Spark code or a post carries the post's own
 * caption and sends none. One rule for the screen, the preview and the driver.
 */
export function tiktokAdText(item: Pick<LaunchContent, "text" | "headline">): string {
  const line = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  return (line(item.text) || line(item.headline)).slice(0, TIKTOK_AD_TEXT_MAX).trim();
}
/** What a TikTok launch may carry: Spark codes, the linked account's posts and Studio clips. */
export const TIKTOK_CONTENT_KINDS: readonly LaunchContent["kind"][] = ["spark", "tiktok_post", "video"];
/** A TikTok post id: TikTok's numeric item id. */
export const TIKTOK_ITEM_ID = /^\d{10,25}$/;

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

/** Meta's floor for an ad-set budget. The plan and the driver share this one number. */
export const META_MIN_BUDGET_CENTS = 100;
/**
 * How far ahead a Meta end time must still lie at preview. A draft opened with
 * a seven-day window and approved a week later would otherwise create the
 * campaign and then have Meta refuse every ad set for ending in the past.
 */
export const META_SCHEDULE_MARGIN_MS = 15 * 60_000;
/** Lowercase, 2–40 characters, starting on a letter or digit. */
export const CAMPID_SHAPE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/**
 * overlord's mass-launch generator: the trailing digits of the first campid are
 * the counter and their zero padding is preserved (`rlapple01, rlapple02, …`);
 * a value with no trailing digits counts from `01`.
 */
export function campidSeries(start: string, count: number): string[] {
  const base = start.trim().toLowerCase();
  const digits = base.match(/^(.*?)(\d+)$/);
  const prefix = digits ? digits[1] : base;
  const first = digits ? Number(digits[2]) : 1;
  const width = digits ? digits[2].length : 2;
  return Array.from({ length: Math.max(0, count) }, (_, i) => `${prefix}${String(first + i).padStart(width, "0")}`);
}

/** Even whole-cent split that never throws; the minimum check reports what is too small. */
function evenly(total: number, count: number): number[] {
  if (count < 1) return [];
  const base = Math.floor(Math.max(0, total) / count), remainder = Math.max(0, total) % count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

const AD_SET_ORDER: MetaPlatform[] = ["facebook", "instagram"];
/** A post belongs to its own platform; an uploaded clip belongs to the chosen placements. */
export function platformOfContent(item: LaunchContent): MetaPlatform | null {
  return item.kind === "facebook_post" ? "facebook" : item.kind === "instagram_post" ? "instagram" : null;
}
/**
 * The ad sets one campaign needs: one per platform that actually has content,
 * each holding only that platform's ads, sharing the campaign's budget equally
 * with the remainder on the first.
 */
export function deriveAdSets(content: LaunchContent[], placements: MetaPlatform[], budgetCents: number, dailyBudgetCents: number | null): LaunchAdSetPlan[] {
  const groups = AD_SET_ORDER.map(platform => ({
    platform,
    content: content.filter(item => item.kind === "video" ? placements.includes(platform) : platformOfContent(item) === platform),
  })).filter(group => group.content.length > 0);
  const lifetime = evenly(budgetCents, groups.length);
  const daily = dailyBudgetCents === null ? null : evenly(dailyBudgetCents, groups.length);
  return groups.map((group, i) => ({ ...group, budget_cents: lifetime[i], daily_budget_cents: daily ? daily[i] : null }));
}
/** The amount Meta actually receives for an ad set: the daily budget when pacing is on, else the lifetime share. */
export const adSetSpendCents = (set: LaunchAdSetPlan) => set.daily_budget_cents ?? set.budget_cents;

/**
 * What a Meta conversions launch needs before anything is created (decision
 * 2026-09-25, "Meta conversions"). Pure, and the one rule the settings panel,
 * the preview and the driver share.
 *
 * The objective and the optimization goal move together because Meta pairs
 * them: `OFFSITE_CONVERSIONS` is refused under `OUTCOME_TRAFFIC`, and
 * `OUTCOME_SALES` with a click goal buys clicks at a conversion campaign's
 * price. Refusing the mismatch here keeps it out of the ad set create, which
 * happens after the campaign already exists and would leave a half-built run.
 *
 * The link is checked too: crazydramas.com is what fires the pixel, so an ad
 * set optimizing toward a crazydramas event whose ad points somewhere else can
 * never report a conversion, and Meta would spend the whole budget learning
 * from nothing.
 */
/**
 * The settings a person gets when they switch the Meta campaign's objective.
 * Pure, and the one place the pairing is decided, so the panel cannot leave a
 * combination the preview would refuse. The pixel is left alone: the server
 * writes it at save (lib/data/launch.ts), never the client.
 */
export function metaObjectiveSettings(settings: MetaLaunchSettings, objective: MetaLaunchSettings["objective"]): MetaLaunchSettings {
  if (objective === settings.objective) return settings;
  // A bid cap is a price for the thing being bought, and the thing changes: a
  // $0.40 cap meant per click becomes $0.40 per checkout, which buys nothing.
  // Clearing it asks for the number again rather than spending on the old one.
  const bid = { bid_strategy: "LOWEST_COST_WITHOUT_CAP" as const, bid_cents: null };
  if (objective === "OUTCOME_SALES")
    return { ...settings, ...bid, objective, optimization_goal: "OFFSITE_CONVERSIONS", conversion_event: settings.conversion_event ?? DEFAULT_META_CONVERSION_EVENT };
  return { ...settings, ...bid, objective, conversion_event: null, pixel_id: null,
    optimization_goal: settings.optimization_goal === "OFFSITE_CONVERSIONS" ? "LINK_CLICKS" : settings.optimization_goal };
}

export function metaConversionIssues(settings: MetaLaunchSettings, destinationUrl: string): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  const sales = settings.objective === "OUTCOME_SALES";
  const conversions = settings.optimization_goal === "OFFSITE_CONVERSIONS";
  if (sales !== conversions) {
    issues.push(sales
      ? { code: "conversionGoal", message: "A Sales campaign optimizes toward a pixel event. Choose the conversion goal, or switch the campaign back to Traffic." }
      : { code: "conversionObjective", message: "Optimizing toward a pixel event needs the Sales objective. Switch the campaign to Sales, or choose a click goal." });
    return issues;
  }
  if (!conversions) {
    if (settings.conversion_event) issues.push({ code: "conversionEventUnused", message: "A Traffic campaign optimizes toward clicks, not a pixel event. Clear the event, or switch the campaign to Sales." });
    if (settings.pixel_id) issues.push({ code: "conversionPixelUnused", message: "A Traffic campaign uses no pixel. Clear it, or switch the campaign to Sales." });
    return issues;
  }
  if (!settings.conversion_event) issues.push({ code: "conversionEvent", message: "Choose the pixel event this campaign optimizes toward." });
  // A missing pixel is NOT an issue here. The server writes it at save
  // (lib/data/launch.ts) and the preview gate refuses an unresolvable one in a
  // sentence, so complaining about it in the panel would show the person a
  // blocker they cannot clear on a draft they have not saved yet.
  if (settings.pixel_id && !META_PIXEL_ID_SHAPE.test(settings.pixel_id)) issues.push({ code: "conversionPixelShape", message: "The pixel id is not a Meta pixel id." });
  if (!isCrazydramasAdUrl(destinationUrl, "meta"))
    issues.push({ code: "conversionLink", message: "Conversions are counted by the crazydramas pixel, so the ad must point at a crazydramas series. Choose the drama again, or switch the campaign to Traffic." });
  return issues;
}

/** The content each campaign carries, in the order the preview lists them. */
export function campaignContentSlices(draft: Pick<LaunchDraft, "allocation" | "content" | "content_per_campaign">, count: number): LaunchContent[][] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => draft.allocation === "shared"
    ? draft.content : draft.content.slice(index * draft.content_per_campaign, (index + 1) * draft.content_per_campaign));
}

function issueList() {
  const issues: LaunchPlanIssue[] = [];
  return {
    issues,
    add(code: string, message: string, vars?: Record<string, string | number>) {
      if (!issues.some(issue => issue.code === code)) issues.push({ code, message, ...(vars ? { vars } : {}) });
    },
  };
}

/**
 * The campid to start the next round from: the value after the last one this
 * round stamped, so a new round never reuses a name the ad account already
 * holds. Null when no first campid was typed.
 */
export function nextCampidStart(start: string | null | undefined, count: number): string | null {
  if (!start?.trim() || !Number.isInteger(count) || count < 1) return null;
  return campidSeries(start, count + 1)[count];
}

/**
 * Campid problems, for both providers. `takenNames` are the campaign names the
 * ad account already carries: the driver refuses a collision before creating,
 * so preview says so first instead of failing halfway through a launch.
 */
export function campidIssues(start: string | null | undefined, count: number, takenNames: readonly string[] = []): LaunchPlanIssue[] {
  const list = issueList();
  if (!start?.trim()) return list.issues;
  const series = campidSeries(start, Math.max(1, count));
  if (series.some(value => !CAMPID_SHAPE.test(value)))
    list.add("campidShape", "A campid uses 2 to 40 lowercase letters, digits, hyphens or underscores and starts with a letter or digit.");
  if (new Set(series).size !== series.length) list.add("campidDuplicate", "Each campaign needs its own campid.");
  const clash = series.filter(value => takenNames.includes(value));
  if (clash.length) list.add("campidTaken", `The ad account already has a campaign named ${clash[0]}. Start from a different campid.`, { campid: clash[0] });
  return list.issues;
}

/**
 * Everything a Meta draft must fix before it can be previewed, collected rather
 * than raised one at a time, so the screen can print one "Fix these first" list.
 * Tolerant of an unfinished draft: counts and account choices are checked
 * elsewhere and never reported twice here.
 */
export function metaDraftIssues(draft: LaunchDraft, connections: LaunchConnection[], takenNames: readonly string[] = []): LaunchPlanIssue[] {
  const list = issueList();
  if (draft.provider !== "meta") return list.issues;
  const settings = draft.meta_settings;
  const chosen = draft.account_ids.map(id => connections.find(c => c.id === id)).filter((c): c is LaunchConnection => !!c);
  const count = chosen.length * Math.max(1, draft.campaigns_per_account);
  // The shape checks every launch shares live here too, so the screen prints
  // them in the same list instead of one refused preview at a time.
  if (new Set(draft.account_ids).size !== draft.account_ids.length) list.add("duplicateAccounts", "Select each advertising account only once.");
  if (new Set(chosen.map(a => a.advertiser_id.replace(/^act_/, ""))).size !== chosen.length) list.add("duplicateAccounts", "The same advertising account was assigned more than once. Select one assignment per account.");
  let destination: URL | null = null;
  try { destination = new URL(draft.destination_url); } catch { destination = null; }
  if (!destination || !["https:", "http:"].includes(destination.protocol) || destination.username || destination.password)
    list.add("destinationUrl", "Enter a complete destination URL: an HTTP(S) address without credentials.");
  // A crazydramas link built for the other platform carries that platform's
  // contract: TikTok's macros are filled by TikTok alone, so on Meta they
  // reach crazydramas as the literal text __CAMPAIGN_ID__ and are stored as a
  // real (false) TikTok session. Refuse it before anything is created.
  if (isCrazydramasAdUrl(draft.destination_url) && !isCrazydramasAdUrl(draft.destination_url, "meta"))
    list.add("crossPlatformLink", "This is the TikTok link for that drama. Choose the drama again so the ad carries the Meta link.");
  if (count > 0) {
    const needed = draft.allocation === "shared" ? draft.content_per_campaign : count * draft.content_per_campaign;
    if (draft.content.length !== needed) list.add("contentCount", `Need exactly ${needed} content entries; ${draft.content.length} provided.`, { needed, provided: draft.content.length });
    if (count > 100) list.add("campaignCount", "A launch may contain up to 100 campaigns.");
  }
  if (new Set(draft.content.map(c => `${c.kind}:${c.value}`)).size !== draft.content.length)
    list.add("duplicateContent", "Remove duplicate content entries. Use shared allocation to reuse content.");
  for (const item of draft.content) {
    if (item.kind === "spark") list.add("contentSpark", "Meta takes existing posts or finished clips, not Spark codes.");
    if (item.kind === "tiktok_post") list.add("contentTikTokPost", "Meta takes Facebook or Instagram posts or finished clips, not TikTok posts.");
    if (item.kind === "facebook_post" && !/^\d+_\d+$/.test(item.value)) list.add("contentFacebookRef", "A Facebook post reference must be pageID_postID.");
    if (item.kind === "instagram_post" && !/^\d+$/.test(item.value)) list.add("contentInstagramRef", "An Instagram post reference must be a media ID.");
  }
  if (chosen.some(account => !account.page_id)) list.add("accountPage", "Assign a Facebook Page to every selected Meta account.");
  const start = Date.parse(settings.start_time), end = Date.parse(settings.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) list.add("schedule", "Meta needs a valid start and end time.");
  else if (end <= Date.now() + META_SCHEDULE_MARGIN_MS) list.add("scheduleEnded", "The Meta end time has passed or is about to. Move it forward before previewing.");
  if (settings.bid_strategy === "LOWEST_COST_WITH_BID_CAP" && !settings.bid_cents) list.add("bid", "Set the Meta bid cap.");
  for (const issue of metaConversionIssues(settings, draft.destination_url)) list.add(issue.code, issue.message);
  if (count > 0) {
    const shares = evenly(draft.total_budget_cents, count);
    if (shares.some(share => share < META_MIN_BUDGET_CENTS))
      list.add("campaignMinimum", "Each Meta campaign needs at least $1 of allocated budget; account-specific minimums are checked by Meta.");
    const slices = campaignContentSlices(draft, count);
    for (let index = 0; index < count; index++) {
      const daily = draft.daily_budget_cents;
      const sets = deriveAdSets(slices[index], settings.placements, shares[index], daily);
      if (!sets.length) { list.add("contentEmpty", "Every campaign needs at least one post or finished clip."); continue; }
      if (sets.some(set => set.platform === "instagram") && chosen.some(account => !account.instagram_id))
        list.add("accountInstagram", "Assign an Instagram identity: these campaigns include Instagram ads.");
      if (sets.some(set => adSetSpendCents(set) < META_MIN_BUDGET_CENTS))
        list.add("adSetMinimum", "Each ad set needs at least $1. Raise the budget, or run one platform at a time.", { platforms: sets.length });
    }
  }
  for (const issue of campidIssues(draft.campid_start, count, takenNames)) list.add(issue.code, issue.message, issue.vars);
  return list.issues;
}

/**
 * The link one campaign's ads carry.
 *
 * TikTok (decision 2026-09-23): the destination is the crazydramas ad link
 * (lib/tiktok/ad-url.ts crazydramasAdUrl), and a website ad (Traffic,
 * Website purchases) carries it exactly — TikTok's macros stay literal and
 * nothing is appended, `campid` included; crazydramas ignores campid and
 * Studio maps results by the ids it recorded, not by the URL. The Sales
 * Instant Page keeps its own rule: its button link needs the campaign's
 * campid (lib/tiktok/instant-page.ts), added after the four parameters.
 *
 * Meta, and a TikTok row approved before the contract: the destination with
 * exactly one `campid` parameter.
 */
export function trackingUrlForCampaign(destination: string, campid: string, target: { provider?: LaunchProvider; shape?: LaunchShape } = {}): string {
  if (target.provider === "tiktok" && isCrazydramasAdUrl(destination, "tiktok")) {
    return target.shape === "instant_page" ? `${destination}&campid=${encodeURIComponent(campid)}` : destination;
  }
  // Meta has no macro Studio can trust in a CTA link, so the campaign is named
  // by Studio's own campid in the slot crazydramas reads (`campaign`). The
  // platform already says `meta`; without this every Meta session would arrive
  // with no campaign at all.
  if (target.provider === "meta" && isCrazydramasAdUrl(destination, "meta")) {
    const url = new URL(destination);
    url.searchParams.set("campaign", campid);
    return url.toString();
  }
  const url = new URL(destination);
  url.searchParams.set("campid", campid);
  return url.toString();
}

/** The TikTok refusal for a destination that is not the title's crazydramas ad link. */
export const TIKTOK_DESTINATION_REFUSAL = "TikTok ads link to the title's crazydramas page. Choose the title this launch promotes.";
/** A Sales Instant Page has one button, so it has one link: its ads cannot promote different titles. */
export const INSTANT_PAGE_ONE_TITLE = "A Sales Instant Page has one button link, so every ad in this launch must promote the launch's title. Set each ad to that title, or use Website purchases or Traffic to promote several titles in one launch.";

/**
 * The link one TikTok ad carries: its own title's link when the server wrote
 * one (per-ad titles), else the campaign's (content saved before them).
 */
export function adLandingUrl(item: Pick<LaunchContent, "landing_url">, campaignUrl: string): string {
  return item.landing_url ?? campaignUrl;
}

export function buildLaunchPlan(input: LaunchDraft, connections: LaunchConnection[], savedRunExternalId?: string, takenNames: readonly string[] = []): LaunchPlan {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const d = parsed.data;
  // A Meta draft collects every shape problem into one list; TikTok keeps
  // raising them one at a time, as its own screen expects.
  const collecting = d.provider === "meta";
  if (!d.account_ids.length) throw new Error("Select at least one assigned advertising account.");
  if (!collecting && new Set(d.account_ids).size !== d.account_ids.length) throw new Error("Select each account only once.");
  if (!collecting) {
    // Every TikTok ad goes to the title's crazydramas page with the four
    // attribution parameters (lib/tiktok/ad-url.ts); the data layer checks the
    // title and that its series is live before it gets here.
    // The launch's own link is needed only by an ad without its own link, and
    // by an Instant Page's one button (the launch's title is optional).
    const needsLaunchLink = !input.content.length || input.content.some(item => item.landing_url === undefined) || launchShape(d.tiktok_settings) === "instant_page";
    if (needsLaunchLink && !isCrazydramasAdUrl(d.destination_url)) throw new Error(TIKTOK_DESTINATION_REFUSAL);
    // Each ad may promote its own title, so each carries its own link (the
    // server writes it on save; the gate checks it against the title).
    input.content.forEach((item, i) => {
      if (item.landing_url !== undefined && !isCrazydramasAdUrl(item.landing_url)) throw new Error(`Ad ${i + 1} has no crazydramas link. Choose a title that is live on crazydramas for it.`);
    });
    if (launchShape(d.tiktok_settings) === "instant_page" && input.content.some(item => item.landing_url !== undefined && item.landing_url !== d.destination_url))
      throw new Error(INSTANT_PAGE_ONE_TITLE);
  }
  const chosen = d.account_ids.map(id => {
    const a = connections.find(c => c.id === id && c.provider === d.provider && c.enabled && c.assigned_by);
    if (!a) throw new Error("An account is unassigned, unavailable or belongs to a different platform.");
    if (a.currency !== "USD") throw new Error("This release supports USD advertising accounts.");
    return a;
  });
  const count = chosen.length * d.campaigns_per_account;
  if (!collecting) {
    if (new Set(chosen.map(a => a.advertiser_id.replace(/^act_/, ""))).size !== chosen.length) throw new Error("The same advertising account was assigned more than once. Select one assignment per account.");
    if (count > 100) throw new Error("A launch may contain up to 100 campaigns.");
    const needed = d.allocation === "shared" ? d.content_per_campaign : count * d.content_per_campaign;
    if (d.content.length !== needed) throw new Error(`Need exactly ${needed} content entries; ${d.content.length} provided.`);
    if (new Set(d.content.map(c => `${c.kind}:${c.value}`)).size !== d.content.length) throw new Error("Remove duplicate content entries. Use shared allocation to reuse content.");
    if (d.content.some(c => !TIKTOK_CONTENT_KINDS.includes(c.kind))) throw new Error("TikTok takes Studio clips, the linked TikTok account's posts and Spark codes; Facebook and Instagram posts go to Meta.");
    d.content.forEach((c, i) => {
      if (c.kind === "tiktok_post" && !TIKTOK_ITEM_ID.test(c.value)) throw new Error(`Ad ${i + 1} is not a TikTok post of the linked account. Choose it again from the list.`);
      if (c.kind === "video" && !tiktokAdText(c)) throw new Error(`Ad ${i + 1} has no text. Write the line TikTok shows under the clip.`);
    });
  } else {
    // One collected list, so the screen prints every reason at once instead of
    // making the producer discover them one refused preview at a time.
    const issues = metaDraftIssues(d as LaunchDraft, connections, takenNames);
    if (issues.length) throw new Error(issues.map(issue => issue.message).join(" "));
  }
  const shares = splitBudget(d.total_budget_cents, count);
  if (!collecting) {
    const campid = campidIssues(d.campid_start, count, takenNames);
    if (campid.length) throw new Error(campid.map(issue => issue.message).join(" "));
    for (const share of shares) {
      const groups = d.tiktok_settings.duplicate_copies + 1;
      if (d.daily_budget_cents !== null && Math.floor(d.daily_budget_cents / groups) < 2000) throw new Error("TikTok's daily minimum is $20 per ad group, including planned copies.");
      const s = { ...d.tiktok_settings, start_paused: d.start_paused,
        budget_mode: d.daily_budget_cents === null ? "BUDGET_MODE_TOTAL" : "BUDGET_MODE_DAY",
        daily_budget_usd: d.daily_budget_cents === null ? null : Math.floor(d.daily_budget_cents / groups) / 100 };
      validateLaunchSettings(s, share / 100);
    }
  }
  // A typed first campid counts up per campaign, exactly as overlord does; an
  // empty field keeps the identifier derived from the saved run.
  const typed = d.campid_start?.trim() ? campidSeries(d.campid_start, count) : null;
  const campidAt = (index: number) => typed ? typed[index] : savedRunExternalId ? campidForRun(savedRunExternalId, index + 1, d.name) : null;
  const rows = chosen.flatMap(connection => Array.from({ length: d.campaigns_per_account }, () => connection)).map((connection, index) => {
    const campid = campidAt(index);
    const content = structuredClone(d.allocation === "shared" ? input.content : input.content.slice(index * d.content_per_campaign, (index + 1) * d.content_per_campaign));
    return {
      index: index + 1, connection_id: connection.id, advertiser_id: connection.advertiser_id,
      name: campid ?? `${d.name}-${index + 1}`,
      ...(campid ? { campid, ...(d.destination_url ? { tracking_url: trackingUrlForCampaign(d.destination_url, campid, { provider: d.provider, shape: launchShape(d.tiktok_settings) }) } : {}) } : {}),
      content,
      budget_cents: shares[index], daily_budget_cents: d.daily_budget_cents,
      ...(d.provider === "meta" ? { ad_sets: deriveAdSets(content, d.meta_settings.placements, shares[index], d.daily_budget_cents) } : {}),
    };
  });
  return { rows, total_budget_cents: d.total_budget_cents, daily_total_cents: d.daily_budget_cents === null ? null : count * d.daily_budget_cents,
    campaign_count: count, account_count: chosen.length, content_count: d.content.length,
    warnings: d.provider === "tiktok" && d.tiktok_settings.duplicate_copies > 0 ? ["The approved budget includes all planned ad group copies."] : [] };
}
