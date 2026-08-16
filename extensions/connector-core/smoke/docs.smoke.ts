/**
 * Smoke for cotal_docs — pure (no broker, no network). Covers the version-exact bundle path:
 * the index, page reads (incl. the spec/schema aliases), search, the unknown-page error, and
 * the release-safety invariant that the bundled docs are stamped with the SHIPPED version.
 * The opt-in remote refresh is not exercised here (it touches the network). Run: `pnpm smoke:docs`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDocs, searchDocs, renderDocsIndex, DOCS_VERSION } from "@cotal-ai/connector-core";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// 1 — release safety: the bundle version equals the version we actually ship. A release can
// never hand agents docs stamped for a different version than the package they installed.
{
  const shipped = JSON.parse(readFileSync(join(repoRoot, "bin", "package.json"), "utf8")).version;
  assert.equal(DOCS_VERSION, shipped, `bundled docs v${DOCS_VERSION} != shipped v${shipped} — run pnpm gen:docsbundle`);
}

// 2 — index: names the version, lists the normative sources, and offers real page slugs.
{
  const index = renderDocsIndex();
  assert.match(index, new RegExp(`Cotal v${DOCS_VERSION.replace(/\./g, "\\.")}`), "index states the version");
  assert.match(index, /`spec`/, "index points at the spec");
  assert.match(index, /`schema`/, "index points at the schema");
  assert.match(index, /`architecture`/, "index lists page slugs");

  const empty = await runDocs({});
  assert.equal(empty.isError, undefined);
  assert.equal(empty.text, index, "no-arg call returns the index");
}

// 3 — page reads: real markdown, with a bundled-source note; spec/schema aliases resolve.
{
  const arch = await runDocs({ page: "architecture" });
  assert.equal(arch.isError, undefined);
  assert.match(arch.text, new RegExp(`bundled v${DOCS_VERSION.replace(/\./g, "\\.")}`), "page notes the bundled source");
  assert.match(arch.text, /# Architecture/, "page carries its real body");

  const spec = await runDocs({ page: "spec" });
  assert.match(spec.text, /Cotal Wire Specification/, "spec alias returns SPEC.md");

  const schema = await runDocs({ page: "schema" });
  assert.match(schema.text, /"\$schema"|"\$id"|"properties"/, "schema alias returns JSON Schema");

  // Case-insensitive and tolerant of a trailing .md.
  const alt = await runDocs({ page: "Architecture.md" });
  assert.match(alt.text, /# Architecture/);
}

// 4 — unknown page fails loud and lists what's available.
{
  const miss = await runDocs({ page: "does-not-exist" });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /spec, schema/, "error lists the available pages");
}

// 5 — BM25 section search: ranks the right page, returns section headings + full-page pointers.
{
  const res = await runDocs({ query: "channel permissions" });
  assert.equal(res.isError, undefined);
  assert.match(res.text, /matches for/);
  assert.match(res.text, /cotal_docs\(page: "/, "each hit points at the full page");

  const hits = searchDocs("channel permissions");
  assert.ok(hits.length > 0, "‘channel permissions’ matches at least one section");
  assert.equal(hits[0].slug, "channels-and-permissions", "the channels page ranks first");
  assert.ok(hits[0].heading.includes(" › ") || hits[0].heading.length > 0, "a hit carries a heading path");
  assert.ok(hits.every((h) => h.slug), "every hit names a page to fetch");

  // BM25's edge: an exact identifier retrieves the page that documents it.
  const ident = searchDocs("allowSubscribe");
  assert.ok(
    ident.some((h) => h.slug === "channels-and-permissions"),
    "exact identifier ‘allowSubscribe’ retrieves the channels page",
  );

  // Subject wildcards hit the intended sections: the exact wildcard form keeps its boost so it
  // ranks the Wildcards section first.
  assert.equal(searchDocs("team.>")[0].slug, "channels-and-permissions", "‘team.>’ ranks the Wildcards section first");
  assert.equal(searchDocs("team.*")[0].slug, "channels-and-permissions", "‘team.*’ ranks the Wildcards section first");

  // A wildcard with NO literal form anywhere — `$SYS.>` is written nowhere in the corpus — reaches
  // its sections only because the tokenizer strips the wildcard and searches the base subject.
  // That is the whole of the code claim here: without the base expansion this query retrieves
  // nothing at all, and what it retrieves must be `$SYS` prose rather than incidental noise.
  const sys = searchDocs("$SYS.>");
  assert.ok(sys.length > 0, "‘$SYS.>’ resolves to its base subject");
  assert.ok(sys.every((h) => /\$SYS/i.test(h.text)), "every ‘$SYS.>’ hit is a section that names $SYS");
  // WHICH of those sections wins is a fact about the corpus, not about this code. Until 2026-08-12
  // the spec was in the default five; then two doc pages gained $SYS operational prose and filled
  // the window, and this suite went red on a docs edit that broke nothing. The base expansion is
  // what makes the spec reachable, so that is what is asserted — reachable, not ranked. There is
  // no signal to rank it on: the corpus writes plain `$SYS` everywhere but one place, and a
  // namespace-prefix term was tried and rejected because every `mesh.` in the docs is the word
  // "mesh" ending a sentence, so it scores punctuation.
  assert.ok(
    searchDocs("$SYS.>", 10).some((h) => h.slug === "spec"),
    "‘$SYS.>’ reaches the spec section documenting the reserved $SYS prefix",
  );
  assert.ok(searchDocs("cotal.schema.json").length > 0, "a dotted path matches on its segments");

  // `refresh` is page-only: on a search it is flagged, not silently ignored.
  const searchRefresh = await runDocs({ query: "channel", refresh: true });
  assert.match(searchRefresh.text, /`refresh` applies only when reading a page/, "refresh on search is flagged");

  // Diversity: at most two sections per page in the results.
  const perPage = new Map<string, number>();
  for (const h of searchDocs("cotal")) perPage.set(h.slug, (perPage.get(h.slug) ?? 0) + 1);
  assert.ok([...perPage.values()].every((n) => n <= 2), "no page contributes more than two sections");

  const none = await runDocs({ query: "zzzznotawordzzzz" });
  assert.match(none.text, /No matches/);
}

console.log("docs.smoke: OK");
