-- Allow multi-platform weekly rows (meta + google).

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'weekly_quality_by_campaign'
  ) then
    alter table public.weekly_quality_by_campaign
      drop constraint if exists weekly_quality_by_campaign_platform_check;

    alter table public.weekly_quality_by_campaign
      add constraint weekly_quality_by_campaign_platform_check
      check (platform in ('meta', 'google'));
  end if;
end $$;

