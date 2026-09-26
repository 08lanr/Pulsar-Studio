// The Campaigns tab and the Overview's money (decision 2026-09-26, "Stats: campaigns, buyers and the full
// episode curve"). Pure and client-safe; tests/crazydramas-buyers.test.ts.
//
//   - which clip every TikTok ad played (Ruobin: "I need to see which clip it is so I can recreate more"):
//     TikTok's ad id -> the campaign's content code (the snapshot's `content_value`, the ad groups' record,
//     the uploaded video id or the post's item id) -> the launch's content item -> the Studio clip, with its
//     ad type (lib/ad-formats.ts), its text and its file;
//   - what TikTok says each campaign sold against what crazydramas saw, and a short reason for any gap;
//   - totals per ad type, and a period's ad spend (overall and per day).

import type { AdFormat } from "@/lib/ad-formats";
import type { ContentKind, LaunchContent, LaunchProvider, LaunchRun } from "@/lib/launch/types";
import { purchaseGoal, type LaunchSettings, type PurchaseGoal } from "@/lib/tiktok/settings";
import { dayIn, deliveryIn, type AdPeriod, type AdRow, type AdSpend, type CampaignRow } from "./stats-summary";
import type { BoughtBy, BuyerCounts } from "./stats-buyers";

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

// ---- which clip each ad played ------------------------------------------------------------------------------

/** What the stats need of a Studio clip (studio.clips). */
export type CreativeClip = { id: string; title_id: string; ad_format: AdFormat | null; hook_en: string; render_path: string | null };

export type AdCreative = {
  ad_id: string;
  provider: LaunchProvider;
  run_id: string;
  launch_name: string;
  campaign_id: string | null;
  campaign_name: string;
  /** The campaign's content code the ad was made from (a clip id, a post id, a Spark code). */
  code: string | null;
  kind: ContentKind | null;
  clip_id: string | null;
  ad_format: AdFormat | null;
  /** The ad's words: the clip's hook, else the content's own text. */
  text: string | null;
  /** The stored file that ran, and its name as it was uploaded ("flirt-hook-v1.mp4"). */
  file_path: string | null;
  file_name: string | null;
  title_id: string | null;
};

/** A stored path's file name as the person uploaded it: an uploaded ad's key carries a hash prefix (`upload-<16 hex>-`). */
export function sourceFileName(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split("/").pop() ?? path;
  return base.replace(/^upload-[0-9a-f]{16}-/, "") || null;
}

type CampaignState = {
  campaign_id?: unknown;
  groups?: { ads?: Record<string, string> }[];
  uploads?: Record<string, { video_id?: string }>;
  posts?: { code?: string; item_id?: string; video_id?: string }[];
  settings?: LaunchSettings;
};

/** The clip id a content item names: its own `clip_id`, or the value of a Studio clip item. */
function clipIdOf(item: LaunchContent | undefined, code: string | null, uploads: CampaignState["uploads"]): string | null {
  if (item?.clip_id) return item.clip_id;
  if (item?.kind === "video") return item.value.trim();
  return code && uploads?.[code] ? code : null;
}

/**
 * Every ad of every launch, by its provider's ad id, with the content and clip it was made from. The first run
 * that names an ad keeps it. An ad whose content cannot be found keeps its campaign and nothing else.
 */
export function adCreatives(runs: readonly LaunchRun[], clips: ReadonlyMap<string, CreativeClip>): Map<string, AdCreative> {
  const out = new Map<string, AdCreative>();
  for (const run of runs) {
    for (const c of run.campaigns ?? []) {
      const state = (c.state ?? {}) as CampaignState;
      const codeById = new Map<string, string>();
      for (const g of state.groups ?? []) for (const [code, id] of Object.entries(g.ads ?? {})) codeById.set(str(id), code);
      const ids = new Set<string>([...codeById.keys()]);
      for (const ad of c.snapshot?.ads ?? []) {
        if (!ad.id) continue;
        ids.add(ad.id);
        const raw = ad as { content_value?: string; item_id?: string; video_id?: string };
        let code = raw.content_value ?? codeById.get(ad.id) ?? null;
        if (!code && raw.video_id) code = Object.entries(state.uploads ?? {}).find(([, u]) => u.video_id === raw.video_id)?.[0] ?? null;
        if (!code && raw.item_id) code = (state.posts ?? []).find((p) => p.item_id === raw.item_id)?.code ?? null;
        if (code) codeById.set(ad.id, code);
      }
      for (const id of ids) {
        if (out.has(id)) continue;
        const code = codeById.get(id) ?? null;
        const item = code ? (c.content ?? []).find((i) => i.value.trim() === code) ?? (run.draft?.content ?? []).find((i) => i.value.trim() === code) : undefined;
        const clipId = clipIdOf(item, code, state.uploads);
        const clip = clipId ? clips.get(clipId) : undefined;
        const file = clip?.render_path ?? item?.file_path ?? null;
        out.set(id, {
          ad_id: id,
          provider: run.draft?.provider ?? "tiktok",
          run_id: run.external_id,
          launch_name: run.draft?.name ?? run.external_id,
          campaign_id: str(state.campaign_id) || null,
          campaign_name: c.name,
          code,
          kind: item?.kind ?? (clipId ? "video" : null),
          clip_id: clipId,
          ad_format: clip?.ad_format ?? null,
          text: clip?.hook_en?.trim() || item?.text?.trim() || item?.label?.trim() || null,
          file_path: file,
          file_name: sourceFileName(file),
          title_id: item?.title_id ?? clip?.title_id ?? null,
        });
      }
    }
  }
  return out;
}

