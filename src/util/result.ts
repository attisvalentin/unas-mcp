import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UnasError } from "../unas/errors.js";

export function jsonResult(data: unknown, maxChars: number): CallToolResult {
  let text = JSON.stringify(data, null, 1);
  if (text.length > maxChars) {
    text =
      text.slice(0, maxChars) +
      `\n... [truncated: ${text.length - maxChars} more characters. Narrow the query, ` +
      `lower the limit, or use detail="summary".]`;
  }
  return { content: [{ type: "text", text }] };
}

export function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof UnasError || err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Wrap a tool handler so thrown errors become MCP tool errors the model can read. */
export function safe<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}
