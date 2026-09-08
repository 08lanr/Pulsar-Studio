# Prompt for Claude Code

Please evolve Pulsar Studio into a market-intelligence and launch-decision tool for Chinese mini-drama companies entering the United States. Work in the existing application and preserve in-progress changes. This is a substantial, phased implementation spanning data reliability, research features and UX.

First read `CLAUDE.md`, the newest decisions in `docs/decisions.md`, and `docs/market-intelligence-review.md`. The review contains the feature inventory, source mappings, concrete code findings, proposed backend contracts and homepage hierarchy. Reverify findings against the current working tree before editing because changes are actively underway. Treat recommendations as proposed changes, not proof that integrations already exist.

## Outcome

Help a producer answer:

1. What titles and story types are gaining visibility?
2. Which of my dramas deserve a US launch test, and why?
3. Which platforms, positioning and creative ideas should we investigate?
4. How did our own launches and experiments actually perform?

The homepage should be visually compelling and understandable in seconds. Prioritize breakout titles, rising tropes, recognizable posters, supported change signals and the producer's shortlist. Move median episode count, paywall and other descriptive statistics into drill-downs. Treat Titles Tracked as coverage information.

## Keep the current architecture and product boundaries

- Continue using `getData()` for application reads and writes, with fixture/Supabase equivalence and tenant isolation.
- Producer UI defaults to Chinese, supports English, and uses existing localization tooling and CSS tokens. Do not replace the design framework.
- Adapt remains frozen under My titles. Studio proposes creative tests and reads results; Grow owns execution and measurement. Do not rebuild Grow or add Stage.
- Preserve immutable approvals, external IDs, role enforcement, and the no-key/no-spend fixture experience.
- Implement the market desk first. New external-source purchases, credentials or inaccessible data are dependencies to report, not facts to fake. Continue independent work when a connector is unavailable.

## Start by fixing trust in the numbers

Investigate and address the review's findings with targeted regression tests:

- Current-versus-previous heat reference populations differ under filters.
- Same-day snapshot/raw-file overwrites contradict append-only history.
- DramaBox newest status depends on encounter order; newest-only detail candidates are skipped.
- Missing observations become zero heat; lifetime views and promotional rank are conflated with momentum.
- Equal-heat chart tie-breaking mishandles a ranked title versus an unranked title.
- Publisher/production studio/rights holder are conflated.
- 女频 is conflated with female protagonist; synopsis sentences are called proven working hooks.
- Data lacks measured geography, exact per-metric provenance and comparable runtime definitions.
- Snapshot validation, partial failures, timestamps, stale input handling and publication safety are insufficient.
- Comparable-title lookup silently truncates the catalog and hides read failures.

There is only one existing saved snapshot in the reviewed version: 507 platform listings, 442 ReelShort and 65 DramaBox. Recount current data rather than hardcoding those values. A single snapshot cannot support growth or trend claims. English-language pages do not establish US audience geography.

## Build a metric and source registry

Map every feature bundle in the review to a registry entry and implementation status. Each metric must define business meaning, entity grain, source field, unit, denominator, source surface, actual audience geography, collection locale, timestamps, window, evidence type, coverage, freshness, formula/version and limitations.

Create a producer-visible Data & Sources page grouped into:

- Catalogs & Charts
- Social & Search
- Ads & Creatives
- Platforms & Pricing
- My Reports
- Derived Metrics

Make every important displayed metric open a source/methodology view. Keep credentials, internal operational logs and other companies' reports inaccessible. Distinguish unavailable, collecting history, requires connection, stale, failed, and valid zero.

Model underlying works separately from platform listings, localized versions and remakes. Add aliases and reviewed identity relationships; title similarity is not identity. Keep immutable metric/chart observations and versioned derivations. Use per-run artifacts, completeness validation and atomic publication. Keep last successful data visibly stale on failure. Production history should be queried from the database through the data layer; retain reproducible fixtures for offline mode.

