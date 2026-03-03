import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function googleAdsClient() {
  const developerToken = requiredEnv("GOOGLE_ADS_DEVELOPER_TOKEN");
  const clientId = requiredEnv("GOOGLE_ADS_CLIENT_ID");
  const clientSecret = requiredEnv("GOOGLE_ADS_CLIENT_SECRET");

  return new GoogleAdsApi({
    developer_token: developerToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

type GoogleAdsIds = {
  customerId: string; // client account (NOT MCC)
  loginCustomerId?: string; // MCC (optional)
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function resolveGoogleAdsIds(overrides?: Partial<GoogleAdsIds>): GoogleAdsIds {
  const customerId =
    overrides?.customerId ?? requiredEnv("GOOGLE_ADS_CUSTOMER_ID");
  const loginCustomerId =
    overrides?.loginCustomerId ??
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ??
    undefined;

  const out: GoogleAdsIds = { customerId };
  if (isNonEmptyString(loginCustomerId)) out.loginCustomerId = loginCustomerId;
  return out;
}

function googleCustomer(overrides?: Partial<GoogleAdsIds>) {
  const refreshToken = requiredEnv("GOOGLE_ADS_REFRESH_TOKEN");
  const { customerId, loginCustomerId } = resolveGoogleAdsIds(overrides);

  const api = googleAdsClient();
  const customer = api.Customer({
    customer_id: customerId,
    refresh_token: refreshToken,
    ...(loginCustomerId ? { login_customer_id: loginCustomerId } : {}),
  });
  return { customer, customerId, loginCustomerId };
}

type GoogleAdsErrorLike = {
  message?: string;
  errors?: unknown[];
};

export function isManagerAccountError(err: unknown): boolean {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String((err as GoogleAdsErrorLike).message ?? "")
      : String(err ?? "");

  if (msg.includes("REQUESTED_METRICS_FOR_MANAGER")) return true;

  try {
    const s = JSON.stringify(err);
    return s.includes("REQUESTED_METRICS_FOR_MANAGER");
  } catch {
    return false;
  }
}

function parseCustomerResourceName(rn: string): string | null {
  // "customers/1234567890"
  const m = /^customers\/(\d+)$/.exec(rn);
  return m?.[1] ?? null;
}

export async function listAccessibleCustomers(params?: {
  loginCustomerId?: string;
}): Promise<string[]> {
  const refreshToken = requiredEnv("GOOGLE_ADS_REFRESH_TOKEN");
  const api = googleAdsClient();

  // Note: this returns customer resource names, not IDs.
  const res = (await api.listAccessibleCustomers(refreshToken)) as unknown as {
    resourceNames?: string[];
    resource_names?: string[];
  };
  const names = (res?.resourceNames ?? res?.resource_names ?? []) as string[];
  const ids = names
    .map((n) => parseCustomerResourceName(n))
    .filter((x): x is string => Boolean(x));

  const unique = Array.from(new Set(ids));
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        connector: "googleAds",
        fn: "listAccessibleCustomers",
        loginCustomerId: params?.loginCustomerId ?? null,
        count: unique.length,
      },
      null,
      2,
    ),
  );
  return unique;
}

export type GoogleClientAccount = {
  manager_customer_id: string;
  customer_id: string;
  descriptive_name: string | null;
  level: number | null;
  status: string | null;
  manager: boolean | null;
  raw?: unknown;
};

export async function listClientAccountsUnderManager(params: {
  loginCustomerId: string;
}): Promise<GoogleClientAccount[]> {
  const { customer } = googleCustomer({
    customerId: params.loginCustomerId,
    loginCustomerId: params.loginCustomerId,
  });

  const gaql = `
    SELECT
      customer_client.client_customer,
      customer_client.id,
      customer_client.descriptive_name,
      customer_client.level,
      customer_client.manager,
      customer_client.status
    FROM customer_client
    WHERE customer_client.manager = FALSE
      AND customer_client.status = 'ENABLED'
  `.trim();

  try {
    const rows: GoogleClientAccount[] = [];
    const stream = customer.queryStream(gaql);
    for await (const r of stream as AsyncIterable<any>) {
      const cc =
        r?.customerClient?.clientCustomer ??
        r?.customer_client?.client_customer ??
        null;
      const clientCustomerId =
        typeof cc === "string"
          ? parseCustomerResourceName(cc) ?? null
          : null;

      const id = r?.customerClient?.id ?? r?.customer_client?.id ?? null;
      const fallbackId = id != null ? String(id) : null;
      const customerId = clientCustomerId ?? fallbackId;
      if (!customerId) continue;

      rows.push({
        manager_customer_id: params.loginCustomerId,
        customer_id: String(customerId),
        descriptive_name:
          r?.customerClient?.descriptiveName ??
          r?.customer_client?.descriptive_name ??
          null,
        level:
          Number(r?.customerClient?.level ?? r?.customer_client?.level) || null,
        status: r?.customerClient?.status ?? r?.customer_client?.status ?? null,
        manager:
          r?.customerClient?.manager ??
          r?.customer_client?.manager ??
          null,
        raw: r,
      });
    }

    const unique = Array.from(
      new Map(rows.map((x) => [x.customer_id, x])).values(),
    );

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          connector: "googleAds",
          fn: "listClientAccountsUnderManager",
          loginCustomerId: params.loginCustomerId,
          clientsFound: unique.length,
        },
        null,
        2,
      ),
    );
    return unique;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify(
        {
          connector: "googleAds",
          fn: "listClientAccountsUnderManager",
          loginCustomerId: params.loginCustomerId,
          gaql,
          error: err instanceof Error ? err.message : String(err),
          details: err,
        },
        null,
        2,
      ),
    );
    throw err;
  }
}

