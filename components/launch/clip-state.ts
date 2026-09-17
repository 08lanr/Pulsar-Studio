// What "posted" means on screen, in one place, so the Clips table, the post
// dialog and the launch content picker never disagree (docs/meta-organic-plan.md §5).

import type { ClipPost, ClipPostPlatform } from "@/lib/launch/clip-posts";

/** Dates follow the chrome, not the browser: 9月16日 under Chinese, Sep 16 under English. */
export const dateTag = (locale: string) => (locale === "zh" ? "zh-CN" : "en-US");
export const shortDate = (iso: string | null | undefined, locale: string) =>
  iso ? new Date(iso).toLocaleDateString(dateTag(locale), { day: "numeric", month: "short" }) : "—";

/**
 * A repost supersedes the published row it replaces (Builder A's `superseded_by`).
 * Read tolerantly so this keeps working both before and after that field lands.
 */
export const isSuperseded = (post: ClipPost) => !!(post as ClipPost & { superseded_by?: string | null }).superseded_by;

/**
 * The one attempt a platform cell speaks for: a run in flight first, then the
 * published row that is still current (a superseded one is history, so its old
 * date never wins over the newest post), then whatever the last attempt was.
 */
export const postOn = (posts: ClipPost[] | undefined, platform: ClipPostPlatform): ClipPost | null => {
  const all = (posts ?? []).filter((p) => p.platform === platform);
  return all.find((p) => p.status === "publishing")
    ?? all.find((p) => p.status === "published" && !isSuperseded(p))
    ?? all[0] ?? null;
};

/** The live published row this clip holds on that platform — on one account when `connectionId` is given. */
export const publishedOn = (posts: ClipPost[] | undefined, platform: ClipPostPlatform, connectionId?: string): ClipPost | null =>
  (posts ?? []).find((p) => p.platform === platform && p.status === "published" && !isSuperseded(p)
    && (!connectionId || p.connection_id === connectionId)) ?? null;
