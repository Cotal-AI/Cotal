/**
 * `cotal docs [page]`: the installed version's own protocol and CLI docs, offline. It reads the docs
 * bundle that ships in `@cotal-ai/connector-core`, the one `cotal_docs` serves agents.
 *
 * Registered here, in the composition root, because the CLI package must not depend on an extension.
 * The bundle is imported inside `run` through its narrow subpath, so no other command loads it.
 */
import { registry, type Command, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, jsonFlag, plainFlag, presentationOf, writeResult, type Cell, type Report } from "@cotal-ai/workspace";
import type { Block, Presentation, Section } from "@cotal-ai/workspace";

const searchFlag = { name: "search", type: "string", value: "<query>", description: "show the sections that best match a query" } as const;
const refreshFlag = { name: "refresh", type: "boolean", description: "also try the version-pinned copy of the page on docs.cotal.ai" } as const;
export const docsFlags = [searchFlag, refreshFlag, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);

type Docs = typeof import("@cotal-ai/connector-core/docs");

/** Every page name `docs <page>` reads. */
const pageSlugs = (d: Docs): string[] => ["spec", "lang", "schema", ...d.docsIndex().pages.map((p) => p.slug)];

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
      throw usage(`no docs page "${page}"; pages: ${pageSlugs(d).join(", ")}`);
    }
    const result: DocsPageResult = { kind: "docs-page", version: read.version, slug: read.page.slug, title: read.page.title, source: read.source, refresh: read.refresh, body: read.page.body };
    writeResult(presentation, { command: "docs", target: null, result }, (r) => pageView(r, presentation));
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
  const columns = [{ key: "slug", label: "PAGE" }, { key: "title", label: "TITLE" }];
  const table = (pages: readonly { slug: string; title: string }[]) =>
    ({ kind: "table" as const, columns, rows: pages.map((p) => ({ slug: { text: p.slug, tone: "command" as const }, title: p.title })) });
  const groups = new Map<string, DocsIndexResult["pages"][number][]>();
  for (const p of r.pages) groups.set(p.category, [...(groups.get(p.category) ?? []), p]);
  return {
    sections: [
      { title: `Cotal v${r.version} documentation`, blocks: [{ kind: "lines", lines: [{ text: "Bundled with this installed version and readable offline.", tone: "hint" }] }] },
      { title: "Normative sources", blocks: [table(r.sources)] },
      ...[...groups].map(([title, pages]) => ({ title, blocks: [table(pages)] })),
      { blocks: [{ kind: "lines", lines: [{ text: "Read a page with `cotal docs <page>`; search with `cotal docs --search <query>`.", tone: "hint" }] }] },
    ],
  };
}

/** A page drawn for reading on a terminal. To a pipe or a file, and with `--plain`, it is its
 *  Markdown, since output there is never wrapped. */
function pageView(r: DocsPageResult, presentation: Presentation): Report {
  const note: Cell =
    r.refresh === null ? { text: `bundled v${r.version}`, tone: "hint" }
    : r.refresh === "served" ? { text: `refreshed from docs.cotal.ai: the version-pinned copy for v${r.version}`, tone: "hint" }
    : { text: `bundled v${r.version}: docs.cotal.ai ${r.refresh === "unreachable" ? "did not answer" : `has no version-pinned copy for v${r.version}`}`, tone: "waiting" };
  const body: Section[] = presentation === "plain" || !process.stdout.isTTY ? [{ blocks: [{ kind: "lines", lines: r.body.split("\n") }] }] : drawnPage(r.body);
  return { sections: [{ blocks: [{ kind: "lines", lines: [note] }] }, ...body] };
}

/** Markdown inline text as read in a terminal: a link is its text, with the address when it leaves
 *  the docs, and bold markers are dropped. Code keeps its backticks. */
const inline = (text: string): string =>
  text.replace(/!?\[([^\]]*)\]\(([^)\s]*)\)/g, (_, label: string, url: string) => (/^https?:/.test(url) ? `${label} <${url}>` : label)).replace(/\*\*/g, "");

/** A table row's cells; a `\|` inside a cell is a pipe, not a column break. */
const cellsOf = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => inline(cell.trim().replace(/\\\|/g, "|")));

