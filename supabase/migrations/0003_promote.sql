-- 0003 · Promote is a sibling product to Studio adaptation.
-- It references core.titles / core.episodes, but never studio.adaptations or
-- subtitle versions. Approval freezes the exact creative metadata that may
-- cross into Grow; later creative edits must create a new version row.

create schema if not exists promote;
grant usage, create on schema promote to studio_owner;
grant usage on schema promote to authenticated, service_role;

create type promote.campaign_status as enum
  ('draft', 'generating', 'review', 'approved', 'submitted', 'launching', 'live', 'failed');
create type promote.creative_kind as enum ('direct_clip', 'ugc_story', 'ugc_reaction');
create type promote.creative_status as enum ('draft', 'ready', 'approved', 'rejected', 'not_selected', 'superseded');
create type promote.objective as enum ('installs', 'subscriptions', 'views');
create type promote.spoiler_level as enum ('low', 'medium', 'high');
create type promote.handoff_status as enum ('pending', 'accepted', 'failed', 'unknown');

create table promote.campaigns (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique default core.ext_id('pb'),
  title_id uuid not null references core.titles(id) on delete cascade,
  producer_id uuid not null references core.producers(id),
  name text not null check (length(trim(name)) > 0),
  target_market text not null check (length(trim(target_market)) > 0),
  destination_url text,
  objective promote.objective not null default 'subscriptions',
  spoiler_level promote.spoiler_level not null default 'medium',
  creative_direction text,
  exclusions text,
  status promote.campaign_status not null default 'draft',
  grow_campaign_id text,
  created_by uuid not null references core.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, title_id),
  unique (id, producer_id)
);

create table promote.creatives (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique default core.ext_id('pc'),
  campaign_id uuid not null references promote.campaigns(id) on delete cascade,
  title_id uuid not null references core.titles(id) on delete cascade,
  parent_creative_id uuid references promote.creatives(id),
  version integer not null default 1 check (version > 0),
  kind promote.creative_kind not null,
  status promote.creative_status not null default 'draft',
  hypothesis text not null,
  source_episode_id uuid references core.episodes(id),
  source_start_ms integer check (source_start_ms is null or source_start_ms >= 0),
  source_end_ms integer check (source_end_ms is null or source_end_ms > source_start_ms),
  hook text not null,
  caption text not null,
  ad_description text not null,
  render_path text,
  render_sha256 text check (render_sha256 is null or render_sha256 ~ '^[0-9a-f]{64}$'),
  duration_ms integer,
  width integer,
  height integer,
  render_settings jsonb not null default '{}'::jsonb,
  rejection_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (external_id, version)
);

create table promote.approvals (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null unique references promote.campaigns(id) on delete cascade,
  producer_id uuid not null references core.producers(id),
  approved_by uuid not null references core.profiles(id),
  manifest jsonb not null,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table promote.handoffs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references promote.campaigns(id) on delete cascade,
  idempotency_key text not null unique,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  status promote.handoff_status not null default 'pending',
  grow_campaign_id text,
  response jsonb,
  error text,
  attempted_at timestamptz not null default now()
);

create index promo_campaigns_producer_updated_idx on promote.campaigns(producer_id, updated_at desc);
create index promo_creatives_campaign_idx on promote.creatives(campaign_id, created_at);
create index promo_handoffs_campaign_idx on promote.handoffs(campaign_id, attempted_at desc);

-- Defense in depth: producer_id is derived from the title, never trusted from
-- a client body. Episode sources must belong to the campaign's title.
create or replace function promote.guard_campaign_ownership()
returns trigger language plpgsql set search_path = promote, core as $$
declare v_producer uuid;
begin
  select producer_id into v_producer from core.titles where id = new.title_id;
  if v_producer is null then raise exception 'title not found' using errcode = 'P0002'; end if;
  new.producer_id := v_producer;
  return new;
end $$;
create trigger promo_campaign_ownership before insert or update of title_id, producer_id
on promote.campaigns for each row execute function promote.guard_campaign_ownership();

create or replace function promote.guard_creative_source()
returns trigger language plpgsql set search_path = promote, core as $$
declare v_title uuid;
begin
  select title_id into v_title from promote.campaigns where id = new.campaign_id;
  if v_title is null or new.title_id is distinct from v_title then
    raise exception 'creative title must match campaign' using errcode = '23514';
  end if;
  if new.source_episode_id is not null and not exists (
    select 1 from core.episodes where id = new.source_episode_id and title_id = v_title
  ) then raise exception 'source episode must belong to campaign title' using errcode = '23514'; end if;
  return new;
