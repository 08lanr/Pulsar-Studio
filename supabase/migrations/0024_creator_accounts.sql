-- 0024 · Creator accounts (decision 2026-10-12, docs/creator-accounts.md).
--
-- Instagram accounts of fictional lifestyle creators that Studio runs: a media
-- library, scheduled posts (image, carousel, Reel), comments with the reply
-- Studio drafted or sent, and daily insights. Chloe Lin (@chloelin.diary) is
-- the first account; the import script creates her row, not this migration.
--
-- Access: Pulsar staff read (RLS core.is_staff()); nobody writes from a
-- browser session. Every write is the server's, after its own staff check, as
-- service_role with a revision-conditional update (CAS), the same rule as
-- 0013 / 0014. No column may ever carry a token or other credential.
--
-- `creator_posts` follows promote.clip_posts (0014): `step` is persisted
-- before every external call, container ids are stored as they come back,
-- `attempted_at` is set immediately before media_publish (only such a row may
-- adopt an Instagram media it may already have made), and a ten-minute lease
-- (`lease_owner` / `leased_until`) keeps two workers off one row.
--
-- `creator_comments.ig_comment_id` is unique: a comment is read once, and a
-- reply id once recorded is never sent again. `creator_stats` holds one row per
-- (account, scope, day), scope 'account' or the Instagram media id; a metric
-- Meta did not answer is null, never 0.
--
-- Apply after 0023_clip_ad_format.sql. Idempotent. The job kinds are added
-- outside the transaction, as 0016 and 0018 do.

begin;

create table if not exists promote.creator_accounts (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique default core.ext_id('cr'),
  handle text not null unique check (handle ~ '^[a-z0-9._]{1,30}$'),
  display_name text not null,
  instagram_id text not null unique check (instagram_id ~ '^[0-9]{5,25}$'),
  page_id text check (page_id is null or page_id ~ '^[0-9]{5,25}$'),
  persona jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{"timezone":"America/Los_Angeles","auto_reply":true,"reply_delay_min":4,"reply_delay_max":45,"max_replies_per_hour":12,"reply_window_days":14}'::jsonb,
  status text not null default 'active' check (status in ('active','paused')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists promote.creator_media (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique default core.ext_id('cm'),
  account_id uuid not null references promote.creator_accounts(id),
  kind text not null check (kind in ('image','video')),
  path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  stored_sha256 text not null check (stored_sha256 ~ '^[0-9a-f]{64}$'),
  width integer,
  height integer,
  duration_s numeric,
  mime text not null check (mime in ('image/jpeg','video/mp4','video/quicktime')),
  bytes bigint not null default 0,
  description text not null default '',
  tags text[] not null default '{}',
  filename text not null default '',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revision integer not null default 1 check (revision > 0),
  unique (account_id, sha256)
);
create index if not exists creator_media_account on promote.creator_media(account_id, created_at desc);

create table if not exists promote.creator_posts (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique default core.ext_id('cp'),
  account_id uuid not null references promote.creator_accounts(id),
  kind text not null check (kind in ('image','carousel','reel')),
  media_ids uuid[] not null,
  caption text not null default '' check (char_length(caption) <= 2200),
  scheduled_at timestamptz,
  status text not null check (status in ('draft','scheduled','publishing','published','failed','cancelled')),
  step text not null default 'container' check (step in ('container','processing','publishing','published')),
  containers jsonb not null default '{}'::jsonb,
  ig_media_id text,
  permalink text,
  attempted_at timestamptz,
  lease_owner text,
  leased_until timestamptz,
  error text,
  source text not null default 'human' check (source in ('human','agent','muse')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  check (cardinality(media_ids) between 1 and 10),
  check (kind <> 'carousel' or cardinality(media_ids) >= 2),
  check (kind = 'carousel' or cardinality(media_ids) = 1)
);
create index if not exists creator_posts_account on promote.creator_posts(account_id, created_at desc);
create index if not exists creator_posts_due on promote.creator_posts(status, scheduled_at) where status in ('scheduled','publishing');
-- One Instagram media is recorded by one post row at most.
create unique index if not exists creator_posts_ig_media on promote.creator_posts(ig_media_id) where ig_media_id is not null;

create table if not exists promote.creator_comments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references promote.creator_accounts(id),
  post_id uuid references promote.creator_posts(id),
  ig_media_id text not null,
  ig_comment_id text not null unique,
  parent_ig_id text,
  username text not null default '',
  text text not null default '',
  commented_at timestamptz not null,
  decision text not null default 'pending' check (decision in ('pending','reply','skip','flag')),
  reason text,
  reply_text text check (reply_text is null or char_length(reply_text) <= 300),
  reply_due_at timestamptz,
  reply_ig_id text unique,
  attempted_at timestamptz,
  replied_at timestamptz,
  status text not null default 'new' check (status in ('new','drafted','sent','skipped','failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision integer not null default 1 check (revision > 0)
);
create index if not exists creator_comments_account on promote.creator_comments(account_id, commented_at desc);
create index if not exists creator_comments_open on promote.creator_comments(status, reply_due_at) where status in ('new','drafted');

create table if not exists promote.creator_stats (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references promote.creator_accounts(id),
  scope text not null,
  ig_media_id text,
  post_id uuid references promote.creator_posts(id),
  day date not null,
  followers_count integer,
  follows_count integer,
  media_count integer,
  reach integer,
  profile_views integer,
  follows_gained integer,
  likes integer,
  comments integer,
  saved integer,
  shares integer,
  views integer,
  total_interactions integer,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (account_id, scope, day),
  check ((scope = 'account') = (ig_media_id is null))
);
create index if not exists creator_stats_account on promote.creator_stats(account_id, day desc);

do $$
declare t text;
begin
  foreach t in array array['creator_accounts','creator_media','creator_posts','creator_comments','creator_stats'] loop
    execute format('alter table promote.%I enable row level security', t);
    execute format('drop policy if exists %I on promote.%I', t || '_read', t);
    execute format('create policy %I on promote.%I for select to authenticated using (core.is_staff())', t || '_read', t);
    execute format('revoke all on promote.%I from anon, authenticated', t);
    execute format('grant select on promote.%I to authenticated', t);
    execute format('grant all on promote.%I to service_role', t);
  end loop;
end $$;

comment on table promote.creator_accounts is 'Instagram creator accounts Studio runs (staff only). No access token or credential material may appear in any column.';
comment on table promote.creator_posts is 'Scheduled and published creator posts; the publishing engine checkpoints step and container ids before every Meta call.';
comment on table promote.creator_comments is 'Comments read from a creator account''s media, the reply decision and the reply Studio sent; one row per Instagram comment.';
comment on table promote.creator_stats is 'Daily insights per creator account and per media; unknown is null, never 0.';

commit;

alter type studio.job_kind add value if not exists 'creator_captions';
alter type studio.job_kind add value if not exists 'creator_reply';
