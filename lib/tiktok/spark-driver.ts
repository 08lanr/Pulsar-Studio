// The TikTok launch driver. Three kinds of content become ads here:
//   a Spark code   overlord's authorize -> authorized-post list -> AUTH_CODE ad
//   a post of the linked account   its item id under the TikTok account
//                  Business Center links to the ad account (BC_AUTH_TT), no code
//   a Studio clip  the approved file, re-hashed, uploaded to the ad account,
//                  TikTok's suggested cover, and an ad under the linked account
//                  shown only as an ad (dark_post_status ON: never on the
//                  profile), carrying the clip's text (decision 2026-09-25)
// The approved launch record supplies every account, code, clip, destination
// and money ceiling; the linked account is picked by the preview's rule and
// recorded before the first write.
import { createHash } from "node:crypto";
import type { AdStats, DeliverySnapshot, DriverContext, LaunchContent, LaunchControl, LaunchDriver } from "@/lib/launch/types";
import { TIKTOK_CONTENT_KINDS, tiktokAdText } from "@/lib/launch/plan";
import { LaunchWaiting } from "@/lib/launch/waiting";
import { readStoredBytes } from "@/lib/data/storage";
import { findLinkedPost, linkedAccountHandle, linkedAccountMissing, linkedNeeds, listLinkedAccounts, pickLinkedAccount, tiktokPostUrl, type LinkedAccount } from "./linked-account";
import { accessTokenFor, tiktokTransport, type TikTokResponse, type TikTokTransport } from "./index";
import { normalizeReview } from "./review";
import { accountHealth, accountStatusLabel } from "./account-health";
import { adGroupBody, attributionLabel, attributionOf, launchSettingsSchema, launchShape, planAdGroup, validateLaunchSettings, type AdGroupPlan, type LaunchSettings } from "./settings";
import { isCrazydramasAdUrl } from "./ad-url";
import { resolvePixel, tiktokPixelCode } from "./pixel";
import { WEB_METRICS, webConversionsFromReport } from "./web-metrics";
import { AD_METRICS, adStatsByAd } from "./ad-stats";
import { assertCampaignBudget } from "@/lib/launch/budget";
import { createInstantPageDraft, InstantPageCreateNotSentError, InstantPageCreateRejectedError, loadSalesMasterSnapshot, publishInstantPage } from "./instant-page";
import { SALES_MASTER_SHA256, SALES_MASTER_VERSION } from "./instant-page-master";

/**
 * One ad's content, resolved before any campaign exists. `code` is the
 * content's value (a Spark code, a post id, a clip id) and keys the ad in
 * every group. Without `kind` it is a redeemed Spark code (AUTH_CODE).
 */
export type SparkPost = {
  code: string; item_id: string; identity_id: string; item_type: string;
  kind?: "tiktok_post" | "video";
  /** BC_AUTH_TT: the Business Center that links the account. */
  bc_id?: string;
  /** A Studio clip: its uploaded video, its cover, and the words under it. */
  video_id?: string; image_id?: string; ad_text?: string;
};
type SkippedSpark = { code: string; reason: string };
type SparkGroup = { id: string; key: string; ads: Record<string, string>; retired?: boolean; ready?: boolean };
type SparkState = {
  campaign_id?: string; posts?: SparkPost[]; skipped?: SkippedSpark[]; groups?: SparkGroup[];
  /** The linked TikTok account Studio clips and posts run as, picked once, before any write. */
  identity?: LinkedAccount | null;
  /** Each Studio clip's upload, by clip id, recorded as it lands so a resumed launch never uploads it twice. */
  uploads?: Record<string, { video_id: string; image_id?: string }>;
  settings?: LaunchSettings; plan?: AdGroupPlan; budget_cents?: number; daily_budget_cents?: number | null;
  planned_budgets?: number[];
  instant_page?: { name: string; phase: "creating" | "created" | "published"; id?: string } | null;
  /** Website purchases: the pixel resolved on this ad account before anything was written (lib/tiktok/pixel.ts); `unverified` when the id was set by hand. */
  pixel?: { code: string; pixel_id: string; unverified?: true } | null;
  activated?: boolean; ended?: boolean; tiktok_mode?: string;
  pending_copy?: { key: string; allocations: Record<string, number>; new_budget: number; was_on: boolean } | null;
  pending_bid?: { bid_cents: number; was_on: boolean; replacements: { old_id: string; key: string; budget: number; enabled: boolean }[] } | null;
};
type Client = { tt: TikTokTransport; token: string; advertiser: string };
type Row = Record<string, unknown>;
const state = (ctx: DriverContext) => ctx.campaign.state as SparkState;
/** The approved link this campaign's website ads carry: the signed row's, or the draft's on rows approved before rows had one. */
const landingUrl = (ctx: DriverContext) => ctx.campaign.tracking_url ?? ctx.run.draft.destination_url;
/**
 * The link one Spark ad carries: its own title's (each Spark code row may
 * promote its own title; the approved row holds the link the server wrote),
 * else the campaign's on rows approved before per-ad titles.
 */
const adLanding = (ctx: DriverContext, code: string) =>
  ctx.campaign.content.find((item) => item.value.trim() === code)?.landing_url ?? landingUrl(ctx);
/** What names an ad and finds it again: the post it plays, or the uploaded video. */
const adRef = (post: SparkPost) => post.item_id || `v${post.video_id ?? ""}`;
const shapeOf = (s: SparkState) => (s.settings ? launchShape(s.settings) : "traffic");
const str = (v: unknown) => v === undefined || v === null ? "" : String(v);
const number = (v: unknown): number | null => v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const cents = (v: unknown): number | null => { const n = number(v); return n === null ? null : Math.round(n * 100); };
const activeGroups = (s: SparkState) => (s.groups ?? []).filter((g) => !g.retired);
// Only a specific creative verdict can remove an approved post from a group.
// A throttle, transport failure, or unfamiliar TikTok response leaves it due.
const permanentAdRejection = (reason: string) => /(?:spark )?creative not valid|invalid spark ad|(?:post|auth(?:orization)?|identity).*(?:invalid|expired|private|deleted|not found)/i.test(reason);
const groupComplete = (s: SparkState, group: SparkGroup) => (s.posts ?? []).every((post) =>
  !!group.ads[post.code] || (s.skipped ?? []).some((item) => item.code === post.code && permanentAdRejection(item.reason)));
function assertBudgetState(ctx: DriverContext): void {
  assertCampaignBudget(ctx.run, ctx.campaign);
  const s = state(ctx);
  if (s.budget_cents !== undefined) assertCampaignBudget(ctx.run, ctx.campaign, s.budget_cents);
  const limit = s.daily_budget_cents ?? s.budget_cents;
  if (limit !== undefined && s.planned_budgets && s.planned_budgets.reduce((sum, value) => sum + value, 0) > limit) {
    throw new Error("Planned ad groups exceed the approved campaign budget; create and approve a new round.");
  }
}
function requireReadyGroups(s: SparkState, ids: string[]): void {
  if (ids.some((id) => {
    const group = activeGroups(s).find((item) => item.id === id);
    return !group?.ready || !groupComplete(s, group);
  })) throw new Error("An ad group has pending Sparks; retry the launch before activation.");
}
const requireOk = (res: TikTokResponse, operation: string) => {
  if (res.code !== 0) throw new Error(`${operation}: ${res.message || "TikTok did not confirm the request"}`);
  return res.data ?? {};
};

function client(ctx: DriverContext): Client {
  const tt = tiktokTransport();
  if ((ctx.run.mode === "fake") !== (tt.mode === "fake")) throw new Error("The launch environment changed; refusing to use a different TikTok environment.");
  if (state(ctx).tiktok_mode && state(ctx).tiktok_mode !== tt.mode) throw new Error("The TikTok sandbox/production setting changed since this launch started.");
  const token = accessTokenFor(ctx.campaign.advertiser_id);
  if (!token) throw new Error("No TikTok connection covers this ad account.");
  return { tt, token, advertiser: ctx.campaign.advertiser_id };
}

