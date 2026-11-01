/**
 * `cotal_docs` is the Cotal knowledge base bundled with each release.
 *
 * The docs ship inside the connector as a generated bundle ({@link loadDocsSource}), built at
 * release time from /docs, /SPEC.md and the message schema and stamped with the installed
 * version. The baseline matches the running version, works offline, and cannot drift from what is
 * installed.
 *
 * `refresh: true` adds an optional remote pass. It fetches the page from an immutable,
 * version-pinned path on docs.cotal.ai (/v/<installed-version>/…), so the response belongs to the
 * installed release. When that path is absent (version-pinned docs are not published yet) or
 * unreachable, the tool falls back to the bundled copy and reports which source answered.
 */
import { DOCS_VERSION, loadDocsIndex, loadDocsMetadata, loadDocsSource, loadDocsSourceLengths } from "./docs-bundle.generated.js";
import { decodeIndex, STOP, tokenize } from "./docs-index-core.js";
import type { ToolResult } from "./tool-specs.js";

export { DOCS_VERSION } from "./docs-bundle.generated.js";

/** The categories the docs index lists pages under, in its order. */
export const DOCS_CATEGORIES = ["Start here", "Guide", "Concept", "Reference", "Project"] as const;
export type DocsCategory = (typeof DOCS_CATEGORIES)[number];

export interface DocsPage {
  /** URL-ish key, e.g. "architecture". Also the argument an agent passes as `page`. */
  slug: string;
  title: string;
  /** The page's classification line, e.g. "Concept (informative)" or "Reference". */
  kind: string;
  /** The category that line names, which the index lists the page under. The spec and lang are
   *  `normative`, and the schema is `reference`. */
  category: DocsCategory | "normative" | "reference";
  /** One-line summary for the index. */
  summary: string;
  /** Full Markdown. */
  body: string;
}

export interface DocsBundle {
  /** The installed Cotal version these docs are exact for, e.g. "0.10.1". */
  version: string;
  generatedFrom: string;
  pages: DocsPage[];
  /** The normative wire contract (SPEC.md). Reachable as page "spec". */
  spec: { title: string; body: string };
  /** The normative workflow-language reference (spec/cotal-lang.md). Reachable as page "lang". */
  lang: { title: string; body: string };
  /** The machine-readable message schema (JSON). Reachable as page "schema". */
  schema: { title: string; body: string };
}

/** Index fields generated from the same sources, without the page bodies. */
export interface DocsMetadata {
  version: string;
  pages: Omit<DocsPage, "body">[];
  spec: { title: string };
  lang: { title: string };
  schema: { title: string };
}

let indexed: DocsMetadata | undefined;
function metadata(): DocsMetadata {
  return (indexed ??= loadDocsMetadata());
}

// A search needs only the bodies of its selected hits, not every page in the corpus.
const pages = new Map<number, DocsPage>();
function localPage(source: number): DocsPage {
  let page = pages.get(source);
  if (!page) {
    page = { ...metadata().pages[source], body: loadDocsSource(source) };
    pages.set(source, page);
  }
  return page;
}
function sourceBody(source: number): string {
  return source < metadata().pages.length ? localPage(source).body : loadDocsSource(source);
}

const REMOTE_BASE = "https://docs.cotal.ai";

/** Resolve a `page` argument to a bundle entry. "spec"/"lang"/"schema" are aliases for the three
 *  non-page docs; everything else matches a page slug (case-insensitive). */
function resolvePage(page: string): DocsPage | undefined {
  const key = page.trim().toLowerCase().replace(/\.md$/, "");
  const meta = metadata();
  // Page reads still fail closed on a missing or mismatched corpus, including unknown page names.
  loadDocsSourceLengths();
  const count = meta.pages.length;
  if (key === "spec") return { slug: "spec", title: meta.spec.title, kind: "normative", category: "normative", summary: "", body: loadDocsSource(count) };
  if (key === "lang" || key === "cotal-lang") return { slug: "lang", title: meta.lang.title, kind: "normative", category: "normative", summary: "", body: loadDocsSource(count + 1) };
  if (key === "schema") return { slug: "schema", title: meta.schema.title, kind: "reference", category: "reference", summary: "", body: loadDocsSource(count + 2) };
  const source = meta.pages.findIndex((p, source) => (pages.get(source) ?? p).slug === key);
  return source < 0 ? undefined : localPage(source);
}

/** Map a resolved slug to an IMMUTABLE, version-pinned URL on docs.cotal.ai. Pinning the version
 *  into the path is what makes a fetched body provably belong to the installed version. */
function remoteUrl(slug: string): string {
  const base = `${REMOTE_BASE}/v/${DOCS_VERSION}`;
  if (slug === "schema") return `${base}/cotal.schema.json`;
  if (slug === "lang") return `${base}/cotal-lang.md`;
  return `${base}/${slug}.md`;
}

/** The index: version banner + every page (slug · kind · summary) + spec/schema + how to
 *  go deeper. Cheap orientation an agent reads before answering anything about Cotal. */
