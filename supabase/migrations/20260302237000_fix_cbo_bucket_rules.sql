-- Tighten Meta CBO bucket: only map specific legacy UTMs observed for the week.

update public.canonical_dictionary
set is_active = false,
    notes = coalesce(notes, '') || ' (disabled: too broad for CBO bucket)'
where platform = 'meta'
  and canonical_campaign = 'per_conversion_cbo_02_26'
  and not (
    match_type = 'equals'
    and pattern in ('MX_clientes_LAL3','MX_Website_Visitors_No_Cotizaron','regiones_seguros_finanzas_60-84')
  );

