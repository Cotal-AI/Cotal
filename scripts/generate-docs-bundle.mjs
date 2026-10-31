// Generate the version-exact Cotal docs bundle that ships inside the connector, so a
// mesh agent can call `cotal_docs` and read the AUTHORITATIVE docs for the exact version
// it is running — offline, with no drift. Sources of truth: /docs/*.md + /SPEC.md +
// /spec/cotal-lang.md + /spec/cotal.schema.json, stamped with the release version (bin/package.json). Run:
// `pnpm gen:docsbundle`.
//
// Emits extensions/connector-core/src/docs-bundle.generated.ts, which holds the version stamp and the
// metadata inline, and two gzip data files written beside it: docs-bundle.bin, the full corpus, and
// docs-index.bin, the search index precomputed here with the same tokenizer and section rules the
// runtime imports (extensions/connector-core/src/docs-index-core.js). Each loader reads its file from
// `import.meta.dirname` only when it is called, after checking the file's length and SHA-256 recorded
// in the loader, and unzips it; nothing keeps the compressed bytes. A missing, replaced or corrupt
// file throws. Importing the module, DOCS_VERSION and loadDocsMetadata() read neither file; a page
// read needs only the corpus; a search needs both. Each bundle build copies both files beside its
// output (the CJS bundles compile `import.meta.dirname` to `__dirname`). The caller owns first-use
// retention. Missing or empty sources fail generation.
//
// THE OUTPUT IS A BUILD ARTIFACT, NOT A TRACKED FILE. `@cotal-ai/connector-core` runs this
// from its own `build` and `typecheck`, and the path is gitignored. It used to be committed,
// which made every pair of branches regenerating the same region of it conflict in a file no
// human wrote while the source pages merged cleanly. Generating it on the way past removes
// that class rather than automating around it.
//
// `--out <path>` writes somewhere else. A caller that must inspect the SHIPPED text without
// running a build (the upgrade-section gate) regenerates into a temporary path with it.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { encodeIndex } from "../extensions/connector-core/src/docs-index-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const docsDir = join(repoRoot, "docs");

// `--out <path>` overrides the destination; the default is the connector source the build
// compiles. An `--out` with no value is a caller mistake, not a reason to silently use the
// default and write over the connector's copy.
const outFlag = process.argv.indexOf("--out");
if (outFlag !== -1 && !process.argv[outFlag + 1]) {
  throw new Error("gen:docsbundle: --out needs a path");
}
const out =
  outFlag === -1
    ? join(repoRoot, "extensions", "connector-core", "src", "docs-bundle.generated.ts")
    : process.argv[outFlag + 1];

const version = JSON.parse(readFileSync(join(repoRoot, "bin", "package.json"), "utf8")).version;
if (!version) throw new Error("gen:docsbundle: no version in bin/package.json");

// README.md is the docs index (human navigation), not agent content — cotal_docs() renders
// its own index from the pages below. Reading order: these key pages first, then the rest
// alphabetically, so the index reads like a route, not a directory listing.
const EXCLUDE = new Set(["README.md"]);
const ORDER = [
  "what-is-cotal.md",
  "getting-started.md",
  "architecture.md",
  "mcp-tools.md",
  "channels-and-permissions.md",
  "identity-and-auth.md",
];

/** First H1 → title; fail loud if a page has none (every doc opens with one). */
function titleOf(md, slug) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  if (!m) throw new Error(`gen:docsbundle: ${slug}.md has no H1 title`);
  return m[1].trim();
}

/** The categories a page's classification line can name, as `DocsCategory` in connector-core's
 *  docs.ts lists them. */
const CATEGORIES = ["Start here", "Guide", "Concept", "Reference", "Project"];

/** The category the classification line every page opens with names — `> **Concept** (informative)
 *  · …` → "Concept". Fail loud on a page without one, so the index lists no page under no heading. */
function categoryOf(md, slug) {
  const category = md.match(/^>\s*\*\*([^*]+)\*\*/m)?.[1].trim();
  if (!CATEGORIES.includes(category)) throw new Error(`gen:docsbundle: ${slug}.md opens with no classification line naming one of ${CATEGORIES.join(", ")}`);
  return category;
}

/** That classification line's own words before its first `·` — `> **Concept** (informative) · …` →
 *  "Concept (informative)". */
function kindOf(md) {
  const line = md.match(/^>\s*\*\*[^*]+\*\*.*$/m)?.[0] ?? "";
  return line.replace(/^>\s*/, "").split("·")[0].replace(/\*\*/g, "").replace(/[[\]]/g, "").trim();
}

/** One-line summary: the first real content paragraph, flattened to a single sentence-ish
 *  line with markdown noise stripped. Fail loud if a page is all headings/blockquotes. */
