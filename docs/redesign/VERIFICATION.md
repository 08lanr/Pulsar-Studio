# Redesign delivery evidence

Updated 2026-09-08. This record distinguishes actual browser interaction from source inspection and automated unit checks. The implementation lead used the controlled in-app Browser against fixture apps on ports 3210 (demo catalog) and 3211 (empty seed). The complete [route/state checklist](../redesign-route-checklist.md) covers all 35 page modules and company tabs.

## Implemented experience

The shared producer and staff shells now use a consistent slate/blue system, readable bilingual typography, semantic navigation, keyboard focus and accessible mobile dialogs. Overview prioritizes decisions and next actions. Catalog replaces nine cramped columns and score rings with five readable fields, plain numeric scores, grouped materials and full evidence disclosures; no-match and empty-catalog recovery differ. Market navigation exposes Saved titles, company/report navigation is consistent, experiments name their signals, and editor/source/secondary headings and media contrast were corrected from actual accessibility findings. [DESIGN.md](../../DESIGN.md) remains the visual reference.

## Completed browser workflows

- Catalog: searched to no matches, reset filters, selected priority filter; separately inspected genuinely empty catalog using `FIXTURE_SEED=empty`.
- Campaign: created a round, saved a $120 budget and observed approval clearing, generated five concepts, kept two, approved creatives, approved budget, submitted mock handoff and simulated explicitly labeled demo results. [Campaign path](verified-campaign.txt).
- Research: added a watchlist entry, opened Saved titles, followed detail, inspected Trends with unavailable history and opened the provenance information dialog.
- Accounts: added and saved an account and checked visible resulting status.
- Reports: previewed a CSV containing one valid and one invalid row, then imported the valid row.
- Titles: created a title through pending and success states, then separately used Add episodes to ingest the demo SRT. The retained filename→Create 1 episode→Uploading (disabled)→Imported→Episode 1 with 22 source lines and Start adapting sequence was verified for title `641df82c-020f-4001-bf54-2f9b18154a5a`. This verifies title creation and subsequent subtitle ingestion separately; simultaneous new-title creation with an attached file and video ingestion were not tested. [Uploaded title axe: 0](axe-uploaded-title-final.json), [empty adaptation editor axe: 0](axe-empty-editor-final.json).
- Editors: inspected frozen finalized script and subtitle workspaces. Their editing, timing, generation, finalize, burn and export workflows were not completed.
- Staff: rendered all eight page families. Empty creative pack→Generate→busy disabled→inline `Claude API ?: Connection error.`→buttons recover verified. Successful external generation, staff editing and approval writes remain unverified.
- Navigation/auth: staff fixture sign-out/sign-in and entry to `/titles`, producer root redirect, four legacy aliases, standalone Reports and in-shell missing-title 404 verified. [Redirect evidence](redirect-checks.json).

## Responsive, keyboard and accessibility

Overview/catalog were inspected at 390px, 768px and 1440px, plus staff mobile, with no document overflow in those checks. English/Chinese and light/dark were inspected. Producer and staff mobile dialogs contained Shift+Tab focus and returned focus to their triggers after Escape. This is representative coverage, not every route at every viewport.

Actual axe-core 4.13.0 checks ran inside the rendered, signed-in app using the generated same-origin audit harness. Saved JSON reports include URLs, timestamps, viewport sizes, violations and incomplete rules. All inspected producer families and all eight staff families have zero reported violations in their latest reports after correction/reruns; overview and experiment-list reports have no `-final` suffix. Do not equate zero violations with full accessibility conformance: incomplete contrast/video-caption/ARIA checks require manual judgment, and every interaction was not keyboard-audited.

Representative reports: [catalog](axe-catalog-final.json), [campaign](axe-campaign-detail-final.json), [script editor](axe-script-editor-final.json), [subtitle editor](axe-subtitle-editor-final.json), [staff title](axe-staff-title-final.json), [staff editor](axe-staff-editor-final.json), [staff pack](axe-staff-pack-final.json).

## Checks

