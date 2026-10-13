// The Routes tab's sums (decision 2026-10-12, "Acquisition routes A/B/C"): the three ways into the Android app side by
// side, A Google Play (an App install ad), B the landing page (crazydramas.com/try/<slug>), C the web player. crazydramas'
// optional `routes` rows give each route's viewers per day and TikTok campaign; Studio adds what TikTok charged for
// those campaigns. A campaign's route is the report's (the rows that name it), else the acquisition_route of the Studio
// launch that made it. Spend over a period is TikTok's own days (deliveryIn, as the Campaigns tab); with no period,
// each ad's whole life. Costs divide only known spend, and only by a count above zero. Pure and client-safe.

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
  /** Null when no campaign of the route has known spend; `partial` when some do and some do not. */
  spend_cents: number | null;
  impressions: number | null;
  clicks: number | null;
  partial: boolean;
  cost_per_install_cents: number | null;
  cost_per_trial_cents: number | null;
  cost_per_paid_cents: number | null;
};

const emptyCounts = (): RouteCounts => ({ landed: 0, store_taps: 0, installs: 0, opened_episode: 0, trials: 0, paid: 0, repeat_viewers: 0, revenue_cents: 0 });

/** Whether the report carries routes at all (a crazydramas from before 2026-10-12 does not). */
export const hasRoutes = (report: Pick<CdStatsReport, "routes">): boolean => Array.isArray(report.routes);

/** The report's route rows whose day lies in the span. */
export function routesIn(report: Pick<CdStatsReport, "routes">, span: { from: string; to: string }): CdStatsRoute[] {
  return (report.routes ?? []).filter((r) => r.day >= span.from && r.day <= span.to);
}

const isRoute = (v: unknown): v is RouteKey => (ROUTE_KEYS as readonly unknown[]).includes(v);

/** The route a TikTok launch run was made on (its signed acquisition_route), or null: Meta, `none`, absent. */
export function routeOfRun(run: Pick<LaunchRun, "draft">): RouteKey | null {
  if (run.draft?.provider !== "tiktok") return null;
  const route = (run.draft.tiktok_settings as { acquisition_route?: unknown } | undefined)?.acquisition_route;
  return isRoute(route) ? route : null;
}

/**
 * Every campaign's route: the report's own rows first (the route of a campaign's rows; were one campaign to appear under
 * two routes, the one with more installs, taps and landings), then the Studio launch that made it.
 */
export function campaignRoutes(rows: readonly CdStatsRoute[], runs: readonly LaunchRun[]): Map<string, RouteKey> {
  const weight = new Map<string, Map<RouteKey, number>>();
  for (const r of rows) {
    if (!r.campaign_id) continue;
    const per = weight.get(r.campaign_id) ?? new Map<RouteKey, number>();
    per.set(r.route, (per.get(r.route) ?? 0) + r.installs + r.store_taps + r.landed + 1);
    weight.set(r.campaign_id, per);
  }
  const out = new Map<string, RouteKey>();
  for (const [id, per] of weight) out.set(id, [...per.entries()].sort((a, b) => b[1] - a[1] || ROUTE_KEYS.indexOf(a[0]) - ROUTE_KEYS.indexOf(b[0]))[0][0]);
  for (const run of runs) {
    const route = routeOfRun(run);
    if (!route) continue;
    for (const c of run.campaigns ?? []) {
      const id = typeof c.state?.campaign_id === "string" ? c.state.campaign_id : null;
      if (id && !out.has(id)) out.set(id, route);
    }
  }
  return out;
}

const per = (cents: number | null, n: number): number | null => (cents !== null && n > 0 ? Math.round(cents / n) : null);

/**
 * The three columns, A then B then C, always all three (a route nobody ran reads zero people and no spend). `rows` are
 * the period's route rows (routesIn); `spends` every ad Studio knows (adSpendsFromRuns); `routeOf` campaignRoutes over
 * the whole report. With a period, an ad's delivery is TikTok's days in it; without, its whole life.
 */
export function routeColumns(rows: readonly CdStatsRoute[], spends: readonly AdSpend[], routeOf: ReadonlyMap<string, RouteKey>, period?: AdPeriod): RouteColumn[] {
  return ROUTE_KEYS.map((route) => {
    const counts = emptyCounts();
    const campaigns = new Set<string>();
    for (const r of rows) {
      if (r.route !== route) continue;
      for (const k of ROUTE_COUNT_KEYS) counts[k] += r[k];
      if (r.campaign_id) campaigns.add(r.campaign_id);
    }
    let spend: number | null = null, impressions: number | null = null, clicks: number | null = null, partial = false;
    for (const s of spends) {
      if (s.provider !== "tiktok" || !s.campaign_id || routeOf.get(s.campaign_id) !== route) continue;
      campaigns.add(s.campaign_id);
      const d = period ? deliveryIn(s, period) : { spend_cents: s.spend_cents, impressions: s.impressions, clicks: s.clicks };
      if (d.spend_cents === null) partial = true;
      else spend = (spend ?? 0) + d.spend_cents;
      if (d.impressions !== null) impressions = (impressions ?? 0) + d.impressions;
      if (d.clicks !== null) clicks = (clicks ?? 0) + d.clicks;
    }
    return {
      route, ...counts, campaigns: [...campaigns].sort(),
      spend_cents: spend, impressions, clicks, partial: partial && spend !== null,
      cost_per_install_cents: per(spend, counts.installs),
      cost_per_trial_cents: per(spend, counts.trials),
      cost_per_paid_cents: per(spend, counts.paid),
    };
  });
}

/** The three routes summed: the headline numbers. Spend is null only when no route has any known spend. */
export function routeTotals(columns: readonly RouteColumn[]): RouteCounts & { spend_cents: number | null; partial: boolean; cost_per_install_cents: number | null } {
  const counts = emptyCounts();
  for (const c of columns) for (const k of ROUTE_COUNT_KEYS) counts[k] += c[k];
  const known = columns.filter((c) => c.spend_cents !== null);
  const spend = known.length ? known.reduce((a, c) => a + c.spend_cents!, 0) : null;
  // Partial: a route's own spend is partial, or a route with campaigns has no known spend while another has some.
  const unknownRoute = columns.some((c) => c.spend_cents === null && c.campaigns.length > 0);
  return { ...counts, spend_cents: spend, partial: spend !== null && (columns.some((c) => c.partial) || unknownRoute), cost_per_install_cents: per(spend, counts.installs) };
}

/** One count per day of a span, the three routes together (the headline numbers' small lines); days with no rows are zero. */
export function routeDaily(rows: readonly CdStatsRoute[], span: { from: string; to: string }, key: (typeof ROUTE_COUNT_KEYS)[number]): number[] {
  const out: number[] = [];
  for (let day = span.from; day <= span.to; day = nextDay(day)) out.push(rows.filter((r) => r.day === day).reduce((a, r) => a + r[key], 0));
  return out;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
