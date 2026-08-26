/**
 * `cotal_docs` — the version-exact Cotal knowledge base an agent reads so it is never wrong
 * about Cotal.
 *
 * The docs ship INSIDE the connector as a generated bundle ({@link DOCS_BUNDLE}), built at
 * release time from /docs, /SPEC.md and the message schema and stamped with the installed
 * version. That makes the baseline authoritative by construction: it matches the exact
 * version running, works offline, and cannot drift newer or older than what's installed.
 *
 * `refresh: true` layers an OPTIONAL remote pass on top: it fetches the page from an IMMUTABLE
 * version-pinned path on docs.cotal.ai (/v/<installed-version>/…), so a fetched body provably
 * belongs to the installed version — there is nothing to skew against. When that path is absent
 * (version-pinned docs aren't published yet) or unreachable, it falls back to the version-exact
 * bundle. The tool always reports which source answered.
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
  /** The normative workflow-language reference (spec/cotal-lang.md). Reachable as page "lang". */
  lang: { title: string; body: string };
  /** The machine-readable message schema (JSON). Reachable as page "schema". */
  schema: { title: string; body: string };
}

/** The installed Cotal version, for stamping the orientation card and other surfaces. */
export const DOCS_VERSION = DOCS_BUNDLE.version;

const REMOTE_BASE = "https://docs.cotal.ai";

/** Resolve a `page` argument to a bundle entry. "spec"/"lang"/"schema" are aliases for the three
 *  non-page docs; everything else matches a page slug (case-insensitive). */
function resolvePage(page: string): DocsPage | undefined {
  const key = page.trim().toLowerCase().replace(/\.md$/, "");
  if (key === "spec") return { slug: "spec", title: DOCS_BUNDLE.spec.title, kind: "normative", summary: "", body: DOCS_BUNDLE.spec.body };
  if (key === "lang" || key === "cotal-lang") return { slug: "lang", title: DOCS_BUNDLE.lang.title, kind: "normative", summary: "", body: DOCS_BUNDLE.lang.body };
  if (key === "schema") return { slug: "schema", title: DOCS_BUNDLE.schema.title, kind: "reference", summary: "", body: DOCS_BUNDLE.schema.body };
  return DOCS_BUNDLE.pages.find((p) => p.slug === key);
}

/** Map a resolved slug to an IMMUTABLE, version-pinned URL on docs.cotal.ai. Pinning the version
 *  into the path is what makes a fetched body provably belong to the installed version. */
