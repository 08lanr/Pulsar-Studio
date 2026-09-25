// What the CrazyDramas stats pages show, summed from crazydramas' report
// (./stats-types.ts). Pure and client-safe; tests/crazydramas-stats.test.ts.
//
// Two kinds of number, never mixed:
//   - per-day audience (watchers, visitors, WAU, MAU): people are never added
//     across days (one person on three days is one person, not three), so a
//     period shows each day, and the week and month come from crazydramas'
//     own distinct counts (`wau`, `mau` of the last day);
//   - per-series paths: people are grouped by the day they FIRST opened the
//     series (a person is in one day's group per series), so the groups of a
//     period add up, and every step is a share of the people who opened it.

import type { LaunchRun } from "@/lib/launch/types";
import type { CdStatsCohort, CdStatsDay, CdStatsReport, CdStatsSeries, CdStatsSource } from "./stats-types";

export const STATS_RANGES = ["today", "7d", "30d", "all"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export function parseStatsRange(raw: unknown): StatsRange {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return STATS_RANGES.includes(v as StatsRange) ? (v as StatsRange) : "7d";
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The first day anything happened (a visit, a robot, a payment), or null for an empty report. */
export function firstActiveDay(report: Pick<CdStatsReport, "days" | "series">): string | null {
  let first: string | null = null;
  const see = (day: string) => {
    if (first === null || day < first) first = day;
  };
  for (const d of report.days) if (d.visitors || d.watchers || d.robots || d.payments) see(d.day);
  for (const s of report.series) for (const c of s.cohorts) if (c.opened || c.robots || c.buyers) see(c.day);
  return first;
}

/**
 * The inclusive days a range covers, ending on the report's last day (today, in the report's time zone).
 * "All" starts on the first day anything happened, not on the report's first (empty) day.
 */
export function rangeDays(report: Pick<CdStatsReport, "from" | "to"> & Partial<Pick<CdStatsReport, "days" | "series">>, range: StatsRange): { from: string; to: string } {
  const span = range === "today" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : null;
  const active = span === null && report.days && report.series ? firstActiveDay({ days: report.days, series: report.series }) : null;
  const from = span === null ? (active ?? report.from) : addDays(report.to, -(span - 1));
  return { from: from < report.from ? report.from : from, to: report.to };
}

const inRange = (day: string, r: { from: string; to: string }) => day >= r.from && day <= r.to;

// ---- the audience -------------------------------------------------------------------------------------------

export type Audience = {
  today: CdStatsDay | null;
  yesterday: CdStatsDay | null;
  /** Different people who pressed play in the 7 / 30 days ending today. */
  wau: number;
  mau: number;
  /** The range's days, oldest first. */
  days: CdStatsDay[];
  money: { revenue_cents: number; payments: number; first_purchases: number; renewals: number };
  /** Robot browsers seen per day, summed over the range (a robot seen on two days counts twice). */
  robot_visits: number;
};

export function audience(report: CdStatsReport, range: StatsRange): Audience {
  const r = rangeDays(report, range);
  const days = report.days.filter((d) => inRange(d.day, r)).sort((a, b) => a.day.localeCompare(b.day));
  const byDay = new Map(report.days.map((d) => [d.day, d]));
  const today = byDay.get(report.to) ?? null;
  const money = { revenue_cents: 0, payments: 0, first_purchases: 0, renewals: 0 };
  let robots = 0;
  for (const d of days) {
    money.revenue_cents += d.revenue_cents;
    money.payments += d.payments;
    money.first_purchases += d.first_purchases;
    money.renewals += d.renewals;
    robots += d.robots;
  }
  return { today, yesterday: byDay.get(addDays(report.to, -1)) ?? null, wau: today?.wau ?? 0, mau: today?.mau ?? 0, days, money, robot_visits: robots };
}

// ---- one series ---------------------------------------------------------------------------------------------

export type SeriesTotals = {
  drama_id: string;
  slug: string;
  title: string;
  free_episodes: number;
  episode_count: number;
  ep1_duration_s: number | null;
  opened: number;
  no_events: number;
  never_started: number;
  left_waiting: number;
  left_waiting_seconds: number;
  started_ep1: number;
  finished_ep1: number;
  ep1_seconds: number;
  ep1_reached: number[];
  ep1_sound_known: number;
  ep1_sound_on: number;
  episodes: number[];
  episodes_watched: number[];
  paywall: number;
  paywall_watched: number;
  paywall_skipped: number;
  checkouts: number;
  buyers: number;
  revenue_cents: number;
  returned: number;
  errors: number;
  survey_ep1_shown: number;
  survey_ep1: Record<string, number>;
  survey_paywall_shown: number;
  survey_paywall: Record<string, number>;
  robots: number;
  team: number;
};

function addInto(into: number[], add: number[]): void {
  for (let i = 0; i < add.length; i++) into[i] = (into[i] ?? 0) + add[i];
}

export function seriesTotals(series: CdStatsSeries, r: { from: string; to: string }): SeriesTotals {
  const t: SeriesTotals = {
    drama_id: series.drama_id,
    slug: series.slug,
    title: series.title,
    free_episodes: series.free_episodes,
    episode_count: series.episode_count,
    ep1_duration_s: series.ep1_duration_s,
    opened: 0,
    no_events: 0,
    never_started: 0,
    left_waiting: 0,
    left_waiting_seconds: 0,
    started_ep1: 0,
    finished_ep1: 0,
    ep1_seconds: 0,
    ep1_reached: [],
    ep1_sound_known: 0,
    ep1_sound_on: 0,
    episodes: [],
    episodes_watched: [],
    paywall: 0,
    paywall_watched: 0,
    paywall_skipped: 0,
    checkouts: 0,
    buyers: 0,
    revenue_cents: 0,
    returned: 0,
    errors: 0,
    survey_ep1_shown: 0,
    survey_ep1: {},
    survey_paywall_shown: 0,
    survey_paywall: {},
    robots: 0,
    team: 0,
  };
  const scalar = [
    "opened",
    "no_events",
    "never_started",
    "left_waiting",
    "left_waiting_seconds",
    "started_ep1",
    "finished_ep1",
    "ep1_seconds",
    "ep1_sound_known",
    "ep1_sound_on",
    "paywall",
    "paywall_watched",
    "paywall_skipped",
    "checkouts",
    "buyers",
    "revenue_cents",
    "returned",
    "errors",
    "survey_ep1_shown",
    "survey_paywall_shown",
    "robots",
    "team",
  ] as const satisfies readonly (keyof CdStatsCohort & keyof SeriesTotals)[];
  for (const c of series.cohorts) {
    if (!inRange(c.day, r)) continue;
    for (const k of scalar) t[k] += c[k];
    addInto(t.ep1_reached, c.ep1_reached);
    addInto(t.episodes, c.episodes);
    addInto(t.episodes_watched, c.episodes_watched);
    for (const [a, n] of Object.entries(c.survey_ep1)) t.survey_ep1[a] = (t.survey_ep1[a] ?? 0) + n;
    for (const [a, n] of Object.entries(c.survey_paywall)) t.survey_paywall[a] = (t.survey_paywall[a] ?? 0) + n;
  }
  return t;
}

/** Every series' totals for the range, most opened first (then by title); series nobody opened come last. */
export function seriesTable(report: CdStatsReport, range: StatsRange): SeriesTotals[] {
  const r = rangeDays(report, range);
  return report.series.map((s) => seriesTotals(s, r)).sort((a, b) => b.opened - a.opened || b.revenue_cents - a.revenue_cents || a.title.localeCompare(b.title));
}

/** A share, 0..1, or null when there is nobody to share out. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** "12%", "4.5%" under 10, "<1%" for a sliver, "–" for no base. */
export function fmtShare(s: number | null): string {
  if (s === null) return "–";
  const p = s * 100;
  if (p > 0 && p < 1) return "<1%";
  return p < 10 ? `${Number(p.toFixed(1))}%` : `${Math.round(p)}%`;
}

/** m:ss */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtUsdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- episode 1 ----------------------------------------------------------------------------------------------

export type Ep1Point = { t: number; people: number; share: number | null };

export type Ep1Curve = {
  started: number;
  finished: number;
  duration_s: number | null;
  /** People still watching at each step, then (when the length is known) the end: the finishers. */
  points: Ep1Point[];
  /** Share of starters gone before the first step (15 s). */
  gone_first_step: number | null;
  step_s: number;
  /** The first step at which fewer than half are still watching, or null when half or more reach the end. */
  half_gone_at: number | null;
  avg_seconds: number | null;
};

export function ep1Curve(t: SeriesTotals, stepS: number): Ep1Curve {
  const started = t.started_ep1;
  const points: Ep1Point[] = t.ep1_reached.map((people, k) => ({ t: k * stepS, people, share: share(people, started) }));
  if (t.ep1_duration_s && (points.length === 0 || points[points.length - 1].t < t.ep1_duration_s)) {
    points.push({ t: t.ep1_duration_s, people: t.finished_ep1, share: share(t.finished_ep1, started) });
  }
  const half = points.find((p) => p.share !== null && p.share < 0.5);
  return {
    started,
    finished: t.finished_ep1,
    duration_s: t.ep1_duration_s,
    points,
    gone_first_step: started > 0 && points.length > 1 ? 1 - points[1].people / started : null,
    step_s: stepS,
    half_gone_at: half ? half.t : null,
    avg_seconds: started > 0 ? t.ep1_seconds / started : null,
  };
}

// ---- every episode ------------------------------------------------------------------------------------------

export type EpisodeBar = { n: number; started: number; watched: number; free: boolean };

/**
 * One bar per episode, up to a little past the last one anybody started (and
 * at least two past the first locked one, so the paywall shows), capped at
 * the series' length. `hidden_after`: the episodes left off, which nobody
 * has started.
 */
export function episodeBars(t: SeriesTotals): { bars: EpisodeBar[]; hidden_after: number | null } {
  let last = 0;
  t.episodes.forEach((v, i) => {
    if (v > 0) last = i + 1;
  });
  const shown = Math.min(Math.max(t.episode_count, t.episodes.length), Math.max(last + 2, t.free_episodes + 3, 8));
  const bars: EpisodeBar[] = [];
  for (let n = 1; n <= shown; n++) bars.push({ n, started: t.episodes[n - 1] ?? 0, watched: t.episodes_watched[n - 1] ?? 0, free: n <= t.free_episodes });
  const total = Math.max(t.episode_count, t.episodes.length);
  return { bars, hidden_after: shown < total ? shown : null };
}

// ---- where people came from: ads, and kinds of browser -------------------------------------------------------

/** One TikTok ad's own numbers from Studio's launch records (TikTok's lifetime totals for the ad). */
export type AdSpend = {
  ad_id: string;
  spend_cents: number | null;
  impressions: number | null;
  clicks: number | null;
  /** TikTok's campaign id, from the launch record; the ad's campaign name and the launch it belongs to. */
  campaign_id: string | null;
  campaign_name: string;
  launch_name: string;
  run_id: string;
  launched_at: string | null;
};

/** Every ad of every launch with its TikTok numbers (the launch records' latest sweep); an ad in two runs keeps the first seen. */
export function adSpendsFromRuns(runs: LaunchRun[]): AdSpend[] {
  const out = new Map<string, AdSpend>();
  for (const run of runs) {
    for (const c of run.campaigns ?? []) {
      const campaignId = typeof c.state?.campaign_id === "string" ? c.state.campaign_id : null;
      for (const ad of c.snapshot?.ads ?? []) {
        if (!ad.id || out.has(ad.id)) continue;
        out.set(ad.id, {
          ad_id: ad.id,
          spend_cents: ad.stats?.spend_cents ?? null,
          impressions: ad.stats?.impressions ?? null,
          clicks: ad.stats?.clicks ?? null,
          campaign_id: campaignId,
          campaign_name: c.name,
          launch_name: run.draft?.name ?? run.external_id,
          run_id: run.external_id,
          launched_at: run.created_at ?? null,
        });
      }
    }
  }
  return [...out.values()];
}

type PathCounts = Pick<
  CdStatsSource,
  "opened" | "no_events" | "never_started" | "started_ep1" | "finished_ep1" | "watched_ep2" | "watched_ep3" | "paywall" | "checkouts" | "buyers" | "revenue_cents" | "robots"
>;
const PATH_KEYS = ["opened", "no_events", "never_started", "started_ep1", "finished_ep1", "watched_ep2", "watched_ep3", "paywall", "checkouts", "buyers", "revenue_cents", "robots"] as const;
const emptyPath = (): PathCounts => ({ opened: 0, no_events: 0, never_started: 0, started_ep1: 0, finished_ep1: 0, watched_ep2: 0, watched_ep3: 0, paywall: 0, checkouts: 0, buyers: 0, revenue_cents: 0, robots: 0 });
function addPath(into: PathCounts, row: PathCounts) {
  for (const k of PATH_KEYS) into[k] += row[k];
}

/** A series the people of an ad (or a campaign) opened, most people first: the title the ad was connected to. */
export type AdTitle = { drama_id: string; title: string; people: number };

/** What a row cost, and what that bought: TikTok's numbers (summed) and the cost per step. */
type Costed = {
  spend_cents: number | null;
  clicks: number | null;
  impressions: number | null;
  cost_per_person_cents: number | null;
  cost_per_finisher_cents: number | null;
  cost_per_ep2_cents: number | null;
};

export type AdRow = PathCounts &
  Costed & {
    key: string;
    /** An ad with its id; TikTok's stored copy of the page (ids lost); or no ad at all (organic, direct). */
    kind: "ad" | "stored_copy" | "no_ad";
    platform: string;
    campaign: string | null;
    ad: string | null;
    /** Studio's launch record for the ad, when Studio launched it. */
    spend: AdSpend | null;
    titles: AdTitle[];
  };

const per = (cents: number | null | undefined, n: number) => (cents != null && n > 0 ? Math.round(cents / n) : null);
const withCosts = <T extends PathCounts & { spend_cents: number | null }>(r: T): T & Costed =>
  ({ ...r, cost_per_person_cents: per(r.spend_cents, r.opened), cost_per_finisher_cents: per(r.spend_cents, r.finished_ep1), cost_per_ep2_cents: per(r.spend_cents, r.watched_ep2) }) as T & Costed;

function addTitle(titles: Map<string, AdTitle>, dramaId: string, title: string, people: number) {
  const t = titles.get(dramaId);
  if (t) t.people += people;
  else titles.set(dramaId, { drama_id: dramaId, title, people });
}
const titleList = (m: Map<string, AdTitle>) => [...m.values()].filter((t) => t.people > 0).sort((a, b) => b.people - a.people || a.title.localeCompare(b.title));

/**
 * The people every ad brought, over each ad's whole life (spend is TikTok's total for the ad, so the
 * people are too), joined to Studio's launch records by TikTok's ad id, with the titles its people
 * opened; then TikTok's stored copy and "no ad" as rows of their own. One series, or all. Ads with
 * spend first, most spent first.
 */
export function adTable(report: Pick<CdStatsReport, "sources" | "series">, spends: AdSpend[], dramaId?: string): AdRow[] {
  const bySpend = new Map(spends.map((s) => [s.ad_id, s]));
  const titleOf = new Map(report.series.map((s) => [s.drama_id, s.title]));
  const rows = new Map<string, AdRow & { titleMap: Map<string, AdTitle> }>();
  const blank = (key: string, kind: AdRow["kind"], platform: string, campaign: string | null, ad: string | null, spend: AdSpend | null) => ({
    key,
    kind,
    platform,
    campaign,
    ad,
    spend,
    spend_cents: spend?.spend_cents ?? null,
    clicks: spend?.clicks ?? null,
    impressions: spend?.impressions ?? null,
    cost_per_person_cents: null,
    cost_per_finisher_cents: null,
    cost_per_ep2_cents: null,
    titles: [],
    titleMap: new Map<string, AdTitle>(),
    ...emptyPath(),
  });
  for (const src of report.sources) {
    if (dramaId && src.drama_id !== dramaId) continue;
    const kind: AdRow["kind"] = src.stored_copy ? "stored_copy" : src.ad ? "ad" : "no_ad";
    const key = kind === "ad" ? `ad:${src.ad}` : kind;
    let row = rows.get(key);
    if (!row) {
      const spend = kind === "ad" && src.ad ? (bySpend.get(src.ad) ?? null) : null;
      row = blank(key, kind, src.platform, src.campaign ?? spend?.campaign_id ?? null, src.ad, spend);
      rows.set(key, row);
    }
    addPath(row, src);
    addTitle(row.titleMap, src.drama_id, titleOf.get(src.drama_id) ?? src.drama_id, src.opened);
  }
  // An ad Studio launched that brought nobody yet is still a row: its spend bought nothing.
  if (!dramaId) {
    for (const s of spends) {
      if ((s.spend_cents ?? 0) <= 0 || rows.has(`ad:${s.ad_id}`)) continue;
      rows.set(`ad:${s.ad_id}`, blank(`ad:${s.ad_id}`, "ad", "tiktok", s.campaign_id, s.ad_id, s));
    }
  }
  const order = { ad: 0, stored_copy: 1, no_ad: 2 } as const;
  return [...rows.values()]
    .filter((r) => r.opened > 0 || (r.spend_cents ?? 0) > 0)
    .map(({ titleMap, ...r }) => withCosts({ ...r, titles: titleList(titleMap) }))
    .sort((a, b) => order[a.kind] - order[b.kind] || (b.spend_cents ?? -1) - (a.spend_cents ?? -1) || b.opened - a.opened);
}

/** A campaign with its ads under it: the ads' numbers summed (spend only over ads TikTok reported), and the costs recomputed from the sums. */
export type CampaignRow = PathCounts &
  Costed & {
    key: string;
    /** A TikTok campaign; TikTok's stored copy (which ad unknown); or no ad at all. */
    kind: "campaign" | "stored_copy" | "no_ad";
    campaign_id: string | null;
    /** Studio's names for it, when Studio launched it: the launch and its campaign. */
    launch_name: string | null;
    campaign_name: string | null;
    launched_at: string | null;
    titles: AdTitle[];
    ads: AdRow[];
  };

/** The ads grouped by campaign (TikTok's campaign id), the stored copy and "no ad" as groups of their own. */
export function campaignTable(report: Pick<CdStatsReport, "sources" | "series">, spends: AdSpend[], dramaId?: string): CampaignRow[] {
  const groups = new Map<string, CampaignRow & { titleMap: Map<string, AdTitle> }>();
  for (const ad of adTable(report, spends, dramaId)) {
    const kind: CampaignRow["kind"] = ad.kind === "ad" ? "campaign" : ad.kind;
    const key = kind === "campaign" ? `campaign:${ad.campaign ?? "unknown"}` : kind;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        kind,
        campaign_id: kind === "campaign" ? ad.campaign : null,
        launch_name: ad.spend?.launch_name ?? null,
        campaign_name: ad.spend?.campaign_name ?? null,
        launched_at: ad.spend?.launched_at ?? null,
        spend_cents: null,
        clicks: null,
        impressions: null,
        cost_per_person_cents: null,
        cost_per_finisher_cents: null,
        cost_per_ep2_cents: null,
        titles: [],
        titleMap: new Map(),
        ads: [],
        ...emptyPath(),
      };
      groups.set(key, g);
    }
    g.ads.push(ad);
    addPath(g, ad);
    for (const t of ad.titles) addTitle(g.titleMap, t.drama_id, t.title, t.people);
    if (ad.spend_cents != null) g.spend_cents = (g.spend_cents ?? 0) + ad.spend_cents;
    if (ad.clicks != null) g.clicks = (g.clicks ?? 0) + ad.clicks;
    if (ad.impressions != null) g.impressions = (g.impressions ?? 0) + ad.impressions;
    g.launch_name ??= ad.spend?.launch_name ?? null;
    g.campaign_name ??= ad.spend?.campaign_name ?? null;
    g.launched_at ??= ad.spend?.launched_at ?? null;
  }
  return sortCampaigns(
    [...groups.values()].map(({ titleMap, ...g }) => withCosts({ ...g, titles: titleList(titleMap) })),
    "spend",
  );
}

