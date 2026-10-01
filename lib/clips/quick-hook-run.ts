// "Quick hook ads" on a title's clips page (decision 2026-10-01): the pick
// (lib/clips/quick-hook.ts) over the title's clips, its lines and its ad
// rules, with the texts a person wrote, then every variant rendered in the
// background (lib/clips/montage-render.ts, its text drawn), each finished
// file a clips row of moment `montage` labelled `quick_hook` as soon as it
// lands — so the Clips library, Launch, the Ads tab and the zip download take
// it like any clip, and the file name carries its code (H2-B1-X3).
//
// One `build_quick_hooks` job per title at a time (target `title`), cost 0;
// a variant whose pieces and text were built before is skipped (its file is
// named by them), so pressing again with the same clips and texts makes
// nothing new, and new texts make new variants beside the old ones. A variant
// the checks refuse is noted and the build goes on; the build fails only when
// no variant was made. The build beats the job's heartbeat every 30 seconds
// (lib/clips/state.ts reads a quiet one as dead). The run writes as the
// system actor after the route checked the caller may edit the title, as the
// 60-second ad does (lib/clips/montage-run.ts, whose lock it shares).

import { systemSession, type Session } from "@/lib/auth";
import { QUICK_HOOK_MIGRATION_MESSAGE } from "@/lib/ad-formats";
import { DataError, getData, isDataError } from "@/lib/data";
import { mediaUrl } from "@/lib/data/storage";
import { ffmpegAvailable } from "@/lib/promote/render";
import type { Clip, Job, Json } from "@/lib/types";
import { montageEpisodesLabel } from "./montage";
import { MontageCheckError, renderMontage } from "./montage-render";
import { montageInputFor, oneStartPerTitle } from "./montage-run";
import { QUICK_HOOK_DEFAULTS, isQuickHook, planQuickHooks, quickHookCode, quickHookFile, quickHookWhy, suggestOverlayTexts, wrapOverlay, type QuickHookOptions, type QuickHookRefusal, type QuickHookVariant } from "./quick-hook";
import { jobIsRunning } from "./state";

export const QUICK_HOOK_JOB = "build_quick_hooks" as const;
/** What the page says when no variant could be joined for a reason the checks do not name (the detail is in the log). */
export const QUICK_HOOK_RENDER_FAILED = "The quick hook ads could not be made from the clips. Press Build again; if it fails twice, tell Pulsar staff.";
export const QUICK_HOOK_STOPPED = "The build stopped before it finished. Press Build again.";
const HEARTBEAT_MS = 30_000;

/** A finished quick hook ad as the title's clips page lists it. */
export type QuickHookRow = Clip & { download_url: string | null; code: string | null; episodes_label: string };

export type QuickHookStatus = {
  state: "none" | "building" | "ready" | "failed";
  note: string | null;
  note_code: "render_failed" | "stopped" | null;
  /** While a build runs: when it started, how many variants it makes and how many have landed. */
  building: { started_at: string | null; total: number; done: number; codes: string[] } | null;
  /** Lines the page offers as the text on screen (the clips' own opening text and hooks). */
  suggestions: string[];
  /** Newest first. */
  ads: QuickHookRow[];
};

export type QuickHookStart =
  | { outcome: "refused"; refusal: QuickHookRefusal }
  | { outcome: "running"; job_id: string }
  | { outcome: "failed"; job_id: string; error: string }
  | { outcome: "exists"; count: number }
  | { outcome: "started"; job_id: string; variants: QuickHookVariant[]; done?: Promise<QuickHookBuild> };

export type QuickHookBuild = { ok: true; clips: Clip[]; refused: string[] } | { ok: false; error: string };

const rowOf = (c: Clip): QuickHookRow => ({ ...c, download_url: c.render_status === "rendered" ? mediaUrl(c.render_path) : null, code: quickHookCode(c.render_path), episodes_label: montageEpisodesLabel(c.pieces) });

/**
 * The title's newest build. A database without 0024 does not know the job kind and refuses the lookup itself: that
 * reads as "no build yet", so the clips page still opens; pressing Build then says which migration to apply.
 */
