import { createHash } from "node:crypto";
import { readStoredBytes } from "@/lib/data/storage";
import { approvedCampaignBudget, assertCampaignBudget } from "@/lib/launch/budget";
import { deriveAdSets, META_MIN_BUDGET_CENTS } from "@/lib/launch/plan";
import { LaunchWaiting } from "@/lib/launch/waiting";
import type { DeliverySnapshot, DriverContext, LaunchAdSetPlan, LaunchContent, LaunchControl, LaunchDriver, MetaLaunchSettings, MetaPlatform } from "@/lib/launch/types";
import { metaTransport } from "./index";
import { MetaApiError, metaList, type MetaObject, type MetaTransport } from "./transport";
import { META_ACTION_TYPES, META_ATTRIBUTION_SPEC } from "./events";
import { resolveMetaPixel } from "./pixel";

type Intent = { edge: string; payload: MetaObject; phase: "sending" | "rejected" | "confirmed"; id?: string };
type MetaState = {
  version: 1; intents: Record<string, Intent>; campaign_id?: string;
  /**
   * The ad set of each platform this campaign runs on. `adset_id` is the legacy
   * alias — the single ad set of a run created before campaigns were split per
   * platform — and is kept written so anything reading it still finds one.
   */
  adset_ids?: Partial<Record<MetaPlatform, string>>; adset_id?: string;
  /**
   * The campaign ids that already carried this campaign's name when we last
   * looked, before we ever sent a create. They are somebody else's by
   * definition, so a reconciliation after a lost response may never adopt them.
   */
  campaign_name_taken?: string[];
  creative_ids: Record<string, string>; ad_ids: Record<string, string>; video_ids: Record<string, string>;
  /** Which ad set an ad belongs to, and which creative key it carries. Absent on legacy single-ad-set runs. */
  ad_platforms?: Record<string, MetaPlatform>; ad_content_keys?: Record<string, string>;
  content_values: Record<string, string>; stopped?: boolean; paused?: boolean; activated?: boolean;
  /**
   * The pixel this run's conversions ad sets were created against, recorded
   * before the first ad set is sent. A resume re-reads and re-checks it, so a
   * pixel that was un-shared between attempts stops the launch instead of
   * silently creating a second ad set against a different one.
   */
  pixel_id?: string;
};
type ResolvedAdSet = LaunchAdSetPlan & { platforms: MetaPlatform[]; id?: string };

/**
 * The ad sets this campaign runs on. `campaign.ad_sets` is NOT covered by the
 * approval hash, so it is never trusted: the driver re-derives the split from
 * the signed content, placements and budget and sends that. A campaign created
 * before the split keeps its single ad set holding all of its content.
 */
function adSetsOf(ctx: DriverContext, current: MetaState): ResolvedAdSet[] {
  const settings = ctx.run.draft.meta_settings;
  if (current.adset_id && !current.adset_ids) {
    const platform: MetaPlatform = settings.placements.includes("facebook") ? "facebook" : "instagram";
    return [{ platform, platforms: [...settings.placements], content: ctx.campaign.content,
      budget_cents: ctx.campaign.budget_cents, daily_budget_cents: ctx.campaign.daily_budget_cents, id: current.adset_id }];
  }
  return deriveAdSets(ctx.campaign.content, settings.placements, ctx.campaign.budget_cents, ctx.campaign.daily_budget_cents)
    .map(set => ({ ...set, platforms: [set.platform], id: current.adset_ids?.[set.platform] }));
}
const adSetShape = (sets: LaunchAdSetPlan[]) => sets
  .map(set => `${set.platform}:${set.budget_cents}:${set.daily_budget_cents}:${set.content.map(item => `${item.kind}:${item.value}`).join(",")}`).join("|");
/**
 * Refuse a stored ad-set split that is not the one the approval implies, before
 * a single Meta write: a tampered row must not place a Facebook post in an
 * Instagram ad set, nor create an inflated ad set for Meta to refuse later.
 * The comparison uses the signed ceiling, so an approved budget *reduction*
 * through the controls still matches.
 */
function assertPlannedAdSets(ctx: DriverContext) {
  const planned = ctx.campaign.ad_sets;
  if (!planned?.length) return;
  const signed = deriveAdSets(ctx.campaign.content, ctx.run.draft.meta_settings.placements,
    approvedCampaignBudget(ctx.run, ctx.campaign), ctx.run.draft.daily_budget_cents);
  if (adSetShape(planned) !== adSetShape(signed))
    throw new Error("Meta ad sets differ from the approved content, placements and budget. Create and approve a new round.");
}
/** Whole-cent re-split across the ad sets, the same shape the plan used. */
function splitAcross(total: number, count: number): number[] {
  const base = Math.floor(total / count), remainder = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}