export type GoogleCampaignInsightDaily = {
  date: string; // YYYY-MM-DD (segments.date)
  customer_id: string;
  campaign_id: string;
  campaign_name: string | null;
  cost_micros: number;
  impressions: number;
  clicks: number;
  advertising_channel_type?: string | null;
  raw?: unknown;
};

async function fetchGoogleCampaignInsightsDailySingle(params: {
  date: string;
  customerId: string;
  loginCustomerId?: string;
}): Promise<GoogleCampaignInsightDaily[]> {
  const overrides: Partial<GoogleAdsIds> = { customerId: params.customerId };
  if (isNonEmptyString(params.loginCustomerId))
    overrides.loginCustomerId = params.loginCustomerId;
  const { customer, customerId, loginCustomerId } = googleCustomer(overrides);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        connector: "googleAds",
        fn: "fetchGoogleCampaignInsightsDailySingle",
        customerId,
        loginCustomerId: loginCustomerId ?? null,
        date: params.date,
      },
      null,
      2,
    ),
  );

  const gaql = `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks
    FROM campaign
    WHERE segments.date = '${params.date}'
  `.trim();

  const rows: GoogleCampaignInsightDaily[] = [];
  const stream = customer.queryStream(gaql);

  for await (const r of stream as AsyncIterable<any>) {
    const date = String(r?.segments?.date ?? params.date);
    const campaignId = String(r?.campaign?.id ?? "");
    if (!campaignId) continue;

    const costMicros =
      Number(r?.metrics?.costMicros ?? r?.metrics?.cost_micros ?? 0) || 0;
    const impressions = Number(r?.metrics?.impressions ?? 0) || 0;
    const clicks = Number(r?.metrics?.clicks ?? 0) || 0;

    rows.push({
      date,
      customer_id: customerId,
      campaign_id: campaignId,
      campaign_name: r?.campaign?.name ? String(r.campaign.name) : null,
      advertising_channel_type: r?.campaign?.advertisingChannelType
        ? String(r.campaign.advertisingChannelType)
        : r?.campaign?.advertising_channel_type
          ? String(r.campaign.advertising_channel_type)
          : null,
      cost_micros: costMicros,
      impressions,
      clicks,
      raw: r,
    });
  }

  return rows;
}

