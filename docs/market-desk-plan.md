# Market desk: implementation plan and progress ledger

Started 2026-09-07 against `docs/market-intelligence-review.md`. This file is
the running ledger; the newest state is at the top of each phase. Findings
from the review were re-verified against the working tree before each fix
(the review described the tree as of the morning; the tree had not moved).

Boundaries kept throughout: `getData()` for every read/write, fixture and
Supabase equivalence, tenant isolation, Chinese-first producer UI on the
existing tokens, Adapt frozen under My titles, Grow owns execution and
measurement, no Stage, no-key fixture mode.

## Phase 1 · Trust in the numbers, registry, Data & Sources

Files: `lib/research/{types,taxonomy,engine,snapshot,registry,history}.ts`,
`scripts/research/{lib.mjs,scrape-*.mjs,build-snapshot.ts}`,
`data/research/{runs,snapshots,published.json}`, `lib/data/{index,fixture,supabase}.ts`,
`app/(producer)/producer/sources/**`, `tests/research*.test.ts`,
`docs/research-feasibility.md`, `docs/decisions.md`.

| Finding (review) | Fix | Regression test |
|---|---|---|
| Current vs previous heat scored on different populations | `scoreSnapshot()` scores a whole snapshot; filters apply after scoring, for current and previous alike | unchanged snapshot under every filter → zero movement |
| Same-day overwrite of raw/snapshot files | per-run artifacts under `data/research/runs/<run_id>/`, snapshot files named by run id, `published.json` pointer written only after validation | same-day repeated run keeps both artifacts; latest-per-day view |
| DramaBox newest flag depends on encounter order | list membership merged first, flags derived after; `platform_new`, `first_seen_at` (history), `released_at` kept separate | duplicate ordering test |
| Newest-only DramaBox listings skipped for detail | detail candidates = union of all lists, documented priority, coverage in manifest | coverage recorded |
| Missing observation = zero heat; lifetime views conflated with momentum | scores are `null` when nothing is observed; `view_percentile` and `chart_visibility` separate; combined value named *prominence*, not momentum | missing/zero counters |
| Equal-heat tie: ranked vs unranked | explicit ranked-first comparator | tie test |
| Publisher/studio/rights holder conflated | `companies: {name, role, evidence, via}[]`; UI says 发行方/出版方, never "studio made it" | attribution test |
| 女频 = "female-led" | field is `audience` (platform audience positioning); labels say positioning, not demographics | copy check |
| Synopsis sentences called working hooks | renamed *premise examples from prominent titles* everywhere | copy check |
| No geography/provenance/runtime basis | per-metric `Observation {value, source_field, unit, observed_at, evidence}`; platform `collection {surface, locale, audience_geography: unknown}`; `episode_seconds_basis` | schema validation test |
| Loose snapshot validation, partial failures | zod schema, per-platform status `ok/partial/stale/failed`, failed platform carried forward as stale from the last published run, never dropped | partial platform failure test |
| Comparable lookup truncates and hides errors | `listCatalogForMatching()` in the data layer with explicit limit and `truncated`, errors surface | tenant isolation test |

Status: **done.** Shipped: schema v2 with per-metric provenance and
collection context; immutable runs + atomic publication + stale carry-forward
(`lib/research/build.ts`, `scripts/research/*`); null-not-zero scoring with
separate view percentile / chart visibility; whole-snapshot scoring before
filters; explicit ranked-first tie-break; company roles; audience positioning
wording; premise examples wording; registry + `/producer/sources`;
`listCatalogForMatching` with explicit limit and coverage. Tests:
`tests/research.test.ts`, `tests/research-pipeline.test.ts`.

## Phase 2 · Overview, Explore, title detail, real states

- Overview per the review hierarchy with one-snapshot substitutes: Prominent
  titles, Story mix, Newly discovered listings, Your comparable titles;
  "Collecting history" wherever a change would go. Coverage strip, not KPIs.
