// The launch monitor's data — Pulsar Grow's lib/monitor.ts on Studio's
// records (decision 2026-09-16). One row per launched campaign, built from
// three reads per campaign against TikTok:
//   /campaign/get/           the switch, TikTok's richer state (PUNISH = the
//                            account is suspended), the campaign cap
//   /adgroup/get/            every ad group with its switch, budget, bid,
//                            schedule end — the original, the copies, the
//                            retired ones
//   /report/integrated/get/  lifetime spend, impressions, clicks, conversions
// plus the review verdicts (lib/tiktok/review.ts) and the account's status.
//
// Cached 90 s on globalThis (Next bundles lib/ per route); every control
// invalidates it, and ?force=1 re-sweeps. A campaign whose sweep fails keeps
// its own records and carries the error, never a zero.

import type { Session } from "@/lib/auth";
import { getData, type LaunchedCampaign } from "@/lib/data";
import { accountHealth, accountStatusLabel, type AccountHealth } from "./account-health";
import { activeAdGroupIds } from "./controls";
import { accessTokenFor, tiktokTransport } from "./index";
import { fetchCampaignReviews, type AdReview, type ReviewState } from "./review";
import { normalizeLaunchSettings, type LaunchSettings } from "./settings";

export type MonitorAdGroup = {
  adgroup_id: string;
  name: string;
  role: "primary" | "copy";
  retired: boolean;
  on: boolean | null;
  secondary: string | null;
  budget: number | null;
  budget_mode: string | null;
  bid_type: string | null;
  bid: number | null;
  billing_event: string | null;
  schedule_end: string | null;
  ad_ids: string[];
};

export type MonitorRow = {
  campaign_id: string;
  external_id: string;
  name: string;
  producer_id: string;
  title_id: string;
  status: string;
  status_note: string | null;
  launched_at: string | null;
  tiktok_campaign_id: string;
  advertiser_id: string;
  account: { name: string | null; status: string | null; health: AccountHealth; label: string; suspended: boolean };
  on: boolean | null;
  campaign_secondary: string | null;
  campaign_cap: number | null;
  budget_usd: number;
  settings: LaunchSettings;
  adgroups: MonitorAdGroup[];
  review: { rollup: ReviewState | "none"; ads: AdReview[]; reasons: string[] };
  metrics: { spend: number; impressions: number; clicks: number; conversions: number; cpc: number | null; ctr: number | null } | null;
  sweep_error: string | null;
  swept_at: string;
};

const CACHE_TTL_MS = 90_000;
const store = globalThis as unknown as { __studioMonitor?: { at: number; rows: MonitorRow[] } };

export function invalidateMonitor(): void {
  delete store.__studioMonitor;
}

