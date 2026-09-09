-- 0009 · Table grants for everything created after 0001 (found on the first
-- real project, 2026-09-09). 0001 granted the base tables to authenticated
-- and service_role; the migrations since added tables with RLS policies but
-- no table grant, so Postgres refused every access before a policy was
-- even evaluated ("permission denied for table ..."). RLS stays the row
-- rule; these are the table-level grants the policies assume.
--
-- Column-level revokes from 0001 are untouched: nothing here re-grants a
-- base table.

begin;

-- The service role (ingest tooling, the launch engine, the scheduler, storage helpers).
grant select, insert, update, delete on
  core.company_accounts, core.account_requests, core.analytics_links,
  promote.results, promote.launches,
  research.crawls, research.title_observations, research.watchlist, research.report_batches, research.report_rows
to service_role, studio_owner;

-- Signed-in users, under RLS.
grant select, insert, update, delete on core.company_accounts to authenticated;
grant select, insert, update on core.account_requests to authenticated;
grant select, insert, update, delete on core.analytics_links to authenticated;
grant select on promote.results, promote.launches to authenticated;
grant select on research.crawls, research.title_observations to authenticated;
grant select, insert, update, delete on research.watchlist to authenticated;
grant select, insert, update on research.report_batches to authenticated;
grant select, insert on research.report_rows to authenticated;

grant usage, select on all sequences in schema research to authenticated, studio_owner, service_role;

-- Tables the migrating role creates from now on get the same baseline, so a
-- future migration cannot repeat this omission (RLS still gates rows).
alter default privileges in schema core, studio, promote, research grant select, insert, update, delete on tables to service_role, studio_owner, authenticated;
alter default privileges in schema core, studio, promote, research grant usage, select on sequences to service_role, studio_owner, authenticated;

commit;
