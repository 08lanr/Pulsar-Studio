import type { Session } from "@/lib/auth";
import type { LaunchSettings } from "@/lib/tiktok/settings";

export type LaunchProvider = "tiktok" | "meta";
export type ContentKind = "spark" | "facebook_post" | "instagram_post" | "video";
export type LaunchContent = {
  kind: ContentKind; value: string; label?: string; creative_id?: string; title_id?: string;
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
  tiktok_settings: LaunchSettings; meta_settings: MetaLaunchSettings;
};
export type LaunchConnection = {
  id: string; producer_id: string; provider: LaunchProvider; advertiser_id: string; name: string;
  currency: string; timezone: string; page_id: string | null; instagram_id: string | null;
  business_id: string | null; assigned_by: string; verified_at: string; enabled: boolean;
  business_name?: string;
};
export type LaunchPlanRow = {
  index: number; connection_id: string; advertiser_id: string; name: string;
  /** Stable Studio campaign identifier. Absent on campaigns approved before this field existed. */
  campid?: string;
  /** Campaign-specific HTTP(S) destination with campid attribution; absent on legacy approvals. */
  tracking_url?: string;
  content: LaunchContent[]; budget_cents: number; daily_budget_cents: number | null;
};
export type LaunchPlan = {
  rows: LaunchPlanRow[]; total_budget_cents: number; daily_total_cents: number | null;
  campaign_count: number; account_count: number; content_count: number; warnings: string[];
};
export type DeliveryState = "submitted" | "review" | "live" | "paused" | "ended" | "rejected" | "failed" | "suspended" | "unknown";
export type DeliverySnapshot = {
  delivery: DeliveryState; note: string | null; checked_at: string;
  spend_cents: number | null; impressions: number | null; clicks: number | null;
  conversions: number | null; cpc_cents: number | null;
  configured_status?: string; effective_status?: string;
  ads?: { id: string; status: string; note?: string; content_value?: string }[];
  groups?: { id: string; status: string; budget_cents?: number; bid_cents?: number | null; end_time?: string }[];
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
export type LaunchWorkspace = {
  connections: LaunchConnection[]; library: LaunchLibraryItem[]; runs: LaunchRun[];
  business_centers: { provider: LaunchProvider; business_id: string; name: string; account_ids: string[] }[];
  account_warnings?: string[];
  default_destination_url: string; producer_id: string; can_edit: boolean; can_launch: boolean;
  producers?: { id: string; name_zh: string; name_en: string | null }[];
};
export interface LaunchDataLayer {
  getLaunchConnections(session: Session, producerId: string, provider?: LaunchProvider): Promise<LaunchConnection[]>;
  getLaunchWorkspace(session: Session, producerId?: string): Promise<LaunchWorkspace>;
  listLaunchRuns(session: Session): Promise<LaunchRun[]>;
  getLaunchRun(session: Session, id: string): Promise<LaunchRun>;
  saveLaunchDraft(session: Session, input: LaunchDraft, opts?: { id?: string; producerId?: string; expectedRevision?: number }): Promise<LaunchRun>;
  previewLaunchRun(session: Session, id: string): Promise<LaunchPlan>;
  submitLaunchRun(session: Session, id: string, revision: number, note?: string): Promise<LaunchRun>;
  newLaunchRound(session: Session, id: string): Promise<LaunchRun>;
  retryLaunchRun(session: Session, id: string): Promise<LaunchRun>;
  recordClipSpark(session: Session, creativeId: string, code: string, postUrl?: string): Promise<void>;
  assignLaunchConnection(session: Session, connection: Omit<LaunchConnection, "id" | "assigned_by" | "verified_at">): Promise<LaunchConnection>;
  claimLaunchRun(session: Session, id: string, owner: string): Promise<LaunchRun | null>;
  updateLaunchRun(session: Session, run: LaunchRun, owner: string): Promise<LaunchRun>;
  listPendingLaunchRuns(session: Session): Promise<LaunchRun[]>;
  requestLaunchStop(session: Session, id: string, campaignId: string, end: boolean): Promise<LaunchRun>;
}
