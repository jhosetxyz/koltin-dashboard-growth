-- Allow seeding campaign mappings with utm_campaign unset (NULL).

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'campaign_mapping'
  ) then
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'campaign_mapping'
        and column_name = 'utm_campaign'
    ) then
      alter table public.campaign_mapping
        alter column utm_campaign drop not null;
    end if;

    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'campaign_mapping'
        and column_name = 'notes'
    ) then
      alter table public.campaign_mapping
        alter column notes drop not null;
    end if;
  end if;
end $$;

