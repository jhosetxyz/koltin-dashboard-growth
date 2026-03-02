import "dotenv/config";
import { getSupabaseClient } from "../lib/supabase";

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getUtcWeekStartMonday(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  const day = copy.getUTCDay(); // 0..6 (Sun..Sat)
  const diffToMonday = (day + 6) % 7; // Mon=0, Sun=6
  copy.setUTCDate(copy.getUTCDate() - diffToMonday);
  return copy;
}

type WeeklyRow = {
  week_start: string;
  week_end: string | null;
  platform: string | null;
  utm_campaign: string | null;
  canonical_campaign?: string | null;
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

type UnmappedWeeklyRow = {
  week_start: string;
  raw_utm: string;
  leads: number;
  spend: string | number;
  inserted_at?: string | null;
};

async function aggregateWeeklyQualityByCampaign() {
  const supabase = getSupabaseClient();

  const weeksBack = Number(process.env.AGG_WEEKS_BACK ?? 12);
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const since = getUtcWeekStartMonday(
    new Date(todayUtc.getTime() - weeksBack * 7 * 24 * 60 * 60 * 1000),
  );
  const until = new Date(todayUtc);
  until.setUTCDate(until.getUTCDate() + 1); // include today, end-exclusive

  const sinceDate = formatDateUtc(since);
  const untilDate = formatDateUtc(until);

  const { data, error } = await supabase.rpc(
    "compute_weekly_quality_by_campaign",
    {
      since_date: sinceDate,
      until_date: untilDate,
    },
  );
  if (error) throw error;

  const rows = (data ?? []) as WeeklyRow[];
  const uniqueWeeks = Array.from(new Set(rows.map((r) => r.week_start))).sort();

  const { data: unmappedCountData, error: unmappedCountError } =
    await supabase.rpc("count_unmapped_utms", {
      since_date: sinceDate,
      until_date: untilDate,
    });
  if (unmappedCountError) throw unmappedCountError;
  const unmappedDistinct = Number(unmappedCountData ?? 0);

  const { data: topUnmappedData, error: topUnmappedError } = await supabase.rpc(
    "top_unmapped_utms",
    { since_date: sinceDate, until_date: untilDate, limit_n: 20 },
  );
  if (topUnmappedError) throw topUnmappedError;

  const { data: unmappedWeeklyData, error: unmappedWeeklyError } =
    await supabase.rpc("compute_utm_unmapped_weekly", {
      since_date: sinceDate,
      until_date: untilDate,
      limit_per_week: 50,
    });
  if (unmappedWeeklyError) throw unmappedWeeklyError;

  const unmappedWeeklyRows = (unmappedWeeklyData ?? []) as UnmappedWeeklyRow[];

  let unmappedUpserted = 0;
  if (unmappedWeeklyRows.length > 0) {
    const { data: unmappedUpsertData, error: unmappedUpsertError } = await supabase
      .from("utm_unmapped_weekly")
      .upsert(unmappedWeeklyRows, { onConflict: "week_start,raw_utm" })
      .select("week_start,raw_utm");
    if (unmappedUpsertError) throw unmappedUpsertError;
    unmappedUpserted = unmappedUpsertData?.length ?? 0;
  }

  const top10UnmappedByLeads = [...unmappedWeeklyRows]
    .sort((a, b) => (b.leads ?? 0) - (a.leads ?? 0))
    .slice(0, 10);
  const top10UnmappedBySpend = [...unmappedWeeklyRows]
    .sort((a, b) => Number(b.spend ?? 0) - Number(a.spend ?? 0))
    .slice(0, 10);

  let upserted = 0;
  if (rows.length > 0) {
    const { data: upsertData, error: upsertError } = await supabase
      .from("weekly_quality_by_campaign")
      .upsert(rows, { onConflict: "week_start,utm_campaign,platform" })
      .select("week_start,utm_campaign,platform");

    if (upsertError) throw upsertError;
    upserted = upsertData?.length ?? 0;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "aggregateWeeklyQualityByCampaign",
        since: sinceDate,
        until: untilDate,
        weeksProcessed: uniqueWeeks.length,
        rowsComputed: rows.length,
        rowsUpserted: upserted,
        unmappedDistinct,
        topUnmapped: topUnmappedData ?? [],
        unmappedWeeklyRowsComputed: unmappedWeeklyRows.length,
        unmappedWeeklyRowsUpserted: unmappedUpserted,
        top10UnmappedByLeads,
        top10UnmappedBySpend,
      },
      null,
      2,
    ),
  );
}

aggregateWeeklyQualityByCampaign().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

