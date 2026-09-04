# Session handoff — Pulsar Studio

Updated 2026-09-03 (evening), after the producer-first pivot. If a new
session picks this up: read `docs/decisions.md` top entry first, then
`CLAUDE.md`, then `docs/demo-script.md` to see what the demo does.

## Where things stand

Working, verified in the browser end to end (typecheck clean, 31 tests):

- **Both portals.** Admin (`/titles`, workbench, pack, producers; en chrome)
  built earlier today by the V1 workflow + Codex. Partner portal
  (`/producer/*`, zh chrome) rebuilt producer-first this evening: poster-grid
  作品管理 → title console with step strip → episode workspace
  (一键生成美式改编 → edit / 换个说法 → 确认 per scene → gold 确认定稿 →
  exports). Staff-submitted episodes still route to the review screen.
- **Self-serve authorization.** Producers (reviewer/approver) create titles
  under their own company, upload scripts, generate, edit; per-title guard
  `requireTitleEditor` (fixture) / `core.can_edit_title()`
  (`supabase/migrations/0002_producer_selfserve.sql`). `finalizeVersion` =
  freeze + sha + per-scene sign-off + approve, producer-approver only.
- **Demo replay.** Fixture mode never calls a model: `lib/demo-replay.ts`
  replays `data/fixture/canned.ts` (all of ep3 + ep4 pre-authored, incl.
  alternatives and scene contexts). `docs/demo/aizailvtu-demo-ep1.srt`
  uploads a fresh title that replays 22/22 lines. `DEMO_REPLAY=0` + key =
  real calls.
- **API key**: `.env.local` exists (gitignored) — paste `ANTHROPIC_API_KEY=`
  there.
- Research: `docs/ui-research.md` (mini-drama consoles → portal patterns).
- Demo walkthrough: `docs/demo-script.md`.

## Known rough edges

- The embedded preview browser paints stale frames on deep programmatic
  scrolls (DOM verified correct; real browsers unaffected).
- Editing a line after its scene is confirmed does not flip the scene back
  to 待确认 (accepted for V1; same gap as the staff flow).
- `0002_producer_selfserve.sql` references `studio.build_version_snapshot` /
  `assert_version_ready` helpers that 0001 may inline — reconcile when a
  Supabase project is actually provisioned (none exists yet; fixture is the
  reference behavior).
- Nothing committed since the initial README commit; commit + push pending
  founder go-ahead.

## Next

1. Founder walk of `docs/demo-script.md`; polish whatever reads wrong.
2. Commit and push (ask first).
3. Week 1 (docs/build-plan.md): Supabase Pro, apply 0001 + 0002, expose
   schemas, buckets, real key, first real producer script.
