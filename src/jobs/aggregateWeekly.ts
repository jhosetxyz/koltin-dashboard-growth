import "dotenv/config";
import { getSupabaseClient } from "../lib/supabase";

type WeeklyAggregateResult = {
  inserted: number;
};

function getUtcWeekStart(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  const day = copy.getUTCDay(); // 0..6 (Sun..Sat)
  const diffToMonday = (day + 6) % 7; // Mon=0, Sun=6
  copy.setUTCDate(copy.getUTCDate() - diffToMonday);
  return copy;
}

async function aggregateWeekly(): Promise<WeeklyAggregateResult> {
  const supabase = getSupabaseClient();

  const weekStart = getUtcWeekStart(new Date());
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

  const { data, error } = await supabase
    .from("hubspot_contacts")
    .select("utm_campaign")
    .gte("created_at", weekStart.toISOString())
    .lt("created_at", weekEnd.toISOString());

  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const campaign = (row as { utm_campaign: string | null }).utm_campaign ?? "";
    counts.set(campaign, (counts.get(campaign) ?? 0) + 1);
  }

  if (counts.size === 0) return { inserted: 0 };

  const inserts = Array.from(counts.entries()).map(([utm_campaign, leads]) => ({
    week_start: weekStart.toISOString(),
    utm_campaign: utm_campaign === "" ? null : utm_campaign,
    leads_count: leads,
    quality_index: null,
  }));

  const { error: insertError } = await supabase
    .from("weekly_quality_by_campaign")
    .insert(inserts);

  if (insertError) throw insertError;
  return { inserted: inserts.length };
}

async function main() {
  const result = await aggregateWeekly();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ job: "aggregateWeekly", ...result }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

