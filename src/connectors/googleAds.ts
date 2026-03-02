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

function resolveGoogleAdsIds(overrides?: Partial<GoogleAdsIds>): GoogleAdsIds {
  const customerId =
    overrides?.customerId ?? requiredEnv("GOOGLE_ADS_CUSTOMER_ID");
  const loginCustomerId =
    overrides?.loginCustomerId ??
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ??
    undefined;

  if (loginCustomerId && customerId === loginCustomerId) {
    throw new Error(
      `GOOGLE_ADS_CUSTOMER_ID (${customerId}) must be the client account id, not the MCC (login customer).`,
    );
  }

  return { customerId, loginCustomerId };
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

export type GoogleCampaignInsightDaily = {
  date: string; // YYYY-MM-DD (segments.date)
  campaign_id: string;
  campaign_name: string | null;
  cost_micros: number;
  impressions: number;
  clicks: number;
  advertising_channel_type?: string | null;
  raw?: unknown;
};

export async function fetchGoogleCampaignInsightsDaily(params: {
  date: string; // YYYY-MM-DD
  customerId?: string;
  loginCustomerId?: string;
}): Promise<GoogleCampaignInsightDaily[]> {
  const { customer, customerId, loginCustomerId } = googleCustomer({
    customerId: params.customerId,
    loginCustomerId: params.loginCustomerId,
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        connector: "googleAds",
        fn: "fetchGoogleCampaignInsightsDaily",
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

  try {
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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify(
        {
          connector: "googleAds",
          fn: "fetchGoogleCampaignInsightsDaily",
          customerId,
          loginCustomerId: loginCustomerId ?? null,
          date: params.date,
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
}): Promise<GoogleCampaignListRow[]> {
  const { customer, customerId, loginCustomerId } = googleCustomer({
    customerId: params.customerId,
    loginCustomerId: params.loginCustomerId,
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        connector: "googleAds",
        fn: "fetchGoogleCampaignList",
        customerId,
        loginCustomerId: loginCustomerId ?? null,
      },
      null,
      2,
    ),
  );

  const gaql = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type
    FROM campaign
    WHERE campaign.status IN ('ENABLED', 'PAUSED')
  `.trim();

  try {
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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify(
        {
          connector: "googleAds",
          fn: "fetchGoogleCampaignList",
          customerId,
          loginCustomerId: loginCustomerId ?? null,
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

