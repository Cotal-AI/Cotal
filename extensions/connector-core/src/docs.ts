/**
 * `cotal_docs` — the version-exact Cotal knowledge base an agent reads so it is never wrong
 * about Cotal.
 *
 * The docs ship INSIDE the connector as a generated bundle ({@link DOCS_BUNDLE}), built at
 * release time from /docs, /SPEC.md and the message schema and stamped with the installed
 * version. That makes the baseline authoritative by construction: it matches the exact
 * version running, works offline, and cannot drift newer or older than what's installed.
 *
 * `refresh: true` layers an OPTIONAL remote pass on top: it fetches the same page from
 * docs.cotal.ai, but only serves it when the site reports the SAME version — so a remote
 * that has moved ahead (or is unreachable) can never feed the agent docs for a version it
 * isn't running. The tool always reports which source answered and why.
 */
import { DOCS_BUNDLE } from "./docs-bundle.generated.js";
import type { ToolResult } from "./tool-specs.js";

export interface DocsPage {
  /** URL-ish key, e.g. "architecture". Also the argument an agent passes as `page`. */
  slug: string;
  title: string;
  /** The page's classification line, e.g. "Concept (informative)" or "Reference"; "" if none. */
  kind: string;
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
  /** The machine-readable message schema (JSON). Reachable as page "schema". */
  schema: { title: string; body: string };
}

/** The installed Cotal version, for stamping the orientation card and other surfaces. */
export const DOCS_VERSION = DOCS_BUNDLE.version;

const REMOTE_BASE = "https://docs.cotal.ai";

/** Resolve a `page` argument to a bundle entry. "spec"/"schema" are aliases for the two
 *  non-page docs; everything else matches a page slug (case-insensitive). */
function resolvePage(page: string): DocsPage | undefined {
  const key = page.trim().toLowerCase().replace(/\.md$/, "");
  if (key === "spec") return { slug: "spec", title: DOCS_BUNDLE.spec.title, kind: "normative", summary: "", body: DOCS_BUNDLE.spec.body };
  if (key === "schema") return { slug: "schema", title: DOCS_BUNDLE.schema.title, kind: "reference", summary: "", body: DOCS_BUNDLE.schema.body };
  return DOCS_BUNDLE.pages.find((p) => p.slug === key);
}

/** Map a resolved slug to its markdown twin on docs.cotal.ai. */
function remoteUrl(slug: string): string {
  if (slug === "schema") return `${REMOTE_BASE}/cotal.schema.json`;
  return `${REMOTE_BASE}/${slug}.md`;
}

/** The index: version banner + every page (slug · kind · summary) + spec/schema + how to
 *  go deeper. Cheap orientation an agent reads before answering anything about Cotal. */
