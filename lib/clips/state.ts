// The one derived answer the Materials page asks per episode: are its ad
// clips none / cutting / ready / failed? Read from the rows and the latest
// cut_clips job, never stored, so a crashed run cannot leave a stale flag.

import type { Clip, Job } from "@/lib/types";

export type ClipRunState = "none" | "cutting" | "ready" | "failed";

/** A `running` job whose heartbeat is older than this is treated as dead (the process went away). */
export const STALE_RUN_MS = 10 * 60 * 1000;

export function jobIsRunning(job: Job | null | undefined, nowMs = Date.now()): boolean {
  if (!job || job.status !== "running") return false;
  const beat = Date.parse(job.heartbeat_at ?? job.started_at ?? job.created_at);
  return Number.isFinite(beat) && nowMs - beat < STALE_RUN_MS;
}

export function clipRunState(clips: Clip[], latestJob: Job | null | undefined, nowMs = Date.now()): { state: ClipRunState; note: string | null } {
  const running = jobIsRunning(latestJob, nowMs);
  if (running) return { state: "cutting", note: null };
  const rendered = clips.filter((c) => c.render_status === "rendered");
  if (rendered.length) return { state: "ready", note: null };
  if (latestJob?.status === "failed") return { state: "failed", note: latestJob.error };
  if (clips.length && clips.every((c) => c.render_status === "failed")) return { state: "failed", note: clips[0].render_note };
  if (clips.some((c) => c.render_status === "pending")) return latestJob && latestJob.status === "running" ? { state: "failed", note: "the cutting run stopped before it finished" } : { state: "cutting", note: null };
  return { state: "none", note: null };
}
