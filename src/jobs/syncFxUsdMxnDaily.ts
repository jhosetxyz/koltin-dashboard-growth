import "dotenv/config";
import { getSupabaseClient } from "../lib/supabase";
import { fetchUsdMxnRate } from "../connectors/fx";

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseArgValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function syncFxUsdMxnDaily() {
  const supabase = getSupabaseClient();

  const day =
    parseArgValue("day") ??
    (() => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - 1);
      return formatDateUtc(d);
    })();

  const rate = await fetchUsdMxnRate({ day });

  const { error } = await supabase.from("fx_rates_daily").upsert(
    [
      {
        day,
        base: "USD",
        quote: "MXN",
        rate,
        provider: process.env.USD_MXN_FX_RATE ? "env" : "placeholder",
      },
    ],
    { onConflict: "day,base,quote" },
  );
  if (error) throw error;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ job: "syncFxUsdMxnDaily", day, rate }, null, 2),
  );
}

syncFxUsdMxnDaily().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

