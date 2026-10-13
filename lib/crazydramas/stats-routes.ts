// The Routes tab's sums (decision 2026-10-12, "Acquisition routes A/B/C"): the three ways into the Android app side by
// side, A Google Play (an App install ad), B the landing page (crazydramas.com/try/<slug>), C the web player. crazydramas'
// optional `routes` rows give each route's viewers per day and TikTok campaign; Studio adds what TikTok charged for
// those campaigns.
//
// A campaign's route: when a Studio launch made it, that launch's acquisition_route decides, and a launch on no route
// is in none of A/B/C (an App install launch on `none`, campaign 1878639243715761, is not route A even though crazydramas
// reports its installs as `store`); only a campaign Studio does not know takes the report's route. Costs set spend only
// against the people of campaigns whose spend is known: a row with no campaign, of a campaign Studio has no spend for, or
// of one whose spend is partly unknown is counted in its route and listed as not set against spend, never mixed into a
// cost. Spend over a period is TikTok's own days (deliveryIn, as the Campaigns tab). Pure and client-safe.

import type { LaunchRun } from "@/lib/launch/types";
import { ROUTE_KEYS, type CdStatsReport, type CdStatsRoute, type RouteKey } from "./stats-types";
import { deliveryIn, type AdPeriod, type AdSpend } from "./stats-summary";

/** crazydramas' counts of one route (summed over rows). */
export type RouteCounts = Pick<CdStatsRoute, "landed" | "store_taps" | "installs" | "opened_episode" | "trials" | "paid" | "repeat_viewers" | "revenue_cents">;
export const ROUTE_COUNT_KEYS = ["landed", "store_taps", "installs", "opened_episode", "trials", "paid", "repeat_viewers", "revenue_cents"] as const;

/** One route's column: crazydramas' counts, TikTok's delivery for the route's campaigns, and the costs. */
export type RouteColumn = RouteCounts & {
  route: RouteKey;
  /** The TikTok campaigns credited to the route (with rows in the period, or a Studio launch on the route). */
  campaigns: string[];
  /** Every known spend of the route's campaigns; null when none is known. */
  spend_cents: number | null;
  impressions: number | null;
  clicks: number | null;
  /** Spend of the campaigns whose spend is wholly known: what the costs divide. */
  costed_spend_cents: number | null;
  /** The counts the costs do not cover: rows with no campaign, of a campaign Studio has no spend for, or partly unknown spend. */
  unmatched: RouteCounts;
  /** Some ad's spend is unknown. */
  spend_partial: boolean;
  /** The costs do not cover every count or every ad (spend_partial, or anything unmatched). */
  partial: boolean;
  cost_per_install_cents: number | null;
  cost_per_trial_cents: number | null;
  cost_per_paid_cents: number | null;
};

const emptyCounts = (): RouteCounts => ({ landed: 0, store_taps: 0, installs: 0, opened_episode: 0, trials: 0, paid: 0, repeat_viewers: 0, revenue_cents: 0 });
const anyCount = (c: RouteCounts) => ROUTE_COUNT_KEYS.some((k) => c[k] > 0);

/** Whether the report carries routes at all (a crazydramas from before 2026-10-12 does not). */
export const hasRoutes = (report: Pick<CdStatsReport, "routes">): boolean => Array.isArray(report.routes);

/** The report's route rows whose day lies in the span. */
export function routesIn(report: Pick<CdStatsReport, "routes">, span: { from: string; to: string }): CdStatsRoute[] {
  return (report.routes ?? []).filter((r) => r.day >= span.from && r.day <= span.to);
}

/**
 * The span "All" means on the Routes tab: from the first day crazydramas reported a route row to the report's last day,
 * so spend from before the routes existed is never set against their people. Null when there are no rows.
 */
export function routeSpanAll(report: Pick<CdStatsReport, "routes" | "to">): { from: string; to: string } | null {
  const days = (report.routes ?? []).map((r) => r.day).sort();
  return days.length ? { from: days[0], to: report.to } : null;
}

const isRoute = (v: unknown): v is RouteKey => (ROUTE_KEYS as readonly unknown[]).includes(v);

/** The route a TikTok launch run was made on (its signed acquisition_route), or null: `none`, absent, Meta. */
export function routeOfRun(run: Pick<LaunchRun, "draft">): RouteKey | null {
  if (run.draft?.provider !== "tiktok") return null;
  const route = (run.draft.tiktok_settings as { acquisition_route?: unknown } | undefined)?.acquisition_route;
  return isRoute(route) ? route : null;
}

/**
 * Every campaign's route; null for a campaign a Studio launch made on no route (left out of A/B/C). A Studio TikTok
 * launch decides for the campaigns it made; a campaign no Studio launch made takes the report's route (were it under two
 * routes, the one with more installs, taps and landings).
 */
export function campaignRoutes(rows: readonly CdStatsRoute[], runs: readonly LaunchRun[]): Map<string, RouteKey | null> {
  const out = new Map<string, RouteKey | null>();
  for (const run of runs) {
    if (run.draft?.provider !== "tiktok") continue;
    const route = routeOfRun(run);
    for (const c of run.campaigns ?? []) {
      const id = typeof c.state?.campaign_id === "string" ? c.state.campaign_id : null;
      if (id && (!out.has(id) || (out.get(id) === null && route))) out.set(id, route);
    }
  }
  const weight = new Map<string, Map<RouteKey, number>>();
  for (const r of rows) {
    if (!r.campaign_id || out.has(r.campaign_id)) continue;
    const w = weight.get(r.campaign_id) ?? new Map<RouteKey, number>();
    w.set(r.route, (w.get(r.route) ?? 0) + r.installs + r.store_taps + r.landed + 1);
    weight.set(r.campaign_id, w);
  }
  for (const [id, w] of weight) out.set(id, [...w.entries()].sort((a, b) => b[1] - a[1] || ROUTE_KEYS.indexOf(a[0]) - ROUTE_KEYS.indexOf(b[0]))[0][0]);
  return out;
}

