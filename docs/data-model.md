# Pulsar Studio — data model

**V1 (2026-09-03).** This file is the schema for the V1 defined at the top
of `docs/decisions.md` ("V1 definition"): upload a Chinese short drama
(video optional) or its script, receive an approved U.S. script plus a
paid-social creative brief, exported, with a partner portal where the
producer (制片方) reviews and approves. Two portals (`app/(admin)`,
`app/(producer)`), one Next.js app, one Supabase project, nothing linked to
Reach or Stage. Where this file and `decisions.md` disagree, `decisions.md`
wins. Everything the earlier drafts specified for Reach, Stage, pockets,
comments, media creatives, dubbing and feedback is kept under **Later** so
no column shape is foreclosed; none of it is in `0001_init.sql`.

Spec for `supabase/migrations/0001_init.sql` and the migrations after it.
Synthesized 2026-09-03 from three schema proposals and two judges; re-cut
the same day to the V1 definition. Where proposals conflicted the
resolution is stated inline under **Resolved**.

Read with `docs/decisions.md` (overrides everything here on conflict),
`docs/build-plan.md` (which week each table lands), `docs/deck-notes.md`
(slide numbers cited below) and `PRODUCT.md` (vocabulary; why the review
gate is shaped this way).

## 0. Conventions

- `uuid` primary keys, `default gen_random_uuid()`. `created_at timestamptz
  default now()` on every table (omitted below). `updated_at` maintained by
  trigger where marked.
- `*` = `not null`.
- **External id** (`external_id text* unique default core.ext_id('xx')`):
  `prefix || '_' || base32(gen_random_bytes(8))`. Generated once, never
  updated (trigger), never reused. In V1 these appear in exports only
  (section 6); there is no consumer yet. uuids never leave this repo.
- Every `studio.*` row carries `title_id` (denormalised, trigger-derived
  from the parent FK and rejected on mismatch) so every RLS policy is one
  function call, no join chains.
- Enum labels are English snake_case. UI labels for them go through `t()`.
  Nothing in the database is translated by the UI locale; content columns
  say which language they hold in their name (`_zh`, `_en`).
- Money in cents only on `jobs.cost_cents` (provider spend). The title page
  shows `sum(cost_cents)` over the title's jobs as "API cost to date".
- **Tags.** `[W4]` = created in `0001_init.sql`; this is the V1 set and the
  only set with UI, jobs and plan weeks. `[v1.1]` = the ASR migration, after
  subtitle ingest works. `[Later]` = a later migration; the column shape is
  decided now so nothing is foreclosed, but there is no UI, no job and no
  plan week until the founders schedule it. A `[Later]` tag on a single
  column means the column is added by the Later migration that needs it,
  not by `0001`.
- Enum values tagged Later are added with `ALTER TYPE ... ADD VALUE` in the
  migration that needs them; `0001` creates only the `[W4]` values.

## 1. Namespacing and ownership in the one Supabase project

Two Postgres schemas in V1, two reserved:

| Schema | Owner | Contents |
|---|---|---|
| `core` | Studio repo | producers, profiles, titles, episodes, audit_events (Later: audience_pockets, feedback_events) |
| `studio` | Studio repo | everything else below |
| `reach` | Reach repo, later | campaigns, ad groups, spend (empty now) |
| `stage` | Stage repo, later | viewers, unlocks, payments (empty now) |
| `public` | nobody | stays empty |

Rules:

- A table lives in `core` only if two products would write it, or another
  product needs it by id on a hot path. Everything else is product-owned.
- V1 shares nothing with Reach or Stage: no view, no manifest table, no
  Reach id shown. External ids are still minted on every row so a later
  handoff is a view over existing columns, not a backfill (section 6,
  Later).
- `supabase/migrations/` in this repo is the only migration directory for
  `core` and `studio`. Reach and Stage would consume `supabase gen types
  --schema core --schema studio` output; they do not migrate these schemas.
- Consequences already accepted: `core` and `studio` must be added to
  "Exposed schemas" in the Supabase API settings (a missing entry returns
  empty results, not an error); every client call names the schema
  (`supabase.schema("studio")`); type generation runs per schema.

## 2. Tables

### `core`

```
core.producers  [W4]                       -- 制片方. The partner. Never "studio" in code or copy.
  id uuid pk, external_id* ('pr'), slug text* unique,
  name_zh text*, name_en text, contact_email text, contact_wechat text,
  deliverables jsonb default '{}'           -- per-producer defaults; per-title copy lives on titles

core.profiles  [W4]                        -- 1:1 with auth.users; the role model
  id uuid pk references auth.users on delete cascade,
  kind core.user_kind* ('staff','producer'),
  staff_role core.staff_role ('admin','editor')          -- required iff kind='staff'
  producer_id uuid references core.producers,            -- required iff kind='producer'
  producer_role core.producer_role ('approver','reviewer','viewer')  -- required iff kind='producer'
  display_name text*,
  locale text check (locale in ('zh','en'))   -- nullable, NO default. Null = the route group decides (decision #8:
                                             --   app/(admin)/layout.tsx passes en, app/(producer)/layout.tsx passes zh,
                                             --   the pulsar_studio_locale cookie wins). Nothing writes it before month 3.
  -- check: exactly one of (staff_role) / (producer_id, producer_role) is set
  -- A2: producers review; they do not upload. One partner account per producer is enough for the pilot; a producer
  --     row may also exist with no login yet (approvals recorded on_behalf, see versions).
  -- Fixture personas (lib/auth.ts): staff admin "Ruobin", producer approver "陈总" for FIXTURE_PRODUCER_ID.

core.titles  [W4]
  id uuid pk, external_id* ('ttl'), producer_id uuid* references core.producers,
  name_zh text*, name_en text, genre text,
  synopsis_zh text, synopsis_en text,        -- optional at creation (/titles/new); the story in a paragraph
  character_notes text,                      -- free text supplied at creation: who is who, relationships, register. With the
                                             --   synopsis this is the TITLE BIBLE that understand_title, first_pass and
                                             --   propose_variants read; [v1.1] also the speaker-attribution input for ASR.
  logline_zh text, logline_en text,          -- one line each, written by understand_title; staff-editable
  episode_count int, source_locale text default 'zh-CN',
  status core.title_status* default 'selected'
    ('candidate','selected','ingesting','adapting','in_review','approved','live','ended','dropped'),
  china_metrics jsonb default '{}',          -- slide 18 (01): views, retention, payment; nullable inputs
  localization_effort text,                  -- slide 18 (02): one line from understand_title
  deliverables jsonb default '{}',           -- {clean_master:bool, dialogue_stem:bool, script_or_srt:bool, music_note:text}
  notes text,                                -- staff free text. Holds the major-change criteria agreed with the producer
                                             --   (decision #11) until marketing_boundaries exists [Later].
  license_start date, license_end date,
  updated_at

core.episodes  [W4]
  id uuid pk, external_id* ('ep'), title_id uuid* references core.titles on delete cascade,
  number int*, name_zh text, name_en text, duration_ms int,   -- duration from the video probe when present, else the last cue
  source_script_path text,                   -- OPTIONAL storage path (bucket studio-media, <title_id>/<episode_id>/...; fixture:
                                             --   .uploads/) of the delivered subtitle or script file, kept for reference when
                                             --   the ingest route stores it. The parsed scenes + lines are the record; the
                                             --   file is THE primary ingest input (A1), not a required column.
  script_format core.script_format,          -- ('srt','vtt','ass','txt','docx') [W4]; 'asr' [v1.1] when the file was
                                             --   produced by transcribe_episode. Set at ingest from the extension by
                                             --   lib/ingest; parse_subtitles raises on mismatch.
  has_timecodes bool* default false,         -- set by parse_subtitles: true when every line parsed with a start/end.
                                             --   false = script-only view (A1): no player, no VTT/SRT export, syllable
                                             --   budget not checked. txt/docx scripts are false unless they carry
                                             --   [hh:mm:ss] markers the parser recognises.
  video_path text,                           -- OPTIONAL. Supabase Storage path in bucket studio-media (<title_id>/<episode_id>/...)
                                             --   or, in fixture mode, a path under .uploads/. Served through
                                             --   GET /api/media/[...path] (fixture: Range streaming; supabase: 302 to a
                                             --   signed URL). Gives the editor a player beside the line and is the input of
                                             --   [v1.1] transcribe_episode. Null for most pilot episodes and may stay null.
  source_stream_uid text,                    -- [Later] Cloudflare Stream uid of the original video, when a title needs
                                             --   delivery; registered by register_stream, never pushed through the app.
  dub_requested bool default false,          -- [Later] per-episode dubbing opt-in
  unique (title_id, number)

core.audit_events  [W4]                    -- append-only. INSERT only, for every role. Written inside the functions below.
  id bigserial pk, at timestamptz default now(),
  actor_id uuid references core.profiles, actor_kind core.actor_kind* ('staff','producer','service'),
  product text* default 'studio', action text*,   -- submit_version | decide_scene | approve_version | fork_version | ...
  table_name text*, row_id uuid, title_id uuid, producer_id uuid,
  before jsonb, after jsonb, note text, channel text   -- channel: in_app | wechat | email | script

core.audience_pockets  [Later]             -- first-class tags Reach would target against; enum-like, never free text.
  id uuid pk, slug text* unique, label_en text*, label_zh text*, description text,
  active bool default true, sort int

core.feedback_events  [Later]              -- reserved shape; created when Reach/Stage emit. Idempotent re-ingest.
  id uuid pk, source core.feedback_source* ('reach','stage'),
  subject_external_id text*,                 -- var_ / clip_ / ver_ / ep_ / sc_ / ttl_
  title_id uuid*, pocket_id uuid references core.audience_pockets,
  metric text*,                              -- spend_cents, viewers, cost_per_viewer, first_payments, first_payment_rate,
                                             -- watch_ms, completion_rate, drop_off, unlocks, revenue_cents, ctr, cvr
  value numeric*, sample_n int, platform text, campaign_ref text,
  period_start date*, period_end date*, payload jsonb, received_at timestamptz*,
  unique (source, subject_external_id, metric, coalesce(pocket_id, uuid_nil()), coalesce(campaign_ref,''), period_start, period_end)
```

