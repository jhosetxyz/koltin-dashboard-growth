import "dotenv/config";
import { fetchMetaAdsetInsightsDaily } from "../connectors/meta";
import { getSupabaseClient } from "../lib/supabase";

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

type SpendRow = {
  platform: "meta";
  account_id: string;
  customer_id: string;
  adset_id: string;
  adset_name: string | null;
  day: string;
  date: string;
  campaign_id: string;
  campaign_name: string;
  spend: number;
  currency: string | null;
  spend_usd: number | null;
  spend_mxn: number | null;
  fx_usd_mxn: number | null;
  impressions: number;
  clicks: number;
  ctr: number;
};

function aggregateByCampaignDate(rows: SpendRow[]): SpendRow[] {
  const map = new Map<string, SpendRow>();

  for (const r of rows) {
    const key = `${r.platform}|${r.date}|${r.customer_id}|${r.campaign_id}|${r.adset_id}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...r });
      continue;
    }

    existing.spend += r.spend;
    existing.impressions += r.impressions;
    existing.clicks += r.clicks;
    if (!existing.campaign_name && r.campaign_name) existing.campaign_name = r.campaign_name;
    if (!existing.adset_name && r.adset_name) existing.adset_name = r.adset_name;
    if (!existing.currency && r.currency) existing.currency = r.currency;
  }

  for (const v of map.values()) {
    v.ctr = v.impressions > 0 ? v.clicks / v.impressions : 0;
  }

  return Array.from(map.values());
}

async function syncMetaSpendDaily() {
  const supabase = getSupabaseClient();
  const accountId = requiredEnv("META_AD_ACCOUNT_ID");

  const untilDate = new Date();
  const sinceDate = new Date(untilDate);
  sinceDate.setUTCDate(sinceDate.getUTCDate() - 30);

  const since = formatDateUtc(sinceDate);
  const until = formatDateUtc(untilDate);

  const insights = await fetchMetaAdsetInsightsDaily({ since, until });

  const rowsRaw: SpendRow[] = insights.map((r) => ({
    platform: "meta",
    account_id: accountId,
    customer_id: accountId,
    adset_id: r.adset_id || "",
    adset_name: r.adset_name || null,
    day: r.date_start,
    date: r.date_start,
    campaign_id: r.campaign_id,
    campaign_name: r.campaign_name,
    spend: Number(r.spend) || 0,
    currency: (r.account_currency as string | undefined) ?? "USD",
    spend_usd: (r.account_currency as string | undefined) === "USD" ? Number(r.spend) || 0 : null,
    spend_mxn: (r.account_currency as string | undefined) === "MXN" ? Number(r.spend) || 0 : null,
    fx_usd_mxn: null,
    impressions: Number.parseInt(r.impressions, 10) || 0,
    clicks: Number.parseInt(r.clicks, 10) || 0,
    ctr: Number(r.ctr) || 0,
  }));

  const rows = aggregateByCampaignDate(rowsRaw);

  // Also write a campaign-level rollup row (adset_id='') to keep old reports stable.
  const rollupMap = new Map<string, SpendRow>();
  for (const r of rows) {
    const key = `${r.platform}|${r.date}|${r.customer_id}|${r.campaign_id}|`;
    const existing = rollupMap.get(key);
    if (!existing) {
      rollupMap.set(key, {
        ...r,
        adset_id: "",
        adset_name: null,
      });
      continue;
    }
    existing.spend += r.spend;
    existing.impressions += r.impressions;
    existing.clicks += r.clicks;
  }
  const rollupRows = Array.from(rollupMap.values()).map((v) => ({
    ...v,
    ctr: v.impressions > 0 ? v.clicks / v.impressions : 0,
  }));

  const allRows = [...rows, ...rollupRows];

  const dates = allRows
    .map((r) => r.date)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const firstDate = dates[0] ?? null;
  const lastDate = dates.at(-1) ?? null;

  let upserted = 0;
  if (allRows.length > 0) {
    const { error, data } = await supabase
      .from("ad_spend_daily")
      .upsert(allRows, { onConflict: "platform,date,customer_id,campaign_id,adset_id" })
      .select("platform,date,customer_id,campaign_id,adset_id");

    if (error) throw error;
    upserted = data?.length ?? 0;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "syncMetaSpendDaily",
        fetchedRows: rowsRaw.length,
        rowsAfterAggregation: allRows.length,
        upsertedRows: upserted,
        firstDate,
        lastDate,
      },
      null,
      2,
    ),
  );
}

syncMetaSpendDaily().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

