-- Fix: RPC function performs writes, must be VOLATILE (not STABLE).
drop function if exists public.compute_utm_governance_weekly(date, date);

create function public.compute_utm_governance_weekly(
  since_date date,
  until_date date
)
returns bigint
language plpgsql
volatile
as $$
declare
  upserted bigint := 0;
begin
  with filtered as (
    select
      date_trunc('week', (mur.date_seen::timestamp))::date as week_start,
      'meta'::text as platform,
      coalesce(mur.campaign_id, 'unknown') as campaign_id,
      max(mur.campaign_name) as campaign_name,
      count(distinct mur.ad_id)::int as total_ads,
      count(distinct case when mur.status = 'ok' then mur.ad_id end)::int as ok_count,
      count(distinct case when mur.status = 'missing' then mur.ad_id end)::int as missing_count,
      count(distinct case when mur.status = 'malformed' then mur.ad_id end)::int as malformed_count,
      count(distinct case when mur.status = 'inconsistent' then mur.ad_id end)::int as inconsistent_count
    from public.meta_utm_registry mur
    where mur.date_seen >= since_date
      and mur.date_seen < until_date
      and (
        mur.status = 'missing'
        or (
          nullif(btrim(mur.utm_campaign), '') is not null
          and nullif(btrim(mur.utm_campaign), '') ~* '^(per_|aw[_-])'
        )
      )
    group by 1, 2, 3
  ),
  up as (
    insert into public.utm_governance_weekly (
      week_start,
      platform,
      campaign_id,
      campaign_name,
      total_ads,
      ok_count,
      missing_count,
      malformed_count,
      inconsistent_count,
      ok_rate,
      missing_rate,
      inserted_at
    )
    select
      f.week_start,
      f.platform,
      f.campaign_id,
      f.campaign_name,
      f.total_ads,
      f.ok_count,
      f.missing_count,
      f.malformed_count,
      f.inconsistent_count,
      case when f.total_ads > 0 then (f.ok_count::numeric / f.total_ads) else null end as ok_rate,
      case when f.total_ads > 0 then (f.missing_count::numeric / f.total_ads) else null end as missing_rate,
      now() as inserted_at
    from filtered f
    on conflict (week_start, platform, campaign_id)
    do update set
      campaign_name = excluded.campaign_name,
      total_ads = excluded.total_ads,
      ok_count = excluded.ok_count,
      missing_count = excluded.missing_count,
      malformed_count = excluded.malformed_count,
      inconsistent_count = excluded.inconsistent_count,
      ok_rate = excluded.ok_rate,
      missing_rate = excluded.missing_rate,
      inserted_at = now()
    returning 1
  )
  select count(*)::bigint into upserted from up;

  return upserted;
end;
$$;

