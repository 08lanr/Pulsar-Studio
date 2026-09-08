-- 0005 · Company-scoped watchlists and report imports (docs/market-desk-plan.md, phase 4).
--
-- Both tables live in the research schema and are scoped to a producer.
-- A producer editor (approver/reviewer, core.can_edit_producer from 0004)
-- writes; any member of the company reads; nobody else sees a row.
-- Report batches are reverted, never deleted: reverted_at hides the rows.

create table research.watchlist (
  producer_id uuid not null references core.producers(id) on delete cascade,
  listing_key text not null check (listing_key ~ '^(reelshort|dramabox)-[A-Za-z0-9]+$'),
  created_by uuid not null references core.profiles(id),
  created_at timestamptz not null default now(),
  primary key (producer_id, listing_key)
);

create type research.report_metric as enum
  ('starts', 'views', 'completions', 'payers', 'revenue', 'spend', 'installs', 'impressions', 'clicks');

create table research.report_batches (
  id uuid primary key default gen_random_uuid(),
  producer_id uuid not null references core.producers(id) on delete cascade,
  filename text not null,
  imported_at timestamptz not null default now(),
  imported_by uuid not null references core.profiles(id),
  row_count integer not null default 0,
  skipped_count integer not null default 0,
  column_map jsonb not null default '{}',
  reverted_at timestamptz
);

create table research.report_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references research.report_batches(id) on delete cascade,
  producer_id uuid not null references core.producers(id) on delete cascade,
  title_id uuid references core.titles(id) on delete set null,
  title_name text not null,
  platform text not null,
  period_start date not null,
  period_end date not null,
  metric research.report_metric not null,
  value numeric not null check (value >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  source_row integer not null default 0,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create index report_rows_producer_title_idx on research.report_rows (producer_id, title_id);
create index report_rows_batch_idx on research.report_rows (batch_id);

-- A row may only link to a title of the same company.
create or replace function research.guard_report_row_title()
returns trigger language plpgsql as $$
begin
  if new.title_id is not null and not exists (select 1 from core.titles t where t.id = new.title_id and t.producer_id = new.producer_id) then
    new.title_id := null;
  end if;
  return new;
end;
$$;
create trigger guard_report_row_title before insert or update on research.report_rows
  for each row execute function research.guard_report_row_title();

alter table research.watchlist enable row level security;
alter table research.report_batches enable row level security;
alter table research.report_rows enable row level security;

create or replace function research.is_member_of(p_producer_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select core.is_staff() or exists (
    select 1 from core.profiles p where p.id = auth.uid() and p.kind = 'producer' and p.producer_id = p_producer_id
  );
$$;

create policy watchlist_read on research.watchlist for select to authenticated using (research.is_member_of(producer_id));
create policy watchlist_write on research.watchlist for all to authenticated
  using (core.can_edit_producer(producer_id)) with check (core.can_edit_producer(producer_id) and created_by = auth.uid());

create policy batches_read on research.report_batches for select to authenticated using (research.is_member_of(producer_id));
create policy batches_insert on research.report_batches for insert to authenticated
  with check (core.can_edit_producer(producer_id) and imported_by = auth.uid());
create policy batches_revert on research.report_batches for update to authenticated
  using (core.can_edit_producer(producer_id)) with check (core.can_edit_producer(producer_id));

create policy rows_read on research.report_rows for select to authenticated using (research.is_member_of(producer_id));
create policy rows_insert on research.report_rows for insert to authenticated with check (core.can_edit_producer(producer_id));
