import "dotenv/config";
import { fetchGoogleCampaignList } from "../connectors/googleAds";
import { getSupabaseClient } from "../lib/supabase";

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

type CampaignMappingRow = {
  platform: "google";
  customer_id: string;
  campaign_id: string;
  utm_campaign: string | null;
  notes: string | null;
  updated_at: string;
};

type GoogleCampaignRow = {
  customer_id: string;
  campaign_id: string;
  campaign_name: string | null;
  status: string | null;
  channel_type: string | null;
};

async function seedGoogleCampaignMapping() {
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

  const idsEnv = (process.env.GOOGLE_ADS_CUSTOMER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const targetCustomerIds = Array.from(new Set(idsEnv));

  let campaigns =
    targetCustomerIds.length > 0
      ? []
      : await fetchGoogleCampaignList({
          customerId,
          ...(loginCustomerId ? { loginCustomerId } : {}),
          ...(forceMcc ? { mode: "mcc" as const } : {}),
        });

  if (targetCustomerIds.length > 0) {
    const all = [];
    for (const id of targetCustomerIds) {
      const rows = await fetchGoogleCampaignList({
        customerId: id,
        ...(loginCustomerId ? { loginCustomerId } : {}),
        mode: "direct",
      });
      all.push(...rows);
    }
    campaigns = all;
  }

  const nowIso = new Date().toISOString();

  const mappingRows: CampaignMappingRow[] = campaigns.map((c) => ({
    platform: "google",
    customer_id: c.customer_id,
    campaign_id: c.campaign_id,
    utm_campaign: null,
    notes: c.campaign_name ? `${c.customer_id}: ${c.campaign_name}` : c.customer_id,
    updated_at: nowIso,
  }));

  const snapshotRows: GoogleCampaignRow[] = campaigns.map((c) => ({
    customer_id: c.customer_id,
    campaign_id: c.campaign_id,
    campaign_name: c.campaign_name,
    status: c.status,
    channel_type: c.channel_type,
  }));

  let mappingUpserted = 0;
  if (mappingRows.length > 0) {
    const { error, data } = await supabase
      .from("campaign_mapping")
      .upsert(mappingRows, { onConflict: "platform,customer_id,campaign_id" })
      .select("platform,customer_id,campaign_id");
    if (error) throw error;
    mappingUpserted = data?.length ?? 0;
  }

  let snapshotUpserted = 0;
  if (snapshotRows.length > 0) {
    const { error, data } = await supabase
      .from("google_campaigns")
      .upsert(snapshotRows, { onConflict: "customer_id,campaign_id" })
      .select("customer_id,campaign_id");
    if (error) throw error;
    snapshotUpserted = data?.length ?? 0;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "seedGoogleCampaignMapping",
        customerId,
        loginCustomerId: loginCustomerId ?? null,
        mode: forceMcc ? "mcc" : "auto",
        customersQueried:
          targetCustomerIds.length > 0 ? targetCustomerIds : undefined,
        campaignsFetched: campaigns.length,
        mappingUpserted,
        googleCampaignsUpserted: snapshotUpserted,
      },
      null,
      2,
    ),
  );
}

seedGoogleCampaignMapping().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

