# Claude Code prompt: simplify Pulsar around the producer

Please refocus Pulsar Studio on UX, UI, data presentation and a company profile that anchors personalization. We already have enough data to make this iteration useful. The current homepage is too crowded, the interaction model is inconsistent, and the producer has to interpret too much methodology before getting value.

Read `docs/producer-ux-strategy-review.md` first, then the current `CLAUDE.md` and latest decisions. The review contains reproduced problems, research references, page design and acceptance criteria. This newer brief supersedes the earlier four-summary-card homepage and broad feature-expansion plan. Preserve data integrity and architecture, but redesign the presentation decisively.

## The product goal

The core customer is a Chinese mini-drama producer with a catalog considering US distribution. Help them discover relevant overseas dramas, understand their story patterns, connect those examples to their own titles, and decide what to investigate or test next.

The product's value is assembling and interpreting scattered information in Chinese, with saved context and clear comparisons. Do not make this pass about more scrapers, more metrics, new scores, or inaccessible integrations. Small data-interface changes needed to expose existing information or persist profile settings are in scope.

## Start with the actual interface

Inspect the running producer app and read the relevant current files before editing. Review Overview, Explore/Titles, Tropes, market-title detail, My titles, company setup, Sources and Creative & tests. Capture before screenshots. Reproduce the review findings against the current working tree because changes may have continued.

Make a short page hierarchy and interaction plan, then implement it. Do not stop after proposing a plan. Keep work reviewable and preserve unrelated in-progress changes.

## 1. Fix navigation and filters first

- Company setup currently calls `router.refresh()` after save. After a successful save, return directly to `/producer`, ensure personalized data reflects the saved profile, and show a confirmation on the destination page. On errors stay in the form and retain edits. Prevent duplicate submissions.
- Add permanent Company profile access under My titles and via the company identity in the shell. Do not hide it after onboarding completion.
- Make simple platform, audience and trope filters apply immediately with clear pending feedback. Text search can submit or debounce, but selected values, applied filters, URL and results must never disagree silently.
- Preserve meaningful filters across overview → trope/title results → detail → back. Current Tropes links and Explore tabs drop scope. Reset pagination when filters change; retain it when returning to the same results. Browser refresh/back/forward must work.
- Clicking a trope should open its matching dramas or a useful detail view, not unexpectedly send the user back to the overview.
- Search promises titles, tropes and companies. Use existing title/blurb, company names, taxonomy IDs and Chinese/English taxonomy labels so it honors that promise. Search existing aliases if present; do not fabricate aliases or build a new crawler. Add matching feedback and useful no-result recovery.
- Prevent sorting incompatible raw counters as a single cross-platform ranking. Offer a platform choice or separate platform sections; do not rely on a warning next to misleading results.
- Restore usable primary navigation below the current 1180px sidebar breakpoint. Include a menu with focus management, Escape, current section and all primary destinations.
- Use “Save title / Saved” or “Add to watchlist,” not the ambiguous “Watch.” Provide a clear saved view and feedback.

## 2. Replace the homepage with a focused market brief

Remove the current four-card summary strip. It repeats content and prioritizes abstract scores and collection states.

Use at most three main sections:

1. **Dramas to examine:** the dominant section, up to six posters/cards, selected through a visible “For your company / All tracked titles” mode. Each shows a readable title, platform, named chart position when available, one or two relevant platform-specific counters, and a short explanation of relevance. Open details is primary; Save is secondary.
2. **Story types to explore:** five or six readable horizontal bars from existing data. Highlight company interests. Use an understandable denominator and click through to the exact relevant titles. Put the full statistical table behind a secondary view.
3. **Your next step:** up to three own titles with one useful comparable, an actual readiness fact, and one next action. If there is no catalog, offer one compact Add title action. Avoid large empty panels.

Top chrome: title, one-sentence description, actual company name/Edit profile, search and compact visible filters. One subtle line describes source scope and last update. Advanced filters are expandable. Coverage belongs in a compact footer.

Do not call public English catalog counters US audience data. Do not show invented trends. When history is absent, design an attractive current-state page; do not fill prime space with Collecting history badges. Preserve platform-new versus released semantics.

Default to intelligible observations. The existing prominence score can remain secondary with an explanation; it must not dominate every poster. A chart rank must name its chart. Explorer row number is not an official rank. Never put a bare #1 or 100 in a context where users cannot tell what it means.

Do not add median-episode cards, a long insight feed, formulas, technical IDs, repeated source disclaimers or speculative market-size numbers to the homepage. Keep the underlying information available in drill-downs.

## 3. Make the company profile the personalization anchor

Under My titles add **Titles | Company profile | Reports**. Show the actual company identity in the shell. Keep competitor Companies under Explore distinct from the customer's Company profile.

Reuse the existing producer and research-profile records. Start with existing company names, tropes, audience positioning, target markets, distribution mode and annual volume. The profile should have a readable summary and explicit Edit mode. Do not collect additional fields unless the product has a visible use for them.

Map every preference to a concrete behavior:

- Tropes affect relevant examples, highlighted story bars and premise suggestions.
- Audience positioning affects visible relevance/default filters.
- Target market expresses company intent, never the measured geography of public counters.
- Distribution mode affects appropriate next actions.
- Annual volume is descriptive unless a justified feature uses it; do not invent score contributions.

