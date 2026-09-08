# Vercel interface review

Reviewed 2026-09-07 against a freshly downloaded `vercel-labs/web-interface-guidelines/main/command.md`, plus the installed React performance and composition guidance. Source checkout and Codex setup evidence are in `redesign-engineering-guidance.md`. DESIGN.md remains the visual authority.

## Fixed in this review

- `components/producer/research/ExploreNav.tsx:25` — added the page h1. Saved titles now has a dedicated, URL-backed link using the existing `watched=1` filter. Platform, audience, trope, search, and company scope survive tab navigation; page index and incompatible per-view controls reset as before. Only one tab has `aria-current` when Saved titles is active.
- `components/producer/research/CompanyNav.tsx:5` — reconciled secondary navigation around Company profile, Accounts, Access, Reports, and the preserved legacy simulation. Canonical links use `/producer/company?tab=...`; the same component now renders on the company page and the legacy report/simulation views. Reports breadcrumbs return to Company rather than Catalog.
- Secondary route page titles now use h1 in company, insights, source directory, both source/metric detail branches, public listing detail, title detail, potential assessment, new title, reports, simulation, and the producer error boundary. Nested section headings were not blindly replaced. ExploreNav supplies the shared h1 for all four explore routes, including their empty-state branches.
- Potential assessment uses the selected locale's title as its primary heading, falls back to the Chinese title when English is absent, and retains the opposite language subtitle with accurate `lang` attributes.
- `app/(producer)/producer/titles/[id]/page.tsx:49` — viewer-role UI no longer exposes editor upload/create actions. The existing reviewer/approver check now matches Company and Potential; the existing read-only explanation is visible. Server permission checks are unchanged.
- `components/producer/research/AccountsForm.tsx` — successful account save announces through a persistent `role="status"` region after the editor closes. Existing inline error announcements and pending fieldset disabling remain.

## Verified through code inspection

- New navigation uses ordinary anchors with real destinations, preserving browser history and open-in-new-tab behavior. No tab roles were added to navigation links because this navigation changes routes rather than implementing an in-page ARIA tab widget.
- No new fetching, client effects, package dependencies, or data copies were needed. Company data retains independent parallel reads. Navigation is composed from shared children/data rather than boolean modes. React 19-only guidance was not applied to React 18.
- New text is in `locales/_keys/redesign-engineering.json`; dictionary merge is part of primary-agent integration.
- `npm run typecheck` passed after the secondary heading/navigation changes, and passed again after the viewer, localization, and account feedback fixes.

## Remaining / delegated verification

### Rendered follow-up

The primary agent's rendered public listing detail review found the same skipped level in Synopsis and related tabs. Its actual section headers (Synopsis, Similar listings, Placements, Trends, Your matches, and Sources) now use h2 below the listing h1. The `.rs-detail-hero h1` selector preserves the earlier title size instead of inheriting the global 40px default.

The primary agent's 375px market insights axe run also found an h1-to-h3 skip at the first section header. The three insights section headers now use h2, while item headings retain their existing levels. Source directory section headings, source/metric detail section headings, explorer platform headers, and the advanced trope-pairs section were inspected and corrected from h3 to h2 where they directly follow the page h1. Existing source-card item headings remain h3 under their section h2. Matching brief-section CSS includes h2 without changing the visual scale. The primary agent owns the rendered rerun.

The primary agent's actual axe run found a `heading-order` failure on Company accounts (h1 followed by h3). The code fix promotes Accounts, Access roles, and Billing section titles to h2; ReportImport preview and batch headings also become h2. AccountsForm and OnboardingForm use labels/legends rather than introducing skipped headings. Potential assessment now uses h2 for its major sections and next actions, with h3 for each nested ComponentCard. Existing heading styles were updated explicitly to the new tags, and the potential title is 32px wide / 28px narrow. `npm run typecheck` is rerun after these changes; the primary agent must rerun axe to verify the rendered finding is resolved.

- No browser was launched by this review. The primary agent owns screenshots, narrow/medium/wide layouts, actual keyboard interaction, focus visibility, color contrast, and workflow verification. Static inspection does not establish those checks passed.
- `components/producer/research/ReportImport.tsx:162` — legacy batch reversal executes immediately without a confirm/undo interaction. This existing behavior was preserved at the primary agent's direction; no destructive action behavior was introduced by this redesign.
- Some account/profile controls still omit native `name`/`autocomplete` hints; labels exist, but a separate forms pass can improve browser assistance.
- Existing dense custom table markup does not expose full native table header relationships. Table semantics and small-screen scrolling require broader component ownership and rendered review.
- Top-level page headings are fixed in the owned scope; existing nested heading levels and producer creative/subtitle workspaces remain subject to the primary agent's broader review. Overview, catalog, and Promote are owned by the other implementation workstreams.

## Final integration note — 2026-09-08

The delegated/rerun statements above describe the review at that time. The implementation lead subsequently completed the rendered checks and targeted refinements documented in [VERIFICATION.md](redesign/VERIFICATION.md) and the [route/state checklist](redesign-route-checklist.md). Latest saved axe reports for the inspected producer families and all eight staff families report zero violations, including [script editor](redesign/axe-script-editor-final.json), [subtitle editor](redesign/axe-subtitle-editor-final.json), [staff editor](redesign/axe-staff-editor-final.json), [new title](redesign/axe-new-title-final.json), [uploaded title](redesign/axe-uploaded-title-final.json), and [empty adaptation editor](redesign/axe-empty-editor-final.json). Incomplete automated rules and untested workflow branches remain explicitly recorded; zero violations is not a complete accessibility certification.

Producer catalog now uses a native five-column table with header relationships and labeled responsive records, resolving its earlier table-semantics concern. Staff comparison views preserve their existing grid implementation inside named scrolling containers; they were not all converted to native tables. Both mobile navigation dialogs were keyboard-tested for Shift+Tab containment, Escape dismissal and restored trigger focus.

The upload review discovered a live FileList/reset race. Selected files are now copied before the deferred state updater, and file inputs remain keyboard-reachable with visible focus treatment. The separate Add episodes SRT flow was rechecked through Import success and Episode 1 with 22 source lines. Final typecheck, lint, all 141 tests and production build passed after this fix. The build reported a nonfatal webpack cache snapshot warning. External Claude generation returned a connection error with recovered controls; successful external AI/provider execution remains unverified.