/** BC discovery does not include currency. Read the actual advertiser before
 * authorizing a post or committing any spend-bearing object, never trust a
 * legacy connection's assumed USD value. Unknown account state is refused. */
async function verifyAccount(c: Client): Promise<void> {
  const data = requireOk(await c.tt.get("/advertiser/info/", c.token, {
    advertiser_ids: JSON.stringify([c.advertiser]), fields: JSON.stringify(["advertiser_id", "currency", "status"]),
  }), "Verify TikTok account");
  const account = ((data.list ?? []) as Row[]).find((a) => str(a.advertiser_id) === c.advertiser);
  if (!account) throw new Error("TikTok did not return the assigned advertising account.");
  if (account.currency !== "USD") throw new Error(`TikTok account currency is ${str(account.currency) || "unknown"}; this approved launch is in USD.`);
  if (accountHealth(str(account.status)) !== "ready") throw new Error(`TikTok account is not ready: ${accountStatusLabel(str(account.status))}.`);
}

/** Pagination is mandatory for adoption: failure to list must never mean absent. */
async function list(c: Client, path: string, params: Record<string, string | number> = {}): Promise<Row[]> {
  const rows: Row[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > 1000) throw new Error(`${path}: pagination limit reached; refusing an incomplete lookup`);
    const pageSize = path === "/tt_video/list/" ? 50 : 100;
    const data = requireOk(await c.tt.get(path, c.token, { advertiser_id: c.advertiser, ...params, page, page_size: pageSize }), path);
    if (!Array.isArray(data.list)) throw new Error(`${path}: TikTok returned no list; refusing an incomplete lookup`);
    rows.push(...(data.list as Row[]));
    const pages = (data.page_info as { total_page?: number } | undefined)?.total_page;
    if (pages === undefined && data.list.length >= pageSize) throw new Error(`${path}: pagination information is missing; refusing an incomplete lookup`);
    total = pages === undefined ? 1 : Math.max(1, Number(pages));
    if (!Number.isSafeInteger(total)) throw new Error(`${path}: invalid pagination information`);
  }
  return rows;
}

const preparationPaused = (ctx: DriverContext) => !!ctx.campaign.state.desired_status || ctx.campaign.state.prepare_while_paused === true;
async function write(ctx: DriverContext, c: Client, path: string, body: Row, preparation = false): Promise<TikTokResponse> {
  await ctx.assertActive();
  if (preparation && body.operation_status === "ENABLE" && preparationPaused(ctx)) throw new Error("Activation stopped because this launch was paused during preparation.");
  return c.tt.post(path, c.token, { advertiser_id: c.advertiser, ...body });
}

/** Reauthorization can fail on a resumed run; the paginated post list is truth. */
export async function redeemSparkCodes(c: Client, codes: string[], beforeWrite: () => Promise<void>): Promise<{ posts: SparkPost[]; skipped: SkippedSpark[] }> {
  const wanted = [...new Set(codes.map((code) => code.trim()).filter(Boolean))];
  const errors = new Map<string, string>();
  for (const code of wanted) {
    await beforeWrite();
    let result = await c.tt.post("/tt_video/authorize/", c.token, { advertiser_id: c.advertiser, auth_code: code });
    if (result.code !== 0 && /QPS limit/i.test(result.message)) {
      // The central transport paces all calls; the extra delay is Overlord's
      // single authorize retry for the endpoint's stricter QPS ceiling.
      if (c.tt.mode !== "fake") await new Promise((resolve) => setTimeout(resolve, 1500));
      await beforeWrite();
      result = await c.tt.post("/tt_video/authorize/", c.token, { advertiser_id: c.advertiser, auth_code: code });
    }
    if (result.code !== 0) errors.set(code, result.message || "authorization rejected");
  }
  const resolved = new Map<string, SparkPost>();
  for (const entry of await list(c, "/tt_video/list/")) {
    const item = entry.item_info as Row | undefined;
    const user = entry.user_info as Row | undefined;
    const code = str(item?.auth_code);
    if (wanted.includes(code) && item?.item_id && user?.identity_id) resolved.set(code, {
      code, item_id: str(item.item_id), identity_id: str(user.identity_id), item_type: str(item.item_type),
    });
  }
  return {
    posts: wanted.flatMap((code) => resolved.has(code) ? [resolved.get(code)!] : []),
    skipped: wanted.filter((code) => !resolved.has(code)).map((code) => ({ code, reason: errors.get(code) ?? "Redeemed but absent from this account's authorized post list" })),
  };
}

/**
 * The linked account this campaign's clips and posts run as: picked by the
 * preview's rule (lib/tiktok/linked-account.ts) and recorded before the first
 * write, so a resumed launch never switches accounts halfway.
 */
async function ensureLinkedAccount(ctx: DriverContext, c: Client): Promise<LinkedAccount> {
  const recorded = state(ctx).identity;
  if (recorded) return recorded;
  const needs = linkedNeeds(ctx.campaign.content);
  const account = pickLinkedAccount(await listLinkedAccounts(c.tt, c.token, c.advertiser), needs);
  if (!account) throw new Error(linkedAccountMissing(needs, ctx.connection?.name || c.advertiser));
  await ctx.checkpoint({ identity: account });
  return account;
}

/** TikTok answers an upload with a bare array in sandbox and an object in production; either carries the video id. */
function uploadedVideoId(res: TikTokResponse): string {
  const data = res.data as unknown;
  const first = Array.isArray(data) ? (data[0] as Row | undefined) : undefined;
  const object = (Array.isArray(data) ? undefined : data) as (Row & { list?: Row[] }) | undefined;
  return str(first?.video_id ?? object?.video_id ?? object?.list?.[0]?.video_id);
}

/**
 * One approved Studio clip in the ad account: the bytes read back and held
 * against the approved SHA-256, uploaded once, then TikTok's suggested cover
 * uploaded as the ad's image. Each id is recorded the moment it exists. A
 * cover TikTok has not made yet (the video is still processing) is a wait,
 * never a failure; any other refusal fails with TikTok's words.
 */
async function uploadClip(ctx: DriverContext, c: Client, item: LaunchContent): Promise<{ video_id: string; image_id: string }> {
  const uploads = { ...(state(ctx).uploads ?? {}) };
  let done = uploads[item.value];
  if (!done?.video_id) {
    if (!item.file_path || !item.sha256) throw new Error("A Studio clip in this launch has no approved file. Create a new round from the clip.");
    const bytes = await readStoredBytes(item.file_path);
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new Error("A Studio clip changed after this launch was approved; nothing was uploaded. Create a new round.");
    await ctx.assertActive();
    // A name of its own per attempt: an upload whose answer was lost is sent
    // again under a new name (a spare copy in the ad account's library, which
    // runs nothing), never refused as a clash.
    const fileName = `studio-${ctx.run.external_id}-${ctx.campaign.index}-${item.value.slice(0, 8)}-${Date.now()}.mp4`;
    const res = await c.tt.upload("/file/video/ad/upload/", c.token, {
      advertiser_id: c.advertiser, upload_type: "UPLOAD_BY_FILE", video_signature: createHash("md5").update(bytes).digest("hex"),
      file_name: fileName, video_file: { data: bytes, filename: fileName },
    });
    const videoId = uploadedVideoId(res);
    if (res.code !== 0 || !videoId) throw new Error(`Upload a Studio clip to TikTok: ${res.message || "TikTok returned no video id"}`);
    done = { video_id: videoId };
    uploads[item.value] = done;
    await ctx.checkpoint({ uploads });
  }
  if (!done.image_id) {
    const suggest = await c.tt.get("/file/video/suggestcover/", c.token, { advertiser_id: c.advertiser, video_id: done.video_id });
    if (suggest.code !== 0) throw new Error(`Read the cover TikTok made for a Studio clip: ${suggest.message || "TikTok did not answer"}`);
    const coverUrl = str(((suggest.data?.list ?? []) as Row[])[0]?.cover_url);
    if (!coverUrl) throw new LaunchWaiting("TikTok is still processing an uploaded Studio clip; its cover will be ready in a minute.", 30_000);
    await ctx.assertActive();
    const up = await c.tt.post("/file/image/ad/upload/", c.token, { advertiser_id: c.advertiser, upload_type: "UPLOAD_BY_URL", image_url: coverUrl, file_name: `studio-cover-${done.video_id}-${Date.now()}.jpg` });
    const imageId = str((up.data as Row | undefined)?.image_id);
    if (up.code !== 0 || !imageId) throw new Error(`Upload a Studio clip's cover to TikTok: ${up.message || "TikTok returned no image id"}`);
    done = { ...done, image_id: imageId };
    uploads[item.value] = done;
    await ctx.checkpoint({ uploads });
  }
  return { video_id: done.video_id, image_id: done.image_id! };
}

