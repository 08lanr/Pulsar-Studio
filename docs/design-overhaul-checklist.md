# Pulsar Studio design overhaul checklist

Updated 2026-09-04. This is the durable execution list for the Studio redesign.
Check an item only after the rendered state has been inspected in the browser.

## Product truth

- [x] Re-read the current producer, admin, API, data, migration, test, locale, and design-system paths.
- [x] Treat `docs/decisions.md` newest-first as authoritative.
- [x] Preserve the two-stage episode model: finalize language, then prepare subtitle delivery.
- [x] Preserve QC, timing offset, cue editing, style preview, export, and immutable version history.
- [x] Exclude dubbing, scene-by-scene approval, and creative-pack concepts from the producer redesign.

## UX architecture

- [x] Replace the producer's location-blind header with persistent route-aware navigation and breadcrumbs.
- [x] Make title, episode, Script, Timing, and Delivery location visible on every relevant screen.
- [x] Replace the misleading five-step progress decoration with actionable stage navigation.
- [x] Establish one predictable primary action per state.
- [x] Rename per-line `Confirm changes` to a save action whose scope is unmistakable.
- [x] Add a visible `Create new draft` action after finalization, backed by the existing fork endpoint.
- [x] Remove duplicated download/subtitle actions from finalized episode states.
- [x] Preserve immutable approved versions while making revision clearly reversible through a new draft.
- [x] Add unsaved-change protection where local edits can be lost.

## Visual system

- [x] Replace legacy blue/gold/card-heavy styling with a deliberate editorial production aesthetic.
- [x] Define a coherent neutral palette, one selection accent, and semantic-only status colors.
- [x] Define typography for UI, Chinese dialogue, English dialogue, and monospaced timecodes.
- [x] Define page gutters, maximum widths, pane dividers, density, radii, elevation, and focus states.
- [ ] Remove obsolete scene-review and dubbing CSS.
- [ ] Split the monolithic stylesheet into maintainable design-system and screen-level styles where useful.
- [ ] Ensure controls meet accessible contrast, focus, labeling, and target-size requirements.

## Producer shell and starting pages

- [x] Redesign global producer navigation and active-page treatment.
- [ ] Redesign login as a polished product entry point.
- [x] Redesign title library with useful status, progress, and next-action hierarchy.
- [x] Redesign title detail with clean episode navigation and batch upload placement.
- [ ] Redesign new-title and upload flows with clear file requirements and parsing states.
- [ ] Validate desktop, tablet, and phone layouts.

## Episode language studio

- [x] Give the studio a true full-width application workspace independent of normal page margins.
- [x] Introduce persistent Script / Timing / Delivery stage navigation.
- [x] Rebalance video, bilingual script, and contextual inspector proportions.
- [ ] Make the selected cue the shared focus across script, player, QC, and inspector.
- [ ] Reduce always-visible rationale density; preserve the full explanation in focused context.
- [ ] Make line save state clear: unchanged, dirty, saving, saved, and failed.
- [ ] Make alternatives subordinate to editing rather than a competing primary action.
- [ ] Redesign QC as a navigable issue surface rather than another stacked card.
- [x] Redesign finalized state with version history and `Create new draft`.
- [x] Remove redundant actions and repeated explanatory copy.

## Subtitle timing and delivery studio

- [x] Separate Timing and Delivery tools into clear modes without losing playback context.
- [x] Consolidate global offset controls into one compact control group.
- [x] Consolidate per-cue start/end, playhead capture, nudging, reset, and save behavior.
- [x] Make pending timing changes and their save boundary unmistakable.
- [ ] Present timing warnings adjacent to the affected cue and in a filterable issue list.
- [ ] Keep unavailable auto-sync informative without giving a disabled feature primary prominence.
- [x] Redesign subtitle style controls around a live video preview.
- [x] Consolidate SRT, VTT, script, and rendered-video outputs into one delivery area.
- [ ] Design render progress, completion, retry, and failure states.

## Admin portal

- [ ] Align admin shell and components with the same visual language.
- [ ] Remove producer-era scene/alternative status language from admin screens.
- [ ] Redesign title and episode oversight around actual subtitle-localization states.
- [ ] De-emphasize or remove creative-pack navigation from the active Studio product.

## Verification

- [ ] Exercise empty, ingesting, generated, dirty edit, QC error, finalized, timing dirty, and delivered states.
- [ ] Verify English and Chinese chrome with real bilingual content.
- [ ] Verify 1440x900, 1024x768, and 390x844 layouts.
- [x] Run `npm run lint`.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Record remaining limitations in `docs/design-handoff.md`.
