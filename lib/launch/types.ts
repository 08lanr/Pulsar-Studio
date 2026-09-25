import type { Session } from "@/lib/auth";
import type { ClipLibraryFilter, ClipLibraryRow, ClipPost, PublishClipInput } from "@/lib/launch/clip-posts";
import type { LaunchSettings } from "@/lib/tiktok/settings";
import type { WebConversions } from "@/lib/tiktok/web-metrics";

export type LaunchProvider = "tiktok" | "meta";
/**
 * `spark` a TikTok Spark code; `tiktok_post` a post of the TikTok account
 * Business Center links to the ad account (its item id, no code); `video` a
 * Studio clip Studio uploads (Meta: to the ad account; TikTok: run as the
 * linked account, shown only as an ad); `facebook_post` / `instagram_post`.
 */
export type ContentKind = "spark" | "tiktok_post" | "facebook_post" | "instagram_post" | "video";
export type LaunchContent = {
  kind: ContentKind; value: string; label?: string; creative_id?: string;
  /**
   * The title this ad promotes. TikTok: each Spark code row picks its own
   * (default: the launch's title; a picked clip's title otherwise), so one
   * launch may promote several titles. The server fills it on save.
   */
  title_id?: string;
  /** The Studio clip this content came from, and the promote.clip_posts row that published it. */
  clip_id?: string; post_id?: string;
  /**
   * TikTok website ads: this ad's own landing page, `crazydramasAdUrl(slug)`
   * of its title. Written by the server on save from the title, never taken
   * from the client, signed with the draft and sent as the ad's
   * `landing_page_url`. Absent on content saved before per-ad titles: the
   * campaign's link applies.
   */
  landing_url?: string;
  // Populated by the server from company-owned finished creatives, never trusted from JSON input.
  file_path?: string; sha256?: string; thumbnail_path?: string; text?: string; headline?: string;
};
export type MetaLaunchSettings = {
  countries: string[]; placements: ("facebook" | "instagram")[];
  optimization_goal: "LINK_CLICKS" | "LANDING_PAGE_VIEWS";
  bid_strategy: "LOWEST_COST_WITHOUT_CAP" | "LOWEST_COST_WITH_BID_CAP";
  bid_cents: number | null; call_to_action: "LEARN_MORE" | "WATCH_MORE";
  start_time: string; end_time: string;
};
export type LaunchDraft = {
  provider: LaunchProvider; name: string; account_ids: string[];
  campaigns_per_account: number; content_per_campaign: number; allocation: "unique" | "shared";
  content: LaunchContent[]; destination_url: string; total_budget_cents: number;
  daily_budget_cents: number | null; start_paused: boolean;
  /**
   * The first campid, counted up once per campaign (`rlapple01, rlapple02, …`).
   * Absent or empty keeps the identifier Studio derives from the saved run.
   */
  campid_start?: string | null;
  /**
   * TikTok: the title the ads promote. Its crazydramas slug decides the one
   * link every TikTok ad carries (lib/tiktok/ad-url.ts); the server writes
   * that link into `destination_url` on save, and preview refuses a title
   * with no slug, a `mock-` slug or a series that is not live.
   */
  title_id?: string | null;
  tiktok_settings: LaunchSettings; meta_settings: MetaLaunchSettings;
};
export type LaunchConnection = {
  id: string; producer_id: string; provider: LaunchProvider; advertiser_id: string; name: string;
  currency: string; timezone: string; page_id: string | null; instagram_id: string | null;
  business_id: string | null; assigned_by: string; verified_at: string; enabled: boolean;
  business_name?: string;
};
export type MetaPlatform = "facebook" | "instagram";
/**
 * One Meta ad set inside a campaign. The content decides the platform, so a
 * campaign that spans both gets two ad sets and each holds only its own ads.
 * Absent on TikTok rows and on Meta campaigns approved before this field.
 */
