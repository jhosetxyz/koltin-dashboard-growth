import "dotenv/config";
import {
  runSyncHubspotContacts,
  type RunSyncHubspotContactsParams,
} from "../jobs/syncHubspotContacts";
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minDate(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? a : b;
}

async function runWindow(params: RunSyncHubspotContactsParams) {
  return await runSyncHubspotContacts({ ...params, logPages: false });
}

async function main() {
  const since = parseArgValue("since");
  const until = parseArgValue("until");
  if (!since || !until) {
    throw new Error("Missing required args: --since=YYYY-MM-DD --until=YYYY-MM-DD");
  }

  const windowDays = Number(parseArgValue("windowDays") ?? 7);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error(`Invalid --windowDays: ${windowDays}`);
  }

  const mode = (parseArgValue("mode") ?? "createdate") as HubSpotSearchMode;

  let cursor = since;
  const windows: Array<{ start: string; end: string }> = [];
  while (cursor.localeCompare(until) < 0) {
    const end = minDate(addDaysUtc(cursor, windowDays), until);
    windows.push({ start: cursor, end });
    cursor = end;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        script: "backfillHubspotContacts",
        mode,
        since,
        until,
        windowDays,
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
        const result = await runWindow(baseParams);
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              script: "backfillHubspotContacts",
              windowStart: w.start,
              windowEnd: w.end,
              mode,
              attempt,
              fetchedRows: result.fetched,
              upsertedRows: result.upserted,
              minCreatedAt: result.minCreatedAt,
              maxCreatedAt: result.maxCreatedAt,
            },
            null,
            2,
          ),
        );
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= maxAttempts) {
          // eslint-disable-next-line no-console
          console.error(
            JSON.stringify(
              {
                script: "backfillHubspotContacts",
                windowStart: w.start,
                windowEnd: w.end,
                mode,
                status: "failed",
                attempts: attempt,
                error: message,
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
              script: "backfillHubspotContacts",
              windowStart: w.start,
              windowEnd: w.end,
              mode,
              status: "retrying",
              attempt,
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
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