/** The one-word verdict for a campaign: the worst state that is present, in the order a person needs to hear it. */
export function rollupReview(ads: AdReview[]): ReviewState | "none" {
  if (!ads.length) return "none";
  for (const s of ["rejected", "limited", "in_review", "not_reviewed", "approved", "unknown"] as ReviewState[]) if (ads.some((a) => a.state === s)) return s;
  return "unknown";
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function sweep(row: LaunchedCampaign): Promise<MonitorRow> {
  const { campaign, launch } = row;
  const settings = normalizeLaunchSettings(launch.settings);
  const out: MonitorRow = {
    campaign_id: campaign.id, external_id: campaign.external_id, name: campaign.name, producer_id: campaign.producer_id, title_id: campaign.title_id,
    status: campaign.status, status_note: campaign.status_note, launched_at: campaign.launched_at,
    tiktok_campaign_id: launch.tiktok_campaign_id ?? campaign.grow_campaign_id ?? "", advertiser_id: launch.advertiser_id,
    account: { name: null, status: null, health: "unknown", label: accountStatusLabel(undefined), suspended: false },
    on: null, campaign_secondary: null, campaign_cap: null, budget_usd: launch.budget_usd, settings, adgroups: [],
    review: { rollup: "none", ads: [], reasons: [] }, metrics: null, sweep_error: null, swept_at: new Date().toISOString(),
  };
  const token = accessTokenFor(launch.advertiser_id);
  if (!token) {
    out.sweep_error = "no TikTok connection covers this ad account";
    return out;
  }
  const tt = tiktokTransport();
  const errors: string[] = [];
  // the account
  const info = await tt.get("/advertiser/info/", token, { advertiser_ids: JSON.stringify([launch.advertiser_id]), fields: JSON.stringify(["advertiser_id", "name", "status"]) });
  const acct = ((info.data?.list ?? []) as Record<string, unknown>[])[0];
  if (info.code === 0 && acct) {
    out.account.name = typeof acct.name === "string" ? acct.name : null;
    out.account.status = typeof acct.status === "string" ? acct.status : null;
    out.account.health = accountHealth(out.account.status ?? undefined);
    out.account.label = accountStatusLabel(out.account.status ?? undefined);
  } else if (info.code !== 0) errors.push(`account: ${info.message}`);
  // the campaign
  const camp = await tt.get("/campaign/get/", token, { advertiser_id: launch.advertiser_id, filtering: JSON.stringify({ campaign_ids: [out.tiktok_campaign_id] }), page: 1, page_size: 1 });
  const live = ((camp.data?.list ?? []) as Record<string, unknown>[])[0];
  if (camp.code === 0 && live) {
    out.on = live.operation_status !== "DISABLE";
    out.campaign_secondary = live.secondary_status ? String(live.secondary_status) : null;
    out.campaign_cap = live.budget_mode === "BUDGET_MODE_TOTAL" ? num(live.budget) : null;
    if (out.campaign_secondary?.includes("PUNISH")) out.account.suspended = true;
  } else errors.push(`campaign: ${camp.code !== 0 ? camp.message : "not found on TikTok"}`);
  // the ad groups
  const groups = await tt.get("/adgroup/get/", token, { advertiser_id: launch.advertiser_id, filtering: JSON.stringify({ campaign_ids: [out.tiktok_campaign_id] }), page: 1, page_size: 100 });
  const known = new Map<string, string[]>([[launch.tiktok_adgroup_id ?? "", Object.values(launch.ad_ids)], ...Object.entries(launch.duplicates ?? {})]);
  const retired = new Set(launch.retired_adgroups ?? []);
  if (groups.code === 0) {
    for (const g of (groups.data?.list ?? []) as Record<string, unknown>[]) {
      const id = String(g.adgroup_id ?? "");
      if (!known.has(id)) continue; // not ours (never happens for a Studio campaign, but never trust a list blindly)
      const billing = String(g.billing_event ?? "");
      out.adgroups.push({
        adgroup_id: id, name: String(g.adgroup_name ?? ""), role: id === launch.tiktok_adgroup_id ? "primary" : "copy", retired: retired.has(id),
        on: g.operation_status !== undefined ? g.operation_status !== "DISABLE" : null, secondary: g.secondary_status ? String(g.secondary_status) : null,
        budget: num(g.budget), budget_mode: g.budget_mode ? String(g.budget_mode) : null, bid_type: g.bid_type ? String(g.bid_type) : null,
        bid: num(billing === "CPC" ? g.bid_price : g.conversion_bid_price), billing_event: billing || null, schedule_end: g.schedule_end_time ? String(g.schedule_end_time) : null,
        ad_ids: known.get(id) ?? [],
      });
    }
  } else errors.push(`ad groups: ${groups.message}`);
  // the review
  try {
    const r = await fetchCampaignReviews(row);
    out.review = { rollup: rollupReview(r.reviews), ads: r.reviews, reasons: [...new Set(r.reviews.flatMap((a) => a.reasons))] };
    if (r.error) errors.push(`review: ${r.error}`);
  } catch (e) {
    errors.push(`review: ${(e as Error).message}`);
  }
  // lifetime numbers
  const since = (campaign.launched_at ?? launch.created_at).slice(0, 10);
  const rep = await tt.get("/report/integrated/get/", token, {
    advertiser_id: launch.advertiser_id, report_type: "BASIC", data_level: "AUCTION_CAMPAIGN", dimensions: JSON.stringify(["campaign_id"]),
    metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion"]), start_date: since, end_date: new Date().toISOString().slice(0, 10),
    filtering: JSON.stringify([{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([out.tiktok_campaign_id]) }]), page_size: 200,
  });
  if (rep.code === 0) {
    const m = { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
    for (const r of (rep.data?.list ?? []) as Array<{ metrics?: Record<string, unknown> }>) {
      m.spend += num(r.metrics?.spend) ?? 0;
      m.impressions += num(r.metrics?.impressions) ?? 0;
      m.clicks += num(r.metrics?.clicks) ?? 0;
      m.conversions += num(r.metrics?.conversion) ?? 0;
    }
    out.metrics = { ...m, spend: Math.round(m.spend * 100) / 100, cpc: m.clicks > 0 ? Math.round((m.spend / m.clicks) * 100) / 100 : null, ctr: m.impressions > 0 ? m.clicks / m.impressions : null };
  } else errors.push(`report: ${rep.message}`);
  out.sweep_error = errors.length ? errors.join(" · ") : null;
  return out;
}

/** Every launched campaign the session may see, swept (cached), newest launch first. */
export async function buildMonitor(session: Session, opts: { force?: boolean; campaignId?: string } = {}): Promise<{ rows: MonitorRow[]; swept_at: string; cached: boolean }> {
  const hit = store.__studioMonitor;
  const data = getData();
  const launched = opts.campaignId ? [await data.getLaunchedCampaign(session, opts.campaignId)].filter((r): r is LaunchedCampaign => !!r) : await data.listLaunchedPromoCampaigns(session, { all: true });
  if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL_MS && !opts.campaignId) {
    const mine = new Set(launched.map((r) => r.campaign.id));
    const rows = hit.rows.filter((r) => mine.has(r.campaign_id));
    if (rows.length === launched.length) return { rows, swept_at: new Date(hit.at).toISOString(), cached: true };
  }
  const rows: MonitorRow[] = [];
  for (const row of launched) rows.push(await sweep(row));
  rows.sort((a, b) => (b.launched_at ?? "").localeCompare(a.launched_at ?? ""));
  const at = Date.now();
  if (!opts.campaignId && session.kind === "staff") store.__studioMonitor = { at, rows };
  else if (opts.campaignId && hit) hit.rows = hit.rows.map((r) => rows.find((x) => x.campaign_id === r.campaign_id) ?? r);
  return { rows, swept_at: new Date(at).toISOString(), cached: false };
}
