# Creator accounts

Decision 2026-10-12 (top of `docs/decisions.md`). Studio runs Instagram accounts of fictional
lifestyle creators end to end: a media library, scheduled posts (photo, carousel, Reel), replies to
comments in the creator's voice, and the daily numbers that say what grows the audience. Chloe Lin,
@chloelin.diary (Instagram user `17841416495486333`, Business portfolio CrazyDramas
`1713297459750982`, no Facebook Page), is the first account. A creator account never promotes
CrazyDramas.

## Where things are

| Piece | File |
| --- | --- |
| Tables | `supabase/migrations/0024_creator_accounts.sql` (`promote.creator_accounts`, `creator_media`, `creator_posts`, `creator_comments`, `creator_stats`; job kinds `creator_captions`, `creator_reply`) |
| Data layer (both backends, CAS) | `lib/data/creators.ts`, merged into `getData()` |
| Types | `lib/creators/types.ts` |
| Media import | `lib/creators/media.ts` (sniff, PNG/WebP → JPEG with ffmpeg, feed-ratio check, SHA-256 dedupe) |
| Post rules | `lib/creators/validate.ts` (pure) |
| Publishing engine | `lib/creators/publish.ts` |
| Comments and replies | `lib/creators/reply-policy.ts` (pure rules), `lib/creators/replies.ts` |
| Insights | `lib/creators/insights.ts`, headline sums `lib/creators/stats.ts` (pure) |
| Caption writer | `lib/creators/captions.ts`, prompts `lib/prompts/creator.ts` |
| Person / agent actions | `lib/creators/service.ts` |
| Sweeps | `lib/creators/sweeps.ts`, step 9 of `lib/tiktok/scheduler.ts` |
| MCP tools | `lib/creators/mcp.ts`, served by `/api/mcp` with the launch tools |
| Staff routes | `lib/creators/routes.ts`, thin files under `app/api/admin/creators/` |
| Screens | `app/(admin)/creators/`, `components/admin/creators/` |
| Import script | `scripts/creators-import.ts` |
| Tests | `tests/creator-*.test.ts` |

## Who may do what

Pulsar staff only; producers never see a creator account (every read is "not found" to them). Any
staff member reads everything, adds media and edits descriptions and tags. A staff administrator
schedules, publishes, retries, cancels, sends, edits or skips replies, writes captions into a post
and changes the character bible and settings. The sweeps act as the system actor. The engine's own
fields (step, containers, lease, Instagram ids) are written by the system actor only.

## Meta tokens

Two Meta apps, two System User tokens, chosen in `lib/meta/transport.ts` (`metaTokenSource`):

- `META_ACCESS_TOKEN`: app "CrazyDramas Ads" (Marketing API only). Launches, controls, the monitor,
  pixels and the launch popup's "From the Page" listing.
- `META_PUBLISH_TOKEN`: app "Pulsar Entertainment" (2026-10-12: never expires; scopes include
  instagram_basic, instagram_content_publish, instagram_manage_comments, instagram_manage_insights,
  pages_show_list, pages_read_engagement, pages_manage_posts, pages_manage_engagement,
  business_management, read_insights). Every organic post (clip posts to the Page and Instagram,
  creator posts), comments, replies and insights. When unset, `META_ACCESS_TOKEN` is used, as before.

An account with no Page (Chloe) is called as `/{instagram_id}/...` with the publish token directly;
one with a `page_id` goes through `forPage`, which derives the Page token from the publish token per
call. Every guarantee of the transport stands: only `lib/meta/transport.ts` fetches Meta, fixture
mode is always the fake, a POST needs `META_LIVE_WRITES=enabled`, and no token is logged, stored,
returned or put in an error.

## Posting

Kinds: `image` (one JPEG, 4:5 to 1.91:1), `carousel` (2 to 10 images or 3-60 s videos, in order;
Instagram crops them to the first item's shape), `reel` (one video, 3 s to 15 min, 9:16 best).
Captions: at most 2,200 characters, 30 hashtags, 20 @mentions, never "CrazyDramas". These rules are
`checkPost`, used when a post is scheduled, edited, posted now or created through MCP.

The engine (`runCreatorPost`) follows `lib/meta/publish.ts`:

1. ten-minute row lease; the account's 24-hour allowance (`content_publishing_limit`, 100 for
   Chloe) is read before the first container, and an exhausted allowance waits instead of failing;
2. the stored bytes are re-hashed against `stored_sha256`, then a 15-minute signed storage URL is
   minted (fixture: a `fixture://` URL that never leaves the process);
3. containers: image `{image_url, caption}`; carousel one child per item
   (`is_carousel_item`, `media_type: VIDEO` for a video) recorded one by one, then the parent
   `{media_type: CAROUSEL, children, caption}`; Reel `{media_type: REELS, video_url, caption,
   share_to_feed: true}`; each id is on the row before the next call;
4. poll `status_code` until FINISHED (the run gives up after five minutes and the sweep resumes);
5. `attempted_at` is written, then `media_publish`; the media id is on the row before anything else,
   then the permalink (a failed permalink read is a note, not a failure).

A resume never makes a second container for an item that has one and never sends `media_publish`
twice: a lost answer is adopted from `/{ig}/media` (exact caption, after the attempt, not held by
another row); nothing to adopt fails the row with a sentence and a person's Retry, after looking,
sends it again (Instagram publishes a container once, so this cannot make a second post). Transient
refusals (codes 1/2/4/17/32/613, 5xx, lost answers, the allowance) leave the row `publishing` for the
sweep; anything else fails it with Meta's sentence. A container Instagram ended in ERROR or EXPIRED
is forgotten so Retry starts fresh containers.

