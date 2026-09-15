// Generate a campaign's ads (decision 2026-09-14): every finished auto-cut
// clip of the title becomes a ready creative with its file already
// rendered, so review opens at once. When the title has no finished clip,
// generation does not invent placeholders: it starts cutting every episode
// that has a video (once; a run already going is left alone) and tells the
// page to wait. A round already in review takes the clips that finished
// since as additional candidates ("Add new clips").
//
// Renders still exist for one case: a staff revision changes a creative's
// range or copy and needs its own file (renderCampaign, background).

import { systemSession, type Session } from "@/lib/auth";
import { cutEpisodeClips } from "@/lib/clips/run";
import { pickClipsForRound } from "@/lib/clips/creatives";
import { jobIsRunning } from "@/lib/clips/state";
import { getData } from "@/lib/data";
import type { PromoCreative } from "@/lib/types";
import { ffmpegAvailable, renderAd } from "./render";

export type GenerateOutcome = {
  creatives: PromoCreative[];
  /** New rows this call added (a subset of `creatives` when the round was already open). */
  added: PromoCreative[];
  /** No finished clip yet: cutting was started (or is going) for `cutting_episodes` episodes. */
  cutting: boolean;
  cutting_episodes: number;
};

export async function generateAds(session: Session, campaignId: string): Promise<GenerateOutcome> {
  const data = getData();
  const detail = await data.getPromoCampaign(session, campaignId);
  const active = detail.creatives.filter((c) => c.status !== "superseded");
  if (active.length) {
    if (detail.campaign.status !== "review") return { creatives: active, added: [], cutting: false, cutting_episodes: 0 };
    const added = await data.appendPromoDraftsFromClips(session, campaignId);
    return { creatives: [...active, ...added], added, cutting: false, cutting_episodes: 0 };
  }
  // Decide from the clips themselves, not from an error message: finished clips → generate; none → cut.
  const clips = await data.listEpisodeClips(session, detail.title.id);
  if (pickClipsForRound(clips, detail.episodes).length) {
    const creatives = await data.generatePromoDrafts(session, campaignId);
    return { creatives, added: creatives, cutting: false, cutting_episodes: 0 };
  }
  // No clips: cut every episode with a video that is not already being cut.
  let started = 0;
  for (const episode of detail.episodes.filter((x) => x.video_path)) {
    const latest = await data.latestEpisodeJob(session, detail.title.id, episode.number, "cut_clips");
    if (jobIsRunning(latest)) { started += 1; continue; }
    if (process.env.PROMO_RENDER === "off") continue;
    void cutEpisodeClips(detail.title.id, episode.number).catch((err) => console.error(`[clips] ${detail.title.id}/${episode.number} threw`, err));
    started += 1;
  }
  return { creatives: [], added: [], cutting: true, cutting_episodes: started };
}

/** Kick the campaign's unrendered creatives in the background — the revise
 * route's way to give a moved-window revision its new cut, so answering a
 * change request never parks at the launch gate's "unrendered creatives".
 * No ffmpeg, no kick; the gate keeps saying so (fixture's fake launch still
 * accepts the source file, decision 2026-09-09). */
export async function renderCampaignInBackground(campaignId: string): Promise<boolean> {
  if (!(await ffmpegAvailable())) return false;
  void renderCampaign(campaignId).catch((e) => console.error(`[render] campaign ${campaignId} threw`, e));
  return true;
}

/** Render every unrendered active creative, then open the campaign for review. Safe to re-run. */
export async function renderCampaign(campaignId: string): Promise<{ rendered: number; failed: string[] }> {
  const data = getData();
  const session = systemSession();
  const detail = await data.getPromoCampaign(session, campaignId);
  const failed: string[] = [];
  let rendered = 0;
  for (const creative of detail.creatives) {
    if (creative.status === "superseded" || creative.render_path) continue;
    const episode = detail.episodes.find((e) => e.id === creative.source_episode_id);
    if (!episode?.video_path) {
      failed.push(`${creative.external_id}: no source video`);
      continue;
    }
    try {
      const r = await renderAd(creative, episode.video_path, `${detail.title.id}/${episode.id}`);
      await data.setCreativeRender(session, creative.id, { render_path: r.render_path, render_sha256: r.render_sha256, duration_ms: r.duration_ms, width: r.width, height: r.height, render_settings: { schema: 2, format: "9:16", source: "rendered_cut" } });
      rendered += 1;
    } catch (e) {
      failed.push(`${creative.external_id}: ${(e as Error).message}`);
      console.error(`[render] ${creative.external_id}: ${(e as Error).message}`);
    }
  }
  if (detail.campaign.status === "generating") {
    await data.finishPromoGeneration(session, campaignId, failed.length ? `${failed.length} ad(s) could not be rendered: ${failed.join("; ").slice(0, 400)}` : null);
  }
  return { rendered, failed };
}
