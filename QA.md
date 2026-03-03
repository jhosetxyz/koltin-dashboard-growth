## QA pack (weekly frozen + decision engine)

Objetivo: validar que `public.weekly_quality_by_campaign_frozen` (WOW snapshot) y `public.weekly_campaign_decisions` coinciden con tu sheet manual para un `week_start` (lunes UTC).

Notas:
- `week_start` debe ser **lunes (UTC)**.
- En decisiones, `call_rate` y `quality_index` están en **porcentaje 0..100** (derivados de `weekly_quality_by_campaign_frozen.call_rate` y `.quality_ratio`).
- `int_plus` = `call_done_count` (HubSpot `lead_status = 'conectado llamada'` y equivalentes de llamada positiva).

---

### 0) Setear el week_start (elige uno)

En Supabase SQL Editor, reemplaza `DATE '2026-02-15'` por el lunes que quieras auditar.

---

### 1) Top 20 por spend (META)

```sql
select
  canonical_campaign,
  canonical_subgroup,
  spend,
  leads,
  call_rate,
  int_plus,
  mql,
  quality_index,
  decision,
  decision_confidence as confidence,
  decision_reason as reason
from public.weekly_campaign_decisions
where week_start = date '2026-02-15'
  and platform = 'meta'
order by spend desc nulls last
limit 20;
```

**Qué esperar**: las mismas top campañas/subgrupos que en el sheet, con spend y leads consistentes.

---

### 2) Top 20 por spend (GOOGLE)

```sql
select
  canonical_campaign,
  canonical_subgroup,
  spend,
  leads,
  call_rate,
  int_plus,
  mql,
  quality_index,
  decision,
  decision_confidence as confidence,
  decision_reason as reason
from public.weekly_campaign_decisions
where week_start = date '2026-02-15'
  and platform = 'google'
order by spend desc nulls last
limit 20;
```

---

### 3) Todas las SCALE (ordenado por spend desc)

```sql
select
  platform,
  canonical_campaign,
  canonical_subgroup,
  spend,
  leads,
  call_rate,
  int_plus,
  mql,
  quality_index,
  delta_quality_index,
  delta_call_rate,
  delta_spend_pct,
  decision_confidence as confidence,
  decision_reason as reason
from public.weekly_campaign_decisions
where week_start = date '2026-02-15'
  and decision = 'scale'
order by spend desc nulls last;
```

---

### 4) Todas las CUT (ordenado por spend desc)

```sql
select
  platform,
  canonical_campaign,
  canonical_subgroup,
  spend,
  leads,
  call_rate,
  int_plus,
  mql,
  quality_index,
  delta_quality_index,
  decision_confidence as confidence,
  decision_reason as reason
from public.weekly_campaign_decisions
where week_start = date '2026-02-15'
  and decision = 'cut'
order by spend desc nulls last;
```

---

### 5) Resumen por decision (count campaigns, sum spend, sum leads)

```sql
select
  decision,
  count(*) as campaigns,
  sum(coalesce(spend, 0)) as spend,
  sum(coalesce(leads, 0)) as leads
from public.weekly_campaign_decisions
where week_start = date '2026-02-15'
group by 1
order by spend desc;
```

---

### 6) Comparativo WoW vs semana anterior (spot-check)

```sql
select
  platform,
  canonical_campaign,
  canonical_subgroup,
  spend,
  prev_spend,
  delta_spend_pct,
  quality_index,
  prev_quality_index,
  delta_quality_index,
  call_rate,
  delta_call_rate,
  decision,
  decision_reason
from public.weekly_campaign_decisions
where week_start = date '2026-02-15'
order by platform, spend desc nulls last
limit 50;
```

**Qué esperar**: deltas coherentes con el cambio entre semanas del sheet.

---

### 7) Cross-check: decisiones vs snapshot frozen (métricas base deben empatar)

