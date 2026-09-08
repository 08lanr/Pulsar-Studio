# Redesign resource exploration

Prepared against `CLAUDE.md`, the newest 2026-09-08 decisions in `docs/decisions.md`, `PRODUCT.md`, `package.json`, and the existing CSS system. Repository decisions override older product prose. This document records resource work actually executed, not a claim that implementation or browser checks have passed.

## Product interpretation

The primary user is a Chinese mini-drama company's producer, catalog owner, or launch decision maker. Staff have a separate oversight portal. The three principal tasks are: select a title using explained US-potential evidence; prepare and approve creative variations and an experiment budget; review attributable results and decide the next investment. Adapt remains a supporting existing workflow and is frozen against new pipeline scope.

Keep the five areas: Overview, My catalog, US market insights, Launch & experiments, Company & accounts. Add title is an action. US potential is a versioned composite, never a probability. Evidence, data freshness, missing inputs, demo results, mock handoff, permissions, and approval status must remain visible. This is repository evidence, not newly conducted user research.

## Availability and setup evidence

The session's skill catalog and `C:/Users/ruobi/.codex/skills` contained neither UI UX Pro Max nor Impeccable. Both repositories were fetched with shallow clones to `tmp/design-resources/`; the initial restricted-network attempt failed, then the approved network execution succeeded.

