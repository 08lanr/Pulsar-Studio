# Launch and Monitor, round 2 — content-aware launch, clean confirm, readable monitor (2026-09-17)

Owner: Ruobin. Executors: three Opus builders (A: launch screen, confirm dialog, plan and Meta
driver; B: monitor; C: test clips seed) and one read-only reviewer, orchestrated by Claude.
`docs/meta-organic-plan.md`, `docs/launch-monitor-plan.md` and `CLAUDE.md` still govern everything
not mentioned here. The yardstick for tone is Pulsar Grow's monitor and overlord's mass launch.

## 0. What Ruobin said, verbatim in spirit

- "If it's a clip the UI needs to update accordingly, versus if it's already a post." The launch
  screen shows Primary text and Headline for every content row; for an existing post they do nothing
  (`lib/meta/driver.ts:106` sends only the post reference and the button). That is a bug: it invites
  copy that is silently dropped.
- "The confirm launch is way too messy. Remove the numbers, the two CrazyDramas-9/31s is too
  repetitive. Just make it a preview of the ads."
- "The monitor tab is ugly. What does launch-dca mean? Let me name the launch. What does Switch
  unknown mean? What is Checking?" And the error he hit must read as a next step, not a code.
- Placements (step 5) is redundant when the content already says which platform each post belongs
  to. It should be derived from the chosen content, and Facebook posts and Instagram posts must not
  share one ad set.
- Campid: "the same as overlord in the mass launch, where we can generate different campids that
  append onto the link." Daily total per campaign must read "optional".
- "Generate some fake clips for Xinghai that I can test on my next launch." His next launch runs on
  port 3203 against Supabase, where `studio.clips` is empty today.

## 1. Decisions (defaults; Ruobin may overrule)

1. **Content decides the platform.** A `facebook_post` is a Facebook ad, an `instagram_post` is an
   Instagram ad, a `video` (uploaded finished clip) can be either or both. The Placements control in
   step 5 is shown only while the draft contains at least one `video` item, and then it governs only
   the clips. Posts never consult it.
2. **One ad set per platform inside a campaign.** A campaign whose content spans both platforms gets
   two ad sets, `facebook` and `instagram`, each with the placement of its platform and holding only
   that platform's ads. A campaign with one platform keeps one ad set. The campaign's signed budget is
   split equally across its ad sets (ad-set-level `lifetime_budget` or `daily_budget`, as today), each
   share at or above Meta's minimum, otherwise preview refuses with "Fix these first". Controls
   (pause, resume, end, budget, daily budget) apply to every ad set of the campaign; the monitor
   aggregates them and lists each group.
3. **Campid works like overlord.** Step 4 gains a *First campid* field (placeholder `rlapple01`).
   Studio stamps one campid per campaign by counting the trailing digits up, zero-padding preserved
   (`rlapple01, rlapple02, …`); a value with no trailing digits gets `01, 02, …` appended. Allowed
   shape `^[a-z0-9][a-z0-9_-]{1,39}$` after lowercasing; unique within the run; unique on the ad
   account (the driver already adopts campaigns by exact name, so before creating it lists the
   account's campaigns and refuses a name that already exists and is not ours). Empty field keeps
   today's derived id. The tracking URL is the destination with `?campid=<value>` (existing
   `trackingUrlForCampaign`), shown per campaign in preview and confirm. Campid is covered by the
   approval hash already; it is editable before approval only.
4. **The Meta campaign name is the campid.** Unchanged. In Studio the campaign is shown as
   "<launch name> · <n>" everywhere, with campid and link on expand or in small text. Nothing in
   Studio leads with `lr_…`, `launch-…-001` or `act_…`.
5. **The launch name is the thing people see.** Step 4's Launch name field stays and defaults to
   "<company> · <date>" rather than "Launch". It can be renamed at any time from the monitor (a pencil
   next to the title, `PUT …/launch/[id]/rename`); Meta objects are never renamed by this.
