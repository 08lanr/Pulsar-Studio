// "Build a 60 s ad" (decision 2026-09-24): the pick (lib/clips/montage.ts)
// over the title's clips, its lines and its ad rules, then the render
// (lib/clips/montage-render.ts) in the background, then the finished file as
// a clips row of moment `montage` — so it shows in the Clips library as
// "Ad · 60 s" with Download, and Launch, the Meta posting and the zip
// download take it like any clip.
//
// One `build_montage` job per title at a time (target `title`), cost 0, a
// row per build; the file is named by the pick, so the same pick of the same
// clips is the same ad and pressing again answers the ad that already
// exists, while new clips make a new pick and a new ad (the one before stays
// in the library). Every step beats the job's heartbeat, a quiet one reads
// as a dead build (lib/clips/state.ts) and the next press starts over. The
// run writes as the system actor after the route checked the caller may
// edit the title, as the clip cutting does.

import { systemSession, type Session } from "@/lib/auth";
import { getData, isDataError } from "@/lib/data";
import { mediaUrl } from "@/lib/data/storage";
import { ffmpegAvailable } from "@/lib/promote/render";
import type { Clip, Job, Json, MontagePiece } from "@/lib/types";
import { montageEpisodesLabel, montageWhy, planMontage, type MontageEpisode, type MontageInput, type MontageOptions, type MontagePlan, type MontageRefusal } from "./montage";
import { MONTAGE_LUFS, renderMontage } from "./montage-render";
import { jobIsRunning } from "./state";

export const MONTAGE_JOB = "build_montage" as const;

/** A finished 60-second ad as the title's clips page lists it. */
export type MontageRow = Clip & { download_url: string | null; episodes_label: string };

export type MontageStatus = {
  state: "none" | "building" | "ready" | "failed";
  /** Why the newest build failed, in its own words. */
  note: string | null;
  /** While a build runs: when it started and the pieces it is joining. */
  building: { started_at: string | null; pieces: MontagePiece[]; duration_ms: number | null } | null;
  /** Newest first. */
  montages: MontageRow[];
};

export type MontageStart =
  | { outcome: "refused"; refusal: MontageRefusal }
  | { outcome: "running"; job_id: string }
  | { outcome: "failed"; job_id: string; error: string }
  | { outcome: "exists"; clip: MontageRow }
  | { outcome: "started"; job_id: string; plan: MontagePlan; done?: Promise<MontageBuild> };

export type MontageBuild = { ok: true; clip: Clip } | { ok: false; error: string };

/** What the pick reads: every episode (its lines where it has clips), the title's clips and its ad rules. */
export async function montageInputFor(session: Session, titleId: string): Promise<{ input: MontageInput; videoPaths: Map<string, string> }> {
  const data = getData();
  const detail = await data.getTitle(session, titleId);
  const clips = (await data.listEpisodeClips(session, titleId)).filter((c) => c.moment !== "montage" && c.status !== "dismissed");
  const withClips = new Set(clips.map((c) => c.episode_id));
  const episodes: MontageEpisode[] = [];
  const videoPaths = new Map<string, string>();
  for (const e of [...detail.episodes].sort((a, b) => a.number - b.number)) {
    const row: MontageEpisode = { id: e.id, number: e.number, has_video: e.has_video, duration_ms: e.duration_ms, film_start_ms: null, cues: [] };
    if (e.has_video && withClips.has(e.id)) {
      const wb = await data.getWorkbench(session, titleId, e.number);
      if (wb.episode.video_path) videoPaths.set(e.id, wb.episode.video_path);
      row.has_video = !!wb.episode.video_path;
      row.duration_ms = wb.episode.duration_ms ?? e.duration_ms;
      row.film_start_ms = wb.episode.film_start_ms ?? null;
      row.cues = wb.lines
        .filter((l) => !l.merged_into_id && l.start_ms !== null && l.end_ms !== null && l.end_ms > l.start_ms)
        .map((l) => ({ start_ms: l.start_ms!, end_ms: l.end_ms! }))
        .sort((a, b) => a.start_ms - b.start_ms);
    }
    episodes.push(row);
  }
  return { input: { episodes, clips, rules: detail.title.ad_rules ?? null }, videoPaths };
}

/** Where a build's file is stored: named by the pick, so a second press of the same pick finds the ad it made. */
export const montageFile = (titleId: string, key: string, jobId: string) => `${titleId}/montage/ad60-${key}-${jobId.slice(0, 8)}.mp4`;

const rowOf = (c: Clip): MontageRow => ({ ...c, download_url: c.render_status === "rendered" ? mediaUrl(c.render_path) : null, episodes_label: montageEpisodesLabel(c.pieces) });

/**
 * Pick and start a build. The caller's right to edit the title is checked
 * here too (a foreign title is not found, a viewer forbidden). `wait` hands
 * back the build's promise (tests); the routes let it run.
 */
