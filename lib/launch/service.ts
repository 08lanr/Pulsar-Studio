import { randomUUID } from "node:crypto";
import { systemSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { launchEnvironment } from "./environment";
import { assertCampaignBudget } from "./budget";
import { isLaunchWaiting, providerRetryDelay, type WaitingState } from "./waiting";
import { launchHash } from "@/lib/data/launch";
import { conflict, forbidden, invalid, notFound } from "@/lib/data/errors";
import type { DriverContext, LaunchCampaign, LaunchControl, LaunchDriver, LaunchRun } from "./types";

// The monitor's snapshot derivation. It lives in `provider-errors.ts` because
// the monitor is a client component and this module reaches the data layer;
// it is re-exported here so the derivation stays part of the launch service's
// surface and the service tests read it from one place.
export { monitorState, needsFirstSweep, switchIsKnown, campaignPlatforms, type MonitorState } from "./provider-errors";

const system = systemSession;
const now = () => new Date().toISOString();
/** How many times a provider may say "later" before the campaign reads as failed and waits for a person. */
const MAX_PROVIDER_RETRIES = 12;
const retriesLeft = (c: LaunchCampaign) => Number(c.state.provider_retries ?? 0) < MAX_PROVIDER_RETRIES;
const message = (e: unknown) => e instanceof Error ? e.message : "Provider operation failed.";
export async function launchDriver(run: LaunchRun): Promise<LaunchDriver> {
  return run.draft.provider === "meta" ? (await import("@/lib/meta/driver")).metaDriver : (await import("@/lib/tiktok/spark-driver")).tiktokSparkDriver;
}
function canControl(s: Session) {
  if (s.kind === "staff" ? s.staffRole !== "admin" : s.producerRole !== "approver") throw forbidden("An approver or staff administrator must authorize campaign changes.");
}
function signed(run: LaunchRun) {
  if (!run.approved_by || !run.snapshot_hash || launchHash(run.draft, run.connections || [],
    run.campaigns.some(c => c.campid) ? run.campaigns : undefined) !== run.snapshot_hash) throw invalid("Launch approval is missing or changed. Create and approve a new round.");
  if (run.mode !== launchEnvironment(run.draft.provider)) throw invalid("Approval belongs to a different environment. Create a new draft.");
}

// One durable lease covers launch, monitor and controls. Each checkpoint also
// incorporates stop requests arriving while an external request was in flight.
async function locked(id: string, task: (run: LaunchRun, context: (c: LaunchCampaign, launching?: boolean, stopping?: boolean) => DriverContext, persist: () => Promise<void>) => Promise<void>): Promise<LaunchRun | null> {
  const data = getData(), actor = system(), owner = randomUUID();
  const run = await data.claimLaunchRun(actor, id, owner);
  if (!run) return null;
  const refresh = async () => {
    const fresh = await data.getLaunchRun(actor, id);
    if (fresh.lease_owner !== owner || Date.parse(fresh.lease_until || "") <= Date.now()) throw conflict("Launch is being updated by another worker.");
    for (const c of run.campaigns) {
      const current = fresh.campaigns.find(x => x.id === c.id);
      // A newer producer stop always wins; do not roll back a local resume.
      if (fresh.revision !== run.revision && current?.state.desired_status) {
        c.state.desired_status = current.state.desired_status;
        c.state.stop_request_id = current.state.stop_request_id;
      }
    }
    if (fresh.revision !== run.revision) {
      run.audit = [...(fresh.audit || []), ...(run.audit || []).filter(a => !(fresh.audit || []).some(b => JSON.stringify(a) === JSON.stringify(b)))];
    }
    run.revision = fresh.revision;
  };
  const persist = async () => {
    await refresh();
    const saved = await data.updateLaunchRun(actor, run, owner);
    run.revision = saved.revision; run.updated_at = saved.updated_at; run.lease_until = saved.lease_until;
  };
  const context = (campaign: LaunchCampaign, launching = false, stopping = false): DriverContext => {
    const connection = run.connections?.find(a => a.id === campaign.connection_id);
    if (!connection) throw invalid("Approved account assignment is missing.");
    return { run, campaign, connection,
      checkpoint: async patch => { campaign.state = { ...campaign.state, ...patch }; await persist(); },
      assertActive: async () => {
        await refresh(); signed(run);
        if (!stopping) assertCampaignBudget(run, campaign);
        if (launching && campaign.state.desired_status && !(campaign.state.desired_status === "paused" && campaign.state.prepare_while_paused)) throw conflict(`Campaign ${campaign.state.desired_status} by its approver.`);
        // Through the inventory's short cache: this runs before every provider
        // write, and re-listing every ad account on each one is what would trip
        // Meta's per-app call limit on a first launch.
        const assigned = await data.getLaunchConnections(actor, run.producer_id, run.draft.provider, false);
        if (!assigned.some(a => a.id === connection.id && a.enabled && a.advertiser_id === connection.advertiser_id && a.page_id === connection.page_id && a.instagram_id === connection.instagram_id)) throw forbidden("Account assignment changed. Create and approve a new round.");
      },
    };
  };
  try { signed(run); await task(run, context, persist); }
  finally {
    // A stale worker may never clear a replacement worker's lease.
    await refresh(); run.lease_owner = null; run.lease_until = null; await persist();
  }
  return run;
}

export async function executeLaunch(id: string): Promise<LaunchRun | null> {
  return locked(id, async (run, context, persist) => {
    if (!["pending", "running"].includes(run.status)) return;
    const driver = await launchDriver(run); run.status = "running"; await persist();
    for (const campaign of run.campaigns) {
      if (!["pending", "running"].includes(campaign.status)) continue;
      try {
        campaign.status = "running"; await persist();
        const ctx = context(campaign, true); await ctx.assertActive();
        await driver.launch(ctx);
        campaign.state.launch_complete = true;
        // A stop may arrive during the final activation request. Reconcile it
        // immediately, even when the provider returned success.
        await ctx.checkpoint({ launch_complete: true, prepare_while_paused: false });
        if (campaign.state.desired_status) throw conflict("Stop requested during preparation.");
        campaign.status = "done"; campaign.error = null; delete campaign.state.waiting; delete campaign.state.provider_retries;
        campaign.snapshot = await driver.monitor(context(campaign));
      } catch (e) {
        // The returned IDs were checkpointed even when a pause raced a write.
        if (campaign.state.desired_status) {
          try {
            await driver.control(context(campaign, false, true), { action: campaign.state.desired_status === "ended" ? "end" : "pause" });
            campaign.snapshot = await driver.monitor(context(campaign));
            campaign.state.stop_applied = campaign.state.desired_status;
            campaign.status = campaign.state.launch_complete || campaign.state.desired_status === "ended" ? "done" : "failed";
            campaign.error = campaign.state.launch_complete ? null : "Stopped before preparation finished. Retry prepares it paused; Resume activates it.";
          } catch (stopError) { campaign.status = "failed"; campaign.error = message(stopError); }
        } else if (isLaunchWaiting(e) || (providerRetryDelay(e) !== null && retriesLeft(campaign))) {
          // Come back later: the row stays pending with its checkpoints, the run
          // stays open for the sweep, and this process returns on its own. A
          // provider that is rate-limiting, timing out or answering 5xx is the
          // same wait, a bounded number of times; a lost write is reconciled by
          // the driver's own intent record on the next attempt, never resent.
          const delay = isLaunchWaiting(e) ? e.retryAfterMs : providerRetryDelay(e)!;
          if (!isLaunchWaiting(e)) campaign.state.provider_retries = Number(campaign.state.provider_retries ?? 0) + 1;
          campaign.status = "pending"; campaign.error = null;
          campaign.state.waiting = { reason: message(e), since: new Date().toISOString(), retry_after_ms: delay } satisfies WaitingState;
          // The test runner never waits for a wake-up; the sweep is its recovery.
          if (process.env.NODE_ENV !== "test") setTimeout(() => queueLaunch(run.id), delay).unref?.();
        } else { campaign.status = "failed"; campaign.error = message(e); }
      }
      await persist();
    }
    run.status = run.campaigns.some(c => c.status === "pending") ? "pending"
      : run.campaigns.some(c => c.status === "failed") ? "failed" : "done";
    run.error = run.status === "failed" ? "Some campaigns need attention. Successful campaigns are preserved." : null;
    await persist();
  });
}

export async function monitorLaunch(id: string): Promise<LaunchRun | null> {
  return locked(id, async (run, context, persist) => {
    const driver = await launchDriver(run);
    for (const c of run.campaigns) {
      if (c.status === "pending") continue;
      try {
        const ctx = context(c);
        if (c.state.desired_status && c.state.stop_applied !== c.state.desired_status) {
          await driver.control(context(c, false, true), { action: c.state.desired_status === "ended" ? "end" : "pause" });
          c.state.stop_applied = c.state.desired_status;
        }
        c.snapshot = await driver.monitor(ctx);
        if (run.draft.provider === "tiktok" && c.state.launch_complete && !c.state.desired_status) {
          await (await import("@/lib/tiktok/spark-driver")).reconcileTikTokSparks(context(c, true));
          c.snapshot = await driver.monitor(ctx);
        }
      } catch (e) {
        c.snapshot = { spend_cents: null, clicks: null, impressions: null, conversions: null, cpc_cents: null, delivery: "unknown", checked_at: now(), note: message(e) };
      }
      await persist();
      // Review-triggered copies can be interrupted at their final activation.
      // Settle a stop from that interval before returning the monitor row.
      if (c.state.desired_status && c.state.stop_applied !== c.state.desired_status) {
        try {
          await driver.control(context(c, false, true), { action: c.state.desired_status === "ended" ? "end" : "pause" });
          c.state.stop_applied = c.state.desired_status;
          c.snapshot = await driver.monitor(context(c));
        } catch (e) {
          c.snapshot = { spend_cents: null, clicks: null, impressions: null, conversions: null, cpc_cents: null, delivery: "unknown", checked_at: now(), note: message(e) };
        }
        await persist();
      }
    }
  });
}

export async function controlLaunch(s: Session, id: string, campaignId: string, control: LaunchControl): Promise<LaunchRun> {
  const data = getData(); canControl(s);
  const visible = await data.getLaunchRun(s, id);
  const campaign = visible.campaigns.find(c => c.id === campaignId);
  if (!campaign) throw notFound("Campaign");
  if (control.action === "pause" || control.action === "end") await data.requestLaunchStop(s, id, campaignId, control.action === "end");
  const result = await locked(id, async (run, context, persist) => {
    const c = run.campaigns.find(row => row.id === campaignId)!;
    if (control.action === "end" && c.state.stop_applied === "ended") return;
    if (c.state.desired_status === "ended" && control.action !== "end") throw conflict("This campaign is ended. Create a new round.");
    if (control.action === "resume" && !c.state.launch_complete) throw conflict("Preparation is incomplete. Retry the failed launch or create a new round.");
    const pending = c.state.pending_control as { control?: LaunchControl } | undefined;
    if (pending?.control && !["pause", "end"].includes(control.action) && JSON.stringify(pending.control) !== JSON.stringify(control)) throw conflict("A prior control needs reconciliation. Repeat that same control or pause/end the campaign first.");
    if (control.action === "budget" && (!Number.isSafeInteger(control.budget_cents) || control.budget_cents < 100 || control.budget_cents > 100_000_000)) throw invalid("Invalid budget.");
    if (control.action === "budget") assertCampaignBudget(run, c, control.budget_cents);
    const previous = { budget_cents: c.budget_cents, daily_budget_cents: c.daily_budget_cents };
    const initialStop = c.state.stop_request_id;
    // Validate against the frozen allocation before persisting the desired row.
    // The audit records in-place changes within that ceiling; it cannot raise it.
    c.state.pending_control = { control, actor: s.userId, at: now(), previous };
    run.audit = [...(run.audit || []), { at: now(), actor: s.userId, action: "control_authorized", detail: { campaign_id: c.id, ...control, previous } }];
    if (control.action === "budget") c.budget_cents = control.budget_cents;
    if (control.action === "resume") { delete c.state.desired_status; delete c.state.stop_applied; }
    await persist();
    const reconcileStop = async () => {
      if (c.state.desired_status && c.state.stop_request_id !== initialStop) {
        await (await launchDriver(run)).control(context(c, false, true), { action: c.state.desired_status === "ended" ? "end" : "pause" });
        c.state.stop_applied = c.state.desired_status;
        await persist();
      }
    };
    try {
      const baseContext = context(c, false, control.action === "pause" || control.action === "end");
      const ctx = { ...baseContext, assertActive: async () => {
        await baseContext.assertActive();
        if (!["pause", "end"].includes(control.action) && c.state.desired_status && c.state.stop_request_id !== initialStop) throw conflict("A new stop was requested during this control.");
      } };
      await ctx.assertActive();
      await (await launchDriver(run)).control(ctx, control);
      await persist(); await reconcileStop();
      if ((control.action === "end" || control.action === "pause") && c.state.stop_request_id === initialStop) c.state.stop_applied = control.action === "end" ? "ended" : "paused";
      if (control.action === "daily_budget") c.daily_budget_cents = control.daily_budget_cents;
      c.state.pending_control = null;
      c.state.control_error = null;
      c.snapshot = await (await launchDriver(run)).monitor(ctx);
      run.audit!.push({ at: now(), actor: s.userId, action: "control_applied", detail: { campaign_id: c.id, ...control } });
      await persist();
    } catch (e) {
      // Preserve desired budget and ambiguity for safe retry/readback. Never
      // claim the provider accepted a change after a timeout.
      c.state.control_error = message(e); await persist(); await reconcileStop(); throw e;
    }
  });
  if (!result && control.action !== "pause" && control.action !== "end") throw conflict("Campaign is being updated. Try again shortly.");
  return result || data.getLaunchRun(s, id);
}

export async function refreshLaunches(s: Session, force = false): Promise<LaunchRun[]> {
  // History remains readable even when a provider token or clip library is unavailable.
  const data = getData(); const runs = await data.listLaunchRuns(s);
  if (force) for (const r of runs.filter(r => r.status !== "draft")) {
    if (r.status === "pending" || r.status === "running") await executeLaunch(r.id);
    await monitorLaunch(r.id);
  }
  return data.listLaunchRuns(s);
}

export async function tickLaunches(): Promise<void> {
  const rows = await getData().listPendingLaunchRuns(system());
  for (const r of rows) {
    if (r.lease_owner && Date.parse(r.lease_until || "") > Date.now()) continue;
    try {
      if (r.status === "pending" || r.status === "running") await executeLaunch(r.id);
      await monitorLaunch(r.id);
    } catch (e) { console.error("[launch] sweep", r.external_id, message(e)); }
  }
}

/** Durable pending state is saved before starting; the sweep recovers restarts. */
export function queueLaunch(id: string): void { void executeLaunch(id).catch(e => console.error("[launch] worker", id, message(e))); }
