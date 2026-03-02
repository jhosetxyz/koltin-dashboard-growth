-- Canonical resolver v2: naming-system based (utm_source/platform + naming tokens), not campaign IDs.

-- 1) Extend weekly output schema.
alter table public.weekly_quality_by_campaign
  add column if not exists canonical_subgroup text;

-- Replace unique index to include canonical_subgroup (avoid collisions across subgroups).
drop index if exists public.weekly_quality_by_campaign_week_utm_platform_uidx;
create unique index if not exists weekly_quality_by_campaign_week_platform_canonical_subgroup_uidx
  on public.weekly_quality_by_campaign (week_start, platform, canonical_campaign, canonical_subgroup);

-- 2) Make utm_alias_rules source-aware.
alter table public.utm_alias_rules
  add column if not exists platform text not null default 'meta',
  add column if not exists canonical_subgroup text null;

-- Ensure match_type constraint exists (historical migrations also do this; idempotent).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'utm_alias_rules_match_type_check'
  ) then
    alter table public.utm_alias_rules
      add constraint utm_alias_rules_match_type_check
      check (match_type in ('equals', 'contains', 'regex'));
  end if;
end $$;

-- Upsert-friendly uniqueness (no partial unique index).
drop index if exists public.utm_alias_rules_active_match_uidx;
create unique index if not exists utm_alias_rules_platform_match_uidx
  on public.utm_alias_rules (platform, match_type, pattern);

-- 3) Canonical dictionary (rules) — configurable business rules by platform/source.
create table if not exists public.canonical_dictionary (
  id bigserial primary key,
  platform text not null, -- meta/google/...
  apply_to text not null, -- 'raw','base','subgroup'
  match_type text not null, -- equals/contains/regex
  pattern text not null,
  canonical_campaign text not null,
  canonical_subgroup text null,
  priority int not null default 100,
  is_active boolean not null default true,
  notes text null,
  inserted_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'canonical_dictionary_match_type_check'
  ) then
    alter table public.canonical_dictionary
      add constraint canonical_dictionary_match_type_check
      check (match_type in ('equals', 'contains', 'regex'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'canonical_dictionary_apply_to_check'
  ) then
    alter table public.canonical_dictionary
      add constraint canonical_dictionary_apply_to_check
      check (apply_to in ('raw', 'base', 'subgroup'));
  end if;
end $$;

create index if not exists canonical_dictionary_active_priority_idx
  on public.canonical_dictionary (platform, is_active, priority, id);

create unique index if not exists canonical_dictionary_platform_apply_match_uidx
  on public.canonical_dictionary (platform, apply_to, match_type, pattern);

-- Minimal seed rules (can be edited/extended in DB; higher priority wins).
insert into public.canonical_dictionary
  (platform, apply_to, match_type, pattern, canonical_campaign, canonical_subgroup, priority, is_active, notes)
values
  ('google','raw','contains','search','search_insurance',null,50,true,'Default: any search => search_insurance (override with higher priority)'),
  ('google','raw','contains','pmax','pmax',null,50,true,'Default: pmax'),
  ('google','raw','contains','search_brand','search_brand',null,40,true,'Default: search_brand'),
  ('meta','raw','contains','CDMX60-84','conversion_abo',null,50,true,'Default: ABO CDMX60-84'),
  ('meta','raw','contains','GDL60-84','conversion_abo',null,50,true,'Default: ABO GDL60-84'),
  ('meta','raw','contains','MTY60-84','conversion_abo',null,50,true,'Default: ABO MTY60-84')
on conflict (platform, apply_to, match_type, pattern) do update
set canonical_campaign = excluded.canonical_campaign,
    canonical_subgroup = excluded.canonical_subgroup,
    priority = excluded.priority,
    is_active = excluded.is_active,
    notes = excluded.notes;

-- 4) Parsing and normalization helpers.
create or replace function public.normalize_campaign_token(input text)
returns text
language sql
immutable
as $$
  select
    nullif(
      regexp_replace(
        regexp_replace(
          lower(btrim(coalesce(input, ''))),
          '[^a-z0-9]+',
          '_',
          'g'
        ),
        '^_+|_+$',
        '',
        'g'
      ),
      ''
    );
$$;

create or replace function public.parse_utm_campaign(utm_campaign text)
returns table (
  base_campaign text,
  subgroup text,
  is_new_format boolean
)
language sql
immutable
as $$
  with cleaned as (
    select nullif(btrim(coalesce(utm_campaign, '')), '') as raw
  ),
  parts as (
    select
      raw,
      position('__' in raw) as pos
    from cleaned
  )
  select
    public.normalize_campaign_token(
      case
        when raw is null then null
        when pos > 0 then left(raw, pos - 1)
        else raw
      end
    ) as base_campaign,
    public.normalize_campaign_token(
      case
        when raw is null then null
        when pos > 0 then substring(raw from pos + 2)
        else null
      end
    ) as subgroup,
    (raw is not null and pos > 0) as is_new_format
  from parts;
$$;

