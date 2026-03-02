-- FX rates for converting USD<->MXN (optional; used to populate spend_usd/spend_mxn).

create table if not exists public.fx_rates_daily (
  day date not null,
  base text not null,
  quote text not null,
  rate numeric not null,
  provider text null,
  inserted_at timestamptz not null default now(),
  constraint fx_rates_daily_uidx unique (day, base, quote)
);

create index if not exists fx_rates_daily_day_idx
  on public.fx_rates_daily (day);

