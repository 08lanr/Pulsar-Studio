-- 0008 · TikTok launch inside Studio (decision 2026-09-09, "TikTok launch").
--
-- Studio launches ads itself: the producer approves the creatives and the
-- budget and presses launch; a launch job creates the TikTok objects; a
-- scheduler polls TikTok's review and reads metrics back. Nothing here
-- holds a TikTok token (tokens are operator-level, in .tokens.json on the
-- server, the way Pulsar Grow keeps them).
--
-- 1. promote.campaigns gains paused/ended and the TikTok bookkeeping columns.
-- 2. promote.launches: one launch job per approval manifest (idempotent).
-- 3. promote.results gains the 'tiktok' source.
-- 4. core.company_accounts gains the publishing identity and staff assignment;
--    staff admins may write a producer's TikTok ad-account row.
-- 5. core.account_requests: "make a new account through Pulsar".

alter type promote.campaign_status add value if not exists 'paused';
alter type promote.campaign_status add value if not exists 'ended';
alter type promote.result_source add value if not exists 'tiktok';

alter table promote.campaigns add column if not exists advertiser_id text;
alter table promote.campaigns add column if not exists tiktok_adgroup_id text;
alter table promote.campaigns add column if not exists status_note text;
alter table promote.campaigns add column if not exists launched_at timestamptz;

create type promote.launch_status as enum ('pending', 'running', 'done', 'failed');
create type promote.launch_mode as enum ('sandbox', 'production', 'fake');

create table promote.launches (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references promote.campaigns(id) on delete cascade,
  idempotency_key text not null unique,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status promote.launch_status not null default 'pending',
  mode promote.launch_mode not null,
  advertiser_id text not null,
  identity_id text,
  identity_type text check (identity_type is null or identity_type in ('BC_AUTH_TT', 'TT_USER')),
  budget_usd numeric not null check (budget_usd > 0),
  destination_url text not null,
  uploaded_videos jsonb not null default '{}'::jsonb,
  covers jsonb not null default '{}'::jsonb,
  tiktok_campaign_id text,
  tiktok_adgroup_id text,
  ad_ids jsonb not null default '{}'::jsonb,
  error text,
  attempts integer not null default 0,
  created_by uuid not null references core.profiles(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz
);
create index launches_campaign_idx on promote.launches (campaign_id, created_at desc);
create index launches_open_idx on promote.launches (status) where status in ('pending', 'running');
alter table promote.launches enable row level security;
-- Members of the campaign's company read their launch record; only the
-- service role (the launch engine and the scheduler) writes.
create policy launches_read on promote.launches for select to authenticated
  using (exists (select 1 from promote.campaigns c where c.id = campaign_id and (core.is_staff() or research.is_member_of(c.producer_id))));

-- Results (0006) had no uniqueness: the TikTok sync upserts one row per
-- creative, window and source, so a re-read updates a day rather than
-- duplicating it.
create unique index if not exists results_creative_window_source_key
  on promote.results (creative_id, window_start, window_end, source);

alter table core.company_accounts add column if not exists identity_id text;
alter table core.company_accounts add column if not exists identity_type text
  check (identity_type is null or identity_type in ('BC_AUTH_TT', 'TT_USER'));
alter table core.company_accounts add column if not exists assigned_by uuid references core.profiles(id);
alter table core.company_accounts add column if not exists assigned_at timestamptz;
-- Staff admins assign launch accounts from Pulsar's Business Center.
create policy accounts_staff_write on core.company_accounts for all to authenticated
  using (core.is_staff()) with check (core.is_staff());

create type core.account_request_status as enum ('requested', 'provisioning', 'assigned', 'declined');

create table core.account_requests (
  id uuid primary key default gen_random_uuid(),
  producer_id uuid not null references core.producers(id) on delete cascade,
  status core.account_request_status not null default 'requested',
  contact_name text not null check (length(trim(contact_name)) > 0),
  contact_email text not null check (length(trim(contact_email)) > 0),
  -- Opt-in record only: {method, brand, last4, holder, opted_in_at}. Never a card number.
  payment jsonb,
  note text,
  staff_note text,
  account_id uuid references core.company_accounts(id),
  requested_by uuid not null references core.profiles(id),
  created_at timestamptz not null default now(),
  resolved_by uuid references core.profiles(id),
  resolved_at timestamptz
);
create index account_requests_producer_idx on core.account_requests (producer_id, created_at desc);
create index account_requests_open_idx on core.account_requests (status) where status in ('requested', 'provisioning');
alter table core.account_requests enable row level security;
create policy account_requests_read on core.account_requests for select to authenticated
  using (core.is_staff() or research.is_member_of(producer_id));
create policy account_requests_producer_insert on core.account_requests for insert to authenticated
  with check (core.can_edit_producer(producer_id) and requested_by = auth.uid());
create policy account_requests_staff_update on core.account_requests for update to authenticated
  using (core.is_staff()) with check (core.is_staff());
