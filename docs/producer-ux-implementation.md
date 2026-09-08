# Producer UX implementation

Implemented the producer-focused redesign described in `producer-ux-strategy-review.md`. This replaces the old four-card dashboard, not the research collection pipeline.

## Delivered journeys

- A three-section market brief: six drama cards, six story-share bars, and up to three catalog next actions. Company relevance is explicit; market bars retain a clear denominator.
- A permanent company profile with summary/edit modes and My titles / Company profile / Reports navigation. Successful edits return to Overview with confirmation and refreshed recommendations; errors retain edits.
- Immediate URL-based filters, Chinese/English story and publisher search, platform-safe counter sorts, saved-title navigation, and scoped detail return links.
- One catalog with readable comparisons and known materials. Existing reports, license dates and episode approval facts remain in expandable details. No generic license dates are presented as US rights.
- Three title-detail tabs, visual trope comparisons, active promotion work before optional premise examples, and a CSV example for report imports.
- Counter dialogs with exact values, evidence, field, read date and original source. Source pages separate current inputs from unconnected sources and show source-specific status.
- Mobile navigation with a native dialog, focus containment, Escape dismissal and focus return. External cover failures receive a local fallback.

## Verification

Automated: 130 tests, TypeScript checking, and production build. Regression coverage includes Chinese/publisher search, profile defaults and explicit overrides, cross-platform sorting prevention, safe return URLs, distribution exclusivity, normalized markets, company isolation, profile write permissions, and source-specific availability.

Browser verification in fixture mode:

- Changed a company trope, saved, returned to Overview with confirmation, and verified persistence on reopening the profile. Restored the original story preferences afterwards.
- Immediate platform changes and single-platform views sorting; opened a title from page 2 and returned with platform, publisher search, sort and page preserved.
- Chinese search `霸总`: 151 ReelShort listings in this snapshot. Publisher search `Webfic`: 53 listings. No-match search exposes a reset action.
- Saved a drama, found it in Saved titles, then removed the test addition.
- Opened an exact-value source dialog and dismissed with Escape without losing results context.
- Inspected Chinese Overview, catalog, source definitions, story bars and profile. Checked 390, 768, 1024, 1280 and 1440px layouts; no page-width overflow in inspected views. Mobile menu exposed all primary destinations, and Escape returned focus to its trigger.

Screenshots (local artifacts, ignored by Git):

- `tmp/ux-screenshots/overview-1440-zh.jpg`
- `tmp/ux-screenshots/overview-390-zh.jpg`
- `tmp/ux-screenshots/catalog-1280-zh.jpg`
- `tmp/ux-screenshots/sources-1280-zh.jpg`
- `tmp/ux-screenshots/company-1280-zh.jpg`

## Practical limits

The live Supabase deployment was not exercised; the new identity read has matching tenant filters in both adapters and requires no migration. No deployment or new external data connection was performed. Public coverage and limited history remain unchanged; third-party cover availability still depends on its host. Browser checks cover the core journeys above, not a formal usability study or every possible API-failure scenario.
