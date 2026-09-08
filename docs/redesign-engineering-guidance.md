# Redesign engineering resources

Inspected 2026-09-07. Application contract: `CLAUDE.md`; Next.js 14.2.35 App Router, React 18.3.1, TypeScript, custom CSS tokens, bilingual dictionaries. No root AGENTS.md, components.json, Tailwind, project Playwright configuration, or installed Playwright/axe dependencies were found during initial inspection.

## Official shadcn skill

- Read https://ui.shadcn.com/docs/skills and cloned https://github.com/shadcn-ui/ui at `5c7072da672b0048bc6771e3204063a2537df91a` into `tmp/design-resources/shadcn-ui`, with sparse checkout of `skills/shadcn`.
- Followed documented `skills add` setup, targeting Codex locally: `npx --yes skills add ./shadcn-ui --agent codex --skill shadcn --yes --copy` from `tmp/design-resources`. Verified with `skills list --agent codex --json`; read installed instructions.
- Ran `npx --yes shadcn@latest info --json` against the application: Next App Router, RSC, TypeScript; `tailwindVersion: null`, `config: null`, `components: []`.
- Ran official `docs sidebar dialog field empty`; fetched sidebar and dialog documentation. Registry search for sidebar returned 31 candidates including grouped navigation, sticky site header, and dialog variants. The search then exited with a Windows `UV_HANDLE_CLOSING` assertion; discovery output was available, but this command did not finish successfully.
- Decision: reuse the custom component system. The library's Tailwind styling setup is incompatible with this repository's explicit prohibition on adding a CSS framework. React itself is compatible, but no framework migration or shadcn component installation is justified. Borrow semantic composition, named modal surfaces, grouped navigation and shared semantic colors; retain native controls and local tokens.

## Vercel Agent Skills

- Cloned https://github.com/vercel-labs/agent-skills at `063bee94c3f4df8453406c830b0a7df0f2860278` into `tmp/design-resources/vercel-agent-skills`.
- Installed `web-design-guidelines`, `vercel-react-best-practices`, and `vercel-composition-patterns` with documented CLI and `--agent codex --yes --copy`. `skills list --agent codex --json` verified all three under the isolated workspace's `.agents/skills`.
- Read all three SKILL.md files, selective `async-parallel` and `patterns-children-over-render-props` references, and fetched fresh https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md to `tmp/design-resources/web-interface-guidelines.md`.
- Initial review covered `components/Nav.tsx`, both portal layouts, `PortalHeader`, `MarketFilters`, `WatchButton`, `LaunchCatalog`, and producer experiment listing. Preserve URL-backed market filters, pending feedback, role checks, semantic links, server components, and already-parallel catalog/market requests. Do not import React 19-only guidance into this React 18 app.
- Applicable findings: admin mobile menu used a scrim without modal focus containment or Escape dismissal; both layouts lacked skip links; experiment signals were two unlabeled percentages; producer experiment page title was h2 without page h1. Native dialog composition, a focusable main landmark and explicit metric labels address these findings without changing business rules.
- Implemented fixes in the owned secondary scope: `Nav.tsx` uses a named native modal dialog with a shared navigation fragment, trigger state, Escape dismissal, close control, focus return, and desktop resize dismissal. Admin layout supplies a localized skip link and focusable main target. Producer experiments now has an h1, individually labeled hold/CTR signals, unobserved CTR when impressions are absent, and locale-aware dates/budgets. No fetching, authorization, approval, or campaign transitions changed.
- Review shared styles for visible focus, 4.5:1 normal text contrast, reduced motion, 320–1440px layouts, native select colors, table number alignment, and long content. Preserve the documented visual direction over optional Vercel title-casing and aesthetic suggestions.

## Playwright and accessibility availability

- Read https://github.com/microsoft/playwright. Initial `npm ls playwright @playwright/test @axe-core/playwright --depth=0` returned empty; existing tests run Node's test runner through `tsx`, not a browser.
- Installed standalone `playwright` and `@axe-core/playwright` with `npm install --prefix tmp/browser-check --no-save --package-lock=false playwright @axe-core/playwright`; the application manifest and lockfile were untouched. Axe browser source is available at `tmp/browser-check/node_modules/axe-core/axe.min.js`.
- Browser verification is delegated to the primary agent using the installed controlled in-app Browser skill. No separate browser was launched by this resource audit. Installation alone is not a test result; screenshots, workflow results and accessibility findings belong in the final verification report.

## Impeccable engineering cross-check

Read `skill/reference/craft.md` and `craft-floor.md` from the fetched Impeccable repository. The deprecated craft alias adds no separate workflow. Applicable craft checks reinforce clear hierarchy, explicit field/state feedback, keyboard focus, measured contrast, real content at each breakpoint, and disciplined shared tokens. The project's DESIGN.md is the authority for palette, typography and density.
