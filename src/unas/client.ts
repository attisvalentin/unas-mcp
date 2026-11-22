import type { UnasConfig } from "../config.js";
import {
  UnasApiError,
  UnasAuthGuardError,
  UnasBanError,
  UnasError,
  UnasFailureGuardError,
  UnasRateLimitError,
} from "./errors.js";
import { zonedToUtc } from "../util/dates.js";
import { GLOBAL_LIMIT, LOGIN_LIMIT, limitsFor } from "./limits.js";
import { asArray, buildXml, parseXml, type XmlObject } from "./xml.js";

type FetchLike = typeof fetch;

const HOUR_MS = 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** UNAS bans the IP for all webshops (2 h) after 10 unidentifiable calls in 10 minutes; we stop well before. */
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_FAILURE_LIMIT = 3;

export interface LoginInfo {
  token: string;
  expiresAt: number; // epoch ms
  shopId?: string;
  subscription?: string;
  permissions: string[];
  apiKeyExpire?: string;
  webshopInfo?: XmlObject;
}

export type CallKind = "single" | "bulk";

export interface CallOptions {
  /** Which documented limit bucket this call counts against. */
  kind: CallKind;
  /** Cache the parsed response for this many ms (read calls only). */
  cacheTtlMs?: number;
}

/** Sliding one-hour window counters, one per bucket. */
class HourlyBudget {
  private hits = new Map<string, number[]>();
  constructor(private now: () => number) {}

  private window(bucket: string): number[] {
    const cutoff = this.now() - HOUR_MS;
    const list = (this.hits.get(bucket) ?? []).filter((t) => t > cutoff);
    this.hits.set(bucket, list);
    return list;
  }

  /** Returns seconds to wait if the bucket is full, otherwise 0. */
  check(bucket: string, limit: number): number {
    const list = this.window(bucket);
    if (list.length < limit) return 0;
    return Math.max(1, Math.ceil((list[0] + HOUR_MS - this.now()) / 1000));
  }

  record(bucket: string) {
    this.window(bucket).push(this.now());
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of [...this.hits.keys()].sort()) {
      const n = this.window(key).length;
      if (n > 0) out[key] = n;
    }
    return out;
  }
}

export class UnasClient {
  private login_?: LoginInfo;
  private loginInFlight?: Promise<LoginInfo>;
  private budget: HourlyBudget;
  private failures = new Map<string, { count: number; last: number }>();
  private cache = new Map<string, { at: number; value: XmlObject }>();
  private bans = new Map<string, { message: string; until: number }>();
  private authFailures: number[] = [];
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(
    readonly config: UnasConfig,
    private fetchImpl: FetchLike = fetch,
    private now: () => number = Date.now
  ) {
    this.budget = new HourlyBudget(now);
  }

  /** Throws if too many authentication failures happened recently. */
  private checkAuthFailures() {
    const cutoff = this.now() - AUTH_WINDOW_MS;
    this.authFailures = this.authFailures.filter((t) => t > cutoff);
    if (this.authFailures.length >= AUTH_FAILURE_LIMIT) {
      const wait = Math.max(1, Math.ceil((this.authFailures[0] + AUTH_WINDOW_MS - this.now()) / 1000));
      throw new UnasAuthGuardError(this.authFailures.length, wait);
    }
  }

  private noteAuthFailure() {
    this.authFailures.push(this.now());
  }