export function renderDocsIndex(): string {
  const b = metadata();
  const rows = b.pages.map((p) => {
    const kind = p.kind ? `: ${p.kind}` : "";
    return `- \`${p.slug}\`${kind}\n  ${p.summary}`;
  });
  return [
    `# Cotal v${b.version} documentation`,
    "",
    "The authoritative docs bundled with this installed version. This index lists what",
    "exists; it holds no answers itself. Your next call:",
    '- Know the page? Read it in full: `cotal_docs(page: "<slug>")` (e.g. "spec", "architecture").',
    '- Not sure which page? Search: `cotal_docs(query: "…")` returns the most relevant sections.',
    "Prefer these docs over training memory, and read the full page before writing code or wire",
    "frames. Docs are bundled and version-exact; add `refresh: true` to also pull any patches",
    "published to docs.cotal.ai for this same version.",
    "",
    "## The normative sources",
    `- \`spec\`: ${b.spec.title} (the wire contract; where a page disagrees, the spec wins)`,
    `- \`lang\`: ${b.lang.title} (the workflow language a durable run executes; spec §14)`,
    `- \`schema\`: ${b.schema.title} (authoritative for message shapes)`,
    "",
    "## Pages",
    ...rows,
  ].join("\n");
}

/** Render one page for the model. `note` (e.g. the remote-source line) is prepended so the
 *  agent always sees where the text came from. */
function renderPage(p: DocsPage, note: string): string {
  return `${note}\n\n${p.body}`.trimStart();
}

// ─── Search: BM25 over heading-aware sections (offline, no embeddings) ───
// Version-exact docs make LEXICAL retrieval the right tool: the queries are dominated by exact
// identifiers (subjects, `cotal_*` tools, field names, `$SYS.*`), and BM25 with IDF + length
// normalization beats naive term-counting on precisely those. We index SECTIONS (a heading and
// its body), not whole pages, so a hit returns the specific passage the agent wants — code
// fences kept intact — with a pointer back to the full page. This mirrors the current
// architecture (index → fetch full page, the model is the retriever); search is the shortcut
// for "I don't yet know which page."

const K1 = 1.2;
const B = 0.75;

/** The sources the index numbers, in its order: each page, the spec, the language reference, the schema. */
function sources(): { slug: string; title: string }[] {
  const b = metadata();
  return [
    ...b.pages.map((page, source) => pages.get(source) ?? page),
    { slug: "spec", ...b.spec },
    { slug: "lang", ...b.lang },
    { slug: "schema", ...b.schema },
  ];
}

// Read, checked and decoded on the first search from the index asset the generator precomputed, for the same reason as the bundle.
let index: ReturnType<typeof decodeIndex> | undefined;
function searchIndex(): ReturnType<typeof decodeIndex> {
  if (index) return index;
  const lengths = loadDocsSourceLengths();
  // A returned ordinary page remains mutable, as before selective decoding.
  for (const [source, page] of pages) lengths[source] = page.body.length;
  return (index = decodeIndex(loadDocsIndex(), lengths, DOCS_VERSION));
}

/** The id of a term in the sorted term list, by binary search, or -1. */
function termId(terms: string[], term: string): number {
  let low = 0;
  let high = terms.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const candidate = terms[mid];
    if (candidate === term) return mid;
    if (candidate < term) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

export interface DocHit {
  /** Page slug to fetch in full via cotal_docs(page: slug). */
  slug: string;
  pageTitle: string;
  heading: string;
  /** The matching section's Markdown. */
  text: string;
  score: number;
}

/** BM25 search over heading-aware sections. Returns the best-matching sections (at most two per
 *  page, for diversity), each with a pointer to read the full page. Offline; no embeddings. */
export function searchDocs(query: string, limit = 5): DocHit[] {
  if (limit <= 0) return [];
  let terms = tokenize(query).filter((t) => !STOP.has(t));
  if (!terms.length) terms = tokenize(query); // all-stopword query → keep the raw terms
  const termSet = new Set(terms);
  if (!termSet.size) return [];

  const idx = searchIndex();
  const N = idx.sections;
  const scores = new Float64Array(N);
  for (const t of termSet) {
    const id = termId(idx.terms, t);
    if (id < 0) continue;
    const from = idx.offsets[id];
    const to = idx.offsets[id + 1];
    const n = to - from;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    for (let p = from; p < to; p++) {
      const s = idx.postSection[p];
      const f = idx.postWeight[p];
      scores[s] += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * idx.length[s]) / idx.avgdl)));
    }
  }
  const scored: { s: number; score: number }[] = [];
  for (let s = 0; s < N; s++) if (scores[s] > 0) scored.push({ s, score: scores[s] });
  scored.sort((a, b) => b.score - a.score);

  const all = sources();
  const perPage = new Map<string, number>();
  const hits: DocHit[] = [];
  for (const { s, score } of scored) {
    const source = all[idx.source[s]];
    const seen = perPage.get(source.slug) ?? 0;
    if (seen >= 2) continue; // don't let one page crowd out the rest
    perPage.set(source.slug, seen + 1);
    hits.push({ slug: source.slug, pageTitle: source.title, heading: idx.headings[s], text: sourceBody(idx.source[s]).slice(idx.start[s], idx.end[s]), score });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Cap a section so a single long match can't blow the context; the pointer covers the rest. */
export function capSection(text: string, maxLines = 48): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text.trim();
  return lines.slice(0, maxLines).join("\n").trimEnd() + "\n\n… (section continues; read the full page)";
}

