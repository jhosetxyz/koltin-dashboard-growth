type HubSpotRequestInit = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

type HubSpotHttpError = Error & {
  status?: number;
  statusText?: string;
  path?: string;
  correlationId?: string | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASE_CONTACT_PROPERTIES = [
  "hs_object_id",
  "email",
  "phone",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "hubspot_owner_id",
  "lifecyclestage",
  "hs_lead_status",
  "mql",
  "disqualified",
  "createdate",
  "lastmodifieddate",
];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function getOldCreatedAtPropertyName(): string | null {
  const raw = process.env.HUBSPOT_OLD_CREATED_AT_PROPERTY ?? "old_created_at";
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

let cachedContactProperties: string[] | null = null;
export async function resolveContactProperties(): Promise<string[]> {
  if (cachedContactProperties) return cachedContactProperties;

  const props = [...BASE_CONTACT_PROPERTIES];
  const oldProp = getOldCreatedAtPropertyName();
  if (!oldProp) {
    cachedContactProperties = props;
    return props;
  }

  try {
    await hubspotRequest(`/crm/v3/properties/contacts/${encodeURIComponent(oldProp)}`);
    props.push(oldProp);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify(
        {
          connector: "hubspot",
          fn: "resolveContactProperties",
          warning: "old_created_at property not available; omitting from properties list",
          property: oldProp,
          error: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ),
    );
  }

  cachedContactProperties = props;
  return props;
}

function toQueryString(query: HubSpotRequestInit["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function hubspotRequest<T>(
  path: string,
  init: HubSpotRequestInit = {},
): Promise<T> {
  const token = requiredEnv("HUBSPOT_PRIVATE_APP_TOKEN");
  const url = `https://api.hubapi.com${path}${toQueryString(init.query)}`;

  const reqInitBase: RequestInit = {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  };

  const maxRetries = 6;
  const timeoutMs = 30_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const reqInit: RequestInit = { ...reqInitBase, signal: controller.signal };
    if (init.body !== undefined) reqInit.body = JSON.stringify(init.body);

    try {
      const res = await fetch(url, reqInit);
      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res
          .json()
          .catch(async () => await res.text().catch(() => null));

        // eslint-disable-next-line no-console
        console.error(
          `HubSpot error response body for ${path}:`,
          typeof body === "string" ? body : JSON.stringify(body, null, 2),
        );
        // eslint-disable-next-line no-console
        console.error(
          `HubSpot error request for ${path}:`,
          JSON.stringify(
            {
              method: reqInitBase.method,
              url,
              body: init.body ?? null,
            },
            null,
            2,
          ),
        );

        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : undefined;
        const retryableStatus = res.status === 429 || res.status >= 500;

        if (attempt < maxRetries && retryableStatus) {
          const backoffMs =
            retryAfterMs ??
            Math.min(15_000, 500 * Math.pow(2, attempt)) +
              Math.floor(Math.random() * 250);
          // eslint-disable-next-line no-console
          console.warn(
            `Retrying HubSpot request ${path} after ${backoffMs}ms (status ${res.status}, attempt ${attempt + 1}/${maxRetries})`,
          );
          await sleep(backoffMs);
          continue;
        }

        const err: HubSpotHttpError = new Error(
          `HubSpot request failed (${res.status} ${res.statusText}) ${path}`,
        );
        err.status = res.status;
        err.statusText = res.statusText;
        err.path = path;
        try {
          err.correlationId =
            body && typeof body === "object" && "correlationId" in body
              ? String((body as any).correlationId ?? "")
              : null;
        } catch {
          err.correlationId = null;
        }
        throw err;
      }

      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timeout);

      // Don't retry HTTP errors we already classified as non-retryable (e.g. 400).
      if (
        err &&
        typeof err === "object" &&
        "message" in err &&
        String((err as Error).message).startsWith("HubSpot request failed (")
      ) {
        throw err;
      }

      if (attempt >= maxRetries) throw err;

      // eslint-disable-next-line no-console
      console.warn(
        `Retrying HubSpot request ${path} after network error (attempt ${attempt + 1}/${maxRetries})`,
      );
      const backoffMs =
        Math.min(15_000, 500 * Math.pow(2, attempt)) +
        Math.floor(Math.random() * 250);
      await sleep(backoffMs);
    }
  }

  throw new Error(`HubSpot request failed after retries ${path}`);
}

export type HubSpotContact = {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
};

export async function listContacts(params?: { after?: string }) {
  const properties = await resolveContactProperties();
  const data = await hubspotRequest<{
    results: HubSpotContact[];
    paging?: { next?: { after: string } };
  }>("/crm/v3/objects/contacts", {
    query: {
      limit: 100,
      archived: false,
      properties: properties.join(","),
      ...(params?.after ? { after: params.after } : {}),
    },
  });

  return {
    results: data.results,
    nextAfter: data.paging?.next?.after,
  };
}

export type HubSpotSearchMode = "createdate" | "lastmodifieddate";

const HUBSPOT_SEARCH_AFTER_LIMIT = 10_000;

export async function searchContacts(params: {
  mode: HubSpotSearchMode;
  sinceMs: number;
  untilMs?: number;
  after?: string;
}) {
  const filterProp = params.mode === "createdate" ? "createdate" : "lastmodifieddate";
  const properties = await resolveContactProperties();

  // HubSpot search has a deep paging cap; after >= 10000 typically fails with 400.
  if (params.after) {
    const n = Number(params.after);
    if (Number.isFinite(n) && n >= HUBSPOT_SEARCH_AFTER_LIMIT) {
      throw new Error(
        `HubSpot search deep paging limit reached (after=${params.after}). Usa ventanas más chicas con --until (end-exclusive) o el backfill runner.`,
      );
    }
  }

  const filters: Array<{
    propertyName: string;
    operator: "GTE" | "LT";
    value: string;
  }> = [
    {
      propertyName: filterProp,
      operator: "GTE",
      value: String(params.sinceMs),
    },
  ];

  if (params.untilMs !== undefined) {
    filters.push({
      propertyName: filterProp,
      operator: "LT",
      value: String(params.untilMs),
    });
  }

  const data = await hubspotRequest<{
    results: HubSpotContact[];
    paging?: { next?: { after: string } };
  }>("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: {
      filterGroups: [{ filters }],
      sorts: [filterProp],
      properties,
      limit: 100,
      archived: false,
      ...(params.after ? { after: params.after } : {}),
    },
  });

  return { results: data.results, nextAfter: data.paging?.next?.after };
}

