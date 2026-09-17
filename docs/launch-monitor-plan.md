# Clips → Sparks → Launch → Monitor: the build plan (2026-09-16)

> Historical source plan. The user's subsequent TikTok manual handoff, Meta support and accepted budget contract are recorded in [unified-launch.md](unified-launch.md). Use [launch-acceptance-2026-09-16.md](launch-acceptance-2026-09-16.md) for current acceptance evidence and [production-launch-readiness-2026-09-16.md](production-launch-readiness-2026-09-16.md) for deployment status. Spark entry is in Launch; the old Promote creation journey is retired.

Owner of the decisions: Ruobin. Executor: Astra. Repository: `C:\Users\ruobi\Github\Pulsar-Studio`
(soon under `Pulsar-Workspace`). References you will port from:
`C:\Users\ruobi\Github\overlord` (the operator console; **everything launch-related
mirrors it, including spark ads**) and `C:\Users\ruobi\Github\pulsar` (Pulsar Grow;
the launch *format* and the monitor mirror it). Read `CLAUDE.md`, the top of
`docs/decisions.md` (entries 2026-09-09 and 2026-09-16) and
`docs/tiktok-live-runbook.md` first; every invariant there still holds unless this
plan says otherwise.

## 0. What Ruobin decided (do not re-open)

1. **Three separate areas.** Making the clips, launching, and monitoring are three
   screens with three records. Today one "campaign" does all three, badly.
2. **The ad is a spark post, not an upload.** Studio cuts the angles from the
   episodes (the clip engine, unchanged). Pulsar/the producer uploads those clips to
   TikTok **manually** as posts on a TikTok account and generates a **spark code**
   (Spark Ads authorization) per post. The launch takes spark codes. Studio's engine
   never uploads a video, never makes a cover, never needs a publishing identity:
   the ad is `identity_type: AUTH_CODE` + `tiktok_item_id`, exactly overlord's
   `stepRedeemSparks` → `stepCreateAds`.
3. **Launch = overlord.** The launch screen is overlord's `StepMassLaunch` in shape and
   vocabulary: ad account picker with usage scan and filter chips, ad group settings
   presets, spark codes (unique per campaign / same sparks every campaign), campaign
   settings (campaigns per account, daily budget each, name prefix, live/paused,
   auto-duplicate copies, call to action, campaign cap), **Preview campaigns**, then
   Launch. **Several ad accounts in one launch.**
4. **Launch format = Grow, gated by the producer's approval.** The producer's approver
   approves the launch (its sparks, budget and settings) and presses Launch. Staff may
   launch on a company's behalf from the desk. No staff approval gate.