  /** Limit parallel requests: UNAS allows at most 5 concurrent API requests per IP per webshop. */
  private async acquireSlot() {
    if (this.active < this.config.maxConcurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private releaseSlot() {
    const next = this.waiting.shift();
    if (next) next(); // hand the slot over directly
    else this.active--;
  }

  // ---------------------------------------------------------------- auth

  async getLogin(force = false): Promise<LoginInfo> {
    if (!force && this.login_ && this.login_.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
      return this.login_;
    }
    if (!this.loginInFlight) {
      this.loginInFlight = this.doLogin().finally(() => (this.loginInFlight = undefined));
    }
    return this.loginInFlight;
  }

  private async doLogin(): Promise<LoginInfo> {
    const sub = this.config.subscription;
    const ban = this.bans.get("login");
    if (ban && ban.until > this.now()) throw new UnasBanError("login", ban.message);
    this.checkAuthFailures();
    this.reserve("login", [
      ["login", Math.floor(LOGIN_LIMIT[sub] * this.config.rateSafety)],
      ["global", Math.floor(GLOBAL_LIMIT[sub] * this.config.rateSafety)],
    ]);
    const body = buildXml("Params", { ApiKey: this.config.apiKey, WebshopInfo: "true" });
    let doc: XmlObject;
    try {
      doc = await this.post("login", body, undefined);
    } catch (err) {
      // A rejected login is an "unidentifiable" call for UNAS; network errors and bans are not.
      if (err instanceof UnasApiError) this.noteAuthFailure();
      throw err;
    }
    const root = firstObject(doc);
    const token = str(root.Token);
    if (!token) {
      this.noteAuthFailure();
      throw new UnasApiError("login", "Login response did not contain a token", 200);
    }
    this.authFailures = [];
    const expireTime = Number(root.ExpireTime);
    const info: LoginInfo = {
      token,
      // Documented validity is 2 hours; fall back to that if ExpireTime is missing.
      expiresAt: Number.isFinite(expireTime) && expireTime > 0 ? expireTime * 1000 : this.now() + 2 * HOUR_MS,
      shopId: str(root.ShopId),
      subscription: str(root.Subscription),
      permissions: asArray<string>((root.Permissions as XmlObject | undefined)?.Permission).map(String),
      apiKeyExpire: str(root.ApiKeyExpire),
      webshopInfo: root.WebshopInfo as XmlObject | undefined,
    };
    this.login_ = info;
    return info;
  }

  // --------------------------------------------------------------- calls

  /**
   * Call a UNAS endpoint. `root` is the request document element ("Params", "Orders", ...).
   * Handles token refresh, local rate budgets, failure guard, ban detection and caching.
   */
  async call(endpoint: string, root: string, body: XmlObject, opts: CallOptions): Promise<XmlObject> {
    const xml = buildXml(root, body);
    const cacheKey = opts.cacheTtlMs ? `${endpoint}\n${xml}` : undefined;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit && this.now() - hit.at < opts.cacheTtlMs!) return hit.value;
    }

    const ban = this.bans.get(endpoint);
    if (ban) {
      if (ban.until > this.now()) throw new UnasBanError(endpoint, ban.message);
      this.bans.delete(endpoint);
    }

    const sub = this.config.subscription;
    const safety = this.config.rateSafety;
    const limit = limitsFor(endpoint)[opts.kind][sub];
    const bucket = `${endpoint}:${opts.kind}`;
    const buckets: Array<[string, number]> = [
      [bucket, Math.max(1, Math.floor(limit * safety))],
      ["global", Math.floor(GLOBAL_LIMIT[sub] * safety)],
    ];
    this.checkFailures(endpoint);
    this.checkAuthFailures();
    // Reserve the budget synchronously, before any await, so concurrent calls cannot all pass the check.
    this.reserve(endpoint, buckets);

    let login = await this.getLogin();
    let result: XmlObject;
    try {
      result = await this.post(endpoint, xml, login.token);
    } catch (err) {
      if (err instanceof UnasApiError && looksLikeAuthError(err)) {
        this.noteAuthFailure();
        login = await this.getLogin(true);
        this.reserve(endpoint, buckets); // the retry is a real call and counts against the limits too
        try {
          result = await this.post(endpoint, xml, login.token);
        } catch (retryErr) {
          if (retryErr instanceof UnasApiError && looksLikeAuthError(retryErr)) this.noteAuthFailure();
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
    if (cacheKey) this.cache.set(cacheKey, { at: this.now(), value: result });
    return result;
  }

  /** Drop cached responses of one endpoint (exact name, so getCustomer does not also clear getCustomerGroup), or all. */
  invalidateCache(endpoint?: string) {
    for (const key of this.cache.keys()) {
      if (!endpoint || key.startsWith(endpoint + "\n")) this.cache.delete(key);
    }
  }

  status() {
    const sub = this.config.subscription;
    const failures: Record<string, number> = {};
    for (const [ep, f] of this.failures) if (f.count > 0) failures[ep] = f.count;
    return {
      subscription: sub,
      safetyFactor: this.config.rateSafety,
      globalLimitPerHour: GLOBAL_LIMIT[sub],
      callsLastHourByBucket: this.budget.snapshot(),
      consecutiveFailures: failures,
      activeBans: Object.fromEntries(
        [...this.bans]
          .filter(([, b]) => b.until > this.now())
          .map(([ep, b]) => [ep, { message: b.message, until: new Date(b.until).toISOString() }])
      ),
      token: this.login_
        ? { valid: this.login_.expiresAt > this.now(), expiresAt: new Date(this.login_.expiresAt).toISOString() }
        : { valid: false },
      note: "Counters only include calls made by this server process; other integrations using the same IP share the UNAS limits.",
    };
  }

  // ------------------------------------------------------------ internals

  /** Check all buckets first, then record in all of them: either the whole call is admitted or nothing is counted. */
  private reserve(endpoint: string, buckets: Array<[bucket: string, limit: number]>) {
    for (const [bucket, limit] of buckets) {
      const wait = this.budget.check(bucket, limit);
      if (wait > 0) throw new UnasRateLimitError(endpoint, bucket, wait, limit);
    }
    for (const [bucket] of buckets) this.budget.record(bucket);
  }

  /** Ban expiry from the UNAS message; falls back to one hour from now if it cannot be read or is already past. */
  private banUntil(message: string): number {
    const parsed = parseBanUntil(message, this.config.timezone);
    return parsed !== undefined && parsed > this.now() ? parsed : this.now() + HOUR_MS;
  }

  private checkFailures(endpoint: string) {
    const f = this.failures.get(endpoint);
    if (!f) return;
    if (this.now() - f.last > HOUR_MS) {
      this.failures.delete(endpoint);
      return;
    }
    if (f.count >= this.config.failureGuard) throw new UnasFailureGuardError(endpoint, f.count);
  }

  private noteResult(endpoint: string, ok: boolean) {
    if (ok) {
      this.failures.delete(endpoint);
      return;
    }
    const f = this.failures.get(endpoint) ?? { count: 0, last: 0 };
    f.count += 1;
    f.last = this.now();
    this.failures.set(endpoint, f);
  }

  /** Raw HTTP call. The caller must have reserved the rate budget already. */
  private async post(endpoint: string, xml: string, token: string | undefined): Promise<XmlObject> {
    const headers: Record<string, string> = {
      "Content-Type": "application/xml; charset=UTF-8",
      Accept: "application/xml",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    let text: string;
    await this.acquireSlot();
    try {
      res = await this.fetchImpl(this.config.baseUrl + endpoint, {
        method: "POST",
        headers,
        body: xml,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      text = await res.text();
    } catch (err) {
      // Network errors never reached UNAS' failure counter, but count them locally anyway.
      this.noteResult(endpoint, false);
      const msg = err instanceof Error ? err.message : String(err);
      throw new UnasError(`Network error calling UNAS ${endpoint}: ${msg}`, endpoint);
    } finally {
      this.releaseSlot();
    }

    let doc: XmlObject | undefined;
    try {
      doc = text.trim() ? parseXml(text) : {};
    } catch {
      doc = undefined;
    }

    const errorMessage = extractError(doc);
    if (!res.ok || errorMessage !== undefined) {
      this.noteResult(endpoint, false);
      const message = errorMessage ?? (text.slice(0, 500) || res.statusText);
      if (/banned/i.test(message)) {
        this.bans.set(endpoint, { message, until: this.banUntil(message) });
        throw new UnasBanError(endpoint, message);
      }
      throw new UnasApiError(endpoint, message, res.status);
    }
    if (!doc) {
      this.noteResult(endpoint, false);
      throw new UnasApiError(endpoint, `Unparseable response: ${text.slice(0, 300)}`, res.status);
    }
    this.noteResult(endpoint, true);
    return doc;
  }
}

// ---------------------------------------------------------------- helpers

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
}

function firstObject(doc: XmlObject): XmlObject {
  // Responses have a single root element; return its content.
  const keys = Object.keys(doc);
  if (keys.length === 1 && doc[keys[0]] && typeof doc[keys[0]] === "object") return doc[keys[0]] as XmlObject;
  return doc;
}

function extractError(doc: XmlObject | undefined): string | undefined {
  if (!doc) return undefined;
  if (doc.Error !== undefined) return String(flatten(doc.Error));
  return undefined;
}

function flatten(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(flatten).join("; ");
  return Object.values(v as XmlObject).map(flatten).join("; ");
}

function looksLikeAuthError(err: UnasApiError): boolean {
  return err.httpStatus === 401 || /token|auth|login/i.test(err.apiMessage);
}

/**
 * "IP is banned till 02.28.2022 10:00:00" -> epoch ms, read as wall-clock time in the shop's time zone.
 * The documented example is MM.DD.YYYY; if the first number cannot be a month, DD.MM.YYYY is assumed.
 */
export function parseBanUntil(message: string, timeZone: string): number | undefined {
  const m = message.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.?\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, a, b, yyyy, h, mi, s] = m.map(Number);
  let month = a;
  let day = b;
  if (month > 12 && day <= 12) [month, day] = [b, a];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  try {
    const t = zonedToUtc(yyyy, month, day, h, mi, s, timeZone);
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}
