-- 0019 · Upload to crazydramas (phase 5; publish spec §6–§10, plan A6;
-- crazydramas docs/STUDIO_API.md is the contract on the other side). Studio
-- creates draft series on crazydramas.com, uploads episodes to Mux through
-- crazydramas' Studio API and publishes them explicitly; this is the record
-- of what it sent.
--
-- 1. studio.cd_publications: the ledger. One row per title × episode × file
--    (idempotency key `cd:<title_id>:ep<k>:<sha8>`), steps planned →
--    upload_created → bytes_sent → asset_ready → verified → published, or
--    failed / superseded. Each step is persisted before the next external
--    call; a ten-minute lease (lease_owner / leased_until) and a CAS
--    revision keep two Studio servers from driving one row; a stale lease is
--    adopted and resumes from the persisted step (with an upload id already
--    recorded Studio asks for that upload, never creates a second one, and
--    sends bytes from the offset Mux acknowledged, bytes_acked). At most one
--    active row per title × episode (partial unique index); a re-cut is a
--    new row and the row it replaces becomes `superseded` once the new one
--    is published. Never an upload URL (a capability) or a playback id (the
--    paywall leak) in any column.
-- 2. core.platform_links.managed_by: who may change the series on the
--    platform ('studio' when Studio created it, 'cms' when it was made in
--    the crazydramas CMS — Studio never writes those), null until an
--    authenticated read or Studio's own create said which.
-- 3. core.platform_snapshots.read_via: which read made the row — 'studio'
--    (the authenticated GET /api/studio/series/:series, which sees drafts,
--    so a 404 there is "not uploaded") or 'public' (a 404 is "not uploaded,
--    or draft"). Null on rows written before this migration.
--
-- Producers read the ledger rows of their own titles (can_read_title);
-- every write is the data layer's, as the service role, after its
-- staff-or-system check (lib/data/supabase.ts, mirrored by
-- lib/data/fixture.ts; the rules in lib/crazydramas/ledger.ts). No job kind:
-- an upload costs no model money and the ledger row is the record, as the
-- snapshot row is for a read (0017). Version 0019 follows
-- 0018_narrated_runs.sql. Idempotent throughout.

begin;

-- ---- studio.cd_publications: what Studio uploaded to crazydramas ----

create table if not exists studio.cd_publications (
  id                  uuid primary key default gen_random_uuid(),
  title_id            uuid not null references core.titles (id) on delete cascade,
  episode_id          uuid references core.episodes (id) on delete set null,
  episode_number      int not null check (episode_number between 1 and 500),
  -- crazydramas dramas.id and the slug the series was addressed by; episodes.id once the upload call answered.
  cd_drama_id         uuid not null,
  slug                text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  cd_episode_id       uuid,
  idempotency_key     text not null,
  step                text not null default 'planned'
                      check (step in ('planned', 'upload_created', 'bytes_sent', 'asset_ready', 'verified', 'published', 'failed', 'superseded')),
  -- The file sent: its SHA-256 (also Mux meta.external_id), size, frame count and rate, and the local-tier stored path it is read from.
  sha256              text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes               bigint not null check (bytes > 0),
  frames              int check (frames is null or frames > 0),
  fps                 numeric check (fps is null or fps > 0),
  source_path         text not null check (source_path like 'local/%'),
  "replace"           boolean not null default false,
  -- Mux ids (letters and digits): the direct upload, its asset, the asset a replace put aside, an upload of this row that died.
  upload_id           text check (upload_id is null or upload_id ~ '^[A-Za-z0-9]{1,128}$'),
  asset_id            text check (asset_id is null or asset_id ~ '^[A-Za-z0-9]{1,128}$'),
  previous_asset_id   text check (previous_asset_id is null or previous_asset_id ~ '^[A-Za-z0-9]{1,128}$'),
  previous_upload_id  text check (previous_upload_id is null or previous_upload_id ~ '^[A-Za-z0-9]{1,128}$'),
  -- Bytes Mux acknowledged (the resumable upload's Range header); the uploader resumes from here.
  bytes_acked         bigint not null default 0 check (bytes_acked >= 0 and bytes_acked <= bytes),
  duration_s          numeric check (duration_s is null or duration_s >= 0),
  -- The verify step's facts ({external_id_ok, d_frames, verdict}).
  verify              jsonb check (verify is null or jsonb_typeof(verify) = 'object'),
  error               text,
  error_code          text,
  cancel_requested    boolean not null default false,
  attempts            int not null default 0 check (attempts >= 0),
  attempted_at        timestamptz,
  next_attempt_at     timestamptz,
  lease_owner         text,
  leased_until        timestamptz,
  revision            int not null default 1 check (revision > 0),
  created_by          uuid references core.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  published_at        timestamptz
);

create index if not exists cd_publications_title_idx on studio.cd_publications (title_id, episode_number, created_at);
create index if not exists cd_publications_active_idx on studio.cd_publications (step, next_attempt_at)
  where step in ('planned', 'upload_created', 'bytes_sent', 'asset_ready');
-- One active upload per title × episode number.
create unique index if not exists cd_publications_one_active
  on studio.cd_publications (title_id, episode_number)
  where step in ('planned', 'upload_created', 'bytes_sent', 'asset_ready');
-- One live row per file (a superseded row may share its key with a later upload of the same bytes).
create unique index if not exists cd_publications_key
  on studio.cd_publications (idempotency_key)
  where step <> 'superseded';

alter table studio.cd_publications enable row level security;
drop policy if exists cd_publications_read on studio.cd_publications;
create policy cd_publications_read on studio.cd_publications for select to authenticated using (core.can_read_title(title_id));

revoke all on studio.cd_publications from anon, authenticated;
grant select on studio.cd_publications to authenticated;
grant select, insert, update, delete on studio.cd_publications to service_role, studio_owner;

comment on table studio.cd_publications is 'What Studio uploaded to crazydramas (phase 5): one row per title × episode × file, each step persisted before the next external call, a CAS revision and a ten-minute lease. Never an upload URL or a playback id.';

-- ---- core.platform_links.managed_by ----

alter table core.platform_links add column if not exists managed_by text;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'core.platform_links'::regclass and conname = 'platform_links_managed_by_check') then
    alter table core.platform_links add constraint platform_links_managed_by_check check (managed_by is null or managed_by in ('studio', 'cms'));
  end if;
end $$;
comment on column core.platform_links.managed_by is 'crazydramas dramas.managed_by: studio = Studio created the series and may change it; cms = made in the CMS, read-only for Studio; null = not known yet.';

-- ---- core.platform_snapshots.read_via ----

alter table core.platform_snapshots add column if not exists read_via text;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'core.platform_snapshots'::regclass and conname = 'platform_snapshots_read_via_check') then
    alter table core.platform_snapshots add constraint platform_snapshots_read_via_check check (read_via is null or read_via in ('public', 'studio'));
  end if;
end $$;
comment on column core.platform_snapshots.read_via is 'Which read made the row: studio = the authenticated Studio API (drafts visible; a 404 is "not uploaded"), public = the public API (a 404 is "not uploaded, or draft").';

commit;
