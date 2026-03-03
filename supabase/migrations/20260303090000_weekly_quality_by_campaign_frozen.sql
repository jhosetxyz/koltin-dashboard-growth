-- Frozen weekly snapshot table:
-- - One row per closed week + dimension
-- - Insert-once semantics enforced by unique key and "ignore duplicates" on insert.

create table if not exists public.weekly_quality_by_campaign_frozen (
  week_start date not null,
  week_end date null,
  platform text not null,
  utm_campaign text null,
  canonical_campaign text not null,
  canonical_subgroup text not null default '',
  spend numeric null,
  impressions bigint null,
  clicks bigint null,
  ctr numeric null,
  cpc numeric null,
  leads_created bigint null,
  cpl numeric null,
  whatsapp_no_response_count bigint null,
  call_done_count bigint null,
  mql_count bigint null,
  disqualified_count bigint null,
  call_rate numeric null,
  quality_ratio numeric null,
  quality_index numeric null,
  generated_at timestamptz null,
  frozen_at timestamptz not null default now(),
  constraint weekly_quality_by_campaign_frozen_uidx
    unique (week_start, platform, canonical_campaign, canonical_subgroup)
);

create index if not exists weekly_quality_by_campaign_frozen_week_start_idx
  on public.weekly_quality_by_campaign_frozen (week_start);

create index if not exists weekly_quality_by_campaign_frozen_platform_week_idx
  on public.weekly_quality_by_campaign_frozen (platform, week_start);

do $$
begin
  alter table public.weekly_quality_by_campaign_frozen
    drop constraint if exists weekly_quality_by_campaign_frozen_platform_check;

  alter table public.weekly_quality_by_campaign_frozen
    add constraint weekly_quality_by_campaign_frozen_platform_check
    check (platform in ('meta', 'google'));
end $$;

