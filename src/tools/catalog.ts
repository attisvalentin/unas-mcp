import { z } from "zod";
import { asArray, buildXml, compact, type XmlObject } from "../unas/xml.js";
import { jsonResult, safe, setResult } from "../util/result.js";
import { dateInput, dryRunInput, READ_ONLY, unixOrUndefined, WRITE, type ToolContext } from "./context.js";
import { checkSeoOverlap, seoInput, seoNodes } from "./seo.js";

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
      // Only the full category tree is cached; filtered queries (especially modifiedSince) must be fresh.
      const unfiltered = !a.id && !a.name && !a.parentId && !a.modifiedSince;
      const doc = await client.call("getCategory", "Params", params, {
        kind: a.id ? "single" : "bulk",
        cacheTtlMs: unfiltered ? config.cacheTtlMs : undefined,
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

  if (config.readOnly) return;

  const yesNo = (v: boolean | undefined) => (v === undefined ? undefined : v ? "yes" : "no");

  server.registerTool(
    "unas_update_category",
    {
      title: "Update category",
      description:
        "Modify an existing category by ID: name, SEO (meta title/description/keywords/robots, SEO URL), texts above/" +
        "below the product list, menu/page visibility, parent, and custom page layout templates. Only provided " +
        "fields change; an empty string clears a text. Layout templates themselves are made in the UNAS admin; here " +
        "you can only assign an existing template ID. Use dryRun to preview.",
      inputSchema: {
        id: z.string().min(1).describe("Category ID (see unas_list_categories)"),
        name: z.string().optional(),
        nameOnPage: z.string().optional().describe("Heading shown on the category page, if different from name"),
        seo: seoInput.optional(),
        topText: z.string().optional().describe("HTML shown above the product list (UNAS: Texts.Top)"),
        bottomText: z.string().optional().describe("HTML shown below the product list, e.g. SEO text (UNAS: Texts.Bottom)"),
        menuText: z.string().optional().describe("Text shown in the category menu (UNAS: Texts.Menu)"),
        showInMenu: z.boolean().optional(),
        showOnPage: z.boolean().optional().describe("Show the category on category listing pages"),
        parentId: z.string().optional().describe("Move under this parent category ID (\"0\" = top level)"),
        pageLayout: z
          .object({
            productList: z.string().optional().describe("Custom template ID for the product list page"),
            categoryList: z.string().optional().describe("Custom template ID for the category page"),
          })
          .optional()
          .describe("Assign custom page layout templates created in the UNAS admin. Empty string = default layout."),
        lang: z.string().length(2).optional().describe("Update this language's translatable fields"),
        extra: z
          .record(z.string(), z.any())
          .optional()
          .describe("Advanced: additional raw UNAS <Category> child nodes (see the UNAS category data structure)"),
        dryRun: dryRunInput,
      },
      annotations: { title: "Update category", ...WRITE },
    },
    safe(async (a) => {
      const bad = Object.keys(a.extra ?? {}).filter((k) => ["action", "id", "lang"].includes(k.toLowerCase()));
      if (bad.length > 0) throw new Error(`extra must not contain ${bad.join(", ")}.`);
      const seo = seoNodes(a.seo);
      checkSeoOverlap(seo, a.extra);
      const nodes = compact({
        Name: a.name,
        NameOnPage: a.nameOnPage,
        ...seo,
        Texts: { Top: a.topText, Bottom: a.bottomText, Menu: a.menuText },
        Display: { Page: yesNo(a.showOnPage), Menu: yesNo(a.showInMenu) },
        Parent: a.parentId !== undefined ? { Id: a.parentId } : undefined,
        PageLayout: a.pageLayout
          ? { ProductList: a.pageLayout.productList, CategoryList: a.pageLayout.categoryList }
          : undefined,
        ...((a.extra ?? {}) as XmlObject),
      });
      if (Object.keys(nodes).length === 0) throw new Error("Nothing to update: provide at least one field besides id.");
      const body = { Category: [compact({ Action: "modify", Id: a.id, Lang: a.lang, ...nodes })] };
      if (a.dryRun) {
        return jsonResult({ dryRun: true, endpoint: "setCategory", xml: buildXml("Categories", body) }, config.maxOutputChars);
      }
      const doc = await client.call("setCategory", "Categories", body, { kind: "single" });
      client.invalidateCache("getCategory");
      return setResult(doc, config.maxOutputChars);
    })
  );
}
