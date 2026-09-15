-- 0010 · Ad clips cut automatically after an upload (decision 2026-09-14,
-- "angles, clips and a budget-gated pick").
--
-- 1. studio.clips gains the render bookkeeping: how the moment was chosen
--    (script | footage), what it is for (opening | peak), and the finished
--    9:16 file with its hash and status. Nothing is burned into the picture.
-- 2. studio.job_kind gains 'cut_clips' (the background run; cost 0).
-- 3. guard_timecodes lets a clip row exist on an untimed episode that has a
--    video: the footage path picks moments from scene cuts and loudness.
-- 4. Producers read the clips of their own titles (RLS producer_select);
--    the system actor (service role) and staff write renders, as before.
--
-- Idempotent throughout; the enum value is added first so nothing below
-- depends on it inside the same statement.

alter type studio.job_kind add value if not exists 'cut_clips';

begin;

alter table studio.clips add column if not exists source text not null default 'script' check (source in ('script', 'footage'));
alter table studio.clips add column if not exists moment text not null default 'peak' check (moment in ('opening', 'peak'));
alter table studio.clips add column if not exists render_path text;
alter table studio.clips add column if not exists render_sha256 text check (render_sha256 is null or render_sha256 ~ '^[0-9a-f]{64}$');
alter table studio.clips add column if not exists render_status text not null default 'pending' check (render_status in ('pending', 'rendered', 'failed'));
alter table studio.clips add column if not exists render_note text;
alter table studio.clips add column if not exists duration_ms int check (duration_ms is null or duration_ms > 0);
alter table studio.clips add column if not exists width int;
alter table studio.clips add column if not exists height int;

create index if not exists clips_title_rendered_idx on studio.clips (title_id) where render_status = 'rendered';

-- Footage clips: an episode with a video but no timecodes may carry clips (the row still needs its own start/end).
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
    if not coalesce(v_timed, false) and v_video is null then
      raise exception 'clips: episode % has neither timecodes nor a video', v_episode;
    end if;
  elsif coalesce(v_timed, false) and (new.start_ms is null or new.end_ms is null) then
    raise exception '%: start_ms and end_ms are required when the episode has timecodes', tg_table_name;
  end if;
  return new;
end
$$;

-- Producers read their own titles' clips (the Materials page); writes stay staff / service role.
drop policy if exists producer_select on studio.clips;
create policy producer_select on studio.clips for select to authenticated using (core.can_read_title(title_id));

grant select on studio.clips to authenticated;
grant select, insert, update, delete on studio.clips to service_role, studio_owner;

commit;
