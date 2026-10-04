// Posting the ads that earned it, by themselves (decision 2026-10-03, "Auto-post
// proven clips"). Every few days the scheduler looks at what TikTok has already
// paid to learn — impressions, click-through, checkouts — and posts the clips
// that cleared the bar to the Facebook Page and the Instagram account, as
// ordinary organic Reels. Nothing here buys anything: it is distribution of
// creative that has already proved itself somewhere else.
//
// Why these numbers. A clip is only worth the Page's attention once TikTok has
// shown it enough to mean something (`early` is under 500 impressions, the line
// lib/crazydramas/stats-creatives.ts already draws), people clicked at a rate
// worth repeating, and at least one of them reached checkout. Checkouts are the
// rank because they are the closest thing in the data to money; click-through
// breaks the tie.
//
// What it will not do:
//   - It never posts the same clip to the same platform twice. A row that is
//     published, publishing or even failed counts as taken: a failure is for a
//     person to look at, not for a sweep to retry on a public account.
//   - It never runs without the two gates a live Meta write already needs
//     (DATA_SOURCE=supabase and META_LIVE_WRITES=enabled), so a fixture or a
//     read-only deployment can never post. AUTO_POST_DISABLED=1 stops it.
//   - It posts at most AUTO_POST_MAX_PER_RUN clips a run, so a backlog trickles
//     out instead of arriving as a dump on the Page.
//
// TikTok is not here. Studio has no TikTok content-posting credential — its
// TikTok clips run as dark posts inside ads and never touch the profile — so
// the summary names what it posted and a person mirrors it to TikTok by hand.
//
// The cadence needs no table: an auto-posted row is the one whose `created_by`
// is the system user (lib/auth.ts SYSTEM_USER_ID), so the last run is the
// newest of those.

import { SYSTEM_USER_ID, systemSession } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import { getData } from "@/lib/data";
import type { ClipLibraryRow, ClipPost } from "@/lib/launch/clip-posts";

