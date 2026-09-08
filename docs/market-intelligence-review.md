# Pulsar Studio: market intelligence review and feature plan

Reviewed September 7, 2026, against the working tree at `C:/Users/ruobi/code/Pulsar-Studio`. The OneDrive workspace contains only a temporary directory. This is a product and research-pipeline review, not a complete security audit or rendered-browser UX audit. Existing in-progress code was left intact.

## Product recommendation

Build the desk around three decisions: **What should we launch? Where should we launch it? What should we test first?** Lead with change, recognizable dramas, and opportunities in the producer's catalog. Keep format statistics available as supporting research.

The compelling promise is an evidence-backed shortlist for a US launch. Public catalog visibility alone does not establish US demand or commercial success. Separate market observations, test hypotheses, and measured results throughout the product.

## What is already here

- Next.js producer portal with market overview, title details, bilingual trope taxonomy, catalog matching, onboarding, and Promote. Adapt remains frozen under My titles; Grow owns campaign execution and measurement.
- Public catalog collectors for ReelShort and DramaBox, normalized files, deterministic analytics, evidence labels, and fixture/Supabase data interfaces.
- One saved snapshot, dated September 7: **507 platform listings: 442 ReelShort and 65 DramaBox**. Views exist for 442 and 53 respectively. These are listings, not necessarily 507 distinct underlying dramas.
- No saved historical series yet. Supabase research tables exist, but the market reader still reads repository files.
- The 11 existing research tests pass. They do not cover the failure modes below. No full build or visual-browser validation was performed for this review.

## Fixes to prioritize

| Priority | Finding and code | Why it matters / requested fix |
|---|---|---|
| P1 | `app/(producer)/producer/page.tsx:60` scores current titles against the full snapshot, while `lib/research/engine.ts:126` recomputes previous heat against filtered titles. | With audience/trope filters, history uses a different reference population. This can fabricate movement. Score both complete snapshots consistently before filtering; test an unchanged snapshot under every filter. |
| P1 | `scripts/research/build-snapshot.ts:174` overwrites a date-named file; `scripts/research/lib.mjs` overwrites raw platform files. | The documented append-only history is not enforced. Preserve immutable run IDs and artifacts, version transformations separately, and atomically publish only validated successful runs. |
| P1 | `lib/research/types.ts` has no metric geography, collection locale, or per-field provenance. | English web pages cannot substantiate “US views.” Store collection context separately from measured audience geography; show unknown geography explicitly. |
| P1 | `scripts/research/build-snapshot.ts:130` sets DramaBox `is_new` only when a title is first encountered. | A title already encountered on a home rail stays false when later found in the newest list. Merge list membership independently of insertion order. Preserve first-seen, release date, and platform-new flag as different fields. |
| P1 | `scripts/research/scrape-dramabox.mjs:90` builds detail candidates from home/other rails, excluding newest-only listings. | New releases can systematically lack metrics. Include all discovered listings and use a documented detail-fetch priority and coverage report. |
| P1 | `lib/research/engine.ts:44` treats missing views and placement as zero heat; lifetime views and shelf rank are combined with `max`. | Unknown data looks like failure; old hits and editorial promotion look like current momentum. Keep missing scores null, separate chart visibility from view momentum, document reference populations and ties. |
| P2 | `lib/research/engine.ts:72` ignores rank tie-breaking when subtracting finite rank from Infinity, because the difference is non-finite. | At equal heat, a charted title may lose to an uncharted one alphabetically. Handle ranked/unranked explicitly and test it. |
| P1 | `studio` combines DramaBox publisher labels with Reel Original attribution in the snapshot builder. | A platform/publisher is not necessarily the production studio. Model publisher, distributor, producer, and rights holder as distinct relationships with evidence. |
| P2 | `locales/_keys/research.json` translates 女频 as “Female-led.” | Audience positioning and protagonist gender are different concepts. Store and label them separately; neither represents measured viewer demographics. |
| P2 | `lib/research/engine.ts:305` extracts synopsis sentences, while locale copy says “Hooks that are working.” | No hook-performance evidence exists. Rename to “Premise examples from prominent titles”; measured winning hooks require actual creative outcomes. |
| P2 | `lib/research/snapshot.ts` accepts loosely checked JSON; builder can publish partial/stale inputs and has an empty-date fallback issue. | Use runtime schemas, per-platform completeness checks, timestamp validation, stale states, and a last-successful publication pointer. Never turn a failed fetch into a market collapse. |
| P2 | `app/(producer)/producer/market/[key]/page.tsx` fetches details for only the first 40 catalog entries and silently catches failures. | Recommendations can omit the strongest matches and disguise errors. Query matching metadata through the data layer with explicit limits, coverage, and error states. |
| P2 | `docs/research-feasibility.md` reports 397/110 titles; the current snapshot contains 442/65. | Generate coverage summaries from published data and distinguish historical notes from current status. |