/** A table starts at a row whose next line is the header rule. */
const startsTable = (line: string, next = ""): boolean => line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|?\s*$/.test(next);

/** Whether a line starts a block of its own: a heading, a fence, a table, a list item or a quote. */
const startsBlock = (line: string, next = ""): boolean =>
  /^#{1,6} /.test(line) || /^\s*(```|~~~)/.test(line) || startsTable(line, next) || /^\s*([-*+]|\d+[.)]) /.test(line) || line.startsWith(">");

/**
 * A Markdown page as report sections, so the report fits it to the terminal. Each heading starts a
 * section. A paragraph, list item or quote is one line the report wraps. A table is a table, which
 * becomes one record per row when the terminal is too narrow for its columns. A code block keeps its
 * lines. A blank line in the page is kept between blocks, so a list stays together.
 */
function drawnPage(body: string): Section[] {
  const sections: { title?: string; blocks: Block[] }[] = [{ blocks: [] }];
  const lines = body.split("\n");
  let gap = false;
  const add = (block: Block) => {
    const blocks = sections.at(-1)!.blocks;
    if (gap && blocks.length) blocks.push({ kind: "lines", lines: [""] });
    blocks.push(block);
    gap = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^#{1,6} +(.*)$/.exec(line);
    const fence = /^\s*(```|~~~)/.exec(line);
    if (!line.trim()) gap = true;
    else if (heading) { sections.push({ title: inline(heading[1]!.trim()), blocks: [] }); gap = false; }
    else if (fence) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) code.push(`  ${lines[i]}`);
      add({ kind: "lines", lines: code.length ? code : [""] });
    } else if (startsTable(line, lines[i + 1])) {
      const columns = cellsOf(line).map((label, c) => ({ key: String(c), label }));
      const rows: Record<string, Cell>[] = [];
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) rows.push(Object.fromEntries(cellsOf(lines[i]!).map((cell, c) => [String(c), cell])));
      i--;
      add({ kind: "table", columns, rows });
    } else if (line.startsWith(">")) {
      const parts = [line];
      while (lines[i + 1]?.startsWith(">")) parts.push(lines[++i]!);
      add({ kind: "lines", lines: [{ text: inline(parts.map((part) => part.replace(/^>\s?/, "").trim()).join(" ")), tone: "hint" }] });
    } else {
      // A paragraph or list item runs to a blank line or the next block.
      const parts = [line.trimEnd()];
      while (lines[i + 1]?.trim() && !startsBlock(lines[i + 1]!, lines[i + 2])) parts.push(lines[++i]!.trim());
      add({ kind: "lines", lines: [inline(parts.join(" "))] });
    }
  }
  return sections.filter((section) => section.title !== undefined || section.blocks.length);
}

function searchView(r: DocsSearchResult): Report {
  if (!r.hits.length)
    return { sections: [{ blocks: [{ kind: "lines", lines: [{ text: `no matches for "${r.query}" in the Cotal v${r.version} docs; \`cotal docs\` lists the pages, or search an exact identifier`, tone: "hint" }] }] }] };
  return {
    sections: r.hits.map((h) => ({
      title: h.heading,
      blocks: [{ kind: "lines" as const, lines: [...h.text.split("\n"), { text: `read the full page: \`cotal docs ${h.slug}\``, tone: "hint" as const }] }],
    })),
  };
}

/** Complete the page name from the bundled index. Its module loads only on this <TAB>, as in `run`. */
async function docsComplete(argv: string[]): Promise<CompletionResult> {
  if (argv.slice(0, -1).some((word) => word === "--search" || !word.startsWith("-"))) return { items: [], directive: "nofiles" };
  const index = (await import("@cotal-ai/connector-core/docs")).docsIndex();
  return { items: [...index.pages, ...index.sources].map((page) => ({ value: page.slug, description: page.title })), directive: "nofiles" };
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
  examples: [{ command: "cotal docs", note: "list the docs pages bundled with this version" }, { command: "cotal docs cli", note: "read the CLI reference" }, { command: "cotal docs --search <query>", note: "find the sections that match a query" }],
  reads: true,
  run: docs,
  complete: docsComplete,
};

registry.register(docsCommand);
