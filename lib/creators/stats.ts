// The Stats tab's numbers and the creator_stats MCP tool's (decision
// 2026-10-12). Pure: rows in, headline out, so the sums are tested without a
// provider. Unknown stays null — a day Meta did not report is a gap, never 0.

import type { CreatorComment, CreatorPost, CreatorStat } from "./types";

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBack(today: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
}

export type CreatorHeadline = {
  followers: number | null;
  /** Followers now against seven days ago; null without both reads. */
  followers_change_7d: number | null;
  followers_by_day: { day: string; value: number }[];
  /** Account reach summed over the last seven reported days; null when none was reported. */
  reach_7d: number | null;
  reach_by_day: { day: string; value: number }[];
  published_30d: number;
  scheduled: number;
  posts_by_day: number[];
  replies_sent_7d: number;
  replies_by_day: number[];
  flagged_open: number;
  best_post: { ig_media_id: string; post_id: string | null; reach: number; permalink: string | null; caption: string } | null;
  /** Per media, the newest read: what each post has done so far. */
  media: { ig_media_id: string; post_id: string | null; reach: number | null; likes: number | null; comments: number | null; saved: number | null; shares: number | null; views: number | null; read_day: string }[];
  read_at: string | null;
};

const dayOf = (iso: string | null, tzDay: (iso: string) => string) => (iso ? tzDay(iso) : null);

/**
 * `today` is the account's own day (YYYY-MM-DD); `tzDay` turns an instant into
 * the account's day, so a post at 11 p.m. in San Francisco counts on that day.
 */
export function creatorHeadline(stats: CreatorStat[], posts: CreatorPost[], comments: CreatorComment[], today: string, tzDay: (iso: string) => string): CreatorHeadline {
  const account = stats.filter(s => s.scope === "account").sort((a, b) => a.day.localeCompare(b.day));
  const followersByDay = account.filter(s => s.followers_count !== null).map(s => ({ day: s.day, value: s.followers_count as number }));
  const latest = followersByDay.at(-1) ?? null;
  const weekAgo = latest ? followersByDay.filter(f => f.day <= addDays(latest.day, -7)).at(-1) ?? null : null;
  const week = new Set(daysBack(today, 7));
  const reachDays = account.filter(s => s.reach !== null).map(s => ({ day: s.day, value: s.reach as number }));
  const reachWeek = reachDays.filter(r => week.has(r.day));

  const published = posts.filter(p => p.status === "published" && p.published_at);
  const month = new Set(daysBack(today, 30));
  const fortnight = daysBack(today, 14);
  const postDays = published.map(p => dayOf(p.published_at, tzDay));
  const sent = comments.filter(c => c.status === "sent" && c.replied_at);
  const sentDays = sent.map(c => dayOf(c.replied_at, tzDay));

  // Per media, its reads in order, each metric the newest value Meta answered (a later refused read keeps it).
  const newest = new Map<string, CreatorStat>();
  const ordered = stats.filter(s => s.scope !== "account" && s.ig_media_id).sort((a, b) => a.day.localeCompare(b.day) || a.read_at.localeCompare(b.read_at));
  for (const s of ordered) {
    const prev = newest.get(s.ig_media_id as string);
    if (!prev) { newest.set(s.ig_media_id as string, { ...s }); continue; }
    const merged = { ...prev, day: s.day, read_at: s.read_at, post_id: s.post_id ?? prev.post_id } as CreatorStat;
    for (const k of ["reach", "likes", "comments", "saved", "shares", "views", "total_interactions"] as const) if (s[k] !== null) merged[k] = s[k];
    newest.set(s.ig_media_id as string, merged);
  }
  const media = [...newest.values()].map(s => ({ ig_media_id: s.ig_media_id as string, post_id: s.post_id, reach: s.reach, likes: s.likes,
    comments: s.comments, saved: s.saved, shares: s.shares, views: s.views, read_day: s.day }))
    .sort((a, b) => (b.reach ?? -1) - (a.reach ?? -1));
  const top = media.find(m => m.reach !== null) ?? null;
  const topPost = top ? posts.find(p => p.ig_media_id === top.ig_media_id) ?? null : null;

  return {
    followers: latest?.value ?? null,
    followers_change_7d: latest && weekAgo ? latest.value - weekAgo.value : null,
    followers_by_day: followersByDay.slice(-30),
    reach_7d: reachWeek.length ? reachWeek.reduce((n, r) => n + r.value, 0) : null,
    reach_by_day: reachDays.slice(-30),
    published_30d: postDays.filter(d => d && month.has(d)).length,
    scheduled: posts.filter(p => p.status === "scheduled").length,
    posts_by_day: fortnight.map(d => postDays.filter(x => x === d).length),
    replies_sent_7d: sentDays.filter(d => d && week.has(d)).length,
    replies_by_day: fortnight.map(d => sentDays.filter(x => x === d).length),
    flagged_open: comments.filter(c => c.decision === "flag" && c.status === "new").length,
    best_post: top ? { ig_media_id: top.ig_media_id, post_id: topPost?.id ?? top.post_id, reach: top.reach as number, permalink: topPost?.permalink ?? null, caption: topPost?.caption ?? "" } : null,
    media,
    read_at: stats.length ? stats.map(s => s.read_at).sort().at(-1) ?? null : null,
  };
}
