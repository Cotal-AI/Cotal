// Build version-exact offline docs from canonical Markdown and MDX through the shared reader.
// Metadata stays inline; corpus members and the search index load independently after validation.
// The connector generates these ignored artifacts during its build and typecheck.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDocument, discoverDocuments } from "@cotal-ai/docs-content";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { encodeIndex } from "../extensions/connector-core/src/docs-index-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const docsDir = join(repoRoot, "docs");

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

const ORDER = [
  "what-is-cotal", "getting-started", "architecture", "mcp-tools",
  "channels-and-permissions", "identity-and-auth",
];
const slugOf = path => basename(path, extname(path)).toLowerCase();
const files = (await discoverDocuments(docsDir)).sort((a, b) => {
  const ia = ORDER.indexOf(slugOf(a));
  const ib = ORDER.indexOf(slugOf(b));
  if (ia !== -1 || ib !== -1) return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  return a.localeCompare(b);
});

function titleOf(md, slug) {
  const title = md.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (!title) throw new Error(`gen:docsbundle: ${slug}.md has no H1 title`);
  return title;
}

function summaryOf(description) {
  const dot = description.indexOf(". ");
  const text = dot > 40 ? description.slice(0, dot + 1) : description;
  return text.length > 200 ? text.slice(0, 197).trimEnd() + "…" : text;
}

const categories = ["Start here", "Guide", "Concept", "Reference", "Project"];
const categoryOf = (kind, path) => {
  const category = categories.find(value => kind === value || kind.startsWith(value + " (") || kind.startsWith(value + ":"));
  if (!category) throw new Error(`${path} has no supported documentation category`);
  return category;
};

const pages = [];
for (const path of files) {
  if (!readFileSync(path, "utf8").trim()) throw new Error(`gen:docsbundle: docs/${basename(path)} is empty`);
  const doc = await readDocument(path);
  pages.push({
    slug: slugOf(path), title: doc.metadata.title, kind: doc.metadata.kind, category: categoryOf(doc.metadata.kind, path),
    summary: summaryOf(doc.metadata.description), body: doc.markdown,
  });
}

const specBody = readFileSync(join(repoRoot, "SPEC.md"), "utf8");
if (!specBody.trim()) throw new Error("gen:docsbundle: SPEC.md is empty");
const schemaBody = readFileSync(join(repoRoot, "spec", "cotal.schema.json"), "utf8");
if (!schemaBody.trim()) throw new Error("gen:docsbundle: spec/cotal.schema.json is empty");
const langBody = readFileSync(join(repoRoot, "spec", "cotal-lang.md"), "utf8");
if (!langBody.trim()) throw new Error("gen:docsbundle: spec/cotal-lang.md is empty");

const bundle = {
  version,
  generatedFrom: "docs/*.{md,mdx} + SPEC.md + spec/cotal-lang.md + spec/cotal.schema.json",
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
// Independent gzip members keep the existing corpus file while allowing one source to be decoded.
// Each member is one ordinary JSON string record; source order is the search index's order.
const bodies = [...bundle.pages.map(page => page.body), bundle.spec.body, bundle.lang.body, bundle.schema.body];
let position = 0;
const bounds = [];
const members = bodies.map(body => {
  const member = gzipSync(Buffer.from(JSON.stringify(body) + "\n"));
  bounds.push([position, position + member.length]);
  position += member.length;
  return member;
});
const corpus = Buffer.concat(members);
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
  "// GENERATED by scripts/generate-docs-bundle.mjs. Do not edit by hand.\n" +
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
    "/** Read and check the corpus once, without decoding its source bodies. */\n" +
    "let corpusPacked: Buffer | undefined;\n" +
    "function corpusData(): Buffer {\n" +
    "  if (corpusPacked) return corpusPacked;\n" +
    `  const packed = readFileSync(join(import.meta.dirname, ${JSON.stringify(CORPUS_FILE)}));\n` +
    `  if (packed.length !== ${corpus.length} || createHash("sha256").update(packed).digest("hex") !== ${JSON.stringify(createHash("sha256").update(corpus).digest("hex"))})\n` +
    `    throw new Error("docs data file ${CORPUS_FILE} beside this module is not the one built with it");\n` +
    "  return (corpusPacked = packed);\n}\n\n" +
    `const sourceBounds: [number, number][] = ${JSON.stringify(bounds)};\n` +
    `const sourceLengths: number[] = ${JSON.stringify(bodies.map(body => body.length))};\n` +
    "const decodedBodies: (string | undefined)[] = [];\n\n" +
    "/** Validate the coupled corpus before the index uses its UTF-16 source bounds. No body is decoded. */\n" +
    "export function loadDocsSourceLengths(): number[] {\n  corpusData();\n  return sourceLengths.slice();\n}\n\n" +
    "function decodeDocsSource(source: number): string {\n" +
    "  const bounds = sourceBounds[source];\n" +
    '  if (!Number.isInteger(source) || !bounds) throw new Error("docs source index is out of bounds");\n' +
    '  const body: unknown = JSON.parse(gunzipSync(corpusData().subarray(bounds[0], bounds[1])).toString("utf8"));\n' +
    '  if (typeof body !== "string" || body.length !== sourceLengths[source]) throw new Error("docs source body does not match its generated bounds");\n' +
    "  return body;\n}\n\n" +
    "/** Decode only a requested source; later page and search reads share that body. */\n" +
    "export function loadDocsSource(source: number): string {\n  return (decodedBodies[source] ??= decodeDocsSource(source));\n}\n\n" +
    "/** Full materialization for build tooling and callers that explicitly request the complete corpus. */\n" +
    "export function loadDocsBundle(): DocsBundle {\n" +
    "  const meta = loadDocsMetadata();\n" +
    "  const count = meta.pages.length;\n" +
    `  return { version: DOCS_VERSION, generatedFrom: ${JSON.stringify(bundle.generatedFrom)},\n` +
    "    pages: meta.pages.map((page, source) => ({ ...page, body: loadDocsSource(source) })),\n" +
    "    spec: { ...meta.spec, body: loadDocsSource(count) },\n" +
    "    lang: { ...meta.lang, body: loadDocsSource(count + 1) },\n" +
    "    schema: { ...meta.schema, body: loadDocsSource(count + 2) } };\n}\n" +
    "\n/** The compact search index of that bundle: the sibling file " + INDEX_FILE + ", read, checked and unzipped on the first search. */\n" +
    loader("loadDocsIndex", INDEX_FILE, index, "Buffer", "gunzipSync(packed)"),
);

console.log(`gen:docsbundle: wrote ${pages.length} pages + spec + lang + schema for Cotal v${version} → ${out.startsWith(repoRoot + "/") ? out.slice(repoRoot.length + 1) : out}`);
