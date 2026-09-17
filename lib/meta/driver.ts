import { createHash } from "node:crypto";
import { readStoredBytes } from "@/lib/data/storage";
import { assertCampaignBudget } from "@/lib/launch/budget";
import type { DeliverySnapshot, DriverContext, LaunchContent, LaunchControl, LaunchDriver } from "@/lib/launch/types";
import { metaTransport } from "./index";
import { MetaApiError, metaList, type MetaObject, type MetaTransport } from "./transport";

type Intent = { edge: string; payload: MetaObject; phase: "sending" | "rejected" | "confirmed"; id?: string };
type MetaState = {
  version: 1; intents: Record<string, Intent>; campaign_id?: string; adset_id?: string;
  creative_ids: Record<string, string>; ad_ids: Record<string, string>; video_ids: Record<string, string>;
  content_values: Record<string, string>; stopped?: boolean; paused?: boolean; activated?: boolean;
};

function state(ctx: DriverContext): MetaState {
  const saved = ctx.campaign.state.meta as MetaState | undefined;
  return saved ? structuredClone(saved) : { version: 1, intents: {}, creative_ids: {}, ad_ids: {}, video_ids: {}, content_values: {} };
}
async function save(ctx: DriverContext, next: MetaState) { await ctx.checkpoint({ meta: structuredClone(next) }); }
function account(ctx: DriverContext) { return `act_${ctx.connection.advertiser_id.replace(/^act_/, "")}`; }
function key(content: LaunchContent, index: number) { return `${index}-${createHash("sha256").update(`${content.kind}:${content.value}`).digest("hex").slice(0, 16)}`; }
function amount(value: number) { if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Meta budget and bid amounts must be positive integer cents."); return value; }
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

/** Persist an intent before sending. A dropped POST is reconciled, never blindly repeated. */
async function create(ctx: DriverContext, transport: MetaTransport, current: MetaState, intentKey: string, edge: string, payload: MetaObject, bytes?: Uint8Array): Promise<string> {
  const existing = current.intents[intentKey];
  if (existing && (existing.edge !== edge || fingerprint(existing.payload) !== fingerprint(payload))) throw new Error("Meta create intent differs from the approved launch; start a new round.");
  if (existing?.id) return existing.id;
  if (existing?.phase === "sending") {
    const expected = matchFields(edge, payload);
    const fields = ["id", ...(edge === "advideos" ? [] : ["account_id"]), ...Object.keys(expected)].join(",");
    const candidates = (await metaList(transport, `${account(ctx)}/${edge}`, { fields })).filter(row =>
      (!row.account_id || String(row.account_id) === ctx.connection.advertiser_id.replace(/^act_/, "")) && includes(row, expected));
    if (candidates.length !== 1) throw new Error(`Meta ${edge} create outcome is ambiguous (${candidates.length} matches). Reconcile the recorded intent before retrying.`);
    const id = String(candidates[0].id);
    current.intents[intentKey] = { ...existing, id, phase: "confirmed" };
    await save(ctx, current);
    return id;
  }
  current.intents[intentKey] = { edge, payload, phase: "sending" };
  await save(ctx, current);
  await ctx.assertActive();
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

async function readAccount(ctx: DriverContext, transport: MetaTransport) {
  const result = await transport.get(account(ctx), { fields: "id,account_status,currency,timezone_name" });
  if (Number(result.account_status) !== 1) throw new Error("Meta ad account is not active.");
  if (result.currency !== ctx.connection.currency) throw new Error("Meta account currency differs from the approved connection.");
  if (ctx.run.draft.meta_settings.placements.includes("instagram")) {
    if (!ctx.connection.instagram_id) throw new Error("Instagram placements require an assigned Instagram identity.");
    const identities = await metaList(transport, `${account(ctx)}/instagram_accounts`, { fields: "id" });
    if (!identities.some(row => row.id === ctx.connection.instagram_id)) throw new Error("Instagram identity is not available to this ad account.");
  }
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
  if (!Number.isFinite(Date.parse(settings.start_time)) || Date.parse(settings.end_time) <= Date.parse(settings.start_time)) throw new Error("Meta needs a valid start and end time.");
  await readAccount(ctx, transport);
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
      if (status !== "ready") throw new Error(status === "error" ? "Meta video processing failed; campaign remains paused." : "Meta is processing the clip. Retry to continue without re-uploading.");
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
    name: ctx.campaign.campid ?? `${ctx.run.external_id}/${ctx.campaign.index}`, objective: "OUTCOME_TRAFFIC", special_ad_categories: [], status: "PAUSED",
    ...(daily !== null ? { spend_cap: ctx.campaign.budget_cents } : {}),
  };
  if (!current.campaign_id) {
    current.campaign_id = await create(ctx, transport, current, "campaign", "campaigns", campaignPayload);
    await save(ctx, current);
  }
  const adsetPayload: MetaObject = {
    name: `${ctx.run.external_id}/${ctx.campaign.index}/group`, campaign_id: current.campaign_id,
    status: "PAUSED", destination_type: "WEBSITE", billing_event: "IMPRESSIONS", optimization_goal: settings.optimization_goal,
    bid_strategy: settings.bid_strategy, ...(settings.bid_strategy === "LOWEST_COST_WITH_BID_CAP" ? { bid_amount: amount(settings.bid_cents ?? 0) } : {}),
    start_time: settings.start_time, end_time: settings.end_time,
    ...(daily === null ? { lifetime_budget: ctx.campaign.budget_cents } : { daily_budget: daily }),
    targeting: { geo_locations: { countries: settings.countries }, publisher_platforms: settings.placements, age_min: 18 },
  };
  if (!current.adset_id) { current.adset_id = await create(ctx, transport, current, "adset", "adsets", adsetPayload); await save(ctx, current); }
  for (const item of payloads) {
    if (!current.creative_ids[item.key]) {
      current.creative_ids[item.key] = await create(ctx, transport, current, `creative/${item.key}`, "adcreatives", item.payload);
      await save(ctx, current);
    }
    if (!current.ad_ids[item.key]) {
      current.ad_ids[item.key] = await create(ctx, transport, current, `ad/${item.key}`, "ads", {
        name: `${ctx.run.external_id}/${ctx.campaign.index}/${item.key}`, adset_id: current.adset_id,
        creative: { creative_id: current.creative_ids[item.key] }, status: "PAUSED",
      });
      current.content_values[current.ad_ids[item.key]] = item.content.value;
      await save(ctx, current);
    }
  }
  await hierarchy(ctx, transport, current, true);
  if (!ctx.run.draft.start_paused && !current.paused) await activate(ctx, transport, current);
}

async function hierarchy(ctx: DriverContext, transport: MetaTransport, current: MetaState, checkBudget = false) {
  if (!current.campaign_id || !current.adset_id) throw new Error("Meta launch hierarchy is incomplete.");
  const campaign = await transport.get(current.campaign_id, { fields: "id,account_id,status,effective_status,spend_cap" });
  const group = await transport.get(current.adset_id, { fields: "id,account_id,campaign_id,status,effective_status,lifetime_budget,daily_budget,bid_amount,end_time" });
  if (String(campaign.account_id) !== ctx.connection.advertiser_id.replace(/^act_/, "") || String(group.campaign_id) !== current.campaign_id) throw new Error("Meta hierarchy does not match the assigned account.");
  if (checkBudget) {
    assertCampaignBudget(ctx.run, ctx.campaign);
    const ceiling = ctx.campaign.daily_budget_cents === null ? Number(group.lifetime_budget) : Number(campaign.spend_cap);
    if (ceiling !== ctx.campaign.budget_cents) throw new Error("Meta budget read-back differs from the approved lifetime ceiling.");
    if (ctx.campaign.daily_budget_cents !== null && Number(group.daily_budget) !== ctx.campaign.daily_budget_cents) throw new Error("Meta daily budget read-back differs from the approved pacing.");
  }
  const ads: MetaObject[] = [];
  for (const adId of Object.values(current.ad_ids)) {
    const ad = await transport.get(adId, { fields: "id,account_id,adset_id,status,effective_status,issues_info,creative{id}" });
    const contentKey = Object.keys(current.ad_ids).find(key => current.ad_ids[key] === adId)!;
    if (String(ad.adset_id) !== current.adset_id || String((ad.creative as MetaObject | undefined)?.id) !== current.creative_ids[contentKey]) throw new Error("Meta ad does not belong to the approved ad set and creative.");
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
  return { campaign, group, ads };
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
  if (Object.keys(current.ad_ids).length !== ctx.campaign.content.length) throw new Error("Meta activation requires every approved creative.");
  await hierarchy(ctx, transport, current, true);
  // Parent last: children remain unable to serve while activation is in progress.
  for (const id of Object.values(current.ad_ids)) await set(ctx, transport, id, { status: "ACTIVE" });
  await set(ctx, transport, current.adset_id!, { status: "ACTIVE" });
  await set(ctx, transport, current.campaign_id!, { status: "ACTIVE" });
  current.activated = true;
  await save(ctx, current);
}

function metric(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
async function monitor(ctx: DriverContext, transport: MetaTransport): Promise<DeliverySnapshot> {
  requireMeta(ctx, transport);
  const current = state(ctx);
  const base = { checked_at: new Date().toISOString(), spend_cents: null, impressions: null, clicks: null, conversions: null, cpc_cents: null };
  if (!current.campaign_id || !current.adset_id) return { ...base, delivery: ctx.campaign.status === "failed" ? "failed" : "submitted", note: ctx.campaign.error };
  const { campaign, group, ads } = await hierarchy(ctx, transport, current);
  const report = await metaList(transport, `${current.campaign_id}/insights`, { fields: "spend,impressions,clicks", date_preset: "maximum", level: "campaign" });
  const spend = metric(report[0]?.spend);
  const clicks = metric(report[0]?.clicks);
  const statuses = ads.map(ad => String(ad.effective_status || ad.status || "UNKNOWN"));
  const configured = String(campaign.status || "UNKNOWN");
  const effective = String(campaign.effective_status || configured);
  const delivery = current.stopped || ["DELETED", "ARCHIVED"].includes(effective) || Date.parse(String(group.end_time)) <= Date.now() ? "ended"
    : statuses.includes("DISAPPROVED") ? "rejected"
    : ["WITH_ISSUES", "IN_PROCESS"].includes(effective) || statuses.includes("WITH_ISSUES") ? "suspended"
    : configured === "PAUSED" || String(group.status) === "PAUSED" ? "paused"
    : statuses.some(status => ["PENDING_REVIEW", "IN_PROCESS", "PREAPPROVED"].includes(status)) ? "review"
    : effective === "ACTIVE" && statuses.length > 0 && statuses.every(status => status === "ACTIVE") ? "live" : "unknown";
  return {
    ...base, delivery, note: null, configured_status: configured, effective_status: effective,
    spend_cents: spend === null ? null : Math.round(spend * 100), impressions: metric(report[0]?.impressions), clicks,
    cpc_cents: spend !== null && clicks !== null && clicks > 0 ? Math.round(spend * 100 / clicks) : null,
    ads: ads.map(ad => ({ id: String(ad.id), status: String(ad.effective_status || ad.status || "UNKNOWN"), content_value: current.content_values[String(ad.id)], ...(Array.isArray(ad.issues_info) && ad.issues_info.length ? { note: "Meta reports an ad review or delivery issue." } : {}) })),
    groups: [{ id: current.adset_id!, status: String(group.effective_status || group.status || "UNKNOWN"), budget_cents: Number(group.lifetime_budget || group.daily_budget) || undefined, bid_cents: metric(group.bid_amount), end_time: String(group.end_time || "") }],
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
  if (command.action === "resume") { await activate(ctx, transport, current); current.paused = false; await save(ctx, current); return; }
  if (!current.adset_id) throw new Error("Meta ad set has not been created yet.");
  await hierarchy(ctx, transport, current);
  if (command.action === "group") {
    if (command.group_id !== current.adset_id) throw new Error("Ad set does not belong to this launch.");
    if (command.enabled) await hierarchy(ctx, transport, current, true);
    await set(ctx, transport, current.adset_id, { status: command.enabled ? "ACTIVE" : "PAUSED" });
  } else if (command.action === "budget") {
    assertCampaignBudget(ctx.run, ctx.campaign, command.budget_cents);
    const observed = await monitor(ctx, transport);
    if (observed.spend_cents !== null && command.budget_cents <= observed.spend_cents) throw new Error("New Meta lifetime budget must exceed recorded spend.");
    await set(ctx, transport, ctx.campaign.daily_budget_cents === null ? current.adset_id : current.campaign_id, ctx.campaign.daily_budget_cents === null ? { lifetime_budget: command.budget_cents } : { spend_cap: command.budget_cents });
  } else if (command.action === "daily_budget") {
    if (ctx.campaign.daily_budget_cents === null) throw new Error("Switching a Meta lifetime budget to daily pacing requires a new round.");
    await set(ctx, transport, current.campaign_id, { spend_cap: ctx.campaign.budget_cents });
    await set(ctx, transport, current.adset_id, { daily_budget: amount(command.daily_budget_cents) });
  } else if (command.action === "bid") {
    await set(ctx, transport, current.adset_id, { bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: amount(command.bid_cents) });
  } else if (command.action === "schedule") {
    if (!Number.isFinite(Date.parse(command.end_time)) || Date.parse(command.end_time) <= Date.now()) throw new Error("Meta schedule end must be in the future.");
    await set(ctx, transport, current.adset_id, { end_time: command.end_time });
  }
}

export function createMetaDriver(transport: MetaTransport): LaunchDriver {
  return { launch: ctx => launch(ctx, transport), monitor: ctx => monitor(ctx, transport), control: (ctx, command) => control(ctx, transport, command) };
}
export const metaDriver: LaunchDriver = {
  launch: ctx => launch(ctx, metaTransport()), monitor: ctx => monitor(ctx, metaTransport()), control: (ctx, command) => control(ctx, metaTransport(), command),
};