export async function startMontage(session: Session, titleId: string, opts: { options?: Partial<MontageOptions>; wait?: boolean } = {}): Promise<MontageStart> {
  const data = getData();
  await data.assertTitleEditable(session, titleId);
  const system = systemSession();
  const latest = await data.latestJobByTarget(system, "title", titleId, MONTAGE_JOB);
  if (jobIsRunning(latest)) return { outcome: "running", job_id: latest!.id };

  const { input, videoPaths } = await montageInputFor(system, titleId);
  const pick = planMontage(input, opts.options);
  if (!pick.ok) {
    const { ok: _ok, ...refusal } = pick;
    return { outcome: "refused", refusal };
  }
  const { ok: _ok, ...plan } = pick;
  // The same pick built before and still listed is that ad (its file is named by the pick, montageFile).
  const built = (await data.listEpisodeClips(system, titleId)).find((c) => c.moment === "montage" && c.status !== "dismissed" && c.render_status === "rendered" && c.render_path?.includes(`/ad60-${plan.key}-`));
  if (built) return { outcome: "exists", clip: rowOf(built) };
  // A new row per build, so the newest job by target is always this one.
  const job = await data.recordJob(system, {
    kind: MONTAGE_JOB, title_id: titleId, target_type: "title", target_id: titleId, provider: null, model: null,
    idempotency_key: `build_montage:${titleId}:${plan.key}:${Date.now().toString(36)}`,
    input: { plan_key: plan.key, pieces: plan.pieces, duration_ms: plan.duration_ms, episodes: plan.episodes, source: plan.source } as unknown as Json,
  });
  if (!(await ffmpegAvailable())) {
    const error = process.env.PROMO_RENDER === "off" ? "rendering is switched off on this server" : "ffmpeg is not installed on this machine";
    await data.finishJob(system, job.id, { status: "failed", error, cost_cents: 0 });
    return { outcome: "failed", job_id: job.id, error };
  }
  const done = runMontageBuild(titleId, job, plan, videoPaths);
  if (!opts.wait) void done.catch((e) => console.error(`[montage] ${titleId} threw`, e));
  return { outcome: "started", job_id: job.id, plan, ...(opts.wait ? { done } : {}) };
}

async function runMontageBuild(titleId: string, job: Job, plan: MontagePlan, videoPaths: Map<string, string>): Promise<MontageBuild> {
  const data = getData();
  const system = systemSession();
  try {
    const rendered = await renderMontage({
      pieces: plan.pieces,
      videoPaths,
      storedPath: montageFile(titleId, plan.key, job.id),
      onStep: () => data.heartbeatJob(system, job.id).catch(() => undefined),
    });
    const why = montageWhy(plan);
    const off = rendered.lufs !== null && Math.abs(rendered.lufs - MONTAGE_LUFS) > 2;
    const clip = await data.addMontageClip(system, {
      title_id: titleId,
      pieces: rendered.pieces,
      hook_en: plan.hook_en,
      why_en: why.en,
      why_zh: why.zh,
      source: plan.source,
      job_id: job.id,
      render_path: rendered.render_path,
      render_sha256: rendered.render_sha256,
      duration_ms: rendered.duration_ms,
      width: rendered.width,
      height: rendered.height,
      render_note: off ? `The sound came out at ${rendered.lufs} LUFS; the target is ${MONTAGE_LUFS}.` : null,
    });
    const output = { clip_id: clip.id, frames: rendered.frames, fps: rendered.fps, duration_ms: rendered.duration_ms, lufs: rendered.lufs, bytes: rendered.bytes } as Json;
    await data.finishJob(system, job.id, { status: "done", output, cost_cents: 0 });
    console.log(`[montage] ${titleId}: ${rendered.pieces.length} pieces, ${rendered.frames} frames at ${rendered.fps} fps, ${rendered.lufs ?? "?"} LUFS`);
    return { ok: true, clip };
  } catch (e) {
    const error = isDataError(e) || e instanceof Error ? (e as Error).message : String(e);
    console.error(`[montage] ${titleId}: ${error}`);
    await data.finishJob(system, job.id, { status: "failed", error, cost_cents: 0 }).catch(() => undefined);
    return { ok: false, error };
  }
}

/** The title's 60-second ads and its newest build, for whoever may read the title (never the job's cost). */
export async function montageStatus(session: Session, titleId: string): Promise<MontageStatus> {
  const data = getData();
  const clips = await data.listEpisodeClips(session, titleId); // scoping: a foreign title is not found
  const montages = clips
    .filter((c) => c.moment === "montage" && c.status !== "dismissed" && c.render_status === "rendered")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(rowOf);
  const job = await data.latestJobByTarget(systemSession(), "title", titleId, MONTAGE_JOB);
  if (jobIsRunning(job)) {
    const input = (job!.input ?? {}) as { pieces?: MontagePiece[]; duration_ms?: number };
    return { state: "building", note: null, building: { started_at: job!.started_at, pieces: input.pieces ?? [], duration_ms: input.duration_ms ?? null }, montages };
  }
  const newest = montages[0]?.created_at ?? "";
  if (job?.status === "failed" && (job.finished_at ?? job.created_at) > newest) return { state: "failed", note: job.error, building: null, montages };
  if (job?.status === "running") return { state: "failed", note: "the build stopped before it finished", building: null, montages };
  return { state: montages.length ? "ready" : "none", note: null, building: null, montages };
}
