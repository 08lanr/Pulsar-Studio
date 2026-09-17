-- 0011 · Transcription for script-less episodes (decision 2026-09-15; the
-- v1.1 slot docs/data-model.md § migrations reserved as "0002_transcribe").
--
-- lib/asr.ts stops returning "unavailable": an explicit Materials-page
-- button transcribes an episode that has a video and no lines, writes the
-- machine VTT to storage as the episode's source script, and attaches the
-- parsed lines through the normal ingest path (attachIngestToEpisode, both
-- backends). Never silent, never replacing an existing script. Job
-- bookkeeping runs through the service role like the clip engine, so
-- producers gain NO access to studio.jobs here.
--
-- Mirrors lib/data/fixture.ts attachIngestToEpisode; apply after 0010.

-- The job kind the stub reserved and the script format the attach writes.
alter type studio.job_kind add value if not exists 'transcribe_episode';
alter type core.script_format add value if not exists 'asr';

-- Attaching a script updates the episode row's script fields. 0002 gave
-- producers insert on core.episodes but never update. 0001's own rule
-- applies (its § grants comment): a column-level grant restricts nothing
-- while the blanket table-level UPDATE from 0001 stands, so the pattern is
-- revoke-the-table, grant-the-columns — the writable surface for episode
-- rows is exactly the script/timing fields, and the row scope is the
-- producer's own titles.
drop policy if exists producer_update_episodes on core.episodes;
create policy producer_update_episodes on core.episodes for update to authenticated
  using (core.can_edit_title(title_id)) with check (core.can_edit_title(title_id));
revoke update on core.episodes from authenticated;
-- video_path is the replace-video flow's column; setEpisodeVideo addresses
-- core.episodes correctly. The two timing writes (updateLineTimings and the
-- duration mirror) once hit studio.episodes; fixed 2026-09-15.
grant update (source_script_path, script_format, has_timecodes, duration_ms, video_path)
  on core.episodes to authenticated;

-- A torn attach (the writes are not one transaction) can leave scenes with
-- no lines; the next attach heals by deleting exactly those. The policy
-- permits deleting ONLY line-less scenes on the producer's own titles —
-- a scene that carries any line stays protected.
drop policy if exists producer_delete_scenes on studio.scenes;
create policy producer_delete_scenes on studio.scenes for delete to authenticated
  using (
    core.can_edit_title(title_id)
    and not exists (select 1 from studio.lines l where l.scene_id = scenes.id)
  );
