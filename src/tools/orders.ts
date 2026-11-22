import { z } from "zod";
import { buildXml, asArray, compact, type XmlObject } from "../unas/xml.js";
import { jsonResult, safe } from "../util/result.js";
import { summarizeOrder } from "../util/summaries.js";
import { dateInput, dryRunInput, READ_ONLY, unixOrUndefined, WRITE, type ToolContext } from "./context.js";

const STATUS_TYPES = ["open_normal", "open_prepare", "close_ok", "close_fault"] as const;

function ordersFrom(doc: XmlObject): XmlObject[] {
  return asArray((doc.Orders as XmlObject | undefined)?.Order);
}

export function registerOrderTools(ctx: ToolContext) {
  const { server, client, config } = ctx;

  server.registerTool(
    "unas_list_orders",
    {
      title: "List orders",
      description:
        "List webshop orders with filters. IMPORTANT: multi-order queries are heavily rate limited by UNAS " +
        "(30/hour on PREMIUM, 90/hour on VIP), so use a narrow time window and a sufficiently large limit " +
        "rather than paging through many small pages. To fetch one order use unas_get_order instead. " +
        "Returns compact summaries by default; use detail='full' for the raw UNAS structure.",
      inputSchema: {
        statusType: z.enum(STATUS_TYPES).optional().describe(
          "open_normal = normal open, open_prepare = outside processing, close_ok = closed successfully, close_fault = closed unsuccessfully"
        ),
        statusNames: z.array(z.string()).optional().describe("Filter by status name(s) as shown in the admin"),
        statusIds: z.array(z.string()).optional().describe("Filter by status ID(s) (see unas_list_order_statuses)"),
        placedFrom: dateInput.optional().describe("Orders placed at/after this time"),
        placedTo: dateInput.optional().describe("Orders placed at/before this time (date-only = end of that day)"),
        modifiedFrom: dateInput.optional(),
        modifiedTo: dateInput.optional(),
        statusChangedFrom: dateInput.optional(),
        statusChangedTo: dateInput.optional(),
        email: z.string().email().optional().describe("Orders of this customer e-mail"),
        invoiceStatus: z.enum(["0", "1", "2"]).optional().describe("0 = not invoiceable, 1 = invoiceable, 2 = invoiced"),
        sort: z
          .enum(["order_time_asc", "order_time_desc", "modify_time_asc", "modify_time_desc", "key_asc", "key_desc"])
          .optional()
          .describe("Default order_time_asc"),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).optional(),
        lang: z.enum(["base", "customer"]).optional(),
        detail: z.enum(["summary", "full"]).default("summary"),
      },
      annotations: { title: "List orders", ...READ_ONLY },
    },
    safe(async (a) => {
      const params = compact({
        Status: a.statusType,
        StatusName: a.statusNames?.join("|"),
        StatusID: a.statusIds?.join(","),
        TimeStart: unixOrUndefined(ctx, a.placedFrom),
        TimeEnd: unixOrUndefined(ctx, a.placedTo, true),
        TimeModStart: unixOrUndefined(ctx, a.modifiedFrom),
        TimeModEnd: unixOrUndefined(ctx, a.modifiedTo, true),
        StatusModTimeStart: unixOrUndefined(ctx, a.statusChangedFrom),
        StatusModTimeEnd: unixOrUndefined(ctx, a.statusChangedTo, true),
        Email: a.email,
        InvoiceStatus: a.invoiceStatus,
        Order: a.sort,
        LimitNum: a.limit,
        LimitStart: a.offset,
        Lang: a.lang,
      });
      const doc = await client.call("getOrder", "Params", params, { kind: "bulk" });
      const orders = ordersFrom(doc);
      return jsonResult(
        {
          count: orders.length,
          possiblyMore: orders.length === a.limit,
          nextOffset: orders.length === a.limit ? (a.offset ?? 0) + a.limit : undefined,
          orders: a.detail === "full" ? orders : orders.map(summarizeOrder),
        },
        config.maxOutputChars
      );
    })
  );

  server.registerTool(
    "unas_get_order",
    {
      title: "Get order",
      description:
        "Fetch a single order by its key (the order number shown in the admin, e.g. 1000-1000000) with all details: " +
        "customer, addresses, items, payment, shipping, invoice, comments. Uses the cheap single-order rate limit.",
      inputSchema: {
        key: z.string().min(1).describe("Order key (order number)"),
        lang: z.enum(["base", "customer"]).optional(),
        detail: z.enum(["summary", "full"]).default("full"),
      },
      annotations: { title: "Get order", ...READ_ONLY },
    },
    safe(async (a) => {
      const doc = await client.call("getOrder", "Params", compact({ Key: a.key, Lang: a.lang }), { kind: "single" });
      const order = ordersFrom(doc)[0];
      if (!order) return jsonResult({ found: false, key: a.key }, config.maxOutputChars);
      return jsonResult(a.detail === "full" ? order : summarizeOrder(order), config.maxOutputChars);
    })
  );

  server.registerTool(
    "unas_list_order_statuses",
    {
      title: "List order statuses",
      description:
        "List the order statuses configured in the webshop (id, name, type). Use before changing an order's status. Cached.",
      inputSchema: {},
      annotations: { title: "List order statuses", ...READ_ONLY },
    },
    safe(async () => {
      const doc = await client.call("getOrderStatus", "Params", {}, { kind: "bulk", cacheTtlMs: config.cacheTtlMs });
      return jsonResult(doc, config.maxOutputChars);
    })
  );

  if (config.readOnly) return;

  server.registerTool(
    "unas_update_order",
    {
      title: "Update order",
      description:
        "Modify an existing order: change status, set parcel/tracking data, invoice data, add an admin comment, or " +
        "mark it seen. Only the provided fields are sent; omitted fields stay unchanged. Changing the status can " +
        "e-mail the customer (sendStatusEmail). Use dryRun to preview the XML.",
      inputSchema: {
        key: z.string().min(1).describe("Order key (order number)"),
        status: z.string().optional().describe("New status: status name or status ID (see unas_list_order_statuses)"),
        statusDetails: z.string().optional(),
        sendStatusEmail: z.boolean().optional().describe("Send the status-change e-mail to the customer"),
        packageNumber: z.string().optional(),
        trackingUrl: z.string().url().optional(),
        labelUrl: z.string().url().optional().describe("Shipping label (sticker) URL"),
        invoice: z
          .object({
            status: z.enum(["0", "1", "2"]).optional().describe("0 = not invoiceable, 1 = invoiceable, 2 = invoiced"),
            number: z.string().optional(),
            url: z.string().url().optional(),
          })
          .optional(),
        adminComment: z.string().optional().describe("Internal admin comment to add"),
        seen: z.boolean().optional(),
        dryRun: dryRunInput,
      },
      annotations: { title: "Update order", ...WRITE },
    },
    safe(async (a) => {
      const order = compact({
        Action: "modify",
        Key: a.key,
        Seen: a.seen === undefined ? undefined : a.seen ? "yes" : "no",
        Status: a.status,
        StatusDetails: a.statusDetails,
        StatusEmail: a.sendStatusEmail === undefined ? undefined : a.sendStatusEmail ? "yes" : "no",
        Shipping: {
          PackageNumber: a.packageNumber,
          TrackingUrl: a.trackingUrl,
          StickerUrl: a.labelUrl,
        },
        Invoice: a.invoice ? { Status: a.invoice.status, Number: a.invoice.number, Url: a.invoice.url } : undefined,
        Comments: a.adminComment ? { Comment: [{ Type: "admin", Text: a.adminComment }] } : undefined,
      });
      if (Object.keys(order).length <= 2) throw new Error("Nothing to update: provide at least one field besides key.");
      const body = { Order: [order] };
      if (a.dryRun) return jsonResult({ dryRun: true, endpoint: "setOrder", xml: buildXml("Orders", body) }, config.maxOutputChars);
      const doc = await client.call("setOrder", "Orders", body, { kind: "single" });
      return jsonResult(doc, config.maxOutputChars);
    })
  );
}