Explicit user filters override defaults. Clearly show when company relevance is active and offer All tracked titles. Do not silently hide the wider market.

Keep first setup short and optional beyond the fields necessary for useful personalization. Give the trope selection limit visible feedback, make None exclusive among distribution options, use normalized market choices and accessible input labels. Save returns to Market Overview with refreshed recommendations. Cancel discards edits. Errors preserve inputs. Viewer and staff-preview permissions stay intact.

Do not infer US rights from generic license dates or whole-title readiness from one approved version. Display only the specific known facts; keep territory rights on individual titles.

## 4. Rework the supporting screens

- **Explorer:** readable title cells and posters, fewer default columns, useful secondary details. Keep sorting separate from source-info actions. Use consistent chips, active-filter summary, result count and reset. Make it possible to scan 25 results without truncated names and technical field labels consuming the row.
- **Tropes:** a visual comparison plus supporting examples. Prioritize story relevance over an eight-column statistics table. Drill into matching titles while preserving platform/audience scope.
- **Title detail:** concise summary, useful counters, synopsis and comparables. Consolidate repetitive sections. Avoid six equally prominent tabs when multiple tabs contain placeholders or duplicate synopsis text. Preserve existing URLs by mapping legacy tab links to appropriate sections. History and sources remain available contextually.
- **My titles:** one coherent catalog. Remove duplicate analytical-list/poster-grid rendering. Separate relevance, readiness and next action; don't lead with competing Market match and Test priority scores. Collapse long reasons into a full-width disclosure instead of an open 110px column. Use existing status/external ID to distinguish same-named records; don't merge them.
- **Creative & tests:** show active work first, with premise examples in a separate secondary view. Preserve Promote/Grow responsibilities.
- **Reports:** keep existing import logic, improve labels, template/help, preview readability, linked-title status and feedback. Localize raw status words. Avoid expanding the ingestion scope.

## 5. Preserve data trust through progressive detail

Keep evidence and provenance, but stop exposing the implementation on every screen.

- Main UI: friendly label, value, unit/platform context, compact evidence indicator.
- Accessible info popover/drawer: explanation, exact value, date, source, relevant limitation and source link.
- Data & Sources: full definitions, methodology and advanced fields.

Metric information should open without losing the current results/filters. Keep a full source-page link for deeper inspection. Replace technical listing IDs with titles in insight references. Remove raw fields such as `read_count`, `public_web`, Jaccard, formula contributions, and internal “founders need to decide” notes from ordinary customer flows. Retain necessary information in advanced details.

Source pages should default to available sources and a concise coverage summary; keep planned/unconnected sources in a separate collapsed area. Localize source explanations and statuses into Chinese as well as English. Missing data stays unknown, and stale warnings remain visible where material.

## Design references

Use these as patterns, not copied branding or a new framework:

- https://flixpatrol.com/top10/ — concrete title charts with explicit platform/date context.
- https://plausible.io/plausible.io and https://plausible.io/docs/filters-segments — restrained hierarchy and consistent scope/filter interactions.
- https://appfigures.com/products/app-intelligence — research organized around tracked entities and comparisons.
- https://evidence.dev/examples and https://github.com/evidence-dev/evidence — narrative/visual/drill-down examples.
- https://www.tremor.so/ — spacing, bar lists and filter affordances, implemented using our existing tokens.

Use Chinese-first product language. Preserve original titles where no verified translated title exists. Prefer readable typography, calm surfaces, a clear accent hierarchy, aligned counters and genuinely useful charts. Avoid decorative dashboards, more badges and score gauges. Keep long titles accessible and provide a graceful fallback when external covers fail.

## Scope and acceptance

Keep Next.js, existing CSS tokens/localization, `getData()`, fixture/Supabase equivalence, tenant isolation and approval invariants. Adapt remains frozen; Grow owns execution. No new paid APIs, crawlers, analytics models or production deployment are required by this UX pass.

Implement and verify these journeys in the browser:

1. Complete/edit company profile → Save → Market Overview immediately → confirmation and updated visible relevance → reload preserves the profile.
2. Choose DramaBox → see only matching results without a hidden extra submit → choose a trope → open a title → back restores platform, trope, sort, page and result context.
3. Search a Chinese trope and an existing company such as Webfic → results reflect the existing taxonomy/company data. No-match state has useful recovery.
4. Save a title → see Saved feedback → find it in the saved view.
5. Open metric explanation → inspect source → close and continue with filters/scroll retained.
6. Open My titles → understand one title's relevance, known readiness and next action without expanding anything; inspect deeper reasons only on demand.
7. Reach every primary destination at 1024px, 768px and 390px. Verify desktop at 1280px and 1440px, bilingual text, keyboard focus, image failures and empty/loading/error states.

Write meaningful regression tests for changed filter/profile/navigation behavior, not tests that merely assert static copy. Run `npm test`, `npm run typecheck`, and `npm run build` per repo requirements. Capture after screenshots for the key pages and compare them to the before screenshots. Do not claim usability is verified from tests alone.

Finish with changes by user journey, validation performed, screenshots, and remaining concrete limitations. Update product decisions so the old four-card/overloaded layout is not reinstated later. The desired result is a calmer, more useful product using the data already available.
