/**
 * Build-time generator for `@cotal-ai/core/browser-control` (`@cotal-ai/core/browser-validators-build`).
 * Node only: it runs Ajv's code generation at the host's build, so the page never does.
 *
 * Input: the cluster documents and schema roots of the endpoints a host will call, as data. Each
 * cluster and closure digest is recomputed with THIS core's §13.7 profile, and a digest that does
 * not match the recorded one refuses. Output: one ES module exporting `contracts`, a
 * `BrowserContractSet` with one standalone validator per closure digest (`standaloneContractSource`,
 * the same profile options as `compileContract`) and the cluster documents by cluster digest.
 */
import { parse, type Node } from "acorn";
import { singleDocumentClosure, standaloneContractSource } from "./schema-profile.js";

export interface BrowserContractSource {
  /** Free label recorded beside the cluster (e.g. the endpoint release it came from). */
  label: string;
  /** The digest the endpoint publishes for this cluster document. */
  clusterDigest: string;
  document: { urn: string; revision: number; commands: Array<{ name: string; inputDigest: string; outputDigest: string }> };
  roots: unknown[];
}

/** Ajv's standalone output still names its runtime helpers with `require`, even in ESM mode. Each
 *  `require("ajv/dist/runtime/<helper>").<name>` read is rewritten to an ESM namespace import. The
 *  check walks the parsed validator, so schema data in a string literal or a comment is never taken
 *  for code: any other reference to `require`, `eval` or `Function`, or a call of a member with one
 *  of those names, refuses. */
const RUNTIME_HELPERS = new Set(["ucs2length", "equal", "uri", "quote", "timestamp", "re2", "parseJson"]);
const RUNTIME_PREFIX = "ajv/dist/runtime/";
const EXECUTABLE = new Set(["require", "eval", "Function"]);
const HEADER = /^"use strict";\s*export const validate = (\w+);\s*export default \1;/;
const PROLOGUE = '(() => {\n"use strict";\n';

/** Acorn nodes are loosely typed; this is the shape we actually read. */
type AnyNode = Node & Record<string, unknown>;
type HelperRead = { start: number; end: number; helper: string; name: string };

const isNode = (value: unknown): value is AnyNode =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** The name a callee reads: `x`, `o.x` and `o["x"]` all name `x`. */
function calleeName(node: AnyNode): string | undefined {
  if (node.type === "Identifier") return node.name as string;
  if (node.type !== "MemberExpression") return undefined;
  const property = node.property as AnyNode;
  if (!node.computed) return property.type === "Identifier" ? (property.name as string) : undefined;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : undefined;
}

/** `require("ajv/dist/runtime/<helper>").<name>` with a known helper, as that helper and name. */
function runtimeHelper(node: AnyNode): Omit<HelperRead, "start" | "end"> | undefined {
  if (node.type !== "MemberExpression" || node.computed || node.optional) return undefined;
  const call = node.object as AnyNode;
  const property = node.property as AnyNode;
  if (call.type !== "CallExpression" || call.optional || property.type !== "Identifier") return undefined;
  const callee = call.callee as AnyNode;
  const args = call.arguments as AnyNode[];
  const spec = args[0];
  if (callee.type !== "Identifier" || callee.name !== "require" || args.length !== 1 || spec?.type !== "Literal") return undefined;
  if (typeof spec.value !== "string" || !spec.value.startsWith(RUNTIME_PREFIX)) return undefined;
  const helper = spec.value.slice(RUNTIME_PREFIX.length);
  return RUNTIME_HELPERS.has(helper) ? { helper, name: property.name as string } : undefined;
}

function collectHelperReads(node: AnyNode, digest: string, reads: HelperRead[]): void {
  const read = runtimeHelper(node);
  if (read) {
    reads.push({ start: node.start, end: node.end, ...read });
    return;
  }
  const callee =
    node.type === "CallExpression" || node.type === "NewExpression" ? (node.callee as AnyNode)
    : node.type === "TaggedTemplateExpression" ? (node.tag as AnyNode)
    : undefined;
  const called = callee && calleeName(callee);
  if ((node.type === "Identifier" && EXECUTABLE.has(node.name as string)) || (called !== undefined && EXECUTABLE.has(called)))
    throw new Error(`closure ${digest}: standalone output still needs require or runtime evaluation`);
  for (const [key, value] of Object.entries(node)) {
    // A property name is not a reference: `data.eval` reads the field a schema calls "eval".
    if (!node.computed && ((node.type === "MemberExpression" && key === "property") || (node.type === "Property" && key === "key"))) continue;
    for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) collectHelperReads(child, digest, reads);
  }
}

