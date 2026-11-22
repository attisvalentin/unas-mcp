export type Subscription = "premium" | "vip";

export interface UnasConfig {
  apiKey: string;
  baseUrl: string;
  subscription: Subscription;
  readOnly: boolean;
  timezone: string;
  /** Fraction of the documented hourly limits we allow ourselves to use (0..1]. */
  rateSafety: number;
  /** Stop calling an endpoint locally after this many consecutive failures (UNAS bans at 20). */
  failureGuard: number;
  requestTimeoutMs: number;
  /** TTL for cached read-only reference data (statuses, methods, categories). */
  cacheTtlMs: number;
  maxOutputChars: number;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in environment: ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): UnasConfig {
  const apiKey = env.UNAS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "UNAS_API_KEY is not set. Create an API key in the UNAS admin under " +
        "Beállítások / Külső kapcsolatok / API kapcsolat and pass it as UNAS_API_KEY."
    );
  }
  const sub = (env.UNAS_SUBSCRIPTION ?? "premium").toLowerCase();
  if (sub !== "premium" && sub !== "vip") {
    throw new Error(`UNAS_SUBSCRIPTION must be "premium" or "vip", got "${sub}"`);
  }
  const rateSafety = num(env.UNAS_RATE_SAFETY, 0.9);
  if (rateSafety <= 0 || rateSafety > 1) throw new Error("UNAS_RATE_SAFETY must be in (0, 1]");

  return {
    apiKey,
    baseUrl: (env.UNAS_BASE_URL ?? "https://api.unas.eu/shop/").replace(/\/?$/, "/"),
    subscription: sub,
    readOnly: bool(env.UNAS_READ_ONLY, false),
    timezone: env.UNAS_TIMEZONE ?? "Europe/Budapest",
    rateSafety,
    failureGuard: num(env.UNAS_FAILURE_GUARD, 15),
    requestTimeoutMs: num(env.UNAS_TIMEOUT_MS, 60_000),
    cacheTtlMs: num(env.UNAS_CACHE_TTL_SECONDS, 600) * 1000,
    maxOutputChars: num(env.UNAS_MAX_OUTPUT_CHARS, 80_000),
  };
}
