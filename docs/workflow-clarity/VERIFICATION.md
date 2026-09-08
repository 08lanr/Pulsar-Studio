# Workflow clarity revision — 8 September 2026

## Implemented direction

Prepare → Choose ads → Approve ads → Approve budget → Launch → Review results.

These six user-facing steps share one resolver across the overview, campaign queue, campaign detail and title evidence. Technical data states remain unchanged. Labels are bilingual; numbered text remains understandable without color. Blue identifies preparation/launch, amber identifies approval, and green identifies results. Demo is a data-source label, not a competing workflow stage. Existing saved campaign names and historical records are preserved.

Overview now contains one actionable campaign queue, followed by titles without campaigns and a compact company setup list. Campaign rows show a current step and next action instead of six miniature repeated trackers. Detail pages bring the current work forward, retain completed brief/ads in expandable records, and use compact two-column ad comparisons with bounded video previews and expandable copy. The shared page rail fixes mismatched alignment at wide effective viewports. A separate 1024–1180px navigation gap found during testing is also fixed.

## Revision checklist and evidence

| Scope | Verified in this revision |
|---|---|
| Overview | Wide 1920 screenshot; effective 2560 DOM alignment; 390 screenshot; no document overflow. One queue and consistent setup actions. |
| Campaign list | 1024 screenshot and overflow check; six-step disclosure opens with Enter; Chinese labels inspected; navigation menu opens with Enter, closes with Escape and restores visible focus. |
| Campaign detail | Real fixture UI: choose two ads, approve ads, approve $100 budget, launch demo handoff, simulate results. Current stage advances through results; submitted destination visible outside archives. |
| Ads | Wide 1440 and narrow 390 screenshots visually inspected; no document overflow; bounded media, selected/not-selected text, expandable captions and immutable archived ads. |
| Results | Demo provenance and named metrics inspected; raw internal ad kinds replaced with localized names; next-test actions state their actual effect; Back to campaigns replaces misleading Stop here. |
| Title evidence | Source review: shared current-step badge/action; removed duplicate embedded campaign form; remaining active experiment labels standardized to campaigns. |
| Company / insights | Fresh axe checks; company navigation manual computed contrast review. |
| Error / pending / roles | Existing permission tests and new workflow transition test pass. Source review fixes failed-state editing, duplicate generation/failure messages, and simulation during unsupported launching state. These rare states and exhaustive role combinations were not all recreated in browser. |

Fresh axe-core reports in this directory cover overview, campaign list, results detail, company and insights: zero violations. Company reported one incomplete color-contrast rule for navigation links. Computed foreground/background review gives 10.7:1 for tab links and 7.0:1 for the profile button (rounded); both exceed 4.5:1. Automated checks do not replace manual interaction review.

`npm test`: 142 passed, 0 failed. `npm run typecheck` and `npm run lint`: passed. Final `NEXT_DIST_DIR=.next-redesign-build npm run build`: exit 0, 36 static pages generated, lint/type validation passed. Nonfatal webpack cache snapshot warnings remain. Temporary public audit assets were removed before the production build.

Viewport checks reproduce the effective wider layout created by zooming out; specific browser zoom percentages were not independently measured. Reduced-motion rules remain present but the preference was not emulated in this revision. Live provider launch, production database integration and every secondary dialog/role combination remain unverified. The broader previous-pass inventory and limitations remain in ../redesign-route-checklist.md.

## Before / after

The before images are the user's supplied screenshots; after images are the running fixture application at port 3210. Fixture records advanced during interaction testing, so data counts can differ.

| Screen | Before | After |
|---|---|---|
| Overview | [Before](overview-before.png) | [Wide](overview-wide.png), [Narrow](overview-mobile.png) |
| Ad comparison | [Before](ads-before.png) | [Wide](ads-after.png), [Narrow](ads-mobile.png) |
| Campaign list | User's fourth attachment | [Medium](campaigns-medium.png) |

## Design resources actually applied

This revision continues the installed Impeccable workflow and existing documented direction: clarify for consistent action language, critique for duplicate overview tasks, normalize for shared workflow presentation and page alignment, harden/polish for responsive navigation and ad comparison. Product audit and independent engineering review were delegated to agents.

The initial transformation's executed UI UX Pro Max exploration, official shadcn compatibility review, Vercel engineering review and browser/Playwright resource setup remain documented in ../redesign-resource-exploration.md, ../redesign-engineering-guidance.md and ../redesign-vercel-review.md. Those setup/search commands were not rerun for this revision. Browser verification here used the installed in-app browser's Playwright controls and actual axe-core; no standalone Playwright test-suite run is claimed. DESIGN.md is the canonical visual and language reference.
