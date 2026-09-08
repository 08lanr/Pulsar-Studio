# Pulsar Studio redesign: route and state checklist

Updated 2026-09-08 from source inspection, the implementation lead's actual controlled-browser workflow checks, screenshots and saved axe-core reports. **Rendered** means the named state was inspected, not that every possible state or write passed. **Source only** means browser verification remains outstanding. The linked reports carry exact URLs, timestamps, viewport dimensions and manual-review items. See [delivery evidence](redesign/VERIFICATION.md).

## Product context

- **Primary users:** Chinese mini-drama company owners, catalog/distribution managers and producer editors/approvers preparing a US launch. Secondary users are Pulsar staff overseeing adaptation and campaign production. This is inferred from current product decisions, permissions and workflows, not interviews.
- **Three primary tasks:** choose which owned title deserves a US test using explained evidence; prepare and approve campaign variations and a bounded experiment; interpret own results and decide the next investment. Market exploration, account inventory and subtitle adaptation support those tasks.
- **Character:** precise, calm, professional, evidence-led and moderately dense. Chinese and English content must both remain readable. Distinguish observations, inferences, partner reports and demo data without implying success probability.
- **Required identity:** Pulsar Studio name/brandmark, local fonts and bilingual content. Gold is reserved for the partner approval action. No supplied external visual references; final resource-based direction is recorded in DESIGN.md.
- **Architecture:** Next.js 14 App Router, React 18, strict TypeScript, hand-written CSS and zh/en locale dictionaries. Shared server data facade `getData()` supports fixture and Supabase. Producer portal defaults to Chinese, staff portal to English; locale cookie wins. Fixture demo catalog is default; empty fixtures are available with `FIXTURE_SEED=empty`.
- **Navigation:** five producer areas: Overview, My catalog, US market insights, Launch & experiments, Company & accounts. Add title is an action. Staff has its own shell and oversight routes. Do not introduce Stage, dubbing or new Adapt pipeline work.

## Route inventory

All 35 page modules found under `app/` are included below (the company page is expanded into its four tab states). Shared shell/tokens should cover every row, including legacy routes and staff screens. Detail routes require representative real fixture identifiers.

