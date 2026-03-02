-- Avoid double counting Meta spend: ignore campaign-level rollup rows (adset_id='') when adset-level rows exist.

drop function if exists public.compute_weekly_quality_by_campaign(date, date);

create function public.compute_weekly_quality_by_campaign(
  since_date date,
  until_date date
)
returns table (
  week_start date,
  week_end date,
  platform text,
  utm_campaign text,
  canonical_campaign text,
  canonical_subgroup text,
  spend numeric,
  impressions bigint,
  clicks bigint,
  ctr numeric,
  cpc numeric,
  leads_created bigint,
  cpl numeric,
  whatsapp_no_response_count bigint,
  call_done_count bigint,
  mql_count bigint,
  disqualified_count bigint,
  call_rate numeric,
  quality_ratio numeric,
  quality_index numeric,
  generated_at timestamptz
)
language sql
stable
as $$
  with spend_rows as (
    select
      a.platform,
      a.customer_id,
      a.campaign_id,
      coalesce(a.date, a.day) as day,
      coalesce(a.spend, 0)::numeric as spend,
      coalesce(a.impressions, 0)::bigint as impressions,
      coalesce(a.clicks, 0)::bigint as clicks,
      case
        when a.platform = 'meta'
         and nullif(btrim(coalesce(a.adset_name, '')), '') is not null
         and coalesce(a.adset_id, '') <> '' then coalesce(a.campaign_name, '') || '__' || a.adset_name
        else coalesce(a.campaign_name, '')
      end as naming
    from public.ad_spend_daily a
    where a.platform in ('meta', 'google')
      and coalesce(a.date, a.day) >= since_date
      and coalesce(a.date, a.day) < until_date
      and (
        (a.platform = 'google' and coalesce(a.adset_id, '') = '')
        or
        (a.platform = 'meta' and coalesce(a.adset_id, '') <> '')
      )
  ),
  spend_resolved as (
    select
      date_trunc('week', sr.day::timestamp)::date as week_start,
      sr.platform,
      coalesce(nullif(r.canonical_campaign,'unmapped'), rm.canonical_campaign, 'unmapped') as canonical_campaign,
      coalesce(nullif(r.canonical_subgroup,''), rm.canonical_subgroup, '') as canonical_subgroup,
      sum(sr.spend)::numeric as spend,
      sum(sr.impressions)::bigint as impressions,
      sum(sr.clicks)::bigint as clicks
    from spend_rows sr
    left join lateral public.parse_utm_campaign(sr.naming) p on true
    left join lateral public.resolve_canonical_campaign_v2(
      sr.platform,
      sr.naming,
      p.base_campaign,
      p.subgroup
    ) r on true
    left join public.campaign_mapping cm
      on cm.platform = sr.platform
     and cm.customer_id = sr.customer_id
     and cm.campaign_id = sr.campaign_id
    left join lateral public.parse_utm_campaign(cm.utm_campaign) pm on true
    left join lateral public.resolve_canonical_campaign_v2(
      sr.platform,
      cm.utm_campaign,
      pm.base_campaign,
      pm.subgroup
    ) rm on true
    group by 1, 2, 3, 4
  ),
  leads_rows as (
    select
      date_trunc('week', (c.created_at at time zone 'utc'))::date as week_start,
      case
        when lower(coalesce(c.utm_source, '')) like '%google%' then 'google'
        else 'meta'
      end as platform,
      nullif(btrim(coalesce(c.utm_campaign, '')), '') as utm_campaign,
      c.lead_status,
      c.mql,
      c.disqualified
    from public.hubspot_contacts c
    where c.created_at >= since_date::timestamptz
      and c.created_at < until_date::timestamptz
  ),
  leads_resolved as (
    select
      lr.week_start,
      lr.platform,
      coalesce(r.canonical_campaign, 'unmapped') as canonical_campaign,
      coalesce(r.canonical_subgroup, '') as canonical_subgroup,
      count(*)::bigint as leads,
      sum(case when lr.lead_status in ('conectado llamada','llamada agendada','cliente') then 1 else 0 end)::bigint as call_positive,
      sum(case when lr.lead_status in ('no contesta whatsapp') then 1 else 0 end)::bigint as no_whats,
      sum(case when lr.mql is true then 1 else 0 end)::bigint as mql_count,
      sum(case when lr.disqualified is true then 1 else 0 end)::bigint as disqualified_count
    from leads_rows lr
    left join lateral public.parse_utm_campaign(lr.utm_campaign) p on true
    left join lateral public.resolve_canonical_campaign_v2(
      lr.platform,
      lr.utm_campaign,
      p.base_campaign,
      p.subgroup
    ) r on true
    group by 1, 2, 3, 4
  ),
  merged as (
    select
      coalesce(s.week_start, l.week_start) as week_start,
      coalesce(s.platform, l.platform) as platform,
      coalesce(s.canonical_campaign, l.canonical_campaign) as canonical_campaign,
      coalesce(s.canonical_subgroup, l.canonical_subgroup, '') as canonical_subgroup,
      coalesce(s.spend, 0)::numeric as spend,
      coalesce(s.impressions, 0)::bigint as impressions,
      coalesce(s.clicks, 0)::bigint as clicks,
      coalesce(l.leads, 0)::bigint as leads,
      coalesce(l.call_positive, 0)::bigint as call_positive,
      coalesce(l.no_whats, 0)::bigint as no_whats,
      coalesce(l.mql_count, 0)::bigint as mql_count,
      coalesce(l.disqualified_count, 0)::bigint as disqualified_count
    from spend_resolved s
    full outer join leads_resolved l
      on s.week_start = l.week_start
     and s.platform = l.platform
     and s.canonical_campaign = l.canonical_campaign
     and s.canonical_subgroup = l.canonical_subgroup
  )
  select
    m.week_start,
    (m.week_start + interval '6 days')::date as week_end,
    m.platform,
    m.canonical_campaign as utm_campaign,
    m.canonical_campaign as canonical_campaign,
    m.canonical_subgroup,
    m.spend,
    m.impressions,
    m.clicks,
    case when m.impressions > 0 then (m.clicks::numeric / m.impressions) else null end as ctr,
    case when m.clicks > 0 then (m.spend / m.clicks) else null end as cpc,
    m.leads as leads_created,
    case when m.leads > 0 then (m.spend / m.leads) else null end as cpl,
    m.no_whats as whatsapp_no_response_count,
    m.call_positive as call_done_count,
    m.mql_count,
    m.disqualified_count,
    case when m.leads > 0 then (m.call_positive::numeric / m.leads) else null end as call_rate,
    case
      when ( (m.call_positive + 3*m.mql_count) + (m.no_whats + 3*m.disqualified_count) ) > 0
        then ((m.call_positive + 3*m.mql_count)::numeric /
              ((m.call_positive + 3*m.mql_count) + (m.no_whats + 3*m.disqualified_count))::numeric)
      else null
    end as quality_ratio,
    case
      when m.leads > 0
       and m.spend > 0
       and (m.spend / m.leads) > 0
       and ( (m.call_positive + 3*m.mql_count) + (m.no_whats + 3*m.disqualified_count) ) > 0
      then round(
        (
          (10000::numeric *
            (
              (m.call_positive + 3*m.mql_count)::numeric /
              ((m.call_positive + 3*m.mql_count) + (m.no_whats + 3*m.disqualified_count))::numeric
            )
          ) / (m.spend / m.leads)
        ) * ln((1 + m.leads)::numeric),
        0
      )
      else null
    end as quality_index,
    now() as generated_at
  from merged m;
$$;

