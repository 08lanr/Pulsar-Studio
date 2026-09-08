# TikTok mini-drama analytics: source mapping

Read on 2026-09-08 for the Title Analytics feature. Two public pages were fetched and read; nothing below comes from an API reference, a partner contract, or a logged-in console. Where this document says **not verified**, no public source we read establishes it, and the feature does not pretend otherwise.

Sources:

1. TikTok for Developers, "Mini Drama Analytics" — https://developers.tiktok.com/doc/mini-drama-analytics (accessed 2026-09-08)
2. TikTok for Business help center, "How to publish your mini drama content" — https://ads.tiktok.com/resources/help/article/how-to-publish-your-mini-drama-content?lang=en (accessed 2026-09-08)

## 1. Publishing paths (source 2)

The help article describes two publishing paths:

- **Mini Program (H5-based).** Content is reached through the TikTok Mini Center in select markets; users unlock episodes through payments or ad engagement inside the mini program. Publishers register a developer account, create an app, pass business verification and industry qualification review, integrate a series engine, enable monetization, upload a code package and submit for review.
- **TikTok Drama Center.** Episodes are published directly into TikTok's feed; users find them on the For You feed and unlock episodes via in-app ads. The article says the path "leverages multi-language translation and recommendation algorithm to reach global audiences". Publishers create an account, establish an organization with business entity verification, submit vendor and payment information, sign a contract and associate a business account with publishing permissions.

What the article does **not** say (not verified): metadata requirements, free-episode counts, coin/bean pricing, revenue-share percentages, regional availability, analytics or reporting features per path, and content submission formats.

Consequence for Studio: a listing carries a `publishing_path` (`mini_program | drama_center`) because the two paths have different account prerequisites and, per source 1, at least the conversion-funnel metrics are named in Mini Program terms ("TT Minis Visit PV"). Whether Drama Center listings expose the same analytics surface is **not verified**.

## 2. Metrics TikTok documents (source 1)

Source 1 describes the analytics visible on an app's page in the Developer Portal. It states data refreshes daily with a two-day delay, that settlement figures are "risk-controlled T+1 data" with a typical 1–3% discrepancy against the ads manager backend, and that monetization user counts are deduplicated. Available filters: date range, region, operating system, user type (retention/profile/device), payer type (orders), ad placement (IAA), order type (conversion funnel).

| Documented metric (TikTok wording) | TikTok definition (quoted or paraphrased) | Pulsar use | Studio key |
| --- | --- | --- | --- |
| Total users | "Total number of users that launched the app at least once till date" | not shown (app-level cumulative) | — |
| Active users | "Number of users who launched the app at least once (including new users)" | app-level; our per-listing `viewers` is proposed, see §3 | `viewers` (proposed granularity) |
| New users | "Number of users who launched the app for the first time" | `new_viewers` at listing level is proposed | `new_viewers` |
| Median duration per user | "Median time spent in the app per user" | not shown; per-episode watch time is proposed | — |
| Paying users, % of paying users | deduplicated count of users who paid; share of active users | `paying_users`; our conversion divides by listing viewers instead of app active users | `paying_users`, `payer_conversion` |
| Repeat paying users, % | deduplicated users with more than one purchase | `repeat_payers`, `repeat_share` | same |
| ARPPU | average revenue per paying user | `arppu` | same |
| Lifetime value | "average sales for new users in date range" | shown as platform-reported LTV, never mixed with cohort math | `platform_ltv` |
| GMV | "total sales value of the orders" | `iap_gross` | same |
| Average GMV per transaction | GMV / orders | `avg_gmv_per_order` | same |
| Recharge orders | purchase of Beans (coins) | `recharge_orders` | same |
| Redeem orders | use of Beans to unlock content | `redeem_orders` (never revenue) | same |
| Ad requests, impressions, clicks, CTR, eCPM | eCPM: "the revenue earned per 1,000 ad impressions" | impressions kept in the dataset; not shown as title views | — |
| Ad revenue | "after platform fee deduction" | `ad_revenue` | same |
| Retention 1/7/14/30-day | cohort retention rates | not shown yet; a future retention view could use them | — |
| Profile (gender, age, region), device, entry point | dimensions | region used for the cohort split (demo shares) | — |
| Conversion funnel: Entrance Exposure PV, Entrance Click PV, TT Minis Visit PV, Last Free Episode Watch PV, 3P/TT Payment Panel Show/Click PV, Consumption / Topup Order Count | page views and order counts | `entries`, `paywall_reached`, `unlock_attempts`, `unlock_success` (events and orders, not people) | same |
| Loading success rate, average launch speed | performance | not shown | — |

Everything in this table is **app-level** in the source. Source 1 names no identifiers (no app id, drama/series id, episode id formats), no API endpoints, no scopes or auth flows, no currency, and no per-episode or per-series breakdown. Per-listing and per-episode granularity is therefore **not verified**.

## 3. What Pulsar calculates, and what is proposed

- **Calculated by Pulsar** from documented inputs: completion rate, payer conversion (listing viewers as denominator), repeat share, ARPPU, average GMV per order, IAP share, CTR/CPC/CPM/hook hold from the campaign result rows (`promote.results`), cost per acquired user, cohort ROAS, observed D7/D30 cohort revenue per user, the gross → refunds → fees → publisher earnings waterfall. Formulas are in `lib/analytics/definitions.ts` and `docs/analytics/metric-dictionary.md`.
- **Proposed, granularity not verified**: per-listing viewers and new viewers, per-episode starts/unique starters/completions/watch time/paywall reach/unlocks/revenue, continuation to the next episode, mid-title entries, refunds by date, the platform fee share, settled and paid-out amounts, attributed users/payers/revenue per campaign. The demo fixture models them so the UI can be exercised; a connector may find that a provider does not expose them, in which case the metric stays `unavailable`.
- **Not shown as facts**: competitor spend and conversion, any forecast of lifetime value, and any cause for a change.

## 4. What a future connector must supply

The typed contract (`lib/analytics/types.ts`, `lib/analytics/dataset.ts`) separates values from provenance so a connector fills the same shapes. Identifier levels it must resolve:

| Level | Studio field | Notes |
| --- | --- | --- |
| Company | `producer_id` | core.producers; every read is scoped to it |
| Provider account / app | `provider_account_ref` | opaque provider id of the developer app or Drama Center organization; the mapping lives on the listing |
| Platform listing | `listing_id` (`lst_` external id) | one listing per title, one title per listing (`core.analytics_links`, migration 0007) |
| Episode | `EpisodeDailyRow.number` | joined to `core.episodes` by number when the Studio episode exists |
| Campaign | `promote.campaigns.id` and `promote.results` rows | attribution rows keyed by campaign; ad metrics never merge with title metrics |
| Reporting period | `{ from, to, timezone: "UTC", currency: "USD" }` | one timezone and one currency per dataset; a connector that reports in another must convert before delivery and say so |
| Cohort | `cohort_size` / `cohort_rev_d7_usd` / `cohort_rev_d30_usd` per entry day | entry = first start of any episode of the listing on that day |

Also required per delivery: `data_from`, `data_through`, `last_sync_at`, `sync_status`, the list of components the source cannot deliver (`unavailable`), whether episode attribution is delivered, the paywall episode, the contractual fee share (or null), settlement and payout cut-offs. The state machine (`available | needs_listing_link | linked_awaiting_data | partial | stale | sync_failed`) is computed from those fields, never set by hand.

Auth flows, scopes, rate limits and endpoint paths are **not verified** by either source and are deliberately absent from the code.
