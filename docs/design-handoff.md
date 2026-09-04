# Pulsar Studio redesign handoff

## Current objective

Redesign the entire visible Studio product, not merely its workflow. This
includes navigation, page geometry, margins, pane proportions, typography,
color, shapes, borders, elevation, controls, interaction states, responsive
behavior, and the visual relationship between producer and admin portals.

The desired character is an editorial post-production instrument: precise,
calm, media-aware, and distinctive. It must not resemble a default shadcn or
AI-generated dashboard.

## Product truth

Pulsar localizes Chinese vertical-drama scripts into natural U.S. English and
delivers subtitle assets. The core sequence is:

1. Create a title and upload episode subtitle/script files; video is optional.
2. Generate an American English adaptation.
3. Review and directly edit localized lines with rationale and alternatives.
4. Run delivery QC and finalize an immutable language version.
5. Adjust subtitle timing and styling, then export SRT/VTT/script or render a
   subtitled video.

Dubbing, scene-by-scene confirmation, and producer request-change threads are
not part of the current producer product. Scenes may remain internal
bookkeeping. Newest entries in `docs/decisions.md` override older documents.

## Current UX diagnosis

- Producer navigation has no route-aware active state or breadcrumbs.
- Normal producer pages are constrained to 640px, while studios escape the
  shell with separate viewport calculations. Margins and alignment jump.
- The title-page progress strip is decorative, horizontally overflows, and
  disappears inside the work itself.
- The language studio places long Chinese, literal English, adapted English,
  and rationale into a narrow sheet beside a 372px rail. Readability collapses.
- `Confirm changes` means save one selected line, but reads like a workflow
  approval. `Finalize episode` freezes the version. Their scopes are unclear.
- Approved versions can be forked in the data layer and through the `/fork`
  route, but the producer UI exposes that action only for `in_review`, making
  finalization appear irreversible.
- Finalized screens repeat Subtitle Studio and script-download actions.
- QC, player, media attachment, export, alternatives, editing, status, and
  finalization compete within the same visual hierarchy.
- The timing desk adds global offset, exact offset, playback speed, loop,
  per-cue fields, playhead capture, nudges, reset, batch save, warnings,
  auto-sync proposals, styling, render, and downloads to one page. It needs
  modes and progressive disclosure, not additional stacked cards.
- `app/globals.css` contains over 4,000 lines and multiple retired interface
  generations, making consistent visual changes risky.

## Reference hierarchy

- CaptionHub: editor-first proportions, persistent waveform, cue timing.
- Phrase TMS: bilingual segment editing, QA, terminology, history inspector.
- Descript: synchronized transcript/player selection and configurable panes.
- Frame.io: media presentation, versioning, review clarity, delivery polish.
- Lokalise: contextual translation, terminology, and focused side panels.
- Linear: navigation precision, density, selection, command behavior.
- OOONA: professional subtitle terminology, QC, and frame-accurate expectations.

Use open-source repos for implementation ideas, not visual authority:
`laubonghaudoi/subtitle-editor`, `hikashop-nicolas/subedit`,
`bbc/react-transcript-editor`, `FreeFrame`, and `OpenFrame`.

## Non-negotiable design principles

1. One selected cue coordinates every visible surface.
2. One primary action per workflow state.
3. Saving a line and finalizing a version must never share approval language.
4. Finalization is immutable, but revision is always visibly available by
   creating a new draft from the approved version.
5. Use full-height panes and dividers in workspaces; avoid nested card soup.
6. Color reinforces meaning but never carries it alone.
7. Every async action has idle, working, recoverable failure, and success UI.
8. Desktop editing and mobile review are intentionally different layouts.
9. Real Chinese and English content determines spacing and typography.
10. Preserve data behavior unless a checklist item explicitly changes it.

## Files that currently define the producer experience

- `components/producer/PortalHeader.tsx`
- `app/(producer)/layout.tsx`
- `app/(producer)/producer/page.tsx`
- `app/(producer)/producer/titles/[id]/page.tsx`
- `components/producer/EpisodeSlots.tsx`
- `components/producer/EpisodeWorkspace.tsx`
- `components/producer/SubtitleStudio.tsx`
- `app/globals.css`
- `locales/_keys/producer-workspace.json`
- `locales/en.json`
- `locales/zh.json`

## Continuation protocol

Continue from `docs/design-overhaul-checklist.md`. Inspect the rendered page
after each meaningful group of changes and check items only after verification.
Do not reintroduce retired workflow concepts from stale docs or CSS comments.
Record material design decisions and unfinished work in this file before the
context ends.

