alter table public.ad_spend_daily
  add column if not exists platform text,
  add column if not exists account_id text,
  add column if not exists date date,
  add column if not exists campaign_id text,
  add column if not exists campaign_name text,
  add column if not exists spend numeric,
  add column if not exists impressions bigint,
  add column if not exists clicks bigint,
  add column if not exists ctr numeric,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

create unique index if not exists ad_spend_daily_platform_date_campaign_id_uidx
  on public.ad_spend_daily (platform, date, campaign_id);

