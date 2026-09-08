-- 0004 · The market desk (decision 2026-09-06, "Studio becomes the market desk").
--
-- Two things live in the database for research; the public-catalog snapshot
-- itself does not (it is committed under data/research/snapshots and read
-- identically by both data sources, lib/research/snapshot.ts).
--
-- 1. core.producers.research_profile — the onboarding answers that
--    personalize the desk. A producer editor (approver/reviewer) may update
--    their own company's row and nothing else on it.
-- 2. research.title_observations — the append-only landing table for the
--    daily crawl, so a Supabase deployment can hold history the repo does
--    not. The row shape mirrors lib/research/types MarketTitle. Nothing
--    reads it yet; the loader reads the committed files until the crawl job
--    writes here (docs/research-feasibility.md § next).

alter table core.producers
  add column if not exists research_profile jsonb;

create or replace function core.can_edit_producer(p_producer_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select exists (
    select 1 from core.profiles p
    where p.id = auth.uid()
      and p.kind = 'producer'
      and p.producer_id = p_producer_id
      and p.producer_role in ('approver', 'reviewer')
  );
$$;

-- A producer editor may write their own research_profile. The trigger keeps
-- every other column immutable from that side; staff paths are unchanged.
drop policy if exists producer_update_own_profile on core.producers;
create policy producer_update_own_profile on core.producers for update to authenticated
  using (core.can_edit_producer(id)) with check (core.can_edit_producer(id));

create or replace function core.guard_producer_self_update()
returns trigger language plpgsql as $$
begin
  if core.is_staff() then return new; end if;
  if new.id <> old.id or new.external_id <> old.external_id or new.slug <> old.slug
     or new.name_zh <> old.name_zh or new.name_en is distinct from old.name_en
     or new.contact_email is distinct from old.contact_email
     or new.contact_wechat is distinct from old.contact_wechat
     or new.deliverables is distinct from old.deliverables
     or new.created_at <> old.created_at then
    raise exception 'producers may only change research_profile' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_producer_self_update on core.producers;
create trigger guard_producer_self_update before update on core.producers
  for each row execute function core.guard_producer_self_update();

-- ---- research schema: the crawl's landing table ---------------------------

create schema if not exists research;
grant usage, create on schema research to studio_owner;
grant usage on schema research to authenticated, service_role;

create type research.platform as enum ('reelshort', 'dramabox');
create type research.evidence as enum ('observed', 'inferred', 'estimated', 'partner_reported');

create table research.crawls (
  id uuid primary key default gen_random_uuid(),
  platform research.platform not null,
  observed_at date not null,
  fetched_at timestamptz not null,
  source_urls text[] not null default '{}',
  title_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (platform, observed_at)
);

create table research.title_observations (
  id uuid primary key default gen_random_uuid(),
  crawl_id uuid not null references research.crawls(id) on delete cascade,
  platform research.platform not null,
  platform_id text not null,
  key text generated always as (platform::text || '-' || platform_id) stored,
  title text not null,
  blurb text not null default '',
  cover text,
  url text not null,
  studio_name text,
  studio_evidence research.evidence,
  lead text check (lead in ('female', 'male')),
  episode_count integer,
  paywall_episode integer,
  episode_seconds integer,
  released_at date,
  is_new boolean not null default false,
  platform_tags text[] not null default '{}',
  tropes jsonb not null default '[]',
  views bigint,
  saves bigint,
  rating numeric,
  metric_evidence research.evidence not null default 'observed',
  placements jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (crawl_id, platform, platform_id)
);

create index title_observations_key_idx on research.title_observations (key, crawl_id);

alter table research.crawls enable row level security;
alter table research.title_observations enable row level security;

-- Market data is Studio-wide: every signed-in member reads it. Only the
-- crawl job (service role) writes.
create policy members_read_crawls on research.crawls for select to authenticated using (true);
create policy members_read_observations on research.title_observations for select to authenticated using (true);