function rememberAdSet(current: MetaState, platform: MetaPlatform, id: string) {
  current.adset_ids = { ...current.adset_ids, [platform]: id };
  current.adset_id = current.adset_ids.facebook ?? current.adset_ids.instagram;
}

function state(ctx: DriverContext): MetaState {
  const saved = ctx.campaign.state.meta as MetaState | undefined;
  return saved ? structuredClone(saved) : { version: 1, intents: {}, creative_ids: {}, ad_ids: {}, video_ids: {}, content_values: {} };
}
async function save(ctx: DriverContext, next: MetaState) { await ctx.checkpoint({ meta: structuredClone(next) }); }
function account(ctx: DriverContext) { return `act_${ctx.connection.advertiser_id.replace(/^act_/, "")}`; }
function key(content: LaunchContent, index: number) { return `${index}-${createHash("sha256").update(`${content.kind}:${content.value}`).digest("hex").slice(0, 16)}`; }
function amount(value: number) { if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Meta budget and bid amounts must be positive integer cents."); return value; }
/**
 * Meta refuses an ad set whose start lies in the past. An approved start that
 * has slipped behind the clock (a draft approved days after it was opened, a
 * retry, a wait for transcoding) begins a minute from now instead; the signed
 * end time is never moved, and a window that has closed is refused outright.
 */
function adSetStartTime(settings: MetaLaunchSettings): string {
  const soon = Date.now() + 60_000;
  return Date.parse(settings.start_time) <= soon ? new Date(soon).toISOString() : settings.start_time;
}
function requireMeta(ctx: DriverContext, transport: MetaTransport) {
  if (ctx.run.draft.provider !== "meta" || ctx.connection.provider !== "meta" || !ctx.connection.enabled || !ctx.connection.assigned_by) throw new Error("An assigned Meta account is required.");
  if (ctx.connection.producer_id !== ctx.run.producer_id || ctx.connection.id !== ctx.campaign.connection_id) throw new Error("Meta account does not belong to this launch.");
  if (ctx.connection.advertiser_id.replace(/^act_/, "") !== ctx.campaign.advertiser_id.replace(/^act_/, "")) throw new Error("Meta account changed after approval.");
  if (ctx.connection.currency !== "USD") throw new Error("Meta launches currently require USD accounts.");
  if (!ctx.connection.page_id) throw new Error("Select an assigned Facebook Page for Meta ads.");
  if ((ctx.run.mode === "fake") !== (transport.mode === "fake")) throw new Error("Meta launch environment differs from its approval. Create a new round in the intended environment.");
}
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${fingerprint(v)}`).join(",")}}`;
  return String(value);
}
function includes(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => includes((actual as MetaObject)[k], v));
  }
  return fingerprint(actual) === fingerprint(expected);
}
function matchFields(edge: string, payload: MetaObject): MetaObject {
  // Names alone are insufficient: compare account, parent and content as appropriate.
  const fields = edge === "campaigns" ? ["name", "objective"]
    : edge === "adsets" ? ["name", "campaign_id"]
    : edge === "ads" ? ["name", "adset_id", "creative"]
    : edge === "advideos" ? ["title", "description"]
    : ["name", "object_story_id", "source_instagram_media_id", "instagram_user_id", "object_id", "call_to_action", "object_story_spec"];
  const selected = Object.fromEntries(fields.filter(field => payload[field] !== undefined).map(field => [field, payload[field]]));
  if (edge === "ads") selected.creative = { id: (payload.creative as MetaObject).creative_id };
  return selected;
}

/**
 * Persist an intent before sending. A dropped POST is reconciled, never blindly
 * repeated. `foreign` names objects that already existed when the caller looked:
 * a reconciliation may never adopt one of those, whoever created it.
 */
