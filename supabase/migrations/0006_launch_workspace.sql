-- 0006 · US launch workspace (decision 2026-09-08).
--
-- 1. promote.campaigns.experiment: the structured experiment record
--    (budget, hypothesis, audience, first batch, signal, budget approval).
--    A brief with an approval history; nothing here spends money.
-- 2. promote.results: measured (or demo-labelled) outcomes per creative
--    and window. Source is explicit; demo rows never masquerade as Grow.
-- 3. core.company_accounts: the customer-owned accounts Studio may be given
--    access to, with the state the customer reported or Studio verified.

alter table promote.campaigns add column if not exists experiment jsonb;

create type promote.result_source as enum ('demo', 'grow');

create table promote.results (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references promote.campaigns(id) on delete cascade,
  creative_id uuid not null references promote.creatives(id) on delete cascade,
  source promote.result_source not null,
  window_start date not null,
  window_end date not null,
  impressions integer not null check (impressions >= 0),
  video_views integer not null check (video_views >= 0),
  hook_hold_rate numeric not null check (hook_hold_rate >= 0 and hook_hold_rate <= 1),
  clicks integer not null check (clicks >= 0),
  spend_usd numeric not null check (spend_usd >= 0),
  landing_actions integer check (landing_actions is null or landing_actions >= 0),
  observed_at timestamptz not null default now(),
  check (window_end >= window_start)
);
create index results_campaign_idx on promote.results (campaign_id);
alter table promote.results enable row level security;
-- Members of the campaign's company read; only the service role (Grow readback) writes.
create policy results_read on promote.results for select to authenticated
  using (exists (select 1 from promote.campaigns c where c.id = campaign_id and research.is_member_of(c.producer_id)));

create type core.account_provider as enum ('tiktok', 'meta', 'youtube');
create type core.account_kind as enum ('business_center', 'ad_account', 'channel', 'pixel');
create type core.account_state as enum ('unconnected', 'invited', 'connected', 'revoked');
create type core.account_access as enum ('none', 'partner', 'owner_operated');

create table core.company_accounts (
  id uuid primary key default gen_random_uuid(),
  producer_id uuid not null references core.producers(id) on delete cascade,
  provider core.account_provider not null,
  kind core.account_kind not null,
  name text not null check (length(trim(name)) > 0),
  external_ref text,
  state core.account_state not null default 'unconnected',
  access core.account_access not null default 'none',
  note text,
  updated_at timestamptz not null default now()
);
create index company_accounts_producer_idx on core.company_accounts (producer_id);
alter table core.company_accounts enable row level security;
create policy accounts_read on core.company_accounts for select to authenticated using (research.is_member_of(producer_id));
create policy accounts_write on core.company_accounts for all to authenticated
  using (core.can_edit_producer(producer_id)) with check (core.can_edit_producer(producer_id));
