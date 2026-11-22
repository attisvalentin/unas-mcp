import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UnasConfig } from "../config.js";
import type { UnasClient } from "../unas/client.js";
import { toUnix } from "../util/dates.js";

export interface ToolContext {
  server: McpServer;
  client: UnasClient;
  config: UnasConfig;
}

export const dateInput = z
  .string()
  .describe("Date or date-time: YYYY-MM-DD (shop time zone), YYYY-MM-DDTHH:mm, ISO-8601 with offset, or unix timestamp");

export const dryRunInput = z
  .boolean()
  .optional()
  .describe("If true, return the XML that would be sent without calling UNAS");

export function unixOrUndefined(ctx: ToolContext, v: string | undefined, endOfDay = false) {
  return v ? toUnix(v, ctx.config.timezone, endOfDay) : undefined;
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