5. **Destination URL = Pulsar's web app, TBD.** One destination per launch, typed on
   the launch screen and remembered per company as the default. When the web app
   exists, per-campaign tracking links (overlord's step 4, `?campid=`) slot in
   without changing the model.
6. **Brief and results verdict: dropped.** No hypothesis, audience, first batch,
   signal, "what the results say", next-spend decision, benchmarks verdict. Nothing
   of that may block the core.
7. **Rounds stay**: "New round" on a launch = a new launch pre-filled with the same
   sparks, accounts and settings, a new budget, numbered `-r2`, `-r3`, fresh TikTok
   objects. Raising the budget in place remains a control.
8. **Monitor = Grow's LaunchMonitor**, ported as-is: one card per launch, one row per
   TikTok campaign with the On/Off switch, the review verdict, cost, clicks, cost per
   click, conversions, TikTok's note, the actions. **One source of truth:** the sweep
   that renders the row also settles the stored state.
9. Everything already decided on 2026-09-16 stays: the signed budget is the ceiling,
   idempotent/resumable engine with name adoption, controls read back, producers
   manage their own launches, Business Centers link to companies, fixture mode never
   reaches TikTok, tokens never in the data layer.

## 1. The three areas, as the user sees them

### 1.1 Clips (creative making) — `/producer/clips` and `/producer/titles/[id]/clips`

What exists today under "Ad campaigns", cut down to the creative work and the manual
hand-off:

- Per title: the clip engine cuts the angles after upload (unchanged: `lib/clips/*`,
  `scheduleClipCut`). The producer chooses clips, writes the caption/ad text (the
  100-char `adTextOf` stays: it becomes the suggested post caption), and marks each
  clip **Uploaded to TikTok** by pasting its **spark code** next to it (and optionally
  the post URL). A clip with a spark code is a **spark**; the set of sparks per title
  is the **spark library**.
- Download: every chosen clip's finished 9:16 file is downloadable from this page
  (single and "download all as zip"), since the upload to TikTok is manual.
- The record: `promote.campaigns` (an ad set) stays as the grouping of chosen clips
  per title, statuses `draft | generating | review | approved`; the manifest freeze
  stays. `promote.creatives` gains `spark_code text`, `spark_item_id text`,
  `spark_identity_id text`, `spark_status text (none | recorded | redeemed | invalid)`,
  `post_url text`, `posted_at`. A spark code is recorded here and **validated at
  launch** (redemption), never at record time (TikTok only answers per ad account).
- Remove from this area: brief, budget sign-off, launch settings, launch record,
  delivery panel, results, "Simulate demo results", next-round drafting, the render
  checksum gate (`unrendered_creatives` blocker: irrelevant, the file is not sent).
  `lib/tiktok/launch.ts` upload/cover steps go.

### 1.2 Launch — `/producer/launch` (new) and `/producer/launch/[launchId]`

Port `overlord/components/StepMassLaunch.tsx` onto Studio's tokens
(`.rs-panel`, `.filter-chip`, `.seg`, `.gtable`) with `useT()` copy in both locales.
Steps, in overlord's order and wording (`docs/mass-launch.md` in overlord is the
architecture note: *values travel, IDs don't*; sparks are redeemed per account at
launch time):

1. **Which ad accounts?** The company's linked Business Center; its accounts with
   Select all / Clear / ↻ Rescan history; quick pick "first N with nothing active /
   any account"; the filter chips *All · Never launched · Has active · Nothing
   active · Full geo · Limited geo* (no warm-up/sales/leadgen chips); search by name
   or id; each row: name, id, health badge, fingerprint line
   (`○ cold — never launched` / `N campaigns · N on · geo 33/65`). Multi-select.
   Backed by `lib/tiktok/fingerprint.ts`; add `POST /api/producer/tiktok/account-scan`
   scoped to the company's BC (today admin-only).
2. **Ad group settings.** Preset dropdown (`Defaults — US, all ages, lowest cost,
   daily budget` / saved presets / `✎ Customize for this launch…`) opening
   `components/tiktok/LaunchSettingsEditor.tsx` (exists). Keep overlord's
   **⚠ No bid cap** box verbatim.
3. **Spark codes** (overlord step 5, verbatim): the two modes **Unique per campaign**
   / **Same sparks every campaign**, the textarea "Paste all your spark codes — one
   per line", the allocation line "N of M needed (K per campaign × C campaigns) —
   handed out in order". Plus Studio's addition: an **Add from library** picker
   listing the company's recorded sparks by title (thumbnail, caption, code), which
   appends codes to the textarea. Codes are the truth; the library is a convenience.
