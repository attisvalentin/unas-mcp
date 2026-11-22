import type { Subscription } from "../config.js";

/**
 * Documented UNAS hourly limits (per IP, per webshop), from unas.hu/tudastar/api.
 * "single" = one entity per call (lookup by Key/Id/Sku, or a set call with <= 100 entities);
 * "bulk" = multi-entity list calls, or set calls with > 100 entities.
 * Endpoints not listed fall back to DEFAULT_LIMITS, which mirror the most common pattern.
 */
export interface EndpointLimits {
  single: Record<Subscription, number>;
  bulk: Record<Subscription, number>;
}

const STD: EndpointLimits = {
  single: { premium: 1000, vip: 3000 },
  bulk: { premium: 30, vip: 90 },
};
const FLAT_30: EndpointLimits = {
  single: { premium: 30, vip: 90 },
  bulk: { premium: 30, vip: 90 },
};

export const GLOBAL_LIMIT: Record<Subscription, number> = { premium: 2000, vip: 6000 };
export const LOGIN_LIMIT: Record<Subscription, number> = { premium: 2000, vip: 6000 };

export const ENDPOINT_LIMITS: Record<string, EndpointLimits> = {
  getOrder: STD,
  setOrder: STD,
  getProduct: STD,
  setProduct: STD,
  getStock: STD,
  setStock: STD,
  getCategory: STD,
  setCategory: STD,
  getCustomer: STD,
  setCustomer: STD,
  getCustomerGroup: STD,
  setCustomerGroup: STD,
  getProductDB: { single: { premium: 10, vip: 20 }, bulk: { premium: 10, vip: 20 } },
  setProductDB: FLAT_30,
  getMethod: FLAT_30,
  setMethod: FLAT_30,
  getPage: FLAT_30,
  setPage: FLAT_30,
};

export const DEFAULT_LIMITS: EndpointLimits = STD;

export function limitsFor(endpoint: string): EndpointLimits {
  return ENDPOINT_LIMITS[endpoint] ?? DEFAULT_LIMITS;
}

/** Known UNAS endpoints (for the raw tools and documentation). */
export const KNOWN_ENDPOINTS = [
  "Order", "OrderStatus", "OrderType", "Stock", "Warehouse", "Product", "ProductDB",
  "ProductParameter", "ProductService", "Sticker", "ProductReview", "Category", "Customer",
  "CustomerGroup", "Newsletter", "ScriptTag", "Page", "PageContent", "Storage", "Automatism",
  "Coupon", "Method", "DeliveryPointGroup", "DeliveryPoint", "PackageOffer", "Setting", "Gift", "Bogo",
] as const;

export const GET_ENDPOINTS = KNOWN_ENDPOINTS.map((e) => `get${e}`);
export const SET_ENDPOINTS = KNOWN_ENDPOINTS.map((e) => `set${e}`);

export function limitsMarkdown(sub: Subscription): string {
  const rows = Object.entries(ENDPOINT_LIMITS)
    .map(([ep, l]) => `| ${ep} | ${l.single[sub]} | ${l.bulk[sub]} |`)
    .join("\n");
  return [
    `# UNAS API limits (${sub.toUpperCase()})`,
    "",
    `- Global: ${GLOBAL_LIMIT[sub]} calls/hour per IP per webshop.`,
    "- Login tokens are valid for 2 hours; this server reuses them.",
    "- 20 consecutive failed calls on an endpoint => 1 hour IP ban for that webshop.",
    "- Max XML body for set calls: 128 MB. getOrder returns at most 500 orders per call.",
    "- Exceeding a limit => 1 hour IP ban; repeated violations escalate (1 day, 1 month, 1 year).",
    "  This server enforces a local budget below the limits.",
    "- 10 unidentifiable calls (bad API key / auth) within 10 minutes => the IP is banned for ALL webshops",
    "  for 2 hours. This server pauses login after 3 authentication failures in 10 minutes.",
    "- At most 5 parallel requests per IP per webshop (this server uses at most UNAS_MAX_CONCURRENCY, default 4).",
    "- Maintenance may happen daily around midnight (±10 min); avoid calls then.",
    "",
    "| Endpoint | single / <=100 items (per h) | list / >100 items (per h) |",
    "|---|---|---|",
    rows,
    `| (others) | ${DEFAULT_LIMITS.single[sub]} | ${DEFAULT_LIMITS.bulk[sub]} |`,
    "",
    "Practical consequence: list queries are scarce (e.g. 30/h on PREMIUM). Prefer narrow",
    "time windows, larger page sizes over many small pages, and single lookups by Key/Id/Sku.",
  ].join("\n");
}