| Executed check | Result |
|---|---|
| `npm test` | Passed: all 141 tests rerun after the file-picker fix; existing API/permission/state contracts included |
| `npm run typecheck` | Passed after final file-picker fix |
| `npm run lint` | Passed after final file-picker fix |
| `npm run build` | Final post-fix build passed, exit 0; generated all 36 static pages. Nonfatal webpack cache snapshot warning only |
| Impeccable targeted detector | Exit 0, empty findings array; static scan, not browser proof |
| Audit harness generator | Syntax checks passed; local-path guard checked; production generation rejected |
| Browser checks | Actual workflows and representative viewports above; no standalone Playwright test suite claimed |

## Screenshots

| Surface | Before | After / inspected states |
|---|---|---|
| Overview | [Baseline](screenshots/before-overview.png) | [Dark desktop](screenshots/after-overview-dark.png), [mobile](screenshots/after-overview-mobile.png) |
| Catalog | [Baseline](screenshots/before-catalog.png) | [Dark desktop](screenshots/after-catalog-dark.png), [tablet](screenshots/after-catalog-tablet.png), [Chinese mobile](screenshots/after-catalog-mobile-zh.png), [true empty](screenshots/empty-catalog.png) |
| Market insights | — | [After](screenshots/after-insights.png) |
| Accounts | — | [After](screenshots/after-accounts.png) |
| Subtitle editor | — | [After](screenshots/after-subtitle-editor.png) |
| Staff catalog | — | [After](screenshots/after-staff-catalog.png) |

Captures represent the state at capture time. The Chinese-mobile catalog image was recaptured after the final accent CSS, replacing the earlier capture flagged by the exploration reviewer. Before/after pairs above differ in theme or viewport, as labels indicate; they are representative rather than pixel-matched comparisons.

## Required resource use

| Resource | Actual use and impact |
|---|---|
| UI UX Pro Max | Fetched, installed for Codex, searched two design directions plus UX/Next.js resources. Selected evidence-led dense comparison over entertainment browsing; documented palette, density and local-font judgment. [Exploration evidence](../redesign-resource-exploration.md) |
| Impeccable | Installed and context executed; Operate/craft-floor and relevant shape/critique/extract/harden/polish references informed hierarchy, shared tokens, typography, responsive states and visual refinement. Targeted detector ran clean. Automatic hook trust and a standalone critique command are not claimed. [Execution details](../redesign-resource-exploration.md) |
| shadcn/ui | Official skill installed/read, project `info` and component documentation/discovery executed. React fits, but required Tailwind setup conflicts with the repository CSS-framework constraint; existing/native components retained. Discovery produced results before a Windows assertion; that command was not a clean success. [Engineering evidence](../redesign-engineering-guidance.md) |
| Vercel Agent Skills | Installed web-design-guidelines, React performance and composition guidance; reviewed current code and fixed navigation, focus containment, headings, labels and account feedback while preserving React 18/data fetching contracts. [Review](../redesign-vercel-review.md) |
| Playwright | Repository/documentation inspected; Playwright and axe dependencies installed in isolated temporary tooling. Actual verification used the available controlled in-app Browser and real axe library, not a separately launched Playwright browser or claimed Playwright suite. [Tooling evidence](../redesign-engineering-guidance.md) |

## Remaining limitations

- Supabase authentication/RLS and live provider launch execution were not verified. Staff creative-pack generation reached an inline Claude connection error; successful external AI generation is unverified. Fixture permissions/API tests are evidence for local contracts, not live service connectivity.
- Video ingestion, combined new-title creation with an attached file, script editing/finalize, subtitle timing/burn/export, profile saves, report reversal and every staff write path were not completed in-browser. The separate Add episodes subtitle-ingestion workflow passed after fixing the live FileList/reset race by capturing the selected files before the deferred state update; file inputs remain keyboard reachable with visible focus treatment.
- Loading, API failure, permission and missing-data variants were not exhaustively induced. Existing tests and source inspection cover additional contracts but cannot substitute for browser evidence.
- Reduced-motion CSS was inspected; browser preference emulation was not performed. Every route/dialog at all sizes and every axe incomplete item was not fully audited.
- Temporary audit public assets were removed successfully using `node scripts/create-ui-audit.mjs --clean`; the reproducible generator remains in scripts.
