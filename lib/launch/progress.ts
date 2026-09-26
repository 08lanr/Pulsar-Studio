// A launch's progress, step by step (decision 2026-09-26 "Launch progress on
// the Monitor"). Ruobin: "in the launch process, you need to put some sort of
// progress bar, with error messages that appear if something goes wrong".
//
// Pure and client-safe: the Monitor draws it and the launch service reads
// `currentStepKey` to stamp when each step began. Nothing here is guessed —
// every step is done only when the driver's own checkpoint in
// `campaign.state` says so, in the order the driver actually runs:
//
//   TikTok (lib/tiktok/spark-driver.ts launch())
//     account   verifyAccount, then `settings` recorded
//     pixel     Website purchases only: `pixel.pixel_id`
//     videos    Studio clips: `identity`, then `uploads[clip].video_id` and
//               `.image_id` (the cover), then `posts` recorded
//     posts     no Studio clips: Spark codes redeemed / posts read back, `posts`
//     page      Instant Page only: `instant_page.phase === "published"`
//     campaign  `campaign_id`
//     adgroup   the primary entry in `groups`
//     ads       that group's `ready`
//     done      `launch_complete` (switched on when `activated`)
//
//   Meta (lib/meta/driver.ts launch(), everything under `state.meta`)
//     account   readAccount, then the first `meta` save
//     videos    finished clips: `video_ids`, processing, then the campaign
//               intent (`campaign_name_taken` / `intents.campaign`)
//     campaign  `campaign_id`
//     adsets    `adset_ids` per planned platform (legacy `adset_id`)
//     ads       `ad_ids`, one per planned ad
//     done      `launch_complete` (switched on when `activated`)
//
// A later step's evidence also marks every earlier step done, so an old row
// written before a checkpoint existed never shows a step that never ran.

import { launchShape } from "@/lib/tiktok/settings";
import { deriveAdSets } from "./plan";
import type { LaunchCampaign, LaunchDraft } from "./types";

export type ProgressStepKey = "account" | "pixel" | "videos" | "posts" | "page" | "campaign" | "adgroup" | "adsets" | "ads" | "done";
export type ProgressStepStatus = "done" | "current" | "todo" | "failed";
/** What the videos step is doing right now. */
export type VideoPhase = "uploading" | "covers" | "processing";
export type ProgressCount = { key: "uploaded" | "covers" | "adsets" | "ads"; done: number; of: number };
export type ProgressStep = {
  key: ProgressStepKey; status: ProgressStepStatus;
  /** Locale key of the step's name. */
  label: string;
  counts: ProgressCount[];
  phase?: VideoPhase;
  /** The finished launch: created paused, or switched on. */
  outcome?: "paused" | "live";
};
/** What the launch service stamps on `campaign.state.progress` when a step begins. */
export type ProgressMark = { step: ProgressStepKey; since: string };
export type LaunchProgress = {
  steps: ProgressStep[];
  /** The step being worked on, or the one that failed; null when queued or finished. */
  current: ProgressStepKey | null;
  done: number; total: number;
  failed: boolean;
  /** The provider's own sentence for a failure (campaign.error). */
  error: string | null;
  /** Not started yet: another campaign of the run is being prepared first. */
  queued: boolean;
  /** How long the current step has been running, when a time was recorded. */
  elapsed_ms: number | null;
  /** The live wait the driver asked for, if any, on the current step. */
  waiting: { reason: string } | null;
  stuck: StuckWait | null;
};
export type StuckWait = {
  step: ProgressStepKey; wait_ms: number; threshold_ms: number;
  /** Locale keys: what is being waited on, and how long it usually takes. */
  what: string; usual: string;
  reason: string | null;
};

const MIN = 60_000;
/**
 * When a step that has not moved reads as stuck, and how long it usually
 * takes. One map for every step (decision 2026-09-26): five minutes each;
 * TikTok's covers and uploads come in under a minute, Meta's transcoding in a
 * minute or two, the rest are single requests of a few seconds.
 */
export const STUCK_AFTER: Record<ProgressStepKey | VideoPhase, { ms: number; usual: string }> = {
  account: { ms: 5 * MIN, usual: "lpg.usual.seconds" },
  pixel: { ms: 5 * MIN, usual: "lpg.usual.seconds" },
  videos: { ms: 5 * MIN, usual: "lpg.usual.underMinute" },
  uploading: { ms: 5 * MIN, usual: "lpg.usual.underMinute" },
  covers: { ms: 5 * MIN, usual: "lpg.usual.underMinute" },
  processing: { ms: 5 * MIN, usual: "lpg.usual.fewMinutes" },
  posts: { ms: 5 * MIN, usual: "lpg.usual.seconds" },
  page: { ms: 5 * MIN, usual: "lpg.usual.seconds" },
  campaign: { ms: 5 * MIN, usual: "lpg.usual.seconds" },
  adgroup: { ms: 5 * MIN, usual: "lpg.usual.seconds" },
  adsets: { ms: 5 * MIN, usual: "lpg.usual.seconds" },
  ads: { ms: 5 * MIN, usual: "lpg.usual.seconds" },
  done: { ms: 5 * MIN, usual: "lpg.usual.seconds" },
};

