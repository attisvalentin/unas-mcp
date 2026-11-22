export class UnasError extends Error {
  constructor(message: string, readonly endpoint?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The UNAS API returned an <Error> (usually HTTP 400). */
export class UnasApiError extends UnasError {
  constructor(endpoint: string, readonly apiMessage: string, readonly httpStatus: number) {
    super(`UNAS ${endpoint} failed (HTTP ${httpStatus}): ${apiMessage}`, endpoint);
  }
}

/** UNAS has banned this IP for the endpoint (1 hour). */
export class UnasBanError extends UnasError {
  constructor(endpoint: string, readonly apiMessage: string) {
    super(
      `UNAS has temporarily banned this IP for ${endpoint}: ${apiMessage}. ` +
        `Do not retry this endpoint until the ban expires.`,
      endpoint
    );
  }
}

/** Refused locally to stay within the documented hourly limits. */
export class UnasRateLimitError extends UnasError {
  constructor(endpoint: string, readonly bucket: string, readonly retryAfterSec: number, limit: number) {
    super(
      `Local rate guard: ${bucket} is at its hourly budget (${limit}/h). ` +
        `Retry in ~${Math.ceil(retryAfterSec / 60)} min, or narrow the query (single-entity ` +
        `lookups by Key/Id/Sku have a much higher limit than list queries).`,
      endpoint
    );
  }
}

/** Refused locally after repeated authentication failures (UNAS bans the IP for ALL shops at 10 in 10 min). */
export class UnasAuthGuardError extends UnasError {
  constructor(failures: number, retryAfterSec: number) {
    super(
      `Local safety stop: ${failures} failed authentications in the last 10 minutes. UNAS bans the IP for ` +
        `every webshop for 2 hours after 10 such calls, so login is paused for ~${Math.ceil(retryAfterSec / 60)} min. ` +
        `Check UNAS_API_KEY (is it valid, not expired, and does it belong to this shop?).`,
      "login"
    );
  }
}

/** Refused locally because the endpoint failed too many times in a row (UNAS bans at 20). */
export class UnasFailureGuardError extends UnasError {
  constructor(endpoint: string, failures: number) {
    super(
      `Local safety stop: ${endpoint} failed ${failures} times in a row. UNAS bans the IP for an hour ` +
        `after 20 consecutive failures, so further calls are blocked until a cool-down passes. ` +
        `Check the parameters before retrying.`,
      endpoint
    );
  }
}