/**
 * Every ad's content, resolved before a campaign exists: Spark codes
 * redeemed (the authorized-post list is truth), the linked account's posts
 * read back as still its own, Studio clips uploaded. Kept in the draft's
 * order; what cannot be used is skipped with the reason.
 */
async function resolveContent(ctx: DriverContext, c: Client): Promise<void> {
  const content = ctx.campaign.content;
  const found: SparkPost[] = [];
  const skipped: SkippedSpark[] = [];
  const codes = content.filter((item) => item.kind === "spark").map((item) => item.value);
  if (codes.length) {
    const redeemed = await redeemSparkCodes(c, codes, ctx.assertActive);
    found.push(...redeemed.posts); skipped.push(...redeemed.skipped);
  }
  if (content.some((item) => item.kind === "video" || item.kind === "tiktok_post")) {
    const account = await ensureLinkedAccount(ctx, c);
    const linked = { identity_id: account.identity_id, bc_id: account.bc_id };
    for (const item of content) {
      const code = item.value.trim();
      if (item.kind === "tiktok_post") {
        const post = await findLinkedPost(c.tt, c.token, c.advertiser, account, code);
        if (post) found.push({ code, kind: "tiktok_post", item_id: post.item_id, item_type: post.item_type, ...linked });
        else skipped.push({ code, reason: `Post ${code} is no longer a post of ${linkedAccountHandle(account)} (deleted, made private or another account's)` });
      } else if (item.kind === "video") {
        const upload = await uploadClip(ctx, c, item);
        found.push({ code, kind: "video", item_id: "", item_type: "VIDEO", ...linked, video_id: upload.video_id, image_id: upload.image_id, ad_text: tiktokAdText(item) });
      }
    }
  }
  const posts = content.flatMap((item) => found.filter((post) => post.code === item.value.trim()).slice(0, 1));
  await ctx.checkpoint({ posts, skipped });
  if (!posts.length) {
    const reasons = skipped.map((s) => s.reason).join(" · ");
    throw new Error(content.every((item) => item.kind === "spark")
      ? `No Spark code resolved; no campaign or ad group was created. ${reasons}`
      : `No ad could be prepared; no campaign or ad group was created. ${reasons}`);
  }
}

function names(ctx: DriverContext) {
  // Put the unique key FIRST so truncating a long human label cannot erase it.
  const prefix = `studio-${ctx.run.id}-${ctx.campaign.index}`;
  return {
    campaign: ctx.campaign.campid ?? `${prefix}-${ctx.campaign.name}`.slice(0, 100),
    group: (key: string) => `${prefix}-${key}`.slice(0, 100),
    ad: (key: string, item: string) => `${prefix}-${key}-${item}`.slice(0, 100),
  };
}

/**
 * TikTok's public listing of an advertiser's Instant Pages (the builder itself
 * has no read). Only `business_type` TIKTOK_INSTANT_PAGE returns Sales pages;
 * without it the endpoint answers an empty list (overlord, verified live).
 */
async function findInstantPageByName(c: Client, name: string): Promise<{ id: string | null; error?: string }> {
  const rows: Row[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await c.tt.get("/page/get/", c.token, { advertiser_id: c.advertiser, business_type: "TIKTOK_INSTANT_PAGE", page, page_size: 50 });
    if (res.code !== 0) return { id: null, error: res.message || "TikTok did not list Instant Pages" };
    const list = (res.data?.list ?? []) as Row[];
    rows.push(...list);
    const pages = (res.data?.page_info as { total_page?: number } | undefined)?.total_page ?? 1;
    if (page >= pages || list.length < 50) break;
  }
  const matches = rows.filter((r) => str(r.title ?? r.page_name ?? r.name) === name);
  if (matches.length > 1) return { id: null, error: `TikTok lists ${matches.length} Instant Pages named ${name}` };
  return { id: matches.length ? str(matches[0].page_id ?? matches[0].id) : null };
}

/**
 * Website purchases: the pixel must be usable on this ad account before any
 * TikTok write (the Spark authorizations included), so a launch on an account
 * the pixel is not shared with creates nothing. The code is the signed one
 * (stamped into the draft on save); the numeric id is resolved read-only and
 * recorded, and a retry reuses the recorded id. The resolution is the
 * preview's (resolvePixel): while TikTok refuses the pixel read for want of
 * the permission, TIKTOK_PIXEL_ID stands in and is recorded as unverified;
 * the ad group's create is then TikTok's own check of it. An unverified id
 * is resolved again on every attempt until an ad group is recorded, so a
 * corrected setting (or TikTok's own answer, once the permission arrives)
 * takes effect on Retry; after that the recorded id is the group's.
 */
async function ensurePixel(ctx: DriverContext, c: Client): Promise<void> {
  const settings = state(ctx).settings;
  if (!settings || launchShape(settings) !== "website_purchases") return;
  if (!isCrazydramasAdUrl(landingUrl(ctx)) || ctx.campaign.content.some((item) => item.landing_url !== undefined && !isCrazydramasAdUrl(item.landing_url)))
    throw new Error("This Website purchases launch has no crazydramas ad link; create a new round from the title.");
  const code = settings.pixel_code ?? tiktokPixelCode();
  const recorded = state(ctx).pixel;
  if (recorded?.code === code && recorded.pixel_id && (!recorded.unverified || (state(ctx).groups ?? []).length > 0)) return;
  const found = await resolvePixel(c.tt, c.token, c.advertiser, code, { businessCenterId: ctx.connection?.business_id ?? null });
  if (!found.ok) throw new Error(found.message);
  await ctx.checkpoint({ pixel: found.relation === "UNVERIFIED" ? { code, pixel_id: found.pixel_id, unverified: true } : { code, pixel_id: found.pixel_id } });
}

async function ensureSalesPage(ctx: DriverContext): Promise<void> {
  const settings = state(ctx).settings;
  if (!settings || launchShape(settings) !== "instant_page") return;
  const design = settings.instant_page_template;
  if (!design || design.master_version !== SALES_MASTER_VERSION || design.master_sha256 !== SALES_MASTER_SHA256)
    throw new Error("The approved Instant Page template or master version is unavailable.");
  const master = loadSalesMasterSnapshot();
  if (master.sha256 !== design.master_sha256) throw new Error("The approved Instant Page master changed; refusing to create a page.");
  const pageName = `studio-tip-${ctx.run.id}-${ctx.campaign.index}`;
  let page = state(ctx).instant_page;
  if (page && page.name !== pageName) throw new Error("The saved Instant Page intent differs from this approved campaign.");
  if (page?.phase === "creating" && !page.id) {
    // The create was sent and its answer lost. The page name is unique to this
    // campaign, so TikTok's own listing settles it: exactly one page of that
    // name is ours and is adopted; none means the create never landed and it
    // is sent again; anything else is reconciled by a person, never guessed.
    const found = await findInstantPageByName(client(ctx), pageName);
    if (found.error) throw new Error(`Instant Page creation has an uncertain result and TikTok's page list could not settle it (${found.error}). Reconcile the page named ${pageName} in TikTok before retrying; no duplicate page will be created automatically.`);
    if (found.id) await ctx.checkpoint({ instant_page: { name: pageName, phase: "created", id: found.id } });
    else await ctx.checkpoint({ instant_page: null });
    page = state(ctx).instant_page;
  }
  if (!page) {
    let pageId: string;
    try {
      pageId = await createInstantPageDraft({ advertiserId: ctx.campaign.advertiser_id, pageName,
        trackingUrl: ctx.campaign.tracking_url ?? ctx.run.draft.destination_url,
        buttonText: design.button_text, background: design.background, handCursor: design.hand_cursor,
        masterSnapshot: master, assertActive: ctx.assertActive,
        beforeCreate: async () => { await ctx.checkpoint({ instant_page: { name: pageName, phase: "creating" } }); },
      });
    } catch (error) {
      if ((error instanceof InstantPageCreateRejectedError || error instanceof InstantPageCreateNotSentError) && state(ctx).instant_page?.phase === "creating")
        await ctx.checkpoint({ instant_page: null });
      throw error;
    }
    await ctx.checkpoint({ instant_page: { name: pageName, phase: "created", id: pageId } });
    page = state(ctx).instant_page;
  }
  if (page?.phase !== "published") {
    if (!page?.id) throw new Error("Instant Page ID was not saved; refusing publish.");
    await publishInstantPage({ advertiserId: ctx.campaign.advertiser_id, pageId: page.id, assertActive: ctx.assertActive });
    await ctx.checkpoint({ instant_page: { name: pageName, phase: "published", id: page.id } });
  }
}

