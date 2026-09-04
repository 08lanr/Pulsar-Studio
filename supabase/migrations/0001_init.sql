-- 0001_init.sql — Pulsar Studio V1 schema (docs/data-model.md, V1 cut of
-- 2026-09-03; docs/decisions.md "V1 definition" wins on conflict).
--
-- WHY one file: the Supabase SQL editor applies it in one pass, top to
-- bottom, in a single transaction. Order matters and is fixed: extensions
-- and schemas -> the studio_owner role -> enums -> functions that column
-- defaults need -> tables (parents before children) -> indexes -> helper
-- predicates (SQL functions are validated against the tables at creation,
-- so they come after the tables) -> trigger functions and triggers -> the
-- state-changing functions -> ownership and grants -> RLS policies ->
-- the storage bucket and its policies.
--
-- Posture: RLS on every table, deny by default. `authenticated` gets table
-- grants narrowed by column lists where a status column must only move
-- through a function; `anon` gets nothing; `service_role` (BYPASSRLS) is the
-- ingest script only. Every state change goes through a SECURITY DEFINER
-- function owned by `studio_owner`, which is allowed through RLS by an
-- explicit policy per table (tables stay owned by the migrating role) and
-- writes a core.audit_events row in the same transaction.
--
-- Deviations from docs/data-model.md are marked "DEVIATION" inline and
-- listed in supabase/README.md.

begin;

-- ---------------------------------------------------------------------------
-- 0. Extensions, schemas, owner role
-- ---------------------------------------------------------------------------

-- pgcrypto is present on every Supabase project (schema `extensions`); the
-- statement is a no-op there. Nothing below depends on it: core.ext_id()
-- draws its random bytes from gen_random_uuid() (pg_catalog, PG13+) so the
-- default works whatever schema the extension landed in.
create extension if not exists pgcrypto;

create schema if not exists core;
create schema if not exists studio;

-- studio_owner owns the functions (nobody logs in as it). The migrating role
-- is made a member so it can transfer ownership at the end of this file.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'studio_owner') then
    create role studio_owner nologin;
  end if;
  execute format('grant studio_owner to %I', current_user);
end
$$;

grant usage, create on schema core, studio to studio_owner;

-- ---------------------------------------------------------------------------
-- 1. Enums ([W4] values only; Later values arrive with ALTER TYPE ... ADD VALUE)
-- ---------------------------------------------------------------------------

create type core.user_kind      as enum ('staff', 'producer');
create type core.staff_role     as enum ('admin', 'editor');
create type core.producer_role  as enum ('approver', 'reviewer', 'viewer');
create type core.actor_kind     as enum ('staff', 'producer', 'service');
create type core.title_status   as enum ('candidate', 'selected', 'ingesting', 'adapting', 'in_review', 'approved', 'live', 'ended', 'dropped');
create type core.script_format  as enum ('srt', 'vtt', 'ass', 'txt', 'docx');

create type studio.scene_status    as enum ('draft', 'approved');
create type studio.scene_decision  as enum ('approved', 'needs_alternative');
create type studio.decided_kind    as enum ('producer', 'staff_on_behalf');
create type studio.version_status  as enum ('draft', 'in_review', 'approved', 'superseded');
create type studio.approval_mode   as enum ('in_app', 'on_behalf');
create type studio.change_type     as enum ('keep', 'literal', 'rewrite', 'tighten', 'tone', 'cultural', 'pacing', 'cut', 'add');
create type studio.author_kind     as enum ('ai', 'editor');
create type studio.variant_kind    as enum ('title', 'hook', 'description', 'thumbnail_concept', 'ad_angle');
create type studio.variant_status  as enum ('candidate', 'dismissed');
create type studio.clip_status     as enum ('suggested', 'shortlisted', 'dismissed');
create type studio.job_kind        as enum ('understand_title', 'understand_scene', 'first_pass', 'alternatives', 'rewrite', 'propose_variants', 'find_clips', 'parse_subtitles');
create type studio.job_status      as enum ('queued', 'running', 'done', 'failed', 'cancelled');

-- ---------------------------------------------------------------------------
-- 2. Functions that column defaults and triggers need before any table exists
-- ---------------------------------------------------------------------------

-- The caller's auth user id, read from the JWT settings PostgREST sets —
-- the same expression Supabase's auth.uid() uses. DEVIATION: the doc says
-- auth.uid(); we read the setting directly so the studio_owner-owned
-- SECURITY DEFINER functions need no grant on the `auth` schema (which the
-- migrating role cannot always give).
create or replace function core.current_uid()
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