4. **Destination** (replaces overlord's tracking links for now): one URL, prefilled
   from the company's saved default, required. Note under it: "Per-campaign tracking
   links come when the web app is live."
5. **Campaign settings** (overlord step 6, verbatim fields): *Campaigns per account*,
   *Spark codes per campaign*, *Daily budget ($ each)*, *Campaign name prefix*,
   *Launch state ▶ Live / ⏸ Paused* with overlord's sentences, *Auto-duplicate ad
   groups after approval (0 = off, up to 19)* with overlord's explanation, *Call to
   action* (website set, Watch Now first), **Campaign cap: None / Daily / Lifetime +
   amount**. Studio's rule on top: the approver signs the launch; the sign-off
   records `daily × campaigns` per day and the cap; the engine sends exactly those.
   Keep the 15 % fee line (`lib/promote/fee.ts`).
6. **Preview campaigns** (pure, no TikTok call; overlord's `buildPlan` in
   `lib/mass-launch-plan.ts` ported as `lib/tiktok/plan.ts`): the table
   `# · Campaign · Ad account · Sparks`, the totals line ("up to $X/day across N
   campaigns; cap $Y"), the "Fix these first" list (counts that do not reconcile,
   duplicate codes, no destination, no approver). Then **🚀 Launch N campaigns
   (paused)** / **(LIVE)** behind a confirm.

Approval: the approver presses Launch; a reviewer prepares and sees the button
disabled with "needs the approver role". Staff on the desk (`/promote/launches/[id]`)
get the same screen with a "launching on behalf of <company>" banner, audited.

`/producer/launch/[launchId]` after launch = the launch's own monitor card (§ 1.3)
with **New round** and the launch record (settings summary, sparks, who signed, when).

### 1.3 Monitor — `/producer/monitor` and staff `/promote`

Port `pulsar/components/LaunchMonitor.tsx` as-is onto Studio tokens. Per launch, one
card:

- Header: launch name, "N campaigns · M accounts · K sparks · $X spent ·
  C conversions", the launch's error or note, **Retry** / **Relaunch on another
  account** / **New round** / **End** / **Archive**.
- Table banded *ours* vs *▉ TikTok*: **State** (● On / ○ Off pill that flips; review
  pill under it with per-ad detail on expand; `⚠ account suspended`), **Launch**
  (campaign name, account, launched date, ids on expand), **Cost** (CTR under it),
  **Clicks**, **$/Click**, **Conv.**, **$/Conv**, sweep-error note. Expanded row: the
  ad group(s) with budget, bid, ends, per-group switch, the sparks with their review
  state, and the actions (Change budget, Change daily budget, Set cost cap, Move end
  date, Duplicate).
- Producer sees their company's launches; staff see all with a producer column and
  the same controls plus retry/relaunch. The old three-queue `/promote` goes; change
  requests become a small strip above the monitor.
- The state words, exactly: *In TikTok's review · Delivering · Paused · Off (paused
  on TikTok) · Rejected · Ended · Failed to launch · Account suspended*. From the
  sweep only. `docs/terminology.md` gets the Chinese.

## 2. Data model

New in migration `0013_launches_v2.sql` (idempotent; fixture mirror in
`data/fixture/index.ts` + `lib/data/fixture.ts`; Supabase in `lib/data/supabase.ts`;
both backends equivalent, audited):

```
promote.launch_runs                       -- the Launch (overlord's Job)
  id uuid pk, external_id text ('lr_'), producer_id, name text,
  round int default 1, parent_run_id uuid null,
  status: draft | pending | running | done | failed         (creation lifecycle)
  settings jsonb (LaunchSettings snapshot),
  spark_mode text (unique | shared), spark_codes jsonb (the pasted list, in order),
  sparks_per_campaign int, campaigns_per_account int, advertiser_ids jsonb,
  daily_budget_usd numeric, cap_mode text (none | daily | lifetime), cap_usd numeric null,
  destination_url text, call_to_action text,
  signed_daily_total_usd numeric (daily × campaigns), approved_by, approved_at,
  launched_by, mode (sandbox | production | fake),
  created_by, created_at, started_at, heartbeat_at, finished_at, error text

promote.launch_campaigns                  -- one TikTok campaign (overlord's JobRow)
  id uuid pk, run_id fk, index int, advertiser_id text, name text,
  spark_codes jsonb (this campaign's allocation),
  posts jsonb (redeemed: [{code, item_id, identity_id, item_type, text, creator}]),
  skipped_sparks jsonb ([{code, reason}]),
  tiktok_campaign_id text null, tiktok_adgroup_id text null, ad_ids jsonb ([ad_id] in post order),
  status: pending | running | done | failed,
  delivery: submitted | live | paused | ended | failed | suspended   (set by the sweep),
  status_note text, launched_at, error,
  paused bool, activated_at, duplicated_at, duplicates jsonb ({adgroup_id: [ad_id]}),
  retired_adgroups jsonb, bid_usd, schedule_end
  unique (run_id, index)
```