### `studio` — W4 (V1)

```
studio.characters  [W4]                    -- per title, from understand_title (seeded from character_notes); editable. The
                                           --   adapted name lives here (one adaptation per title); per-adaptation recasting
                                           --   is character_voices [Later]
  id uuid pk, title_id uuid* references core.titles on delete cascade,
  name_zh text*, name_en text, notes text,
  unique (title_id, name_zh)

studio.scenes  [W4]                        -- the working unit: context block + the STAFF working status (slide 1 "Approve Scene")
  id uuid pk, external_id* ('sc'), title_id uuid*,
  episode_id uuid* references core.episodes on delete cascade,
  number int*, start_ms int, end_ms int,     -- null only when the episode has_timecodes = false (trigger checks)
  context_zh text, context_en text,          -- the Context block on slide 1; one understand_scene call, editable
  status studio.scene_status* default 'draft' ('draft','approved'),
                                             -- STAFF working status, per scene (not per version): the checklist submit_version
                                             --   reads. Set by staff through POST .../scenes/[sceneId]/status, which checks
                                             --   every source line is ready; the partner never writes it — partner decisions are
                                             --   scene_decisions, per version.
  status_by uuid references core.profiles, status_at timestamptz,   -- stamped by trigger on every status change
  unique (episode_id, number)

studio.lines  [W4]                         -- SOURCE lines. The storage grain. Write-once text; order immutable after ingest.
  id uuid pk, external_id* ('ln'), title_id uuid*,
  scene_id uuid* references studio.scenes on delete cascade,
  seq int*,                                  -- lib/ingest seq; unique within the episode, so (scene_id, seq) is also unique
  speaker text,                              -- raw label from the cue (ASS Name field, VTT <v> tag, "李薇：" prefix); may be null
  character_id uuid references studio.characters,   -- resolved by understand_title from speaker + character_notes; editable
  start_ms int, end_ms int,                  -- from the subtitle cue; null only when the episode has_timecodes = false (trigger)
  duration_ms int generated always as (end_ms - start_ms) stored,   -- null when untimed
  text_zh text*,                             -- write-once: trigger rejects UPDATE of text_zh once any version exists
  literal_en text,                           -- literal translation: the diff baseline, written by first_pass
  merged_into_id uuid references studio.lines,   -- never hard-delete a source line; a merge points it at the survivor.
                                             --   [Later] written by the Merge toolbar action; always null in V1
  unique (scene_id, seq)

studio.adaptations  [W4]                   -- one per title in V1 (general U.S. audience). Exists as a row so versions and
                                           --   variants have a stable parent when pockets arrive [Later].
  id uuid pk, external_id* ('ad'), title_id uuid* references core.titles on delete cascade,
  target_locale text* default 'en-US', label text* default 'U.S. general',
  display_title_en text,                     -- the U.S. title used in export headers. Written by select_variant() when a
                                             --   kind='title' variant is selected; staff may also set it directly.
  created_by uuid references core.profiles,
  pocket_id uuid references core.audience_pockets,   -- [Later] null = general U.S.; the unique key widens to include it then
  unique (title_id, target_locale)
  -- Created by POST /api/titles together with the title row; nothing in the V1 UI creates a second one.

studio.versions  [W4]                      -- the gate. Grain = (adaptation, episode). One row per submission; in_review and
                                           --   approved are frozen so an export reproduces.
  id uuid pk, external_id* ('ver'), title_id uuid*,
  adaptation_id uuid* references studio.adaptations on delete cascade,
  episode_id uuid* references core.episodes,
  number int*, parent_version_id uuid references studio.versions,
  status studio.version_status* default 'draft' ('draft','in_review','approved','superseded'),
                                             -- 'superseded' is bookkeeping only, set by fork_version (an in_review row that
                                             --   was forked) and approve_version (the previously approved row); no UI shows
                                             --   it and the producer never sees it. No 'withdrawn' state in V1.
  submitted_at timestamptz, submitted_by uuid references core.profiles,     -- staff "Approve episode" = submit_version()
  approved_at timestamptz, approved_by uuid references core.profiles,       -- partner "Approve episode" = approve_version()
  approval_mode studio.approval_mode ('in_app','on_behalf'),
  approval_evidence text,                    -- the evidence NOTE (free text: "approved over WeChat 2026-09-10, screenshot on
                                             --   file"); required when on_behalf (POST .../approve-on-behalf { evidence_note }).
                                             --   No evidence bucket in V1; a screenshot attachment is [Later].
  approval_note text,
  snapshot jsonb, snapshot_sha256 text,      -- written ONCE by submit_version(): episode, scenes (context, status), source
                                             --   lines, adapted lines (text_en, back_translation_zh, change_type, is_major,
                                             --   rationale_*, tone_note_*, tags, external ids), characters. Never
                                             --   alternatives, never jobs. sha256 over the canonical JSON. What the partner
                                             --   reviews and what every export renders from.
  -- No export columns in V1: GET /api/titles/[id]/export renders SRT/VTT/CSV/diff/brief/package on request from the
  --   snapshot (approved when one exists, else in_review, else the current draft; the file header says which). [Later]
  --   export_vtt_path / export_diff_path (bucket studio-exports) if a stored copy per run is ever wanted.
  updated_at,
  unique (adaptation_id, episode_id, number)
  -- partial unique: one live approved per (adaptation, episode)
  create unique index versions_one_approved on studio.versions (adaptation_id, episode_id) where status = 'approved';
  -- partial unique: at most one open draft per (adaptation, episode)
  create unique index versions_one_draft on studio.versions (adaptation_id, episode_id) where status = 'draft';

studio.adapted_lines  [W4]                 -- the diff. One row per replacement, anchored to a source line range.
  id uuid pk, external_id* ('rw'),          -- so an individual rewrite is gradeable later without a backfill
  title_id uuid*, version_id uuid* references studio.versions on delete cascade,
  scene_id uuid* references studio.scenes,
  line_id uuid references studio.lines,      -- null = added line. [Later] the "Add line" toolbar action; V1 writes 1:1 rows only
  merges uuid[] default '{}',                -- extra source lines absorbed. [Later] "Merge" / "Split" (two rows, same line_id)
                                             --   toolbar actions; the V1 workbench has no line toolbar (PRODUCT.md)
  seq int*,                                  -- order within scene on the adapted side
  start_ms int, end_ms int,                  -- derived from covered source range unless an editor overrides; null when untimed
  text_en text,                              -- null when change_type = 'cut'
  back_translation_zh text,                  -- 回译: what the producer actually judges; written by first_pass / rewrite /
                                             --   choose_alternative (a hand edit keeps the last AI back-translation in V1)
  change_type studio.change_type* ('keep','literal','rewrite','tighten','tone','cultural','pacing','cut','add'),
  is_major bool default false,               -- slide 10 "major change"; LLM-proposed, editor-editable, sorts the partner's list
  rationale_en text, rationale_zh text,      -- 为什么这样改编 (slide 7). zh required on every changed line before submit
                                             --   (submit_version guard, not a column constraint: the editor may save partial work)
  tone_note_en text, tone_note_zh text,      -- 语气调整 (slide 7)
  tags text[] default '{}',                  -- 这一版本 tags (slide 7): 'tighter','more_emotional',... vocabulary in lib/types.ts, not a table
  syllables_est int,                         -- model's estimate; compared to the duration budget only when timed
  authored_by studio.author_kind* default 'ai' ('ai','editor'),   -- drives the per-line chip; 'producer' [Later]
  model text, prompt_version text,           -- provenance when authored_by='ai'
  ai_text_en text, ai_rationale_zh text,     -- the AI first pass is retained when an editor overwrites; never regenerated
  edited_by uuid references core.profiles, updated_at,
  unique (version_id, scene_id, seq)

studio.line_alternatives  [W4]             -- "ideas to adapt the dialogue" (slide 7): up to 3 alternative rewrites for ONE
                                           --   adapted line, generated on demand. Internal editor tooling; never in the diff,
                                           --   never seen by the producer, in the snapshot only through the line it was
                                           --   chosen into.
  id uuid pk, external_id* ('alt'), title_id uuid*, version_id uuid*,   -- title_id, version_id trigger-derived from adapted_line_id
  adapted_line_id uuid* references studio.adapted_lines on delete cascade,
  seq int*,                                  -- 1..3 within one alternatives job; a second job appends 4..6
  text_en text*, back_translation_zh text,
  rationale_zh text*, rationale_en text,     -- same {zh,en} pair rule as adapted_lines; zh required so the editor can show it
  tags text[] default '{}',                  -- same vocabulary as adapted_lines.tags
  syllables_est int,
  model text*, prompt_version text*,         -- always AI-authored; provenance is mandatory
  job_id uuid references studio.jobs,        -- cost attribution
  chosen bool default false, chosen_by uuid references core.profiles, chosen_at timestamptz,
  unique (adapted_line_id, seq)
  create unique index line_alternatives_one_chosen on studio.line_alternatives (adapted_line_id) where chosen;
  -- Why a table and not columns/jsonb on adapted_lines: each alternative needs its own provenance (model, prompt_version,
  --   job_id -> cost_cents) and its own rationale pair; "chosen" must be a flip, not a blob rewrite; the count per line is
  --   variable and a later grade on an alternative that lost needs a stable row. guard_frozen applies (parent version).

studio.scene_decisions  [W4]               -- the PARTNER's decision, per scene per version. Replaces the three-stage
                                           --   scene_reviews rail of the earlier drafts (no stages, no assignment).
  version_id uuid* references studio.versions on delete cascade,
  scene_id uuid* references studio.scenes,
  title_id uuid*,                            -- trigger-derived from version_id
  decision studio.scene_decision* ('approved','needs_alternative'),
  note text,                                 -- the one-line reason; check (decision <> 'needs_alternative' or note is not null)
  decided_by uuid* references core.profiles,
  decided_at timestamptz* default now(),
  decided_kind studio.decided_kind* default 'producer' ('producer','staff_on_behalf'),
  primary key (version_id, scene_id)
  -- The ONLY partner write in the schema, and only through studio.decide_scene(). A decision may be changed while the
  --   version is in_review (upsert on the primary key); frozen once approved. No comments thread: the note is the reason.

studio.variants  [W4]                      -- the creative pack, TEXT ONLY: 5 titles, 10 hooks, 3 descriptions, 3–5 thumbnail
                                           --   concepts as text, ad angles (slide 7 Hook 选项 / 标题选项). Produced by
                                           --   propose_variants from the approved script and the title bible.
  id uuid pk, external_id* ('var'), title_id uuid* references core.titles on delete cascade,
  adaptation_id uuid* references studio.adaptations,
  kind studio.variant_kind* ('title','hook','description','thumbnail_concept','ad_angle'),
  text_en text*, text_zh text,               -- the option itself; zh = back-translation the producer would read
  rationale_en text, rationale_zh text,      -- why this option
  tags text[] default '{}',                  -- angle vocabulary ('betrayal','revenge','secret_identity','romance','cliffhanger',...)
                                             --   in lib/types.ts, not a table
  selected bool default false,               -- THE PLATFORM PICK. Set only via select_variant(); one per (title, kind) for
                                             --   kinds 'title' and 'hook'; other kinds are never selected (check).
  status studio.variant_status* default 'candidate' ('candidate','dismissed'),
  model text, prompt_version text, job_id uuid references studio.jobs,   -- provenance; null model = typed in by staff
  created_by uuid references core.profiles, updated_at
  create unique index variants_one_selected on studio.variants (title_id, kind) where selected;
  -- check: (selected = false) or (kind in ('title','hook') and status = 'candidate')
  -- Later (media variants, on this table, not a new one): kinds 'thumbnail','opening','trailer','clip' [ALTER TYPE];
  --   pocket_id, source_version_id, scene_id, start_ms, end_ms, storage_path, stream_uid, is_selection_test, is_major,
  --   boundary_id, boundary_attested_by/at, producer_decision, producer_decided_by/at; statuses 'ready','exported','retired'.

studio.clips  [W4]                         -- the CLIP FINDER: best scenes to advertise, per episode. Together they are the
                                           --   ad brief for a human editor (decisions.md screen 3). Internal in V1.
                                           --   Table, TS type and API name are all `clips` (`/api/titles/[id]/clips/...`,
                                           --   `{ clips }`); "clip suggestion" is the prose term only.
  id uuid pk, external_id* ('clip'), title_id uuid*,
  episode_id uuid* references core.episodes on delete cascade,
  adaptation_id uuid references studio.adaptations,
  rank int*,                                 -- 1 = strongest, within the episode
  start_ms int*, end_ms int*,                -- the timestamp range; requires episodes.has_timecodes (find_clips refuses untimed)
  scene_ids uuid[] default '{}',             -- the scenes the range covers (sc_ ids in exports)
  hook_en text*,                             -- the hook line for the cut
  why_en text*, why_zh text*,                -- why it could work, {en, zh} pair from one structured call
  opening_text_en text,                      -- suggested on-screen opening text
  cut_length_s int,                          -- recommended cut length in seconds
  angle text,                                -- one of the ad-angle vocabulary (same list as variants.tags)
  status studio.clip_status* default 'suggested' ('suggested','shortlisted','dismissed'),
  model text, prompt_version text, job_id uuid references studio.jobs,
  unique (episode_id, rank)

studio.jobs  [W4]                          -- every LLM call, plus one cost-0 bookkeeping row per ingest. Idempotent; carries cost.
  id uuid pk, title_id uuid, episode_id uuid, version_id uuid,
  kind studio.job_kind*                      -- identifiers are the SAME as the lib/llm module names in build-plan.md
    [W4] LLM  ('understand_title',           -- title bible + script -> characters, loglines, localization_effort (one call per title)
               'understand_scene',           -- context_zh / context_en for one scene
               'first_pass',                 -- literal_en + adapted line per source line of one scene, with rationale pair,
                                             --   tone note, tags, back-translation, is_major proposal
               'alternatives',               -- up to 3 rows in line_alternatives for one adapted line
               'rewrite',                    -- one line: instruction "regenerate" | "shorten" (syllable budget) | free text;
                                             --   refreshes back_translation_zh with the new text
               'propose_variants',           -- the creative pack for one title (variants of every kind)
               'find_clips')                 -- clips for one episode (or every timed episode of the title)
    [W4] cost-0 bookkeeping, no provider:
              ('parse_subtitles')            -- POST .../ingest: file -> scenes + lines (+ has_timecodes) via lib/ingest;
                                             --   srt/vtt/ass/txt. Scene breaks come from the parser (cue gaps). Written so
                                             --   the episode's ingest state is derivable from jobs (section 4).
    [v1.1]    ('transcribe_episode')         -- ASR from video_path -> a VTT written to source_script_path, script_format='asr',
                                             --   LLM speaker attribution from character_notes, flagged for a human check;
                                             --   then parse_subtitles as usual. lib/asr.ts returns "unavailable" until then.
    [Later]   ('back_translate',             -- refresh back_translation_zh after a hand edit (V1: hand edits keep the last AI one)
               'export_vtt','export_diff','export_brief',   -- stored export copies (V1 renders exports on request, no job)
               'register_stream',            -- validates a Cloudflare Stream uid, reads duration
               'export_reach',               -- builds the Reach manifest (section 6, Later)
               'voice_take','dub_episode',   -- dubbing / TTS / Voice A/B
               'render_episode',             -- burn-in, dubbed video, Stream push
               'cut_variant'),               -- media creatives
  target_type text*, target_id uuid*,
  idempotency_key text* unique,              -- e.g. first_pass:{version_id}:{scene_id}:{prompt_version}
  status studio.job_status* default 'queued' ('queued','running','done','failed','cancelled'),
  provider text, model text, input jsonb, output jsonb, error text,
  usage jsonb,                               -- tokens / chars / minutes as the provider reports them
  cost_cents int, heartbeat_at timestamptz, started_at timestamptz, finished_at timestamptz
  -- V1 runs every kind inline in the route handler (no worker); the row is still written first so a crash leaves a
  --   'running' row with a stale heartbeat, and so cost is recorded even when the handler fails after the provider call.
```

