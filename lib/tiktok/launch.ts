// The launch engine — Pulsar Grow's lib/launch-job.ts invariants over
// Studio's data layer (decision 2026-09-09, "TikTok launch"):
//
//   IDEMPOTENT — a step whose output id is already recorded on the launch
//     row is skipped. Duplicate campaigns spending real money is the worst
//     possible bug, so resuming or retrying can never re-create something.
//     One launch row per approval manifest (unique idempotency key), so a
//     second press of the button resumes, never re-launches.
//   RESUMABLE — the row is persisted after EVERY step; killed mid-run the
//     scheduler adopts it (stale heartbeat) and it picks up at the first
//     unfinished step.
//   ISOLATED CREATIVE FAILURES — one bad file skips that ad, not the launch;
//     the launch only fails when NO ad survives.
//
// Steps: identity → upload the rendered ads → covers → campaign → ad group →
// ads. Objective TRAFFIC to the campaign's destination URL (decision:
// "ads send viewers to a link"); the ad group's lifetime budget is exactly
// the approved experiment budget — nothing here may spend more than the
// producer signed.
//
// The engine runs as the system actor and against whichever transport
// lib/tiktok/index.ts chose: in fixture mode the fake, so the demo walks the
// same six steps and spends nothing.

import crypto from "node:crypto";
import path from "node:path";
import { systemSession } from "@/lib/auth";
import { getData, isDataError } from "@/lib/data";
import { readStoredBytes } from "@/lib/data/storage";
import type { PromoCreative, PromoLaunch } from "@/lib/types";
import { accessTokenFor, launchMode, tiktokTransport } from "./index";
import { fetchIdentities } from "./preflight";

/** TikTok rejects lifetime budgets below this (USD); the fake enforces it too. */
export const MIN_BUDGET_USD = 20;
/** United States. */
const DEFAULT_LOCATION_IDS = ["6252001"];
/** The ad group runs the budget over at most this many days. */
const MAX_DURATION_DAYS = 30;

// One run at a time per launch, across every route/scheduler bundle —
// globalThis for the same reason as the transport's pacer.
const lockStore = globalThis as unknown as { __studioLaunchRunning?: Set<string> };
const running: Set<string> = lockStore.__studioLaunchRunning ?? new Set();
lockStore.__studioLaunchRunning = running;

/** UTC "YYYY-MM-DD HH:MM:SS" — the timestamp format TikTok's API expects. */
function tiktokTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Days the ad group runs: the approved budget at no less than the daily
 * minimum, capped. $100 runs five days; $20 runs one.
 */
export function scheduleDays(budgetUsd: number): number {
  return Math.max(1, Math.min(MAX_DURATION_DAYS, Math.floor(budgetUsd / MIN_BUDGET_USD)));
}

export type LaunchOutcome = { status: PromoLaunch["status"]; error?: string };

export async function runLaunch(launchId: string): Promise<LaunchOutcome> {
  if (running.has(launchId)) return { status: "running" };
  running.add(launchId);
  try {
    return await runLocked(launchId);
  } finally {
    running.delete(launchId);
  }
}