- Explore: Titles (search zh/en, sort, paginate, platform-specific columns),
  Tropes (share with denominators, pairs), Platforms (format drill-down),
  Companies (relationships with roles).
- Title detail: Overview · Trends · Story & format · Creative examples ·
  Comparables · Sources.
- Navigation: 市场概览 / 市场探索 / 我的剧库 / 素材与测试 / 数据与来源.

Status: **done.** Overview with four cards (Prominent titles, Story mix,
Platform-new listings, Your comparable titles; the change cards appear once
history exists), prominent posters, templated observations citing listings,
story mix with table alternative, your titles to test, platform-new
listings, watchlist, coverage strip. Explore: Titles (search, filters, sort,
pagination, platform-specific counters, watched filter), Tropes (shares with
denominators, lift, change column, pairs), Platforms (format drill-down with
basis and n), Companies (roles). Title detail with six tabs and a Sources
tab listing field/unit/read time per number. Verified in fixture mode on
port 3200, desktop and 375px, zh and en, no hydration errors.

## Phase 3 · Scheduled collection and history

Dependency: the founders' decision on the terms-of-service posture for a
daily crawl (docs/research-feasibility.md). The pipeline is ready: a second
run on a later date turns on rank movement, counter velocity and trope-share
change automatically; irregular intervals report actual elapsed days.
Status: pipeline done; scheduling **not enabled** (founder decision).

## Phase 4 · Watchlists, shortlist, report imports

Status: **done** in fixture mode and coded for Supabase (migration 0005,
not applied: no Supabase project exists yet). Watchlist (title page button,
overview panel with rank movement once history exists, explorer filter);
explained shortlist v1.0 on My titles with reasons, points and missing
inputs; CSV import at `/producer/reports` with preview, row errors,
duplicate detection (in-file and against existing rows), title linking,
reversible batches, and the imported numbers shown per title as
partner-reported. Tests: `tests/research-phase4.test.ts`.

## Phase 5–6 · External sources, Grow readback

Status: **not started**. Each listed in Data & Sources with its real state
(`requires_connection` / `manual`), with the review's source corrections.

## Phase 7 · US launch workspace (2026-09-08)

Status: **done in fixture mode.** Five-area navigation; US potential score
with explained components on the assessment page, catalog and overview;
structured experiments with budget approval, demo-labelled results and a
next-spend decision that opens a new round; company & accounts with owned
account inventory, permissions and billing state; demo catalog seeding 14
titles, 4 experiments, reports, watchlist and accounts. Supabase paths
coded (migration 0006), not exercised. Verified in the browser on port
3200 (zh and en, desktop and 375px, no hydration errors). 141 tests.

Not done: provider connections (TikTok/Meta), real results (Grow readback),
scheduled market collection (founder decision), history-based market
signal (turns on with a second crawl).

## Phase 8 · What to make next (2026-09-08, later)

Status: **done.** US market insights has two views (US overview, What to
make next) plus Explore and Data & sources as tabs; the board ranks story
types by their share of new listings with lift, growth, partner trope,
own-catalog count and examples; make-now briefs for the top three; per
platform "new on" tables (reasons, release / first seen, views, growth per
day, chart, story types) and fastest-growing lists; a miniature on the
Overview. Engine `lib/research/next.ts`, registry metrics `fresh_share` and
`fresh_growth`, 7 tests. Verified in the browser on port 3200 against two
real collection days.

Also this session: Codex's redesign and workflow-clarity passes were
reviewed in the browser; row grids with an `auto` action column (campaign
queue, launch shortlist, assessment facts) were misaligning across rows and
now use fixed columns; flush tables inside panels are inset to the panel
padding; the results and accounts tables got proportional columns.

Daily collection scheduled the same evening (`.github/workflows/research-crawl.yml`,
04:30 UTC, commits the run to `main`). Not done: the ReelShort New shelf pagination change (27 rows per page,
page 2 repeats page 1) is recorded, not worked around.
