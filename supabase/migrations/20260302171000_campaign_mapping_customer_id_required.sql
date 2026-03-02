-- campaign_mapping: require customer_id and scope uniqueness by customer_id.

alter table public.campaign_mapping
  add column if not exists customer_id text;

update public.campaign_mapping
set customer_id = coalesce(customer_id, 'unknown')
where customer_id is null;

alter table public.campaign_mapping
  alter column customer_id set not null;

drop index if exists public.campaign_mapping_platform_campaign_id_uidx;
drop index if exists public.campaign_mapping_platform_customer_campaign_id_uidx;

create unique index if not exists campaign_mapping_platform_customer_campaign_id_uidx
  on public.campaign_mapping (platform, customer_id, campaign_id);

