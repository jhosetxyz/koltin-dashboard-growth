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

async function computeUtmGovernanceWeekly() {
  const supabase = getSupabaseClient();

  const weeksBack = Number(process.env.GOV_WEEKS_BACK ?? 8);
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const since = getUtcWeekStartMonday(
    new Date(todayUtc.getTime() - weeksBack * 7 * 24 * 60 * 60 * 1000),
  );
  const until = new Date(todayUtc);
  until.setUTCDate(until.getUTCDate() + 1); // end-exclusive

  const sinceDate = formatDateUtc(since);
  const untilDate = formatDateUtc(until);

  const { data, error } = await supabase.rpc("compute_utm_governance_weekly", {
    since_date: sinceDate,
    until_date: untilDate,
  });
  if (error) throw error;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "computeUtmGovernanceWeekly",
        since: sinceDate,
        until: untilDate,
        rowsUpserted: Number(data ?? 0),
      },
      null,
      2,
    ),
  );
}

computeUtmGovernanceWeekly().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