-- External id: prefix || '_' || lower base32 of 64 random bits (13 chars,
-- alphabet a-z2-7, no padding). The bits are bytes 1-6 and 15-16 of a v4
-- uuid, the positions that carry no version/variant marker.
create or replace function core.ext_id(prefix text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  u      bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  raw    bytea;
  buf    int  := 0;
  bits   int  := 0;
  result text := '';
  i      int;
begin
  raw := substring(u from 1 for 6) || substring(u from 15 for 2);
  for i in 0..7 loop
    buf  := (buf << 8) | get_byte(raw, i);
    bits := bits + 8;
    while bits >= 5 loop
      bits   := bits - 5;
      result := result || substr(alphabet, ((buf >> bits) & 31) + 1, 1);
      buf    := buf & ((1 << bits) - 1);
    end loop;
  end loop;
  if bits > 0 then
    result := result || substr(alphabet, ((buf << (5 - bits)) & 31) + 1, 1);
  end if;
  return prefix || '_' || result;
end
$$;

create or replace function core.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Canonical JSON text: object keys sorted bytewise (collate "C"),
-- recursively, arrays in order, no whitespace, strings escaped the way
-- to_json(text) does (which matches JSON.stringify for valid UTF-8). The
-- snapshot hash is taken over this text, and lib/types.ts canonicalJson()
-- produces the same bytes, so a hash computed in the app (fixture mode, a
-- test) and one computed here agree. jsonb's own ::text output would not do:
-- it orders keys by length and puts spaces after ':' and ','.
create or replace function core.canonical_json(j jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text := jsonb_typeof(j);
begin
  if j is null or t = 'null' then
    return 'null';
  elsif t = 'object' then
    return '{' || coalesce((
      select string_agg(to_json(e.k)::text || ':' || core.canonical_json(e.v), ',' order by e.k collate "C")
      from jsonb_each(j) as e(k, v)
    ), '') || '}';
  elsif t = 'array' then
    return '[' || coalesce((
      select string_agg(core.canonical_json(e.v), ',' order by e.ord)
      from jsonb_array_elements(j) with ordinality as e(v, ord)
    ), '') || ']';
  elsif t = 'string' then
    return to_json(j #>> '{}')::text;
  else
    return j::text;   -- number, boolean
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Tables — core
-- ---------------------------------------------------------------------------

create table core.producers (
  id             uuid primary key default gen_random_uuid(),
  external_id    text not null unique default core.ext_id('pr'),
  -- DEVIATION: the doc has no default; POST /api/producers sends no slug, so
  -- a random 12-hex token stands in until staff set one.
  slug           text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  name_zh        text not null,
  name_en        text,
  contact_email  text,
  contact_wechat text,
  deliverables   jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create table core.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  kind          core.user_kind not null,
  staff_role    core.staff_role,
  producer_id   uuid references core.producers (id),
  producer_role core.producer_role,
  display_name  text not null,
  locale        text check (locale in ('zh', 'en')),
  created_at    timestamptz not null default now(),
  constraint profiles_role_shape check (
    (kind = 'staff'    and staff_role is not null and producer_id is null     and producer_role is null) or
    (kind = 'producer' and staff_role is null     and producer_id is not null and producer_role is not null)
  )
);

create table core.titles (
  id                  uuid primary key default gen_random_uuid(),
  external_id         text not null unique default core.ext_id('ttl'),
  producer_id         uuid not null references core.producers (id),
  name_zh             text not null,
  name_en             text,
  genre               text,
  synopsis_zh         text,
  synopsis_en         text,
  character_notes     text,
  logline_zh          text,
  logline_en          text,
  episode_count       int check (episode_count is null or episode_count >= 0),
  source_locale       text not null default 'zh-CN',
  status              core.title_status not null default 'selected',
  china_metrics       jsonb not null default '{}'::jsonb,
  localization_effort text,
  deliverables        jsonb not null default '{}'::jsonb,
  notes               text,
  license_start       date,
  license_end         date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table core.episodes (
  id                 uuid primary key default gen_random_uuid(),
  external_id        text not null unique default core.ext_id('ep'),
  title_id           uuid not null references core.titles (id) on delete cascade,
  number             int not null check (number > 0),
  name_zh            text,
  name_en            text,
  duration_ms        int check (duration_ms is null or duration_ms >= 0),
  source_script_path text,
  script_format      core.script_format,
  has_timecodes      boolean not null default false,
  video_path         text,
  created_at         timestamptz not null default now(),
  unique (title_id, number)
);

create table core.audit_events (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid references core.profiles (id),
  actor_kind  core.actor_kind not null,
  product     text not null default 'studio',
  action      text not null,
  table_name  text not null,
  row_id      uuid,
  title_id    uuid,
  producer_id uuid,
  "before"    jsonb,
  "after"     jsonb,
  note        text,
  channel     text
);

-- ---------------------------------------------------------------------------
-- 4. Tables — studio (V1 set only)
-- ---------------------------------------------------------------------------

create table studio.characters (
  id         uuid primary key default gen_random_uuid(),
  title_id   uuid not null references core.titles (id) on delete cascade,
  name_zh    text not null,
  name_en    text,
  notes      text,
  created_at timestamptz not null default now(),
  unique (title_id, name_zh)
);

create table studio.scenes (
  id          uuid primary key default gen_random_uuid(),
  external_id text not null unique default core.ext_id('sc'),
  title_id    uuid not null references core.titles (id) on delete cascade,
  episode_id  uuid not null references core.episodes (id) on delete cascade,
  number      int not null check (number > 0),
  start_ms    int check (start_ms is null or start_ms >= 0),
  end_ms      int check (end_ms is null or start_ms is null or end_ms >= start_ms),
  context_zh  text,
  context_en  text,
  status      studio.scene_status not null default 'draft',
  status_by   uuid references core.profiles (id),
  status_at   timestamptz,
  created_at  timestamptz not null default now(),
  unique (episode_id, number)
);

create table studio.lines (
  id             uuid primary key default gen_random_uuid(),
  external_id    text not null unique default core.ext_id('ln'),
  title_id       uuid not null references core.titles (id) on delete cascade,
  scene_id       uuid not null references studio.scenes (id) on delete cascade,
  seq            int not null check (seq > 0),
  speaker        text,
  character_id   uuid references studio.characters (id) on delete set null,
  start_ms       int check (start_ms is null or start_ms >= 0),
  end_ms         int check (end_ms is null or start_ms is null or end_ms >= start_ms),
  duration_ms    int generated always as (end_ms - start_ms) stored,
  text_zh        text not null,
  literal_en     text,
  merged_into_id uuid references studio.lines (id),
  created_at     timestamptz not null default now(),
  unique (scene_id, seq)
);

create table studio.adaptations (
  id               uuid primary key default gen_random_uuid(),
  external_id      text not null unique default core.ext_id('ad'),
  title_id         uuid not null references core.titles (id) on delete cascade,
  target_locale    text not null default 'en-US',
  label            text not null default 'U.S. general',
  display_title_en text,
  created_by       uuid references core.profiles (id),
  created_at       timestamptz not null default now(),
  unique (title_id, target_locale)
);

create table studio.versions (
  id                uuid primary key default gen_random_uuid(),
  external_id       text not null unique default core.ext_id('ver'),
  title_id          uuid not null references core.titles (id) on delete cascade,
  adaptation_id     uuid not null references studio.adaptations (id) on delete cascade,
  episode_id        uuid not null references core.episodes (id),
  number            int not null check (number > 0),
  parent_version_id uuid references studio.versions (id),
  status            studio.version_status not null default 'draft',
  submitted_at      timestamptz,
  submitted_by      uuid references core.profiles (id),
  approved_at       timestamptz,
  approved_by       uuid references core.profiles (id),
  approval_mode     studio.approval_mode,
  approval_evidence text,
  approval_note     text,
  snapshot          jsonb,
  snapshot_sha256   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (adaptation_id, episode_id, number)
);
create unique index versions_one_approved on studio.versions (adaptation_id, episode_id) where status = 'approved';
create unique index versions_one_draft    on studio.versions (adaptation_id, episode_id) where status = 'draft';

-- jobs before adapted_lines / line_alternatives / variants / clips (job_id FKs).
-- title_id / episode_id / version_id are plain uuids on purpose: a job row
-- (and its cost) outlives whatever it targeted.
create table studio.jobs (
  id              uuid primary key default gen_random_uuid(),
  title_id        uuid,
  episode_id      uuid,
  version_id      uuid,
  kind            studio.job_kind not null,
  target_type     text not null,
  target_id       uuid not null,
  idempotency_key text not null unique,
  status          studio.job_status not null default 'queued',
  provider        text,
  model           text,
  input           jsonb,
  output          jsonb,
  error           text,
  usage           jsonb,
  cost_cents      int check (cost_cents is null or cost_cents >= 0),
  heartbeat_at    timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table studio.adapted_lines (
  id                  uuid primary key default gen_random_uuid(),
  external_id         text not null unique default core.ext_id('rw'),
  title_id            uuid not null references core.titles (id) on delete cascade,
  version_id          uuid not null references studio.versions (id) on delete cascade,
  scene_id            uuid not null references studio.scenes (id),
  line_id             uuid references studio.lines (id),
  merges              uuid[] not null default '{}',
  seq                 int not null check (seq > 0),
  start_ms            int check (start_ms is null or start_ms >= 0),
  end_ms              int check (end_ms is null or start_ms is null or end_ms >= start_ms),
  text_en             text,
  key_phrase_en       text,
  back_translation_zh text,
  change_type         studio.change_type not null,
  is_major            boolean not null default false,
  rationale_en        text,
  rationale_zh        text,
  tone_note_en        text,
  tone_note_zh        text,
  tags                text[] not null default '{}',
  syllables_est       int,
  authored_by         studio.author_kind not null default 'ai',
  model               text,
  prompt_version      text,
  ai_text_en          text,
  ai_rationale_zh     text,
  edited_by           uuid references core.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (version_id, scene_id, seq),
  constraint adapted_lines_cut_has_no_text check (change_type <> 'cut' or text_en is null)
);

create table studio.line_alternatives (
  id                  uuid primary key default gen_random_uuid(),
  external_id         text not null unique default core.ext_id('alt'),
  title_id            uuid not null references core.titles (id) on delete cascade,
  version_id          uuid not null references studio.versions (id) on delete cascade,
  adapted_line_id     uuid not null references studio.adapted_lines (id) on delete cascade,
  seq                 int not null check (seq > 0),
  text_en             text not null,
  back_translation_zh text,
  rationale_zh        text not null,
  rationale_en        text,
  tags                text[] not null default '{}',
  syllables_est       int,
  model               text not null,
  prompt_version      text not null,
  job_id              uuid references studio.jobs (id),
  chosen              boolean not null default false,
  chosen_by           uuid references core.profiles (id),
  chosen_at           timestamptz,
  created_at          timestamptz not null default now(),
  unique (adapted_line_id, seq)
);
create unique index line_alternatives_one_chosen on studio.line_alternatives (adapted_line_id) where chosen;

create table studio.scene_decisions (
  version_id   uuid not null references studio.versions (id) on delete cascade,
  scene_id     uuid not null references studio.scenes (id),
  title_id     uuid not null references core.titles (id) on delete cascade,
  decision     studio.scene_decision not null,
  line_id      uuid references studio.lines (id),
  timestamp_ms bigint,
  note         text,
  resolution_disposition text,
  resolution_note text,
  responded_by uuid references core.profiles (id),
  responded_at timestamptz,
  decided_by   uuid not null references core.profiles (id),
  decided_at   timestamptz not null default now(),
  decided_kind studio.decided_kind not null default 'producer',
  created_at   timestamptz not null default now(),
  primary key (version_id, scene_id),
  constraint scene_decisions_needs_alternative_has_anchor check (
    decision <> 'needs_alternative' or (note is not null and line_id is not null)
  ),
  constraint scene_decisions_resolution_shape check (
    resolution_disposition is null or (
      resolution_disposition in ('agreed', 'partially_agreed', 'disagreed')
      and resolution_note is not null and responded_by is not null and responded_at is not null
    )
  )
);

create table studio.variants (
  id             uuid primary key default gen_random_uuid(),
  external_id    text not null unique default core.ext_id('var'),
  title_id       uuid not null references core.titles (id) on delete cascade,
  adaptation_id  uuid not null references studio.adaptations (id),
  kind           studio.variant_kind not null,
  text_en        text not null,
  text_zh        text,
  rationale_en   text,
  rationale_zh   text,
  tags           text[] not null default '{}',
  selected       boolean not null default false,
  status         studio.variant_status not null default 'candidate',
  model          text,
  prompt_version text,
  job_id         uuid references studio.jobs (id),
  created_by     uuid references core.profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint variants_selected_shape check (selected = false or (kind in ('title', 'hook') and status = 'candidate'))
);
create unique index variants_one_selected on studio.variants (title_id, kind) where selected;

create table studio.clips (
  id              uuid primary key default gen_random_uuid(),
  external_id     text not null unique default core.ext_id('clip'),
  title_id        uuid not null references core.titles (id) on delete cascade,
  episode_id      uuid not null references core.episodes (id) on delete cascade,
  adaptation_id   uuid references studio.adaptations (id),
  rank            int not null check (rank > 0),
  start_ms        int not null check (start_ms >= 0),
  end_ms          int not null check (end_ms >= start_ms),
  scene_ids       uuid[] not null default '{}',
  hook_en         text not null,
  why_en          text not null,
  why_zh          text not null,
  opening_text_en text,
  cut_length_s    int check (cut_length_s is null or cut_length_s > 0),
  angle           text,
  status          studio.clip_status not null default 'suggested',
  model           text,
  prompt_version  text,
  job_id          uuid references studio.jobs (id),
  created_at      timestamptz not null default now(),
  unique (episode_id, rank)
);

-- ---------------------------------------------------------------------------
-- 5. Indexes (the unique constraints above already cover the (parent, seq) lookups)
-- ---------------------------------------------------------------------------

create index titles_producer_idx            on core.titles (producer_id);
create index episodes_title_idx             on core.episodes (title_id);
create index audit_events_title_at_idx      on core.audit_events (title_id, at);
create index audit_events_producer_idx      on core.audit_events (producer_id);
create index characters_title_idx           on studio.characters (title_id);
create index scenes_title_idx               on studio.scenes (title_id);
create index lines_title_idx                on studio.lines (title_id);
create index lines_character_idx            on studio.lines (character_id);
create index versions_adaptation_status_idx on studio.versions (adaptation_id, episode_id, status);
create index versions_title_idx             on studio.versions (title_id);
create index adapted_lines_scene_idx        on studio.adapted_lines (scene_id);
create index adapted_lines_title_idx        on studio.adapted_lines (title_id);
create index line_alternatives_version_idx  on studio.line_alternatives (version_id);
create index scene_decisions_scene_idx      on studio.scene_decisions (scene_id);
create index variants_title_kind_idx        on studio.variants (title_id, kind);
create index clips_title_episode_rank_idx   on studio.clips (title_id, episode_id, rank);
create index jobs_status_heartbeat_idx      on studio.jobs (status, heartbeat_at);
create index jobs_title_idx                 on studio.jobs (title_id);

-- ---------------------------------------------------------------------------
-- 6. Role predicates (SECURITY DEFINER so a policy on core.profiles never
--    recurses: they read profiles as studio_owner, which has its own policy)
-- ---------------------------------------------------------------------------

create or replace function core.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from core.profiles p
    where p.id = core.current_uid() and p.kind = 'staff'
  )
$$;

create or replace function core.is_staff_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from core.profiles p
    where p.id = core.current_uid() and p.kind = 'staff' and p.staff_role = 'admin'
  )
$$;

create or replace function core.my_producer_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.producer_id from core.profiles p
  where p.id = core.current_uid() and p.kind = 'producer'
$$;

create or replace function core.can_read_title(t uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select core.is_staff() or exists (
    select 1 from core.titles x
    where x.id = t and x.producer_id = core.my_producer_id()
  )
$$;

create or replace function core.is_producer_approver(t uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.profiles p
    join core.titles x on x.producer_id = p.producer_id
    where p.id = core.current_uid()
      and p.kind = 'producer'
      and p.producer_role = 'approver'
      and x.id = t
  )
$$;

create or replace function core.is_producer_reviewer(t uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.profiles p
    join core.titles x on x.producer_id = p.producer_id
    where p.id = core.current_uid()
      and p.kind = 'producer'
      and p.producer_role in ('approver', 'reviewer')
      and x.id = t
  )
$$;

-- Producer visibility begins at in_review; staff see every version.
create or replace function studio.version_readable(p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select core.is_staff() or exists (
    select 1 from studio.versions v
    where v.id = p_version_id
      and (
        v.status in ('in_review', 'approved')
        or exists (
          select 1 from studio.versions child
          where child.parent_version_id = v.id and child.status in ('in_review', 'approved')
        )
      )
      and core.can_read_title(v.title_id)
  )
$$;

-- First path segment of a storage object name as a uuid, null when it is
-- not one. Used by the storage policies (objects live under <title_id>/...).
create or replace function core.title_id_from_path(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then split_part(p_name, '/', 1)::uuid
    else null
  end
$$;

-- One audit row per state change, written by the functions in section 8.
-- actor_kind follows the caller's profile; no profile (service role, script)
-- = 'service'. producer_id defaults to the title's producer so a producer's
-- "select own rows" policy finds every event on their titles.
create or replace function core.audit(
  p_action      text,
  p_table_name  text,
  p_row_id      uuid,
  p_title_id    uuid,
  p_producer_id uuid,
  p_before      jsonb,
  p_after       jsonb,
  p_note        text,
  p_channel     text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := core.current_uid();
  v_actor uuid;
  v_kind  core.actor_kind := 'service';
  v_id    bigint;
begin
  if v_uid is not null then
    select p.id, p.kind::text::core.actor_kind into v_actor, v_kind
    from core.profiles p where p.id = v_uid;
    if v_actor is null then
      v_kind := 'service';
    end if;
  end if;
  insert into core.audit_events
    (actor_id, actor_kind, action, table_name, row_id, title_id, producer_id, "before", "after", note, channel)
  values
    (v_actor, v_kind, p_action, p_table_name, p_row_id, p_title_id,
     coalesce(p_producer_id, (select t.producer_id from core.titles t where t.id = p_title_id)),
     p_before, p_after, p_note, p_channel)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Trigger functions and triggers
-- ---------------------------------------------------------------------------

-- title_id is denormalised onto every studio.* child so each RLS policy is
-- one function call. The parent decides; a mismatching explicit value is an
-- error, never silently corrected. line_alternatives also derives
-- version_id; scene_decisions and adapted_lines also check that the scene
-- belongs to the version's episode.
create or replace function core.derive_title_id()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_title   uuid;
  v_other   uuid;
  v_episode uuid;
  v_version uuid;
begin
  case tg_table_name
    when 'scenes' then
      select e.title_id into v_title from core.episodes e where e.id = new.episode_id;
    when 'lines' then
      select s.title_id into v_title from studio.scenes s where s.id = new.scene_id;
    when 'versions' then
      select a.title_id into v_title from studio.adaptations a where a.id = new.adaptation_id;
      select e.title_id into v_other from core.episodes e where e.id = new.episode_id;
      if v_other is distinct from v_title then
        raise exception 'versions: episode % does not belong to the adaptation''s title', new.episode_id;
      end if;
    when 'adapted_lines' then
      select v.title_id, v.episode_id into v_title, v_episode from studio.versions v where v.id = new.version_id;
      select s.episode_id into v_other from studio.scenes s where s.id = new.scene_id;
      if v_other is distinct from v_episode then
        raise exception 'adapted_lines: scene % is not in the version''s episode', new.scene_id;
      end if;
      if new.line_id is not null and not exists (
        select 1 from studio.lines l where l.id = new.line_id and l.scene_id = new.scene_id
      ) then
        raise exception 'adapted_lines: line % is not in scene %', new.line_id, new.scene_id;
      end if;
    when 'line_alternatives' then
      select a.title_id, a.version_id into v_title, v_version from studio.adapted_lines a where a.id = new.adapted_line_id;
      if new.version_id is null then
        new.version_id := v_version;
      elsif new.version_id <> v_version then
        raise exception 'line_alternatives: version_id % does not match the adapted line''s version %', new.version_id, v_version;
      end if;
    when 'scene_decisions' then
      select v.title_id, v.episode_id into v_title, v_episode from studio.versions v where v.id = new.version_id;
      select s.episode_id into v_other from studio.scenes s where s.id = new.scene_id;
      if v_other is distinct from v_episode then
        raise exception 'scene_decisions: scene % is not in the version''s episode', new.scene_id;
      end if;
    when 'variants' then
      select a.title_id into v_title from studio.adaptations a where a.id = new.adaptation_id;
    when 'clips' then
      select e.title_id into v_title from core.episodes e where e.id = new.episode_id;
      if new.adaptation_id is not null then
        select a.title_id into v_other from studio.adaptations a where a.id = new.adaptation_id;
        if v_other is distinct from v_title then
          raise exception 'clips: adaptation % does not belong to the episode''s title', new.adaptation_id;
        end if;
      end if;
    else
      raise exception 'derive_title_id: no parent rule for table %', tg_table_name;
  end case;

  if v_title is null then
    raise exception '%: parent row not found', tg_table_name;
  end if;
  if new.title_id is null then
    new.title_id := v_title;
  elsif new.title_id <> v_title then
    raise exception '%: title_id % does not match the parent''s title %', tg_table_name, new.title_id, v_title;
  end if;
  return new;
end
$$;

create or replace function core.freeze_external_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.external_id is distinct from old.external_id then
    raise exception '%: external_id is immutable', tg_table_name;
  end if;
  return new;
end
$$;

-- start_ms / end_ms are required once the episode has timecodes; a bare
-- script (has_timecodes = false) may leave them null. Clips always need a
-- range and refuse an untimed episode.
create or replace function studio.guard_timecodes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_episode uuid;
  v_timed   boolean;
begin
  if tg_table_name = 'lines' then
    select s.episode_id into v_episode from studio.scenes s where s.id = new.scene_id;
  else
    v_episode := new.episode_id;
  end if;
  select e.has_timecodes into v_timed from core.episodes e where e.id = v_episode;

  if tg_table_name = 'clips' then
    if not coalesce(v_timed, false) then
      raise exception 'clips: episode % has no timecodes; find_clips refuses untimed episodes', v_episode;
    end if;
  elsif coalesce(v_timed, false) and (new.start_ms is null or new.end_ms is null) then
    raise exception '%: start_ms and end_ms are required when the episode has timecodes', tg_table_name;
  end if;
  return new;
end
$$;

create or replace function studio.stamp_scene_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.status_by := core.current_uid();
    new.status_at := now();
  end if;
  return new;
end
$$;

-- Source lines are write-once after any version exists for the episode:
-- corrections before that edit in place, re-segmentation after that is a
-- new episode row plus a fork.
create or replace function studio.guard_source_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.text_zh, new.start_ms, new.end_ms, new.seq) is distinct from (old.text_zh, old.start_ms, old.end_ms, old.seq)
     and exists (
       select 1 from studio.versions v
       join studio.scenes s on s.episode_id = v.episode_id
       where s.id = old.scene_id
     ) then
    raise exception 'lines: text_zh, start_ms, end_ms and seq are write-once after a version exists for the episode';
  end if;
  return new;
end
$$;

-- What "frozen" means per table (docs/data-model.md § 2, guard_frozen):
--   versions        in_review: snapshot fixed, status may go approved | superseded
--                   approved:  only status -> superseded, nothing else
--                   superseded: terminal; delete only while draft
--   adapted_lines / line_alternatives: no write once the version left draft
--   scene_decisions: writes only while in_review; frozen once approved
-- NEW is never touched on DELETE and OLD never on INSERT (a null record).
create or replace function studio.guard_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version uuid;
  v_status  studio.version_status;
begin
  if tg_table_name = 'versions' then
    if tg_op = 'DELETE' then
      if old.status <> 'draft' then
        raise exception 'versions: % version % is frozen and cannot be deleted', old.status, old.id;
      end if;
      return old;
    end if;
    if old.status = 'superseded' then
      raise exception 'versions: % is superseded (terminal)', old.id;
    elsif old.status = 'in_review' then
      if new.snapshot is distinct from old.snapshot or new.snapshot_sha256 is distinct from old.snapshot_sha256 then
        raise exception 'versions: the snapshot of % is frozen once in_review', old.id;
      end if;
      if new.status not in ('in_review', 'approved', 'superseded') then
        raise exception 'versions: in_review may only move to approved or superseded, not %', new.status;
      end if;
    elsif old.status = 'approved' then
      if new.status <> 'superseded'
         or (to_jsonb(new) - 'status' - 'updated_at') <> (to_jsonb(old) - 'status' - 'updated_at') then
        raise exception 'versions: approved version % may only move to superseded', old.id;
      end if;
    end if;
    return new;
  end if;

  -- child tables: resolve the parent version first
  if tg_op = 'DELETE' then
    v_version := old.version_id;
  else
    v_version := new.version_id;
    if v_version is null and tg_table_name = 'line_alternatives' then
      select a.version_id into v_version from studio.adapted_lines a where a.id = new.adapted_line_id;
    end if;
  end if;
  select v.status into v_status from studio.versions v where v.id = v_version;

  if tg_table_name in ('adapted_lines', 'line_alternatives') then
    if v_status in ('in_review', 'approved', 'superseded') then
      raise exception '%: version % is % (frozen); use fork_version() to edit', tg_table_name, v_version, v_status;
    end if;
    if tg_op = 'UPDATE' and new.version_id is distinct from old.version_id then
      select v.status into v_status from studio.versions v where v.id = old.version_id;
      if v_status in ('in_review', 'approved', 'superseded') then
        raise exception '%: version % is % (frozen); use fork_version() to edit', tg_table_name, old.version_id, v_status;
      end if;
    end if;
  elsif tg_table_name = 'scene_decisions' then
    if tg_op = 'UPDATE' and v_status = 'superseded' and core.is_staff()
      and new.version_id = old.version_id
      and new.scene_id = old.scene_id
      and new.title_id = old.title_id
      and new.decision = old.decision
      and new.line_id is not distinct from old.line_id
      and new.timestamp_ms is not distinct from old.timestamp_ms
      and new.note is not distinct from old.note
      and new.decided_by = old.decided_by
      and new.decided_at = old.decided_at
      and new.decided_kind = old.decided_kind
      and new.created_at = old.created_at then
      return new;
    end if;
    if v_status in ('approved', 'superseded') then
      raise exception 'scene_decisions: version % is % (frozen)', v_version, v_status;
    end if;
    if tg_op <> 'DELETE' and v_status is distinct from 'in_review' then
      raise exception 'scene_decisions: version % is %; decisions need in_review', v_version, v_status;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

-- Trigger names carry a prefix because BEFORE triggers on one table fire in
-- alphabetical order: derive (t1) must run before the frozen guard (t4) reads
-- line_alternatives.version_id, and updated_at (t9) stamps last.

-- external_id freeze
create trigger t2_freeze_external_id before update on core.producers           for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on core.titles              for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on core.episodes            for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on studio.scenes            for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on studio.lines             for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on studio.adaptations       for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on studio.versions          for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on studio.adapted_lines     for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on studio.line_alternatives for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on studio.variants          for each row execute function core.freeze_external_id();
create trigger t2_freeze_external_id before update on studio.clips             for each row execute function core.freeze_external_id();

-- title_id derivation (every studio.* table with a parent other than the title)
create trigger t1_derive_title_id before insert or update on studio.scenes            for each row execute function core.derive_title_id();
create trigger t1_derive_title_id before insert or update on studio.lines             for each row execute function core.derive_title_id();
create trigger t1_derive_title_id before insert or update on studio.versions          for each row execute function core.derive_title_id();
create trigger t1_derive_title_id before insert or update on studio.adapted_lines     for each row execute function core.derive_title_id();
create trigger t1_derive_title_id before insert or update on studio.line_alternatives for each row execute function core.derive_title_id();
create trigger t1_derive_title_id before insert or update on studio.scene_decisions   for each row execute function core.derive_title_id();
create trigger t1_derive_title_id before insert or update on studio.variants          for each row execute function core.derive_title_id();
create trigger t1_derive_title_id before insert or update on studio.clips             for each row execute function core.derive_title_id();

-- timecodes
create trigger t3_guard_timecodes before insert or update on studio.scenes for each row execute function studio.guard_timecodes();
create trigger t3_guard_timecodes before insert or update on studio.lines  for each row execute function studio.guard_timecodes();
create trigger t3_guard_timecodes before insert or update on studio.clips  for each row execute function studio.guard_timecodes();

-- frozen versions
create trigger t4_guard_frozen before update or delete on studio.versions                    for each row execute function studio.guard_frozen();
create trigger t4_guard_frozen before insert or update or delete on studio.adapted_lines     for each row execute function studio.guard_frozen();
create trigger t4_guard_frozen before insert or update or delete on studio.line_alternatives for each row execute function studio.guard_frozen();
create trigger t4_guard_frozen before insert or update or delete on studio.scene_decisions   for each row execute function studio.guard_frozen();

-- write-once source text
create trigger t5_guard_source_text before update on studio.lines for each row execute function studio.guard_source_text();

-- staff scene status stamp
create trigger t6_stamp_scene_status before update of status on studio.scenes for each row execute function studio.stamp_scene_status();

-- updated_at
create trigger t9_updated_at before update on core.titles          for each row execute function core.set_updated_at();
create trigger t9_updated_at before update on studio.versions      for each row execute function core.set_updated_at();
create trigger t9_updated_at before update on studio.adapted_lines for each row execute function core.set_updated_at();
create trigger t9_updated_at before update on studio.variants      for each row execute function core.set_updated_at();

-- ---------------------------------------------------------------------------
-- 8. State-changing functions (SECURITY DEFINER, owned by studio_owner at
--    the end of this file; each checks the caller and writes one audit row)
--
--    Call through PostgREST: supabase.schema('studio').rpc('submit_version',
--    { p_version_id }). Version functions return the version uuid,
--    choose_alternative the adapted line uuid, select_variant the variant
--    uuid, set_scene_status the scene uuid, decide_scene the decision row
--    as jsonb.
-- ---------------------------------------------------------------------------

-- The frozen snapshot: episode, scenes (context, staff status), source
-- lines, adapted lines, characters — never alternatives, never jobs. Row
-- uuids ride along beside the external ids because the partner review UI
-- addresses decide_scene by scene uuid; exports print external ids only.
-- Staff may also call it on a draft: the export of "the current draft"
-- renders from the same shape. lib/types.ts VersionSnapshot mirrors this
-- object key for key (and data/fixture/snapshot.ts builds the same JSON):
-- change one, change all three. Orderings are fixed (characters by name_zh
-- bytewise, scenes by number, lines by seq) so the hash is reproducible.
create or replace function studio.build_snapshot(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v         studio.versions%rowtype;
  v_result  jsonb;
begin
  if not core.is_staff() then
    raise exception 'build_snapshot: staff only' using errcode = '42501';
  end if;
  select * into v from studio.versions where id = p_version_id;
  if not found then
    raise exception 'build_snapshot: version % not found', p_version_id;
  end if;

  select jsonb_build_object(
    'schema', 1,
    'version', jsonb_build_object(
      'id', v.id, 'external_id', v.external_id, 'number', v.number,
      'adaptation_id', a.id, 'adaptation_external_id', a.external_id,
      'target_locale', a.target_locale, 'display_title_en', a.display_title_en
    ),
    'title', jsonb_build_object(
      'id', t.id, 'external_id', t.external_id, 'name_zh', t.name_zh, 'name_en', t.name_en,
      'producer_id', t.producer_id
    ),
    'episode', jsonb_build_object(
      'id', e.id, 'external_id', e.external_id, 'number', e.number,
      'name_zh', e.name_zh, 'name_en', e.name_en,
      'duration_ms', e.duration_ms, 'has_timecodes', e.has_timecodes
    ),
    'characters', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'name_zh', c.name_zh, 'name_en', c.name_en, 'notes', c.notes
      ) order by c.name_zh collate "C"), '[]'::jsonb)
      from studio.characters c where c.title_id = v.title_id
    ),
    'scenes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'external_id', s.external_id, 'number', s.number,
        'start_ms', s.start_ms, 'end_ms', s.end_ms,
        'context_zh', s.context_zh, 'context_en', s.context_en, 'status', s.status,
        'lines', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', l.id, 'external_id', l.external_id, 'seq', l.seq, 'speaker', l.speaker,
            'character_id', l.character_id, 'start_ms', l.start_ms, 'end_ms', l.end_ms,
            'text_zh', l.text_zh, 'literal_en', l.literal_en
          ) order by l.seq), '[]'::jsonb)
          from studio.lines l where l.scene_id = s.id
        ),
        'adapted_lines', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', r.id, 'external_id', r.external_id, 'line_id', r.line_id, 'merges', r.merges,
            'seq', r.seq, 'start_ms', r.start_ms, 'end_ms', r.end_ms,
            'text_en', r.text_en, 'key_phrase_en', r.key_phrase_en, 'back_translation_zh', r.back_translation_zh,
            'change_type', r.change_type, 'is_major', r.is_major,
            'rationale_en', r.rationale_en, 'rationale_zh', r.rationale_zh,
            'tone_note_en', r.tone_note_en, 'tone_note_zh', r.tone_note_zh,
            'tags', r.tags, 'syllables_est', r.syllables_est,
            'authored_by', r.authored_by, 'model', r.model, 'prompt_version', r.prompt_version
          ) order by r.seq), '[]'::jsonb)
          from studio.adapted_lines r where r.version_id = v.id and r.scene_id = s.id
        )
      ) order by s.number), '[]'::jsonb)
      from studio.scenes s where s.episode_id = v.episode_id
    )
  )
  into v_result
  from studio.adaptations a, core.titles t, core.episodes e
  where a.id = v.adaptation_id and t.id = v.title_id and e.id = v.episode_id;

  return v_result;
