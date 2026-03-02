import "dotenv/config";
import { fetchGoogleCampaignInsightsDaily } from "../connectors/googleAds";
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

function parseArgValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function toJsonSafe(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

type SpendRow = {
  platform: "google";
  account_id: string;
  day: string;
  date: string;
  campaign_id: string;
  campaign_name: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  raw_json?: unknown;
};

function aggregateByCampaignDate(rows: SpendRow[]): SpendRow[] {
  const map = new Map<string, SpendRow>();

  for (const r of rows) {
    const key = `${r.platform}|${r.date}|${r.campaign_id}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...r });
      continue;
    }

    existing.spend += r.spend;
    existing.impressions += r.impressions;
    existing.clicks += r.clicks;
    if (!existing.campaign_name && r.campaign_name) existing.campaign_name = r.campaign_name;
  }

  for (const v of map.values()) {
    v.ctr = v.impressions > 0 ? v.clicks / v.impressions : 0;
  }

  return Array.from(map.values());
}

async function syncGoogleSpendDaily() {
  const supabase = getSupabaseClient();

  const customerId =
    parseArgValue("customerId") ?? process.env.GOOGLE_ADS_CUSTOMER_ID;
  if (!customerId) {
    throw new Error(
      "Missing env var: GOOGLE_ADS_CUSTOMER_ID (client account id). You can also pass --customerId=XXXX",
    );
  }
  const loginCustomerId =
    parseArgValue("loginCustomerId") ??
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ??
    undefined;

  const dateArg = parseArgValue("date");
  const defaultDate = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - 1);
    return formatDateUtc(d);
  })();
  const date = dateArg ?? defaultDate;

  const insights = await fetchGoogleCampaignInsightsDaily({
    date,
    customerId,
    ...(loginCustomerId ? { loginCustomerId } : {}),
  });

  const rowsRaw: SpendRow[] = insights.map((r) => {
    const impressions = Number(r.impressions) || 0;
    const clicks = Number(r.clicks) || 0;
    const spend = (Number(r.cost_micros) || 0) / 1_000_000;

    return {
      platform: "google",
      account_id: customerId,
      day: r.date,
      date: r.date,
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      spend,
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
      raw_json: toJsonSafe(r.raw ?? r),
    };
  });

  const rows = aggregateByCampaignDate(rowsRaw);

  const dates = rows
    .map((r) => r.date)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const firstDate = dates[0] ?? null;
  const lastDate = dates.at(-1) ?? null;

  const spendSum = rows.reduce((acc, r) => acc + (Number(r.spend) || 0), 0);

  let upserted = 0;
  if (rows.length > 0) {
    const { error, data } = await supabase
      .from("ad_spend_daily")
      .upsert(rows, { onConflict: "platform,date,campaign_id" })
      .select("platform,date,campaign_id");

    if (error) throw error;
    upserted = data?.length ?? 0;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "syncGoogleSpendDaily",
        date,
        customerId,
        loginCustomerId: loginCustomerId ?? null,
        fetchedRows: rowsRaw.length,
        rowsAfterAggregation: rows.length,
        upsertedRows: upserted,
        spendSum: Math.round(spendSum * 100) / 100,
        firstDate,
        lastDate,
      },
      null,
      2,
    ),
  );
}

syncGoogleSpendDaily().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