type Draft = Pick<LaunchDraft, "provider" | "tiktok_settings" | "meta_settings">;
type Campaign = Pick<LaunchCampaign, "status" | "state" | "error" | "content" | "budget_cents" | "daily_budget_cents">;
type Evidence = { key: ProgressStepKey; label: string; done: boolean; counts?: ProgressCount[]; phase?: VideoPhase; outcome?: "paused" | "live" };
type Row = Record<string, unknown>;

const obj = (v: unknown): Row | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown) => typeof v === "string" && v ? v : "";
const time = (v: unknown): number | null => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const count = (key: ProgressCount["key"], done: number, of: number): ProgressCount => ({ key, done: Math.min(done, of), of });

function tiktokEvidence(draft: Draft, c: Campaign): Evidence[] {
  const s = c.state;
  const settings = obj(s.settings) ?? (draft.tiktok_settings as unknown as Row | undefined);
  let shape = "traffic";
  try { if (settings) shape = launchShape(settings as Parameters<typeof launchShape>[0]); } catch { /* an unreadable shape is a plain traffic launch */ }
  const clips = c.content.filter(item => item.kind === "video");
  const uploads = obj(s.uploads) ?? {};
  const upload = (value: string) => obj(uploads[value]);
  const uploaded = clips.filter(item => text(upload(item.value)?.video_id)).length;
  const covered = clips.filter(item => text(upload(item.value)?.image_id)).length;
  const posts = list(s.posts).length;
  const groups = list(s.groups).map(obj).filter((g): g is Row => !!g && !g.retired);
  const primary = groups.find(g => g.key === "primary") ?? groups[0];
  const pageStep = obj(s.instant_page);
  const steps: Evidence[] = [{ key: "account", label: "lpg.step.account", done: !!obj(s.settings) }];
  if (shape === "website_purchases") steps.push({ key: "pixel", label: "lpg.step.pixel", done: !!text(obj(s.pixel)?.pixel_id) });
  steps.push(clips.length
    ? { key: "videos", label: "lpg.step.videos", done: posts > 0,
        counts: [count("uploaded", uploaded, clips.length), count("covers", covered, clips.length)],
        phase: uploaded < clips.length ? "uploading" : covered < clips.length ? "covers" : undefined }
    : { key: "posts", label: "lpg.step.posts", done: posts > 0 });
  if (shape === "instant_page") steps.push({ key: "page", label: "lpg.step.page", done: pageStep?.phase === "published" });
  steps.push({ key: "campaign", label: "lpg.step.campaign", done: !!text(s.campaign_id) });
  steps.push({ key: "adgroup", label: "lpg.step.adgroup", done: !!primary });
  steps.push({ key: "ads", label: "lpg.step.ads", done: primary?.ready === true,
    counts: posts ? [count("ads", Object.keys(obj(primary?.ads) ?? {}).length, posts)] : [] });
  steps.push({ key: "done", label: "lpg.step.done", done: s.launch_complete === true || c.status === "done", outcome: s.activated === true ? "live" : "paused" });
  return steps;
}

function metaEvidence(draft: Draft, c: Campaign): Evidence[] {
  const m = obj(c.state.meta);
  const clips = c.content.filter(item => item.kind === "video");
  const legacy = !!text(m?.adset_id) && !obj(m?.adset_ids);
  let sets: { content: unknown[] }[] = [];
  try { sets = legacy ? [{ content: c.content }] : deriveAdSets(c.content, draft.meta_settings?.placements ?? [], c.budget_cents, c.daily_budget_cents); } catch { sets = []; }
  const setsMade = legacy ? 1 : Object.values(obj(m?.adset_ids) ?? {}).filter(v => !!text(v)).length;
  const adsPlanned = sets.reduce((sum, set) => sum + set.content.length, 0);
  const adsMade = Object.keys(obj(m?.ad_ids) ?? {}).length;
  const uploaded = Object.values(obj(m?.video_ids) ?? {}).filter(v => !!text(v)).length;
  const campaignStarted = !!text(m?.campaign_id) || Array.isArray(m?.campaign_name_taken) || !!obj(obj(m?.intents)?.campaign);
  const steps: Evidence[] = [{ key: "account", label: clips.length ? "lpg.step.account" : "lpg.step.accountPosts", done: !!m }];
  if (clips.length) steps.push({ key: "videos", label: "lpg.step.videos", done: campaignStarted,
    counts: [count("uploaded", uploaded, clips.length)], phase: uploaded < clips.length ? "uploading" : "processing" });
  steps.push({ key: "campaign", label: "lpg.step.campaign", done: !!text(m?.campaign_id) });
  steps.push({ key: "adsets", label: "lpg.step.adsets", done: sets.length > 0 && setsMade >= sets.length,
    counts: sets.length > 1 ? [count("adsets", setsMade, sets.length)] : [] });
  steps.push({ key: "ads", label: "lpg.step.ads", done: adsPlanned > 0 && adsMade >= adsPlanned,
    counts: adsPlanned ? [count("ads", adsMade, adsPlanned)] : [] });
  steps.push({ key: "done", label: "lpg.step.done", done: c.state.launch_complete === true || c.status === "done", outcome: m?.activated === true ? "live" : "paused" });
  return steps;
}

