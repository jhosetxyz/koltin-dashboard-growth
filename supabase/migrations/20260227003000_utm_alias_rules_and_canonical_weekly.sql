create table if not exists public.utm_alias_rules (
  id bigserial primary key,
  match_type text not null,
  pattern text not null,
  canonical_campaign text not null,
  priority int not null default 100,
  is_active boolean not null default true,
  notes text null,
  inserted_at timestamptz not null default now()
);

create index if not exists utm_alias_rules_active_priority_idx
  on public.utm_alias_rules (is_active, priority);

create or replace function public.resolve_canonical_campaign(raw_utm text)
returns text
language plpgsql
stable
as $$
declare
  cleaned text;
  r record;
begin
  cleaned := nullif(btrim(raw_utm), '');
  if cleaned is null then
    return 'unmapped';
  end if;

  for r in
    select match_type, pattern, canonical_campaign
    from public.utm_alias_rules
    where is_active is true
    order by priority asc, id asc
  loop
    if r.match_type = 'equals' and cleaned = r.pattern then
      return r.canonical_campaign;
    elsif r.match_type = 'contains' and cleaned ilike ('%' || r.pattern || '%') then
      return r.canonical_campaign;
    elsif r.match_type = 'regex' and cleaned ~ r.pattern then
      return r.canonical_campaign;
    end if;
  end loop;

  -- No rule match: keep raw value (caller can treat as "unmapped" via separate check).
  return cleaned;
end;
$$;

create or replace function public.is_utm_mapped(raw_utm text)
returns boolean
language plpgsql
stable
as $$
declare
  cleaned text;
  r record;
begin
  cleaned := nullif(btrim(raw_utm), '');
  if cleaned is null then
    return false;
  end if;

  for r in
    select match_type, pattern
    from public.utm_alias_rules
    where is_active is true
    order by priority asc, id asc
  loop
    if r.match_type = 'equals' and cleaned = r.pattern then
      return true;
    elsif r.match_type = 'contains' and cleaned ilike ('%' || r.pattern || '%') then
      return true;
    elsif r.match_type = 'regex' and cleaned ~ r.pattern then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

alter table public.weekly_quality_by_campaign
  add column if not exists canonical_campaign text;

-- Replace compute function to aggregate by canonical campaign
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
  with ad as (
    select
      date_trunc('week', (coalesce(a.date, a.day))::timestamp)::date as week_start,
      public.resolve_canonical_campaign(cm.utm_campaign) as canonical_campaign,
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
      public.resolve_canonical_campaign(c.utm_campaign) as canonical_campaign,
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
    group by 1, 2
  ),
  merged as (
    select
      coalesce(a.week_start, l.week_start) as week_start,
      coalesce(a.canonical_campaign, l.canonical_campaign) as canonical_campaign,
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
     and a.canonical_campaign = l.canonical_campaign
  )
  select
    m.week_start,
    (m.week_start + interval '6 days')::date as week_end,
    'meta'::text as platform,
    m.canonical_campaign as utm_campaign,
    m.canonical_campaign as canonical_campaign,
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

create or replace function public.count_unmapped_utms(since_date date, until_date date)
returns bigint
language sql
stable
as $$
  select count(distinct c.utm_campaign)::bigint
  from public.hubspot_contacts c
  where c.created_at >= since_date::timestamptz
    and c.created_at < until_date::timestamptz
    and nullif(btrim(c.utm_campaign), '') is not null
    and public.is_utm_mapped(c.utm_campaign) is false;
$$;

create or replace function public.top_unmapped_utms(since_date date, until_date date, limit_n int default 20)
returns table (raw_utm text, leads bigint)
language sql
stable
as $$
  select c.utm_campaign as raw_utm, count(*)::bigint as leads
  from public.hubspot_contacts c
  where c.created_at >= since_date::timestamptz
    and c.created_at < until_date::timestamptz
    and nullif(btrim(c.utm_campaign), '') is not null
    and public.is_utm_mapped(c.utm_campaign) is false
  group by 1
  order by leads desc
  limit greatest(limit_n, 0);
$$;

