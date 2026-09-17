-- Organic clip posting on Meta (docs/meta-organic-plan.md). One row per clip ×
-- platform × connection attempt: the post record is the only source of truth
-- for "posted"; nothing infers it from Meta on the fly. The publishing engine
-- persists `step` before every external call, exactly like promote.launch_runs,
-- and takes a ten-minute lease on the row so two processes cannot both upload.
--
-- `attempted_at` is set immediately before the current step's create call and
-- cleared when the step advances: only a row that carries it may adopt an
-- existing Meta object, so a brand-new row can never claim somebody else's
-- post. `superseded_by` is how "Post again" stays legal — the older published
-- row points at its replacement and stops counting for the one-published-post
-- invariant, which is why the engine can always record a post it created.
--
-- Version 0014 is shared with 0014_instant_page_templates.sql, the same way
-- 0006 is shared by two migrations; the two touch different tables and either
-- order applies. Apply after 0013_launch_runs.sql.
begin;
create table if not exists promote.clip_posts (
  id uuid primary key,
  producer_id uuid not null references core.producers(id),
  clip_id uuid not null references studio.clips(id),
  -- promote.launch_connections.id; kept as text so a discovered (unsaved)
  -- assignment identifier stays usable, as on the launch draft.
  connection_id text not null,
  platform text not null check (platform in ('facebook','instagram')),
  status text not null check (status in ('publishing','published','failed')),
  -- facebook: uploading | uploaded | published
  -- instagram: container | processing | publishing | published
  step text not null check (step in ('uploading','uploaded','container','processing','publishing','published')),
  external_video_id text,
  external_post_id text,
  permalink text,
  caption text not null,
  sha256 text not null,
  error text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  revision integer not null default 1 check (revision > 0)
);
-- Added after the first cut of this table; idempotent for an already applied 0014.
alter table promote.clip_posts add column if not exists attempted_at timestamptz;
alter table promote.clip_posts add column if not exists superseded_by uuid references promote.clip_posts(id);
alter table promote.clip_posts add column if not exists lease_owner text;
alter table promote.clip_posts add column if not exists leased_until timestamptz;
create index if not exists clip_posts_company on promote.clip_posts(producer_id, created_at desc);
create index if not exists clip_posts_clip on promote.clip_posts(clip_id, platform);
-- One *live* published post per clip per platform per connection. A failed
-- attempt may be retried; "Post again" is a deliberate extra row that, once it
-- has its own post id, supersedes the row it replaces.
drop index if exists promote.clip_posts_published_once;
create unique index if not exists clip_posts_published_once
  on promote.clip_posts(clip_id, platform, connection_id) where status = 'published' and superseded_by is null;
alter table promote.clip_posts enable row level security;
drop policy if exists clip_posts_read on promote.clip_posts;
create policy clip_posts_read on promote.clip_posts for select to authenticated
  using (core.is_staff() or research.is_member_of(producer_id));
revoke all on promote.clip_posts from anon, authenticated;
grant select on promote.clip_posts to authenticated;
grant all on promote.clip_posts to service_role;
-- No browser/session may publish or rewrite a post record directly. The
-- server-only publishing service checks the actor's company and role, then
-- writes revision-conditionally as service_role.
comment on table promote.clip_posts is 'Organic Facebook/Instagram posts made from a rendered clip; no access token or credential material may appear in any column.';
commit;
