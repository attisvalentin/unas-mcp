import { z } from "zod";
import { asArray, compact, type XmlObject } from "../unas/xml.js";
import { jsonResult, safe } from "../util/result.js";
import { dateInput, READ_ONLY, unixOrUndefined, type ToolContext } from "./context.js";

export function registerCatalogTools(ctx: ToolContext) {
  const { server, client, config } = ctx;

  server.registerTool(
    "unas_list_categories",
    {
      title: "List categories",
      description:
        "List product categories (optionally one by ID, children of a parent, by name, or modified since a time). " +
        "Unfiltered results are cached for a few minutes because list queries are rate limited.",
      inputSchema: {
        id: z.string().optional(),
        parentId: z.string().optional(),
        name: z.string().optional(),
        modifiedSince: dateInput.optional(),
        contentType: z.enum(["minimal", "normal", "full"]).default("minimal"),
      },
      annotations: { title: "List categories", ...READ_ONLY },
    },
    safe(async (a) => {
      const params = compact({
        Id: a.id,
        Name: a.name,
        Parent: a.parentId,
        TimeStart: unixOrUndefined(ctx, a.modifiedSince),
        ContentType: a.contentType,
      });
      const doc = await client.call("getCategory", "Params", params, {
        kind: a.id ? "single" : "bulk",
        cacheTtlMs: config.cacheTtlMs,
      });
      const categories = asArray((doc.Categories as XmlObject | undefined)?.Category);
      return jsonResult({ count: categories.length, categories }, config.maxOutputChars);
    })
  );

  server.registerTool(
    "unas_list_customers",
    {
      title: "List customers",
      description:
        "Find registered customers by ID, e-mail or username, or list customers registered/modified/logged in within " +
        "a time range. A lookup by id/email/username uses the cheap rate limit.",
      inputSchema: {
        id: z.string().optional(),
        email: z.string().optional(),
        username: z.string().optional(),
        registeredFrom: dateInput.optional(),
        registeredTo: dateInput.optional(),
        modifiedFrom: dateInput.optional(),
        modifiedTo: dateInput.optional(),
        lastLoginFrom: dateInput.optional(),
        lastLoginTo: dateInput.optional(),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { title: "List customers", ...READ_ONLY },
    },
    safe(async (a) => {
      const params = compact({
        Id: a.id,
        Email: a.email,
        Username: a.username,
        RegTimeStart: unixOrUndefined(ctx, a.registeredFrom),
        RegTimeEnd: unixOrUndefined(ctx, a.registeredTo, true),
        ModTimeStart: unixOrUndefined(ctx, a.modifiedFrom),
        ModTimeEnd: unixOrUndefined(ctx, a.modifiedTo, true),
        LoginTimeStart: unixOrUndefined(ctx, a.lastLoginFrom),
        LoginTimeEnd: unixOrUndefined(ctx, a.lastLoginTo, true),
        LimitNum: a.limit,
        LimitStart: a.offset,
      });
      const single = !!(a.id || a.email || a.username);
      const doc = await client.call("getCustomer", "Params", params, { kind: single ? "single" : "bulk" });
      const customers = asArray((doc.Customers as XmlObject | undefined)?.Customer);
      return jsonResult(
        { count: customers.length, possiblyMore: customers.length === a.limit, customers },
        config.maxOutputChars
      );
    })
  );

  server.registerTool(
    "unas_list_methods",
    {
      title: "List payment & shipping methods",
      description: "List the webshop's payment and shipping methods (IDs, names, types). Cached; limited to 30/h on PREMIUM.",
      inputSchema: {},
      annotations: { title: "List payment & shipping methods", ...READ_ONLY },
    },
    safe(async () => {
      const doc = await client.call("getMethod", "Params", {}, { kind: "bulk", cacheTtlMs: config.cacheTtlMs });
      return jsonResult(doc, config.maxOutputChars);
    })
  );
}