end
$$;

-- Staff "Approve episode": draft -> in_review. Every scene approved by
-- staff; every changed line carries rationale_zh (and back_translation_zh
-- unless it is a cut, which has no English to translate back). Writes the
-- snapshot and its sha256 over core.canonical_json(snapshot) — the same
-- bytes lib/types.ts canonicalJson() yields, so the app can verify a hash.
create or replace function studio.submit_version(p_version_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v          studio.versions%rowtype;
  v_snapshot jsonb;
  v_sha      text;
  v_missing  int;
begin
  if not core.is_staff() then
    raise exception 'submit_version: staff only' using errcode = '42501';
  end if;
  select * into v from studio.versions where id = p_version_id for update;
  if not found then
    raise exception 'submit_version: version % not found', p_version_id;
  end if;
  if v.status <> 'draft' then
    raise exception 'submit_version: version is %, expected draft', v.status;
  end if;
  if not exists (select 1 from studio.scenes s where s.episode_id = v.episode_id) then
    raise exception 'submit_version: the episode has no scenes';
  end if;

  select count(*) into v_missing
  from studio.scenes s
  where s.episode_id = v.episode_id and s.status <> 'approved';
  if v_missing > 0 then
    raise exception 'submit_version: % scene(s) not yet approved by staff', v_missing;
  end if;

  select count(*) into v_missing
  from studio.lines l
  join studio.scenes s on s.id = l.scene_id
  where s.episode_id = v.episode_id
    and l.merged_into_id is null
    and not exists (
      select 1 from studio.adapted_lines r
      where r.version_id = v.id and r.line_id = l.id
    );
  if v_missing > 0 then
    raise exception 'submit_version: % source line(s) still need an English adaptation', v_missing;
  end if;

  select count(*) into v_missing
  from studio.adapted_lines r
  join studio.scenes s on s.id = r.scene_id
  where r.version_id = v.id
    and s.episode_id = v.episode_id
    and r.change_type <> 'cut'
    and nullif(btrim(r.text_en), '') is null;
  if v_missing > 0 then
    raise exception 'submit_version: % adapted line(s) are empty', v_missing;
  end if;

  select count(*) into v_missing
  from studio.adapted_lines r
  where r.version_id = v.id
    and r.change_type <> 'keep'
    and (
      nullif(btrim(r.rationale_zh), '') is null
      or (r.change_type <> 'cut' and nullif(btrim(r.back_translation_zh), '') is null)
    );
  if v_missing > 0 then
    raise exception 'submit_version: % changed line(s) lack rationale_zh or back_translation_zh', v_missing;
  end if;

  if v.parent_version_id is not null then
    select count(*) into v_missing
    from studio.scene_decisions d
    where d.version_id = v.parent_version_id
      and d.decision = 'needs_alternative'
      and d.resolution_disposition is null;
    if v_missing > 0 then
      raise exception 'submit_version: % producer request(s) still need a Pulsar response', v_missing;
    end if;
  end if;

  v_snapshot := studio.build_snapshot(v.id);
  v_sha      := encode(sha256(convert_to(core.canonical_json(v_snapshot), 'UTF8')), 'hex');

  update studio.versions
     set status = 'in_review',
         submitted_at = now(),
         submitted_by = core.current_uid(),
         snapshot = v_snapshot,
         snapshot_sha256 = v_sha
   where id = v.id;

  perform core.audit('submit_version', 'studio.versions', v.id, v.title_id, null,
    jsonb_build_object('status', v.status),
    jsonb_build_object('status', 'in_review', 'snapshot_sha256', v_sha),
    null, 'in_app');
  return v.id;
end
$$;

-- The only partner write. A producer approver or reviewer on the title, or
-- a staff admin with a note as evidence (recorded as staff_on_behalf).
-- Upserts, so the partner may change their mind while the version is still
-- in_review; guard_frozen refuses anything later.
create or replace function studio.decide_scene(
  p_version_id uuid,
  p_scene_id   uuid,
  p_decision   studio.scene_decision,
  p_note       text default null,
  p_line_id    uuid default null,
  p_channel    text default 'in_app'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v        studio.versions%rowtype;
  v_uid    uuid := core.current_uid();
  v_kind   studio.decided_kind;
  v_before jsonb;
  v_row    studio.scene_decisions%rowtype;
begin
  select * into v from studio.versions where id = p_version_id for update;
  if not found then
    raise exception 'decide_scene: version % not found', p_version_id;
  end if;
  if v.status <> 'in_review' then
    raise exception 'decide_scene: version is %, decisions need in_review', v.status;
  end if;
  if not exists (select 1 from studio.scenes s where s.id = p_scene_id and s.episode_id = v.episode_id) then
    raise exception 'decide_scene: scene % is not in this version''s episode', p_scene_id;
  end if;

  if core.is_producer_reviewer(v.title_id) then
    v_kind := 'producer';
  elsif core.is_staff_admin() then
    if p_note is null or btrim(p_note) = '' then
      raise exception 'decide_scene: an evidence note is required to decide on the producer''s behalf';
    end if;
    v_kind := 'staff_on_behalf';
  else
    raise exception 'decide_scene: producer approver/reviewer of this title or staff admin only' using errcode = '42501';
  end if;
  if p_decision = 'needs_alternative' and (p_note is null or btrim(p_note) = '') then
    raise exception 'decide_scene: needs_alternative requires a one-line reason';
  end if;
  if p_decision = 'needs_alternative' and not exists (
    select 1 from studio.lines l where l.id = p_line_id and l.scene_id = p_scene_id
  ) then
    raise exception 'decide_scene: needs_alternative requires a timestamped line in this scene';
  end if;

  select to_jsonb(d) into v_before from studio.scene_decisions d
  where d.version_id = p_version_id and d.scene_id = p_scene_id;

  insert into studio.scene_decisions (
    version_id, scene_id, title_id, decision, line_id, timestamp_ms, note,
    resolution_disposition, resolution_note, responded_by, responded_at,
    decided_by, decided_at, decided_kind
  )
  values (
    p_version_id, p_scene_id, v.title_id, p_decision,
    case when p_decision = 'needs_alternative' then p_line_id else null end,
    case when p_decision = 'needs_alternative' then (select start_ms from studio.lines where id = p_line_id) else null end,
    p_note, null, null, null, null, v_uid, now(), v_kind
  )
  on conflict (version_id, scene_id) do update
    set decision     = excluded.decision,
        line_id      = excluded.line_id,
        timestamp_ms = excluded.timestamp_ms,
        note         = excluded.note,
        resolution_disposition = null,
        resolution_note = null,
        responded_by = null,
        responded_at = null,
        decided_by   = excluded.decided_by,
        decided_at   = now(),
        decided_kind = excluded.decided_kind
  returning * into v_row;

  perform core.audit('decide_scene', 'studio.scene_decisions', p_scene_id, v.title_id, null,
    v_before, to_jsonb(v_row), p_note, p_channel);
  return to_jsonb(v_row);
end
$$;

-- Pulsar's reply to timestamped producer feedback. This is deliberately
-- separate from the producer decision: the request remains immutable while
-- staff records whether they agreed and what changed in the next revision.
create or replace function studio.respond_to_scene_feedback(
  p_version_id uuid,
  p_scene_id uuid,
  p_disposition text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v studio.versions%rowtype;
  v_before jsonb;
  v_row studio.scene_decisions%rowtype;
begin
  if not core.is_staff() then
    raise exception 'respond_to_scene_feedback: staff only' using errcode = '42501';
  end if;
  if p_disposition not in ('agreed', 'partially_agreed', 'disagreed') then
    raise exception 'respond_to_scene_feedback: invalid disposition';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'respond_to_scene_feedback: response note is required';
  end if;
  select * into v from studio.versions where id = p_version_id;
  if not found then raise exception 'respond_to_scene_feedback: version not found'; end if;
  select to_jsonb(d) into v_before from studio.scene_decisions d
    where d.version_id = p_version_id and d.scene_id = p_scene_id and d.decision = 'needs_alternative';
  if v_before is null then raise exception 'respond_to_scene_feedback: request not found'; end if;
  update studio.scene_decisions
    set resolution_disposition = p_disposition,
        resolution_note = btrim(p_note),
        responded_by = core.current_uid(),
        responded_at = now()
    where version_id = p_version_id and scene_id = p_scene_id
    returning * into v_row;
  perform core.audit('respond_to_feedback', 'studio.scene_decisions', p_scene_id, v.title_id, null,
    v_before, to_jsonb(v_row), p_note, 'in_app');
  return to_jsonb(v_row);
end
$$;

-- Partner "Approve episode": in_review -> approved. in_app: the producer
-- approver, every scene decided 'approved'. on_behalf: a staff admin with an
-- evidence note; any scene still undecided (or sent back) gets an approved
-- decision with that note as staff_on_behalf so the record is complete.
-- The previously approved version of the same (adaptation, episode) becomes
-- superseded. The snapshot is untouched — frozen since submit.
create or replace function studio.approve_version(
  p_version_id uuid,
  p_mode       studio.approval_mode default 'in_app',
  p_evidence   text default null,
  p_note       text default null,
  p_channel    text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v         studio.versions%rowtype;
  v_uid     uuid := core.current_uid();
  v_missing int;
  v_prev    uuid;
  v_channel text := coalesce(p_channel, 'in_app');
begin
  select * into v from studio.versions where id = p_version_id for update;
  if not found then
    raise exception 'approve_version: version % not found', p_version_id;
  end if;
  if v.status <> 'in_review' then
    raise exception 'approve_version: version is %, expected in_review', v.status;
  end if;

  if p_mode = 'in_app' then
    if not core.is_producer_approver(v.title_id) then
      raise exception 'approve_version: producer approver of this title only' using errcode = '42501';
    end if;
    select count(*) into v_missing
    from studio.scenes s
    where s.episode_id = v.episode_id
      and not exists (
        select 1 from studio.scene_decisions d
        where d.version_id = v.id and d.scene_id = s.id and d.decision = 'approved'
      );
    if v_missing > 0 then
      raise exception 'approve_version: % scene(s) not approved yet', v_missing;
    end if;
  else
    if not core.is_staff_admin() then
      raise exception 'approve_version: on_behalf is for staff admins only' using errcode = '42501';
    end if;
    if p_evidence is null or btrim(p_evidence) = '' then
      raise exception 'approve_version: on_behalf requires an evidence note';
    end if;
    insert into studio.scene_decisions as d (version_id, scene_id, title_id, decision, note, decided_by, decided_at, decided_kind)
    select v.id, s.id, v.title_id, 'approved', p_evidence, v_uid, now(), 'staff_on_behalf'
    from studio.scenes s
    where s.episode_id = v.episode_id
    on conflict (version_id, scene_id) do update
      set decision     = 'approved',
          line_id      = null,
          timestamp_ms = null,
          note         = excluded.note,
          resolution_disposition = null,
          resolution_note = null,
          responded_by = null,
          responded_at = null,
          decided_by   = excluded.decided_by,
          decided_at   = now(),
          decided_kind = 'staff_on_behalf'
      where d.decision <> 'approved';
  end if;

  -- supersede first so the one-approved partial unique index stays satisfied
  update studio.versions
     set status = 'superseded'
   where adaptation_id = v.adaptation_id
     and episode_id = v.episode_id
     and status = 'approved'
     and id <> v.id
  returning id into v_prev;

  update studio.versions
     set status = 'approved',
         approved_at = now(),
         approved_by = v_uid,
         approval_mode = p_mode,
         approval_evidence = p_evidence,
         approval_note = p_note
   where id = v.id;

  if v_prev is not null then
    perform core.audit('supersede_version', 'studio.versions', v_prev, v.title_id, null,
      jsonb_build_object('status', 'approved'),
      jsonb_build_object('status', 'superseded', 'superseded_by', v.id),
      null, v_channel);
  end if;
  perform core.audit('approve_version', 'studio.versions', v.id, v.title_id, null,
    jsonb_build_object('status', 'in_review'),
    jsonb_build_object('status', 'approved', 'approval_mode', p_mode),
    coalesce(p_note, p_evidence), v_channel);
  return v.id;
end
$$;

-- Staff, from an in_review (after needs_alternative) or approved version:
-- a new draft with number max+1, adapted lines copied (provenance kept),
-- nothing from line_alternatives or scene_decisions. Scenes the partner
-- sent back drop to draft; every other scene keeps its staff status. A
-- forked in_review version becomes superseded so the partner stops seeing it.
create or replace function studio.fork_version(p_version_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      studio.versions%rowtype;
  v_new  uuid;
  v_next int;
begin
  if not core.is_staff() then
    raise exception 'fork_version: staff only' using errcode = '42501';
  end if;
  select * into v from studio.versions where id = p_version_id for update;
  if not found then
    raise exception 'fork_version: version % not found', p_version_id;
  end if;
  if v.status not in ('in_review', 'approved') then
    raise exception 'fork_version: version is %, expected in_review or approved', v.status;
  end if;
  if v.status = 'in_review' and exists (
    select 1
    from studio.scenes s
    where s.episode_id = v.episode_id
      and not exists (
        select 1 from studio.scene_decisions d
        where d.version_id = v.id and d.scene_id = s.id
      )
  ) then
    raise exception 'fork_version: producer review still has undecided scenes';
  end if;
  if exists (
    select 1 from studio.versions x
    where x.adaptation_id = v.adaptation_id and x.episode_id = v.episode_id and x.status = 'draft'
  ) then
    raise exception 'fork_version: an open draft already exists for this episode';
  end if;

  select coalesce(max(x.number), 0) + 1 into v_next
  from studio.versions x
  where x.adaptation_id = v.adaptation_id and x.episode_id = v.episode_id;

  insert into studio.versions (title_id, adaptation_id, episode_id, number, parent_version_id)
  values (v.title_id, v.adaptation_id, v.episode_id, v_next, v.id)
  returning id into v_new;

  insert into studio.adapted_lines (
    title_id, version_id, scene_id, line_id, merges, seq, start_ms, end_ms,
    text_en, key_phrase_en, back_translation_zh, change_type, is_major,
    rationale_en, rationale_zh, tone_note_en, tone_note_zh, tags, syllables_est,
    authored_by, model, prompt_version, ai_text_en, ai_rationale_zh, edited_by
  )
  select
    r.title_id, v_new, r.scene_id, r.line_id, r.merges, r.seq, r.start_ms, r.end_ms,
    r.text_en, r.key_phrase_en, r.back_translation_zh, r.change_type, r.is_major,
    r.rationale_en, r.rationale_zh, r.tone_note_en, r.tone_note_zh, r.tags, r.syllables_est,
    r.authored_by, r.model, r.prompt_version, r.ai_text_en, r.ai_rationale_zh, r.edited_by
  from studio.adapted_lines r
  where r.version_id = v.id;

  update studio.scenes s
     set status = 'draft'
   where s.episode_id = v.episode_id
     and s.status <> 'draft'
     and exists (
       select 1 from studio.scene_decisions d
       where d.version_id = v.id and d.scene_id = s.id and d.decision = 'needs_alternative'
     );

  if v.status = 'in_review' then
    update studio.versions set status = 'superseded' where id = v.id;
  end if;

  perform core.audit('fork_version', 'studio.versions', v_new, v.title_id, null,
    jsonb_build_object('parent_version_id', v.id, 'parent_status', v.status),
    jsonb_build_object('status', 'draft', 'number', v_next),
    null, 'in_app');
  return v_new;
end
$$;

-- Staff editor picks one alternative: the flag moves to that row and its
-- text, back-translation, rationale pair, tags, estimate and provenance are
-- copied onto the adapted line. authored_by stays 'ai' (model-written);
-- ai_text_en / ai_rationale_zh (the first pass) are untouched. A frozen
-- version raises from guard_frozen on the first update.
create or replace function studio.choose_alternative(p_alternative_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  alt   studio.line_alternatives%rowtype;
  v_uid uuid := core.current_uid();
begin
  if not core.is_staff() then
    raise exception 'choose_alternative: staff only' using errcode = '42501';
  end if;
  select * into alt from studio.line_alternatives where id = p_alternative_id for update;
  if not found then
    raise exception 'choose_alternative: alternative % not found', p_alternative_id;
  end if;

  update studio.line_alternatives
     set chosen = false, chosen_by = null, chosen_at = null
   where adapted_line_id = alt.adapted_line_id and chosen and id <> alt.id;

  update studio.line_alternatives
     set chosen = true, chosen_by = v_uid, chosen_at = now()
   where id = alt.id;

  update studio.adapted_lines
     set text_en = alt.text_en,
         back_translation_zh = alt.back_translation_zh,
         rationale_en = alt.rationale_en,
         rationale_zh = alt.rationale_zh,
         tags = alt.tags,
         syllables_est = alt.syllables_est,
         model = alt.model,
         prompt_version = alt.prompt_version,
         authored_by = 'ai',
         edited_by = v_uid
   where id = alt.adapted_line_id;

  perform core.audit('choose_alternative', 'studio.adapted_lines', alt.adapted_line_id, alt.title_id, null,
    null,
    jsonb_build_object('alternative_id', alt.id, 'alternative_external_id', alt.external_id),
    null, 'in_app');
  return alt.adapted_line_id;
end
$$;

-- The platform pick: one title, one hook per title. Only a candidate of
-- kind title | hook; the previous pick of the same kind is cleared; a
-- selected title is mirrored into adaptations.display_title_en.
create or replace function studio.select_variant(p_variant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_var  studio.variants%rowtype;
  v_prev uuid;
begin
  if not core.is_staff() then
    raise exception 'select_variant: staff only' using errcode = '42501';
  end if;
  select * into v_var from studio.variants where id = p_variant_id for update;
  if not found then
    raise exception 'select_variant: variant % not found', p_variant_id;
  end if;
  if v_var.kind not in ('title', 'hook') then
    raise exception 'select_variant: only title and hook variants can be selected, not %', v_var.kind;
  end if;
  if v_var.status <> 'candidate' then
    raise exception 'select_variant: a % variant cannot be selected', v_var.status;
  end if;

  update studio.variants
     set selected = false
   where title_id = v_var.title_id and kind = v_var.kind and selected and id <> v_var.id
  returning id into v_prev;

  update studio.variants set selected = true where id = v_var.id;

  if v_var.kind = 'title' then
    update studio.adaptations set display_title_en = v_var.text_en where id = v_var.adaptation_id;
  end if;

  perform core.audit('select_variant', 'studio.variants', v_var.id, v_var.title_id, null,
    jsonb_build_object('previous_selected_id', v_prev),
    jsonb_build_object('kind', v_var.kind, 'selected', true),
    null, 'in_app');
  return v_var.id;
end
$$;

-- Staff working status of a scene (POST .../scenes/[sceneId]/status). The
-- stamp trigger writes status_by / status_at. Status changes go through this
-- function so the readiness gate cannot be bypassed by a direct table update.
create or replace function studio.set_scene_status(p_scene_id uuid, p_status studio.scene_status)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  s         studio.scenes%rowtype;
  v_version uuid;
  v_missing int;
begin
  if not core.is_staff() then
    raise exception 'set_scene_status: staff only' using errcode = '42501';
  end if;
  select * into s from studio.scenes where id = p_scene_id for update;
  if not found then
    raise exception 'set_scene_status: scene % not found', p_scene_id;
  end if;
  if s.status = p_status then
    return s.id;
  end if;

  select v.id into v_version
  from studio.versions v
  where v.episode_id = s.episode_id and v.status = 'draft'
  limit 1;
  if v_version is null then
    raise exception 'set_scene_status: no editable draft exists; fork the submitted version first';
  end if;

  if p_status = 'approved' then
    select count(*) into v_missing
    from studio.lines l
    left join studio.adapted_lines r
      on r.version_id = v_version and r.line_id = l.id
    where l.scene_id = s.id
      and l.merged_into_id is null
      and (
        r.id is null
        or (r.change_type <> 'cut' and nullif(btrim(r.text_en), '') is null)
        or (
          r.change_type <> 'keep'
          and (
            nullif(btrim(r.rationale_zh), '') is null
            or (r.change_type <> 'cut' and nullif(btrim(r.back_translation_zh), '') is null)
          )
        )
      );
    if v_missing > 0 then
      raise exception 'set_scene_status: scene is not ready; % line(s) need adaptation details', v_missing;
    end if;
  end if;

  update studio.scenes set status = p_status where id = s.id;

  perform core.audit('set_scene_status', 'studio.scenes', s.id, s.title_id, null,
    jsonb_build_object('status', s.status),
    jsonb_build_object('status', p_status),
    null, 'in_app');
  return s.id;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Ownership and grants
-- ---------------------------------------------------------------------------

-- Every function in core and studio is owned by studio_owner: the SECURITY
-- DEFINER ones run as it, the trigger functions run as the invoking user
-- whoever owns them. Tables keep the migrating role as owner; studio_owner
-- gets full table grants plus an RLS policy of its own (section 10).
do $$
declare
  r record;
begin
  for r in
    select n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('core', 'studio')
  loop
    execute format('alter function %I.%I(%s) owner to studio_owner', r.nspname, r.proname, r.args);
  end loop;
end
$$;

grant usage on schema core, studio to studio_owner, authenticated, service_role;
revoke all on schema core, studio from anon;

grant select, insert, update, delete on all tables in schema core, studio to studio_owner, service_role;
grant usage, select on all sequences in schema core, studio to studio_owner, service_role, authenticated;
revoke all on all tables in schema core, studio from anon;

-- authenticated: table-level grants, then the tables whose status columns
-- move only through functions get column lists instead. (A column-level
-- REVOKE does nothing against a table-level GRANT, so the pattern is
-- revoke-the-table, grant-the-columns.)
grant select, insert, update, delete on all tables in schema core, studio to authenticated;

-- append-only, and only the functions append
revoke insert, update, delete on core.audit_events from authenticated;

-- the partner's decisions: decide_scene / approve_version only
revoke insert, update, delete on studio.scene_decisions from authenticated;

-- versions: create a draft; every status / approval / snapshot column moves
-- through submit_version / approve_version / fork_version. DEVIATION: the
-- doc revokes UPDATE on the listed columns; no remaining column is a
-- legitimate direct edit, so UPDATE is not granted at all.
revoke insert, update on studio.versions from authenticated;
grant insert (title_id, adaptation_id, episode_id, number, parent_version_id) on studio.versions to authenticated;

-- scenes: status_by / status_at are trigger-stamped
revoke insert, update on studio.scenes from authenticated;
grant insert (title_id, episode_id, number, start_ms, end_ms, context_zh, context_en, status) on studio.scenes to authenticated;
grant update (episode_id, number, start_ms, end_ms, context_zh, context_en) on studio.scenes to authenticated;

-- line_alternatives: chosen / chosen_by / chosen_at via choose_alternative
revoke insert, update on studio.line_alternatives from authenticated;
grant insert (title_id, version_id, adapted_line_id, seq, text_en, back_translation_zh, rationale_zh, rationale_en,
              tags, syllables_est, model, prompt_version, job_id) on studio.line_alternatives to authenticated;
grant update (text_en, back_translation_zh, rationale_zh, rationale_en, tags, syllables_est) on studio.line_alternatives to authenticated;

-- variants: selected via select_variant
revoke insert, update on studio.variants from authenticated;
grant insert (title_id, adaptation_id, kind, text_en, text_zh, rationale_en, rationale_zh, tags, status,
              model, prompt_version, job_id, created_by) on studio.variants to authenticated;
grant update (kind, text_en, text_zh, rationale_en, rationale_zh, tags, status) on studio.variants to authenticated;

-- Functions: the state changers are callable by signed-in users (each checks
-- the caller itself) and by scripts; the audit writer and the snapshot
-- builder are internal. The predicates keep the default PUBLIC execute so
-- the RLS policies can evaluate them as any role.
revoke execute on function core.audit(text, text, uuid, uuid, uuid, jsonb, jsonb, text, text) from public;
revoke execute on function studio.build_snapshot(uuid) from public;
grant execute on function studio.build_snapshot(uuid) to authenticated, service_role;
-- canonical_json is pure; a client may recompute a snapshot hash with it.
grant execute on function core.canonical_json(jsonb) to authenticated, service_role;

revoke execute on function studio.submit_version(uuid) from public;
revoke execute on function studio.decide_scene(uuid, uuid, studio.scene_decision, text, uuid, text) from public;
revoke execute on function studio.respond_to_scene_feedback(uuid, uuid, text, text) from public;
revoke execute on function studio.approve_version(uuid, studio.approval_mode, text, text, text) from public;
revoke execute on function studio.fork_version(uuid) from public;
revoke execute on function studio.choose_alternative(uuid) from public;
revoke execute on function studio.select_variant(uuid) from public;
revoke execute on function studio.set_scene_status(uuid, studio.scene_status) from public;

grant execute on function studio.submit_version(uuid) to authenticated, service_role;
grant execute on function studio.decide_scene(uuid, uuid, studio.scene_decision, text, uuid, text) to authenticated, service_role;
grant execute on function studio.respond_to_scene_feedback(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function studio.approve_version(uuid, studio.approval_mode, text, text, text) to authenticated, service_role;
grant execute on function studio.fork_version(uuid) to authenticated, service_role;
grant execute on function studio.choose_alternative(uuid) to authenticated, service_role;
grant execute on function studio.select_variant(uuid) to authenticated, service_role;
grant execute on function studio.set_scene_status(uuid, studio.scene_status) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. Row level security (deny by default; docs/data-model.md § 3 table)
-- ---------------------------------------------------------------------------

alter table core.producers          enable row level security;
alter table core.profiles           enable row level security;
alter table core.titles             enable row level security;
alter table core.episodes           enable row level security;
alter table core.audit_events       enable row level security;
alter table studio.characters       enable row level security;
alter table studio.scenes           enable row level security;
alter table studio.lines            enable row level security;
alter table studio.adaptations      enable row level security;
alter table studio.versions         enable row level security;
alter table studio.jobs             enable row level security;
alter table studio.adapted_lines    enable row level security;
alter table studio.line_alternatives enable row level security;
alter table studio.scene_decisions  enable row level security;
alter table studio.variants         enable row level security;
alter table studio.clips            enable row level security;

-- studio_owner: the SECURITY DEFINER functions see everything
create policy owner_all on core.producers           for all to studio_owner using (true) with check (true);
create policy owner_all on core.profiles            for all to studio_owner using (true) with check (true);
create policy owner_all on core.titles              for all to studio_owner using (true) with check (true);
create policy owner_all on core.episodes            for all to studio_owner using (true) with check (true);
create policy owner_all on core.audit_events        for all to studio_owner using (true) with check (true);
create policy owner_all on studio.characters        for all to studio_owner using (true) with check (true);
create policy owner_all on studio.scenes            for all to studio_owner using (true) with check (true);
create policy owner_all on studio.lines             for all to studio_owner using (true) with check (true);
create policy owner_all on studio.adaptations       for all to studio_owner using (true) with check (true);
create policy owner_all on studio.versions          for all to studio_owner using (true) with check (true);
create policy owner_all on studio.jobs              for all to studio_owner using (true) with check (true);
create policy owner_all on studio.adapted_lines     for all to studio_owner using (true) with check (true);
create policy owner_all on studio.line_alternatives for all to studio_owner using (true) with check (true);
create policy owner_all on studio.scene_decisions   for all to studio_owner using (true) with check (true);
create policy owner_all on studio.variants          for all to studio_owner using (true) with check (true);
create policy owner_all on studio.clips             for all to studio_owner using (true) with check (true);

-- staff: everything (the table grants above and the frozen triggers narrow it)
create policy staff_all on core.producers           for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on core.profiles            for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on core.titles              for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on core.episodes            for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_select on core.audit_events     for select to authenticated using (core.is_staff());
create policy staff_all on studio.characters        for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on studio.scenes            for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on studio.lines             for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on studio.adaptations       for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on studio.versions          for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on studio.adapted_lines     for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on studio.line_alternatives for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_select on studio.scene_decisions for select to authenticated using (core.is_staff());
create policy staff_all on studio.variants          for all to authenticated using (core.is_staff()) with check (core.is_staff());
create policy staff_all on studio.clips             for all to authenticated using (core.is_staff()) with check (core.is_staff());
-- DEVIATION: the doc gives staff SELECT on jobs and the service role the
-- writes; V1 runs every job inline in a route handler under the staff
-- session (RLS client), so staff need the writes too.
create policy staff_all on studio.jobs              for all to authenticated using (core.is_staff()) with check (core.is_staff());

-- producer: own titles, read only; versions from in_review on; no variants,
-- clips or jobs at all
create policy producer_select on core.producers     for select to authenticated using (id = core.my_producer_id());
create policy producer_select on core.profiles      for select to authenticated
  using (id = core.current_uid() or (producer_id is not null and producer_id = core.my_producer_id()));
create policy producer_select on core.titles        for select to authenticated using (core.can_read_title(id));
create policy producer_select on core.episodes      for select to authenticated using (core.can_read_title(title_id));
create policy producer_select on core.audit_events  for select to authenticated
  using (producer_id is not null and producer_id = core.my_producer_id());
create policy producer_select on studio.characters  for select to authenticated using (core.can_read_title(title_id));
create policy producer_select on studio.scenes      for select to authenticated using (core.can_read_title(title_id));
create policy producer_select on studio.lines       for select to authenticated using (core.can_read_title(title_id));
create policy producer_select on studio.adaptations for select to authenticated using (core.can_read_title(title_id));
create policy producer_select on studio.versions    for select to authenticated
  using (studio.version_readable(id));
create policy producer_select on studio.adapted_lines     for select to authenticated using (studio.version_readable(version_id));
create policy producer_select on studio.line_alternatives for select to authenticated using (studio.version_readable(version_id));
create policy producer_select on studio.scene_decisions   for select to authenticated using (studio.version_readable(version_id));

-- ---------------------------------------------------------------------------
-- 11. Storage bucket and policies
--
-- ONE bucket in V1 (docs/data-model.md § 3, decisions.md "Stack"):
-- studio-media, private, holding the episode video and, when kept, the
-- delivered subtitle / script file under <title_id>/<episode_id>/..., so the
-- object policies mirror core.can_read_title on the first path segment.
-- Exports are rendered on request, never stored; on-behalf evidence is a
-- text note on the version. studio-exports, studio-evidence, studio-audio,
-- studio-renders and studio-thumbs are [Later] and arrive with the migration
-- that needs them. Producers never write (A2). Wrapped in a DO block so a
-- non-Supabase Postgres, or a project where the migrating role cannot create
-- policies on storage.objects, applies the rest of the file and prints what
-- to do by hand (supabase/README.md).
-- ---------------------------------------------------------------------------

do $$
begin
  insert into storage.buckets (id, name, public)
  values ('studio-media', 'studio-media', false)
  on conflict (id) do nothing;

  drop policy if exists studio_media_select on storage.objects;
  drop policy if exists studio_media_insert on storage.objects;
  drop policy if exists studio_media_update on storage.objects;
  drop policy if exists studio_media_delete on storage.objects;

  create policy studio_media_select on storage.objects for select to authenticated
    using (bucket_id = 'studio-media' and core.can_read_title(core.title_id_from_path(name)));
  create policy studio_media_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'studio-media' and core.is_staff() and core.title_id_from_path(name) is not null);
  create policy studio_media_update on storage.objects for update to authenticated
    using (bucket_id = 'studio-media' and core.is_staff())
    with check (bucket_id = 'studio-media' and core.is_staff() and core.title_id_from_path(name) is not null);
  create policy studio_media_delete on storage.objects for delete to authenticated
    using (bucket_id = 'studio-media' and core.is_staff());
exception
  when invalid_schema_name or undefined_table then
    raise notice 'storage schema not present: bucket and storage policies skipped (not a Supabase project?)';
  when insufficient_privilege then
    raise notice 'storage policies could not be created by %; create the private bucket studio-media and the policies in Dashboard > Storage (see supabase/README.md)', current_user;
end
$$;

commit;
