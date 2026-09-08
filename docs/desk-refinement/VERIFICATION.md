# Overview and catalog refinement

Implemented the researched information hierarchy while preserving Claude's market collection, freshness rules, assessment calculations and existing integrations.

- Overview separates Campaign tasks and What to make next into bookmarkable navigation views. Campaign count remains visible in both.
- Market rows compare new-listing share with all-listing share, showing counts and denominators. Owned-title counts link to a taxonomy-filtered catalog. Examples remain grouped by source platform; full metrics/definitions remain on the market page.
- Catalog rows support comparison without expanding one title into a full page inside a cell. Title evidence remains accessible on the existing detail page. Rights, media, subtitles, campaign states and partner-reported China views remain available.
- Story filter combines with search, sort and recommendation; scope is visible and removable.

## Checks

- Existing tests: 149 passed, zero failed.
- Typecheck passed. Final production build passed (exit 0), including lint/type validation and 37 generated static pages. Nonfatal webpack cache snapshot warnings remain.
- Browser: Campaign tasks ↔ What to make next; keyboard Enter navigation and visible 2px focus outline; market count → six matching titles; search preserves story filter; zero-match recovery link inspected.
- Rendered English/Chinese; 1440, 1024 and 390px representative screenshots. No document-level horizontal overflow on inspected views. The comparison table may scroll inside its container at intermediate widths.
- Four axe-core audits: tasks, market view, catalog, filtered catalog. Zero violations and zero incomplete rules. JSON reports beside this file. Temporary audit assets removed before build.
- Full live campaign delivery, unavailable-market rendering, production permissions, and reduced-motion emulation were not retested for this presentation-only iteration. Existing business tests remained intact. No representative-user study or measured task-speed improvement is claimed.

## Screenshots

[Campaign tasks](tasks-wide.png) · [Market view](market-wide.png) · [Market mobile](market-mobile.png) · [Catalog desktop](catalog-wide.png) · [Catalog mobile](catalog-mobile.png) · [Chinese catalog](catalog-medium-zh.png)

## Rationale

See DESIGN.md's latest section for source links and how each source informed the changes. The preceding conversation contains the research findings and qualifications. This is an implemented design hypothesis, with technical/browser verification; actual users still need to validate whether the prioritization matches their working habits.
