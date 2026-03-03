-- Unmapped reports: use operational HubSpot created timestamp (old_created_at) when present.

create or replace function public.count_unmapped_utms(since_date date, until_date date)
returns bigint
language sql
stable
as $$
  select count(distinct c.utm_campaign)::bigint
  from public.hubspot_contacts c
  where coalesce(c.old_created_at, c.created_at) >= since_date::timestamptz
    and coalesce(c.old_created_at, c.created_at) < until_date::timestamptz
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
  where coalesce(c.old_created_at, c.created_at) >= since_date::timestamptz
    and coalesce(c.old_created_at, c.created_at) < until_date::timestamptz
    and nullif(btrim(c.utm_campaign), '') is not null
    and public.is_utm_mapped(c.utm_campaign) is false
  group by 1
  order by leads desc
  limit greatest(limit_n, 0);
$$;

create or replace function public.compute_utm_unmapped_weekly(
  since_date date,
  until_date date,
  limit_per_week int default 50
)
returns table (
  week_start date,
  raw_utm text,
  leads bigint,
  spend numeric,
  inserted_at timestamptz
)
language sql
stable
as $$
  with active_equals as (
    select pattern
    from public.utm_alias_rules
    where is_active is true
      and match_type = 'equals'
  ),
  unmapped_leads as (
    select
      date_trunc('week', (coalesce(c.old_created_at, c.created_at) at time zone 'utc'))::date as week_start,
      nullif(btrim(c.utm_campaign), '') as raw_utm,
      count(*)::bigint as leads
    from public.hubspot_contacts c
    where coalesce(c.old_created_at, c.created_at) >= since_date::timestamptz
      and coalesce(c.old_created_at, c.created_at) < until_date::timestamptz
      and nullif(btrim(c.utm_campaign), '') is not null
      and public.resolve_canonical_campaign(c.utm_campaign) = nullif(btrim(c.utm_campaign), '')
      and public.is_utm_mapped(c.utm_campaign) is false
      and not exists (select 1 from active_equals e where e.pattern = nullif(btrim(c.utm_campaign), ''))
    group by 1, 2
  ),
  unmapped_spend as (
    select
      date_trunc('week', (coalesce(a.date, a.day))::timestamp)::date as week_start,
      nullif(btrim(cm.utm_campaign), '') as raw_utm,
      sum(coalesce(a.spend, 0))::numeric as spend
    from public.ad_spend_daily a
    join public.campaign_mapping cm
      on cm.platform = 'meta'
     and cm.campaign_id = a.campaign_id
    where a.platform = 'meta'
      and coalesce(a.date, a.day) >= since_date
      and coalesce(a.date, a.day) < until_date
      and nullif(btrim(cm.utm_campaign), '') is not null
      and public.resolve_canonical_campaign(cm.utm_campaign) = nullif(btrim(cm.utm_campaign), '')
      and public.is_utm_mapped(cm.utm_campaign) is false
      and not exists (select 1 from active_equals e where e.pattern = nullif(btrim(cm.utm_campaign), ''))
    group by 1, 2
  ),
  merged as (
    select
      coalesce(l.week_start, s.week_start) as week_start,
      coalesce(l.raw_utm, s.raw_utm) as raw_utm,
      coalesce(l.leads, 0)::bigint as leads,
      coalesce(s.spend, 0)::numeric as spend
    from unmapped_leads l
    full outer join unmapped_spend s
      on l.week_start = s.week_start
     and l.raw_utm = s.raw_utm
  ),
  ranked as (
    select
      m.*,
      row_number() over (
        partition by m.week_start
        order by m.leads desc, m.spend desc, m.raw_utm asc
      ) as rn
    from merged m
    where m.raw_utm is not null
  )
  select
    week_start,
    raw_utm,
    leads,
    spend,
    now() as inserted_at
  from ranked
  where rn <= greatest(limit_per_week, 0);
$$;

