// What a creator post must be before Studio accepts it (decision 2026-10-12).
// Pure: the scheduling route, the MCP tool and the publishing engine read the
// same answer, so anything the engine would refuse is refused when the post is
// scheduled, not at 3 a.m. when it is due.
//
// Instagram's own limits (Content Publishing API): a feed image is a JPEG with
// an aspect ratio between 4:5 and 1.91:1; a carousel holds 2 to 10 images or
// videos (it is cropped to the first item's ratio); a Reel is one video of 3
// seconds to 15 minutes; a caption is at most 2,200 characters with at most 30
// hashtags and 20 @mentions. Ours on top: a creator account never mentions
// CrazyDramas.

import type { CreatorMedia, CreatorPostKind } from "./types";

export const FEED_RATIO_MIN = 4 / 5;
export const FEED_RATIO_MAX = 1.91;
const RATIO_SLACK = 0.005;
export const CAPTION_MAX = 2200;
export const HASHTAG_MAX = 30;
export const MENTION_MAX = 20;
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 10;
export const REEL_MIN_S = 3;
export const REEL_MAX_S = 15 * 60;
export const CAROUSEL_VIDEO_MAX_S = 60;
export const SCHEDULE_MAX_DAYS = 90;

export type PostCheck = { errors: string[]; warnings: string[] };

/** Why an image cannot go in the feed, or null. */
export function feedRatioIssue(width: number | null, height: number | null): string | null {
  if (!width || !height) return "its size is unknown";
  const ratio = width / height;
  if (ratio < FEED_RATIO_MIN - RATIO_SLACK) return `it is taller than 4:5 (${width}×${height})`;
  if (ratio > FEED_RATIO_MAX + RATIO_SLACK) return `it is wider than 1.91:1 (${width}×${height})`;
  return null;
}

export function hashtagsOf(caption: string): string[] { return caption.match(/#[\p{L}\p{N}_]+/gu) ?? []; }

/** Caption rules alone (the caption writer's options pass through here too). */
export function captionIssues(caption: string): string[] {
  const out: string[] = [];
  if (caption.length > CAPTION_MAX) out.push(`The caption is longer than ${CAPTION_MAX.toLocaleString("en-US")} characters.`);
  if (hashtagsOf(caption).length > HASHTAG_MAX) out.push(`Instagram allows at most ${HASHTAG_MAX} hashtags.`);
  if ((caption.match(/@[A-Za-z0-9._]+/g) ?? []).length > MENTION_MAX) out.push(`Instagram allows at most ${MENTION_MAX} @mentions.`);
  if (/crazy\s*dramas?/i.test(caption)) out.push("A creator account never mentions CrazyDramas.");
  return out;
}

export type PostInput = {
  kind: CreatorPostKind;
  /** The media in post order, as resolved for this account (an id the account does not own is the caller's error). */
  media: CreatorMedia[];
  caption: string;
  /** Required unless the post is a draft or goes out now. */
  scheduled_at: string | null;
  when: "draft" | "schedule" | "now";
};

/** Everything the engine would refuse, said up front. Pure. */
export function checkPost(input: PostInput, now: Date = new Date()): PostCheck {
  const errors: string[] = [], warnings: string[] = [];
  const { kind, media } = input;
  const ids = media.map(m => m.id);
  if (new Set(ids).size !== ids.length) errors.push("The same media is in this post twice.");
  if (kind === "image") {
    if (media.length !== 1) errors.push("An image post has exactly one image.");
  } else if (kind === "carousel") {
    if (media.length < CAROUSEL_MIN || media.length > CAROUSEL_MAX) errors.push(`A carousel has ${CAROUSEL_MIN} to ${CAROUSEL_MAX} items.`);
  } else if (media.length !== 1) errors.push("A Reel has exactly one video.");

  media.forEach((m, i) => {
    const name = media.length > 1 ? `Item ${i + 1}` : "The media";
    if (kind === "reel") {
      if (m.kind !== "video") { errors.push("A Reel is a video."); return; }
      if (m.duration_s === null) errors.push(`${name}: its length is unknown.`);
      else if (m.duration_s < REEL_MIN_S || m.duration_s > REEL_MAX_S) errors.push(`${name}: a Reel runs ${REEL_MIN_S} seconds to 15 minutes (this one ${Math.round(m.duration_s)} s).`);
      if (m.width && m.height && Math.abs(m.width / m.height - 9 / 16) > 0.02) warnings.push(`${name}: a Reel shows best at 9:16 (this one ${m.width}×${m.height}).`);
      return;
    }
    if (m.kind === "image") {
      if (m.mime !== "image/jpeg") errors.push(`${name}: Instagram takes JPEG images only.`);
      const issue = feedRatioIssue(m.width, m.height);
      if (issue) errors.push(`${name} cannot go in the feed: ${issue}.`);
    } else if (kind === "image") {
      errors.push("An image post cannot carry a video; post it as a Reel.");
    } else {
      if (m.duration_s === null || m.duration_s < REEL_MIN_S || m.duration_s > CAROUSEL_VIDEO_MAX_S) errors.push(`${name}: a carousel video runs ${REEL_MIN_S} to ${CAROUSEL_VIDEO_MAX_S} seconds.`);
      const issue = feedRatioIssue(m.width, m.height);
      if (issue) errors.push(`${name} cannot go in the feed: ${issue}.`);
    }
    if (!m.description.trim()) warnings.push(`${name} has no description; the caption writer cannot see what is in it.`);
  });
  if (kind === "carousel" && media.length > 1) {
    const ratios = media.filter(m => m.width && m.height).map(m => (m.width as number) / (m.height as number));
    if (ratios.some(r => Math.abs(r - ratios[0]) > 0.01)) warnings.push("Instagram crops every carousel item to the first item's shape.");
  }

  const caption = input.caption.trim();
  errors.push(...captionIssues(caption));
  if (!caption && input.when !== "draft") warnings.push("The post has no caption.");

  if (input.when === "schedule") {
    const at = Date.parse(input.scheduled_at ?? "");
    if (!Number.isFinite(at)) errors.push("Pick when the post goes out.");
    else if (at < now.getTime() - 60_000) errors.push("That time has passed. Pick a later time or post now.");
    else if (at > now.getTime() + SCHEDULE_MAX_DAYS * 86_400_000) errors.push(`Schedule at most ${SCHEDULE_MAX_DAYS} days ahead.`);
  }
  return { errors, warnings };
}
