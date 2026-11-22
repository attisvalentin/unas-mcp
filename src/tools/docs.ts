import { z } from "zod";
import { DOCS_SECTIONS, DocsStore } from "../docs/store.js";
import { jsonResult, safe } from "../util/result.js";
import { READ_ONLY, type ToolContext } from "./context.js";

const sectionInput = z
  .enum(DOCS_SECTIONS)
  .describe(
    "admin = webshop admin help (settings, menus), api = API documentation, design = themes/templates, " +
      "hosting, integracio, rendeles, ugyfelfiok"
  );

const NOT_SYNCED =
  "The local UNAS knowledge base is empty. Run unas_docs_sync (takes a few minutes) or `npm run docs:sync`, " +
  "then search again.";

export function registerDocsTools(ctx: ToolContext, docs: DocsStore) {
  const { server, config } = ctx;

  server.registerTool(
    "unas_docs_search",
    {
      title: "Search UNAS knowledge base",
      description:
        "Search the local copy of the UNAS knowledge base (unas.hu/tudastar): where a setting is in the admin, how " +
        "a feature works, API fields and request formats. Use it before answering questions about UNAS itself, and " +
        "before guessing API element names. Hungarian queries work best (accents optional). Returns titles, URLs " +
        "and snippets; read a page with unas_docs_read.",
      inputSchema: {
        query: z.string().min(2).describe("Search words, e.g. \"státusz értesítő email\" or \"setScriptTag\""),
        section: sectionInput.optional(),
        limit: z.number().int().min(1).max(20).default(5),
      },
      annotations: { title: "Search UNAS knowledge base", ...READ_ONLY, openWorldHint: false },
    },
    safe(async (a) => {
      const count = await docs.count();
      if (count === 0) {
        const status = docs.syncStatus;
        return jsonResult(
          { results: [], note: status.running ? `Sync in progress: ${status.done}/${status.total} pages.` : NOT_SYNCED },
          config.maxOutputChars
        );
      }
      const results = await docs.search(a.query, { section: a.section, limit: a.limit });
      const status = docs.syncStatus;
      return jsonResult(
        {
          results,
          pagesInCache: count,
          note:
            results.length === 0
              ? "No match. Try other or fewer words, Hungarian terms, or another section."
              : status.running
                ? `Sync in progress (${status.done}/${status.total}); results may be incomplete.`
                : undefined,
        },
        config.maxOutputChars
      );
    })
  );

  server.registerTool(
    "unas_docs_read",
    {
      title: "Read UNAS knowledge base page",
      description:
        "Read one UNAS knowledge base page as text, by URL (from unas_docs_search) or section/slug, e.g. " +
        "\"api/termekek-adatszerkezet\" or \"admin/ertesitesek\". Pages missing from the local copy are fetched " +
        "from unas.hu and cached. Long pages are returned in parts: use offset to continue.",
      inputSchema: {
        page: z.string().min(1).describe("URL, section/slug, or a slug already in the local copy"),
        offset: z.number().int().min(0).default(0).describe("Character offset for long pages"),
        maxChars: z.number().int().min(1000).max(60000).default(20000),
      },
      annotations: { title: "Read UNAS knowledge base page", ...READ_ONLY },
    },
    safe(async (a) => {
      const page = await docs.read(a.page);
      const part = page.text.slice(a.offset, a.offset + a.maxChars);
      const end = a.offset + part.length;
      return jsonResult(
        {
          title: page.title,
          url: page.url,
          section: DocsStore.sectionName(page.section),
          fetchedAt: page.fetchedAt,
          totalChars: page.text.length,
          offset: a.offset,
          nextOffset: end < page.text.length ? end : undefined,
          text: part,
        },
        // The text part is already bounded by maxChars; leave room for the wrapper.
        Math.max(config.maxOutputChars, a.maxChars + 2000)
      );
    })
  );

  server.registerTool(
    "unas_docs_sync",
    {
      title: "Sync UNAS knowledge base",
      description:
        "Download or refresh the local copy of the UNAS knowledge base (about 600 pages, a few minutes, politely " +
        "rate limited). Runs in the background: call again to see progress. Pages younger than 30 days are kept " +
        "unless force is true. Stored only on this computer, never in the project.",
      inputSchema: {
        sections: z.array(sectionInput).optional().describe("Only these sections (default: all)"),
        force: z.boolean().default(false).describe("Re-download pages that are still fresh"),
        statusOnly: z.boolean().default(false).describe("Only report progress, do not start a sync"),
      },
      annotations: { title: "Sync UNAS knowledge base", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async (a) => {
      const before = docs.syncStatus;
      if (!a.statusOnly && !before.running) {
        // Deliberately not awaited: the sync outlives this tool call.
        void docs.startSync({ sections: a.sections, force: a.force });
      }
      const status = docs.syncStatus;
      return jsonResult(
        {
          started: !a.statusOnly && !before.running,
          status,
          pagesInCache: await docs.count(),
          cacheFile: docs.file,
        },
        config.maxOutputChars
      );
    })
  );
}