export type LaunchAdSetPlan = {
  platform: MetaPlatform; content: LaunchContent[];
  budget_cents: number; daily_budget_cents: number | null;
};
export type LaunchPlanRow = {
  index: number; connection_id: string; advertiser_id: string; name: string;
  /** Stable Studio campaign identifier. Absent on campaigns approved before this field existed. */
  campid?: string;
  /** Campaign-specific HTTP(S) destination with campid attribution; absent on legacy approvals. */
  tracking_url?: string;
  content: LaunchContent[]; budget_cents: number; daily_budget_cents: number | null;
  ad_sets?: LaunchAdSetPlan[];
};
/** One reason a draft cannot be previewed. The screen localizes `code`; a server refusal prints `message`. */
export type LaunchPlanIssue = { code: string; message: string; vars?: Record<string, string | number> };
export type LaunchPlan = {
  rows: LaunchPlanRow[]; total_budget_cents: number; daily_total_cents: number | null;
  campaign_count: number; account_count: number; content_count: number; warnings: string[];
  /**
   * TikTok Website purchases: the pixel the preview resolved on every chosen
   * account, and what the ad groups optimize toward. `unverified`: the id is
   * TIKTOK_PIXEL_ID, set by hand while TikTok refuses the pixel read for want
   * of the permission; `owner` is the Business Center that lists the pixel,
   * when it was asked and answered (lib/tiktok/pixel.ts).
   */
  tiktok_pixel?: { code: string; event: string; attribution: string; accounts: { connection_id: string; pixel_id: string; unverified?: true; owner?: string | null }[] };
  /**
   * TikTok, when the ads include Studio clips or the linked account's posts:
   * how many of each, and the account they run as on every chosen ad account
   * (lib/tiktok/linked-account.ts), read at preview; the driver picks it again
   * by the same rule before anything is written.
   */
  tiktok_identity?: { clips: number; posts: number; accounts: { connection_id: string; name: string; handle: string; ads_only: boolean }[] };
};
export type DeliveryState = "submitted" | "review" | "live" | "paused" | "ended" | "rejected" | "failed" | "suspended" | "unknown";
export type DeliverySnapshot = {
  delivery: DeliveryState; note: string | null; checked_at: string;
  spend_cents: number | null; impressions: number | null; clicks: number | null;
  conversions: number | null; cpc_cents: number | null;
  configured_status?: string; effective_status?: string;
  ads?: {
    id: string; status: string; note?: string; content_value?: string; stats?: AdStats;
    /** TikTok: the linked account the ad runs as ("@crazydramaus"), when it runs as one (a Studio clip or one of its posts). */
    runs_as?: string;
    /** TikTok: the ad's video is shown only as an ad, never on the profile (dark_post_status ON). */
    ads_only?: boolean;
    /** TikTok: the post the ad plays, and its own page, when TikTok names one (an ads-only post opens there for the account's owner only). */
    item_id?: string; post_url?: string;
  }[];
  /** Why the per-ad numbers are missing when TikTok's ad report failed (fails soft: the campaign's numbers stand). */
  ad_stats_error?: string;
  /** Why the per-ad PURCHASES are missing when that second read failed; the ads keep their delivery numbers (ad_stats_error is the first read's). */
  ad_web_error?: string;
  /** One entry per ad set. Meta names the platform its ad set runs on; TikTok groups have none. */
  groups?: { id: string; status: string; budget_cents?: number; bid_cents?: number | null; end_time?: string; platform?: MetaPlatform }[];
  /**
   * TikTok Website purchases only: TikTok-attributed website conversions (its
   * own click/view windows, never crazydramas' funnel). Read by a second
   * report call that fails soft: `web_error` says why they are missing.
   */
  web?: (WebConversions & { event: string; attribution: string }) | null;
  web_error?: string;
};
/**
 * One ad's own results: TikTok's AUCTION_AD report over the launch's life.
 * Unknown stays null, never zero. `web` is TikTok-attributed website
 * conversions, read on a Website purchases launch only.
 */
export type AdStats = {
  spend_cents: number | null; impressions: number | null; clicks: number | null;
  /** clicks ÷ impressions (0.0123 = 1.23%), recomputed from the sums. */
  ctr: number | null; cpc_cents: number | null; conversions: number | null;
  web?: WebConversions | null;
};
export type LaunchCampaign = LaunchPlanRow & {
  id: string; run_id: string; status: "pending" | "running" | "done" | "failed";
  state: Record<string, unknown>; error: string | null; snapshot: DeliverySnapshot | null;
};
export type LaunchRun = {
  id: string; external_id: string; producer_id: string; draft: LaunchDraft; round: number; parent_run_id: string | null;
  status: "draft" | "pending" | "running" | "done" | "failed";
  revision: number; snapshot_hash: string | null; approved_by: string | null; approved_at: string | null;
  approval_note: string | null; created_by: string; created_at: string; updated_at: string;
  mode: "fake" | "sandbox" | "production"; error: string | null; campaigns: LaunchCampaign[];
  lease_owner: string | null; lease_until: string | null;
  connections?: LaunchConnection[];
  audit?: { at: string; actor: string; action: string; note?: string; detail?: unknown }[];
};
export type LaunchControl =
  | { action: "pause" | "resume" | "end" }
  | { action: "budget"; budget_cents: number }
  | { action: "daily_budget"; daily_budget_cents: number }
  | { action: "bid"; bid_cents: number }
  | { action: "schedule"; end_time: string }
  | { action: "duplicate" }
  | { action: "group"; group_id: string; enabled: boolean };
