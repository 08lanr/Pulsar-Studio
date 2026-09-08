# Pulsar Studio design direction

## Product and audience

Studio is a US launch workspace for Chinese mini-drama companies. Producers and catalog managers choose titles, prepare and approve experiments, and evaluate results before further investment. Pulsar staff use a separate oversight portal. The latest decisions in `docs/decisions.md` govern behavior; preserve authentication, tenant boundaries, evidence rules, immutable approvals, real integrations, and existing Adapt capabilities.

The three priority tasks are selecting a title with explained US potential, approving creative variations and an experiment budget, and deciding the next investment from attributable results. The character is precise, calm, professional, and comfortably dense. This audience interpretation comes from repository decisions, not invented user interviews.

## Direction and hierarchy

**A calm blue launch desk.** Neutral pale workspace and sidebar, white work surfaces, slate text, blue primary actions and current selection. Cover imagery belongs to the catalog; operating controls remain readable and consistent. Preserve the Pulsar name and mark. No decorative gradients, glows, or shadows. Borders and spacing establish grouping.

UI UX Pro Max exploration compared a Data-Dense Dashboard with a Vibrant & Block-based media direction. The former supports repeat title comparisons and decisions; the latter emphasizes entertainment browsing. We select the former with product judgment, retaining neither generated sales-page patterns nor external font recommendations. Impeccable Operate guidance sets the implementation workflow. See `docs/redesign-resource-exploration.md` for executed queries, setup, seed output, and rejected alternatives.

Five primary navigation areas remain: Overview, My catalog, US market insights, Launch & experiments, Company & accounts. Add title is a clearly differentiated action. Secondary tabs stay within their parent area. Breadcrumbs and contextual return links preserve the user's place. Overview is a deliberate list of decisions and recommended next actions, followed by supporting evidence. Catalog uses compact aligned comparisons. Forms, narrative evidence, creative review, and script editing each use layouts suited to their content.

## Workflow language

Campaign progress uses one six-stage vocabulary in both languages, everywhere a campaign appears: **Prepare → Choose ads → Approve ads → Approve budget → Launch → Review results** / **准备 → 选择广告 → 批准广告 → 批准预算 → 投放 → 查看结果**. Use the same shared stage resolver and labels in Overview, catalog next actions, title assessment, campaign list and campaign detail. Full progress strips belong on the working page; compact list rows show the current stage and relevant next action rather than six miniature steps.

The artifact is an **ad / 广告**. Use “concept” only when explanatory copy describes an idea before generation; do not alternate “creative,” “variation,” “batch,” and “concept” as names for the same ad. “Campaign / 广告活动” is the container, “brief / 简报” is its preparation record, and “round / 轮” distinguishes subsequent tests. Selection and final approval are separate actions: choosing ads does not replace immutable ad approval or budget sign-off.

Legacy data stage keys are preserved: `brief` maps to Prepare, `concepts` to Choose ads, `batch` to Approve ads, `budget` to Approve budget, `submitted` to Launch, and `results`/`decide` to Review results. Record status and actionable readiness must still be evaluated before showing a control. “Waiting for results” describes unavailable results within the final stage, not a seventh stage. Demo, mock handoff, source evidence and provider connectivity are provenance/status information alongside progress; they never become stages or imply a live launch. Keep adaptation-specific script, subtitle and finalization vocabulary separate.

Stage lists reset their own width, margins, padding and list styling; broad page-child and prose `ol` rules must not change their layout. The current step has `aria-current="step"`; ordinary list badges communicate progress without claiming button semantics. Navigation links name the destination action; mutation buttons state the actual authorized action and preserve permission/disabled feedback.

## Shared tokens

Implement this system through the active `app/redesign.css` semantic custom properties imported by `app/globals.css` and reusable existing classes, not a new CSS framework. Both light and dark themes ship; components consume semantic tokens rather than literal colors.