/** The bar a clip clears, and how often the sweep runs. Every one is an env override. */
export const AUTO_POST_RULE = {
  everyHours: num("AUTO_POST_EVERY_HOURS", 60),           // 2.5 days
  maxPerRun: num("AUTO_POST_MAX_PER_RUN", 3),
  minImpressions: num("AUTO_POST_MIN_IMPRESSIONS", 500),  // the `early` line
  minCtrPct: num("AUTO_POST_MIN_CTR_PCT", 2),
  minCheckouts: num("AUTO_POST_MIN_CHECKOUTS", 1),
};
function num(key: string, fallback: number): number {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export type AutoPostPick = {
  clip_id: string;
  label: string;
  title: string;
  impressions: number;
  ctr_pct: number;
  checkouts: number;
  /** Where it went, and what came back. A platform that failed carries its sentence. */
  results: { platform: "facebook" | "instagram"; ok: boolean; permalink?: string | null; error?: string }[];
};

export type AutoPostRun = {
  at: string;
  /** Why nothing was posted, when nothing was. Null on a run that posted. */
  idle: string | null;
  posted: AutoPostPick[];
  /** Clips that cleared the bar but did not fit this run's ceiling. */
  waiting: number;
  /** Ad accounts TikTok would not report on, so their clips could not be judged. */
  unreadable: string[];
  errors: string[];
  next_due_at: string;
};

type State = { last: AutoPostRun | null; running: boolean };
const g = globalThis as typeof globalThis & { __studioAutoPost?: State };
const state = (): State => (g.__studioAutoPost ??= { last: null, running: false });

/** The newest run, for the Clips page's line. Null until one has happened in this process. */
export function lastAutoPostRun(): AutoPostRun | null { return state().last; }

/** On, unless a gate says otherwise. The same gates a live Meta write already needs. */
export function autoPostEnabled(): boolean {
  return process.env.AUTO_POST_DISABLED !== "1"
    && dataSource() === "supabase"
    && process.env.META_LIVE_WRITES === "enabled";
}

/** When the sweep may run again, from the newest row the system user created. */
export async function nextDueAt(posts: readonly ClipPost[]): Promise<Date> {
  const at = (rows: readonly ClipPost[]) => rows.map(p => Date.parse(p.created_at)).filter(Number.isFinite);
  const mine = at(posts.filter(p => p.created_by === SYSTEM_USER_ID));
  if (mine.length) return new Date(Math.max(...mine) + AUTO_POST_RULE.everyHours * 3600_000);
  // Never run before: the clock starts from the newest post by anybody, so a
  // first start after a person has just posted by hand waits its turn instead
  // of posting again on top of them. With no posts at all it is due at once.
  const anyone = at(posts);
  return new Date((anyone.length ? Math.max(...anyone) : 0) + AUTO_POST_RULE.everyHours * 3600_000);
}

/**
 * Which clips deserve a post, best first. Pure, so the rule is testable without
 * a provider: `summaries` is lib/crazydramas/stats-creatives.ts' reading by clip
 * id, `taken` the platforms each clip already has a row for.
 */
export function pickAutoPosts(
  library: readonly ClipLibraryRow[],
  summaries: Record<string, { impressions: number | null; ctr: number | null; hold_6s: number | null; checkouts: number | null; early: boolean }>,
  taken: ReadonlyMap<string, ReadonlySet<string>>,
): { ready: { clip: ClipLibraryRow; impressions: number; ctr_pct: number; checkouts: number; platforms: ("facebook" | "instagram")[] }[] } {
  const ready: ReturnType<typeof pickAutoPosts>["ready"] = [];
  for (const clip of library) {
    const n = summaries[clip.id];
    if (!n || n.early) continue;
    const impressions = n.impressions ?? 0;
    const ctr_pct = (n.ctr ?? 0) * 100;
    const checkouts = n.checkouts ?? 0;
    if (impressions < AUTO_POST_RULE.minImpressions) continue;
    if (ctr_pct < AUTO_POST_RULE.minCtrPct) continue;
    if (checkouts < AUTO_POST_RULE.minCheckouts) continue;
    // A clip with no stored file cannot be uploaded; publish would refuse it anyway.
    if (!clip.file_path || !clip.sha256) continue;
    const has = taken.get(clip.id) ?? new Set<string>();
    const platforms = (["facebook", "instagram"] as const).filter(p => !has.has(p));
    if (!platforms.length) continue;
    ready.push({ clip, impressions, ctr_pct, checkouts, platforms: [...platforms] });
  }
  // Checkouts are the closest thing to money; click-through breaks the tie.
  ready.sort((a, b) => b.checkouts - a.checkouts || b.ctr_pct - a.ctr_pct || b.impressions - a.impressions);
  return { ready };
}

/**
 * The scheduler's step. Never throws: a sweep that cannot read TikTok, or that
 * Meta refuses, records the sentence and leaves the next tick to try again.
 */
export async function tickAutoPost(): Promise<AutoPostRun | null> {
  if (!autoPostEnabled()) return null;
  const s = state();
  if (s.running) return s.last;
  s.running = true;
  const run: AutoPostRun = { at: new Date().toISOString(), idle: null, posted: [], waiting: 0, unreadable: [], errors: [], next_due_at: "" };
  try {
    const session = systemSession();
    const data = getData();
    const posts = await data.listClipPosts(session);
    const due = await nextDueAt(posts);
    run.next_due_at = due.toISOString();
    if (Date.now() < due.getTime()) { run.idle = "not due yet"; return (s.last = run); }

    const library = await data.listClipLibrary(session, {});
    // What TikTok already paid to learn about each clip.
    const { adCreatives } = await import("@/lib/crazydramas/stats-ads");
    const { clipSummaries, creativeRows } = await import("@/lib/crazydramas/stats-creatives");
    const { readTikTokAdVideo } = await import("@/lib/tiktok/ad-video");
    const runs = await data.listLaunchRuns(session);
    const read = await readTikTokAdVideo(runs, "lifetime", {});
    run.unreadable = read.failed.map(f => f.advertiser_id);
    const summaries = clipSummaries(creativeRows(adCreatives(runs, new Map()), read.ads));

    const taken = new Map<string, Set<string>>();
    for (const p of posts) {
      if (!taken.has(p.clip_id)) taken.set(p.clip_id, new Set());
      taken.get(p.clip_id)!.add(p.platform);
    }

    const { ready } = pickAutoPosts(library, summaries, taken);
    if (!ready.length) { run.idle = "nothing cleared the bar"; return (s.last = run); }
    run.waiting = Math.max(0, ready.length - AUTO_POST_RULE.maxPerRun);

    const { publishClip, clipPostSettled } = await import("@/lib/meta/publish");
    // The Meta account is the company's own, read once per company.
    const byProducer = new Map<string, Awaited<ReturnType<typeof data.getLaunchConnections>>>();
    const metaFor = async (producerId: string) => {
      if (!byProducer.has(producerId))
        byProducer.set(producerId, (await data.getLaunchConnections(session, producerId, "meta"))
          .filter(c => c.enabled && c.assigned_by && c.page_id));
      return byProducer.get(producerId)!;
    };
    for (const pick of ready.slice(0, AUTO_POST_RULE.maxPerRun)) {
      const entry: AutoPostPick = {
        clip_id: pick.clip.id, label: pick.clip.label, title: pick.clip.title_name,
        impressions: pick.impressions, ctr_pct: Number(pick.ctr_pct.toFixed(1)), checkouts: pick.checkouts, results: [],
      };
      const connection = (await metaFor(pick.clip.producer_id))[0];
      if (!connection) {
        entry.results.push({ platform: "facebook", ok: false, error: "This company has no assigned Meta account." });
        run.posted.push(entry);
        continue;
      }
      for (const platform of pick.platforms) {
        if (platform === "instagram" && !connection.instagram_id) {
          entry.results.push({ platform, ok: false, error: "No Instagram identity on this Meta account." });
          continue;
        }
        try {
          const post = await publishClip(session, { clip_id: pick.clip.id, platform, connection_id: connection.id });
          await clipPostSettled(post.id);
          const settled = await data.getClipPost(session, post.id);
          entry.results.push(settled.status === "published"
            ? { platform, ok: true, permalink: settled.permalink }
            : { platform, ok: false, error: settled.error ?? `left ${settled.status}` });
        } catch (e) {
          entry.results.push({ platform, ok: false, error: (e as Error).message });
        }
      }
      run.posted.push(entry);
    }
    if (!run.posted.some(p => p.results.some(r => r.ok))) run.idle = "every post was refused";
    return (s.last = run);
  } catch (e) {
    run.errors.push((e as Error).message);
    run.idle = "the sweep failed";
    return (s.last = run);
  } finally {
    s.running = false;
  }
}
