import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UnasConfig } from "./config.js";
import { UnasClient } from "./unas/client.js";
import { KNOWN_ENDPOINTS, limitsMarkdown } from "./unas/limits.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerContentTools } from "./tools/content.js";
import { registerDocsTools } from "./tools/docs.js";
import { DocsStore } from "./docs/store.js";
import type { ToolContext } from "./tools/context.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerProductTools } from "./tools/products.js";
import { registerStockTools } from "./tools/stock.js";
import { registerSystemTools } from "./tools/system.js";

export const SERVER_NAME = "unas-mcp";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Tools for a UNAS (unas.hu) webshop: orders, products, stock, categories, customers, SEO, own pages
and storefront scripts. The shop's design/theme (templates, CSS) cannot be edited through the API; a category can
only be assigned an existing custom layout template ID.
For questions about UNAS itself (where a setting is in the admin, how a feature works, API fields) search the
local knowledge base with unas_docs_search and read pages with unas_docs_read before answering or guessing.
Key facts:
- UNAS strictly rate limits LIST queries (e.g. 30/hour on PREMIUM) and bans the IP for 1 hour if exceeded,
  or after 20 consecutive failed calls. Single lookups (order by key, product/stock by one SKU) are cheap.
  Prefer narrow date ranges and one larger page over many small pages; check unas_rate_limit_status if unsure.
  Repeated bans escalate (1 day, 1 month, 1 year), so never retry into a limit or ban.
- UNAS may run maintenance around midnight (±10 min, shop time); avoid starting calls then.
- Dates without a time zone are interpreted in the shop's time zone.
- Write tools change the live shop. Summarise the intended change and get the user's confirmation before
  calling them; use dryRun to show exactly what would be sent.
- In UNAS set calls, an omitted field is left unchanged and an empty field clears the stored value.
- Set calls can partly fail: a tool result marked as an error lists the failed items; report them to the user.`;

export function createServer(config: UnasConfig, client = new UnasClient(config), docs = new DocsStore()) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );
  const ctx: ToolContext = { server, client, config };

  registerSystemTools(ctx);
  registerOrderTools(ctx);
  registerProductTools(ctx);
  registerStockTools(ctx);
  registerCatalogTools(ctx);
  registerContentTools(ctx);
  registerDocsTools(ctx, docs);

  // ---------------------------------------------------------------- resources

  server.registerResource(
    "unas-limits",
    "unas://limits",
    {
      title: "UNAS API rate limits",
      description: "Documented hourly call limits per endpoint for this subscription",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: limitsMarkdown(client.subscription) }] })
  );

  server.registerResource(
    "unas-endpoints",
    "unas://endpoints",
    {
      title: "UNAS API endpoints",
      description: "All known get*/set* endpoints usable through unas_raw_get / unas_raw_set",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text:
            "# UNAS API endpoints\n\nBase URL: https://api.unas.eu/shop/<endpoint> (POST, XML, Bearer token)\n" +
            "Docs: https://unas.hu/tudastar/api\n\n" +
            KNOWN_ENDPOINTS.map((e) => `- get${e} / set${e}`).join("\n"),
        },
      ],
    })
  );

  // ------------------------------------------------------------------ prompts

  server.registerPrompt(
    "daily_order_report",
    {
      title: "Daily order report",
      description: "Summarise the orders of a given day: count, revenue, status breakdown, top products, open issues",
      argsSchema: { date: z.string().describe("Day to report on, YYYY-MM-DD") },
    },
    ({ date }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Készíts napi rendelés-összesítőt a(z) ${date} napra az UNAS webshopból. ` +
              `Egyetlen unas_list_orders hívással kérd le a nap rendeléseit (placedFrom=${date}, placedTo=${date}, limit=500). ` +
              `Összesítsd: rendelések száma, bruttó bevétel pénznemenként, státusz szerinti bontás, fizetési és szállítási ` +
              `módok megoszlása, top 10 termék darabszám szerint, és emeld ki a fizetetlen vagy hibás státuszú rendeléseket.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "customer_lookup",
    {
      title: "Customer lookup",
      description: "Everything about one customer: profile and order history",
      argsSchema: { email: z.string().describe("Customer e-mail address") },
    },
    ({ email }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Nézd meg a(z) ${email} vásárlót az UNAS webshopban: unas_list_customers (email) a profilhoz, ` +
              `unas_list_orders (email, sort=order_time_desc) a rendelésekhez. Foglald össze: regisztráció, ` +
              `rendelésszám, összes költés, utolsó rendelés és státusza, nyitott ügyek.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "stock_check",
    {
      title: "Stock check",
      description: "Check stock for a list of SKUs and flag low stock",
      argsSchema: {
        skus: z.string().describe("Comma-separated SKUs"),
        threshold: z.string().optional().describe("Low-stock threshold, default 5"),
      },
    },
    ({ skus, threshold }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Ellenőrizd ezeknek a cikkszámoknak a készletét egyetlen unas_get_stock hívással: ${skus}. ` +
              `Listázd táblázatban, és jelöld azokat, ahol a készlet ${threshold ?? "5"} alatt van.`,
          },
        },
      ],
    })
  );

  return server;
}