Also review multi-label trope shares (they need not sum to 100%), reference sample imbalance between platforms, inferred attribution propagation in studio aggregates, and episode duration semantics: ReelShort episode-one duration is currently stored in the same field as DramaBox average listed duration. “New on shelf,” “first discovered,” and “released this week” must not be interchangeable.

## Feature and data-point inventory

Each row maps a feature bundle to a collection path and backend category. **Now** means existing observations or producer input suffice; **History** needs repeated comparable observations; **Connect** needs a new authorized source or report; **Research** requires evidence review/access validation. These describe data availability, not features already implemented.

### A. Breakouts and competitive movement

Backend: platform listings, metric observations, chart observations, daily derived metrics.

| Feature / data points | Source and collection | Availability / placement |
|---|---|---|
| Current chart position, chart name, platform, movement, entry/exit | Existing catalog shelves, repeated captures; retain list identity | Current Now; movement History. Homepage |
| Added views over 24h/7d/30d; views per elapsed day | Same-platform, same-definition counter observations | History. Homepage breakouts |
| Added saves/follows, save momentum | Platform-specific counter history; do not rename follows as identical saves | History. Homepage secondary signal |
| View growth percentage and acceleration | Counter history, positive baseline and minimum volume; acceleration needs two intervals | History. Drill-down or qualified breakout card |
| First seen, platform-new badge, verified release date, days since release | Existing flags/date fields plus historical discovery | Mixed Now/History. New releases |
| Time to enter top 10, peak rank, observed days in chart | Repeated named-chart observations; report missing days | History. Title detail |
| Comparable launch trajectories at day 1/7/30 | Verified release dates and equal-age observation cohorts | History. Compare |
| Save-to-view ratio | Compatible counters from one platform/surface/time; denominator displayed | Now if definitions support it. Detail; not payer conversion |
| Watchlist changes and saved-search alerts | Tenant watchlists plus derived event log | History. Homepage personal section |

### B. Story types and production opportunities

Backend: taxonomy versions, title-tag evidence, comparable cohorts, opportunity assessments.

| Feature / data points | Source and collection | Availability / placement |
|---|---|---|
| Trope chart share, rank change, momentum | Existing bilingual tags plus comparable history | Current Now; change History. Homepage |
| Trope supply: observed listings and newly discovered listings | Catalog sample; explicitly not entire market supply | Now/History. Research |
| Trope overrepresentation among prominent titles | Top-N share divided by sampled-catalog share within one platform | Now. Exploratory signal with sample size, not validated demand |
| Trope combinations: revenge + hidden identity, contract marriage + billionaire | Versioned multi-label tags, pair counts, supported examples | Now. Trope explorer |
| Opportunity map: chart visibility versus observed supply | Per-platform aggregation with minimum cohort support | Now; label as exploration, not proven unmet demand |
| Audience positioning, protagonist type, setting, emotional promise, relationship dynamic | Platform tags and reviewed synopsis coding | Now/Research. Filters and title detail |
| Local English original vs translated Chinese production vs remake | Credits and producer submissions, reviewed identity matches | Research. Strategic segment comparison |
| Competitor launch cadence and repeat trope strategy | Verified company/title links and release history | Research/History. Company pages |

### C. US audience signals

Backend: external videos, social observations, search-series imports, qualitative annotations.

| Feature / data points | Source and collection | Availability / placement |
|---|---|---|
| YouTube views, likes, comments, upload age and velocity | YouTube Data API plus scheduled observations [S2] | Connect/History. Social panel; public views are not US-only |
| US title/trope search-interest trend and related queries | Google Trends export or approved access, fixed query settings [S4] | Connect. Research; normalized index, not search counts |
| Recurring praise, complaints, “where can I watch?” requests | Sampled permitted comments with source links and human-reviewed coding | Research. Qualitative evidence; do not infer nationality from language |
| Localization friction: confusing names, subtitles, pacing, cultural references | Own test surveys, permitted comments, editorial review | Connect/Research. Catalog readiness |
| US audience share, geography, watch time and retention | Producer-authorized platform analytics [S3] | Connect. Own-title performance, not competitor estimates |
| Target-audience concept preference and willingness to continue | US recruited concept/clip tests with recruitment and sample metadata | Connect. Launch shortlist; convenience samples labeled |

