-- Allow campaign_mapping rows for Google (in addition to Meta).

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'campaign_mapping'
  ) then
    alter table public.campaign_mapping
      drop constraint if exists campaign_mapping_platform_check;

    alter table public.campaign_mapping
      add constraint campaign_mapping_platform_check
      check (platform in ('meta', 'google'));
  end if;
end $$;

