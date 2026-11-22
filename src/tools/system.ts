import { z } from "zod";
import { GET_ENDPOINTS, SET_ENDPOINTS } from "../unas/limits.js";
import { buildXml, type XmlObject } from "../unas/xml.js";
import { jsonResult, safe } from "../util/result.js";
import { DESTRUCTIVE, READ_ONLY, type ToolContext } from "./context.js";

const xmlBody = z
  .record(z.string(), z.any())
  .describe("Request content as JSON mirroring the XML. Arrays become repeated elements, e.g. {\"Product\":[{...},{...}]}");

export function registerSystemTools(ctx: ToolContext) {
  const { server, client, config } = ctx;

  server.registerTool(
    "unas_shop_info",
    {
      title: "Shop info & permissions",
      description:
        "Show which webshop the API key belongs to, its subscription, API key expiry and the API permissions " +
        "granted to the key. Useful as a first call to see which tools will work.",
      inputSchema: {},
      annotations: { title: "Shop info & permissions", ...READ_ONLY },
    },
    safe(async () => {
      const login = await client.getLogin();
      return jsonResult(
        {
          shopId: login.shopId,
          subscription: login.subscription,
          apiKeyExpires: login.apiKeyExpire,
          tokenExpires: new Date(login.expiresAt).toISOString(),
          permissions: login.permissions,
          webshop: login.webshopInfo,
          serverMode: config.readOnly ? "read-only" : "read-write",
        },
        config.maxOutputChars
      );
    })
  );

  server.registerTool(
    "unas_rate_limit_status",
    {
      title: "Rate limit status",
      description:
        "Show how much of the hourly UNAS API budget this server has used, consecutive failures per endpoint and " +
        "any active IP bans. Check this before running many list queries.",
      inputSchema: {},
      annotations: { title: "Rate limit status", ...READ_ONLY, openWorldHint: false },
    },
    safe(async () => jsonResult(client.status(), config.maxOutputChars))
  );

  server.registerTool(
    "unas_raw_get",
    {
      title: "Raw UNAS get request",
      description:
        "Call any UNAS get* endpoint directly (e.g. getCoupon, getProductParameter, getCustomerGroup, getWarehouse, " +
        "getSticker, getNewsletter, getPage, getSetting, getAutomatism...). `params` are the request <Params> " +
        "children as documented at unas.hu/tudastar/api. Prefer the dedicated tools when one exists.",
      inputSchema: {
        endpoint: z.enum(GET_ENDPOINTS as [string, ...string[]]),
        params: xmlBody.default({}),
        single: z
          .boolean()
          .default(false)
          .describe("True if this fetches exactly one entity by ID (counts against the higher single-entity limit)"),
      },
      annotations: { title: "Raw UNAS get request", ...READ_ONLY },
    },
    safe(async (a) => {
      const doc = await client.call(a.endpoint, "Params", a.params as XmlObject, { kind: a.single ? "single" : "bulk" });
      return jsonResult(doc, config.maxOutputChars);
    })
  );

  if (config.readOnly) return;

  server.registerTool(
    "unas_raw_set",
    {
      title: "Raw UNAS set request",
      description:
        "Call any UNAS set* endpoint directly with a full request document (e.g. setCoupon, setCategory, setCustomer, " +
        "setProductParameter). Can create, modify or delete data, so describe the change to the user and get explicit " +
        "approval first; set confirm=true only after that. Use dryRun to show the XML. Remember: an empty element " +
        "deletes the stored value in UNAS, an omitted element leaves it unchanged.",
      inputSchema: {
        endpoint: z.enum(SET_ENDPOINTS as [string, ...string[]]),
        root: z.string().describe("Root element, e.g. 'Coupons', 'Categories', 'Customers', 'Params'"),
        body: xmlBody,
        entityCount: z.number().int().min(1).default(1).describe("Number of entities in the request (for rate limiting)"),
        confirm: z.boolean().default(false).describe("Must be true to send; otherwise behaves like dryRun"),
        dryRun: z.boolean().optional(),
      },
      annotations: { title: "Raw UNAS set request", ...DESTRUCTIVE },
    },
    safe(async (a) => {
      const xml = buildXml(a.root, a.body as XmlObject);
      if (a.dryRun || !a.confirm) {
        return jsonResult(
          { dryRun: true, endpoint: a.endpoint, xml, note: a.confirm ? undefined : "Not sent: confirm is false." },
          config.maxOutputChars
        );
      }
      const doc = await client.call(a.endpoint, a.root, a.body as XmlObject, {
        kind: a.entityCount > 100 ? "bulk" : "single",
      });
      client.invalidateCache(a.endpoint.replace(/^set/, "get"));
      return jsonResult(doc, config.maxOutputChars);
    })
  );
}
