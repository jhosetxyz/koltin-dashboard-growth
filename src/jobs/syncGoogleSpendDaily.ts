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

function parseBool(v: string | undefined): boolean | null {
  if (v == null) return null;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return null;
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
  customer_id: string;
  adset_id: string;
  adset_name: string | null;
  day: string;
  date: string;
  campaign_id: string;
  campaign_name: string | null;
  spend: number;
  currency: string | null;
  spend_usd: number | null;
  spend_mxn: number | null;
  fx_usd_mxn: number | null;
  impressions: number;
  clicks: number;
  ctr: number;
  raw_json?: unknown;
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
  }

  for (const v of map.values()) {
    v.ctr = v.impressions > 0 ? v.clicks / v.impressions : 0;
  }

  return Array.from(map.values());
}

async function syncGoogleSpendDaily() {
  const supabase = getSupabaseClient();

  const customerId =
    parseArgValue("customer_id") ??
    parseArgValue("customerId") ??
    process.env.GOOGLE_ADS_CUSTOMER_ID;
  if (!customerId) {
    throw new Error(
      "Missing env var: GOOGLE_ADS_CUSTOMER_ID. Puedes pasar override con --customer_id=XXXX o --customerId=XXXX",
    );
  }
  const loginCustomerId =
    parseArgValue("login_customer_id") ??
    parseArgValue("loginCustomerId") ??
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ??
    undefined;

  const mccFlag =
    parseBool(parseArgValue("mcc")) ??
    parseBool(process.env.GOOGLE_ADS_MCC_MODE) ??
    null;
  const forceMcc = mccFlag === true;

  const dateArg = parseArgValue("date");
  const sinceArg = parseArgValue("since");
  const untilArg = parseArgValue("until");

  const defaultDate = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - 1);
    return formatDateUtc(d);
  })();

  const datesToFetch: string[] = [];
  if (sinceArg && untilArg) {
    const start = new Date(`${sinceArg}T00:00:00Z`);
    const end = new Date(`${untilArg}T00:00:00Z`); // end-exclusive
    for (let t = start.getTime(); t < end.getTime(); ) {
      datesToFetch.push(formatDateUtc(new Date(t)));
      t += 24 * 60 * 60 * 1000;
    }
  } else {
    datesToFetch.push(dateArg ?? defaultDate);
  }

  const idsEnv = (process.env.GOOGLE_ADS_CUSTOMER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const targetCustomerIds = Array.from(new Set(idsEnv));

  const allInsights = [];
  for (const date of datesToFetch) {
    if (targetCustomerIds.length > 0) {
      for (const id of targetCustomerIds) {
        const rows = await fetchGoogleCampaignInsightsDaily({
          date,
          customerId: id,
          ...(loginCustomerId ? { loginCustomerId } : {}),
          mode: "direct",
        });
        allInsights.push(...rows);
      }
    } else {
      const rows = await fetchGoogleCampaignInsightsDaily({
        date,
        customerId,
        ...(loginCustomerId ? { loginCustomerId } : {}),
        ...(forceMcc ? { mode: "mcc" as const } : {}),
      });
      allInsights.push(...rows);
    }
  }

  const rowsRaw: SpendRow[] = allInsights.map((r) => {
    const impressions = Number(r.impressions) || 0;
    const clicks = Number(r.clicks) || 0;
    const spend = (Number(r.cost_micros) || 0) / 1_000_000;

    return {
      platform: "google",
      account_id: r.customer_id,
      customer_id: r.customer_id,
      adset_id: "",
      adset_name: null,
      day: r.date,
      date: r.date,
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      spend,
      currency: "MXN",
      spend_usd: null,
      spend_mxn: spend,
      fx_usd_mxn: null,
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
      .upsert(rows, { onConflict: "platform,date,customer_id,campaign_id,adset_id" })
      .select("platform,date,customer_id,campaign_id,adset_id");

    if (error) throw error;
    upserted = data?.length ?? 0;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "syncGoogleSpendDaily",
        date: datesToFetch.length === 1 ? datesToFetch[0] : null,
        since: sinceArg ?? null,
        until: untilArg ?? null,
        customerId,
        loginCustomerId: loginCustomerId ?? null,
        mode: forceMcc ? "mcc" : "auto",
        customersQueried:
          targetCustomerIds.length > 0 ? targetCustomerIds : undefined,
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

