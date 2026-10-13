// Running creator accounts by themselves (decision 2026-10-12): step 9 of the
// scheduler (lib/tiktok/scheduler.ts), every tick (five minutes):
//
//   a. publish the scheduled posts that are due, and resume any left open
//   b. read comments on each active account's media (every 5 minutes)
//   c. decide them: the rules first, then one model draft per ordinary comment
//   d. send the drafted replies that are due (auto-reply on, within the hourly cap)
//   e. once a day per account, read its insights and its media's
//
// Gates, the same as the auto-poster's (lib/launch/auto-post.ts): only with
// DATA_SOURCE=supabase and META_LIVE_WRITES=enabled, never in fixture mode;
// CREATORS_DISABLED=1 stops all of it. A person's "Post now", "Send now",
// "Check comments now" and "Read now" do not wait for the sweep and work in
// fixture mode against the fake. Never throws; the last run is kept in memory
// for the /creators page's status line (process-local by design: every
// cadence is read back from the database, so a restart repeats nothing).

import { systemSession } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import { getData } from "@/lib/data";
import { readCreatorInsights } from "./insights";
import { tickCreatorPosts } from "./publish";
import { decideComments, pollComments, sendDueReplies } from "./replies";

export const COMMENTS_EVERY_MS = 5 * 60_000;

export type CreatorsRun = {
  at: string;
  idle: string | null;
  posts: { started: number; resumed: number };
  comments: { read: number; added: number; drafted: number; flagged: number; skipped: number; waiting: number };
  replies: { sent: number; failed: number; held: string[] };
  insights: string[];
  errors: string[];
};

type State = { last: CreatorsRun | null; running: boolean; commentsAt: Map<string, number> };
const g = globalThis as typeof globalThis & { __studioCreatorSweep?: State };
const state = (): State => (g.__studioCreatorSweep ??= { last: null, running: false, commentsAt: new Map() });

/** The newest run, for the /creators status line. Null until one ran in this process. */
export function lastCreatorsRun(): CreatorsRun | null { return state().last; }
/** Tests start clean. */
export function resetCreatorSweep(): void { g.__studioCreatorSweep = undefined; }

/** On unless a gate says otherwise: the gates a live Meta write already needs, plus the kill switch. */
export function creatorsEnabled(): boolean {
  return process.env.CREATORS_DISABLED !== "1" && dataSource() === "supabase" && process.env.META_LIVE_WRITES === "enabled";
}
/** Why the sweep is off, in words for the status line; null when it runs. */
export function creatorsGate(): string | null {
  if (process.env.CREATORS_DISABLED === "1") return "stopped by CREATORS_DISABLED=1";
  if (dataSource() !== "supabase") return "fixture mode: nothing runs by itself";
  if (process.env.META_LIVE_WRITES !== "enabled") return "META_LIVE_WRITES is not enabled";
  return null;
}

export async function tickCreators(now = new Date()): Promise<CreatorsRun | null> {
  if (!creatorsEnabled()) return null;
  const s = state();
  if (s.running) return s.last;
  s.running = true;
  const run: CreatorsRun = {
    at: now.toISOString(), idle: null, posts: { started: 0, resumed: 0 },
    comments: { read: 0, added: 0, drafted: 0, flagged: 0, skipped: 0, waiting: 0 }, replies: { sent: 0, failed: 0, held: [] }, insights: [], errors: [],
  };
  try {
    // a. posts
    try {
      const p = await tickCreatorPosts(now);
      run.posts = { started: p.started, resumed: p.resumed };
      run.errors.push(...p.errors);
    } catch (e) { run.errors.push(`posts: ${(e as Error).message}`); }

    const accounts = (await getData().listCreatorAccounts(systemSession())).filter(a => a.status === "active");
    if (!accounts.length) run.idle = "no active creator accounts";
    for (const account of accounts) {
      const name = `@${account.handle}`;
      // b + c. comments, every five minutes per account
      if (now.getTime() - (s.commentsAt.get(account.id) ?? 0) >= COMMENTS_EVERY_MS - 5_000) {
        try {
          const read = await pollComments(account, now);
          s.commentsAt.set(account.id, now.getTime());
          run.comments.read += read.read; run.comments.added += read.added;
        } catch (e) { run.errors.push(`${name} comments: ${(e as Error).message}`); }
        try {
          const d = await decideComments(account, { now });
          run.comments.drafted += d.drafted; run.comments.flagged += d.flagged; run.comments.skipped += d.skipped; run.comments.waiting += d.waiting;
          if (d.note) run.errors.push(`${name}: ${d.note}`);
        } catch (e) { run.errors.push(`${name} drafts: ${(e as Error).message}`); }
      }
      // d. replies
      try {
        const r = await sendDueReplies(account, now);
        run.replies.sent += r.sent; run.replies.failed += r.failed;
        if (r.held) run.replies.held.push(`${name}: ${r.held}`);
      } catch (e) { run.errors.push(`${name} replies: ${(e as Error).message}`); }
      // e. insights, once a day (the stats table says whether today was read)
      try {
        const i = await readCreatorInsights(account, { now });
        if (!i.skipped) run.insights.push(`${name}: ${i.day}, ${i.media} posts`);
      } catch (e) { run.errors.push(`${name} insights: ${(e as Error).message}`); }
    }
    return (s.last = run);
  } catch (e) {
    run.errors.push((e as Error).message);
    run.idle = "the sweep failed";
    return (s.last = run);
  } finally {
    s.running = false;
  }
}
