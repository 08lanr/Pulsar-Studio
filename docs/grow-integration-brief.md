# Brief: integrate Pulsar Grow into Pulsar Studio ("Promote")

Audience: the Codex agent implementing this. Written 2026-09-04 against
Studio `main@0eb0138` and Grow (`pulsar` repo) `main@c90a057`.

Read this whole file before touching code. Where it says *your call*, it
means it — design the workflow and UI yourself within the guardrails. Where
it says *must*, it is a contract with the other agent working in Studio
(Claude, who owns localization: `components/producer/*` except your new
folder, `lib/subtitle-*`, `lib/ingest`, `lib/qc.ts`, the timing routes).

## 1. Goal in one paragraph

A mini-drama producer who has episodes in Studio should be able to open a
**Promote** workspace, get a pack of ad-ready vertical clips cut from their
own footage (with Studio's English subtitles burned in), review and
approve them, and hand the approved set to **Grow** as an ordinary
`mini_drama` campaign. From that moment Grow is the single source of
truth for operator approval, TikTok launch, platform review, and metrics;
Studio only reads results back. Studio never launches ads. Grow never
touches episode masters.

## 2. Decision record (do this first)

This lifts two lines of Studio's V1 boundary in `CLAUDE.md` ("Studio only,
no Reach/Stage dependencies" and "the creative pack is Pulsar-internal").
That boundary was a deliberate focusing choice by the founders; lifting it
must be equally deliberate:

1. Add an entry at the TOP of `docs/decisions.md` titled
   `2026-09-04 · Promote: Studio hands approved clips to Grow` stating the
   ownership split in §3 and that the creative pack becomes
   producer-facing *through the Promote module only* (the staff pack page
   stays staff-only).
2. Edit the two `CLAUDE.md` lines to match. Do not weaken anything else
   in that file — every other invariant still applies to your code.

## 3. Ownership split (must)

| Concern | Owner |
|---|---|
| Titles, episodes, episode video masters, producer identity/permissions | Studio (`core.titles`, `core.episodes`, `studio-media` storage, `requireTitleEditor`) — **reuse, never duplicate** |
| Drama analysis, clip selection, subtitle burn, ad renders, producer review/revisions, approval of creatives | Studio — new Promote module |
| Campaign config, operator approval, TikTok launch, review polling, pause/end, metrics | Grow — **unchanged engine** |
| Metrics display inside Studio | Studio, read-only via Grow's API; Grow remains the data owner |

Only small, finished ad renders cross into Grow (its uploader is local-disk,
200 MB max, loads the file into memory — `app/api/upload/route.ts` — which
is fine for a 15–60s vertical MP4 and wrong for an episode master).

## 4. Prerequisite: durability

Studio runs in fixture mode: in-memory, reset on every restart. No Supabase
project has ever been provisioned. Build and test Promote in fixture mode
(the whole app works that way), but a handoff to a *real* Grow environment
requires stable ids across restarts, so:

- Design every Promote id as a UUID minted at creation and carried in the
  handoff, never derived from array position or timestamps.
- Keep the Supabase mirror of every new data-layer method (see §6) so the
  day a project is provisioned nothing in Promote changes.
- Flag in your summary that provisioning Supabase + a storage bucket is the
  remaining blocker for production handoffs. Do not provision it yourself.

## 5. Phase A — Grow side (`pulsar` repo), small and exact

1. `lib/store.ts` — `Campaign.vertical: "ecommerce" | "mini_drama"`
   (the comment at line ~120 already anticipates this). Audit every
   `vertical === "ecommerce"` assumption (creative directions, adgroup
   presets, fit factors, discover) and make `mini_drama` a first-class,
   explicitly handled value — never a fall-through.
2. **Handoff endpoint** `POST /api/internal/studio/handoff`:
   - Auth: shared secret in a header (`x-studio-key`), constant-time
     compared against `STUDIO_HANDOFF_KEY`. Reuse `guardApiRequest` for the
     same-origin/shape checks it provides; this route is server-to-server.
   - Body (zod): `{ batch_id (uuid), merchant_ref, title: {external_id,
     name_zh, name_en}, campaign: {name, destination_url, market, goal,
     budget, notes}, creatives: [{ creative_id (uuid), source_url,
     kind:"video", caption, on_screen_text, angle, hook, format,
     source: {episode_number, start_ms, end_ms} }] }`.
   - **Idempotent on `batch_id`**: a second call with the same batch
     returns the existing campaign id, HTTP 200, no duplicate. Persist the
     mapping in the store.
   - Stages each `source_url` into Grow's own upload storage (download
     server-side, validate size/type like the uploader does), then creates
     the campaign with `vertical: "mini_drama"`, `creativeMode:
     "generated"`, `status: "pending_approval"`, one `Creative` per row
     with `provider: "pulsar-studio"`, `review: "approved"`, and the
     hypothesis fields (`angle`, `hook`, `format`) filled — Grow's own
     comment says results should attribute to an idea, not a file.
   - Response: `{ campaign_id, status, creatives: [{creative_id, file}] }`.
