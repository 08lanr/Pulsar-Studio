// The in-process heartbeat — Pulsar Grow's lib/scheduler.ts, lighter.
// Started once per process by the first server request that reaches a
// portal layout or an API handler (ensureScheduler below; Next's boot hook
// would drag these Node imports into the edge bundle). It works because the
// app is one long-lived Node process (the Pulsar topology: next start
// behind Caddy). SCHEDULER_DISABLED=1 is the kill switch for any
// environment that is not that.
//
// Each tick, in order:
//   1. adopt unfinished launches (crash/deploy recovery — the engine's
//      idempotency makes re-running safe; a row still "running" with a
//      stale heartbeat was orphaned by a dead process)
//   2. poll TikTok's review for every launched campaign whose status can move
//   3. read metrics back, at most hourly
//
// State lives on globalThis (Next bundles lib/ per route). `tick()` is also
// what the staff "Sync now" button runs, so the desk never waits five minutes.

import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { runLaunch } from "./launch";
import { syncCampaignResults } from "./metrics";
import { pollCampaignReview } from "./review";

const TICK_MS = 5 * 60 * 1000;
const METRICS_EVERY_MS = 60 * 60 * 1000;
/** A running launch whose heartbeat is older than this was orphaned. */
const STALE_MS = 10 * 60 * 1000;

type SchedState = { started: boolean; ticking: boolean; lastMetricsAt: number; lastTickAt: number | null; lastSummary: TickSummary | null };
const store = globalThis as unknown as { __studioTikTokSched?: SchedState };

function state(): SchedState {
  if (!store.__studioTikTokSched) store.__studioTikTokSched = { started: false, ticking: false, lastMetricsAt: 0, lastTickAt: null, lastSummary: null };
  return store.__studioTikTokSched;
}

export type TickSummary = { at: string; launches: number; polled: number; synced: number; errors: string[] };

export function schedulerStatus(): { started: boolean; lastTickAt: string | null; lastSummary: TickSummary | null } {
  const s = state();
  return { started: s.started, lastTickAt: s.lastTickAt ? new Date(s.lastTickAt).toISOString() : null, lastSummary: s.lastSummary };
}

export async function tick(opts: { metrics?: boolean } = {}): Promise<TickSummary> {
  const s = state();
  const summary: TickSummary = { at: new Date().toISOString(), launches: 0, polled: 0, synced: 0, errors: [] };
  if (s.ticking) return summary;
  s.ticking = true;
  try {
    const data = getData();
    const session = systemSession();

    // 1. launches
    const open = await data.listOpenPromoLaunches(session);
    for (const launch of open) {
      const stale = launch.status === "pending" || !launch.heartbeat_at || Date.now() - new Date(launch.heartbeat_at).getTime() > STALE_MS;
      if (!stale) continue;
      try {
        await runLaunch(launch.id);
        summary.launches += 1;
      } catch (e) {
        summary.errors.push(`launch ${launch.id}: ${(e as Error).message}`);
      }
    }

    // 2. review + 3. metrics
    const launched = await data.listLaunchedPromoCampaigns(session);
    const doMetrics = opts.metrics ?? Date.now() - s.lastMetricsAt >= METRICS_EVERY_MS;
    for (const row of launched) {
      try {
        const r = await pollCampaignReview(row);
        summary.polled += 1;
        if (r.error) summary.errors.push(`review ${row.campaign.external_id}: ${r.error}`);
      } catch (e) {
        summary.errors.push(`review ${row.campaign.external_id}: ${(e as Error).message}`);
      }
      if (!doMetrics) continue;
      try {
        const m = await syncCampaignResults(row);
        summary.synced += m.written;
        if (m.error) summary.errors.push(`metrics ${row.campaign.external_id}: ${m.error}`);
      } catch (e) {
        summary.errors.push(`metrics ${row.campaign.external_id}: ${(e as Error).message}`);
      }
    }
    if (doMetrics) s.lastMetricsAt = Date.now();
  } finally {
    s.ticking = false;
    s.lastTickAt = Date.now();
    s.lastSummary = summary;
  }
  return summary;
}

/** Idempotent, cheap: call from any Node-runtime entry point. */
export function ensureScheduler(): void {
  if (!state().started && process.env.NEXT_RUNTIME !== "edge" && process.env.NODE_ENV !== "test") startScheduler();
}

export function startScheduler(): void {
  const s = state();
  if (s.started) return;
  if (process.env.SCHEDULER_DISABLED === "1") {
    console.log("[tiktok-scheduler] disabled by SCHEDULER_DISABLED=1");
    return;
  }
  s.started = true;
  const run = () => {
    tick().catch((e) => console.error("[tiktok-scheduler] tick failed", e));
  };
  // First tick shortly after boot (adopt anything a deploy interrupted), then every five minutes.
  setTimeout(run, 15_000).unref?.();
  setInterval(run, TICK_MS).unref?.();
  console.log("[tiktok-scheduler] started");
}
