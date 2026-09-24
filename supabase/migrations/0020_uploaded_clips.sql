-- 0020 · A finished ad file can be uploaded as a clip (decision 2026-09-24).
--
-- Until now the only way a launchable clip existed was the background cutter
-- (lib/clips/*), which needs an episode VIDEO and re-cuts a 20-30 s window.
-- A partner who already has a graded, finished ad had no way in: re-cutting
-- would re-encode and crop work that is already done. This adds the third
-- clip source, 'upload' — bytes the person supplied, stored and hashed as
-- they arrived, never re-encoded.
--
-- Two constraints have to widen, and nothing else changes: writes still go
-- through the service role / staff (there is still no producer insert policy
-- on studio.clips), producers still only read their own titles' clips, and
-- the launch path still resolves the file and re-verifies its SHA-256 server
-- side. An uploaded clip is created 'shortlisted' by the data layer so a
-- later re-cut (which replaces 'suggested' rows) can never delete it.
--
-- Idempotent; apply after 0019.

begin;

-- 1. source gains 'upload'. The 0010 constraint was created inline by
--    `add column ... check (...)`, so its name is whatever Postgres chose.
--    Drop every check constraint that covers exactly the source column
--    rather than guessing the name, then add the widened one by name.
do $$
declare
  v_attnum smallint;
  v_name   text;
begin
  select attnum into v_attnum from pg_attribute
   where attrelid = 'studio.clips'::regclass and attname = 'source' and not attisdropped;
  if v_attnum is null then
    raise exception 'studio.clips.source is missing; apply 0010_clip_renders.sql first';
  end if;
  for v_name in
    select con.conname from pg_constraint con
     where con.conrelid = 'studio.clips'::regclass
       and con.contype = 'c'
       and con.conkey = array[v_attnum]::smallint[]
  loop
    execute format('alter table studio.clips drop constraint %I', v_name);
  end loop;
end $$;

alter table studio.clips
  add constraint clips_source_check check (source in ('script', 'footage', 'upload'));

-- 2. guard_timecodes: an uploaded clip carries its own finished file, so the
--    episode it is filed under needs neither timecodes nor a video. Every
--    other rule is exactly as 0010 left it.
create or replace function studio.guard_timecodes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_episode uuid;
  v_timed   boolean;
  v_video   text;
begin
  if tg_table_name = 'lines' then
    select s.episode_id into v_episode from studio.scenes s where s.id = new.scene_id;
  else
    v_episode := new.episode_id;
  end if;
  select e.has_timecodes, e.video_path into v_timed, v_video from core.episodes e where e.id = v_episode;

  if tg_table_name = 'clips' then
    if new.source <> 'upload' and not coalesce(v_timed, false) and v_video is null then
      raise exception 'clips: episode % has neither timecodes nor a video', v_episode;
    end if;
  elsif coalesce(v_timed, false) and (new.start_ms is null or new.end_ms is null) then
    raise exception '%: start_ms and end_ms are required when the episode has timecodes', tg_table_name;
  end if;
  return new;
end
$$;

commit;
