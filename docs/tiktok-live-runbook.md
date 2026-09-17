# TikTok paused pilot — unified Spark launch, September 16, 2026

Use the shared Clips → Launch → Monitor flow in `unified-launch.md`. Earlier campaigns is historical and cannot create or resume campaigns. Read `production-launch-readiness-2026-09-16.md` for the measured database/account state.

## Prepare the persistent environment

1. Apply `0010_clip_renders.sql`, `0011_transcribe.sql`, `0012_launch_controls.sql`, then `0013_launch_runs.sql`, one file at a time, and verify the schema. The readiness document includes the read-only SQL check.
2. Run Studio with `DATA_SOURCE=supabase` and `TIKTOK_MODE=production` using `studio-live`; keep an existing fixture server on a separate port and build directory if running alongside it. Fixture mode never creates real advertising objects.
3. On the staff `/tiktok` page, connect the intended Business Center and assign it or its account to the producer company. Stored authorizations accumulate in server-only `.tokens.json`. Check the exact account is enabled, USD, funded, and eligible for the intended Spark post. An ordinary publishing handle is not a substitute for Spark authorization and is not required by the Spark engine.

## Prepare the exact content and approval

1. On Clips, choose finished files and download individually or as a ZIP (up to 30 per ZIP; filter by title for larger libraries).
2. Manually post each chosen file on TikTok and manually generate its Spark authorization code. Paste codes directly into Launch. Keep codes and tokens out of chat and logs.
3. Select the approved company account, campaign count and Spark allocation. The first pilot should be one account and one campaign unless the approver chooses otherwise. Use the user-supplied destination `https://crazydramas.com`.
4. Choose **Paused**. Review targeting, bidding, schedule, daily pacing and the exact total lifetime media budget. A multi-campaign total is divided among campaigns; it is not repeated for every row. Preview the exact allocation and obtain the producer approver's submission, or a staff administrator's on-behalf submission with an authorization note.
5. Confirm real assets, budget and approval before submitting. No live objects or spend were authorized merely by local fixture acceptance.

## Verify paused creation

- Check every approved Spark was either created or explicitly rejected with a visible reason. An all-invalid campaign creates no provider hierarchy. Throttling leaves work pending for retry, and an incomplete hierarchy stays off.
- Read back campaign and ad-group IDs, names, budgets, schedule and disabled switches in Studio and TikTok. Campaign plus ad-group switches determine a paused launch; do not rely on an ad-level status field.
- Confirm AUTH_CODE ads refer to the authorized post/identity. The Spark flow performs no video or cover uploads.
- Producer `/producer/monitor` and staff `/promote/launches` read the same sweep. Configured On/Off and effective review/delivery are separate. Missing metrics remain unavailable.
- Refresh or retry an interrupted run using its existing run ID. Checkpointed objects are adopted, not recreated. Do not use the retired retry/relaunch endpoints.

## Activation and controls

Only after the paused hierarchy passes read-back and the exact live pilot is approved should an approver turn it on. Confirm the observed switch and delivery state; an enabled switch alone does not prove delivery.

In-place budgets cannot exceed the row's original signed allocation. A higher ceiling requires New round and a fresh preview/approval. Cost-cap replacement carries only unspent budget and may fail if below the provider minimum. End or pause remains available when creation, controls or account health need attention. Do not enable `LEGACY_PROMO_RECOVERY` for this new flow.

Revenue, Pixel and Conversions API are outside this pilot. Ask Ruobin before starting that later phase.