async function create(ctx: DriverContext, transport: MetaTransport, current: MetaState, intentKey: string, edge: string, payload: MetaObject, bytes?: Uint8Array, foreign: readonly string[] = []): Promise<string> {
  const existing = current.intents[intentKey];
  // A rejected intent created nothing, so a corrected payload (a start time
  // moved up to now) may replace it; an intent that was sent or confirmed is frozen.
  if (existing && existing.phase !== "rejected" && (existing.edge !== edge || fingerprint(existing.payload) !== fingerprint(payload))) throw new Error("Meta create intent differs from the approved launch; start a new round.");
  if (existing?.id) return existing.id;
  if (existing?.phase === "sending") {
    const expected = matchFields(edge, payload);
    const fields = ["id", ...(edge === "advideos" ? [] : ["account_id"]), ...Object.keys(expected)].join(",");
    const candidates = (await metaList(transport, `${account(ctx)}/${edge}`, { fields })).filter(row =>
      (!row.account_id || String(row.account_id) === ctx.connection.advertiser_id.replace(/^act_/, "")) && includes(row, expected) && !foreign.includes(String(row.id)));
    if (candidates.length !== 1) throw new Error(`Meta ${edge} create outcome is ambiguous (${candidates.length} matches). Reconcile the recorded intent before retrying.`);
    const id = String(candidates[0].id);
    current.intents[intentKey] = { ...existing, id, phase: "confirmed" };
    await save(ctx, current);
    return id;
  }
  // Ownership is checked BEFORE the intent is written: a worker that has lost
  // its lease must not leave a "sending" intent behind, because that intent is
  // what later lets a reconciliation adopt an object by name.
  await ctx.assertActive();
  current.intents[intentKey] = { edge, payload, phase: "sending" };
  await save(ctx, current);
  let response: MetaObject;
  try {
    response = bytes
      ? await transport.upload(`${account(ctx)}/${edge}`, payload, { source: { bytes, filename: "approved-clip.mp4", contentType: "video/mp4" } })
      : await transport.post(`${account(ctx)}/${edge}`, payload);
  } catch (error) {
    if (error instanceof MetaApiError && !error.ambiguous) { current.intents[intentKey].phase = "rejected"; await save(ctx, current); }
    throw error;
  }
  if (typeof response.id !== "string" || !response.id) throw new MetaApiError("Meta create returned no object ID; reconcile before retrying.", undefined, true);
  current.intents[intentKey] = { edge, payload, phase: "confirmed", id: response.id };
  await save(ctx, current);
  return response.id;
}

async function readAccount(ctx: DriverContext, transport: MetaTransport, sets: ResolvedAdSet[], current: MetaState) {
  const result = await transport.get(account(ctx), { fields: "id,account_status,currency,timezone_name" });
  if (Number(result.account_status) !== 1) throw new Error("Meta ad account is not active.");
  if (result.currency !== ctx.connection.currency) throw new Error("Meta account currency differs from the approved connection.");
  if (sets.some(set => set.platforms.includes("instagram"))) {
    if (!ctx.connection.instagram_id) throw new Error("Instagram placements require an assigned Instagram identity.");
    const identities = await metaList(transport, `${account(ctx)}/instagram_accounts`, { fields: "id" });
    if (!identities.some(row => row.id === ctx.connection.instagram_id)) throw new Error("Instagram identity is not available to this ad account.");
  }
  await readPixel(ctx, transport, current);
}

/**
 * The pixel a conversions run optimizes toward, checked against the ad account
 * before any paid object exists and recorded on the run. The approved draft
 * names a pixel; this refuses to send a different one, because the budget was
 * signed against the event that pixel reports.
 */
async function readPixel(ctx: DriverContext, transport: MetaTransport, current: MetaState) {
  const settings = ctx.run.draft.meta_settings;
  if (settings.optimization_goal !== "OFFSITE_CONVERSIONS") return;
  if (!settings.conversion_event) throw new Error("This Meta launch optimizes toward a pixel event but names none. Create and approve a new round.");
  const approved = settings.pixel_id;
  if (!approved) throw new Error("This Meta launch optimizes toward a pixel event but names no pixel. Create and approve a new round.");
  const resolved = await resolveMetaPixel(transport, ctx.connection.advertiser_id);
  if (!resolved.ok) throw new Error(resolved.reason);
  if (resolved.pixel_id !== approved) throw new Error(`The approved pixel ${approved} is not the pixel this ad account resolves (${resolved.pixel_id}). Create and approve a new round.`);
  if (current.pixel_id && current.pixel_id !== resolved.pixel_id) throw new Error(`This launch already created ad sets against pixel ${current.pixel_id}. Create a new round to move to ${resolved.pixel_id}.`);
  current.pixel_id = resolved.pixel_id;
  await save(ctx, current);
}

/** The pixel `readPixel` recorded. Never reached without it: the ad set payload is built after readAccount. */
function requirePixel(ctx: DriverContext, current: MetaState): string {
  if (!current.pixel_id) throw new Error("The Meta pixel was not resolved before the ad set was built.");
  return current.pixel_id;
}

function creativePayload(ctx: DriverContext, content: LaunchContent, name: string, video?: { id: string; thumbnail: string }): MetaObject {
  const page = ctx.connection.page_id!;
  const instagram = ctx.connection.instagram_id;
  const callToAction = { type: ctx.run.draft.meta_settings.call_to_action, value: { link: ctx.campaign.tracking_url ?? ctx.run.draft.destination_url } };
  if (content.kind === "facebook_post") {
    if (!content.value.startsWith(`${page}_`)) throw new Error("Facebook post must belong to the assigned Page and use its PageID_PostID reference.");
    return { name, object_story_id: content.value, call_to_action: callToAction, ...(instagram ? { instagram_user_id: instagram } : {}) };
  }
  if (content.kind === "instagram_post") {
    if (!instagram) throw new Error("Instagram post ads require an assigned Instagram account.");
    return { name, source_instagram_media_id: content.value, instagram_user_id: instagram, object_id: page, call_to_action: callToAction };
  }
  if (content.kind !== "video" || !video) throw new Error("Select an existing Meta post or an approved finished clip.");
  return {
    name,
    object_story_spec: {
      page_id: page, ...(instagram ? { instagram_user_id: instagram } : {}),
      video_data: {
        video_id: video.id, image_url: video.thumbnail, message: content.text || "", ...(content.headline ? { title: content.headline } : {}),
        call_to_action: callToAction,
      },
    },
  };
}

