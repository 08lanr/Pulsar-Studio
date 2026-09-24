-- 0021 · The 60-second ad (decision 2026-09-24, "The 60-second ad";
-- lib/clips/montage.ts picks, lib/clips/montage-render.ts renders,
-- lib/clips/montage-run.ts builds).
--
-- 1. studio.job_kind gains `build_montage`: one row per build of a title's
--    60-second ad (target_type 'title'), cost 0 — ffmpeg only, no model call.
-- 2. studio.clips.moment gains 'montage': a finished 60-second ad is a clips
--    row, so the Clips library, Launch, the Meta posting (promote.clip_posts
--    references studio.clips) and the zip download take it like any clip. It
--    hangs on its hook's episode (the hook's range as start_ms / end_ms),
--    ranks from 1001 up there (clips is unique on episode × rank), is born
--    'shortlisted' and rendered.
-- 3. studio.clips.pieces (jsonb): the ad's pieces in playing order — role
--    (hook | scene | cliff), the clip each was cut from, its episode and
--    number, its range to the frame and its frame count. Required on a
--    montage row, absent on every other clip.
--
-- The row is written by the build as the service role after the route's
-- edit check (lib/data/supabase.ts addMontageClip, mirrored by the fixture);
-- producers read it through the existing producer_select policy (0010).
-- Version 0021 follows 0020_draft_series_text.sql. Idempotent; the enum value
-- is added outside a transaction, as 0016, 0018 and 0020 do.

alter type studio.job_kind add value if not exists 'build_montage';

begin;

alter table studio.clips add column if not exists pieces jsonb;

alter table studio.clips drop constraint if exists clips_moment_check;
alter table studio.clips add constraint clips_moment_check check (moment in ('opening', 'peak', 'montage'));

alter table studio.clips drop constraint if exists clips_montage_pieces;
alter table studio.clips add constraint clips_montage_pieces check (
  (moment = 'montage') = (case when pieces is null or jsonb_typeof(pieces) <> 'array' then false else jsonb_array_length(pieces) > 0 end)
);

commit;
