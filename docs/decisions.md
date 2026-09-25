# Decisions log

Integration note (2026-09-07): the Promote desk migration is `0006_promote_desk.sql`, after the market desk migrations `0004_research.sql` and `0005_watchlist_reports.sql`, to keep migration versions unique. Its column addition remains idempotent.

Integration note (2026-09-24): main's `0020_uploaded_clips.sql` (PR #6, "A finished ad can be uploaded as a clip") landed while the overnight branch had its own 0020, so the series-text migration is `0022_draft_series_text.sql`, after `0021_ad_montage.sql`, to keep migration versions unique. The three are independent and idempotent (the clip source check and timecode guard; the montage moment and pieces; a job kind). The 60-second ad's pick skips a clip of source `upload`: an uploaded ad's file is its own, not a window of the episode it is filed under.

Newest first. A decision here overrides anything older in `PRODUCT.md`,
`docs/build-plan.md`, `docs/data-model.md` or `docs/build-context-review.md`
until those files are brought in line.

## 2026-09-25 · CrazyDramas stats: the playback report on the Playback tab

Ruobin, 2026-09-25: "We're having a lot of drop off between saw the page / episode 1 playing --> finishing episode 1. This doesn't make sense to me, and I suspect it's because of a technical issue? Why is the phone pausing the video 3 times. Why does it take 2.8 seconds? Can we record these things or aggregate these stats? I need to know why users are dropping off, and what issues (e.g. loading) they face." His choices: every episode (not only episode 1), one build with the tabbed dashboard, and a per-viewer drill-down.

crazydramas' player now reports how every episode view went (`playback_summary`, released as crazydramas 3854e94 and 5a18964): the first frame (the landing episode from the tap, in three parts: the page, the player, the video), freezes after the start, the pauses and who made them (the viewer, or the phone with the page on screen), restarts, seconds watched against seconds on screen, the picture rung, the connection, a timeline, and how the view ended. Its report adds them up per source row for episode 1 and the later episodes (`play_ep1`, `play_later`) and lists the latest 60 early endings (`drops`, a 6-character code per browser, never its id).

The Playback tab reads them (`components/admin/cd-stats/Playback.tsx`, `PlaybackSection` in `Sections.tsx`; `earlyExits`, `endFamily`, `landingSplit`, `dropsFor`, `addPlayback` in `stats-summary.ts`), with an Episode 1 / Later episodes switch:
- **Why episode 1 ended early**: one bar split into something went wrong (left before it started, while it was frozen, after the phone paused it, the video failed, or vanished in one of those states), they chose to stop (left while it played, paused and left), and unknown; then every reason with its count.
- **Six numbers**: the first frame, how often it froze (and for how long), how often the phone paused it (and how often with sound on), pages never on screen, left waiting, errors (later episodes: views and hours watched instead of the two landing numbers).
- **Where the start time goes**: page, player, video, on average, for all phones and each phone.
- The first frame and the wait before leaving as histograms; the phones side by side (views, went wrong, first frame, froze, phone paused, sound on, picture, connection).
- **Recent early endings**: the latest 20 under the filters, each opening its timeline in seconds ("1.3 s started · 2.9 s the phone paused it at 1.8 s · ...").