async function launch(ctx: DriverContext, transport: MetaTransport) {
  requireMeta(ctx, transport);
  const current = state(ctx);
  if (current.stopped) throw new Error("Ended Meta launches require a new round.");
  const settings = ctx.run.draft.meta_settings;
  if (!ctx.campaign.content.length) throw new Error("No eligible Meta content; no campaign was created.");
  assertCampaignBudget(ctx.run, ctx.campaign);
  assertPlannedAdSets(ctx);
  if (!Number.isFinite(Date.parse(settings.start_time)) || Date.parse(settings.end_time) <= Date.parse(settings.start_time)) throw new Error("Meta needs a valid start and end time.");
  if (Date.parse(settings.end_time) <= Date.now() + 60_000) throw new Error("The approved Meta end time has already passed. Create a new round with a later end time.");
  const sets = adSetsOf(ctx, current);
  if (!sets.length) throw new Error("No eligible Meta content; no campaign was created.");
  if (sets.some(set => (set.daily_budget_cents ?? set.budget_cents) < META_MIN_BUDGET_CENTS)) throw new Error("Each Meta ad set needs at least $1 of allocated budget. Create and approve a new round.");
  await readAccount(ctx, transport, sets, current);
  const payloads: { content: LaunchContent; key: string; payload: MetaObject }[] = [];
  for (let index = 0; index < ctx.campaign.content.length; index++) {
    const content = ctx.campaign.content[index];
    const contentKey = key(content, index);
    const name = `${ctx.run.external_id}/${ctx.campaign.index}/${contentKey}`;
    let video: { id: string; thumbnail: string } | undefined;
    if (content.kind === "video") {
      if (!content.file_path || !content.sha256 || !content.creative_id) throw new Error("Meta uploads require a frozen approved finished clip and SHA-256.");
      if (!current.video_ids[contentKey]) {
        const bytes = await readStoredBytes(content.file_path);
        if (createHash("sha256").update(bytes).digest("hex") !== content.sha256) throw new Error("Approved Meta clip changed after approval; launch stopped.");
        const videoId = await create(ctx, transport, current, `video/${contentKey}`, "advideos", { title: name, description: `Studio approved sha256:${content.sha256}` }, bytes);
        current.video_ids[contentKey] = videoId;
        await save(ctx, current);
      }
      const details = await transport.get(current.video_ids[contentKey], { fields: "id,status,thumbnails" });
      const status = (details.status as MetaObject | undefined)?.video_status;
      if (status === "error") throw new Error("Meta could not process the uploaded clip. The campaign was not created.");
      // Transcoding takes a minute or two. Not a failure: the video id is
      // checkpointed, so the resume continues from here without re-uploading.
      if (status !== "ready") throw new LaunchWaiting("Meta is still processing the uploaded clip.");
      const thumbnails = (details.thumbnails as { data?: { uri?: string; is_preferred?: boolean }[] } | undefined)?.data || [];
      const thumbnail = (thumbnails.find(row => row.is_preferred) || thumbnails[0])?.uri;
      if (!thumbnail?.startsWith("https://")) throw new Error("Meta has not returned a usable video thumbnail yet.");
      video = { id: current.video_ids[contentKey], thumbnail };
    } else {
      if (content.kind !== "facebook_post" && content.kind !== "instagram_post") throw new Error("Spark codes cannot be sent to Meta.");
      await transport.get(content.value, { fields: "id" });
    }
    const payload = creativePayload(ctx, content, name, video);
    // Meta decides eligibility for this account and identity before any paid hierarchy exists.
    await ctx.assertActive();
    await transport.post(`${account(ctx)}/adcreatives`, { ...payload, execution_options: ["validate_only"] });
    payloads.push({ content, key: contentKey, payload });
  }
  const daily = ctx.campaign.daily_budget_cents;
  if (daily !== null) amount(daily);
  const campaignPayload: MetaObject = {
    // A run approved before Meta conversions landed has no objective in its
    // stored draft (a database JSON blob, never re-validated by zod), and Meta
    // refuses a campaign create without one. Those runs were all Traffic.
    name: ctx.campaign.campid ?? `${ctx.run.external_id}/${ctx.campaign.index}`, objective: settings.objective ?? "OUTCOME_TRAFFIC", special_ad_categories: [], status: "PAUSED",
    // Meta requires this whenever the budget is not on the campaign.
    // Studio always budgets per ad set, and the signed per-campaign
    // ceiling is exact, so ad sets must never borrow from each other.
    is_adset_budget_sharing_enabled: false,
    ...(daily !== null ? { spend_cap: ctx.campaign.budget_cents } : {}),
  };
  if (!current.campaign_id) {
    // The campaign name is the campid, and the driver adopts a campaign by exact
    // name after a lost response. So the account is read EVERY time, not only on
    // a first attempt: a name somebody else took stops the launch, and the ids
    // that already carried the name can never be adopted as our own.
    const name = String(campaignPayload.name);
    const intent = current.intents.campaign;
    // "sending" means this run really did reach the POST: only then may an
    // object that appeared since be our own. Anything else — no intent, a
    // rejected one, a confirmed one we already hold — is checked outright.
    const sending = intent?.phase === "sending";
    const matching = (await metaList(transport, `${account(ctx)}/campaigns`, { fields: "id,name" }))
      .filter(row => String(row.name) === name).map(row => String(row.id));
    const known = sending ? (current.campaign_name_taken ?? []) : matching.filter(id => id !== intent?.id);
    const collision = sending ? matching.filter(id => known.includes(id)) : known;
    if (collision.length) throw new Error(`The campid "${name}" is already used by a campaign on this ad account. Choose a different first campid.`);
    if (!sending) { current.campaign_name_taken = known; await save(ctx, current); }
    current.campaign_id = await create(ctx, transport, current, "campaign", "campaigns", campaignPayload, undefined, known);
    await save(ctx, current);
  }
  const multiple = sets.length > 1;
  const byValue = new Map(payloads.map(item => [`${item.content.kind}:${item.content.value}`, item]));
  for (const set of sets) {
    if (!set.id) {
      // An intent already sent keeps the start time it was sent with, so the
      // reconciliation after a lost response compares like with like.
      const sent = current.intents[`adset/${set.platform}`];
      const sentStart = sent && sent.phase !== "rejected" ? (sent.payload as { start_time?: string }).start_time : undefined;
      const adsetPayload: MetaObject = {
        name: `${ctx.run.external_id}/${ctx.campaign.index}/group/${set.platform}`, campaign_id: current.campaign_id,
        status: "PAUSED", destination_type: "WEBSITE", billing_event: "IMPRESSIONS", optimization_goal: settings.optimization_goal,
        bid_strategy: settings.bid_strategy, ...(settings.bid_strategy === "LOWEST_COST_WITH_BID_CAP" ? { bid_amount: amount(settings.bid_cents ?? 0) } : {}),
        start_time: sentStart ?? adSetStartTime(settings), end_time: settings.end_time,
        ...(set.daily_budget_cents === null ? { lifetime_budget: amount(set.budget_cents) } : { daily_budget: amount(set.daily_budget_cents) }),
        // Meta asks every new ad set whether Advantage+ audience may widen the
        // targeting beyond what was set; the approved audience is the audience.
        targeting: { geo_locations: { countries: settings.countries }, publisher_platforms: set.platforms, age_min: 18, targeting_automation: { advantage_audience: 0 } },
        // A conversions ad set names the pixel and the event it optimizes
        // toward, and the window its numbers are counted over (decision
        // 2026-09-25, "Meta conversions"). The pixel is the one re-checked
        // above, never the one the stored draft asks for on its own.
        ...(settings.optimization_goal === "OFFSITE_CONVERSIONS"
          ? { promoted_object: { pixel_id: requirePixel(ctx, current), custom_event_type: settings.conversion_event }, attribution_spec: META_ATTRIBUTION_SPEC }
          : {}),
      };
      set.id = await create(ctx, transport, current, `adset/${set.platform}`, "adsets", adsetPayload);
      rememberAdSet(current, set.platform, set.id);
      await save(ctx, current);
    }
    for (const content of set.content) {
      const item = byValue.get(`${content.kind}:${content.value}`);
      if (!item) throw new Error("Meta ad set holds content that is not part of the approved campaign.");
      const adKey = multiple ? `${set.platform}/${item.key}` : item.key;
      if (!current.creative_ids[item.key]) {
        current.creative_ids[item.key] = await create(ctx, transport, current, `creative/${item.key}`, "adcreatives", item.payload);
        await save(ctx, current);
      }
      if (!current.ad_ids[adKey]) {
        current.ad_ids[adKey] = await create(ctx, transport, current, `ad/${adKey}`, "ads", {
          name: `${ctx.run.external_id}/${ctx.campaign.index}/${adKey}`, adset_id: set.id,
          creative: { creative_id: current.creative_ids[item.key] }, status: "PAUSED",
        });
        current.content_values[current.ad_ids[adKey]] = item.content.value;
        current.ad_platforms = { ...current.ad_platforms, [adKey]: set.platform };
        current.ad_content_keys = { ...current.ad_content_keys, [adKey]: item.key };
        await save(ctx, current);
      }
    }
  }
  await hierarchy(ctx, transport, current, true);
  if (!ctx.run.draft.start_paused && !current.paused) await activate(ctx, transport, current);
}

