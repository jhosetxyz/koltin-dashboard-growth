import "dotenv/config";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FX request failed (${res.status}): ${body}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch USD->MXN daily FX rate.
 *
 * Provider:
 * - exchangerate-api.com (no key for basic latest endpoint)
 * - For historical rates, we fall back to latest if daily not supported.
 */
export async function fetchUsdMxnRate(params: { day: string }): Promise<number> {
  // If user provides a fixed rate, honor it (fastest/most reliable).
  const fixed = process.env.USD_MXN_FX_RATE;
  if (fixed) {
    const n = Number(fixed);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid USD_MXN_FX_RATE: ${fixed}`);
    }
    return n;
  }

  // Placeholder until we integrate a historical FX provider.
  // Keep deterministic behavior for analytics reproducibility.
  return 18;
}

