// Results by title (Ruobin, 2026-09-24: "stats by title"): every launch,
// campaign and ad that promotes a title, with its totals. Pure and
// client-safe: the Monitor's "By title" table, the title's own results page
// and the title pages all read the stored launch runs through these functions,
// so the numbers can never differ between them.
//
// Which ad promotes which title: the ad's own `title_id` (TikTok: one per
// Spark code row; Meta: the clip's), else the launch's title. Which numbers a
// title gets from a campaign:
//   - a campaign whose every ad promotes the title: the campaign's own numbers
//     (the complete reading, TikTok-attributed purchases included);
//   - a campaign that mixes titles: the sum of this title's ads' own numbers
//     (TikTok's per-ad report; a Spark code that never became an ad delivered
//     nothing once the report has read the others); without them the campaign
//     counts, its numbers do not, and `unattributed` says how many such
//     campaigns there are — `unattributed_meta` for Meta, which never reports
//     ads separately.
// Unknown stays null, never zero. Ratios are recomputed from sums, and ROAS
// and cost per purchase only from the spend of campaigns that read purchases
// (a Traffic campaign reads none: its spend is not "no purchases").

import type { AdStats, DeliverySnapshot, LaunchCampaign, LaunchContent, LaunchRun } from "./types";
import type { WebConversions } from "@/lib/tiktok/web-metrics";

/** crazydramas' own attribution dashboard: the second source, by campaign and creative (ad) id. */
export const CRAZYDRAMAS_DASHBOARD_URL = "https://crazydramas.com/admin/dashboard";

export type Numbers = {
  spend_cents: number | null; impressions: number | null; clicks: number | null;
  conversions: number | null;
  /** TikTok-attributed website purchases (Website purchases launches only). */
  purchases: number | null; value_cents: number | null; checkouts: number | null;
  /** The spend of the campaigns (or ads) that read purchases: ROAS and cost per purchase divide by this. */
  web_spend_cents: number | null;
};
export type Totals = Numbers & {
  ctr: number | null; cpc_cents: number | null; roas: number | null; cost_per_purchase_cents: number | null;
  /** Spend that read purchases ÷ checkouts started: what an InitiateCheckout-optimised ad pays per checkout. */
  cost_per_checkout_cents: number | null;
};
type AdStatus = NonNullable<DeliverySnapshot["ads"]>[number];

const EMPTY: Numbers = { spend_cents: null, impressions: null, clicks: null, conversions: null, purchases: null, value_cents: null, checkouts: null, web_spend_cents: null };
const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);

/** Sums of known values; a metric no part knows stays null. */
export function sumNumbers(parts: readonly Numbers[]): Numbers {
  return parts.reduce<Numbers>((sum, n) => ({
    spend_cents: add(sum.spend_cents, n.spend_cents), impressions: add(sum.impressions, n.impressions),
    clicks: add(sum.clicks, n.clicks), conversions: add(sum.conversions, n.conversions),
    purchases: add(sum.purchases, n.purchases), value_cents: add(sum.value_cents, n.value_cents),
    checkouts: add(sum.checkouts, n.checkouts), web_spend_cents: add(sum.web_spend_cents, n.web_spend_cents),
  }), { ...EMPTY });
}

/** The ratios, recomputed from the sums. */
export function totalsOf(n: Numbers): Totals {
  return {
    ...n,
    ctr: n.impressions && n.clicks !== null ? n.clicks / n.impressions : null,
    cpc_cents: n.spend_cents !== null && n.clicks ? Math.round(n.spend_cents / n.clicks) : null,
    roas: n.web_spend_cents && n.value_cents !== null ? Math.round((n.value_cents / n.web_spend_cents) * 100) / 100 : null,
    cost_per_purchase_cents: n.web_spend_cents !== null && n.purchases ? Math.round(n.web_spend_cents / n.purchases) : null,
    cost_per_checkout_cents: n.web_spend_cents !== null && n.checkouts ? Math.round(n.web_spend_cents / n.checkouts) : null,
  };
}

