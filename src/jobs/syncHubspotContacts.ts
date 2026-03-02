import "dotenv/config";
import {
  searchContacts,
  type HubSpotContact,
  type HubSpotSearchMode,
} from "../connectors/hubspot";
import { getSupabaseClient } from "../lib/supabase";

type SyncResult = {
  fetched: number;
  upserted: number;
};

export type RunSyncHubspotContactsParams = {
  mode: HubSpotSearchMode;
  since: string; // YYYY-MM-DD (UTC)
  until?: string; // YYYY-MM-DD (UTC), end-exclusive
  after?: string;
  logPages?: boolean;
};

export type RunSyncHubspotContactsResult = SyncResult & {
  minCreatedAt: string | null;
  maxCreatedAt: string | null;
};

function parseArgValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function parseUtcDateStartMs(yyyyMmDd: string): number {
  const [y, m, d] = yyyyMmDd.split("-").map((x) => Number(x));
  if (!y || !m || !d) throw new Error(`Invalid date: ${yyyyMmDd}`);
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0);
}

function toIsoFromHubspotValue(
  value: string | null | undefined,
  fallbackIso: string | null | undefined,
  opts?: { fallbackNow?: boolean },
): string {
  if (value) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return new Date(asNumber).toISOString();
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (fallbackIso) {
    const parsed = Date.parse(fallbackIso);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (opts?.fallbackNow) return new Date().toISOString();
  throw new Error("Missing timestamp");
}

function parseBool(v: string | null | undefined): boolean | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return null;
}

async function syncHubspotContacts(): Promise<SyncResult> {
  const mode = (parseArgValue("mode") ??
    process.env.HUBSPOT_MODE ??
    "lastmodifieddate") as HubSpotSearchMode;

  const sinceStr = parseArgValue("since") ?? process.env.HUBSPOT_SINCE;
  const untilStr = parseArgValue("until") ?? process.env.HUBSPOT_UNTIL;

  const since =
    sinceStr ??
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return await runSyncHubspotContacts({
    mode,
    since,
    ...(untilStr ? { until: untilStr } : {}),
    ...(process.env.HUBSPOT_AFTER ? { after: process.env.HUBSPOT_AFTER } : {}),
    logPages: true,
  });
}

export async function runSyncHubspotContacts(
  params: RunSyncHubspotContactsParams,
): Promise<RunSyncHubspotContactsResult> {
  const supabase = getSupabaseClient();

  let after: string | undefined = params.after;
  let fetched = 0;
  let upserted = 0;

  const sinceMs = parseUtcDateStartMs(params.since);
  const untilMs = params.until ? parseUtcDateStartMs(params.until) : undefined;

  let minCreatedAtMs: number | null = null;
  let maxCreatedAtMs: number | null = null;

  for (;;) {
    const page = await searchContacts({
      mode: params.mode,
      sinceMs,
      ...(untilMs !== undefined ? { untilMs } : {}),
      ...(after ? { after } : {}),
    });

    const pageSize = page.results.length;
    fetched += pageSize;

    const createdates: number[] = [];
    const lastmods: number[] = [];
    for (const c of page.results) {
      const cd = c.properties.createdate
        ? Date.parse(c.properties.createdate)
        : NaN;
      const lm = c.properties.lastmodifieddate
        ? Date.parse(c.properties.lastmodifieddate)
        : NaN;
      if (Number.isFinite(cd)) createdates.push(cd);
      if (Number.isFinite(lm)) lastmods.push(lm);
    }
    createdates.sort((a, b) => a - b);
    lastmods.sort((a, b) => a - b);

    if (createdates.length > 0) {
      const minCd = createdates[0]!;
      const maxCd = createdates[createdates.length - 1]!;
      minCreatedAtMs =
        minCreatedAtMs === null
          ? minCd
          : Math.min(minCreatedAtMs, minCd);
      maxCreatedAtMs =
        maxCreatedAtMs === null
          ? maxCd
          : Math.max(maxCreatedAtMs, maxCd);
    }

    if (params.logPages) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            job: "syncHubspotContacts",
            mode: params.mode,
            sinceMs,
            untilMs: untilMs ?? null,
            pageSize,
            after: after ?? null,
            nextAfter: page.nextAfter ?? null,
            minCreatedate: createdates[0] ?? null,
            maxCreatedate: createdates.at(-1) ?? null,
            minLastmodifieddate: lastmods[0] ?? null,
            maxLastmodifieddate: lastmods.at(-1) ?? null,
          },
          null,
          2,
        ),
      );
    }

    if (page.results.length > 0) {
      const rows = page.results.map((c: HubSpotContact) => {
        let created_at: string;
        let updated_at: string;

        try {
          created_at = toIsoFromHubspotValue(c.properties.createdate, c.createdAt);
        } catch {
          // eslint-disable-next-line no-console
          console.warn(`Missing createdate for contact ${c.id}; using now()`);
          created_at = toIsoFromHubspotValue(null, null, { fallbackNow: true });
        }

        try {
          updated_at = toIsoFromHubspotValue(
            c.properties.lastmodifieddate,
            c.updatedAt,
          );
        } catch {
          // eslint-disable-next-line no-console
          console.warn(
            `Missing lastmodifieddate for contact ${c.id}; using now()`,
          );
          updated_at = toIsoFromHubspotValue(null, null, { fallbackNow: true });
        }

        const leadStatus = c.properties.hs_lead_status ?? null;
        const leadStatusLower = (leadStatus ?? "").toLowerCase();

        return {
          hubspot_contact_id: c.id,
          created_at,
          updated_at,
          email: c.properties.email ?? null,
          phone: c.properties.phone ?? null,
          utm_source: c.properties.utm_source ?? null,
          utm_medium: c.properties.utm_medium ?? null,
          utm_campaign: c.properties.utm_campaign ?? null,
          utm_content: c.properties.utm_content ?? null,
          utm_term: c.properties.utm_term ?? null,
          lifecycle_stage: c.properties.lifecyclestage ?? null,
          lead_status: leadStatus,
          whatsapp_no_response: leadStatusLower === "no contesta whatsapp",
          call_done: ["conectado llamada", "llamada agendada", "cliente"].includes(
            leadStatusLower,
          ),
          mql: parseBool(c.properties.mql),
          disqualified: parseBool(c.properties.disqualified),
          owner_id: c.properties.hubspot_owner_id ?? null,
          hubspot_owner_id: c.properties.hubspot_owner_id ?? null,
          raw_json: c as unknown,
        };
      });

      const { error, data } = await supabase
        .from("hubspot_contacts")
        .upsert(rows, { onConflict: "hubspot_contact_id" })
        .select("hubspot_contact_id");

      if (error) throw error;
      upserted += data?.length ?? 0;

      if (params.logPages) {
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
    }

    after = page.nextAfter;
    if (!after) break;
  }

  return {
    fetched,
    upserted,
    minCreatedAt:
      minCreatedAtMs === null ? null : new Date(minCreatedAtMs).toISOString(),
    maxCreatedAt:
      maxCreatedAtMs === null ? null : new Date(maxCreatedAtMs).toISOString(),
  };
}

async function main() {
  const result = await syncHubspotContacts();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ job: "syncHubspotContacts", ...result }, null, 2));
}

if (require.main === module) {
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
}