function validatorBody(source: string, digest: string, helpers: Set<string>): string {
  const head = HEADER.exec(source);
  if (!head) throw new Error(`closure ${digest}: unexpected standalone output shape`);
  const body = source.slice(head[0].length);
  const epilogue = `\nreturn ${head[1]};\n})()`;
  let program: AnyNode;
  try {
    program = parse(PROLOGUE + body + epilogue, { ecmaVersion: "latest", sourceType: "script" }) as unknown as AnyNode;
  } catch (error) {
    throw new Error(`closure ${digest}: standalone output does not parse: ${(error as Error).message}`);
  }
  const reads: HelperRead[] = [];
  collectHelperReads(program, digest, reads);
  let rewritten = body;
  for (const { start, end, helper, name } of reads.sort((a, b) => b.start - a.start)) {
    helpers.add(helper);
    rewritten = `${rewritten.slice(0, start - PROLOGUE.length)}__rt(__rt_${helper}, ${JSON.stringify(name)})${rewritten.slice(end - PROLOGUE.length)}`;
  }
  return PROLOGUE + rewritten + epilogue;
}

/** The generated module text, and how many clusters and closures it carries. */
export function generateBrowserContracts(sources: readonly BrowserContractSource[]): { text: string; clusters: number; closures: number } {
  if (sources.length === 0) throw new Error("no contract sources");
  const clusters = new Map<string, { labels: string[]; document: BrowserContractSource["document"] }>();
  const roots = new Map<string, unknown>();
  for (const src of sources) {
    const clusterDigest = singleDocumentClosure(src.document).closureDigest;
    if (clusterDigest !== src.clusterDigest)
      throw new Error(`${src.label}: cluster document recomputes to ${clusterDigest}, the source recorded ${src.clusterDigest}`);
    for (const root of src.roots) roots.set(singleDocumentClosure(root).closureDigest, root);
    for (const command of src.document.commands)
      for (const digest of [command.inputDigest, command.outputDigest])
        if (!roots.has(digest)) throw new Error(`${src.label}: ${command.name} names closure ${digest} with no schema root`);
    const seen = clusters.get(clusterDigest);
    if (seen) seen.labels.push(src.label);
    else clusters.set(clusterDigest, { labels: [src.label], document: src.document });
  }
  const helpers = new Set<string>();
  const validators: string[] = [];
  for (const [digest, root] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
    const { closureDigest, source } = standaloneContractSource({ root });
    if (closureDigest !== digest) throw new Error(`closure ${digest} compiles as ${closureDigest}`);
    validators.push(`  ${JSON.stringify(digest)}: ${validatorBody(source, digest, helpers)},`);
  }
  const imports = [...helpers].sort().map((m) => `import * as __rt_${m} from "ajv/dist/runtime/${m}.js";`);
  const clusterRows = [...clusters].sort(([a], [b]) => a.localeCompare(b))
    .map(([digest, c]) => `  ${JSON.stringify(digest)}: ${JSON.stringify({ sources: c.labels, ...c.document })},`);
  const text = [
    "// @ts-nocheck",
    "// GENERATED by @cotal-ai/core/browser-validators-build. Do not edit; regenerate from the contract sources.",
    ...imports,
    "/** An Ajv runtime helper from a CommonJS module, whichever way the importer exposes its exports. */",
    "const __rt = (ns, name) => {",
    "  const exports = ns.default !== null && typeof ns.default === \"object\" && name in ns.default ? ns.default : ns;",
    "  const value = exports[name];",
    "  if (typeof value !== \"function\") throw new Error(`ajv runtime helper ${name} is not a function`);",
    "  return value;",
    "};",
    "export const contracts = Object.freeze({ validators: Object.freeze({",
    ...validators,
    "}), clusters: Object.freeze({",
    ...clusterRows,
    "}) });",
    "",
  ].join("\n");
  return { text, clusters: clusters.size, closures: roots.size };
}
