with checks(name, ok) as (
  select '0010_clip_columns', count(*) = 9 from information_schema.columns where table_schema='studio' and table_name='clips' and column_name in ('source','moment','render_path','render_sha256','render_status','render_note','duration_ms','width','height')
  union all select 'cut_clips_enum', exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace join pg_enum e on e.enumtypid=t.oid where n.nspname='studio' and t.typname='job_kind' and e.enumlabel='cut_clips')
  union all select 'transcribe_enum', exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace join pg_enum e on e.enumtypid=t.oid where n.nspname='studio' and t.typname='job_kind' and e.enumlabel='transcribe_episode')
  union all select 'asr_enum', exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace join pg_enum e on e.enumtypid=t.oid where n.nspname='core' and t.typname='script_format' and e.enumlabel='asr')
  union all select 'campaign_launch_settings', exists(select 1 from information_schema.columns where table_schema='promote' and table_name='campaigns' and column_name='launch_settings')
  union all select 'account_preferred_advertiser', exists(select 1 from information_schema.columns where table_schema='core' and table_name='company_accounts' and column_name='preferred_advertiser_id')
  union all select 'legacy_launch_columns', count(*)=8 from information_schema.columns where table_schema='promote' and table_name='launches' and column_name in ('settings','paused','duplicates','retired_adgroups','duplicated_at','activated_at','bid_usd','schedule_end')
  union all select 'launch_presets_present', to_regclass('promote.launch_presets') is not null
  union all select 'launch_runs_rls', coalesce((select relrowsecurity from pg_class where oid=to_regclass('promote.launch_runs')),false)
  union all select 'launch_connections_rls', coalesce((select relrowsecurity from pg_class where oid=to_regclass('promote.launch_connections')),false)
  union all select 'authenticated_runs_read_only', has_table_privilege('authenticated','promote.launch_runs','SELECT') and not has_table_privilege('authenticated','promote.launch_runs','INSERT,UPDATE,DELETE')
  union all select 'authenticated_connections_read_only', has_table_privilege('authenticated','promote.launch_connections','SELECT') and not has_table_privilege('authenticated','promote.launch_connections','INSERT,UPDATE,DELETE')
  union all select 'anonymous_runs_denied', not has_table_privilege('anon','promote.launch_runs','SELECT,INSERT,UPDATE,DELETE')
  union all select 'anonymous_connections_denied', not has_table_privilege('anon','promote.launch_connections','SELECT,INSERT,UPDATE,DELETE')
  union all select 'service_runs_writes', has_table_privilege('service_role','promote.launch_runs','INSERT') and has_table_privilege('service_role','promote.launch_runs','UPDATE') and has_table_privilege('service_role','promote.launch_runs','DELETE')
  union all select 'service_connections_writes', has_table_privilege('service_role','promote.launch_connections','INSERT') and has_table_privilege('service_role','promote.launch_connections','UPDATE') and has_table_privilege('service_role','promote.launch_connections','DELETE')
  union all select 'presets_admin_only', coalesce((select qual like '%is_staff_admin()%' and with_check like '%is_staff_admin()%' from pg_policies where schemaname='promote' and tablename='launch_presets' and policyname='launch_presets_staff_write'),false)
  union all select 'account_assignment_admin_guard', pg_get_functiondef('core.guard_company_account_write()'::regprocedure) like '%auth.uid() is null or core.is_staff_admin()%'
  union all select 'scene_delete_correlates_outer_row', coalesce((select qual like '%l.scene_id = scenes.id%' from pg_policies where schemaname='studio' and tablename='scenes' and policyname='producer_delete_scenes'),false)
  union all select 'launch_company_read_scope', count(*)=2 from pg_policies where schemaname='promote' and tablename in ('launch_runs','launch_connections') and cmd='SELECT' and qual like '%research.is_member_of(producer_id)%'
)
select count(*) as checks, bool_and(ok) as all_passed, coalesce(string_agg(name, ', ') filter (where not ok), 'none') as failures from checks;
