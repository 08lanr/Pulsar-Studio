# Meta organic posting and clip-driven launches — build plan (2026-09-16)

Owner: Ruobin. Executors: two Opus builders (A: data and engine, B: screens) and one read-only
reviewer, orchestrated by Claude. This plan is the contract between them; `docs/launch-monitor-plan.md`
and `docs/unified-launch.md` still govern everything it does not mention.

## 0. What Ruobin asked for, and the decisions

Meta can do something TikTok cannot: the post itself can be created by API, and the post's id is
immediately usable as the ad creative. On TikTok the Spark authorization step is human-only, so the
clip → post → ad chain has a manual link in it. On Meta the whole chain can be one screen.

The ask, from the staff (administrative) side:

1. See every producer's rendered clips, filterable by producer, title and episode, in a staff
   **Clips** tab that mirrors the producer's Clips page.
2. From the Launch tab, pick clips and post them **organically** to the company's Facebook Page
   and Instagram account, from a popup that lists the selected producer's clips.
3. Once posted, use the resulting Facebook `pageID_postID` and Instagram media id as the ad
   content of a launch, without pasting anything by hand.
4. Clean up the staff side so Clips · Launch · Monitor read like the producer side.

Decisions (defaults Ruobin can override; everything else is fixed):

- **The post record is the source of truth for "posted".** A new table `promote.clip_posts` holds one
  row per clip × platform × connection attempt. The Clips tab, the Launch popup and the monitor all
  read it. Nothing infers "posted" from Meta on the fly.
- **Facebook posts are Page video posts** (`POST /{page_id}/videos`, multipart upload from Studio's
  stored clip bytes). Not Reels for now; a Page video post is promotable as `object_story_id` and needs
  no public URL. Reels can be added later as a second Facebook post type.
- **Instagram posts are Reels** (`media_type=REELS`, `share_to_feed=true`), because Instagram only
  accepts video through Reels now. Instagram needs a publicly fetchable `video_url`, so Studio mints a
  15-minute signed Supabase storage URL for the clip and hands it to Meta. Fixture mode never mints
  anything; the fake accepts any URL.
- **Caption default** is the clip's hook (`hook_en`, falling back to `external_id`) on the first line and
  the title name on the second. The dialog lets the poster edit it before confirming. The destination
  URL is not put in the caption; the ad supplies the button.
- **Who may post:** staff admin, or the producer's approver. Reviewers and viewers see status only.
  Staff editors cannot post (same rule as launching). Publishing public content is money-adjacent and
  is audited in both backends.
- **One published post per clip per platform per connection.** A failed attempt can be retried
  (resumes from the stored step) or reposted (new row). "Post again" on a published clip is a
  deliberate extra action with a confirm, never a side effect of the popup.
- **Publishing runs in the background** with the row's `step` persisted before every external call,
  exactly like launch runs. The screen polls the row. Instagram processing can take minutes.
- **Page access token is derived per call** (`GET /{page_id}?fields=access_token` with the configured
  token) and used only for that publish. It is never stored, logged, seeded or returned. This is the
  one place a second token exists in memory; the transport owns it.
- **Live gates stay:** fixture mode always uses `lib/meta/fake.ts`; live POST requires
  `META_LIVE_WRITES=enabled`; a clip must be `rendered` with a stored SHA-256 before it can be posted;
  the SHA-256 is re-verified on the bytes Studio uploads.
- **The launch popup has three tabs:** *Studio clips* (this plan), *From the Page* (recent posts and
  Reels made outside Studio, read-only listing, the "Pull from Page" idea), and *Paste an id* (the
  existing box). A clip already posted adds its Facebook id and, when Instagram is in placements, its
  Instagram media id; an unposted clip offers "Post to Facebook / Instagram" inline and adds the ids
  when the post finishes.
- **Draft content carries `clip_id` and a human label** (`title · hook`) so preview, confirm dialog and
  monitor show the clip, not the id. The id stays visible on expand.

## 1. Preconditions Ruobin must satisfy (not code)