## Feature priorities

Use the detailed inventory in the review. Implement in this order:

1. Current charts and source-backed title detail; clear unknowns and provenance.
2. Search/filter/sort/pagination, platform-aware comparisons and bilingual aliases.
3. Historical rank movement, view/save velocity, chart entries, trope-share changes and launch-age comparisons when adequate history exists.
4. Company-scoped watchlists and an explainable catalog shortlist using comparables, rights, localization readiness and user constraints.
5. Own-performance CSV import with preview, validation, row errors, period/currency mapping, duplicate detection and reversible import batches.
6. One verified external-source integration at a time, followed by Grow result views.

Keep the longer-term feature inventory visible in Data & Sources with real availability states. Do not fill the homepage with placeholder widgets.

## Homepage and navigation

Top: market scope, freshness, global search and compact filters. Then four evidence-backed summary cards, a prominent breakout-title section with real trends, rising-story-type chart, personal catalog shortlist, new releases and watchlist changes. Each card opens its supporting filtered data.

With one snapshot use Prominent titles, Story mix, Newly discovered listings and Your comparable titles. Show Collecting history instead of invented changes. Keep unsupported US filters honest: an English public catalog remains labeled as such.

Navigation: Overview, Explore, My titles, Creative & tests, Data & Sources. Within Explore use Titles, Tropes, Platforms and Companies. Keep Add title as an action. Preserve existing deep links and flows.

Title details should expose Overview, Trends, Story & format, Creative examples, Comparables and Sources. Users must be able to inspect why a tag, comparison or recommendation exists.

Use disciplined typography, aligned numeric columns, consistent platform colors, useful posters and restrained chart styling. All charts need units, date windows, sample sizes, accessible summaries and tabular equivalents. Retain filter state in URLs and browser history. Verify desktop and mobile navigation, keyboard use, contrast, overflow, long bilingual titles and empty/error states.

## Rules for interpretation

- Do not aggregate incompatible raw views across platforms or interpret public counters as unique viewers.
- Preserve follows versus saves, lifetime counts versus interval growth, and platform rankings versus inferred scores.
- Trend calculations need comparable metric definitions and actual observation intervals. Do not invent a zero before first discovery. Flag counter resets and sampling changes.
- Trope share is multi-label and can sum above 100%; show denominators and platform weights. Changes use percentage points.
- Ad visibility and longevity do not prove spend, profitability or creative effectiveness. Synopsis examples are not tested hooks.
- Launch fit is an explained hypothesis, not a probability of success. Scores need versioned formulas and visible inputs.
- US retention, conversion, revenue and demographic claims require authorized reports or suitable evidence. Never infer nationality from comment language.
- Meta's Ad Library API is not a guaranteed US commercial-ad feed; its documented broad commercial scope is UK/EU. Validate access or use reviewed imports. TikTok Top Ads is a selected sample. YouTube public counters differ from owner-authorized analytics. See cited official sources in the review and recheck before integration.

## Execution and acceptance

Start with a concise implementation plan mapped to existing files, dependencies and phases, then implement the first complete slice. Continue through feasible authorized phases; keep a clear progress ledger. Avoid a sweeping rewrite or one enormous unreviewable patch.

For each phase update the source registry, relevant docs and tests. Before considering an integration complete run the repository-required `npm test`, `npm run typecheck`, and `npm run build`. Verify rendered UI in fixture mode on port 3200. Report any checks that cannot run rather than claiming success.

Required regression scenarios include unchanged snapshots under filters; same-day repeated runs; partial platform failure; missing/zero/reset counters; insufficient history; irregular intervals; newest-title duplicate ordering; score ties with missing ranks; taxonomy-version changes; source geography unknown; tenant-crossing requests; duplicate report imports; and unsupported source states.

For each delivered slice summarize the resulting user behavior, evidence/source coverage, files changed, checks performed and remaining dependencies. Do not call a feature live when it only has mock data, a schema or a connection placeholder.