### `studio` — Later

Shapes decided; no UI, no jobs, no plan weeks. Nothing here is in
`0001_init.sql`. Column comments are unchanged from the first draft except
where a V1 dependency moved.

```
studio.comments  [Later]                   -- Notes & Comments (slide 1). Not in V1: the partner's one-line note on a
                                           --   needs_alternative decision is the only feedback channel.
  id uuid pk, title_id uuid*, version_id uuid* references studio.versions on delete cascade,
  scene_id uuid* references studio.scenes,
  adapted_line_id uuid references studio.adapted_lines on delete set null,
  author_id uuid* references core.profiles,
  visibility studio.comment_visibility* default 'internal' ('internal','producer'),   -- producer authors forced to 'producer' by trigger
  kind studio.comment_kind* default 'note' ('note','change_request'),
  body text*, lang text* check (lang in ('zh','en')),  -- stored as typed; never translated
  parent_id uuid references studio.comments, resolved_at timestamptz, resolved_by uuid

studio.creative_exports  [Later]           -- the manifest handed to Reach; the "shared table" of a future handoff.
  id uuid pk, external_id* ('cx'), title_id uuid*, adaptation_id uuid, pocket_id uuid,
  variant_ids uuid[]*, manifest jsonb*,      -- see section 6 (Later); manifest is frozen at export (UPDATE revoked)
  status studio.export_status* default 'ready' ('ready','sent','acknowledged','retired'),
  exported_by uuid*, exported_at timestamptz, reach_ref text   -- Reach's own id; status -> acknowledged when set
  -- with it: studio.export_variants(variant_ids, adaptation_id), studio.v_exported_variants, variant statuses
  --   'ready','exported','retired' and the ready/exported trigger.

studio.releases  [Later]                   -- the ONLY thing Stage would read. Insert only via release_episode().
  id uuid pk, external_id* ('rel'), title_id uuid*,
  version_id uuid* references studio.versions, episode_id uuid* references core.episodes,
  stream_uid text*,                          -- REQUIRED: a release exists only when the episode has a video on Cloudflare Stream
  subtitle_vtt_path text*,                   -- the approved version's VTT, stored then ([Later] versions.export_vtt_path; sidecar)
  scene_map jsonb,                           -- [{scene_external_id, start_ms, end_ms}] so Stage can key drop-off to sc_ ids
  render_id uuid,                            -- FK to studio.episode_renders when a burned-in / dubbed render replaces the sidecar
  boundary_id uuid,                          -- FK to studio.marketing_boundaries
  released_by uuid*, released_at timestamptz default now(), withdrawn_at timestamptz
  -- trigger: version.status = 'approved' AND episode.has_timecodes AND stream_uid not null
  --          AND title.license_end is null or >= today
  -- with it: studio.release_episode(version_id, stream_uid, subtitle_vtt_path), studio.v_released_episodes,
  --   roles stage_reader / reach_reader.

studio.beats  [Later]                      -- annotation layer over a line RANGE. Never the diff unit, never versioned.
  id uuid pk, title_id uuid*, episode_id uuid* references core.episodes on delete cascade,
  scene_id uuid references studio.scenes,
  kind studio.beat_kind* ('hook','setup','turn','reveal','cliffhanger','payoff','drop_risk'),
  from_line_id uuid references studio.lines, to_line_id uuid references studio.lines,
  label_en text*, label_zh text, why_us_viewers_drop_en text, why_us_viewers_drop_zh text,
  origin studio.origin* ('ai','human'), seq int*

studio.marketing_boundaries  [Later]       -- slide 10. Structured, versioned, producer-confirmed, immutable once confirmed.
  id uuid pk, title_id uuid* references core.titles on delete cascade, version_no int*,
  positioning_zh text, positioning_en text,
  likeness_rule studio.likeness_rule* default 'as_shot' ('as_shot','no_face_in_thumbnails','no_voice_clone','custom'),
  likeness_note_zh text, likeness_note_en text,
  no_promote_zh text[] default '{}', no_promote_en text[] default '{}',
  major_change_criteria_zh text[] default '{}', major_change_criteria_en text[] default '{}',
  minor_changes_delegated bool default false,
  free_text_zh text, free_text_en text,
  drafted_by uuid*, confirmed_by uuid references core.profiles, confirmed_at timestamptz,
  unique (title_id, version_no)
  -- trigger: no UPDATE once confirmed_at is set; at most one unconfirmed draft per title
  -- with it: studio.confirm_boundaries(boundary_id); variants.boundary_id / releases.boundary_id FKs.

studio.episode_renders  [Later]            -- rendered outputs tied to the version they came from.
  id uuid pk, title_id uuid*, version_id uuid* references studio.versions,
  episode_id uuid* references core.episodes,
  kind studio.render_kind* ('subtitle_vtt','dub_track','dubbed_video','burned_in'),
  storage_path text, stream_uid text, sha256 text,
  scene_map jsonb,
  status studio.job_status* default 'queued', job_id uuid references studio.jobs,
  unique (version_id, kind)

studio.character_voices  [Later]           -- per adaptation: adapted name + dubbing voice; a second adaptation can recast
  id uuid pk, title_id uuid*, adaptation_id uuid* references studio.adaptations on delete cascade,
  character_id uuid* references studio.characters,
  name_en text*, pinyin text,
  provider text, voice_id text,
  voice_kind studio.voice_kind default 'stock' ('stock','cloned'),   -- 'cloned' only when boundaries record likeness consent (trigger)
  unique (adaptation_id, character_id)

studio.voice_takes  [Later]                -- Voice A/B and per-line TTS. Decision #12: deferred entirely — not built, not fixtured.
  id uuid pk, title_id uuid*, version_id uuid* references studio.versions on delete cascade,
  scene_id uuid* references studio.scenes, adapted_line_id uuid references studio.adapted_lines,
  side studio.voice_side* ('literal','rewrite'),
  provider text*, voice_id text, voice_kind studio.voice_kind default 'stock',
  storage_path text, duration_ms int, overrun_pct numeric,
  status studio.job_status* default 'queued', job_id uuid references studio.jobs

studio.share_links  [Later]                -- signed, expiring, view-only zh diff for forwarding. In V1 the partner logs in,
                                           --   or receives the diff downloaded from /api/titles/[id]/export?format=diff (A2).
  id uuid pk, title_id uuid*, version_id uuid* references studio.versions,
  token_hash text* unique, expires_at timestamptz*, created_by uuid*, first_opened_at timestamptz, revoked_at timestamptz
```

