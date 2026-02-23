type MetaInsightsRow = {
  campaign_id: string;
  campaign_name: string;
  date_start: string;
  spend: string;
  impressions: string;
  clicks: string;
  ctr: string;
};

type MetaResponse<T> = {
  data: T[];
  paging?: { next?: string };
  error?: unknown;
};

const baseUrl = "https://graph.facebook.com/v19.0";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function toQueryString(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function metaFetchJson<T>(url: string): Promise<T> {
  const maxRetries = 6;
  const timeoutMs = 30_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res
          .json()
          .catch(async () => await res.text().catch(() => null));
        // eslint-disable-next-line no-console
        console.error(
          `Meta error response body:`,
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
            `Retrying Meta request after ${backoffMs}ms (status ${res.status}, attempt ${attempt + 1}/${maxRetries})`,
          );
          await sleep(backoffMs);
          continue;
        }

        throw new Error(`Meta request failed (${res.status} ${res.statusText})`);
      }

      const json = (await res.json()) as T;
      return json;
    } catch (err) {
      clearTimeout(timeout);

      if (attempt >= maxRetries) throw err;
      // eslint-disable-next-line no-console
      console.warn(
        `Retrying Meta request after network error (attempt ${attempt + 1}/${maxRetries})`,
      );
      const backoffMs =
        Math.min(15_000, 500 * Math.pow(2, attempt)) +
        Math.floor(Math.random() * 250);
      await sleep(backoffMs);
    }
  }

  throw new Error("Meta request failed after retries");
}

export async function fetchMetaCampaignInsightsDaily(params: {
  since: string;
  until: string;
}): Promise<MetaInsightsRow[]> {
  const accessToken = requiredEnv("META_ACCESS_TOKEN");
  const adAccountId = requiredEnv("META_AD_ACCOUNT_ID");

  let nextUrl =
    `${baseUrl}/${encodeURIComponent(adAccountId)}/insights` +
    toQueryString({
      level: "campaign",
      time_increment: 1,
      "time_range[since]": params.since,
      "time_range[until]": params.until,
      fields:
        "campaign_id,campaign_name,date_start,spend,impressions,clicks,ctr",
      limit: 500,
      access_token: accessToken,
    });

  const rows: MetaInsightsRow[] = [];

  while (nextUrl) {
    const json = await metaFetchJson<MetaResponse<MetaInsightsRow>>(nextUrl);

    if (json && typeof json === "object" && "error" in (json as object) && (json as MetaResponse<MetaInsightsRow>).error) {
      // eslint-disable-next-line no-console
      console.error("Meta API returned error payload:", JSON.stringify((json as MetaResponse<MetaInsightsRow>).error, null, 2));
      throw new Error("Meta API returned error payload");
    }

    rows.push(...(json.data ?? []));
    nextUrl = json.paging?.next ?? "";
  }

  return rows;
}

