-- 0012 · Launch settings, controls and the monitor (decision 2026-09-16).
--
-- Studio's TikTok launch gains overlord's launch settings and post-launch
-- controls: a campaign carries the shape of its launch (targeting, budget
-- shape, schedule, bidding, pacing, CTA, live or paused, auto-duplicate
-- copies); the launch row snapshots that shape and records what happened
-- after — copies, retired ad groups, the current cost cap and schedule end.
-- Staff keep Pulsar-wide presets; a producer names the ad account inside
-- their Business Center that launches should use.
--
-- Idempotent; apply after 0011.

begin;

-- 1. The shape of a launch, on the campaign (null = the defaults).
alter table promote.campaigns add column if not exists launch_settings jsonb;

-- 2. What the launch used and what changed since.
alter table promote.launches add column if not exists settings jsonb not null default '{}'::jsonb;
alter table promote.launches add column if not exists paused boolean not null default false;
alter table promote.launches add column if not exists duplicates jsonb not null default '{}'::jsonb;
alter table promote.launches add column if not exists retired_adgroups jsonb not null default '[]'::jsonb;
alter table promote.launches add column if not exists duplicated_at timestamptz;
alter table promote.launches add column if not exists activated_at timestamptz;
alter table promote.launches add column if not exists bid_usd numeric check (bid_usd is null or bid_usd > 0);
alter table promote.launches add column if not exists schedule_end text;

-- 3. Pulsar-wide launch presets (staff admins write; every member reads).
create table if not exists promote.launch_presets (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 60),
  settings jsonb not null,
  note text,
  created_by uuid not null references core.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table promote.launch_presets enable row level security;
drop policy if exists launch_presets_read on promote.launch_presets;
create policy launch_presets_read on promote.launch_presets for select to authenticated using (true);
drop policy if exists launch_presets_staff_write on promote.launch_presets;
create policy launch_presets_staff_write on promote.launch_presets for all to authenticated
  using (core.is_staff_admin()) with check (core.is_staff_admin());
grant select on promote.launch_presets to authenticated;
grant insert, update, delete on promote.launch_presets to authenticated;

-- 4. The producer's preferred ad account inside their assigned Business Center.
alter table core.company_accounts add column if not exists preferred_advertiser_id text
  check (preferred_advertiser_id is null or preferred_advertiser_id ~ '^\d{5,}$');

-- 5. What a producer may change on a company account, in SQL and not only in
--    the data layer (review of 2026-09-16: 0006's accounts_write policy is
--    row-scoped, so a producer editor could rewrite a staff assignment through
--    the database API). A row is a launch assignment once assigned_by is set:
--    from then on a non-staff caller may change only preferred_advertiser_id
--    (and updated_at). A non-staff caller may never set or move assigned_by,
--    assigned_at, identity_id or identity_type on any row, nor insert one
--    already assigned. Staff admins keep the full row; staff editors cannot
--    alter assignments. The service role (the launch engine, no auth uid)
--    is let through like any trusted server actor.
drop policy if exists accounts_preferred_update on core.company_accounts;
create or replace function core.guard_company_account_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or core.is_staff_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.assigned_by is not null or new.assigned_at is not null or new.identity_id is not null or new.identity_type is not null then
      raise exception 'only Pulsar staff assign launch accounts' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.assigned_by is distinct from old.assigned_by or new.assigned_at is distinct from old.assigned_at
     or new.identity_id is distinct from old.identity_id or new.identity_type is distinct from old.identity_type then
    raise exception 'only Pulsar staff change a launch assignment' using errcode = '42501';
  end if;
  if old.assigned_by is not null and (
       new.provider is distinct from old.provider or new.kind is distinct from old.kind or new.name is distinct from old.name
    or new.external_ref is distinct from old.external_ref or new.state is distinct from old.state or new.access is distinct from old.access
    or new.note is distinct from old.note or new.producer_id is distinct from old.producer_id) then
    raise exception 'this account was assigned by Pulsar; only the preferred ad account may be changed' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists company_accounts_guard_write on core.company_accounts;
create trigger company_accounts_guard_write
  before insert or update on core.company_accounts
  for each row execute function core.guard_company_account_write();

commit;