export const CAMPAIGN_SORTS = ["spend", "people", "per_finisher", "per_ep2", "finished", "ep2", "newest"] as const;
export type CampaignSort = (typeof CAMPAIGN_SORTS)[number];

/**
 * Campaigns, and the ads inside each, in the chosen order: most spent, most people, cheapest episode 1
 * finisher or episode 2 watcher (rows with no cost last), most finishers or episode 2 watchers, newest
 * launch. TikTok's stored copy and "no ad" always come last.
 */
export function sortCampaigns(rows: CampaignRow[], by: CampaignSort): CampaignRow[] {
  const cheap = (v: number | null) => (v == null ? Number.POSITIVE_INFINITY : v);
  const cmp = (a: AdRow | CampaignRow, b: AdRow | CampaignRow): number => {
    switch (by) {
      case "people":
        return b.opened - a.opened;
      case "per_finisher":
        return cheap(a.cost_per_finisher_cents) - cheap(b.cost_per_finisher_cents) || b.finished_ep1 - a.finished_ep1;
      case "per_ep2":
        return cheap(a.cost_per_ep2_cents) - cheap(b.cost_per_ep2_cents) || b.watched_ep2 - a.watched_ep2;
      case "finished":
        return b.finished_ep1 - a.finished_ep1;
      case "ep2":
        return b.watched_ep2 - a.watched_ep2;
      case "newest": {
        const at = (r: AdRow | CampaignRow) => ("launched_at" in r ? r.launched_at : r.spend?.launched_at) ?? "";
        return at(b).localeCompare(at(a));
      }
      default:
        return (b.spend_cents ?? -1) - (a.spend_cents ?? -1);
    }
  };
  const last = { campaign: 0, stored_copy: 1, no_ad: 2 } as const;
  return rows
    .map((r) => ({ ...r, ads: [...r.ads].sort((a, b) => cmp(a, b) || b.opened - a.opened) }))
    .sort((a, b) => last[a.kind] - last[b.kind] || cmp(a, b) || b.opened - a.opened);
}