6. **Confirm dialog = a preview of the ads.** For each campaign: the ad account name and the budget on
   one line, then one card per ad with its thumbnail (9:16 for clips, the post's image for posts), a
   platform badge (Facebook / Instagram), the caption or primary text it will actually carry, and the
   headline when there is one. Below the cards, one small line: campid and the tracking link. Fee line,
   paused sentence, staff note and the two buttons stay. No raw ids anywhere in the dialog. The same
   ad card component renders in step 3's chosen list, the preview table's content cell, and the
   monitor's expanded row, so the four never disagree.
7. **Monitor states are sentences a person would say.** The pill words from
   `docs/launch-monitor-plan.md` §1.3 stand. Two situations that today print "Checking" and "Switch
   unknown" get real words: a launch that has never been swept reads **Not checked yet** with the
   sweep starting automatically within ten seconds of the page opening; a campaign that is created
   but whose switch has not been read yet reads **Created paused on Meta** (or on TikTok) with the
   On/Off pill disabled until the first read. "Switch unknown" and "Checking" are deleted from the
   locale files.
8. **A failed launch tells you what to do.** The row shows Meta's or TikTok's own sentence (the
   transport now includes it) and, when the code is one we recognise, one plain-language hint above
   it with the next step. Known codes live in `lib/launch/provider-errors.ts` (Builder B owns), for
   example: Meta `100/1885183` → "Your Meta app is in Development mode. Switch it to Live in the App
   Dashboard, then press Retry."; Meta `10` → "The app is not allowed to manage this ad account.
   Check the app's Marketing API access and that it is attached to the business."; Meta `190` →
   "The Meta access token has expired or was revoked. Generate a new one and update the server.";
   Meta `100/1885183` and `368`/`1487` families as documented. Unknown codes show only the provider's
   sentence.
9. **Daily total per campaign** is labelled "(optional)" with a one-line hint that the lifetime total
   still caps spend.
10. **Test clips for Xinghai** come from a script, `scripts/seed-test-clips.mjs`, that Ruobin (or the
    orchestrator) runs against Supabase. Rows are clearly named as seed data and removable with one
    flag. The script never touches Meta or TikTok.

## 2. Builder A — launch screen, confirm dialog, plan, Meta driver

Owns: `components/launch/LaunchStudio.tsx`, `components/launch/ContentPicker.tsx`,
`components/launch/LaunchConfirmDialog.tsx`, new `components/launch/AdCard.tsx`,
`components/launch/plan-summary.ts`, `lib/launch/plan.ts`, `lib/launch/types.ts` (additions),
`lib/launch/clip-posts.ts` (additions), `lib/meta/driver.ts`, `lib/meta/fake.ts`, `lib/meta/publish.ts`
(only if the listing needs one more field), `app/launch-v2.css` (append only), new
`locales/_keys/launch-round2.json`, tests `tests/launch-runs.test.ts`, `tests/meta-launch-provider.test.ts`,
new `tests/launch-content-model.test.ts`, and the e2e specs that assert on step 3, step 5 or the
confirm dialog.

### 2.1 Content model on screen

- `AdCard` props: `{ platform: "facebook" | "instagram" | "tiktok"; kind: ContentKind; label: string;
  caption: string | null; headline?: string | null; thumbnail_url: string | null; media_url?: string |
  null; permalink?: string | null; id: string; compact?: boolean }`. Renders thumbnail (video element
  for clips with `media_url`, image for posts; a neutral 9:16 frame when neither), badge, caption,
  headline, and a "Open post" link when `permalink` exists. The id renders only in `title=` and in a
  `<small>` when `compact` is false.
- Post metadata (thumbnail, caption, permalink) comes from the existing `…/launch/meta-posts` listing.
  `ContentPicker` keeps what it fetched in a `Record<id, MetaPagePost>` and reports it up
  (`onPostMeta`). `LaunchStudio` also fetches the listing itself on load when the draft already holds
  post ids for the selected account (the route is cached 60 s server-side), so a reloaded page shows
  previews without opening the picker. Nothing new is stored in the draft.
- Step 3's chosen list: one `AdCard` per item. For `video` items, Primary text and Headline inputs
  sit beside the card. For post items there are no inputs; a single hint under the card reads "This ad
  uses the post's own caption. Edit it on Facebook / Instagram." (localized).
- The counter, the preview table's content cell and the confirm dialog use the same card (compact in
  the table).

### 2.2 Placements and ad sets

- `LaunchDraft.meta_settings.placements` stays as the clips' placement. Derive per campaign in
  `buildPlan`: `LaunchPlanRow` gains `ad_sets: { platform: "facebook" | "instagram"; content: LaunchContent[]; budget_cents: number; daily_budget_cents: number | null }[]`.
  Rules: posts go to their platform; clips go to every platform in `meta_settings.placements`; a
  platform with no content has no ad set; budget split equally across the campaign's ad sets in
  cents with the remainder on the first; each share must satisfy Meta's minimum (use the same
  constant the driver uses; refuse in "Fix these first" otherwise).
