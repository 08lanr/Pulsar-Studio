// Campaign ads from the title's auto-cut clips (decision 2026-09-14): one
// pure mapping shared by both data-layer backends, so "Generate ads" builds
// the same rows from the same clips in fixture and Supabase mode. The clip
// already carries the finished 9:16 file and its hash; the creative copies
// them and renderCampaign skips it (it skips anything with a render_path).
// The hook is the ad's text (never burned into the picture); caption and
// description are templated from the title name only — the plot claim on a
// card is the clip's own `why`, which came from the script or says "footage".

import type { Clip, Episode, Json, PromoCreative, Title } from "@/lib/types";

/** How many clip-backed ads one round offers the producer to pick from. */
export const MAX_ADS_FROM_CLIPS = 8;

export const FALLBACK_NOTE = "No finished ad clips were available for this title, so the ads were cut at fixed offsets. Upload episodes (or press Cut clips again on Materials) and generate ads again for real moments.";

export type CreativeDraft = Pick<
  PromoCreative,
  "kind" | "status" | "hypothesis" | "source_episode_id" | "source_start_ms" | "source_end_ms" | "hook" | "caption" | "ad_description" | "render_path" | "render_sha256" | "duration_ms" | "width" | "height" | "render_settings"
>;

/** Rendered clips only, opening first, then by episode number and rank; at most MAX_ADS_FROM_CLIPS. */
export function pickClipsForRound(clips: Clip[], episodes: Pick<Episode, "id" | "number">[]): Clip[] {
  const number = new Map(episodes.map((e) => [e.id, e.number]));
  return clips
    .filter((c) => c.render_status === "rendered" && c.render_path && c.render_sha256 && c.status !== "dismissed")
    .sort((a, b) => Number(b.moment === "opening") - Number(a.moment === "opening") || (number.get(a.episode_id) ?? 0) - (number.get(b.episode_id) ?? 0) || a.rank - b.rank)
    .slice(0, MAX_ADS_FROM_CLIPS);
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
    hook: clip.hook_en,
    caption: clip.moment === "opening" ? `${name}: the story starts here.` : `${name}: one choice changes everything.`,
    ad_description: `Watch ${name} and see what happens next.`,
    render_path: clip.render_path,
    render_sha256: clip.render_sha256,
    duration_ms: clip.duration_ms ?? clip.end_ms - clip.start_ms,
    width: clip.width ?? 1080,
    height: clip.height ?? 1920,
    render_settings: { schema: 3, format: "9:16", source: "auto_clip", clip_id: clip.id, clip_external_id: clip.external_id, moment: clip.moment, selection: clip.source } as Json,
  }));
}