async function hierarchy(ctx: DriverContext, transport: MetaTransport, current: MetaState, checkBudget = false) {
  const sets = adSetsOf(ctx, current);
  if (!current.campaign_id || !sets.length || sets.some(set => !set.id)) throw new Error("Meta launch hierarchy is incomplete.");
  const campaign = await transport.get(current.campaign_id, { fields: "id,account_id,status,effective_status,spend_cap" });
  if (String(campaign.account_id) !== ctx.connection.advertiser_id.replace(/^act_/, "")) throw new Error("Meta hierarchy does not match the assigned account.");
  const groups: { set: ResolvedAdSet; group: MetaObject }[] = [];
  for (const set of sets) {
    const group = await transport.get(set.id!, { fields: "id,account_id,campaign_id,status,effective_status,lifetime_budget,daily_budget,bid_amount,end_time" });
    if (String(group.campaign_id) !== current.campaign_id) throw new Error("Meta hierarchy does not match the assigned account.");
    groups.push({ set, group });
  }
  if (checkBudget) {
    assertCampaignBudget(ctx.run, ctx.campaign);
    // Every ad set of a campaign shares its one signed ceiling, so the read-back
    // is the sum across them, never one group's share.
    const lifetime = groups.reduce((sum, row) => sum + Number(row.group.lifetime_budget || 0), 0);
    const ceiling = ctx.campaign.daily_budget_cents === null ? lifetime : Number(campaign.spend_cap);
    if (ceiling !== ctx.campaign.budget_cents) throw new Error("Meta budget read-back differs from the approved lifetime ceiling.");
    const daily = groups.reduce((sum, row) => sum + Number(row.group.daily_budget || 0), 0);
    if (ctx.campaign.daily_budget_cents !== null && daily !== ctx.campaign.daily_budget_cents) throw new Error("Meta daily budget read-back differs from the approved pacing.");
  }
  const ads: MetaObject[] = [];
  for (const [adKey, adId] of Object.entries(current.ad_ids)) {
    const ad = await transport.get(adId, { fields: "id,account_id,adset_id,status,effective_status,issues_info,creative{id}" });
    const contentKey = current.ad_content_keys?.[adKey] ?? adKey;
    const platform = current.ad_platforms?.[adKey];
    const owner = platform ? groups.find(row => row.set.platform === platform)?.set.id : groups[0].set.id;
    if (String(ad.adset_id) !== owner || String((ad.creative as MetaObject | undefined)?.id) !== current.creative_ids[contentKey]) throw new Error("Meta ad does not belong to the approved ad set and creative.");
    ads.push(ad);
  }
  if (checkBudget) {
    for (const [contentKey, id] of Object.entries(current.creative_ids)) {
      const intent = current.intents[`creative/${contentKey}`];
      if (!intent) throw new Error("Meta creative has no frozen create intent.");
      const expected = matchFields("adcreatives", intent.payload);
      const creative = await transport.get(id, { fields: ["id", ...Object.keys(expected)].join(",") });
      if (!includes(creative, expected)) throw new Error("Meta creative read-back differs from the approved content, identity or destination.");
    }
  }
  return { campaign, groups, ads };
}