| Route | Purpose and representative states | Rendered check |
|---|---|---|
| `/` | Role-aware entry redirect; unauthenticated redirect | Browser verified root→producer; staff entry→titles. [Redirect evidence](redesign/redirect-checks.json) |
| `/login` | Fixture identity choice or Supabase authentication; pending, invalid credentials, callback error; safe return path | Staff fixture sign-out/sign-in and entry to `/titles` verified; producer fixture session used. Supabase and callback/credential failure branches unverified |
| `/producer` | Recommended titles, decisions awaiting action, demo results, setup gaps; empty catalog/profile/accounts/results; freshness | Rendered populated overview; 390/768/1440, English/Chinese, light/dark; [axe: 0 violations](redesign/axe-overview.json). All missing-data branches not individually induced |
| `/producer/titles` | Scored catalog; search, band filters, four sorts; populated, no matches, truly empty, truncated; unknown/outside/expiring rights and partial media | Rendered populated, no-match/reset and priority filter; true empty seed on 3211; responsive/theme/locale checks; [axe: 0](redesign/axe-catalog-final.json). All sorts/truncation not separately exercised |
| `/producer/titles/new` | Create title and episode upload workflow; validation, pending, failed upload, successful creation; viewer/staff permission | Title create pending→success verified; [axe: 0](redesign/axe-new-title-final.json). Subsequent Add episodes subtitle ingestion verified separately; combined new-title-with-file submission and video ingestion untested |
| `/producer/titles/[id]` | Owned title, episodes, subtitle/video upload and recorded facts; no episodes, partial materials, read-only, not found | Populated/no-episodes/invalid-id 404 rendered. Add episodes: filename retained→Create 1 episode→Uploading disabled→Imported→Episode 1 with 22 source lines verified after picker fix; [uploaded-title axe: 0](redesign/axe-uploaded-title-final.json). Video ingestion untested |
| `/producer/titles/[id]/potential` | Explained score/band, component points, comparables, missing evidence, experiment and reports; no synopsis/comparables/results; new/existing experiment | Explained score and fixture evidence rendered; [axe: 0](redesign/axe-potential-final.json). Missing-evidence combinations not all induced |
| `/producer/titles/[id]/episodes/[n]` | Continuous bilingual script; no version, generate pending/error, editable draft, autosave/error, in-review, frozen approved, fork, QC errors/warnings, finalize; viewer/staff preview | Frozen finalized editor and newly ingested 22-line Start adapting state rendered; [finalized axe: 0](redesign/axe-script-editor-final.json), [empty-editor axe: 0](redesign/axe-empty-editor-final.json). Editing/generation/fork/finalize workflow not completed in browser |
| `/producer/titles/[id]/episodes/[n]/subtitles` | Subtitle/video studio; missing video, missing timings, playback, cue edits, offset, finalized export/burn state, read-only | Finalized subtitle editor rendered; [axe: 0 after landmark/heading/contrast fix](redesign/axe-subtitle-editor-final.json). Cue edits, offset, burn and export not completed |
| `/producer/insights` | Market brief, example dramas, trope shares, owned comparables; filters/company relevance, missing snapshot, missing covers, stale source | Normal fixture brief rendered and refined; [axe: 0](redesign/axe-insights-final.json). Missing snapshot/stale combinations source only |
| `/producer/explore` | Redirect to title explorer | Browser verified→`/producer/explore/titles`; [redirect evidence](redesign/redirect-checks.json) |
| `/producer/explore/titles` | Search/filter/sort, pagination, single-platform raw-counter sorting, save/remove watchlist, metric dialog; no matches/no snapshot, permission, long English titles | Watchlist add→Saved filter→detail verified; [axe: 0](redesign/axe-explore-titles-final.json). Remove/pagination/all sorts not separately exercised |
| `/producer/explore/tropes` | Taxonomy/story shares, disclosure groups, filter links; missing data and company interests | Normal rendered; [axe: 0](redesign/axe-explore-tropes-final.json). Empty/missing data source only |
| `/producer/explore/platforms` | Platform format/counter summaries and sources; unknown values, stale/unavailable, no data | Normal rendered; [axe: 0](redesign/axe-explore-platforms-final.json). Stale/unavailable/no snapshot not induced |
| `/producer/explore/companies` | Publisher/company grouping with role evidence; missing company attribution, filters/no data | Normal rendered; [axe: 0](redesign/axe-explore-companies-final.json). Empty/filter combinations not all exercised |
| `/producer/market/[key]` | Summary/Trends/Sources tabs; preserved filter return link, watchlist, metric disclosure, missing history, null counters, cover fallback, legacy tab normalization, not found | Detail, Trends no-history and provenance modal verified; [axe: 0](redesign/axe-market-detail-final.json). Legacy tabs/not-found pending |
| `/producer/sources` | Current and planned data sources, metric details, collection history/failure disclosures | Normal rendered; [axe: 0](redesign/axe-sources-final.json). Collection failure not induced |
| `/producer/sources/[key]` | Source/metric methodology, formula, limitations, computed status; not found | Catalog-match detail rendered; [axe: 0](redesign/axe-source-detail-final.json). Every registry entry/not-found not separately checked |
| `/producer/promote` | Experiment list prioritized by required decision; stages, budget approval, variations, best signal, demo label; empty | Fixture list/stages rendered; [axe: 0](redesign/axe-experiments.json). Empty campaign list not separately induced |
| `/producer/promote/new` | Title selection and campaign brief; missing eligible video, required fields, validation, pending/error/success, read-only | New round created in complete campaign workflow; [axe: 0](redesign/axe-new-experiment-final.json). All validation/permission variants not exercised |
| `/producer/promote/[campaignId]` | Brief → concepts → creative edits/review → immutable creative approval → budget approval → mock handoff → results → new round; busy/error, unavailable AI/media, change request, permission | Created round→saved $120 budget (cleared approval)→generated 5→kept 2→approved creatives→approved budget→mock submit→demo results verified; [axe: 0](redesign/axe-campaign-detail-final.json). Real launch/AI and failure branches unverified |
| `/producer/company?tab=profile` | Company goals/profile read view and edit; missing profile, required input, save/return confirmation, read-only | Normal rendered; [axe: 0](redesign/axe-company-profile-final.json). Profile save/missing/read-only states source only |
| `/producer/company?tab=accounts` | Recorded owned-account list/form; add/edit/cancel, validation, busy/error, unconnected/invited/connected/revoked | Add/save and resulting status verified; [axe: 0](redesign/axe-accounts-final.json). Every status/edit/cancel/error permutation not exercised |
| `/producer/company?tab=access` | Role capabilities and current role; billing provider not configured | Rendered roles and unconfigured billing; [axe: 0](redesign/axe-company-access-final.json). No provider connectivity claimed |
| `/producer/company?tab=reports` | CSV report preview/import, duplicates/invalid rows, import result, reversible batch, read-only | CSV preview with 1 valid + 1 invalid row, import of valid row verified; [axe: 0](redesign/axe-company-reports-final.json). Duplicate/revert/read-only browser writes unverified |
| `/producer/reports` | Standalone reports route using same import component; company/catalog sibling navigation and complete import states | Standalone My reports/Import batches rendered; shared ReportImport workflow verified through company tab |
| `/producer/accounts` | Redirect to company accounts tab | Browser verified→`/producer/company?tab=accounts` |
| `/producer/onboarding` | Redirect to company profile editor | Browser verified→`/producer/company?edit=1` |
| `/producer/library` | Legacy redirect to catalog | Browser verified→`/producer/titles` |
| `/producer/simulation` | Existing fixture simulation controls/results and permission/unavailable states | Normal rendered; [axe: 0 after heading fix](redesign/axe-simulation-final.json). Selection/download workflow not completed |
| `/titles` | Staff title catalog, statuses/producer/cost, empty and open title | Normal rendered; [axe: 0](redesign/axe-staff-titles-final.json); staff narrow shell checked. Empty not separately induced |
| `/titles/new` | Staff title creation, company selection, required validation, pending/error/success | Form rendered; [axe: 0](redesign/axe-staff-new-title-final.json). Staff creation writes not completed |
| `/titles/[id]` | Staff title details, episode ingestion/add episodes, costs, export menu; missing/partial/approved versions | Normal rendered; [axe: 0 after correction/rerun](redesign/axe-staff-title-final.json). Upload/export writes unverified |
| `/titles/[id]/episodes/[n]` | Staff adaptation workbench, source/player/edit/alternatives, scene approve, submit/fork/on-behalf evidence; pending/error, frozen versions, permission | Workbench rendered; [axe: 0 after correction/rerun](redesign/axe-staff-editor-final.json). Editing/submit/on-behalf not completed |
| `/titles/[id]/pack` | Internal creative pack, variant choice, clips shortlist/dismiss, generation availability/pending/error/empty | Empty→Generate→busy disabled→inline Claude connection error→buttons recover verified. [Axe: 0 after correction/rerun](redesign/axe-staff-pack-final.json). Successful external generation/selection unverified |
| `/producers` | Staff producer-company inventory/create form; empty, validation, success/error | Normal rendered; [axe: 0](redesign/axe-staff-producers-final.json). Create writes not completed |
| `/promote` | Staff campaign queues, priority/next action, statuses/counts, empty | Normal rendered; [axe: 0](redesign/axe-staff-promote-final.json). Empty state not separately induced |
| `/promote/[campaignId]` | Staff Promote desk, producer change requests, creative revisions, append-only launch progress/handoff; role/pending/error states | Normal rendered; [axe: 0](redesign/axe-staff-campaign-final.json). Staff change/launch progress writes not completed |

