/*
Seed UTM alias rules -> canonical_campaign

How to add a new rule:
- Pick a priority bucket:
  - 10–19: very specific "lead" patterns
  - 20–39: very specific cases (consentform, hero, etc.)
  - 40–79: general buckets (pmax/search/demand-gen/lanes/retarget)
  - 80–99: broad legacy buckets (meta_abo_legacy)
- Prefer match_type='regex' with (?i) for case-insensitive matching.
- Keep rules deterministic: lower priority number wins.

Idempotency:
- Enforced via a partial unique index on (match_type, pattern) where is_active=true.
- Inserts use ON CONFLICT to update existing active rules.
*/

-- Ensure match_type check exists (no-op if already there).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'utm_alias_rules_match_type_check'
  ) then
    alter table public.utm_alias_rules
      add constraint utm_alias_rules_match_type_check
      check (match_type in ('equals','contains','regex'));
  end if;
end $$;

-- De-dup active rules so we can create a unique partial index safely.
delete from public.utm_alias_rules a
using public.utm_alias_rules b
where a.is_active is true
  and b.is_active is true
  and a.match_type = b.match_type
  and a.pattern = b.pattern
  and a.id > b.id;

create unique index if not exists utm_alias_rules_active_match_uidx
  on public.utm_alias_rules (match_type, pattern)
  where is_active is true;

with rules(match_type, pattern, canonical_campaign, priority, notes) as (
  values
    -- 10–19: lead-specific Search patterns (most specific)
    ('regex', '(?i)search[-_ ]insurance.*lead|search.*insurance.*lead', 'search_insurance_lead_mx_2026-02', 10, 'Search insurance lead (specific)'),
    ('regex', '(?i)search[-_ ]brand.*lead|search.*brand.*lead', 'search_brand_lead_mx_2026-02', 11, 'Search brand lead (specific)'),

    -- 20–39: very specific cases
    ('regex', '(?i)consent', 'pmax_consentform', 20, 'PMAX consentform (consent takes precedence)'),
    ('regex', '(?i)aw_.*brand.*hero', 'AW_Brand-hero_02-26', 30, 'Brand hero awareness'),
    ('contains', 'Always_on_brand_performance', 'Always_on_brand_performance', 35, 'Keep exact canonical for Always_on_brand_performance'),

    -- 40–79: general buckets
    ('regex', '(?i)pmax', 'pmax', 40, 'PMAX bucket (any variant)'),
    ('regex', '(?i)search.*brand', 'search_brand', 50, 'Search brand bucket'),
    ('regex', '(?i)search.*(seguro|insurance|generic)', 'search_insurance', 55, 'Search insurance/generic bucket'),
    ('regex', '(?i)(retarget|prelead)', 'retarget-prelead_lead_2026-02', 60, 'Retarget / prelead'),
    ('regex', '(?i)fast[-_ ]lane', 'fast-lane_lead_2026-02', 61, 'Fast lane'),
    ('regex', '(?i)slow[-_ ]lane', 'slow-lane_lead_2026-02', 62, 'Slow lane'),
    ('regex', '(?i)demand.*gen', 'demand-gen_lead_2026-02', 65, 'Demand gen'),
    ('regex', '(?i)brand_traffic', 'brand_traffic_2026-02', 70, 'Brand traffic'),
    ('regex', '(?i)advantage_lead_2026-02', 'advantage_lead_2026-02', 75, 'Meta Advantage'),

    -- 80–99: broad legacy ABO bucket (avoid matching per_/aw_ via negative lookahead)
    ('regex', '(?i)^(?!per_|aw_).*(cdmx|gdl|mty|lal|website[_ ]visitors|broad|regiones|tofu|\\bls\\b|\\d{2}-\\d{2}).*', 'meta_abo_legacy', 90, 'Legacy ABO naming bucket')
)
insert into public.utm_alias_rules (match_type, pattern, canonical_campaign, priority, is_active, notes)
select match_type, pattern, canonical_campaign, priority, true, notes
from rules
on conflict (match_type, pattern) where is_active is true
do update set
  canonical_campaign = excluded.canonical_campaign,
  priority = excluded.priority,
  is_active = true,
  notes = excluded.notes;