### D. Creative and promotion intelligence

Backend: advertisers, ad observations, creative families, asset/title matches, creative annotations.

| Feature / data points | Source and collection | Availability / placement |
|---|---|---|
| Observed active creatives per title/advertiser, first/last seen, observed longevity | Meta Ad Library reviewed capture or validated licensed feed [S1] | Research. Creative explorer; observed count, not complete ad universe |
| Creative variant count and launch cadence | Deduplicated ad IDs plus creative-family mapping | History after access. Promotion signal, not spend |
| Opening hook, first conflict, reveal time, cliffhanger, CTA, video length | Permitted ad references and manual/editorial annotations | Research. Creative cards |
| Title/thumbnail/copy variants and destination platform | Authorized creative metadata or reviewed public references | Research. Side-by-side comparisons |
| TikTok Top Ads examples and available indexed performance | Creative Center, preserving exact metric labels and selection scope [S5] | Research. Inspiration; curated sample |
| Producer hook hold rate, CTR, CPC, install/purchase conversion and CPA | Grow or authorized ad-account results with attribution settings | Connect. My titles and Promote |
| Experiment winner, sample size, spend, confidence/uncertainty | Grow experiment read model; preserve control, allocation and conversion window | Connect. Personal homepage once supported |

### E. Platform and distribution intelligence

Backend: apps, storefront observations, commercial-model records, partner-provided distribution terms.

| Feature / data points | Source and collection | Availability / placement |
|---|---|---|
| Platform audience positioning and observed trope mix | Catalog sample plus documented publisher materials | Now/Research. Platform explorer |
| Episode count, runtime distribution, first paid episode, free minutes | Existing fields and verified episode samples; preserve runtime basis | Now with gaps. Format drill-down |
| Subscription/coin pricing and estimated cost to finish | Dated storefront offer captures by region/device/currency and explicit purchase scenario | Research. Distribution; avoid a misleading universal dollar figure |
| US app chart rank, rank movement, ratings and review themes | Verified storefront source or licensed report; confirm chart type/access before implementation | Research/History. Platform context |
| US app downloads/revenue estimates | Candidate licensed app-intelligence vendor; validate fields, methodology and redistribution rights first | Research. App-level estimates only; no title-level allocation |
| Distribution mode, delivery specifications, licensing contacts, turnaround | Official partner documentation and company-entered information | Research/Now. Launch planning |

### F. Your catalog and launch outcomes

Backend: tenant-owned catalog metadata, territory/rights records, import batches, performance cohorts, launch assessments.

| Feature / data points | Source and collection | Availability / placement |
|---|---|---|
| Candidate titles for testing, comparable hits, match explanation | Existing catalog synopses and market tags | Now. Homepage; similarity is not success probability |
| Chinese title, English aliases, original/remake relationship, versions | Producer input plus reviewed source matching | Now/Research. Catalog and global search |
| US rights availability, exclusivity period, material delivery readiness | Producer-entered rights and asset records | Now. Launch shortlist; reported status, not legal certification |
| Subtitle readiness, localization effort, missing assets | Existing Adapt state plus producer/editor estimates | Now. Catalog detail; no new Adapt pipeline |
| Budget, launch deadline, preferred distribution and acceptable test cost | Producer input | Now. Personalization |
| US starts, episode continuation, completion and paywall drop-off | Authorized distribution reports or validated CSV | Connect. Own-title performance |
| Payers, payer conversion, net receipts, refunds, acquisition cost | Own reports and Grow results with currency and attribution metadata | Connect. Own-title performance |
| D1/D7/D30 retention and revenue cohorts | Own player/distribution reports; only if cohort definitions are available | Connect. Cohort charts |
| Launch scenario: costs, assumed conversion, break-even and sensitivity | Producer inputs plus explicit assumptions; realized results kept separate | Now as scenario tool. Launch planning |
| Chinese-to-US performance comparison | Partner-reported China data plus own US reports, matched periods/definitions | Connect. Directional context; no raw incompatible totals |