## Shared state and interaction checklist

| Check | Coverage required | Result |
|---|---|---|
| Shell/navigation | Five producer areas, active nested routes, staff shell, locale switch, sign out, mobile modal Escape/focus return, skip navigation | Both shells rendered; mobile Shift+Tab containment and Escape/trigger focus return verified; locale navigation used. Fixture sign-out/login and four aliases verified |
| Responsive | Representative 390px, 768px and 1440px viewports; dense catalogs/workbenches, long bilingual titles, tables and toolbars; no page-level accidental horizontal overflow | Overview/catalog at 390/768/1440 and staff mobile checked with no document overflow. Every editor/dialog at every size not verified |
| Keyboard/accessibility | Logical heading hierarchy, visible focus, label/name on controls, modal focus containment, reachable disclosure/button/link states, contrast, automation plus manual inspection | Actual axe-core 4.13 reports for all normal producer families and 8 staff families; latest producer and staff reports all zero violations. Incomplete rules retain manual-review status |
| Loading | Existing producer `loading.tsx`, field/button pending states, no duplicate submissions | Title creation, episode ingestion Uploading/disabled and campaign pending transitions observed. Route skeleton timing and duplicate-submission stress source only |
| Empty | Bare fixture seed, catalog filter no matches, no market/history/reports/media/results, clear recovery action | True empty catalog, no-match/reset, new title with no episodes, no-history trend and empty staff pack verified. Other branches not all induced |
| Error | Existing producer `error.tsx` retry/home, inline API errors, missing/foreign resource not found, failed upload/import | Invalid CSV feedback, staff generation connection error/recovery and `/producer/titles/does-not-exist` in-shell 404 verified. Error-boundary retry and upload failure not forced |
| Success | Profile/account/title/report saves, watchlist feedback, adaptation save/finalize, creative/budget approval, new experiment round | Account/title/report/watchlist and complete demo campaign workflow verified. Profile save and adaptation write/finalize browser workflows not completed |
| Validation/disabled | Invalid required fields, import row errors, QC blockers, locked/frozen records, busy states; visible reason for blocked important actions | CSV valid/invalid split, budget save clearing approval, finalized editor states verified. QC blockers and every disabled state source/tests only |
| Permissions | Approver/reviewer/viewer/staff preview, producer isolation, server checks preserved, no costs exposed to producer | Existing API/permission tests passed; producer and staff browser sessions used. Exhaustive role matrix and Supabase RLS not live verified |
| Motion/theme | Reduced-motion preference; light/dark token contrast if both remain available | English/Chinese and light/dark inspected. Reduced-motion CSS inspected only; preference not emulated in browser |
| Data integrity | Null is not zero, public counters not cross-platform comparisons, demo results labeled, score not probability, timestamp/evidence remains discoverable | Provenance modal, no-history display, explained score and labeled mock/demo results checked; existing data tests passed. External provider data not validated |