end $$;
create trigger promo_creative_source before insert or update on promote.creatives
for each row execute function promote.guard_creative_source();

create or replace function promote.guard_frozen_campaign()
returns trigger language plpgsql set search_path = promote as $$
declare v_status promote.campaign_status;
begin
  if tg_op = 'DELETE' then
    select status into v_status from promote.campaigns where id = old.campaign_id;
  else
    select status into v_status from promote.campaigns where id = new.campaign_id;
  end if;
  if v_status in ('approved', 'submitted', 'launching', 'live') then
    raise exception 'approved promotion is frozen; create a revision' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger promo_creative_frozen before insert or update or delete on promote.creatives
for each row execute function promote.guard_frozen_campaign();

create or replace function promote.approve_campaign(p_campaign_id uuid)
returns uuid language plpgsql security definer set search_path = promote, core as $$
declare
  v_campaign promote.campaigns%rowtype;
  v_profile core.profiles%rowtype;
  v_manifest jsonb;
  v_sha text;
begin
  select * into v_campaign from promote.campaigns where id = p_campaign_id for update;
  if not found then raise exception 'campaign not found' using errcode = 'P0002'; end if;
  select * into v_profile from core.profiles where id = auth.uid();
  if v_profile.kind <> 'producer' or v_profile.producer_role <> 'approver'
     or v_profile.producer_id <> v_campaign.producer_id then
    raise exception 'submitting creatives needs the approver role' using errcode = '42501';
  end if;
  if v_campaign.status <> 'review' then raise exception 'campaign is not ready for approval'; end if;
  if not exists (select 1 from promote.creatives where campaign_id = p_campaign_id and status = 'approved') then
    raise exception 'approve at least one creative first';
  end if;
  select jsonb_build_object(
    'schema', 1,
    'campaign_external_id', v_campaign.external_id,
    'creatives', jsonb_agg(jsonb_build_object(
      'external_id', external_id, 'version', version, 'render_path', render_path,
      'render_sha256', render_sha256, 'hook', hook, 'caption', caption,
      'ad_description', ad_description
    ) order by external_id)
  ) into v_manifest from promote.creatives
  where campaign_id = p_campaign_id and status = 'approved';
  v_sha := encode(digest(v_manifest::text, 'sha256'), 'hex');
  insert into promote.approvals(campaign_id, producer_id, approved_by, manifest, manifest_sha256)
  values (p_campaign_id, v_campaign.producer_id, auth.uid(), v_manifest, v_sha);
  update promote.creatives set status = 'not_selected', updated_at = now()
  where campaign_id = p_campaign_id and status not in ('approved', 'superseded');
  update promote.campaigns set status = 'approved', updated_at = now() where id = p_campaign_id;
  return p_campaign_id;
end $$;

alter table promote.campaigns enable row level security;
alter table promote.creatives enable row level security;
alter table promote.approvals enable row level security;
alter table promote.handoffs enable row level security;

create policy promo_campaign_read on promote.campaigns for select to authenticated
  using (core.can_read_title(title_id));
create policy promo_campaign_insert on promote.campaigns for insert to authenticated
  with check (core.can_edit_title(title_id));
create policy promo_campaign_update on promote.campaigns for update to authenticated
  using (core.can_edit_title(title_id)) with check (core.can_edit_title(title_id));
create policy promo_creative_read on promote.creatives for select to authenticated
  using (core.can_read_title(title_id));
create policy promo_creative_write on promote.creatives for all to authenticated
  using (core.can_edit_title(title_id)) with check (core.can_edit_title(title_id));
create policy promo_approval_read on promote.approvals for select to authenticated
  using (exists (select 1 from promote.campaigns c where c.id = campaign_id and core.can_read_title(c.title_id)));
create policy promo_handoff_read on promote.handoffs for select to authenticated
  using (exists (select 1 from promote.campaigns c where c.id = campaign_id and core.can_read_title(c.title_id)));
create policy promo_handoff_insert on promote.handoffs for insert to authenticated
  with check (exists (select 1 from promote.campaigns c where c.id = campaign_id and core.can_edit_title(c.title_id)));

grant select, insert, update on promote.campaigns, promote.creatives to authenticated;
grant select on promote.approvals to authenticated;
grant select, insert on promote.handoffs to authenticated;
grant all on all tables in schema promote to studio_owner, service_role;
grant usage, select on all sequences in schema promote to authenticated, studio_owner, service_role;
grant execute on function promote.approve_campaign(uuid) to authenticated;
