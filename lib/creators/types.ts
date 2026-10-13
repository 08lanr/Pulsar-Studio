// Creator accounts (decision 2026-10-12, docs/creator-accounts.md): Instagram
// accounts of fictional lifestyle creators that Studio runs end to end —
// scheduled posts, replies to comments in the creator's voice, and the numbers
// that say what grows the audience. Chloe Lin (@chloelin.diary) is the first
// row; nothing here is specific to her. Client-safe: types and constants only.

export const CREATOR_POST_KINDS = ["image", "carousel", "reel"] as const;
export type CreatorPostKind = (typeof CREATOR_POST_KINDS)[number];
export type CreatorMediaKind = "image" | "video";
export type CreatorPostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
/** container → (children) → processing → publishing → published; see lib/creators/publish.ts. */
export type CreatorPostStep = "container" | "processing" | "publishing" | "published";
export type CreatorPostSource = "human" | "agent" | "muse";
export type CommentDecision = "pending" | "reply" | "skip" | "flag";
export type CommentStatus = "new" | "drafted" | "sent" | "skipped" | "failed";

/** The character bible every caption and reply is written from. */
export type CreatorPersona = {
  summary: string;
  age: number | null;
  city: string;
  interests: string[];
  voice: string;
  do: string[];
  dont: string[];
  banned_topics: string[];
};

export type CreatorSettings = {
  timezone: string;
  auto_reply: boolean;
  reply_delay_min: number;
  reply_delay_max: number;
  max_replies_per_hour: number;
  reply_window_days: number;
};

export const DEFAULT_CREATOR_SETTINGS: CreatorSettings = {
  timezone: "America/Los_Angeles",
  auto_reply: true,
  reply_delay_min: 4,
  reply_delay_max: 45,
  max_replies_per_hour: 12,
  reply_window_days: 14,
};

export type CreatorAccount = {
  id: string;
  external_id: string;            // cr_…
  handle: string;                 // without the @
  display_name: string;
  instagram_id: string;
  /** Null: the account is called directly with the publish token (no Facebook Page linked). */
  page_id: string | null;
  persona: CreatorPersona;
  settings: CreatorSettings;
  status: "active" | "paused";
  revision: number;
  created_at: string;
  updated_at: string;
};

export type CreatorMedia = {
  id: string;
  external_id: string;            // cm_…
  account_id: string;
  kind: CreatorMediaKind;
  /** Storage path in the studio-media bucket (`creators/<account>/<file>`); never a URL. */
  path: string;
  /** SHA-256 of the file as it was imported: re-importing the same file is a no-op. */
  sha256: string;
  /** SHA-256 of the stored bytes (a PNG is stored as a JPEG), re-verified before every post. */
  stored_sha256: string;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  mime: string;
  bytes: number;
  description: string;
  tags: string[];
  /** The original file name, for people; never used as a path. */
  filename: string;
  created_by: string;
  created_at: string;
  revision: number;
};

/** Container ids, persisted before the next call: children by media id, then the parent. */
export type CreatorContainers = { children?: Record<string, string>; parent?: string | null };

export type CreatorPost = {
  id: string;
  external_id: string;            // cp_…
  account_id: string;
  kind: CreatorPostKind;
  media_ids: string[];
  caption: string;
  scheduled_at: string | null;
  status: CreatorPostStatus;
  step: CreatorPostStep;
  containers: CreatorContainers;
  ig_media_id: string | null;
  permalink: string | null;
  /** Set immediately before media_publish is sent; only such a row may adopt an existing Instagram media. */
  attempted_at: string | null;
  lease_owner: string | null;
  leased_until: string | null;
  error: string | null;
  source: CreatorPostSource;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  revision: number;
};

export type CreatorComment = {
  id: string;
  account_id: string;
  post_id: string | null;
  ig_media_id: string;
  ig_comment_id: string;
  /** The comment this one answers inside a thread; null for a top-level comment. */
  parent_ig_id: string | null;
  username: string;
  text: string;
  commented_at: string;
  decision: CommentDecision;
  reason: string | null;
  reply_text: string | null;
  reply_due_at: string | null;
  reply_ig_id: string | null;
  /** Set immediately before the reply is sent: a resumed send reads the thread back, never resends blindly. */
  attempted_at: string | null;
  replied_at: string | null;
  status: CommentStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
};

/** One daily read. `scope` is "account" or the Instagram media id; unknown is null, never 0. */
export type CreatorStat = {
  id: string;
  account_id: string;
  scope: string;
  ig_media_id: string | null;
  post_id: string | null;
  day: string;                    // YYYY-MM-DD in the account's time zone
  followers_count: number | null;
  follows_count: number | null;
  media_count: number | null;
  reach: number | null;
  profile_views: number | null;
  follows_gained: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  views: number | null;
  total_interactions: number | null;
  read_at: string;
};

export type CreatorAccountInput = {
  handle: string;
  display_name: string;
  instagram_id: string;
  page_id?: string | null;
  persona: CreatorPersona;
  settings?: Partial<CreatorSettings>;
  status?: "active" | "paused";
};

export type CreatorAccountPatch = Partial<Pick<CreatorAccount, "display_name" | "status" | "page_id">> & {
  persona?: Partial<CreatorPersona>;
  settings?: Partial<CreatorSettings>;
};

export type NewCreatorMedia = Omit<CreatorMedia, "id" | "external_id" | "created_at" | "revision" | "created_by">;

export type NewCreatorPost = {
  account_id: string;
  kind: CreatorPostKind;
  media_ids: string[];
  caption: string;
  scheduled_at: string | null;
  status: "draft" | "scheduled" | "publishing";
  source: CreatorPostSource;
};

/** What the engine and the person's edits may change on a post. */
export type CreatorPostPatch = Partial<Pick<CreatorPost,
  "kind" | "media_ids" | "caption" | "scheduled_at" | "status" | "step" | "containers" | "ig_media_id" | "permalink"
  | "attempted_at" | "lease_owner" | "leased_until" | "error" | "published_at">>;

export type CreatorCommentPatch = Partial<Pick<CreatorComment,
  "post_id" | "decision" | "reason" | "reply_text" | "reply_due_at" | "reply_ig_id" | "attempted_at" | "replied_at" | "status" | "error">>;

/** A comment as the sweep reads it from Instagram, before any decision. */
export type NewCreatorComment = Pick<CreatorComment,
  "account_id" | "post_id" | "ig_media_id" | "ig_comment_id" | "parent_ig_id" | "username" | "text" | "commented_at">
  & Partial<Pick<CreatorComment, "decision" | "reason" | "status" | "reply_ig_id">>;

export type NewCreatorStat = Omit<CreatorStat, "id">;

/** Shown wherever a persona is edited; one default for a new account. */
export const EMPTY_PERSONA: CreatorPersona = {
  summary: "", age: null, city: "", interests: [], voice: "", do: [], dont: [], banned_topics: [],
};
