import "dotenv/config";
import { getSupabaseClient } from "../lib/supabase";

function parseArgValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function parseBool(v: string | null | undefined, defaultValue: boolean): boolean {
  if (v === null || v === undefined) return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return defaultValue;
}

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseUtcDateStart(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split("-").map((x) => Number(x));
  if (!y || !m || !d) throw new Error(`Invalid date: ${yyyyMmDd}`);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

function getUtcWeekStartMonday(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  const day = copy.getUTCDay(); // 0..6 (Sun..Sat)
  const diffToMonday = (day + 6) % 7; // Mon=0, Sun=6
  copy.setUTCDate(copy.getUTCDate() - diffToMonday);
  return copy;
}

function normalizeToMondayUtc(dateStr: string): {
  normalized: string;
  inputDow: number;
  adjusted: boolean;
} {
  const d = parseUtcDateStart(dateStr);
  const inputDow = d.getUTCDay(); // Mon=1
  const monday = getUtcWeekStartMonday(d);
  const normalized = formatDateUtc(monday);
  return { normalized, inputDow, adjusted: normalized !== dateStr };
}

type WeeklyRow = {
  week_start: string;
  week_end: string | null;
  platform: string | null;
  utm_campaign: string | null;
  canonical_campaign?: string | null;
  canonical_subgroup?: string | null;
  spend: string | number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: string | number | null;
  cpc: string | number | null;
  leads_created: number | null;
  cpl: string | number | null;
  whatsapp_no_response_count: number | null;
  call_done_count: number | null;
  mql_count: number | null;
  disqualified_count: number | null;
  call_rate: string | number | null;
  quality_ratio: string | number | null;
  quality_index: string | number | null;
  generated_at: string | null;
};

type FrozenWeeklyRow = WeeklyRow & {
  frozen_at: string;
};

function normalizeForFrozen(r: WeeklyRow): FrozenWeeklyRow {
  const platform = r.platform ?? "meta";
  const canonical_campaign =
    r.canonical_campaign ?? r.utm_campaign ?? "unmapped";
  const canonical_subgroup = r.canonical_subgroup ?? "";
  const utm_campaign = r.utm_campaign ?? canonical_campaign;

  return {
    ...r,
    platform,
    canonical_campaign,
    canonical_subgroup,
    utm_campaign,
    frozen_at: new Date().toISOString(),
  };
}

async function opsWeeklyClose() {
  const supabase = getSupabaseClient();

  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const currentWeekStartDate = getUtcWeekStartMonday(todayUtc);
  const currentWeekStart = formatDateUtc(currentWeekStartDate);

  const sinceArg = parseArgValue("since");
  const untilArg = parseArgValue("until");
  const dryRun = parseBool(parseArgValue("dry_run"), false);

  const defaultWeeksBack = Number(process.env.OPS_WEEKS_BACK ?? 12);
  const defaultSince = formatDateUtc(
    getUtcWeekStartMonday(
      new Date(
        currentWeekStartDate.getTime() - defaultWeeksBack * 7 * 24 * 60 * 60 * 1000,
      ),
    ),
  );

  let sinceDate = sinceArg ?? defaultSince;
  const untilDate = untilArg ?? currentWeekStart; // end-exclusive; default only closed weeks
  if (sinceArg) {
    const n = normalizeToMondayUtc(sinceArg);
    if (n.adjusted) {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify(
          {
            job: "opsWeeklyClose",
            warning: "--since no cae en lunes UTC; normalizando al lunes de esa semana",
            sinceInput: sinceArg,
            sinceNormalized: n.normalized,
            dow: n.inputDow,
          },
          null,
          2,
        ),
      );
      sinceDate = n.normalized;
    }
  }

  // 1) Recompute weekly live for range
  const { data: computed, error: computeError } = await supabase.rpc(
    "compute_weekly_quality_by_campaign",
    { since_date: sinceDate, until_date: untilDate },
  );
  if (computeError) throw computeError;
  const rows = (computed ?? []) as WeeklyRow[];

  let liveUpserted = 0;
  if (!dryRun && rows.length > 0) {
    const { data: upsertData, error: upsertError } = await supabase
      .from("weekly_quality_by_campaign")
      .upsert(rows, {
        onConflict: "week_start,platform,canonical_campaign,canonical_subgroup",
      })
      .select("week_start");
    if (upsertError) throw upsertError;
    liveUpserted = upsertData?.length ?? 0;
  }

  const uniqueWeeks = Array.from(new Set(rows.map((r) => r.week_start))).sort();
  const closedWeeks = uniqueWeeks.filter((w) => w < currentWeekStart);

  const perWeekErrors: Array<{ week_start: string; step: string; error: string }> =
    [];

  let weeksFrozen = 0;
  let rowsInsertedFrozen = 0;
  let decisionsUpserted = 0;

  const frozenRowsByWeek = new Map<string, FrozenWeeklyRow[]>();
  for (const r of rows) {
    const wk = r.week_start;
    if (!wk) continue;
    if (!frozenRowsByWeek.has(wk)) frozenRowsByWeek.set(wk, []);
    frozenRowsByWeek.get(wk)!.push(normalizeForFrozen(r));
  }

  for (const wk of closedWeeks) {
    const rowsForWeek = frozenRowsByWeek.get(wk) ?? [];
    let didFreezeThisWeek = false;

    try {
      // Week-level "insert-once": if any row exists for this week, do not insert again.
      const { count, error: countError } = await supabase
        .from("weekly_quality_by_campaign_frozen")
        .select("week_start", { count: "exact", head: true })
        .eq("week_start", wk);
      if (countError) throw countError;

      if (dryRun) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              job: "opsWeeklyClose",
              week_start: wk,
              closed: true,
              alreadyFrozen: (count ?? 0) > 0,
              rowsWouldFreeze: (count ?? 0) > 0 ? 0 : rowsForWeek.length,
            },
            null,
            2,
          ),
        );
      } else if ((count ?? 0) === 0) {
        if (rowsForWeek.length > 0) {
          const { data: frozenData, error: frozenError } = await supabase
            .from("weekly_quality_by_campaign_frozen")
            .upsert(rowsForWeek, {
              onConflict: "week_start,platform,canonical_campaign,canonical_subgroup",
              ignoreDuplicates: true,
            })
            .select("week_start");
          if (frozenError) throw frozenError;
          const inserted = frozenData?.length ?? 0;
          rowsInsertedFrozen += inserted;
          didFreezeThisWeek = inserted > 0;
        } else {
          didFreezeThisWeek = true; // frozen as empty/no-data week (no rows to insert)
        }
      }
    } catch (err) {
      perWeekErrors.push({
        week_start: wk,
        step: "freeze",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      if (!dryRun) {
        const { data: decided, error: decideError } = await supabase.rpc(
          "compute_weekly_campaign_decisions",
          { target_week_start: wk },
        );
        if (decideError) throw decideError;
        decisionsUpserted += Number(decided ?? 0);
      }
    } catch (err) {
      perWeekErrors.push({
        week_start: wk,
        step: "decisions",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!dryRun && didFreezeThisWeek) weeksFrozen += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "opsWeeklyClose",
        since: sinceDate,
        until: untilDate,
        dryRun,
        currentWeekStart,
        weeksFound: closedWeeks.length,
        weeksFrozen,
        rowsInsertedFrozen,
        decisionsUpserted,
        liveRowsComputed: rows.length,
        liveRowsUpserted: liveUpserted,
        perWeekErrors,
      },
      null,
      2,
    ),
  );
}

opsWeeklyClose().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify(
      {
        job: "opsWeeklyClose",
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