function controlMatches(observed: MetaObject, patch: MetaObject) {
  return Object.entries(patch).every(([field, expected]) => field === "end_time"
    ? Date.parse(String(observed[field])) === Date.parse(String(expected))
    : includes(observed[field], expected));
}

async function set(ctx: DriverContext, transport: MetaTransport, id: string, patch: MetaObject) {
  await ctx.assertActive();
  try { await transport.post(id, patch); }
  catch (error) {
    if (!(error instanceof MetaApiError) || !error.ambiguous) throw error;
    // Updating a known ID can be read back even if the response was lost.
    const observed = await transport.get(id, { fields: ["id", ...Object.keys(patch)].join(",") });
    if (!controlMatches(observed, patch)) throw error;
    return;
  }
  const readback = await transport.get(id, { fields: ["id", ...Object.keys(patch)].join(",") });
  if (!controlMatches(readback, patch)) throw new Error("Meta did not confirm the requested control state.");
}

async function activate(ctx: DriverContext, transport: MetaTransport, current: MetaState) {
  if (current.stopped) throw new Error("Ended Meta launches require a new round.");
  assertCampaignBudget(ctx.run, ctx.campaign);
  const sets = adSetsOf(ctx, current);
  const expectedAds = sets.reduce((sum, item) => sum + item.content.length, 0);
  if (Object.keys(current.ad_ids).length !== expectedAds) throw new Error("Meta activation requires every approved creative.");
  await hierarchy(ctx, transport, current, true);
  // Parent last: children remain unable to serve while activation is in progress.
  for (const id of Object.values(current.ad_ids)) await set(ctx, transport, id, { status: "ACTIVE" });
  for (const item of sets) await set(ctx, transport, item.id!, { status: "ACTIVE" });
  await set(ctx, transport, current.campaign_id!, { status: "ACTIVE" });
  current.activated = true;
  await save(ctx, current);
}