function split(total: number, count: number): number[] {
  const floor = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => floor + (i < total % count ? 1 : 0));
}

async function saveGroup(ctx: DriverContext, group: SparkGroup): Promise<void> {
  const groups = [...(state(ctx).groups ?? [])];
  const index = groups.findIndex((g) => g.key === group.key);
  if (index < 0) groups.push(group); else groups[index] = group;
  await ctx.checkpoint({ groups });
}

async function createGroup(ctx: DriverContext, c: Client, key: string, budgetCents: number): Promise<SparkGroup> {
  const s = state(ctx);
  const recorded = (s.groups ?? []).find((g) => g.key === key);
  if (recorded) return recorded;
  const name = names(ctx).group(key);
  const candidates = await list(c, "/adgroup/get/", { filtering: JSON.stringify({ campaign_ids: [s.campaign_id] }) });
  const existing = candidates.find((g) => str(g.adgroup_name) === name && str(g.campaign_id) === s.campaign_id);
  let id = str(existing?.adgroup_id);
  if (existing && (cents(existing.budget) !== budgetCents || str(existing.budget_mode) !== s.plan!.budget_mode)) throw new Error("The existing ad group's budget differs from this approved launch; refusing adoption.");
  // A website-purchase group optimizes toward one pixel event; a group of our
  // name that carries another pixel or event is not the one we approved.
  if (existing && shapeOf(s) === "website_purchases" && (str(existing.pixel_id) !== str(s.pixel?.pixel_id) || str(existing.optimization_event) !== str(s.settings!.optimization_event ?? "SHOPPING"))) {
    throw new Error("The existing ad group optimizes toward a different pixel or event than this approved launch; refusing adoption.");
  }
  if (!id) {
    const plan = { ...s.plan!, budget: budgetCents / 100 };
    const signedStart = Date.parse(`${plan.schedule_start_time.replace(" ", "T")}Z`);
    const start = Math.max(signedStart, Date.now() + 10 * 60_000);
    const end = plan.schedule_end_time ? Date.parse(`${plan.schedule_end_time.replace(" ", "T")}Z`) : null;
    if (!Number.isFinite(start) || (end !== null && (!Number.isFinite(end) || end <= start))) throw new Error("The approved schedule has ended or leaves no time for another ad group; create a new round.");
    plan.schedule_start_time = new Date(start).toISOString().slice(0, 19).replace("T", " ");
    const result = await write(ctx, c, "/adgroup/create/", {
      campaign_id: s.campaign_id, adgroup_name: name,
      ...adGroupBody(s.settings!, plan, s.pixel),
      operation_status: "DISABLE",
    });
    id = str(result.data?.adgroup_id);
    if (!id && /name already exists/i.test(result.message)) id = str((await list(c, "/adgroup/get/", { filtering: JSON.stringify({ campaign_ids: [s.campaign_id] }) })).find((g) => str(g.adgroup_name) === name)?.adgroup_id);
    if (!id) { requireOk(result, "Create ad group"); throw new Error("TikTok returned no ad group id"); }
  }
  const group = { id, key, ads: {}, ready: false };
  await saveGroup(ctx, group);
  return group;
}

async function createAds(ctx: DriverContext, c: Client, group: SparkGroup): Promise<void> {
  if (group.ready && groupComplete(state(ctx), group)) return;
  if (group.ready) { group = { ...group, ready: false }; await saveGroup(ctx, group); }
  const known = await list(c, "/ad/get/", { filtering: JSON.stringify({ adgroup_ids: [group.id] }) });
  let skipped = (state(ctx).skipped ?? []).filter((item) => permanentAdRejection(item.reason) || !(state(ctx).posts ?? []).some((post) => post.code === item.code));
  const pending: string[] = [];
  for (const post of state(ctx).posts ?? []) {
    if (group.ads[post.code]) continue;
    if (skipped.some((item) => item.code === post.code && permanentAdRejection(item.reason))) continue;
    const name = names(ctx).ad(group.key, adRef(post));
    const adopted = known.find((a) => str(a.adgroup_id) === group.id && (str(a.ad_name) === name
      || (post.kind !== "video" && !!post.item_id && str(a.tiktok_item_id) === post.item_id && str(a.identity_id) === post.identity_id)
      || (post.kind === "video" && !!post.video_id && str(a.video_id) === post.video_id)));
    let id = str(adopted?.ad_id);
    if (!id) {
      // One creative per request isolates invalid posts and avoids relying on
      // an undocumented ordering of returned ad ids. Persist each survivor.
      const common = {
        ad_name: name, call_to_action: state(ctx).settings!.call_to_action,
        // An Instant Page ad points at the page; every website ad (Traffic,
        // Website purchases) carries its own title's approved crazydramas
        // link verbatim.
        ...(shapeOf(state(ctx)) === "instant_page"
          ? { page_id: state(ctx).instant_page?.id }
          : { landing_page_url: adLanding(ctx, post.code) }),
      };
      const linked = { identity_type: "BC_AUTH_TT", identity_id: post.identity_id, identity_authorized_bc_id: post.bc_id };
      const creative = post.kind === "video"
        // A Studio clip under the linked account, shown only as an ad: in the
        // For You feed with the account's name and picture, never on its
        // profile, no organic views (TikTok's "Show through ads only").
        ? { ...common, ...linked, ad_format: "SINGLE_VIDEO", video_id: post.video_id, image_ids: [post.image_id], ad_text: post.ad_text, dark_post_status: "ON" }
        : post.kind === "tiktok_post"
          ? { ...common, ...linked, tiktok_item_id: post.item_id, ad_format: post.item_type === "CAROUSEL" ? "CAROUSEL_ADS" : "SINGLE_VIDEO" }
          : { ...common, identity_type: "AUTH_CODE", identity_id: post.identity_id, tiktok_item_id: post.item_id, ad_format: post.item_type === "CAROUSEL" ? "CAROUSEL_ADS" : "SINGLE_VIDEO" };
      const result = await write(ctx, c, "/ad/create/", { adgroup_id: group.id, creatives: [creative] });
      if (result.code !== 0) {
        if (result.code > 0 && result.code !== 40100 && !/QPS limit|too many requests|rate limit/i.test(result.message || "") && permanentAdRejection(result.message || "")) skipped.push({ code: post.code, reason: result.message });
        else pending.push(`${post.code}: ${result.message || "TikTok did not confirm ad creation"}`);
        continue;
      }
      const ids = result.data?.ad_ids as unknown[] | undefined;
      const creatives = result.data?.creatives as Row[] | undefined;
      id = str(ids?.[0] ?? creatives?.[0]?.ad_id);
      if (!id) throw new Error("TikTok accepted the ad but returned no id; retry will look it up by post.");
    }
    group = { ...group, ads: { ...group.ads, [post.code]: id } };
    await saveGroup(ctx, group);
    skipped = skipped.filter((s) => s.code !== post.code);
  }
  await ctx.checkpoint({ skipped: [...new Map(skipped.map((v) => [`${v.code}:${v.reason}`, v])).values()] });
  if (pending.length || !groupComplete(state(ctx), group)) throw new Error(`Some ads remain pending; retry the launch to add the missing ads. ${pending.join(" · ")}`);
  if (!Object.keys(group.ads).length) throw new Error("TikTok accepted none of the ads; the campaign remains paused.");
  await saveGroup(ctx, { ...group, ready: true });
}