function remoteUrl(slug: string): string {
  const base = `${REMOTE_BASE}/v/${DOCS_BUNDLE.version}`;
  if (slug === "schema") return `${base}/cotal.schema.json`;
  if (slug === "lang") return `${base}/cotal-lang.md`;
  return `${base}/${slug}.md`;
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
    "The authoritative docs for the exact version installed here. This is the index — it lists what",
    "exists; it holds no answers itself. Your next call:",
    '- Know the page? Read it in full: `cotal_docs(page: "<slug>")` (e.g. "spec", "architecture").',
    '- Not sure which page? Search: `cotal_docs(query: "…")` returns the most relevant sections.',
    "Prefer these docs over training memory, and read the full page before writing code or wire",
    "frames. Docs are bundled and version-exact; add `refresh: true` to also pull any patches",
    "published to docs.cotal.ai for this same version.",
    "",
    "## The normative sources",
    `- \`spec\` — ${DOCS_BUNDLE.spec.title} (the wire contract; where a page disagrees, the spec wins)`,
    `- \`lang\` — ${DOCS_BUNDLE.lang.title} (the workflow language a durable run executes; spec §14)`,
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

// ─── Search: BM25 over heading-aware sections (offline, no embeddings) ───
// Version-exact docs make LEXICAL retrieval the right tool: the queries are dominated by exact
// identifiers (subjects, `cotal_*` tools, field names, `$SYS.*`), and BM25 with IDF + length
// normalization beats naive term-counting on precisely those. We index SECTIONS (a heading and
// its body), not whole pages, so a hit returns the specific passage the agent wants — code
// fences kept intact — with a pointer back to the full page. This mirrors the current
// architecture (index → fetch full page, the model is the retriever); search is the shortcut
// for "I don't yet know which page."

interface Section {
  slug: string;
  pageTitle: string;
  /** Heading path shown to the agent, e.g. "Channels and permissions › The three verbs". */
  heading: string;
  /** The section's raw Markdown (its heading line included). */
  text: string;
  /** Field-boosted tokens (page title / heading repeated) used for scoring. */
  tokens: string[];
  len: number;
}

/** Keep identifiers and subjects whole: `cotal_send`, `$SYS.ACCOUNT`, `#general`, `allowSubscribe`. */
const TOKEN = /[a-z0-9_$.#>*-]+/gi;
/** Trailing/leading subject-wildcard and punctuation noise: `$SYS.>` → `$SYS`, `team.*` → `team`. */
const EDGE = /^[.>*#-]+|[.>*#-]+$/g;
function tokenize(s: string): string[] {
  const raw = s.toLowerCase().match(TOKEN);
  if (!raw) return [];
  const out: string[] = [];
  for (const r of raw) {
    // The raw form first, so an exact wildcard/identifier match (`team.>`, `cotal_send`) keeps
    // its full weight and out-scores a mere base-subject match.
    if (r.length >= 2) out.push(r);
    // The wildcard-stripped base, so `$SYS.>` still finds the section documenting `$SYS`.
    const t = r.replace(EDGE, "");
    if (t.length >= 2 && t !== r) out.push(t);
    // Dotted segments, so `cotal.schema.json` matches a `schema` query.
    if (t.includes(".")) for (const seg of t.split(".")) if (seg.length >= 2) out.push(seg);
  }
  return out;
}

// Query-side stopwords only (the corpus keeps everything so IDF stays honest).
const STOP = new Set(
  "a an and are as at be by do for from has how in is it of on or that the this to use using was what when where which who with you your".split(" "),
);

function sectionsOf(slug: string, pageTitle: string, body: string): Section[] {
  const out: Section[] = [];
  let heading = pageTitle;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) {
      const tokens = [
        ...tokenize(pageTitle), ...tokenize(pageTitle), ...tokenize(pageTitle), // title ×3
        ...tokenize(heading), ...tokenize(heading), // heading ×2
        ...tokenize(text),
      ];
      out.push({ slug, pageTitle, heading, text, tokens, len: tokens.length });
    }
    buf = [];
  };
  let inFence = false;
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const h = inFence ? null : line.match(/^#{2,6}\s+(.+?)\s*$/);
    if (h) {
      flush();
      heading = `${pageTitle} › ${h[1].trim()}`;
    }
    buf.push(line);
  }
  flush();
  return out;
}

const K1 = 1.2;
const B = 0.75;

function buildIndex(): { sections: Section[]; df: Map<string, number>; avgdl: number } {
  const sections: Section[] = [];
  for (const p of DOCS_BUNDLE.pages) sections.push(...sectionsOf(p.slug, p.title, p.body));
  sections.push(...sectionsOf("spec", DOCS_BUNDLE.spec.title, DOCS_BUNDLE.spec.body));
  sections.push(...sectionsOf("lang", DOCS_BUNDLE.lang.title, DOCS_BUNDLE.lang.body));
  // The schema is JSON (no Markdown headings) — index it as a single section.
  const sTok = [...tokenize(DOCS_BUNDLE.schema.title), ...tokenize(DOCS_BUNDLE.schema.title), ...tokenize(DOCS_BUNDLE.schema.body)];
  sections.push({ slug: "schema", pageTitle: DOCS_BUNDLE.schema.title, heading: DOCS_BUNDLE.schema.title, text: DOCS_BUNDLE.schema.body, tokens: sTok, len: sTok.length });

  const df = new Map<string, number>();
  let total = 0;
  for (const s of sections) {
    total += s.len;
    for (const t of new Set(s.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { sections, df, avgdl: total / Math.max(1, sections.length) };
}

// Built once at import: the bundle is static, so the section index is too.
const INDEX = buildIndex();

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
  let terms = tokenize(query).filter((t) => !STOP.has(t));
  if (!terms.length) terms = tokenize(query); // all-stopword query → keep the raw terms
  const termSet = new Set(terms);
  if (!termSet.size) return [];

  const N = INDEX.sections.length;
  const scored: { s: Section; score: number }[] = [];
  for (const s of INDEX.sections) {
    const tf = new Map<string, number>();
    for (const t of s.tokens) if (termSet.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of termSet) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const n = INDEX.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * s.len) / INDEX.avgdl)));
    }
    if (score > 0) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const perPage = new Map<string, number>();
  const hits: DocHit[] = [];
  for (const { s, score } of scored) {
    const seen = perPage.get(s.slug) ?? 0;
    if (seen >= 2) continue; // don't let one page crowd out the rest
    perPage.set(s.slug, seen + 1);
    hits.push({ slug: s.slug, pageTitle: s.pageTitle, heading: s.heading, text: s.text, score });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Cap a section so a single long match can't blow the context; the pointer covers the rest. */
function capSection(text: string, maxLines = 48): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text.trim();
  return lines.slice(0, maxLines).join("\n").trimEnd() + "\n\n… (section continues — read the full page)";
}

function renderSearch(query: string, hits: DocHit[]): string {
  if (!hits.length) {
    return `No matches for "${query}" in the Cotal v${DOCS_BUNDLE.version} docs. Call cotal_docs() for the page index, or search an exact identifier (a subject, a cotal_* tool, a field name).`;
  }
  const blocks = hits.map(
    (h) => `## ${h.heading}\n${capSection(h.text)}\n\n→ read the full page: cotal_docs(page: "${h.slug}")`,
  );
  return [
    `# Cotal v${DOCS_BUNDLE.version} docs — top matches for "${query}"`,
    "The most relevant sections are below. Read the full page before writing code or wire frames.",
    ...blocks,
  ].join("\n\n");
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
 * Remote refresh for a page. It fetches the IMMUTABLE, version-pinned path
 * (docs.cotal.ai/v/<installed-version>/…): a 200 body provably belongs to the installed
 * version, so there is no separate version check to race or skew against. When that path is
 * absent (version-pinned docs aren't published yet) or unreachable, it returns null and the
 * caller serves the version-exact bundle. Fail-closed — an unverifiable remote is never served.
 */
async function refreshPage(slug: string): Promise<{ body: string | null; note: string }> {
  const body = await remoteBody(slug);
  if (body === null) {
    return {
      body: null,
      note: `(bundled v${DOCS_BUNDLE.version}; no version-pinned copy at docs.cotal.ai/v/${DOCS_BUNDLE.version} — showing bundled docs)`,
    };
  }
  return { body, note: `(refreshed from docs.cotal.ai — version-pinned copy for v${DOCS_BUNDLE.version})` };
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
        text: `No Cotal doc page "${page}". Available: spec, lang, schema, ${names}. Call cotal_docs() for the index.`,
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

  // `refresh` only applies to reading a page; say so rather than silently ignore it, so an
  // agent never believes a searched/indexed result was patched from the remote.
  const refreshNote =
    args.refresh && !page
      ? "\n\n(note: `refresh` applies only when reading a page; the index and search use the bundled docs.)"
      : "";

  if (query) return { text: renderSearch(query, searchDocs(query)) + refreshNote };

  return { text: renderDocsIndex() + refreshNote };
}
