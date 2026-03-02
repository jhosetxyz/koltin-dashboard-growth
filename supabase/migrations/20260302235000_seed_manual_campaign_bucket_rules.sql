-- Seed rules to match operational manual mapping (legacy UTMs -> current PER_* campaign buckets).
-- These are platform-specific and take precedence over generic legacy buckets.

insert into public.canonical_dictionary
  (platform, apply_to, match_type, pattern, canonical_campaign, canonical_subgroup, priority, is_active, notes)
values
  -- META: CBO campaign bucket (02-26)
  ('meta','raw','equals','MX_clientes_LAL3','per_conversion_cbo_02_26','',15,true,'seed: meta map legacy UTMs to PER_Conversion-cbo_02-26'),
  ('meta','raw','equals','MX_Website_Visitors_No_Cotizaron','per_conversion_cbo_02_26','',15,true,'seed: meta map legacy UTMs to PER_Conversion-cbo_02-26'),
  ('meta','raw','equals','MX_Website_Visitors_LAL','per_conversion_cbo_02_26','',15,true,'seed: meta map legacy UTMs to PER_Conversion-cbo_02-26'),
  ('meta','raw','equals','MX_Website_Visitors_LAL_clientes','per_conversion_cbo_02_26','',15,true,'seed: meta map legacy UTMs to PER_Conversion-cbo_02-26'),
  ('meta','raw','equals','MX_Website_Visitors_No_Cotizaron_nuevo_ingreso','per_conversion_cbo_02_26','',15,true,'seed: meta map legacy UTMs to PER_Conversion-cbo_02-26'),
  ('meta','raw','equals','regiones_seguros_finanzas_60-84','per_conversion_cbo_02_26','',15,true,'seed: meta map legacy UTMs to PER_Conversion-cbo_02-26'),
  ('meta','raw','equals','Regiones_LAL_WebsiteVisitors Seguros Finanzas Estilo_de_vida_60-84','per_conversion_cbo_02_26','',15,true,'seed: meta map legacy UTMs to PER_Conversion-cbo_02-26'),
  ('meta','raw','equals','Regiones_LAL_WebsiteVisitors Seguros Finanzas Estilo_de_vida_60-84_nuevo_ingreso','per_conversion_cbo_02_26','',15,true,'seed: meta map legacy UTMs to PER_Conversion-cbo_02-26'),
  ('meta','raw','equals','regiones_seguros_finanzas_60-84_nuevo_ingreso','per_conversion_cbo_02_26','',15,true,'seed: meta map legacy UTMs to PER_Conversion-cbo_02-26'),

  -- META: ABO campaign bucket (02-26) — legacy ABO terms should roll up here.
  ('meta','raw','regex','(^|[^a-z0-9])(CDMX60-84|GDL60-84|MTY60-84)([^a-z0-9]|$)','per_conversion_abo_02_26','',16,true,'seed: meta map ABO legacy terms to PER_Conversion-abo_02-26'),

  -- GOOGLE: map legacy search/pmax names to current PER_* campaign buckets (02-26).
  ('google','raw','equals','search','per_search_insurance_02_26','',15,true,'seed: google legacy search -> PER_Search-insurance_02-26'),
  ('google','raw','contains','Search - Generic','per_search_insurance_02_26','',15,true,'seed: google search generic -> PER_Search-insurance_02-26'),
  ('google','raw','equals','search-gen','per_search_insurance_02_26','',15,true,'seed: google search-gen -> PER_Search-insurance_02-26'),
  ('google','raw','contains','Search | Seguros','per_search_insurance_02_26','',15,true,'seed: google Search | Seguros -> PER_Search-insurance_02-26'),
  ('google','raw','equals','search_brand','per_search_brand_02_26','',15,true,'seed: google legacy brand -> PER_Search-brand_02-26'),
  ('google','raw','contains','Search | Brand | Koltin','per_search_brand_02_26','',15,true,'seed: google Search | Brand | Koltin -> PER_Search-brand_02-26'),
  ('google','raw','regex','(?i)^pmax(\\b|[_\\- ])','per_pmax_02_26','',15,true,'seed: google legacy pmax -> PER_Pmax_02-26'),
  ('google','raw','contains','PMAX | Koltin','per_pmax_02_26','',15,true,'seed: google legacy PMAX | Koltin -> PER_Pmax_02-26'),
  ('google','raw','equals','pmax_consentform','pmax_consentform','',14,true,'seed: google consentform bucket')
on conflict (platform, apply_to, match_type, pattern) do update
set canonical_campaign = excluded.canonical_campaign,
    canonical_subgroup = excluded.canonical_subgroup,
    priority = excluded.priority,
    is_active = excluded.is_active,
    notes = excluded.notes;