export function renderDocsIndex(): string {
  const rows = DOCS_BUNDLE.pages.map((p) => {
    const kind = p.kind ? ` — ${p.kind}` : "";
    return `- \`${p.slug}\`${kind}\n  ${p.summary}`;
  });
  return [
    `# Cotal v${DOCS_BUNDLE.version} — documentation`,
    "",
    "Authoritative docs for the exact version installed here. Fetch a page for the full text",
    "instead of relying on memory: `cotal_docs(page: \"<name>\")`. Search across everything:",
    "`cotal_docs(query: \"…\")`. These docs are bundled and version-exact; add `refresh: true`",
    "to also pull any doc patches published to docs.cotal.ai for this same version.",
    "",
    "## The normative sources",
    `- \`spec\` — ${DOCS_BUNDLE.spec.title} (the wire contract; where a page disagrees, the spec wins)`,
    `- \`schema\` — ${DOCS_BUNDLE.schema.title} (authoritative for message shapes)`,
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

interface Hit {
  page: DocsPage;
  score: number;
  excerpt: string;
}

/** Case-insensitive keyword search over the bundle. Title/summary weighted above body.
 *  Returns the top pages with a short excerpt around the first match, and points the agent
 *  at the full page — token-bounded, never dumps everything. */
export function searchDocs(query: string, limit = 5): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const all: DocsPage[] = [
    ...DOCS_BUNDLE.pages,
    { slug: "spec", title: DOCS_BUNDLE.spec.title, kind: "normative", summary: "", body: DOCS_BUNDLE.spec.body },
    { slug: "schema", title: DOCS_BUNDLE.schema.title, kind: "reference", summary: "", body: DOCS_BUNDLE.schema.body },
  ];
  const hits: Hit[] = [];
  for (const page of all) {
    const title = page.title.toLowerCase();
    const summary = page.summary.toLowerCase();
    const body = page.body.toLowerCase();
    let score = 0;
    for (const t of terms) {
      score += title.includes(t) ? 5 : 0;
      score += summary.includes(t) ? 3 : 0;
      score += occurrences(body, t);
    }
    if (!score) continue;
    hits.push({ page, score, excerpt: excerptAround(page.body, terms) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** A few lines of context around the first matching term. */
function excerptAround(body: string, terms: string[]): string {
  const lines = body.split("\n");
  const lc = lines.map((l) => l.toLowerCase());
  const at = lc.findIndex((l) => terms.some((t) => l.includes(t)));
  if (at === -1) return lines.slice(0, 3).join("\n").trim();
  const start = Math.max(0, at - 1);
  return lines.slice(start, start + 4).join("\n").trim();
}

function renderSearch(query: string, hits: Hit[]): string {
  if (!hits.length) {
    return `No matches for "${query}" in the Cotal v${DOCS_BUNDLE.version} docs. Try \`cotal_docs()\` for the page index, or broader terms.`;
  }
  const blocks = hits.map(
    (h) => `## \`${h.page.slug}\` — ${h.page.title}\n${h.excerpt}\n→ full page: cotal_docs(page: "${h.page.slug}")`,
  );
  return [`# Cotal docs — matches for "${query}"`, "", ...blocks].join("\n");
}

/** Fetch the version docs.cotal.ai is currently serving, or null if unavailable. */
async function remoteVersion(): Promise<string | null> {
  try {
    const r = await fetch(`${REMOTE_BASE}/docs-version.json`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { version?: unknown };
    return typeof j.version === "string" ? j.version : null;
  } catch {
    return null;
  }
}

async function remoteBody(slug: string): Promise<string | null> {
  try {
    const r = await fetch(remoteUrl(slug), { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const text = await r.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * Version-guarded remote refresh for a page. Returns the remote body ONLY when the site
 * reports the same version as the installed bundle; otherwise returns null with a reason,
 * and the caller serves the version-exact bundle. This is what keeps `refresh` from ever
 * feeding the agent docs for a version it isn't running.
 */
async function refreshPage(slug: string): Promise<{ body: string | null; note: string }> {
  const rv = await remoteVersion();
  if (rv === null) {
    return { body: null, note: `(bundled v${DOCS_BUNDLE.version}; docs.cotal.ai unreachable — showing bundled docs)` };
  }
  if (rv !== DOCS_BUNDLE.version) {
    return {
      body: null,
      note: `(bundled v${DOCS_BUNDLE.version}; docs.cotal.ai is on v${rv} — showing bundled docs to stay version-accurate)`,
    };
  }
  const body = await remoteBody(slug);
  if (body === null) {
    return { body: null, note: `(bundled v${DOCS_BUNDLE.version}; remote page fetch failed — showing bundled docs)` };
  }
  return { body, note: `(refreshed from docs.cotal.ai, v${rv})` };
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
    const found = resolvePage(page);
    if (!found) {
      const names = DOCS_BUNDLE.pages.map((p) => p.slug).join(", ");
      return {
        text: `No Cotal doc page "${page}". Available: spec, schema, ${names}. Call cotal_docs() for the index.`,
        isError: true,
      };
    }
    let note = `(bundled v${DOCS_BUNDLE.version})`;
    let body = found.body;
    if (args.refresh) {
      const r = await refreshPage(found.slug);
      note = r.note;
      if (r.body !== null) body = r.body;
    }
    return { text: renderPage({ ...found, body }, note) };
  }

  if (query) return { text: renderSearch(query, searchDocs(query)) };

  return { text: renderDocsIndex() };
}
