# Unified Clips, Launch and Monitor

Implemented locally September 16, 2026. This document records the user's final approved scope; it supersedes conflicting product defaults in the earlier launch plans. Live provider acceptance and database deployment are separate from fixture verification.

## User flow

- `/producer/clips` uses the existing episode cutter's finished files. Choose, preview and download individually or as a selected-clips ZIP (up to 30 files; bounded size). TikTok posting and obtaining Spark authorization codes are manual; paste the resulting codes into Launch.
- `/producer/launch` chooses TikTok or Meta, company-assigned accounts, content allocation, destination, targeting, lifetime launch budget and optional daily pacing. Preview shows each campaign allocation; an approver submits. Staff administrators can act for a selected company with an authorization note.
- TikTok redeems codes separately per account. Unique allocation is the default; shared allocation reuses a set in every campaign. The new Spark engine does not upload videos, create covers or replace post text. An entirely invalid Spark row creates no campaign; eligible sibling rows proceed and skipped codes are recorded.
- Meta accepts Facebook Page post IDs, Instagram media IDs or exact finished Studio clips. Files are resolved and hashed on the server. Upload processing and partially built hierarchies resume from durable checkpoints. Complete hierarchies are verified before activation.
- `/producer/monitor` shows stored delivery, review notes, spend, clicks, CPC, available conversions, freshness and supported controls. Staff use `/promote/launches`; account assignment is `/meta`. Missing measurements are unavailable, never fabricated zeroes.
- New round copies content/settings into a fresh draft with no approval or external IDs. Meta schedules move forward with the original duration. The next budget must be reviewed and approved again.

The initial objective is website traffic. Revenue tracking, Pixel, Conversions API, purchase optimization and mobile app measurement are deferred. Ask Ruobin about the Pixel and Conversions API before starting that phase.

## Money and authorization

The entered lifetime amount is the total across this provider launch. A $500 launch across four campaigns allocates $125 each. Whole-cent remainder allocation is deterministic. Daily pacing is an additional per-campaign rate, divided across planned TikTok groups; it does not expand the lifetime ceiling. Platform minimums are validated. The 15% fee is displayed separately and never becomes media spend.

Submitted input and account bindings are immutable and hashed. File or assignment changes after preview require saving and previewing again. In-place budget changes are audited and must remain within that campaign's original signed allocation. The service validates the requested amount before changing the campaign row; each provider independently derives its ceiling from the signed draft and account allocation. Reductions can be restored up to that original ceiling. A higher ceiling requires New round, a fresh preview and approval; an audit entry alone cannot authorize it. An uncertain control remains pending until the same control is reconciled or delivery is stopped.

Producer viewers read; reviewers prepare; approvers launch/control. Staff editors prepare; staff administrators launch/control. Every read and mutation remains scoped to the company. Provider tokens stay in server configuration and are absent from run records and API responses.

## Persistence and recovery

Migration `0013_launch_runs.sql` adds `promote.launch_runs` and `promote.launch_connections`. A run is one revision-conditional JSON document containing campaign rows, allocations, frozen inputs, approval, audit and provider checkpoints. This deliberately makes submit and worker claims atomic without a multi-table partial-commit window. Both tables have read-only authenticated RLS; authorized server services perform writes with the service role. Existing legacy campaigns, launches and migrations are preserved.

Fixture data implements the same guards and compare-and-swap transitions, persists under `.uploads/launch-state.json` outside tests, and routes new launch engines to endpoint fakes. Fixture approval cannot be replayed in another environment. Meta and TikTok provider payloads remain separate.

One lease serializes launch, controls and monitoring per run. Checkpoints adopt IDs after interrupted creates and preserve stop requests arriving during provider calls. Paused preparation can retry to completion while remaining paused; explicit Resume then activates. End is terminal. The existing scheduler calls the shared sweep for recovery, review, metrics and TikTok review-triggered copies. UI and MCP use the same services.