One ad group per campaign (overlord's shape). `promote.results` rows point at
`launch_campaign_id` + `ad_id` (+ `creative_id` when the spark maps to a library
clip through `spark_item_id`). `promote.launches` (per ad-set, today's table) is
superseded: keep for the demo rows and old data, stop writing it.

`promote.campaigns` (ad sets): statuses used from now on `draft | generating | review
| approved`; drop `experiment` and `launch_settings` from use; `destination_url`
moves to `core.producers.default_destination_url` (company default) and the run.

RLS: producers read their runs/campaigns (`research.is_member_of`); only the
service role writes them; the audit helper records every control.
`core.guard_company_account_write` from 0012 stays.

## 3. Engine, controls, monitor (port overlord's `lib/mass-launch-job.ts` +
`lib/mass-launch-steps.ts`, minus Instant Pages, display cards, Everflow, Smart+, warm-ups)

- **Plan** (`lib/tiktok/plan.ts`): `buildPlan({accounts, sparkCodes, campsPerAccount,
  sparksPerCamp, namePrefix, sharedSparks})` — counts must reconcile exactly, codes
  unique after trim, rows `{index, accountId, campaignName, sparkCodes}`.
- **Run** (`lib/tiktok/launch.ts` → `runLaunchRun(runId)`), per campaign row in
  order, skipping done rows, persisting after every step, name adoption on
  "already exists":
  1. **Redeem sparks** for this row's account: `POST /tt_video/authorize/` per code
     (1100 ms spacing, one QPS retry), then `GET /tt_video/list/` pages (≤ 6) to map
     `auth_code → {item_id, identity_id, item_type, text}`; codes found in the list
     count as redeemed whatever authorize said; codes in neither place are
     `skipped_sparks` with TikTok's reason; **zero redeemed → the row fails before
     any object is created** (overlord's rule: an all-bad-codes row makes nothing).
  2. **Campaign** `POST /campaign/create/` (TRAFFIC, cap from `cap_mode`,
     `operation_status` from launch state; adopt by exact name on collision via
     `/campaign/get/` `filtering: {campaign_name}`).
  3. **Ad group** with `adGroupBody(settings, plan)` (`budget = daily_budget_usd`,
     `BUDGET_MODE_DAY`, or the lifetime share when the settings say lifetime);
     adopt by exact name under the row's campaign.
  4. **Ads**: crash-gap adoption first (`/ad/get/` by adgroup, keyed by
     `tiktok_item_id`), then `POST /ad/create/` with
     `{ad_name, identity_type: "AUTH_CODE", identity_id, tiktok_item_id, ad_format
     (SINGLE_VIDEO | CAROUSEL_ADS), call_to_action, landing_page_url}` (**no ad_text**,
     no video_id); batch first, per-creative fallback with 1100 ms spacing on a batch
     refusal; `ad_ids.length === 0` throws.
  5. Row `done`; the run is `done` when every row is, else `failed` with the first
     error and the list; a retry re-arms failed rows only (`resetFailedRows`).
  Rows are isolated: one failing never stops the others. The fake models
  `/tt_video/authorize/` (empty body on success) and `/tt_video/list/` with
  deterministic item ids per code; `TIKTOK_FAKE_SPARK=reject:<code>` makes one code
  fail.
- **Controls** (`lib/tiktok/controls.ts`): per `launch_campaign` (a TikTok campaign)
  or ad group; same behaviour as today (read-back, remaining budget on cost-cap
  replacement, first-activation enabling groups, planned-group sharing, relaunch
  switches the old campaign off first, copies in the old group's switch state).
  A copy re-creates the spark ads (same identity_id + item_id pair works in the
  copy: authorization is account-level, overlord verified).
- **Auto-duplicate** (`lib/tiktok/autodup.ts`) per row, unchanged semantics.
- **Monitor** (`lib/tiktok/monitor.ts`): runs → campaigns → ad groups → ads, three
  reads per account (campaign/get chunked, review via `/ad/get/` + `/ad/review_info/`,
  report AUCTION_CAMPAIGN / AUCTION_AD chunked), and **settles** `delivery` +
  `status_note` on each row from what it read (the rules of `review.ts`
  `pollCampaignReview` move here; the scheduler tick calls `buildMonitor({force})`).
- **Metrics** (`lib/tiktok/metrics.ts`): per ad; `results.launch_campaign_id`,
  `ad_id`, and `creative_id` when the item id matches a library spark; copy ads map
  by `tiktok_item_id`, never by position.
- **Identity preflight** (`lib/tiktok/preflight.ts`): the "no handle linked" blocker
  goes; spark ads carry their own identity. Account readiness = `STATUS_ENABLE` +
  balance.

## 4. Routes

Producer (`requireProducer`; approver for anything that launches or changes money):
`GET/POST /api/producer/launch` (list, create draft), `PUT /api/producer/launch/[id]`
(steps saved as a draft), `POST /api/producer/launch/[id]/preview` (pure plan),
`POST /api/producer/launch/[id]/launch` (approve + run; `maxDuration 300`),
`POST /api/producer/launch/[id]/round`, `POST /api/producer/launch/[id]/retry`,
`POST /api/producer/launch/[id]/controls` (dispatcher; `launch_campaign_id` /
`adgroup_id` in the body), `GET /api/producer/monitor`, `GET
/api/producer/company/tiktok` (+ scan), `PUT /api/producer/titles/[id]/clips/[clipId]/spark`
(record a spark code / post URL), `GET /api/producer/titles/[id]/clips/[clipId]/download`.
Staff: the same under `/api/promote/launches/…` with `requireStaff`, plus relaunch.
Keep the house shape (`handle`, zod, data layer, same-origin guard).

## 5. Screens to delete or shrink

- `/producer/promote/*` → redirect to `/producer/clips`; catalog board, title shell
  section and `components/producer/PortalHeader.tsx` groups: *My titles* = My catalog ·
  Clips · Launch · Monitor · TikTok performance.
- `components/producer/promote/PromoWorkspace.tsx`: remove Launch, budget slots and
  the angle minimum-budget meter (`lib/angles.ts` budget check is meaningless without
  a per-ad budget); keep choose / ad text / change request; add the spark code field
  and the download.
- `components/tiktok/LaunchSettingsPanel.tsx`, `DeliveryPanel.tsx`,
  `components/producer/research/ExperimentPanel.tsx`: delete when nothing imports
  them. `lib/research/results.ts` verdicts: delete with the results section.
- `components/producer/research/AccountsForm.tsx` under Company & accounts: keep only
  non-TikTok providers; add the **default destination URL** field to the company.
- Catalog board "Ad status" column reads from the monitor: *No sparks · Sparks ready ·
  Delivering · Paused · Ended*.
- Staff `/tiktok`: remove the "identity" column from the probe (no longer required),
  keep everything else (BC link, scan, presets, authorizations, requests).

## 6. Tests

- Keep every current guarantee, re-pointed at runs/campaigns: idempotent creation
  and name adoption, planned-group budget sharing, remaining budget on replacement,
  paused copies, first activation, relaunch switch-off first, suspended-account
  read-back, presets, preferred account (still used to order the account picker).
- New: `buildPlan` reconciliation (counts, uniqueness, shared vs unique); a
  two-account, `campaigns_per_account: 2`, 4 sparks per campaign run creates 4
  campaigns with the right names, budgets and 4 spark ads each; a bad code is
  skipped with its reason and a row with no good code creates nothing; a row
  failing leaves the others done and the run `failed` with the list; retry finishes
  only the failed row; adoption by `tiktok_item_id` after a simulated crash between
  ad create and save; a round creates `round: 2` with the same codes; the monitor
  settles `delivery` per row and never returns a stored state that contradicts the
  sweep (assert the pair on every row); copy ads map to results by item id.
- e2e: make clips on two titles → record spark codes → Launch (two accounts, paused)
  → Monitor shows 2 campaigns Off → turn one On → Delivering after Read again →
  New round. Screenshots under `docs/demo/e2e/`.

## 7. Sequencing (each step leaves `npm test`, typecheck, lint and build green)

1. Data model + fixture + migration 0013 + types; the demo seed builds one run with
   redeemed sparks on two accounts.
2. Plan + engine over runs (spark redemption, isolation, adoption); the old
   per-ad-set engine removed; unit tests re-pointed; the fake's spark endpoints.
3. Controls, autodup, metrics, monitor-settles-state; regression tests green.
4. Routes.
5. Launch screen (steps 1–6), producer and staff.
6. Monitor screen, producer and staff; `/promote` rebuilt.
7. Clips area (spark code field, download), deletions, nav, catalog column,
   redirects, company default destination.
8. Demo seed journey, e2e, locales (`node scripts/merge-locales.mjs`), terminology,
   `docs/decisions.md` entry ("2026-09-1x · Clips, Sparks, Launch, Monitor"),
   CLAUDE.md boundary, runbook (spark-code steps added).

## 8. Acceptance (Ruobin walks this in fixture mode, then live paused)

1. On `/producer/clips` he chooses clips on two titles, downloads them, and records
   a spark code on each, without seeing a budget or a brief.
2. On `/producer/launch` he picks two accounts, a preset with a cost cap, pastes 8
   codes (or adds them from the library), 2 campaigns per account, 2 sparks per
   campaign, daily $20 each, paused, cap lifetime $500, destination the web app URL;
   the preview lists 4 campaigns × 2 sparks and reads "up to $80/day across 4
   campaigns; cap $500"; Launch creates exactly that with everything Off, and the
   fake snapshot / Ads Manager shows spark ads (AUTH_CODE identities), no uploads.
3. On `/producer/monitor` every row says Off; he turns one On; the row reads
   *In TikTok's review* then *Delivering* after Read again, with cost and clicks;
   the pill and the sentence never disagree; staff `/promote` shows the same rows.
4. He changes the budget on one campaign, sets a cost cap on one ad group, ends one
   campaign; each change is visible in the fake snapshot / Ads Manager at once.
5. **New round** produces round 2 with the same sparks on the same accounts and its
   own campaigns.
6. Live: `studio-live`, one account, real spark codes from a real post, paused, then
   one campaign turned on, per `docs/tiktok-live-runbook.md`.

## 9. Open questions for Ruobin (Astra: ask before step 1; otherwise use the default)

1. **Spark allocation default**: unique per campaign (default, overlord's) or the
   same sparks in every campaign?
2. **One ad group per campaign** (default, overlord's) — or one per title when a
   campaign mixes titles?
3. **Who records spark codes**: the producer on the Clips page (default), Pulsar staff
   on the desk, or both?
4. **Destination before the web app exists**: what URL does the first live test
   use? (A placeholder page on crazydramas.com would do; TikTok needs a real link.)

## 10. Things that will bite (learned this week)

- Never run two `next dev` servers on the same `.next`; `studio-fixture-3201` sets
  `NEXT_DIST_DIR=.next-e2e` for a reason. Screenshots and 500s with "reading 'call'"
  are that.
- The repo's TypeScript files are CRLF; edit with the Edit tool or CRLF-aware
  scripts, never `sed -i`, or the diff becomes the whole file.
- The fake TikTok seeds the demo objects only when the process starts; after
  changing the seed, restart the server.
- `.env.local` is `DATA_SOURCE=fixture` + `TIKTOK_MODE=production`: fixture never
  reaches TikTok; real runs use the `studio-live` launch config. Migrations
  0010–0013 go through the Supabase SQL editor (no CLI on the machine).
- Tokens live in `.tokens.json`; never log or return one. The production
  authorization already there reaches two Business Centers (30 accounts in the first:
  13 enabled, 17 limited).
- Spark endpoints (overlord, verified live): `/tt_video/authorize/` returns an
  **empty body** on success; `/tt_video/list/` is the truth; `operation_status` is
  ignored at ad level (a paused launch relies on campaign + ad group); a copy's spark
  ads reuse the same `identity_id` + `item_id` pair (authorization is account-level).