async function campaignRow(c: Client, s: SparkState): Promise<Row> {
  const row = (await list(c, "/campaign/get/", { filtering: JSON.stringify({ campaign_ids: [s.campaign_id] }) })).find((r) => str(r.campaign_id) === s.campaign_id);
  if (!row) throw new Error("The recorded campaign was not found on TikTok.");
  return row;
}
async function groupRows(c: Client, s: SparkState): Promise<Row[]> {
  const rows = await list(c, "/adgroup/get/", { filtering: JSON.stringify({ campaign_ids: [s.campaign_id] }) });
  const ids = new Set((s.groups ?? []).map((g) => g.id));
  return rows.filter((g) => ids.has(str(g.adgroup_id)));
}

/** A remote edit can change spend ceilings without changing our signed state.
 * Read the whole hierarchy: an untracked ad group can also spend under this
 * campaign, while retired groups must remain disabled. */
async function assertRemoteBudget(ctx: DriverContext, c: Client): Promise<void> {
  assertBudgetState(ctx);
  const s = state(ctx);
  const cap = s.budget_cents ?? ctx.campaign.budget_cents;
  const campaign = await campaignRow(c, s);
  if (str(campaign.advertiser_id) !== c.advertiser) throw new Error("Remote TikTok campaign belongs to a different account; refusing activation.");
  const remote = await list(c, "/adgroup/get/", { filtering: JSON.stringify({ campaign_ids: [s.campaign_id] }) });
  const recorded = s.groups ?? [];
  const byId = new Map(remote.map((group) => [str(group.adgroup_id), group]));
  const recordedIds = new Set(recorded.map((group) => group.id));
  if (byId.size !== remote.length || recordedIds.size !== recorded.length || remote.length !== recorded.length ||
      remote.some((group) => !recordedIds.has(str(group.adgroup_id))) || recorded.some((group) => !byId.has(group.id)) ||
      remote.some((group) => str(group.campaign_id) !== s.campaign_id || str(group.advertiser_id) !== c.advertiser)) {
    throw new Error("Remote TikTok ad groups differ from the recorded launch; refusing activation.");
  }
  if (recorded.some((group) => group.retired && byId.get(group.id)?.operation_status !== "DISABLE")) {
    throw new Error("A retired TikTok ad group is still enabled; refusing activation.");
  }
  const daily = s.daily_budget_cents !== null && s.daily_budget_cents !== undefined;
  if (daily) {
    if (campaign.budget_mode !== "BUDGET_MODE_TOTAL" || cents(campaign.budget) !== cap) {
      throw new Error("Remote TikTok campaign budget differs from the approved lifetime cap; refusing activation.");
    }
    if (!Number.isSafeInteger(s.daily_budget_cents) || s.daily_budget_cents! <= 0) throw new Error("The approved daily budget is unavailable; refusing activation.");
  } else if (campaign.budget_mode !== "BUDGET_MODE_INFINITE") {
    throw new Error("Remote TikTok campaign budget mode differs from the approved launch; refusing activation.");
  }
  let activeBudget = 0;
  for (const group of activeGroups(s)) {
    const row = byId.get(group.id)!;
    const budget = cents(row.budget);
    if (budget === null || budget < 0 || row.budget_mode !== (daily ? "BUDGET_MODE_DAY" : "BUDGET_MODE_TOTAL")) {
      throw new Error("Remote TikTok ad group budget is unreadable or has changed mode; refusing activation.");
    }
    activeBudget += budget;
  }
  if (daily) {
    if (activeBudget > s.daily_budget_cents!) throw new Error("Remote TikTok daily ad group budgets exceed the approved pacing; refusing activation.");
  } else {
    const spent = await spends(ctx, c);
    const retiredSpend = recorded.filter((group) => group.retired).reduce((total, group) => total + (spent.get(group.id) ?? 0), 0);
    if (activeBudget + retiredSpend > cap) throw new Error("Remote TikTok ad group budgets exceed the approved campaign budget; refusing activation.");
  }
}

async function switchGroups(ctx: DriverContext, c: Client, ids: string[], on: boolean, preparation = false): Promise<void> {
  if (!ids.length) return;
  if (on) { requireReadyGroups(state(ctx), ids); await assertRemoteBudget(ctx, c); }
  requireOk(await write(ctx, c, "/adgroup/status/update/", { adgroup_ids: ids, operation_status: on ? "ENABLE" : "DISABLE" }, preparation), "Switch ad groups");
  const back = await groupRows(c, state(ctx));
  if (!ids.every((id) => back.some((g) => str(g.adgroup_id) === id && g.operation_status === (on ? "ENABLE" : "DISABLE")))) throw new Error("TikTok accepted the switch but did not confirm every ad group's new status.");
}
async function switchCampaign(ctx: DriverContext, c: Client, on: boolean, preparation = false): Promise<void> {
  if (on) { requireReadyGroups(state(ctx), activeGroups(state(ctx)).map((group) => group.id)); await assertRemoteBudget(ctx, c); }
  requireOk(await write(ctx, c, "/campaign/status/update/", { campaign_ids: [state(ctx).campaign_id], operation_status: on ? "ENABLE" : "DISABLE" }, preparation), "Switch campaign");
  const back = await campaignRow(c, state(ctx));
  if (back.operation_status !== (on ? "ENABLE" : "DISABLE")) throw new Error("TikTok accepted the switch but did not apply it; check whether this ad account is suspended.");
}

async function launch(ctx: DriverContext): Promise<void> {
  assertBudgetState(ctx);
  const c = client(ctx);
  await verifyAccount(c);
  if (ctx.campaign.content.some((item) => !TIKTOK_CONTENT_KINDS.includes(item.kind))) throw new Error("TikTok launches take Studio clips, the linked account's posts and Spark codes only.");
  if (!state(ctx).settings) {
    const raw = launchSettingsSchema.parse(ctx.run.draft.tiktok_settings);
    const copies = raw.duplicate_copies + 1;
    const daily = ctx.campaign.daily_budget_cents;
    if (daily !== null && Math.floor(daily / copies) < 2000) throw new Error("TikTok requires a minimum $20 daily per existing or planned ad group.");
    const settings = validateLaunchSettings({ ...raw, start_paused: ctx.run.draft.start_paused,
      budget_mode: daily === null ? "BUDGET_MODE_TOTAL" : "BUDGET_MODE_DAY",
      daily_budget_usd: daily === null ? null : Math.floor(daily / copies) / 100,
    }, ctx.campaign.budget_cents / 100);
    await ctx.checkpoint({ settings, plan: planAdGroup(settings, ctx.campaign.budget_cents / 100), budget_cents: ctx.campaign.budget_cents, daily_budget_cents: daily,
      planned_budgets: split(daily ?? ctx.campaign.budget_cents, copies), tiktok_mode: c.tt.mode });
  }
  await ensurePixel(ctx, c);
  if (!state(ctx).posts?.length) await resolveContent(ctx, c);
  await ensureSalesPage(ctx);
  if (!state(ctx).campaign_id) {
    const name = names(ctx).campaign;
    const candidates = await list(c, "/campaign/get/", { filtering: JSON.stringify({ campaign_name: name }) });
    const adopted = candidates.find((r) => str(r.campaign_name) === name);
    if (adopted) {
      const s = state(ctx);
      const expectedMode = s.plan!.campaign_budget === null ? "BUDGET_MODE_INFINITE" : "BUDGET_MODE_TOTAL";
      if (str(adopted.objective_type) !== (s.settings!.objective_type ?? "TRAFFIC") || str(adopted.budget_mode) !== expectedMode || (expectedMode === "BUDGET_MODE_TOTAL" && cents(adopted.budget) !== s.budget_cents)) {
        throw new Error("The existing campaign's objective or budget cap differs from this approved launch; refusing adoption.");
      }
    }
    let id = str(adopted?.campaign_id);
    if (!id) {
      const s = state(ctx);
      const result = await write(ctx, c, "/campaign/create/", {
        campaign_name: name, objective_type: s.settings!.objective_type ?? "TRAFFIC",
        ...(s.settings!.objective_type === "WEB_CONVERSIONS" ? { virtual_objective_type: "SALES", sales_destination: "WEBSITE" } : {}),
        operation_status: "DISABLE",
        ...(s.plan!.campaign_budget !== null ? { budget_mode: "BUDGET_MODE_TOTAL", budget: s.budget_cents! / 100 } : { budget_mode: "BUDGET_MODE_INFINITE" }),
      });
      id = str(result.data?.campaign_id);
      if (!id && /name already exists/i.test(result.message)) id = str((await list(c, "/campaign/get/", { filtering: JSON.stringify({ campaign_name: name }) })).find((r) => str(r.campaign_name) === name)?.campaign_id);
      if (!id) { requireOk(result, "Create campaign"); throw new Error("TikTok returned no campaign id"); }
    }
    await ctx.checkpoint({ campaign_id: id });
  }
  const s = state(ctx);
  // The approved pot already reserves the planned copies' shares. Copies
  // are created only after the original ads have cleared review (reconcile).
  const budgets = s.planned_budgets ?? split(s.daily_budget_cents ?? s.budget_cents!, s.settings!.duplicate_copies + 1);
  const group = await createGroup(ctx, c, "primary", budgets[0]);
  await createAds(ctx, c, group);
  if (!state(ctx).activated && !state(ctx).settings!.start_paused && !preparationPaused(ctx)) {
    await switchGroups(ctx, c, activeGroups(state(ctx)).map((g) => g.id), true, true);
    await switchCampaign(ctx, c, true, true);
    await ctx.checkpoint({ activated: true });
  }
}

