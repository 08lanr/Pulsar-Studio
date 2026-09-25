-- 0023 · Ad types on clips (decision 2026-09-25, "Ad types on clips";
-- lib/ad-formats.ts is the registry).
--
-- Ruobin makes finished ads outside Studio and uploads them; he wants each
-- one classified by type ("this is a hook ad"). studio.clips.ad_format is
-- that label, on every clip alike (an uploaded ad, a 60-second ad, a window
-- the cutter made):
--   hook_ad             one whole scene played as it is (15-60 s)
--   narration_trailer   the heroine narrates the plot in first person
--   direct_cuts_trailer the same spine in the characters' own lines
--   clip                a window cut from one episode
-- Null = not classified. It is not the launch angle (`angle`) and not how the
-- cutter chose the window (`moment`, `source`).
--
-- Written by the upload route and POST .../clips/[clipId]/format as the
-- service role after the route's edit check, as every clip write is;
-- producers read it through the existing producer_select policy (0010).
-- The app never names the column in an insert unless a type was chosen, so
-- uploads keep working before this is applied. Version 0023 follows
-- 0022_draft_series_text.sql. Idempotent; paste into the SQL editor once.

begin;

alter table studio.clips add column if not exists ad_format text;

alter table studio.clips drop constraint if exists clips_ad_format_check;
alter table studio.clips add constraint clips_ad_format_check check (
  ad_format is null or ad_format in ('hook_ad', 'narration_trailer', 'direct_cuts_trailer', 'clip')
);

commit;
