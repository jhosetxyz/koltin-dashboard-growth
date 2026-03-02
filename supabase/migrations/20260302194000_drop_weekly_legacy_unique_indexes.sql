-- Drop any legacy unique index on (week_start, platform, utm_campaign).

do $$
declare
  r record;
  idxdef text;
begin
  for r in
    select
      i.oid as index_oid,
      i.relname as index_name
    from pg_class t
    join pg_namespace n on n.oid = t.relnamespace
    join pg_index ix on ix.indrelid = t.oid
    join pg_class i on i.oid = ix.indexrelid
    where n.nspname = 'public'
      and t.relname = 'weekly_quality_by_campaign'
  loop
    idxdef := pg_get_indexdef(r.index_oid);
    if idxdef ilike '%unique%' and idxdef ilike '%(week_start, platform, utm_campaign)%' then
      execute format('drop index if exists public.%I', r.index_name);
    end if;
  end loop;
end $$;

-- Recreate desired unique index (idempotent).
drop index if exists public.weekly_quality_by_campaign_week_platform_canonical_subgroup_uidx;
create unique index if not exists weekly_quality_by_campaign_week_platform_canonical_subgroup_uidx
  on public.weekly_quality_by_campaign (week_start, platform, canonical_campaign, canonical_subgroup);

