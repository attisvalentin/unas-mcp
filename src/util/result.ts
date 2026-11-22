import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UnasError } from "../unas/errors.js";

const TRUNCATION_HINT = `Narrow the query, lower the limit, or use detail="summary".`;

const stringify = (v: unknown) => JSON.stringify(v, null, 1);

/**
 * Serialize a tool result, staying within maxChars while keeping the output valid JSON.
 * If it is too long, the largest list in the result is shortened and a `truncated` field says how many
 * items are shown; if that is not enough, the JSON text is returned as a string inside a valid wrapper.
 */
export function jsonResult(data: unknown, maxChars: number): CallToolResult {
  const full = stringify(data);
  const text = full.length <= maxChars ? full : (trimLargestList(data, maxChars) ?? cutWrapped(full, maxChars));
  return { content: [{ type: "text", text }] };
}

type Path = Array<string | number>;

/** Find the longest array within the first few levels of the value. */
function largestArray(value: unknown, path: Path = [], depth = 0): { path: Path; length: number } | undefined {
  if (depth > 4 || value === null || typeof value !== "object") return undefined;
  let best: { path: Path; length: number } | undefined;
  if (Array.isArray(value)) best = { path, length: value.length };
  const entries: Array<[string | number, unknown]> = Array.isArray(value)
    ? value.length === 1 ? [[0, value[0]]] : []
    : Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries) {
    const found = largestArray(v, [...path, k], depth + 1);
    if (found && (!best || found.length > best.length)) best = found;
  }
  return best;
}

/** Copy `root` with the array at `path` cut to `keep` items; the note goes next to the array (or wraps it). */
function withShortenedArray(root: unknown, path: Path, keep: number, total: number): unknown {
  const note = {
    shown: keep,
    total,
    note: `Output limit reached: only the first ${keep} of ${total} items are shown. ${TRUNCATION_HINT}`,
  };
  const rebuild = (node: unknown, i: number): unknown => {
    if (i === path.length) return (node as unknown[]).slice(0, keep);
    const key = path[i];
    if (Array.isArray(node)) return node.map((x, idx) => (idx === key ? rebuild(x, i + 1) : x));
    const obj = node as Record<string, unknown>;
    const next = { ...obj, [key]: rebuild(obj[key], i + 1) };
    return i === path.length - 1 ? { truncated: note, ...next } : next;
  };
  return path.length === 0 ? { truncated: note, items: (root as unknown[]).slice(0, keep) } : rebuild(root, 0);
}

function trimLargestList(data: unknown, maxChars: number): string | undefined {
  const target = largestArray(data);
  if (!target || target.length === 0) return undefined;
  const render = (keep: number) => stringify(withShortenedArray(data, target.path, keep, target.length));
  if (render(0).length > maxChars) return undefined;
  // Largest `keep` that still fits.
  let lo = 0;
  let hi = target.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(mid).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return render(lo);
}

function cutWrapped(full: string, maxChars: number): string {
  const wrapper = (partial: string) =>
    stringify({
      truncated: { totalChars: full.length, note: `Output limit reached; partial JSON text follows. ${TRUNCATION_HINT}` },
      partialJson: partial,
    });
  // Escaping can grow the text, so shrink until the wrapper fits.
  let len = Math.max(0, maxChars - 400);
  let out = wrapper(full.slice(0, len));
  while (out.length > maxChars && len > 0) {
    len = Math.floor(len * 0.8);
    out = wrapper(full.slice(0, len));
  }
  return out;
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
