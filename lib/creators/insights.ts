// The daily read of a creator account's numbers (decision 2026-10-12): one
// creator_stats row for the account and one per media published in the last
// 30 days, per day in the account's time zone. Fails soft everywhere: a metric
// Meta does not answer (a new account under 100 followers has no follower_count,
// a metric a media type lacks, a permission missing) is null — unknown — never
// 0, and one refused metric never blanks the others.
//
// What is read (Instagram Graph API, publish token):
//   account  GET /{ig}?fields=followers_count,follows_count,media_count
//            GET /{ig}/insights metric=reach | profile_views | follower_count, period=day
//            (reach and profile_views are the previous day's; follower_count the
//            day's net new followers, which Meta gives only above 100 followers)
//   media    GET /{media}/insights metric=reach,likes,comments,saved,shares,total_interactions,views
//            (lifetime totals as of the read; asked together, then one by one
//            when Meta refuses the set because one metric does not apply)
// The exact metric names Meta accepts move between API versions; anything
// refused stays null and the Stats tab says "not reported".

import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import type { MetaObject, MetaTransport } from "@/lib/meta/transport";
import { creatorTransport } from "./publish";
import type { CreatorAccount, NewCreatorStat } from "./types";

export const MEDIA_WINDOW_DAYS = 30;
const MEDIA_METRICS = ["reach", "likes", "comments", "saved", "shares", "total_interactions", "views"] as const;
type MediaMetric = (typeof MEDIA_METRICS)[number];

/** Today in the account's time zone, as YYYY-MM-DD. */
export function dayIn(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const count = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** One metric's value from an insights answer: the total, else the newest day's value. Null when absent. */
export function metricValue(response: MetaObject, name: string): number | null {
  const rows = Array.isArray(response.data) ? (response.data as MetaObject[]) : [];
  const row = rows.find(r => r.name === name);
  if (!row) return null;
  const total = (row.total_value as MetaObject | undefined)?.value;
  if (total !== undefined) return count(total);
  const values = Array.isArray(row.values) ? (row.values as MetaObject[]) : [];
  return values.length ? count(values[values.length - 1].value) : null;
}

async function soft<T>(work: () => Promise<T>): Promise<T | null> {
  try { return await work(); } catch { return null; }
}

async function accountMetric(t: MetaTransport, ig: string, metric: string, extra: MetaObject = {}): Promise<number | null> {
  const r = await soft(() => t.get(`${ig}/insights`, { metric, period: "day", ...extra }));
  return r ? metricValue(r, metric) : null;
}

async function mediaMetrics(t: MetaTransport, mediaId: string): Promise<Record<MediaMetric, number | null>> {
  const out = Object.fromEntries(MEDIA_METRICS.map(m => [m, null])) as Record<MediaMetric, number | null>;
  const all = await soft(() => t.get(`${mediaId}/insights`, { metric: MEDIA_METRICS.join(",") }));
  if (all) { for (const m of MEDIA_METRICS) out[m] = metricValue(all, m); return out; }
  for (const m of MEDIA_METRICS) {
    const one = await soft(() => t.get(`${mediaId}/insights`, { metric: m }));
    out[m] = one ? metricValue(one, m) : null;
  }
  return out;
}

export type InsightsRead = { day: string; account: boolean; media: number; skipped: boolean };

/**
 * Reads and records one day's numbers. `force` reads again on a day already
 * read (the Stats tab's "Read now"); the sweep reads once a day.
 */
export async function readCreatorInsights(account: CreatorAccount, opts: { force?: boolean; now?: Date } = {}): Promise<InsightsRead> {
  const now = opts.now ?? new Date();
  const data = getData();
  const sys = systemSession();
  const day = dayIn(account.settings.timezone, now);
  if (!opts.force) {
    const done = (await data.listCreatorStats(sys, account.id, { since: day })).some(r => r.scope === "account" && r.day === day);
    if (done) return { day, account: false, media: 0, skipped: true };
  }
  const t = creatorTransport(account);
  const ig = account.instagram_id;
  const fields = await soft(() => t.get(ig, { fields: "followers_count,follows_count,media_count" }));
  const readAt = now.toISOString();
  const base = (scope: string, igMedia: string | null, postId: string | null): NewCreatorStat => ({
    account_id: account.id, scope, ig_media_id: igMedia, post_id: postId, day, followers_count: null, follows_count: null, media_count: null,
    reach: null, profile_views: null, follows_gained: null, likes: null, comments: null, saved: null, shares: null, views: null,
    total_interactions: null, read_at: readAt,
  });
  await data.recordCreatorStat(sys, {
    ...base("account", null, null),
    followers_count: count(fields?.followers_count), follows_count: count(fields?.follows_count), media_count: count(fields?.media_count),
    reach: await accountMetric(t, ig, "reach"),
    profile_views: await accountMetric(t, ig, "profile_views", { metric_type: "total_value" }),
    follows_gained: await accountMetric(t, ig, "follower_count"),
  });

  const since = now.getTime() - MEDIA_WINDOW_DAYS * 86_400_000;
  const listed = await soft(() => t.get(`${ig}/media`, { fields: "id,timestamp", limit: 50 }));
  const recent = (Array.isArray(listed?.data) ? (listed!.data as MetaObject[]) : [])
    .filter(m => typeof m.id === "string" && (!m.timestamp || Date.parse(String(m.timestamp)) >= since));
  const posts = await data.listCreatorPosts(sys, { account_id: account.id });
  const postOf = new Map(posts.filter(p => p.ig_media_id).map(p => [p.ig_media_id as string, p.id]));
  for (const m of recent) {
    const id = String(m.id);
    const metrics = await mediaMetrics(t, id);
    await data.recordCreatorStat(sys, { ...base(id, id, postOf.get(id) ?? null), ...metrics });
  }
  return { day, account: true, media: recent.length, skipped: false };
}
