## Koltin dashboard growth

Backend TypeScript para sincronizar fuentes (HubSpot/Meta/Google Ads) a Supabase y calcular métricas semanales por `canonical_campaign`.

### Requisitos

- **Node**: recomendado `>= 18`
- **pnpm**: `pnpm@10` (ver `packageManager` en `package.json`)
- **Supabase CLI** (para aplicar migrations): `supabase`

### Variables de entorno (.env)

- **Supabase**
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`

- **Meta**
  - `META_ACCESS_TOKEN`
  - `META_AD_ACCOUNT_ID`

- **HubSpot**
  - `HUBSPOT_PRIVATE_APP_TOKEN`

- **Google Ads (OAuth2)**
  - `GOOGLE_ADS_DEVELOPER_TOKEN`
  - `GOOGLE_ADS_CLIENT_ID`
  - `GOOGLE_ADS_CLIENT_SECRET`
  - `GOOGLE_ADS_REFRESH_TOKEN`
  - `GOOGLE_ADS_CUSTOMER_ID` (sin guiones). Puede ser **cliente** o **MCC** (si es MCC, el job entra a modo fan-out)
  - `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (opcional, MCC; sin guiones)
  - `GOOGLE_ADS_CUSTOMER_IDS` (opcional; comma-separated; lista de **clientes** para forzar targets bajo MCC)

### Comandos

- **Dev server (healthcheck)**

```bash
pnpm run dev
```

- **Sync HubSpot (contacts)**

```bash
pnpm run sync:hubspot
```

- **Backfill HubSpot por ventanas**

```bash
pnpm run backfill:hubspot -- --since=2026-01-01 --until=2026-02-01 --windowDays=3 --mode=lastmodifieddate
```

- **Sync Meta spend diario**

```bash
pnpm run sync:meta
```

- **Sync Meta UTMs diario (gobernanza)**

```bash
pnpm run sync:meta_utms
```

- **Sync Google Ads spend diario (por defecto: ayer UTC)**

```bash
pnpm run sync:google_spend
pnpm run sync:google_spend -- --date=2026-02-18
pnpm run sync:google_spend -- --date=2026-02-18 --customer_id=6978671646 --login_customer_id=6978671646 --mcc=true
```

- **Seed campaign mapping (Google)**

Esto crea/actualiza filas en `public.campaign_mapping` con `utm_campaign = NULL` y `notes = campaign_name`.
Luego puedes poblar `utm_campaign` manualmente para atribuir spend a `canonical_campaign`.

```bash
pnpm run seed:google_campaign_mapping
pnpm run seed:google_campaign_mapping -- --customer_id=6978671646 --login_customer_id=6978671646 --mcc=true
```

- **Aggregate weekly (quality + spend)**

```bash
pnpm run aggregate:weekly
```

### Migraciones (Supabase)

Aplicar migrations al proyecto Supabase:

```bash
supabase db push --yes
```

### Troubleshooting rápido (Google Ads)

- **403 / developer token inválido**: revisa `GOOGLE_ADS_DEVELOPER_TOKEN` y si el token está aprobado para producción.
- **REQUESTED_METRICS_FOR_MANAGER**: estás intentando pedir métricas contra un MCC. Usa `--mcc=true` o setea `GOOGLE_ADS_CUSTOMER_ID` al cliente (o usa `GOOGLE_ADS_CUSTOMER_IDS`).
- **Customer not under manager**: si usas MCC, asegúrate de setear `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC) y targets cliente correctos.
- **customer_id con guiones**: Google Ads IDs siempre **sin guiones**.
- **Permisos/OAuth**: si el refresh token no tiene scope correcto o está revocado, el API va a fallar; imprime el error completo (request_id / error_code).

### Queries útiles (Google)

- **Spend por customer_id (Google)**:

```sql
select day, customer_id, count(*), sum(spend)
from public.ad_spend_daily
where platform='google'
group by 1,2
order by 1 desc
limit 20;
```

### Queries de validación (weekly v2)

- **a) Top spend Google (semana pasada) por canonical_campaign/subgroup**:

```sql
select week_start, canonical_campaign, canonical_subgroup, sum(spend) as spend
from public.weekly_quality_by_campaign
where platform='google'
  and week_start >= (current_date - interval '14 days')::date
group by 1,2,3
order by week_start desc, spend desc
limit 50;
```

- **b) Top spend Meta (semana pasada) por canonical_campaign/subgroup**:

```sql
select week_start, canonical_campaign, canonical_subgroup, sum(spend) as spend
from public.weekly_quality_by_campaign
where platform='meta'
  and week_start >= (current_date - interval '14 days')::date
group by 1,2,3
order by week_start desc, spend desc
limit 50;
```

- **c) % spend unmapped por platform (semana pasada)**:

```sql
with w as (
  select *
  from public.weekly_quality_by_campaign
  where week_start >= (current_date - interval '14 days')::date
)
select
  platform,
  sum(spend) filter (where canonical_campaign = 'unmapped') as unmapped_spend,
  sum(spend) as total_spend,
  case when sum(spend) > 0 then (sum(spend) filter (where canonical_campaign = 'unmapped') / sum(spend)) else 0 end as unmapped_rate
from w
group by 1
order by 1;
```

- **d) Top 20 utm_campaign unmapped por leads (separado por source)**:

```sql
with leads as (
  select
    date_trunc('week', (c.created_at at time zone 'utc'))::date as week_start,
    case when lower(coalesce(c.utm_source,'')) like '%google%' then 'google' else 'meta' end as source,
    nullif(btrim(coalesce(c.utm_campaign,'')), '') as utm_campaign
  from public.hubspot_contacts c
  where c.created_at >= (current_date - interval '21 days')::date::timestamptz
),
resolved as (
  select
    l.source,
    l.utm_campaign,
    (public.resolve_canonical_campaign_v2(
      l.source,
      l.utm_campaign,
      (public.parse_utm_campaign(l.utm_campaign)).base_campaign,
      (public.parse_utm_campaign(l.utm_campaign)).subgroup
    )).canonical_campaign as canonical_campaign
  from leads l
  where l.utm_campaign is not null
)
select source, utm_campaign, count(*) as leads
from resolved
where canonical_campaign = 'unmapped'
group by 1,2
order by leads desc
limit 20;
```

- **e) Consistencia leads vs spend por canonical_campaign (mismo week_start/platform)**:

```sql
select
  week_start,
  platform,
  canonical_campaign,
  sum(spend) as spend,
  sum(leads_created) as leads
from public.weekly_quality_by_campaign
where week_start >= (current_date - interval '21 days')::date
group by 1,2,3
order by week_start desc, platform, spend desc;
```