/** Called by the orchestrator after its one authoritative monitor sweep. */
export async function reconcileTikTokSparks(ctx: DriverContext): Promise<void> {
  const s = state(ctx);
  if (!s.campaign_id || s.ended || !s.settings?.duplicate_copies || preparationPaused(ctx)) return;
  assertBudgetState(ctx);
  const completed = (ctx.campaign.state.activated_copies as string[] | undefined) ?? [];
  if (Array.from({ length: s.settings.duplicate_copies }, (_, i) => `copy-${i + 1}`).every((key) => s.groups?.some((g) => g.key === key && g.ready && completed.includes(g.id)))) return;
  const primary = s.groups?.find((g) => g.key === "primary");
  const verdicts = new Map((ctx.campaign.snapshot?.ads ?? []).map((a) => [a.id, a.status]));
  if (!primary || !primary.ready || !groupComplete(s, primary) || !Object.values(primary.ads).some((id) => ["approved", "limited"].includes(verdicts.get(id) ?? ""))) return;
  const c = client(ctx);
  if ((await campaignRow(c, s)).operation_status !== "ENABLE") return;
  await verifyAccount(c);
  const primarySource = primary.retired ? s.groups?.find((g) => g.key === `bid-${primary.id}` && !g.retired) ?? primary : primary;
  const primaryLive = (await groupRows(c, s)).find((g) => str(g.adgroup_id) === primarySource.id);
  const on = primaryLive?.operation_status === "ENABLE";
  const budgets = s.planned_budgets ?? split(s.daily_budget_cents ?? s.budget_cents!, s.settings.duplicate_copies + 1);
  for (let i = 1; i <= s.settings.duplicate_copies; i++) {
    const group = await createGroup(ctx, c, `copy-${i}`, budgets[i]);
    await createAds(ctx, c, group);
    // Existing switches belong to the operator; only a newly assembled
    // copy is activated. Persist this once to make future sweeps read-only.
    const activated = (ctx.campaign.state.activated_copies as string[] | undefined) ?? [];
    if (!activated.includes(group.id)) {
      if (on) await switchGroups(ctx, c, [group.id], true, true);
      await ctx.checkpoint({ activated_copies: [...activated, group.id] });
    }
  }
}

async function report(c: Client, ctx: DriverContext, level: "AUCTION_CAMPAIGN" | "AUCTION_ADGROUP", ids: string[]): Promise<Row[]> {
  const dimension = level === "AUCTION_CAMPAIGN" ? "campaign_id" : "adgroup_id";
  return list(c, "/report/integrated/get/", {
    report_type: "BASIC", data_level: level, dimensions: JSON.stringify([dimension]),
    metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion"]),
    start_date: ctx.run.created_at.slice(0, 10), end_date: new Date().toISOString().slice(0, 10),
    filtering: JSON.stringify([{ field_name: `${dimension}s`, filter_type: "IN", filter_value: JSON.stringify(ids) }]),
  });
}

