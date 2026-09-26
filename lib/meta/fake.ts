import { createHash } from "node:crypto";
import { MetaApiError, type MetaFile, type MetaObject, type MetaTransport } from "./transport";
import type { LaunchRun } from "@/lib/launch/types";
import { META_ACTION_TYPES, META_CONVERSION_EVENTS, type MetaConversionEvent } from "./events";
import { metaPixelId } from "./pixel";

type FakeRow = MetaObject & { id: string; edge: string; account_id: string };
type Failure = { method: "GET" | "POST" | "UPLOAD"; path: string; after: boolean; ambiguous: boolean; code: number };
/**
 * A fixture constant, not a credential: the fake holds no Meta token and
 * reaches no network. Organic publishing never asks the fake for it either —
 * `forPage` returns the fake itself, exactly as the live transport binds the
 * derived Page token to one request.
 */
const FAKE_PAGE_TOKEN = "fixture-page-token-not-a-credential";
/** `ig_error` ends the Reel container in ERROR; `fb_throttle` rate-limits the first /videos upload once. */
const publishMode = () => process.env.META_FAKE_PUBLISH || "";
const demoStamp = (offsetDays: number) => new Date(Date.UTC(2026, 8, 16 - offsetDays, 12, 0, 0)).toISOString();
function removeRunObjects(objects: Map<string, FakeRow>, runs: readonly LaunchRun[]) {
  const ids = new Set<string>();
  const prefixes = runs.map(run => `${run.external_id}/`);
  for (const run of runs) for (const campaign of run.campaigns) {
    const saved = campaign.state.meta as {
      campaign_id?: string; adset_id?: string; adset_ids?: Record<string, string>;
      creative_ids?: Record<string, string>;
      ad_ids?: Record<string, string>; video_ids?: Record<string, string>;
      intents?: Record<string, { id?: string }>;
    } | undefined;
    if (!saved) continue;
    // A campaign holds one ad set per platform; the legacy single id is still read.
    for (const id of [saved.campaign_id, saved.adset_id, ...Object.values(saved.adset_ids ?? {}),
      ...Object.values(saved.creative_ids ?? {}), ...Object.values(saved.ad_ids ?? {}),
      ...Object.values(saved.video_ids ?? {}), ...Object.values(saved.intents ?? {}).map(intent => intent.id)]) {
      if (id) ids.add(id);
    }
  }
  for (const [id, row] of objects) {
    // Names and video titles include the immutable run key, including when
    // an interrupted create has not recorded the returned ID yet.
    if (ids.has(id) || prefixes.some(prefix =>
      (typeof row.name === "string" && row.name.startsWith(prefix)) ||
      (typeof row.title === "string" && row.title.startsWith(prefix)))) objects.delete(id);
  }
}
/** Endpoint-level fake: launch, controls and monitor run the same provider code. */
export class FakeMetaTransport implements MetaTransport {
  readonly mode = "fake" as const;
  readonly calls: { method: string; path: string; params: MetaObject }[] = [];
  readonly objects = new Map<string, FakeRow>();
  private sequence = 0;
  private failures: Failure[] = [];
  private sources = new Map<string, MetaObject>();
  private blocked = new Set<string>();
  private containerPolls = new Map<string, number>();
  private throttledOnce = false;
  videoStatus = "ready";
  /** Instagram's rolling 24-hour publishing allowance, as the fake reports it. */
  publishingQuota = { used: 0, total: 50 };
  /** The pixels this fake ad account may use (`act_<id>/adspixels`). */
  pixels: { id: string; name: string; is_unavailable?: boolean }[] = [{ id: metaPixelId(), name: "CrazyDramas" }];
  /** Meta refuses the pixel list for want of the permission, the way it does before App Review. */
  pixelReadRefused = false;
  /** What a conversions campaign's insights report. */
  conversions = 0;
  conversionValue = 0;

  reset() {
    this.calls.length = 0; this.objects.clear(); this.sequence = 0; this.failures = []; this.sources.clear();
    this.blocked.clear(); this.containerPolls.clear(); this.throttledOnce = false;
    this.publishingQuota = { used: 0, total: 50 }; this.videoStatus = "ready";
    this.pixels = [{ id: metaPixelId(), name: "CrazyDramas" }]; this.pixelReadRefused = false;
    this.conversions = 0; this.conversionValue = 0;
  }
  removeForRuns(runs: readonly LaunchRun[]) { removeRunObjects(this.objects, runs); }
  /** Organic publishing never derives a Page token from the fake; the fake is already the Page. */
  forPage(_pageId: string): MetaTransport { return this; }
  removeObjects(ids: readonly (string | null | undefined)[]) { for (const id of ids) if (id) this.objects.delete(id); }
  /** `code` is the Meta error code the injected refusal carries: 100 (a plain refusal) unless a test asks for a transient one. */
  failNext(method: Failure["method"], path: string, opts: { after?: boolean; ambiguous?: boolean; code?: number } = {}) {
    this.failures.push({ method, path, after: opts.after ?? false, ambiguous: opts.ambiguous ?? false, code: opts.code ?? 100 });
  }
  seedSource(id: string, data: MetaObject) { this.sources.set(id, { id, ...data }); }
  rejectSource(id: string) { this.blocked.add(id); }
  snapshot() { return [...this.objects.values()].map(row => structuredClone(row)); }