async function runLocked(launchId: string): Promise<LaunchOutcome> {
  const session = systemSession();
  const data = getData();
  let launch = await data.getPromoLaunch(session, launchId);
  if (launch.status === "done" || launch.status === "failed") return { status: launch.status, error: launch.error ?? undefined };

  const fail = async (message: string): Promise<LaunchOutcome> => {
    await data.updatePromoLaunch(session, launch.id, { status: "failed", error: message, finished_at: new Date().toISOString() });
    // The status flip is guarded: if staff paused or ended meanwhile, that is the newer truth.
    try {
      await data.setPromoCampaignDelivery(session, launch.campaign_id, { status: "failed", status_note: message });
    } catch (e) {
      if (!isDataError(e)) throw e;
    }
    return { status: "failed", error: message };
  };

  const token = accessTokenFor(launch.advertiser_id);
  if (!token) {
    // Not a failure — no TikTok connection yet. The row stays pending and the scheduler retries once one exists.
    return { status: "pending" };
  }
  const tt = tiktokTransport();
  const mode = launchMode();
  if (launch.mode !== mode) {
    return fail(`This launch was recorded for ${launch.mode} but the app now runs ${mode}; refusing to continue against a different TikTok.`);
  }

  const detail = await data.getPromoCampaign(session, launch.campaign_id);
  const campaign = detail.campaign;
  if (!["launching", "failed"].includes(campaign.status)) return { status: launch.status };
  // The manifest names the frozen creatives: `{external_id}` rows from the
  // data layer (0003's shape), or bare ids in the demo seed. Either way only
  // approved creatives the manifest names become ads.
  const manifest = detail.approval?.manifest as { creatives?: Array<{ external_id?: string } | string> } | undefined;
  const chosen = new Set((manifest?.creatives ?? []).map((c) => (typeof c === "string" ? c : c.external_id)).filter((x): x is string => !!x));
  const creatives = detail.creatives.filter((c) => c.status === "approved" && (chosen.size === 0 || chosen.has(c.external_id) || chosen.has(c.id)));
  if (!creatives.length) return fail("The approved manifest names no creatives");
  if (launch.budget_usd < MIN_BUDGET_USD) return fail(`The approved budget ($${launch.budget_usd}) is below TikTok's minimum of $${MIN_BUDGET_USD}`);

  const now = new Date().toISOString();
  launch = await data.updatePromoLaunch(session, launch.id, {
    status: "running",
    started_at: launch.started_at ?? now,
    heartbeat_at: now,
    attempts: launch.attempts + 1,
    error: null,
  });
  await data.setPromoCampaignDelivery(session, campaign.id, { status: "launching", status_note: null, advertiser_id: launch.advertiser_id });
  const beat = async (patch: Parameters<typeof data.updatePromoLaunch>[2]) => {
    launch = await data.updatePromoLaunch(session, launch.id, { ...patch, heartbeat_at: new Date().toISOString() });
  };

  // --- identity ----------------------------------------------------------------
  // Scoped to the ad account THIS launch goes into: identities are
  // advertiser-scoped on TikTok's side.
  if (!launch.identity_id || !launch.identity_type) {
    const identities = await fetchIdentities(launch.advertiser_id);
    const identity = identities.find((i) => i.type === "BC_AUTH_TT") ?? identities[0];
    if (!identity) {
      return fail(`Ad account ${launch.advertiser_id} has no TikTok handle linked to it, so an uploaded video cannot run there — every ad is published by a TikTok account. Link one in Business Center → this ad account → Identities, then retry.`);
    }
    await beat({ identity_id: identity.id, identity_type: identity.type });
  }

  // --- upload the rendered ads ---------------------------------------------------
  const usable: PromoCreative[] = [];
  for (const creative of creatives) {
    if (launch.uploaded_videos[creative.id]) {
      usable.push(creative);
      continue;
    }
    const stored = creative.render_path ?? (mode === "fake" ? sourceOf(detail.episodes, creative) : null);
    if (!stored) {
      console.error(`[launch] creative ${creative.external_id} has no rendered file`);
      continue; // isolated failure
    }
    let buf: Buffer;
    try {
      buf = await readStoredBytes(stored);
    } catch (e) {
      console.error(`[launch] creative file unreadable ${stored}: ${(e as Error).message}`);
      continue;
    }
    // The approval froze a checksum of the render; the bytes that leave must match it.
    if (creative.render_sha256) {
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      if (sha !== creative.render_sha256) {
        console.error(`[launch] creative ${creative.external_id}: file hash does not match the approved manifest`);
        continue;
      }
    }
    const signature = crypto.createHash("md5").update(buf).digest("hex");
    const res = await tt.upload("/file/video/ad/upload/", token, {
      advertiser_id: launch.advertiser_id,
      upload_type: "UPLOAD_BY_FILE",
      video_signature: signature,
      file_name: path.basename(stored),
      video_file: { data: buf, filename: path.basename(stored) },
    });
    // Sandbox answers with a bare ARRAY — {"data": [{"video_id"}]}; accept every shape.
    const d = res.data as unknown;
    const arrayFirst = Array.isArray(d) ? (d[0] as { video_id?: string } | undefined) : undefined;
    const obj = (Array.isArray(d) ? undefined : d) as ({ video_id?: string } & { list?: Array<{ video_id?: string }> }) | undefined;
    const videoId = arrayFirst?.video_id ?? obj?.video_id ?? obj?.list?.[0]?.video_id;
    if (res.code !== 0 || !videoId) {
      console.error(`[launch] video upload failed for ${creative.external_id}: ${res.message}`);
      continue;
    }
    await beat({ uploaded_videos: { ...launch.uploaded_videos, [creative.id]: String(videoId) } });
    usable.push(creative);
  }
  if (!usable.length) return fail("No rendered ad could be uploaded to TikTok");

  // --- video covers ---------------------------------------------------------------
  for (const creative of usable) {
    const videoId = launch.uploaded_videos[creative.id];
    if (!videoId || launch.covers[videoId]) continue;
    const suggest = await tt.get("/file/video/suggestcover/", token, { advertiser_id: launch.advertiser_id, video_id: videoId });
    const coverUrl = ((suggest.data?.list ?? []) as Array<{ cover_url?: string }>)[0]?.cover_url;
    if (!coverUrl) {
      console.error(`[launch] no cover suggestion for ${videoId}: ${suggest.message}`);
      continue;
    }
    const up = await tt.post("/file/image/ad/upload/", token, { advertiser_id: launch.advertiser_id, upload_type: "UPLOAD_BY_URL", image_url: coverUrl, file_name: `cover-${videoId}.jpg` });
    const imageId = (up.data as { image_id?: string } | undefined)?.image_id;
    if (up.code !== 0 || !imageId) {
      console.error(`[launch] cover upload failed for ${videoId}: ${up.message}`);
      continue;
    }
    await beat({ covers: { ...launch.covers, [videoId]: String(imageId) } });
  }

  // --- campaign -------------------------------------------------------------------
  if (!launch.tiktok_campaign_id) {
    const res = await tt.post("/campaign/create/", token, {
      advertiser_id: launch.advertiser_id,
      campaign_name: `studio-${campaign.external_id}`.slice(0, 100),
      objective_type: "TRAFFIC",
      budget_mode: "BUDGET_MODE_INFINITE",
      operation_status: "ENABLE",
    });
    const id = (res.data as { campaign_id?: string } | undefined)?.campaign_id;
    if (res.code !== 0 || !id) return fail(`TikTok refused the campaign: ${res.message}`);
    await beat({ tiktok_campaign_id: String(id) });
    await data.setPromoCampaignDelivery(session, campaign.id, { status: "launching", grow_campaign_id: String(id) });
  }

  // --- ad group ---------------------------------------------------------------------
  if (!launch.tiktok_adgroup_id) {
    const start = new Date(Date.now() + 10 * 60 * 1000);
    const end = new Date(start.getTime() + scheduleDays(launch.budget_usd) * 24 * 60 * 60 * 1000);
    const res = await tt.post("/adgroup/create/", token, {
      advertiser_id: launch.advertiser_id,
      campaign_id: launch.tiktok_campaign_id,
      adgroup_name: `studio-${campaign.external_id}-${campaign.target_market || "US"}`.slice(0, 100),
      promotion_type: "WEBSITE",
      placement_type: "PLACEMENT_TYPE_AUTOMATIC",
      location_ids: DEFAULT_LOCATION_IDS,
      // The producer's approved total, as a lifetime ceiling. Nothing else is sent.
      budget_mode: "BUDGET_MODE_TOTAL",
      budget: launch.budget_usd,
      schedule_type: "SCHEDULE_START_END",
      schedule_start_time: tiktokTime(start),
      schedule_end_time: tiktokTime(end),
      optimization_goal: "CLICK",
      billing_event: "CPC",
      bid_type: "BID_TYPE_NO_BID",
      pacing: "PACING_MODE_SMOOTH",
      // House policy (from overlord): nobody may download or reshare the creative from the ad.
      video_download_disabled: true,
      share_disabled: true,
      operation_status: "ENABLE",
    });
    const id = (res.data as { adgroup_id?: string } | undefined)?.adgroup_id;
    if (res.code !== 0 || !id) return fail(`TikTok refused the ad group: ${res.message}`);
    await beat({ tiktok_adgroup_id: String(id) });
    await data.setPromoCampaignDelivery(session, campaign.id, { status: "launching", tiktok_adgroup_id: String(id) });
  }

  // --- ads ---------------------------------------------------------------------------
  if (!Object.keys(launch.ad_ids).length) {
    const submitted: Array<{ creative: PromoCreative; payload: Record<string, unknown> }> = [];
    usable.forEach((c, i) => {
      const videoId = launch.uploaded_videos[c.id];
      const cover = videoId ? launch.covers[videoId] : undefined;
      if (!videoId || !cover) return;
      submitted.push({
        creative: c,
        payload: {
          ad_name: `studio-${campaign.external_id}-${c.external_id}-${i + 1}`.slice(0, 100),
          identity_id: launch.identity_id,
          identity_type: launch.identity_type,
          ad_format: "SINGLE_VIDEO",
          video_id: videoId,
          image_ids: [cover],
          ad_text: (c.caption || campaign.name).slice(0, 100),
          call_to_action: "WATCH_NOW",
          landing_page_url: launch.destination_url,
        },
      });
    });
    if (!submitted.length) return fail("No ad was complete enough to submit (missing video or cover)");
    const res = await tt.post("/ad/create/", token, { advertiser_id: launch.advertiser_id, adgroup_id: launch.tiktok_adgroup_id, creatives: submitted.map((s) => s.payload) });
    const ids = (res.data as { ad_ids?: string[] } | undefined)?.ad_ids;
    if (res.code !== 0 || !ids?.length) return fail(`TikTok refused the ads: ${res.message}`);
    // ASSUMPTION, UNVERIFIED AGAINST THE LIVE API (Pulsar's note): ad_ids come
    // back in submission order. The ad names are unique per creative so a
    // later read of /ad/get/ can re-map by name if this does not hold.
    const adIds: Record<string, string> = {};
    submitted.forEach((s, i) => {
      if (ids[i]) adIds[s.creative.id] = String(ids[i]);
    });
    await beat({ ad_ids: adIds });
  }

  // --- done -----------------------------------------------------------------------------
  const finished = new Date().toISOString();
  await data.updatePromoLaunch(session, launch.id, { status: "done", error: null, finished_at: finished });
  await data.setPromoCampaignDelivery(session, campaign.id, {
    status: "submitted",
    status_note: null,
    grow_campaign_id: launch.tiktok_campaign_id,
    tiktok_adgroup_id: launch.tiktok_adgroup_id,
    advertiser_id: launch.advertiser_id,
    launched_at: finished,
  });
  return { status: "done" };
}

/** Fixture demo only: with no render, the source episode file stands in for the ad so the fake pipeline has bytes. */
function sourceOf(episodes: Array<{ id: string; video_path: string | null }>, creative: PromoCreative): string | null {
  return episodes.find((e) => e.id === creative.source_episode_id)?.video_path ?? null;
}

/** Fire-and-forget from a route; the scheduler adopts the row if the request dies. */
export function runLaunchInBackground(launchId: string): void {
  void runLaunch(launchId).catch((e) => console.error(`[launch] ${launchId} threw`, e));
}