Este query compara métricas de `weekly_campaign_decisions` contra `weekly_quality_by_campaign_frozen` (transformando a % donde aplica).

```sql
with frozen as (
  select
    week_start,
    platform,
    canonical_campaign,
    canonical_subgroup,
    coalesce(spend, 0)::numeric as spend,
    coalesce(leads_created, 0)::numeric as leads,
    coalesce(mql_count, 0)::numeric as mql,
    coalesce(call_done_count, 0)::numeric as int_plus,
    (coalesce(call_rate, 0)::numeric * 100) as call_rate_pct,
    (coalesce(quality_ratio, 0)::numeric * 100) as quality_index_pct
  from public.weekly_quality_by_campaign_frozen
  where week_start = date '2026-02-15'
),
dec as (
  select
    week_start,
    platform,
    canonical_campaign,
    canonical_subgroup,
    coalesce(spend, 0)::numeric as spend,
    coalesce(leads, 0)::numeric as leads,
    coalesce(mql, 0)::numeric as mql,
    coalesce(int_plus, 0)::numeric as int_plus,
    coalesce(call_rate, 0)::numeric as call_rate_pct,
    coalesce(quality_index, 0)::numeric as quality_index_pct
  from public.weekly_campaign_decisions
  where week_start = date '2026-02-15'
)
select
  coalesce(f.platform, d.platform) as platform,
  coalesce(f.canonical_campaign, d.canonical_campaign) as canonical_campaign,
  coalesce(f.canonical_subgroup, d.canonical_subgroup) as canonical_subgroup,
  f.spend as frozen_spend,
  d.spend as decision_spend,
  (d.spend - f.spend) as diff_spend,
  f.leads as frozen_leads,
  d.leads as decision_leads,
  (d.leads - f.leads) as diff_leads,
  f.call_rate_pct as frozen_call_rate_pct,
  d.call_rate_pct as decision_call_rate_pct,
  (d.call_rate_pct - f.call_rate_pct) as diff_call_rate_pct,
  f.quality_index_pct as frozen_quality_index_pct,
  d.quality_index_pct as decision_quality_index_pct,
  (d.quality_index_pct - f.quality_index_pct) as diff_quality_index_pct
from frozen f
full outer join dec d
  on d.platform = f.platform
 and d.canonical_campaign = f.canonical_campaign
 and d.canonical_subgroup = f.canonical_subgroup
where
  abs(coalesce(d.spend, 0) - coalesce(f.spend, 0)) > 0.01
  or abs(coalesce(d.leads, 0) - coalesce(f.leads, 0)) > 0
  or abs(coalesce(d.call_rate_pct, 0) - coalesce(f.call_rate_pct, 0)) > 0.01
  or abs(coalesce(d.quality_index_pct, 0) - coalesce(f.quality_index_pct, 0)) > 0.01
order by platform, canonical_campaign, canonical_subgroup
limit 200;
```

**Qué esperar**: idealmente 0 filas (o diferencias muy pequeñas por redondeo).

---

### 8) Query de anomalías

```sql
select
  platform,
  canonical_campaign,
  canonical_subgroup,
  spend,
  leads,
  call_rate,
  quality_index,
  delta_quality_index,
  decision,
  decision_reason
from public.weekly_campaign_decisions
where week_start = date '2026-02-15'
  and (
    (coalesce(spend, 0) > 0 and coalesce(leads, 0) = 0)
    or (coalesce(leads, 0) > 0 and coalesce(spend, 0) = 0)
    or (coalesce(leads, 0) < 10 and abs(coalesce(delta_quality_index, 0)) >= 15)
  )
order by spend desc nulls last, leads desc;
```

**Qué esperar**:
- `spend > 0` y `leads = 0`: revisar tracking/atribución o lead_source.
- `leads > 0` y `spend = 0`: puede ser normal si no hay spend trackeado, pero conviene auditar.
- `delta_quality_index` muy alto con `leads` bajos: ruido estadístico o cambio fuerte de status.

