// Shared contract for organic clip posting on Meta (docs/meta-organic-plan.md).
// Builders import from here; neither redefines these shapes.

import type { LaunchContent } from "./types";

export type ClipPostPlatform = "facebook" | "instagram";
export type ClipPostStatus = "publishing" | "published" | "failed";
export type ClipPostStep =
  | "uploading" | "uploaded" | "published"          // facebook: Page video post
  | "container" | "processing" | "publishing";      // instagram: Reel via container

export type ClipPost = {
  id: string;
  producer_id: string;
  clip_id: string;
  connection_id: string;
  platform: ClipPostPlatform;
  status: ClipPostStatus;
  step: ClipPostStep;
  external_video_id: string | null;   // facebook video id / instagram container id
  external_post_id: string | null;    // facebook pageID_postID / instagram media id
  permalink: string | null;
  caption: string;
  sha256: string;
  error: string | null;
  /**
   * Set immediately before the current step's create call is sent, cleared when
   * the step advances. Only a row carrying it may adopt an existing Meta object:
   * a brand-new row never claims a post somebody else made.
   */
  attempted_at: string | null;
  /** The published row this one replaced, when it was made with "Post again". */
  superseded_by: string | null;
  /** Ten-minute worker lease, the same shape as promote.launch_runs. */
  lease_owner: string | null;
  leased_until: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  revision: number;
  /** Fixture-only in-memory audit copy; Supabase writes core.audit_events instead. */
  audit?: { at: string; actor: string | null; action: string; note?: string }[];
};

/** One rendered clip as the Clips tab and the Launch popup see it. */
export type ClipLibraryRow = LaunchContent & {
  id: string;
  external_id: string;                // clip_… , the internal reference; never a caption
  producer_id: string;
  producer_name: string;
  title_id: string;
  title_name: string;
  episode_id: string | null;
  episode_label: string | null;       // the bare number; null on a 60-second ad (see `montage`)
  label: string;                      // hook_en, falling back to external_id
  /** A 60-second ad (lib/clips/montage.ts): shown as "Ad · 60 s", its episodes in place of one. Null on a clip. */
  montage?: { episodes: string; pieces: number } | null;
  /** A finished ad supplied by the partner (source 'upload'). It is filed under an
   *  episode because studio.clips.episode_id is NOT NULL, but it is not a window of
   *  that episode, so no episode is shown for it. */
  uploaded?: boolean;
  duration_ms: number | null;
  rendered_at: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  spark_code: string | null;
  post_url: string | null;
  posts: ClipPost[];                  // every attempt, newest first
};

export type ClipLibraryFilter = {
  producer_id?: string;
  title_id?: string;
  episode_id?: string;
  posted?: "any" | "not_posted" | "posted" | "failed";
  search?: string;
};

export type PublishClipInput = {
  clip_id: string;
  platform: ClipPostPlatform;
  connection_id: string;
  caption?: string;                   // default: hook on line one, title on line two
  again?: boolean;                    // post a second time although a published row exists
};

/** A post that already exists on the Page or Instagram account (the "From the Page" tab). */
export type MetaPagePost = {
  platform: ClipPostPlatform;
  id: string;                         // facebook pageID_postID / instagram media id
  caption: string;
  permalink: string | null;
  thumbnail_url: string | null;
  created_at: string;
};

/**
 * TikTok's "From @account" tab: the account Business Center links to the ad
 * account, and its newest posts (lib/launch/tiktok-posts.ts). `account` is
 * null, with the reason in `notes`, when there is none or it cannot be read.
 */
export type TikTokAccountPostList = {
  account: { name: string; handle: string; ads_only: boolean; can_push: boolean; can_pull: boolean } | null;
  posts: { item_id: string; text: string; cover_url: string | null; duration_s: number | null; status: string }[];
  more: boolean;
  notes: string[];
};

/** The "From the Page" tab: what Meta returned, plus why a side is empty. */
export type MetaPagePostList = {
  facebook: MetaPagePost[];
  instagram: MetaPagePost[];
  /** One sentence per side that could not be read, e.g. a missing permission. */
  notes: string[];
};