function renderSearch(query: string, hits: DocHit[]): string {
  if (!hits.length) {
    return `No matches for "${query}" in the Cotal v${DOCS_VERSION} docs. Call cotal_docs() for the page index, or search an exact identifier (a subject, a cotal_* tool, a field name).`;
  }
  const blocks = hits.map(
    (h) => `## ${h.heading}\n${capSection(h.text)}\n\n→ read the full page: cotal_docs(page: "${h.slug}")`,
  );
  return [
    `# Cotal v${DOCS_VERSION} docs: top matches for "${query}"`,
    "The most relevant sections are below. Read the full page before writing code or wire frames.",
    ...blocks,
  ].join("\n\n");
}

/** Why a refresh served the bundle: the version-pinned path answered with no page, or did not answer. */
type RemoteMiss = "not-published" | "unreachable";

async function remoteBody(slug: string): Promise<{ body: string } | { miss: RemoteMiss }> {
  try {
    const r = await fetch(remoteUrl(slug), { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { miss: "not-published" };
    const text = await r.text();
    return text.trim() ? { body: text } : { miss: "not-published" };
  } catch {
    return { miss: "unreachable" };
  }
}

/** One page as read: the bundled copy, or with `refresh` the version-pinned copy from docs.cotal.ai
 *  when that path serves one. `refresh` says what the remote pass did, or null when none was asked. */
export interface DocsPageRead {
  readonly version: string;
  readonly page: DocsPage;
  readonly source: "bundled" | "docs.cotal.ai";
  readonly refresh: "served" | RemoteMiss | null;
}

/**
 * Read one page. `refresh` fetches the IMMUTABLE, version-pinned path
 * (docs.cotal.ai/v/<installed-version>/…): a 200 body provably belongs to the installed
 * version, so there is no separate version check to race or skew against. When that path is
 * absent (version-pinned docs aren't published yet) or unreachable, the version-exact bundle is
 * served. Fail-closed: an unverifiable remote is never served. Undefined for an unknown page.
 */
export async function readDocsPage(page: string, opts: { refresh?: boolean } = {}): Promise<DocsPageRead | undefined> {
  const found = resolvePage(page);
  if (!found) return undefined;
  const version = DOCS_VERSION;
  if (!opts.refresh) return { version, page: found, source: "bundled", refresh: null };
  const remote = await remoteBody(found.slug);
  if ("miss" in remote) return { version, page: found, source: "bundled", refresh: remote.miss };
  return { version, page: { ...found, body: remote.body }, source: "docs.cotal.ai", refresh: "served" };
}

/** The bundled docs' version, their normative sources and their pages, for an index, the pages in
 *  the order of their categories. */
export function docsIndex(): { version: string; sources: { slug: string; title: string }[]; pages: Omit<DocsPage, "body">[] } {
  const b = metadata();
  return {
    version: b.version,
    sources: [{ slug: "spec", title: b.spec.title }, { slug: "lang", title: b.lang.title }, { slug: "schema", title: b.schema.title }],
    pages: b.pages.map(({ slug, title, kind, category, summary }) => ({ slug, title, kind, category, summary })).sort((x, y) => DOCS_CATEGORIES.indexOf(x.category as DocsCategory) - DOCS_CATEGORIES.indexOf(y.category as DocsCategory)),
  };
}

export interface DocsArgs {
  page?: string;
  query?: string;
  refresh?: boolean;
}

/** The `cotal_docs` tool body. Pure over the bundle except for the opt-in remote refresh. */
export async function runDocs(args: DocsArgs): Promise<ToolResult> {
  const page = args.page?.trim();
  const query = args.query?.trim();

  if (page) {
    const read = await readDocsPage(page, { refresh: args.refresh });
    if (!read) {
      const names = metadata().pages.map((p, source) => (pages.get(source) ?? p).slug).join(", ");
      return {
        text: `No Cotal doc page "${page}". Available: spec, lang, schema, ${names}. Call cotal_docs() for the index.`,
        isError: true,
      };
    }
    const v = read.version;
    const note =
      read.refresh === null ? `(bundled v${v})`
      : read.refresh === "served" ? `(refreshed from docs.cotal.ai; version-pinned copy for v${v})`
      : `(bundled v${v}; no version-pinned copy at docs.cotal.ai/v/${v}; showing bundled docs)`;
    return { text: renderPage(read.page, note) };
  }

  // `refresh` only applies to reading a page; say so rather than silently ignore it, so an
  // agent never believes a searched/indexed result was patched from the remote.
  const refreshNote =
    args.refresh && !page
      ? "\n\n(note: `refresh` applies only when reading a page; the index and search use the bundled docs.)"
      : "";

  if (query) return { text: renderSearch(query, searchDocs(query)) + refreshNote };

  return { text: renderDocsIndex() + refreshNote };
}