### Functions and triggers (all `[W4]` unless marked)

All functions `security definer`, owned by a dedicated `studio_owner` role
(created in `0001_init.sql`; nobody logs in as it). Each state-changing
function writes a `core.audit_events` row in the same transaction.

- `core.ext_id(prefix text) returns text`.
- `core.derive_title_id()` BEFORE INSERT/UPDATE on every `studio.*` table:
  sets `title_id` from the parent and raises on mismatch. On
  `line_alternatives` it also derives `version_id`; on `scene_decisions`
  it also checks the scene belongs to the version's episode.
- `core.freeze_external_id()` BEFORE UPDATE: rejects a change to
  `external_id`.
- `studio.guard_timecodes()` BEFORE INSERT/UPDATE on `scenes`, `lines`,
  `clips`: `start_ms`/`end_ms` must be non-null when the episode
  `has_timecodes`; may be null otherwise (`clips` always
  requires them and refuses an untimed episode). `parse_subtitles` sets
  `has_timecodes` before it inserts lines.
- `studio.stamp_scene_status()` BEFORE UPDATE OF `status` on `scenes`: sets
  `status_by = auth.uid()`, `status_at = now()`. Staff only (RLS);
  `status_by`/`status_at` are UPDATE-revoked from `authenticated`. No
  automatic reset when an adapted line changes: the status is the staff
  checklist, and `submit_version` is the gate that reads it.