  private fail(method: Failure["method"], path: string, after: boolean) {
    const at = this.failures.findIndex(f => f.method === method && f.path === path && f.after === after);
    if (at < 0) return;
    const [failure] = this.failures.splice(at, 1);
    throw new MetaApiError("Injected Meta endpoint failure.", failure.code, failure.ambiguous);
  }
  async get<T extends MetaObject = MetaObject>(path: string, params: MetaObject = {}): Promise<T> {
    this.calls.push({ method: "GET", path, params: structuredClone(params) });
    this.fail("GET", path, false);
    if (this.blocked.has(path)) throw new MetaApiError("Content is unavailable.", 100);
    const [id, edge] = path.split("/");
    const fields = String(params.fields ?? "");
    const publish = this.publishGet(id, edge, fields);
    if (publish) return publish as T;
    if (edge === "insights") {
      if (!this.objects.has(id)) return { data: [] } as unknown as T;
      // A conversions campaign reports the event it optimizes toward, so the
      // Monitor and the stats can be exercised without a live Meta account.
      // The demo numbers are invented and stay zero unless a test sets them.
      const row = this.objects.get(id)!;
      const event = (row.edge === "campaigns" && this.conversionEventOf(String(row.id))) || null;
      return { data: [{ spend: "0", impressions: "0", clicks: "0",
        ...(event ? { actions: [{ action_type: event, value: String(this.conversions) }], action_values: [{ action_type: event, value: this.conversionValue.toFixed(2) }] } : {}) }] } as unknown as T;
    }
    if (edge === "adspixels") {
      if (this.pixelReadRefused) throw new MetaApiError("Permissions error: the app does not have ads_management on this pixel.", 200);
      return { data: this.pixels.map(pixel => ({ ...pixel })) } as unknown as T;
    }
    if (edge === "instagram_accounts") return { data: [{ id: "demo-instagram", username: "demo" }, { id: "9000000000000020", username: "demo_studio" }] } as unknown as T;
    if (edge) return { data: this.snapshot().filter(r => r.account_id === id.replace(/^act_/, "") && r.edge === edge) } as unknown as T;
    const row = this.objects.get(id);
    if (row) return structuredClone(row) as T;
    const source = this.sources.get(id);
    if (source) return structuredClone(source) as T;
    if (id.startsWith("act_")) return { id, account_status: 1, currency: "USD", timezone_name: "America/Los_Angeles" } as unknown as T;
    return { id, from: { id: id.split("_")[0] }, owner: { id: "demo-instagram" } } as unknown as T;
  }