| Resource | Inspected revision / setup | Verified use |
| --- | --- | --- |
| [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `4aad0584d92131626b16d4ff4d77f0455385013c`; README CLI installation guidance; `npx --yes ui-ux-pro-max-cli init --ai codex` in `tmp/design-resources` | CLI reported generated `.agents` installation. Its installed search script ran with Python 3.10.4 and returned both design systems and UX/Next.js results. |
| [Impeccable](https://github.com/pbakaus/impeccable) | `2bc2879276c1f321a53c4ca99d3371e411329b52`; README project-scoped Codex setup; `npx --yes impeccable install --providers=codex --scope=project` | Installer detected the repository root and installed `.agents/skills/impeccable`, engine v0.1.3, and project hook resources. `.agents/skills/impeccable/scripts/impeccable.cmd context` executed successfully from the product root. |

No global configuration was edited. Impeccable's README says native Codex hooks require user trust through `/hooks`; this session has verified the callable engine and read the skill, not claimed that automatic hook execution is trusted/enabled. The installer resolving to the git root is the reason Impeccable is at root while Pro Max remains in the isolated resource directory. Skill launcher/context output loaded older PRODUCT prose as well, so the newer decisions were explicitly read separately and take precedence.

## Two directions investigated

Executed using the installed Pro Max `scripts/search.py`:

```text
python tmp/design-resources/.agents/skills/ui-ux-pro-max/scripts/search.py "analytics dashboard media catalog intelligence professional" --design-system --density 8 -p "Pulsar Decision Desk"
python tmp/design-resources/.agents/skills/ui-ux-pro-max/scripts/search.py "entertainment media streaming cinema editorial dark" --design-system --density 5 -p "Pulsar Cinema Studio"
```

Raw output is preserved in `tmp/design-resources/direction-a.txt` and `direction-b.txt`.

| | A: launch decision desk | B: cinematic media studio |
| --- | --- | --- |
| Actual style match | Data-Dense Dashboard | Vibrant & Block-based |
| Actual palette | Primary `#1E40AF`, secondary `#3B82F6`, amber `#D97706`, background `#F8FAFC`, white surface | Rose `#E11D48`, secondary `#FB7185`, blue `#2563EB`, rose background `#FFF1F2` |
| Actual font suggestion | Fira Code / Fira Sans | Inter / Inter |
| Density and behavior | 8/10; compact tables, filters, row highlighting, visible data | 5/10; large sections, bold color shifts, large typography, showcase cards |
| Product fit | Supports comparing title readiness, evidence, and next actions repeatedly | Supports discovering entertainment visually but draws attention away from business decisions |

**Selected: A, translated into a restrained bilingual launch desk.** Use a cool pale workspace, white data surfaces, dark ink, deliberate blue selection/actions, strong row and section hierarchy, and real cover art as the primary visual texture. Favor aligned comparison rows and an explicit next action over repeated equal-weight cards. Retain a recognizable Pulsar mark and use a local system sans stack (Segoe UI with PingFang/Microsoft YaHei fallbacks); replace rounded Outfit for denser operating labels and do not request external fonts. Amber/gold stays reserved for partner approval and meaningful warning semantics rather than generic CTA decoration. Use a fixed compact rem scale with 14–15px body text, readable 12–13px support labels, 24–30px page titles, a 4px rhythm, 8–12px row gaps, and 24–32px section spacing. Inputs need full labels and comfortably operable touch targets even when adjacent data is dense.

Product judgment rejected both generated landing-page patterns (Enterprise Gateway and Feature-Rich Showcase): sales heroes, testimonials, and CTA repetition do not fit an authenticated operating workspace. The entertainment query did not actually produce a dark palette; the comparison reports its real output rather than relabeling it. No external visual reference or new user research was supplied.

### Impeccable direction seed

Executed `impeccable.cmd concept-seed --scope direction --mode operate` with approved access to its documented roll endpoint. The successful API result is preserved in `tmp/design-resources/concept-seed.txt`: seed `3ee1d401`, assigned index 6, six challengers. The initial `--help` probe unexpectedly executed a default surface roll with unavailable network; that probe was not used as design evidence. The subsequent explicit direction command succeeded with catalog challengers.

The product brief authorizes autonomous aesthetic decisions and comparison of two plausible directions; it takes precedence over the optional attended approval tournament. The seed is acknowledged as exploratory input, not falsely reported as a user-approved choice. The blue launch desk remains the selected product direction.

| Catalog challenger | Product-grounded assessment | Verdict / discipline carried forward |
| --- | --- | --- |
| Nixie laboratory counter | Quantities-first layout would over-emphasize composite numbers while diminishing their uncertainty and evidence. Mechanical glow does not identify the producer's work. | Declined on both axes. Raise numeric alignment and unit consistency. |
| CRT arcade | Tiles could hold dramas, but sprite-state conventions weaken budget approval clarity and professional trust. | Declined on both axes. Raise consistency of semantic state colors. |
| Industrial quote grammar | Literal zone labels are useful, but hazard stripes and quoted controls imply warning or irony in ordinary workflows. | Declined on both axes. Raise unambiguous action naming. |
| Iridescent cloud edge | Evidence and uncertainty fit the analytical task; pastel spectral navigation has little connection to catalogs and campaigns. | Competitive on clarity only. Retain explicit evidence grouping, without importing spectral decoration. |
| Camcorder viewfinder | Strong media audience identification, but a full-bleed frame and corner readouts impede catalog comparisons and forms. | Competitive on identification only. Make real media clearly associated with the active title, without overlaying business controls on imagery. |
| PC98 sixteen-color field | Fixed regions support orientation, but bitmap labels and integer scaling cannot comfortably handle bilingual forms and narrow devices. | Declined on both axes. Raise stability of shell, labels, and action positions. |

No challenger artwork was used as a visual reference or claimed inspected; none became the build direction. Following engineering coordination, the final typography is a local system sans stack (Segoe UI plus Chinese fallbacks), replacing rounded Outfit. This refines direction A for clearer dense bilingual controls without any external font request. DESIGN.md records the final binding values.

## Targeted resource findings

`--domain ux -n 4` for `accessible table filters empty error` returned table containment on mobile, announced errors, actionable empty states, and field-specific errors connected with `aria-describedby`. Apply these to table wrappers, form feedback, and empty results. The raw output is `tmp/design-resources/ux.txt`.

`--stack nextjs` for `form validation keyboard loading` returned route `loading.tsx`, Server Action input validation/authorization, and Server Actions for mutations. The source marks these recommendations as Next.js 16.2; this app runs Next.js 14.2.35. Route loading and explicit authorization remain useful; migrating working guarded API mutations to Server Actions is unnecessary and conflicts with preserving established contracts. Raw output is `tmp/design-resources/nextjs.txt`.

## Impeccable workflow applied to the implementation brief

Read the installed SKILL.md plus relevant parts of `reference/new-work.md`, `operate.md`, `shape.md`, `critique.md`, `extract.md`, `harden.md`, and `polish.md`. The primary applicable mode is **Operate**: users are completing tasks, so familiar controls, scanability, consistent density, restrained color, and state feedback take precedence over expressive spectacle. Documentation/source methodology sections also need Read-mode prose measure.

1. Use current repository decisions for context and baseline rendered screens for critique. Maintain separate observed findings versus assumptions.
2. Carry the selected world into DESIGN.md. The user's explicit autonomous redesign instruction resolves optional concept-choice interviews; no new approval pause is needed for routine aesthetics.
3. Read `reference/craft-floor.md` immediately before UI edits, as required by the skill. Start with the shell and core title-decision workflow and inspect the rendered result before propagation.
4. Reuse the existing CSS design-system home. Extract semantic tokens and genuinely repeated patterns; avoid generic abstraction of unrelated content. Operate guidance permits standard sans, conventional navigation, and dense tables.
5. Harden flex/grid `min-width: 0`, long bilingual content, narrow screens, contained table scrolling, missing data, field errors, loading, disabled actions, and role-specific states. Keep overlays outside clipping ancestors with native dialog/portal patterns.
6. Polish in functional priority order: blocked tasks and misleading states; missing states; hierarchy/responsive/system drift; visual/motion details. Use 150–250ms state transitions and reduced-motion overrides; no page-entry choreography.
7. Perform bounded visual inspection and focused fixes; the user's requested workflow and actual defects determine necessary rechecks. Do not treat detector output alone as proof of quality.

The standalone `critique` command documents two isolated assessments plus a detector and browser evidence. Reading its guidance here is not a completed critique command execution. The main implementation team should record any executed assessments and detector runs separately. No UI implementation edits were performed by this exploration subtask; DESIGN.md was subsequently authored at the implementation lead's request.

## Implementation documentation review

Read the implemented `app/redesign.css` and aligned DESIGN.md's exact colors, type scale, token ownership, and responsive dimensions with its active tokens. Read `impeccable detect --help`, then executed the installed detector against `app/redesign.css`, `components/Nav.tsx`, the producer overview, and producer catalog. The valid scan returned exit 0 and an empty findings array; raw JSON is at `tmp/design-resources/impeccable-detect.json`. An initial multi-target attempt named a nonexistent `components/producer-shell.tsx` and warned that it could not scan that path; it was corrected and rerun. The completed scan is static CSS/TSX analysis, not automated proof of rendered accessibility or a standalone Impeccable critique.

Visually inspected the saved after screenshots for mobile overview, dark catalog, and Chinese mobile catalog. The task-list hierarchy, catalog comparison columns, and narrow stacked material disclosures are readable with no evident clipping. The Chinese mobile catalog capture showed the earlier purple accent and predates the latest CSS by roughly 90 seconds; it requires refresh before being represented as final evidence. This freshness issue was reported to the implementation lead. The screenshots alone do not verify keyboard behavior, contrast measurements, or real workflow execution.