## Comments and replies

Every five minutes the sweep lists the account's media from the last `reply_window_days` (posts made
by hand count too) and their comments with replies. The account's own words are never stored as
comments; they prove a comment was answered (an answer made in the app closes the comment, a reply
Studio sent but never recorded is adopted). Then `preFilter` decides:

- skip: empty, too old, a reply inside a thread, links, promotion/spam, a tag of a friend;
- flag (never answered by Studio, not even by a person through Studio): asks whether she is real,
  human, AI, a bot or fake; sexual; minors; hostile; asks to meet, for contact details, about money
  or investing, or to DM;
- reply: emoji-only comments get a short emoji back;
- everything else: one model draft (`creator_reply` job, ADS_TEXT_PROVIDER's fast tier, at most 20
  per account per sweep), zod-validated, re-checked by `replyProblem` (one short sentence, no links,
  hashtags, @mentions, CrazyDramas, claims about what she is, employers or offers); a draft that
  breaks a rule is flagged.

Drafted replies go out only with `auto_reply` on and the account active, after a random delay
between `reply_delay_min` and `reply_delay_max` minutes, at most `max_replies_per_hour`, through
`POST /{comment_id}/replies`. `attempted_at` is written first; a lost answer is read back from the
thread, never re-sent. One comment gets one reply, ever (`reply_ig_id` is unique).

## Insights

Once a day per account (the stats table says whether today was read; "Read now" forces it):
followers, follows and media count from `/{ig}`, account `reach`, `profile_views` and
`follower_count` for the day, and per media from the last 30 days `reach, likes, comments, saved,
shares, total_interactions, views` (asked together, then one by one). Anything Meta refuses is null,
never 0; a later refused read the same day keeps the earlier value.

## Screens and MCP

`/creators` lists the accounts with the sweep's status line. `/creators/<id>`: Queue (upcoming,
failed, published; New post with media in order, kind, caption and "Write captions", time in the
account's time zone; Schedule, Post now, Retry, Cancel), Library (upload, description, tags, used-in
count), Comments (filters; Send now, Save reply, Skip; "Check comments now"), Stats (followers, reach
7 days, posts 30 days, replies sent 7 days, best post; followers chart; per-post table; ⓘ
definitions), Character (persona and settings, the auto-reply switch).

MCP (same endpoint and switch as the launch tools, `STUDIO_LAUNCH_MCP_ENABLED=1`): `creator_list`,
`creator_get`, `creator_media_list`, `creator_media_describe`, `creator_queue_list`,
`creator_post_schedule` (publishes), `creator_post_update`, `creator_post_cancel`,
`creator_caption_options`, `creator_comments_list`, `creator_reply_send` (sends), 
`creator_settings_update`, `creator_stats`.

## Environment

| Variable | Meaning |
| --- | --- |
| `META_PUBLISH_TOKEN` | Publish token (above). Blank = `META_ACCESS_TOKEN`. |
| `CREATORS_DISABLED=1` | Stops every creator sweep (posts, comments, replies, insights). Manual buttons still work. |
| `META_LIVE_WRITES=enabled` + `DATA_SOURCE=supabase` | Required for the sweeps to run at all, and for any live POST. |
| `ADS_TEXT_PROVIDER` + its key | The caption writer and the reply drafts. Without a key: no captions offered, ordinary comments wait for a person. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | PNG/WebP conversion and video probing at import. |
| `META_FAKE_PUBLISH` | Fixture only: `ig_error`, `ig_quota`, `ig_throttle`, `comments_error`, `reply_error`, `insights_error` (comma-separated). |

## Going live (operator steps)

1. Apply `supabase/migrations/0024_creator_accounts.sql` to the live database (SQL editor or
   `supabase db push`); it is idempotent, and the two job kinds are added after its transaction.
2. In `.env.local` of the computer that runs `studio-live`: `META_PUBLISH_TOKEN=<Pulsar Entertainment
   System User token>` (already present on Ruobin's computer as of 2026-10-12). Keep
   `META_ACCESS_TOKEN` as the ads token. The sweeps need `META_LIVE_WRITES=enabled`; leave
   `CREATORS_DISABLED=1` until the first post below is checked if you want nothing to run by itself.
3. Import Chloe and her photos: `node --import tsx scripts/creators-import.ts --live` (dry run: check
   the list), then `node --import tsx scripts/creators-import.ts --live --write` from the Studio
   checkout. 6 photos are added (06 is a copy of 01); a second run adds nothing.
4. Restart `studio-live`, open `/creators`, check the Character tab (auto-reply is on by default;
   switch it off first if replies should wait for a person at the start).
5. First post: Queue → New post → one photo → Write captions (or write one) → Post now. Watch the
   row reach Published and open the permalink. Then schedule the next ones.
6. Check comments: Comments → Check comments now; read the decisions before turning auto-reply on.

Not verified live as of 2026-10-12: any write (container create, media_publish, comment reply) on an
Instagram account with no linked Page through `graph.facebook.com` with a System User token. Reads
(`/{ig}`, `content_publishing_limit`, `/media`, `/insights?metric=reach&period=day`) were verified
with the publish token directly. The insights metric names (`profile_views` with
`metric_type=total_value`, `follower_count`, media `views`) follow the current Graph API but are
read fail-soft; a refused one shows "not reported".
