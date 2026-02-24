type HubSpotRequestInit = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_CONTACT_PROPERTIES = [
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

        throw new Error(
          `HubSpot request failed (${res.status} ${res.statusText}) ${path}`,
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timeout);

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
  const data = await hubspotRequest<{
    results: HubSpotContact[];
    paging?: { next?: { after: string } };
  }>("/crm/v3/objects/contacts", {
    query: {
      limit: 100,
      archived: false,
      properties: DEFAULT_CONTACT_PROPERTIES.join(","),
      ...(params?.after ? { after: params.after } : {}),
    },
  });

  return {
    results: data.results,
    nextAfter: data.paging?.next?.after,
  };
}

export type HubSpotSearchMode = "createdate" | "lastmodifieddate";

export async function searchContacts(params: {
  mode: HubSpotSearchMode;
  sinceMs: number;
  untilMs?: number;
  after?: string;
}) {
  const filterProp = params.mode === "createdate" ? "createdate" : "lastmodifieddate";

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
      properties: DEFAULT_CONTACT_PROPERTIES,
      limit: 100,
      archived: false,
      ...(params.after ? { after: params.after } : {}),
    },
  });

  return { results: data.results, nextAfter: data.paging?.next?.after };
}