export async function fetchGoogleCampaignInsightsDaily(params: {
  date: string; // YYYY-MM-DD
  customerId?: string;
  loginCustomerId?: string;
  mode?: "direct" | "mcc";
}): Promise<GoogleCampaignInsightDaily[]> {
  try {
    const overrides: Partial<GoogleAdsIds> = {};
    if (isNonEmptyString(params.customerId)) overrides.customerId = params.customerId;
    if (isNonEmptyString(params.loginCustomerId))
      overrides.loginCustomerId = params.loginCustomerId;

    const ids = resolveGoogleAdsIds(overrides);

    const forcedMcc =
      params.mode === "mcc" ||
      (ids.loginCustomerId != null && ids.customerId === ids.loginCustomerId);

    if (!forcedMcc) {
      return await fetchGoogleCampaignInsightsDailySingle({
        date: params.date,
        customerId: ids.customerId,
        ...(ids.loginCustomerId ? { loginCustomerId: ids.loginCustomerId } : {}),
      });
    }

    const managerId = ids.loginCustomerId ?? ids.customerId;
    const clients = await listClientAccountsUnderManager({
      loginCustomerId: managerId,
    });
    const targetClientIds = clients.map((c) => c.customer_id);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          connector: "googleAds",
          fn: "fetchGoogleCampaignInsightsDaily",
          mode: "mcc",
          managerId,
          clientsFound: targetClientIds.length,
          date: params.date,
        },
        null,
        2,
      ),
    );

    const all: GoogleCampaignInsightDaily[] = [];
    let spendMicrosTotal = 0;
    for (const clientId of targetClientIds) {
      const rows = await fetchGoogleCampaignInsightsDailySingle({
        date: params.date,
        customerId: clientId,
        loginCustomerId: managerId,
      });
      for (const r of rows) spendMicrosTotal += Number(r.cost_micros) || 0;
      all.push(...rows);
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          connector: "googleAds",
          fn: "fetchGoogleCampaignInsightsDaily",
          mode: "mcc",
          managerId,
          clientsQueried: targetClientIds.length,
          rows: all.length,
          spendTotal: spendMicrosTotal / 1_000_000,
        },
        null,
        2,
      ),
    );

    return all;
  } catch (err) {
    if (params.mode !== "mcc" && isManagerAccountError(err)) {
      const overrides: Partial<GoogleAdsIds> = {};
      if (isNonEmptyString(params.customerId)) overrides.customerId = params.customerId;
      if (isNonEmptyString(params.loginCustomerId))
        overrides.loginCustomerId = params.loginCustomerId;
      const ids = resolveGoogleAdsIds(overrides);
      const managerId = ids.loginCustomerId ?? ids.customerId;
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify(
          {
            connector: "googleAds",
            fn: "fetchGoogleCampaignInsightsDaily",
            fallback: "mcc",
            reason: "REQUESTED_METRICS_FOR_MANAGER",
            managerId,
            date: params.date,
          },
          null,
          2,
        ),
      );
      return await fetchGoogleCampaignInsightsDaily({
        date: params.date,
        customerId: managerId,
        loginCustomerId: managerId,
        mode: "mcc",
      });
    }

    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify(
        {
          connector: "googleAds",
          fn: "fetchGoogleCampaignInsightsDaily",
          customerId: params.customerId ?? null,
          loginCustomerId: params.loginCustomerId ?? null,
          date: params.date,
          error: err instanceof Error ? err.message : String(err),
          details: err,
        },
        null,
        2,
      ),
    );
    throw err;
  }
}

export type GoogleCampaignListRow = {
  customer_id: string;
  campaign_id: string;
  campaign_name: string | null;
  status: string | null;
  channel_type: string | null;
  raw?: unknown;
};

