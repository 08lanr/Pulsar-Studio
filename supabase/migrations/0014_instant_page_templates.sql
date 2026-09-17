-- Local reusable Sales Instant Page designs. TikTok publication is separate.
begin;
create table if not exists promote.instant_page_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 60),
  button_text text not null check (length(trim(button_text)) between 1 and 40),
  background text not null check (background in ('white', 'black')),
  hand_cursor boolean not null default false,
  created_by uuid not null references core.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table promote.instant_page_templates enable row level security;
drop policy if exists instant_page_templates_read on promote.instant_page_templates;
create policy instant_page_templates_read on promote.instant_page_templates for select to authenticated using (true);
drop policy if exists instant_page_templates_admin_write on promote.instant_page_templates;
create policy instant_page_templates_admin_write on promote.instant_page_templates for all to authenticated
  using (core.is_staff_admin()) with check (core.is_staff_admin());
grant select on promote.instant_page_templates to authenticated;
grant insert, update, delete on promote.instant_page_templates to authenticated;
commit;
