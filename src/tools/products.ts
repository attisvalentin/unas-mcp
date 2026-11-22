import { z } from "zod";
import { asArray, buildXml, compact, type XmlObject } from "../unas/xml.js";
import { jsonResult, safe } from "../util/result.js";
import { summarizeProduct } from "../util/summaries.js";
import { dateInput, DESTRUCTIVE, dryRunInput, READ_ONLY, unixOrUndefined, WRITE, type ToolContext } from "./context.js";

const CONTENT_TYPES = ["minimal", "short", "normal", "full", "custom"] as const;
const PRODUCT_STATUS = z
  .enum(["0", "1", "2", "3"])
  .describe("0 = inactive, 1 = active, 2 = active & new, 3 = active but not buyable");

function productsFrom(doc: XmlObject): XmlObject[] {
  return asArray((doc.Products as XmlObject | undefined)?.Product);
}

const extraInput = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Advanced: additional raw UNAS <Product> child nodes merged into the request, following the UNAS product " +
      "data structure (e.g. {\"Weight\": 1.2, \"Meta\": {\"Title\": \"...\"}}). Empty string clears a value."
  );

const priceInput = z
  .object({
    net: z.number().nonnegative().optional(),
    gross: z.number().nonnegative().optional(),
  })
  .describe("Normal price. UNAS normally expects both net and gross.");

/**
 * Keys the tool itself controls. Letting `extra` set them would allow e.g. {"Action":"delete"} to turn an
 * update into a delete (bypassing confirm), or {"Sku":"other"} to modify a different product.
 */
const RESERVED_EXTRA_KEYS = new Set(["action", "sku", "id", "lang"]);

function checkExtra(extra: Record<string, unknown> | undefined) {
  const bad = Object.keys(extra ?? {}).filter((k) => RESERVED_EXTRA_KEYS.has(k.toLowerCase()));
  if (bad.length > 0) {
    throw new Error(
      `extra must not contain ${bad.join(", ")}: use the tool's own parameters (sku, lang) or ` +
        `unas_delete_products for deletion.`
    );
  }
}

function productNodes(a: {
  name?: string;
  unit?: string;
  status?: string;
  price?: { net?: number; gross?: number };
  categoryId?: string;
  categoryName?: string;
  shortDescription?: string;
  longDescription?: string;
  extra?: Record<string, unknown>;
}): XmlObject {
  checkExtra(a.extra);
  return compact({
    Statuses: a.status !== undefined ? { Status: [{ Type: "base", Value: a.status }] } : undefined,
    Name: a.name,
    Unit: a.unit,
    Description:
      a.shortDescription !== undefined || a.longDescription !== undefined
        ? { Short: a.shortDescription, Long: a.longDescription }
        : undefined,
    Categories:
      a.categoryId !== undefined || a.categoryName !== undefined
        ? { Category: [{ Type: "base", Id: a.categoryId, Name: a.categoryName }] }
        : undefined,
    Prices: a.price ? { Price: [{ Type: "normal", Net: a.price.net, Gross: a.price.gross }] } : undefined,
    ...((a.extra ?? {}) as XmlObject),
  });
}