## Shared backend and source catalog

Create a visible **Data & Sources** destination now. Group it into Catalogs & Charts, Social & Search, Ads & Creatives, Platforms & Pricing, My Reports, and Derived Metrics. Keep non-secret methodology visible to producers; operational logs, credentials and tenant raw reports require appropriate access.

Every feature above needs a registry entry even if unavailable. Record its display name, business question, metric key, grain, units, numerator/denominator, source, evidence kind, source geography, collection locale, actual audience geography, period, refresh target, current freshness, sample/coverage, formula/version, limitations, and status (`available`, `collecting_history`, `requires_connection`, `manual`, `unavailable`, `stale`, `failed`).

Suggested shared entities:

1. `sources`, `metric_definitions`, `ingestion_runs`, `source_artifacts`: access method, owner, expected schedule, run status, completeness, artifact hash, parser version. Retain permitted artifacts under source-specific retention rules.
2. `works`, `platform_listings`, `title_aliases`, `company_relationships`: distinguish underlying drama, localized versions, remakes, platform IDs, and company roles. Matching has confidence, rationale and review state; similarity never automatically merges records.
3. `metric_observations`, `chart_observations`: immutable values keyed by listing, metric definition, source, context and timestamp. Keep raw source field names and units. Missing values include a reason; zero remains an actual observation.
4. `taxonomy_assignments`, `derived_metrics`: versioned classification and reproducible outputs referencing input observation IDs, method, cohort and evidence.
5. `watchlists`, `saved_views`, `import_batches`, `partner_performance`, `launch_assessments`: company-scoped records with equivalent fixture and Supabase authorization.

Continue routing reads/writes through `getData()`. Keep committed fixtures for a no-key demo; make the production data implementation read successfully published database runs. Do not scan an indefinitely growing JSON history on every request. Compute daily aggregates and query indexed windows.

Collection flow: source capture/import → immutable artifact/run → validated normalization → quality checks → atomic publication → derived metrics → UI. A missing platform must be visibly stale or unavailable, never silently removed from a comparison. Persist failed-run status without replacing successful data. Use timeouts, bounded retries, pagination completeness checks and idempotency.

### Metric contracts to settle before coding

- Counter velocity: `(value_end - value_start) / actual_elapsed_days`, only for comparable definitions/context. Counter decreases generate an anomaly; do not automatically call them negative demand.
- Seven-day growth: `100 * (end-start)/start` with baseline > 0. Show the absolute change and timestamps; first-seen titles lack a historical zero baseline.
- Rank movement: `prior_rank - current_rank` within the same named chart. Entry/exit are categorical, not invented numeric ranks.
- Trope share: matching titles / eligible chart cohort. Multi-label totals can exceed 100%. Display top-N, platform and sample size; specify how multi-platform summaries are weighted.
- Chart-share change: percentage points, with the same reference-population policy and taxonomy version. Method changes should not appear as market changes.
- Trend intervals: require comparable observations near the requested endpoints with a published tolerance. Report actual elapsed time; never label yesterday-versus-last-month as a daily delta. Use three or more valid samples for a sparkline, showing gaps.
- Launch fit: explain comparable titles, rights/readiness and missing information. Do not show a hit probability without validated outcome training data and calibration.

## Homepage and navigation

The first screen should answer a question before asking users to inspect a table. Prefer four strong signals over a dozen undifferentiated KPIs.

Suggested desktop hierarchy:

```text
Market overview                 Search titles / tropes / companies
Source scope • freshness        Platform | period | audience positioning

[Biggest chart climber] [Fastest view growth] [Rising trope] [Your shortlist]

Breakout titles (wide)                         Changes worth investigating
Cover • title • platform • movement            3 concise evidence-linked insights
Trend • observation window • source            Each links to examples/data

Story types gaining chart visibility          Your titles to test
Ranked change bars + sample sizes              Comparable titles + readiness

Newly discovered titles                       Saved watchlist changes

Coverage: 507 listings • 2 platforms • observation timestamps • Data & Sources
```

Initially there is only one snapshot. Substitute **Prominent titles**, **Story mix**, **Newly discovered listings**, and **Your comparable titles**. Display “Collecting history” where appropriate. Never fabricate trend lines to complete the design. Keep Titles Tracked as a small coverage strip, not a success metric. Move median episodes, paywall and audience-positioning shares into detailed research.