/** What each ad brought on CrazyDramas over its life, by TikTok's ad id (the Monitor's line under each ad). */
export type AdOutcome = Pick<PathCounts, "opened" | "started_ep1" | "finished_ep1" | "watched_ep2" | "buyers" | "revenue_cents">;
export function adOutcomes(report: Pick<CdStatsReport, "sources">): Record<string, AdOutcome> {
  const out: Record<string, AdOutcome> = {};
  for (const src of report.sources) {
    if (!src.ad || src.stored_copy) continue;
    const o = (out[src.ad] ??= { opened: 0, started_ep1: 0, finished_ep1: 0, watched_ep2: 0, buyers: 0, revenue_cents: 0 });
    o.opened += src.opened;
    o.started_ep1 += src.started_ep1;
    o.finished_ep1 += src.finished_ep1;
    o.watched_ep2 += src.watched_ep2;
    o.buyers += src.buyers;
    o.revenue_cents += src.revenue_cents;
  }
  return out;
}

export const DEVICE_ORDER = ["tiktok_android", "tiktok_iphone", "android", "iphone", "desktop", "other", "unknown"] as const;
export type DeviceRow = PathCounts & { device: string };

/** A period's people by kind of browser (TikTok on Android, on iPhone, …), one series or all. */
export function deviceTable(report: Pick<CdStatsReport, "sources">, r: { from: string; to: string }, dramaId?: string): DeviceRow[] {
  const rows = new Map<string, DeviceRow>();
  for (const src of report.sources) {
    if ((dramaId && src.drama_id !== dramaId) || !inRange(src.day, r)) continue;
    let row = rows.get(src.device);
    if (!row) {
      row = { device: src.device, ...emptyPath() };
      rows.set(src.device, row);
    }
    addPath(row, src);
  }
  const rank = (d: string) => {
    const i = (DEVICE_ORDER as readonly string[]).indexOf(d);
    return i < 0 ? DEVICE_ORDER.length : i;
  };
  return [...rows.values()].filter((d) => d.opened > 0).sort((a, b) => rank(a.device) - rank(b.device));
}

/** The one-tap questions' answers in the order the player shows them (crazydramas components/player/StopSurvey.tsx). */
export const SURVEY_ANSWERS = {
  ep1_stop: ["not_for_me", "too_slow", "av_problem", "browsing"],
  paywall_close: ["price", "more_free", "payment_trust", "browsing"],
} as const;
