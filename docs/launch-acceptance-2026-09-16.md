# Unified launch acceptance — September 16, 2026

> Follow-up: [Launch/Monitor redesign and live account verification](launch-redesign-2026-09-16.md) records the newer 333-test results, UI changes, and saved Xinghai account bindings.

## Result

Local acceptance is complete. The final uninterrupted browser run passed all 30 cases across desktop and presentation viewports. Production schema verification passes 17 of 20 checks; corrected migration 0011 awaits separate approval. A real paused provider launch and official Meta MCP authentication remain outstanding.

The accepted flow remains one clipping engine, manual TikTok posting and Spark-code generation, TikTok/Meta Launch with preview and approval, and a shared Monitor. Meta supports existing Facebook/Instagram posts and finished Studio videos. Revenue, Pixel and Conversions API remain deferred.

## Completed checks and fixes

| Area | Acceptance evidence |
| --- | --- |
| Clips | Browser plays real rendered MP4s, compares an individual download's SHA-256 to its source, downloads a selected ZIP and a complete title ZIP, and verifies the MP4 bytes inside each archive. Inaccessible IDs reject the whole selection. Loading is explicit, title filtering makes a large library downloadable, and the 30-file ZIP limit is explained. |
| TikTok allocation | Two accounts, four campaigns and eight unique Spark codes; exact $500 total allocation. Unit tests verify all-invalid rows create nothing, no TikTok uploads, failed siblings continue, and uncertain creates retry without duplicates. |
| Budgets and controls | Browser verifies $20 daily per campaign/$80 total pacing, $125 original row ceilings, budget reduction, rejection above the signed ceiling, daily-budget and cost-cap changes, and ending a campaign. Unit tests cover remote budget drift, incomplete ads and stop/retry races. |
| Meta | Existing Facebook post and a real finished file complete together in one paused fixture launch. Provider tests cover Instagram post handling, video processing, recovery and identity validation. Preview identifies the selected clip by title and hook. |
| Monitor | Observed On/Off is distinct from review/delivery; unavailable metrics remain unavailable. Producer and staff read the same campaign IDs. Controls reflect provider and campaign state. |
| New round | Same content/accounts/settings, fresh approval and provider campaign IDs; $600 round two is split into four $150 ceilings. Acceptance exposed a race where the saved draft response could overwrite an early budget edit. The editor now waits for that response, ignores superseded run/workspace responses, and a deliberately delayed-response test verifies the behavior in both viewports. |
| Legacy cutover | Old creation/approval/submit/retry/relaunch APIs and data methods reject. Historical records, creative media, results and stop controls remain. Default scheduling does not adopt or auto-copy old launches. Five inert component stubs retain compatibility with the running development server's cached module graph. |
| Demo isolation | Reset removes only the demo company's launch state and fake objects, retaining other companies' runs, bindings and provider hierarchies. It also works after hot reload. |

## Verification

- 329/329 unit tests passed, with no skipped tests.
- 30/30 browser tests passed in one uninterrupted final run, covering desktop and presentation viewports.
- TypeScript, lint and the isolated production build passed. The generated build-only tsconfig include was removed after confirming there were no other tsconfig changes.
- Logs: `tmp/acceptance-unit.log`, `tmp/acceptance-typecheck.log`, `tmp/acceptance-lint.log`, `tmp/acceptance-build.log`, `tmp/acceptance-full-e2e.log`.
- Screenshots: `docs/demo/launch-v2/2026-09-16-*-clips-acceptance.png`, `*-launch-preview-final.png`, `*-monitor-final.png`, `*-meta-monitor-paused-final.png`.
- [Screen parity matrix](launch-screen-acceptance.md) documents Overlord/Grow behavior and intentional scope differences.

## Production database and provider checks

Applied and verified migrations `0010`, `0012` and `0013` in the intended Studio project. The user explicitly approved `0012` and `0013`. A 20-check SQL query passed 17 checks; the remaining failures are the `transcribe_episode` and `asr` enum values plus the corrected scene-deletion correlation from `0011`. That migration remains pending separate approval after automatic approval review rejected its execution because the explicit approval named only `0012` and `0013`. Existing records were preserved, and no real advertising objects were created or deleted.

Before application, SQL review corrected the scene deletion policy's correlation to its outer scene row and limited preset/assignment writes to staff administrators. The read-only verification query is in `docs/acceptance/verify-launch-schema.sql`; it checks columns, enums, RLS, user/service-role grants and the corrected policy predicates. Existing records were preserved.

The supplied destination `https://crazydramas.com` returns HTTP 200. Meta reads succeed for enabled USD account `act_4565068993810003`, Page `1298189526712840` and connected Instagram identity `17841434498347152`. The Page posts query returned no rows; Instagram media listing returned permission error 10. This confirms the identity is linked, not that a particular Instagram post is usable by this token.

A fresh TikTok read succeeds for two Business Centers. Of the first 100 authorized USD accounts queried, five were enabled and 95 limited. No pilot account was selected from that subset.

## Remaining live acceptance

Production has no titles, finished clips, launch drafts or company account assignments. A real paused test still needs an assigned account, the exact real creative (a manually obtained TikTok Spark code, eligible Meta post, or finished Studio clip), and an approved budget/preview. The destination is already confirmed. No real ad object was created or activated, and no advertising spend was initiated by this acceptance work.

The direct Meta Marketing API adapter is implemented. Meta's separate official MCP remains unauthenticated and needs a supported OAuth client registration/sign-in. The optional Studio MCP bridge remains disabled by default; its authorization and disabled-route behavior are covered by tests.

See [production readiness](production-launch-readiness-2026-09-16.md) and the updated [TikTok paused-pilot runbook](tiktok-live-runbook.md) for the exact next steps.
