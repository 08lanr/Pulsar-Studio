// Generate a campaign's ads: the concept rows first (the data layer's five
// per round), then the finished files in the background, then the campaign
// opens for review (decision 2026-09-09: "Studio generates finished ad
// videos; producers approve the exact video"). The producer sees
// "generating" while renders run and the page polls; without ffmpeg the
// concepts open for review at once with the source-footage preview and the
// launch gate asks for renders before a live launch.
//
// Renders write through the system actor: the request that started them
// has usually returned by the time they finish.

import { systemSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import type { PromoCreative } from "@/lib/types";
import { ffmpegAvailable, renderAd } from "./render";

export type GenerateOutcome = { creatives: PromoCreative[]; rendering: boolean };

export async function generateAds(session: Session, campaignId: string): Promise<GenerateOutcome> {
  const data = getData();
  const rendering = await ffmpegAvailable();
  const creatives = await data.generatePromoDrafts(session, campaignId, { rendering });
  const pending = creatives.filter((c) => !c.render_path);
  if (!rendering || !pending.length) return { creatives, rendering: false };
  void renderCampaign(campaignId).catch((e) => console.error(`[render] campaign ${campaignId} threw`, e));
  return { creatives, rendering: true };
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
      await data.setCreativeRender(session, creative.id, { render_path: r.render_path, render_sha256: r.render_sha256, duration_ms: r.duration_ms, width: r.width, height: r.height, render_settings: { schema: 2, format: "9:16", source: "rendered_cut", hook_burned: !!creative.hook.trim() } });
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
