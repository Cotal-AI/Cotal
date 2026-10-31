/** Cold index paths use generated metadata, not the full corpus. Precise coverage counts
 *  actual loader calls; a later page or search in each child proves the instrument sees it.
 *  No network, mocks, forced GC, or timing/memory assertions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { fileURLToPath } from "node:url";

const modes = ["text", "structured", "refresh"] as const;
const mode = process.argv[2];
if (!mode) {
  let failed = 0;
  for (const child of modes) {
    const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), child], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) failed++;
  }
  assert.equal(failed, 0, "all three fresh-process index paths pass");
  console.log("docs-index-lazy: 3 cold processes passed");
} else {
  assert.ok(modes.some(value => value === mode), "known cold path");
  const session = new Session();
  const generatedUrl = new URL("../dist/docs-bundle.generated.js", import.meta.url).href;
  const callsOf = (coverage: Profiler.TakePreciseCoverageReturnType, name: string): number => coverage.result
    .filter(script => script.url === generatedUrl)
    .flatMap(script => script.functions)
    .filter(fn => fn.functionName === name)
    .reduce((total, fn) => total + fn.ranges[0].count, 0);
  // The search index payload has its own loader; `indexCalls` is its count in the coverage `calls` last read.
  let indexCalls = 0;
  const calls = (coverage: Profiler.TakePreciseCoverageReturnType): number => {
    indexCalls = callsOf(coverage, "loadDocsIndex");
    return callsOf(coverage, "loadDocsBundle");
  };
  let checks = 0;
  const check = (label: string, run: () => void): void => { run(); checks++; console.log(`✓ ${mode}: ${label}`); };
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    const docs = await import("@cotal-ai/connector-core/docs");
    const imported = calls(await session.post("Profiler.takePreciseCoverage"));
    check("import does not decode the full corpus or the search index", () => { assert.equal(imported, 0); assert.equal(indexCalls, 0); });
    const first = mode === "text" ? docs.renderDocsIndex() : mode === "structured" ? docs.docsIndex() : await docs.runDocs({ refresh: true });
    const firstCalls = calls(await session.post("Profiler.takePreciseCoverage"));
    check("cold index does not decode the full corpus or the search index", () => { assert.equal(firstCalls, 0); assert.equal(indexCalls, 0); });

    const text = docs.renderDocsIndex();
    const structured = docs.docsIndex();
    const copy = docs.docsIndex();
    check("structured results are equal but independently owned", () => {
      assert.deepEqual(structured, copy);
      assert.notEqual(structured, copy);
      assert.notEqual(structured.pages, copy.pages);
      assert.notEqual(structured.sources, copy.sources);
      for (let i = 0; i < structured.pages.length; i++) assert.notEqual(structured.pages[i], copy.pages[i]);
      for (let i = 0; i < structured.sources.length; i++) assert.notEqual(structured.sources[i], copy.sources[i]);
    });
    copy.version = "caller change";
    copy.pages[0].title = "caller change";
    copy.pages[0].summary = "caller change";
    copy.sources[0].title = "caller change";
    copy.pages.reverse();
    copy.sources.pop();
    check("caller mutation cannot contaminate indexes", () => {
      assert.deepEqual(docs.docsIndex(), structured);
      assert.equal(docs.renderDocsIndex(), text);
    });
    const ordinary = await docs.runDocs({});
    const refresh = await docs.runDocs({ refresh: true });
    check("tool index preserves output and refresh note", () => {
      assert.deepEqual(ordinary, { text });
      assert.deepEqual(refresh, { text: text + "\n\n(note: `refresh` applies only when reading a page; the index and search use the bundled docs.)" });
      assert.deepEqual(first, mode === "text" ? text : mode === "structured" ? structured : refresh);
    });
    const callsResult = calls(await session.post("Profiler.takePreciseCoverage"));
    check("warm indexes still do not decode the full corpus or the search index", () => { assert.equal(callsResult, 0); assert.equal(indexCalls, 0); });

    async function page(): Promise<void> {
      const result = await docs.runDocs({ page: "architecture" });
      check("page remains byte-for-byte source text", () => assert.deepEqual(result, {
        text: `(bundled v${docs.DOCS_VERSION})\n\n${readFileSync(new URL("../../../docs/architecture.md", import.meta.url), "utf8")}`,
      }));
    }
    function search(): void {
      const hits = docs.searchDocs("channel permissions");
      check("search still retrieves the documented page", () => assert.equal(hits[0].slug, "channels-and-permissions"));
    }
    if (mode === "structured") search(); else await page();
    const laterCalls = calls(await session.post("Profiler.takePreciseCoverage"));
    check("later content call positively witnesses the full loader", () => assert.equal(laterCalls, 1));
    check("only a search decodes the search index", () => assert.equal(indexCalls, mode === "structured" ? 1 : 0));
    if (mode === "structured") await page(); else search();
    const cachedCalls = calls(await session.post("Profiler.takePreciseCoverage"));
    check("page and search share the existing full-corpus cache", () => assert.equal(cachedCalls, 0));
    check("the search index is decoded once, by the search", () => assert.equal(indexCalls, mode === "structured" ? 0 : 1));

    const { loadDocsBundle, loadDocsMetadata } = await import("../dist/docs-bundle.generated.js");
    const bundle = loadDocsBundle();
    check("generated metadata contains only index fields in source order", () => assert.deepEqual(loadDocsMetadata(), {
      version: bundle.version,
      pages: bundle.pages.map(({ body: _body, ...entry }) => entry),
      spec: { title: bundle.spec.title },
      lang: { title: bundle.lang.title },
      schema: { title: bundle.schema.title },
    }));
    check("structured metadata matches the actual full loader", () => {
      assert.equal(structured.version, bundle.version);
      assert.deepEqual(structured.sources, ["spec", "lang", "schema"].map(slug => ({ slug, title: bundle[slug as "spec" | "lang" | "schema"].title })));
      const pages = bundle.pages.map(({ body: _body, ...entry }) => entry).sort((a, b) =>
        docs.DOCS_CATEGORIES.indexOf(a.category as typeof docs.DOCS_CATEGORIES[number]) - docs.DOCS_CATEGORIES.indexOf(b.category as typeof docs.DOCS_CATEGORIES[number]));
      assert.deepEqual(structured.pages, pages);
    });
    console.log(`docs-index-lazy ${mode}: ${checks} checks passed`);
  } finally {
    await session.post("Profiler.stopPreciseCoverage");
    await session.post("Profiler.disable");
    session.disconnect();
  }
}