/** Each step's own evidence, with a later step's evidence carried back to every earlier one. */
function evidence(draft: Draft, c: Campaign): Evidence[] {
  const steps = draft.provider === "meta" ? metaEvidence(draft, c) : tiktokEvidence(draft, c);
  for (let i = steps.length - 2; i >= 0; i--) if (steps[i + 1].done) steps[i].done = true;
  return steps;
}

/** The step the driver is on (the first one not yet done), or null once the launch is complete. */
export function currentStepKey(draft: Draft, campaign: Campaign): ProgressStepKey | null {
  return evidence(draft, campaign).find(step => !step.done)?.key ?? null;
}

/** A campaign still being prepared, or one that failed before its launch finished (and was not ended). */
export function showsProgress(campaign: Pick<LaunchCampaign, "status" | "state">): boolean {
  const s = campaign.state;
  if (s.stop_applied === "ended" || s.desired_status === "ended") return false;
  if (campaign.status === "pending" || campaign.status === "running") return true;
  return campaign.status === "failed" && s.launch_complete !== true;
}

export function launchProgress(draft: Draft, campaign: Campaign, now = Date.now()): LaunchProgress {
  const found = evidence(draft, campaign);
  const failed = campaign.status === "failed";
  const s = campaign.state;
  const firstOpen = found.findIndex(step => !step.done);
  const mark = obj(s.progress);
  const wait = campaign.status === "pending" ? obj(s.waiting) : undefined;
  // Nothing done, nothing waited on, never started: the run is preparing
  // another campaign first.
  const queued = campaign.status === "pending" && !wait && !mark && firstOpen === 0;
  const steps: ProgressStep[] = found.map((step, i) => ({
    key: step.key, label: step.label, counts: step.counts ?? [],
    ...(step.phase ? { phase: step.phase } : {}), ...(step.key === "done" && step.done ? { outcome: step.outcome } : {}),
    status: step.done ? "done" : i === firstOpen && !queued ? (failed ? "failed" : "current") : "todo",
  }));
  const open = firstOpen >= 0 && !queued ? found[firstOpen] : null;
  const result: LaunchProgress = {
    steps, current: open?.key ?? null, done: found.filter(step => step.done).length, total: found.length,
    failed, error: failed ? campaign.error : null, queued, elapsed_ms: null, waiting: null, stuck: null,
  };
  if (!open || failed) return result;
  // When this step began: the service's stamp, else the driver's wait (its
  // first time, not the last retry), else the first empty cover answer.
  const stepSince = mark?.step === open.key ? time(mark.since) : null;
  const waitHere = wait && (!text(wait.step) || wait.step === open.key) ? wait : undefined;
  const waitSince = waitHere ? time(waitHere.first_since) ?? time(waitHere.since) : null;
  let coverSince: number | null = null;
  if (open.key === "videos" && open.phase === "covers" && draft.provider !== "meta") {
    const uploads = obj(s.uploads) ?? {};
    for (const item of campaign.content.filter(x => x.kind === "video")) {
      const u = obj(uploads[item.value]);
      const at = u && !text(u.image_id) ? time(u.cover_wait_since) : null;
      if (at !== null && (coverSince === null || at < coverSince)) coverSince = at;
    }
  }
  const began = stepSince ?? waitSince ?? coverSince;
  result.elapsed_ms = began === null ? null : Math.max(0, now - began);
  if (waitHere) result.waiting = { reason: text(waitHere.reason) };
  // The wait itself, as precisely as it was recorded.
  const waitingSince = coverSince ?? waitSince ?? stepSince;
  const limit = STUCK_AFTER[open.phase ?? open.key];
  if (waitingSince !== null && now - waitingSince > limit.ms) {
    result.stuck = {
      step: open.key, wait_ms: now - waitingSince, threshold_ms: limit.ms,
      what: open.phase ? `lpg.what.${open.phase}` : `lpg.what.${open.key}`, usual: limit.usual,
      reason: waitHere ? text(waitHere.reason) || null : null,
    };
  }
  return result;
}
