import "dotenv/config";
import { listContacts, type HubSpotContact } from "../connectors/hubspot";
import { getSupabaseClient } from "../lib/supabase";

type SyncResult = {
  fetched: number;
  upserted: number;
};

async function syncHubspotContacts(): Promise<SyncResult> {
  const supabase = getSupabaseClient();

  let after: string | undefined = process.env.HUBSPOT_AFTER || undefined;
  let fetched = 0;
  let upserted = 0;
  const updatedSinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (;;) {
    const page = await listContacts(after ? { after } : undefined);
    const pageSize = page.results.length;
    fetched += pageSize;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        { job: "syncHubspotContacts", pageSize, after: after ?? null },
        null,
        2,
      ),
    );

    const recent = page.results.filter((c: HubSpotContact) => {
      const updatedAtMs = Date.parse(c.updatedAt);
      return Number.isFinite(updatedAtMs) && updatedAtMs >= updatedSinceMs;
    });

    if (recent.length > 0) {
      const rows = recent.map((c: HubSpotContact) => ({
        hubspot_contact_id: c.id,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        utm_source: c.properties.utm_source ?? null,
        utm_medium: c.properties.utm_medium ?? null,
        utm_campaign: c.properties.utm_campaign ?? null,
        utm_content: c.properties.utm_content ?? null,
        utm_term: c.properties.utm_term ?? null,
        lifecycle_stage: c.properties.lifecyclestage ?? null,
        lead_status: c.properties.hs_lead_status ?? null,
        hubspot_owner_id: c.properties.hubspot_owner_id ?? null,
      }));

      const { error, data } = await supabase
        .from("hubspot_contacts")
        .upsert(rows, { onConflict: "hubspot_contact_id" })
        .select("hubspot_contact_id");

      if (error) throw error;
      upserted += data?.length ?? 0;
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            job: "syncHubspotContacts",
            insertedThisPage: data?.length ?? 0,
            totalInserted: upserted,
          },
          null,
          2,
        ),
      );
    }

    after = page.nextAfter;
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
  console.error(
    JSON.stringify(
      {
        job: "syncHubspotContacts",
        error: err instanceof Error ? err.message : String(err),
        hint: "Puedes reanudar con HUBSPOT_AFTER=<after> pnpm run sync:hubspot",
      },
      null,
      2,
    ),
  );
  console.error(err);
  process.exitCode = 1;
});