TikTok ad-create throttling and unfamiliar provider errors leave the affected Spark pending, rather than skipping approved content. An incomplete group stays paused and cannot be enabled through Resume, group switches or automatic copies. Retry adopts confirmed ads and creates only missing ones. Explicit permanent creative rejection still follows the partial-code policy and is shown as skipped.

The old campaign desk is labeled Earlier campaigns and its main creation link opens the new Launch. The older create page redirects to Launch, title-level new campaign links open Launch, and the old creation, approval, submit, retry and relaunch APIs reject with 409. Earlier campaign records remain readable. Their monitor and stop controls remain available; legacy resume, budget changes, new copies and status overrides are retired. The scheduler continues review and metric reads of existing deliveries, but by default it does not adopt unfinished old launch rows or create old automatic copies. Set `LEGACY_PROMO_RECOVERY=1` only for a deliberate one-time recovery of previously approved in-flight legacy rows; inspect the queued launch and its signed budget first, since this enables old uploads and copies. Unset it after recovery. New `promote.launch_runs` recovery continues independently.

## Deployment configuration

1. Verify required migrations in the intended Studio database before deploying. Acceptance applied and verified `0010`, `0012` and `0013`; corrected `0011` still awaits separate approval. See [production readiness](production-launch-readiness-2026-09-16.md) for current schema evidence.
2. Real launch persistence requires `DATA_SOURCE=supabase` and the existing Supabase server credentials. Fixture is the default and always uses the new providers' fakes.
3. TikTok uses the existing server authorization store and `TIKTOK_MODE`. Assign a Business Center or account to a company through the staff desk. The Spark engine checks account status and actual currency before authorization/creation.
4. Meta uses server-only `META_ACCESS_TOKEN`, `META_API_VERSION=v26.0`, and the explicit `META_LIVE_WRITES=enabled` deployment switch. Until the switch is enabled, live reads can work but writes fail clearly. Assign discovered ad account, Facebook Page and optional connected Instagram identity in `/meta`.
5. Run the app as a persistent Node process for its five-minute sweep, or use the shared sweep from the deployment's job runner. `SCHEDULER_DISABLED=1` disables the in-process scheduler.
6. Verify a specifically approved paused live test with real destination, assets and budget before any activation. Fixtures prove orchestration and recovery, not live account eligibility or Meta App Review status.

The official Meta Ads MCP URL is configured locally, but its OAuth dynamic registration was rejected for this client. It is not authenticated. Studio's separate MCP bridge is described in `launch-mcp.md`; it reuses Studio approval services and does not substitute for official Meta OAuth.

Studio's optional MCP route is disabled by default. Enable it explicitly with `STUDIO_LAUNCH_MCP_ENABLED=1` only when connecting a Studio client. Disabled GET and POST requests return 404 before tool dispatch; enabling the route preserves all existing authentication and role checks.

## Verification

The final acceptance passed 329/329 unit tests, 30/30 browser tests in one uninterrupted run, TypeScript, lint and an isolated production build. The browser suite includes real rendered clip previews and byte-verified MP4/ZIP downloads; two TikTok accounts, four campaigns and eight Sparks; daily pacing, cost-cap and signed-ceiling controls; staff/producer monitor consistency; fresh-round approval/IDs; and a Meta launch using both an existing Facebook post and a finished Studio file.

Regression tests cover the signed-budget bypass, transient Spark creation failures, remote budget drift and the saved-round loading race. Older creation paths are retired and covered by route/data/browser checks. Screen behavior and intentional differences from Overlord/Grow are recorded in [screen acceptance](launch-screen-acceptance.md).

See [the acceptance report](launch-acceptance-2026-09-16.md) for exact results, artifacts and remaining live limits. Migrations `0010`, `0012` and `0013` are verified; corrected `0011` is pending separate approval. Read-only provider checks succeeded, but no real paused ad launch has been performed and official Meta MCP remains unauthenticated. Revenue, Pixel and Conversions API are deferred.
