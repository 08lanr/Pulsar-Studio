// The background run behind "clips cut themselves after an upload"
// (decision 2026-09-14). Fire-and-forget from the upload routes through
// `scheduleClipCut`; the Materials page polls the derived state
// (lib/clips/state.ts) while it runs. Idempotent and resumable in the
// sense that matters: one `cut_clips` job per episode + video + rule
// version, a second run while one is alive is refused, every row ends in a
// terminal render status, and rendered files are never deleted (a campaign
// creative may point at one).
//
// Cost: the footage path spends nothing (cost_cents 0). The script path's
// model spend is on its own find_clips job; this job records the run.
// The cuts are clean: nothing is burned into the picture (founders,
// 2026-09-14); the hook is ad copy beside the clip.

import { systemSession } from "@/lib/auth";
import { getData, isDataError } from "@/lib/data";
import { ffmpegAvailable } from "@/lib/promote/render";
import { CLIP_PROMPT_VERSION } from "@/lib/prompts";
import type { Clip, Json } from "@/lib/types";
import { cutClip, probeSourceSize, withSourceFile } from "./cut";
import { selectClips, type CutSource } from "./select";
import { probeDurationMs } from "./signals";
import { jobIsRunning } from "./state";

/** How many clips per episode are rendered (the strongest by rank). */
export const RENDER_LIMIT = 6;

export type CutRunResult = {
  outcome: "done" | "skipped" | "refused" | "failed";
  source: CutSource | null;
  selected: number;
  rendered: number;
  failed: string[];
  job_id: string | null;
};

const log = (m: string) => console.log(`[clips] ${m}`);

/** Fire-and-forget: the upload routes call this after the episode is saved. `PROMO_RENDER=off` (tests) disables it. */
export function scheduleClipCut(titleId: string, episodeNumber: number, opts: { force?: boolean } = {}): void {
  if (process.env.PROMO_RENDER === "off") return;
  void cutEpisodeClips(titleId, episodeNumber, opts).catch((e) => console.error(`[clips] ${titleId}/${episodeNumber} threw`, e));
}

export async function cutEpisodeClips(titleId: string, episodeNumber: number, opts: { force?: boolean } = {}): Promise<CutRunResult> {
  const data = getData();
  const session = systemSession();
  const wb = await data.getWorkbench(session, titleId, episodeNumber);
  const episode = wb.episode;
  if (!episode.video_path) return { outcome: "refused", source: null, selected: 0, rendered: 0, failed: ["this episode has no video"], job_id: null };
  // An imported episode (auto_cut false, decision 2026-09-22) gets no upload-time run and no job row; a person's
  // explicit "Cut clips again" (force) still cuts it (Ruobin, 2026-09-23: clips for the imported titles' first ads).
  if (episode.auto_cut === false && !opts.force) {
    log(`${wb.title.id}/${episode.number}: skipped, the episode is not cut automatically`);
    return { outcome: "skipped", source: null, selected: 0, rendered: 0, failed: [], job_id: null };
  }

  // One run per episode at a time; a run whose heartbeat went quiet is treated as dead and superseded.
  const latest = await data.latestEpisodeJob(session, titleId, episodeNumber, "cut_clips");
  if (jobIsRunning(latest)) return { outcome: "refused", source: null, selected: 0, rendered: 0, failed: ["a cutting run is already going"], job_id: latest!.id };

  const suffix = opts.force ? `:r${Date.now().toString(36)}` : "";
  const job = await data.recordJob(session, {
    kind: "cut_clips",
    title_id: wb.title.id,
    episode_id: episode.id,
    target_type: "episode",
    target_id: episode.id,
    idempotency_key: `cut_clips:${episode.id}:${episode.video_path}:${CLIP_PROMPT_VERSION}${suffix}`,
    provider: null,
    model: null,
    input: { video_path: episode.video_path, clip_prompt_version: CLIP_PROMPT_VERSION, force: !!opts.force },
  });
  if (job.status === "done") return { outcome: "skipped", source: null, selected: 0, rendered: 0, failed: [], job_id: job.id };

  const fail = async (error: string): Promise<CutRunResult> => {
    await data.finishJob(session, job.id, { status: "failed", error, cost_cents: 0 });
    return { outcome: "failed", source: null, selected: 0, rendered: 0, failed: [error], job_id: job.id };
  };

  if (!(await ffmpegAvailable())) return fail("ffmpeg is not installed on this machine");

  try {
    return await withSourceFile(episode.video_path, async (srcAbs, workDir) => {
      const [probedDuration, sourceSize] = await Promise.all([probeDurationMs(srcAbs), probeSourceSize(srcAbs)]);
      const durationMs = probedDuration ?? episode.duration_ms ?? null;
      const selection = await selectClips(session, wb, srcAbs, durationMs, { force: opts.force });
      const toRender = selection.clips
        .filter((c) => c.status !== "dismissed")
        .sort((a, b) => a.rank - b.rank)
        .filter((c) => opts.force || c.render_status !== "rendered")
        .slice(0, RENDER_LIMIT);
      const failed: string[] = [];
      let rendered = 0;
      for (const clip of toRender) {
        try {
          const r = await cutClip({ srcAbs, workDir, startMs: clip.start_ms, endMs: clip.end_ms, sourceSize, storedPath: `${wb.title.id}/${episode.id}/clip-${clip.external_id}-${job.id.slice(0, 8)}.mp4` });
          await data.setClipRender(session, clip.id, { render_status: "rendered", render_path: r.render_path, render_sha256: r.render_sha256, duration_ms: r.duration_ms, width: r.width, height: r.height, render_note: null });
          rendered += 1;
        } catch (e) {
          const note = (e as Error).message;
          failed.push(`${clip.external_id}: ${note}`);
          await data.setClipRender(session, clip.id, { render_status: "failed", render_note: note }).catch(() => undefined);
        }
        await data.heartbeatJob(session, job.id).catch(() => undefined);
      }
      // Rows this run selected but did not render (over the limit) must not sit "pending" forever.
      for (const clip of selection.clips) {
        if (clip.render_status === "pending" && !toRender.some((t) => t.id === clip.id)) {
          await data.setClipRender(session, clip.id, { render_status: "failed", render_note: `only the ${RENDER_LIMIT} strongest clips are rendered` }).catch(() => undefined);
        }
      }
      const output: Json = { source: selection.source, selected: selection.clips.length, rendered, failed, duration_ms: durationMs, source_size: sourceSize ? `${sourceSize.width}x${sourceSize.height}` : null };
      await data.finishJob(session, job.id, { status: rendered > 0 || !toRender.length ? "done" : "failed", output, cost_cents: 0, error: rendered === 0 && failed.length ? failed[0] : null });
      log(`${wb.title.id}/${episode.number}: ${selection.source}, ${rendered}/${toRender.length} rendered${failed.length ? `, ${failed.length} failed` : ""}`);
      return { outcome: rendered > 0 || !toRender.length ? "done" : "failed", source: selection.source, selected: selection.clips.length, rendered, failed, job_id: job.id };
    });
  } catch (e) {
    const message = isDataError(e) || e instanceof Error ? (e as Error).message : String(e);
    console.error(`[clips] ${wb.title.id}/${episode.number}: ${message}`);
    return fail(message);
  }
}

export type { Clip };