- Step 5 shows the Placements control only when `draft.content.some(kind === "video")`; a line under
  step 3 says which platforms the campaign will run on, derived.
- Remove the "Instagram content while placements exclude Instagram" warning; it can no longer occur.
  Keep the Page/Instagram identity check (a campaign with an Instagram ad set needs `instagram_id`).
- Driver: `state.meta` gains `adset_ids: Record<platform, string>` with `adset_id` kept as a legacy
  alias meaning the `facebook` (or only) ad set for runs created before this change. Creation is
  idempotent per platform (`create(ctx, …, "adset/facebook", …)`), ads are created inside their
  platform's ad set, targeting `publisher_platforms` is that platform only. `hierarchy()`, `monitor()`
  (groups list), `activate()`, and every control iterate all ad sets. Budget controls re-split across
  ad sets the same way the plan did. Read-back rules unchanged. Fake models multiple ad sets per
  campaign.

### 2.3 Campid

- `LaunchDraft.campid_start: string | null`. `buildPlan` stamps `campid` per row per §1.3; validation
  errors go into the "Fix these first" list, not thrown one at a time (plan §5.2 of the earlier
  plan asked for this; do it for the whole Meta branch of `buildPlan` while you are there).
- Driver: before `POST /campaigns`, if the campaign is not yet created, list the account's campaigns
  filtered by name and refuse a collision that is not this run's own adoption target.
- Step 4 UI: "First campid" text field with the placeholder, a live line "Campaigns will be named
  rlapple01, rlapple02, rlapple03" as the user types, and the per-campaign link in the preview table.
- Daily total label "(optional)" and hint.

### 2.4 Confirm dialog

Per §1.6. Remove the `content-pick-name` id lines from the dialog. Keep `planSummary`.

### 2.5 Tests (A)

