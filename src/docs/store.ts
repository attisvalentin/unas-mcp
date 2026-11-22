import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { extractArticle, sectionLinks } from "./html.js";

export const DOCS_BASE = "https://unas.hu/tudastar";
export const DOCS_SECTIONS = ["admin", "api", "design", "hosting", "integracio", "rendeles", "ugyfelfiok"] as const;
export type DocsSection = (typeof DOCS_SECTIONS)[number];

const SECTION_NAMES: Record<DocsSection, string> = {
  admin: "Webáruház segédlet (admin)",
  api: "API dokumentáció",
  design: "Kinézet dokumentáció",
  hosting: "Hosting",
  integracio: "Integráció",
  rendeles: "Rendelés",
  ugyfelfiok: "Ügyfélfiók",
};

/** Generic client name: no user or shop data goes to unas.hu. */
const USER_AGENT = "unas-mcp-docs/0.1 (+local knowledge base cache)";

export interface DocPage {
  url: string;
  section: DocsSection;
  slug: string;
  /** Title with the parent page prepended where the page's own title is generic ("Termékek – Adatszerkezet"). */
  title: string;
  text: string;
  fetchedAt: string;
}

interface DocsFile {
  version: 1;
  updatedAt: string;
  pages: DocPage[];
}

export interface SyncStatus {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  total: number;
  done: number;
  fetched: number;
  skipped: number;
  failed: Array<{ url: string; error: string }>;
  error?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  section: DocsSection;
  score: number;
  snippet: string;
}

type FetchLike = typeof fetch;

export function defaultDocsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.UNAS_DOCS_DIR) return env.UNAS_DOCS_DIR;
  const cache = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "unas-mcp");
}

/** Lower case without diacritics, so "értesítés" and "ertesites" match. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function tokenize(s: string): string[] {
  return fold(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/** Common Hungarian (and a few English) words that carry no meaning in a search query (accents folded). */
const STOPWORDS = new Set(
  (
    "az egy es is hol hogy hogyan mi mit mik mely melyik milyen miert mikor van vannak nem be ki meg el fel le at " +
    "ra re ba be ban ben nal nel tol tol bol rol rol ott itt ez ezt azt ezek azok kell lehet tudok tudom tudod " +
    "lehetseges szeretnek szeretnem vagy de ha mar meg csak minden kerem kerlek the a an of to in on for how what " +
    "where is are can do does"
  ).split(" ")
);

/** Query terms: tokens without stop words (unless the query is nothing but stop words). */
export function queryTerms(query: string): string[] {
  const all = [...new Set(tokenize(query))];
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  return meaningful.length ? meaningful : all;
}

/**
 * Hungarian is agglutinative ("értesítés", "értesítések", "értesítésekben"), so a query term matches every
 * document term that starts with its stem.
 */
function stem(term: string): string {
  if (term.length >= 8) return term.slice(0, term.length - 3);
  if (term.length >= 6) return term.slice(0, term.length - 2);
  return term;
}

interface Indexed {
  page: DocPage;
  terms: Map<string, number>;
  length: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DocsStore {
  private pages = new Map<string, DocPage>();
  private index?: Indexed[];
  private loaded = false;
  private sync_: SyncStatus = { running: false, total: 0, done: 0, fetched: 0, skipped: 0, failed: [] };
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string = defaultDocsDir(),
    private fetchImpl: FetchLike = fetch,
    private opts: { delayMs?: number; concurrency?: number; maxAgeDays?: number } = {}
  ) {}

  get file() {
    return join(this.dir, "docs.json");
  }

