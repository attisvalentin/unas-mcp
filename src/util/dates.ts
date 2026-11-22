/**
 * Convert user-friendly date input into a UNIX timestamp (seconds).
 * - "2026-11-19"            -> start (or end) of that day in the shop's time zone
 * - "2026-11-19T08:30"      -> that wall-clock time in the shop's time zone
 * - "2026-11-19T08:30:00Z"  -> exact instant (explicit offset wins)
 * - "1763535600"            -> passed through as a unix timestamp
 */
export function toUnix(input: string, timeZone: string, endOfDay = false): number {
  const s = input.trim();
  if (/^\d{9,11}$/.test(s)) return Number(s);

  const dateOnly = s.match(/^(\d{4})[-.](\d{2})[-.](\d{2})\.?$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly.map(Number);
    const base = zonedToUtc(y, m, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, timeZone);
    return Math.floor(base / 1000);
  }

  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  if (hasOffset) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`Unrecognised date/time: "${input}"`);
    return Math.floor(t / 1000);
  }

  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (local) {
    const [, y, m, d, h, mi, sec] = local.map((x) => (x === undefined ? 0 : Number(x)));
    return Math.floor(zonedToUtc(y, m, d, h, mi, sec, timeZone) / 1000);
  }
  throw new Error(`Unrecognised date/time: "${input}". Use YYYY-MM-DD, YYYY-MM-DDTHH:mm, ISO-8601 or a unix timestamp.`);
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}

export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  // Two passes handle DST transitions correctly in practice.
  let ts = guess - tzOffsetMs(guess, timeZone);
  ts = guess - tzOffsetMs(ts, timeZone);
  return ts;
}
