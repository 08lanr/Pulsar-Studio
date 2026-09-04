-- seed.sql — the one row the app assumes exists: the pilot producer, with
-- the id lib/auth.ts uses as FIXTURE_PRODUCER_ID so a fixture-mode session
-- and a Supabase-mode session point at the same partner. Nothing here needs
-- auth.users; profiles are created by hand after inviting users
-- (supabase/README.md). Safe to re-run.

insert into core.producers (id, slug, name_zh, name_en, contact_email, contact_wechat, deliverables)
values (
  '00000000-0000-4000-8000-000000000001',
  'xinghai',
  '星海影视',
  'Xinghai Pictures',
  null,
  null,
  '{"script_or_srt": true, "clean_master": false, "dialogue_stem": false}'::jsonb
)
on conflict (id) do nothing;
