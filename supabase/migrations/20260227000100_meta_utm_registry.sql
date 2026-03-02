create table if not exists public.meta_utm_registry (
  date_seen date not null,
  account_id text not null,
  campaign_id text null,
  adset_id text null,
  ad_id text not null,
  campaign_name text null,
  adset_name text null,
  ad_name text null,
  utm_source text null,
  utm_medium text null,
  utm_campaign text null,
  utm_content text null,
  utm_term text null,
  url_params_raw text null,
  status text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  inserted_at timestamptz not null default now(),
  constraint meta_utm_registry_unique unique (account_id, ad_id, date_seen)
);

create index if not exists meta_utm_registry_date_seen_idx
  on public.meta_utm_registry (date_seen);

create index if not exists meta_utm_registry_campaign_id_idx
  on public.meta_utm_registry (campaign_id);

create table if not exists public.utm_anomalies (
  date_seen date not null,
  account_id text not null,
  platform text not null default 'meta',
  campaign_id text null,
  status text not null,
  count bigint not null,
  generated_at timestamptz not null default now(),
  constraint utm_anomalies_unique unique (date_seen, account_id, platform, campaign_id, status)
);

create index if not exists utm_anomalies_date_seen_idx
  on public.utm_anomalies (date_seen);

