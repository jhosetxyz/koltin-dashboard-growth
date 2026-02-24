-- Ensure we have a conflict target for upserts.
create unique index if not exists weekly_quality_by_campaign_week_utm_platform_uidx
  on public.weekly_quality_by_campaign (week_start, utm_campaign, platform);

create or replace function public.week_start_monday_utc(ts timestamptz)
returns date
language sql
immutable
as $$
  select (date_trunc('week', ts at time zone 'utc'))::date;
$$;

create or replace function public.compute_weekly_quality_by_campaign(
  since_date date,
  until_date date
)
returns table (
  week_start date,
  week_end date,
  platform text,
  utm_campaign text,
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
  quality_index numeric,
  generated_at timestamptz
)
language sql
stable
as $$
  with ad as (
    select
      date_trunc('week', (coalesce(a.date, a.day))::timestamp)::date as week_start,
      cm.utm_campaign as utm_campaign,
      sum(coalesce(a.spend, 0))::numeric as spend,
      sum(coalesce(a.impressions, 0))::bigint as impressions,
      sum(coalesce(a.clicks, 0))::bigint as clicks
    from public.ad_spend_daily a
    join public.campaign_mapping cm
      on cm.platform = 'meta'
     and cm.campaign_id = a.campaign_id
    where a.platform = 'meta'
      and coalesce(a.date, a.day) >= since_date
      and coalesce(a.date, a.day) < until_date
    group by 1, 2
  ),
  leads as (
    select
      date_trunc('week', (c.created_at at time zone 'utc'))::date as week_start,
      c.utm_campaign as utm_campaign,
      count(*)::bigint as leads,
      sum(
        case
          when c.lead_status in ('conectado llamada','llamada agendada','cliente') then 1
          else 0
        end
      )::bigint as call_positive,
      sum(
        case
          when c.lead_status in ('no contesta whatsapp') then 1
          else 0
        end
      )::bigint as no_whats,
      sum(case when c.mql is true then 1 else 0 end)::bigint as mql_count,
      sum(case when c.disqualified is true then 1 else 0 end)::bigint as disqualified_count
    from public.hubspot_contacts c
    where c.created_at >= since_date::timestamptz
      and c.created_at < until_date::timestamptz
      and c.utm_campaign is not null
    group by 1, 2
  ),
  merged as (
    select
      coalesce(a.week_start, l.week_start) as week_start,
      coalesce(a.utm_campaign, l.utm_campaign) as utm_campaign,
      coalesce(a.spend, 0)::numeric as spend,
      coalesce(a.impressions, 0)::bigint as impressions,
      coalesce(a.clicks, 0)::bigint as clicks,
      coalesce(l.leads, 0)::bigint as leads,
      coalesce(l.call_positive, 0)::bigint as call_positive,
      coalesce(l.no_whats, 0)::bigint as no_whats,
      coalesce(l.mql_count, 0)::bigint as mql_count,
      coalesce(l.disqualified_count, 0)::bigint as disqualified_count
    from ad a
    full outer join leads l
      on a.week_start = l.week_start
     and a.utm_campaign = l.utm_campaign
  )
  select
    m.week_start,
    (m.week_start + interval '6 days')::date as week_end,
    'meta'::text as platform,
    m.utm_campaign,
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