function summaryOf(md, slug) {
  const lines = md.split("\n");
  const para = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!para.length) {
      // Seek the first content line: skip headings, the classification blockquote,
      // images, HTML comments, and blanks.
      if (!l || l.startsWith("#") || l.startsWith(">") || l.startsWith("![") || l.startsWith("<!--")) continue;
      para.push(l);
    } else {
      if (!l) break; // paragraph ends at the first blank line
      para.push(l);
    }
  }
  if (!para.length) throw new Error(`gen:docsbundle: ${slug}.md has no summary paragraph`);
  const flat = para
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → their text
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Trim to the first sentence, capped, so the index stays scannable.
  const dot = flat.indexOf(". ");
  const oneLine = dot > 40 ? flat.slice(0, dot + 1) : flat;
  return oneLine.length > 200 ? oneLine.slice(0, 197).trimEnd() + "…" : oneLine;
}

const files = readdirSync(docsDir)
  .filter((f) => f.endsWith(".md") && !EXCLUDE.has(f))
  .sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    return a.localeCompare(b);
  });

const pages = files.map((f) => {
  const slug = basename(f, ".md").toLowerCase();
  const body = readFileSync(join(docsDir, f), "utf8");
  if (!body.trim()) throw new Error(`gen:docsbundle: docs/${f} is empty`);
  return { slug, title: titleOf(body, slug), kind: kindOf(body), category: categoryOf(body, slug), summary: summaryOf(body, slug), body };
});

const specBody = readFileSync(join(repoRoot, "SPEC.md"), "utf8");
if (!specBody.trim()) throw new Error("gen:docsbundle: SPEC.md is empty");
const schemaBody = readFileSync(join(repoRoot, "spec", "cotal.schema.json"), "utf8");
if (!schemaBody.trim()) throw new Error("gen:docsbundle: spec/cotal.schema.json is empty");
const langBody = readFileSync(join(repoRoot, "spec", "cotal-lang.md"), "utf8");
if (!langBody.trim()) throw new Error("gen:docsbundle: spec/cotal-lang.md is empty");

const bundle = {
  version,
  generatedFrom: "docs/*.md + SPEC.md + spec/cotal-lang.md + spec/cotal.schema.json",
  pages,
  spec: { title: titleOf(specBody, "spec"), body: specBody },
  lang: { title: titleOf(langBody, "lang"), body: langBody },
  schema: { title: "Cotal message schema (JSON Schema)", body: schemaBody },
};

const metadata = {
  version: bundle.version,
  pages: bundle.pages.map(({ body: _body, ...entry }) => entry),
  spec: { title: bundle.spec.title },
  lang: { title: bundle.lang.title },
  schema: { title: bundle.schema.title },
};

// The two data files sit beside the generated module, so `--out` elsewhere carries them along.
const CORPUS_FILE = "docs-bundle.bin";
const INDEX_FILE = "docs-index.bin";
const corpus = gzipSync(Buffer.from(JSON.stringify(bundle, null, 2)));
const index = gzipSync(encodeIndex(bundle));
writeFileSync(join(dirname(out), CORPUS_FILE), corpus);
writeFileSync(join(dirname(out), INDEX_FILE), index);
/** The loader text that reads one of them. */
const loader = (name, file, packed, returns, body) =>
  `export function ${name}(): ${returns} {\n` +
  `  const packed = readFileSync(join(import.meta.dirname, ${JSON.stringify(file)}));\n` +
  `  if (packed.length !== ${packed.length} || createHash("sha256").update(packed).digest("hex") !== ${JSON.stringify(createHash("sha256").update(packed).digest("hex"))})\n` +
  `    throw new Error("docs data file ${file} beside this module is not the one built with it");\n` +
  `  return ${body};\n}\n`;

const banner =
  "// GENERATED by scripts/generate-docs-bundle.mjs — do not edit by hand.\n" +
  "// Regenerate with `pnpm gen:docsbundle` whenever /docs, /SPEC.md, /spec, or the\n" +
  "// release version changes. It is the version-exact docs `cotal_docs` serves offline.\n";

writeFileSync(
  out,
  banner +
    'import type { DocsBundle, DocsMetadata } from "./docs.js";\n' +
    'import { createHash } from "node:crypto";\n' +
    'import { readFileSync } from "node:fs";\n' +
    'import { join } from "node:path";\n' +
    'import { gunzipSync } from "node:zlib";\n\n' +
    "/** The installed Cotal version, for stamping the orientation card and other surfaces. */\n" +
    `export const DOCS_VERSION = ${JSON.stringify(version)};\n\n` +
    `export function loadDocsMetadata(): DocsMetadata {\n  return ${JSON.stringify(metadata, null, 2)};\n}\n\n` +
    "/** The full corpus: the sibling file " + CORPUS_FILE + ", read, checked against its digest and unzipped. Throws when the file\n" +
    " *  is missing, replaced or corrupt. */\n" +
    loader("loadDocsBundle", CORPUS_FILE, corpus, "DocsBundle", 'JSON.parse(gunzipSync(packed).toString("utf8")) as DocsBundle') +
    "\n/** The compact search index of that bundle: the sibling file " + INDEX_FILE + ", read, checked and unzipped on the first search. */\n" +
    loader("loadDocsIndex", INDEX_FILE, index, "Buffer", "gunzipSync(packed)"),
);

console.log(`gen:docsbundle: wrote ${pages.length} pages + spec + lang + schema for Cotal v${version} → ${out.startsWith(repoRoot + "/") ? out.slice(repoRoot.length + 1) : out}`);
