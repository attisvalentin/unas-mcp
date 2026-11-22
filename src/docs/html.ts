/**
 * Minimal, dependency-free extraction of the readable text of a UNAS knowledge base page
 * (unas.hu/tudastar/...). Every page keeps its content in <article id="blog-item-0"> with the title in an <h1>.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML fragment to plain text, keeping block structure as line breaks and code samples readable. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style|noscript|svg|button)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Code samples (XML examples) are HTML-escaped inside <pre>/<code>; keep their line breaks.
  s = s.replace(/<(pre)\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, _t, inner: string) => {
    const text = inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
    return `\n\n${text}\n\n`;
  });
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|section|article|blockquote|dd|dt)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The <article> element that holds the page content, or undefined if the page has none. */
export function extractArticle(html: string): { title: string; text: string } | undefined {
  const start = html.search(/<article\b[^>]*\bid=["']blog-item-0["'][^>]*>/i);
  if (start < 0) return undefined;
  // Articles do not nest on these pages, so the first closing tag ends it.
  const end = html.indexOf("</article>", start);
  const article = html.slice(start, end < 0 ? undefined : end);
  const h1 = article.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 ? htmlToText(h1[1]).replace(/\s+/g, " ").trim() : "";
  let text = htmlToText(article);
  if (title && text.startsWith(`# ${title}`)) text = text.slice(title.length + 2).trim();
  return { title, text };
}

/** Links to knowledge base pages of one section, e.g. section "api" → https://unas.hu/tudastar/api/<slug>. */
export function sectionLinks(html: string, base: string, section: string): string[] {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}/${section}/([A-Za-z0-9_-]+)`, "g");
  const found = new Set<string>();
  for (const m of html.matchAll(re)) found.add(`${base}/${section}/${m[1]}`);
  return [...found].sort();
}