-- 5) Resolver v2.
create or replace function public.resolve_canonical_campaign_v2(
  source text,
  utm_campaign text,
  base_campaign text,
  subgroup text
)
returns table (
  canonical_campaign text,
  canonical_subgroup text
)
language sql
stable
as $$
  with ctx as (
    select
      lower(nullif(btrim(coalesce(source, '')), '')) as platform,
      nullif(btrim(coalesce(utm_campaign, '')), '') as raw,
      nullif(btrim(coalesce(base_campaign, '')), '') as base_norm,
      nullif(btrim(coalesce(subgroup, '')), '') as subgroup_norm
  ),
  dict as (
    select d.canonical_campaign, d.canonical_subgroup, d.priority, d.id
    from public.canonical_dictionary d
    join ctx on d.platform = ctx.platform
    where d.is_active is true
      and (
        (d.apply_to = 'raw' and ctx.raw is not null and (
          (d.match_type = 'equals' and ctx.raw = d.pattern) or
          (d.match_type = 'contains' and ctx.raw ilike ('%' || d.pattern || '%')) or
          (d.match_type = 'regex' and ctx.raw ~ d.pattern)
        )) or
        (d.apply_to = 'base' and ctx.base_norm is not null and (
          (d.match_type = 'equals' and ctx.base_norm = d.pattern) or
          (d.match_type = 'contains' and ctx.base_norm ilike ('%' || d.pattern || '%')) or
          (d.match_type = 'regex' and ctx.base_norm ~ d.pattern)
        )) or
        (d.apply_to = 'subgroup' and ctx.subgroup_norm is not null and (
          (d.match_type = 'equals' and ctx.subgroup_norm = d.pattern) or
          (d.match_type = 'contains' and ctx.subgroup_norm ilike ('%' || d.pattern || '%')) or
          (d.match_type = 'regex' and ctx.subgroup_norm ~ d.pattern)
        ))
      )
    order by d.priority asc, d.id asc
    limit 1
  ),
  alias_rules as (
    select a.canonical_campaign, a.canonical_subgroup, a.priority, a.id
    from public.utm_alias_rules a
    join ctx on a.platform = ctx.platform
    where a.is_active is true
      and ctx.raw is not null
      and (
        (a.match_type = 'equals' and ctx.raw = a.pattern) or
        (a.match_type = 'contains' and ctx.raw ilike ('%' || a.pattern || '%')) or
        (a.match_type = 'regex' and ctx.raw ~ a.pattern)
      )
    order by a.priority asc, a.id asc
    limit 1
  )
  select
    coalesce(dict.canonical_campaign, alias_rules.canonical_campaign, 'unmapped') as canonical_campaign,
    coalesce(dict.canonical_subgroup, alias_rules.canonical_subgroup, ctx.subgroup_norm) as canonical_subgroup
  from ctx
  left join dict on true
  left join alias_rules on dict.canonical_campaign is null;
$$;

-- 6) Weekly compute: naming-system based attribution.
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
      coalesce(a.campaign_name, '') as campaign_name,
      a.campaign_id,
      a.customer_id,
      coalesce(a.date, a.day) as day,
      coalesce(a.spend, 0)::numeric as spend,
      coalesce(a.impressions, 0)::bigint as impressions,
      coalesce(a.clicks, 0)::bigint as clicks
    from public.ad_spend_daily a
    where a.platform in ('meta', 'google')
      and coalesce(a.date, a.day) >= since_date
      and coalesce(a.date, a.day) < until_date
  ),
  spend_resolved as (
    select
      date_trunc('week', sr.day::timestamp)::date as week_start,
      sr.platform,
      coalesce(nullif(r.canonical_campaign,'unmapped'), rm.canonical_campaign, 'unmapped') as canonical_campaign,
      coalesce(nullif(r.canonical_subgroup,''), rm.canonical_subgroup, null) as canonical_subgroup,
      sum(sr.spend)::numeric as spend,
      sum(sr.impressions)::bigint as impressions,
      sum(sr.clicks)::bigint as clicks
    from spend_rows sr
    left join lateral public.parse_utm_campaign(sr.campaign_name) p on true
    left join lateral public.resolve_canonical_campaign_v2(
      sr.platform,
      sr.campaign_name,
      p.base_campaign,
      p.subgroup
    ) r on true
    -- Fallback: if still unmapped, try campaign_mapping.utm_campaign (explicit mapping only).
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
  spend_final as (
    select
      week_start,
      platform,
      canonical_campaign,
      canonical_subgroup,
      spend,
      impressions,
      clicks
    from spend_resolved
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
      r.canonical_campaign,
      r.canonical_subgroup,
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
      coalesce(s.canonical_subgroup, l.canonical_subgroup) as canonical_subgroup,
      coalesce(s.spend, 0)::numeric as spend,
      coalesce(s.impressions, 0)::bigint as impressions,
      coalesce(s.clicks, 0)::bigint as clicks,
      coalesce(l.leads, 0)::bigint as leads,
      coalesce(l.call_positive, 0)::bigint as call_positive,
      coalesce(l.no_whats, 0)::bigint as no_whats,
      coalesce(l.mql_count, 0)::bigint as mql_count,
      coalesce(l.disqualified_count, 0)::bigint as disqualified_count
    from spend_final s
    full outer join leads_resolved l
      on s.week_start = l.week_start
     and s.platform = l.platform
     and s.canonical_campaign = l.canonical_campaign
     and coalesce(s.canonical_subgroup, '') = coalesce(l.canonical_subgroup, '')
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

