type HubSpotRequestInit = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

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

  const reqInit: RequestInit = {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  };
  if (init.body !== undefined) reqInit.body = JSON.stringify(init.body);

  const res = await fetch(url, reqInit);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HubSpot request failed (${res.status} ${res.statusText}) ${path} ${text}`,
    );
  }

  return (await res.json()) as T;
}

export type HubSpotContact = {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
};

export async function searchHubspotContactsUpdatedSince(params: {
  updatedSinceMs: number;
  properties?: string[];
  limit?: number;
  after?: string | undefined;
}) {
  return hubspotRequest<{
    results: HubSpotContact[];
    paging?: { next?: { after: string } };
  }>("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "lastmodifieddate",
              operator: "GTE",
              value: String(params.updatedSinceMs),
            },
          ],
        },
      ],
      sorts: [{ propertyName: "lastmodifieddate", direction: "ASCENDING" }],
      properties: params.properties ?? [],
      limit: params.limit ?? 100,
      after: params.after,
    },
  });
}