function webNumbers(web: WebConversions | null | undefined, spend: number | null): Pick<Numbers, "purchases" | "value_cents" | "checkouts" | "web_spend_cents"> {
  if (!web) return { purchases: null, value_cents: null, checkouts: null, web_spend_cents: null };
  return { purchases: web.purchases, value_cents: web.purchase_value_cents, checkouts: web.checkouts, web_spend_cents: web.purchases === null ? null : spend };
}

/** A campaign's own reading as numbers. */
export function campaignNumbers(snapshot: DeliverySnapshot | null | undefined): Numbers {
  if (!snapshot) return { ...EMPTY };
  return { spend_cents: snapshot.spend_cents, impressions: snapshot.impressions, clicks: snapshot.clicks, conversions: snapshot.conversions,
    ...webNumbers(snapshot.web, snapshot.spend_cents) };
}

/** One ad's reading as numbers. */
export function adNumbers(stats: AdStats | null | undefined): Numbers {
  if (!stats) return { ...EMPTY };
  return { spend_cents: stats.spend_cents, impressions: stats.impressions, clicks: stats.clicks, conversions: stats.conversions,
    ...webNumbers(stats.web, stats.spend_cents) };
}

/** The title an ad promotes: its own, else (TikTok) the launch's. */
export function adTitleId(run: Pick<LaunchRun, "draft">, item: Pick<LaunchContent, "title_id">): string | null {
  return item.title_id ?? (run.draft.provider === "tiktok" ? run.draft.title_id ?? null : null);
}

