-- Allow multiple ad platforms (meta + google) in ad_spend_daily.

alter table public.ad_spend_daily
  drop constraint if exists ad_spend_daily_platform_check;

alter table public.ad_spend_daily
  add constraint ad_spend_daily_platform_check
  check (platform in ('meta', 'google'));

