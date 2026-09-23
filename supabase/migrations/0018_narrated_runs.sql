-- 0018 · Narrated mode in Studio (decision 2026-09-23, "Narrated mode in
-- Studio"; narrated spec N3 with Ruobin's amendments). A narrated run is one
-- source episode of a season going through the skip-through route under
-- projects/high-quality/<slug>; its film_runs row keeps the run-level stages
-- (intake, index, sheets, script_raw, script, episodes, episode_work,
-- film_meta, handoff — `stage` is plain text, so no change there) and each
-- of its episodes progresses in its own row here.
--
-- 1. studio.job_kind gains the narrated route's rows:
--      sheet_read, frame_verify, cut_verify   one per picture-check API call
--                                             (the drama-remix Workflow each
--                                             call stands in for; its cost)
--      tts_line                               one per new tts_ledger.json row
--                                             (chars × ELEVENLABS_CENTS_PER_1K_CHARS / 1000)
--      jev_check                              one per Jev-calling script run
--                                             (cost null, "unmetered", until
--                                             jev.py logs usage)
--      claude_session                         one per headless Claude Code
--                                             writing session Studio launched
--                                             (cost null: the subscription
--                                             login pays, never the API key)
-- 2. studio.film_assets.kind gains the narrated delivery's files:
--    narrated_captions (.srt/.ass), narration (narration.json + manifest),
--    gate_report (.gate.md/.json, USER-REVIEW.md), script_doc (SCRIPT,
--    glossary), delivery_manifest (DELIVERED-narrated.json).
-- 3. studio.film_run_episodes, mirrored by lib/data/fixture.ts
--    (createRunEpisodes, listRunEpisodes, getRunEpisode, claimRunEpisode,
--    renewRunEpisodeLease, setRunEpisodeStage, releaseRunEpisode) under the
--    one rule set of lib/data/film-runs.ts. Two lanes (words_stage,
--    picture_stage) join into `stage`; the row has its own lease and CAS
--    revision, so one worker can hold the picture lane of ep9 and the words
--    lane of ep11 at once. `n` is unique per run, and unique per series_key
--    across live runs (a run neither failed nor cancelled, an episode not
--    dropped): the data layer refuses a held number in both backends and
--    the trigger below is the backstop against a race. RLS: staff only —
--    producers read nothing of a run in progress; writes go through the
--    service role after the data layer's staff check, revision-conditionally.
--
-- Version 0018 follows 0017_crazydramas_link.sql. Idempotent throughout; the
-- enum values are added first, outside the transaction, as 0016 does.

alter type studio.job_kind add value if not exists 'sheet_read';
alter type studio.job_kind add value if not exists 'frame_verify';
alter type studio.job_kind add value if not exists 'cut_verify';
alter type studio.job_kind add value if not exists 'tts_line';
alter type studio.job_kind add value if not exists 'jev_check';
alter type studio.job_kind add value if not exists 'claude_session';

begin;

-- ---- 2. the narrated delivery's asset kinds ----

alter table studio.film_assets drop constraint if exists film_assets_kind_check;
alter table studio.film_assets add constraint film_assets_kind_check check (kind in (
  'transcript', 'shots', 'motion', 'candidates', 'source_facts', 'delivered_plan', 'vision_notes', 'film_meta', 'poster',
  'narrated_captions', 'narration', 'gate_report', 'script_doc', 'delivery_manifest'
));

-- ---- 3. studio.film_run_episodes ----

create table if not exists studio.film_run_episodes (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references studio.film_runs (id) on delete cascade,
  -- The run's settings.season.series_key, copied at creation: numbering is continuous across source episodes.
  series_key      text not null check (series_key ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'),
  n               integer not null check (n >= 1),
  -- The episode's window in the source, seconds.
  src_in          numeric not null check (src_in >= 0),
  src_out         numeric not null,
  title           text not null check (length(title) between 1 and 120),
  subtitle        text check (subtitle is null or length(subtitle) <= 200),
  words_stage     text not null default 'prep' check (words_stage in ('prep', 'prep_review', 'voice', 'frames', 'joins', 'ready')),
  picture_stage   text not null default 'waiting' check (picture_stage in ('waiting', 'picture', 'reframe_glance', 'ready', 'stale')),
  stage           text not null default 'lanes' check (stage in ('lanes', 'build', 'ep_review', 'shipped', 'dropped')),
  -- The newest built variant (v1, v2, …) and gate.py's counts for it ({PASS, WARN, FAIL}).
  variant         text check (variant is null or variant ~ '^v[0-9]{1,4}$'),
  gate            jsonb check (gate is null or jsonb_typeof(gate) = 'object'),
  body_sha256     text check (body_sha256 is null or body_sha256 ~ '^[0-9a-f]{64}$'),
  shipped_sha256  text check (shipped_sha256 is null or shipped_sha256 ~ '^[0-9a-f]{64}$'),
  stage_detail    jsonb not null default '{}'::jsonb check (jsonb_typeof(stage_detail) = 'object'),
  error_text      text,
  -- The final watch (E8).
  approved_by     text,
  approved_at     timestamptz,
  lease_owner     text,
  leased_until    timestamptz,
  revision        integer not null default 1 check (revision > 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (src_out > src_in),
  unique (run_id, n)
);
create index if not exists film_run_episodes_run_idx on studio.film_run_episodes (run_id, n);
create index if not exists film_run_episodes_series_idx on studio.film_run_episodes (series_key, n);

-- The backstop of the held-number rule: a number another live run of the season holds is refused.
create or replace function studio.guard_run_episode_number() returns trigger
language plpgsql as $$
begin
  if new.stage = 'dropped' then
    return new;
  end if;
  if exists (
    select 1
      from studio.film_run_episodes e
      join studio.film_runs r on r.id = e.run_id
     where e.series_key = new.series_key
       and e.n = new.n
       and e.run_id <> new.run_id
       and e.stage <> 'dropped'
       and r.stage not in ('failed', 'cancelled')
  ) then
    raise exception 'episode % of season % is already held by a live run', new.n, new.series_key using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists film_run_episodes_number_guard on studio.film_run_episodes;
create trigger film_run_episodes_number_guard
  before insert or update of n, series_key, stage on studio.film_run_episodes
  for each row execute function studio.guard_run_episode_number();

alter table studio.film_run_episodes enable row level security;
-- Staff only, reads and all: a producer sees nothing of a narrated run in progress.
drop policy if exists staff_all on studio.film_run_episodes;
create policy staff_all on studio.film_run_episodes for all to authenticated using (core.is_staff()) with check (core.is_staff());

-- Grants as 0016: rows are written by the data layer as the service role (after its staff check,
-- revision-conditionally) and read under RLS.
revoke all on studio.film_run_episodes from anon, authenticated;
grant select on studio.film_run_episodes to authenticated;
grant select, insert, update, delete on studio.film_run_episodes to service_role, studio_owner;

comment on table studio.film_run_episodes is 'One episode of a narrated (skip-through) film run: the words and picture lanes, the build, the final watch; its own lease and CAS revision. Staff only.';

commit;
