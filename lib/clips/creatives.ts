// Campaign ads from the title's auto-cut clips (decision 2026-09-14): one
// pure mapping shared by both data-layer backends, so "Generate ads" builds
// the same rows from the same clips in fixture and Supabase mode. The clip
// already carries the finished 9:16 file and its hash; the creative copies
// them and renderCampaign skips it (it skips anything with a render_path).
// There is no other source of ads: without finished clips generation
// refuses with NO_CLIPS_MESSAGE and the route starts cutting (review
// 2026-09-14: "production clip generation still uses placeholders").
//
// The hook is the ad's text — the one string TikTok shows, sent verbatim
// up to TikTok's 100 characters (AD_TEXT_MAX). Caption and description are
// records for the producer; the plot claim on a card is the clip's own
// `why`, which came from the script or says "footage".

import type { Clip, Episode, Json, PromoCreative, Title } from "@/lib/types";

export const NO_CLIPS_MESSAGE = "no finished ad clips yet for this title";

/** TikTok's ad_text limit; what is sent is the hook cut here, and the UI shows exactly that. */
export const AD_TEXT_MAX = 100;

export function adTextOf(creative: Pick<PromoCreative, "hook" | "caption">, fallback = ""): string {
  const text = (creative.hook || creative.caption || fallback).replace(/\s+/g, " ").trim();
  return text.slice(0, AD_TEXT_MAX);
}

/** The clip a creative was built from, when it was built from one. */
export function clipIdOf(creative: Pick<PromoCreative, "render_settings">): string | null {
  const s = (creative.render_settings ?? {}) as { source?: string; clip_id?: string };
  return s.source === "auto_clip" && typeof s.clip_id === "string" ? s.clip_id : null;
}

export type CreativeDraft = Pick<
  PromoCreative,
  "kind" | "status" | "hypothesis" | "source_episode_id" | "source_start_ms" | "source_end_ms" | "hook" | "caption" | "ad_description" | "render_path" | "render_sha256" | "duration_ms" | "width" | "height" | "render_settings"
>;

/** Every rendered clip, opening first, then by episode number and rank. */
export function pickClipsForRound(clips: Clip[], episodes: Pick<Episode, "id" | "number">[]): Clip[] {
  const number = new Map(episodes.map((e) => [e.id, e.number]));
  return clips
    .filter((c) => c.render_status === "rendered" && c.render_path && c.render_sha256 && c.status !== "dismissed")
    .sort((a, b) => Number(b.moment === "opening") - Number(a.moment === "opening") || (number.get(a.episode_id) ?? 0) - (number.get(b.episode_id) ?? 0) || a.rank - b.rank);
}

export function creativesFromClips(clips: Clip[], title: Pick<Title, "name_en" | "name_zh">): CreativeDraft[] {
  const name = title.name_en || title.name_zh;
  return clips.map((clip) => ({
    kind: "direct_clip",
    status: "ready",
    hypothesis: clip.why_en,
    source_episode_id: clip.episode_id,
    source_start_ms: clip.start_ms,
    source_end_ms: clip.end_ms,
    hook: clip.hook_en.slice(0, AD_TEXT_MAX),
    caption: clip.moment === "opening" ? `${name}: the story starts here.` : `${name}: one choice changes everything.`,
    ad_description: `Watch ${name} and see what happens next.`,
    render_path: clip.render_path,
    render_sha256: clip.render_sha256,
    duration_ms: clip.duration_ms ?? clip.end_ms - clip.start_ms,
    width: clip.width ?? 1080,
    height: clip.height ?? 1920,
    render_settings: { schema: 3, format: "9:16", source: "auto_clip", clip_id: clip.id, clip_external_id: clip.external_id, moment: clip.moment, selection: clip.source, why_zh: clip.why_zh } as Json,
  }));
}
