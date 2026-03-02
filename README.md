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
  - `GOOGLE_ADS_CUSTOMER_ID` (sin guiones)
  - `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (opcional, MCC; sin guiones)

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
```

- **Seed campaign mapping (Google)**

Esto crea/actualiza filas en `public.campaign_mapping` con `utm_campaign = NULL` y `notes = campaign_name`.
Luego puedes poblar `utm_campaign` manualmente para atribuir spend a `canonical_campaign`.

```bash
pnpm run seed:google_campaign_mapping
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
- **Customer not under manager**: si usas MCC, asegúrate de setear `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC) y `GOOGLE_ADS_CUSTOMER_ID` (cuenta).
- **customer_id con guiones**: Google Ads IDs siempre **sin guiones**.
- **Permisos/OAuth**: si el refresh token no tiene scope correcto o está revocado, el API va a fallar; imprime el error completo (request_id / error_code).