| Role | Light target | Dark target |
| --- | --- | --- |
| Workspace (`--bg`) | `#F3F6FA` | `#101925` |
| Sidebar / secondary surface (`--surface-2`) | `#F8FAFC` | `#1B293B` |
| Work surface (`--surface`) | `#FFFFFF` | `#172332` |
| Primary text (`--text`) | `#172B43` | `#EDF3FB` |
| Secondary text (`--text-muted`) | `#506176` | `#BECBDC` |
| Structural border (`--border`) | `#D7E0E9` | `#36485E` |
| Action / selection (`--brand`) | `#1E40AF` | `#8EAFFF` |
| Selection surface (`--brand-tint`) | `#EAF0FF` | `#24385D` |
| Positive (`--success`) | `#176641` | `#8CD6AA` |
| Warning (`--warning`) | `#85500C` | `#F0C582` |
| Error (`--error`) | `#B42332` | `#FFABB5` |

Action fills must have contrasting text in each theme. Gold `.btn-approve` is reserved for the partner's primary approval action; warning labels can use muted semantic amber but never look like an approval button. Evidence labels use text plus restrained treatment, never color alone. Null is unobserved, not zero. The US potential number always retains its explained composite meaning and score provenance. Demo results and mock handoffs remain visibly identified.

## Typography, spacing, and components

Use `"Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`; no external font requests. Use 14px body, 12px support/data labels, 16px lead copy, 18–22px section headings, and 32px page headings on desktop. Keep weight at 400–600. At narrow widths page headings may be 26px. Bilingual source and adaptation retain their language attributes independently of chrome locale. Numerals in comparisons use tabular figures.

Use a 4px spacing rhythm: 4px tight associations, 8–12px component gaps, 16px compact panel padding, 24px normal panel padding, 24–32px between sections. Controls have 8px corner radius; panels have 12px. Dense data rows need clear separators and row hover/selection states. Keep labels readable and controls comfortably operable; touch-oriented controls should reach 44px where practical. No arbitrary pill shape for every status or control.

Primary buttons are filled blue, secondary buttons are quiet bordered surfaces, destructive controls are explicit, and disabled controls remain legible while clearly unavailable. Links navigate; buttons perform actions. Inputs have persistent labels and consistent focus borders. Use existing SVG icon vocabulary; icon-only controls require accessible names. Show the key action at the relevant task boundary instead of repeating a generic CTA across the screen.

## States, responsiveness, and motion

Every relevant workflow covers loading, empty, error, success, validation, disabled, and permission states. Empty states explain the next meaningful step. Errors identify the failed action and recovery; field errors associate with inputs and announce appropriately. Route loading preserves page structure where possible. Do not fabricate enabled controls or data to populate a state.

At wide widths retain a 240px sidebar, 64px header, and 1440px content maximum; the overview adds its decision side column at 1320px. Below 1024px the sidebar gives way to the drawer. Below 760px page padding becomes 24px 16px and task rows stack. Below the shell breakpoint use the existing accessible modal drawer with Escape, focus containment, and restored trigger focus. Narrow layouts stack task sections and forms; comparison tables scroll within labeled containers rather than overflowing the document. Long Chinese and English titles wrap safely; flex and grid children can shrink. Dialog actions remain reachable and overlays escape clipping containers.

Keyboard users receive a visible focus indicator, logical tab order, usable skip navigation, native control semantics, and no hover-only essential information. Contrast targets are WCAG AA: 4.5:1 for normal text and 3:1 for large text and control boundaries where required. Loading and result messages use appropriate live regions. Reduced motion disables nonessential animation. Ordinary color/border transitions last 150–200ms; there is no page-entry choreography.

## Verification contract

Maintain a route-and-state checklist covering both portals, login, secondary pages, and dialogs. Inspect actual implementation at narrow, medium, and wide widths and in both themes. Exercise core workflows and keyboard operation, inspect screenshot evidence, use automated accessibility checks where available, and run `npm test`, `npm run typecheck`, and `npm run build`. Record executed checks and limitations honestly; passing a detector is not a substitute for rendered and interaction review.


