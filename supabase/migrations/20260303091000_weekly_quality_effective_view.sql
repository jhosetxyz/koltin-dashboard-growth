-- Convenience view:
-- - Closed weeks come from the frozen table (WOW snapshot)
-- - Current open week comes from the live table (keeps updating)

create or replace view public.weekly_quality_by_campaign_effective as
with current_week as (
  select public.week_start_monday_utc(now()) as week_start
)
select
  f.week_start,
  f.week_end,
  f.platform,
  f.utm_campaign,
  f.canonical_campaign,
  f.canonical_subgroup,
  f.spend,
  f.impressions,
  f.clicks,
  f.ctr,
  f.cpc,
  f.leads_created,
  f.cpl,
  f.whatsapp_no_response_count,
  f.call_done_count,
  f.mql_count,
  f.disqualified_count,
  f.call_rate,
  f.quality_ratio,
  f.quality_index,
  f.generated_at,
  true as is_frozen,
  f.frozen_at as as_of
from public.weekly_quality_by_campaign_frozen f

union all

select
  w.week_start,
  w.week_end,
  w.platform,
  w.utm_campaign,
  w.canonical_campaign,
  w.canonical_subgroup,
  w.spend,
  w.impressions,
  w.clicks,
  w.ctr,
  w.cpc,
  w.leads_created,
  w.cpl,
  w.whatsapp_no_response_count,
  w.call_done_count,
  w.mql_count,
  w.disqualified_count,
  w.call_rate,
  w.quality_ratio,
  w.quality_index,
  w.generated_at,
  false as is_frozen,
  w.generated_at as as_of
from public.weekly_quality_by_campaign w
join current_week cw
  on w.week_start >= cw.week_start;

