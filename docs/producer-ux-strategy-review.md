# Pulsar Studio: producer UX review and product reset

Reviewed September 8, 2026 UTC, after the market-desk implementation. This document reflects the user's newer direction: prioritize existing data, clear presentation, reliable interactions, a focused homepage, and a persistent company profile. It supersedes the earlier recommendation to put four summary cards and many parallel sections on the homepage.

## Recommendation

Make Pulsar a Chinese-language research desk that helps a studio choose a shortlist and explain the choice to colleagues. The product should connect **the company → relevant market titles → story patterns → its own catalog → a launch/test decision**.

There is enough existing data to build a substantially better discovery product now. That does not mean the current observations establish US audience demand, title profitability, or willingness to pay. Keep those limits clear, without making customers read the collection architecture.

The immediate bottleneck is product design. The interface currently asks the producer to understand prominence, cohorts, lift, evidence labels and collection states before understanding what to do. Replace that with recognizable titles, clear comparisons and useful next actions.

## Review coverage and evidence

- Read current producer overview, explorer pages, market-title detail, catalog, Promote, sources, onboarding, report import, shared UI, styles, filters and shortlist logic.
- Inspected the running local app at port 3200: Overview, title explorer, trope explorer, market-title detail, My titles and Data & Sources. Inspected English and Chinese source rendering.
- Reproduced filter application and lost platform scope; verified the failed company search. Inspected navigation visibility at 390px and 1024px and desktop screenshots.
- Onboarding redirect finding comes from the submit implementation; no company-profile data was submitted or altered during review. Report import and Promote findings are code-reviewed rather than end-to-end mutations.
- Researched primary industry reports and public dashboard examples; inspected Plausible's live dashboard visually. Other references were reviewed through their public pages/docs.
- This is a comprehensive producer-facing UX review, not a full security, database, or workflow audit. No application code changed, and no full test/build run was performed for this document-only deliverable.

## What a producer wants to know

Start with Chinese producers who already own a catalog and are evaluating overseas distribution. A platform operator optimizing acquisition is a related but different user; do not let acquisition dashboards dominate the catalog owner's first screen.

| Producer question | Best information | Product response |
|---|---|---|
| Which of our dramas should we examine first? | Similar foreign-market titles, shared story mechanics, existing readiness facts | Explainable shortlist with comparable posters and one next action |
| What is visible on the platforms we care about? | Named chart positions, current titles, platform-specific counters | Platform-scoped chart with a clear date and chart name |
| Do our strongest story types appear among prominent titles? | Story mix, examples, denominator, profile overlap | Ranked story bars with highlighted company interests |
| Why is this title a useful comparable? | Premise, tropes, format, platform, counters and attribution | Side-by-side comparison using readable labels |
| How do we position the English release? | Existing premise examples, localized title choices and reviewed cultural notes | Story/positioning detail linked to the original examples |
| What prevents us from acting? | Territory-specific rights status, delivery readiness, distribution preference | Separate action checklist; unknown facts are editable gaps |
| What changed since our last visit? | Historical chart/counter observations | Watchlist changes once history actually exists |
| What can I take into a planning meeting? | A short, sourced explanation of the shortlisted titles | Saved research brief; an eventual bilingual export |

Industry context supports attention to distribution and acquisition as well as content. Sensor Tower's June 2026 short-drama report discusses localization, paid acquisition, web/search/video discovery and retention. That is app-level market evidence, not validation of an individual drama recommendation. [Report](https://sensortower.com/blog/state-of-short-drama-apps-2026-report).

Ampere's October 2025 research describes social platforms as both distribution destinations and discovery funnels. Its global mini-drama definition includes episodes up to ten minutes; do not treat its audience findings as a US-only survey of paid vertical-drama apps. [Primary release](https://www.ampereanalysis.com/press/release/dl/mini-dramas-attract-mega-audiences).

## Why customers might pay

This is a product hypothesis to validate with customers, not an established pricing result. Access to a foreign page alone is a weak lasting advantage. Do not assume every Chinese customer lacks access to the same services; interview them about actual access, language, staffing and workflow constraints.

The stronger value proposition is **a decision-ready view of an overseas market that would take a researcher substantial work to assemble and keep current**:

1. Bilingual discovery: a Chinese trope query finds relevant English titles through the existing shared taxonomy.
2. Connection: one place connects title, platform, story mechanics, available creative references, company attribution and the producer's catalog.
3. Continuity: saved comparisons, watchlists and eventually historical changes avoid repeating manual research.
4. Interpretation: explain why examples matter to this studio, while distinguishing facts from hypotheses.
5. Decision output: a compact research brief that colleagues can review and act on.

The software must demonstrate this value before asking users to import reports or fill long questionnaires. A useful first session should work with existing market data and two or three company preferences.

