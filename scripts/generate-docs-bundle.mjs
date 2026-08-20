// Generate the version-exact Cotal docs bundle that ships inside the connector, so a
// mesh agent can call `cotal_docs` and read the AUTHORITATIVE docs for the exact version
// it is running — offline, with no drift. Sources of truth: /docs/*.md + /SPEC.md +
// /spec/cotal-lang.md + /spec/cotal.schema.json, stamped with the release version (bin/package.json). Run:
// `pnpm gen:docsbundle`.
//
// Emits extensions/connector-core/src/docs-bundle.generated.ts as a plain typed constant
// (a JSON.stringify'd object literal — readable, diffable, and bundler-proof: tsc copies
// it into dist and esbuild inlines it into the OpenCode plugin bundle, where loose files
// would be dropped). FAILS LOUD on an empty or missing source so a release can never ship
// hollow docs.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const docsDir = join(repoRoot, "docs");
const out = join(repoRoot, "extensions", "connector-core", "src", "docs-bundle.generated.ts");

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

/** The classification line every page opens with — `> **Concept** (informative) · …` →
 *  "Concept (informative)". "" when a page has no such line. */
function kindOf(md) {
  const m = md.match(/^>\s*(.+?)\s*$/m);
  if (!m) return "";
  return m[1].split("·")[0].replace(/\*\*/g, "").replace(/[[\]]/g, "").trim();
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
  return { slug, title: titleOf(body, slug), kind: kindOf(body), summary: summaryOf(body, slug), body };
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

const banner =
  "// GENERATED by scripts/generate-docs-bundle.mjs — do not edit by hand.\n" +
  "// Regenerate with `pnpm gen:docsbundle` whenever /docs, /SPEC.md, /spec, or the\n" +
  "// release version changes. It is the version-exact docs `cotal_docs` serves offline.\n";

writeFileSync(
  out,
  banner +
    'import type { DocsBundle } from "./docs.js";\n\n' +
    "export const DOCS_BUNDLE: DocsBundle = " +
    JSON.stringify(bundle, null, 2) +
    ";\n",
);

console.log(`gen:docsbundle: wrote ${pages.length} pages + spec + lang + schema for Cotal v${version} → ${out.replace(repoRoot + "/", "")}`);