- `studio.guard_frozen()` BEFORE INSERT/UPDATE/DELETE:
  - on `adapted_lines`, `line_alternatives`: raise if the parent version's
    status is `in_review`, `approved` or `superseded` (a submitted version
    is what the partner is reading; edit = `fork_version`).
  - on `scene_decisions`: raise if the parent version's status is
    `approved` or `superseded`; `in_review` accepts inserts and updates
    (through `decide_scene` only — direct writes are revoked).
  - on `versions`: once `in_review`, `snapshot` and `snapshot_sha256` may
    not change; once `approved`, only `status -> superseded` may change
    ([Later] plus the export path columns, when stored exports exist).
  - `voice_takes` and `comments (kind='change_request')` join the list
    when they land [Later].
- `studio.guard_source_text()` BEFORE UPDATE on `lines`: `text_zh`,
  `start_ms`, `end_ms`, `seq` are write-once after any version exists for
  the episode. Corrections before that edit in place; re-segmentation after
  that = new episode row + fork.
- `studio.submit_version(version_id)` — **staff approval of the episode**
  ("Approve episode" in the admin portal). `draft -> in_review`. Guards:
  caller `is_staff()`; every scene of the episode has `scenes.status =
  'approved'`; every adapted line with `change_type <> 'keep'` has
  `rationale_zh` and `back_translation_zh` (the partner cannot be sent
  something they cannot read). Writes `snapshot` and `snapshot_sha256`,
  `submitted_at/by`. No export job: exports render on request from the
  snapshot. Audit row.
- `studio.decide_scene(version_id, scene_id, decision, note default null)`
  — **the only partner write.** Requires the version `in_review`. Caller
  is a producer `approver` or `reviewer` on the title (`decided_kind =
  'producer'`), or `is_staff_admin()` with a non-null `note` as evidence
  (`decided_kind = 'staff_on_behalf'`). `needs_alternative` requires
  `note`. Upserts the `(version_id, scene_id)` row; a partner may change
  their mind while the version is still `in_review`. Audit row with
  `channel`.
- `studio.approve_version(version_id, mode default 'in_app', evidence
  default null, note default null)` — **partner approval of the episode**.
  `in_review -> approved`. `mode = 'in_app'`: caller
  `is_producer_approver(title_id)` and every scene of the episode has a
  `scene_decisions` row for this version with `decision = 'approved'`.
  `mode = 'on_behalf'`: caller `is_staff_admin()` and `evidence` non-null;
  any scene without an `approved` decision gets one inserted with
  `decided_kind = 'staff_on_behalf'` and `note = evidence` so the record is
  complete. Sets `approved_at/by`, `approval_mode`, `approval_evidence`,
  `approval_note`; sets the previously approved version of the same
  (adaptation, episode) to `superseded`. No export job. The snapshot is not
  rewritten — it has been frozen since submit. Audit row carries `channel` (`in_app` | `wechat` |
  `email`). The partner's next login shows an on-behalf approval as
  "approved on your behalf".
- `studio.fork_version(version_id) returns uuid` — staff, from an
  `in_review` (after `needs_alternative`) or `approved` version. Creates
  `number = max+1`, `parent_version_id` set, status `draft`; copies
  `adapted_lines` (with `authored_by` preserved and `ai_*` retained).
  Copies nothing from `line_alternatives` (they belong to the round that
  generated them) and nothing from `scene_decisions` (decisions are per
  version). Scene statuses live on `scenes`, not on the version: the fork
  resets `scenes.status` to `'draft'` ONLY for scenes whose decision on the
  source version was `needs_alternative`; every other scene keeps
  `'approved'`, so the staff re-approve exactly the scenes the partner sent
  back. Forking an `in_review` version sets it to `superseded` (so the
  partner stops seeing it). The only way to change submitted text. Audit
  row. No `withdraw_version` in V1: a draft is edited or forked over, never
  withdrawn.
- `studio.choose_alternative(alternative_id)`: staff editor. Sets `chosen`
  on the row (clearing any other chosen alternative of the same line) and
  copies `text_en`, `back_translation_zh`, `rationale_*`, `tags`,
  `syllables_est`, `model`, `prompt_version` onto the adapted line;
  `authored_by` stays `'ai'` (the text is model-written), `edited_by` = the
  chooser; `ai_text_en` / `ai_rationale_zh` (the first pass) are untouched.
  Blocked by `guard_frozen`.
- `studio.select_variant(variant_id)`: staff. Only for `kind in ('title',
  'hook')` and `status = 'candidate'`; sets `selected` (clearing the
  previous pick of the same `(title_id, kind)`); for `kind='title'` copies
  `text_en` into `adaptations.display_title_en`. This is the platform pick
  shown in the export headers; it exports nothing and no consumer reads it
  yet.
- `[Later]` `studio.export_variants`, `studio.release_episode`,
  `studio.confirm_boundaries`, batch wrappers (a 60-episode title is
  approved one episode at a time in V1).
- Column-level `REVOKE UPDATE (status, submitted_at, submitted_by,
  approved_at, approved_by, approval_mode, approval_evidence,
  approval_note, snapshot, snapshot_sha256) ON studio.versions FROM
  authenticated`; `REVOKE INSERT, UPDATE,
  DELETE ON studio.scene_decisions FROM authenticated` (`decide_scene` and
  `approve_version` only); `REVOKE UPDATE (status_by, status_at) ON
  studio.scenes FROM authenticated`; `REVOKE UPDATE (selected) ON
  studio.variants FROM authenticated`; `REVOKE UPDATE (chosen, chosen_by,
  chosen_at) ON studio.line_alternatives FROM authenticated`. Status moves
  only through the functions above.