### Additional data worth considering later

| Priority | Addition | Why it is harder to assemble manually | Boundary |
|---|---|---|---|
| 1 | Longitudinal observations of the existing catalog | A single visit cannot reconstruct last month's changes | Start with reliable permitted collection; not a blocker for current-state UX |
| 2 | Reviewed Chinese/English title, localization and remake relationships | Different names obscure genuine comparable works | Evidence and review required; never merge by title similarity alone |
| 3 | Title-linked creative references with opening-conflict/reveal/CTA annotations | Research spans many ads and titles | Observed ad activity is not measured spend or a winning test |
| 4 | Verified distributor/publisher/production relationships and stated acquisition preferences | Relationship research is scattered | Separate company roles; verify contacts/preferences before showing them |
| 5 | Actual US response to the producer's own concepts or launches | This requires a test or authorized report rather than catalog browsing | Add through Grow or authorized imports; no fabricated competitor conversions |

I would defer another general-purpose 0–100 score, a large new connector suite, and more app-level revenue estimates until the core research journey works. None of these additions belongs in the immediate implementation scope unless necessary to repair a current interaction.

## Prioritized UX findings

### P1: fix interactions that violate the user's expectations

| Finding | Evidence | Required behavior |
|---|---|---|
| Saving company information does not return to the overview | `components/producer/research/OnboardingForm.tsx:59–60` sets saved state and calls `router.refresh()` only | After successful persistence, navigate to `/producer`, refresh personalized content, and show confirmation there. Errors retain the form. |
| Company profile becomes difficult to find after completion | Overview shows its onboarding link only under `!profile`; sidebar has no profile entry | Permanent Company profile tab and a clickable company identity in the shell |
| Filters use two conflicting interaction models | Browser: choosing DramaBox in explorer leaves 507 results until Search; homepage chips apply immediately | Simple filters apply immediately with pending feedback; text search uses a clear submit or debounce. URL, selected controls and results stay synchronized. |
| Drill-down drops selected platform | Browser: `/producer?platform=dramabox` → `Tropes ›` → `/producer/explore/tropes` | Preserve meaningful platform/audience/query context through drill-down and back navigation |
| Search does not do what it advertises | Browser: Webfic returns zero, though Webfic labels are visible; `engine.ts:105` only checks title/blurb | Match existing company names and both taxonomy languages, or accurately limit the promise. Do not require a new data source. |
| Tablet/mobile loses primary navigation | CSS hides sidebar at <=1180px; DOM at 1024px has no visible primary navigation or replacement menu | Accessible menu or compact nav at every breakpoint, including keyboard focus and Escape handling |
| Cross-platform counter sorting remains possible | Explorer `sortRows()` sorts raw views/saves across all platforms; disclaimer appears afterward | Require a platform for incompatible counter sorts or group results by platform. Warn by preventing ambiguity, not adding more prose. |

### P2: remove the effort of interpreting the interface

| Finding | Evidence | Design response |
|---|---|---|
| Homepage spends most of its first viewport on explanation and equal-weight cards | Desktop screenshot: actual title content begins near the fold; four cards repeat later sections | Remove the four-card strip. Give one title section visual priority and keep the intro to one sentence. |
| Scores hide the interesting observations | Poster cards emphasize 99/100 alongside #1/#74/#117 without the chart name | Lead with a named platform chart rank and available views/saves; keep derived prominence secondary and explicitly labeled |
| Multiple rank concepts look interchangeable | Explorer row number, source chart rank, and prominence are displayed together | Row position is not a platform ranking. Omit it unless needed; always pair actual rank with chart name. |
| Technical identifiers appear as evidence links | Overview insight references show `dramabox-410...` | Render title names/poster thumbnails and a separate source action |
| Technical copy overwhelms insights | “Templated from the snapshot”, Jaccard, cohort, formula, source fields and repeated caveats appear in ordinary screens | Put method details behind a contextual information control. Keep units and scope visible. |
| Trope click takes users back into the overview | Trope explorer and title hero route chips to `/producer?trope=...` | Open filtered title results or a trope detail view; keep the overview as a stable starting point |
| Catalog rows are difficult to scan | `titles/page.tsx:122` forces Why open inside a 110px score column; desktop screenshot shows tall rows with centered content and narrow wrapping | A readable row/card with one main explanation and one next action; detailed reasons collapsed in a full-width section |
| The same titles appear in an analytical list and a second poster grid | My titles renders shortlist then full duplicate catalog | One coherent collection with optional tabs/views; distinguish same-named records using existing status/external ID, without merging them |
| Two scoring systems are presented as competing answers | Overview uses market match; catalog leads with test priority | Separate “market relevance” from “delivery readiness.” Do not fix the confusion by inventing another combined score. |
| Small title images and clipping defeat browsing | Explorer has nine columns; titles/tropes are truncated; example links clip | Fewer default columns, wider title cells, progressive details, reliable missing-image fallbacks |
| Six title tabs promise more depth than the data supports | Trends is unavailable; Creative examples largely repeats synopsis openings; format/similarity duplicate overview | Start with Summary and Comparables; use contextual sections/details for format, history and sources. Preserve old tab URLs. |
| Methodology clicks interrupt research | `MetricLabel` always navigates to a full source page | Accessible popover/drawer with value, units, date and source; retain deep methodology link |
| Source page resembles internal project planning | Actual page shows `public_web`, run IDs and “once the founders settle…”; these remain English in Chinese UI | Human-readable source cards, localized labels, Last updated and View source. Put advanced registry details behind disclosure and future sources under a separate collapsed area. |
| Creative & tests puts reference prose ahead of active work | Promote renders six premise examples before campaign list | Show own tests/campaigns first, with premise library as a separate view |
| Watch control is ambiguous | Title page says Watch beside Open on DramaBox | Use Save title / Saved or Add to watchlist, with confirmation and a clear saved collection |
| Profile form permits confusing states | Silent 12-trope cap; `none` can coexist with distribution options; free-text countries; inputs remain editable while saving | Selection count/limit feedback, exclusive None, normalized market controls, consistent pending state and inline errors |
| Report UI exposes storage vocabulary | Raw metrics/status words, unlinked/duplicate/ok, and schema-first instructions in import component | Localized template/help, clear preview and linked-title state; no new ingestion engine required |

