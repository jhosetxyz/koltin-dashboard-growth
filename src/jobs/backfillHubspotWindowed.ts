import "dotenv/config";
import { getSupabaseClient } from "../lib/supabase";
import { runSyncHubspotContacts, type RunSyncHubspotContactsParams } from "./syncHubspotContacts";
import type { HubSpotSearchMode } from "../connectors/hubspot";

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

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysUtc(dateStr: string, days: number): string {
  const ms = parseUtcDateStartMs(dateStr);
  const next = new Date(ms);
  next.setUTCDate(next.getUTCDate() + days);
  return formatDateUtc(next);
}

function minDate(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? a : b;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCorrelationId(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  if ("correlationId" in err) {
    const v = (err as any).correlationId;
    return v ? String(v) : null;
  }
  return null;
}

async function getMaxTimestamps() {
  const supabase = getSupabaseClient();

  const { data: maxCreated, error: maxCreatedError } = await supabase
    .from("hubspot_contacts")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (maxCreatedError) throw maxCreatedError;

  const { data: maxOldCreated, error: maxOldCreatedError } = await supabase
    .from("hubspot_contacts")
    .select("old_created_at")
    .order("old_created_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (maxOldCreatedError) throw maxOldCreatedError;

  const { count: nullOldCount, error: nullOldCountError } = await supabase
    .from("hubspot_contacts")
    .select("hubspot_contact_id", { count: "exact", head: true })
    .is("old_created_at", null);
  if (nullOldCountError) throw nullOldCountError;

  return {
    max_created_at: (maxCreated?.[0] as any)?.created_at ?? null,
    max_old_created_at: (maxOldCreated?.[0] as any)?.old_created_at ?? null,
    old_created_at_nulls: nullOldCount ?? null,
  };
}

async function main() {
  const since = parseArgValue("since");
  const until = parseArgValue("until");
  if (!since || !until) {
    throw new Error("Missing required args: --since=YYYY-MM-DD --until=YYYY-MM-DD");
  }

  const windowDaysRaw =
    parseArgValue("window_days") ?? parseArgValue("windowDays") ?? "7";
  const window_days = Number(windowDaysRaw);
  if (!Number.isFinite(window_days) || window_days <= 0) {
    throw new Error(`Invalid --window_days: ${windowDaysRaw}`);
  }

  const mode = (parseArgValue("mode") ?? "lastmodifieddate") as HubSpotSearchMode;

  // Build windows
  let cursor = since;
  const windows: Array<{ start: string; end: string }> = [];
  while (cursor.localeCompare(until) < 0) {
    const end = minDate(addDaysUtc(cursor, window_days), until);
    windows.push({ start: cursor, end });
    cursor = end;
  }

  const failed_windows: Array<{
    window_since: string;
    window_until: string;
    attempts: number;
    error: string;
    correlationId: string | null;
  }> = [];

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "backfillHubspotWindowed",
        mode,
        since,
        until,
        window_days,
        windows: windows.length,
      },
      null,
      2,
    ),
  );

  for (const w of windows) {
    const baseParams: RunSyncHubspotContactsParams = {
      mode,
      since: w.start,
      until: w.end,
      logPages: false,
    };

    let attempt = 0;
    const maxAttempts = 3; // 1 + 2 retries

    for (;;) {
      attempt++;
      try {
        const result = await runSyncHubspotContacts(baseParams);
        const maxes = await getMaxTimestamps();

        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              job: "backfillHubspotWindowed",
              window_since: w.start,
              window_until: w.end,
              mode,
              attempt,
              fetched: result.fetched,
              upserted: result.upserted,
              sync_minCreatedAt: result.minCreatedAt,
              sync_maxCreatedAt: result.maxCreatedAt,
              db_max_created_at: maxes.max_created_at,
              db_max_old_created_at: maxes.max_old_created_at,
              db_old_created_at_nulls: maxes.old_created_at_nulls,
            },
            null,
            2,
          ),
        );
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const correlationId = getCorrelationId(err);

        if (attempt >= maxAttempts) {
          failed_windows.push({
            window_since: w.start,
            window_until: w.end,
            attempts: attempt,
            error: message,
            correlationId,
          });

          // eslint-disable-next-line no-console
          console.error(
            JSON.stringify(
              {
                job: "backfillHubspotWindowed",
                window_since: w.start,
                window_until: w.end,
                mode,
                status: "failed",
                attempts: attempt,
                correlationId,
                error: message,
                hint:
                  message.includes("deep paging limit") || message.includes("after=")
                    ? "Reduce window_days (ej. 3 o 1) para esta ventana."
                    : null,
              },
              null,
              2,
            ),
          );
          break; // continue to next window
        }

        const backoffMs =
          Math.min(15_000, 500 * Math.pow(2, attempt - 1)) +
          Math.floor(Math.random() * 250);

        // eslint-disable-next-line no-console
        console.warn(
          JSON.stringify(
            {
              job: "backfillHubspotWindowed",
              window_since: w.start,
              window_until: w.end,
              mode,
              status: "retrying",
              attempt,
              correlationId,
              error: message,
              backoffMs,
            },
            null,
            2,
          ),
        );
        await sleep(backoffMs);
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "backfillHubspotWindowed",
        status: failed_windows.length === 0 ? "ok" : "completed_with_failures",
        failed_windows,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify(
      {
        job: "backfillHubspotWindowed",
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

