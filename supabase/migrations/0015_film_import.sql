-- 0015 · The workspace import (decision 2026-09-22, "the end goal, the
-- workspace import and the ad engine"). A finished film from the
-- mini-drama-system pipeline becomes a title with episodes:
--
-- 1. core.titles remembers which film it came from (source_ref, unique per
--    producer), its poster as cover art, the crazydramas slug and the ad
--    rules (the spoiler line and the review-added exclusions).
-- 2. core.episodes carries the imported file's identity (source_ref, sha256,
--    bytes, measured frames), its window in the film, the pipeline's end
--    note (the vision record plus a band_fix flag) and auto_cut, which the
--    import sets false: an imported episode is cut by the ad engine, never
--    by the upload-time clip run (lib/clips/run.ts and the fixture's
--    starter cuts skip it).
-- 3. studio.film_assets: the pipeline files that came with the film
--    (transcript, shots, motion, candidates, source facts, the delivered
--    plan, vision notes, film-meta, poster), linked into the local media
--    tier. Append-only, unique on (title_id, kind, sha256); the newest row
--    of a kind is the one that counts. Producers read their own titles'
--    rows (can_read_title); writes go through the service role only.
-- 4. studio.job_kind gains 'import_film' (cost 0; one running per title).
--
-- Version 0015 follows the two 0014 migrations (clip_posts and
-- instant_page_templates). Idempotent throughout; the enum value is added
-- first so nothing below depends on it inside the same statement. Mirrors
-- lib/data/fixture.ts (createImportedTitle, setEpisodeImport,
-- putFilmAsset, setTitleAdRules).

alter type studio.job_kind add value if not exists 'import_film';

begin;

-- ---- core.titles: where the film came from, what it looks like on crazydramas ----

alter table core.titles add column if not exists source_ref text;
alter table core.titles add column if not exists cover_path text;
alter table core.titles add column if not exists crazydramas_slug text;
alter table core.titles add column if not exists ad_rules jsonb;
-- One title per film per producer; a title that was not imported has no source_ref.
create unique index if not exists titles_producer_source_ref_key
  on core.titles (producer_id, source_ref) where source_ref is not null;

-- ---- core.episodes: the imported file and its place in the film ----

alter table core.episodes add column if not exists source_ref text;
alter table core.episodes add column if not exists video_sha256 text check (video_sha256 is null or video_sha256 ~ '^[0-9a-f]{64}$');
alter table core.episodes add column if not exists video_bytes bigint check (video_bytes is null or video_bytes >= 0);
alter table core.episodes add column if not exists video_frames int check (video_frames is null or video_frames >= 0);
alter table core.episodes add column if not exists film_start_ms int check (film_start_ms is null or film_start_ms >= 0);
alter table core.episodes add column if not exists film_end_ms int check (film_end_ms is null or film_start_ms is null or film_end_ms >= film_start_ms);
alter table core.episodes add column if not exists end_note jsonb;
alter table core.episodes add column if not exists auto_cut boolean not null default true;

-- 0011 narrowed the producer's UPDATE on core.episodes to a column list; the
-- import fields join it so a producer editor's session writes them under the
-- same row rule (producer_update_episodes: can_edit_title). The import job
-- itself runs as the system actor through the service role.
grant update (source_ref, video_sha256, video_bytes, video_frames, film_start_ms, film_end_ms, end_note, auto_cut)
  on core.episodes to authenticated;

-- ---- studio.film_assets: the pipeline's files, kept beside the title ----

create table if not exists studio.film_assets (
  id           uuid primary key default gen_random_uuid(),
  title_id     uuid not null references core.titles (id) on delete cascade,
  kind         text not null check (kind in ('transcript', 'shots', 'motion', 'candidates', 'source_facts', 'delivered_plan', 'vision_notes', 'film_meta', 'poster')),
  -- local/<title_id>/ws/<slug>/<file> for a workspace file linked into the local tier; a bucket path for a Studio-made one.
  storage_path text not null,
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes        bigint not null check (bytes >= 0),
  origin       text not null check (origin in ('workspace', 'studio')),
  source_ref   text,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (title_id, kind, sha256)
);
create index if not exists film_assets_title_kind_idx on studio.film_assets (title_id, kind, created_at desc);

alter table studio.film_assets enable row level security;
drop policy if exists producer_select on studio.film_assets;
create policy producer_select on studio.film_assets for select to authenticated using (core.can_read_title(title_id));

-- 0009's default privileges would have handed authenticated the full set; the
-- rows are written by the import (service role) only, and read under RLS.
revoke all on studio.film_assets from anon, authenticated;
grant select on studio.film_assets to authenticated;
grant select, insert, update, delete on studio.film_assets to service_role, studio_owner;

comment on table studio.film_assets is 'Files that came with an imported film (or were made from it), linked into the local media tier; append-only, the newest row per kind wins.';

commit;