async function latestBuild(titleId: string): Promise<Job | null> {
  try {
    return await getData().latestJobByTarget(systemSession(), "title", titleId, QUICK_HOOK_JOB);
  } catch (e) {
    if (/build_quick_hooks|job_kind/.test((e as Error)?.message ?? "")) return null;
    throw e;
  }
}

const builtKeys = (clips: readonly Clip[]) => new Set(clips.filter((c) => isQuickHook(c) && c.status !== "dismissed" && c.render_status === "rendered").map((c) => c.render_path?.match(/-([0-9a-f]{16})\.mp4$/)?.[1]).filter(Boolean));

/**
 * Pick and start a build with the texts a person wrote. The caller's right to
 * edit the title is checked here too (a foreign title is not found, a viewer
 * forbidden). `wait` hands back the build's promise (tests).
 */
export async function startQuickHooks(session: Session, titleId: string, texts: readonly string[], opts: { options?: Partial<QuickHookOptions>; wait?: boolean } = {}): Promise<QuickHookStart> {
  await getData().assertTitleEditable(session, titleId);
  return oneStartPerTitle(titleId, () => pickAndStart(titleId, texts, opts), "quick_hooks");
}

async function pickAndStart(titleId: string, texts: readonly string[], opts: { options?: Partial<QuickHookOptions>; wait?: boolean }): Promise<QuickHookStart> {
  const data = getData();
  const system = systemSession();
  const latest = await latestBuild(titleId);
  if (jobIsRunning(latest)) return { outcome: "running", job_id: latest!.id };

  const { input, videoPaths } = await montageInputFor(system, titleId);
  const pick = planQuickHooks(input, texts, opts.options);
  if (!pick.ok) {
    const { ok: _ok, ...refusal } = pick;
    return { outcome: "refused", refusal };
  }
  const built = builtKeys(await data.listEpisodeClips(system, titleId));
  const variants = pick.variants.filter((v) => !built.has(v.key));
  if (!variants.length) return { outcome: "exists", count: pick.variants.length };
  let job: Job;
  try {
    job = await data.recordJob(system, {
      kind: QUICK_HOOK_JOB, title_id: titleId, target_type: "title", target_id: titleId, provider: null, model: null,
      idempotency_key: `build_quick_hooks:${titleId}:${variants.map((v) => v.key).join(",").slice(0, 200)}:${Date.now().toString(36)}`,
      input: { codes: variants.map((v) => v.code), keys: variants.map((v) => v.key), texts: pick.variants.map((v) => v.overlay).filter((t, i, all) => all.indexOf(t) === i) } as unknown as Json,
    });
  } catch (e) {
    // A database without 0024 does not know the job kind.
    if (/build_quick_hooks/.test((e as Error).message ?? "")) throw new DataError("conflict", QUICK_HOOK_MIGRATION_MESSAGE);
    throw e;
  }
  const newest = await latestBuild(titleId);
  if (newest && newest.id !== job.id && jobIsRunning(newest)) {
    await data.finishJob(system, job.id, { status: "cancelled", error: "another build of this title started at the same moment", cost_cents: 0 });
    return { outcome: "running", job_id: newest.id };
  }
  if (!(await ffmpegAvailable())) {
    const error = process.env.PROMO_RENDER === "off" ? "rendering is switched off on this server" : "ffmpeg is not installed on this machine";
    await data.finishJob(system, job.id, { status: "failed", error, cost_cents: 0 });
    return { outcome: "failed", job_id: job.id, error };
  }
  const done = runQuickHookBuild(titleId, job, variants, videoPaths);
  if (!opts.wait) void done.catch((e) => console.error(`[quick-hooks] ${titleId} threw`, e));
  return { outcome: "started", job_id: job.id, variants, ...(opts.wait ? { done } : {}) };
}

