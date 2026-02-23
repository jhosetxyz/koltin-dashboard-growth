create table if not exists public.ad_spend_daily (
  platform text not null,
  account_id text not null,
  date date not null,
  campaign_id text not null,
  campaign_name text null,
  spend numeric null,
  impressions bigint null,
  clicks bigint null,
  ctr numeric null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_spend_daily_unique unique (platform, date, campaign_id)
);

create index if not exists ad_spend_daily_account_id_idx
  on public.ad_spend_daily (account_id);

