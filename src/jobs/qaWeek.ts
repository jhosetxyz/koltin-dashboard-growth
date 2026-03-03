import "dotenv/config";
import { getSupabaseClient } from "../lib/supabase";

function parseArgValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function parseUtcDateStart(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split("-").map((x) => Number(x));
  if (!y || !m || !d) throw new Error(`Invalid date: ${yyyyMmDd}`);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

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

function normalizeToMondayUtc(dateStr: string): { normalized: string; adjusted: boolean } {
  const d = parseUtcDateStart(dateStr);
  const monday = getUtcWeekStartMonday(d);
  const normalized = formatDateUtc(monday);
  return { normalized, adjusted: normalized !== dateStr };
}

type DecisionRow = {
  week_start: string;
  platform: string;
  canonical_campaign: string;
  canonical_subgroup: string;
  spend: number | null;
  leads: number | null;
  mql: number | null;
  int_plus: number | null;
  call_rate: number | null;
  quality_index: number | null;
  prev_spend: number | null;
  prev_leads: number | null;
  prev_quality_index: number | null;
  delta_spend_pct: number | null;
  delta_quality_index: number | null;
  delta_call_rate: number | null;
  volume_flag: string | null;
  trend_flag: string | null;
  decision: string | null;
  decision_reason: string | null;
  decision_confidence: string | null;
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function qaWeek() {
  const supabase = getSupabaseClient();

  const weekStartArg = parseArgValue("week_start");
  if (!weekStartArg) throw new Error("Missing --week_start=YYYY-MM-DD");

  const normalized = normalizeToMondayUtc(weekStartArg);
  const weekStart = normalized.normalized;

  const { data, error } = await supabase
    .from("weekly_campaign_decisions")
    .select(
      [
        "week_start",
        "platform",
        "canonical_campaign",
        "canonical_subgroup",
        "spend",
        "leads",
        "mql",
        "int_plus",
        "call_rate",
        "quality_index",
        "prev_spend",
        "prev_leads",
        "prev_quality_index",
        "delta_spend_pct",
        "delta_quality_index",
        "delta_call_rate",
        "volume_flag",
        "trend_flag",
        "decision",
        "decision_reason",
        "decision_confidence",
      ].join(","),
    )
    .eq("week_start", weekStart);

  if (error) throw error;
  const rows = (data ?? []) as unknown as DecisionRow[];

  const byPlatform = {
    meta: rows.filter((r) => r.platform === "meta"),
    google: rows.filter((r) => r.platform === "google"),
  };

  const top = (platform: "meta" | "google") =>
    [...byPlatform[platform]]
      .sort((a, b) => n(b.spend) - n(a.spend))
      .slice(0, 20);

  const scale = rows
    .filter((r) => r.decision === "scale")
    .sort((a, b) => n(b.spend) - n(a.spend));

  const cut = rows
    .filter((r) => r.decision === "cut")
    .sort((a, b) => n(b.spend) - n(a.spend));

  const summary: Record<string, { campaigns: number; spend: number; leads: number }> = {};
  for (const r of rows) {
    const key = String(r.decision ?? "unknown");
    if (!summary[key]) summary[key] = { campaigns: 0, spend: 0, leads: 0 };
    summary[key].campaigns += 1;
    summary[key].spend += n(r.spend);
    summary[key].leads += n(r.leads);
  }

  const anomalies = rows
    .filter((r) => {
      const spend = n(r.spend);
      const leads = n(r.leads);
      const dqi = r.delta_quality_index ?? 0;
      return (
        (spend > 0 && leads === 0) ||
        (leads > 0 && spend === 0) ||
        (leads < 10 && Math.abs(Number(dqi) || 0) >= 15)
      );
    })
    .sort((a, b) => n(b.spend) - n(a.spend));

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        job: "qaWeek",
        week_start_input: weekStartArg,
        week_start: weekStart,
        normalized: normalized.adjusted,
        rows: rows.length,
        top_meta: top("meta"),
        top_google: top("google"),
        scale,
        cut,
        summary_by_decision: summary,
        anomalies,
      },
      null,
      2,
    ),
  );
}

qaWeek().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify(
      {
        job: "qaWeek",
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

