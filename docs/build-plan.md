# Pulsar Studio — build plan

Scope: V1 as defined at the top of `docs/decisions.md` (2026-09-03). That
entry overrides anything below until this file is brought in line; this
revision brings it in line. In one line: upload a Chinese short drama
(video optional) or its script and receive an approved U.S. script plus a
paid-social creative brief, exported — with a partner portal where the
producer (制片方) reviews and approves. Nothing is linked to Reach or Stage
in V1. Studio only.

Weeks are counted from the scaffold (Week 0, 2026-09-03) and aligned to
deck slide 15 where Studio has a milestone: Week 4 "Studio workflow usable,
first title adapted"; Week 6 "first 3-5 titles adapted"; Week 10 "pilot
complete". "Adapted" here means: every episode's version approved by the
producer (in their portal, or on their behalf with evidence), the script
exported as SRT/VTT/CSV, the bilingual diff on file, the creative pack and
clip shortlist exported as the brief. Reach launches ads from the exported
brief by hand; no integration is built or planned before Week 10.

Two portals, one Next.js app, one Supabase project. Admin portal: Pulsar
staff, English chrome, route group `app/(admin)`: `/titles`, `/titles/new`,
`/titles/[id]`, `/titles/[id]/episodes/[n]` (the workbench),
`/titles/[id]/pack`, `/producers`. Partner portal: the producer, Chinese
chrome, route group `app/(producer)`, URLs under `/producer`: `/producer`,
`/producer/titles/[id]`, `/producer/titles/[id]/episodes/[n]`. Nothing else
ships as a route. Schema references are to `docs/data-model.md`; product
decisions to `PRODUCT.md` and `docs/decisions.md`.

## Budget reality

Two founders. A runs product and producer relationships and is roughly half
an engineer; B is full time. Every week below lists a hand-operated
fallback: the thing a founder does by hand so the milestone is honest even
if the software behind it is not finished. Nothing in this plan is faked; a
fallback is a person, never a mock.

Rule for both engineers: every screen renders from `DATA_SOURCE=fixture`
with no Supabase project and no API keys before it is considered done; AI
buttons render an "unavailable — set ANTHROPIC_API_KEY" state without one.

Rule for scope: no dubbing, TTS, render, burn-in, Stream push, thumbnail
image generation, Reach handoff table or Stage release work is scheduled
before the media-track gate (under "Later"). Schema shapes for those may be
sketched in `data-model.md`; no tables in `0001`, no UI, no jobs, no plan
weeks.

Success test (from `decisions.md`, three real titles): (1) a usable
first-pass adaptation; (2) a native English-speaking editor saves
meaningful time; (3) 10-20 usable TikTok/Meta ad concepts per title; (4)
those concepts become ads the Reach workflow can launch. Each week below
names which test it moves.

## Week 0 — the scaffold (today)

What the repo holds at the start of the day:

- Config: `package.json` (Next 14.2, React 18.3, `@supabase/ssr`,
  `supabase-js`, zod, `@anthropic-ai/sdk`, tsx; `dev` on 3200, `typecheck`,
  `test`), `tsconfig.json` (strict, `@/`), `next.config.js`, `.env.example`
  (Supabase keys, `DATA_SOURCE`, `ANTHROPIC_API_KEY`; the Cloudflare and
  `DUBBING_API_KEY` lines are unused in V1 and stay for the media track),
  `.gitignore` (`.uploads/` for fixture-mode video), `.claude/launch.json`.
