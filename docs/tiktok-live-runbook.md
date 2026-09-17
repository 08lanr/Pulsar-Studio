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

## Seeding test clips for a producer

A live company with no finished clip has nothing to select in Launch. `scripts/seed-test-clips.mjs` gives one producer a throwaway title, one episode and a handful of finished clips built from Studio's own sample footage, so the Clips → Launch → Monitor flow can be walked end to end before the producer's real episodes are cut. It creates only that title and never touches an existing one. It never opens `.tokens.json` and never calls Meta or TikTok; nothing it prints is a token or a key.

1. **See the plan first.** `node scripts/seed-test-clips.mjs --dry-run --producer="Xinghai Pictures" --count=6` prints every row and storage path it would write — the title, the episode, and each clip with its hook, its window and the SHA-256 of the exact bytes — and makes no network call. `<title_id>` and `<episode_id>` stand in for ids the database assigns; the live run prints the real ones. `--count` defaults to 6 and may not exceed 20.
2. **Write it.** `node scripts/seed-test-clips.mjs --live --producer="Xinghai Pictures" --count=6`. Run it from the Studio checkout with `DATA_SOURCE=supabase` in the environment (the `studio-live` config, or the same `.env.local` that server reads); it refuses in fixture mode. `--producer` takes the company's `name_en`, `name_zh` or id, and refuses a name that matches two companies rather than guessing. The clip files go to the `studio-media` bucket under `<title_id>/<episode_id>/seed-clip-<rank>.mp4`. Re-running the same command is safe: it reuses the seed title and episode, tops the company up to `--count`, and finishes any clip whose upload did not complete last time.
3. **Take it away.** `node scripts/seed-test-clips.mjs --live --producer="Xinghai Pictures" --remove` deletes the seed clips, their storage objects, the episode and the title, prints what it removed, and stops without deleting anything if a clip on that title was not written by the script.

Afterwards the staff `/clips` page and the producer's Clips page list the seeded clips under the title **Studio seed · test drama** (Chinese: 测试剧集（种子数据）) for that company, each row showing its hook sentence rather than an id, a playable 9:16 file and a duration. Any of them can be chosen in Launch as an uploaded clip and given Primary text and a Headline. They are ordinary clip rows, so posting one to Facebook or Instagram publishes a real public post — treat a seeded clip like any other finished file. Remove the seed before the company's real clips land, so the desk never mistakes sample footage for the producer's own.

## Verify paused creation

- Check every approved Spark was either created or explicitly rejected with a visible reason. An all-invalid campaign creates no provider hierarchy. Throttling leaves work pending for retry, and an incomplete hierarchy stays off.
- Read back campaign and ad-group IDs, names, budgets, schedule and disabled switches in Studio and TikTok. Campaign plus ad-group switches determine a paused launch; do not rely on an ad-level status field.
- Confirm AUTH_CODE ads refer to the authorized post/identity. The Spark flow performs no video or cover uploads.
- Producer `/producer/monitor` and staff `/promote/launches` read the same sweep. Configured On/Off and effective review/delivery are separate. Missing metrics remain unavailable.
- Refresh or retry an interrupted run using its existing run ID. Checkpointed objects are adopted, not recreated. Do not use the retired retry/relaunch endpoints.
- A row that reads **Waiting** is not a failure: the provider rate-limited, timed out or lost a response, and the worker returns on its own after a minute (the scheduler sweep is the second net). Leave it alone; it turns into a failure only after twelve such waits, and Retry then starts the count over. A Sales launch whose Instant Page create lost its answer settles itself on retry from TikTok's own page list.

## Activation and controls

Only after the paused hierarchy passes read-back and the exact live pilot is approved should an approver turn it on. Confirm the observed switch and delivery state; an enabled switch alone does not prove delivery.

In-place budgets cannot exceed the row's original signed allocation. A higher ceiling requires New round and a fresh preview/approval. Cost-cap replacement carries only unspent budget and may fail if below the provider minimum. End or pause remains available when creation, controls or account health need attention. Do not enable `LEGACY_PROMO_RECOVERY` for this new flow.

Revenue, Pixel and Conversions API are outside this pilot. Ask Ruobin before starting that later phase.

## Posting a clip to Facebook or Instagram

Organic posting publishes public content from Studio (decision 2026-09-16, `docs/meta-organic-plan.md`). It is not reversible from Studio: deleting a post is done in Meta's own tools.

**Before the first post.**

1. Check the scopes on the configured token: `node scripts/meta-readiness.mjs --live --scopes`. It prints the granted scopes and whether the token is a user or a system-user token, never the token itself. `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `ads_management` and `business_management` must all be there — a missing scope is the most likely reason a first post fails. `--live --account=<numeric id> --scopes` runs the account checks and the token check together.
2. The Instagram account must be a professional account linked to the Page. `--live --account=…` lists `instagram_business_account` and the account's Instagram identities; an empty list means the query returned none, not that none exists.
3. `META_LIVE_WRITES=enabled` belongs only in the approved deployment (Ruobin's Supabase-backed server on port 3203). The workspace `studio-live` config does not set it. Without it every Meta POST is refused, including a post.
4. The clip must be finished: `rendered`, with a stored SHA-256. Studio re-hashes the bytes it is about to upload and refuses if they no longer match, so a re-render means posting again, not retrying.

**Posting.** On `/clips` (staff) or the producer's Clips page, use *Post to Facebook* or *Post to Instagram* on the row. Anyone on the company can open the page and watch the state; only a staff administrator or the company's approver may confirm. The dialog names the Page or account and the caption, which defaults to the hook on the first line and the title and episode on the second. The row then reads *Publishing…* and settles by itself: a Facebook Page video takes seconds, an Instagram Reel can take minutes while Meta processes the container. Nothing needs to stay open — the row is leased for ten minutes at a time, and the scheduler sweep takes over a post whose worker died.

**Posting the same clip twice.** *Post again* on an already published clip is a second, real post: it uploads again, gets its own id, and the earlier row is marked superseded and stays in the record. Use it deliberately — Meta will show both posts until one is deleted in Meta's own tools.

**Quotas and refusals.** Instagram enforces a rolling 24-hour publishing quota per account; Studio reads it before every Reel and refuses with the number when it is exhausted. A rate limit or a 5xx leaves the row *Publishing…* at its step and the sweep finishes it — do not press Retry repeatedly. A permanent refusal (a missing permission, an ineligible media, a policy decision) shows the reason on the row; fix the cause and press Retry, which resumes from the stored step and never uploads or publishes twice.

**After the first post.** Open the permalink from the row's date, then check it in Meta Business Suite: the post is on the intended Page (or the intended Instagram account) with the caption as written, and it is a normal published post, not a draft or a scheduled one. On the ad side, the Facebook post's `pageID_postID` and the Instagram media id are then selectable in Launch's *Choose content* without pasting. Launch paused, confirm the creative in Ads Manager points at that exact post, and only then switch it on.

**What is not there yet.** Facebook Reels as a second post type, scheduling a post for later, and deleting a post from Studio. A post that must go is deleted in Meta's tools; the Studio row stays as the record that it happened.
