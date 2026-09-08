-- Title analytics (2026-09-08): which platform listing a title's analytics
-- come from. One listing per title, one title per listing, company-scoped.
-- Reads follow the company; writes follow core.can_edit_title() (0002), the
-- same rule as every producer self-serve write, and staff preview cannot
-- act. The listing id is the provider's external listing id (lst_ prefix);
-- no provider data is stored here and nothing in this table is a credential.
create table if not exists core.analytics_links (
  id uuid primary key default gen_random_uuid(),
  producer_id uuid not null references core.producers(id) on delete cascade,
  title_id uuid not null references core.titles(id) on delete cascade,
  listing_id text not null check (listing_id ~ '^lst_[a-z0-9_]{3,80}$'),
  linked_by uuid not null references core.profiles(id),
  linked_at timestamptz not null default now(),
  unique (title_id),
  unique (listing_id)
);

-- The link belongs to the title's company: derive producer_id from the title.
create or replace function core.analytics_link_guard()
returns trigger language plpgsql as $$
begin
  select producer_id into new.producer_id from core.titles where id = new.title_id;
  if new.producer_id is null then raise exception 'title % not found', new.title_id; end if;
  return new;
end $$;
drop trigger if exists analytics_link_guard on core.analytics_links;
create trigger analytics_link_guard before insert or update on core.analytics_links
  for each row execute function core.analytics_link_guard();

alter table core.analytics_links enable row level security;
drop policy if exists analytics_links_read on core.analytics_links;
create policy analytics_links_read on core.analytics_links for select to authenticated
  using (core.is_staff() or producer_id = (select producer_id from core.profiles where id = auth.uid()));
drop policy if exists analytics_links_write on core.analytics_links;
create policy analytics_links_write on core.analytics_links for all to authenticated
  using (core.can_edit_title(title_id) and not core.is_staff())
  with check (core.can_edit_title(title_id) and not core.is_staff() and linked_by = auth.uid());