## Source-observed usability priorities

Historical baseline observations below motivated the implemented changes. They describe the pre-redesign source, not remaining failures; current status is in the inventory and verification report.

1. The catalog is a nine-column grid containing title, miniature component bars, several readiness facts and next action. Condense/organize readiness facts and ensure the score/title/next decision remain readable at medium widths.
2. Experiment rows combine hold rate and CTR as `x% · y%` under one general signal label. Name both measures so results can support a decision without memory or guessing.
3. Catalog zero search results and a truly empty catalog share the same empty message, with no reset action in that state. Differentiate recovery: reset the filters or add the first title.
4. Overview setup gaps are text-only list items with a single general company link. Route each actionable gap to its account/profile/report task.
5. Most producer route headings start at `h2`; several page shells have no `h1`. Normalize accessible page hierarchy along with visual typography.
6. Reports exists both as a standalone catalog-oriented page and as a company tab. Preserve compatibility while making the primary path and return navigation consistent.
7. Multiple UI generations coexist (`brief-*`, `rs-*`, `ws-*`, `studio-*`, staff grids). Shared tokens and primitives should unify all, with content-specific layouts retained.
8. Existing positive affordances should survive: native mobile dialog with Escape/focus return, company-scoped watchlist/import, explicit metric dialogs, current/planned source separation, role-disabled fieldsets, status/alert feedback in reports and experiment forms.

## Required completion checks

- `npm test`: passed, all 141 tests rerun after final file-picker fix.
- `npm run typecheck`: passed after final file-picker fix.
- `npm run lint`: passed after final file-picker fix.
- `npm run build`: final post-fix production build passed (exit 0), all 36 static pages generated; nonfatal webpack cache snapshot warning only.
- Running app: fixture demo at port 3210; separate `FIXTURE_SEED=empty` fixture app at 3211 used for true empty catalog. No database/API key required for verified workflow.
- Before/after screenshots: [gallery and freshness notes](redesign/VERIFICATION.md#screenshots).
- Workflow/browser evidence: table above, [verified campaign path](redesign/verified-campaign.txt), and saved axe JSON reports. No standalone Playwright suite execution is claimed.

Real provider launch execution, provisioned Supabase and external credentials are not assumed available. Report these separately from fixture verification. A fixture UI check never establishes external integration connectivity.