/** The route a row counts in: its campaign's (null = left out), else, with no known campaign, the row's own. */
const rowRoute = (r: CdStatsRoute, routeOf: ReadonlyMap<string, RouteKey | null>): RouteKey | null =>
  r.campaign_id && routeOf.has(r.campaign_id) ? routeOf.get(r.campaign_id)! : r.route;

const per = (cents: number | null, n: number): number | null => (cents !== null && n > 0 ? Math.round(cents / n) : null);
const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);

/**
 * The three columns, A then B then C, always all three (a route nobody ran reads zero people and no spend). `rows` are
 * the period's route rows (routesIn); `spends` every ad Studio knows (adSpendsFromRuns); `routeOf` campaignRoutes. With a
 * period, an ad's delivery is TikTok's days in it; without, its whole life.
 */
export function routeColumns(rows: readonly CdStatsRoute[], spends: readonly AdSpend[], routeOf: ReadonlyMap<string, RouteKey | null>, period?: AdPeriod): RouteColumn[] {
  // Each routed campaign's delivery, and whether every one of its ads' spend is known.
  const delivery = new Map<string, { spend: number | null; impressions: number | null; clicks: number | null; known: boolean }>();
  for (const s of spends) {
    if (s.provider !== "tiktok" || !s.campaign_id || !routeOf.get(s.campaign_id)) continue;
    const d = period ? deliveryIn(s, period) : { spend_cents: s.spend_cents, impressions: s.impressions, clicks: s.clicks };
    const c = delivery.get(s.campaign_id) ?? { spend: null, impressions: null, clicks: null, known: true };
    delivery.set(s.campaign_id, { spend: add(c.spend, d.spend_cents), impressions: add(c.impressions, d.impressions), clicks: add(c.clicks, d.clicks), known: c.known && d.spend_cents !== null });
  }
  const costed = (id: string | null) => !!id && delivery.get(id)?.known === true;
  return ROUTE_KEYS.map((route) => {
    const counts = emptyCounts(), unmatched = emptyCounts();
    const campaigns = new Set<string>();
    for (const r of rows) {
      if (rowRoute(r, routeOf) !== route) continue;
      for (const k of ROUTE_COUNT_KEYS) { counts[k] += r[k]; if (!costed(r.campaign_id)) unmatched[k] += r[k]; }
      if (r.campaign_id) campaigns.add(r.campaign_id);
    }
    let spend: number | null = null, costedSpend: number | null = null, impressions: number | null = null, clicks: number | null = null, spendPartial = false;
    for (const [id, d] of delivery) {
      if (routeOf.get(id) !== route) continue;
      campaigns.add(id);
      spend = add(spend, d.spend); impressions = add(impressions, d.impressions); clicks = add(clicks, d.clicks);
      if (d.known) costedSpend = add(costedSpend, d.spend);
      else spendPartial = true;
    }
    const by = (k: "installs" | "trials" | "paid") => counts[k] - unmatched[k];
    return {
      route, ...counts, campaigns: [...campaigns].sort(),
      spend_cents: spend, impressions, clicks, costed_spend_cents: costedSpend, unmatched,
      spend_partial: spendPartial, partial: spendPartial || anyCount(unmatched),
      cost_per_install_cents: per(costedSpend, by("installs")),
      cost_per_trial_cents: per(costedSpend, by("trials")),
      cost_per_paid_cents: per(costedSpend, by("paid")),
    };
  });
}

/** The three routes summed: the headline numbers. Spend is null only when no route has any known spend. */
export function routeTotals(columns: readonly RouteColumn[]): RouteCounts & { spend_cents: number | null; partial: boolean; cost_per_install_cents: number | null; unmatched: RouteCounts } {
  const counts = emptyCounts(), unmatched = emptyCounts();
  for (const c of columns) for (const k of ROUTE_COUNT_KEYS) { counts[k] += c[k]; unmatched[k] += c.unmatched[k]; }
  const spend = columns.reduce<number | null>((a, c) => add(a, c.spend_cents), null);
  const costedSpend = columns.reduce<number | null>((a, c) => add(a, c.costed_spend_cents), null);
  return { ...counts, unmatched, spend_cents: spend, partial: columns.some((c) => c.partial), cost_per_install_cents: per(costedSpend, counts.installs - unmatched.installs) };
}

/** One count per day of a span, the three routes together (the headline numbers' small lines); days with no rows are zero. */
export function routeDaily(rows: readonly CdStatsRoute[], span: { from: string; to: string }, key: (typeof ROUTE_COUNT_KEYS)[number], routeOf?: ReadonlyMap<string, RouteKey | null>): number[] {
  const out: number[] = [];
  const counted = routeOf ? rows.filter((r) => rowRoute(r, routeOf) !== null) : rows;
  for (let day = span.from; day <= span.to; day = nextDay(day)) out.push(counted.filter((r) => r.day === day).reduce((a, r) => a + r[key], 0));
  return out;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
