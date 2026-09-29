# Studio payment attribution review

Reviewed latest fetched Studio `origin/main` at `e8de22d`, in isolated worktree `Pulsar-Studio-payment-review`, branch `codex/payment-attribution`. The original Studio checkout and its unrelated edits were not changed. This is the Studio side of the CrazyDramas payments review and coin-pack price reduction.

Publication follow-up (2026-09-29 Pacific): rebased onto latest `origin/main` **340262c**, preserving its new ad-video statistics, Ads tab and translations. The small overlap in the dashboard imports and the decisions/locales files was resolved by retaining both features.

## Changes

1. **Fixed an incorrect refund chart.** `moneyByDay` previously excluded refunded sales from the positive product stacks and also showed the refund below zero. Its displayed net was lower than the headline by the refund amount. It now includes gross receipts above zero and refunds below zero; gross less refunds equals `moneyTotals.net_cents`. The cash KPI sparkline sums gross receipts once. Product mix and payer counts still exclude refunded purchases.
2. **Preserved actual coin costs through the report contract.** The schema accepts `coins.value_basis: "purchase_cost"`, `unpriced_spent_paid` and `unpriced_unspent_paid`. Series coin sums consume the source's integer cents. Studio does not multiply spent coins by a fixed rate or apply today's pack prices to historical purchases.
3. **Made incomplete attribution visible.** Both the main stats dashboard and the series-detail page warn when a report still uses legacy coin valuation, or when historical costs are missing. The warning covers the whole report because the source's coverage flags are not split by dashboard filters. Money's cash totals continue to use actual payments independently.
4. **Corrected explanatory text.** English and Chinese tooltips describe original purchase cost, zero cash value for free coins, and no second cash payment when coins are spent. The first-time pack description no longer hardcodes $4.99.

## Checked behavior retained

- A $4.99 historical pack and a $2.99 current pack retain their own actual cash amounts. Spending their paid coins attributes the cost supplied by CrazyDramas; it is not added to cash again.
- A coin pack bought on a series' unlock sheet does not directly credit that series. The series receives the value of coins actually spent there.
- Refunds are counted against the payment date because the report does not supply a separate refund date. Refunded payments do not create new payers or count as repeat surviving purchases.
- VIP first-week purchases and renewals remain distinct; VIP pricing is unchanged. Existing corrections for elapsed VIP periods, renewal offer labels, filtering, and unique payer counts remain intact.
- Older reports remain readable. The invented fixture intentionally exercises the legacy warning instead of claiming its approximated values are verified purchase costs.

## Verification and limits

- Targeted payment/stat tests: **11 passed**. They cover mixed old/new pack prices, cash conservation, refund-chart equality, repeat buyers, VIP renewals and legacy/incomplete report compatibility.
- `npm run typecheck`: **passed**.
- Final full suite after integrating `340262c`: **1,030 passed, 18 skipped, zero failures**, run serially. The original run's Git Bash PATH failure is resolved by including `C:\Program Files\Git\usr\bin` in the check command's PATH, so `basename` and `dirname` are available. No runner source or global environment was changed.
- Production build: **passed**, including Next's lint/type validation. After the user's performance request, final payment tests, TypeScript and build ran sequentially at Idle priority on one CPU core. The build used one worker (`CIRCLE_NODE_TOTAL=2`, which Next 14 converts to one worker); no persistent configuration was changed. Existing tracing-configuration/cache warnings remained nonfatal.
- No live provider calls, database changes or production deployment were performed by this Studio task. Publication uses the review branch `codex/payment-attribution`. CrazyDramas must deploy its purchase-cost allocation/report changes before the dashboard can show complete actual-cost attribution. Missing historical allocations remain explicitly incomplete rather than receiving invented dollars.
- Existing data limits remain: first-payer classification is bounded by the source read window; historical payments lacking origin fields cannot satisfy every demographic filter. This work does not claim to recover information the source never recorded.