async function runQuickHookBuild(titleId: string, job: Job, variants: readonly QuickHookVariant[], videoPaths: Map<string, string>): Promise<QuickHookBuild> {
  const data = getData();
  const system = systemSession();
  const beat = () => void data.heartbeatJob(system, job.id).catch(() => undefined);
  const pulse = setInterval(beat, HEARTBEAT_MS);
  const made: Clip[] = [];
  const refused: string[] = [];
  const details: string[] = [];
  try {
    for (const v of variants) {
      beat();
      try {
        const rendered = await renderMontage({
          pieces: v.pieces,
          videoPaths,
          storedPath: quickHookFile(titleId, v.code, v.key),
          maxMs: Math.max(QUICK_HOOK_DEFAULTS.maxMs, v.duration_ms),
          onStep: beat,
          overlay: { lines: wrapOverlay(v.overlay) ?? [v.overlay], untilMs: v.overlay_ms },
        });
        const why = quickHookWhy(v);
        made.push(await data.addMontageClip(system, {
          title_id: titleId,
          pieces: rendered.pieces,
          hook_en: v.ad_text,
          why_en: why.en,
          why_zh: why.zh,
          source: v.source,
          job_id: job.id,
          render_path: rendered.render_path,
          render_sha256: rendered.render_sha256,
          duration_ms: rendered.duration_ms,
          width: rendered.width,
          height: rendered.height,
          ad_format: "quick_hook",
          opening_text_en: v.overlay,
        }));
      } catch (e) {
        const detail = isDataError(e) || e instanceof Error ? (e as Error).message : String(e);
        console.error(`[quick-hooks] ${titleId} ${v.code}: ${detail}`);
        // A database that refuses the row will refuse every one: stop and say why.
        if (isDataError(e)) throw e;
        details.push(`${v.code}: ${detail}`);
        refused.push(e instanceof MontageCheckError ? `${v.code}: ${detail}` : v.code);
      }
    }
    if (!made.length) {
      await data.finishJob(system, job.id, { status: "failed", error: QUICK_HOOK_RENDER_FAILED, output: { refused, details } as Json, cost_cents: 0 });
      return { ok: false, error: QUICK_HOOK_RENDER_FAILED };
    }
    await data.finishJob(system, job.id, { status: "done", output: { clip_ids: made.map((c) => c.id), refused, details } as Json, cost_cents: 0 });
    console.log(`[quick-hooks] ${titleId}: ${made.length} made, ${refused.length} refused`);
    return { ok: true, clips: made, refused };
  } catch (e) {
    const error = isDataError(e) ? (e as Error).message : QUICK_HOOK_RENDER_FAILED;
    await data.finishJob(system, job.id, { status: "failed", error, output: { refused, details, detail: String((e as Error)?.message ?? e) } as Json, cost_cents: 0 }).catch(() => undefined);
    return { ok: false, error };
  } finally {
    clearInterval(pulse);
  }
}

/** The title's quick hook ads, its newest build and the suggested texts, for whoever may read the title (never the job's cost). */
export async function quickHooksStatus(session: Session, titleId: string): Promise<QuickHookStatus> {
  const data = getData();
  const clips = await data.listEpisodeClips(session, titleId); // scoping: a foreign title is not found
  const ads = clips
    .filter((c) => isQuickHook(c) && c.status !== "dismissed" && c.render_status === "rendered")
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || (quickHookCode(a.render_path) ?? "").localeCompare(quickHookCode(b.render_path) ?? ""))
    .map(rowOf);
  const suggestions = suggestOverlayTexts(clips);
  const job = await latestBuild(titleId);
  if (jobIsRunning(job)) {
    const input = (job!.input ?? {}) as { codes?: string[] };
    return { state: "building", note: null, note_code: null, building: { started_at: job!.started_at, total: input.codes?.length ?? 0, done: ads.filter((a) => a.job_id === job!.id).length, codes: input.codes ?? [] }, suggestions, ads };
  }
  const newest = ads[0]?.created_at ?? "";
  if (job?.status === "failed" && (job.finished_at ?? job.created_at) > newest) return { state: "failed", note: job.error, note_code: job.error === QUICK_HOOK_RENDER_FAILED ? "render_failed" : null, building: null, suggestions, ads };
  if (job?.status === "running") return { state: "failed", note: QUICK_HOOK_STOPPED, note_code: "stopped", building: null, suggestions, ads };
  return { state: ads.length ? "ready" : "none", note: null, note_code: null, building: null, suggestions, ads };
}
