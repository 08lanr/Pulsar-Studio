# Pulsar Studio engineering guide

This is the working contract for repository changes. Product scope and vocabulary live in `PRODUCT.md`; newer entries at the top of `docs/decisions.md` override older prose.

## Current product boundary

- Studio contains two producer products over one drama library: Adapt and Promote. Promote owns creative generation/review/approval; the sibling Grow repository owns TikTok launch and metrics. Do not add Stage.
- Two portals share one Next.js app: staff routes under `app/(admin)` and producer routes under `app/(producer)` with `/producer` URLs.
- **Producer-first, subtitles-not-dubbing (2026-09-03/04 pivots, see `docs/decisions.md`):** the work happens in the partner portal — a producer uploads subtitles per episode, presses generate, edits lines on one continuous script sheet (no scene confirms anywhere in the producer flow), and finalizes. Deliverables are the clean English script report and the burned-subtitle video; there is no dubbing. The admin portal is oversight. The portal follows the UI grammar of the consoles producers already use (`docs/ui-research.md`); its look stays on our tokens.
- The legacy creative pack remains Pulsar-internal. Producer-facing Promote has its own `promote.*` records and does not expose or depend on that pack. Adapt still accepts optional video with SRT, VTT, ASS/SSA, or plain text; Promote requires shared episode video but never requires Adapt output.
- **Demo replay:** in fixture mode, first-pass and alternatives replay `data/fixture/canned.ts` through `lib/demo-replay.ts` — deterministic, zero spend, no key. Never wire fixture mode to real model calls (`DEMO_REPLAY=0` is the explicit override). `docs/demo/aizailvtu-demo-ep1.srt` must keep matching the bank.

## Required checks

Run `npm test`, `npm run typecheck`, and `npm run build` before considering an integration complete. The app runs on port 3200. Fixture mode is the default and must work without a database or API keys.

## Data and identity

- All application reads and writes go through `getData()` in `lib/data/index.ts`; pages and routes do not select tables directly.
- Keep fixture and Supabase behavior equivalent, especially authorization and state-transition failures.
- UUIDs are internal. UI and exports use external ids with the established prefixes (`ttl_`, `ep_`, `sc_`, `ln_`, `ad_`, `ver_`, `rw_`, `alt_`, `var_`, `clip_`).
- `core.profiles` determines portal access. Producers read only their own producer's titles — and (reviewer/approver roles) EDIT them: create titles under their own company, ingest, run the AI pass, edit lines. Per-title enforcement is `requireTitleEditor` (fixture) / `core.can_edit_title()` (SQL, migration 0002). Viewer-role producers stay read-only. Staff may preview the producer portal but may not act there.
- Producers see their own drafts (they author them). Pulsar's API spend (`cost_cents`, jobs) never reaches a producer session.
- Service-role access is server-only and limited to jobs, ingestion tooling, and storage helpers.

## Approval invariants

- A scene's staff state is only `draft | approved` (a staff-side grouping; the producer flow never surfaces or requires it).
- A version's visible state is `draft | in_review | approved`; `superseded` is bookkeeping only.
- Submission creates and hashes an immutable snapshot. Producer review and exports read frozen snapshots, never mutable draft rows.
- Two paths to `approved`, and they never blur: (1) staff `submitVersion` (freeze + `in_review`) then producer `approveVersion` (or admin on-behalf with evidence); (2) producer-approver `finalizeVersion` — one action that freezes the snapshot, writes per-scene sign-off rows automatically, and approves. Staff are refused by finalize, so every approval records which side made it.
- Finalize gates on content readiness only (every line adapted, non-cut lines non-empty, changed lines carry rationale) — NO scene-confirm requirement, in fixture and SQL alike. The finalize route additionally runs `lib/qc.ts` (`runQc`): QC errors return 409 and block; warnings ship visibly.
- Changes after submission fork a new draft; frozen versions are never edited in place.
- Staff approval on behalf is admin-only and requires an evidence note and audit channel.
- Promote approval follows the same principle with a separate invariant: it freezes exact `pc_` creative versions, media hashes, and copy in a hashed manifest. Handoffs are append-only and idempotent.

## LLM and cost invariants

- Every model call creates a `studio.jobs` row with an idempotency key, input/output, usage, status, and integer `cost_cents`.
- Validate structured model output with zod before data-layer writes.
- `LLM_PROVIDER=anthropic|openai` selects the gateway; without that provider's API key, AI actions show an unavailable state while fixture mode continues to work.
- Producer-approved immutable snapshots are the translation-memory source of truth. First-pass prompts may retrieve examples Studio-wide, but this corpus is server-only and must never expose another producer's rows through a route or UI; never create a second mutable copy of approved lines.
- Writing passes get their context through `lib/memory` only, in fixed authority order: approved memory → house exemplars → register guide → CC-CEDICT glosses → Tatoeba near-exact pairs. Knowledge blocks go after the cached system blocks and never into idempotency keys (decisions 2026-09-04, "Training the translator").
- ASR is a v1.1 stub; do not silently transcribe video in V1.

## UI and localization

- Admin chrome defaults to English and producer chrome to Chinese; the locale cookie wins.
- Use `t()` in server components and `useT()` in client components. Add strings under `locales/_keys/`, then run `node scripts/merge-locales.mjs`.
- Chinese source and English adaptation remain in their content languages independent of chrome locale; retain `lang` attributes or bilingual classes.
- Use existing tokens and classes in `app/globals.css`. Do not introduce a CSS framework or external font host.
- Reserve the gold `.btn-approve` for the partner's primary approval action.

## Routes and exports

- API routes follow: same-origin guard, role check, zod validation, data-layer/job call, JSON response. Use the shared handler and API guard.
- Foreign producer resources behave as not found; never leak their existence.
- Render exports on request from approved, then in-review, then draft state, and identify the source in the header. Do not store generated exports or create export jobs.