- The configured `META_ACCESS_TOKEN` must carry `pages_show_list`, `pages_read_engagement`,
  `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `ads_management` and
  `business_management`. Builder A extends `scripts/meta-readiness.mjs` with `--scopes`, which calls
  `GET /debug_token` and prints the granted scopes and the token type (user or system user) without the
  token itself. Missing scopes are the most likely reason a first post fails.
- The Instagram account `17841434498347152` must be a professional account linked to Page
  `1298189526712840`; the readiness script already lists `instagram_business_account`.
- `META_LIVE_WRITES=enabled` in the live environment only. `studio-live` in the workspace
  `.claude/launch.json` does not set it; Ruobin adds it when he is ready to post for real. Port 3203 is
  his Supabase-backed server.
- Instagram enforces a rolling 24-hour API publishing quota per account. Studio reads
  `GET /{ig_user_id}/content_publishing_limit` before each Instagram post and refuses with the number
  when the quota is exhausted.

## 2. Data model (Builder A)

### 2.1 `supabase/migrations/0014_clip_posts.sql`

```
promote.clip_posts
  id              uuid primary key
  producer_id     uuid not null references core.producers(id)
  clip_id         uuid not null references studio.clips(id)
  connection_id   text not null            -- promote.launch_connections.id
  platform        text not null check (platform in ('facebook','instagram'))
  status          text not null check (status in ('publishing','published','failed'))
  step            text not null            -- facebook: uploading | uploaded | published
                                           -- instagram: container | processing | publishing | published
  external_video_id text                   -- facebook video id / instagram container id
  external_post_id  text                   -- facebook pageID_postID / instagram media id
  permalink       text
  caption         text not null
  sha256          text not null            -- the clip bytes that were posted
  error           text
  created_by      uuid not null
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()
  published_at    timestamptz
  revision        integer not null default 1   -- CAS, same discipline as launch_runs
