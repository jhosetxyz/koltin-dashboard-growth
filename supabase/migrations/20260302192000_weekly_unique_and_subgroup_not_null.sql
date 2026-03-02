-- Weekly v2: make canonical_subgroup not null and fix unique constraint to include subgroup.

alter table public.weekly_quality_by_campaign
  add column if not exists canonical_subgroup text;

update public.weekly_quality_by_campaign
set canonical_subgroup = coalesce(canonical_subgroup, '')
where canonical_subgroup is null;

alter table public.weekly_quality_by_campaign
  alter column canonical_subgroup set default '',
  alter column canonical_subgroup set not null;

-- Drop legacy unique constraint (observed as weekly_quality_uniq) and any old indexes.
alter table public.weekly_quality_by_campaign
  drop constraint if exists weekly_quality_uniq;

drop index if exists public.weekly_quality_by_campaign_week_utm_platform_uidx;
drop index if exists public.weekly_quality_by_campaign_week_platform_canonical_subgroup_uidx;

create unique index if not exists weekly_quality_by_campaign_week_platform_canonical_subgroup_uidx
  on public.weekly_quality_by_campaign (week_start, platform, canonical_campaign, canonical_subgroup);

