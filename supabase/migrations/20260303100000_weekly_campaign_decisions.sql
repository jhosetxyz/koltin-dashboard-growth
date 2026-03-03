-- Decision Engine v1
-- IMPORTANT: decisiones se calculan SOLO desde snapshot_weekly (fotografía cerrada).

-- 1) Fuente: snapshot_weekly (view sobre tabla frozen)
create or replace view public.snapshot_weekly as
select
  f.week_start,
  f.platform,
  f.canonical_campaign,
  f.canonical_subgroup,
  f.spend::numeric as spend,
  coalesce(f.leads_created, 0)::numeric as leads,
  coalesce(f.mql_count, 0)::numeric as mql,
  coalesce(f.call_done_count, 0)::numeric as int_plus,
  -- stored as percentage points (0..100) to match rule thresholds
  (coalesce(f.call_rate, 0)::numeric * 100) as call_rate,
  (coalesce(f.quality_ratio, 0)::numeric * 100) as quality_index
from public.weekly_quality_by_campaign_frozen f;

-- 2) Tabla derivada: weekly_campaign_decisions
create table if not exists public.weekly_campaign_decisions (
  week_start date not null,
  platform text not null,
  canonical_campaign text not null,
  canonical_subgroup text not null default '',
  spend numeric null,
  leads numeric null,
  mql numeric null,
  int_plus numeric null,
  call_rate numeric null,
  quality_index numeric null,
  -- WoW
  prev_spend numeric null,
  prev_leads numeric null,
  prev_quality_index numeric null,
  delta_spend_pct numeric null,
  delta_quality_index numeric null,
  delta_call_rate numeric null,
  -- flags + decision
  volume_flag text null,
  trend_flag text null,
  decision text null,
  decision_reason text null,
  decision_confidence text null,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_campaign_decisions_uidx
    unique (week_start, platform, canonical_campaign, canonical_subgroup)
);

create index if not exists weekly_campaign_decisions_week_start_idx
  on public.weekly_campaign_decisions (week_start);

create index if not exists weekly_campaign_decisions_decision_week_idx
  on public.weekly_campaign_decisions (decision, week_start);

do $$
begin
  alter table public.weekly_campaign_decisions
    drop constraint if exists weekly_campaign_decisions_platform_check;
  alter table public.weekly_campaign_decisions
    add constraint weekly_campaign_decisions_platform_check
    check (platform in ('meta', 'google'));

  alter table public.weekly_campaign_decisions
    drop constraint if exists weekly_campaign_decisions_volume_flag_check;
  alter table public.weekly_campaign_decisions
    add constraint weekly_campaign_decisions_volume_flag_check
    check (volume_flag in ('high','medium','low'));

  alter table public.weekly_campaign_decisions
    drop constraint if exists weekly_campaign_decisions_trend_flag_check;
  alter table public.weekly_campaign_decisions
    add constraint weekly_campaign_decisions_trend_flag_check
    check (trend_flag in ('improving','stable','declining'));

  alter table public.weekly_campaign_decisions
    drop constraint if exists weekly_campaign_decisions_decision_check;
  alter table public.weekly_campaign_decisions
    add constraint weekly_campaign_decisions_decision_check
    check (decision in ('scale','hold','cut','investigate'));

  alter table public.weekly_campaign_decisions
    drop constraint if exists weekly_campaign_decisions_confidence_check;
  alter table public.weekly_campaign_decisions
    add constraint weekly_campaign_decisions_confidence_check
    check (decision_confidence in ('high','medium','low'));
end $$;