```

Indexes: `(producer_id)`, `(clip_id, platform)`. Partial unique index on `(clip_id, platform,
connection_id) where status = 'published'`. RLS exactly as 0013: enabled, `select` for
`core.is_staff() or research.is_member_of(producer_id)`, no insert/update/delete policy, `revoke all
from anon, authenticated`, `grant select to authenticated`, `grant all to service_role`. Idempotent
(`create table if not exists`, `create index if not exists`), a `comment on table`, and it must apply
cleanly after 0013 in the Supabase SQL editor.

### 2.2 Fixture mirror

`lib/data/launch.ts` `store()` gains `clipPosts: ClipPost[]` next to `sparks`, persisted in
`.uploads/launch-state.json` under the same `FIXTURE_PERSIST` rule, cleared by `resetLaunchFixture()`
and by `/api/demo/reset`. Fixture and Supabase share one code path with `dataSource()` branches only at
storage, like the rest of that file.

### 2.3 Types (already added by the orchestrator in `lib/launch/clip-posts.ts`)

`ClipPost`, `ClipPostPlatform`, `ClipPostStatus`, `ClipPostStep`, `ClipLibraryRow`,
`ClipLibraryFilter`, `PublishClipInput`, `MetaPagePost`. Builders import these; they do not redefine
them. `LaunchContent` gains optional `clip_id` and `post_id` (Builder A adds them in
`lib/launch/types.ts`; B uses them).

### 2.4 Data-layer methods (`LaunchDataLayer` in `lib/launch/types.ts`, implemented in `lib/data/launch.ts`)

- `listClipLibrary(s, filter: ClipLibraryFilter): Promise<ClipLibraryRow[]>` — every rendered,
  non-dismissed clip with a stored SHA-256, joined with its posts. Staff with no `producer_id` filter
  see every producer; a producer session is always scoped to its own company and the filter's
  `producer_id` is ignored (the existing `getLaunchWorkspace` rule). Adds `producer_id`,
  `producer_name`, `episode_id`, `episode_label`, `duration_ms`, `rendered_at`, `thumbnail_url` to what
  `library()` returns today; `library()` becomes a thin wrapper so the launch workspace keeps working.
- `createClipPost(s, input: PublishClipInput & { caption: string; sha256: string }): Promise<ClipPost>`
  — authorization: staff admin or producer approver of that producer; the clip must belong to that
  producer and be rendered; the connection must belong to that producer, be enabled, be `meta`, and
  carry a `page_id` (and `instagram_id` for Instagram). Refuses with `conflict` when a published row
  already exists for that clip/platform/connection unless `input.again === true`.
- `getClipPost(s, id)`, `listClipPosts(s, { producer_id?, clip_id? })` — foreign rows are `not_found`.
- `updateClipPost(worker, id, expectedRevision, patch)` — system session only; CAS on `revision`;
  `conflict` on a lost update. The engine persists `step`, ids, `permalink`, `status`, `error`,
  `published_at` through this.
- Audit: the Supabase branch writes `core.audit_events` (`auditEvent` in `lib/data/supabase.ts`, exported
  or duplicated for this module) for `clip_post_created`, `clip_post_published`, `clip_post_failed`,
  `clip_post_retried`, with `table_name = 'promote.clip_posts'`. The fixture branch appends the same
  entries to an in-memory `audit` array on the row. This closes, for this path, the missing-audit
  finding from the 2026-09-16 review.

## 3. Publishing engine (Builder A) — `lib/meta/publish.ts`

`publishClip(s, input): Promise<ClipPost>` creates the row (status `publishing`) and returns it at
once; `runClipPost(id)` does the work and is started detached (`void runClipPost(id)`) the same way
`queueLaunch` starts `executeLaunch`. `retryClipPost(s, id)` re-arms a `failed` row and resumes from
its stored `step`. `tickClipPosts()` is called from the scheduler tick and adopts `publishing` rows whose
`updated_at` is older than ten minutes (a dead process), resuming from `step`.

Facebook (`platform = facebook`):

1. `step = uploading`: read the clip bytes (extract `readClip` from `lib/launch/clip-download.ts` into
   `lib/launch/clip-bytes.ts` and reuse it; 96 MB limit stays), verify SHA-256 equals the row's
   `sha256`, then `transport.upload(`${page_id}/videos`, { description: caption, title: clipLabel },
   { source: file })` using the **Page token**. Persist `external_video_id`, `step = uploaded`.
2. `step = uploaded`: `GET /{video_id}?fields=post_id,permalink_url` (Page token). Persist
   `external_post_id = post_id` (already `pageID_postID`), `permalink`, `step = published`,
   `status = published`, `published_at`.
   If `post_id` is missing, poll up to five times ten seconds apart; still missing → `failed` with
   "Facebook accepted the video but has not created the post yet. Retry in a minute."

Instagram (`platform = instagram`):

1. `step = container`: quota check `GET /{instagram_id}/content_publishing_limit?fields=quota_usage,config`;
   refuse when exhausted. Mint a 15-minute signed URL for the clip (`createSignedUrl(path, 900)`),
   then `POST /{instagram_id}/media { media_type: "REELS", video_url, caption, share_to_feed: true }`.
   Persist `external_video_id = container id`, `step = processing`.
2. `step = processing`: poll `GET /{container}?fields=status_code,status` every five seconds, up to five
   minutes per run (the scheduler resumes later runs). `FINISHED` → `step = publishing`. `ERROR` or
   `EXPIRED` → `failed` with Meta's `status` text in plain language.
3. `step = publishing`: `POST /{instagram_id}/media_publish { creation_id }`. Persist
   `external_post_id = media id`, `step = published`. Then `GET /{media_id}?fields=permalink` for
   `permalink` (a failure here is a note, not a failed post).

Rules that must hold, with a test each:

- Every step is persisted before the next external call; a crash between a create and its persistence
  is closed on retry by the stored id (never a second upload, container or publish). A retry of a row
  with `external_post_id` set does nothing but re-read the permalink.
- A transient Meta error (rate limit, 5xx, timeout, code 1/2/4/17/32/613) leaves the row `publishing`
  at the same step for the scheduler to resume; a permanent refusal (permission, invalid media,
  policy) sets `failed` with the reason. Never treat an ambiguous timeout after a POST as a failure to
  re-issue.
- Page tokens: `liveMetaTransport.forPage(pageId)` returns a transport bound to the Page token fetched
  at that moment; the fake's `forPage` returns itself. No token appears in any error message, log line,
  row or response.
- `dataSource() === "fixture"` never reaches Meta; live POST needs `META_LIVE_WRITES=enabled` (already
  enforced in the transport; do not weaken it).
- Fake (`lib/meta/fake.ts`) models: `{page}?fields=access_token`, `{page}/videos` upload (returns a video
  id; the video's `post_id` becomes `${page}_${n}` after one read), `{video}?fields=post_id`,
  `{ig}/content_publishing_limit`, `{ig}/media` (container `IN_PROGRESS` for two polls then
  `FINISHED`), `{container}?fields=status_code`, `{ig}/media_publish`, `{media}?fields=permalink`,
  `{page}/posts` and `{ig}/media` listings for the "From the Page" tab. `META_FAKE_PUBLISH=ig_error`
  makes the container end in `ERROR`; `META_FAKE_PUBLISH=fb_throttle` makes the first `/videos` upload
  answer a rate-limit error once. Uploads through the fake still verify the SHA-256 they were given.

## 4. Routes (Builder A)

Shape: same-origin guard → role → zod → data layer → `publicJson` (strips `file_path`, `sha256`,
`thumbnail_path`), via `handle()` like `lib/launch/routes.ts`. Add a `clipRoute(req, staff, op, id)`
dispatcher in `lib/launch/clip-routes.ts` and thin route files:

| Staff | Producer | Op |
| --- | --- | --- |
| `GET /api/promote/clips?producer_id&title_id&episode_id&posted` | `GET /api/producer/clips` | `list` → `{ clips: ClipLibraryRow[] }` |
| `POST /api/promote/clips/[clipId]/post` | `POST /api/producer/clips/[clipId]/post` | `post` body `{ platform, connection_id, caption, again? }` → `{ post }` (202) |
| `GET /api/promote/clips/posts/[id]` | `GET /api/producer/clips/posts/[id]` | `get` → `{ post }` |
| `POST /api/promote/clips/posts/[id]/retry` | `POST /api/producer/clips/posts/[id]/retry` | `retry` → `{ post }` |
| `GET /api/promote/launch/meta-posts?connection_id` | `GET /api/producer/launch/meta-posts?connection_id` | `pagePosts` → `{ facebook: MetaPagePost[], instagram: MetaPagePost[] }` (read-only, 25 newest each, through the transport, cached 60 s) |

Roles: `list`, `get`, `pagePosts` need reviewer or any staff; `post` and `retry` need approver or staff
admin. Foreign clip/post/connection → 404. `POST …/post` sets `export const maxDuration = 60`; the work
is detached so the request returns as soon as the row exists.

The existing `GET …/launch/workspace` keeps returning `library`, now with `posts` per item, so the
Launch popup needs no second call for the *Studio clips* tab.

## 5. Screens (Builder B)

### 5.1 Staff Clips tab — `/clips`

Nav (`components/Nav.tsx`): staff order becomes **Clips · Launch · Monitor · Connections · Legacy
campaigns · Titles · Producers**, with Connections linking to `/tiktok` (which gains a tab or section
for Meta so `/meta` is reachable from it; `/meta` itself stays). The producer nav already reads Clips ·
Launch · Monitor; the staff nav must read the same words in the same order.

The page is `components/launch/ClipsTable.tsx` with a `staff` prop, used by `/clips` and by the
producer `/producer/clips` (which loses its current list in favour of this component so the two never
drift). Columns, fixed-width action column, wrapping discipline from `CLAUDE.md`:

preview (poster + play, 9:16 thumbnail) · producer (staff only) · title · episode · hook · duration ·
rendered on · **Facebook** · **Instagram** · actions.

The two platform cells are the state in plain words, one line, never an id: *Not posted* ·
*Publishing…* (with the step in small text) · *Posted · 16 Sep* (the date links to the permalink) ·
*Failed · reason* (with Retry). Filters above the table: producer (staff), title, episode, state
(any / not posted / posted / failed), search on hook. Filters persist in the URL query.

Actions per row: *Post to Facebook*, *Post to Instagram* (disabled with a hint when the producer has
no Meta connection, or no Instagram identity, or the viewer cannot post), *Download*. Both post actions
open one dialog (`components/launch/PostClipDialog.tsx`): connection (auto-selected when there is one),
caption (prefilled per §0, editable, character count), a plain sentence "This publishes a public post
on {Page or account name} now", Confirm. On confirm the row flips to *Publishing…* and the component
polls `GET …/clips/posts/[id]` every three seconds until it settles. Errors render in the row, not in
an alert.

### 5.2 Launch step 3 for Meta — the popup

Replace the bare id box with a *Choose content* button that opens `components/launch/ContentPicker.tsx`
with three tabs:

- **Studio clips** — the selected producer's `ClipLibraryRow`s (from the workspace library) with the
  same two platform cells. Clicking a posted clip adds `{ kind: "facebook_post", value, clip_id, label }`
  and, when Instagram is among the placements and an Instagram post exists, the matching
  `instagram_post` entry. An unposted clip shows the two post buttons inline (same dialog); when the post
  finishes the entry is added automatically. A clip already in the draft shows a check and removes on
  click.
- **From the Page** — `GET …/launch/meta-posts?connection_id` for the selected account: thumbnail,
  caption excerpt, date, platform; click adds it with the excerpt as label.
- **Paste an id** — the existing box and validation, unchanged.

The "N of M supplied" counter, the preview table, the confirm dialog and the monitor content column
show `label` (title · hook) with the id beneath in small text, instead of the raw id. Placements
warning: if the draft holds Instagram content while placements exclude Instagram, show the existing
"Assign … placements" sentence before preview rather than after.

### 5.3 Admin cleanup

- Producer UUIDs on staff screens become names (`workspace.producers` already carries them): the
  on-behalf hint in `LaunchStudio.tsx`, the producer sub-line in `LaunchMonitorV2.tsx`.
- `/promote/monitor` and `/promote/launches` headings match the nav labels.
- `/tiktok` gets a *Meta* section (or tab) that embeds `MetaSetup` so one Connections entry covers both
  providers; `/meta` keeps working.
- CSS only through tokens in `app/globals.css`; new rules go in `app/launch-v2.css`; `app/polish.css`
  stays last in `app/layout.tsx`.
- Locales: new keys in `locales/_keys/clips-posting.json` (both languages; Chinese for the producer
  chrome per `docs/terminology.md`, which gains the new state words: 未发布 / 发布中 / 已发布 / 发布失败),
  then `node scripts/merge-locales.mjs`. No producer-facing English string outside the locale files.

## 6. Tests

Builder A (`tests/clip-posts.test.ts`, `tests/meta-publish.test.ts`, run with the fixture seed):
library filtering and scoping (staff all, producer own, foreign producer filter ignored); authorization
(viewer, reviewer and staff editor refused on post; approver and admin allowed); duplicate published
row refused without `again`; Facebook happy path ends `published` with `pageID_postID` and the fake
saw exactly one upload; Instagram happy path polls to `FINISHED` then publishes once; container `ERROR`
→ `failed` with reason and no `media_publish` call; a crash after `/videos` and before persistence is
closed on retry with no second upload (use `failNext(…, { after: true })`); throttle on `/videos` leaves
the row `publishing` and the scheduler tick completes it; SHA-256 mismatch refuses before any call;
fixture mode never calls the live transport (assert `mode === "fake"`); quota exhausted refuses; audit
entries present. `pagePosts` returns the fake's seeded listings and never a token.

Builder B (`tests/e2e/clips-posting.spec.ts`, fixture server on its own port and dist dir): staff opens
Clips, filters by producer and episode, posts one clip to Facebook, watches the row reach *Posted*,
opens Launch for that producer, chooses the clip from the popup, sees "1 of 1 supplied" and the label in
the preview table and the confirm dialog, and the Instagram cell of an unposted clip says *Not posted*.
Screenshots to `docs/demo/launch-v2/2026-09-16-*-clips-posting*.png` at desktop and presentation widths.

## 7. Docs

`docs/decisions.md` new dated entry (newest first) summarising §0; `CLAUDE.md` boundary bullets for
organic publishing, `promote.clip_posts`, the Page-token rule and the fake's new endpoints;
`docs/tiktok-live-runbook.md` gains a "Posting a clip to Facebook or Instagram" section (scopes,
`META_LIVE_WRITES`, quota, what to check in Business Suite after the first post);
`docs/terminology.md` gains the state words. `.env.example` documents `META_FAKE_PUBLISH`.

## 8. Ownership and sequencing

Builder A owns: `supabase/migrations/0014_clip_posts.sql`, `lib/launch/types.ts` (additions only),
`lib/launch/clip-posts.ts` (may extend), `lib/data/launch.ts`, `lib/data/index.ts` (if the interface
lives there), `lib/launch/clip-bytes.ts`, `lib/launch/clip-download.ts` (refactor to use clip-bytes),
`lib/launch/clip-routes.ts`, all new `app/api/**` route files, `lib/meta/publish.ts`,
`lib/meta/transport.ts` (`forPage`), `lib/meta/fake.ts`, `lib/tiktok/scheduler.ts` (one added call),
`scripts/meta-readiness.mjs`, `app/api/demo/reset/route.ts`, `.env.example`, Builder A's tests, and
the docs in §7 except terminology.

Builder B owns: `components/launch/ClipsTable.tsx`, `PostClipDialog.tsx`, `ContentPicker.tsx`,
`components/launch/ClipsLibrary.tsx` (replace body with ClipsTable), `components/launch/LaunchStudio.tsx`,
`LaunchMonitorV2.tsx`, `LaunchConfirmDialog.tsx`, `components/Nav.tsx`, `components/admin/tiktok/TikTokSetup.tsx`
(Meta section), `app/(admin)/clips/page.tsx`, the two `/promote/*` page headings, `app/launch-v2.css`,
`locales/_keys/clips-posting.json` and the merged `locales/*.json`, `docs/terminology.md`, the e2e spec
and screenshots.

Neither builder edits the other's files. Both build against `lib/launch/clip-posts.ts` and the route
table in §4. B may stub a response shape in a component while A's route is not there yet, but must
remove the stub before finishing. Each builder finishes with `npm run typecheck`, `npx next lint`,
`npm test`; B additionally runs its e2e against a server it starts on port 3213 with
`NEXT_DIST_DIR=.next-clips-e2e` and stops afterwards. Neither commits.

The reviewer runs after both finish: plan conformance, spend and publishing safety (no double post, no
token leak, gates intact), data parity and RLS, UI clarity, and the full verification including the
production build. Fixes go back to the responsible builder by message, not to the reviewer.

## 9. Acceptance (Ruobin, fixture first, then live paused)

1. As staff on `/clips`, filter to a producer and an episode, post one clip to Facebook and one to
   Instagram from the row; both reach *Posted* with a date that links to a permalink.
2. On Launch for that producer, open *Choose content*, pick the posted clip; the counter reads
   1 of 1, the preview names the clip, the confirm dialog names the clip, and the launch is created
   paused.
3. Live: with `META_LIVE_WRITES=enabled` on port 3203, post one clip to Page 1298189526712840; open the
   permalink in Business Suite; then launch it paused and see it in Ads Manager before switching it on.

## 10. Open questions (defaults apply unless Ruobin says otherwise)

1. Facebook Reels as a second post type — not now.
2. Should posting be allowed from the producer portal too, or staff only for the first weeks? Default:
   producer approver may post (same rule as launching).
3. Scheduling posts for later — not now; every post is immediate.
4. Deleting a post from Studio — not now; the row can be marked *again* and Meta's own tools delete.
