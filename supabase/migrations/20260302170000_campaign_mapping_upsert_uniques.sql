-- Make campaign_mapping upsert-friendly for PostgREST (no partial unique indexes).

-- Drop partial unique indexes introduced for MCC.
drop index if exists public.campaign_mapping_meta_uidx;
drop index if exists public.campaign_mapping_google_uidx;

-- Keep legacy uniqueness (platform + campaign_id) for backward compatibility.
create unique index if not exists campaign_mapping_platform_campaign_id_uidx
  on public.campaign_mapping (platform, campaign_id);

-- Add uniqueness by customer for Google MCC mode.
create unique index if not exists campaign_mapping_platform_customer_campaign_id_uidx
  on public.campaign_mapping (platform, customer_id, campaign_id);

