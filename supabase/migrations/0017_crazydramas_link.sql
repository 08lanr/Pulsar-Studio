-- 0017 · The crazydramas connection, read-only (decision 2026-09-23, "the
-- crazydramas connection"; plan A2). Studio reads the public crazydramas
-- API — the catalog and one series per slug — and keeps what it read:
--
-- 1. core.platform_links: which drama on the platform a title IS. Written
--    on the first 200 read of core.titles.crazydramas_slug (0015) with the
--    drama id the platform returned; from then on the title is matched by
--    that id, because a slug can be edited in the crazydramas CMS. One link
--    per title × platform, one title per drama id. Its own table, not a row
--    of core.analytics_links (0007): that table's listing_id must match
--    ^lst_… and a crazydramas uuid never will.
-- 2. core.platform_snapshots: append-only, one row per public read of one
--    slug (the hourly sweep, Check now, the after-import check). The
--    whitelisted series fields and the episode list go in jsonb; a failed
--    read keeps its error and no body. The sweep keeps the last twenty per
--    slug. These are public facts, so producers of a title read its rows
--    (can_read_title); a row whose slug matches no title (title_id null) is
--    staff's to see. Future stats (revenue, funnels) do NOT go here — they
--    go in a staff-only table later.
--
-- Neither table takes a session write: every write is the data layer's, as
-- the service role, after its staff-or-system check (lib/data/supabase.ts
-- upsertPlatformLink, recordPlatformSnapshot, prunePlatformSnapshots),
-- mirrored by lib/data/fixture.ts. Nothing in either table is a credential,
-- a playback id or a thumbnail URL (lib/crazydramas/types.ts is the
-- whitelist). No job kind: a public GET costs no model money and the
-- snapshot row is the record. Version 0017 follows 0016_film_runs.sql.
-- Idempotent throughout.

begin;

-- ---- core.platform_links: the title is this drama ----

create table if not exists core.platform_links (
  id          uuid primary key default gen_random_uuid(),
  title_id    uuid not null references core.titles (id) on delete cascade,
  platform    text not null check (platform in ('crazydramas')),
  -- The slug the link was made under (the title's crazydramas_slug at the time); lowercase words joined by hyphens.
  slug        text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- The platform's own id of the drama (crazydramas dramas.id).
  cd_drama_id uuid not null,
  linked_at   timestamptz not null default now(),
  -- Null for the system actor (the sweep); a staff profile otherwise.
  linked_by   uuid references core.profiles (id) on delete set null,
  unique (title_id, platform),
  unique (platform, cd_drama_id)
);

alter table core.platform_links enable row level security;
drop policy if exists platform_links_read on core.platform_links;
create policy platform_links_read on core.platform_links for select to authenticated using (core.can_read_title(title_id));

revoke all on core.platform_links from anon, authenticated;
grant select on core.platform_links to authenticated;
grant select, insert, update, delete on core.platform_links to service_role, studio_owner;

comment on table core.platform_links is 'Which drama on a consumer platform a title is: made on the first 200 read of the title''s slug, matched by the platform''s drama id from then on. One per title × platform; one title per drama.';

-- ---- core.platform_snapshots: one public read of one slug ----

create table if not exists core.platform_snapshots (
  id          uuid primary key default gen_random_uuid(),
  platform    text not null check (platform in ('crazydramas')),
  slug        text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  cd_drama_id uuid,
  -- The title the slug belongs to at read time; null for a series that matches no title (staff read those).
  title_id    uuid references core.titles (id) on delete set null,
  -- 200 or 404 for a read that answered; null when the request itself failed (error says how).
  http_status int check (http_status is null or (http_status between 100 and 599)),
  -- The whitelisted series fields (id, slug, title, status, language, free_episode_count, series_price_cents,
  -- iap_product_id, poster_url, poster_blurhash, episode_count, cta_mode); never a playback id or a thumbnail URL.
  drama       jsonb check (drama is null or jsonb_typeof(drama) = 'object'),
  -- [{n, duration_s, status, is_published}] as the platform listed them.
  episodes    jsonb check (episodes is null or jsonb_typeof(episodes) = 'array'),
  read_at     timestamptz not null default now(),
  error       text,
  -- A 200 carries a body; anything else carries none; a read with no status carries its error.
  check ((http_status = 200) = (drama is not null and episodes is not null)),
  check (http_status is not null or error is not null)
);
create index if not exists platform_snapshots_slug_idx on core.platform_snapshots (platform, slug, read_at desc);
create index if not exists platform_snapshots_title_idx on core.platform_snapshots (title_id, read_at desc);

alter table core.platform_snapshots enable row level security;
-- Staff every row (a series with no title included); a producer the rows of titles they can read.
drop policy if exists platform_snapshots_read on core.platform_snapshots;
create policy platform_snapshots_read on core.platform_snapshots for select to authenticated
  using (core.is_staff() or (title_id is not null and core.can_read_title(title_id)));

revoke all on core.platform_snapshots from anon, authenticated;
grant select on core.platform_snapshots to authenticated;
grant select, insert, update, delete on core.platform_snapshots to service_role, studio_owner;

comment on table core.platform_snapshots is 'One public read of one slug on a consumer platform (the sweep, Check now, the after-import check); append-only, the last twenty per slug kept. Public facts: producers read their own titles'' rows, staff every row.';

commit;