- Indexes: `adapted_lines (version_id, scene_id, seq)`,
  `line_alternatives (adapted_line_id, seq)`, `lines (scene_id, seq)`,
  `scenes (episode_id, number)`, `scene_decisions (version_id)`,
  `variants (title_id, kind)`, `clips (title_id, episode_id,
  rank)`, `jobs (status, heartbeat_at)`, `jobs (title_id)` (the cost sum),
  `audit_events (title_id, at)`.
- Views: none in V1. `studio.v_released_episodes` and
  `studio.v_exported_variants` are `[Later]` (section 6).

**Resolved: the three grains.** Line is the storage grain (timecoded source
text; untimed when the source is a bare script, A1). Scene is the container
and the working checkpoint (context block, staff status, partner decision).
Version at (adaptation, episode) is the gate and the only thing that
freezes. Beat is an annotation over a line range, never a row that lines
belong to (table Later). An adapted line maps to a source-line range
(`line_id` + `merges`), not 1:1, and a cut is a row with `text_en` null. An
alternative is a child of one adapted line, never a sibling in the diff.
The per-line chip on slide 1 is derived (`adapted_lines.authored_by` +
`scenes.status`), not a fourth machine.

**Resolved: two approvals, two tables.** `scenes.status` is the staff's
working state and persists across versions (a scene approved by the U.S.
editor stays approved through a fork unless the partner sent it back).
`scene_decisions` is the partner's answer to one submitted version and is
never copied forward. The three-stage rail (`ai_first_pass` →
`editorial_review` → `producer_approval`), assignment, batch wrappers and
the `review_scene` function of the earlier drafts are gone; they would
return as a Later migration only if the founders bring the rail back.

**Resolved: one adaptation per title.** `adaptations` exists as a parent
row (unique on `(title_id, target_locale)`), created with the title. Pockets
(`core.audience_pockets`, `adaptations.pocket_id`, a wider unique key) are
Later; nothing in V1 reads or shows them.

**Resolved: canonical vs variant.** `variants.selected` is the platform
pick (one title, one hook) and `adaptations.display_title_en` mirrors the
selected title; both are shown in the headers of the staff exports (script,
brief, package) and nowhere else — not in the partner's bilingual diff,
which carries only `titles.name_zh` / `name_en`.
Every other variant is a candidate the human editor may use in ads. There
is no export status, no Reach manifest and no "what Reach may test" flag in
V1; those are the Later columns listed on the table.