  /** The organic publishing reads (docs/meta-organic-plan.md §3); null when this is not one of them. */
  private publishGet(id: string, edge: string, fields: string): MetaObject | null {
    if (!edge && fields.includes("access_token")) return { id, access_token: FAKE_PAGE_TOKEN };
    if (edge === "content_publishing_limit") return { data: [{ quota_usage: this.publishingQuota.used, config: { quota_total: this.publishingQuota.total, quota_duration: 86400 } }] };
    if (edge === "videos") return { data: this.snapshot().filter(r => r.edge === "videos" && r.account_id === id) };
    if (edge === "posts") return { data: [
      ...this.snapshot().filter(r => r.edge === "videos" && r.account_id === id && r.post_id)
        .map(r => ({ id: r.post_id, message: r.description ?? "", created_time: r.created_time, permalink_url: r.permalink_url, full_picture: null })),
      { id: `${id}_100000001`, message: "Behind the scenes from the set.", created_time: demoStamp(1), permalink_url: `https://www.facebook.com/${id}_100000001`, full_picture: null },
      { id: `${id}_100000002`, message: "A first look at this week's episode.", created_time: demoStamp(3), permalink_url: `https://www.facebook.com/${id}_100000002`, full_picture: null },
    ] };
    if (edge === "media") return { data: [
      ...this.snapshot().filter(r => r.edge === "media" && r.account_id === id)
        .map(r => ({ id: r.id, caption: r.caption ?? "", media_type: "VIDEO", permalink: r.permalink, thumbnail_url: null, timestamp: r.timestamp })),
      { id: `${id}0000001`, caption: "Reel: the confession scene.", media_type: "VIDEO", permalink: `https://www.instagram.com/reel/${id}0000001/`, thumbnail_url: null, timestamp: demoStamp(2) },
      { id: `${id}0000002`, caption: "Reel: the rooftop cliffhanger.", media_type: "VIDEO", permalink: `https://www.instagram.com/reel/${id}0000002/`, thumbnail_url: null, timestamp: demoStamp(4) },
    ] };
    const row = this.objects.get(id);
    if (!row) return null;
    if (row.edge === "videos" && fields.includes("post_id")) {
      // Facebook creates the Page post a moment after the upload: the id
      // appears on the second read, which is what the engine polls for.
      const reads = Number(row.post_id_reads ?? 0) + 1;
      row.post_id_reads = reads;
      if (reads >= 2 && !row.post_id) {
        row.post_id = `${row.account_id}_${880000000000000n + BigInt(++this.sequence)}`;
        row.permalink_url = `https://www.facebook.com/${row.post_id}`;
      }
      return structuredClone(row);
    }
    if (row.edge === "ig_container" && fields.includes("status_code")) {
      if (row.failing) return { id, status_code: "ERROR", status: "The media could not be processed." };
      const polls = (this.containerPolls.get(id) ?? 0) + 1;
      this.containerPolls.set(id, polls);
      return polls > 2 ? { id, status_code: "FINISHED", status: "Finished" } : { id, status_code: "IN_PROGRESS", status: "In progress" };
    }
    return null;
  }

  private create(path: string, params: MetaObject): MetaObject {
    const [account, edge] = path.split("/");
    if (!edge) {
      const row = this.objects.get(account);
      if (!row) throw new MetaApiError("Object not found.", 100);
      Object.assign(row, structuredClone(params));
      if (params.status) row.effective_status = params.status;
      return { success: true };
    }
    if (edge === "adsets") this.checkAdSet(params);
    const ref = params.object_story_id ?? params.source_instagram_media_id;
    if (typeof ref === "string" && this.blocked.has(ref)) throw new MetaApiError("Content is not eligible for ads.", 100);
    if (Array.isArray(params.execution_options) && params.execution_options.includes("validate_only")) return { success: true };
    const id = String(880000000000000n + BigInt(++this.sequence));
    const row: FakeRow = { ...structuredClone(params), id, account_id: account.replace(/^act_/, ""), edge };
    if (edge === "ads") row.creative = { id: (params.creative as MetaObject).creative_id };
    if (params.status) row.effective_status = params.status;
    if (edge === "advideos") {
      row.status = { video_status: this.videoStatus };
      row.thumbnails = { data: [{ uri: "https://example.com/demo-thumb.jpg", is_preferred: true }] };
    }
    this.objects.set(id, row);
    return { id };
  }
  private nextId(): string { return String(880000000000000n + BigInt(++this.sequence)); }

  /**
   * What Meta refuses about a conversions ad set, modelled so a wrong pairing
   * fails in fixture mode instead of on the live account: the goal belongs to
   * a Sales campaign, it needs a promoted_object naming a pixel the account
   * may use and an event, and a click goal may carry no promoted_object.
   */
  private checkAdSet(params: MetaObject) {
    const goal = String(params.optimization_goal ?? "");
    const promoted = params.promoted_object as MetaObject | undefined;
    const campaign = this.objects.get(String(params.campaign_id ?? ""));
    if (goal === "OFFSITE_CONVERSIONS") {
      if (campaign && String(campaign.objective) !== "OUTCOME_SALES")
        throw new MetaApiError(`optimization_goal OFFSITE_CONVERSIONS is not supported by objective ${campaign.objective}`, 100);
      if (!promoted?.pixel_id) throw new MetaApiError("promoted_object with a pixel_id is required when optimization_goal is OFFSITE_CONVERSIONS", 100);
      if (!promoted.custom_event_type) throw new MetaApiError("promoted_object requires custom_event_type", 100);
      if (!(META_CONVERSION_EVENTS as readonly string[]).includes(String(promoted.custom_event_type)))
        throw new MetaApiError(`(#100) Invalid parameter: ${promoted.custom_event_type} is not a valid custom_event_type`, 100);
      const pixel = this.pixels.find(row => row.id === String(promoted.pixel_id));
      if (!pixel || pixel.is_unavailable) throw new MetaApiError(`Pixel ${promoted.pixel_id} is not available to this ad account`, 100);
    } else if (promoted) {
      throw new MetaApiError(`promoted_object is not supported when optimization_goal is ${goal}`, 100);
    }
  }