Plan: derived ad sets for post-only, clip-only (both placements), and mixed campaigns; budget split
and minimum refusal; campid stamping (padding, no-digit case, invalid shape, duplicate within run);
"Fix these first" collects all errors. Driver (fake): a mixed campaign creates two ad sets and each ad
lands in its platform's set; a resumed run with legacy `adset_id` still monitors and controls; budget
control re-splits; campid collision on the account is refused before creation; adoption by name still
works. e2e: step 3 shows a post card without text inputs and a clip card with them; step 5 hides
Placements for a post-only draft; confirm dialog shows two ad cards and no `1298189…` string
(assert the id is absent from the dialog's text).

## 3. Builder B — monitor

Owns: `components/launch/LaunchMonitorV2.tsx`, `app/(admin)/promote/monitor/page.tsx`,
`app/(producer)/producer/monitor/page.tsx`, `app/(producer)/producer/launch/[id]/page.tsx`
(if it embeds the monitor), new `lib/launch/provider-errors.ts`, `lib/launch/routes.ts` (add the
`rename` op) and its route files, `lib/data/launch.ts` (add `renameLaunchRun` only),
`lib/launch/service.ts` (monitor snapshot derivation only), new `locales/_keys/monitor-round2.json`,
`docs/terminology.md`, tests `tests/launch-service.test.ts` (additions), new
`tests/provider-errors.test.ts`, and `tests/e2e/monitor-redesign.spec.ts`.

- Card header: the launch name (pencil to rename, inline, saves on Enter/blur, disabled while a
  launch is running), then one grey line "Meta · Xinghai Pictures · Round 1 · Sep 16, 8:26 PM".
  Stats strip as today but never a dash for a known zero; "—" only when the sweep has not run.
- Campaign row: State cell = the On/Off pill (disabled with a tooltip until the switch is read) and
  the delivery word beneath; Campaign cell = "<launch name> · 1" in bold, then the account name, then
  platform badges for the ad sets; the `act_…` id and copy icon move into the expanded row; "2 ads"
  becomes the ad cards (compact) on expand, using Builder A's `AdCard` (B may stub a local minimal
  card if A's file is not there yet and must replace the stub before finishing).
- Expanded row: groups (one per ad set) with platform, status word, budget, bid, ends; the controls
  as today; the campid and tracking link; the account id with copy.
- Errors: a `note-warn` block with the plain-language hint first (from `provider-errors.ts`) and the
  provider's sentence beneath, plus Retry. `provider-errors.ts` exports `explainProviderError(provider,
  message): { hint: string | null; code?: string }` parsing the `(HTTP 400, code 100/1885183)` shape
  the transports now emit; TikTok codes may be added later.
- States: implement §1.7. The "Not checked yet" launch triggers `?force=1` once on mount (the
  existing refresh) and shows a spinner in the Last checked line; "Last checked" prints a real time.
- Locales: delete `lv2.delivery.unknown` ("Checking") and the "Switch unknown" key; add the new
  words in both languages and mirror them in `docs/terminology.md`.
- Tests: `explainProviderError` for each known code and an unknown one; monitor snapshot derivation
  produces "not_checked" before a sweep and "created_paused" for a campaign with objects but no switch
  read; rename allowed for approver/staff admin, refused for viewer, refused while `running`.

## 4. Builder C — test clips for Xinghai

Owns: new `scripts/seed-test-clips.mjs`, a section in `docs/tiktok-live-runbook.md`, nothing else.

- `node scripts/seed-test-clips.mjs --live --producer="Xinghai Pictures" --count=6` creates, under
  that producer, one title named "Studio seed · test drama" (name_zh "测试剧集（种子数据）"),
  one episode, and `count` clips whose rows satisfy the Clips tab's filter: `render_status =
  'rendered'`, `render_path` set, `render_sha256` set, `status` not dismissed, distinct `hook_en`
  values that read like hooks (not ids), `why_en`/`why_zh` filled, `rank` 1..n, `start_ms`/`end_ms`
  from the file's duration, `duration_ms`, `width`, `height`. The video bytes come from the rendered
  fixture files under `.uploads/**/clip-demo-*.mp4` (pick distinct files), uploaded to the
  `studio-media` bucket at `storagePath(titleId, episodeId, filename)` via `putStoredBytes`, SHA-256
  computed on the exact bytes uploaded. Title and episode rows must satisfy every not-null column
  and enum of `core.titles` / `core.episodes` (read `0001_init.sql` and the data layer's `createTitle`
  to learn the minimum viable row; prefer calling the data layer with a staff session over raw inserts
  where a method exists).
- Idempotent: re-running with the same producer reuses the seed title and tops up to `count`.
  `--remove` deletes the seed clips, their storage objects, the episode and the title, and nothing
  else. `--dry-run` prints what it would do. Refuses without `--live`; refuses when
  `DATA_SOURCE` resolves to fixture; never reads `.tokens.json`; never calls Meta or TikTok.
- Verify by running `--dry-run` and, in fixture mode with a temporary `DATA_SOURCE=supabase`
  guard bypass explicitly not allowed, by unit-testing the row builder (`tests/seed-test-clips.test.ts`)
  against the clip filter in `lib/data/launch.ts`. The orchestrator runs the live seed.

## 5. Shared rules

No commits. Edit/Write tools only, never `sed -i`. Never read `.env.local` or `.tokens.json` values,
never `DATA_SOURCE=supabase` in a test, never call Meta or TikTok for real. Every producer-facing
string via `tt()` with a key in the builder's own `_keys` file, both languages, then
`node scripts/merge-locales.mjs`. Colors and spacing via existing tokens. Each builder ends with
`npm run typecheck`, `npx next lint`, `npm test`; A and B also run the e2e specs they touched on a
server they start on their own port (A: 3215, B: 3216) with their own `NEXT_DIST_DIR`, then stop it,
delete the dist dir and remove any `tsconfig.json` include line the build added. Ports 3200, 3201 and
3203 belong to other people.

## 6. Acceptance (Ruobin, fixture on 3200 first, then 3203)

1. Step 3 with one Facebook post and one Instagram post shows two cards with the real images and
   captions, no text boxes, and a line saying the campaign will run on Facebook and Instagram; step 5
   shows no Placements control.
2. Step 4: typing `rlapple01` shows "rlapple01" as the campaign name in preview and the tracking link
   ending `?campid=rlapple01`; daily total reads optional.
3. Confirm dialog shows the account, the budget, the two ad cards and one small campid line; the
   string `1298189526712840` does not appear anywhere in it.
4. Monitor shows the launch by its name, the campaign as "<name> · 1" with Facebook and Instagram
   badges, "Not checked yet" for at most ten seconds, then real states; a failed Meta launch shows a
   hint sentence above Meta's own words and a Retry.
5. On 3203, `/clips` lists the six seed clips under Xinghai with hooks, not ids, and one of them can be
   chosen in Launch as an uploaded clip with Primary text and Headline.
