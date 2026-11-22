#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main() {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel: log to stderr only.
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} running on stdio (limits from the shop's subscription, ` +
      `fallback ${config.subscription.toUpperCase()}, ` +
      `${config.readOnly ? "read-only" : "read-write"})`
  );

  const shutdown = async () => {
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