async function monitor(ctx: DriverContext): Promise<DeliverySnapshot> {
  const out: DeliverySnapshot = { delivery: "unknown", note: null, checked_at: new Date().toISOString(), spend_cents: null, impressions: null, clicks: null, conversions: null, cpc_cents: null };
  if (!state(ctx).campaign_id) return { ...out, delivery: state(ctx).ended ? "ended" : ctx.campaign.state.desired_status === "paused" ? "paused" : ctx.campaign.status === "failed" ? "failed" : "unknown", note: ctx.campaign.error ?? "No TikTok campaign has been created." };
  const c = client(ctx);
  const errors: string[] = [];
  let campaign: Row | undefined;
  let groups: Row[] = [];
  let ads: Row[] = [];
  let reviews: ReturnType<typeof normalizeReview>[] = [];
  try { campaign = await campaignRow(c, state(ctx)); } catch (e) { errors.push((e as Error).message); }
  try { groups = await groupRows(c, state(ctx)); } catch (e) { errors.push((e as Error).message); }
  const codeById = new Map((state(ctx).groups ?? []).flatMap((g) => Object.entries(g.ads).map(([code, id]) => [id, code] as const)));
  try {
    ads = (await list(c, "/ad/get/", { filtering: JSON.stringify({ campaign_ids: [state(ctx).campaign_id] }) })).filter((a) => codeById.has(str(a.ad_id)));
    const ids = [...codeById.keys()];
    const verdicts: Record<string, Row> = {};
    for (let i = 0; i < ids.length; i += 100) {
      const data = requireOk(await c.tt.get("/ad/review_info/", c.token, { advertiser_id: c.advertiser, ad_ids: JSON.stringify(ids.slice(i, i + 100)) }), "Ad review");
      Object.assign(verdicts, data.ad_review_map ?? {});
    }
    reviews = ads.map((ad) => normalizeReview(str(ad.ad_id), verdicts[str(ad.ad_id)] ?? {}, str(ad.secondary_status)));
  } catch (e) { errors.push((e as Error).message); }
  try {
    const rows = await report(c, ctx, "AUCTION_CAMPAIGN", [state(ctx).campaign_id!]);
    // An empty successful report is observed zero delivery; a missing field
    // on a returned row remains unknown, never silently becomes zero.
    const sum = (key: string) => rows.every((r) => number((r.metrics as Row | undefined)?.[key]) !== null) ? rows.reduce((n, r) => n + Number((r.metrics as Row)[key]), 0) : null;
    const spend = sum("spend");
    out.spend_cents = spend === null ? null : Math.round(spend * 100);
    out.impressions = sum("impressions"); out.clicks = sum("clicks"); out.conversions = sum("conversion");
    out.cpc_cents = out.spend_cents !== null && out.clicks !== null && out.clicks > 0 ? Math.round(out.spend_cents / out.clicks) : null;
  } catch (e) { errors.push((e as Error).message); }
  const settings = state(ctx).settings;
  if (settings && launchShape(settings) === "website_purchases") {
    // TikTok-attributed website conversions, a second read that fails soft:
    // a refusal (an unknown metric, a missing permission) never costs the
    // sweep its delivery state or the numbers above.
    try {
      const rows = await list(c, "/report/integrated/get/", {
        report_type: "BASIC", data_level: "AUCTION_CAMPAIGN", dimensions: JSON.stringify(["campaign_id"]),
        metrics: JSON.stringify(WEB_METRICS),
        start_date: ctx.run.created_at.slice(0, 10), end_date: new Date().toISOString().slice(0, 10),
        filtering: JSON.stringify([{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([state(ctx).campaign_id]) }]),
      });
      out.web = { ...webConversionsFromReport(rows), event: settings.optimization_event ?? "SHOPPING", attribution: attributionLabel(attributionOf(settings)) };
    } catch (e) { out.web = null; out.web_error = (e as Error).message; }
  }
  // Each ad's own numbers (TikTok's AUCTION_AD report), read after the
  // campaign's and failing soft the same way: a refusal never costs the sweep
  // its delivery state or the campaign's numbers. Website purchases launches
  // also read each ad's TikTok-attributed purchases; that second read failing
  // leaves the ads their delivery numbers.
  let adStats = new Map<string, AdStats>();
  if (codeById.size) {
    const window = {
      start_date: ctx.run.created_at.slice(0, 10), end_date: new Date().toISOString().slice(0, 10),
      filtering: JSON.stringify([{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([state(ctx).campaign_id]) }]),
    };
    try {
      const rows = await list(c, "/report/integrated/get/", { report_type: "BASIC", data_level: "AUCTION_AD", dimensions: JSON.stringify(["ad_id"]), metrics: JSON.stringify(AD_METRICS), ...window });
      let webRows: Row[] | null = null;
      if (settings && launchShape(settings) === "website_purchases") {
        try { webRows = await list(c, "/report/integrated/get/", { report_type: "BASIC", data_level: "AUCTION_AD", dimensions: JSON.stringify(["ad_id"]), metrics: JSON.stringify(WEB_METRICS), ...window }); }
        catch (e) { out.ad_web_error = (e as Error).message; }
      }
      adStats = adStatsByAd(codeById.keys(), rows, webRows);
    } catch (e) { out.ad_stats_error = (e as Error).message; }
  }
  out.configured_status = str(campaign?.operation_status) || undefined;
  out.effective_status = str(campaign?.secondary_status) || undefined;
  out.groups = groups.map((g) => ({ id: str(g.adgroup_id), status: str(g.operation_status), budget_cents: cents(g.budget) ?? undefined, bid_cents: cents(g.billing_event === "CPC" ? g.bid_price : g.conversion_bid_price), end_time: str(g.schedule_end_time) || undefined }));
  // Which account an ad runs as and whether its video stays off the profile,
  // as TikTok's own ad record says: a person can see that the ad exists and
  // where (the Monitor's "Watch on TikTok" opens TikTok's preview of it).
  const rowOf = new Map(ads.map((a) => [str(a.ad_id), a]));
  const identity = state(ctx).identity;
  out.ads = reviews.map((r) => {
    const row = rowOf.get(r.adId);
    const linked = !!identity && str(row?.identity_type) === "BC_AUTH_TT" && str(row?.identity_id) === identity.identity_id;
    const item = str(row?.tiktok_item_id);
    const postUrl = linked && item ? tiktokPostUrl(identity!.username, item) : null;
    const dark = str(row?.dark_post_status);
    return { id: r.adId, status: r.state, note: r.reasons.join(" · ") || undefined, content_value: codeById.get(r.adId),
      ...(linked ? { runs_as: linkedAccountHandle(identity!) } : {}),
      ...(dark === "ON" || dark === "OFF" ? { ads_only: dark === "ON" } : {}),
      ...(item ? { item_id: item } : {}), ...(postUrl ? { post_url: postUrl } : {}),
      ...(adStats.has(r.adId) ? { stats: adStats.get(r.adId) } : {}) };
  });
  const activeIds = new Set(activeGroups(state(ctx)).flatMap((g) => Object.values(g.ads)));
  const currentReviews = reviews.filter((r) => activeIds.has(r.adId));
  const currentAds = ads.filter((a) => activeIds.has(str(a.ad_id)));
  if (state(ctx).ended) out.delivery = "ended";
  else if (out.effective_status?.includes("PUNISH")) out.delivery = "suspended";
  else if (campaign?.operation_status === "DISABLE") out.delivery = "paused";
  else if (currentReviews.length && currentReviews.every((r) => r.state === "rejected")) out.delivery = "rejected";
  else if (currentAds.length && currentAds.every((a) => /TIME_DONE|BUDGET_EXCEED|CAMPAIGN_EXCEED|ADGROUP_EXCEED/.test(str(a.secondary_status)))) out.delivery = "ended";
  else if (currentAds.some((a) => /DELIVERY_OK/.test(str(a.secondary_status)))) out.delivery = "live";
  else if (currentReviews.some((r) => r.state === "in_review" || r.state === "not_reviewed")) out.delivery = "review";
  else if (campaign) out.delivery = "submitted";
  const skippedWord = (code: string) => ctx.campaign.content.find((item) => item.value.trim() === code)?.kind === "spark" ? "Skipped Spark" : "Skipped ad";
  out.note = [...errors, ...reviews.flatMap((r) => r.reasons), ...(state(ctx).skipped ?? []).map((s) => `${skippedWord(s.code)}: ${s.reason}`)].join(" · ") || null;
  return out;
}

async function updateGroup(ctx: DriverContext, c: Client, id: string, patch: Row): Promise<void> {
  requireOk(await write(ctx, c, "/adgroup/update/", { adgroup_id: id, ...patch }), "Update ad group");
  const back = (await groupRows(c, state(ctx))).find((g) => str(g.adgroup_id) === id);
  if (!back || !Object.entries(patch).every(([key, value]) => typeof value === "number" ? Math.abs(Number(back[key]) - value) < 0.005 : str(back[key]) === str(value))) throw new Error("TikTok did not confirm the ad group update.");
}

async function spends(ctx: DriverContext, c: Client): Promise<Map<string, number>> {
  const ids = (state(ctx).groups ?? []).map((g) => g.id);
  const rows = await report(c, ctx, "AUCTION_ADGROUP", ids);
  const result = new Map(ids.map((id) => [id, 0]));
  for (const row of rows) {
    const id = str((row.dimensions as Row | undefined)?.adgroup_id);
    const value = cents((row.metrics as Row | undefined)?.spend);
    if (value === null) throw new Error("TikTok did not report spend; refusing to change budget allocation.");
    if (result.has(id)) result.set(id, result.get(id)! + value);
  }
  return result;
}

