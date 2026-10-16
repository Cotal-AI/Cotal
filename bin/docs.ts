/**
 * `cotal docs [page]`: the installed version's own protocol and CLI docs, offline. It reads the docs
 * bundle that ships in `@cotal-ai/connector-core`, the one `cotal_docs` serves agents.
 *
 * Registered here, in the composition root, because the CLI package must not depend on an extension.
 * The bundle is imported inside `run` through its narrow subpath, so no other command loads it.
 */
import { registry, type Command, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, jsonFlag, plainFlag, presentationOf, writeResult, type Cell, type Report } from "@cotal-ai/workspace";

const searchFlag = { name: "search", type: "string", value: "<query>", description: "show the sections that best match a query" } as const;
const refreshFlag = { name: "refresh", type: "boolean", description: "also try the version-pinned copy of the page on docs.cotal.ai" } as const;
export const docsFlags = [searchFlag, refreshFlag, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);

type Docs = typeof import("@cotal-ai/connector-core/docs");

interface DocsIndexResult extends ReturnType<Docs["docsIndex"]> {
  readonly kind: "docs-index";
}

interface DocsPageResult {
  readonly kind: "docs-page";
  readonly version: string;
  readonly slug: string;
  readonly title: string;
  readonly source: "bundled" | "docs.cotal.ai";
  readonly refresh: "served" | "not-published" | "unreachable" | null;
  readonly body: string;
}

interface DocsSearchResult {
  readonly kind: "docs-search";
  readonly version: string;
  readonly query: string;
  readonly hits: readonly { readonly slug: string; readonly page: string; readonly heading: string; readonly text: string }[];
}

async function docs(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof docsFlags>;
  const presentation = presentationOf(v);
  if (args.positionals.length > 1) throw usage("docs takes at most one page");
  const page = args.positionals[0];
  const query = v.search?.trim();
  if (v.search !== undefined && !query) throw usage("--search takes a query");
  if (page !== undefined && query !== undefined) throw usage("give a page or --search, not both");
  if (v.refresh && page === undefined) throw usage("--refresh applies to reading a page; the index and search use the bundled docs");

  const d: Docs = await import("@cotal-ai/connector-core/docs");
  if (page !== undefined) {
    const read = await d.readDocsPage(page, { refresh: v.refresh });
    if (!read) {
      const slugs = ["spec", "lang", "schema", ...d.docsIndex().pages.map((p) => p.slug)];
      throw usage(`no docs page "${page}"; pages: ${slugs.join(", ")}`);
    }
    const result: DocsPageResult = { kind: "docs-page", version: read.version, slug: read.page.slug, title: read.page.title, source: read.source, refresh: read.refresh, body: read.page.body };
    writeResult(presentation, { command: "docs", target: null, result }, pageView);
    return;
  }
  if (query !== undefined) {
    const hits = d.searchDocs(query).map((h) => ({ slug: h.slug, page: h.pageTitle, heading: h.heading, text: d.capSection(h.text) }));
    const result: DocsSearchResult = { kind: "docs-search", version: d.docsIndex().version, query, hits };
    writeResult(presentation, { command: "docs", target: null, result }, searchView);
    return;
  }
  const result: DocsIndexResult = { kind: "docs-index", ...d.docsIndex() };
  writeResult(presentation, { command: "docs", target: null, result }, indexView);
}

function indexView(r: DocsIndexResult): Report {
  const row = (slug: string, kind: string, about: string) => ({ slug: { text: slug, tone: "command" as const }, kind, about });
  const columns = [{ key: "slug", label: "PAGE" }, { key: "kind", label: "KIND" }, { key: "about", label: "ABOUT" }];
  return {
    sections: [
      { title: `Cotal v${r.version} documentation`, blocks: [{ kind: "lines", lines: [{ text: "Bundled with this installed version and readable offline.", tone: "hint" }] }] },
      { title: "Normative sources", blocks: [{ kind: "table", columns, rows: r.sources.map((s) => row(s.slug, "normative", s.title)) }] },
      { title: "Pages", blocks: [{ kind: "table", columns, rows: r.pages.map((p) => row(p.slug, p.kind, p.summary || p.title)) }] },
      { blocks: [{ kind: "lines", lines: [{ text: "Read a page with `cotal docs <page>`; search with `cotal docs --search <query>`.", tone: "hint" }] }] },
    ],
  };
}

function pageView(r: DocsPageResult): Report {
  const note: Cell =
    r.refresh === null ? { text: `bundled v${r.version}`, tone: "hint" }
    : r.refresh === "served" ? { text: `refreshed from docs.cotal.ai: the version-pinned copy for v${r.version}`, tone: "hint" }
    : { text: `bundled v${r.version}: docs.cotal.ai ${r.refresh === "unreachable" ? "did not answer" : `has no version-pinned copy for v${r.version}`}`, tone: "waiting" };
  return { sections: [{ blocks: [{ kind: "lines", lines: [note] }] }, { blocks: [{ kind: "lines", lines: r.body.split("\n") }] }] };
}

function searchView(r: DocsSearchResult): Report {
  if (!r.hits.length)
    return { sections: [{ blocks: [{ kind: "lines", lines: [{ text: `no matches for "${r.query}" in the Cotal v${r.version} docs; \`cotal docs\` lists the pages, or search an exact identifier`, tone: "hint" }] }] }] };
  return {
    sections: r.hits.map((h) => ({
      title: h.heading,
      blocks: [{ kind: "lines" as const, lines: [...h.text.split("\n"), { text: `read the full page: cotal docs ${h.slug}`, tone: "hint" as const }] }],
    })),
  };
}

const docsCommand: Command = {
  kind: "command",
  name: "docs",
  group: "Setup",
  summary: "read this version's protocol and CLI docs, offline",
  usage: "cotal docs [<page>] [--refresh] [--json|--plain] | cotal docs --search <query> [--json|--plain]",
  positionals: "[<page>]",
  flags: docsFlags,
  outputs: ["json", "plain"],
  examples: ["cotal docs", "cotal docs architecture", "cotal docs --search allowSubscribe", "cotal docs spec --refresh"],
  run: docs,
};

registry.register(docsCommand);