/** One `action_type` out of Meta's `actions` / `action_values` array, or null when it is not reported yet. */
function actionValue(rows: unknown, actionType: string): number | null {
  if (!Array.isArray(rows)) return null;
  const row = rows.find(item => item && typeof item === "object" && String((item as MetaObject).action_type) === actionType);
  return row ? metric((row as MetaObject).value) : null;
}
const centsOf = (value: number | null) => (value === null ? null : Math.round(value * 100));

function metric(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
async function monitor(ctx: DriverContext, transport: MetaTransport): Promise<DeliverySnapshot> {
  requireMeta(ctx, transport);
  const current = state(ctx);
  const base = { checked_at: new Date().toISOString(), spend_cents: null, impressions: null, clicks: null, conversions: null, conversion_value_cents: null, cpc_cents: null };
  if (!current.campaign_id || !adSetsOf(ctx, current).some(set => set.id)) return { ...base, delivery: ctx.campaign.status === "failed" ? "failed" : "submitted", note: ctx.campaign.error };
  const { campaign, groups, ads } = await hierarchy(ctx, transport, current);
  const report = await metaList(transport, `${current.campaign_id}/insights`, { fields: "spend,impressions,clicks,actions,action_values", date_preset: "maximum", level: "campaign" });
  const spend = metric(report[0]?.spend);
  const clicks = metric(report[0]?.clicks);
  // Conversions of the event this campaign was approved to optimize toward,
  // and what they were worth. Meta reports every action it attributes, so the
  // one we asked for is picked out by name rather than summed: an Add to cart
  // is not a purchase. A Traffic campaign has no event and stays null, which
  // is how the screens tell "none yet" from "not measured" apart.
  const event = ctx.run.draft.meta_settings.conversion_event;
  const conversions = event ? actionValue(report[0]?.actions, META_ACTION_TYPES[event]) : null;
  const conversion_value_cents = event ? centsOf(actionValue(report[0]?.action_values, META_ACTION_TYPES[event])) : null;
  const statuses = ads.map(ad => String(ad.effective_status || ad.status || "UNKNOWN"));
  const configured = String(campaign.status || "UNKNOWN");
  const effective = String(campaign.effective_status || configured);
  const ended = groups.every(row => Date.parse(String(row.group.end_time)) <= Date.now());
  const delivery = current.stopped || ["DELETED", "ARCHIVED"].includes(effective) || ended ? "ended"
    : statuses.includes("DISAPPROVED") ? "rejected"
    : ["WITH_ISSUES", "IN_PROCESS"].includes(effective) || statuses.includes("WITH_ISSUES") ? "suspended"
    : configured === "PAUSED" || groups.some(row => String(row.group.status) === "PAUSED") ? "paused"
    : statuses.some(status => ["PENDING_REVIEW", "IN_PROCESS", "PREAPPROVED"].includes(status)) ? "review"
    : effective === "ACTIVE" && statuses.length > 0 && statuses.every(status => status === "ACTIVE") ? "live" : "unknown";
  return {
    ...base, delivery, note: null, configured_status: configured, effective_status: effective,
    spend_cents: spend === null ? null : Math.round(spend * 100), impressions: metric(report[0]?.impressions), clicks,
    conversions, conversion_value_cents,
    cpc_cents: spend !== null && clicks !== null && clicks > 0 ? Math.round(spend * 100 / clicks) : null,
    ads: ads.map(ad => ({ id: String(ad.id), status: String(ad.effective_status || ad.status || "UNKNOWN"), content_value: current.content_values[String(ad.id)], ...(Array.isArray(ad.issues_info) && ad.issues_info.length ? { note: "Meta reports an ad review or delivery issue." } : {}) })),
    groups: groups.map(({ set: adSet, group }) => ({ id: adSet.id!, platform: adSet.platform, status: String(group.effective_status || group.status || "UNKNOWN"), budget_cents: Number(group.lifetime_budget || group.daily_budget) || undefined, bid_cents: metric(group.bid_amount), end_time: String(group.end_time || "") })),
  };
}

async function control(ctx: DriverContext, transport: MetaTransport, command: LaunchControl) {
  requireMeta(ctx, transport);
  const current = state(ctx);
  if (command.action === "duplicate") throw new Error("Create a new Meta round to duplicate a campaign with a separately approved budget.");
  if (!current.campaign_id) {
    if (command.action === "end") { current.stopped = true; await save(ctx, current); return; }
    if (command.action === "pause") { current.paused = true; await save(ctx, current); return; }
    if (command.action === "resume") throw new Error("Retry preparation to create every approved ad before explicitly resuming Meta delivery.");
    throw new Error("Meta campaign has not been created yet.");
  }
  if (command.action === "pause" || command.action === "end") {
    await set(ctx, transport, current.campaign_id, { status: "PAUSED" });
    current.paused = true;
    if (command.action === "end") current.stopped = true;
    await save(ctx, current);
    return;
  }
  if (current.stopped) throw new Error("Ended Meta launches require a new round.");
  assertCampaignBudget(ctx.run, ctx.campaign);
  assertPlannedAdSets(ctx);
  if (command.action === "resume") { await activate(ctx, transport, current); current.paused = false; await save(ctx, current); return; }
  const sets = adSetsOf(ctx, current);
  if (!sets.length || sets.some(item => !item.id)) throw new Error("Meta ad set has not been created yet.");
  await hierarchy(ctx, transport, current);
  if (command.action === "group") {
    const target = sets.find(item => item.id === command.group_id);
    if (!target) throw new Error("Ad set does not belong to this launch.");
    if (command.enabled) await hierarchy(ctx, transport, current, true);
    await set(ctx, transport, target.id!, { status: command.enabled ? "ACTIVE" : "PAUSED" });
  } else if (command.action === "budget") {
    assertCampaignBudget(ctx.run, ctx.campaign, command.budget_cents);
    const observed = await monitor(ctx, transport);
    if (observed.spend_cents !== null && command.budget_cents <= observed.spend_cents) throw new Error("New Meta lifetime budget must exceed recorded spend.");
    if (ctx.campaign.daily_budget_cents === null) {
      // The ceiling belongs to the campaign, so a change is re-split across its
      // ad sets exactly as the plan split the approved amount.
      const shares = splitAcross(command.budget_cents, sets.length);
      if (shares.some(share => share < META_MIN_BUDGET_CENTS)) throw new Error("Each Meta ad set needs at least $1 of allocated budget.");
      for (let i = 0; i < sets.length; i++) await set(ctx, transport, sets[i].id!, { lifetime_budget: shares[i] });
    } else {
      await set(ctx, transport, current.campaign_id, { spend_cap: command.budget_cents });
    }
  } else if (command.action === "daily_budget") {
    if (ctx.campaign.daily_budget_cents === null) throw new Error("Switching a Meta lifetime budget to daily pacing requires a new round.");
    const shares = splitAcross(amount(command.daily_budget_cents), sets.length);
    if (shares.some(share => share < META_MIN_BUDGET_CENTS)) throw new Error("Each Meta ad set needs at least $1 of daily budget.");
    await set(ctx, transport, current.campaign_id, { spend_cap: ctx.campaign.budget_cents });
    for (let i = 0; i < sets.length; i++) await set(ctx, transport, sets[i].id!, { daily_budget: shares[i] });
  } else if (command.action === "bid") {
    for (const item of sets) await set(ctx, transport, item.id!, { bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: amount(command.bid_cents) });
  } else if (command.action === "schedule") {
    if (!Number.isFinite(Date.parse(command.end_time)) || Date.parse(command.end_time) <= Date.now()) throw new Error("Meta schedule end must be in the future.");
    for (const item of sets) await set(ctx, transport, item.id!, { end_time: command.end_time });
  }
}

/**
 * The campaign names an ad account already carries, for preview: the driver
 * refuses a campid that collides, so the launch screen says so first. Read only
 * — the fixture's fake answers it exactly as Meta does.
 */
export async function listMetaCampaignNames(transport: MetaTransport, advertiserId: string): Promise<string[]> {
  const rows = await metaList(transport, `act_${advertiserId.replace(/^act_/, "")}/campaigns`, { fields: "id,name" });
  return [...new Set(rows.map(row => String(row.name ?? "")).filter(Boolean))];
}

export function createMetaDriver(transport: MetaTransport): LaunchDriver {
  return { launch: ctx => launch(ctx, transport), monitor: ctx => monitor(ctx, transport), control: (ctx, command) => control(ctx, transport, command) };
}
export const metaDriver: LaunchDriver = {
  launch: ctx => launch(ctx, metaTransport()), monitor: ctx => monitor(ctx, metaTransport()), control: (ctx, command) => control(ctx, metaTransport(), command),
};