- Design system: `app/globals.css` — tokens, light and dark, the CLASS
  INDEX comment, app shell, workspace breakpoints, `.bilingual`,
  `.btn-approve` (gold, the partner's one action); `app/layout.tsx`
  (cookie locale, theme stamped before first paint; the per-portal
  defaults — admin en, partner zh — are set by `app/(admin)/layout.tsx`
  and `app/(producer)/layout.tsx` when no cookie exists, produced with the
  screens below);
  `components/{ThemeToggle,LangToggle}.tsx`; Outfit 400/500/600
  self-hosted in `public/fonts` (no external hosts; partners are in
  mainland China).
- i18n: `lib/i18n.ts` (`t(locale, key)`, cookie `pulsar_studio_locale`),
  `components/locale.tsx` (`useT`), `locales/{zh,en}.json` (~75 keys),
  `locales/_keys/{auth,ingest}.json` (per-agent key files merged into the
  dictionaries by the merge step; nobody edits `zh.json` / `en.json`
  directly).
- Auth wall with both portals: `middleware.ts` (deny-by-default; `/producer/*`
  for producers, everything else staff, staff may preview `/producer`;
  pages bounce to `/login`, API calls get 401 JSON), `lib/auth.ts`
  (`getSession`, `requireStaff`, `requireProducer`, `canReadTitle`; fixture
  personas staff admin "Ruobin" and producer approver "陈总" for the fixture
  producer), `/login` with fixture-mode "continue as staff / producer"
  buttons and Supabase magic-link / password in supabase mode,
  `app/api/auth/{dev,login,logout,session}`, `app/auth/callback`,
  `lib/api-guard.ts` (`guardApiRequest`, `apiError`), `lib/api-client.ts`
  (`getJson`, `postJson`).
- Ingest parser: `lib/ingest/{index,subtitles,script-text,scenes,text}.ts`
  — `ingestEpisodeFile(input, filename)` for SRT / VTT / ASS / txt scripts
  with speaker prefixes, BOM/CRLF, overlap and monotonicity warnings,
  gap-based scene segmentation; `scripts/ingest-episode.ts` (dry run by
  default); `tests/ingest.test.ts`, 15 tests over 7 fixture files
  (`npm test`).
- Supabase clients: `lib/supabase/{client,server}.ts`
  (`createServerSupabase` under RLS; `createServiceSupabase` for scripts
  and jobs only); `lib/data-source.ts` (`fixture` default).
- Docs: `PRODUCT.md`, `README.md`, `docs/{decisions,deck-notes,data-model,
  build-context-draft,build-context-review}.md`, this file.

What it proves: the stack is real, both portals are gated, the parser
handles real partner files, and the UI can run with no database. What it
does not prove: any table, any screen past `/login`, any LLM call, any
export.

What the build workflow produces the same day (each by its own agent,
against the API contract in the workflow prompt; paths fixed, shapes from
`lib/types.ts` and `lib/data/index.ts`):

- `supabase/migrations/0001_init.sql`: `core` (`producers`, `profiles`,
  `titles`, `episodes`, `audit_events`, `ext_id(prefix)`) and `studio`
  (`characters`, `scenes` with staff status `draft | approved`, `lines`,
  `adaptations`, `versions` with `snapshot` + `sha256`, `adapted_lines`,
  `line_alternatives`, `scene_decisions` — the only partner writes,
  `variants`, `clips`, `jobs` with `idempotency_key`, usage and
  `cost_cents`); version statuses `draft | in_review | approved` plus the
  bookkeeping value `superseded` (set only by `fork_version` /
  `approve_version`, never shown; no `withdrawn`, no `withdraw_version`);
  `submit_version`, `approve_version` (partner, or staff
  admin `on_behalf` with an evidence note), `fork_version`, `decide_scene`,
  `choose_alternative`, `select_variant`; freeze trigger on `in_review` /
  `approved` versions; RLS (producers read own titles, versions only where
  `status in ('in_review','approved')`, write only through
  `decide_scene` / `approve_version`); one bucket `studio-media`.
- `lib/types.ts` (hand-written from `docs/data-model.md` in Week 0,
  replaced by `supabase gen types` output in Week 1), the fixture title
  (one producer persona 陈总, one title with one timed episode and one
  untimed script-only episode, scenes in every state, versions in `draft`,
  `in_review` and `approved` so the partner screen renders every state,
  scene decisions of both kinds, alternatives, variants of every kind with
  one title and one hook selected, clips in every status, jobs with cost),
  `lib/data/{index, fixture,supabase}.ts` behind `lib/data-source.ts`.
- `lib/llm/*`: `understand_title`, `understand_scene`, `first_pass`,
  `alternatives`, `rewrite` (regenerate / shorten / instruction),
  `propose_variants`, `find_clips` — the seven V1 LLM job kinds, and the
  identifiers are the `studio.job_kind` enum values verbatim (plus the
  cost-0 bookkeeping kind `parse_subtitles` written by ingest; the rest of
  the enum is v1.1 / Later); structured outputs via zod, title
  bible and character sheet as a cached prefix, every call a `studio.jobs`
  row; `lib/asr.ts` stub returning "unavailable" (`transcribe_episode` is
  a job kind, v1.1).
- `lib/exports/*`: SRT, VTT, CSV, the bilingual diff, the creative brief and
  the title package (self-contained HTML), rendered on request by
  `GET /api/titles/[id]/export` from the approved snapshot when one exists,
  else the in-review one, else the current draft (the file header says
  which); no export files stored, no export jobs; external ids (`ttl_ ep_
  sc_ ln_ ad_ ver_ rw_ alt_ var_ clip_`) in every export, uuids never.
- API routes per the contract (admin: titles, ingest, workbench, lines,
  alternatives, choose, rewrite, scene status, submit, approve-on-behalf,
  fork, pack, clips, export, producers, `/api/media/[...path]`; partner:
  own titles, review payload, decide, approve).
- Admin screens: `/titles`, `/titles/new` (name, producer, synopsis,
  character notes), `/titles/[id]` (episodes with per-episode subtitle /
  video upload, status, cost to date, export), `/producers`;
  the workbench `/titles/[id]/episodes/[n]` (player when a video exists │
  Chinese lines, click to seek │ adapted line: English, why this version
  zh + en, tone shift, alternatives, regenerate, edit, approve scene;
  submit episode); `/titles/[id]/pack` (variants with the platform pick,
  clip finder with shortlist).
- Partner portal: `/producer`, `/producer/titles/[id]`,
  `/producer/titles/[id]/episodes/[n]` (bilingual review from the frozen
  snapshot, `is_major` first: approve scene / request alternative with a
  one-line reason / approve episode).
- `CLAUDE.md` (conventions and invariants; linked from `README.md` and
  `PRODUCT.md` as pending until this step lands), the locale merge (which
  also renames the scaffold's `term.partnerStudio` / `term.studioReview`,
  drops the `stage.*` keys, and rewrites `status.inReview` to "In partner
  review" / 审核中 per the `PRODUCT.md` vocabulary table), `README.md`
  brought in line.

Demo at the end of the day, fixture mode, no keys: log in as staff, open
the fixture title, walk the workbench, approve every scene, submit, log in
as the producer, decide each scene, approve the episode, export the diff.

Fallback: none; nothing is promised to anyone today.

## Week 1 — real project, real title, real first pass

Deliverable: a Supabase Pro project with `0001_init.sql` applied and the
two auth flows proven (a staff account, a producer account for the fixture
producer id); `lib/types.ts` checked against the applied schema; the first
real title created at `/titles/new` and ingested from the producer's
subtitle files on `/titles/[id]` (video for the first episodes uploaded to `studio-media` and
playing in the workbench); `understand_title`, `understand_scene`,
`first_pass` and `alternatives` run on real content with the never-invent
rule and the line-length budget (English fits the line's window when a
timecode exists); cost per job on `studio.jobs` and API cost to date on the
title page, compared with the table below.

Demo: `/titles` with the real title, one episode open in the workbench with
video, a real rationale and back-translation on a real line, alternatives
picked, cost to date on the title page.

Tables: none new. Routes: none new. Jobs: `understand_title`,
`understand_scene`, `first_pass`, `alternatives`, `rewrite`.

Sign-ups: Supabase Pro ($25/month; `core` and `studio` in exposed
schemas; `studio-media` bucket); Anthropic API key; a small VPS (2 vCPU)
or equivalent host for the one Node process. No ffmpeg, no Cloudflare, no
ASR provider this week.

Who: A: the producer's files and character notes, the title bible in
Chinese, reading every first-pass line of episode 1 against the source.
B: the project, migration and RLS proven from a real session, `lib/llm`
prompts tuned on the real title, cost recorded, fixture parity kept.

Fallback: if the files are late, a founder transcribes one episode into an
SRT by hand; if no clean subtitle file exists for the first title, the
first title is the one that has files. Success test moved: #1.

## Week 2 — creative pack, clip finder, editor time trials

Deliverable: `propose_variants` (5 titles, 10 hooks, 3 descriptions, 3-5
thumbnail concepts as text, ad angles) and `find_clips` (timestamp range,
hook, why, opening text, cut length) on the real title; `/titles/[id]/pack`
with the platform pick and the clip shortlist; the creative brief and title
package exported and handed to whoever runs Reach, who launches ads from
the file by hand (no integration, no shared table); editor time trials: a
native English-speaking editor edits two episodes cold and two with the
first pass, times recorded, the edit distance between AI text and final
text recorded per line (`authored_by` flips on edit).

Demo: the pack page for the real title; the brief as a file; the time-trial
numbers.

Tables: none new. Routes: none new. Jobs: `propose_variants`, `find_clips`.

Sign-ups: nothing new.

Who: A: the editor, the time trials, the brief in Reach's hands, the first
producer conversation about the pack (which angles they will not allow).
B: pack and clip prompts, the pack page, exports proven on a real approved
snapshot, the workbench fixes the editor asks for.

Fallback: if `find_clips` is not done, a founder shortlists scenes by hand
and enters them as clips through the same function so `clip_` ids are
minted the same way; if the editor is not available, A runs the trial and
the number is marked as a founder's. Success tests moved: #2, #3, #4 (by
hand).

## Week 3 — the partner reads it in their own portal

Deliverable: the first producer logs in to `/producer` with their own
account (magic link or password), reads one episode's bilingual review,
decides each scene, approves the episode; `needs_alternative` exercised
end to end: staff fork, edit, re-submit, partner re-decide; the on-behalf
path (`approve-on-behalf` with an evidence note) used only where the
producer prefers WeChat; the partner questions answered and recorded in
`docs/decisions.md`: do they want to localize themselves in the workbench
(a `producer` editor role), what counts as a major change, which ad angles
are off limits, how they want the diff delivered.

Demo: the producer persona on a phone, in Chinese, approving a scene and
requesting an alternative with a reason; the audit rows behind it; the
staff side receiving the reason and re-submitting.

Tables: none new. Routes: none new. Jobs: none new.

Sign-ups: nothing new.

Who: A: the read-through with the producer, the questions, the decisions
log. B: portal fixes from the read-through, RLS re-checked from the
producer's session (partner-count integration test: a second fixture
producer sees nothing of the first), on-behalf path, fork loop hardened.