export async function fetchGoogleCampaignList(params: {
  customerId?: string;
  loginCustomerId?: string;
  mode?: "direct" | "mcc";
}): Promise<GoogleCampaignListRow[]> {
  const gaql = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type
    FROM campaign
    WHERE campaign.status IN ('ENABLED', 'PAUSED')
  `.trim();

  const overrides: Partial<GoogleAdsIds> = {};
  if (isNonEmptyString(params.customerId)) overrides.customerId = params.customerId;
  if (isNonEmptyString(params.loginCustomerId))
    overrides.loginCustomerId = params.loginCustomerId;
  const ids = resolveGoogleAdsIds(overrides);

  const forcedMcc =
    params.mode === "mcc" ||
    (ids.loginCustomerId != null && ids.customerId === ids.loginCustomerId);

  try {
    if (!forcedMcc) {
      const overrides: Partial<GoogleAdsIds> = { customerId: ids.customerId };
      if (isNonEmptyString(ids.loginCustomerId))
        overrides.loginCustomerId = ids.loginCustomerId;
      const { customer, customerId, loginCustomerId } = googleCustomer(overrides);

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            connector: "googleAds",
            fn: "fetchGoogleCampaignList",
            mode: "direct",
            customerId,
            loginCustomerId: loginCustomerId ?? null,
          },
          null,
          2,
        ),
      );

      const rows: GoogleCampaignListRow[] = [];
      const stream = customer.queryStream(gaql);

      for await (const r of stream as AsyncIterable<any>) {
        const campaignId = String(r?.campaign?.id ?? "");
        if (!campaignId) continue;

        rows.push({
          customer_id: customerId,
          campaign_id: campaignId,
          campaign_name: r?.campaign?.name ? String(r.campaign.name) : null,
          status: r?.campaign?.status ? String(r.campaign.status) : null,
          channel_type: r?.campaign?.advertisingChannelType
            ? String(r.campaign.advertisingChannelType)
            : r?.campaign?.advertising_channel_type
              ? String(r.campaign.advertising_channel_type)
              : null,
          raw: r,
        });
      }

      return rows;
    }

    const managerId = ids.loginCustomerId ?? ids.customerId;
    const clients = await listClientAccountsUnderManager({
      loginCustomerId: managerId,
    });
    const targetClientIds = clients.map((c) => c.customer_id);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          connector: "googleAds",
          fn: "fetchGoogleCampaignList",
          mode: "mcc",
          managerId,
          clientsFound: targetClientIds.length,
        },
        null,
        2,
      ),
    );

    const all: GoogleCampaignListRow[] = [];
    for (const clientId of targetClientIds) {
      const { customer } = googleCustomer({
        customerId: clientId,
        loginCustomerId: managerId,
      });
      const stream = customer.queryStream(gaql);
      for await (const r of stream as AsyncIterable<any>) {
        const campaignId = String(r?.campaign?.id ?? "");
        if (!campaignId) continue;
        all.push({
          customer_id: clientId,
          campaign_id: campaignId,
          campaign_name: r?.campaign?.name ? String(r.campaign.name) : null,
          status: r?.campaign?.status ? String(r.campaign.status) : null,
          channel_type: r?.campaign?.advertisingChannelType
            ? String(r.campaign.advertisingChannelType)
            : r?.campaign?.advertising_channel_type
              ? String(r.campaign.advertising_channel_type)
              : null,
          raw: r,
        });
      }
    }

    return all;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify(
        {
          connector: "googleAds",
          fn: "fetchGoogleCampaignList",
          customerId: ids.customerId,
          loginCustomerId: ids.loginCustomerId ?? null,
          mode: forcedMcc ? "mcc" : "direct",
          gaql,
          error: err instanceof Error ? err.message : String(err),
          details: err,
        },
        null,
        2,
      ),
    );
    throw err;
  }
}