/** The clip ids the launches' content names (to read only those clips). */
export function launchClipTitles(runs: readonly LaunchRun[]): Map<string, Set<string>> {
  const byTitle = new Map<string, Set<string>>();
  for (const run of runs) {
    for (const c of run.campaigns ?? []) {
      for (const item of c.content ?? []) {
        const clip = item.clip_id ?? (item.kind === "video" ? item.value.trim() : null);
        const title = item.title_id ?? run.draft?.title_id ?? null;
        if (clip && title) byTitle.set(title, (byTitle.get(title) ?? new Set()).add(clip));
      }
    }
  }
  return byTitle;
}

// ---- what TikTok says against what we saw ---------------------------------------------------------------------

export type CampaignFacts = {
  campaign_id: string;
  provider: LaunchProvider;
  /** What the campaign optimizes toward (lib/tiktok/settings.ts purchaseGoal); Meta campaigns optimize clicks or page views. */
  goal: PurchaseGoal;
  /** TikTok's own purchases (complete_payment, its click/view windows) over the campaign's life; null when it did not report them. */
  tiktok_purchases: number | null;
  /** Each ad's, the same way. */
  ad_purchases: Map<string, number | null>;
  launched_at: string | null;
};

/** Each launched campaign's goal and TikTok's purchases, by the provider's campaign id. */
export function campaignFacts(runs: readonly LaunchRun[]): Map<string, CampaignFacts> {
  const out = new Map<string, CampaignFacts>();
  for (const run of runs) {
    for (const c of run.campaigns ?? []) {
      const state = (c.state ?? {}) as CampaignState;
      const id = str(state.campaign_id);
      if (!id || out.has(id)) continue;
      const provider = run.draft?.provider ?? "tiktok";
      const settings = state.settings ?? run.draft?.tiktok_settings;
      const goal: PurchaseGoal =
        provider === "meta" ? (run.draft?.meta_settings?.optimization_goal === "LANDING_PAGE_VIEWS" ? "page_views" : "clicks") : settings ? purchaseGoal(settings) : "clicks";
      const web = c.snapshot?.web;
      out.set(id, {
        campaign_id: id,
        provider,
        goal,
        tiktok_purchases: web?.purchases ?? null,
        ad_purchases: new Map((c.snapshot?.ads ?? []).map((a) => [a.id, a.stats?.web?.purchases ?? null])),
        launched_at: run.created_at ?? null,
      });
    }
  }
  return out;
}

/** Why TikTok's purchases and ours differ (or that they match), in the order the chips show. */
export type GapReason =
  | { code: "no_spend" }
  | { code: "not_purchases"; goal: PurchaseGoal }
  | { code: "outside_period" }
  | { code: "not_reported" }
  | { code: "tiktok_higher" }
  | { code: "untagged"; n: number }
  | { code: "we_higher" }
  | { code: "match" };

/**
 * The reasons for one campaign (or ad): no spend yet; a goal that is not purchases (TikTok then counts none);
 * TikTok's numbers are its whole life and the period starts after the launch; TikTok did not report; TikTok
 * higher (it also counts view-through and dates by the ad view), with the buyers who came from TikTok without
 * a campaign tag as a likely part of it; we saw more; or they match.
 */
export function gapReasons(x: { spend_cents: number | null; goal: PurchaseGoal | null; tiktok: number | null; ours: number; untagged: number; in_period: boolean }): GapReason[] {
  if (!x.spend_cents && x.ours === 0 && !x.tiktok) return [{ code: "no_spend" }];
  if (x.goal && x.goal !== "purchases") return [{ code: "not_purchases", goal: x.goal }];
  if (!x.in_period) return [{ code: "outside_period" }];
  if (x.tiktok === null) return [{ code: "not_reported" }];
  if (x.tiktok > x.ours) return x.untagged > 0 ? [{ code: "tiktok_higher" }, { code: "untagged", n: x.untagged }] : [{ code: "tiktok_higher" }];
  if (x.ours > x.tiktok) return [{ code: "we_higher" }];
  return [{ code: "match" }];
}

