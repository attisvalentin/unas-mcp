#!/usr/bin/env node
/**
 * `npm run docs:sync [-- --force] [-- api admin ...]`: download the UNAS knowledge base into the local cache.
 * Needs no API key; stores the pages only on this computer (see UNAS_DOCS_DIR).
 */
import { DOCS_SECTIONS, DocsStore, type DocsSection } from "./store.js";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const sections = args.filter((a) => !a.startsWith("--")) as DocsSection[];
  const bad = sections.filter((s) => !(DOCS_SECTIONS as readonly string[]).includes(s));
  if (bad.length) throw new Error(`Unknown section(s): ${bad.join(", ")}. Valid: ${DOCS_SECTIONS.join(", ")}`);

  const store = new DocsStore();
  console.error(`Syncing the UNAS knowledge base into ${store.file} ...`);
  const run = store.startSync({ sections, force });
  const timer = setInterval(() => {
    const s = store.syncStatus;
    if (s.total) console.error(`  ${s.done}/${s.total} pages (${s.fetched} downloaded, ${s.skipped} fresh, ${s.failed.length} failed)`);
  }, 5000);
  const status = await run;
  clearInterval(timer);
  console.error(
    `Done: ${status.fetched} downloaded, ${status.skipped} still fresh, ${status.failed.length} failed. ` +
      `${await store.count()} pages in the cache.`
  );
  for (const f of status.failed.slice(0, 20)) console.error(`  failed: ${f.url} (${f.error})`);
  if (status.error) throw new Error(status.error);
}

main().catch((err) => {
  console.error("docs sync failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
