-- 0024 · Quick hook ads (decision 2026-10-01, "Quick hook ads";
-- lib/clips/quick-hook.ts picks, lib/clips/quick-hook-run.ts builds).
--
-- 1. studio.job_kind gains `build_quick_hooks`: one row per build of a
--    title's quick hook variants (target_type 'title'), cost 0 — ffmpeg only.
-- 2. studio.clips.ad_format gains 'quick_hook': the 2-3 s bait, the scene
--    that leads up to it, a line of text on screen. Each variant is a clips
--    row of moment 'montage' with its pieces (0021), labelled quick_hook, so
--    Launch, the Ads tab and the zip download take it like any clip.
--    'hook_ad' stays valid for the ads already filed under it.
--
-- Version 0024 follows 0023_clip_ad_format.sql. Idempotent; the enum value
-- is added outside a transaction, as 0021 does. Paste into the SQL editor once.

alter type studio.job_kind add value if not exists 'build_quick_hooks';

begin;

alter table studio.clips add column if not exists ad_format text;

alter table studio.clips drop constraint if exists clips_ad_format_check;
alter table studio.clips add constraint clips_ad_format_check check (
  ad_format is null or ad_format in ('hook_ad', 'narration_trailer', 'direct_cuts_trailer', 'clip', 'quick_hook')
);

commit;
