-- Fix utm_alias_rules platform dimension:
-- Move Google-only legacy rules (search/pmax/consent) from default 'meta' to 'google'.

update public.utm_alias_rules
set platform = 'google'
where platform = 'meta'
  and (
    canonical_campaign ilike 'search_%'
    or canonical_campaign ilike 'pmax%'
    or pattern ilike '%search%'
    or pattern ilike '%pmax%'
    or pattern ilike '%consent%'
  );