  /** The action type a campaign's conversions ad sets optimize toward, or null when none do. */
  private conversionEventOf(campaignId: string): string | null {
    const set = this.snapshot().find(row => row.edge === "adsets" && String(row.campaign_id) === campaignId && (row.promoted_object as MetaObject | undefined)?.custom_event_type);
    const event = set ? String((set.promoted_object as MetaObject).custom_event_type) : null;
    return event && event in META_ACTION_TYPES ? META_ACTION_TYPES[event as MetaConversionEvent] : null;
  }

  /** The organic publishing writes; null when this is not one of them. */
  private publishPost(account: string, edge: string, params: MetaObject): MetaObject | null {
    if (edge === "media") {
      if (params.media_type !== "REELS") throw new MetaApiError("Instagram accepts video only as a Reel.", 100);
      if (typeof params.video_url !== "string" || !params.video_url) throw new MetaApiError("A Reel container needs a fetchable video URL.", 100);
      const id = this.nextId();
      this.objects.set(id, { id, edge: "ig_container", account_id: account, caption: String(params.caption ?? ""), video_url: params.video_url, failing: publishMode() === "ig_error" });
      return { id };
    }
    if (edge === "media_publish") {
      const container = this.objects.get(String(params.creation_id ?? ""));
      if (!container || container.edge !== "ig_container" || container.account_id !== account) throw new MetaApiError("Unknown Reel container.", 100);
      if (container.published_id) throw new MetaApiError("This container was already published.", 100);
      if ((this.containerPolls.get(container.id) ?? 0) <= 2) throw new MetaApiError("The Reel is still processing.", 9007);
      const id = this.nextId();
      container.published_id = id;
      this.objects.set(id, { id, edge: "media", account_id: account, caption: container.caption, permalink: `https://www.instagram.com/reel/${id}/`, timestamp: new Date().toISOString() });
      return { id };
    }
    return null;
  }

  async post<T extends MetaObject = MetaObject>(path: string, params: MetaObject): Promise<T> {
    this.calls.push({ method: "POST", path, params: structuredClone(params) });
    this.fail("POST", path, false);
    const [account, edge] = path.split("/");
    const result = this.publishPost(account, edge, params) ?? this.create(path, params);
    this.fail("POST", path, true);
    return result as T;
  }
  async upload<T extends MetaObject = MetaObject>(path: string, params: MetaObject, files: Record<string, MetaFile>): Promise<T> {
    this.calls.push({ method: "UPLOAD", path, params: structuredClone(params) });
    this.fail("UPLOAD", path, false);
    if (!files.source?.bytes.length) throw new MetaApiError("Video is empty.", 100);
    const [account, edge] = path.split("/");
    let result: MetaObject;
    if (edge === "videos") {
      if (publishMode() === "fb_throttle" && !this.throttledOnce) {
        this.throttledOnce = true;
        throw new MetaApiError("Meta application request limit reached.", 4);
      }
      const id = this.nextId();
      // The fake records the hash of the bytes it actually received, so a test
      // can prove the exact rendered clip was the thing uploaded.
      this.objects.set(id, { id, edge: "videos", account_id: account, title: params.title ?? "", description: params.description ?? "",
        created_time: new Date().toISOString(), sha256: createHash("sha256").update(files.source.bytes).digest("hex") });
      result = { id };
    } else {
      result = this.create(path, params);
    }
    this.fail("UPLOAD", path, true);
    return result as T;
  }
}

const globalFake = globalThis as typeof globalThis & { __studioMetaFake?: FakeMetaTransport };
export const fakeMetaTransport = globalFake.__studioMetaFake ??= new FakeMetaTransport();
export const resetFakeMeta = () => fakeMetaTransport.reset();
// Next hot reload retains the process-wide instance, which may still have the
// previous class prototype. Operate on its Map directly instead of requiring
// a newly added method on that retained instance.
export const resetFakeMetaForRuns = (runs: readonly LaunchRun[]) => removeRunObjects(fakeMetaTransport.objects, runs);
/** Demo reset: a removed company's organic posts stop existing on the fake Page too. */
export const resetFakeMetaForClipPosts = (posts: readonly { external_video_id: string | null; external_post_id: string | null }[]) => {
  for (const post of posts) for (const id of [post.external_video_id, post.external_post_id]) if (id) fakeMetaTransport.objects.delete(id);
};
export const fakeMetaSnapshot = () => fakeMetaTransport.snapshot();
