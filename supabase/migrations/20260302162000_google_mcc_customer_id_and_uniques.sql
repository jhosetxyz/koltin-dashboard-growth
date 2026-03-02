-- Google MCC support: add customer_id to ad_spend_daily and scope uniques for multi-account.

-- 1) ad_spend_daily: add customer_id, backfill, and replace unique index to include customer_id.
alter table public.ad_spend_daily
  add column if not exists customer_id text;

update public.ad_spend_daily
set customer_id = coalesce(customer_id, account_id)
where customer_id is null;

alter table public.ad_spend_daily
  alter column customer_id set not null;

-- Drop old unique constraint / index (single-account).
alter table public.ad_spend_daily
  drop constraint if exists ad_spend_daily_unique;

drop index if exists public.ad_spend_daily_platform_date_campaign_id_uidx;
drop index if exists ad_spend_daily_platform_date_campaign_id_uidx;

-- Create the new unique index.
create unique index if not exists ad_spend_daily_platform_date_customer_campaign_uidx
  on public.ad_spend_daily (platform, date, customer_id, campaign_id);

create index if not exists ad_spend_daily_customer_id_idx
  on public.ad_spend_daily (customer_id);

-- 2) campaign_mapping: scope Google mappings by customer_id to avoid collisions.
alter table public.campaign_mapping
  add column if not exists customer_id text;

-- Replace unique index with partial unique indexes:
-- - Meta stays unique by (platform, campaign_id)
-- - Google becomes unique by (platform, customer_id, campaign_id)
drop index if exists public.campaign_mapping_platform_campaign_id_uidx;

create unique index if not exists campaign_mapping_meta_uidx
  on public.campaign_mapping (platform, campaign_id)
  where platform = 'meta';

create unique index if not exists campaign_mapping_google_uidx
  on public.campaign_mapping (platform, customer_id, campaign_id)
  where platform = 'google';