export type DriverContext = {
  run: LaunchRun; campaign: LaunchCampaign; connection: LaunchConnection;
  /** Merge and durably save provider state before the next external operation. Updates context.campaign.state. */
  checkpoint: (patch: Record<string, unknown>) => Promise<void>;
  /** Throws if the worker no longer owns this run or a stop was requested. Call before each write/activation. */
  assertActive: () => Promise<void>;
};
export type LaunchDriver = {
  launch(context: DriverContext): Promise<void>;
  monitor(context: DriverContext): Promise<DeliverySnapshot>;
  control(context: DriverContext, action: LaunchControl): Promise<void>;
};
export type LaunchLibraryItem = LaunchContent & {
  id: string; title_name: string; media_url: string | null; spark_code: string | null; post_url: string | null;
};
/** The fields the publishing engine and the Clips tab may change on a post row. */
export type ClipPostPatch = Partial<Pick<ClipPost,
  "status" | "step" | "external_video_id" | "external_post_id" | "permalink" | "caption" | "sha256" | "error" | "published_at"
  | "attempted_at" | "superseded_by" | "lease_owner" | "leased_until">>;
/** A title a TikTok launch may promote: its crazydramas slug and the phase 3a reading of it. */
export type LaunchTitleOption = {
  id: string; name: string; slug: string | null;
  /** The crazydramas status state (lib/crazydramas/match.ts), or null when the title has no slug. */
  state: string | null;
  /** Whether ads may send people to it today (the gate's reading): only these are offered per ad. */
  live?: boolean;
  /** The link its ads would carry, when the slug can carry one. */
  ad_url: string | null;
};
export type LaunchWorkspace = {
  connections: LaunchConnection[]; library: ClipLibraryRow[]; runs: LaunchRun[];
  /** The company's titles with their crazydramas slug, for the TikTok destination. */
  titles?: LaunchTitleOption[];
  /**
   * The TikTok account a new launch starts on (one account for now):
   * TIKTOK_DEFAULT_ADVERTISER_ID when this company's assignment reaches it,
   * else the company's preferred account, else its only one. Null: choose.
   */
  tiktok_default_connection_id?: string | null;
  business_centers: { provider: LaunchProvider; business_id: string; name: string; account_ids: string[] }[];
  account_warnings?: string[];
  default_destination_url: string; producer_id: string; can_edit: boolean; can_launch: boolean;
  producers?: { id: string; name_zh: string; name_en: string | null }[];
};
export interface LaunchDataLayer {
  /** `fresh` false reads the provider inventory through its short cache: the worker's per-write ownership check uses it. */
  getLaunchConnections(session: Session, producerId: string, provider?: LaunchProvider, fresh?: boolean): Promise<LaunchConnection[]>;
  getLaunchWorkspace(session: Session, producerId?: string): Promise<LaunchWorkspace>;
  listLaunchRuns(session: Session): Promise<LaunchRun[]>;
  getLaunchRun(session: Session, id: string): Promise<LaunchRun>;
  saveLaunchDraft(session: Session, input: LaunchDraft, opts?: { id?: string; producerId?: string; expectedRevision?: number }): Promise<LaunchRun>;
  previewLaunchRun(session: Session, id: string): Promise<LaunchPlan>;
  submitLaunchRun(session: Session, id: string, revision: number, note?: string): Promise<LaunchRun>;
  newLaunchRound(session: Session, id: string): Promise<LaunchRun>;
  retryLaunchRun(session: Session, id: string): Promise<LaunchRun>;
  /** The name people read on the monitor. Approver or staff administrator; refused while the run is being created; never renames a provider object. */
  renameLaunchRun(session: Session, id: string, name: string): Promise<LaunchRun>;
  recordClipSpark(session: Session, creativeId: string, code: string, postUrl?: string): Promise<void>;
  assignLaunchConnection(session: Session, connection: Omit<LaunchConnection, "id" | "assigned_by" | "verified_at">): Promise<LaunchConnection>;
  claimLaunchRun(session: Session, id: string, owner: string): Promise<LaunchRun | null>;
  updateLaunchRun(session: Session, run: LaunchRun, owner: string): Promise<LaunchRun>;
  listPendingLaunchRuns(session: Session): Promise<LaunchRun[]>;
  requestLaunchStop(session: Session, id: string, campaignId: string, end: boolean): Promise<LaunchRun>;
  // Organic clip posting (docs/meta-organic-plan.md §2.4).
  /** Every rendered, non-dismissed clip with a stored SHA-256, joined with its posts. A producer session is always scoped to its own company. */
  listClipLibrary(session: Session, filter: ClipLibraryFilter): Promise<ClipLibraryRow[]>;
  /** Staff administrator or the company's approver. Refuses a second published row for the same clip/platform/connection unless `again`. */
  createClipPost(session: Session, input: PublishClipInput & { caption: string; sha256: string }): Promise<ClipPost>;
  getClipPost(session: Session, id: string): Promise<ClipPost>;
  listClipPosts(session: Session, filter?: { producer_id?: string; clip_id?: string }): Promise<ClipPost[]>;
  /** System session only; CAS on `revision`. `opts.action` names the audited transition. */
  updateClipPost(session: Session, id: string, expectedRevision: number, patch: ClipPostPatch, opts?: { action?: string; actor?: Session }): Promise<ClipPost>;
}
