# Pulsar Studio

Localization for Chinese mini dramas, delivered as SUBTITLES. The producer
(制片方, the mini-drama company) uploads an episode's subtitles (video
optional), presses one button, and gets an American adaptation they edit
themselves — Original (Chinese + literal English) beside Adapted, WHY THIS
CHANGE under every rewrite — then finalizes and downloads the clean English
script and, when a video is attached, the subtitled video. No approval
round-trips, no dubbing, no scene confirms. Studio only: nothing is linked
to Reach or Stage. The newest entries at the top of
[docs/decisions.md](docs/decisions.md) override every other doc.

- Business context and vocabulary: [PRODUCT.md](PRODUCT.md)
- Engineering conventions and invariants: [CLAUDE.md](CLAUDE.md)
- Decisions (newest first, V1 definition on top): [docs/decisions.md](docs/decisions.md)
- Deck transcription with slide numbers: [docs/deck-notes.md](docs/deck-notes.md)
- Build plan, data model, review of the founding draft: [docs/](docs/)

## Two portals, one app

| Portal | Who | Chrome | Routes |
|---|---|---|---|
| Admin | Pulsar staff | English (default set in `app/(admin)/layout.tsx`; cookie wins) | `/titles`, `/titles/new`, `/titles/[id]` (episodes, status, cost to date, export), `/titles/[id]/episodes/[n]` (Adaptation workbench), `/titles/[id]/pack` (creative pack + clip finder), `/producers` |
| Partner | Producer | Chinese (default set in `app/(producer)/layout.tsx`; cookie wins) | `/producer` (their titles), `/producer/titles/[id]` (episodes + add new episodes), `/producer/titles/[id]/episodes/[n]` (the studio: continuous script sheet, player rail, edit panel, QC preflight, finalize, downloads) |

`middleware.ts` is the login wall: `/producer/*` for producers, everything
else for staff; staff may preview `/producer/*`. Flow: the producer ingests
an episode, runs the first pass, edits lines (3 alternatives per line on
request), and — once QC preflight shows no blocking issues — finalizes:
one click that freezes a hashed snapshot and approves it. Staff can still
`submitVersion` + approve on behalf (admin path with evidence). Changes
after finalize fork a new draft. Exports render from the approved snapshot
when one exists, else the in-review one, else the current draft (the file
header says which). Producer deliverables: the clean English script report
(`format=script`) and the ffmpeg-burned subtitled video.

## Try it offline

Requires Node 20+ — and ffmpeg on PATH for the burned-subtitle video
(`winget install ffmpeg` / `brew install ffmpeg`); every other deliverable
works without it. Fixture mode is the default and needs no Supabase project
and no API keys; AI buttons render an "unavailable" state until the selected
provider's key is set.

```bash
npm install
cp .env.example .env.local
npm run dev                  # http://localhost:3200
```

Open `/login`. The fixture seed is empty: "Continue as producer" lands on
`/producer` with a blank workspace (the flow starts at 上传新剧), "Continue
as staff" on `/titles`. To watch the one-click adaptation work offline,
upload `docs/demo/aizailvtu-demo-ep1.srt` as an episode — fixture mode
replays the canned bank for exactly that script (`lib/demo-replay.ts`) and
translates nothing else; any other script gets a polite "not in the demo
corpus" refusal. The offline path for new material: staff open the episode
in the admin workbench and press **Start manual draft**, then the producer
types the English line by line — that path finalizes and exports exactly
like the AI one. Real model calls need `DEMO_REPLAY=0` plus a provider key.
Uploaded video in fixture mode is written to `.uploads/` (gitignored) and
served by `GET /api/media/[...path]`.

## Scripts

| Script | What |
|---|---|
| `npm run dev` | Next.js dev server on port 3200 (pulsar owns 3100, overlord 3000) |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | `tsc --noEmit` — must pass before a commit |
| `npm test` | Node test runner over `tests/*.test.ts` (ingest parsers, approval rules) |

`scripts/ingest-episode.ts` parses one subtitle file from the CLI (dry run by
default, `--write` to insert through the service-role client).

## Supabase mode

1. `cp .env.example .env.local`; set `DATA_SOURCE=supabase`,
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (server only), then choose either
   `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`, or
   `LLM_PROVIDER=openai` with `OPENAI_API_KEY`.
2. Apply `supabase/migrations/0001_init.sql` (schemas `core` and `studio`,
   RLS, approval functions, triggers).
3. In the Supabase dashboard, API settings, expose the schemas `core` and
   `studio`.
4. Create the Storage bucket `studio-media` (private) for episode video.
5. Create one auth user per producer and one per staff member; the
   `core.profiles` row decides which portal they get.

Every LLM call is a `studio.jobs` row with provider, usage and cost; the title
page sums it. Each first pass also retrieves relevant lines from Studio's
immutable approved snapshots, so approvals across every title become translation
memory without a second source of truth. Rows carry external ids (`ttl_`,
`ep_`, `sc_`, `ln_`, `ad_`, `ver_`,
`rw_`, `alt_`, `var_`, `clip_`) that appear in exports; uuids never leave the
repo.

## Layout

```
app/(admin)/       Staff portal: titles, workbench, pack, producers.
app/(producer)/    Partner portal under /producer.
app/api/           Route handlers: guardApiRequest -> requireStaff/requireProducer -> zod -> work.
app/login/         Login page; fixture-mode persona buttons.
components/        Shared UI. No CSS framework; classes only from app/globals.css.
lib/ingest/        SRT / VTT / ASS / script-text parsers, scene splitting.
lib/data/          Data layer (fixture and supabase behind one interface).
lib/data/fixture.ts  The fixture title 爱在旅途 used in DATA_SOURCE=fixture.
lib/llm.ts         Anthropic/OpenAI gateway, structured output, retries and cost accounting.
lib/translation-memory.ts  Approved-script extraction and scene-level retrieval.
lib/reference-memory.ts  Lower-trust retrieval from the licensed Tatoeba seed corpus.
lib/prompts/       Prompts for:
                   understand_title, understand_scene, first_pass, alternatives,
                   rewrite, propose_variants, find_clips.
lib/exports/       srt / vtt / csv / diff / brief / package, rendered on request.
lib/supabase/      Server (RLS) and service-role clients.
lib/               auth, api-guard, api-client, data-source, i18n, types, asr stub.
locales/           zh.json / en.json; agents write keys to locales/_keys/.
supabase/          migrations/0001_init.sql.
docs/              Decisions, plans, data model, deck notes.
tests/             Node test runner specs and fixtures.
scripts/           CLI ingest.
data/reference/    Attributed, licensed external translation-memory seed data.
public/fonts/      Self-hosted Outfit (Latin). No external hosts.
```

## Third-party data

The bundled Mandarin-English reference corpus contains text from
[Tatoeba](https://tatoeba.org). Sentence text is licensed per row under
[CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/deed.en) or
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Contributor
usernames and source sentence IDs are retained in
`data/reference/tatoeba-cmn-eng.json`; filtering and attribution details are
in `data/reference/README.md`.