3. **Merchant mapping**: `merchant_ref` is Studio's producer external id.
   Map it to a Grow merchant (create on first sight with `locale: "zh"`,
   category `mini_drama`; store the ref on the merchant for reverse lookup).
   Identity/advertiser assignment stays operator-driven as today.
4. **Read-back endpoints** for Studio, same auth:
   `GET /api/internal/studio/campaigns/:id` (status + creatives + review
   state) and `GET /api/internal/studio/campaigns/:id/metrics` (whatever
   the dashboard already aggregates — spend, impressions, clicks, CTR,
   conversions where present). Read-only, no new metrics pipeline.
5. Tests in Grow's existing test style: idempotency (same batch twice →
   one campaign), auth rejection, staging failure → no half-created
   campaign, `mini_drama` handled by every vertical-switching module.

Do not touch the launch job, review polling, or metrics sync.

## 6. Phase B — Studio side, the Promote module

**Code boundary (must):** everything new lives in `lib/promote/`,
`app/(producer)/producer/titles/[id]/promote/` (pages), and
`app/api/titles/[id]/promote/` (routes). Reuse existing primitives by
import; do not edit them without a note in your summary:
`lib/jobs.ts runFindClips` / `runCreativePack` (clip scoring, hooks,
angles — already produce `Clip` and `Variant` rows), `lib/subtitle-video.ts`
(`styledSrt`, the ffmpeg burn — extend, don't fork, if you need trimming),
`lib/data/storage.ts`, `lib/qc.ts`.

**Data model (must, both layers):** add to `lib/types.ts` and implement in
`lib/data/fixture.ts` AND `lib/data/supabase.ts` (plus a migration
`supabase/migrations/0003_promote.sql`; keep fixture as the reference
behavior like the rest of the app):

- `promo_batches` — id, title_id, producer_id, brief (destination url,
  market, goal, budget, spoiler tolerance, emphasis, exclusions — shape is
  *your call*), status (`draft | generating | review | approved |
  handed_off | failed`), grow_campaign_id, handoff_at, created_by.
- `promo_creatives` — id, batch_id, episode_id, start_ms, end_ms,
  render_path, poster_path, hook, on_screen_text, caption (the TikTok ad
  text — distinct from burned subtitles and from the on-screen hook; keep
  all three separate fields), angle, format, hypothesis (free text), status
  (`rendering | ready | approved | rejected | revised`), review_note,
  revision_of (previous creative id), version, cost/job refs.
- Authorization: producer-scoped exactly like titles (`requireTitleEditor`
  / `core.can_edit_title()`); viewer role read-only; staff may preview,
  may not act; foreign titles are not-found. External id prefix: `pb_` for
  batches, `pc_` for creatives (add to the established list).
- Every model call goes through `runJob` with an idempotency key and
  `cost_cents`; render jobs are ffmpeg (cost 0) but still audited.

**Producer flow — the shape is fixed, the design is yours:**

1. Entry from a title page: a Promote stage that is obviously *different*
   from localization (different verb, different color of primary action
   — but gold `.btn-approve` stays reserved for the producer's approval
   click, here "approve creatives").
2. A brief step that asks for intent, not ad settings (destination,
   market, goal/budget, what to emphasize, what never to show). Your call
   how much is form vs. conversation.
3. Generation → a pack of 6–8 variants across distinct hypotheses (cold
   open cliffhanger, character POV, recap/trailer control, etc.). Use the
   clip finder's timecodes + hooks as the seed; render each clip with
   Studio's burned subtitles (English by default; bilingual is a style
   option the burn already supports). Show real progress — the codebase
   has a pattern (elapsed + estimate bar, `genbar` classes).
