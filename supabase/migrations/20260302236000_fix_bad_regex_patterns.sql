-- Fix invalid regex patterns that can break resolver (~*).

-- Replace problematic pmax word-boundary/charclass regex with a safe variant.
update public.canonical_dictionary
set pattern = '(?i)^pmax($|_|-|\\s)'
where platform = 'google'
  and match_type = 'regex'
  and pattern like '%pmax%';

