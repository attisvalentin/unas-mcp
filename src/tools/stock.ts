import { z } from "zod";
import { asArray, buildXml, compact, type XmlObject } from "../unas/xml.js";
import { jsonResult, safe } from "../util/result.js";
import { dateInput, dryRunInput, READ_ONLY, unixOrUndefined, WRITE, type ToolContext } from "./context.js";

const CHUNK = 100; // setStock calls with <= 100 products use the generous limit

export function registerStockTools(ctx: ToolContext) {
  const { server, client, config } = ctx;

  server.registerTool(
    "unas_get_stock",
    {
      title: "Get stock",
      description:
        "Get stock quantities for one or more SKUs, optionally for a specific variant combination, or list " +
        "products whose stock moved since a given time. A single SKU uses the cheap rate limit.",
      inputSchema: {
        skus: z.array(z.string()).optional(),
        id: z.string().optional().describe("UNAS product ID (overrides skus)"),
        variants: z
          .array(z.string())
          .max(3)
          .optional()
          .describe("Variant values in order, e.g. [\"Kék\",\"XL\"], to get that combination's stock"),
        changedSince: dateInput.optional().describe("Only products with stock movement after this time"),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { title: "Get stock", ...READ_ONLY },
    },
    safe(async (a) => {
      const [v1, v2, v3] = a.variants ?? [];
      const params = compact({
        Id: a.id,
        Sku: a.id ? undefined : a.skus?.join(","),
        Variant1: v1,
        Variant2: v2,
        Variant3: v3,
        TimeStart: unixOrUndefined(ctx, a.changedSince),
        LimitNum: a.limit ?? (a.offset !== undefined ? 100 : undefined),
        LimitStart: a.offset,
      });
      const single = !!a.id || a.skus?.length === 1;
      const doc = await client.call("getStock", "Params", params, { kind: single ? "single" : "bulk" });
      const products = asArray((doc.Products as XmlObject | undefined)?.Product).map((p) => ({
        id: p.Id,
        sku: p.Sku,
        stocks: asArray((p.Stocks as XmlObject | undefined)?.Stock),
      }));
      return jsonResult({ count: products.length, products }, config.maxOutputChars);
    })
  );

  if (config.readOnly) return;

  server.registerTool(
    "unas_set_stock",
    {
      title: "Set stock",
      description:
        "Change stock for one or more products. action: 'modify' sets the absolute quantity, 'in' adds (goods " +
        "received, optional purchase price), 'out' removes. Supports variant-level stock and additional warehouses. " +
        "Large batches are split into chunks of 100 automatically. UNAS stops at the first failing product in a " +
        "chunk; later products in that chunk are not processed. Use dryRun to preview.",
      inputSchema: {
        items: z
          .array(
            z.object({
              sku: z.string().min(1),
              action: z.enum(["modify", "in", "out"]),
              qty: z.number(),
              variants: z.array(z.string()).max(3).optional(),
              warehouseId: z.string().optional().describe("Additional warehouse ID"),
              purchasePrice: z.number().optional().describe("Only for in/out"),
              comment: z.string().optional(),
            })
          )
          .min(1)
          .max(5000),
        dryRun: dryRunInput,
      },
      annotations: { title: "Set stock", ...WRITE, idempotentHint: false },
    },
    safe(async (a) => {
      const products = a.items.map((i) => ({
        Action: i.action,
        Sku: i.sku,
        Stocks: {
          Stock: [
            compact({
              WarehouseId: i.warehouseId,
              Variants: i.variants?.length ? { Variant: i.variants } : undefined,
              Qty: i.qty,
              Price: i.action === "modify" ? undefined : i.purchasePrice,
              Comment: i.comment,
            }),
          ],
        },
      }));
      const chunks: XmlObject[][] = [];
      for (let i = 0; i < products.length; i += CHUNK) chunks.push(products.slice(i, i + CHUNK));

      if (a.dryRun) {
        return jsonResult(
          { dryRun: true, endpoint: "setStock", calls: chunks.length, xml: chunks.map((c) => buildXml("Products", { Product: c })) },
          config.maxOutputChars
        );
      }
      const results: unknown[] = [];
      for (const [idx, chunk] of chunks.entries()) {
        try {
          const doc = await client.call("setStock", "Products", { Product: chunk }, { kind: "single" });
          results.push(...asArray((doc.Products as XmlObject | undefined)?.Product));
        } catch (err) {
          return jsonResult(
            {
              completedChunks: idx,
              totalChunks: chunks.length,
              error: err instanceof Error ? err.message : String(err),
              note: "Chunks before the failing one were applied. Within the failing chunk, products before the faulty one may have been applied.",
              results,
            },
            config.maxOutputChars
          );
        }
      }
      return jsonResult({ ok: true, results }, config.maxOutputChars);
    })
  );
}
