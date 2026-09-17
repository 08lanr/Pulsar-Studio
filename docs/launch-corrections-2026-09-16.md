# Launch corrections — 2026-09-16

The Xinghai staff launch was completed before this final correction: read-only verification confirmed real TikTok advertiser `7661702138107822098` and campaign `1876533366182050`. This work did not modify that live campaign. The subsequent changes make campaign identity, default Sales settings, Instant Pages, account selection and Monitor behavior reviewable for future rounds.

## Changes

- `LaunchAccountPicker` now uses compact scrollable account rows, filter counts, search, select shown/clear, quick-pick modes and a history rescan. It opens immediately. TikTok objective counts support the warmed, Sales and Leadgen filters; unavailable values stay unknown. A 66-country account is no longer labeled 66/65 or excluded from Full geo.
- New TikTok drafts default to five Spark codes per campaign; Meta remains one. Saved drafts retain their chosen quantities. The existing allocation counter continues to distinguish unique content from shared content.
- The preset picker refreshes on window focus, visible-tab changes, selector focus and an explicit refresh button. New presets appear without overwriting the draft or automatically applying a preset.
- Staff authorization notes remain mandatory on the server. The primary **Launch on TikTok** or **Launch on Meta** action prepares a preview, then opens a full review and authorization dialog. The final **Confirm launch** action submits. Missing authorization is reported in the dialog. No ads are created by previewing or opening the dialog.
- Save, preview and launch failures remain visible beside the bottom actions and receive focus. The launch form and staff company selector lock while saving or previewing, preventing a late preview from describing a different draft or company. Switching companies also clears an unsaved run reference.
- Staff Launch (`/promote/launches`) and Monitor (`/promote/monitor`) are separate pages and sidebar items. Producer Launch and Monitor are separate as well. Launch detail pages show the editor only. Old staff `/promote/launches?run=…` links redirect to `/promote/monitor?run=…`.

## Real account status

The requested `ruobin+xinghai@itspulsar.com` login was created as a producer approver for Xinghai Pictures. The existing staff identity was preserved. Its initial random password was used only for an in-memory sign-in/RLS verification, then discarded. The temporary password setup helper has expired; this report does not imply that it remains usable. No password or access token is recorded here.

Earlier in the investigation, before the real launch was submitted, read-only inspection found zero saved Xinghai launch runs and the live-server log showed account scans without a draft-save or launch request. The empty staff authorization note was a real post-preview blocker, but it did not explain that earlier click. The user then completed the real launch; the zero-run observation is historical, not the current state.

Xinghai still has one stored Meta connection and an assigned TikTok Business Center. Eligible TikTok account choices are expanded dynamically from that Business Center, not stored as one launch-connection row per account.

The submitted real launch used one selected TikTok account, four manually supplied Spark codes, a $20 total lifetime budget, Start paused, and `https://crazydramas.com` as its destination. The later Sales and Instant Page implementation was not used to create or change that campaign. Revenue, Pixel and CAPI remain deferred.

## Earlier verification

- At the earlier confirmation-dialog milestone, 336 unit tests, TypeScript, ESLint and a production build passed. The final implementation has a newer verification result below.
- The full browser run passed 34 cases; the new confirmation flow exposed an ambiguous test selector matching both the inline and dialog summaries. Four dependent cases were skipped. After scoping that assertion to the dialog, all 10 affected launch cases passed at desktop and presentation widths (`tmp/actual-launch-final-e2e.log`). Together with the 30 unaffected cases in `tmp/actual-launch-e2e.log`, all 40 browser cases have passing coverage. No app change was needed for the selector correction.
- The earlier focused browser pass covered the compact picker, preview consistency, authorization errors, presets, the five-Spark default, allocation and paused delivery. Its log is `tmp/launch-corrections-final-e2e.log`.
- Browser tests use port 3202 and do not reset the user's demo or live workspace.
- Visually inspected the fresh confirmation dialog and Launch preview: account, Spark allocation, budget, destination and paused state are readable together. Screenshots: `docs/demo/launch-v2/2026-09-16-desktop-launch-confirmation.png` and `docs/demo/launch-v2/2026-09-16-desktop-launch-preview-final.png`.

## Historical launch-button diagnosis

The user's later screenshots identify the exact control: the button labeled "Launch" beside the Monitor heading was a navigation link to `/promote/launches`, which was already the open staff page. The real form had not yet been previewed, so its actual submission button was not present. Account selection was complete (one account, four supplied Spark codes, four required). The earlier missing-note diagnosis described a real post-preview UI defect, but was not the cause of this click.

The monitor is now on its own page, where its secondary navigation link reads **Create a launch**. The Launch page offers **Launch on TikTok** or **Launch on Meta** as the primary action. That action prepares the preview and opens the full review and authorization dialog; only **Confirm launch** submits.

## Sales launch and campaign identity acceptance

- New saved rounds assign each campaign a readable `campid` containing the launch-name slug, a stable run-derived suffix and a campaign index. The same ID is the provider campaign name. Its destination gains exactly one `campid` query parameter while retaining existing parameters and fragments. Preview, approval, provider creation and retry use the frozen row; a new round gets new IDs. Approval signatures cover the ID, name and tracking URL. Approved rows created before this change keep their original signature, provider name and destination on retry; existing live TikTok campaigns were not renamed.
- Fresh TikTok drafts default to the one-geo US Sales shape: `WEB_CONVERSIONS`, `CONVERT`, TikTok placement, $0.20 cost cap, and $20 daily budget per campaign. Existing saved Traffic drafts and old promotion launches retain their settings. Staff can manage reusable Instant Page designs with button text, white or black background, and optional hand cursor. The selected design and pinned master version/hash freeze in the approved launch. The adapter copies the pinned Sales master, puts the campaign tracking URL on its CTA, mints an editor token using the existing advertiser OAuth token, and creates and publishes the page before Sales ads reference its saved page ID. It guards writes and refuses an uncertain create result rather than silently creating a second page. This integration has only been exercised with fake or mocked transport; no real Instant Page has been published during acceptance.
- The Monitor presents compact campaign rows grouped by launch, with campaign details and ad groups expandable. The Business Center or Meta portfolio control groups the accounts returned for the selected producer; when none is available it shows a clear selection/loading/empty placeholder. It does not create or assign Business Centers.
- Migration `0014_instant_page_templates.sql` is applied. Live schema verification found row-level security enabled, `hand_cursor` present, and two policies; authenticated `SELECT` was confirmed. The existing real TikTok advertiser `7661702138107822098` and campaign `1876533366182050` were verified separately and left untouched by this implementation.

Final browser verification: the full fixture suite passed 44/44 on port 3202 with no failures. After the template picker gained focus/visibility refresh with stale-response protection, its focused return-from-Templates regression passed 2/2 across desktop and presentation projects. The browser test server was stopped afterward; the user's demo and live services were preserved.

Final offline verification: 344 unit tests pass; TypeScript, ESLint and the isolated `.next-redesign-build` production build pass. The production file traces for staff launch, producer launch and the sync worker each include the exact pinned Sales master asset. No live provider create, publish or activation request was made for this acceptance.