Fallback: the diff sent as a file over WeChat and approval recorded on
behalf with the screenshot as evidence; the questions asked over a call
and written down. Success test moved: #1 confirmed by the owner.

## Week 4 — three real titles through (slide 15)

Deliverable: three real titles with every episode approved (in the portal
or on behalf), scripts exported as SRT/VTT/CSV, bilingual diffs on file,
creative packs and clip shortlists exported as briefs, ads launched from
them by hand; cost per title measured on each title page against the
table; idempotency proven by re-running a finished title and confirming
zero spend; the founder-intervention list (every place a person had to
step in) written down as Week 5's backlog. This is the success test and
the Week-4 milestone for Studio.

Slide 15 collision: the same Week 4 promises "Stage MVP live" (web player,
first title, payment sandbox) and "Reach workflow usable", all on the same
engineer. Studio's plan assumes Studio gets B for Weeks 1-4. If Stage takes
B from Week 3, Weeks 3 and 4 here slip by the same amount and the honest
reading of slide 15 for Studio is: workflow usable (Week 1's deliverable)
on time, first title adapted on time, three titles by Week 6 instead. That
choice is the founders', recorded in `docs/decisions.md` when made.

Demo to a partner: `/titles` with three titles at approved; one title's
cost to date; the partner portal on their own login; the brief that
became an ad.

Tables: none new. Routes: empty and error states on every existing route.
Jobs: none new; the seven at title scale.

Sign-ups: nothing new.

Who: A: titles 2 and 3 ingested, read-throughs with each producer, the
intervention list. B: hardening (resume after a failed pass, partial
first-pass recovery per scene, upload limits, media route Range
behaviour), cost roll-up, typecheck and fixture parity clean.

Fallback: scene boundaries adjusted by hand in the workbench; approval on
behalf with evidence for any producer not yet on their login; briefs
typed by a founder if the pack fails on a title, ids minted by the same
function. Success tests: all four measured on three titles.

## Weeks 5-6 — v1.1 ASR fallback, batch review, titles 4-5 (slide 15 Week 6)

Deliverable: titles 4-5 through the Week-1 path; `0002_transcribe.sql`
(`ALTER TYPE studio.job_kind ADD VALUE 'transcribe_episode'`; `ALTER TYPE
core.script_format ADD VALUE 'asr'`) and `lib/asr.ts` for real — ffmpeg
audio extract on the VPS (installed then), a hosted ASR provider, LLM
speaker attribution from the character notes, the episode flagged so the
editor knows the Chinese itself is unverified — built only if a title on
the slate has no subtitle file; batch review: approve all draft scenes of
an episode in one action (staff), approve all remaining scenes of a
version in one action (partner), on-behalf per episode batch with one
evidence note; the Week-4 intervention list worked down; title bible and
character notes editable on the title page so the cached prefix improves
title by title.

Demo: a 60-episode title approved episode by episode in one sitting; an
ASR episode, if one exists, with its unverified flag in the workbench.

Tables: none new (ASR adds two enum values). Routes: none new; the title
page gains the bible editor. Jobs: `transcribe_episode` (conditional).

Sign-ups: an ASR provider only if needed (pay-as-you-go, about $0.01 per
audio minute or less); ffmpeg on the VPS the same day.

Who: A: titles 4-5, read-throughs, the second and third producers' logins.
B: batch actions, ASR job if needed, bible editor, backlog.

Fallback: a title without subtitle files and without ASR is dropped from
the Week-6 slate rather than transcribed by hand at scale; batch approval
falls back to per-scene, slow but correct.

## Weeks 7-8 — second producers, .docx, portal polish

Deliverable: two or three producers on their own logins; `.docx` export of
the adapted script and the diff for producers who forward documents;
"approved on your behalf" visible in the portal for anything approved in
Weeks 1-6, with a request-alternative action that reopens the scene via
`fork_version`; the partner questions from Week 3 turned into decisions
(a producer editor role is built here only if two producers asked for it);
media-track gate reviewed against its definition.

Demo: a producer disputing an on-behalf approval from their phone and the
resulting fork on the staff side.

Tables: none new. Routes: none new; `export?format=docx`. Jobs: none new.

Sign-ups: nothing new.

Who: A: producer onboarding, the gate review. B: docx writer, portal
polish, dispute path.

Fallback: producers who prefer WeChat keep getting the file; the on-behalf
path stays.

## Weeks 9-10 — pilot complete (slide 15)

Deliverable: cost per title against the $2K line, from stored job rows on
every title page; the intervention list reduced to what is acceptable for
month 3; time-trial numbers re-measured on the last title; the deferred
decisions revisited in `docs/decisions.md`: media-track go/no-go, whether
Reach reads from Studio (the shared table under "Later") or keeps taking
the brief as a file, whether a results view is wanted. Reach's and Stage's
pilot results reach the founders as their own reports, keyed by the
`var_` / `clip_` ids printed in the brief; nothing is ingested into Studio.

Demo: for one title, what it cost to adapt, from job rows, beside Reach's
report of which hooks paid; nothing computed at view time that the
pipeline did not measure.

Tables: none new. Routes: none new. Jobs: none new.

Who: A: the month-3 slate conversation using the cost line and Reach's
reports. B: cleanup, hardening, the month-3 backlog.

Fallback: none needed; measurement is what is promised.

## Later

### The Reach / Stage contract (moved out of V1)

Nothing is linked in V1; Reach launches from the exported brief and Stage
does not read Studio. What returns, and when: when the founders decide
Reach should read from Studio rather than from a file — a view over
`studio.variants` and `studio.clips` (`v_exported_variants`: `var_` /
`clip_` / `ttl_` ids, `text_en`, `text_zh`, `rationale_en`, `selected`,
`source_version_external_id`, `exported_at`, `reach_ref`), an
`export_variants()` function writing `creative_exports` rows, service-role
read for Reach, producers never; when a title has a video Stage will play
— `studio.releases`, `release_episode()`, `v_released_episodes` with the
approved version's VTT. The ids are already minted in V1, so nothing is
renumbered when these land. Recorded in `docs/decisions.md` first.

### Media track — gated

Gate: at least three titles approved end to end through the Week-1/2/3
path, at least one producer approval in their own portal, cost per title
measured on the title page, the Week-4 intervention list below ten items.
Until every item holds nothing on this track is scheduled, whatever the
deck says about dubbing.

When it opens, and only for a title that has a video: Cloudflare Stream for
delivery (`episodes.source_stream_uid`, `register_stream`); one dubbing
provider trialled on the free episodes of one title (stock voices, lip
sync off; `dub_episode`, `character_voices`, `episode_renders`,
`render_episode`; per-minute cost recorded; overrun measured against line
windows, where `shorten` earns the syllable estimate); thumbnail image
generation from the text concepts; marketing boundaries
(`marketing_boundaries`, slide 10) and the boundary attestation on media
variants; `cut_variant` for trailers and hook cuts. Sign-ups then:
Cloudflare Stream, the dubbing provider's lowest tier, ffmpeg on the VPS
unless ASR installed it.

### Planned, not built, not blocked

Editor role and assignment UI (month 4-5, first U.S. editors); comments
(the one-line reason on `needs_alternative` covers the pilot); version
history UI (one version row per submission exists; only the current one
is shown); producer monthly report; feedback ingestion from Reach and
Stage and a results view per title; share links for forwarding the diff;
audience pockets; beats UI; Voice A/B; new-title incubation (slide 19);
native app; brand marketplace.

## Cost

All figures are estimates until measured; every LLM call records usage
and `cost_cents` on its job row, and the title page shows the sum. Model
rates assumed: Opus-class $5 / $25 per million input / output tokens,
Sonnet-class $2 / $10, cache reads about a tenth of input, cache writes
about 1.25x; re-check against the provider's price list when the first
title's spend is recorded in Week 1. Thinking tokens bill as output; the
ranges below allow for them.

Per title (75 episodes, ~110 minutes, ~1,500 lines in ~150 scenes; a
50-episode title is about two thirds of this):

| Item | V1 (LLM only, optional ASR) | Later, with dubbing |
|---|---|---|
| `understand_title`, Sonnet-class, once (bible, character sheet from synopsis, notes and sampled lines) | $0.10-0.50 | $0.10-0.50 |
| `understand_scene`, Sonnet-class, per scene, cached bible | $1-3 | $1-3 |
| `first_pass`, Opus-class, per scene, cached bible (rewrite, back-translation, rationale zh/en, tone, tags, `is_major`) | $10-25 | $10-25 |
| `alternatives` and `rewrite` (regenerate / shorten / instruction), Opus-class, ~20% of lines | $5-12 | $5-12 |
| `propose_variants`, once (5 titles, 10 hooks, 3 descriptions, 3-5 thumbnail concepts, angles) | $0.50-1 | $0.50-1 |
| `find_clips`, Sonnet-class, per episode over scene contexts | $1-3 | $1-3 |
| `transcribe_episode` (v1.1; only when no subtitle file is delivered) | $0-1 | $0-1 |
| Video in Supabase Storage (~3 GB per title, inside Pro's 100 GB) | ~$0 | ~$0 |
| Dubbing retakes after shorten (TTS re-runs) | 0 | $10-30 |
| End-to-end dubbing, ~110 min at $0.50-2.00/min | 0 | $55-220 |
| ffmpeg mux / burn-in on the VPS | 0 | ~$0 |
| Cloudflare Stream storage, 2-3 versions | 0 | $1-2/month |
| Thumbnail images, trailer and hook cuts | 0 | $1-5 |
| **External APIs per title** | **$20-45** | **$85-300** |
| Against slide 13's $2K per title | 1-2% | 4-15% |

The balance of the $2K is editorial hours, and in V1 that balance is nearly
all of it: the script pipeline costs tens of dollars per title, so the
per-title line is a labor line, which is what the Week-2 time trials
measure.

Per month at pilot scale (Weeks 4-10, 3-5 titles; delivery, when a title
has video, booked under Stage's line per slide 14):

| Item | V1 | Later, with dubbing |
|---|---|---|
| Supabase Pro (database, auth, `studio-media` storage and egress inside plan limits) | $25 | $25 |
| VPS or equivalent host (one Node process; ffmpeg only for ASR / media) | $20-40 | $20-40 |
| Anthropic API (3-5 titles at $20-45 plus interactive rewrites) | $100-300 | $100-300 |
| ASR (v1.1, only for titles without subtitle files) | $0-5 | $0-5 |
| Cloudflare Stream storage (~1,100 min) | 0 | ~$6 |
| Cloudflare Stream delivery | 0 | Stage's $500-1,000 line |
| Dubbing provider plan floor | 0 | $99-330 |
| Dubbing / TTS minutes | 0 | $300-1,100 |
| **Studio's share of the API line** | **$145-370** | **$550-1,800** |
| Slide 14 AI/dubbing/creative APIs, all three products | $500-1,000 | $500-1,000 |

V1 fits inside slide 14's line with most of it left for Reach's creative
tooling; full dubbing of every title does not fit, which is why the media
track is gated.
