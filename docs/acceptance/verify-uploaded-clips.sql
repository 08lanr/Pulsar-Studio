-- Read-only verification for 0020_uploaded_clips.sql (decision 2026-09-24,
-- "a finished ad can be uploaded as a clip"). Run it in the SQL Editor AFTER
-- applying the migration. Every row must say true. Nothing is written.
--
-- What it proves: an uploaded ad can exist as a clip (the source check allows
-- it, the timecode trigger exempts it), clip writes are still service-role /
-- staff only, and the columns the upload path fills are present.
with checks(name, ok) as (
  select 'source_allows_upload', exists(
    select 1 from pg_constraint con
     where con.conrelid = 'studio.clips'::regclass and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%upload%')
  union all select 'source_still_allows_script_and_footage', exists(
    select 1 from pg_constraint con
     where con.conrelid = 'studio.clips'::regclass and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%script%'
       and pg_get_constraintdef(con.oid) like '%footage%')
  union all select 'exactly_one_source_check', (
    select count(*) = 1 from pg_constraint con
     where con.conrelid = 'studio.clips'::regclass and con.contype = 'c'
       and con.conkey = array[(select attnum from pg_attribute
                                where attrelid = 'studio.clips'::regclass
                                  and attname = 'source' and not attisdropped)]::smallint[])
  union all select 'guard_timecodes_exempts_upload', (
    select pg_get_functiondef(p.oid) like '%upload%'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'studio' and p.proname = 'guard_timecodes')
  union all select 'guard_timecodes_still_on_clips', exists(
    select 1 from pg_trigger where tgrelid = 'studio.clips'::regclass
       and not tgisinternal and tgname = 't3_guard_timecodes')
  union all select 'render_columns_present', (
    select count(*) = 4 from information_schema.columns
     where table_schema = 'studio' and table_name = 'clips'
       and column_name in ('render_path','render_sha256','render_status','source'))
  -- The upload route writes through the service role on purpose; a producer
  -- must still only READ clips. If this goes false, 0020 granted too much.
  union all select 'producers_still_cannot_write_clips',
    has_table_privilege('authenticated','studio.clips','SELECT')
    and not has_table_privilege('authenticated','studio.clips','INSERT,UPDATE,DELETE')
)
select name, ok from checks order by ok, name;