-- 3) Función: compute_weekly_campaign_decisions(week_start date)
-- - self-join vs semana anterior
-- - reglas determinísticas v1
create or replace function public.compute_weekly_campaign_decisions(target_week_start date)
returns bigint
language sql
volatile
as $$
  with cur as (
    select
      s.week_start,
      s.platform,
      s.canonical_campaign,
      coalesce(s.canonical_subgroup, '') as canonical_subgroup,
      coalesce(s.spend, 0)::numeric as spend,
      coalesce(s.leads, 0)::numeric as leads,
      coalesce(s.mql, 0)::numeric as mql,
      coalesce(s.int_plus, 0)::numeric as int_plus,
      coalesce(s.call_rate, 0)::numeric as call_rate,
      coalesce(s.quality_index, 0)::numeric as quality_index
    from public.snapshot_weekly s
    where s.week_start = target_week_start
  ),
  prev as (
    select
      s.week_start,
      s.platform,
      s.canonical_campaign,
      coalesce(s.canonical_subgroup, '') as canonical_subgroup,
      coalesce(s.spend, 0)::numeric as prev_spend,
      coalesce(s.leads, 0)::numeric as prev_leads,
      coalesce(s.call_rate, 0)::numeric as prev_call_rate,
      coalesce(s.quality_index, 0)::numeric as prev_quality_index
    from public.snapshot_weekly s
    where s.week_start = (target_week_start - interval '7 days')::date
  ),
  joined as (
    select
      c.*,
      p.prev_spend,
      p.prev_leads,
      p.prev_quality_index,
      p.prev_call_rate,
      case
        when coalesce(p.prev_spend, 0) > 0
          then ((c.spend - p.prev_spend) / p.prev_spend) * 100
        else null
      end as delta_spend_pct,
      case
        when p.prev_quality_index is not null then (c.quality_index - p.prev_quality_index)
        else null
      end as delta_quality_index,
      case
        when p.prev_call_rate is not null then (c.call_rate - p.prev_call_rate)
        else null
      end as delta_call_rate
    from cur c
    left join prev p
      on p.platform = c.platform
     and p.canonical_campaign = c.canonical_campaign
     and p.canonical_subgroup = c.canonical_subgroup
  ),
  flags as (
    select
      j.*,
      case
        when j.leads >= 50 then 'high'
        when j.leads between 20 and 49 then 'medium'
        else 'low'
      end as volume_flag,
      case
        when j.delta_quality_index is null then 'stable'
        when j.delta_quality_index > 0 then 'improving'
        when j.delta_quality_index < 0 then 'declining'
        else 'stable'
      end as trend_flag,
      case
        when j.platform = 'meta' then 30::numeric
        when j.platform = 'google' and j.canonical_campaign ~* '(brand|branded)' then 30::numeric
        else 38::numeric
      end as scale_threshold
    from joined j
  ),
  decided as (
    select
      f.*,
      -- Decision Engine v1 priority:
      -- 1) CUT (hard fail)
      -- 2) INVESTIGATE (low volume / anomalies)
      -- 3) CUT (quality+call fail)
      -- 4) SCALE
      -- 5) HOLD
      -- 6) INVESTIGATE (default)
      case
        when f.mql = 0 and f.int_plus < 3 and f.spend > 0
          then 'cut'
        when f.volume_flag = 'low'
          then 'investigate'
        when f.quality_index < 25 and f.call_rate < 8 and f.volume_flag <> 'low'
          then 'cut'
        when f.quality_index >= f.scale_threshold
         and f.call_rate >= 10
         and (f.mql >= 5 or f.int_plus >= 10)
         and f.trend_flag <> 'declining'
          then 'scale'
        when f.quality_index >= 25 and f.quality_index < f.scale_threshold
         and f.volume_flag <> 'low'
         and (f.call_rate >= 8)
         and (f.delta_call_rate is null or f.delta_call_rate >= -2)
          then 'hold'
        when (
          (f.delta_quality_index is not null and f.quality_index >= f.scale_threshold and f.delta_quality_index <= -5)
          or (f.delta_spend_pct is not null and f.delta_spend_pct >= 20 and f.delta_quality_index is not null and f.delta_quality_index <= -2)
          or (f.delta_quality_index is not null and f.delta_quality_index >= 2 and f.delta_call_rate is not null and f.delta_call_rate <= -3)
        )
          then 'investigate'
        else 'investigate'
      end as decision,
      case
        when f.mql = 0 and f.int_plus < 3 and f.spend > 0
          then 'CUT: mql=0, int_plus<3 y spend>0'
        when f.volume_flag = 'low'
          then 'INVESTIGATE: low volume (<20 leads)'
        when f.quality_index < 25 and f.call_rate < 8 and f.volume_flag <> 'low'
          then 'CUT: quality_index<25 y call_rate<8 con volumen suficiente'
        when f.quality_index >= f.scale_threshold
         and f.call_rate >= 10
         and (f.mql >= 5 or f.int_plus >= 10)
         and f.trend_flag <> 'declining'
          then 'SCALE: umbral QI + call_rate + (mql/int_plus) y no declinando'
        when f.quality_index >= 25 and f.quality_index < f.scale_threshold
         and f.volume_flag <> 'low'
         and (f.call_rate >= 8)
         and (f.delta_call_rate is null or f.delta_call_rate >= -2)
          then 'HOLD: QI medio, call_rate estable y volumen suficiente'
        when (
          (f.delta_quality_index is not null and f.quality_index >= f.scale_threshold and f.delta_quality_index <= -5)
          or (f.delta_spend_pct is not null and f.delta_spend_pct >= 20 and f.delta_quality_index is not null and f.delta_quality_index <= -2)
          or (f.delta_quality_index is not null and f.delta_quality_index >= 2 and f.delta_call_rate is not null and f.delta_call_rate <= -3)
        )
          then 'INVESTIGATE: señales conflictivas o caída fuerte WoW'
        else 'INVESTIGATE: señales insuficientes o mixtas'
      end as decision_reason,
      case
        when f.volume_flag = 'high' then 'high'
        when f.volume_flag = 'medium' then 'medium'
        else 'low'
      end as decision_confidence
    from flags f
  ),
  upserted as (
    insert into public.weekly_campaign_decisions (
      week_start,
      platform,
      canonical_campaign,
      canonical_subgroup,
      spend,
      leads,
      mql,
      int_plus,
      call_rate,
      quality_index,
      prev_spend,
      prev_leads,
      prev_quality_index,
      delta_spend_pct,
      delta_quality_index,
      delta_call_rate,
      volume_flag,
      trend_flag,
      decision,
      decision_reason,
      decision_confidence,
      updated_at
    )
    select
      d.week_start,
      d.platform,
      d.canonical_campaign,
      d.canonical_subgroup,
      d.spend,
      d.leads,
      d.mql,
      d.int_plus,
      d.call_rate,
      d.quality_index,
      d.prev_spend,
      d.prev_leads,
      d.prev_quality_index,
      d.delta_spend_pct,
      d.delta_quality_index,
      d.delta_call_rate,
      d.volume_flag,
      d.trend_flag,
      d.decision,
      d.decision_reason,
      d.decision_confidence,
      now()
    from decided d
    on conflict (week_start, platform, canonical_campaign, canonical_subgroup)
    do update set
      spend = excluded.spend,
      leads = excluded.leads,
      mql = excluded.mql,
      int_plus = excluded.int_plus,
      call_rate = excluded.call_rate,
      quality_index = excluded.quality_index,
      prev_spend = excluded.prev_spend,
      prev_leads = excluded.prev_leads,
      prev_quality_index = excluded.prev_quality_index,
      delta_spend_pct = excluded.delta_spend_pct,
      delta_quality_index = excluded.delta_quality_index,
      delta_call_rate = excluded.delta_call_rate,
      volume_flag = excluded.volume_flag,
      trend_flag = excluded.trend_flag,
      decision = excluded.decision,
      decision_reason = excluded.decision_reason,
      decision_confidence = excluded.decision_confidence,
      updated_at = excluded.updated_at
    returning 1
  )
  select count(*)::bigint from upserted;
$$;