Use Chinese-first navigation with an English toggle: Overview / 市场概览, Explore / 市场探索, My titles / 我的剧库, Creative & tests / 素材与测试, Data & Sources / 数据与来源. Explore contains Titles, Tropes, Platforms and Companies; saved views/watchlists can live inside it. Keep “Add title” as an action. Adapt stays inside title detail; Grow still runs tests.

Interaction requirements:

- Every card and chart opens the exact supporting filtered view. Preserve filters in URLs and browser history; clearly reset them.
- Title explorer: search Chinese/English aliases, sort, paginate, choose columns, save filters, compare 2–4 titles. Use platform-specific metric columns instead of a pooled views leaderboard.
- Title detail: Overview, Trends, Story & format, Creative examples, Comparable titles, Sources. Evidence drawer shows source, exact observation, formula, sample and caveat.
- Use consistent platform colors, accessible contrast, real axes, units and time ranges. Change has arrows/text as well as color. Avoid 3D charts, decorative gauges and unsupported precision.
- Stable poster sizes, readable bilingual titles, tabular numerals, aligned decimal precision and restrained animation. Preserve the existing CSS tokens; no full visual framework replacement.
- Desktop can use a wide chart and narrow insight column. Mobile gets stacked cards, usable navigation and deliberate table overflow/column reduction. Keyboard users need visible focus and accessible chart summaries; every chart has a table alternative.
- Show loading, no results, no history, stale source, partial coverage and connection-required as different states. Do not render all of them as a dash or zero.
- Generated insight copy must cite observation IDs and use templates or validated structured output. “Chart visibility increased” is defensible; “Americans now prefer X” requires US audience evidence.

## Source feasibility corrections

**S1 — Meta:** The existing feasibility note overstates the Ad Library API as a straightforward source for US commercial-ad monitoring. Meta's current documentation lists worldwide political/issue ads and all ad types delivered to the UK/EU; its general live-ad search is a separate library surface. Treat US commercial monitoring as a source-access research task or reviewed import, not a promised API connector. Ad activity does not establish spend or ROAS. [Meta official API description](https://br-fr.facebook.com/ads/library/api/?source=archive-landing-page).

**S2 — YouTube public:** Public video resources expose counters such as views, likes and comments. Preserve video type and metric definition; Shorts view-count semantics changed in March 2025. Public counters do not supply US viewer geography. [YouTube video resource](https://developers.google.com/youtube/v3/docs/videos).

**S3 — YouTube owned:** Authorized channel reports support geography and retention subject to report compatibility and ownership. This is a connected-producer feature. [YouTube channel reports](https://developers.google.com/youtube/analytics/channel_reports).

**S4 — Search:** Google Trends is normalized relative interest, not absolute search volume. Preserve region, query/topic, category, search property and time window; separately normalized exports cannot simply be spliced together. [Google Trends methodology](https://support.google.com/trends/answer/4365533?hl=en).

**S5 — TikTok:** Top Ads contains selected advertiser-authorized creatives. Its available examples and indexed metrics should not be described as a complete competitive universe. [TikTok Top Ads documentation](https://ads.tiktok.com/resources/help/article/top-ads?lang=nl-NL).

The existing catalog-access caveats are recorded in `docs/research-feasibility.md`; confirm an appropriate production access arrangement before enabling ongoing collection. App intelligence, storefront feeds, pricing and redistribution access still require validation. Do not assume a free Apple top-grossing RSS feed exists because the earlier note suggests one.

## Implementation order

1. Correct semantics and pipeline integrity; introduce the metric/source registry and visible source pages. Retain no-key fixtures.
2. Ship the redesigned current-state overview, explorer, title sources and real empty/history states using existing data.
3. Establish permitted scheduled collection, production storage and comparable historical metrics. Enable movement only when enough observations exist.
4. Add company-scoped watchlists, explainable catalog shortlist and report imports. Begin with the producer's highest-value actual report.
5. Validate one additional public/authorized source at a time: YouTube is a concrete candidate; creative libraries begin with reviewed references unless access is established.
6. Add measured launch-performance views from Grow, followed by deeper audience and commercial modeling once the inputs exist.

For each phase require a visible end-to-end slice, matching data contracts, meaningful tests, updated documentation and clear source limitations. Avoid building dozens of empty widgets or introducing a universal “success score” before its ingredients are defensible.