  get syncStatus(): SyncStatus {
    return { ...this.sync_, failed: [...this.sync_.failed] };
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as DocsFile;
      for (const p of data.pages ?? []) this.pages.set(p.url, p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.index = undefined;
  }

  async count(): Promise<number> {
    await this.load();
    return this.pages.size;
  }

  private async save(): Promise<void> {
    // Serialize writes; write to a temp file and rename so a crash never leaves a half-written cache.
    this.writing = this.writing.then(async () => {
      const data: DocsFile = { version: 1, updatedAt: new Date().toISOString(), pages: [...this.pages.values()] };
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  private async get(url: string): Promise<string> {
    const res = await this.fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  /** Resolve "termekek-adatszerkezet", "api/termekek" or a full URL to a knowledge base URL. */
  resolve(ref: string): string {
    const r = ref.trim();
    if (/^https?:\/\//i.test(r)) {
      const u = new URL(r);
      if (u.hostname !== "unas.hu" || !u.pathname.startsWith("/tudastar/")) {
        throw new Error("Only unas.hu/tudastar pages can be read.");
      }
      return `${DOCS_BASE}${u.pathname.slice("/tudastar".length).replace(/\/$/, "")}`;
    }
    const path = r.replace(/^\/?(tudastar\/)?/, "").replace(/\/$/, "");
    if (/^[a-z]+\/[A-Za-z0-9_-]+$/.test(path)) return `${DOCS_BASE}/${path}`;
    // A bare slug: find it among the cached pages.
    const hit = [...this.pages.values()].find((p) => p.slug === path);
    if (hit) return hit.url;
    throw new Error(`Unknown page "${ref}". Use a URL or section/slug, e.g. "api/termekek-adatszerkezet".`);
  }

  private parse(url: string, html: string, titles: Map<string, string>): DocPage {
    const m = url.match(/\/tudastar\/([a-z]+)\/([A-Za-z0-9_-]+)$/);
    if (!m) throw new Error(`Not a knowledge base page URL: ${url}`);
    const [, section, slug] = m;
    const article = extractArticle(html);
    if (!article) throw new Error("No article content on the page");
    const own = article.title || slug;
    // API subpages are titled "Adatszerkezet", "getProduct kérés" ...: prefix the parent page's title.
    const parentSlug = [...titles.keys()]
      .filter((s) => slug !== s && slug.startsWith(`${s}-`))
      .sort((a, b) => b.length - a.length)[0];
    const parent = parentSlug ? titles.get(parentSlug) : undefined;
    const title = parent && !fold(own).includes(fold(parent)) ? `${parent} – ${own}` : own;
    return {
      url,
      section: section as DocsSection,
      slug,
      title,
      text: article.text,
      fetchedAt: new Date().toISOString(),
    };
  }

  private titleMap(): Map<string, string> {
    const titles = new Map<string, string>();
    for (const p of this.pages.values()) titles.set(p.slug, p.title.split(" – ")[0]);
    return titles;
  }

  /** Read one page: from the cache, or fetched (and cached) if missing. */
  async read(ref: string): Promise<DocPage> {
    await this.load();
    const url = this.resolve(ref);
    const cached = this.pages.get(url);
    if (cached) return cached;
    const page = this.parse(url, await this.get(url), this.titleMap());
    this.pages.set(url, page);
    this.index = undefined;
    await this.save();
    return page;
  }

  /** Start a background sync (no-op if one is running). Resolves when it finishes. */
  startSync(options: { sections?: DocsSection[]; force?: boolean } = {}): Promise<SyncStatus> {
    if (this.sync_.running) return this.currentSync!;
    this.sync_ = {
      running: true,
      startedAt: new Date().toISOString(),
      total: 0,
      done: 0,
      fetched: 0,
      skipped: 0,
      failed: [],
    };
    this.currentSync = this.runSync(options).then(
      () => this.finishSync(),
      (err) => this.finishSync(err instanceof Error ? err.message : String(err))
    );
    return this.currentSync;
  }

  private currentSync?: Promise<SyncStatus>;

  private finishSync(error?: string): SyncStatus {
    this.sync_.running = false;
    this.sync_.finishedAt = new Date().toISOString();
    if (error) this.sync_.error = error;
    return this.syncStatus;
  }

  private async runSync(options: { sections?: DocsSection[]; force?: boolean }) {
    await this.load();
    const delayMs = this.opts.delayMs ?? 250;
    const concurrency = this.opts.concurrency ?? 2;
    const maxAgeMs = (this.opts.maxAgeDays ?? 30) * 24 * 3600 * 1000;
    const sections = options.sections?.length ? options.sections : [...DOCS_SECTIONS];

    // 1. Page lists from each section's index page (its sidebar lists every page of the section).
    const urls: string[] = [];
    for (const section of sections) {
      const html = await this.get(`${DOCS_BASE}/${section}`);
      urls.push(...sectionLinks(html, DOCS_BASE, section));
      await sleep(delayMs);
    }
    // Parents before their subpages, so subpage titles can be prefixed in the same run.
    urls.sort((a, b) => a.length - b.length || a.localeCompare(b));
    this.sync_.total = urls.length;

    // 2. The pages, politely: few parallel requests with a pause between them.
    const titles = this.titleMap();
    const queue = [...urls];
    let sinceSave = 0;
    const worker = async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        const cached = this.pages.get(url);
        const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < maxAgeMs;
        if (fresh && !options.force) {
          this.sync_.skipped++;
        } else {
          try {
            const page = this.parse(url, await this.get(url), titles);
            this.pages.set(url, page);
            titles.set(page.slug, page.title.split(" – ")[0]);
            this.index = undefined;
            this.sync_.fetched++;
            if (++sinceSave >= 50) {
              sinceSave = 0;
              await this.save();
            }
          } catch (err) {
            this.sync_.failed.push({ url, error: err instanceof Error ? err.message : String(err) });
          }
          await sleep(delayMs);
        }
        this.sync_.done++;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    await this.save();
  }

  private buildIndex(): Indexed[] {
    if (this.index) return this.index;
    this.index = [...this.pages.values()].map((page) => {
      const terms = new Map<string, number>();
      // The title counts three times: a match there is a strong signal.
      const tokens = [...tokenize(page.title), ...tokenize(page.title), ...tokenize(page.title), ...tokenize(page.text)];
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
      return { page, terms, length: tokens.length };
    });
    return this.index;
  }

  /** BM25 ranking over title + text, with stem (prefix) matching for Hungarian word forms. */
  async search(query: string, opts: { section?: DocsSection; limit?: number } = {}): Promise<SearchHit[]> {
    await this.load();
    const qTerms = queryTerms(query).map(stem);
    if (qTerms.length === 0) return [];
    const docs = this.buildIndex().filter((d) => !opts.section || d.page.section === opts.section);
    if (docs.length === 0) return [];
    const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length;
    const k1 = 1.2;
    const b = 0.75;

    const tfFor = (d: Indexed, q: string) => {
      let tf = 0;
      for (const [term, n] of d.terms) if (term.startsWith(q)) tf += n;
      return tf;
    };
    const tfs = docs.map((d) => qTerms.map((q) => tfFor(d, q)));
    const df = qTerms.map((_, i) => tfs.filter((row) => row[i] > 0).length);

    const scored = docs.map((d, di) => {
      let score = 0;
      let matched = 0;
      qTerms.forEach((_, i) => {
        const tf = tfs[di][i];
        if (tf === 0) return;
        matched++;
        const idf = Math.log(1 + (docs.length - df[i] + 0.5) / (df[i] + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avgLen));
      });
      // Prefer pages that contain all the query terms.
      return { d, score: score * (matched / qTerms.length) };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, opts.limit ?? 5)
      .map(({ d, score }) => ({
        title: d.page.title,
        url: d.page.url,
        section: d.page.section,
        score: Math.round(score * 100) / 100,
        snippet: snippet(d.page.text, qTerms),
      }));
  }

  static sectionName(s: DocsSection) {
    return SECTION_NAMES[s];
  }
}

/** ~300 characters around the first line that contains a query stem. */
function snippet(text: string, stems: string[]): string {
  const folded = fold(text);
  let at = -1;
  for (const s of stems) {
    const re = new RegExp(`(^|[^a-z0-9])${s.replace(/[^a-z0-9]/g, "")}`);
    const m = re.exec(folded);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) at = 0;
  const from = Math.max(0, at - 80);
  const out = text.slice(from, from + 300).replace(/\s+/g, " ").trim();
  return (from > 0 ? "…" : "") + out + (from + 300 < text.length ? "…" : "");
}
