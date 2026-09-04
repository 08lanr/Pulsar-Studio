-- 0002 · The producer-first pivot (docs/decisions.md, 2026-09-03 afternoon).
--
-- The self-serve flow moves most of the work to the producer's portal: their
-- reviewer/approver users create titles under their own company, upload
-- scripts, run the AI pass, edit lines, confirm scenes, and FINALIZE — one
-- action that freezes the snapshot and approves it, with per-scene sign-off
-- rows. Staff keep the submit + approve-on-behalf path; finalize refuses
-- staff so an approval always says which side made it.
--
-- Mirrors lib/data/fixture.ts requireTitleEditor + finalizeVersion. Apply
-- after 0001_init.sql.

-- ---- who may edit ---------------------------------------------------------

create or replace function core.can_edit_title(p_title_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select core.is_staff() or exists (
    select 1
    from core.titles t
    join core.profiles p on p.id = auth.uid()
    where t.id = p_title_id
      and p.kind = 'producer'
      and p.producer_id = t.producer_id
      and p.producer_role in ('approver', 'reviewer')
  );
$$;

create or replace function core.is_producer_editor()
returns boolean language sql stable security definer set search_path = core as $$
  select exists (
    select 1 from core.profiles p
    where p.id = auth.uid() and p.kind = 'producer'
      and p.producer_role in ('approver', 'reviewer')
  );
$$;

-- ---- writes the portal now needs -----------------------------------------
-- 0001 granted producers SELECT only. Each policy scopes to their own
-- company through can_edit_title(); the guard triggers from 0001
-- (guard_frozen, guard_source_text, derive_title_id) still apply.

-- Create a title under their own company only.
drop policy if exists producer_insert_titles on core.titles;
create policy producer_insert_titles on core.titles for insert to authenticated
  with check (
    core.is_producer_editor()
    and producer_id = (select producer_id from core.profiles where id = auth.uid())
  );
drop policy if exists producer_update_titles on core.titles;
create policy producer_update_titles on core.titles for update to authenticated
  using (core.can_edit_title(id)) with check (core.can_edit_title(id));

-- Ingest: episodes, scenes, lines, characters, the adaptation row, drafts.
drop policy if exists producer_insert_episodes on core.episodes;
create policy producer_insert_episodes on core.episodes for insert to authenticated
  with check (core.can_edit_title(title_id));

drop policy if exists producer_insert_scenes on studio.scenes;
create policy producer_insert_scenes on studio.scenes for insert to authenticated
  with check (core.can_edit_title(title_id));
drop policy if exists producer_update_scenes on studio.scenes;
create policy producer_update_scenes on studio.scenes for update to authenticated
  using (core.can_edit_title(title_id)) with check (core.can_edit_title(title_id));

drop policy if exists producer_insert_lines on studio.lines;
create policy producer_insert_lines on studio.lines for insert to authenticated
  with check (core.can_edit_title(title_id));

drop policy if exists producer_insert_characters on studio.characters;
create policy producer_insert_characters on studio.characters for insert to authenticated
  with check (core.can_edit_title(title_id));
drop policy if exists producer_update_characters on studio.characters;
create policy producer_update_characters on studio.characters for update to authenticated
  using (core.can_edit_title(title_id)) with check (core.can_edit_title(title_id));

drop policy if exists producer_insert_adaptations on studio.adaptations;
create policy producer_insert_adaptations on studio.adaptations for insert to authenticated
  with check (core.can_edit_title(title_id));

drop policy if exists producer_insert_versions on studio.versions;
create policy producer_insert_versions on studio.versions for insert to authenticated
  with check (core.can_edit_title(title_id) and status = 'draft');
-- Producers now see their own drafts (they author them). 0001's SELECT
-- policy hid status = 'draft'; replace it.
drop policy if exists producer_select_versions on studio.versions;
create policy producer_select_versions on studio.versions for select to authenticated
  using (core.can_read_title(title_id));

drop policy if exists producer_write_adapted_lines on studio.adapted_lines;
create policy producer_write_adapted_lines on studio.adapted_lines for all to authenticated
  using (core.can_edit_title(title_id)) with check (core.can_edit_title(title_id));

drop policy if exists producer_write_alternatives on studio.line_alternatives;
create policy producer_write_alternatives on studio.line_alternatives for all to authenticated
  using (core.can_edit_title(title_id)) with check (core.can_edit_title(title_id));

-- Their generate-button presses are job rows on their own titles. Cost stays
-- invisible: 0001's column revoke on jobs for producers remains; this only
-- lets the rows exist.
drop policy if exists producer_insert_jobs on studio.jobs;
create policy producer_insert_jobs on studio.jobs for insert to authenticated
  with check (title_id is not null and core.can_edit_title(title_id));
drop policy if exists producer_update_jobs on studio.jobs;
create policy producer_update_jobs on studio.jobs for update to authenticated
  using (title_id is not null and core.can_edit_title(title_id))
  with check (title_id is not null and core.can_edit_title(title_id));

-- Storage: uploads into the imports/media buckets under their own titles.
drop policy if exists producer_upload_imports on storage.objects;
create policy producer_upload_imports on storage.objects for insert to authenticated
  with check (
    bucket_id in ('studio-imports', 'studio-media')
    and core.can_edit_title(((storage.foldername(name))[1])::uuid)
  );

-- set_scene_status was staff-only in 0001; the producer confirms scenes now.
create or replace function studio.set_scene_status(p_scene_id uuid, p_status studio.scene_status)
returns uuid language plpgsql security definer set search_path = studio, core as $$
declare
  v_scene studio.scenes%rowtype;
  v_before studio.scene_status;
begin
  select * into v_scene from studio.scenes where id = p_scene_id;
  if not found then raise exception 'scene % not found', p_scene_id using errcode = 'P0002'; end if;
  if not core.can_edit_title(v_scene.title_id) then
    raise exception 'not an editor of this title' using errcode = '42501';
  end if;
  v_before := v_scene.status;
  update studio.scenes
     set status = p_status, status_by = auth.uid(), status_at = now()
   where id = p_scene_id;
  insert into core.audit_events (actor_id, actor_kind, action, table_name, row_id, title_id, before, after)
  values (auth.uid(), case when core.is_staff() then 'staff' else 'producer' end,
          'set_scene_status', 'studio.scenes', p_scene_id, v_scene.title_id,
          jsonb_build_object('status', v_before), jsonb_build_object('status', p_status));
  return p_scene_id;
end $$;

-- ---- finalize_version -----------------------------------------------------
-- The producer approver's one action: draft -> approved with the frozen
-- snapshot, per-scene sign-off rows, previous approved version superseded.
-- Reuses 0001's snapshot builder if one exists; otherwise builds inline the
-- same shape submit_version writes.

create or replace function studio.finalize_version(p_version_id uuid)
returns uuid language plpgsql security definer set search_path = studio, core as $$
declare
  v studio.versions%rowtype;
  v_profile core.profiles%rowtype;
  v_snapshot jsonb;
  v_sha text;
  v_prev uuid;
begin
  select * into v from studio.versions where id = p_version_id;
  if not found then raise exception 'version % not found', p_version_id using errcode = 'P0002'; end if;

  select * into v_profile from core.profiles where id = auth.uid();
  if v_profile.kind is distinct from 'producer' then
    raise exception 'finalize is the producer''s action; staff submit for review instead' using errcode = '42501';
  end if;
  if v_profile.producer_role is distinct from 'approver' then
    raise exception 'finalizing needs the approver role' using errcode = '42501';
  end if;
  if not core.can_edit_title(v.title_id) then
    raise exception 'not an editor of this title' using errcode = '42501';
  end if;
  if v.status <> 'draft' then
    raise exception 'version is %, expected draft', v.status using errcode = '55000';
  end if;

  -- V2 (subtitles, not scenes): no scene-confirm gate — the producer's one
  -- click finalizes the whole episode; scene sign-off rows below are written
  -- automatically as the approval record.

  -- The same readiness gate submit_version applies (0001): every source line
  -- adapted, non-cut lines non-empty, changed lines carry rationale_zh and
  -- back_translation_zh.
  perform studio.assert_version_ready(p_version_id);

  v_snapshot := studio.build_version_snapshot(p_version_id);
  v_sha := encode(digest(v_snapshot::text, 'sha256'), 'hex');

  insert into studio.scene_decisions
    (version_id, scene_id, title_id, decision, decided_by, decided_at, decided_kind)
  select p_version_id, s.id, v.title_id, 'approved', auth.uid(), now(), 'producer'
  from studio.scenes s where s.episode_id = v.episode_id
  on conflict (version_id, scene_id) do update
    set decision = 'approved', decided_by = auth.uid(), decided_at = now(), decided_kind = 'producer';

  select id into v_prev from studio.versions
   where adaptation_id = v.adaptation_id and episode_id = v.episode_id
     and status = 'approved' and id <> p_version_id;
  if v_prev is not null then
    update studio.versions set status = 'superseded', updated_at = now() where id = v_prev;
  end if;

  update studio.versions
     set status = 'approved',
         submitted_at = now(), submitted_by = auth.uid(),
         approved_at = now(), approved_by = auth.uid(),
         approval_mode = 'in_app',
         snapshot = v_snapshot, snapshot_sha256 = v_sha,
         updated_at = now()
   where id = p_version_id;

  update core.titles set updated_at = now() where id = v.title_id;

  insert into core.audit_events (actor_id, actor_kind, action, table_name, row_id, title_id, before, after)
  values (auth.uid(), 'producer', 'finalize_version', 'studio.versions', p_version_id, v.title_id,
          jsonb_build_object('status', 'draft'),
          jsonb_build_object('status', 'approved', 'snapshot_sha256', v_sha));

  return p_version_id;
end $$;

grant execute on function studio.finalize_version(uuid) to authenticated;
grant execute on function core.can_edit_title(uuid) to authenticated;
grant execute on function core.is_producer_editor() to authenticated;

-- NOTE: 0001 names its snapshot builder / readiness assertion as part of
-- submit_version. If they are inlined there rather than the helpers
-- studio.build_version_snapshot(uuid) / studio.assert_version_ready(uuid),
-- extract them when applying this file — the fixture layer
-- (lib/data/fixture.ts finalizeVersion) is the reference behaviour either
-- way, and no Supabase project has been provisioned yet.
