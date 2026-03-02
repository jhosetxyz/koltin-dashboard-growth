-- Drop legacy unique index/constraint that blocks v2 rows.

alter table public.weekly_quality_by_campaign
  drop constraint if exists weekly_quality_uniq;

drop index if exists public.weekly_quality_uniq;
drop index if exists weekly_quality_uniq;