4. Review cockpit in phone format: approve/reject per variant, note on
   reject, editable hook/caption, source episode+timecode visible,
   "generate another like this" / "change only the opening" — revisions
   keep `revision_of` lineage. Batch approve. *Your call* on layout,
   density, and whether an optional storyboard checkpoint exists before
   rendering (it must not be a mandatory step).
5. Handoff: one button, enabled when ≥1 creative is approved, calling
   Grow's endpoint with `batch_id` idempotency; on success the batch is
   `handed_off` and locked (revisions after that start a new batch). Show
   the Grow campaign status and, later, metrics on the same screen,
   labeled by hypothesis ("Episode 3 cliffhanger", "UGC reaction").
6. Fixture mode must work end-to-end without Grow: implement a
   `GROW_HANDOFF=mock` mode that records the handoff locally and fakes a
   `pending_approval → live` progression, so the demo never depends on a
   second server. Real mode uses `GROW_BASE_URL` + `STUDIO_HANDOFF_KEY`.

**UI guardrails (must):** existing tokens/classes in `app/globals.css`
and `app/studio-v3.css`, no CSS framework, no external fonts, no emoji.
All copy through `locales/_keys/*.json` + `node scripts/merge-locales.mjs`
(producer chrome defaults to Chinese; write both languages). Content text
keeps its `lang`. Nothing above font-weight 600.

## 7. Handoff protocol details (must)

- Studio → Grow files are served from Studio's media route
  (`/api/media/...` requires a session); for server-to-server staging,
  generate a short-lived signed URL or a one-time token route under
  `app/api/titles/[id]/promote/.../file` that Grow can fetch with the
  shared key. Never make episode masters reachable this way — renders only.
- Retries: Studio may call handoff repeatedly with the same `batch_id`
  (network failures, double clicks); Grow's idempotency makes that safe.
  Studio stores `grow_campaign_id` only after a 2xx.
- Never send producer PII beyond the merchant ref and title names.
- Log every handoff attempt in Studio's audit events.

## 8. Metrics read-back

Studio polls Grow's read endpoints on page load (no background sync in
V1). Display reuses Studio's own components/tokens — do not embed Grow's
UI. Preserve attribution ids in the schema now (tracking/destination
params on the creative) even though episode-start / paid-unlock
attribution is explicitly postponed.

## 9. Definition of done

- `npm test`, `npm run typecheck`, `npm run lint` green in Studio; Grow's
  own checks green in `pulsar`. Run `npm run build` only when no dev
  server is running (shared `.next`).
- Fixture mode: create batch → generate → review → approve → mock handoff
  → status/metrics visible, all without a database or keys.
- Tests: batch/creative authorization (producer scope, viewer read-only,
  staff cannot act, foreign not-found), idempotent handoff (mock mode),
  revision lineage, render path safety (only renders exposed), and the
  Grow-side tests in §5.
- `docs/decisions.md` entry + `CLAUDE.md` edits from §2; a short
  `docs/promote.md` describing the flow, env vars, and mock mode.
- Summary lists: files touched outside your boundary (should be near
  zero), env vars added, and the Supabase provisioning blocker.

## 10. Do not

- Do not build object storage, resumable multipart upload, a job queue,
  scene detection, or UGC/avatar generation in this pass. Clips from the
  existing clip finder + burned subtitles are the MVP creative.
- Do not add Reach/Stage anything beyond this Grow handoff.
- Do not edit the localization workspace, the subtitle studio, ingest, or
  QC (Claude's territory) — if you need a change there, write it in your
  summary as a request.
- Do not loosen the localization uploader's subtitle requirement; if
  Promote accepts video-only episodes, that is its own entry point.
- Do not write Grow campaigns to Studio's store or vice versa; ids cross,
  records do not.