**Resolved: what the producer approves.** The script per episode version,
scene by scene, from the frozen snapshot: the Chinese source, the Chinese
back-translation, the English, the rationale in Chinese, `is_major` lines
first. The creative pack (variants, clip suggestions) is internal in V1 and
is not shown to the partner at all (`PRODUCT.md`, partner portal: "Nothing
internal"); the partner objects to the script through a `needs_alternative`
note on a scene. Later: individual
media variants when `is_major`, renders before release, boundaries.

## 3. Roles and RLS

Two user kinds, resolved from `core.profiles` (not JWT claims; nothing to
sync at invite time). The middleware (`middleware.ts`) is the same wall at
the route level: `/producer/*` for producers, everything else staff; staff
may preview `/producer`.

```sql
core.is_staff()          stable security definer:
  exists (select 1 from core.profiles where id = auth.uid() and kind = 'staff')
core.is_staff_admin()    ... and staff_role = 'admin'
core.my_producer_id()    select producer_id from core.profiles where id = auth.uid()
core.can_read_title(t)   is_staff() or exists (select 1 from core.titles x where x.id = t and x.producer_id = core.my_producer_id())
core.is_producer_approver(t)  can_read_title(t) and producer_role = 'approver'
core.is_producer_reviewer(t)  can_read_title(t) and producer_role in ('approver','reviewer')
```

Postgres roles: `anon` (no grants), `authenticated` (policies below),
`service_role` (ingest scripts only in V1), `studio_owner` (owns
the functions). Reserved for later: `reach_reader`, `stage_reader`.

| Table | staff | producer (own titles only) | service role |
|---|---|---|---|
| `core.producers` | all | select own | ingest |
| `core.profiles` | all | select self + same producer | none |
| `core.titles`, `core.episodes` | all | select | ingest |
| `core.audit_events` | select; insert via fns | select own `producer_id` rows | insert |
| `studio.characters/scenes/lines` | all (scene status via audited `set_scene_status`) | select | ingest |
| `studio.adaptations` | all | select | none |
| `studio.versions` | all (status and approval cols revoked) | select where `status in ('in_review','approved')` — never `draft` or `superseded` | none |
| `studio.adapted_lines` | all unless frozen | select where version visible | jobs (authored_by='ai' only) |
| `studio.line_alternatives` | all unless frozen; choose via fn | select where version visible (read-only; never rendered in the partner UI) | jobs insert |
| `studio.scene_decisions` | select; `decide_scene` on_behalf (admin) | select where version visible; write ONLY via `decide_scene` | none |
| `studio.variants` | all; select via fn | **none** — the creative pack is internal in V1 | jobs insert |
| `studio.clips` | all | **none** — the creative pack is internal in V1 | jobs insert |
| `studio.jobs` | select | none | all |
| `core.audience_pockets`, `core.feedback_events`, `studio.comments/creative_exports/releases/beats/marketing_boundaries/episode_renders/character_voices/voice_takes/share_links` [Later] | — | — | — |

Producer writes, in total: `studio.decide_scene()` and
`studio.approve_version()`. Nothing else.

Rules, stated as invariants for `CLAUDE.md`:

- RLS on every table, deny by default (same posture as `middleware.ts`).
- Producers never get INSERT/UPDATE/DELETE on any table. Every producer
  action is a function that checks `is_producer_approver` /
  `is_producer_reviewer` on `title_id` and writes an audit row in the same
  transaction.
- Producers never upload (A2). Ingest is staff or the service role; the
  `studio-media` bucket has no producer write policy.
- Staff cannot approve as the producer except through `approval_mode =
  'on_behalf'`, which requires `is_staff_admin()` and an evidence note or
  attachment, and which the producer's next login surfaces as "approved on
  your behalf". This is the pilot's WeChat reality made auditable, not
  hidden.
- Browser code and Next route handlers never hold the service-role key for
  content writes. `createServiceSupabase()` (`lib/supabase/server.ts`) is
  imported only by ingest scripts (and a job worker, when one exists); route handlers use
  `createServerSupabase()` under RLS after `requireStaff()` /
  `requireProducer()` (`lib/auth.ts`). A producer-facing route using the
  service key would write every approval as the server.
- Producer visibility begins at `in_review`. Drafts, superseded versions,
  `line_alternatives` in the UI, `clips`, `variants`, `jobs` and provider
  cost never reach a producer session.
- Storage bucket `[W4]`: ONE bucket, `studio-media` (private): episode
  videos and, when kept, the delivered subtitle / script file, under
  `<title_id>/<episode_id>/...`; read by `GET /api/media/[...path]` after
  `canReadTitle`, so a producer may watch their own title. Exports are
  rendered on request by `GET /api/titles/[id]/export`, never stored;
  on-behalf evidence is a text note on the version. `[Later]`:
  `studio-exports`, `studio-evidence`, `studio-audio`, `studio-renders`,
  `studio-thumbs`. Fixture mode stores uploads under `.uploads/`
  (gitignored) with the same relative paths.
- One integration test in `supabase/tests/`: sign in as a producer and count
  rows across every table; the count must equal the producer's own titles'
  rows and nothing else, and `clips` must be zero.

`DATA_SOURCE=fixture` bypasses all of this. The fixture is typed from
`lib/types.ts`, hand-written from this file in Week 0 and replaced by
`supabase gen types` output in Week 1 so the two paths cannot drift, and it mirrors
the producer-visible subset: one producer persona (陈总), one title with one
timed episode and one untimed script-only episode, versions in `draft`,
`in_review` and `approved`, scene decisions of both kinds, variants of
every kind with one title and one hook selected, clip suggestions in every
status, jobs with cost. No comments, no voice fixture.

## 4. State machines

**Title** (`core.titles.status`):

```
candidate -> selected -> ingesting -> adapting -> in_review -> approved -> live -> ended
                                                                              \-> dropped (from any state before live)
```

Two kinds of state. **Staff-moved** (written by staff in the UI):
`candidate`, `selected`, `ingesting`, `adapting`, `dropped`. `live` and
`ended` are `[Later]` values (enum labels exist in `0001` so no migration is
needed; no V1 UI moves a title to them — the founder's record that a title
went out arrives with the Stage release, `PRODUCT.md` "Producer control").
In V1 a title tops out at `approved`. **Derived** (a view over the title's
episode versions, not independently editable): `in_review` (any version
`in_review`) and `approved` (every episode has an approved version). A new
title starts at `selected`; `candidate` exists so the selection loop (slide
18) can be recorded later without a migration.

**Episode ingest** (`core.episodes`), not a status column; derived from
jobs: `source_script_path set -> parse_subtitles done (has_timecodes
decided, scenes + lines inserted) -> understand_title done once per title
-> understand_scene done per scene -> first_pass done per scene`. The
`/titles` list's "% adapted" is scenes with a first pass over scenes.
`[v1.1]` `transcribe_episode` precedes `parse_subtitles` when there is a
`video_path` and no script.

**Version** (`studio.versions.status`), per (adaptation, episode):

```
draft --submit_version() [staff]--> in_review --approve_version() [partner | admin on_behalf]--> approved --newer approved--> superseded
  ^                                    |
  |------- fork_version() (new draft; the forked in_review row -> superseded) ----+
```

- `submit_version` requires every scene `approved` by staff and
  `rationale_zh` + `back_translation_zh` on every changed line. It writes
  the snapshot; from here the version is frozen for `adapted_lines` and
  `line_alternatives`.
- `approved` is terminal except `-> superseded`. Any change =
  `fork_version()` -> new `draft`.
- Nothing else changes on an approved version; exports are rendered from
  the snapshot on request (approved, else in_review, else the draft).
- The diff shown on a second round is approved version vs new draft, not
  source vs draft again.

**Scene, staff status** (`studio.scenes.status`), per scene, persists
across versions:

```
draft <--staff toggle (POST .../scenes/[sceneId]/status; readiness enforced)--> approved
  ^
  +---- fork_version() resets to draft the scenes the partner marked needs_alternative
```

**Scene, partner decision** (`studio.scene_decisions.decision`), per
(version, scene), exists only while the version is `in_review` or later:

```
(none) --decide_scene()--> approved | needs_alternative (note required)     -- changeable while in_review; frozen on approved
```

Every scene `approved` is the precondition of `approve_version()`
(`in_app`). Any `needs_alternative` is the signal for staff to
`fork_version()`, edit, re-submit.

UI labels (fixed pairs, copied verbatim from the `PRODUCT.md` vocabulary
table, which is the source of truth; `locales/*.json` must use them): scene
status `draft` 草稿 / Draft · `approved` 已批准 / Approved; decision
`approved` 已批准 / Approved · `needs_alternative` 需要备选 / Needs
alternative; version `draft` 草稿 / Draft · `in_review` 审核中 / In partner
review · `approved` 已批准 / Approved · `superseded` has no label (never
shown).

**Variant** (`studio.variants.status` + `selected`):

```
candidate <--> dismissed          (staff; a dismissed row cannot be selected)
selected (platform pick; kinds title, hook) is set by select_variant() on a candidate row and is orthogonal to status
```

**Clip suggestion** (`studio.clips.status`):

```
suggested --> shortlisted | dismissed     (staff; both reversible; a re-run of find_clips replaces 'suggested' rows only)
```

The brief export takes `shortlisted` clips first, then `suggested` by rank.

**Job** (`studio.jobs.status`): `queued -> running -> done | failed |
cancelled`. A job whose `idempotency_key` already has `status = 'done'` is
never re-run; a `running` job with a stale `heartbeat_at` is retried by the
next request that needs it (V1 runs jobs inline; the sibling's
`lib/launch-job.ts` worker pattern returns when a queue exists).

## 5. Provenance and cost rules (schema-level)

- An AI first pass on an adapted line is stored once (`ai_text_en`,
  `ai_rationale_zh`, `model`, `prompt_version`). If an editor overwrites,
  `authored_by` flips to `editor` and the AI columns are retained. The
  first-pass job for a scene is keyed `first_pass:{version_id}:{scene_id}:{prompt_version}`
  and skips lines whose `authored_by <> 'ai'`. Re-generation is an explicit
  `rewrite` job (instruction `regenerate` | `shorten` | free text) on one
  line, never a silent re-run.
- Alternatives are stored as their own rows with their own `model`,
  `prompt_version` and `job_id`, keyed
  `alternatives:{adapted_line_id}:{prompt_version}:{batch}`. Choosing
  one copies it onto the line and keeps the row; the line's `model` /
  `prompt_version` then point at the alternative's job. A losing alternative
  is never deleted.
- Variants carry `model` / `prompt_version` / `job_id` like adapted lines;
  the job is `propose_variants` (`target_type = 'title'`), keyed
  `propose_variants:{title_id}:{adaptation_id}:{prompt_version}:{batch}`,
  run on the approved script (or the latest snapshot when nothing is
  approved yet — the pack page says which) and the title bible. A variant
  typed in by staff has `model` null and `created_by` set.
- Clip suggestions carry the same provenance; the job is `find_clips`
  (`target_type = 'episode'`), keyed
  `find_clips:{episode_id}:{version_id}:{prompt_version}`; a re-run
  replaces the episode's `suggested` rows and keeps `shortlisted` /
  `dismissed` ones (their `rank` is preserved; new rows take the free
  ranks).
- Every provider call writes `usage` and `cost_cents` on its job row before
  the handler touches content, so a failed write still records spend. A
  title's page shows "API cost to date" as `sum(cost_cents)` over its
  jobs; nothing else in the UI shows a cost or a grade the pipeline did not
  measure. `parse_subtitles` rows have `cost_cents = 0`; exports are not
  jobs in V1.
- Generated analytical text (scene context, rationale, tone notes, variant
  rationale, clip "why"; beat labels Later) is stored as a `{zh, en}` pair
  produced in one structured call. Adapted lines, alternatives and variant
  text are `en-US` with a zh back-translation column. Nothing is translated
  at render time.
- No API key (`ANTHROPIC_API_KEY` unset) means no job row is created: the
  UI renders the "unavailable" state and the fixture content stands.

## 6. External ids (for exports; no consumer yet)

Prefixes minted in V1: `ttl_` title · `ep_` episode · `sc_` scene · `ln_`
source line · `ad_` adaptation · `ver_` version · `rw_` adapted line ·
`alt_` line alternative · `var_` variant · `clip_` clip suggestion
(`pr_` producer exists on the row and is not exported). Opaque, stable,
never reused.

Where they appear in V1: the `.csv` script export (one row per adapted
line: `ver_`, `sc_`, `ln_`, `rw_`), the diff HTML (`ver_` in the header,
`sc_` per scene, `rw_` per changed line), the creative brief (`clip_` per
scene, `var_` per hook), the title package (`var_` per option), the VTT
(`ver_` in the header NOTE block; SRT carries nothing). Every export is
rendered on request by `GET /api/titles/[id]/export` from the approved
snapshot when one exists, else the in_review one, else the current draft;
the file header says which (`PRODUCT.md`, Export). Reach and Stage
consume none of this today; when a handoff exists it is a view over these
columns (below), not a backfill.

### Later — the Reach manifest and the Stage view

Unchanged from the earlier draft; nothing below exists in V1.

Prefixes added then: `cx_` creative export · `rel_` release.

**To Reach** — a text creative-set manifest, JSON, one per
`creative_exports` row, mirrored row-wise by `studio.v_exported_variants`
(the shared table; columns `cx_external_id`, `var_external_id`,
`ttl_external_id`, `ad_external_id`, `pocket`, `kind`, `text_en`,
`text_zh`, `rationale_en`, `tags`, `selected`, `source_version_external_id`,
`scene_external_ids`, `exported_at`, `reach_ref`). Reach stores the manifest
on its campaign record (today a JSON file in its `.data/`; the view if it
moves to Supabase). Reach turns hook lines and title options into TikTok /
Meta ad copy and tests any number of them; `selected` tells it which one
Stage shows so the landing matches. Media fields (`stream_uid`, `mp4_url`,
`duration_ms`, `boundary_version`, `storage_path`) are absent in W4 and
optional in the schema; Reach must not require them.

```json
{
  "export_id": "cx_...", "title_id": "ttl_...", "adaptation_id": "ad_...",
  "pocket": "women_35_plus",
  "display_title_en": "Love on the Line",
  "selected": {"title": "var_...", "hook": "var_..."},
  "variants": [
    {"id": "var_...", "kind": "hook", "text_en": "You only care about the merger.", "text_zh": "...",
     "rationale_en": "...", "tags": ["tighter","more_emotional"],
     "source_version_id": "ver_...", "scene_ids": ["sc_..."], "selected": false, "is_selection_test": false},
    {"id": "var_...", "kind": "title", "text_en": "Love on the Line", "text_zh": "爱在旅途",
     "rationale_en": "...", "tags": [], "source_version_id": null, "scene_ids": [], "selected": true, "is_selection_test": false}
  ]
}
```

`[Later]` the same manifest gains media variants: `{"kind": "clip",
"stream_uid": "...", "mp4_url": "...", "duration_ms": 14200, ...}` and a
top-level `boundary_version`. The shape above stays valid; Reach reads
`kind` and ignores fields it does not know.

**From Reach `[Later]`** — rows into `core.feedback_events` keyed by
`var_` and `cx_`, metrics `spend_cents`, `viewers`, `cost_per_viewer`,
`first_payments`, `first_payment_rate`, `ctr`, per `period_start/end` and
`pocket`. Idempotent on the unique key in section 2. In the pilot Reach's
results reach Studio as a screenshot or a spreadsheet, not as rows.

**To Stage `[Later]`** — `studio.v_released_episodes`: `rel_`, `ttl_`, `ep_`,
`ver_`, `stream_uid`, `subtitle_vtt_path`, `scene_map`, `display_title_en`,
episode number and name, `released_at`. Stage joins through this view and
never through `episodes` or a raw Stream uid. A row exists only when
`release_episode()` passed its guards: the episode has a video on Stream
and a timed, approved script; script-only titles produce no rows. Nothing
in V1 creates or reads it (no release to Stage).

**From Stage `[Later]`** — `core.feedback_events` keyed by `ep_` and
`sc_` (`watch_ms`, `completion_rate`, `drop_off`, `unlocks`,
`revenue_cents`) and by `var_` for the ad that brought the viewer. The
finest grain Stage can attribute is a scene; "which rewrite paid" is scene
-> version -> lines, inferred, and any grade shown for an `rw_` id is a
computed view labelled as such. Attribution shares across variants and
versions are a product decision deferred past Week 10; no `grade` column
exists until then.

## 7. Migration plan

| File | When | Contents |
|---|---|---|
| `0001_init.sql` | V1 | schemas `core` + `studio`; `studio_owner` role; enums with `[W4]` values only (`core.user_kind`, `core.staff_role`, `core.producer_role`, `core.actor_kind`, `core.title_status`, `core.script_format` srt/vtt/ass/txt/docx; `studio.scene_status`, `studio.scene_decision`, `studio.decided_kind`, `studio.version_status`, `studio.approval_mode`, `studio.change_type`, `studio.author_kind` ai/editor, `studio.variant_kind` title/hook/description/thumbnail_concept/ad_angle, `studio.variant_status` candidate/dismissed, `studio.clip_status`, `studio.job_kind` understand_title / understand_scene / first_pass / alternatives / rewrite / propose_variants / find_clips / parse_subtitles, `studio.job_status`; `studio.version_status` draft/in_review/approved/superseded); `[W4]` tables: `core.producers/profiles/titles/episodes/audit_events`, `studio.characters/scenes/lines/adaptations/versions/adapted_lines/line_alternatives/scene_decisions/variants/clips/jobs`; `ext_id`, `derive_title_id`, `freeze_external_id`, `guard_timecodes`, `stamp_scene_status`, `guard_frozen`, `guard_source_text`; `submit_version`, `decide_scene`, `approve_version`, `fork_version`, `choose_alternative`, `select_variant`; helper fns (`is_staff`, `is_staff_admin`, `my_producer_id`, `can_read_title`, `is_producer_approver`, `is_producer_reviewer`); all RLS policies; column and table revokes; one bucket `studio-media` |
| `0002_transcribe.sql` | v1.1 | `ALTER TYPE studio.job_kind ADD VALUE 'transcribe_episode'`; `ALTER TYPE core.script_format ADD VALUE 'asr'`; no table changes; `lib/asr.ts` stops returning "unavailable" |
| `0003_pockets_beats.sql` | Later | `core.audience_pockets`; `adaptations.pocket_id`, unique key widened to `(title_id, pocket_id, target_locale)`; `variants.pocket_id`; `studio.beats`, `studio.beat_kind`, `studio.origin` |
| `0004_reach_stage_contract.sql` | Later | `studio.creative_exports`, `studio.export_status`, `export_variants`, `v_exported_variants`, variant statuses `ready`/`exported`/`retired` + the ready/exported trigger, `variants.source_version_id`/`scene_id`/`is_selection_test`; `core.episodes.source_stream_uid` read, job kinds `register_stream`, `export_reach`; `studio.releases`, `release_episode`, `v_released_episodes`; roles `reach_reader`, `stage_reader`; `studio.comments` if the founders bring comments back |
| `0005_boundaries_media.sql` | Later | `marketing_boundaries`, `confirm_boundaries`; `ALTER TYPE studio.variant_kind ADD VALUE` thumbnail/opening/trailer/clip; `variants.start_ms`/`end_ms`/`storage_path`/`stream_uid`/`is_major`/`boundary_*`/`producer_decision*`; `releases.boundary_id`; `episode_renders`, `releases.render_id`, `release_episode(..., render_id)`; job kinds `cut_variant`, `render_episode`; buckets `studio-thumbs`, `studio-renders`; `core.episodes.dub_requested` starts being read |
| `0006_voice.sql` | Later | `character_voices` (+ clone-consent trigger), `voice_takes`, `voice_kind`/`voice_side` enums, `author_kind` value `producer`, job kinds `voice_take`, `dub_episode`, bucket `studio-audio`, `guard_frozen` extended |
| `0007_feedback_share.sql` | Later | `core.feedback_events`, `share_links`, producer SELECT on feedback |

File numbers are order of landing; a Later file that lands earlier than
its neighbour renumbers. Nothing in `0002`+ changes a `[W4]` column.

Deliberately not in any of these: a tag taxonomy table (`tags text[]`,
vocabulary in `lib/types.ts`), per-line pocket tags, a gradeable registry
and grade rollups, per-scene versioning, source-line versioning, a
`projects` entity (project = title; nav label only), Reach and Stage
tables, comment threads, notifications or assignment queues, a
version-history UI (the rows exist for reproducible exports only), soft
deletes beyond `superseded`/`dismissed`, full-text search, multi-locale
adaptations beyond the `target_locale` column, an ingest status column on
`episodes` (derived from jobs), a Reach UI or Reach write path inside
Studio.
