-- Provider-aware launch jobs. The approved input and all campaign checkpoints
-- are one CAS document so allocation/submission cannot be partially committed.
-- Existing promote.launches and its history are preserved.
begin;
create table if not exists promote.launch_runs (
  id uuid primary key,
  producer_id uuid not null references core.producers(id),
  status text not null check (status in ('draft','pending','running','done','failed')),
  revision integer not null check (revision > 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  check ((payload->>'id')::uuid = id),
  check ((payload->>'producer_id')::uuid = producer_id),
  check (payload->>'status' = status),
  check ((payload->>'revision')::integer = revision),
  check (payload->'draft'->>'provider' in ('tiktok','meta'))
);
create index if not exists launch_runs_company on promote.launch_runs(producer_id, created_at desc);
create index if not exists launch_runs_pending on promote.launch_runs(status) where status in ('pending','running');
alter table promote.launch_runs enable row level security;
drop policy if exists launch_runs_read on promote.launch_runs;
create policy launch_runs_read on promote.launch_runs for select to authenticated
  using (core.is_staff() or research.is_member_of(producer_id));
revoke all on promote.launch_runs from anon, authenticated;
grant select on promote.launch_runs to authenticated;
grant all on promote.launch_runs to service_role;
-- No browser/session may mutate approvals or provider IDs directly. The
-- server-only launch job service validates authenticated actor, company and
-- immutable inputs, then performs a revision-conditional write as service_role.

create table if not exists promote.launch_connections (
  id uuid primary key,
  producer_id uuid not null references core.producers(id),
  provider text not null check (provider in ('tiktok','meta')),
  advertiser_id text not null,
  payload jsonb not null,
  unique (producer_id, provider, advertiser_id),
  check ((payload->>'id')::uuid = id),
  check ((payload->>'producer_id')::uuid = producer_id),
  check (payload->>'provider' = provider),
  check (payload->>'advertiser_id' = advertiser_id)
);
alter table promote.launch_connections enable row level security;
drop policy if exists launch_connections_read on promote.launch_connections;
create policy launch_connections_read on promote.launch_connections for select to authenticated
  using (core.is_staff() or research.is_member_of(producer_id));
revoke all on promote.launch_connections from anon, authenticated;
grant select on promote.launch_connections to authenticated;
grant all on promote.launch_connections to service_role;
comment on table promote.launch_connections is 'Verified company assignments; credential material must never appear in payload.';
commit;