Additional accuracy issue that directly affects UX: `shortlist.ts` infers a “US rights window” from generic license dates and treats any approved version as readiness evidence. Those facts do not establish US territory rights or whole-title readiness. Show the narrow known facts, and label missing territory/completeness information. Do not award apparent certainty through a nicer badge.

## Homepage: choose one focus

Default concept: **“Your market brief” / 你的市场简报**, with **Dramas relevant to your company** as the main section. It is a current-state brief while history is unavailable; do not label it a weekly change report.

Use at most three primary content sections:

1. **Dramas to examine:** up to six titles. Select either company-relevant examples or platform chart leaders using an explicit visible mode. Each has poster, readable title, platform, named chart position if available, one or two platform-specific counters, and one short relevance explanation. One primary action opens detail; Save is secondary.
2. **Story types to explore:** five or six horizontal bars using existing data. Show “18 of 50 titles” with an understandable cohort label. Highlight company interests. Clicking opens those titles. A secondary toggle can show the full tracked catalog; do not show both denominator systems as eight columns.
3. **Your next step:** up to three own titles with a matching comparable, readiness fact and action. Before catalog upload, offer one quiet Add title action. Saved titles can be a small section here or a separate saved view; no oversized empty watchlist panel.

Suggested desktop wireframe:

```text
Market Overview                 [Company name · Edit profile]
Relevant overseas dramas for your studio.         [Search]
[For your company | All tracked titles] [Platform] [More filters]
English public catalog data · Updated [date] · Source details

Dramas to examine                                      See all →
[poster + name] [poster + name] [poster + name]
[platform/chart] [views/saves] [why relevant + Save]
                         (up to six total)

Story types to explore                Your next step
5–6 ranked bars                       Up to 3 own titles
Count and clear denominator           Comparable + readiness + action

Coverage / methodology (compact footer)
```

No four-card KPI strip, generic market-size number, long insight feed, repeated setup panels or empty trend widgets. Coverage counts and episode medians remain available in the right place. Do not remove views/saves merely because comparison needs care: display them within a clear platform context.

“For your company” is a visible relevance mode, not a hidden global filter. Explicit user filters override profile defaults. Company target market expresses intent; it must never relabel unknown-geography public counters as US-only data. Always offer All tracked titles to escape a recommendation bubble.

## Company profile as the anchor

Keep existing My titles navigation, add sub-tabs **Titles | Company profile | Reports**. Show the actual company name in the shell with an Edit profile link. This distinguishes the customer's company profile from competitor Companies under Explore.

Reuse the existing producer record and research profile; do not create an unrelated second profile store.

| Profile section | Fields | Concrete effect |
|---|---|---|
| Company | Existing Chinese/English names; optional short description | Workspace identity and brief attribution |
| Content focus | Existing tropes and audience positioning | Relevant example ordering, highlighted bars, premise filtering |
| Overseas plan | Existing target markets and distribution mode | Visible research defaults and relevant next actions; does not manufacture regional evidence |
| Production context | Existing annual volume, catalog-derived title count | Company context; no invented scoring effect if unused |
| Optional constraints, later | Budget band, format, language, timing | Only collect when the product actually uses them; clearly mark unsupported inputs |

