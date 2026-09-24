// Which moments of an episode become ad clips (decision 2026-09-14).
// Script first: a timed episode with lines is ranked by the find_clips
// model (lib/jobs.ts runFindClips), which knows the story and writes the
// hook. Footage second: without timecodes, lines, a provider key, or when
// demo replay refuses model calls, the moments come from scene cuts and
// loudness (lib/clips/footage.ts) and the rows say so — no hook, no plot
// claim, a fixed "why" sentence. Both paths write the rows through the data
// layer and return them.

import type { Session } from "@/lib/auth";
import { getData, type NewClip } from "@/lib/data";
import { runFindClips } from "@/lib/jobs";
import { LlmUnavailableError } from "@/lib/llm";
import type { Clip, ClipSource, WorkbenchPayload } from "@/lib/types";
import { scoreWindows } from "./footage";
import { loudness, sceneCuts } from "./signals";

export const FOOTAGE_WHY_EN = "Chosen from footage signals (scene cuts and loudness); no script was available for this episode.";
export const FOOTAGE_WHY_ZH = "根据画面切换和音量选出，这一集没有台词可参考。";

/** The cutter chooses from the script or the footage; an uploaded clip never reaches it. */
export type CutSource = Exclude<ClipSource, "upload">;
export type Selection = { source: CutSource; clips: Clip[]; skipped: boolean };

export async function selectClips(session: Session, wb: WorkbenchPayload, srcAbs: string, durationMs: number | null, opts: { force?: boolean } = {}): Promise<Selection> {
  const timedLines = wb.lines.filter((l) => !l.merged_into_id && l.start_ms !== null && l.end_ms !== null).length;
  if (wb.episode.has_timecodes && timedLines > 0) {
    try {
      const r = await runFindClips(session, wb.title.id, wb.episode.number, { force: opts.force, durationMs });
      return { source: "script", clips: r.clips, skipped: r.skipped };
    } catch (e) {
      // No model available (no key, or demo replay): the footage path still gives the producer clips.
      if (!(e instanceof LlmUnavailableError)) throw e;
    }
  }
  if (durationMs === null) throw new Error("could not read the video's duration");
  const [cuts, loud] = await Promise.all([sceneCuts(srcAbs), loudness(srcAbs)]);
  const windows = scoreWindows(cuts, loud, durationMs);
  const rows: NewClip[] = windows.map((w, i) => ({
    rank: i + 1,
    start_ms: w.start_ms,
    end_ms: w.end_ms,
    scene_ids: [],
    hook_en: "",
    why_en: FOOTAGE_WHY_EN,
    why_zh: FOOTAGE_WHY_ZH,
    opening_text_en: null,
    cut_length_s: Math.round((w.end_ms - w.start_ms) / 1000),
    angle: null,
    model: null,
    prompt_version: null,
    job_id: null,
    source: "footage",
    // The first window of episode 1 is the closest thing to an opening the footage can offer.
    moment: wb.episode.number === 1 && w.start_ms === 0 ? "opening" : "peak",
  }));
  const clips = await getData().upsertClips(session, wb.episode.id, rows);
  return { source: "footage", clips, skipped: false };
}
