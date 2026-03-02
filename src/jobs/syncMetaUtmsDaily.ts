import "dotenv/config";
import { fetchMetaActiveAdsWithTracking } from "../connectors/meta";
import { getSupabaseClient } from "../lib/supabase";

type UTMStatus = "ok" | "missing" | "malformed" | "inconsistent";

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

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeRawParams(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Accept raw like "?utm_source=..." or "utm_source=..." or "&utm_source=..."
  const noPrefix = trimmed.replace(/^[?&]+/, "");
  return noPrefix;
}

function parseUtmParams(raw: string) {
  const normalized = normalizeRawParams(raw);
  if (!normalized) return { utms: null as null, malformed: false };

  try {
    const params = new URLSearchParams(normalized);
    const utm_source = params.get("utm_source");
    const utm_medium = params.get("utm_medium");
    const utm_campaign = params.get("utm_campaign");
    const utm_content = params.get("utm_content");
    const utm_term = params.get("utm_term");

    const any =
      utm_source !== null ||
      utm_medium !== null ||
      utm_campaign !== null ||
      utm_content !== null ||
      utm_term !== null;

    if (!any) return { utms: null as null, malformed: false };

    const values = [utm_source, utm_medium, utm_campaign, utm_content, utm_term]
      .filter((v): v is string => typeof v === "string")
      .join("|");
    const hasMacros = values.includes("{{") || values.includes("}}");

    return {
      utms: {
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
      },
      malformed: hasMacros,
    };
  } catch {
    return { utms: null as null, malformed: true };
  }
}

function pickUrlParamsCandidates(ad: any): string[] {
  const candidates: Array<string | null | undefined> = [
    ad?.url_parameters,
    ad?.url_tags,
    ad?.creative?.url_parameters,
    ad?.creative?.url_tags,
    ad?.creative?.object_url,
  ];

  const out: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    out.push(String(c));
  }
  return Array.from(new Set(out));
}

function decideStatusAndUtms(candidates: string[]) {
  if (candidates.length === 0) {
    return {
      status: "missing" as UTMStatus,
      utms: {
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        utm_content: null,
        utm_term: null,
      },
      url_params_raw: null as string | null,
    };
  }

  const parsed = candidates.map((raw) => ({
    raw,
    ...parseUtmParams(raw),
  }));

  const usable = parsed.filter((p) => p.utms !== null);
  const malformedAny = parsed.some((p) => p.malformed);

  if (usable.length === 0) {
    return {
      status: malformedAny ? ("malformed" as UTMStatus) : ("missing" as UTMStatus),
      utms: {
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        utm_content: null,
        utm_term: null,
      },
      url_params_raw: candidates[0] ?? null,
    };
  }

  const fingerprint = (u: any) =>
    JSON.stringify({
      utm_source: u.utm_source,
      utm_medium: u.utm_medium,
      utm_campaign: u.utm_campaign,
      utm_content: u.utm_content,
      utm_term: u.utm_term,
    });

  const unique = new Set(usable.map((p) => fingerprint(p.utms)));
  const inconsistent = unique.size > 1;

  const chosen = usable[0]!;
  return {
    status: inconsistent
      ? ("inconsistent" as UTMStatus)
      : malformedAny
        ? ("malformed" as UTMStatus)
        : ("ok" as UTMStatus),
    utms: chosen.utms!,
    url_params_raw: chosen.raw ?? candidates[0] ?? null,
  };
}

async function syncMetaUtmsDaily() {
  const supabase = getSupabaseClient();
  const accountId = requiredEnv("META_AD_ACCOUNT_ID");

  const dateSeen =
    parseArgValue("date") ??
    formatDateUtc(new Date()); // UTC today

  const ads = await fetchMetaActiveAdsWithTracking();

  const nowIso = new Date().toISOString();

  const rows = ads.map((ad: any) => {
    const candidates = pickUrlParamsCandidates(ad);
    const decided = decideStatusAndUtms(candidates);

    return {
      date_seen: dateSeen,
      account_id: accountId,
      campaign_id: ad.campaign_id ?? ad.campaign?.id ?? null,
      adset_id: ad.adset_id ?? ad.adset?.id ?? null,
      ad_id: ad.id,
      campaign_name: ad.campaign?.name ?? null,
      adset_name: ad.adset?.name ?? null,
      ad_name: ad.name ?? null,
      utm_source: decided.utms.utm_source,
      utm_medium: decided.utms.utm_medium,
      utm_campaign: decided.utms.utm_campaign,
      utm_content: decided.utms.utm_content,
      utm_term: decided.utms.utm_term,
      url_params_raw: decided.url_params_raw,
      status: decided.status,
      last_seen_at: nowIso,
    };
  });

  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  let upserted = 0;
  if (rows.length > 0) {
    const { error, data } = await supabase
      .from("meta_utm_registry")
      .upsert(rows, { onConflict: "account_id,ad_id,date_seen" })
      .select("account_id,ad_id,date_seen");
    if (error) throw error;
    upserted = data?.length ?? 0;
  }

  // Optional anomalies report
  if (rows.length > 0) {
    const anomalyCounts = new Map<string, number>();
    for (const r of rows) {
      const key = JSON.stringify({
        date_seen: dateSeen,
        account_id: accountId,
        platform: "meta",
        campaign_id: r.campaign_id ?? null,
        status: r.status,
      });
      anomalyCounts.set(key, (anomalyCounts.get(key) ?? 0) + 1);
    }

    const anomalyRows = Array.from(anomalyCounts.entries()).map(([k, count]) => {
      const parsed = JSON.parse(k) as {
        date_seen: string;
        account_id: string;
        platform: string;
        campaign_id: string | null;
        status: string;
      };
      return { ...parsed, count, generated_at: nowIso };
    });

    const { error: anomalyError } = await supabase
      .from("utm_anomalies")
      .upsert(anomalyRows, {
        onConflict: "date_seen,account_id,platform,campaign_id,status",
      });
    if (anomalyError) throw anomalyError;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "syncMetaUtmsDaily",
        dateSeen,
        fetchedAds: ads.length,
        upsertedRows: upserted,
        statusCounts,
      },
      null,
      2,
    ),
  );
}

syncMetaUtmsDaily().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