An older report reads as empty; the fake report carries invented playback numbers and early endings. Checks: `tests/crazydramas-stats.test.ts` (the sums, the families, the split, the drill-down's filter, old and fake reports). Checked live (read-only, nothing sent): the watch page reports a 5 s checkpoint and a final "left while it played" with page 0.3 s, player 0.5 s, first frame 1.3 s, 720p on 4G.

## 2026-09-25 · CrazyDramas stats: the dashboard, second cut

Ruobin, 2026-09-25, on the first cut: "completely information overload ... no tabs no nothing ... 50% less text, and words that make more sense or organization ... search up dashboard basics". What analytics dashboards share (Plausible: "six numbers, one chart, and four panels", with depth in tabbed panels; YouTube Studio: a tab per question; the common rules: 4-6 headline numbers with their change against the period before, the most important top left, general to specific, definitions in hover text, a funnel's biggest drop judged in people lost, not percent) became the layout:

- **One filter row** (period, series, phone, source, country) over **tabs**: Overview · Funnel · Playback · Series · Ads · Audience, kept in the address bar (`?tab=`, `?metric=`, `?by=`).
- **Overview**: six headline numbers (visitors, started / finished episode 1, episode 2, buyers, revenue), each with its change against the period before (not shown when that period had under 10: 3 to 300 is not "up 9,900%") and a line of its days; a click on one charts it per day (a one-day range charts two weeks); where people drop (the biggest drop marked); Top, a panel with Series / Phones / Sources / Countries tabs whose rows narrow the page; what is left out in one line.
- **Funnel**: every step with its biggest drop; the groups compared (by phone, source, series or country) as shares of their visitors; why they stop. **Playback**: pages never on screen, no video, waits, first frame, the player's restarts, errors (up is red there), the three timings, by phone. **Series**: one row per series. **Ads**: spend, visitors, cost per visitor and per finisher, then the campaigns. **Audience**: watchers per day, the money, where they're from.
- **The series page** has the same layout: Overview · Episode 1 · Episodes · Playback · Ads.
- Every explanation is an ⓘ tooltip; section subtitles, the definitions panel and the "says" paragraphs are gone. The main page went from 1,989 words (6,219 px tall) to 380 on Overview (1,239 px); the series page from 1,046 to 286. Pieces: `Overview.tsx` (`KpiCard`, `TrendChart`, drawn wide and narrow so a phone's text stays readable), `TopPanel.tsx`, `Sections.tsx` (`HeadlineNumbers`, `PlaybackSection`), `Dash.tsx` (`FunnelChart`, `CompareTable`, `HistView`); sums in `stats-summary.ts` (`prevSpan`, `change`, `MIN_COMPARE`, `chartSpan`, `dailyTotals`, `kpiValue`, `biggestDrop`). The old tiles, path view, "before the video starts" list, breakdown table, daily chart, read line and definitions, and their labels, are gone.

## 2026-09-25 · CrazyDramas stats: where people were

Ruobin, worried that no payments had come through, asked whether there were location stats; there were
none. crazydramas now stamps every event its `/api/events` ingest takes with the viewer's country and
region (Vercel's IP headers, crazydramas `lib/geo.ts`) and splits each source row by the person's first
located place (`country`, `region`: ISO codes, null before 2026-09-25 or unplaced). Studio reads them
(`stats-types.ts`, an older report reads as null), adds a Country filter (`?country=US`, or `none` for
"Not recorded") and a "Where they're from" table on the dashboard: countries, or the picked country's
states (`byPlace`, `countryName`, `regionName` in `stats-summary.ts`). There is no state filter. As with
a phone, By ad hides spend under a country filter (spend is per ad, not per place). No city is recorded.

## 2026-09-25 · CrazyDramas stats: the dashboard

Ruobin, 2026-09-25, after the "opened → played ep 1" drop had to be dug out of the raw events by hand: "i dont see these android / iphone stats, and all these advanced stats. i have to ask you. so why dont u build me a comprehensive dashboard that contains all these things? al these options?" `/crazydramas/stats` is now that dashboard: one page, narrowed by **period, series, kind of phone and source** (any ad, one campaign by Studio's launch name, TikTok's stored copy, no ad), kept in the address bar (`FilterBar.tsx`). Every section below follows the filters: at a glance (landed, saw the page, played / finished episode 1, episode 2, paid), **the path step by step** (landed, saw the page, episode 1 playing, a quarter / half / three quarters / all of it, episodes 2 and 3, the unlock screen, Unlock, paid; each as a share of those who saw the page and of the step before, except the unlock screen, which swipes reach without episode 3), **before the video starts** (pages never on screen, nothing recorded, no video ever played and how long those who left had waited, the player's restarts and how many went on muted, sound refused, errors, and three histograms: the tap to the player on screen, the tap to the first frame, the wait before leaving), **by phone** and **by series** (each ignores its own filter; "only this" narrows the page to a row), by ad (with a phone picked, costs are hidden: spend is per ad, not per phone), and why people stop. The audience, the money and what is not counted (robots by reason, pages never on screen, browsing) are the whole site. The series page's "before the video starts" uses the same pieces.

It all sums crazydramas' source rows (a day × a series × an ad × a kind of phone), which since crazydramas 2f55183 carry every number of the path (`dashRows`, `sumRows`, `dashPath`, `histSummary`, `byDevice`, `dashBy`, `sourceOptions`, `notCounted` in `lib/crazydramas/stats-summary.ts`; `Dash.tsx`). New in the report and read with defaults, so an older crazydramas still parses: `unseen` (the page was never really on screen) and `browsed` (feed or series page only), both no longer in "opened"; the robot rule `link_check` (TikTok opening the ad link itself); `restarted`, `restarted_muted`, `blocked`; the timing histograms over `timing_edges_s`. The fake report fills them all. The old phone table (`deviceTable`, `DeviceTableView`) is gone. Checks: `tests/crazydramas-stats.test.ts` (the filter, the sums, the path, the histograms, the campaign names, the defaults, the fake).

The same day on crazydramas (its own commits, released): the player keeps an episode playing whenever the page is on screen (1b6e913), the stats rules above (2f55183), and the watch page downloads what a phone shows (fddfadf, baabe58: 2 pictures instead of one per episode, video starting at 480p); on a throttled mid-range Android the first frame came at ~4.7 s on 4G (was ~7.5 s) and ~15 s on slow 3G (was 40 s).

## 2026-09-25 · CrazyDramas stats: "By ad" follows the period

Ruobin, 2026-09-25: "the 'by ad' part does not filter by today, last 7 days, the same way that by series does". It showed each ad's whole life whatever the period. Now, on Today · 7 days · 30 days, **By ad** and each series' **Where these viewers came from** count the people who first opened a series in the period (crazydramas' `sources` by day, the rule the series rows follow) and what TikTok charged and counted on the same days; **All** stays each ad's whole life from the launch records. The launch records hold lifetime numbers only, and only as fresh as the Monitor's last look, so the stats pages read TikTok's own days: `lib/tiktok/ad-days.ts` asks TikTok's AUCTION_AD report broken down by `stat_time_day` (spend, impressions, clicks) for every TikTok campaign Studio launched, over the 30 days ending on the stats' last day (TikTok refuses a daily report over more than 30 days), one report per ad account, paged, kept five minutes (Refresh reads again); `deliveryIn` in `lib/crazydramas/stats-summary.ts` sums an ad's days in the period, and an ad of a covered campaign with no day in it spent nothing. When the read fails (a refusal, no connection) it fails soft, in words above the table: an ad whose whole life is in the period keeps its lifetime numbers, any other shows a dash, never a guess. An ad that spent in the period but brought nobody is still a row. TikTok's days are the ad account's time zone: Pulsar Entertainment's (7686288484534599696) is `Etc/GMT+8`, fixed UTC−8, so in summer TikTok's day starts at 1 am Pacific, an hour after the stats' day (said under the section's title). Checked live on 2026-09-25: Today lists the three campaigns launched that day with their spend (the Sep 23 traffic campaign, $0 and nobody today, is not a row), 7 days adds it back at $16.93. Checks: `tests/crazydramas-stats.test.ts` (the periods, the fallback, the day report, the read's window, paging, keep and refusals).

## 2026-09-25 · The launch's title is optional

Ruobin, 2026-09-25, launching two titles in one TikTok launch: "make the step 4 title optional now … it should go with the link each clip has", and "each ad / different title / different link". Every ad already carried its own title's link (decision 2026-09-24); the launch's title was only the default for new ads and the fallback link, yet preview refused a launch without it and stats filed the launch under it even when no ad promoted it. Now step 4 is "Default title for new ads (optional)" with "None: each ad picks its own title". With none, the saved draft has no launch link (`destination_url` ""), the gate (`lib/launch/tiktok-gate.ts`) names any ad without a title, the plan asks for a launch link only when an ad falls back to it or the shape is a Sales Instant Page (one button, so it still needs the launch's title), campaigns carry no `tracking_url`, the driver's pixel check reads each ad's own link, and `runTitleIds` counts the launch's title only when an ad promotes it.

## 2026-09-25 · TikTok ads from Studio clips

Ruobin, 2026-09-25: "I still can't launch automatically on TikTok, the same way I do on Meta?" Until now a TikTok launch took Spark codes only: download a clip, post it in the TikTok app, copy the post's code, paste it into Launch (decision 2026-09-16, "keep TikTok download/post/Spark authorization manual"). Posting from Studio the way Meta does needs TikTok's Accounts API, still in TikTok's review since 2026-09-17. But a read-only check on 2026-09-25 found CrazyDramas' own TikTok account (@crazydramaus, "CrazyDramasUS") linked to the Pulsar Entertainment Business Center on the launch ad account 7686288484534599696 as a `BC_AUTH_TT` identity, AVAILABLE, with `can_push_video` and `can_pull_video` true and `ads_only_mode` on, and its posts readable through `/identity/video/get/`. So, with the scopes Studio already holds, a Studio clip can run as that account with nothing posted by hand. Told that such a clip is shown only as an ad and never on the profile, he answered: "build it, it doesn't matter with me that it doesn't show up on the profile, but I need to know it exists." And mid-build: "put ad previews here [step 3's rows], a singular picture is fine so I know which title to match it to." In plain words:

- **Three kinds of TikTok content.** A **Studio clip** (`video`, as on Meta): the approved file, its SHA-256 checked again on the bytes read, is uploaded to the ad account once (`/file/video/ad/upload/`, recorded per clip in the campaign's `uploads` the moment it lands, so a resumed launch never sends it twice), TikTok's suggested cover becomes its image, and the ad is created under the linked account: `identity_type BC_AUTH_TT`, `identity_authorized_bc_id`, `video_id`, `image_ids`, `ad_text` (the clip's hook unless edited in step 3, on one line, TikTok's 100 characters; the title's name when empty: `tiktokAdText` in `lib/launch/plan.ts`, one rule for the screen, the plan and the driver) and **`dark_post_status: "ON"`** (TikTok's "Show through ads only": it plays in the For You feed under the account's name and picture, never on the profile's grid, with no organic views). A **post of the linked account** (`tiktok_post`, its numeric item id, picked from a list): `BC_AUTH_TT` with its `tiktok_item_id`, no code to copy; it stays on the profile. **Spark codes** are unchanged. One launch may mix all three, in one order everywhere (clips and posts as picked, then the pasted codes: `tiktokOrder`). A clip always promotes its own title (the server ignores a row's other title); a post or a code the title its row names.
- **Which account.** `lib/tiktok/linked-account.ts` lists the ad account's `BC_AUTH_TT` identities and picks the first, by identity id, that allows what the campaign's content needs (uploading clips, using posts): one rule for the preview (`tiktokIdentityGate` in `lib/launch/tiktok-gate.ts`, also run again at approval) and the driver, which records the pick on the campaign before its first write. Preview refuses in words when an ad account has none, when Business Center does not let ads upload to it, or when a chosen post is no longer that account's (deleted, private, another account's); it then says, as the confirm dialog does, "N Studio clips run as @account, shown only as ads (not on the profile)". A launch of Spark codes only reads nothing new.
- **Knowing it exists.** The Monitor names the account each such ad runs as and whether its video stays off the profile, from TikTok's own ad record (`identity_type`, `dark_post_status`, `tiktok_item_id`), links to the post TikTok made for it (it opens for the account's owner, signed in, and nobody else), and gives **every** TikTok ad a **Watch on TikTok** link: TikTok's own preview of the ad (`POST /creative/ads_preview/create/`, `preview_type AD`; a link valid 30 days, kept 20; checked live 2026-09-25 on a Sep 24-r2 ad: it answers `https://ads.tiktok.com/ad_preview_tool?ad_preview_id=…`), through `GET …/launch(es)/<run>/ads/<ad>/preview`, which redirects only for an ad the launch's own record created.
- **A picture per ad in step 3.** Each row shows one picture: the clip itself, the post's cover, or, for a pasted Spark code, the cover of the code's post with its first line and account, read through `/tt_video/info/` (a read: the code is not authorized or used up; checked live 2026-09-25). A code TikTok does not recognise says so on its row, in TikTok's words, before any preview. Codes go in a POST body (`…/launch/spark-previews`), never a URL; the answers are kept ten minutes.
- **The picker.** TikTok's step 3 gets "Choose Studio clips or TikTok posts" (the Meta picker's dialog in a TikTok mode: *Studio clips* and *From @account*); the Spark code box stays below it. "Spark codes per campaign" reads "Ads per campaign".
- **A cover TikTok has not made yet** (the upload is still processing) is a wait, not a failure (`LaunchWaiting`, the campaign stays pending and returns); any other refusal fails with TikTok's words and a retry resumes from the recorded upload.

Unverified until the first real launch, which is created paused and needs Ruobin's OK: that TikTok accepts a `BC_AUTH_TT` + `video_id` ad with `dark_post_status` in a Website purchases ad group on this account, and whether `ads_only_mode` on the identity would also refuse `OFF` (Studio sends `ON` only). The fake (`lib/tiktok/fake.ts`) enforces the documented shape and nothing more. The Accounts API (posting to the profile first, then promoting the post, as on Meta) stays for when TikTok grants it. Checks: `tests/tiktok-studio-clips.test.ts` (end to end through the launch worker: one upload, the cover wait, a changed file, a post, a mix with its links, every refusal in words, a Spark-only launch reads nothing new, the Spark pictures, the preview link) and `tests/e2e/launch-tiktok-clips.spec.ts` (step 3's pictures and a bad code, the picker, preview, confirm, the Monitor and the preview redirect).

## 2026-09-24 · CrazyDramas stats: ads, the team, why viewers leave

Ruobin, 2026-09-24 (late): "can you connect this to the ads?", "clean up the LHS UI, group them in larger buckets", find why people stop in episode 1, benchmark, try an exit survey; and "make sure it doesn't start on mute". His choices: four nav groups, a team email list, survey at both points, and the player changed by us (crazydramas' own commits). In plain words:

- **Ads.** crazydramas' report now splits every group of people by where they came from (`sources`: platform, campaign, TikTok's ad id, or TikTok's stored copy with the ids lost; and the kind of phone). Studio joins it to its launch records by TikTok's ad id (`adSpendsFromRuns`, `adTable` in `lib/crazydramas/stats-summary.ts`): the stats page's **By ad** section and each series' **Where these viewers came from** show, over each ad's whole life, TikTok's spend and clicks beside the real people it brought, episode 1 started / finished, episode 2, paid, and the cost per person, per episode 1 finisher and per episode 2 watcher; the ad with the cheapest episode 1 finishers (3 or more) is marked. Grouped by campaign (Ruobin, later the same night: "add the title it was connected to, and group it by campaign rather than individually, with a drop down sorting option"): one row per TikTok campaign (Studio's launch and campaign names, its ads' numbers summed, costs from the sums) that opens to its ads, a Title column (the series its people opened, most first, "+n more"), and one sort for campaigns and their ads alike: most spent, most people, cheapest per episode 1 finisher, cheapest per episode 2 watcher, most finishers, most episode 2 watchers, newest launch (`campaignTable`, `sortCampaigns`; `CampaignTable.tsx`). The stored copy and "no ad" stay at the bottom; the per-person cost left the table so the two costs that matter fit on screen. The Monitor adds one line under each TikTok ad ("On CrazyDramas: …", `CdAdLine`) from `GET /api/admin/crazydramas/ad-outcomes` (staff, loaded apart so the Monitor never waits on crazydramas). Judge an ad by cost per episode 1 finisher, not per click: on Sep 23's traffic campaign the ad with the highest click-through brought one episode 2 watcher, another brought nine.
- **The team.** A staff administrator keeps the team's emails on the stats page ("Team accounts left out"; `lib/crazydramas/stats-team.ts`, one JSON file in Studio's own storage, `POST /api/admin/crazydramas/stats-team`); the stats read sends them in the body of `POST /api/studio/stats` (a read-only POST: `READ_ONLY_POSTS` in `transport.ts` needs only the read gate), and crazydramas leaves those accounts, their browsers and the browsers they paid from out of every number, counted apart. The kept read is keyed by the list, so a saved list shows at once.
- **Why people stop.** New per series: landed with nothing recorded (TikTok's iPhone browser dropped our events until Sep 24 18:03 PT, so that is a data gap, not a verdict), never had an episode playing (and how long those seen leaving waited), sound on in episode 1, came back another day, videos that failed, the two one-tap questions' answers, and a table by kind of phone. On Android, where tracking was sound, about half of the visitors never had video playing: the first thing to fix, ahead of episode 1's content.
- **The nav.** The staff rail is grouped: Films (Titles, Import films, Segment a film) · CrazyDramas (Series, Stats) · Ads (Clips, Launch, Monitor, Earlier campaigns) · Settings (Connections, Producers).
- **crazydramas' side** (its own commits): the player starts with sound on at 70% volume (iPhones use the phone's volume), with a large "Tap for sound" when a browser refuses sound before a tap; it records leaving the page (seconds, what the video was doing, the position), sound changes, playback errors, and asks once per session why someone paused episode 1 early and what stopped them at the unlock screen.

Benchmarks (research of 2026-09-24): episode 1 completion (48%) is in line with 1–3 minute video (Wistia 2025: 46% watched on average); opening-to-play is in line with paid social (about 65% leave without interacting); there is no public figure for episode 1 → 2 continuation; our prices are 20x or more below ReelShort's.

## 2026-09-24 · CrazyDramas stats

Ruobin, 2026-09-24: crazydramas' admin "Funnel by drama" was confusing ("I don't know what preview start, ep2 reach, etc. mean"), and he wants clean numbers per title (real people landing, how long they stay in episode 1, how many go on to episodes 2 and 3, why so many paywall hits), plus DAU / WAU. Staff only (everything is CrazyDramas now); built in Studio, the crazydramas dashboard stays as it is. In plain words:

- **Where the numbers come from.** crazydramas computes them: `GET /api/studio/stats` (its `docs/STUDIO_API.md`, `apps/web/lib/stats.ts`), read-only, behind the Studio token Studio already holds. Counts only, never a person's id or user agent. Studio reads it through the Studio API transport (`lib/crazydramas/stats.ts`: the fake in fixture mode, the live site in Supabase mode or with `CRAZYDRAMAS_LIVE_READ=1`), parses it with a whitelist (`stats-types.ts`) and keeps it five minutes; the pages add up days with the pure functions in `stats-summary.ts`. No migration, no table: nothing is stored in Studio.
- **Robots are left out.** On 2026-09-24 about 40% of the "landings" on crazydramas were not people: ad-network crawlers that render the whole episode pager at once, so every locked episode "shows" in the same second and each one logged a paywall view (that is why One Night showed 49 paywall views of 50 landings while 8 pressed play). crazydramas' three rules, in `lib/stats.ts`: a known crawler in the user agent; 4+ different locked episodes within 2 seconds; the last episode's unlock screen with nothing played. Every page says how many were left out.
- **People are grouped by the day they first opened a series**, and each step counts what they did since, so every step is a share of "Opened" and the days of a period add up. Per day (DAU, WAU, MAU) people are never added across days; the week and the month are crazydramas' own distinct counts.
- **Words.** Opened · Played ep 1 · Finished ep 1 · Watched ep 2 / ep 3 (at least a quarter: a swipe that flicks past does not count) · Reached paywall (split: after watching the episode before it, or swiped past / picked a locked one from the list) · Tapped Unlock · Paid · Revenue (live money only; All-Access renewals credited to the series that sold the subscription). Days are Pacific time. Test (archived) and `mock-*` series and test payments are left out.
- **Screens.** `/crazydramas/stats` (rail: "CrazyDramas stats"): today / yesterday watchers, WAU, MAU, people watching each day, money, and one row per series. `/crazydramas/stats/<slug>`: the path from opening to paying, episode 1's curve (the share still watching every 15 s, the early drop, when half had left, the average watch time), every episode's audience with the paywall marked, and how people reached the paywall. Periods: Today · 7 days · 30 days · All.

What it showed on its first read (Forced to Marry the Mafia Boss, 2026-09-24): 219 people opened it, 99 pressed play, 30% of those left in the first 15 seconds, 48 finished episode 1, 12 watched episode 2; 12 reached the paywall, 10 of them by swiping past the free episodes. One buyer's visit left no events at all on crazydramas (only the payment): a tracking gap on crazydramas' side, counted on the day they paid.

## 2026-09-24 · Match live shows by episode lengths

Love Between Lines was imported by folder as "Love between lines". It was already live on crazydramas as "Who Are
You When the Game Ends? Season 1" (ep1-31, made in the CMS), and Studio did not know. Studio recognised a live
show only by its name, through the working-name table and the catalog's titles. So the upload page was one click
from creating a second series of the same show and uploading all 54 episodes into it. Ruobin: "make sure this
mistake doesn't exist".

- **The check** (`lib/crazydramas/twin-lengths.ts`): it compares the title's first six episode lengths with the
  first six of every series in the catalog. It is the same show when at least three lengths are within 1.5 s and
  at least 80% of those compared match. Episodes under 30 s are not compared, because a few seconds matches
  anything.
- **At import:** when Studio picks a slug and no name matches, a length match takes that series' slug and links
  the title to it (`assignCrazydramasSlug`).
- **Before creating a series:** `saveSeries` refuses to create one when the lengths match a live series
  (`series_episodes_exist`, nothing sent). While the title's slug may still change, the title is moved onto the
  live series and linked.
- **A hand audit the same day** compared every workspace film and the Desktop folder with all 10 live series.
  Each film matched exactly one series, there were no duplicates, and Love Between Lines was the only one Studio
  had missed. It is now linked and in the working-name table.
- **Limit:** the public catalog lists published series only, so a draft made in the CMS is not seen.
- **The "replace needed" label:** an episode Studio has no upload record for (the CMS put it up) now needs replacing
  only when crazydramas' copy differs. The episode check reading it `same_length` or `identical` means it is the same
  file. Love Between Lines ep1-31 had been flagged for no reason.

## 2026-09-24 · Rename a title, choose its poster

Ruobin, after importing Love Between Lines by folder: "i want to change the title now and i dont know how", and
"pulsar studio should have an upload poster from folder option". Studio had no way to rename a title (`updateTitle`
had no route), and the poster could be set only from the CrazyDramas page, where it went to the series and never
back to the title.

The staff title page now has a **Name and poster** card (`components/admin/TitleDetails.tsx`,
`lib/titles/details.ts`, `PATCH`/`POST /api/admin/titles/[id]/details`, admin only):

- **Rename:** changes `name_en`. The Chinese name changes too when it was the same text, because a folder import
  names both after the folder. While the slug may still change (no series, no upload), it follows the new name,
  or takes the next free slug after it. Once the series exists the slug stays, and the card says why. The title's
  own Studio series is renamed through `setSeriesFields`, a PUT with `title`, which gained the name alongside the
  poster.
- **Choose poster…:** opens the device's file window. The image (JPG, PNG or WebP) becomes the title's cover in the
  local tier, recorded as a film asset. When the series exists, it is normalised, hosted and set as the series'
  poster. With no series yet, "Create series" starts from the cover.
- **A live series:** changes only after "Update CrazyDramas too", because viewers see the change at once
  (`update_live`). Until then Studio's side is saved. A refusal from crazydramas never undoes Studio's side.

## 2026-09-24 · Upload by folder: a folder of finished episodes becomes a title

Ruobin, on Love Between Lines (a narrated remix delivered to `Desktop\Dramas\Love between lines` as ep1.mp4 … ep54.mp4, built outside Studio, so no workspace manifest): "give the upload by folder option." Import films (staff, admin only) has an **Upload by folder** card; the CrazyDramas page links to it.

- **What it reads.** A folder on this computer, by its full path. The episodes are its files named `ep<N>` / `episode <N>` / `<N>` (`.mp4`, `.mov`, `.m4v`, any case, leading zeros allowed); the numbers must run 1..N with no gap and no repeat, or the card says which and nothing is imported. `poster.jpg` / `cover.png` in the folder becomes the title's cover. Nothing else is read: no plan, no index, no transcript (a folder's captions are burned in).
- **What it writes.** A title under `source_ref` `_folders/<folder name as a slug>` (a relative path no workspace project has; the same folder name for the same company updates the same title), and one video-only episode per file with the rows the upload needs: `video_path` in the local tier, `video_sha256`, `video_bytes`, `video_frames` and `duration_ms` from ffprobe on the tier file, `auto_cut` false. Each file is hashed where it lies and **copied** (never hardlinked) into the tier under its hash, only when the tier does not hold those bytes; the copy is hashed again before it is kept. A finished folder may live under OneDrive, which syncs, replaces or makes files online-only, and a link would follow that. A re-run of an unchanged folder copies nothing; a changed file is the only one copied again. The folder itself is never written.
- **Who.** Admin staff only, the listing too: the path is a path on the server's own disk. Producer sessions are refused in `lib/film-import/folder.ts` as well as by the route.
- **After it.** The crazydramas slug is picked as the workspace import picks one (`assignCrazydramasSlug`; no `cut/` folder, so no film-meta is written), then "Upload to CrazyDramas" takes the title unchanged. `lib/film-import/folder.ts`, `app/api/admin/films/folder/route.ts`, `components/admin/FolderImport.tsx`; tests `tests/folder-import.test.ts`.

Choosing the folder: a **Choose folder…** button opens the Windows folder dialog on this computer and
checks the chosen folder at once; pasting the address stays as the fallback. The browser's own
folder picker cannot be used, because it never gives the page the folder's real path, and the import
reads the files from disk. The server (which runs on this computer) opens the dialog through PowerShell
(`lib/film-import/folder-picker.ts`, `POST /api/admin/films/folder/pick`, admin only). It starts in
Desktop\Dramas and closes itself after 10 minutes. It works on Windows only; elsewhere it says to paste the path.

## 2026-09-24 · Two computers, one database: this computer's films folder, runs pinned to a computer, imported films in the cloud

Ruobin's cofounder Andrew runs his own Studio (`npm run dev`, the live `.env.local` and `.tokens.json`) against the same Supabase project. Titles, launches, Monitor and stats were already shared; what was not is everything on a disk. Ruobin's answers: "connect a folder to Pulsar Studio" so Andrew can import and cut films himself, the pipeline is a repo (`08lanr/drama-remix`), and imported films go to Supabase (choice B), "only imported films".

- **This computer** (`lib/computer.ts`). What is true of one computer only lives in `.studio-computer.json` beside package.json (gitignored), never in the database: a generated id (`cmp_` + 16 hex), a name (the host name at first, editable), the films folder, the pipeline's Python, the cloud-copy switch. It is laid over process.env once per process (`ensureComputerSettings`, next to `ensureScheduler` in both portal layouts and the API handler, in `workspaceRoot()` and in the worker script), so every reader of `WORKSPACE_ROOT` / `STUDIO_PIPELINE_PYTHON` is unchanged: the file wins, clearing a value gives the server's own back. `STUDIO_COMPUTER_FILE=off` (the unit test runner) reads and writes nothing and names a fixed computer from the host name; the e2e server has its own file under `.uploads-e2e/`.
- **The "This computer" card** (`components/admin/ThisComputer.tsx`, `/api/admin/computer`, `lib/computer-setup.ts`) on Import films and New film run: rename; connect a films folder in the pipeline's layout, `<root>/projects` beside `<root>/drama-remix` (a picked projects folder is used as it is, a root with `projects/` gives that, an empty or new folder becomes a root, a folder holding other things or inside Studio's own is refused, and Studio proves it can write there; "Make a new one for me" is `~/Pulsar Films`). Download the pipeline = `git clone` of `DRAMA_REMIX_REPO` (default the private `08lanr/drama-remix`) beside the projects folder with the computer's own git sign-in (`GIT_TERMINAL_PROMPT=0`, so a missing sign-in fails in words instead of hanging); Update = `git pull --ff-only`, refused over the pipeline's own uncommitted changes. The readiness checks (films folder, pipeline, git, Python 3.10 or newer, with a working `python3` remembered when `python` is not it; faster-whisper, opencv, numpy; ffmpeg with scdet, delogo and tile; ffprobe; Bash; the vision key) each carry their fix; "Install the Python packages" runs pip itself (a Homebrew or system Python that refuses packages is named). Clone, update and install are one background task at a time whose last lines the card shows. No screen names an env var.
- **Runs belong to a computer.** `createRun` stamps `settings.computer` (validated `{ id, name }`; no migration, settings are jsonb). `runIsHere` (a stamped run: its computer only; an unstamped one: still queued, or its folder is on this disk) gates the worker (`runTick` and `executeRun` skip another computer's run; before this a second computer's worker would claim a run whose folder it lacks and fail it), `decideRun` and `cancelRun` (409, "being cut on <name>; open Studio on that computer"). The run and review pages show another computer's run read-only (`Elsewhere`; the GET answers `stage_view: null, elsewhere`), the list says "on <name>". There were no film runs in the live database, so nothing needed stamping.
- **The worker runs with Studio.** `ensureInProcessWorker` starts in Supabase mode too once the computer has a films folder (and the scheduler's tick keeps it alive), so `npm run dev` is all a computer runs; `scripts/segment-worker.ts` still works beside it (leases keep them off one run).
- **Imported films in the cloud** (`lib/cloud-copy.ts`; `ensureLocalTierFile` and `CloudStore` in `lib/data/storage.ts`). The local tier's files (each imported episode's video, the film assets, a cover in the tier; nothing of the pipeline, sources or work files) are copied to the `studio-media` bucket under the SAME key (`local/<title_id>/ws/<slug>/<file>`), so nothing new is recorded: the rows say what is wanted, the bucket listing what is there. A sweep (every scheduler tick, and after an import finishes; never awaited; one at a time; one file at a time; never overwriting, an existing object counts as done) uploads only what is on this computer's disk. Uploading is this computer's switch, **off until someone turns it on**: the plan could not be read (the dashboard is not signed in here) and the free plan's 1 GB would put the live project at risk; the Pro plan holds 100 GB. A file over the project's size limit (50 MB unless raised) is reported with the largest size and retried hourly or on "Upload now". Reading back is always on: the media route streams the local file or 302s to a signed URL of the cloud copy; clip cutting, the 60-second ad, the CrazyDramas upload and `readStoredBytes` go through `ensureLocalTierFile`, which downloads into this computer's tier, checks the SHA-256 prefix in the file name, then renames into place. The three imported titles are 185 files, 4.62 GB, the largest 47.4 MB (measured read-only against the live project). `listImportedTitles` is new in both backends: `listTitles` reads through the request's cookies and fails in a background sweep.
- **Not covered:** the narrated route stays on Ruobin's PC (NVIDIA GPU, Claude Code, ElevenLabs); the cut-only pipeline has only ever run on Windows, so a Mac is untested; an updated film's old episode files stay in the bucket.

## 2026-09-24 · TikTok pixel ID set by hand

TikTok has not yet approved the Studio app's new Pixel / Measurement scopes, so `/pixel/list/` answers 40001 ("advertiser does not grant you /pixel/list/:GET permission") for ad account 7686288484534599696 (Pulsar Entertainment, Business Center 7686288435216187393), and every Website purchases preview was refused. `/bc/pixel/get/` does answer: that Business Center owns pixel DALLBMJC77U250DBQUR0 "crazydramas.com", whose numeric ID in Events Manager is 7686323395218259976. So a server setting, `TIKTOK_PIXEL_ID` (15–20 digits, not a secret), stands in for the list **only** while the list is refused for want of the permission: `resolvePixel` (`lib/tiktok/pixel.ts`, the one resolution the preview gate, `/tiktok` and the driver share) returns it as ok with relation `UNVERIFIED`, and, when the account's Business Center is known, asks `/bc/pixel/get/` and names the pixel's owner ("confirmed through the Business Center"; still unverified for the numeric ID). Preview, the confirm dialog and the `/tiktok` card say it in plain words, not as a refusal: the ID is set by hand, TikTok can't confirm it yet, the launch uses it anyway, and the first paused launch is the check. The driver records it as unverified and sends it as the ad group's `pixel_id` with the Purchase event exactly as before; until an ad group carries it, it is resolved again on every attempt, so a corrected setting takes effect on Retry. When `/pixel/list/` answers, it wins and the setting is ignored; a setting that names a different ID (there, or in the Business Center's listing) is refused with both numbers, and a setting that is not 15–20 digits is refused by name before anything is read. Without the setting, the permission refusal is unchanged. The fake's pixel carries a well-formed setting as its ID, so a fixture server sharing `.env.local` never contradicts it; `TIKTOK_FAKE_PIXEL=unreadable` answers the live 40001 words and the fake models `/bc/pixel/get/`. No real TikTok write was made. Clear the setting once TikTok approves the scopes.

## 2026-09-24 · The UI sweep

Ruobin's overnight spec, phase 4 (item 17): every staff and producer page walked on a fixture server at 1440 and 390 wide (a crawler following every link, nothing pressed; the import pages and the CrazyDramas page also over the real workspace, read-only), each page's sideways overflow measured, every link fetched (all answer), and every issue fixed in plain words with the existing tokens. The list, page by page with each fix, is the sweep's ISSUES.md in the overnight notes; the rules it left behind:

- **The header.** The hamburger and wordmark are phone-only again (a later rule had shown them beside the sidebar); on a phone the language toggle stays one row.
- **Nothing scrolls the page sideways.** `.sr-only` is anchored left (a hidden column label inside a table that scrolls on its own had made Clips and My catalog scroll at 390); a `video` never runs past its column; the Earlier campaigns page and a film run's page are columns that may shrink. Tables still scroll inside their card.
- **Words, not codes or files.** No page tells the reader to edit a file or set an env var for a routine step (the default ad account, the pack's AI note); film-run decisions and progress are words, not action codes or the worker's bookkeeping; the segment intake's hints are plain sentences; "slug" is 网址 in the Chinese portal; "Refresh delivery" is "Refresh results" (Monitor) or "Read accounts again" (Meta); "Grow campaign" is "TikTok campaign".
- **One place, one name.** `/tiktok` is headed Connections (as the sidebar says) and links to its presets instead of repeating them; Earlier campaigns is headed so; Launch presets points back to Connections; a title's Clips page names its title with a breadcrumb.
- **A title made from videos only** (made in Studio, every episode a video with no script) reads like an imported film: "Videos · N episodes", its episodes, videos, ad clips and cost, with Add episodes kept; its episodes no longer count as staff actions, and the workbench says "Video only: nothing to translate".
- **Empty states say what to do** (Monitor, Segment a film, Instant Page templates), and an empty title results page keeps one Create a launch.
- **Review notes (same day).** A video-only episode's workbench no longer argues with itself: no draft button, no Send to producer, no lines-adapted bar or checks, no status pill, and its empty English column says "Video only: nothing to translate" too. "Slug" reads 网址 in the rest of the Chinese portal (the CrazyDramas section, the slug field and its lock, the unmatched table, the Segment form). No screen names an env var or a file: the pixel line, the stopped background sync, the AI hint, the paywall line and the TikTok sandbox and token lines say it in words. The film-run log labels every decision a run can record (`seg.decision.*` follows `DECISION` in `lib/segment/stages.ts`: `no_logo`, `unmark` and `rejudge` gained labels, three labels for codes that do not exist are gone, and `tests/segment-decision-labels.test.ts` keeps them in step). The film-run page's last jargon is plain words (no command flags, script names or "delogo"), and "Save film meta" reads "Save the film's details". Left: a failed 60-second ad whose own check named the reason (frames, size, length, over 32 MB, ffmpeg or rendering off) still shows that sentence in English on the Chinese page.

No migration. Left as they are, with why, at the end of ISSUES.md (the fixture's demo company and data, `_studio-smoke`, the sidebar's New title, the strip counting Studio launches only).

## 2026-09-24 · The 60-second ad

Ruobin's overnight spec, phase 3 (item 16): per title, "Build a 60 s ad" — a hook, two to four strong scenes and a cliff from the title's own clips, joined into one 9:16 file of at most 60.0 s. The capability, clean rather than clever; Ruobin improves the picking himself. In plain words:

- **The pick** (`lib/clips/montage.ts`, pure, unit-tested). Only what an ad may show: a clip's window stops at the title's spoiler line (`ad_rules.spoiler_from_s`, film time) and steps around its exclusions (the cards film-meta lists); a title without a spoiler line keeps its last fifth of episodes out, as the series text does. The **hook** is the title's opening clip (find_clips' trailer-style tease), else the strongest clip of the earliest episode, cut to its first 8 s. The **cliff** is the strongest clip of the last episode that still has one, cut to its last 10 s (the clip's end is where find_clips closed the moment); when that leaves no room for two scenes, a later window is tried. The **scenes** (two to four) are the strongest clips nearest to evenly spaced points between the two, each from its own start, sharing what hook and cliff leave of the 60 s (up to 20 s each). Clips of one episode often overlap: a window is trimmed to the part no other piece holds, never used twice. No edge cuts through a spoken line when a gap is near (an end inside a line moves back to where it starts, a start inside one moves on to where it ends). Fewer than four separate moments is refused in words, with how many were usable and how many the spoiler line held back.
- **The render** (`lib/clips/montage-render.ts`): one ffmpeg run, each piece its own input seeked 0.3 of a frame before its first frame and trimmed to exactly its frame count (the cut-only pipeline's lesson), framed as every clip is (`frameFilter`: cover a vertical source, keep a landscape one whole over its blurred fill), joined by the concat filter with hard cuts, and **one** loudness pass (loudnorm to -14 LUFS, the mobile-feed target) over the joined sound, which fades out over the last half second; each piece's sound has a 15 ms edge fade so a cut does not click. Nothing is drawn: no text, no poster, no end card (decision 2026-09-22). Whole frames never exceed 60.0 s (the longest scene gives back what rounding added). The file is checked before it is kept: the frame count ffprobe counts must be the plan's, the size 1080×1920; the measured loudness is recorded (a note on the ad when it is more than 2 LU off).
- **The build** (`lib/clips/montage-run.ts`, `POST /api/producer/titles/[id]/montage`): a reviewer or approver of the title, or a staff administrator (the same rule as "Cut clips again"); runs in the background as the system after that check; one `build_montage` job per title at a time, cost 0; the file is named by the pick, so pressing again with the same clips answers the ad that exists, and new clips make a new ad beside the old one. `GET` gives the ads and the build's state (never the job's cost).
- **Where it shows.** The finished ad is a `studio.clips` row of moment `montage` with its `pieces` (migration `0021_ad_montage.sql`: the moment, the `pieces` column, the `build_montage` job kind): it hangs on its hook's episode, ranks from 1001 there and is `shortlisted`, so a re-run of that episode's clips never replaces it and the Materials list and a Promote round leave it out. Because it is a clips row, the **Clips library** lists it first for its title as "Ad · 60 s" with its episodes, Preview and Download (the episode filter finds it under every episode it uses), **Launch** takes it like any clip (a Spark code made from it names its title; a Meta draft sends its file), the Meta posting and the zip download too. The panel sits above the table on the producer's title clips page and above the episodes on the staff title's Ad clips page, with the pieces it joins (hook, scenes, cliff, episode and times) while it builds and on every finished ad.
- **Review notes (same day).** The build beats its heartbeat every 30 seconds for as long as it runs, so a render waiting for a free ffmpeg slot or running long never reads as a dead build that a second press would duplicate. The encode is capped at 3.5 Mbit/s and a finished file over the 32 MB a clip may be for the zip download and the Meta posting is refused before it is kept. A join that fails for a reason the checks do not name shows one plain sentence ("The ad could not be joined from its clips. Press Build again; if it fails twice, tell Pulsar staff.", in the page's language); ffmpeg's own words, which name server paths, stay in the log and the job's output. Two pieces of one episode keep at least 1.5 s between them (`gapMs`), so a scene that starts where another ends no longer counts as a second moment. Two presses at once start one build (the check and the job's record are one step per title on the server, and a build that finds a newer running build of its title stands down; in Supabase mode a second ad finishing at the same moment takes the next rank). A timed-out render says the real limit, and the refusal reads "Usable clips so far: n".

Not done: choosing or swapping the pieces by hand, a vision pass on the joins (the cut-only pipeline's review), and a 4:5 variant. Checks: `npm test` (the pick, the frames, the command line, the row, and the whole build on the fixture film with the real ffmpeg: every piece's first and last frame is the source's own, 1080×1920, -14 LUFS, then the ad in the library, a Spark row and a Meta draft), `npm run typecheck`, `npx next lint`, and `tests/e2e/montage.spec.ts` (the button, the pieces while it builds, the finished ad and its file, the Clips table, a second press).

## 2026-09-24 · The CrazyDramas page, the flow strip, the publish progress

Ruobin's overnight spec, phase 2 (items 10–15): one page for every film and title on its way to crazydramas.com, the imported films labelled as what they are, and the publish made visible step by step. In plain words:

- **One CrazyDramas page** (`/crazydramas`, staff; `/producer/crazydramas`, the company's mirror; both in the sidebar). One row per film or title — every workspace film the scanner sees, every Studio title, and (staff) every series live on crazydramas.com that matches neither — with **In Studio** (not imported / imported · N episodes / made in Studio / not in Studio), **On CrazyDramas** (live · N of N match, made in the CMS / draft · N of N uploaded / not uploaded / not checked yet / check failed), **Episodes**, and **one button for the next step**: Import (runs on the row; staff import for the company picked above the table) → Upload to CrazyDramas (the series form opens in place, under the row) → Publish (its dialog opens at once) → Open on site. A film nobody imported is matched to the live series of its show (its slug, the working-name table, or the same title), so it is one row, not two. Films that cannot be imported yet (rendering, not delivered, a narrated work folder) fold into one **Not ready (n)** line with their reasons. `lib/crazydramas/hub.ts` decides every row (pure `buildHub`, unit-tested) from the recorded snapshots and the upload ledger; nothing is read from crazydramas to draw the page. Staff can **Read CrazyDramas now** (`POST /api/admin/crazydramas/sweep`: the hourly sweep's reads, once, refused for fifteen seconds after the last), so the live series show without waiting an hour. The "Unmatched on CrazyDramas" table left Import films for this page.
- **Import films** folds the same not-ready films into "Not ready (n)"; the narrated work folders no longer head the list, and their reasons are plain words.
- **Imported titles read as imported.** The staff titles list and title page show "Imported · N episodes" and the crazydramas chip for a film that never entered the translation workflow (`usesTranslationWorkflow`: made in Studio, or a line adapted, or an episode past `ingested`); its title page shows episodes, videos, ad clips and cost, and an episode table of length and ad clips, instead of "Ingesting · 0%", "Needs staff action" and "With producer". Titles that use the translation workflow are unchanged. The button to the crazydramas section is named **CrazyDramas**; **Ad clips** and **Ad results** stay.
- **The flow strip** (`lib/titles/flow.ts`, on the staff title page and the producer title overview): Segment → Import → Upload to CrazyDramas → Ad clips → Launch → Stats, each done / next / not yet / not needed, each linking to its page, each with one line of what it is — so "Segment a film" (the series' episodes) and "Ad clips" (short clips for ads) read as the different things they are.
- **Publish shows its progress.** Pressing Publish closes the dialog and the Publish step walks: 1) the episodes, a small batch per call so the count moves ("Publishing episodes… 4 of 12"), 2) the series goes live (its own call, only once every episode went out), 3) the **public** page (`POST /api/titles/[id]/crazydramas/public-check`: the public read a viewer gets, every five seconds for up to 90 s, because crazydramas' public pages trail a publish by up to a minute), 4) **Live** with the link. A refusal is said in words on its step; a public page that is still behind after 90 s says so with Check again. The fake models that cache (`CRAZYDRAMAS_FAKE_PUBLIC_LAG_MS`, 0 by default). The uploads show a bar with counts ("3 of 3 episodes on CrazyDramas · 1 on its way · 2 published").
- **Phase 1 review notes.** A Spark code TikTok never made into an ad counts as observed zero once the per-ad report read the others (a two-title campaign no longer stays "not added in" for good); a Meta campaign with two titles gets its own note, since Meta never reports ads separately. A refused per-ad purchases read lands in `ad_web_error` with its own sentence, and each ad keeps its delivery numbers. The ad rows and the title page show checkouts started (and cost per checkout). The Monitor's By title view shows its Platform filter instead of applying a hidden one; `?view=titles` opens it and the title page's breadcrumb links back to it. The producer title's Ad campaigns section has one Launch button, the header's.

- **Review fixes (same day).** A Studio draft series whose episodes all went out and were published, but which is still a draft ("Also publish the series" left unticked, or its own call failed), gets **Publish the series** as its next step, and the Publish dialog opens for it from the hub, as the section's own Publish button allows. The company's page (`/producer/crazydramas`) matches its films against the live series too, read as the system (`listUnmatchedCrazydramas(…, { titleIds })`: only the company's own titles count as a match, so a series another company's title holds reads live without "made in the CMS"), and says "not checked yet" until CrazyDramas has been read, never "Not on CrazyDramas"; only the staff desk lists the unmatched series as rows. A film whose import is still scanning keeps its progress line and a disabled Import on reload. The not-ready line shows the scanner's first warning; "No manifest" reads "Work folder". The producer title overview's button follows the flow strip's next step when no campaign waits, and US overview's own titles read "Imported · N episodes" for imported films.

- **Second review's notes (same day).** An import already running when the page is drawn (a reload, a second tab) is followed like one started there: its progress line advances and the row becomes the title's row when it settles, the staff desk reading the company each import is for, not the picker's. While an import runs, the row offers nothing but a disabled "Importing…", even once its title exists; an open panel always closes from its row, whatever the next step became under it (after Publish, "Open on site"). A title with no episode video has no next step on the flow strip (no "Ad clips" for a live CMS series with nothing in Studio), and the producer overview's button asks for the videos. An unreachable rule in `titleAction` is gone. The scanner still lists `mini-drama-system/projects/low-quality/_studio-smoke` (the segment smoke test's scratch film, whose underscore slug was allowed on purpose on 2026-09-23) as ready to import: whether that folder can go is Ruobin's call.

No migration and no live call: the page reads Studio's records, and every write it offers goes through the routes that existed (import, series, uploads, publish).

## 2026-09-24 · Upload automation, the review's fixes

The review of the upload automation (2026-09-23 entry below) found six small gaps; each is closed, and the Launch autosave race it could not reproduce is now pinned by a test:

- **A slug is checked before it is kept.** The Segment form's crazydramas slug starts empty unless the film's film-meta names one (it used to start from the folder name, which the import then took unchecked); the import picks one and checks it on crazydramas. A slug typed there is still taken as it is.
- **Another Studio title's slug is taken.** The pick (and a typed slug) treats a slug any other Studio title carries as taken even while crazydramas has no series under it yet (`takenInStudio` in `pickSlug`), so two titles of one name get `x` and `x-2` instead of the second being locked out later.
- **The series text respects the spoiler line.** The draft reads up to the title's own spoiler line (`ad_rules.spoiler_from_s`) when that comes before the 80% mark, and a moved line is a new draft (part of the transcript key). Episodes with neither a film window nor a length count as two minutes each (or up to their last line), so the last episode never lands in the opening the model reads in full.
- **No refusal asks for a file edit.** A title whose slug was changed away from the series it is linked to (held on its link, or its uploads went there) gets **Put the slug back to <slug>** under the locked slug; the slug route takes the link's own slug even while locked. The two refusals point at that button or at staff, never at film-meta.json.
- **The lock says why.** A locked slug shows the section's own reason (uploads in the ledger, a CMS series, a series linked to another title, a published series) instead of one fixed sentence.
- **The autosave race has a test.** `tests/e2e/launch-autosave.spec.ts` holds a draft's first save, edits meanwhile and slows the old page's flush: the new page must show and keep the edit, answer no 409 and preview. It fails on the Launch screen before the phase 6 fix and passes now.

## 2026-09-24 · A title per ad, ad-level stats, stats by title

Ruobin's ad workflow (the overnight spec, phase 1): one TikTok launch may promote several titles, the Monitor says which title each campaign and ad promotes, TikTok's numbers are read per ad, and every title has its own results. In plain words:

- **A title per ad.** In Launch (TikTok), step 3 lists one row per pasted Spark code with its own **Title** (the titles that can be live on crazydramas: a series read as not live is left out, one not checked yet is offered and preview checks it) and, optionally, the **clip** the code was made from (from the Clips library). A new row starts on the launch's title (step 4); changing the launch's title moves the rows that follow it, never a row set to another title or made from a clip; picking a clip sets the row to the clip's title. The row's link — the exact string TikTok receives — is printed beside it. Stored per content item: `title_id`, and `landing_url` = `crazydramasAdUrl(slug)` of that title, **written by the server on save** (never taken from the client) and signed with the draft. The launch's own `title_id` and `destination_url` stay: the default, and the campaign's link (the Instant Page button, rows approved before this).
- **The gate** (`lib/launch/tiktok-gate.ts`) checks the launch's title and every title an ad names, each once (the company's, a real slug, a live series after one fresh read), that each ad carries exactly its title's link (content saved before per-ad titles, with no link, passes on the launch's title), that a picked clip is from the ad's own title ("Ad 2 is made from a clip of X, but it is set to promote Y. Set the ad's title to X, or clear its clip."), and that a **Sales Instant Page** launch promotes one title (its page has one button link). Submit refuses a draft whose per-ad titles or links changed since it was saved. The driver sends each ad its own `landing_page_url` (`adLanding`), macros literal; the pixel check covers every ad's link. Preview shows each ad's title and link; the confirm dialog says "Each ad links to its own title's page" when there is more than one link and prints each under its ad. Meta is unchanged (a Meta ad's title is display only: its clip's).
- **Ad-level stats.** Every sweep also reads TikTok's `AUCTION_AD` report (`dimensions: ["ad_id"]`, spend, impressions, clicks, conversion; CTR and CPC recomputed from the sums), and on Website purchases launches a second per-ad read of the web metrics the campaign already reads (`complete_payment`, `total_complete_payment_rate`, `complete_payment_roas`, `initiate_checkout`, …). Both fail soft (`ad_stats_error`); an ad a successful report does not list delivered nothing yet (observed zero). Stored on `snapshot.ads[].stats` (`lib/tiktok/ad-stats.ts`). The fake answers the lifetime per-ad report, pixel numbers included, and its campaign purchases are now the sum of its ads'.
- **The Monitor** shows the titles on each launch, on every campaign row and under every ad (with the ad's own numbers, TikTok's ad id — the "creative" crazydramas' dashboard lists — and "Open landing page ↗" on the ad's own link), a **Title** filter beside Platform and Status, and a **By title** view: every title with launches, campaigns, ads, cost, clicks, CTR, $/click, purchases, value, ROAS and cost per purchase.
- **Stats by title** (`lib/launch/title-stats.ts`, one pure module every screen reads): a campaign whose every ad promotes the title counts whole (its own complete reading); a campaign that mixes titles counts by its ads' own numbers, and until TikTok has reported them it is counted, not added up, and the page says so. ROAS and cost per purchase divide by the spend of the campaigns that read purchases, never a Traffic campaign's. The title's page — `/promote/monitor/titles/[id]` (staff, linked from the staff title page as "Ad results") and `/producer/monitor/titles/[id]` — shows the totals, every campaign and every ad, and links to **crazydramas' own dashboard** (`https://crazydramas.com/admin/dashboard`, by campaign and creative id) as the second source. The producer title's Ad campaigns section and its TikTok revenue & audience pages, empty for every title without a platform listing, now start with the same totals from the launches; the older rounds show only when a title has any.
- **TikTok setup.** On `/tiktok` the Link to company / Change company / Assign as override form opens directly under the row it belongs to (the Business Center, the ad account or the account request), scrolls into view and takes the focus; Escape closes it. It used to open below the table, off-screen.

No migration: everything lives in the launch run's JSON (`promote.launch_runs.payload`). Nothing was sent to TikTok or crazydramas to build or check this; whether the live `/report/integrated/get/` answers `AUCTION_AD` with the web metrics is confirmed on the first real sweep (it fails soft if not).

## 2026-09-23 · Upload automation: poster, slug, series text

Ruobin's rule, 2026-09-23: "Studio does routine steps itself — never tell the user to edit a JSON file, run Update, or paste SQL for routine work; every routine value gets a sensible automatic default plus an in-page way to change it." Three steps of "Upload to crazydramas" (the entry below) broke it: the poster had to be sent to Jayden for `/posters/<slug>.jpg`, a title without a slug said "add crazydramas_slug to cut/film-meta.json and run Update", and the tagline, description and genres started empty. Now:

- **The poster is Studio's to host.** crazydramas needs a permanent public https URL that answers 200 `image/*`; Studio has no public host, so the poster goes into a **public bucket of Studio's own Supabase project, `public-posters`**, at `<title_external_id>/<sha8>.jpg`, and its public URL (`<SUPABASE_URL>/storage/v1/object/public/public-posters/…`) is what crazydramas gets. The app makes the bucket on first use through the Storage API with the service role (created public when missing, made public when it is not; idempotent; no SQL for anyone). The source — the title's cover (`core.titles.cover_path`) by default, or an image the person picks, uploaded through a Studio route — is normalised with ffmpeg (sharp is not a dependency) to a 1200×1600 JPEG: a straight scale when it is already 3:4, a cover-fit centred crop when it is not, mjpeg q 3 (about quality 85), metadata stripped, bit-exact so the same source always gives the same file and name. On Create / Save Studio stores the poster first, checks the public URL answers 200 `image/jpeg`, and only then sends `poster_url`; a pasted address is still checked and sent as it is. A title with no cover says so and the series is made without one. **Set poster** sets just the poster on an existing Studio series (a PUT with `poster_url` alone; a published series asks for a confirm and sends `update_live`) — Ghostly Night Bus' draft gets its poster that way. Fixture mode never reaches Supabase: the bucket is `.uploads/public-posters/`, served by `GET /api/public-posters/…`, under the made-up `https://studio-fixture.invalid` origin the screens map back to that route. The "send it to Jayden" text is gone.
- **The slug is picked on import.** A film whose film-meta names no `crazydramas_slug` gets one: the show's own slug when crazydramas already has it (the working-name table of STUDIO_API.md, the public catalog by title), else the display title as a slug (lowercase ASCII words joined by hyphens, at most 80 characters) read on crazydramas — 404 is free; 200 with the same title is the show itself, linked read-only by the existing link rules; 200 with another series takes `-2`, `-3`, … until one is free. The slug is saved on the title and written into `cut/film-meta.json` (Studio's one hand-writable file; every other key kept in its place; nothing else in the folder touched). crazydramas not answering is a warning on the import, never a failure, and the upload form picks one when it opens, saying so with Retry. The form shows the slug editable until the draft series exists (a typed slug is checked the same way; one another series has comes back with the next free one), then locked with the reason: ad links depend on it.
- **The series text is drafted.** Opening the form for a title with no Studio series drafts the tagline (at most 80 characters, the catalog's voice: "A debt. A contract. A vow she can't break."), the description (2–4 sentences, premise, stakes and a hint, never the ending) and 1–3 genres (the catalog's words first) from the film's transcript — its first 15 minutes and a sample of the rest, **never the last 20% of the film** — on `ADS_TEXT_PROVIDER`'s fast tier, as a `studio.jobs` row (`draft_series_text`, migration 0022) with its cost, validated with zod, idempotent per title and transcript; "Draft again" is the next attempt. Fields a person already filled are kept. Demo replay answers a canned draft; with no model key the fields stay empty with a one-line note.

**What needs a live step.** The bucket is created on the first live poster (nothing to run beforehand; the service role has the Storage permission it needs). Migration 0022 (numbered 0020 until main's `0020_uploaded_clips.sql` took the number) adds the `draft_series_text` job kind and waits, with 0015–0019, for Ruobin's OK on the production database; until then a live draft fails at its job row and the form says so in words. The live check of the bucket's public URL goes through the poster check's rule (https, a named host whose every address is public), which the Supabase project URL meets.

How it works — the routes, the refusals, the fixture stand-ins — is in `docs/crazydramas-connection.md`, "Upload automation".

## 2026-09-23 · TikTok launch: crazydramas link contract + pixel + one account

Ruobin, 2026-09-23: "in studio's launch capabilities, can you update it so that it matches these parameters? and also use this tiktok pixel. We'll be primarily launching out of one tiktok account for now." This lands the pixel phase the 2026-09-22 entry (below) scheduled, and replaces that entry's "Landing URL signing rule" (a URL built from Studio's own ad group and clip ids): TikTok fills its own ids in, so Studio never builds them. In plain words:

- **The link.** Every TikTok website ad (Website purchases and Traffic) goes to `https://crazydramas.com/watch/<slug>?source=tiktok&campaign=__CAMPAIGN_ID__&adgroup=__AID__&creative=__CID__`, built by one pure function, `crazydramasAdUrl(slug)` in `lib/tiktok/ad-url.ts`. The three macros are TikTok's own (campaign id, ad group id, ad id; the `utm_params` macro list of `/ad/create/`, https://business-api.tiktok.com/portal/docs?id=1739953377508354, and ads.tiktok.com/help/article/track-offsite-web-events-with-utm-parameters) and are sent literally: never Studio's ids, never URL-encoded, nothing appended, `campid` included — crazydramas' attribution contract (its README and `packages/shared/src/attribution.ts`) reads `source`, `campaign`, `adgroup`, `creative` and `ttclid` and ignores `campid`. The `campid` still names each TikTok campaign; Studio maps results by the ids its launch records hold, never by reading the URL back. Upgraded Smart+ campaigns name the ad `__ADID_V2__` and `__CID__` is then not the ad id; Studio does not create Smart+ campaigns.
- **The title decides the link.** A TikTok draft names the title it promotes (`title_id`); the Launch screen lists the company's titles that have a crazydramas slug and prints the exact link TikTok will receive, macros and all, with one line on what they become — on the screen and in the confirm dialog. The server writes the link into the draft on save (a typed URL never reaches TikTok) and the approver signs it. Preview and approval refuse a TikTok draft with no title, a title with no slug, a `mock-` slug or one that is not lowercase words, and a series that is not live by the phase 3a reading (a title that does not read live gets one fresh public check first, as Check now does). The Sales Instant Page keeps its own rule — its button links to the same four-parameter link plus the campaign's `campid`, which the page builder requires.
- **The pixel.** `DALLBMJC77U250DBQUR0`, the pixel crazydramas.com loads (public). Server setting `TIKTOK_PIXEL_CODE`; blank means this code; `.env.local` sets it. The numeric `pixel_id` an ad group needs is resolved per ad account with `GET /open_api/v1.3/pixel/list/?advertiser_id=…&code=…` (read-only, https://business-api.tiktok.com/portal/docs?id=1740858697598978) at preview, and again by the driver before any TikTok write (the Spark authorizations included), then recorded on the campaign. A pixel the account does not list, or lists as `UNBOUND`, refuses the launch with "the pixel isn't shared with this ad account in Business Center". The code is stamped into the signed draft, so a changed setting is a new approval, never a silent swap. Studio sends no events and holds no Events API token: crazydramas.com sends the browser and server events itself.
- **Website purchases, the new TikTok default.** Campaign `objective_type` WEB_CONVERSIONS with `virtual_objective_type` SALES and `sales_destination` WEBSITE (campaign/create, docs?id=1739318962329602; the objectives page, docs?id=1737585562434561). Ad group (`/adgroup/create/`, docs?id=1739499616346114): `promotion_type` WEBSITE with no `promotion_website_type` (TIKTOK_NATIVE_PAGE refuses `pixel_id`), `optimization_goal` CONVERT, `billing_event` OCPM (the goal → billing table), `pixel_id`, `optimization_event` SHOPPING — the web Purchase event (Supported Pixel events, docs?id=1739585696931842) — with INITIATE_ORDER (InitiateCheckout) as the selectable fallback, and `click_attribution_window` SEVEN_DAYS + `view_attribution_window` ONE_DAY sent explicitly because they can never change after create (allowed values for WEB_CONVERSIONS + WEBSITE + CONVERT: docs?id=1777694366654465), `attribution_event_count` EVERY for Purchase and ONCE for InitiateCheckout (TikTok's Help Center maps "Every" to purchase optimization). Lowest cost, $30 a day per ad group (TikTok's advice for a new web-conversion ad group; the $20 floor is unchanged), US, TikTok placement, comments off, no copies while it learns, starts paused. Every ad carries the link as `landing_page_url`. `tracking_pixel_id` is not sent on the ad: the ad group's `pixel_id` already attributes, and the doc types that field as a number, which a 19-digit id cannot survive in JSON. Traffic and the Sales Instant Page keep working as they were (Traffic now links to the crazydramas link too); an existing ad group is adopted only when its pixel and event match the approval as well as its budget.
- **The monitor.** A Website purchases campaign also reads TikTok-attributed website conversions in a second report call that fails soft (`complete_payment`, `cost_per_complete_payment`, `total_complete_payment_rate` — the purchase VALUE despite its name — `complete_payment_roas`, `initiate_checkout`, `cost_per_initiate_checkout`; "Basic report supported metrics", docs?id=1751443967255553). The monitor labels them "TikTok-attributed" with the attribution windows; they are TikTok's attribution, not crazydramas' click_id funnel, and the two will not match.
- **One account.** `TIKTOK_DEFAULT_ADVERTISER_ID` names the ad account launches start on (not `TIKTOK_ADVERTISER_ID`, which is the sandbox token's account). Launch preselects it for any company whose staff-assigned Business Center (or assigned account) reaches it, so a one-account setup needs no click; else the company's preferred account, else its only one. It never makes an account a launch account by itself: the per-company Business Center model stays as it was. Staff `/tiktok` shows the default account, the companies whose assignment reaches it, and the pixel read on it.
- **Meta is unchanged.** Meta's own dynamic URL parameters (`{{campaign.id}}`, `{{adset.id}}`, `{{ad.id}}`) exist, but Meta's Help Center documents them for the Ads Manager "URL parameters" field (the API's `url_tags`), whose API description names page post ads only and says nothing of dynamic values or Instagram-media creatives. That does not confirm them for every creative Studio makes, so Meta keeps its `campid` link; a Meta click still reaches crazydramas without `source`, and crazydramas records it as organic.

**Unverified until the first real launch** (created paused and checked, with Ruobin's explicit OK; not part of this build): whether TikTok accepts a Spark (AUTH_CODE) ad with `landing_page_url` in a pixel-optimized website ad group (no TikTok page states the combination; the fake enforces every documented rule and nothing more); whether TikTok substitutes the macros inside a Spark ad's landing URL and inside an Instant Page button link; whether the live `/report/integrated/get/` accepts the web metric names; whether the TikTok developer app's scopes cover `/pixel/list/` (answered 2026-09-23 by a read-only check: they do not. The stored authorization, scopes 1, 2, 4 and 6, reads `advertiser/info/` for 7661702138107822098 but gets 40001 on `/pixel/list/`, so the pixel permission has to be added to the app in the TikTok developer portal and the connection reconnected before a Website purchases preview can pass; until then launches use Traffic. The refusal says this in words); and which Business Center owns the pixel and whether it is shared with the launch account.

## 2026-09-23 · Upload to crazydramas

Ruobin, 2026-09-23: "yeah lets do it. thats what i want to build." The crazydramas side is live — its Studio API (PR #1, merged into crazydramas `main` with Jayden's two follow-ups: series ownership and product ids, and the title guard) — and its contract, crazydramas' `docs/STUDIO_API.md`, is what Studio follows. The defaults below were chosen for him from the phase 5 spec; he can change any of them. In plain words:

- **Where.** The title's crazydramas section gets "Upload to crazydramas": a series details form filled from the title (display title, tagline, description, genres, language, five free episodes, $9.99, the IAP id `cd.series.<short_name>` from the slug, the poster), **Create draft series**, **Upload episodes** (all, or a chosen range, in the background with per-episode progress) and **Publish** with an explicit episode list. The Import page gets a row action for titles not yet on crazydramas; staff get the same on the admin side.
- **Draft first, publish explicitly.** Uploading never publishes. Publish shows exactly which episodes go live.
- **Paid episodes.** Everything uploads as a draft. Publishing an episode past the free count warns that paid episodes can be streamed free until the paywall fix is live on crazydramas, and needs an extra confirm — until `CRAZYDRAMAS_PAYWALL_LIVE=1` is set.
- **Poster.** Optional. The suggestion is `https://crazydramas.com/posters/<slug>.jpg` (Jayden commits the posters there); Studio checks the address answers with an image before sending it and shows the title's own cover as a preview to send to Jayden. No new hosting.
- **The series already live** (all eight were made in the CMS) are shown read-only: "made in the CMS — ask Jayden to hand it over (one SQL line) to manage it from Studio". Studio never tries to write to them. Before creating a series Studio also checks the show is not already live under another name (the contract's working-name table and the public catalog).
- **Live writes need both switches.** Real writes need `DATA_SOURCE=supabase` and `CRAZYDRAMAS_LIVE_WRITES=enabled` (and `CRAZYDRAMAS_STUDIO_TOKEN`), as with Meta and TikTok. Fixture mode talks to a fake crazydramas that models every route, every error code and the Mux upload. `CRAZYDRAMAS_LIVE_READ=1` still lets an engineer read the live site from fixture mode — and write nowhere.
- **Reads upgrade.** With the token, the phase 3a status reads use the authenticated series read, so "not live" can say "not uploaded" or "draft"; without it, the public read stands in.
- **The ledger.** Every upload is recorded step by step before the next call (`studio.cd_publications`, migration 0019): planned → upload created → bytes sent → asset ready → verified → published, or failed / superseded. The uploader survives a crash: it picks the row up where it stopped, asks for the upload it already made instead of making a second one, and sends bytes from where Mux says it got to. Bytes come only from Studio's local-tier link of the file. One upload at a time per title, at most two on the machine.
- **Verify before publish.** Once Mux has the file, its length must pass the frame rule against the episode's own frame count and Mux's `external_id` must be the file's SHA-256; if not, the episode is marked failed with the reason and is never published. The frame rule is still calibrated on one film: the first Studio-made upload is where it is confirmed.
- **Replace** (a re-cut) uses the contract's replace path, only while the crazydramas episode is ready or errored, after the viewer warning (the old cut plays until the new one is ready; watch positions then refer to the old timing). The old asset is recorded, never deleted.
- **No rights gate. No push. No change to crazydramas.** Studio code only; **no real write to crazydramas in this phase** — the first real upload happens when Ruobin says go, on a series he names.

**Open item for Ruobin.** The live Studio Supabase is missing migrations 0015–0018 (checked read-only with the service role on 2026-09-23: the film-import columns, `studio.film_assets`, `studio.film_runs`, `core.platform_links`, `core.platform_snapshots` and `studio.film_run_episodes` are absent; 0014 is there), and 0019 is new. Real uploads need live mode and those migrations applied — a production database change that needs his OK.

How it works — the flow, the uploader's steps, the gates and what it never does — is in `docs/crazydramas-connection.md`, "Upload to crazydramas"; the table in `docs/data-model.md` section 11.

## 2026-09-23 · Narrated mode in Studio

Ruobin, 2026-09-23, on the narrated plan (`narrated-spec.md` N0–N11): the high-quality skip-through route (narration, kept dialogue, captions, the 9:16 reframe; `mini-drama-system/drama-remix/scripts/skip-through/`) runs from Studio the way the cut-only route does. His decisions, in plain words:

- **Studio starts the Claude Code session itself.** The writing steps — reading the source's script, preparing each episode, writing the narration — stay with Claude Code on Opus, but Studio launches the session in the film folder with the brief as the prompt, follows it, and picks it up again where it stopped after a usage limit or an interruption. Nobody copies a command. The old hand-off stays as a fallback button, "Run it yourself in Claude Code", for when a session is limited or a person prefers it.
- **Four approvals block, and nothing is spent before the third.** The script; the episode breaks; each episode's decide list together with reading its transcript end to end — no voice and no GPU work starts before that approval (today the GPU started before Ruobin answered); and the final watch before the import.
- **New sources only.** Studio drives the next source after S01E04 and later ones, under `projects/high-quality/<slug>/`, with the earlier episodes linked in read-only. lbl-e03 and lbl-e04 stay with the session that is working on them; lbl-e02 is used only as a replay copy for calibration.
- **Import into the existing Love Between Lines title**, numbering continued. **No rights or licence gate anywhere** (rights are settled: he owns the films) and no automatic OneDrive copy from a Studio build.

**The launcher and the billing rule.** `lib/claude-session.ts` runs a headless session through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, which carries its own Claude Code binary; installed with an npm override so its zod peer resolves to ours — it bundles its own), with `claude -p --output-format stream-json` as the fallback; the flag names were read off the installed SDK's typings and its binary's `--help`, and the CLI path is untested because this machine has no `claude` on PATH. With neither, the stage says "Claude Code CLI not installed — install it, then Retry" and waits; it never crashes. **A writing session runs on the Claude subscription, never on the API key**: its environment is built from an allow-list (the pipeline steps' basics, the Jev key, Claude Code's config folder and Git Bash path, the proxy settings), so no `ANTHROPIC_*` variable, no service secret of Studio's, no `ELEVENLABS_API_KEY` (the brief forbids voice) and none of the `CLAUDECODE` / `CLAUDE_CODE_*` variables a parent desktop session hands a dev server started from it reaches the session; a session whose init reports a key source other than the subscription login is stopped as failed; and its job row carries no cost. Only the three picture checks — the minute-sheet read, the frame check of every narration line, the join check of every skip — call the API with the key, on the frame judge's model (`claude-opus-5-5`, `tool_choice` auto), through the drama-remix `*.workflow.js` prompts (one source of truth), at most two calls at once, and their answers enter a project only through the pipeline's own recorders. **One writing session at a time on the machine**, by a lock file with the heavy lock's rules. Every session's events go to a log in the run's work folder and its id is kept, so a resume is the same conversation.

**What else is settled.** The prep brief is read from drama-remix's committed `scripts/skip-through/PREP-BRIEF.md` every time and filled from the rows — never copied into Studio. Studio may run the canonical skip-through scripts, as jobs, only inside a film folder it created, from the film root, under `<film>/.studio-run.json`. The data model is migration 0018 (`studio.film_run_episodes`: two lanes per episode with their own lease; the job kinds `sheet_read`, `frame_verify`, `cut_verify`, `tts_line`, `jev_check`, `claude_session`; the narrated asset kinds). The files Studio writes into a project are a short list, each through one writer that snapshots first and records who and why. A waiver switches a check off, so it is the person's: the waivers a prep session writes itself (the brief tells it to) are taken back into proposals and the file restored, and at the prep review each is accepted or refused — a refused one is removed whoever wrote it. Every paid voice line is a job row and a line in the project's `credits-ledger.json`. The delivery is `DELIVERED-narrated.json`, which the scanner now reads. The stages, the waits, the files, the launcher and the billing rule are in `docs/segment-a-film.md`, "Narrated mode".

**The second review's fixes, same day.** (1) A prep's "before" is taken when its session really starts — never before a busy slot — and whenever another episode's session stops or its checks end, what it did inside its own window and files is laid into every pending snapshot, so an episode that waited through a limit is never refused for a neighbour's cue fixes and told to restore them from its own backup. (2) Only make_ep's refusal resumes a prep on its own (`prep_auto_retry`); a W-id refusal, a drift, a failed session or an unfillable brief waits for a person, and `retry` with `accept_index` takes the whisper rows as they are. (3) Every intake answer folds, oldest first, so the budget the voice lane asks to raise never drops the season, the premise or the brief — and with them the import into the season's title. (4) The synced `scripts/` is re-hashed against its sync record before anything runs from it or is compiled in Studio's process, and a session's write there is flagged like any other. (5) The intake syncs before it places the source or links the season, the build runs under the film's `.lock`, a build refusal consumes the Retry that woke it (it rebuilt for ever), and the delivery's unwaived counts are the recorders' own status, run at the hand-off.

## 2026-09-23 · The frame judge on Claude, measured

Phase 2.3: the Claude arms of the calibration bar ("The frame judge, second pass", below), run the day `ANTHROPIC_WORKSPACE_ID` reached `.env.local` beside the key and `scripts/anthropic-probe.ts` went green on `claude-sonnet-5`, `claude-opus-5` and `claude-opus-5-5`. He Hated All Women, boundaries 1–20 and 21–40, against the delivered cuts at ±0.2 s, the production arm every time (dense strips, annotated strips, film notes, the tie-break on, the card spans NOT in the prompt). Spend $12.09 by the job rows, $10.05–12.09 exact (each of the 204 rows rounds up to the cent), of a cap of about $45. The film folder was read-only and is byte-for-byte what it was.

**The probe's finding, confirmed by the runs: a FORCED tool call skips the thinking.** Under `tool_choice: {type: "tool"}` Sonnet 5 thought first on 0 of 40 turns; under `auto` plus "Answer only by calling <tool>." on 41 of 41. Opus 5.5 refuses a forced call and thought first on 59 of 82 turns.

**Per arm** (applied agreement = the cut `apply_vision.py` applies after the guarded skeptic, within 0.2 s of the delivered cut; the bar wants 15/20 on 1–20 and 14/20 on 21–40):

- **`claude-opus-5-5`** (auto is its only mode): 1–20 **16/20** (the reviewer alone 16; the skeptic agreed on all 20), 21–40 **17/20** (the reviewer alone 16; the skeptic helped once, at 3276.333, where the tie-break took its 3278.3 — the first frame after the source's card and not a listed option). Bad overrides 0. Person reviews 1 and 2, so 3 per 40; only 1 wrong cut in 40 went through unflagged. Hard-rule failures 2 on 1–20, and they are one pair: 640.733 (the delivered cut) then 729.633 (the first frame after the source's own card), an 88.9 s episode — each right on its own, together under the 95–150 s band, which is what the band-fix stage exists for and what the eval scored raw. Card boundaries 9/9 and 7/8 (the miss at 4313.4: the right cut, 4316.967, is no listed option; Opus's pick at confidence 0.4 went to a person). $2.93 + $3.17, $0.147 and $0.159 per boundary; wall 265 and 294 s.
- **`claude-sonnet-5`, `tool_choice` auto:** 1–20 **14/20** (the reviewer alone 14), 21–40 **12/20** (the reviewer alone 13). Bad overrides 1 (3983.433: the reviewer matched the delivered cut, the skeptic and the tie-break called a document handed between two men "a grab/pass action" and moved it). Person reviews 2 and 2 — and 8 wrong cuts in 40 went through unflagged, which is why it cannot be the pass. Card boundaries 9/9 and 6/8. $2.05 + $2.19, $0.102 and $0.110 per boundary; wall 459 and 456 s.
- **`claude-sonnet-5`, forced tool** (1–20 only): **14/20**, no thinking at all, $1.62, $0.081 per boundary, wall 274 s. On this sample the thinking bought Sonnet nothing measurable (14 = 14) for about 27% more cost and 68% more wall time.
- **`deepseek-flash`**, on record from phase 2.1: 10–12/20 and 6–7/20, about $0.02 per boundary.

**Judged by eye from the annotated strips.** Opus 5.5's seven misses: the delivered cut right at three (1209.033, the reveal "You have a child" against a cut after "You're hired"; 2785.5, a cut inside the scuffle; 4313.4, the card buried 18 s inside the episode — two of the three went to a person), both defensible or the API right on the frames at four (323.4, the same shot change half a second apart, failed by the tolerance; 744.6 and 1325.967, rule 7 where the delivered cut buries the card to keep the band; 3866.967, a clean scene change against the delivered line). Of Sonnet 5's fourteen misses the delivered cut was right at eleven (three went to a person) and both were defensible at three; its own misses were frame misreads and payoff timing (a cut inside a struggle at 2429, mid-dialing at 2541.067, after the tension resolved at 3646.267, the confession and the card pushed into the next episode at 3276.333).

**Per 63-boundary film:** Opus 5.5 about **$9.60** and about **5 person reviews** plus 1–2 band-fix groups; Sonnet 5 about $6.70 (forced about $5.10) and about 6 reviews plus about 13 wrong cuts nobody is asked about; DeepSeek about $1.30 and 6–19 reviews.

**The bar: not met by any arm.** Opus 5.5 clears agreement (16 ≥ 15, 17 ≥ 14), bad overrides, person reviews and cost on both ranges and misses two lines, each for a reason in the measure rather than the model: the band line on 1–20 (a structural pair the eval scored before any band fix, while production runs the band fix before it renders) and the card line on 21–40 (8 of 8 needed; the right cut was no listed option and the pick went to a person). Sonnet 5 fails agreement on both ranges under either tool choice, and cards on 21–40. So the Workflow stays the pass of record and the API pass a pre-screen a person reviews, as "The frame judge, second pass" prescribes, until the two lines are re-measured under the changes below.

**The default chosen.** With `ANTHROPIC_API_KEY` set and no `ADS_VISION_PROVIDER`, the frame judge runs on **`claude-opus-5-5`**: `VISION_DEFAULT_MODELS` in `lib/llm.ts`, the judge's own model per provider — it is no longer the provider's fast tier, which `LLM_MODEL_FAST` moves together with every reading pass and which nothing could set for the judge alone. `ADS_VISION_MODEL` is the judge's override, checked as the eval's `--model` is (the provider's own family, reads images; a Claude id under `ADS_VISION_PROVIDER=deepseek` is refused, not swapped). `deepseek-flash` stays the fallback when only that key exists. Every call of the judge — reviewer, skeptic, tie-break, band-fix judge and skeptics — asks for `tool_choice: auto` (`StructuredCall.toolChoice`), so the model thinks first whichever model it is; `ANTHROPIC_TOOL_CHOICE` overrides every call either way (`auto`, or `forced` where the model accepts it — the cheap arm); Opus 5.5 is auto regardless. The adaptation passes keep the forced call.

**What the run fixed** (`lib/llm.ts`, `lib/segment/vision.ts`, `lib/segment/annotate.ts`, `lib/segment/calibration.ts`, `lib/prompts/boundary-*.ts`, `scripts/segment-eval.ts`; rule version `by-eye-v5`, tie-break `tiebreak-v4`, so every idempotency key is new; tests in `tests/llm.test.ts`, `tests/segment-guard.test.ts`, `tests/segment-vision.test.ts`). (1) **The eval runs the band fix** the stage runs after the review: `findBandConflicts` over the applied picks, with the boundaries the eval did not judge (and the faulted ones a person decides) pinned at the delivered cuts, then `judgeBandFix` (which now takes the eval's `--model` instead of the provider's default), and the fixed plan is what the bar scores; the fix is printed as its own line, an unresolved group counts as a person review on the bar, and its calls count in the cost. (2) **A card in another option's entry:** `selfContradiction` refuses a chosen option whose own entry shows no card while another option's shows one, says which way the card lands (before the cut: buried inside this episode; after: the source's break inside the next), names the option the entries mark as the first frame after the card when there is one, and asks for a refusal that names the card when there is none — the honest answer at 4313.4, which Sonnet gave and Opus did not; `refusalProblem` accepts a refusal that names the card. The finding's other half, a second dense strip centred on the option that shows the card for the skeptic, was not built: this check refuses the pick before any skeptic is called, so the case no longer reaches one. (3) **A grab is defined** — seizing a person (an arm, a collar, hair) or snatching something by force; handing over, receiving, holding or reading an object is none for rules 2–4 — in the reading block every prompt shares and in every schema that records an action across the cut (`GRAB_DEFINITION`, `ACTION_LIST`). (4) **The annotate step waits** up to 15 minutes at BelowNormal priority (`ANNOTATE_TIMEOUT_MS`: the work is a second, the time is waiting, and a session's OCR at normal priority starved the two-minute limit and errored the boundary with an empty reason after the reviewer's call was paid for), is retried once, and a timeout names itself and the priority in the error. (5) **The exact spend** rides on every job entry (`JudgedJob.cost_usd`, from the call's usage and `PRICES` through `costUsd`; a reused row from the row's own usage) and the eval prints it beside the rounded-up cents, on the bar's cost line too; the rows keep rounding up.

**What remains.** Re-measure Opus 5.5 on both ranges under `by-eye-v5` with the band fix in the eval (about $7 for the eighty boundaries, `--no-card-prompt`): if the band and card lines clear with agreement held, the API pass becomes the pass of record with a person reviewing what it flags, and the Workflow the hand-off. Until then this entry changes nothing about who decides: the API pass pre-screens, a person reviews, the Workflow stands.

## 2026-09-23 · The frame judge on Claude

Phase 2.2: the Claude arms of the calibration bar ("The frame judge, second pass", below), run the day `ANTHROPIC_API_KEY` reached `.env.local`. **Measured: nothing.** The key is an identity-linked console key that is not scoped to a workspace, and `ANTHROPIC_WORKSPACE_ID` is nowhere on the machine, so every call — the probe's tiny text calls on `claude-sonnet-5`, `claude-opus-5` and `claude-opus-5-5`, direct and through the gateway, and the one-boundary smoke — answered 400 (`This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header…`). Spend $0.00. So there is no Sonnet 5 or Opus 5 number on 1–20 or 21–40, no person-review count and no measured cost per boundary on Claude, and **the bar is not met: unmeasured, not failed.** The numbers on record per model: `deepseek-flash` (the three runs of phase 2.1) applied 10–12/20 on 1–20 and 6–7/20 on 21–40, 0 bad overrides in the last run, about $0.40–0.45 per 20 boundaries (about $1.30 per 63-boundary film), 2–6 person reviews per 20 (about 6–19 per film); `claude-sonnet-5` and `claude-opus-5` n/a on every line. The estimates from the real prompt sizes of boundaries 1–40 (about 10k input tokens per reviewer call — 5.65 strips at about 1.24k tokens each — and 14k for the skeptic with its dense strip; 1–1.5k of JSON out plus 2–5k of thinking; a tie-break on about 15% of boundaries; the tools+system prefix of about 2.3k tokens caches): Sonnet 5 $0.13–0.20 per boundary, about $8–13 per film, within the $0.40 line; Opus 5 $0.33–0.50, $21–32 per film, at risk; Opus 5.5 $0.26–0.40 once the gateway can run it (it can now, below).

**The default chosen.** With `ANTHROPIC_API_KEY` set and no `ADS_VISION_PROVIDER`, the frame judge runs on Anthropic's fast tier, `claude-sonnet-5`: the first arm to measure and the one the estimates keep under the cost line. `deepseek-flash` stays the fallback when only `DEEPSEEK_API_KEY` exists; an explicitly named provider is never swapped. The pass of record stays the Workflow, and the API pass a pre-screen a person reviews, until an arm clears the bar. `claude-opus-5` is measured only if Sonnet 5 misses (`--model claude-opus-5`).

**What the blocked run fixed in the gateway, so the first real run measures the model and not the plumbing** (`lib/llm.ts`, `lib/jobs.ts`, `lib/segment/vision.ts`, `lib/segment/calibration.ts`, `lib/segment/annotate.ts`; tests in `tests/llm.test.ts` and `tests/segment-guard.test.ts`). (1) **The thinking's room:** Sonnet 5 and Opus 5 think adaptively by default and the thinking counts against `max_tokens`, so a call sent with the answer's 6,000 alone can end in `max_tokens` with no tool call — a lost boundary, counted as a miss and a review. Every Claude call now sends `maxTokens + ANTHROPIC_THINKING_TOKENS` (16,000; streamed, so no timeout), as DeepSeek's strong tier already did, and records per turn the stop reason, the output tokens and whether a thinking block came first (`TurnTrace`, on the pass's job entry and on the eval's summary line, so the eval shows whether the model thought at all). (2) **A configuration 400 is not a transient:** `toLlmError` turns the workspace 400 into `LlmUnavailableError` naming `ANTHROPIC_WORKSPACE_ID`; `judgeBoundaries` stops at the first such answer and returns `{unavailable}` (the stage waits for the hand-off with the reason, the eval exits 3 — before, forty doomed pairs of calls and exit 0); `isTransientLlmFailure` retries no 4xx but 408/409/429; `calibrationBar` prints no PASS when nothing was scored. (3) **A failed call keeps its spend:** `LlmError` carries the usage and cents of a call that failed after the API answered (a refusal after the repair turn, a truncated reply, a failed skeptic or tie-break), `runJob` writes them on the failed row and hands the row's id back on the error, and the pass lists failed rows in `jobs` with `status: "failed"`, so `cost_cents` and the bar's cost line cover everything spent — CLAUDE.md's "every model call has a row with usage and cost_cents" held for done rows only. (4) **Opus 5.5 can run:** priced ($4/$20; it was charged at the Fable fallback, $10/$50, 2.5× too much), and `tool_choice` is chosen per model — forced where the model accepts it; `auto` with one call at most plus "Answer only by calling <tool>." on Opus 5.5, Fable 5.1 and Mythos 5.1, a reply with no tool call repaired by one nudge turn (`parseAnthropicResponse`). `ANTHROPIC_TOOL_CHOICE=auto` takes that path on every model: the switch for the open question of whether a forced call still thinks first, which only a live call answers. (5) **Image size:** an annotated copy over 3.5 MB (a dense strip's PNG reaches 3.05 MB, 4.07 MB base64, against the API's 5 MB) is re-encoded as JPEG at about quality 90, and the strip's `media_type` says which it is.

**What remains, in order.** `ANTHROPIC_WORKSPACE_ID=wrkspc_…` (console.anthropic.com → Settings → Workspaces) in `.env.local`, or a key scoped to a workspace — Ruobin's; until then `ADS_VISION_PROVIDER=deepseek` keeps the verify stage on `deepseek-flash`, and the judge's unavailable message says so whenever that key is there. Then `npx tsx scripts/anthropic-probe.ts` (under $0.05: whether thinking blocks appear under a forced tool call on Sonnet 5 and Opus 5, and what Opus 5.5 answers), the one-boundary smoke (`scripts/segment-eval.ts --boundaries "#1" --model claude-sonnet-5 --no-card-prompt`), and the evals — `claude-sonnet-5` on 1–20 and 21–40 with `--no-card-prompt`, then `claude-opus-5` only if Sonnet misses — about $21–26 for the eighty boundaries. If the probe shows no thinking under the forced call, the eval reruns with `ANTHROPIC_TOOL_CHOICE=auto`, and if that closes the gap the auto path becomes the default. Measured the same day: the numbers per model, the cost and the person reviews per film, and the default they chose (`claude-opus-5-5`, every call of the judge on `auto`), are the entry above, "The frame judge on Claude, measured", which overrides the default named here.

## 2026-09-23 · The frame judge, second pass

The read-only diagnosis of the first calibration of the API vision pass (He Hated All Women, boundaries 1–20, `deepseek-flash` against the recorded Workflow; the build is described in `docs/segment-a-film.md`, "The frame judge, second pass"). **The result:** the skill's agents were right at 15 of the 16 disagreements checked by eye (the 16th was defensible either way), so the 4/20 was the API pass's error rate, not noise in the reference; **the API skeptic caused most of the misses** — the two reviewers agreed on 10 of 20, the skeptic turned 6 of those into disagreements, named a fix 9 times, and none was right: every one was legal in the index and every one broke a standing rule (a cut on the first frame of the source's card, a cut before the payoff, a split conversation, a time no image showed that broke the band), and `apply_vision.py`'s rule 1 applied them all. The reviewer's own misses came from the motion flag taken as fact, the film notes never reaching the prompt, captions running across the cut, and tiles bound to the wrong times or strips. The eval also measured a weaker pass than production (no dense strips, no film notes) and scored against the first-pass records instead of the delivered cuts.

**The guard rule, from now on.** In the API path a skeptic's fix is a candidate, never an answer. It applies only if (a) the time is a tile of an image the skeptic received, (b) both episodes stay in the 95–150 s band against the planner's neighbours, (c) it is not inside or at the start of a card span (`film-meta.json` exclusions of kind `card`, `index/skips.json`), and (d) it is a legal cut — and then only when a blind tie-break, shown the two cuts as A and B with their dense strips and no reasoning from either side, picks it. A fix that fails a check is written as the reviewer's pick with the skeptic's verdict as a note and goes to a person as `skeptic_unverified`; a tie-break that picks neither faults the boundary; a fault the skeptic cannot place on an image and a tile is recorded and ignored. The prompts gain the card rule (7) and the split-caption rule (8), a block on how to read a strip, the motion flag as a detector reading, the neighbours and the allowed range (an option outside it, or inside a card span, is marked and refused by the call's own check before any guard), the film notes whenever they exist, and observation-first schemas (what each strip shows before the choice). Every strip the model sees is an annotated copy made by Studio with ffmpeg (tile times, END/NEXT, the cut framed) under `STUDIO_WORK_DIR`; the pipeline's own `boundary_frames.py` is not changed, and rules 7–8 are not mirrored into `pick_by_eye.workflow.js` either (that repo is read-only from Studio; a session may carry them over). `apply_vision.py` stays as it is: its rule 1 is right for the Workflow, whose skeptic has more evidence than its reviewer. Founder rules taken as defaults until confirmed: an episode opening on the source's "TO BE CONTINUED" card is a defect (cut on the first frame after the card); card spans come from `film-meta.json` and the index skips when present.

**The calibration bar** an arm must clear before the API pass can be more than a pre-screen a person reviews (the Workflow stays the pass of record until then): scored against the DELIVERED cuts (`review/cuts-*-DELIVERED.json`, newest by its end) at ±0.2 s, applied agreement of at least 15/20 on boundaries 1–20 and at least 14/20 on the held-out 21–40; zero hard-rule failures in the applied times (no applied cut opens an episode on a card, none falls out of band with the applied neighbours, none was a time the skeptic never saw); at most 1 applied override per 20 that moves away from a reviewer pick which matched the delivered cut; at most 2 hand-offs to a person per 20, each a real fault when checked by eye; 9 of the 10 card boundaries in 1–20 on the first frame after the card; at most $0.40 per boundary, wall time reported. `scripts/segment-eval.ts` prints every line of it. Claude arms (Sonnet 5, Opus 5) wait for an `ANTHROPIC_API_KEY` in `.env.local`; the first run under the new rules was on `deepseek-flash` and is recorded in `docs/segment-a-film.md`.

**Calibration fixes (2026-09-23, phase 2.1).** The second run on `deepseek-flash` (12/20 on 1–20, 6/20 on 21–40, 0 bad overrides, 0 hard-rule failures; `docs/segment-a-film.md`) was read by eye: 17 of 22 misses were the model's, and most came from the prompt being read backwards rather than from the frames. Three things are settled by it. **The prompt states targets, not prohibitions:** rule 7 names the FIRST frame after the card as the best cut (a card before the cut is the target, not a fault; the faults are the card on the cut tile and a cut a second or more after it ends), rule 8 says the SAME subtitle line on the last tile before the cut and on the cut tile, and the reading block names the cut tile of the OPTION strips and, separately, of the dense strip from its own layout (`by-eye-v3`). **A deterministic check refuses what the model's own observations contradict:** a pick whose `options_seen` entry shows a caption across the cut, the card on or after the cut tile or an action across the cut is sent back for repair, and a tie-break must place a fault tile on the losing side (both for `neither`) from that side's own images (`tiebreak-v2`) — a hand-off always names a tile for the person to look at. **The bar's hand-off line means every boundary `reviewState` sends to a person** (`Score.person_reviews`: faults, unverified fixes, picks under `CONFIDENCE_GATE` 0.65, and errored boundaries, which also stay in the denominator), not the faults alone. And the calibration's card marks were the answer in disguise: a delivered film's `film-meta.json` card exclusions end on the delivered cut, while a by-eye run in production has no card spans at vision time (`film-meta.json` is written after the render; `cards.py` runs only in source-episodes mode), so the production measure is the eval's `--no-card-prompt` arm and the 9/9 card score with the spans in the prompt is not it. Running `cards.py` detection before the plan stage in by-eye mode, so production gets the same evidence, is left open: it needs a person to name a card template per film.

**Calibration fixes, round two (2026-09-23, phase 2.1).** The third run on `deepseek-flash` (10/20 and 7/20 with the card spans in the prompt, 11/20 and 7/20 without them; `docs/segment-a-film.md`) was read by eye again: 16 of 23 misses were the model's, and six of eighty boundary calls errored on the very checks the first round added, each losing its record. Settled by it: **a call that fails after its repair turn is recorded per role, never a lost boundary** — the reviewer's check failure is a refusal record (confidence 0, the check's words as the why, guard rule `check`) that `apply_vision.py` faults and a person decides; the skeptic's keeps the reviewer's pick unverified (`skeptic_failed` → `skeptic_unverified`); the tie-break's is `no_tiebreak`; a transport or non-JSON failure gets one job-level retry first. **The skeptic's verdict is tied to its own observations** the way the reviewer's already was: it records the caption, card and action at the chosen cut before `agree`, agreeing over an observed fault is refused, and so is a rule-8 or rule-7 fault the observation does not show. **A citation must show the chosen cut and carry the rule it names:** the chosen option's own strip or the dense strip, never another option's; a rule-7 tile at or after the cut (an END tile under the card is rule 7's target, refused in rule 7's own words), a rule-8 tile the last before the cut or the cut tile, a rule-2 or rule-4 tile within 1.5 s — in the skeptic and in the tie-break, which now names a rule per fault tile. **A winner never carries its own fault tile:** both cuts break a rule, or the winner's tile is cleared. **The guard's rule (e), `bury`, needs no card spans:** a fix a second or more after a pick the reviewer's own entry marks as the first frame after the card buries the card, and production has no spans at vision time. **Rule 7's target among the options is the earliest** option the reviewer's own entries mark as after the card and clean. **A refusal must name the image it could not read**, in real words, with every option still covered: Studio attaches every strip before the call. **The bar names the measure's own limits** beside the numbers — truths that are no listed option, applied cuts on the first frame after a card the delivered cut buries, false hand-offs among the person reviews, errored card boundaries as card misses — and says that rule 8 is checked by eye only. Rule versions `by-eye-v4` and `tiebreak-v3`. The eye check's estimate stands: on this model the fixes reach about 11–13/20 and 9–11/20, and the bar needs a thinking model (`--model claude-sonnet-5` once the key exists).

## 2026-09-23 · The crazydramas connection, read-only

Ruobin, 2026-09-23, on the plan for the crazydramas leg (`connection-segment-plan.md` part A). His order stands: segment a film → upload to crazydramas → ads. This phase builds the read-only half (A0–A5, A8): Studio reads the public crazydramas.com API and tells, for each title, where its series stands. **The write path (A6 — publish a series, upload missing episodes, replace an episode) is deferred to a decision on access** with Jayden, who runs the crazydramas CMS: a push to crazydramas `main` is a release, and the paywall leak (paid episodes' `thumbnailUrl` carries the playback id) is fixed first. Nothing of A6 is built; the `identical` and `local_newer` values exist in the types and are never produced.

- **What it answers, and what it never claims** (`docs/crazydramas-connection.md`). Four things per title: is the series on crazydramas; how many episodes and are they 1..N; which episodes match Studio's files and which are missing, another length or still processing; the free/paid split, the price, whether an IAP product is set and whether the poster is the placeholder. A duration match proves only **"same length"**, never "same file"; the three series live today were uploaded by hand through the CMS, so for them the answer stays at "same length" until a ledger exists.
- **Read-only, no credentials, public endpoints only.** `GET /api/dramas` (with `Cookie: pulsar_mock=0` **and** every `mock-*` slug dropped, `cache: 'no-store'`, up to 60 s of lag after a publish) and `GET /api/dramas/<slug>` (404 = "not live", which is *not* "not uploaded": drafts and archived series answer 404 too). `playbackId`, `previewPlaybackId` and `thumbnailUrl` are never stored or shown: the zod schemas in `lib/crazydramas/types.ts` are whitelists and a hand-built row carrying one of those keys is refused. `CRAZYDRAMAS_BASE_URL` is the site's origin, not a secret. `lib/crazydramas/transport.ts` is the only module that fetches (server-only, sanitised errors, a timeout); `lib/crazydramas/index.ts` picks the fake in fixture mode (`lib/crazydramas/fake.ts`, a deterministic catalog mirroring `tests/fixtures/workspace`: complete, partial, differs, processing, a 404 and a failed read, plus the three real unmatched series) and the live transport in Supabase mode; `CRAZYDRAMAS_LIVE_READ=1` is the engineer's override from fixture mode; under node:test the live transport refuses before any request. A future credential is always `CRAZYDRAMAS_`-prefixed, read only in the transport, and never in a row, log, fixture or response.
- **Two tables, migration `0017_crazydramas_link.sql`** (`docs/data-model.md` §10): `core.platform_links` (the title *is* this drama: made on the first 200 read of `crazydramas_slug` with the returned drama id, matched by id from then on because the CMS can rename a slug; one per title × platform, one title per drama) and `core.platform_snapshots` (append-only, one row per public read: status, the whitelisted body, the episode list, the read time, the error; `title_id` null for a series that matches no title; twenty kept per slug). Public facts: producers read their own titles' rows through `can_read_title`, a title-less row is staff's; every write is the system's or staff's through the data layer (service role in Supabase mode), the same refusals in both backends. No job kind — a public GET costs no model money and the snapshot row is the record.
- **The frame rule** (`lib/crazydramas/match.ts`, pure and never stored): `d = round(durationSeconds × fps) − video_frames`, fps from the file, `video_frames` from Studio's own ffprobe count on the imported link. `d == +2` is `same_length` (`MUX_FRAME_OFFSET`, one named constant: all 52 Mafia King files from `cut/eps.zip` give exactly +2); +1, +3, +4 are `close` (the current re-renders show +3 and +4 against live — "probably an older render"); anything else is `different_length` (He Hated All Women's episodes 3, 4, 29, 30, 56, 57 after their boundary fixes). **Never ±0.1 s** — it misfires on 69 of 169 live episodes. **The offset is calibrated on one film** and must be confirmed on the first Studio-made upload before it may block anything (`FRAME_RULE.confirmed` stays false). Series states, first rule that applies: `not_linked`, `not_checked`, `read_failed` (the last good read shown, marked stale), `not_live` (a 404, or a 200 for another drama under the linked slug: `slug_reassigned`), `live_partial` (an episode missing or not ready), `live_differs` (another length, an extra episode, or numbers not 1..N), `local_newer` (ledger only), `live_unverified` (no frame count for an episode), `live_complete` (counts equal, 1..N, every episode ready and same length or close). `not_checked` and `live_unverified` are the two states the plan's table left implicit. One pure `crazydramasStatusFor(title, episodes, snapshots, link)` is what every screen calls.
- **Refresh** (`lib/crazydramas/sweep.ts`): step 5 of the scheduler's tick, `tickCrazydramas()` — once an hour, every 15 minutes while any title is partial or differs (or the last sweep hit an error); one catalog GET plus one GET per linked or catalog slug in sequence, the catalog's series that match no title recorded with no title (the staff mirror, `GET /api/admin/crazydramas/unmatched` and the Import films desk: he-mocked-…, he-treated-…, ever-since-… today), then the prune; skipped under `SCHEDULER_DISABLED=1` and in tests. **Check now**, `POST /api/titles/[id]/crazydramas/check` (same-origin, staff or any producer role, zod, the same function, JSON), is refused with 429 while a snapshot of the slug is younger than 30 s — before any request — and with 409 when the title has no slug. **After an import** that set a slug, `lib/film-import/import.ts` runs one check, failure-soft. A CMS rename is followed through the catalog and the link's slug moves; a slug re-pointed in Studio moves the link to the drama it answers with, refused in words when another title holds that drama.
- **Tests** (`tests/crazydramas-match.test.ts`, `-data`, `-sweep`; fixtures under `tests/fixtures/crazydramas/`, the six live bodies and the catalog stripped of the leaking fields, plus `studio-frames.json` with the measured counts): the whitelist parse of the real bodies, Mafia King 52 × same_length from the zip counts and same_length/close from the current renders, Reclaiming's +3/+4, He Hated All Women's six different_length, never ±0.1 s, every state and verdict, `resolveReadSlug`, the link and snapshot rows with their refusals on the fixture (the Supabase layer applies the same rules), the check's 30-second rule, the sweep's order and prune, the unmatched list, the tick skipped in tests, the after-import check through a real `importFilm`, and the guard that no credential value reaches a status, a row, an error or the fake and that the live transport throws in tests. Checks: `npm test`, `npm run typecheck`, `npx next lint`. The screens (the catalog column, the title header chip and section, the Import films chip, the staff mirror; plan A4) are the UI half of this phase and are recorded when they land.

**The screens (2026-09-23, the UI half; plan A4).** One chip per series state, in plain words and never a number on the catalog (`components/producer/CrazydramasChip.tsx`; decision 2026-09-08 "status board"): "Not linked to CrazyDramas", "Slug set · not checked yet", "Not live on CrazyDramas · not uploaded, or draft", "CrazyDramas · check failed" (with "showing the last good read" only when there is one), "On CrazyDramas · complete / episodes missing / lengths differ / lengths unverified / Studio file newer"; Chinese per `docs/terminology.md`. My catalog gains a CrazyDramas column whose cell opens the title's new CrazyDramas section ("How to link" when not linked). `TitleShell` gains the `crazydramas` section and a third header chip beside the TikTok and ad chips, drawn when a page supplies the state (`loadTitleWorkspace().crazydramas`, `loadAnalyticsPage().crazydramas`; the other section pages — overview, campaigns, preparation, report, materials, the analytics frame and the promote page — pass nothing yet, a one-line change each). The section `/producer/titles/[id]/crazydramas` (`components/producer/CrazydramasPanel.tsx`; the staff mirror is `/titles/[id]/crazydramas`) shows the series as crazydramas.com shows it — live or not, the slug, the title there, the public page, Studio vs crazydramas episode counts, the free/paid split, the price, whether an IAP product is set (and its id), the poster with a placeholder warning — the per-episode table (number, Studio frames with seconds and fps, the crazydramas length, the verdict with its frame delta, free or paid), "Checked <time>" with the observed label (实测), the failed-read time when no read ever succeeded, and Check now, whose 30-second refusal reads in words; reviewers and approvers may press it, viewers and staff previewing the portal read why they cannot, staff press it on the mirror. A title with no slug says how to get one (`crazydramas_slug` in `cut/film-meta.json`, then Update on Import films) or that it was not imported from the workspace; a 404 says the public site cannot tell "not uploaded" from "draft"; the length rule is stated at the foot with its one-film calibration. The Import films rows carry the same chip: no film-meta slug reads "Not linked: add a crazydramas slug" (the-cold-ceo, she-returned-with-her-son), a slug not yet imported reads "slug: … · import to check", an imported title its state (`crazydramasStatesByTitle` in `lib/research/title-workspace.ts`). The staff desk lists "Unmatched on CrazyDramas" from `listUnmatchedCrazydramas` (series, slug, episodes, poster, the read time as observed, the public page) and says the catalog has not been read until a sweep ran in this process — a Check now alone reads no catalog. Fixture mode shows every chip: five demo titles carry the fake's slugs (`data/fixture/demo-catalog.ts`), chosen by episode count alone because every video episode keeps the demo clip's duration — processing on a three-episode title → partial, differs on a title with no episodes (three extra) → differs, partial on a two-episode title without frame counts → unverified, draft → not live, broken → read failed — and the imported fixture film is the complete one. Strings in `locales/_keys/crazydramas.json`. Tests: `tests/crazydramas-ui.test.ts` (a tone and words for every state, no digit in them, every verdict's pill, the formats, the saved bodies stripped) and `tests/e2e/crazydramas.spec.ts` (the catalog per state after the spec runs the check itself, since the e2e server never sweeps; the header chip and section per state; the imported film's facts and three same-length rows; Check now and its refusal on the page and on the route; the Import rows; producer vs staff visibility of the unmatched list, which on the e2e server can only say "not read yet" until a staff sweep trigger exists).

**Phase 3a review fixes (2026-09-23).** What the review of the commit found (the build, the e2e suite, live reads of the three series and a CMS-rename probe), all applied. `next build` ran out of heap; the first round blamed a cycle (`sweep.ts` imported the transport choice from `index.ts` while `index.ts` re-exported `sweep.ts`) and moved the choice to `lib/crazydramas/pick.ts`, which `index.ts` re-exports and nothing inside the folder imports `./index` — kept, but the cycle was not the cause (round two, below): the build's output tracing followed `path.join(process.cwd(), ".uploads")` in `lib/data/storage.ts` and `lib/data/launch.ts` into the runtime `.uploads` folder. The fake assumed 151 frames for the fixture film's second episode where `ffprobe -count_packets` measures 150, so a real import read "close" and the e2e film test failed; the fake and the unit tests carry 120/150/180. The staff e2e test never chose the company the film was imported for (the picker opens on the first company by name); it selects Xinghai Pictures. **A followed CMS rename held for one check only:** from the third check on, film-meta's unchanged slug read as "the person re-pointed the title", the old slug was read, answered 404, and the screens froze on the second read. The link now records `title_slug`, the title's own slug when the link was made or last re-pointed, which a followed rename never rewrites (migration 0017 in place, idempotent for a table made from the first version; both backends); `resolveReadSlug` calls a re-point only a slug that is none of the link's `title_slug`, its `slug` or the platform's, and the sweep test runs three more checks after the rename. The third header chip is on every section page now (overview, campaigns, materials, preparation, the TikTok frame), through one `chipReading(status)` — state, stale, and `older` when a complete series has episodes that read close, said on the chip as "some older renders" and never as a count (keeping close inside complete is deliberate: Mafia King's 21 one-frame renders stay, amendment 2, and "differs" would sweep every 15 minutes for good). The fake's posters were `https://crazydramas.com/posters/…` and the panel's `<img>` fetched them from the browser in fixture mode and e2e; they are two SVGs under `public/crazydramas-fake/`, served like the fonts (the middleware lists the prefix as public, since a producer session's request for any other non-producer path is redirected to `/producer` and the image broke), and the e2e spec aborts and fails on any request to another host and checks the poster image loaded. Check now refuses a viewer-role producer (403 from the route and from `checkCrazydramasTitle`, the page's own rule; a test covers it). The refusal when another title holds the drama no longer names that title or the drama id — it may be another company's — and a title's reading is built from its own snapshot rows of the slug, as the caller's session sees them, never from another company's reads of the same slug (a test puts two companies' titles on one slug). `loadCrazydramasStatuses` reads the titles side by side. The staff title page, the admin Import rows and the producer-preview note link to the staff mirror `/titles/[id]/crazydramas`; the producer Import rows link to the section. Found on the way: the import desk applied listing answers in arrival order, so a company picked while the first list was still in flight could be shown under the other company's rows (the desktop e2e run hit it); an answer for a list the desk no longer shows is dropped. Checks: `npm test`, `npm run typecheck`, `npx next lint`, the crazydramas e2e spec.

**Phase 3a review fixes, round two (2026-09-23).** The build: `next build` still ran out of heap with the cycle gone, and a `git archive` copy of the same commit built in 30 s — the difference was the repo's runtime folders. Output tracing (nft, run inside the compile) followed `path.join(process.cwd(), ".uploads")` in `lib/data/storage.ts` and `lib/data/launch.ts` into `.uploads` (33 GB, some ten thousand entries), and `.uploads-e2e` and `tmp` with it; this predates the phase. `next.config.js` lists the three under `experimental.outputFileTracingIgnores` (the trace's own ignore list, the key that matters) and `outputFileTracingExcludes`; Next 14.2 warns that Ignores "has moved" to Excludes, which only prunes the route lists after the trace, so both stay and the warning is expected. **A re-point to a slug that is not live froze the screens on the old drama:** the check read the new slug and answered not_live, but the reading was built with the old link (its slug) and every screen kept "On CrazyDramas · complete" with the checked time of the last read of the old slug. `loadCrazydramasStatus` now reads the slug a check would read (`resolveReadSlug` without a catalog): on a re-point, the title's own slug with no link, so the screens say "not checked yet" or "not live" under the slug the title carries; a check's answer carries the link only when it is the link's slug that was read. **Two CMS renames:** a followed rename kept the link's original `title_slug` even after film-meta had been brought up to date with the first rename, so the second rename made every later check read the intermediate slug (404). The link now records the title's own slug when it is one the link already accepted (`title_slug` or `slug`). **Posters in fixture mode:** the fixture store persists its snapshots, so one `CRAZYDRAMAS_LIVE_READ=1` run left real `https://crazydramas.com/posters/…` URLs for a later plain fixture run's `<img>` to fetch; the pages pass the panel `shownPosterUrl(...)`, null in fake mode unless the URL is same-origin (the fake's SVGs), and the poster facts (set, placeholder) are still shown. Tests: the re-point to `fixture-film-draft` (check, screens, the 30-second refusal and the sweep all say not_live under that slug; pointed back, the screens follow), the two-rename case, and the poster rule.

## 2026-09-23 · Segment a film in Studio: the pipeline's cut-only scripts run as Studio jobs

Ruobin, 2026-09-23, on the segmenting plan (`connection-segment-plan.md` part B, B0–B6, and his decisions on it). Order: segment a film first, then upload to crazydramas, then ads; the ad phases of the 2026-09-22 build plan (§4–7) are postponed and nothing of them is built now.

- **Studio orchestrates the canonical scripts; it does not port them.** "Part 2 is just the skill — take it from the existing repo." This amends the 2026-09-22 line "the pipeline's `projects/` folder is a read-only data contract: Studio never runs its scripts and never writes into `index/` or `review/`", in the wording of plan B0: **Studio may run the canonical cut-only scripts (`mini-drama-system/drama-remix/scripts/cut-only/*`), as a job, only inside a film folder it created or explicitly claimed, under a lock file `cut/.studio-run.json` that Claude Code sessions also respect. The data layer stays read-only against `WORKSPACE_ROOT` (`lib/data/storage.ts` `localPathOf` unchanged). Results enter Studio only through the phase-1 scanner and import.** The scripts encode about twenty refusals and the "derive nothing twice" rule and still change daily; a TypeScript port would fork them. Studio runs the film's own synced copy in `cut/scripts/` and records the drama-remix commit it came from (`drama_remix_sha`, `drama_remix_dirty`); a dirty working tree refuses a run unless its settings say `allow_dirty`, so "a session edited a script and did not commit" is the reading of that refusal. One warning stated openly: `projects/` is not in git and not backed up, so a bad write into `cut/` cannot be undone; Studio snapshots `cut/review/` before each apply or render.
- **Both routes eventually; the cut-only route first.** This phase builds the low-quality route end to end (watermark removal, whisper index, options, the vision pass, human review, render, QA, film-meta, hand-off to the import). The narrated high-quality route (`scripts/skip-through/`, narration, captions, reframe) is the next phase: `film_runs.mode` accepts `narrated` today and both backends refuse to create a run with it, and the stage list is plain text so a new stage needs no migration.
- **The vision pass runs from Studio through the API in v1.** The reviewer and skeptic prompts and rules of `pick_by_eye.workflow.js` (and `band_fix.workflow.js`) are ported into `lib/prompts/` and called through `lib/llm.ts` with the option strips as images (`ADS_VISION_PROVIDER`: DeepSeek Flash reads images today, Anthropic when the key exists); the result file is written in the exact Workflow-output shape (`{result: [{boundary_s, pick, verdict}]}`) and applied with `apply_vision.py --from <file> --label <run>`, so the pipeline's refusal rules and audit trail stay. A "Hand off to Claude Code" fallback shows the exact Workflow command and waits for the `.output` file, for when no vision provider is configured or Ruobin prefers it.
- **Human review is mandatory before the render** for every boundary below confidence 0.65 or with a skeptic override; the rest are pre-accepted but visible. Each decision goes into `film_runs.decisions` (who, when, why); applying writes one override file in the Workflow output shape with reviewer `"ruobin"` and runs `apply_vision.py` — Studio never hand-edits `choices.json`.
- **Intake is a server-side file picker** (Downloads, OneDrive "Mini Drama", or a typed path), never a browser upload of a multi-GB file; the source is hardlinked or copied to `projects/low-quality/<slug>/source/original.mp4`.
- **Pipeline repo hygiene, in the drama-remix repo:** the untracked `cards.py` and the three modified cut-only scripts are committed as they are (Ruobin's working state), the `.studio-run.json` and machine-wide heavy-lock rules are documented in `scripts/cut-only/README.md` ("Running under Pulsar Studio"), never pushed.
- **Staff-gated for now** (Ruobin is staff and owns the producer company); producers read their own company's runs and write nothing. Producer-portal exposure comes later.
- **Required gates:** `npm test`, `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e` (a fixture fake runner over `tests/fixtures/workspace`, no real Python in e2e), plus one real run — index → plan → vision (API) → review → render → QA — on a real source, with the wall time per stage and the refusals hit reported.

**The core (2026-09-23): the run table, the runner, the locks, the stage, the sync, the import fixes.** Migration `0016_film_runs.sql` adds `studio.film_runs` (plan B1: producer, nullable title, source path, bucket and slug, mode, lang, settings, stage and stage_detail, the drama-remix sha and dirty flag, lease owner and expiry, a CAS `revision`, the refusal verbatim in `error_text`, `decisions`, created_by) with the job kinds `segment_film` (cost 0, one row per stage) and `verify_boundaries` (one row per model call of the vision pass, title null) added before `begin` as 0015 did; RLS is staff every run, producers read their own company's, and the grants follow 0015 (authenticated reads, the service role writes). `docs/data-model.md` §9 has the shape. The data methods exist in both backends with the same signatures and refusals, all through the one rule set in `lib/data/film-runs.ts`: `createFilmRun` (staff or the system; `narrated` and a malformed slug, bucket, band or region are `invalid`, a missing company `not_found`, a producer `forbidden`), `getFilmRun` / `listFilmRuns` (a foreign company's run is `not_found`, never `forbidden`; another company's list reads empty), `claimFilmRun` (a CAS on the revision plus a ten-minute lease; a lost race answers `null`, never a throw), `renewFilmRunLease` (the lease moves, the revision does not), `setFilmRunStage` (revision-conditional; a foreign live lease is a conflict when the writer names itself; `error_text` kept as given), `appendFilmRunDecision` (stamped at/by, validated), `releaseFilmRun`, and `latestJobByTarget` (a job by `target_type`/`target_id`, staff or the system only). The fixture store persists runs like everything else. `lib/python.ts` is the one place Studio spawns a script: `runProcess` / `runPython` / `runBashScript` (Git Bash for `index_cut.sh`, found beside git or at `STUDIO_BASH`) with line callbacks on both streams, stdout and stderr tails (a refusal is exit 1 with its reason on stdout), `PYTHONIOENCODING=utf-8`, a timeout and a cancel that kill the whole tree (`taskkill /T /F`; the only thing that reaches a script's ffmpeg children), below-normal priority, an optional heartbeat, and a result rather than a throw for an exit code; `lib/asr.ts` and `lib/align.ts` run their scripts through it with their messages unchanged, and `pipelinePython()` / `dramaRemixRoot()` live there (`STUDIO_PIPELINE_PYTHON` default `python`, the README's system Python; `DRAMA_REMIX_ROOT`, else beside `WORKSPACE_ROOT`'s parent, else the sibling checkout), `lib/segment/strips.ts` delegating to them. `lib/locks.ts` writes the two files the README documents — `cut/.studio-run.json` and `<mini-drama-system>/.heavy-lock.json` (`HEAVY_LOCK_ROOT`) — atomically, adopts its own, refuses a live foreign holder (`LockHeldError`) or waits for it (`waitForHeavyLock`), treats a dead pid or six hours as stale and reports what it replaced, and never removes a lock it does not hold. `lib/film-import/scan.ts` reads a film's `pipeline_stage` from its artifacts alone (`NO_SOURCE → NOT_INDEXED → INDEXED → OPTIONS_READY → JUDGED → PLANNED → RENDERING → DELIVERED`, newest step first, with the file that decided it) without changing the READY rules: READY answers the import, the stage answers what the worker does next, and a QA re-pin that moved `cuts.json` on from the delivery reads READY and PLANNED at once. `lib/segment/scripts-sync.ts` copies `scripts/cut-only/.` (the `.route` dotfile included, `__pycache__` out) into `<film>/cut/scripts/` and records the sha, the dirty flag and the file list in `cut/.studio-scripts.json`, outside `scripts/` so `checks.py --strict` sees no drift. The B4 import fixes: `DeliveredPlanSchema` accepts a source-episodes plan (`band: null`, no `target`, `skips`, `source_breaks`, per-episode `play`), and `plannedFrames` and `sliceTranscript` count and shift by the pieces that play once the skips are out, so a trimmed episode no longer flags as wrong-length and a cue after a card no longer lands the card's length late. `.env.example` and the four studio launch configs carry `STUDIO_PIPELINE_PYTHON` and `DRAMA_REMIX_ROOT` (plus `HEAVY_LOCK_ROOT` and `STUDIO_BASH` in `.env.example`).

**The vision pass as an API module (2026-09-23).** `lib/prompts/boundary-review.ts`, `boundary-skeptic.ts` and `band-fix.ts` carry the Workflow's rules; `lib/segment/vision.ts` `judgeBoundaries` runs a reviewer per boundary over its option strips and a skeptic over the strips plus an optional dense 10 fps strip (rendered by `boundary_frames.py` into `STUDIO_WORK_DIR`, never the film folder) and the legal cuts within ±30 s, one `verify_boundaries` job row per call, and writes `<cut>/review/vision/<label>.json` in the Workflow record shape for `apply_vision.py`; `applyVision` mirrors apply_vision.py's three rules; `judgeBandFix` and `findBandConflicts` port `band_fix.workflow.js` and write the records and the `A -> B` note phase 1 reads; `evaluate` and `scripts/segment-eval.ts` measure agreement with the ~226 recorded boundaries (agreement with past agent picks, not correctness). Without a vision key it answers "vision provider unavailable" and calls nothing. Deliberate deviations from the Workflow, on record: the API reviewer sees only the option strips (the agents could pull any frame with ffmpeg); a skeptic's `better_t` must be a listed option or a listed legal cut; a reviewer at confidence 0 gets no skeptic call; band-fix arithmetic is checked in code; the model is the vision provider's fast tier (the Workflow ran on `claude-opus-5-5`, which refuses a forced `tool_choice` — `lib/llm.ts` must drop it before that model can judge).

Checks for the core: `npm test`, `npm run typecheck`, `npx next lint`. The worker process (`scripts/segment-worker.ts`), the intake, watermark and boundary-review screens, the evidence route and the e2e run over the fixture fake runner are the rest of this phase (plan B1–B3, B5) and are recorded when they land.

**Phase 2 review fixes (2026-09-23).** What the review of the phase commit found (a real ten-minute run on He Hated All Women's first 600 s, DeepSeek reading the strips, plus the e2e suite and a calibration of 20 recorded boundaries), all applied. The B0 rule was not enforced: the intake adopted any film folder whose source had the same size, and the plan resumed "at the review" on a foreign `choices.json`, so a run pointed at a session's film would have re-synced its scripts, moved and re-judged its boundaries and re-rendered it. An existing `cut/` is now driven only when a Studio run made it (`cut/.studio-scripts.json`) or the run says `settings.claim_existing` (a checkbox on the intake: the explicit claim in so many words), a film the scanner reads DELIVERED / READY / IMPORTED — or already imported for the company — only with `settings.extend`, and an applied options file resumes only with this run's own record files beside it. `extend` is the first proof's other half, which had no path in Studio: the index steps re-run when their files stop short of what the run plans (`whisper.json`'s `duration`, `motion.json`'s range), an applied options file whose boundaries all lie inside the newest DELIVERED stretch is re-emitted under `--pin-from`, and the move check and the served lengths measure from the pinned start (`pinsOf().fixedStart`), which the review screen already did and the route did not. The heavy lock names the run (`run_id`): one worker process drives several runs, and "same pid and owner" let a second run take the slot the first held and then delete the lock under it; the file is created exclusively (`wx`) and a release checks the run. The review's "Accept the remaining N" is gone — decision 5 makes the review mandatory, and the calibration showed the skeptic disagreeing on 12 of 20 boundaries, so the button would have been the common path and would have applied the skeptic's times unread; an accepted override now records the skeptic's key and reason rather than the reviewer's description of another frame. Smaller: the e2e rail lists "Segment a film"; the intake spec waits for the client's roots before clicking a tab (a server-rendered button takes focus and runs no handler); the film-meta inputs take `step="any"` (the default spoiler line is half the runtime, with decimals, and a whole-number step refused to submit it); `PYTHONUNBUFFERED=1` so a render's per-episode lines arrive as they are printed; a stage's final summary is written past the one-second progress throttle (the vision pass's provider and cost were dropped); the lease is renewed while the API judge, a re-judge and the band fix run (a pass longer than ten minutes let a second worker judge and pay again); `qa_episodes.py --only` writes only the episodes it measured, so the report is snapshotted and the untouched records merged back; the log line carries the stage the run is at, not the one it was claimed at; the picker ignores a listing that answers after the tab changed; a slug may start with one underscore (`_studio-smoke`, the spec's scratch folder, in both parsers and the migration); the stage audit row is written only when the stage, the refusal or the title moves (both backends; the Supabase layer had one per progress write and no `create_film_run`); the calibration CLI takes `allow_stale` for a candidates file rewritten after the recorded pass; and the phase commit's stray `.next-2c-smoke` tsconfig line is out. Checks: `npm test`, `npm run typecheck`, `npx next lint`, the segment and clips-posting e2e specs.

**Phase 2 review fixes, second round (2026-09-23).** What the review of the first fixup found (the real smoke on the `_studio-smoke` excerpt, a cancel test with two runs in one process, and the calibration on the real He Hated All Women folder), all applied. The first-round rule "an applied options file resumes only with this run's own records" locked a folder out after the likeliest cancel of all: a run cancelled at its review (the vision apply had stamped `review/options.json` with its label) could not be retried (retry is for a failed run), and a new run on the same slug passed intake, skipped the index and failed at plan with "the film was judged outside Studio" — false, and with no way out but a new slug (a 43–88 minute re-index and the vision pass paid again) or a hand edit under `projects/`. The plan stage now reads the stamp: `applied.label` is `studio-<8 hex>` (or `-review` / `-band` after the review's apply), and when that label belongs to an earlier run of the same company, bucket and slug that is over, the options are re-emitted for this run, as the extension path already did (`appliedRunLabel`, `earlierRunByLabel`); a film delivered to its end (`deliveredToEnd`: the newest DELIVERED reaches what the run plans) says "there is nothing to extend" instead; a foreign stamp is refused naming it. A rejected boundary closed itself: a re-judge at confidence ≥ 0.65 with the skeptic agreeing became `pre_accepted` and Apply went ahead without the person seeing the answer they asked for — the calibration shows the model confidently disagreeing with the recorded pass on 16 of 20 applied times, so a rejection the model may close defeats decision 5. A boundary with a re-judge asked stays `needs_decision` (reason `rejudged`, a pill on the card) until an accept or move recorded after the re-judge. B0 had a 60 ms hole: the worker wrote `cut/.studio-run.json` (creating `cut/` when the folder had only `source/`) before the intake's folder check refused the folder; pointed at a session's film it would have written the lock inside it and left it there had the worker died. The lock is taken lazily — the intake takes it after its check passes (`ctx.lock()`), the worker before every later stage — and the create route runs the same check before the row exists, so a refused run has no row, no lock and no worker tick (`createRun` → `folderFactsOf` / `existingFolderRefusal`, 409 in the intake's words). Cancel pulled the run lock from under a worker whose scripts were still running (the worker sees the cancel at its next heartbeat, up to 30 s later): the route now removes the lock only when no live lease holds the run (`leaseLive`), and leaves it to the worker's `finally`, which releases on a terminal stage after the child is killed. A cancel during the API pass, a re-judge or the band fix did not stop them — `withHeartbeat` honoured the abort only after the pass returned, so a 60-boundary film kept making and paying for calls for two minutes after Cancel; `JudgeOptions.signal` and `BandFixOptions.signal` carry the run's signal, checked before every reviewer, skeptic and band-fix call (the boundaries not reached read `cancelled`, the rows made stay done for a retry). An `import_now` posted while the hand-off waited for READY was consumed by the readiness wait's `decisions_seen` although the wait's note said it would apply: the stage now reads the newest `import_now` since the film-meta or join decision it follows (`importNowSince`), seen or not; a join or a new film-meta starts over. The re-judge's judge request carried no `work_dir`, so its dense strip went to `%TEMP%\studio-work\dense` rather than the run's work folder (`work_dir: dirs.work`; the band-fix request carries the work dir and the signal too). `defaultFilmMeta` turned the scratch slug `_studio-smoke` into `-studio-smoke`, which the decide route's slug rule refused (`suggestedCrazydramasSlug` trims the separators). And the join review played a proxy of the SOURCE around the join time while its header claimed the built episodes' joins: plan B3 asks for the last 2 s of episode k and the first 2 s of k+1 from the built files, and the source proxy showed neither the delogo nor the join as `cut_episodes.py` encoded it. The evidence route now serves `work/joins/j<kk>_t<s>_<ms>.mp4`, cut by ffmpeg (`-sseof -2` on the first, `-t 2` on the second, the concat filter) from Studio's own hardlinks of the two built files under the run's work folder (`<work>/eps/epNN-<mtime>-<size>.mp4`; the pipeline's `eps/` path is never opened; a copy only across volumes, as the import does) and remade once a re-render makes either file newer; the fake runner's join clip is the first episode's bytes. Checks: `npm test`, `npm run typecheck`, `npx next lint`, the segment e2e spec.

## 2026-09-22 · The end goal, the workspace import and the ad engine: what is settled before the build

Ruobin, 2026-09-22, on the plan for the next phases (the build plan and his amendments to it the same evening). These points are settled; the build starts from them.

- **Rights are settled.** Ruobin owns the rights to every film Studio will import (Mafia King, Reclaiming Her World, He Hated All Women, and whatever the same pipeline delivers next). There is no rights or licence gate anywhere in Studio and none is added.
- **Studio's end goal**, in order: segment a source film into episodes → upload them → clip the episodes for ads → publish to crazydramas → read the stats back. This build starts in the middle: the workspace import (a finished film from the mini-drama-system pipeline becomes a title with episodes) and the ad/hook engine (a hook, two to four scenes in story order and a cliffhanger, cut from those episodes and reviewed before anything is launched). Segmenting inside Studio and the publish and stats legs come after.
- **Montage is in scope.** The 2026-09-14 line "montage: not done, on purpose" is lifted: an ad may join moments from several episodes with hard cuts. What stays: nothing is burned into the picture (the source's own captions remain), and the hook is the ad text beside the clip, never a title card.
- **No poster, no end card, no AI imagery.** An ad ends on the cliffhanger's last frame with the normal audio fade-out. No poster card, no "poster-open" variant, no generated art, and therefore no AI-content label to remember. Posters are imported only as a title's cover art for thumbnails. This is Ruobin's amendment to the plan's poster card: the card fields, the two card checks and the label reminders are dropped.
- **The Pixel and Conversions API deferral is lifted.** Ruobin asked for it on 2026-09-22 ("we also have a tiktok business center and pixel for you to connect to"). It lands in the pixel phase of this build (phase 6): the pixel as a staff-assigned company account, website-conversion ad groups, and TikTok-attributed purchase columns on the monitor. (Landed 2026-09-23, entry above, which also corrected the five statements named here.) Until that phase lands, the "deferred; ask Ruobin" sentence in `CLAUDE.md` stays as written and is corrected then, together with the other four statements that still say the same thing: the `OBJECTIVE` header in `lib/tiktok/options.ts` ("Studio launches are TRAFFIC campaigns to the campaign's destination link"), `docs/unified-launch.md` ("Revenue tracking, Pixel, Conversions API … are deferred. Ask Ruobin"), `docs/tiktok-live-runbook.md` ("Revenue, Pixel and Conversions API are outside this pilot") and `lib/meta/README.md` ("Revenue, Pixel and Conversions API work is deferred by user instruction").
- **Landing URL signing rule.** The approver signs the tracking URL (`source`, `campaign` and `campid`, from `trackingUrlForCampaign`). At ad create the driver adds `adgroup=<TikTok ad group id>&creative=<clip external_id, else item_id, never the Spark code>` deterministically through a pure `adLandingUrl()`, each value under 200 characters, so the URL that is sent is derivable from the signed one plus ids we record. This is a deliberate exception to the hashed-manifest invariant (`CLAUDE.md`, "Promote approval … hashed manifest"): the two parameters exist only once the ad group does, so they are added outside the signed manifest rather than by re-signing. It ships with the ad engine (phase 4), not the pixel phase, and needs no TikTok permission. *Superseded the next day by "TikTok launch: crazydramas link contract + pixel + one account" (above): TikTok fills `adgroup` and `creative` with its own macros, so no `adLandingUrl()` was built and TikTok links carry no `campid`.*
- **Imported films are hardlink snapshots in a local media tier.** An imported episode is a hardlink from the pipeline's `cut/eps/epNN.mp4` into `STUDIO_LOCAL_MEDIA_DIR/<title_id>/ws/<film>/epNN-<sha8>.mp4`, stored on the row as `local/<title_id>/ws/<film>/epNN-<sha8>.mp4` (the tier marker first so no bucket path can be mistaken for it, the title id second so the media route still authorizes on the title), in fixture and Supabase mode alike; Studio reads, hashes and cuts only through the link, never through the pipeline's own path (holding that path open would crash a re-render). This is a deliberate exception to "a stored value is a bucket path" (`lib/data/storage.ts`, `docs/data-model.md`): the local tier resolves on disk in both modes. Rendered ads still go to the media bucket. The pipeline's `projects/` folder (`WORKSPACE_ROOT`) is a read-only data contract: Studio never runs its scripts and never writes into `index/` or `review/`; the one hand-written file per film is `cut/film-meta.json`.
- **Pipeline transcripts imported at import time are data, not transcription.** The whisper words the pipeline already produced come in with the film as the episode's script (`script_format 'asr'`, through `attachIngestToEpisode`). The 2026-09-15 rule is unchanged: transcribing an episode from its audio happens only on the explicit Materials button, and never replaces existing lines.
- **The model provider is chosen per call: text on one, vision on another.** `LLM_PROVIDER` stays the default for the adaptation passes. The ad engine names its provider on each call: text nomination on `ADS_TEXT_PROVIDER` (default DeepSeek, `deepseek-flash`), the frame judge on `ADS_VISION_PROVIDER` (default Anthropic; with no `ANTHROPIC_API_KEY` and a `DEEPSEEK_API_KEY` it runs on `deepseek-flash`, which reads images; a provider named explicitly is never swapped, and its missing key reads "vision provider unavailable" with the key to add). A structured call may carry images, sent base64; a model that does not read images is refused before any request. DeepSeek's ids are the V4.1 generation, verified on api-docs.deepseek.com on 2026-09-22: `deepseek-flash` (vision; at peak, cache miss $0.30, cache hit $0.006, output $1.20 per million) and `deepseek-v4-pro` (text only; $1.32 / $0.044 / $3.96); `deepseek-chat` and `deepseek-reasoner` were discontinued on 2026-07-24 and are gone from the price table. **DeepSeek thinking is decided per call** (review of 2026-09-23): the V4 API thinks by default at effort high and counts the reasoning against `max_tokens`, so a JSON-sized budget would end in `finish_reason: "length"` and pay reasoning at the output rate. `lib/llm.ts` builds the body in a pure `deepSeekRequestBody()` that the tests cover for both tiers: the fast tier sends `thinking: {type: "disabled"}` (what `deepseek-chat` was; nomination and the reading passes pay for JSON only); the strong tier sends `thinking: {type: "enabled"}` plus a top-level `reasoning_effort` mapped from the call's effort (what `deepseek-reasoner` was) and 32,000 tokens of room on top of the call's own budget; a strong call that names no effort does not think, and a model that also serves the fast tier never does. `scripts/zh-native` runs on `deepseek-flash` with thinking off for the same reason. `resolveCall` refuses a model from another vendor's family before any request (claude-* only on Anthropic, gpt-* only on OpenAI, deepseek-* only on DeepSeek; `LlmError("invalid")`, a logged 500), so a prompt cannot name `provider: "deepseek"` and keep a Claude id. Every job row records the provider it actually called: `runJob`'s `run()` returns the provider the call went to, and a call that went elsewhere than the row and the key check named fails the job with its spend kept on the row.
- **Housekeeping the review found.** `.tokens.json` was tracked in git although `lib/tiktok/tokens.ts` said it was ignored; it is untracked and ignored now (its own commit), the local file stays, and revoking the authorization it held is Ruobin's call. In live mode every write the system actor makes (the clip engine, the transcription run, now the import) went through the cookie client with no cookie behind it, so RLS refused the first write; `lib/data/supabase.ts` now switches those functions to the service role for the system session (`dbFor`): createTitle, addEpisodeFromIngest, addVideoOnlyEpisode, attachIngestToEpisode, getWorkbench, setEpisodeVideo, listClips, upsertClips, setClipStatus, recordJob, finishJob, heartbeatJob, generatePromoDrafts and appendPromoDraftsFromClips. `finishJob` and `heartbeatJob` take the session that recorded the job. `createTitle` accepts `source_locale` and an explicit `created_by`, because the system actor has no `core.profiles` row and the adaptation's creator is a foreign key to it. The ingest and replace-video routes check edit rights before any storage write (`assertTitleEditable`, both backends), so a refused upload leaves no orphan file. The uploader: `ep30.part.mp4` no longer parses as episode 30, and a file that names its episode lands on that episode only (a new row when there is none), never on another episode's open slot. `WORKSPACE_ROOT`, `STUDIO_LOCAL_MEDIA_DIR` and `STUDIO_WORK_DIR` are in `.env.example` and the launch configs; `ADS_TEXT_PROVIDER` and `ADS_VISION_PROVIDER` are in `.env.example` only, with their defaults in code (`lib/llm.ts`), so a launch config never has to name a provider (the phase-0 review's note).

Checks: `npm test` (459 unit tests, 24 new), `npm run typecheck`, `npx next lint`.

**Phase 1 delivered (2026-09-23): the import itself.** `lib/film-import/` reads the pipeline's files as they really are (`scan.ts`: a film is READY only with no `.part` render, files exactly 1..N matching the newest DELIVERED plan by numeric end, and no write in `eps/` in the last five minutes — `STUDIO_IMPORT_QUIET_MS=0` switches that off for the e2e server; `manifest.ts`: zod parsers for the plan, whisper, scdet, motion, candidates, source facts, the split vision records and the band-fix notes, and `explainBoundaries`, which names the record behind every delivered end). Migration `0015_film_import.sql` and the fixture add `source_ref`, `cover_path`, `crazydramas_slug`, `ad_rules` on titles, the import fields on episodes (`video_sha256`, `video_bytes`, `video_frames`, `film_start_ms`, `film_end_ms`, `end_note`, `auto_cut`), `studio.film_assets` (append-only, unique on title × kind × hash, read via `can_read_title`, written by the service role only) and the `import_film` job kind; `docs/data-model.md` §8 has the shapes. The job (`lib/film-import/import.ts`) runs as the system actor with the caller as the adaptation's creator, one running per film, cost 0, a heartbeat after every episode: it re-scans and refuses anything not READY, finds or creates the title by `source_ref`, hardlinks each episode into the local tier under a pending name, hashes the LINK, renames it by its hash, counts frames with ffprobe on the link (`-count_packets`), skips an episode whose hash the row already carries, writes the film window and `end_note`, flags a frame count off the plan (Mafia King's +1 cases) without stopping, slices the whisper words by the DELIVERED window into subtitle cues and attaches them through `attachIngestToEpisode` as `script_format 'asr'` (never over existing lines), copies the plan, index, vision, film-meta and poster files into the tier as film assets (their bytes written under the hash's name, never linked: the index writers and a hand edit rewrite the same inode in place, so only the episodes are hardlinks), makes the live poster the cover, writes film-meta's spoiler line and exclusions to `ad_rules` (review-added exclusions kept), re-reads the plan at the end (K_CHANGED when it moved) and leaves an import record (a Studio-made `delivered_plan` asset: the plan hash and each episode's size, mtime and hash) that the listing reads. The listing never hashes an original: IMPORTED / K_CHANGED come from the record against a stat of the disk, and the update run confirms by hashing the links. Never `scheduleClipCut`: an imported episode is born `auto_cut false`. Routes: `GET /api/producer/films` (+ `/poster`), `POST /api/producer/films/import` (approver; body `{source_ref, mode: import|update, attach_transcript, display_title}`) and the `/api/admin/films/*` mirrors (staff read, admin imports for a company). Pages: `/producer/films/import` under My titles ("导入影片") and `/films/import` on the staff rail with a company picker; one row per film with poster, editable display title, source title, episodes, size, pixel size, language, state with its reason, a fixed action column (Import · Update N changed · Open), the transcript checkbox and a progress line polled every two seconds from the in-process registry the job writes (`docs/terminology.md` register in Chinese, English on the staff side; keys `locales/_keys/film-import.json`). Fixture workspace under `tests/fixtures/workspace/` (three tiny films: ready, rendering, undelivered; `scripts/make-fixture-workspace.mjs` regenerates the media byte-identically) drives the unit tests and `tests/e2e/film-import.spec.ts`; the three real films carry a hand-written `cut/film-meta.json` (slug, spoiler line at 50 %, stingers / recap replays / TO BE CONTINUED cards as exclusions). Leftovers: `lib/jobs.ts` needed no change (`runJob` is the model-call gate; the import records its row through the data layer like the clip engine); `STUDIO_WORK_DIR` is the scanner's probe scratch, `withSourceFile` still uses the OS temp dir; marking `ad_cuts` stale on a re-render waits for the table (phase 4); an edited `film-meta.json` is picked up by the next Update, the listing does not flag it.

**Phase 1 review fixes (2026-09-23).** What the review of the commit found, all applied: the index, plan, vision, film-meta and poster files are copied into the tier, not hardlinked (the dry run showed `candidates.json` rewritten in place under its "snapshot" after a `--allow` re-index); a stored media path refuses a backslash, colon or NUL inside a segment and `localPathOf` checks the resolved file sits under the title it names (Next decodes `%5C`, so `ws%5C..%5C..%5C<other title>` passed the access check on one title and read another's folder); the request's `source_ref` is resolved to the film's canonical entry by folded realpath (`resolveProject`), so `Low-Quality/He-Hated-All-Women` or a junction alias is the same title, never a second; the job key is `import:<producer_id>:<ref>:<sha>` (company B no longer adopts company A's running or failed row); the "one running per film" guard claims the registry key synchronously before the first await and gives it back on a refusal; an episode's size and mtime come from a stat of the link that was hashed, not from the earlier scan; `duration_ms` is set from the probe (else the window length) before the transcript attaches, so the timeline and the export runtime no longer stop at the last cue; kept lines are flagged only when their episode's window or file moved, and an update to a shrunk plan flags the episodes past the new count; supabase `getTitle` reads through `dbFor` (the background continuation and scripts have no cookie); `linkIntoLocalTier` and the scanner's probe copy only on EXDEV and rethrow every other link error (a copy would hold the original open); migration 0015 revokes instead of granting the import columns to `authenticated` (no producer-facing write exists; a forged hash or window would be trusted by the ad engine); the film's last episode caps its planned frame count at the measured one (the container duration overshoots the source's last frame, a false "-2" on He Hated All Women). **Open question for Ruobin:** every producer company, viewers included, sees every film under `WORKSPACE_ROOT` and any company's approver can import any of them into its own catalog — in live mode a partner company would see and could import the pipeline films. If only Ruobin's company should see the workspace, the producer routes and the sidebar entry get a `WORKSPACE_PRODUCER_IDS` allowlist (a tenancy gate, not a rights gate; the staff desk stays as it is). Not built until he answers.

**Phase 1 review fixes, second round (2026-09-23).** What the review of the first fixup found, all applied. The media path, again: Next decodes `%2F` inside a catch-all segment just as it decodes `%5C`, so a producer signed in on their own title could read `GET /api/media/<own>/x%2F..%2F..%2F<other title>%2F...` — `titleIdOfMediaPath` passed the segment (not literally `..`, no backslash) and `resolveUploadPath` only checked the file stayed under `.uploads/`, where every title and the local tier live. A route segment now refuses a slash too (`BAD_SEGMENT_CHARS`), and `resolveUploadPath` applies `localPathOf`'s rules to a bucket path: split on `/`, no empty or dot segment, and the resolved file must sit under the title the value names. The plan's `moves`: the 02:01 QA session on He Hated All Women moved ep29's end 3276.333 → 3278.3, an ordinary legal candidate that needs no `--allow`, and declared it in the plan's own `moves` field, which `explainBoundaries` ignored, so the three QA-moved ends carried `end_note.decision 'none'` with no record and the real-workspace test turned the required gate red. `moves` is typed `{from, to}[]`, an end a move names is decision `qa_move` carrying the move and the vision record that judged the time it left (priority band_fix, chosen, skeptic, qa_move, none; `band_fix` stays false on it), and the invariant test accepts a QA move and requires a `none` end to be a legal candidate or an `--allow`, so a legitimate pipeline edit can no longer fail the gate. Staff previewing the producer portal got the desk's load-failed error (the listing route was producer-only): `GET /api/producer/films` and `/poster` admit a staff session and answer the states from disk alone, no company's import records. An imported title's `source_locale` is the film's own language (`sourceLocaleOf`: zh → zh-CN, else en-US, with a warning when the language is neither — The Cold CEO scans READY with Mandarin dialogue and would have been labelled en-US). The replace-video route and `setEpisodeVideo` (both backends) refuse an episode whose `source_ref` is set with 409 "this episode comes from the film workspace; update the film instead": a file replaced by hand would leave the hash, frames, window and end note describing the snapshot, and the next Update would have pointed the episode back at the workspace file without a flag. Migration 0015 also revokes INSERT on `core.episodes` from `authenticated` and grants the pre-0015 columns back (0001's table-level insert plus 0002's policy let a producer insert a row with any hash or window over PostgREST), and the fixture's `setEpisodeImport` and `addVideoOnlyEpisode`-with-import-fields now require staff or the system, as the Supabase layer does, so both modes refuse a producer the same way.

## 2026-09-17 · Launch round 3: the confirm dialog restates one request, and the monitor row stops repeating the money

Ruobin, on the round-2 screens: "this UI is completely garbage" (the confirm dialog) and, on the monitor's expanded row, "we dont need campaign lifetime budget, daily pacing, campaign ceiling, we dont need the spark code". Rebuilt by two Opus builders against the NN/G and Smashing Magazine guidance for consequential confirmations: restate the specific request and its consequence, put the facts in a scannable grid, make the button say what it commits to, and keep machine references out of headline content.

- **The confirm dialog** (`components/launch/LaunchConfirmDialog.tsx`, 600px, sticky header and footer, scrolling body) is: the title; one sentence naming the campaign count, the provider and the ad account and saying the campaigns start paused (a sandbox run keeps the test-launch sentence); a two-column facts grid (launch name, platform, ad accounts, campaigns, destination, landing page); one block per campaign with the account name, its budget and its ads; the bill as three right-aligned numbers (media budget, service fee, total billed); the staff authorization note; Cancel and the gold primary. The primary reads "Confirm launch · $X billed" in production; its accessible name stays exactly "Confirm launch".
- **A Spark code is never printed.** `AdCard` no longer names an ad by its code; an ad with no picture and no words is one line named by its position ("Ad 1 · TikTok", the new `line` and `fallbackName` props), on the dialog and on the monitor alike. The code stays in `title=` and `data-content-id`, which is what the browser tests now check.
- **The monitor's expanded row** drops the campaign lifetime budget, the approved ceiling, the daily pacing and the per-row "last checked" (the footer has it). What remains is one row per ad group (state, budget as "$20.00/day" or "$20.00 lifetime", bid, end), one row per ad with the provider's review word as a pill, and one label-size references line (campid, tracking link shown by its host, ad account with copy, provider campaign id). The budget is still edited through "Change budget", whose ceiling line is unchanged.
- New strings live in `locales/_keys/launch-round3-confirm.json` and `launch-round3-monitor.json`.

## 2026-09-17 · Pre-launch review: what a first real launch on either provider would have hit

Ruobin asked for one last pass over the administrative and producer sides before Meta business verification lands, so that ads go out on TikTok and Meta the day it does. The live database is fully migrated (read-only probes found every 0010–0014 object: launch runs, connections, clip posts with their lease columns, Instant Page templates, presets, the transcription enum values); the gaps were in the code paths a live launch takes and in what the monitor said afterwards.

- **Meta ad sets declare their audience.** Every new ad set sends `targeting_automation: { advantage_audience: 0 }`: the approved countries and age are the audience, and Meta refuses a new ad set that leaves the Advantage+ audience question unanswered. Read-back rules are unchanged.
- **A Meta schedule that has slipped.** A draft opens with a seven-day window counted from the moment it is opened; approved days later, Meta would have created the campaign and then refused every ad set for starting or ending in the past, with no way out but a new round. Preview now refuses an end time already behind the clock (`scheduleEnded`, `META_SCHEDULE_MARGIN_MS`), the driver refuses it again before creating anything, and a start that has slipped into the past begins a minute from now. A sent intent keeps the start it was sent with, so the reconciliation after a lost response compares like with like; only a rejected intent, which created nothing, may carry the corrected start. The signed end never moves.
- **A provider's "later" is a wait, not a failure.** A Meta rate limit, timeout, 5xx or lost response (codes 1/2/4/17/32/613, the set organic posting already waits on) and a TikTok timeout, unreachable host or throttle now leave the campaign `pending` with a `waiting` note and a 60-second wake-up (`providerRetryDelay`), resumed from its checkpoints: a lost write is reconciled by the driver's own intent record, never resent. Twelve waits and it fails for a person (`provider_retries`); a manual Retry starts the count over. Before this, the first rate limit of a first launch was a failed campaign.
- **Fewer Meta calls per write.** The worker's per-write ownership check re-listed every ad account, Page and Instagram identity through a forced inventory read before each of the roughly ten writes a one-campaign launch makes, enough on its own to trip a Development-mode app's per-hour call limit. It now reads through the inventory's fifteen-second cache (`getLaunchConnections(…, fresh = false)`); a revoked assignment is still noticed within that window.
- **A failed launch reads "failed".** A TikTok launch that failed before a campaign existed (every Spark code invalid, say) had its sweep answer "unknown", which the monitor rendered as *Not checked yet* for good and re-swept on every visit. The driver now answers `failed` for a failed row with no campaign, and `monitorState` says so whatever the sweep wrote; a failure after the campaign exists still shows what the provider holds.
- **The Sales Instant Page is crash-safe.** A create whose answer was lost used to stop the launch for good ("reconcile before retrying"). The retry now asks TikTok's public `/page/get/` (`business_type` TIKTOK_INSTANT_PAGE, the only family that returns Sales pages, as overlord verified live) for the campaign's uniquely named page: one match is adopted, none means the create never landed and it is sent again, and more than one, or a listing the token may not read, is still a person's to reconcile. Nothing is created twice.
- **Connections: the Page's own Instagram account.** Organic posts go out through the Page's token, and a Page can only post to its own Instagram account. The staff assignment preselects the Page-linked account, marks it in the list, warns on a mismatch, and the route refuses pairing a Page that has a linked account with a different one. Ads were never the problem; a Reel would have failed at runtime with Meta's own words.
- Small: a daily budget typed as 0 clears to "none" instead of a validation refusal.

Checks: `npm test` (435 unit tests, seven new), `npm run typecheck`, `npx next lint`, `npm run test:e2e` (60 browser cases, desktop and presentation), an isolated production build. This review made no live provider call beyond the read-only schema probe.

## 2026-09-17 · Launch and Monitor round 2: the content decides the platform, and every screen says it in words

Decided by Ruobin after using the round-1 screens. The plan of record is `docs/launch-ux-round-2.md`.

- **Content decides the platform, not a placement switch.** A Facebook post is a Facebook ad, an Instagram post is an Instagram ad, and an uploaded clip runs wherever the placements say. Placements are therefore shown only while the draft holds an uploaded clip, and they govern only the clips; a post never consults them. The old "Instagram content while placements exclude Instagram" warning is gone because it can no longer happen.
- **One ad set per platform inside a campaign.** A campaign whose content spans both platforms gets two ad sets, each carrying only its own platform's ads and an equal share of the campaign's signed budget, each share at or above Meta's minimum — otherwise the preview refuses. Controls apply to every ad set of the campaign, and the monitor lists them. The split is derived from the signed content and budget on every driver call, so a stored split is never the authority.
- **Only an uploaded clip takes copy.** Primary text and Headline appear for clips alone; an existing post carries its own caption, and the screen says so instead of offering boxes whose words would be silently dropped.
- **The campid works like overlord's mass launch.** One *First campid* names every campaign by counting its trailing digits up with the padding preserved, it is the Meta campaign name, it is appended to the destination as each campaign's tracking link, and it is part of what the approver signs. It must be free on the ad account: the preview says so, and the driver reads the account back before it creates anything, so a launch never adopts a campaign it did not make. A new round starts from the campid after the last one the previous round stamped.
- **The launch name is the thing people see.** It defaults to the company and the date, can be renamed at any time from the monitor, and Studio shows a campaign as "<launch name> · <n>" everywhere. No screen leads with `lr_…`, `act_…` or a post reference; those live on expand, in small text or in a tooltip. Daily pacing is labelled optional, because the lifetime total is what caps spend.
- **The confirm dialog is a preview of the ads.** Per campaign: the ad account, the budget, one card per ad with its thumbnail, platform, the words it will carry, and one small line with the campid and its tracking link. The same card renders in the chosen list, the preview table and the monitor's expanded row, so the four can never disagree.
- **Monitor states are sentences a person would say.** A launch that has never been swept reads *Not checked yet* and sweeps itself; a campaign whose switch has not been read reads *Created paused*, with the switch disabled until it is. A failure shows the provider's own sentence with a plain-language next step above it when the code is one we recognise.
- **Renaming is not re-approval.** A rename changes the Studio name only: no Meta or TikTok object is renamed, and the approval it re-signs is the same signed intent, verified before it is written.

## 2026-09-16 · Organic Meta posting: clip → post → ad in one screen

Decided by Ruobin: staff see every producer's rendered clips in a **Clips** tab that mirrors the producer's, post chosen clips organically to the company's Facebook Page and Instagram account from the Launch tab, and use the resulting ids as the ad content without pasting anything. Meta can do what TikTok cannot — the post is created by API and its id is immediately usable as the ad creative — so the whole chain is one screen. The plan of record is `docs/meta-organic-plan.md`.

- **The post record is the source of truth for "posted".** `promote.clip_posts` (migration `0014_clip_posts.sql`, sharing version 0014 with the instant-page templates the way 0006 is shared) holds one row per clip × platform × connection attempt, with the same CAS `revision` discipline as `promote.launch_runs` and the same RLS: read for staff or the company, no insert/update/delete policy, writes through the server-only service. The Clips tab, the Launch popup and the monitor all read it; nothing infers "posted" from Meta on the fly.
- **Facebook posts are Page video posts** (`POST /{page_id}/videos` with the stored clip bytes), promotable as `object_story_id` and needing no public URL. Facebook Reels are a later second post type. **Instagram posts are Reels** (`media_type=REELS`, `share_to_feed=true`), because Instagram accepts video only through Reels; Instagram fetches the file itself, so Studio mints a 15-minute signed storage URL for that one call. Fixture mode mints nothing.
- **Caption default** is the clip's hook on the first line and the title (with its episode number) on the second, editable before confirming; the destination URL stays out of the caption because the ad supplies the button. A clip with no hook falls back to the title alone — a `clip_…` reference is never pre-filled into public copy, and a caption equal to one is refused.
- **Who may post:** a staff administrator or the company's approver — the same rule as launching, because a public post is money-adjacent. Reviewers, viewers and staff editors **read** the Clips page and the state of every post; they just cannot make one. Both backends audit `clip_post_created`, `clip_post_published`, `clip_post_failed`, `clip_post_retried` and `clip_post_superseded`.
- **One live published post per clip per platform per connection** — a partial unique index `where status = 'published' and superseded_by is null`, mirrored in fixture. A failed attempt is retried from its stored step. "Post again" is a deliberate extra row with a confirm, and it is legal: the new row persists its own post id first, marks the row it replaces `superseded_by`, and only then becomes published. **Studio never creates a public post it cannot record** — any refusal after a post id exists keeps the id on the row with a sentence naming it.
- **Publishing runs in the background** under a ten-minute row lease (`lease_owner` / `leased_until`, the shape `promote.launch_runs` already uses), so two processes on one database cannot both upload; the sweep only takes a row whose lease is absent or expired. `step` is persisted before every external call, exactly like a launch run, and `attempted_at` is persisted immediately before the call itself. A crash between a create and its persistence is closed on resume by the stored id, or by adopting an existing Meta object — but **only** on a row whose `attempted_at` says it sent that call, only when the object is not already held by another post row, and, on Facebook, only when the video title carries that row's own id (Meta stores a title verbatim). Two ad accounts can share one Page and two clips can share a caption, so a read-back match alone is never proof of ownership; more than one match is reconciled by a person, never guessed. A transient refusal (rate limit, 5xx, timeout, codes 1/2/4/17/32/613) leaves the row `publishing` at the same step for the scheduler sweep; a permanent refusal fails it with the reason. An ambiguous timeout after a POST is never treated as a failure to re-issue.
- **The Page access token is derived per call** (`GET /{page_id}?fields=access_token` with the configured token) inside `liveMetaTransport.forPage(pageId)` and used only for that request. It is never stored, logged, seeded, returned or put in an error message; the fake's `forPage` returns itself.
- **The live gates do not move:** fixture mode always uses `lib/meta/fake.ts`, a live POST still needs `META_LIVE_WRITES=enabled`, a clip must be `rendered` with a stored SHA-256, and that hash is re-verified on the exact bytes Studio uploads. Instagram's rolling 24-hour quota is read before every Reel and refuses with the number when it is exhausted.
- **The launch content popup has three tabs:** Studio clips, *From the Page* (the newest 25 Page posts and 25 Reels, read only, cached 60 s) and the existing paste box. Draft content carries `clip_id`, `post_id` and a human label (title · hook) so the preview, the confirm dialog and the monitor name the clip; the id stays visible on expand.
- `scripts/meta-readiness.mjs --scopes` inspects the configured token with `GET /debug_token` and prints the granted scopes and the token type — never the token — so a missing `pages_manage_posts` or `instagram_content_publish` is found before the first post fails. `META_FAKE_PUBLISH=ig_error | fb_throttle` drives the fake's failure paths.

## 2026-09-16 · Unified Clips, Launch and Monitor acceptance

The user's final instructions supersede the older single-campaign Promote journey: use one clipping engine, keep TikTok download/post/Spark authorization manual, paste codes in Launch, and support Meta existing posts and finished Studio videos in the same preview/approval/monitor process. Meta and its optional MCP integration are requested scope. Revenue, Pixel and Conversions API remain deferred until Ruobin is consulted.

The preview signs the total lifetime amount across one provider run, split among campaigns; each campaign's original signed allocation is its ceiling for in-place controls. Reductions can be restored to that ceiling; a higher ceiling requires New round, fresh preview and approval. Daily pacing remains a separate limit. Staff-admin launches record an on-behalf note.

The old creation, approval, submission, retry and relaunch paths are closed in routes and data methods. Earlier campaigns preserves records, creatives, results and delivery stop controls. The old scheduler reads review and metrics; adoption and auto-copy require the explicitly off-by-default `LEGACY_PROMO_RECOVERY` switch. The unified launch sweep owns new creation. Demo reset preserves other companies' launch records, assignments and fake provider objects.

Acceptance covers actual clip previews/downloads, multi-account Spark allocation, both Meta content modes, observed monitor states, control ceilings and the history cutover. Local checks and live evidence are recorded in `launch-acceptance-2026-09-16.md`; database deployment, real paused launch and official MCP authentication are separate gates. The user supplied `https://crazydramas.com` as the real destination.

## 2026-09-16 (earlier) · Launch settings, controls and the monitor: the overlord process inside Studio

Decided by the founders (Ruobin): "I need to solidify the TikTok launch process, similar to Pulsar Grow … connect real TikTok BCs, streamline the UI, and launch a real ad to a real TikTok account … make it the exact same setup as Pulsar Grow, where we are essentially able to manage, launch, stop, change bids, budgets, etc., connect BCs … the only difference is that we will link BCs to companies … not lowest cost: you should have everything that we have in overlord for launch settings … we can let producers do that [manage their campaigns] … for real mode, go with your recommendation [Supabase]." What crossed over from overlord and Grow is the launch-settings model, the account fingerprint, the post-launch controls and the launch monitor; what stayed behind is everything built for affiliate offers (Instant Pages, display cards, tracker links, warm-ups, Smart+, appeals, the rules engine).

- **Why the founder could not connect an account.** The local server runs `DATA_SOURCE=fixture`, and fixture mode is hard-wired to the fake TikTok (decision 2026-09-09), so the Connect button never rendered there. A production authorization from 2026-09-09 (153 ad accounts) already sits in `.tokens.json`; it is only consulted in Supabase mode. The answer is a launch config, not a rule change: `studio-live` (`DATA_SOURCE=supabase`, `TIKTOK_MODE=production`) in `.claude/launch.json`; the staff page now says so in fixture mode. The invariant stands: fixture mode never reaches a real TikTok.
- **Launch settings (`lib/tiktok/settings.ts`, `lib/tiktok/options.ts`)** are one typed record on the campaign (`promote.campaigns.launch_settings`): locations (TikTok's catalogue through `lib/tiktok/regions.ts`, cached on disk), ages, gender, languages, OS, placement (TikTok only / automatic), budget shape, schedule, optimization goal (clicks/CPC or landing page views/oCPM), bid strategy (lowest cost / cost cap in the field the billing event keeps it in), pacing, comments, CTA (the full website set, Watch Now first), launch state (live / paused), auto-duplicate copies (0–19) and a campaign name prefix. Staff keep Pulsar-wide presets (`promote.launch_presets`, migration 0012); a producer picks one or customizes; the launch row snapshots the settings it used ("values travel"). The editor is the same component on both sides; the no-cap warning is loud, as in overlord.
- **The money stays the signed number.** Lifetime shape: the campaign is uncapped and every ad group (the original and its copies) holds an equal share of the approved budget — the sum is exactly what the approver signed. Daily shape: each ad group runs its daily amount and the campaign carries the approved budget as a lifetime cap (TikTok's $50 campaign minimum applies). `validateLaunchSettings` refuses a split below TikTok's $20 ad group minimum; the launch gate names it (`settings_invalid`) and the submit refuses it in both backends.
- **Controls (`lib/tiktok/controls.ts`, one dispatcher `lib/tiktok/control-actions.ts` behind `/api/promote/[id]/controls` for staff and `/api/producer/promote/[id]/controls` for the company's approver):** pause/resume (read back), end (terminal; switched off on TikTok), change budget (a new signed experiment version by the approver, or an audited staff override that never signs as the approver; re-shared across active groups or moved onto the campaign cap), change daily budget, set a cost cap (a capped group is edited in place; a lowest-cost group cannot take a bid — TikTok refuses, probed in overlord — so it is replaced by a capped copy with the same ads and retired), move the schedule end, duplicate ad groups (lifetime: re-shared first), switch one ad group. Every control loads the campaign from our records (the account and ids never come from the request), writes TikTok, reads back where TikTok lies (a suspended account answers 0 and ignores the switch), and records through `recordLaunchChange`. `setPromoCampaignDelivery` admits the company's approver for the same reason.
- **Crash-gap adoption (overlord):** the campaign, ad group and ad names are unique per launch; "name already exists" means "ours, unsaved" and the object is adopted, so a run that died between a create and its save never makes a second object. Ad ids lost from the row are recovered by name on the next run (the earlier test that expected re-created ads now expects adoption).
- **Auto-duplicate (`lib/tiktok/autodup.ts`, run by the scheduler each tick):** once an ad clears review, N copies of the ad group are created with the lifetime shares the launch already planned (or the daily amount under the cap); decided once (`duplicated_at`); a launch whose every ad is rejected, or that ended, settles without copies; a paused launch never triggers.
- **The monitor (`lib/tiktok/monitor.ts`, `/api/promote/monitor`, `/api/producer/promote/[id]/monitor`):** per launched campaign, three reads — the campaign (switch, PUNISH = suspended, cap), the ad groups (switch, budget, bid, schedule end; original, copies, retired) and the lifetime report — plus the review rollup and the account's status; cached 90 s, invalidated by every control and tick. The Promote desk's launched queue is now that table with the on/off switch on every row; the campaign desk page and the producer's campaign page carry the delivery panel with the controls. The review poll additionally settles `ended` when every ad of a lifetime launch reports finished, and writes the suspended-account note.
- **Business Centers link to companies (the staff `/tiktok` page, rebuilt on Grow's TikTok tab):** verdict, Connect a Business Center, the BC table with the linked company on every row, one BC's accounts with health and the usage fingerprint (`lib/tiktok/fingerprint.ts`: campaigns, active, geo countries; filter chips), authorizations (never tokens), requests, presets, the scheduler. The single-account assignment stays as an explicit override. **Producers see their own Business Center** (Company & accounts): every ad account inside it with health and linked handles, which one the next launch uses, and a preferred account (`core.company_accounts.preferred_advertiser_id`; the pick still requires ready with a handle).
- **Relaunch on another account** (staff, `/api/promote/[id]/relaunch`): the suspended-account escape hatch — only after end or failure, only inside the company's BC, a NEW launch row (`…:relaunchN`) with the same manifest and budget. The one explicit, audited door out of `ended`.
- **What stays out:** Instant Pages, display cards, tracker links and revenue attribution, warm-ups, Smart+, appeals, the rules engine, multi-account fan-out at launch. The producer's flow is unchanged: brief → ads → budget → launch settings → Launch on TikTok → delivery.

**Review of the same day (Codex, eight findings, all accepted; the fixes are in this entry's scope):**

1. *A budget change before auto-duplication could exceed the new total.* `changeBudget` now shares across `plannedGroupCount` — the larger of the groups that exist and the groups the launch still plans (`duplicate_copies + 1` until `duplicated_at`) — and the auto-duplicate pass re-shares the existing groups to the current share before it creates a copy. Manual duplication settles `duplicated_at`, so the pass never adds its copies on top of a person's.
2. *Relaunch after a partial failure left the old campaign on.* `relaunchOnAnotherAccount` (`lib/tiktok/controls.ts`) switches the previous TikTok campaign off and reads it back before the data layer writes the new launch row; no confirmation, no relaunch (a suspended account that ignores the switch is named). The campaign note records which campaign was retired.
3. *A cost-cap replacement renewed the lifetime allowance.* The copy gets `old budget − spend so far` (from `/report/integrated/get/` at the ad group level) and is refused below TikTok's $20 minimum; the copy is recorded before the old group is switched off.
4. *A bid change re-enabled a paused group.* The replacement inherits the old group's switch state (`createAdGroupCopy` takes `operation_status` in its override).
5. *Resume did not activate a launch created paused.* The first switch-on of a `start_paused` launch enables its ad groups and records `activated_at`; later intentional group pauses survive later campaign pause/resume.
6. *Copy ads fell out of creative results.* `creativeByAdId` maps every copy's ads to the original creatives by position (a copy submits the same creatives in the same order), and `resultsFromReport` sums every variant per creative and day.
7. *The setup page overwrote its own loads.* `run()` takes the exact refresh that follows, or none.
8. *Live controls kept no audit trail.* The Supabase layer writes `core.audit_events` (service role, actor and before/after, `service` for the system actor) for launch controls, settings, presets, the preferred account and both assignments. And the pre-existing gap the review named: 0012 now installs `core.guard_company_account_write`, a trigger that lets a non-staff caller change only `preferred_advertiser_id` on a staff-assigned row and never set or move `assigned_by`, `assigned_at` or the identity columns, in SQL and not only in the data layer.

Checks: `npm test` (234, including `tests/tiktok-review-fixes.test.ts`), `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e`. Migration `0012_launch_controls.sql` must be applied (with 0010 and 0011) before the first real run; there is no Supabase CLI on this machine, so it goes through the SQL editor.

## 2026-09-15 · The one-page title report is the outbound artifact

The reports page (0005) is inbound only — a producer imports their own
platform CSVs. The other direction did not exist: the person our contact
answers to never logs in, and "what did Pulsar find?" was five screenshots.
The report closes that gap as a forwardable sheet, the same principle that
made the bilingual diff the unit of output.

- **One page per title** (`/producer/titles/[id]/report`, "导出报告" from
  the title overview): the US launch priority with its component points,
  the latest MEASURED round's per-ad results against both benchmarks with
  the winner and its ad text (a newer draft round never erases them; a
  campaign that has not reported prints "尚无广告结果", never "no
  campaign"), the TikTok summary, the market comparables, the
  readiness counts and the assessment's next steps. Read-only, assembled
  from the same reads as the sections it summarizes (`loadTitleWorkspace`,
  `readResults`), so the report can never disagree with the workspace.
- **Export is the browser's print-to-PDF** ("保存为 PDF"): `report.css`
  strips the app chrome and pins the color tokens to paper values in
  `@media print`. Nothing is generated or stored server-side — the
  exports rule (rendered on request, never stored) applies unchanged.
- **Provenance travels**: demo labels (演示数据 / 演示结果（模拟）),
  data-through dates, the score-note ("not a success probability") and an
  evidence-label footer print with the numbers. Empty sections say so
  (尚无广告活动, 未关联条目) instead of inventing zeros.
- Chinese-first like the rest of the portal; the chrome locale cookie
  still wins, so a staff preview can export the English rendering.

## 2026-09-15 · Transcription fills a script-less episode, by explicit button

The v1.1 slot the ASR stub reserved (`lib/asr.ts`, job kind
`transcribe_episode`, docs/build-plan.md) is filled, prompted by the
starter company shipping five video-only episodes: without a script an
episode cannot be adapted, only gets the footage-signal clip path, and
eats the launch-readiness subtitle penalty. The V1 rule stands — nothing
is ever transcribed silently.

- **One explicit button** (转写字幕, Materials, editors only, shown only on
  an episode with a video and no lines): reads the audio into timed
  subtitles and refreshes the page. When no provider is configured the
  button is disabled with portal words and the technical reason on hover,
  the auto-sync pattern.
- **Provider-based like alignment** (`STUDIO_ASR_PROVIDER`,
  docs/transcription.md): `local-whisper` (faster-whisper on CPU,
  `scripts/transcribe_episode.py`, word timestamps + VAD, language
  auto-detected) spends nothing and may run in fixture/demo mode the way
  the ffmpeg burns do; `openai` (whisper-1, verbose_json) is a REAL model
  call — demo replay refuses it (`DEMO_REPLAY=0` overrides) and the job
  carries the audio-minute cost, rounded up to integer cents.
- **Words become subtitle cues, not paragraphs** (`transcriptToCues`,
  pure, tested): break on ≥600 ms silence, sentence-final punctuation once
  a cue has ≥1.2 s of substance, a 6.5 s screen-time cap and the 42-char
  width budget; starts clamp to the previous cue's end; nothing under
  300 ms. Latin words space themselves (the leading space rides inside the
  token), CJK concatenates bare.
- **The stored file and the lines cannot disagree**: the cues are written
  as a real WebVTT (machine NOTE naming provider/model/language) into
  storage, the episode's `script_format` becomes `'asr'`
  (`source_script_path` set), and the SAME bytes are parsed back through
  `lib/ingest` and attached via the new `attachIngestToEpisode` (both
  backends; refuses an episode that already has lines — a script is never
  silently replaced; scenes, draft version and the cost-0 parse job exactly
  as an uploaded SRT). Migration `0011_transcribe.sql` adds the reserved
  enum values and the producer episode-update policy the timing desk's SQL
  path was silently missing.
- **The clips re-rank afterwards**: a forced `cut_clips` run follows the
  attach, so `find_clips` can rank from the script where AI is enabled; in
  demo replay the selection honestly stays on footage signals.
- **Speaker attribution stays open** (the stub's planned LLM pass from the
  character notes): ASR hears what was said, not who — the parsed lines are
  restored to the EXACT machine cues with `speaker: null`
  (`restoreMachineLines`), so the generic parser's speaker heuristic can
  never strip "他说：…" or "[Music] …" out of machine text.
- **Hardened by an adversarial review before merge:** job bookkeeping runs
  through the system actor like the clip engine (producers never gain read
  access to `studio.jobs`; a failed run resurrects its own row in both
  backends); the run heartbeats every 2 minutes so the concurrency guard
  stays honest for the whole 8-minute budget, and a failure never clobbers
  a concurrently-finished done row; the openai provider extracts the audio
  track first (16 kHz mono AAC — the endpoint caps uploads at 25 MB) and
  its spend is recorded on the job even when a later step fails; both
  providers' output passes a zod schema; 0011 follows 0001's own
  revoke-the-table-grant-the-columns rule so the new producer episode
  UPDATE policy exposes exactly the script/timing/video-path fields (the
  blanket 0001 grant would otherwise have opened every column); a
  half-attached episode (scenes without lines, a torn non-transactional
  attach) self-heals on the next attach instead of refusing forever. Known
  pre-existing defect noted, not fixed here: supabase.ts's three episode
  UPDATE call sites address `studio.episodes` instead of `core.episodes`
  (retime, duration backfill, replace-video).
- Verified with a real run: faster-whisper `small` on the Mandarin demo
  minute scored 94.3% character recall against its reference SRT with
  median cue-start drift 230 ms (p90 450 ms, 19 s on CPU;
  `scripts/asr-smoke.ts` prints the scoring), and on the starter company's
  English footage end to end in the browser — 17 timed lines, the button
  disappearing once the script exists.

## 2026-09-14 · A revision keeps its finished file unless the window moved

Follow-through on the same day's "clean cuts" decision, found rehearsing the
change-request flow: `revisePromoCreative` always discarded the parent's
`render_path`/`render_sha256`, which was right while the hook was burned
into the picture and generation re-rendered every unrendered creative — and
wrong now that copy is ad text and campaign generation reuses clip files
without re-rendering. A staff answer that only rewrote the copy threw away a
finished file nothing would rebuild: the revision previewed as raw source
footage and, in the live modes, parked the launch gate at "unrendered
creatives" with "generate the ads again" refused on a review campaign.

- **Copy is not pixels.** A revision whose clip window equals its parent's
  keeps the parent's `render_path` and `render_sha256` (both backends, one
  `windowChanged` rule). Rendered files are never deleted, so versions may
  share a file; the manifest still freezes the exact `pc_` version and hash
  the producer approved.
- **A moved window starts unrendered and re-cuts itself.** The revise route
  kicks the campaign's background render (`renderCampaignInBackground`,
  ffmpeg-gated) after a window change, through the same cutter as every
  other ad file. Without ffmpeg the behavior is unchanged: the gate says so,
  and fixture's fake launch still accepts the source file.
- Tests pin both halves (`tests/promote.test.ts`, "a copy-only revision
  keeps the finished file; a moved window re-cuts").

Checks: `npm test`, `npm run typecheck`, `npx next lint`, `npm run build`,
`npm run test:e2e`, and a live desk walk in fixture mode (copy-only revise
keeps the file and hash; a moved window re-cuts in the background with
ffmpeg 9.0.1).

## 2026-09-14 · Ad angles, clips cut after upload, and a budget-gated pick

Decided by the founders (Ruobin) from the brief `docs/auto-clips-brief.md` and the conversation that followed: "in the end state there will be a few different types of ads or angles … build out this infrastructure first … the customer will pick the ads they choose to run; each ad will have a minimum budget … direct clipping will be the first angle … keep them between 20-30 seconds … capture either the intro (trailer-esque) or a crazy heartbreaking moment … if an episode's English subtitles aren't approved, don't spend the time or the tokens to burn it … narration as greyed coming soon". The end goal is a live walk: upload a mini drama, watch the clips appear, pick ads, launch on production TikTok with real spend.

- **Angles are the unit an ad belongs to** (`lib/angles.ts`): a registry entry says how the material is produced, what the title needs, and the minimum budget one ad needs to be worth running ($50 for direct clips). `direct_clip` is active; `narration` is registered as *coming soon* and shown greyed on the campaign page so the direction is visible; it has no engine and nothing can pick it. The legacy concept kinds (`ugc_*`) count as direct clips for the budget rule.
- **Clips cut themselves after an upload** (`lib/clips/*`): the ingest route and the replace-video route schedule `cutEpisodeClips` in the background (`scheduleClipCut`; `PROMO_RENDER=off` disables it, which the tests set). One `cut_clips` job per episode + video + clip-rule version, cost 0; a second run is refused while one is alive; a run whose heartbeat is ten minutes quiet counts as dead and is superseded; every row ends `rendered` or `failed` with a note; the six strongest are rendered; rendered files are never deleted (an approved creative may point at one). The producer's Materials page shows an **Ad clips** block per episode (state, rows with time range, hook, moment, an *inferred* why, Preview and Download in a fixed action column, **Cut clips again**) and polls while cutting; `GET/POST /api/producer/titles/[id]/episodes/[n]/clips` serve it.
- **Selection is script first, footage second.** A timed episode with lines is ranked by `find_clips` (prompt `clips-v2`: 6–10 moments, cut 20–30 s, each tagged `opening` or `peak`; episode 1 must return exactly one opening); the range is clamped to the rule (`clampClipRange`) and never runs past the probed duration. Without timecodes, lines, a provider key, or under demo replay, the moments come from scene cuts and EBU R128 loudness (`scoreWindows`, pure and tested): 25 s windows, snapped to a cut, non-overlapping; those rows carry no hook and a fixed "chosen from footage signals" why. The SQL trigger and both `upsertClips` now accept clips on an untimed episode that has a video (migration 0010, which also adds the `cut_clips` job kind, the render columns and a producer read policy on `studio.clips`).
- **Clean cuts: nothing is burned into the picture.** The first build burned the hook and the approved English into the clip, as the brief asked; on seeing it Ruobin decided the same day that burned text "is not necessary for now, and won't ever be necessary". The hook is ad copy: shown beside the clip on Materials, carried on the creative and sent as the ad's text; captions are not produced at all (draft or approved). The campaign renderer (`lib/promote/render.ts`) uses the same cutter (`lib/clips/cut.ts`) and no longer burns the hook either.
- **Framing follows the source's shape** (`frameFilter`, same day: "the resolution is terrible"). A vertical source is scaled to cover 1080×1920 and center-cropped. A landscape source is never zoom-cropped (a 16:9 frame cropped to 9:16 keeps a third of the width blown up 2.7×): it is scaled to the full width, kept whole, and placed over a blurred copy of itself with its bottom on the 35 % band, so the platform UI never covers the picture. Encoding is libx264 crf 20; quality is bounded by the upload.
- **Campaign ads come from the clips.** `generatePromoDrafts` (both backends, one mapping in `lib/clips/creatives.ts`) builds up to 8 ready creatives from the title's rendered clips, opening first, copying the file and hash so nothing re-renders and review opens at once; only when no rendered clip exists does it fall back to the fixed-offset concepts, with a `status_note` that says so on the page.
- **The producer picks within the budget.** Ads are grouped by angle on the campaign page; the toolbar says how many ads the budget covers at $50 each and how many are chosen; **Approve ads** is disabled and refused (both backends, before the manifest is frozen) while the pick is over budget; a chosen ad can be **unselected** (`reviewPromoCreative` accepts `ready` from `approved` only). Manifest, approval, launch and the ad-group budget are untouched.
- **Demo.** Title 1's two finalized episodes are seeded with six clip rows whose hooks are lines from the sample footage's own script (the demo catalog's invented scripts never reach a clip); the fixture store cuts the real files with ffmpeg the first time the seed loads and caches them under `.uploads/` with a sha sidecar (`ensureDemoClips`), so the rehearsal shows genuine cuts and a machine without ffmpeg shows the failure honestly. The e2e journey chooses two of the five ads on the $100 round (slots, not a warning) and checks the Ad clips block on Materials.
- **The pick is slots, not a warning** (UI pass the same day: "the budget / ad interaction should be obvious … angles more obvious, e.g. tabs on top"). The campaign page turns the budget into slots (budget ÷ $50), fills them as ads are chosen, greys every Choose button when they are full and says what to do; angles are tabs above the ads (Direct clips; Narration disabled as coming soon); each card says what it reserves. The data-layer refusal stays as the backstop.
- **Review pass, same evening** (two reviews of the episode → clip → render → launch pipeline, Ruobin: "I'd fix these before launching real TikTok ads"): (1) **no placeholder ads at all** — the fixed-offset fallback and the `ugc_*` concept rows are gone; Generate ads builds one candidate per finished clip (no cap), refuses without any (`NO_CLIPS_MESSAGE`) and the route starts cutting instead; an open round takes clips that finished since ("Add new clips"). (2) **Truthful launch settings** — the brief states the only delivery the launch sends (United States, website traffic to the destination, optimized for clicks), the objective is a business-goal record, spoiler level / direction / exclusions are labelled as review notes, the "spends nothing" line appears in the fake mode only, and the launch summary names the destination and ad count. (3) **One ad text** — the hook is what TikTok gets (`adTextOf`, 100 characters), shown on the card exactly as sent; caption is a record. (4) **Recovery** — a staff revision schedules its own render; the launch submits ads per creative, fails with the list when any approved ad is not on TikTok and a retry submits only the missing ones; the campaign page's poll is mounted by the page; new-title upload keeps the created title and finished episodes across a retry; a count keystroke never drops a row that holds a file. (5) **Media and budget** — a 216 px player with a per-card file state (finished / source preview), source previews stop at the out point (media fragment), live-mode approval requires finished files, `MIN_BUDGET_USD` ($50) is the one floor at create / edit / pick, slots read as planning capacity with the shared-budget note, Choose greys out when no slot is left (including a budget below one slot), the meter caps at 12 boxes, upload rows stack on phones and touch targets are 44 px. Clip rows say whether the moment came from the script or from footage signals; clip-backed cards show the reasoning in the reader's language. The demo seed carries clips on every title with video, rounds built from them, and the two results rounds are `live`.
- **ffmpeg is capped, same night.** Dozens of ffmpeg processes (close to a gigabyte each) piled up on Ruobin's machine: every demo reset during an e2e run rebuilt the seed and started cutting the same demo clips again. Now `runFfmpeg` queues behind a process-wide gate (`FFMPEG_CONCURRENCY`, default 2) whatever asks, the demo cutter runs once per process and remembers finished files (`demoCuts`), and the blurred fill is built at a quarter size. Renders still run on the web server; a worker stays the next step.
- **QA run 2026-09-15** (a five-episode video-only title through the API, seven real clips verified by ffprobe): (1) the tester's title "disappeared" because the fixture store rebuilds when `SEED_VERSION` changes, and it was bumped twice during the test — the rebuild now logs a warning naming the cause; fixture data is in-memory by design and Supabase mode is unaffected. (2) The fixture login can name a company (`producer_id` on `/api/auth/dev`, cookie `producer:<uuid>`, a field on the login card), so a company created in the session can be walked as a producer; the producer clips GET is read-only for any signed-in session so staff preview polls too. (3) The staff uploader accepts a video alone, as the API always did. (4) The staff title page shows each episode's ad-clip state and, for a video without a script, says the clips cut themselves and the producer picks ads. (5) Materials clips have an inline phone-proportion preview so a landscape source (the picture is ~32 % of the frame over the blurred fill) is judged before an ad is chosen.
- **Demo mode keeps its data and has one login per company (2026-09-15, Ruobin: "make it simple and make different login accounts, and save the data there").** The fixture store is written to `.uploads/fixture-state.json` after every access (debounced, atomic) and read back at start; the demo studio (Xinghai) is always rebuilt from the seed so demo rows follow the code, and every other company with all of its rows is carried over — across restarts, seed-version bumps and the Reset demo button. The login card shows one "Sign in as …" button per company (`producer_id` on the dev login, cookie `producer:<uuid>`), named after the company. `FIXTURE_PERSIST=off` disables it (the unit tests, and the `studio-fixture-3201` e2e server, which must never share the file with the developer's own server on 3200); `FIXTURE_STATE_FILE` moves the file. Supabase mode is untouched. Tokens never enter the store, so nothing secret lands in the file.
- **Starter company shipped with the repository (2026-09-15, Ruobin: "make sure to hand off the video and the company").** `data/fixture/starter-companies.ts` seeds *Idiots in Cars*: the five one-minute episodes of Ruobin's launch test, re-encoded to 720p under `docs/demo/idiots-in-cars/` (56 MB), no subtitles. On first load the real engine cuts its clips (footage path) one episode after another. Unlike the demo studio, a starter is seeded once: as soon as the saved state has it, the saved version wins, so campaigns built on it survive restarts and Reset demo; a saved company with the same English name replaces the starter. The producer can also write an ad's TikTok text on the card (`setPromoCreativeText`, 100 characters, review only); the clip row and the campaign card both say "Ad text", never "hook", in producer copy.
- **Not done, on purpose:** montage, a 4:5 feed variant, voiceover or music, a Meta launch from Studio, moving renders off the web server (note for when more than one producer uploads at once), snapping script ranges to scene cuts, carrying chosen clip ids from Materials into a specific round (every finished clip is a candidate instead), a focused review player, per-ad launch status on the page beyond the failure note.

Checks: `npm test`, `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e`. The real cut needs ffmpeg (`winget install Gyan.FFmpeg`; `FFMPEG_PATH` names the binary when a shell's PATH does not carry it, and the `studio-fixture` launch config sets it). Verified the same day with ffmpeg 9.0.1: `npx tsx scripts/clips-smoke.ts` cut the demo episode (1280×720) into two 25 s 1080×1920 H.264/AAC clips through the footage path in under four seconds, whole picture over a blurred fill.

## 2026-09-10 · Published audience research sits under the US overview, as dated references

Codex (branch `codex/us-audience-evidence`) added a "Who to make the first titles for" section at the bottom of the US overview, reviewed and merged by Ruobin with fixes. Kept: hand-transcribed facts from three publications in `lib/research/audience.ts` (Sensor Tower 2024: 72% of ReelShort's US users female; Pew 2025: platform use by age and by gender, marginals only; YouGov September 2025: five titles by online demand, names only), each registered as a `publication` source and metric in `lib/research/registry.ts` with its original denominator and window, labelled `estimated` (third-party figure) or `inferred` (the report's qualitative genre reading). The section renders outside the snapshot condition, so a failed crawl never hides it, and nothing in it feeds a score or the launch priority.

- **Publications are references, not feeds.** `status_rule: "publication"` always reads `available`; the source card says it is re-read by hand. They are listed after the live catalogs on Data & Sources, never ahead of them.
- **No ethnicity in producer copy.** The branch's copy rebutted a "white women aged 25–45" brief that the product never states; that sentence, and every ethnicity mention, was removed from the UI and the metric limitations. The research note (`docs/audience-research-2026-09-10.md`) keeps the full record of what was and was not retrieved. Age × gender × genre stays null until an authenticated audience export exists; never fill a matrix with placeholders.
- **Marginals stay marginal.** The Pew table is penetration within each group; the copy says so and the unit test asserts women + men > 100 so nobody normalises it into a composition.
- Open: the Sensor Tower link points at a third-party rehost of the PDF (page 13). Replace with Sensor Tower's own page when one is found.
## 2026-09-10 · Market signal counts what the platforms are launching now

Decided by the founders (Ruobin) while rehearsing the demo: the What to make next board said a title's story types were launching at twice their usual share while its US launch priority showed "Market signal 5 / 10 · moved 0 pts", so the two pages disagreed. Assessment v1.1 (`lib/research/assessment.ts`):

- **Market signal 0–10 = launch lift 0–6 + chart movement 0–4.** Lift is the largest `fresh_share / share` among the title's tropes, read from the same `whatToMakeNext` board (v1.0) the producer sees: ≥ 1.5× → 6, ≥ 1.2× → 4, ≥ 1.0× → 2, else 0; labelled inferred, with the count of tropes at or above 1.2× and the largest lift shown. Below 10 recent listings the fact says so and scores 0. Chart movement keeps the day-over-day cohort-share delta (observed), now mapped to 0–4 around 2.
- **The movement was always 0 before.** `loadWorkspace` never passed the previous day's snapshot to `tropeStats`, so `delta_pts` was null for every trope; it now passes the previous day scored, and the fact reports the real mean.
- Bands and every other component are unchanged; the composite stays "our evidence summarized, never a probability".
- **Same day, for the demo walk:** My catalog accepts `?trope=<id>` and the "N of your titles carry it" link on What to make next carries it, so the board's story type filters the catalog (a status line names the story type, and each row shows its own story types while the filter is on; the plain board is unchanged otherwise). Company & accounts leads with the goal and shows the profile as chips. **Rights are no longer scored** (v1.2): the license window stays recorded on the title but contributes no points, no band override and no next-step; launch readiness is subtitles 0–10, video 0–8, destination 0–4, ad account 0–3. **Pulsar's 15% service fee is shown** under every proposed budget (`lib/promote/fee.ts`: ad spend + fee = total billed) on the new-campaign form and the brief panel; the approved budget stays the ad spend and is what TikTok receives. The new-campaign form proposes $500 and a tiktok.com destination by default. **Lifts are displayed as signed percentages** (`lib/research/lift.ts`: 2.18× → "+118%") on What to make next, Explore › story types and the assessment facts; the column reads "Share increase · vs its usual share". The ratio stays in the data and the registry.
- **TikTok revenue & audience, same day:** (1) a from/to date form beside the presets (`?range=custom&from&to`, `parseWindow`, clamped to the delivered data, previous period of the same length); (2) the data bar is labelled cells (Period · Data through · Last sync · Source) with source notes as chips; (3) the overview opens with **How this title is doing** (`lib/analytics/health.ts`): revenue and viewers vs the previous period, payer conversion and revenue per viewer vs the catalog median of the producer's other titles with data, and **blended ROAS** = all title revenue in the period ÷ ad spend whose reporting window overlaps it, labelled blended and never attributed; an overall rules-based label (Doing well / Mixed / Needs attention / Not enough data). Nothing here predicts. The demo seed's campaign 4 (Rise of the Son-in-Law) is a finished round with demo results and one open change request, so the title has a result to read before the next round is drafted from Prepare.

Checks: `npm test`, `npm run typecheck`, `npm run build`.

## 2026-09-09 · TikTok launch inside Studio: connect, launch, read back

Decided by the founders (Ruobin): "all I really want you to port over is the ability to connect to TikTok, launch ads, and feed the metrics back … keep the entire Studio workflow as is … the only thing we need from the admin side is the ability to make sure everything is going well." The Pulsar Grow bridge (2026-09-04 "Grow owns launch") is retired: Studio launches ads itself. What was ported from the sibling `pulsar` repository is its TikTok transport, OAuth connect, identity preflight, the idempotent launch engine, the review verdict logic and the ad-level metrics sync; what was left behind is its merchant model, category blocklist, concierge queue, spark/mass launch, warm-ups and the operator approval gate.

- **The producer flow is unchanged and now real.** Brief → generate → choose → approve ads → approve budget → **Launch on TikTok** → results. The launch button replaces the demo handoff; no staff step sits between the producer's approval and TikTok. The destination URL is required (ads send viewers to a link, decision: "we'll have a platform ready for it"); objective TRAFFIC to that link, CTA WATCH_NOW.
- **One launch per approval manifest, resumable.** `promote.launches` (migration 0008) holds one row per manifest hash (unique idempotency key); each step's TikTok id is recorded before the next runs, so a retry or the scheduler's adoption resumes at the first unfinished step and can never create a second campaign (`lib/tiktok/launch.ts`, Pulsar's invariants over `getData()`). The ad group's lifetime budget is exactly the approved experiment budget; nothing sends more than the approver signed. A budget change is a new experiment version, which clears approval as before.
- **Statuses from `launching` on are TikTok's** (`launching` engine running → `submitted` created, in TikTok's review → `live` | `paused` | `ended` | `failed` with TikTok's reason in `status_note`). A five-minute in-process scheduler (`lib/tiktok/scheduler.ts`, started by the first request of the process; `SCHEDULER_DISABLED=1` off) adopts stale launches, polls review (`/ad/get/` + `/ad/review_info/`, neither sufficient alone) and reads ad-level daily metrics back hourly into `promote.results` with `source: "tiktok"`, upserted on (creative, window, source). Staff `Sync now` runs a tick on demand.
- **Hook hold is the 2-second watch rate.** TikTok reports `video_watched_2s` and `video_watched_6s`, never 3 s; `hook_hold_rate = video_watched_2s / video_play_actions` (`docs/analytics/metric-dictionary.md`). Landing actions stay null: no source observes them for a TRAFFIC campaign. The 30 % benchmark stands.
- **Accounts are Pulsar's Business Centers, assigned manually — a BC per vendor, not an ad account** (Ruobin, later the same day: "the way we have it in overlord and pulsar is the ability to connect multiple BCs … we can assign a BC, not an ad account, to a specific vendor"). The operator connection is Pulsar Grow's: many authorizations accumulate in `.tokens.json` on the server through the admin **Connect TikTok** flow (`/tiktok`, staff admin, the approved production developer app; each Business Center is its own authorization), sandbox tokens from `.env.local`. `/tiktok` lists the Business Centers every authorization reaches (one `/bc/get/` per token, cached) and loads one BC's accounts with their health on demand (`/bc/asset/get/` + `/advertiser/info/`, `lib/tiktok/business-centers.ts`, `lib/tiktok/account-health.ts` deny-by-default). Staff assign a **Business Center** to a producer company (`core.company_accounts` row of kind `business_center`, `assigned_by` set); at launch `pickLaunchAccount` walks that BC and takes the first account TikTok reports as READY that has a linked TikTok handle, and the data layer refuses any pick outside the vendor's assignment. Assigning one ad account (with its identity) remains as an explicit override. Only staff-assigned rows count — a producer-recorded "connected" row never routes Pulsar's token anywhere. Producers see the assignment on Company & accounts and can **request one from Pulsar** (`core.account_requests`) with a mock payment opt-in (brand, holder, last four; never a card number; Studio charges nothing). The exact Business Center process stays manual by decision. Not ported from Pulsar: warm-ups, the account fingerprint scan and the multi-account fan-out; a suspended account is handled by re-assigning.
- **Finished ads.** Generation now renders each concept to the file the producer approves (`lib/promote/render.ts`: ffmpeg cut, 9:16, hook burned in via libass; `render_sha256` frozen by the manifest and checked at upload). Without ffmpeg the concepts open with the source-footage preview and the live launch gate asks for renders; fixture mode's fake launch accepts the source file so the demo walks the pipeline.
- **Demo data stays demo.** Fixture mode always launches into a fake TikTok inside the process (`lib/tiktok/fake.ts`, deterministic 17-digit ids, review settles on the second poll, `TIKTOK_FAKE_REVIEW=reject` for the failure path); its read-back is labelled `demo`. Real objects require `DATA_SOURCE=supabase`, because an in-memory store that forgets a launch on restart is a duplicate launch waiting to happen (`TIKTOK_LIVE=1` reaches the sandbox from fixture mode for engineers; production is refused there).
- **Staff monitor and intervene, never approve.** The Promote desk lists launched campaigns with TikTok's note; a campaign's page shows the launch record and offers Sync now, Pause/Resume on TikTok (read back after the flip: a suspended account answers 0 and ignores the change) and Retry; the old mark-launching/live buttons survive only as an audited override behind a disclosure.
- **Not done, on purpose.** Automatic regeneration on a producer's change request (staff still revise); app-install objectives and native drama destinations; a production launch has not been exercised — Pulsar's briefing notes sandbox cannot prove `/ad/create/` end to end, so the first real proof needs a production token, an assigned account with a linked identity and a small budget.

Checks: `npm test` (182), `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e` (the journey now presses Launch on TikTok and lands in TikTok's review on the fake).

## 2026-09-08 (night) · Native Chinese pass on the producer portal, written with DeepSeek

Decided by the founders (Ruobin): "it might be a good literal translation, but it likely doesn't look like a native Chinese app". DeepSeek (`deepseek-chat`) rewrote every Chinese string the producer portal can render, then a human review settled the result. Scope: the 1,508 keys referenced from `app/(producer)`, `components/producer`, the shared components and `lib/` (`scripts/zh-native/collect.ts`); staff chrome (285 admin-only keys) and 558 unreferenced keys were left alone. Register, chosen for this pass: neutral 你, lighter than a formal B2B tone, the voice of a domestic SaaS console.

- **How.** `scripts/zh-native/run.ts glossary` asked for one canonical term list plus a critique of the current wording (`docs/reviews/zh-native-2026-09-08-glossary.json`); `run.ts translate` then rewrote the keys in 63 batches of 30 with the product brief, the style rules, the terminology map and that glossary in the system prompt, returning per-key notes and a per-batch analysis. `apply.ts` rejects a rewrite that changes the `{placeholders}`, drops a brand or unit, loses a TikTok/广告/美国 qualifier, uses 您 or half-width punctuation next to CJK, or grows past 1.6×; `review.json` records the human decisions (21 rewrites kept as they were, 38 final wordings). Result: 353 strings rewritten, 1,134 kept. The full record, with DeepSeek's analysis of every batch and each accepted change, is `docs/reviews/zh-native-2026-09-08-report.md`.
- **What changed in the vocabulary.** 作品 → 剧集 for a title and 分集 for an episode (作品 no longer appears in producer copy or the metric registry); the evidence labels are 实测 / 推断 / 估算 / 合作方上报; 花费 always reads 广告花费 and 3 秒留存 reads 开场留存; 版权窗口 → 授权窗口; 映射 → 关联; "Explore listings" is 浏览上架剧集, "Story ideas to explore" is 选题参考; 打开 → 查看 on buttons; "第 {n}/{total} 步" reads 第 {n} 步，共 {total} 步. The terminology map (`docs/terminology.md`) carries the new rows and the register rules.
- **What was refused.** Rewrites that changed meaning (n/a → 暂无, 下载英文剧本 → 分集, 占展示 → 的展示, 英文为空 → 英文行为空, comparative rewrite tags losing 更), that blurred product distinctions (平台条目关联 → 平台链接, 采集日 → 昨日), that were inconsistent with each other (人群 / 入组 / 同期群, 审批角色 / 批准角色), and the four admin keys outside scope.
- **Invariants.** No English string changed; placeholders, brand names and the evidence-label rules were checked mechanically; `docs/demo` and the e2e (English) are unaffected. The DeepSeek calls were developer tooling against `DEEPSEEK_API_KEY` in `.env.local`, not app jobs.

Checks: `npm test` (173), `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e`, and a walk through every producer page in Chinese at 1440.

## 2026-09-08 (night, later) · DeepSeek as a third LLM provider

Decided by the founders (Ruobin): "put a DeepSeek API key". `LLM_PROVIDER=deepseek` with `DEEPSEEK_API_KEY` selects it (`lib/llm.ts`); defaults are `deepseek-chat` for the fast tier and `deepseek-reasoner` for the strong tier, overridable with `LLM_MODEL_FAST` / `LLM_MODEL_STRONG`. DeepSeek is reached through the OpenAI SDK at `https://api.deepseek.com` (`DEEPSEEK_BASE_URL` to change) using chat completions in JSON mode: the caller's zod schema is stated in the system prompt as JSON Schema, the answer is validated by the same zod schema and semantic check on our side, and a failure gets the same single repair turn as the other providers. Every invariant holds: one `studio.jobs` row per call with integer `cost_cents` (DeepSeek's cache-hit tokens are counted as cache reads; list prices in `PRICES`, unknown models still charge at the top tier), `isLlmAvailable()` reads only the chosen provider's key, and fixture replay stays provider-free. The key goes in `.env.local`, never in the repo.

## 2026-09-08 (night) · Final UI/UX pass: nothing hangs, one shape per row, one range control

Decided by the founders (Ruobin) after the redesign: "small things have fallen through the cracks" — the Ad campaigns table and its buttons, the date-range chips, and words or arrows hanging alone on a new line. Presentation only; no number, rule or route changed.

- `app/polish.css` loads last. Producer-portal text uses `text-wrap-style: pretty` (paragraphs, cells, captions) and `balance` (headings) so a last line is never one word; the longhand is deliberate, the `text-wrap` shorthand would undo every intentional `white-space: nowrap`. Every "label →" link carries a non-breaking space before the arrow; the freshness lag "(1 d lag)" and the comparison note "(% change)" carry non-breaking spaces in the locale strings.
- Repeating rows share one shape: the action column is a fixed width in Ad campaigns (170px), TikTok performance (112px), My catalog and the title's campaigns table, and its button never wraps; the "Step n of 6" badge always sits above its step name; column names share the top line of the header with units and bases beneath; the Spend and Ad results sub-labels (`USD · this round to date`, `Hook hold ≥ 30% · CTR ≥ 1.2%`) break only at their separator. TikTok performance headers are single-line and the state chip stays on one line.
- The date range is one segmented control (`RangeControl`, `.seg.an-range`) everywhere, sitting at the right of the analytics view tabs under a shared hairline and beside the TikTok performance filters; the "Range" label is now the control's accessible name only.
- What to make next: the story-type board's lift and growth columns are wide enough for "vs all listings" and "median of {n} listings"; "See all →" is its own line under the platform split, which breaks only between platforms.
- Sidebar: the US market item reads **Data sources** (`ws.nav.sources`); the page and the What-to-make-next button keep "Data sources & definitions". The section tab rows (`.tw-nav`, `.pf-views`) no longer summon a vertical scrollbar from the active tab's 1px overhang.

Checks: `npm test` (173), `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e` (both viewports), walked in both locales at 1440 and 1920.

## 2026-09-08 (evening) · Status-board catalog; TikTok performance is its own area; Overview retired

Decided by the founders (Ruobin) after walking the pulled build: the Overview was "kind of useless" (its task queue duplicated Ad campaigns and its market board duplicated What to make next) and the catalog was unintuitive — three views competing on one screen, buttons whose destination changed per row, and a "TikTok comparison" label that meant nothing on its own. The fix separates ad performance from TikTok performance completely and makes the catalog a plain status page.

- **My catalog is the landing page and a status board.** One row per title: title, TikTok status, ad status, US potential (score dial and band). Each cell links into the section that owns it — TikTok → the title's TikTok section (or the listing-link flow when not linked), Ads → the title's campaigns (or a new campaign when none), US potential → Preparation — plus Open. Search, sort (launch priority or name) and the recommendation-band chips are the only controls. No numbers on this page.
- **TikTok performance (`/producer/tiktok`)** is a sidebar area of its own: the former catalog "TikTok comparison" table unchanged (revenue, viewers, payer conversion, D30 cohort value, state), with range, search and sort. The per-title TikTok section breadcrumbs back here. `/producer/titles?view=performance|tiktok` redirects here with its query.
- **Ad campaigns** keeps every ad number: the task queue, all rounds, results and the next-round decision. The queue rows read "Step n of 6" and the budget stays visible at every width; the demo-handoff note appears only at the launch step.
- **Overview is retired.** `/producer` redirects to the catalog (`?view=opportunities` to What to make next). The company goal and monthly budget remain on Company & accounts.
- **Two sidebar groups** (later the same day): *My titles* — My catalog · Ad campaigns · TikTok performance; *US market* — US overview · What to make next · Explore listings · Data sources; then Company & accounts. The market pages drop their in-page area tabs (the sidebar is the area navigation); Explore keeps its own sub-tabs. Ad campaigns is a table in the TikTok performance framing (one row per round: step, budget, spend, results, action). What to make next is trimmed to read top-down: story types in five columns (pair and "of yours" fold into the story-type cell), three make-now briefs, a four-tile summary (new listings, leading story type, fastest riser, own exposure), six newest listings per platform beside each other with the five fastest movers folded into the same panel.
- Preparation is unchanged as a title section; the catalog's "preparation checklist" view folds into the band filter. `homeFor("producer")` is `/producer/titles`.

## 2026-09-09 (later) · One title workspace; the catalog is the portfolio home

Decided by the founders (Ruobin): "reframe the items; the information is good, it is missing presentation." A title had four unrelated homes (episode console, assessment, analytics, campaign) and the catalog mixed preparation with operating results. The reorganization moves presentation only; every calculation, permission and provenance rule stays where it was.

- **My catalog is the portfolio.** One row per title: TikTok status, ad status, TikTok earnings (publisher earnings, USD, one visible range; a gross-sales basis is tagged, never substituted), ad spend to date, ad CTR to date against the benchmark, open. Quick filters *All · On TikTok · Ads active · Preparing* are defined in the UI and may overlap. The US potential score is no longer a headline; the readiness comparison survives as the **Preparation checklist** view and the analytics comparison as the **TikTok comparison** view (old `?view=` values resolve).
- **Two statuses, two sources** (`lib/research/title-status.ts`). Platform status comes from the linked listing's analytics state: data delivered = on TikTok; a link alone = awaiting data; no link = unknown, never "unpublished". Ad status comes from the latest campaign record and its results: submitted is a demo handoff, only a `live` record is running. Neither proves the other.
- **One title workspace** (`components/producer/TitleShell.tsx`, `lib/research/title-workspace.ts`): Overview · TikTok revenue & audience · Ad campaigns · Preparation · Materials, with the shared identity, both statuses, section nav and the route back to the catalog. `/producer/titles/[id]` is the overview; the episode console moved to `/materials`; `/potential` redirects to `/preparation`; analytics routes are unchanged and framed by the shell; campaign detail stays at `/producer/promote/[id]` with a title breadcrumb and a return route.
- **Vocabulary** (`docs/terminology.md`, applied through `locales/_keys/zz-terminology.json`, which merges last): revenue and viewers always carry "TikTok", spend/CTR/results always carry "ad"; "Review ad results" outside the campaign strip; "View assessment" instead of "Score & story evidence"; "Data sources & definitions". The composite keeps its name, US potential assessment, inside Preparation.
- **Less text.** Results cells show the benchmark once in the header and ✓/✗ in the cell; the demo note appears once; findings are one line per ad; next-round options are one line each.

Checks: `npm test`, typecheck, lint, build, `npm run test:e2e` (updated for the workspace: catalog → overview → preparation → campaigns → campaign → back, quick filters, old deep links).

## 2026-09-09 · MVP pass: one demo journey, results that explain the next decision, what to make next as a decision table

Decided by the founders (Ruobin): "get this to an MVP state" overnight. Four things changed; none of them touches approvals, spend controls or the evidence rules.

- **One demo journey, reset on demand.** The fixture seed is one coherent path: the market board's launch signal (CEO / rebirth / revenge) → title 1, which carries it and scores highest → campaign 1 on title 1 with chosen ads, an immutable manifest, an approved budget, a demo handoff and two demo-labelled results → the next round. One campaign per title, distinct names, every video episode hard linked to `docs/demo/xiangyuan-ep1.mp4` under `.uploads/` by the fixture store so previews play. `POST /api/demo/reset` (fixture only; 404 in Supabase), the top-bar "Demo dataset · Reset demo" chip and `npm run demo:reset` rebuild the store. `docs/demo/DEMO.md` is the script.
- **An end-to-end smoke test.** Playwright (`npm run test:e2e`, `tests/e2e/demo-journey.spec.ts`) exercises the journey on 1440×900 and 1920×1080 against the running dev server: overview → what to make next → filtered Explore with reload persistence → catalog search/band/zero-result recovery → title potential → campaign 2 through choose, change request, approve, budget, launch, demo results, reload and the next round → API error feedback and form validation → a check that no request leaves localhost. Screenshots under `docs/demo/e2e/`. `npm test` stays the unit suite; the e2e is a separate command because it needs the server.
- **Results explain the next decision.** `lib/research/results.ts` (`readResults`) is the one benchmark reading: per ad, hook hold and CTR beside the benchmark they are judged against with a met/missed mark, CPM / CPC / cost per action under their counters, rates unknown (never 0 %) when the denominator is 0, and provenance (source, window, read time, demo note) ahead of the table. "What the results say" lists which benchmark each ad met or missed with its numbers, then offers the next round as three explained options; every option creates round N as a new campaign (`nextRoundName`, counted per title) that must be approved and submitted again. No demo action reaches a model or a provider (e2e asserts it; `lib/jobs.ts` still refuses in replay mode).
- **What to make next is a decision table.** The Overview's market view reads left to right: story type and its share of new listings → views added to that story type's listings since the last collection, per platform and never pooled (`RisingTrope.views_added`, registry metric `trope_views_added`, observed; listings without a comparable counter are a stated gap, not a zero) → the owned titles that carry it → "View listings", which opens Explore already filtered. Top new listings expand in place with their own counters and growth. Explore now sits under the US market insights area tabs so the flow never drops the producer into an unrelated page.
- **Title Analytics (demo provenance, typed contract).** One canonical destination per title, `/producer/titles/[id]/analytics` with four views (Overview, Revenue & LTV, Episodes, Acquisition) plus the fixture-only listing link, reachable from My catalog (`?view=performance`, one basis / one window / one currency per ranking column), the title page and campaign results. Values and provenance are separate fields (`lib/analytics/types.ts`): every metric carries availability, source, evidence and a definition key; unobserved values are unavailable, never zero; percentage change and percentage-point change are distinct types. Ten demo scenarios are keyed to the demo titles (`data/fixture/demo-analytics.ts`, deterministic, clock fixed at 2026-09-08). Distinctions kept on every page: gross → refunds → fees → publisher earnings → settled → paid out; recharge ≠ redemption; platform-reported LTV ≠ observed D7/D30 cohort revenue per user (explicit formula, entry window, elapsed days, immature cohorts null); the funnel is event counts unless a cohort is linked; attributed revenue is a subset of title revenue and unattributed traffic is never called organic; ROAS is not profit. Acquisition reuses `promote.results` and the same benchmarks as the campaign page. Supabase mode stores links (migration 0007) and returns `requires_connection` for every metric: production never falls back to demo numbers. TikTok's public documentation defines metrics at app level only; per-listing, per-episode, refund, fee, settlement and attribution granularity is **proposed and unverified** (`docs/analytics/tiktok-source-mapping.md`, `docs/analytics/metric-dictionary.md`).

Checks: `npm test` (168), `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e` (both specs, both viewports) and axe-core on the redesigned and new pages (0 violations).

## 2026-09-08 (evening) · The market collection runs daily

Decided by the founders (Ruobin): "schedule a daily crawl". The
terms-of-service posture that was left open on 2026-09-06 is now settled
in favour of one collection a day of the same public catalog pages a
browser loads, at a fixed hour, from one runner.

- `.github/workflows/research-crawl.yml` runs `npm run research:crawl` at
  04:30 UTC daily (12:30 Beijing) and on manual dispatch, then commits
  `data/research/runs/<id>/`, the snapshot and `published.json` to `main`.
  Same command, same immutability and atomic-publication rules as a local
  run; a failed platform is carried forward as stale by the builder.
- The repo is the data store for now: each day adds roughly 0.5–1 MB of
  run artifacts plus a snapshot. Move the artifacts to object storage when
  that becomes a burden, keeping the snapshot and pointer in the repo.
- Watch the first runs: if the platforms refuse GitHub's datacenter
  addresses, the fallback is the same command on a Windows scheduled task
  on a founder's machine, committing the same paths.
- A local `npm run research:crawl` still works and publishes a second run
  for the day; the loader follows the newest validated run per day.

## 2026-09-08 (later) · What to make next: launches, not just prominence

Decided by the founders (Ruobin): the workspace judged the catalog a studio
already has, but did not say what to shoot next. Mini-drama studios clone a
premise within days of seeing it work, so US market insights now has two
views: **US overview** (what is prominent) and **What to make next** (what
the platforms are launching now). A small version sits on the Overview.

- **Fresh is observed, with every reason kept:** the platform's own new
  flag, its New/Newest list (with rank), a release date within 30 days
  (DramaBox exposes one; ReelShort does not), and first seen by Studio on
  the latest published day (needs history). `lib/research/next.ts`
  (`whatToMakeNext`, v1.0). Nothing is called new because we guessed.
- **Growth needs two published days** and stays within a platform: listings
  are grouped per platform and ranked by views added per day (same counter,
  actual elapsed days; a decrease is an anomaly and never a mover). A
  listing first seen today has no baseline and shows "no baseline", never 0.
  Until the second day the board says "collecting history".
- **Story types being launched now:** share of the fresh cohort carrying
  each trope (multi-label, denominator shown, split by platform), lift
  against the trope's share of every listing (≥ 10 fresh listings), median
  growth of the fresh listings carrying it, the trope most often launched
  with it, the producer's own titles with it, and two new examples.
  Registry metrics `fresh_share` (inferred) and `fresh_growth` (observed).
- **Make-now briefs** are templated from the top three story types: keep the
  structure (trope + partner), swap the setting, the platform's median
  episode count and paywall, one premise example (a synopsis opening, not a
  tested hook) and the count of the studio's own titles. Labelled inferred.
  They are a starting point for a clone brief, never a demand claim.
- Verified against two real collections (2026-09-07 and 2026-09-08). The
  ReelShort New shelf returned 27 rows on the second day where it had
  returned 200; the collector stops when a page adds nothing, so the
  snapshot carries what the platform served. Tests: `tests/research-next.test.ts`.

## 2026-09-08 · The US launch workspace: a number, a demo catalog, five areas

Decided by the founders (Ruobin): "show a number", "generate a test / demo
for everything so we can stress-test it", "make everything usable". The
product is a US launch workspace for Chinese mini-drama catalogs, with the
market desk as supporting evidence. Central journey: choose a title →
understand its US potential → generate campaign concepts → approve
variations and budget → launch (mock until a provider is connected) → learn
what deserves more investment.

- **Navigation is five areas** plus "Add title" as an action: 总览 Overview
  (recommended titles, decisions waiting, results, setup gaps), 我的剧库 My
  catalog (every title scored, readiness, tests, next action), 美国市场洞察
  US market insights (the market brief, explorer, title detail, sources),
  发行与实验 Launch & experiments, 公司与账户 Company & accounts (goals &
  profile, owned accounts, permissions & billing, reports).
- **US potential is a number** (`lib/research/assessment.ts`, v1.0): 0–100,
  a composite of what Studio actually holds — story match 0–35, market
  signal 0–10 (needs history; 0 and says so until then), readiness 0–25,
  own evidence 0–25 (demo results count at half), fit 0–5 — with every
  fact, its evidence label, its points and "what would raise it" shown next
  to the number, plus a band (test first / prepare / not now / not enough).
  It is our evidence summarized, never a probability of success or an
  audience measurement, and the page says so.
- **Experiments are structured records.** `promote.campaigns.experiment`
  holds budget, hypothesis, audience, first batch, signal, and the
  approver's budget sign-off, versioned; a save clears approval. Results
  (`promote.results`) are per creative and window with an explicit source;
  in fixture mode "simulate demo results" produces demo-labelled rows so
  the results → next-spend loop can be exercised. The next-spend decision
  creates a new round. Submission stays a mock handoff.
- **Customer ownership is recorded, not fabricated.**
  `core.company_accounts` holds the accounts the customer owns and the
  state they reported (unconnected / invited / connected / revoked) and
  what access Studio has. No account creation, no credentials. Billing is
  "not configured" until a provider is connected.
- **The demo catalog** (`data/fixture/demo-catalog.ts`) seeds fixture mode
  by default: 14 titles in different states of readiness, profile,
  watchlist, imported reports, four experiments at different stages (one
  with demo results), and the account inventory. `FIXTURE_SEED=empty`
  restores the bare seed; the test runner uses it.
- Migration 0006 carries the Supabase side; no project is provisioned.
  Tests: `tests/workspace.test.ts`.

## 2026-09-08 · A focused producer market brief

This supersedes the four-summary-card homepage and the expanded dashboard layout. The existing research collection, evidence rules, and tenant boundaries stay in place.

- Overview has three sections: up to six concrete drama examples; six story-share bars; and up to three owned titles with a comparable, recorded materials and an action. Company relevance is visible and optional. The story bars describe the selected market, with company interests highlighted, rather than measuring only the company's preferred tropes.
- My titles has one catalog, with Company profile and Reports as permanent sibling tabs. Company identity is loaded through a minimal tenant-scoped data method. Profiles reuse the existing research record; saving returns to Overview with refreshed recommendations and confirmation. Distribution informs next actions; annual volume remains descriptive. Target markets express intent, not viewer geography.
- Filters apply immediately, search covers existing Chinese/English taxonomy and publisher names, and scope travels into detail return links. Raw views/saves sorts require a single platform. Mobile navigation uses a modal menu with focus containment and Escape support.
- Ordinary views prioritize readable titles, named charts and platform-specific counters. An information dialog gives exact values and read dates without leaving the results; full methodology remains in Sources. Available data and planned connections are separated. Missing covers have a local visual fallback.
- Market detail uses Summary, Trends and Sources; legacy Story/Creative/Comparables tab URLs resolve to the summary. Saved titles have a dedicated navigation link.
- No US rights or whole-title readiness is inferred from generic dates or partial approvals. Existing company reports and recorded license/episode facts remain in catalog disclosures. Promote remains review/approval; Grow owns execution.

## 2026-09-07 · Trust in the numbers: run artifacts, provenance, registry, Data & Sources

Decided by the founders (Ruobin) via the market-intelligence review
(`docs/market-intelligence-review.md`) and its prompt. The desk is rebuilt
as a market-intelligence and launch-decision tool; the ledger is
`docs/market-desk-plan.md`. What changed in the contracts:

- **Snapshot schema v2.** Every counter is an `Observation` with the
  platform's field name, unit (views / collects / follows / rating), read
  time and evidence. Collection context (English public web, locale en) is
  recorded separately from audience geography, which is `unknown` for these
  sources: an English page does not establish a US audience. Runtime basis
  (`episode_1` vs `listed_average`) travels with the value.
- **Immutable runs, atomic publication.** Collectors write
  `data/research/runs/<run_id>/` and refuse to overwrite; the builder
  validates with zod and only then moves `data/research/published.json`.
  The latest validated run of a day represents that day; earlier same-day
  runs stay on disk. A failed platform is carried forward as `stale` from
  the last published run, never dropped; a run with no fresh platform
  publishes nothing and is recorded as `last_failure`.
- **Scores are within-platform and null when unobserved.** `view_percentile`
  and `chart_visibility` stay separate; their max is called *prominence*
  and is documented as not momentum. Ties go to the charted listing. Whole
  snapshots are scored before filtering, current and previous alike, so an
  unchanged snapshot shows zero movement under every filter.
- **Movement only with comparable history** (`lib/research/history.ts`):
  counter velocity over the actual interval, growth % only on a positive
  baseline, decreases as anomalies, rank movement within the same named
  list, entry/exit categorical. First-seen dates come from history.
- **Words.** Publisher ≠ studio (`companies[].role`); 女频/男频 is audience
  positioning, not protagonist gender or demographics; synopsis openings
  are *premise examples*, not hooks.
- **Registry.** `lib/research/registry.ts` lists every source and metric
  with grain, source field, unit, denominator, window, evidence, formula,
  version, limitations and a status computed from the published data
  (`available | collecting_history | requires_connection | manual |
  unavailable | stale | failed`). Rendered at `/producer/sources`; every
  metric label links to its entry. The review's source corrections (Meta
  Ad Library scope, YouTube public vs owned, Trends normalization, TikTok
  Top Ads sample, no assumed app-store RSS) are recorded there.
- **Navigation.** 市场概览 / 市场探索 (作品 · 题材 · 平台 · 公司) / 我的剧库 /
  素材与测试 / 数据与来源, with 新增作品 as an action. Title detail has
  Overview · Trends · Story & format · Creative examples · Comparables ·
  Sources.
- **Company-scoped records (migration 0005).** Watchlists; report imports
  with preview, validation, duplicate detection and reversible batches;
  an explained launch-test shortlist (`lib/research/shortlist.ts`, v1.0)
  whose reasons and missing inputs are visible. Nothing here is a
  probability of success.
- **Not enabled:** scheduled collection (terms-of-service posture is the
  founders' call), every external connector (listed with real states).

Current coverage at this decision (recounted from the published run
`2026-09-07T04-38-53Z`, 507 listings, 506 tagged):

| platform | status | listings | with views | fetched |
|---|---|---|---|---|
| reelshort | ok | 442 | 442 | 2026-09-07T04:39:46.308Z |
| dramabox | ok | 65 | 53 | 2026-09-07T04:38:53.436Z |

## 2026-09-06 · Studio becomes the market desk

Decided by the founders (Ruobin) after the first conversation with a Chinese
mini-drama studio: Studio angles away from being a creation/production space
and toward helping studios decide **what to produce, where to release, and
how they are doing.** Two products under one roof, in this order of
importance, and the platform (the money pit) feeds the second one later.

- **Market research is the front door.** `/producer` is now the market
  overview: public charts from ReelShort and DramaBox (first two platforms;
  Meta Ad Library, TikTok Creative Center and YouTube are next), run through
  one **trope taxonomy** (`lib/research/taxonomy.ts`, ~28 premise mechanics
  such as 霸总, 复仇, 隐藏身份, 契约婚姻, 战神, 狼人) so titles, tropes,
  studios and the producer's own catalog are comparable. Filters by
  platform, audience (女频/男频) and trope. Nothing raw is shown: a crawl is
  normalized into a dated snapshot (`data/research/snapshots/YYYY-MM-DD.json`,
  `npm run research:crawl`) and the engine (`lib/research/engine.ts`) computes
  what the page shows. Snapshots append; a second crawl turns on change
  columns.
- **Every number carries an evidence label**: `observed` (read from the
  platform's page), `inferred` (our rules, e.g. a keyword trope or a studio
  guessed from a shelf), `estimated` (a model or third-party estimate),
  `partner_reported` (the producer told us). The UI shows the label beside
  the number. Competitor CTR, payer conversion and spend are NOT shown
  because no public source exposes them; rank, chart share, saves and view
  velocity are what is observable. Raw views are never compared across
  platforms (ReelShort read_count and DramaBox viewCount count different
  things); titles get a within-platform heat score (0-100).
- **Personalization comes from a short onboarding**, not from Adapt: a
  producer editor answers which tropes they produce, their audience, volume,
  distribution mode and markets (`core.producers.research_profile`,
  migration 0004). The market page then shows "you produce it and the charts
  want it / the charts want it and you do not list it / you produce it and it
  is thin on the charts". Viewer-role producers read the desk but cannot
  describe the company; staff previewing cannot act, as everywhere.
- **My titles is the second tab**: the catalog, each title tagged with the
  same taxonomy from its synopsis, scored against chart share, with
  comparable market titles. Performance-vs-market is an honest empty state
  until a platform report is connected or a CSV imported; the founder's
  China numbers on a title (`china_metrics`) show as partner-reported.
- **Hooks and promotion are the third**: Promote's home now opens with the
  opening sentence of the hottest blurbs for the producer's tropes ("hooks
  that are working"), then the existing campaign flow. Promote proposes the
  test; Grow runs it and reports back. No measurement is rebuilt in Studio.
- **Adapt is frozen, not retired.** It is the fulfillment step once a title
  is chosen ("you already have an English-ready version") and the catalog
  intake for producers who upload scripts. It moves off the home page under
  My titles; no new pipeline work.
- Feasibility of the first two crawls, the fields each platform exposes,
  and the caveats (client-side pagination, DramaBox's two view counts,
  terms-of-service posture) are in `docs/research-feasibility.md`.
- Data-layer contract: `getMarket` (any member; Studio-wide, no per-producer
  rows), `getResearchProfile` / `saveResearchProfile` (own company only).
  Both modes read the same committed snapshot; `research.title_observations`
  is the crawl's landing table for history and is not read yet.
## 2026-09-04 · Finalize readiness: an editor-authored line is its own explanation

Found testing the manual-draft path: the finalize gate required `rationale_zh`
and `back_translation_zh` on every non-keep line, but the producer editor
sends text only — an episode whose lines were hand-written could show a green
“可以定稿了” banner while `finalize_version` refused, in English. Decided:

- **The finalize rule** (`lib/data/views.ts` `adaptedLineIssue`; fixture
  `finalizeVersion`; SQL `studio.finalize_version`): every source line
  adapted, non-cut lines non-empty, and AI-authored changes carry
  `rationale_zh` (plus `back_translation_zh` unless cut). Rows with
  `authored_by = 'editor'` are exempt — finalize is the producer approving
  words a person wrote; nobody owes an explanation to themselves.
- **The staff path stays strict.** `submit_version` and `set_scene_status`
  still require the rationale on every changed line regardless of author:
  staff changes are explained TO the producer.
- **One rule, three readers.** The same predicate feeds the episode
  summaries and the studio's banner/finalize button, so the UI can never say
  ready while the server would refuse; when AI takes are missing their notes
  the banner counts them in portal words.
- **Portal words for unavailable states.** Producer-facing refusals map by
  error code (`llm_unavailable`) instead of printing server English; the
  burn failure and the auto-sync unavailable state are localized (the
  technical reason stays on hover); a blank manual-draft row reads
  “（英文待填写）”, no longer “（该句已删去）”.

## 2026-09-04 · Pulsar's Promote desk: the staff side of every producer action

Decided by the founders (Ruobin): "after a producer does anything — request
change, send for approval — the admin portal doesn't do anything, and that is
the important part we want from Grow." Also: five concepts per round, an
approve-all, and the producer information architecture.

- **Every producer action has a staff next step.** The admin portal gains a
  Promote desk (`/promote`): campaigns queued as *Needs Pulsar* (change
  requests to answer, launches to run), *Waiting on producer*, *Launched*.
- **A change request is answered with a revision, never an edit.** Staff
  `revisePromoCreative` writes a new `pc_` row (`parent_creative_id`,
  `version + 1`, status `ready`, a `revision_note` the producer sees) and marks
  the parent `superseded`. Only while the campaign is in `review`; approved
  rounds stay frozen (0003's guard). Producers cannot call it.
- **Launch is recorded by staff on the desk.** `advancePromoCampaign` moves
  `submitted → launching → live`, `submitted|launching → failed`,
  `failed → launching`, with the Grow campaign id and an audit note. Until
  Grow's read-back lands, this is the source of launch status inside Studio.
- **Five concepts per round, not six.** Copy says so explicitly: Pulsar keeps
  launching new rounds; it tests five concepts at a time.
- **Keep all.** Producers can approve every still-pending creative in one
  click; existing change requests are never swept up by it.
- **Producer IA.** Sidebar: a primary *New drama* action; *Studio* (Adapt, where
  localization happens); *Promote*; *Drama library* (placeholder for the title
  list that will connect to Stage — wording only, no Stage integration). The
  site title is *Pulsar Mini Dramas*. Promote's brief starts by picking a drama
  from cards; the chosen drama is locked into the brief.
- **Admin localization is oversight only.** Staff watch where a producer is;
  they do not upload scripts or adapt from the admin side. Removing the admin
  upload/adapt affordances is pending, not done.

## 2026-09-04 · Promote is a sibling product; Grow owns launch

Decided by the founders (Ruobin): Pulsar Studio now has two producer-facing
products over one drama library. **Adapt** localizes a title. **Promote** turns
the uploaded episode masters into paid-social creatives, asks the producer to
approve the exact outputs, and hands those outputs to Pulsar Grow. Grow remains
the system of record from launch onward, including TikTok review and metrics.

- `core.titles`, `core.episodes`, and their private source media are shared.
  Promote never requires an adaptation, approved subtitle version, or creative
  pack. A better script may improve future selection, but cannot be a gate.
- Promote owns campaign intent, concepts, immutable creative revisions,
  producer approval manifests, and append-only handoff attempts in a separate
  `promote` schema. It uses external `pb_` and `pc_` ids across the boundary.
- Only approved, rendered outputs cross to Grow. A producer-facing button says
  “Submit to Pulsar for launch”; “handoff to Grow” stays implementation detail.
- A producer approves exact versions. Approval hashes a frozen manifest. Any
  later media or copy change creates a new creative version and new approval;
  it never mutates the approved row.
- The producer navigation exposes Promote as a first-class product and keeps
  the title page as a shortcut, not another adaptation pipeline step.
- The initial vertical slice includes the campaign brief, six hypothesis-led
  direct/creator-style concepts, review, frozen approval, and an idempotent mock
  submission. Actual MP4 rendering, production UGC composition, Grow service
  authentication, launch status, and metrics readback replace the seams next.

## 2026-09-04 · Demo readiness: five fixes before a producer sees it alone

Decided by the founders (Ruobin): "fix these things for the demo", from the
repo review's must-fix list.

- **Overlaps are fixable from the sheet.** QC still treats an overlap as an
  error, but the QC row now offers 修正时间 and 「AI 修复全部」 handles overlaps
  first: the previous cue's end is trimmed to a two-frame gap (never below a
  300 ms cue; if that is not enough the current cue's start moves too), in
  one batched `POST …/timing/cues`. No producer is blocked on a real SRT any
  more; the full timing desk still lives after finalize.
- **Pulsar's spend never reaches a producer.** First-pass, rewrite and
  alternatives return the job row (usage, cost, prompt input) to staff
  sessions only.
- **Demo replay cannot spend money.** `demoReplayActive()` moved to
  `lib/data-source.ts` and `runJob` — the single choke point for every model
  call — refuses while it is on, with a producer-readable message. Rewrite,
  pack and clips were previously unguarded; `tests/demo-guard.test.ts` pins it.
- **One word for finalize: 定稿 / Finalize.** The button, the confirm step,
  the title-page progress card, the version pill and the done banner all say
  it. The title-page step strip says 审阅修改, not 逐场确认; the sheet header
  says 双语剧本 and "click a timestamp to jump and edit", not "review or
  comment". Engineering copy (API keys, DEMO_REPLAY, "demo mode" as an
  excuse) is gone from producer strings. The producer home uses producer
  words for status (待确认, not 制片方审核中).
- **The header cannot contradict the QC card.** With every line adapted but
  errors remaining, the command strip reads 「还有 N 处必须修复」 in a warning
  tone; 「可以定稿了」 appears only when preflight is clean.

## 2026-09-04 · Training the translator: a knowledge layer in authority order

Decided by the founders (Ruobin): "improve translation right now, and improve
it over time as we translate more scripts, using online sources." The Tatoeba
seed (below) was the first attempt; a probe against the founder's own 24 lines
showed bigram-Dice retrieval returning unrelated textbook sentences ("We're
going to paint the wall" for 咱们准备开始汇报) in the wrong register, so the
approach was reshaped rather than removed.

- **One knowledge layer, `lib/memory`, gathered per scene (or per line) and
  rendered as prompt blocks in this authority order:**
  1. *Approved memory* — producer-approved lines from immutable snapshots
     (house truth). Lines the producer wrote or corrected by hand rank higher
     and are labelled `producer-edited`; they are the strongest signal of the
     voice the producer wants. This is the corpus that compounds.
  2. *House exemplars* — the Pulsar-authored demo bank (`data/fixture/canned*.ts`)
     is now also the house-style corpus: literal → studio line → key phrase →
     why, so the model sees the MOVE, not just a target sentence.
  3. *Register guide* — `lib/memory/idioms.ts`, an authored table of set
     phrases, forms of address and genre beats (久仰, 辛苦了, X总, 丫头, 撤单,
     白月光 …) with how American series say them and when. Exact containment,
     so it never misfires.
  4. *Glosses* — CC-CEDICT (CC BY-SA 4.0) filtered to idioms, marked usages
     and 4+ character set phrases (`npm run memory:import:cedict`). Meaning
     only; the prompt says so.
  5. *Reference pairs* — Tatoeba, now near-exact matches only (≥ 0.55) and at
     most three; lowest authority.
- **Retrieval is IDF-weighted bigram cosine** (`lib/memory/rank.ts`) for every
  corpus: shared function characters no longer make a match.
- **Knowledge blocks sit AFTER the cached system blocks** (bible, rules), so
  the two cache breakpoints have stable prefixes again. The Tatoeba and CEDICT
  files load lazily; routes that never write a line do not carry them.
- **Idempotency keys are stable** (`first_pass:version:scene:PROMPT_VERSION`);
  what was retrieved is recorded on the job as counts plus a fingerprint. A
  memory that grew since the last click must not silently regenerate a scene
  the producer already edited. `PROMPT_VERSION` is `v4`.
- **Alternatives and rewrites get the per-line knowledge too** (approved,
  house, register guide, glosses; no Tatoeba).
- **Approved-memory scope:** Studio-wide, as the seed-memory entry already
  decided; CLAUDE.md is aligned. A producer's rows never appear in another
  producer's route response — they only inform the prompt.
- Tests: `tests/memory.test.ts`, `tests/reference-memory.test.ts` (pins the
  probe lines to zero Tatoeba hits), `tests/translation-memory.test.ts`.

## 2026-09-04 · Tags become the dial: two takes, then "take it another direction"

Decided by the founders (Ruobin), in session, after a review noted the tone
tags (更精炼 / 更口语 / 更情感化 …) were the product's clearest evidence of
*how* it helps and yet rendered as passive grey chips nobody looked at.

- **Alternatives are TWO, not three**, and each leans into a different
  direction: the first tag on a take names it and is rendered filled at the
  top of the card, so the two read as "a more emotional one, a more direct
  one" rather than an anonymous list. The prompt (`lib/prompts/alternatives.ts`)
  enforces the count and the spread; the bank serves its first two.
- **The dial appears after alternatives, not before.** The default panel stays
  quiet (applied tags, edit box, one button). Once the producer opens
  备选说法 and neither take fits, a row 「都不合适？换个方向再写一版」 lists
  the tags nobody has tried on this line — not on the current take, not on any
  alternative — and tapping one requests **one more take that commits to that
  tag** (`POST …/alternatives` with `{ direction }`; new idempotency batch,
  suffixed with the tag; the `check` refuses a take missing it).
- **A tapped direction lands in the edit box like picking an alternative
  does** — it is written as an alternative row, auto-picked, and nothing
  commits until 保存本句. The confirm contract is unchanged.
- **Demo mode:** a direction pulls the first unused bank entry carrying that
  tag, else the first unused entry at all, else answers `available: false`
  and the UI says so. `tests/alternatives.test.ts` pins the prompt shapes
  and the replay behaviour.

## 2026-09-04 · Licensed seed memory

Translation retrieval no longer starts empty while the Studio approval corpus
is young.

- **Tatoeba seeds the corpus.** A refreshable, attributed Mandarin-English
  subset comes from Tatoeba's official API. Both sides must be approved,
  non-orphaned, directly linked, and owned by self-identified native speakers;
  only Simplified Chinese and subtitle-sized pairs are kept.
- **Authority is explicit.** Studio-approved memory remains house truth and
  ranks separately. Tatoeba examples are lower-trust vocabulary and idiom
  hints only; the prompt warns that community data can be wrong and forbids
  importing its names, story facts, relationships, or character voice.
- **License provenance stays attached.** Every pair retains both sentence IDs,
  contributor usernames, and per-sentence licenses. The corpus is generated
  with `npm run memory:import:tatoeba` and documented in `data/reference`.
- **No live production dependency.** Translation jobs retrieve locally from
  the bundled snapshot; they do not wait on Tatoeba or send studio scripts to
  Tatoeba.

## 2026-09-04 · Approved-script memory + provider-neutral LLM gateway

Translation quality now compounds from producer decisions instead of starting
from a generic prompt on every title.

- **Approved snapshots are the translation memory.** The first pass derives
  Chinese/English pairs from immutable `approved` version snapshots, ranks a
  small relevant set for each scene, and includes them as style and character-
  voice evidence. Retrieval spans Studio's approved corpus across producers;
  it remains server-only, same-title matches rank higher, and the prompt
  explicitly forbids importing old plot facts.
- **No duplicate memory table yet.** The approval snapshot remains the source
  of truth. A dedicated glossary/import surface can be added for historical
  scripts and exact terminology without copying current approved rows.
- **Provider-neutral calls.** `LLM_PROVIDER=anthropic|openai` selects one
  structured-output gateway. Both paths use the existing Zod contract,
  semantic validation, one repair attempt, retry taxonomy, usage accounting,
  and `studio.jobs.provider`. Fixture replay remains deterministic and never
  calls either API.
- **OpenAI path.** The OpenAI provider uses the Responses API with strict
  structured output; `OPENAI_API_KEY` is separate from a ChatGPT subscription.
  The default strong/fast models remain overrideable with
  `LLM_MODEL_STRONG` / `LLM_MODEL_FAST`.

## 2026-09-04 · The timing desk: offsets, per-cue trims, honest auto-sync

Built from a structured spec after the founder's footage ran ~500 ms late
(the burned-sub extraction sampled at 2 fps). Timing is now a first-class
control in the subtitle studio, not a re-ingest.

- **Pure math in `lib/subtitle-timing.ts`:** global offset (clamp starts at
  0, keep durations, push a clamp-pileup later — pre-existing overlaps pass
  through for QC), per-cue validation, the studio's warning list (overlap /
  reversed / <300 ms / past-video), `preciseTimecode`.
- **Explicit APIs, distinct from the stamp-repair `/retime`:**
  `POST …/timing/offset` (signed ms, ±1 min bound) and
  `POST …/timing/cues` (batched millisecond edits). Both live in the data
  layer for fixture AND Supabase (direct row updates; no schema change),
  mirror adapted rows and episode duration, and on an approved version run
  the shared fork→QC→refinalize tail (`app/api/titles/_lib/refinalize.ts`,
  which `/retime` now also uses). Offsets land in the rows exactly once —
  exports and burns never re-apply them.
- **The studio's timing desk:** ±100/±500 buttons plus an exact-ms field
  with the pending shift previewed live before applying; a per-cue editor
  (ms start/end, set-to-playhead, , / . nudges with Shift for 500 ms,
  undo per cue / all — edits stay client-side until saved in one batch);
  a playback desk (loop-current-cue, 0.5–1.5x, play-from-2s-before);
  inline warnings that click through to their cue.
- **Auto-sync from audio is an interface, not a fake:** `lib/align.ts`
  defines the forced-alignment provider contract and resolves from
  `STUDIO_ALIGN_PROVIDER`; none is implemented, so the button renders
  disabled with the reason and `docs/audio-alignment.md` documents the
  setup. The review-diff UI (per-cue accept/reject, confidence) is built
  and only ever shows real proposals.
- **Applied:** -500 ms to the founder's live episode (24 cues, none
  clamped, auto-refinalized). The bundled demo SRT was left alone — it
  already opens at 0:00.05 and a blanket shift would pile its head cues.
- ESLint was configured (eslint 8 + next/core-web-vitals) — `npm run lint`
  now actually runs; `.codex-tools/` and `video_output/` are gitignored.

## 2026-09-05 · Delivery stage two: the subtitle studio

Decided by the founders (Ruobin), in session: "first we finalize the
script, and then we finalize the subtitles (leaves room for fonts,
english + chinese, etc.)".

- **Subtitles are their own stage and page** — `/producer/titles/[id]/
  episodes/[n]/subtitles`, unlocked only once the script version is
  `approved` (a draft shows a pointer back to the episode studio, so the
  frozen script and the delivered video can never drift apart).
- **Live styled preview:** the studio's player renders the current cue as
  an overlay restyled instantly by the controls — content (English only /
  English + Chinese bilingual), font (sans / serif), size (S/M/L). The
  burn uses the SAME mapping (`lib/subtitle-video.ts`: Arial/Georgia for
  English, Microsoft YaHei/SimSun when bilingual so CJK glyphs render).
- **Deliverables live here:** the styled burned MP4 (route accepts the
  style options), SRT/VTT downloads, and the script report. The episode
  workspace's finalized card now points here instead of burning directly.
- **UI adopted:** the title-page flow is five steps (上传剧本 → AI 改编 →
  审阅修改 → 定稿 → 字幕交付); an approved episode's row action becomes
  制作字幕 and links straight into the studio.
- **Untimed episodes say so in words:** a plain-text script upload has no
  timecodes, so the studio explains that subtitles need SRT/VTT/ASS-timed
  lines (instead of a failing button), and still offers the script report.

## 2026-09-04 (late) · QC preflight + old-era consolidation

Prioritized by the founders from an outside product review ("which one do
you want to do / prioritize?"); built in session.

- **Subtitle QC preflight** (`lib/qc.ts`, pure functions): the checks a
  subtitle house runs before delivery — coverage (missing/empty lines),
  reading speed (error > 20 cps, warn > 17), line shape (≤ 42 chars/line,
  ≤ 2 lines), cue duration (700 ms – 7 s), overlaps (error) and hairline
  gaps (< 80 ms, warn), missing rationale, character-name spelling drift.
- **Errors block finalize; warnings ship visibly.** The finalize route runs
  `runQc` and returns 409 `qc_failed` with the report; the producer studio
  shows a live 交付预检 card in the right rail (issues click-through to
  their line) and disables the finalize button while errors remain.
- **Consolidation of pre-V2 remnants:** SQL `finalize_version` (migration
  0002) no longer requires scene confirms, matching the fixture;
  `dub_source_path` is gone everywhere (types, fixture, Supabase layer,
  SQL, subtitle-video source pick); the unused producer `ReviewScreen` is
  deleted; README / CLAUDE.md / PRODUCT.md now describe the subtitles-first
  flow (PRODUCT.md carries a status note rather than a rewrite).

## 2026-09-04 · The 审阅与修改 panel, final shape

Decided by the founders (Ruobin), in session, iterating on the live portal.

- **The panel sits level with the timestamps.** Viewer + timeline + scene
  strip run full width on top; below them the bilingual script sheet (left)
  and the 审阅与修改 panel (right, sticky) share one eye-line.
- **Panel order, top to bottom:** 为什么这样改编 + tone + tag chips → the
  English line in a clearly-labeled editable box (英文台词——可直接修改) →
  a 查看备选说法 button → **exactly 3 alternatives**, each an English line
  plus the vibe/why it could work → **确认修改**. Tapping an alternative
  fills the box; nothing commits until confirm; on confirm the script sheet
  on the left updates. Only the English ever changes — the Chinese column is
  untouchable.
- **No back-translation in the panel** (it stays in the bilingual diff
  export). No autosave — the confirm button is the contract.
- The alternatives prompt now asks for exactly 3; the demo bank carries 3
  per key line (including the slide-7 example line in episode 2).

## 2026-09-04 (night) · 向园 deleted; the seed is empty

The stale in-memory 向园 still pointed at a dubbed video from the retired
TTS experiments — "completely wrong". Removed at the founder's request:

- **The fixture seeds NOTHING** (producer + login personas only). The portal
  opens on the 新建剧集 card; the demo starts from the founder's own upload
  of `docs/demo/xiangyuan-ep1.srt` + `xiangyuan-ep1.mp4` (the clean,
  never-dubbed 720p cut). The replay bank still answers 生成 for that
  footage, so the flow works offline end to end.
- `.uploads/` purged (every dubbed/subtitled/test file), the seeded-title
  module deleted, tests rebuilt to construct their state through the real
  pipeline (tests/seed-minute.ts). A server restart clears any old in-memory
  titles.

## 2026-09-04 (night) · Subtitles, not dubbing — the V2 rework

Decided by the founders (Ruobin) after hearing the dub: localization ships
as SUBTITLES. "The intention of this application is to give producers the
ability to localize their scripts for America" — dubbing is out entirely.

- **Dubbing removed** (route, runner, script, button, job kind). The
  TTS demo is retired; edge-tts venv left on disk, unused.
- **The episode screen is built around reading the script.** No scenes: one
  continuous scrolling sheet; the right rail (compact player + 审阅与修改
  panel + media/export actions) stays on screen while the sheet scrolls.
  Finalize moved to the header and no longer requires scene confirms —
  content readiness (every line adapted, changed lines carrying their
  Chinese rationale) is the whole gate. Scene rows remain in the schema as
  segmentation bookkeeping only.
- **Columns are ORIGINAL vs ADAPTED.** Original = the Chinese line with its
  literal English underneath; Adapted = our American rewrite with the key
  phrase highlighted and WHY THIS CHANGE on the row beneath (the flagship;
  derived from the script alone for now — video ingestion for tone comes
  later).
- **Deliverables:** `format=script` — the clean report, JUST the English
  script (timecode · speaker · line) with a stats row (lines · words ·
  runtime); and `POST .../subtitle-video` — the episode's video with the
  adapted English burned in (ffmpeg, original audio untouched). Producer
  export surface is exactly those two.
- **Upload wording:** 添加单集 / "Add new episodes"; one row per episode
  (number + subtitle/script file + optional video), video field now in the
  new-title form too.
- **Fresh seed:** the fixture ships ONE title — minute one of the founder's
  footage (向园, `data/fixture/xiangyuan.ts`), ingested and untouched, so
  the demo opens on the 生成 moment. 爱在旅途 and the pack/clips/jobs seed
  data are retired (files deleted; their replay entries remain in canned.ts
  so the old demo SRTs still work if re-uploaded). Tests rebuilt around the
  new seed and the real pipeline (33 passing).

## 2026-09-04 · The founder's own footage in the demo

Minute one of the founder's 5-minute drama video (bilingual burned-in subs,
no subtitle stream) is a second demo title. Subs were extracted from tiled
frame crops read directly; the burned English became `literal_en`, our own
American rewrites became the adaptation (per the founder: "when you make the
English translation do your own, not from the video"), all authored into
`data/fixture/canned-user.ts` (24 lines, contexts, alternatives, key
phrases) and merged into the demo bank. New cast voices in lib/dub.ts
(董事长/向园/杨总/助理/随行). Assets: `docs/demo/xiangyuan-ep1.{srt,mp4}`
(720p re-encode of minute one). Episodes 2–5 deferred per the founder's
"just do one minute" fallback; extend by the same recipe or with a live key.

## 2026-09-04 · Demo dubbing is in (one-time, for the demo)

Requested by the founders: pass in a video + subtitles and hear an English
dub — a demo feature, explicitly not the deferred dubbing-provider decision.

- **How it works:** the producer uploads video + subtitle file at ingest
  (the uploader now has a video field), generates the adaptation, and a
  「生成英文配音（演示）」 button on the player's timeline row voices every
  adapted English line with Microsoft Edge neural TTS (free, no key) and
  mixes them over the video with ffmpeg — original audio ducked to 15%,
  each line delayed to its timecode and tempo-fitted to its slot (cap
  1.5x). The dubbed file replaces the episode's video (the original stays
  on disk). ~30s for a 22-line episode.
- **Voices:** per-character — the demo cast is pinned (林晚 Jenny · 沈亦辰
  Guy · 周瑞 Christopher), unknown speakers rotate through five Edge voices.
- **Pieces:** `scripts/dub.py` (edge-tts + ffmpeg), `lib/dub.ts` (gathers
  lines, assigns voices, spawns the repo venv `.venv-dub`'s python),
  `POST /api/titles/[id]/episodes/[n]/dub`, `setEpisodeVideo` on the data
  layer, JobKind `dub_episode` (fixture-only; NOT in the SQL enum).
- **Fixture-mode only** by guard: bytes and ffmpeg are local. Machine setup
  (done on this machine): `python -m venv .venv-dub && .venv-dub/Scripts/pip
  install edge-tts`; ffmpeg on PATH.
- Verified end to end: video+SRT upload → generate → dub → mixed, served by
  /api/media, plays with AAC audio.
- **Discoverability + demo clip (same day):** an 「上传视频/更换视频」 control
  sits beside the dub button on the timeline row (`POST .../episodes/[n]/video`
  attaches to an EXISTING episode), so the feature is reachable on the
  fixture title. A 15-second vertical demo clip ships at
  `docs/demo/demo-clip.mp4`; the dub drops lines beyond the video's end and
  clamps output to the video. `episodes.dub_source_path` remembers the
  undubbed original so re-dubs mix from the source, never from a dub
  (a manual attach resets it).

## 2026-09-04 · The cornerstone made visible: key phrase + why, in the sheet

Decided by the founders (Ruobin), in session.

- **"Why this change" is the cornerstone of the product and must be shown in
  the sheet itself, not only in the side panel.** Every adapted line now
  carries `key_phrase_en` — the exact substring of the English that carries
  the change — highlighted gold inside column 2 (e.g. "hear it from me"),
  with the explanation on a second row of the same sheet entry (gold-ruled
  WHY THIS CHANGE row). The field flows through the whole pipeline: types,
  fixture builder, canned bank (authored for all 24 bank lines), demo
  replay, first-pass/rewrite prompts, SQL (0001 adapted_lines + fork +
  snapshot). A hand edit clears the phrase (it may no longer exist in the
  text); choosing an alternative clears it too.
- **Finalize lives on the scene-strip row**, right-aligned beside the scene
  tabs (with its arm/confirm step); the panel keeps only the scene confirm.
- Note: the running fixture store predates the field — restart the dev
  server to reseed, then regenerate; fresh generations carry phrases
  immediately.

## 2026-09-03 (night) · No approval requests: producers change it themselves

Decided by the founders (Ruobin), in session, after running the portal.

- **The producer side has no request-changes flow.** They don't send changes
  for approval — they just make them. The 要求备选/needs_alternative UI is
  gone from the portal; the review screen is no longer routed to.
- **A Pulsar-submitted (in_review) episode** shows the same line list
  read-only with one decision bar: 确认定稿 (approve as submitted — per-scene
  sign-off rows are filled automatically) or 自己修改 (fork to an editable
  draft on the spot; the fork-while-undecided guard is removed, and the
  superseded version keeps any decisions for the audit trail).
- **The tag vocabulary is capped at exactly ten** so it reads as a system:
  tighter 更精炼 · more_emotional 更情感化 · more_direct 更直接 · softened 更缓和
  · more_casual 更口语 · cultural_swap 文化替换 · idiom 地道表达 · pacing 节奏调整
  · clarity 更清晰 · humor 增加幽默. (Dropped formal_to_casual/casual_to_formal
  → more_casual; subtext remapped.) An eleventh tag needs a decisions entry.
- **The screen stays the review-studio layout the founders liked** (viewer
  with the current line + timeline markers + scene strip + two-column
  bilingual script sheet). What changed is the right-hand panel: it is now
  审阅与修改 — click any timestamp and it shows 为什么这样改编 + tone, the tag
  chips, the EDITABLE English, the 回译, and 2–3 suggested alternatives
  (auto-fetched when the demo replay makes them free; behind a button when a
  live model would spend). A first rework replaced the whole layout with
  card rows and dropped the viewer — reverted the same night; keep the
  studio layout.
- The single 确认定稿 per episode stays: exports still come from a frozen,
  hashed snapshot.

## 2026-09-03 (evening) · Producer-first: the work moves to the partner portal

Decided by the founders (Ruobin), in session, over the V1 build.

- **Most of the workflow moves to the producer side.** A producer uploads a
  script → presses one button → the script is auto-adapted → they change
  what they want. The admin portal stays for Pulsar oversight; it is no
  longer where the work happens.
- **The UI must feel familiar to a mini-drama producer** and be smooth for a
  demo. Researched the consoles producers already use (短剧创作者中心, 爱奇艺号,
  抖音创作服务平台 …) — see `docs/ui-research.md`; the portal now follows
  their grammar: 作品管理 poster grid, 步骤条 pipeline strip, one primary
  action per screen, visible processing, platform status vocabulary.
- **Never translate new material for the demo; replay the existing
  translations.** In fixture mode the generate button replays the
  pre-authored bank (`data/fixture/canned.ts` via `lib/demo-replay.ts`) —
  deterministic, zero spend, no key needed. Real model calls run only in
  supabase mode (or `DEMO_REPLAY=0` with a key). `docs/demo/aizailvtu-demo-ep1.srt`
  is a bundled script whose upload replays end to end.
- **API key storage:** `.env.local` (gitignored) now exists with
  `ANTHROPIC_API_KEY=` — paste the key there.

What this changed in the build:

- Producers (reviewer/approver roles) may now: create titles under their own
  company, upload episodes, run the AI pass, edit lines, pick alternatives,
  confirm scenes — enforced per title by `requireTitleEditor`
  (lib/data/fixture.ts) and, in supabase mode, `core.can_edit_title()`
  (supabase/migrations/0002_producer_selfserve.sql). Viewers stay read-only.
  Producers now see their own drafts (they author them); Pulsar's API costs
  still never reach a producer session.
- **`finalizeVersion`** — the producer approver's one action: freezes the
  snapshot + sha256, writes per-scene sign-off rows, approves, supersedes
  the previous approved version. Staff are refused (they keep submit +
  approve-on-behalf), so an approval always records which side made it.
- New partner-portal screens: `/producer` (poster grid), `/producer/titles/new`
  (create + upload), `/producer/titles/[id]` (episode console + step strip),
  `/producer/titles/[id]/episodes/[n]` (the workspace: generate → edit →
  confirm → finalize → export). The staff-submitted `in_review` flow still
  routes to the review screen.
- Producer exports: srt / vtt / csv / diff of their own titles; brief and
  package stay Pulsar-internal.

## 2026-09-03 · V1 definition (supersedes the entries below where they differ)

Decided by the founders (Ruobin) after reviewing an outside proposal;
adopted with the lead engineer's three amendments (freeze on approve, mint
ids and record cost now, ASR as fallback not front door).

**Pulsar Studio V1: upload a Chinese short drama (video optional) or its
script and receive an approved U.S. script plus a paid-social creative
brief, exported — with a partner portal where the mini-drama company
reviews and approves.** Nothing is linked to Reach in V1. Studio only.

Two portals, one app, one Supabase project:

- **Admin portal** — Pulsar staff, English chrome by default. Projects →
  Adaptation workbench → Creative pack → Export.
- **Partner portal** — the producer (制片方, the mini-drama company), Chinese
  chrome by default. (Defaults are enforced by the route-group layouts:
  `app/(admin)/layout.tsx` passes `en` and `app/(producer)/layout.tsx`
  passes `zh` to `LocaleProvider` when no `pulsar_studio_locale` cookie is
  set; `lib/i18n.ts` `DEFAULT_LOCALE` only covers routes outside a group,
  such as `/login`.) Their own titles only (RLS); the bilingual diff per
  episode; approve scene / request alternative with a one-line reason /
  approve episode. Login through Supabase auth (magic link or password);
  one partner account per producer is enough for the pilot.

Screens (nothing else ships as a route):

1. **Projects** `/titles` — title, episode count, % adapted, status; open.
   New title (`/titles/new`): name, producer, optional synopsis and
   character notes. Per-episode subtitle files (video optional) are
   uploaded on the title page `/titles/[id]` after creation (`POST
   /api/titles`, then `POST /api/titles/[id]/ingest` per episode).
2. **Adaptation** `/titles/[id]/episodes/[n]` — the hero screen. Video (when
   present) │ Chinese script (timecoded lines; click a line and the player
   jumps) │ U.S. adaptation for the selected line and scene: adapted
   English, *why this version* (zh + en), tone shift, 2–3 alternatives,
   regenerate, edit by hand, approve scene. A Chinese back-translation of
   each rewrite is stored for the partner. Not translation: 「你再这样下去，我以后不会再管你了。」→ literal "If you continue like this, I won't care about
   you anymore." → Studio "Do this again and I'm done covering for you."
   with 为什么这样改编: 更直接，也更符合美式剧集中争吵场景的表达方式。
3. **Creative pack** `/titles/[id]/pack` — per title: 5 U.S. title options,
   10 hooks (opening lines / ad hooks), 3 short descriptions, 3–5 thumbnail
   concepts as text, ad angles (betrayal, revenge, secret identity, romance,
   cliffhanger…). **Clip finder**: best scenes to advertise, each with a
   timestamp range, hook, why it could work, suggested opening text and a
   recommended cut length; together they form the ad brief for a human
   editor. Picking a title or hook marks it as the platform choice. No Reach
   manifest, no export to Reach, no Reach ids shown (ids are still minted).
4. **Export** — one action on the title page: adapted script (.srt/.vtt and
   .csv now; .docx later), creative brief (top ad scenes, hook copy,
   timestamps, angle), title package (titles, descriptions, thumbnail
   ideas), and the bilingual diff document for the partner. Exports are
   taken from the approved snapshot when one exists, else the in-review
   one, else the current draft; the file header says which.

Approval, kept simple: a scene is `draft` or `approved` (a partner may mark
`needs_alternative` with a reason). Approving an episode — by staff in the
admin portal, by the partner in theirs — writes one frozen snapshot with a
hash; exports come from it. No comment threads, no three-stage rail, no
assignment, no version-history UI; the schema keeps one version row per
submission (a fork after `needs_alternative` is a new row) so an export is
reproducible, and the submit / approve / fork functions insert audit rows
(no UI). Version statuses are `draft`, `in_review`, `approved`, plus the
bookkeeping value `superseded` that only `fork_version` and
`approve_version` set (never shown, never visible to the partner).

Ingest: subtitle files (SRT/VTT/ASS) first. Video optional; in V1 an
episode file is stored in Supabase Storage and played from there
(Cloudflare Stream when a title needs delivery). When no subtitles exist:
an ASR job through an external API plus LLM speaker attribution from the
character notes, flagged for a human check — a fallback, not the front
door.

Costs and ids: every LLM/ASR call writes usage and cost on a jobs row and
the title page shows API cost to date; hooks, clip suggestions and rewrites
carry stable external ids in every export.

Not in V1: dubbing, lip sync, automatic video editing, thumbnail image
generation, originals / incubation, the feedback loop from Reach or Stage,
any Reach handoff, comments, roles beyond staff vs partner, asset library,
native app, publishing to Stage, Voice A/B, the marketing-boundaries
record, beats UI.

Success test (three real titles): a usable first-pass adaptation; a native
English-speaking editor saves meaningful time; 10–20 usable TikTok/Meta ad
concepts per title; those concepts become ads the Reach workflow can
launch.

## 2026-09-03 · MVP scope: the script first (superseded by V1 above where it differs)

Decided by the founders (Ruobin), in session, after reading the review.
Bullets 2–3 below (Stage pick, shared table to Reach, no producer login)
are superseded by V1: the partner portal replaces the WeChat handoff, the
creative pack replaces the hook / title lists, nothing is linked to Reach.

- The grand idea — upload a Chinese mini drama, get an American version
  (dub, subtitles, on-screen text, creatives) — is the product. It is too
  big for the MVP.
- **The MVP is the script.** Ingest a title's script: subtitle files per
  episode (SRT / VTT / ASS) or a script document; the video is optional and
  only gives the editor a player beside the line. Parse into episodes,
  scenes and timecoded lines. AI understanding pass (characters, per-scene
  context, beats). AI first-pass English adaptation per line with the
  rationale ("why this change"), 1–3 alternative rewrites on demand ("ideas
  to adapt the dialogue"), change-type tags, a Chinese back-translation.
  U.S. editorial edit. Producer approval per scene, version frozen on
  approval. Export the approved script: English VTT/SRT (the script in
  subtitle form) and a bilingual diff document the producer can forward.
- **Hook and title options are text and are in scope.** (superseded by V1
  above: the creative pack; `selected` is the platform pick and nothing is
  handed to Reach.) Studio produces
  them from the same pass; one is selected for the platform (Stage) and any
  number are handed to Pulsar Reach, the ad-launch engine. Assume Reach
  behaves like the `pulsar` / `overlord` repos: it drives TikTok (and Meta)
  traffic from creatives it is handed. The handoff is stable ids plus a
  shared table in the same Supabase project, not a Reach UI inside Studio.
- **Not in the MVP** (schema shapes may exist; no UI, no jobs): thumbnails,
  trailers, clips and other media creatives; dubbing and TTS; Voice A/B;
  subtitle burn-in and renders; Cloudflare Stream pushes; feedback
  ingestion from Reach and Stage.
- **Video → script extraction (ASR) is v1.1**, a job added after subtitle
  ingest works; it is not on the Week-4 path.

Assumptions taken by the lead engineer pending founder confirmation:

- **A1.** Subtitle files are the primary ingest. A script document without
  timecodes is accepted but degrades to a script-only view (no player, no
  VTT export until timecodes exist).
- **A2.** Producers review; they do not upload. Pulsar staff ingest. In the
  pilot a producer's approval may be recorded on their behalf with evidence
  (WeChat screenshot), as the review recommends. (Second half superseded by
  V1: the producer logs in to the partner portal; on-behalf survives as a
  staff-admin path with an evidence note.)
- **A3.** "From the same pass" for hook and title options means the same
  prompt family and cost rules, run as its own job (`propose_variants`)
  on the approved script and the title bible in Week 4 — not a side
  effect of the per-scene `first_pass` job.

## 2026-09-03 · Review decisions adopted for the scaffold

From `docs/build-context-review.md` § "Decisions the founders must make
now", adopted as defaults for the scaffold with these adjustments for the
script-first scope:

| # | Decision | Adopted default |
|---|---|---|
| 1 | Unit of review | Line stored · scene checkpoint · episode-version gate (unchanged) |
| 2 | Week-4 launch format | **Script only**: approved version exported as English VTT + bilingual diff. Subtitled playback is Stage's concern once a video exists on Stream; no dubbing trial in the plan until the script MVP is real |
| 3 | Producer approval in the pilot | (superseded by V1 above: the partner portal ships in V1; `on_behalf` remains a staff-admin path with an evidence note) ~~Exported zh diff over WeChat, recorded `on_behalf` with evidence; producer login later~~ |
| 4 | Partner deliverables | SRT/VTT/ASS required; video optional; no in-app alignment (unchanged; ASR is v1.1) |
| 5 | Schema ownership / deploy | Studio owns `core` + `studio` and the migrations; shared ids not tables; one long-lived Node process (unchanged). ffmpeg on the VPS is deferred: installed when ASR (v1.1) or the media track first needs it, not in Week 1 |
| 6 | Producer gate on creatives | (superseded by V1 above: the creative pack is text, internal to staff, no exported status, nothing to Reach) **Text variants only** (hook, title) in the MVP; `selected` marks the platform pick; ~~exported status marks what Reach may test~~; media variants and the boundary attestation flow arrive with them [Later] |
| 7 | Naming | `producer` for the partner, `Studio` for the product (unchanged); ~~stages `ai_first_pass` / `editorial_review` / `producer_approval`~~ (superseded by V1 above: no three-stage rail; `scenes.status` draft/approved + `scene_decisions`) |
| 8 | Locale defaults | `app/(admin)/` en, `app/(producer)/` zh, cookie wins; content columns never follow the locale (unchanged; route group renamed from `app/(studio)` by V1; enforced by the two route-group layouts, see V1 above) |
| 9 | Pockets | (superseded by V1 above: pockets are Later, no column in `0001`) ~~One nullable pocket per adaptation~~; one adaptation per title in the pilot UI |
| 10 | Design target | Slide 1 primary for the workbench, slide 7 for the diff card and pickers; sibling tokens and blue; Outfit 400/500/600; no pinyin (unchanged) |
| 11 | Major-change criteria | Proposed list taken to the first producer; recorded on the boundary (unchanged; boundaries table itself is post-MVP) |
| 12 | Voice A/B | **Deferred entirely** — not built, not fixtured, in the scaffold |

## 2026-09-03 · Stack

Next.js 14 App Router (matches `pulsar` and `overlord`), TypeScript strict,
`@/` alias, no CSS framework, hand-rolled zh/en i18n ported from `pulsar`,
dev port 3200, Supabase via `@supabase/ssr`, `DATA_SOURCE=fixture|supabase`
so the UI runs with no database, `@anthropic-ai/sdk` for the LLM passes,
Supabase Storage (bucket `studio-media`) for video in V1; Cloudflare Stream
only Later, when a title needs delivery.
