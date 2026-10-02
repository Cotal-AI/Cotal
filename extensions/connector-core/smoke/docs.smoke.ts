/**
 * Smoke for cotal_docs — pure (no broker, no network). Covers the version-exact bundle path:
 * the index, page reads (incl. the spec/schema aliases), search, the unknown-page error, and
 * the release-safety invariant that the bundled docs are stamped with the SHIPPED version.
 * The opt-in remote refresh is not exercised here (it touches the network). Run: `pnpm smoke:docs`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
console.log("✓ 1 — the bundled docs are stamped with the shipped version");

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
console.log("✓ 2 — the index names the version and offers real page slugs");

// 3 — page reads: real markdown, with a bundled-source note; spec/schema aliases resolve.
{
  const arch = await runDocs({ page: "architecture" });
  assert.equal(arch.isError, undefined);
  assert.match(arch.text, new RegExp(`bundled v${DOCS_VERSION.replace(/\./g, "\\.")}`), "page notes the bundled source");
  assert.match(arch.text, /# Architecture/, "page carries its real body");

  const spec = await runDocs({ page: "spec" });
  assert.match(spec.text, /Cotal Wire Specification/, "spec alias returns SPEC.md");

  const lang = await runDocs({ page: "lang" });
  assert.match(lang.text, /# Cotal Lang: the workflow language/, "lang alias returns spec/cotal-lang.md");
  const langAlt = await runDocs({ page: "cotal-lang.md" });
  assert.match(langAlt.text, /# Cotal Lang: the workflow language/, "cotal-lang alias resolves too");

  const schema = await runDocs({ page: "schema" });
  assert.match(schema.text, /"\$schema"|"\$id"|"properties"/, "schema alias returns JSON Schema");

  // Case-insensitive and tolerant of a trailing .md.
  const alt = await runDocs({ page: "Architecture.md" });
  assert.match(alt.text, /# Architecture/);
}
console.log("✓ 3 — page reads carry real markdown; spec/lang/schema aliases resolve");

// 4 — unknown page fails loud and lists what's available.
{
  const miss = await runDocs({ page: "does-not-exist" });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /spec, lang, schema/, "error lists the available pages");
}
console.log("✓ 4 — an unknown page fails loud and lists what is available");

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
  //
  // UNWINDOWED, and the window it replaces was the same corpus fact in a smaller disguise. Asking
  // for the spec inside the first ten hits reads as reachability and is not: the spec sits at rank
  // six today, so the cell was carrying four slots of slack against one afternoon's corpus, and a
  // docs wave that added four higher-scoring $SYS sections would have reddened it exactly the way
  // the top-five version did. Worse, it let the limit argument be ignored: hardcoding the cut at
  // six left every cell green. So the claim is now the one the code is actually responsible for —
  // the base expansion makes the section REACHABLE — with no rank in it at all.
  assert.ok(
    searchDocs("$SYS.>", Number.MAX_SAFE_INTEGER).some((h) => h.slug === "spec"),
    "‘$SYS.>’ reaches the spec section documenting the reserved $SYS prefix",
  );
  // And the limit argument is HONOURED, which is what the window used to prove by accident and
  // stopped proving the moment it had slack. Asserted against the count rather than against any
  // page, so it holds whatever the corpus says: a hardcoded cut of any value fails one of these.
  assert.equal(searchDocs("cotal", 1).length, 1, "a limit of one returns one section");
  assert.equal(searchDocs("cotal", 4).length, 4, "a limit of four returns four, so the argument is read");
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
console.log("✓ 5 — BM25 section search");

// 6 — THE BUNDLE IS A BUILD ARTIFACT NOW, so the thing worth asserting moved. It used to be a
// committed file a reviewer could read, and `check:docsbundle` proved the tree matched the
// sources by diffing it. There is no tracked artifact to diff any more: the generator runs from
// this package's own `build` and `typecheck`. What has to stay true is that the BUILT module an
// agent actually calls serves EVERY page in `docs/`, at the version the release ships. A
// generator that silently dropped pages would leave `cotal_docs` answering "no such page" for
// docs that exist, and nothing else in this suite counts the corpus.
//
// The expectation is read from the filesystem rather than pinned to a number, so adding a page
// does not redden this the way a hardcoded count would; the claim is coverage, not size.
{
  const docsDir = join(repoRoot, "docs");
  // README.md is the human index; cotal_docs renders its own, so the generator excludes it.
  const expected = readdirSync(docsDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.slice(0, -3).toLowerCase())
    .sort();
  assert.ok(expected.length > 0, "the docs directory has pages to serve");

  const missing: string[] = [];
  for (const slug of expected) {
    const res = await runDocs({ page: slug });
    if (res.isError) missing.push(slug);
  }
  assert.deepEqual(missing, [], "the built docs module serves every page in docs/");

  // …and the three normative sources, which are not pages in `docs/` and so are not covered above.
  for (const alias of ["spec", "lang", "schema"]) {
    const res = await runDocs({ page: alias });
    assert.equal(res.isError, undefined, `the built docs module serves ${alias}`);
  }

  const shipped = JSON.parse(readFileSync(join(repoRoot, "bin", "package.json"), "utf8")).version;
  assert.equal(DOCS_VERSION, shipped, "the built module is stamped with the shipped version");
}
console.log("✓ 6 — the built docs module serves every page in docs/ at the shipped version");

// 7 — FAIL LOUD ON A HOLLOW SOURCE, which is the property the generator documents and the only
// thing standing between an empty page and a release that ships docs answering nothing. This
// mattered less when the artifact was committed, because a human saw the diff; now the generator
// runs unattended inside every build, so its refusal is the check.
//
// Driven through the REAL generator. The sources it reads are copied into a temp dir and the
// generator is invoked against that copy, so the repository's own docs are never modified and
// `--out` keeps the connector's artifact untouched.
{
  const gen = join(repoRoot, "scripts", "generate-docs-bundle.mjs");
  const dir = mkdtempSync(join(tmpdir(), "docs-smoke-gen-"));
  try {
    const out = join(dir, "out.ts");

    // ACCEPT CONTROL FIRST. Without it, a generator broken in some unrelated way would throw for
    // the wrong reason and the refuse legs below would pass while measuring nothing.
    execFileSync("node", [gen, "--out", out], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    assert.match(readFileSync(out, "utf8"), /export const DOCS_BUNDLE/, "the generator writes a bundle from the real sources");

    // The generator resolves its sources relative to its own file, so a copy of the four source
    // locations plus the script reproduces a real run against a damaged tree.
    const tree = join(dir, "tree");
    mkdirSync(join(tree, "scripts"), { recursive: true });
    cpSync(join(repoRoot, "docs"), join(tree, "docs"), { recursive: true });
    cpSync(join(repoRoot, "spec"), join(tree, "spec"), { recursive: true });
    cpSync(join(repoRoot, "SPEC.md"), join(tree, "SPEC.md"));
    mkdirSync(join(tree, "bin"), { recursive: true });
    cpSync(join(repoRoot, "bin", "package.json"), join(tree, "bin", "package.json"));
    cpSync(gen, join(tree, "scripts", "generate-docs-bundle.mjs"));
    const copied = join(tree, "scripts", "generate-docs-bundle.mjs");

    // ACCEPT CONTROL FOR THE COPY. The refuse legs below are only evidence if the copy itself is
    // a working tree the generator succeeds on; otherwise they would pass on a broken fixture.
    execFileSync("node", [copied, "--out", join(dir, "copy.ts")], { stdio: ["ignore", "pipe", "pipe"] });

    // WHICH GUARD REFUSED, not merely that something threw. Measured while proving these cells:
    // with the emptiness guard removed, an empty page STILL throws — one line later, from the H1
    // title check — so a bare `assert.throws` is green either way and grades nothing. Both
    // mutations survived on exactly that. The message is therefore the assertion: it names the
    // source that is hollow and the reason, which is what a build failing unattended has to say.
    const refusal = (path: string): string => {
      try {
        execFileSync("node", [copied, "--out", path], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        return String((error as { stderr?: Buffer }).stderr ?? "");
      }
      throw new assert.AssertionError({ message: "the generator emitted a bundle from a hollow source" });
    };

    // REFUSE LEG: an empty page.
    writeFileSync(join(tree, "docs", "architecture.md"), "");
    assert.match(
      refusal(join(dir, "hollow.ts")),
      /gen:docsbundle: docs\/architecture\.md is empty/,
      "an empty source page makes the generator throw rather than emit hollow docs",
    );

    // REFUSE LEG: an empty normative source. A hollow SPEC.md is a different failure from an
    // empty page, and a generator that only guarded pages would ship a bundle with no spec.
    cpSync(join(repoRoot, "docs", "architecture.md"), join(tree, "docs", "architecture.md"));
    writeFileSync(join(tree, "SPEC.md"), "");
    assert.match(
      refusal(join(dir, "nospec.ts")),
      /gen:docsbundle: SPEC\.md is empty/,
      "an empty normative source makes the generator throw",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("✓ 7 — the generator refuses a hollow source, naming which one");

console.log("docs.smoke: OK — 7 sections");
