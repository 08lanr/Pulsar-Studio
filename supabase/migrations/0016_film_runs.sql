-- 0016 · Segment a film in Studio (decision 2026-09-23, "Studio orchestrates
-- the pipeline's cut-only scripts"; plan B1). One row per segmenting run of
-- one film: where the source came from, which film folder it became
-- (<bucket>/<slug> under WORKSPACE_ROOT), how it is cut (mode, lang,
-- settings), where the run is (stage + stage_detail), which drama-remix
-- commit its scripts were synced from, the worker's lease, the CAS revision,
-- the refusal that failed it, and every human decision made on it. Progress
-- lives HERE, not in process memory: the worker is a separate process
-- (scripts/segment-worker.ts) and a restart resumes from the row plus the
-- artifacts on disk.
--
-- 1. studio.job_kind gains 'segment_film' (cost 0, one row per stage the
--    worker runs) and 'verify_boundaries' (one row per model call of the
--    vision pass, reviewer or skeptic, its cost recorded, title_id null):
--    the run row gives the job's NOT NULL target_id a real row
--    (target_type 'film_run').
-- 2. studio.film_runs, mirrored by lib/data/fixture.ts (createFilmRun,
--    getFilmRun, listFilmRuns, claimFilmRun, renewFilmRunLease,
--    setFilmRunStage, appendFilmRunDecision, releaseFilmRun) and validated by
--    the one rule set in lib/data/film-runs.ts in both modes.
--    `mode` accepts 'narrated' so the next phase needs no migration, but both
--    backends refuse to create a run with it today. `stage` is plain text so a
--    later stage needs no migration either (lib/types.ts FilmRunStage is the
--    list). RLS: staff every run, producers read their own company's; every
--    write goes through the service role after the data layer's staff check
--    (the phase is staff-gated), revision-conditionally.
--
-- Version 0016 follows 0015_film_import.sql. Idempotent throughout; the enum
-- values are added first so nothing below depends on them inside the same
-- transaction.

alter type studio.job_kind add value if not exists 'segment_film';
alter type studio.job_kind add value if not exists 'verify_boundaries';

begin;

create table if not exists studio.film_runs (
  id                uuid primary key default gen_random_uuid(),
  producer_id       uuid not null references core.producers (id),
  -- The title the run's episodes became through the import, once they did.
  title_id          uuid references core.titles (id) on delete set null,
  -- The source video as picked at intake (absolute path, forward slashes).
  source_path       text not null check (length(source_path) > 0),
  -- The film folder under WORKSPACE_ROOT is <bucket>/<slug>; one leading _ marks a scratch folder (_studio-smoke).
  bucket            text not null check (bucket ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'),
  slug              text not null check (slug ~ '^_?[a-z0-9]+([-_][a-z0-9]+)*$'),
  mode              text not null check (mode in ('by_eye_2min', 'source_episodes', 'narrated')),
  lang              text not null default 'en',
  settings          jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  stage             text not null default 'queued',
  stage_detail      jsonb not null default '{}'::jsonb check (jsonb_typeof(stage_detail) = 'object'),
  drama_remix_sha   text check (drama_remix_sha is null or drama_remix_sha ~ '^[0-9a-f]{40}$'),
  drama_remix_dirty boolean not null default false,
  lease_owner       text,
  leased_until      timestamptz,
  revision          integer not null default 1 check (revision > 0),
  error_text        text,
  decisions         jsonb not null default '[]'::jsonb check (jsonb_typeof(decisions) = 'array'),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists film_runs_company_idx on studio.film_runs (producer_id, created_at desc);
create index if not exists film_runs_open_idx on studio.film_runs (stage, updated_at desc) where stage not in ('done', 'failed', 'cancelled');
create index if not exists film_runs_film_idx on studio.film_runs (bucket, slug, created_at desc);

alter table studio.film_runs enable row level security;
-- Staff read every run (and could write, were the grant there); a producer reads their own company's.
drop policy if exists staff_all on studio.film_runs;
create policy staff_all on studio.film_runs for all to authenticated using (core.is_staff()) with check (core.is_staff());
drop policy if exists producer_select on studio.film_runs;
create policy producer_select on studio.film_runs for select to authenticated using (producer_id = core.my_producer_id());

-- Grants as 0015: 0009's default privileges would have handed authenticated
-- the full set; the rows are written by the data layer as the service role
-- (after its staff check, revision-conditionally) and read under RLS.
revoke all on studio.film_runs from anon, authenticated;
grant select on studio.film_runs to authenticated;
grant select, insert, update, delete on studio.film_runs to service_role, studio_owner;

comment on table studio.film_runs is 'One segmenting run of one film through the drama-remix cut-only scripts; the row is the progress record (stage, lease, CAS revision, decisions). Staff-gated; producers read their own company''s runs.';

commit;