/** TikTok's lifetime purchases compare with a period only when the campaign's whole life is in it (as `deliveryIn` does for spend). */
export function lifeInPeriod(launchedAt: string | null, period: AdPeriod | undefined): boolean {
  if (!period) return true;
  return !!launchedAt && dayIn(launchedAt, period.timezone) >= period.from;
}

// ---- the Campaigns table ------------------------------------------------------------------------------------

export type Seen = { people: number; purchases: number; revenue_cents: number };

export type CompareAd = {
  ad_id: string;
  spend_cents: number | null;
  clicks: number | null;
  opened: number;
  started_ep1: number;
  finished_ep1: number;
  watched_ep2: number;
  cost_per_finisher_cents: number | null;
  /** The series the ad's people opened, most first. */
  titles: string[];
  tiktok: number | null;
  ours: Seen;
  reasons: GapReason[];
  creative: AdCreative | null;
};

export type CompareCampaign = {
  key: string;
  kind: CampaignRow["kind"];
  campaign_id: string | null;
  launch_name: string | null;
  campaign_name: string | null;
  launched_at: string | null;
  goal: PurchaseGoal | null;
  spend_cents: number | null;
  clicks: number | null;
  opened: number;
  finished_ep1: number;
  tiktok: number | null;
  ours: Seen;
  reasons: GapReason[];
  ads: CompareAd[];
};

const seenOf = (counts: BuyerCounts | undefined, fallback: { buyers: number; revenue_cents: number }, havePurchases: boolean): Seen =>
  havePurchases ? { people: counts?.people ?? 0, purchases: counts?.purchases ?? 0, revenue_cents: counts?.revenue_cents ?? 0 } : { people: fallback.buyers, purchases: fallback.buyers, revenue_cents: fallback.revenue_cents };

/**
 * The campaign rows (`campaignTable`) with what TikTok says and what we saw, per campaign and per ad. "We saw" is
 * the buyers whose payment's landing carried the campaign (or ad): from the report's payments when it has them
 * (people and payments apart), else the source rows' buyers. `untagged`: buyers from TikTok with no campaign tag.
 */
export function compareCampaigns(
  rows: readonly CampaignRow[],
  facts: ReadonlyMap<string, CampaignFacts>,
  creatives: ReadonlyMap<string, AdCreative>,
  bought: BoughtBy | null,
  untagged: number,
  period: AdPeriod | undefined,
): CompareCampaign[] {
  return rows.map((r) => {
    const f = r.campaign_id ? facts.get(r.campaign_id) : undefined;
    const inPeriod = lifeInPeriod(f?.launched_at ?? r.launched_at, period);
    const tiktok = f && f.goal === "purchases" && inPeriod ? f.tiktok_purchases : null;
    const ours = seenOf(r.kind === "campaign" ? (r.campaign_id ? bought?.campaigns.get(r.campaign_id) : undefined) : bought?.other.get(r.kind), r, !!bought);
    const ads: CompareAd[] = r.ads.map((a: AdRow) => {
      const id = a.ad ?? "";
      const adTikTok = f && f.goal === "purchases" && inPeriod ? (f.ad_purchases.get(id) ?? null) : null;
      const adOurs = seenOf(bought?.ads.get(id), a, !!bought);
      return {
        ad_id: id,
        spend_cents: a.spend_cents,
        clicks: a.clicks,
        opened: a.opened,
        started_ep1: a.started_ep1,
        finished_ep1: a.finished_ep1,
        watched_ep2: a.watched_ep2,
        cost_per_finisher_cents: a.cost_per_finisher_cents,
        titles: a.titles.map((t) => t.title),
        tiktok: adTikTok,
        ours: adOurs,
        reasons: r.kind === "campaign" ? gapReasons({ spend_cents: a.spend_cents, goal: f?.goal ?? null, tiktok: adTikTok, ours: adOurs.people, untagged: 0, in_period: inPeriod }) : [],
        creative: creatives.get(id) ?? null,
      };
    });
    return {
      key: r.key,
      kind: r.kind,
      campaign_id: r.campaign_id,
      launch_name: r.launch_name,
      campaign_name: r.campaign_name,
      launched_at: r.launched_at,
      goal: f?.goal ?? null,
      spend_cents: r.spend_cents,
      clicks: r.clicks,
      opened: r.opened,
      finished_ep1: r.finished_ep1,
      tiktok,
      ours,
      reasons: r.kind === "campaign" ? gapReasons({ spend_cents: r.spend_cents, goal: f?.goal ?? null, tiktok, ours: ours.people, untagged, in_period: inPeriod }) : [],
      ads,
    };
  });
}