First setup should need only story focus, audience positioning and distribution intent, with reasonable US intent default if appropriate. Everything else is optional. Completing setup returns directly to Market Overview with “Company profile saved. Your recommendations have been updated.” A small line states the preferences used, with Edit and View all actions.

The profile page has a readable summary and Edit mode. Save returns to Market Overview per the user's requested flow; Cancel does not persist. Preserve unsaved edits on failure, give visible saving feedback, and verify persistence after reload. Viewer/staff permissions remain unchanged.

Rights belong on individual titles. Company identity, customer preferences, platform evidence and actual audience data are separate concepts.

## Data display: three levels of detail

| Level | What users see | What stays accessible |
|---|---|---|
| Overview / results | Friendly metric label, value, unit/context, compact evidence indicator | Contextual info control |
| Context panel | Explanation, exact value, source name, read date, scope and relevant limitation | Open original source and full methodology |
| Data & Sources | Coverage, definitions, methodology, source states | Advanced source field names, formula versions, collection detail |

Preserve evidence records and honest unknowns. Reduce repetition, not integrity. Non-actionable unavailable future data should not occupy valuable overview space. Display stale warnings where they affect interpretation; do not show a green “Available” chip on every ordinary card.

Examples of clearer wording:

- “Prominence cohort” → “The 50 titles selected by our visibility method” in explanation; preferably use a named chart as the user-facing default instead.
- “Platform-new listings” → “Marked new by the platform.”
- “Market match 21” → “Shares revenge and hidden-identity themes with these titles.”
- “Jaccard overlap” → “Shares 3 story types.”
- “Open supporting data” → “Explore these titles.”
- “Collecting history” → one contextual “Trend comparison is not available yet,” where relevant.

Avoid replacing precise but awkward terms with unsupported marketing claims such as “proven hit,” “US audience favorite,” or “high success probability.”

## Public design references

These are design references, not instructions to replace the existing Next.js/CSS stack or clone proprietary screens.

| Reference | What to borrow for Pulsar | What not to copy |
|---|---|---|
| [FlixPatrol charts](https://flixpatrol.com/top10/) | Clear title/chart identity, platform/date scope, obvious detail links | A long page of every platform; cinema/streaming metrics are not short-drama evidence |
| [Plausible live demo](https://plausible.io/plausible.io), [dashboard guide](https://plausible.io/docs/guided-tour), [filter guide](https://plausible.io/docs/filters-segments) | One dominant visualization, restrained hierarchy, shared scope and focused breakdowns | A time-series hero when Pulsar has only one observation day |
| [Appfigures intelligence](https://appfigures.com/products/app-intelligence) | Competitor tracking and research organized around concrete entities | Making app-level estimates appear to describe individual dramas |
| [Evidence examples](https://evidence.dev/examples), [official repo](https://github.com/evidence-dev/evidence) | Narrative + chart + drill-down patterns; examples include live apps and code | Migrating the app to a different BI framework |
| [Tremor components](https://www.tremor.so/) | Legible bar lists, filter controls, restrained card/table spacing | Adding Tailwind or a component framework solely to imitate the styling |
| [Plausible repository](https://github.com/plausible/analytics) | A public implementation reference for cohesive analytics UX | Wholesale code copying or assuming license compatibility without checking |

The strongest combination is FlixPatrol's clarity about titles and charts, Plausible's restraint, and Appfigures' tracked-entity workflow, with Pulsar's bilingual company relevance.

## Acceptance criteria and sequencing

1. Fix onboarding navigation, permanent profile access, filter consistency, lost scope, misleading search and mobile navigation.
2. Replace the homepage hierarchy using existing observations; remove duplicate/low-value blocks.
3. Unify card/table/detail interactions, sources disclosure and My titles layout.
4. Add the persistent company-profile view and visible personalization contract using existing records.
5. Polish bilingual copy and validate concrete journeys. Defer data expansion.

Validate at 1440, 1280, 1024, 768 and 390 CSS pixels. All navigation must remain reachable; no clipped primary controls. Keep long titles readable and tables intentionally responsive. Keyboard focus must reach filters, saved actions and disclosures; chart tables remain available.

Manual journeys: company setup → save → personalized overview; platform → trope → result → detail → back with state preserved; Chinese trope search → matching English titles; company search → matching listings; save title → find saved view; My titles → readable comparable → next action; metric → explanation → return without losing context; mobile navigation between all primary sections.

For product validation, give 3–5 target studios their own example catalog and ask them to produce a three-title shortlist and explain it. Record task completion, time, confusion, repeated use, and what they currently pay a researcher to do. Test willingness to pay for the complete brief/workflow, not for a list of hypothetical features. No pricing claim is established by this review.
