# Workflow clarity review

Reviewed 2026-09-08 against current `lib/research/workspace.ts`, shared stage components, campaign/assessment/list consumers, locale source files and the active CSS cascade. This is a source and terminology review; browser verification for this workflow change is owned by the integration lead and is not claimed here.

## Chosen language

| Position | English | Chinese | Preserved legacy stage |
|---|---|---|---|
| 1 | Prepare | 准备 | `brief` |
| 2 | Choose ads | 选择广告 | `concepts` |
| 3 | Approve ads | 批准广告 | `batch` |
| 4 | Approve budget | 批准预算 | `budget` |
| 5 | Launch | 投放 | `submitted` |
| 6 | Review results | 查看结果 | `results`, `decide` |

These are the user-facing campaign stages. They do not rename database statuses, alter role checks or remove the immutable ad/budget approvals. Waiting for results remains an availability message in Review results. Demo and mock describe provenance/execution mode separately. An ad is consistently an “ad / 广告”; the campaign holds ads, its brief holds the plan, and a new round records another test. Subtitle adaptation remains a distinct domain.

## Locale changes completed

Updated existing English/Chinese values in `locales/_keys/workspace.json` without changing keys or interpolation variables. Stage aliases now use the six labels above; next actions use Generate ads, Choose ads, Approve budget, Launch and Review results. Campaign/table copy consistently names ads instead of interchangeable concepts, creatives or batches. Budget explanation names the user's settings and approval reset rather than internal typed/versioned implementation. Demo labels and assessment-weight explanation remain intact.

Inspected `redesign.json`, `redesign-engineering.json` and `redesign-catalog.json`; they already describe setup, navigation, catalog facts and result availability consistently, so no needless edits were made. Merged locale output was not edited by this subtask. `workflow.json` belongs to the integration lead and `workflow-campaign.json` to the campaign implementation agent.

The legacy `ws.actions.reviewAds` consumer in LaunchShortlist originally represented `waiting.select`; its label is therefore Choose ads. The new shared workflow resolver must distinguish an actual ad-approval action with its dedicated stage/action label. Do not infer ad-approval authorization from that legacy key name.

## Conflicts found and integration targets

- `lib/research/workspace.ts`: `experimentStage` returns seven technical keys and a separate waiting value. Existing logic can show the same `submitted` stage before and after submission, and a `batch` stage alongside a budget/submit waiting value. A single shared user-stage resolver must evaluate these record facts consistently, rather than each screen independently selecting its label.
- `components/producer/research/workspace-ui.tsx`: the former seven-item StageStrip exposed Brief, Concepts, First batch and Next spend. Integration is replacing that presentation with the shared six-step model while preserving data keys.
- `LaunchShortlist.tsx`, producer Overview, catalog, potential page and campaign list: these are competing entry points to the same work. Reuse the shared current-stage/next-action resolution; compact rows need a current badge, not a tiny full workflow competing with title/material facts.
- Producer campaign detail and `PromoWorkspace.tsx`: old section labels and a separate five-step launch strip could repeat or contradict the outer seven-step strip. Keep one authoritative progress strip and make current work/action clear; separate ad choosing from final campaign approval.
- `ExperimentPanel.tsx`: the result/next-round panel contains literal generated-English notes about “winning concept” and “variations.” They are outside this subtask's application-code ownership; campaign implementation should standardize user-facing generated round descriptions too. Do not mislabel creation of a new round as immediate AI generation or spending.
- `locales/_keys/promote.json`: legacy statuses, `promote.step.*`, generation and approval labels remain consumers to inspect during campaign integration. Staff Promote has its own operational queues; retain real staff state information while using ads for the shared artifact. No bulk replacement was applied to staff adaptation/creative-pack domains.

## CSS causes to address

1. `app/studio-v3.css` `.producer-main > *` assigns `width: min(100%, 1480px)` and horizontal auto margins to every direct child. A top-level ordered workflow list inherits this broad page-container treatment; component width/margin resets need sufficient specificity.
2. `.ws-hero-next ol` applies grid display, padding-left and gap to every ordered list inside the next-action aside. A shared stage strip rendered there would become a prose/grid list. Scope prose selectors to their intended class or explicitly style workflow lists.
3. `.page-head + .ws-stages` adds negative top margin, while `app/redesign.css` separately supplies stage padding. Together with old narrow strip rules, these can cause spacing inconsistency across placements.
4. The earlier `.promo-launch-steps` implements five equally divided columns and hides label spans below 577px. It cannot be the canonical six-step responsive model; leave no competing label-less tracker in the active campaign UI.

These are source-observed collision risks, not a claim that every selector produced a rendered defect. The implementation lead owns the fixes and actual wide/narrow layout check.

## Checks performed

### Extended legacy/source pass

Updated 34 producer labels in `promote.json` and 9 staff Promote labels in `admin.json`. Shared artifacts now read ads/广告 and campaign/广告活动; select controls say Choose ad while the immutable campaign-level action says Approve ads. The selected-ad count retains its count meaning; staff labels and explanations use the same artifact without renaming actual live/launching/failed statuses. Existing adaptation and internal creative-pack terminology, campaign names and generated historical records were untouched. The five historical `promote.step.*` keys remain backward-compatible, but no active TSX reference to that legacy five-step tracker was found; its old CSS remains a cascade risk rather than a second active tracker.

Current generation is five proposed ads followed by a user-selected test set. Copy previously said all five were tested every round, conflicting with that selection. The revised explanation preserves five generated ads while making the selection explicit. Hardcoded future-round descriptions in ExperimentPanel were reported to the campaign implementation owner for equivalent vocabulary updates. JSON and tracked-baseline placeholder checks passed for all producer Promote and staff Promote source keys. No merged dictionary or application-code edit was made in this pass.

Parsed the edited locale JSON and checked workflow-key interpolation placeholders against the tracked baseline; the targeted check passed. A first whole-file comparison detected a pre-existing `ws.score.note` placeholder difference outside this task, so the check was narrowed to the owned workflow keys. This subtask added/removed no keys or interpolation variables. Read the relevant component/data/CSS consumers and documented the shared-stage contract in DESIGN.md. No application code, merged locale dictionaries, business rules or adaptation strings were edited by this subtask. Build, test and rendered workflow checks remain integration-level work.