// ---- by ad type ---------------------------------------------------------------------------------------------

export type AdTypeRow = {
  format: AdFormat | "none";
  ads: number;
  spend_cents: number | null;
  clicks: number | null;
  opened: number;
  finished_ep1: number;
  buyers: number;
  revenue_cents: number;
  cost_per_finisher_cents: number | null;
  cost_per_buyer_cents: number | null;
};

/** Every ad's numbers added up by the ad type of the clip it played ("none": not classified or not a Studio clip), most spent first. */
export function byAdType(ads: readonly CompareAd[]): AdTypeRow[] {
  const groups = new Map<AdTypeRow["format"], AdTypeRow>();
  for (const a of ads) {
    const format = a.creative?.ad_format ?? "none";
    const g = groups.get(format) ?? { format, ads: 0, spend_cents: null, clicks: null, opened: 0, finished_ep1: 0, buyers: 0, revenue_cents: 0, cost_per_finisher_cents: null, cost_per_buyer_cents: null };
    g.ads += 1;
    if (a.spend_cents != null) g.spend_cents = (g.spend_cents ?? 0) + a.spend_cents;
    if (a.clicks != null) g.clicks = (g.clicks ?? 0) + a.clicks;
    g.opened += a.opened;
    g.finished_ep1 += a.finished_ep1;
    g.buyers += a.ours.people;
    g.revenue_cents += a.ours.revenue_cents;
    groups.set(format, g);
  }
  const per = (c: number | null, n: number) => (c != null && n > 0 ? Math.round(c / n) : null);
  return [...groups.values()]
    .map((g) => ({ ...g, cost_per_finisher_cents: per(g.spend_cents, g.finished_ep1), cost_per_buyer_cents: per(g.spend_cents, g.buyers) }))
    .sort((a, b) => Number(a.format === "none") - Number(b.format === "none") || (b.spend_cents ?? -1) - (a.spend_cents ?? -1));
}

// ---- the Overview's money -----------------------------------------------------------------------------------

/** Ad spend over a period (every ad's `deliveryIn`), or each ad's lifetime without one; `partial` when some ad's spend is unknown. */
export function spendIn(spends: readonly AdSpend[], period: AdPeriod | undefined): { cents: number | null; partial: boolean } {
  let cents: number | null = null;
  let partial = false;
  for (const s of spends) {
    const v = period ? deliveryIn(s, period).spend_cents : s.spend_cents;
    if (v === null) partial = true;
    else cents = (cents ?? 0) + v;
  }
  return { cents, partial: partial && cents !== null };
}

/**
 * The spend of each day of a span from TikTok's own days (lib/tiktok/ad-days.ts): a covered campaign's ad with no
 * row that day spent nothing; a day before the read, or with no read at all, is unknown (null).
 */
export function dailySpend(spends: readonly AdSpend[], days: AdPeriod["days"], span: { from: string; to: string }): { day: string; cents: number | null }[] {
  const out: { day: string; cents: number | null }[] = [];
  const covered = days?.ok ? spends.filter((s) => s.provider === "tiktok" && s.campaign_id && days.campaigns.includes(s.campaign_id)) : [];
  for (let day = span.from; day <= span.to; day = nextDay(day)) {
    if (!days?.ok || day < days.from) {
      out.push({ day, cents: null });
      continue;
    }
    let cents = 0;
    for (const s of covered) for (const d of days.days[s.ad_id] ?? []) if (d.day === day) cents += d.spend_cents ?? 0;
    out.push({ day, cents });
  }
  return out;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Revenue per dollar of ad spend (0.42 = 42 cents back per dollar); null without spend. */
export function returnOnSpend(revenueCents: number, spendCents: number | null): number | null {
  return spendCents && spendCents > 0 ? revenueCents / spendCents : null;
}

/** "0.42×" */
export function fmtRatio(v: number | null): string {
  return v === null ? "–" : `${v < 10 ? v.toFixed(2) : Math.round(v)}×`;
}

/**
 * The change from before to now (0.12 = up 12%), only when the period before had at least `min` of it (money in
 * cents: under $10 before, "up 400%" says nothing); null otherwise.
 */
export function changeAbove(now: number | null, before: number | null, min: number): number | null {
  return now === null || before === null || before < min || before === 0 ? null : (now - before) / before;
}