/** Every title a launch promotes, its own first. */
export function runTitleIds(run: Pick<LaunchRun, "draft" | "campaigns">): string[] {
  const ids = new Set<string>();
  if (run.draft.provider === "tiktok" && run.draft.title_id) ids.add(run.draft.title_id);
  for (const item of [...run.draft.content, ...run.campaigns.flatMap((c) => c.content)]) {
    const id = adTitleId(run, item);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The titles one campaign's ads promote. */
export function campaignTitleIds(run: Pick<LaunchRun, "draft">, campaign: Pick<LaunchCampaign, "content">): string[] {
  return [...new Set(campaign.content.map((item) => adTitleId(run, item)).filter((id): id is string => !!id))];
}

/**
 * The provider ads that carry one content item (a Spark code, a post): the
 * ad and any copies the auto-duplicate made of it, matched by the reference
 * the sweep recorded.
 */
export function adsOfContent(campaign: Pick<LaunchCampaign, "snapshot">, item: Pick<LaunchContent, "value">): AdStatus[] {
  return (campaign.snapshot?.ads ?? []).filter((ad) => ad.content_value === item.value);
}

/**
 * TikTok read this campaign's ads one by one: the sweep recorded the ads and
 * the per-ad report did not fail. Only then is a content item with no ad at
 * all (a Spark code TikTok refused for good when the ads were made) known to
 * have delivered nothing.
 */
function adsReportRead(campaign: Pick<LaunchCampaign, "snapshot">): boolean {
  return !!campaign.snapshot?.ads && !campaign.snapshot.ad_stats_error;
}

/** Observed zero delivery; the purchase fields are zero only on a campaign that reads purchases. */
function observedZero(snapshot: DeliverySnapshot | null | undefined): Numbers {
  const web = !!snapshot?.web;
  return { spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, purchases: web ? 0 : null, value_cents: web ? 0 : null, checkouts: web ? 0 : null, web_spend_cents: web ? 0 : null };
}

/**
 * One content item's numbers: its ads' own, summed. A TikTok item that never
 * became an ad, on a campaign whose ads TikTok did report, delivered nothing
 * (observed zero). Null when no ad of it has numbers yet.
 */
export function contentNumbers(campaign: Pick<LaunchCampaign, "snapshot">, item: Pick<LaunchContent, "value">, provider: "tiktok" | "meta" = "tiktok"): Numbers | null {
  const ads = adsOfContent(campaign, item);
  const withStats = ads.filter((ad) => ad.stats);
  if (withStats.length) return sumNumbers(withStats.map((ad) => adNumbers(ad.stats)));
  if (provider === "tiktok" && ads.length === 0 && adsReportRead(campaign)) return observedZero(campaign.snapshot);
  return null;
}

export type TitleAd = {
  run: LaunchRun; campaign: LaunchCampaign; item: LaunchContent; position: number;
  ads: AdStatus[]; totals: Totals | null;
};
export type TitleCampaign = {
  run: LaunchRun; campaign: LaunchCampaign;
  /** Every ad of the campaign promotes this title. */
  whole: boolean;
  /** Null: the campaign mixes titles and TikTok has not reported its ads separately yet. */
  totals: Totals | null;
  ads: TitleAd[];
};
export type TitleResults = {
  title_id: string; totals: Totals;
  launches: number; campaigns: TitleCampaign[]; ads: number;
  /** TikTok campaigns that mix titles whose ads have no numbers of their own yet: counted, not added up (a Refresh may read them). */
  unattributed: number;
  /** Meta campaigns that mix titles (or a clip and a Page post): Meta's numbers are per campaign, never per ad, so they are counted and never added up. */
  unattributed_meta: number;
  /** When a campaign of this title was last read. */
  checked_at: string | null;
};

/** Everything one title's launches did. Drafts have no campaigns and add nothing. */
export function titleResults(runs: readonly LaunchRun[], titleId: string): TitleResults {
  const campaigns: TitleCampaign[] = [];
  const launches = new Set<string>();
  let checked: string | null = null;
  for (const run of runs) {
    for (const campaign of run.campaigns) {
      const own = campaign.content.map((item, i) => ({ item, position: i + 1 })).filter(({ item }) => adTitleId(run, item) === titleId);
      if (!own.length) continue;
      launches.add(run.id);
      const provider = run.draft.provider === "meta" ? "meta" : "tiktok";
      const ads: TitleAd[] = own.map(({ item, position }) => {
        const numbers = contentNumbers(campaign, item, provider);
        return { run, campaign, item, position, ads: adsOfContent(campaign, item), totals: numbers ? totalsOf(numbers) : null };
      });
      const whole = own.length === campaign.content.length;
      let numbers: Numbers | null;
      if (whole) numbers = campaignNumbers(campaign.snapshot);
      else numbers = ads.every((ad) => ad.totals) ? sumNumbers(ads.map((ad) => ad.totals!)) : null;
      campaigns.push({ run, campaign, whole, totals: numbers ? totalsOf(numbers) : null, ads });
      const at = campaign.snapshot?.checked_at;
      if (at && (!checked || at > checked)) checked = at;
    }
  }
  return {
    title_id: titleId,
    totals: totalsOf(sumNumbers(campaigns.filter((c) => c.totals).map((c) => c.totals!))),
    launches: launches.size, campaigns, ads: campaigns.reduce((n, c) => n + c.ads.length, 0),
    unattributed: campaigns.filter((c) => !c.totals && c.run.draft.provider !== "meta").length,
    unattributed_meta: campaigns.filter((c) => !c.totals && c.run.draft.provider === "meta").length,
    checked_at: checked,
  };
}

/** Every title any launch promotes, with its results, most spend first. */
export function resultsByTitle(runs: readonly LaunchRun[]): TitleResults[] {
  const ids = new Set(runs.flatMap((run) => run.campaigns.length ? runTitleIds(run) : []));
  return [...ids].map((id) => titleResults(runs, id)).filter((r) => r.campaigns.length > 0)
    .sort((a, b) => (b.totals.spend_cents ?? -1) - (a.totals.spend_cents ?? -1) || b.launches - a.launches);
}