export function registerProductTools(ctx: ToolContext) {
  const { server, client, config } = ctx;

  server.registerTool(
    "unas_list_products",
    {
      title: "List products",
      description:
        "List/search products by SKU(s), category, status or modification time. Multi-product queries are rate " +
        "limited by UNAS, so filter as narrowly as possible. For one product use unas_get_product. Returns compact " +
        "summaries (sku, name, status, price, stock, category) by default.",
      inputSchema: {
        skus: z.array(z.string()).optional().describe("One or more SKUs (cikkszám)"),
        parentSku: z.string().optional().describe("Base SKU of a product merge: returns all its sub-types"),
        categoryIds: z.array(z.string()).optional().describe("Primary (base) category IDs"),
        statuses: z.array(PRODUCT_STATUS).optional(),
        state: z.enum(["live", "deleted"]).optional().describe("deleted = products deleted within the last month"),
        modifiedFrom: dateInput.optional(),
        modifiedTo: dateInput.optional(),
        contentType: z.enum(CONTENT_TYPES).default("short").describe("Amount of data per product"),
        requestedData: z
          .array(z.string())
          .optional()
          .describe("With contentType=custom: first-level Product fields to return, e.g. [\"Name\",\"Prices\",\"Stock\"]"),
        lang: z.string().length(2).optional().describe("ISO 639-1 language code, e.g. hu, en, de"),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).optional(),
        detail: z.enum(["summary", "full"]).default("summary"),
      },
      annotations: { title: "List products", ...READ_ONLY },
    },
    safe(async (a) => {
      const params = compact({
        StatusBase: a.statuses?.join(","),
        State: a.state,
        Sku: a.skus?.join(","),
        Parent: a.parentSku,
        CategoryId: a.categoryIds?.join(","),
        TimeStart: unixOrUndefined(ctx, a.modifiedFrom),
        TimeEnd: unixOrUndefined(ctx, a.modifiedTo, true),
        ContentType: a.requestedData?.length ? "custom" : a.contentType,
        RequestedData: a.requestedData?.join(","),
        Lang: a.lang,
        LimitNum: a.limit,
        LimitStart: a.offset,
      });
      const single = a.skus?.length === 1 && !a.parentSku;
      const doc = await client.call("getProduct", "Params", params, { kind: single ? "single" : "bulk" });
      const products = productsFrom(doc);
      return jsonResult(
        {
          count: products.length,
          possiblyMore: products.length === a.limit,
          nextOffset: products.length === a.limit ? (a.offset ?? 0) + a.limit : undefined,
          products: a.detail === "full" ? products : products.map(summarizeProduct),
        },
        config.maxOutputChars
      );
    })
  );

  server.registerTool(
    "unas_get_product",
    {
      title: "Get product",
      description: "Fetch one product by SKU or ID with all data (prices, categories, images, variants, params, stock...).",
      inputSchema: {
        sku: z.string().optional(),
        id: z.string().optional().describe("UNAS product ID (takes precedence over sku)"),
        contentType: z.enum(CONTENT_TYPES).default("full"),
        lang: z.string().length(2).optional(),
        detail: z.enum(["summary", "full"]).default("full"),
      },
      annotations: { title: "Get product", ...READ_ONLY },
    },
    safe(async (a) => {
      if (!a.sku && !a.id) throw new Error("Provide sku or id.");
      const doc = await client.call(
        "getProduct",
        "Params",
        compact({ Id: a.id, Sku: a.id ? undefined : a.sku, ContentType: a.contentType, Lang: a.lang }),
        { kind: "single" }
      );
      const product = productsFrom(doc)[0];
      if (!product) return jsonResult({ found: false, sku: a.sku, id: a.id }, config.maxOutputChars);
      return jsonResult(a.detail === "full" ? product : summarizeProduct(product), config.maxOutputChars);
    })
  );

  if (config.readOnly) return;

  server.registerTool(
    "unas_update_product",
    {
      title: "Update product",
      description:
        "Modify an existing product identified by SKU. Only provided fields are changed. For stock changes use " +
        "unas_set_stock instead. Use lang to update a translation (only translatable fields apply). Use dryRun to preview.",
      inputSchema: {
        sku: z.string().min(1),
        name: z.string().optional(),
        unit: z.string().optional(),
        status: PRODUCT_STATUS.optional(),
        price: priceInput.optional(),
        categoryId: z.string().optional().describe("New base category ID"),
        shortDescription: z.string().optional(),
        longDescription: z.string().optional().describe("HTML allowed"),
        lang: z.string().length(2).optional(),
        extra: extraInput,
        dryRun: dryRunInput,
      },
      annotations: { title: "Update product", ...WRITE },
    },
    safe(async (a) => {
      const nodes = productNodes(a);
      if (Object.keys(nodes).length === 0) throw new Error("Nothing to update: provide at least one field besides sku.");
      const body = { Product: [compact({ Action: "modify", Lang: a.lang, Sku: a.sku, ...nodes })] };
      if (a.dryRun) return jsonResult({ dryRun: true, endpoint: "setProduct", xml: buildXml("Products", body) }, config.maxOutputChars);
      const doc = await client.call("setProduct", "Products", body, { kind: "single" });
      return jsonResult(doc, config.maxOutputChars);
    })
  );

  server.registerTool(
    "unas_create_product",
    {
      title: "Create product",
      description:
        "Create a new product. Required by UNAS: sku, name, unit, a base category and the normal price (net + gross). " +
        "Status defaults to 1 (active). Use dryRun to preview the XML.",
      inputSchema: {
        sku: z.string().min(1),
        name: z.string().min(1),
        unit: z.string().default("db"),
        status: PRODUCT_STATUS.default("1"),
        price: priceInput,
        categoryId: z.string().optional().describe("Existing category ID"),
        categoryName: z
          .string()
          .optional()
          .describe("Category path with | separators, e.g. 'Termékek|Alkategória 1' (used if no ID)"),
        shortDescription: z.string().optional(),
        longDescription: z.string().optional(),
        extra: extraInput,
        dryRun: dryRunInput,
      },
      annotations: { title: "Create product", ...WRITE, idempotentHint: false },
    },
    safe(async (a) => {
      if (!a.categoryId && !a.categoryName) throw new Error("Provide categoryId or categoryName.");
      const body = { Product: [compact({ Action: "add", Sku: a.sku, ...productNodes(a) })] };
      if (a.dryRun) return jsonResult({ dryRun: true, endpoint: "setProduct", xml: buildXml("Products", body) }, config.maxOutputChars);
      const doc = await client.call("setProduct", "Products", body, { kind: "single" });
      return jsonResult(doc, config.maxOutputChars);
    })
  );

  server.registerTool(
    "unas_delete_products",
    {
      title: "Delete products",
      description:
        "Delete products by SKU. Irreversible from the API's point of view (deleted products remain queryable for " +
        "about a month with state=deleted). Requires confirm=true. Ask the user for explicit confirmation first.",
      inputSchema: {
        skus: z.array(z.string().min(1)).min(1).max(100),
        confirm: z.literal(true).describe("Must be true to actually delete"),
        dryRun: dryRunInput,
      },
      annotations: { title: "Delete products", ...DESTRUCTIVE },
    },
    safe(async (a) => {
      const body = { Product: a.skus.map((sku) => ({ Action: "delete", Sku: sku })) };
      if (a.dryRun) return jsonResult({ dryRun: true, endpoint: "setProduct", xml: buildXml("Products", body) }, config.maxOutputChars);
      const doc = await client.call("setProduct", "Products", body, { kind: "single" });
      return jsonResult(doc, config.maxOutputChars);
    })
  );
}