async function control(ctx: DriverContext, action: LaunchControl): Promise<void> {
  const s = state(ctx);
  if (!s.campaign_id && (action.action === "pause" || action.action === "end")) {
    await ctx.assertActive();
    await ctx.checkpoint({ paused: true, ...(action.action === "end" ? { ended: true } : {}) });
    return;
  }
  if (!s.campaign_id) throw new Error("No TikTok campaign has been created.");
  if (s.ended) { if (action.action === "end") return; throw new Error("This campaign has ended; create a new round."); }
  const c = client(ctx);
  // A stop may still be attempted on a suspended account; report its actual
  // read-back. Changes that can permit spend require a ready USD account.
  if (action.action !== "pause" && action.action !== "end" && !(action.action === "group" && !action.enabled)) await verifyAccount(c);
  if (action.action !== "pause" && action.action !== "end" && !(action.action === "group" && !action.enabled)) assertBudgetState(ctx);
  if (action.action === "pause" || action.action === "end" || action.action === "resume") {
    if (action.action === "resume" && !s.activated) {
      await switchGroups(ctx, c, activeGroups(s).map((g) => g.id), true);
    }
    await switchCampaign(ctx, c, action.action === "resume");
    await ctx.checkpoint({ ...(action.action === "resume" ? { activated: true } : {}), ...(action.action === "end" ? { ended: true } : {}) });
    return;
  }
  if (action.action === "group") {
    if (!activeGroups(s).some((g) => g.id === action.group_id)) throw new Error("This ad group does not belong to the active launch.");
    await switchGroups(ctx, c, [action.group_id], action.enabled);
    return;
  }
  const groups = activeGroups(s);
  if (!groups.length) throw new Error("This launch has no active ad groups.");
  if (action.action === "schedule") {
    const date = new Date(action.end_time);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("The end time must be in the future.");
    const end = date.toISOString().slice(0, 19).replace("T", " ");
    for (const group of groups) await updateGroup(ctx, c, group.id, { schedule_end_time: end });
    await ctx.checkpoint({ plan: { ...s.plan, schedule_end_time: end } });
    return;
  }
  if (action.action === "bid") {
    if (!Number.isInteger(action.bid_cents) || action.bid_cents <= 0) throw new Error("The cost cap must be positive cents.");
    await assertRemoteBudget(ctx, c);
    const live = await groupRows(c, s);
    if (live.length < groups.length) throw new Error("Cannot read every ad group before changing its bidding.");
    const replacements = groups.filter((g) => live.find((r) => str(r.adgroup_id) === g.id)?.bid_type !== "BID_TYPE_CUSTOM");
    if (replacements.length || s.pending_bid) {
      if (s.pending_bid && s.pending_bid.bid_cents !== action.bid_cents) throw new Error("Finish the interrupted cost-cap change before choosing a different bid.");
      if (!s.pending_bid) {
        const wasOn = (await campaignRow(c, s)).operation_status === "ENABLE";
        await switchCampaign(ctx, c, false);
        const spend = await spends(ctx, c);
        const daily = s.daily_budget_cents !== null && s.daily_budget_cents !== undefined;
        const planned = replacements.map((g) => {
          const row = live.find((r) => str(r.adgroup_id) === g.id)!;
          const budget = cents(row.budget);
          if (budget === null) throw new Error("Cannot read an ad group's budget before replacing it.");
          const available = budget - (daily ? 0 : spend.get(g.id) ?? 0);
          if (available < 2000) throw new Error("A cost-cap replacement needs at least $20 of the old group's unspent budget.");
          return { old_id: g.id, key: `bid-${g.id}`, budget: available, enabled: row.operation_status === "ENABLE" };
        });
        await ctx.checkpoint({ pending_bid: { bid_cents: action.bid_cents, was_on: wasOn, replacements: planned } });
      }
      await ctx.checkpoint({ settings: { ...state(ctx).settings, bid_strategy: "COST_CAP", bid_usd: action.bid_cents / 100 } });
      const pending = state(ctx).pending_bid!;
      for (const replacement of pending.replacements) {
        // Stop the old allowance before allocating the unspent portion to a
        // replacement. A crash cannot leave both groups delivering.
        await switchGroups(ctx, c, [replacement.old_id], false);
        const group = await createGroup(ctx, c, replacement.key, replacement.budget);
        await createAds(ctx, c, group);
        const old = state(ctx).groups!.find((g) => g.id === replacement.old_id)!;
        await saveGroup(ctx, { ...old, retired: true });
        if (replacement.enabled) await switchGroups(ctx, c, [group.id], true);
      }
      // Groups that already used a cost cap can still be edited in place.
      for (const group of groups.filter((g) => !pending.replacements.some((p) => p.old_id === g.id))) {
        const row = live.find((g) => str(g.adgroup_id) === group.id)!;
        await updateGroup(ctx, c, group.id, { [row.billing_event === "CPC" ? "bid_price" : "conversion_bid_price"]: action.bid_cents / 100 });
      }
      if (pending.was_on) await switchCampaign(ctx, c, true);
      await ctx.checkpoint({ pending_bid: null });
      return;
    }
    for (const group of groups) {
      const row = live.find((g) => str(g.adgroup_id) === group.id)!;
      await updateGroup(ctx, c, group.id, { [row.billing_event === "CPC" ? "bid_price" : "conversion_bid_price"]: action.bid_cents / 100 });
    }
    await ctx.checkpoint({ settings: { ...s.settings, bid_usd: action.bid_cents / 100 } });
    return;
  }
  if (action.action === "daily_budget") {
    if (s.daily_budget_cents === null || s.daily_budget_cents === undefined) throw new Error("This launch uses lifetime ad-group budgets; start a new round for daily pacing.");
    if (!Number.isInteger(action.daily_budget_cents) || action.daily_budget_cents > s.budget_cents!) throw new Error("Daily pacing cannot exceed the approved lifetime cap.");
    const shares = split(action.daily_budget_cents, Math.max(groups.length, s.settings!.duplicate_copies + 1));
    if (shares.some((v) => v < 2000)) throw new Error("Daily pacing must leave at least $20 per ad group.");
    for (let i = 0; i < groups.length; i++) await updateGroup(ctx, c, groups[i].id, { budget: shares[i] / 100 });
    await ctx.checkpoint({ daily_budget_cents: action.daily_budget_cents, planned_budgets: shares });
    return;
  }
  if (action.action === "budget") {
    assertCampaignBudget(ctx.run, ctx.campaign, action.budget_cents);
    const spend = await spends(ctx, c);
    const totalSpent = [...spend.values()].reduce((a, b) => a + b, 0);
    if (action.budget_cents < totalSpent) throw new Error("The budget cannot be less than spend already reported.");
    if (s.daily_budget_cents !== null && s.daily_budget_cents !== undefined) {
      if (action.budget_cents < 5000) throw new Error("TikTok campaign lifetime caps must be at least $50.");
      requireOk(await write(ctx, c, "/campaign/update/", { campaign_id: s.campaign_id, budget_mode: "BUDGET_MODE_TOTAL", budget: action.budget_cents / 100 }), "Update campaign budget");
      if (cents((await campaignRow(c, s)).budget) !== action.budget_cents) throw new Error("TikTok did not confirm the budget change.");
    } else {
      const remaining = split(action.budget_cents - totalSpent, Math.max(groups.length, s.settings!.duplicate_copies + 1));
      const allocations = groups.map((g, i) => (spend.get(g.id) ?? 0) + remaining[i]);
      if (allocations.some((v) => v < 2000) || remaining.slice(groups.length).some((v) => v < 2000)) throw new Error("Every existing or planned ad group must retain at least TikTok's $20 minimum.");
      for (let i = 0; i < groups.length; i++) await updateGroup(ctx, c, groups[i].id, { budget: allocations[i] / 100 });
      await ctx.checkpoint({ planned_budgets: remaining.map((value, i) => value + (groups[i] ? spend.get(groups[i].id) ?? 0 : 0)) });
    }
    await ctx.checkpoint({ budget_cents: action.budget_cents });
    return;
  }
  if (action.action === "duplicate") {
    if (groups.length < s.settings!.duplicate_copies + 1) throw new Error("The approved automatic copies must clear review and finish before adding another copy.");
    if (groups.length >= 21) throw new Error("This launch already has the maximum number of copies.");
    const liveCampaign = await campaignRow(c, s);
    // Pause while the fixed pot is redistributed, so spend cannot race the
    // read. An interrupted control is safely left paused until resumed.
    await switchCampaign(ctx, c, false);
    if (!state(ctx).pending_copy) {
      const spend = await spends(ctx, c);
      const daily = s.daily_budget_cents !== null && s.daily_budget_cents !== undefined;
      const pot = daily ? s.daily_budget_cents! : s.budget_cents! - [...spend.values()].reduce((a, b) => a + b, 0);
      const shares = split(pot, groups.length + 1);
      if (shares.some((v) => v < 2000)) throw new Error("The remaining approved budget cannot fund another $20 ad group.");
      await ctx.checkpoint({ pending_copy: { key: `copy-${(s.groups ?? []).length}`, new_budget: shares.at(-1)!, was_on: liveCampaign.operation_status === "ENABLE", allocations: Object.fromEntries(groups.map((g, i) => [g.id, shares[i] + (daily ? 0 : spend.get(g.id) ?? 0)])) } });
    }
    const pending = state(ctx).pending_copy!;
    for (const [id, budget] of Object.entries(pending.allocations)) await updateGroup(ctx, c, id, { budget: budget / 100 });
    const group = await createGroup(ctx, c, pending.key, pending.new_budget);
    await createAds(ctx, c, group);
    if (pending.was_on) {
      await switchGroups(ctx, c, [group.id], true);
      await switchCampaign(ctx, c, true);
    }
    await ctx.checkpoint({ pending_copy: null });
  }
}

export const tiktokSparkDriver: LaunchDriver = { launch, monitor, control };
