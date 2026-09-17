# Launch review response — September 16, 2026

This response is based on the review screenshot supplied in the task and inspection of the current checkout. The full consolidated Markdown and the reviewer's two test files were not available locally, so the reproductions below are independent tests, not executions of the attached tests. Review claims are findings to verify; they do not supersede the user's later instructions.

## Confirmed failures and repairs

- **Signed budget bypass:** reproduced for both TikTok and Meta. A $200 approval accepted a $100,000 control because the provider compared against the campaign row after the control changed it. Both new rejection tests failed before the repair. The service now validates before mutation, and both providers derive the immutable per-campaign ceiling from the signed draft/account allocation. In-place reductions/restorations stay within that ceiling. Higher budgets use the existing New round flow with a fresh preview, approval and external objects. Another account's allocation is not available to borrow. Budget-corrupt rows fail independently, and stopping remains possible.
- **Throttled Spark silently omitted:** a throttled or unfamiliar ad-create error now leaves the selected Spark due for retry. A group must contain every resolved post or an explicit permanent rejection before it is ready. Incomplete groups cannot activate through initial launch, Resume, group switches or copies. Reconciliation creates/adopts only missing ads and keeps earlier successes. Tests cover both the original group and a copy.
- **Remote budget drift:** independent follow-up tests also reproduced TikTok resuming a group whose budget had been increased in Ads Manager, and using that inflated amount for a cost-cap replacement. The driver now reads the whole remote hierarchy before enabling delivery or sizing a replacement. It verifies the current ceiling and budget modes, accounts for retired groups' spend, and rejects unknown/missing groups or enabled retired groups. Pause/end remain available. Meta already checks its remote hierarchy before activation and now combines that with the immutable signed-ceiling check.
- **Monitor presentation:** run names and account names lead, with the external run identifier secondary. Plan approval and campaign creation have separate visible states from provider delivery. Budget controls explain the signed ceiling and the new-round path. Older creative-pick approval is explicitly labeled as such.
- **Optional Studio MCP exposure:** the bridge remains implemented, but its route now returns 404 unless the deployment sets `STUDIO_LAUNCH_MCP_ENABLED=1`. The enabled route retains authentication, origin checks and shared service authorization. This switch does not authenticate Meta's separate official MCP server.

## Scope reconciliation

The user explicitly requested Meta alongside TikTok, answered **Support both** for existing posts and finished-clip upload, and requested Meta MCP research/connection. Deleting Meta or MCP as unsolicited would contradict those instructions. TikTok video download, posting and Spark-code generation remain manual; the user's last clarification places those codes in Launch. A mandatory Spark-code entry step on Clips is therefore not part of this accepted flow.

The current preview explicitly treats the entered lifetime amount as the total across a provider launch, allocated among campaigns, with daily pacing separate. This differs from a literal per-campaign cap interpretation of the earlier plan. The repair enforces the displayed/signed contract; it does not silently reinterpret a $500 total as $500 for every campaign. Staff administrators retain the audited on-behalf role in the current launch flow. Revenue, Pixel and Conversions API work remain deferred until the user is consulted.

The JSON document per launch is an implementation choice, not a verbatim port of the earlier table design. It allows allocation, approval, lease and campaign checkpoints to commit atomically with a revision check. It also leaves campaign-level SQL reporting/indexing as a tradeoff to revisit; production schema status is now recorded in the [acceptance report](launch-acceptance-2026-09-16.md).

## Acceptance follow-through

- Legacy cutover passed route, data-method and browser verification. Earlier campaigns retains historical records, creatives, results and stop controls; the default old scheduler reads review/metrics without adopting or copying old launches.
- Completed the screen-by-screen Overlord/Grow comparison and documented intentional scope differences in [screen acceptance](launch-screen-acceptance.md). This is behavioral acceptance, not a claim of identical visual styling.
- Clips now has actual browser preview and binary-verified individual/ZIP download coverage. Expanded launch tests cover daily pacing, cost-cap changes, ending a campaign, shared staff/producer IDs and a new round with fresh budget approval/provider IDs.
- The new-round walkthrough exposed an asynchronous loading race that could replace an early budget edit with saved values. The loading guard and stale-request cancellation now pass a deterministic delayed-response test in both viewports.
- Migrations `0010`, `0012` and `0013` were applied and verified. Corrected `0011` still needs separate approval; production SQL verification currently passes 17 of 20 checks.

## Verification and remaining live work

The final uninterrupted run passed **30/30 browser tests**. **329/329 unit tests**, TypeScript, lint and an isolated production build also passed. The build-generated tsconfig include was removed after checking it was the only tsconfig difference.

A real paused launch still requires the exact approved creative, assigned company account and budget/preview. The supplied destination `https://crazydramas.com` is reachable, and fresh read-only Meta/TikTok checks succeeded; those reads do not establish creation eligibility. Official Meta MCP OAuth remains unresolved. No live advertising writes, spend, app deployment or revenue instrumentation were performed.

See [the final acceptance report](launch-acceptance-2026-09-16.md) and [production readiness](production-launch-readiness-2026-09-16.md) for evidence and current limits.
