import "dotenv/config";
import {
  searchHubspotContactsUpdatedSince,
  type HubSpotContact,
} from "../connectors/hubspot";
import { getSupabaseClient } from "../lib/supabase";

type SyncResult = {
  fetched: number;
  upserted: number;
};

const CONTACT_PROPERTIES = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "lifecycle_stage",
  "lead_status",
  "hubspot_owner_id",
];

async function syncHubspotContacts(): Promise<SyncResult> {
  const supabase = getSupabaseClient();

  let after: string | undefined;
  let fetched = 0;
  let upserted = 0;
  const updatedSinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (;;) {
    const page = await searchHubspotContactsUpdatedSince({
      updatedSinceMs,
      limit: 100,
      properties: CONTACT_PROPERTIES,
      ...(after ? { after } : {}),
    });
    fetched += page.results.length;

    if (page.results.length > 0) {
      const rows = page.results.map((c: HubSpotContact) => ({
        hubspot_contact_id: c.id,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        utm_source: c.properties.utm_source ?? null,
        utm_medium: c.properties.utm_medium ?? null,
        utm_campaign: c.properties.utm_campaign ?? null,
        utm_content: c.properties.utm_content ?? null,
        utm_term: c.properties.utm_term ?? null,
        lifecycle_stage: c.properties.lifecycle_stage ?? null,
        lead_status: c.properties.lead_status ?? null,
        hubspot_owner_id: c.properties.hubspot_owner_id ?? null,
      }));

      const { error, data } = await supabase
        .from("hubspot_contacts")
        .upsert(rows, { onConflict: "hubspot_contact_id" })
        .select("hubspot_contact_id");

      if (error) throw error;
      upserted += data?.length ?? 0;
    }

    after = page.paging?.next?.after;
    if (!after) break;
  }

  return { fetched, upserted };
}

async function main() {
  const result = await syncHubspotContacts();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ job: "syncHubspotContacts", ...result }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

