-- Support spend attribution by subgroup (Meta adset-level) + multi-currency storage.

-- 1) Add adset fields (adset_id='' means campaign-level aggregate row).
alter table public.ad_spend_daily
  add column if not exists adset_id text not null default '',
  add column if not exists adset_name text null;

-- 2) Currency fields (native spend stays in `spend`).
alter table public.ad_spend_daily
  add column if not exists currency text null,
  add column if not exists spend_usd numeric null,
  add column if not exists spend_mxn numeric null,
  add column if not exists fx_usd_mxn numeric null;

-- Backfill existing rows to have adset_id=''
update public.ad_spend_daily
set adset_id = ''
where adset_id is null;

-- Replace unique index to allow multiple adsets per campaign/day/customer.
drop index if exists public.ad_spend_daily_platform_date_customer_campaign_uidx;
drop index if exists ad_spend_daily_platform_date_customer_campaign_uidx;

create unique index if not exists ad_spend_daily_platform_date_customer_campaign_adset_uidx
  on public.ad_spend_daily (platform, date, customer_id, campaign_id, adset_id);

