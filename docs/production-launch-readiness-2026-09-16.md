# Production launch readiness — 2026-09-16

This is a read-only inventory and execution checklist for the intended Studio Supabase database. Production migrations were attempted and then checked through zero-row REST probes; no deployment, ad creation, activation, or Pixel/Conversions API work has been performed.

## Database evidence and current status

Zero-row Supabase REST probes used the configured server credential and returned only HTTP status and error codes. Header-only counts retrieved no rows. The database has one `core.producers` row and one `core.profiles` row; `core.titles`, `core.episodes`, `studio.clips`, `studio.jobs`, `promote.campaigns`, legacy `promote.launches`, and `core.company_accounts` each have zero rows.

| Migration | Missing-object evidence |
| --- | --- |
| `0010_clip_renders.sql` | `studio.clips.render_status`: 400 / PostgreSQL `42703`; `studio.jobs.kind = cut_clips`: 400 / `22P02` |
| `0011_transcribe.sql` | `core.episodes.script_format = asr` and `studio.jobs.kind = transcribe_episode`: 400 / `22P02` |
| `0012_launch_controls.sql` | `promote.campaigns.launch_settings` and `core.company_accounts.preferred_advertiser_id`: 400 / `42703`; `promote.launch_presets`: 404 / PostgREST `PGRST205` |
| `0013_launch_runs.sql` | `promote.launch_runs` and `promote.launch_connections`: 404 / `PGRST205` |

The table above records the **pre-migration** errors. Follow-up zero-row probes found the relevant `0010`, `0012`, and `0013` objects present. A stronger read-only SQL verification checked 20 schema, policy, grant, and trigger conditions: **17 passed**. The only failures are `transcribe_enum`, `asr_enum`, and `scene_delete_correlates_outer_row`, all belonging to `0011`. The corrected `0011` migration has not been executed and awaits separate explicit approval. The check verified `0010`, `0012`, and `0013` objects and their relevant RLS/grants, including the admin-only preset and account-assignment rules. Post-migration counts remain one producer and one profile, with zero titles, episodes, clips, jobs, campaigns, launches, company accounts, launch runs, and launch connections.

## Migration execution and recheck

The machine has neither Supabase CLI nor `psql`, and no database URL or Supabase management token is configured. The execution order in the intended Supabase project's SQL Editor is:

1. `supabase/migrations/0010_clip_renders.sql` — relevant objects verified.
2. `supabase/migrations/0011_transcribe.sql` — **corrected file awaits separate explicit approval; two enum values and the scene-delete correlation remain unverified in production**.
3. `supabase/migrations/0012_launch_controls.sql` — relevant objects verified.
4. `supabase/migrations/0013_launch_runs.sql` — both new tables verified.

Keep the transaction boundaries as written. `0010` adds the `cut_clips` enum value before its `BEGIN`; `0011` adds `transcribe_episode` and `asr` before its policy/grant statements. Once separately approved, execute the corrected `0011` file alone so its enum additions commit; do not append it to another SQL Editor query. `0012` and `0013` each contain their own `BEGIN`/`COMMIT`. All four files use guarded/idempotent object creation or replacement, but a SQL Editor error still requires inspection before retrying.

After `0011` is approved and executed, rerun the read-only [20-check launch schema verification](acceptance/verify-launch-schema.sql) in the same project. All 20 boolean results should be true before proceeding to live-mode acceptance.

Then start `studio-live` (`DATA_SOURCE=supabase`, `TIKTOK_MODE=production`) and check authenticated launch workspace/account reads before preparing a pilot. `0013` gives authenticated users read-only RLS on the two new tables; launch service writes use the server role. The in-process five-minute sweep needs a persistent Node process or an equivalent job runner.

## Provider and pilot evidence

At 2026-09-16 19:01:49 UTC, the existing **read-only** Meta diagnostic passed. Ad account `act_4565068993810003` (“Crazy Drama US”) is enabled (`account_status=1`, `disable_reason=0`), in USD, and belongs to business `1713297459750982`. The token has `ads_read`, `ads_management`, `business_management`, `pages_show_list`, and `pages_read_engagement`. Page `1298189526712840` (“CrazyDramas US”) is visible with `ADVERTISE` among its tasks; Instagram identity `17841434498347152` is visible through the account. This proves read eligibility, not ad creation eligibility or App Review approval. `META_LIVE_WRITES` is currently unset, so Studio's live Meta writes remain disabled.

The supplied destination `https://crazydramas.com/` returned HTTP 200 with title “Crazy Drama” and no redirect. The linked Page's recent `/posts` query returned no rows. Instagram `/media` returned Graph API code 10 (permission). No eligible existing Page/Instagram post ID has been verified. At 19:15:18 UTC, a fresh TikTok read-only check succeeded: the stored authorization returned two Business Centers; the first 100 authorized accounts all returned USD metadata, with five `STATUS_ENABLE` and 95 `STATUS_LIMIT`. This checks a subset of the 153 stored advertiser IDs. No TikTok account has been selected or assigned for the pilot, and no real Spark code has been verified. Production has no title, finished Studio clip, launch run, or account assignment yet.

Before proposing a paused live test, create or identify the exact approved creative, assign the production account to its company, verify its provider eligibility, and specify the provider, account, destination, exact lifetime budget, and paused launch settings. Review the resulting preview and approval record before enabling any live write switch or submitting a paid object. A paused hierarchy must be read back and verified before any later activation.

## Official Meta Ads MCP

The global Codex config points to `https://mcp.facebook.com/ads`, but it is unauthenticated and has no configured OAuth client ID. Fresh public OAuth discovery advertises authorization server/issuer `https://www.facebook.com/ads`, a dynamic registration endpoint, and no Client ID Metadata Document support. The issuer now matches its advertised authorization-server URL; this does **not** establish successful registration or login. We did not repeat a failed registration or pass the Studio Graph token to the MCP server.

[Official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) supports a pre-registered OAuth client ID and requires the exact callback URL to be registered with the provider. The [Meta Ads MCP dynamic-registration failure report](https://github.com/openai/codex/issues/24103) remains open; the later [endpoint-origin report](https://github.com/openai/codex/issues/44437) reflects earlier discovery metadata and is not proof of the current login outcome. The official MCP connection needs a supported client-registration path and an interactive OAuth sign-in before its tools can be used.
