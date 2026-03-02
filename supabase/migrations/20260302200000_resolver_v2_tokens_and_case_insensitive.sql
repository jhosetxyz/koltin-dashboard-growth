-- Resolver v2 improvements:
-- - Make regex matches case-insensitive (~*)
-- - Support token substitution for "__USE_PARSED_BASE__" and "__USE_PARSED_SUBGROUP__"
-- - Seed structural rules for per_/aw_ naming to use parsed base/subgroup.

-- 1) Recreate resolver with token support + case-insensitive matching.
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
          (d.match_type = 'equals' and lower(ctx.raw) = lower(d.pattern)) or
          (d.match_type = 'contains' and ctx.raw ilike ('%' || d.pattern || '%')) or
          (d.match_type = 'regex' and ctx.raw ~* d.pattern)
        )) or
        (d.apply_to = 'base' and ctx.base_norm is not null and (
          (d.match_type = 'equals' and lower(ctx.base_norm) = lower(d.pattern)) or
          (d.match_type = 'contains' and ctx.base_norm ilike ('%' || d.pattern || '%')) or
          (d.match_type = 'regex' and ctx.base_norm ~* d.pattern)
        )) or
        (d.apply_to = 'subgroup' and ctx.subgroup_norm is not null and (
          (d.match_type = 'equals' and lower(ctx.subgroup_norm) = lower(d.pattern)) or
          (d.match_type = 'contains' and ctx.subgroup_norm ilike ('%' || d.pattern || '%')) or
          (d.match_type = 'regex' and ctx.subgroup_norm ~* d.pattern)
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
        (a.match_type = 'equals' and lower(ctx.raw) = lower(a.pattern)) or
        (a.match_type = 'contains' and ctx.raw ilike ('%' || a.pattern || '%')) or
        (a.match_type = 'regex' and ctx.raw ~* a.pattern)
      )
    order by a.priority asc, a.id asc
    limit 1
  ),
  picked as (
    select
      ctx.*,
      coalesce(dict.canonical_campaign, alias_rules.canonical_campaign, 'unmapped') as picked_campaign,
      coalesce(dict.canonical_subgroup, alias_rules.canonical_subgroup, ctx.subgroup_norm) as picked_subgroup
    from ctx
    left join dict on true
    left join alias_rules on dict.canonical_campaign is null
  )
  select
    case
      when picked_campaign = '__USE_PARSED_BASE__' then coalesce(base_norm, 'unmapped')
      else picked_campaign
    end as canonical_campaign,
    case
      when picked_subgroup = '__USE_PARSED_SUBGROUP__' then coalesce(subgroup_norm, '')
      else coalesce(picked_subgroup, '')
    end as canonical_subgroup
  from picked;
$$;

-- 2) Seed structural rules: if per_/aw_ prefix, use parsed base/subgroup.
insert into public.canonical_dictionary
  (platform, apply_to, match_type, pattern, canonical_campaign, canonical_subgroup, priority, is_active, notes)
values
  ('meta',   'raw', 'regex', '^(per|aw)[_-]', '__USE_PARSED_BASE__', '__USE_PARSED_SUBGROUP__', 25, true, 'seed: meta per_/aw_ => parsed base/subgroup'),
  ('google', 'raw', 'regex', '^(per|aw)[_-]', '__USE_PARSED_BASE__', '__USE_PARSED_SUBGROUP__', 25, true, 'seed: google per_/aw_ => parsed base/subgroup')
on conflict (platform, apply_to, match_type, pattern) do update
set canonical_campaign = excluded.canonical_campaign,
    canonical_subgroup = excluded.canonical_subgroup,
    priority = excluded.priority,
    is_active = excluded.is_active,
    notes = excluded.notes;

