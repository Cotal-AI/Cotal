/**
 * Builds the contracts the browser entry (`@cotal-ai/core/browser`) can enforce without runtime code
 * generation. Two steps, both deterministic:
 *
 *   extract <contract module> <label> <out.json>
 *     Reads one released or source Manager contract module (`managerClusterDocument`,
 *     `managerContractArtifactValues`, `managerClusterArtifacts`) and writes its cluster document
 *     and schema roots as data. Run it against a published package's own dist to add a release.
 *
 *   generate
 *     Reads every `browser-contracts/*.json`, recomputes each cluster and closure digest with THIS
 *     core's §13.7 profile, refuses any digest that does not match what the source module recorded,
 *     and writes `src/browser-contracts.generated.ts`: one standalone validator per closure digest
 *     (`standaloneContractSource`, the same profile options as `compileContract`) and the cluster
 *     documents keyed by their closure digest.
 *
 * Run: pnpm --filter @cotal-ai/core gen:browser-contracts (after `build`, so `@cotal-ai/core` resolves).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { singleDocumentClosure, standaloneContractSource } from "../src/schema-profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const inputs = join(here, "..", "browser-contracts");
const output = join(here, "..", "src", "browser-contracts.generated.ts");

interface ContractSource {
  label: string;
  clusterDigest: string;
  document: { urn: string; revision: number; commands: Array<{ name: string; inputDigest: string; outputDigest: string }> };
  roots: unknown[];
}

async function extract(modulePath: string, label: string, out: string): Promise<void> {
  const mod = await import(pathToFileURL(resolve(modulePath)).href);
  const document = mod.managerClusterDocument();
  const { closureDigest } = mod.managerClusterArtifacts();
  const artifactValues = mod.managerContractArtifactValues;
  const values: unknown[] = [...(typeof artifactValues === "function" ? artifactValues() : artifactValues)];
  // Keep only the schema roots a command names: the closure manifests are rebuilt from them.
  const byClosure = new Map(values.map((value) => [singleDocumentClosure(value).closureDigest, value]));
  const wanted = new Set<string>(document.commands.flatMap((c: { inputDigest: string; outputDigest: string }) => [c.inputDigest, c.outputDigest]));
  const roots = [...wanted].sort().map((digest) => {
    const root = byClosure.get(digest);
    if (root === undefined) throw new Error(`${label}: no schema root for closure ${digest}`);
    return root;
  });
  const source: ContractSource = { label, clusterDigest: closureDigest, document, roots };
  writeFileSync(out, JSON.stringify(source, null, 2) + "\n");
  console.log(`extract: ${label} cluster ${closureDigest}, ${document.commands.length} commands, ${roots.length} closures -> ${out}`);
}

/** Ajv's standalone output still names its runtime helpers with `require`, even in ESM mode. Each is
 *  rewritten to an ESM namespace import; any other `require`, or any runtime code generation, refuses. */
const RUNTIME_REQUIRE = /require\("ajv\/dist\/runtime\/(ucs2length|equal|uri|quote|timestamp|re2|parseJson)"\)\.(\w+)/g;
const HEADER = /^"use strict";\s*export const validate = (\w+);\s*export default \1;/;

function validatorBody(source: string, digest: string, helpers: Set<string>): string {
  const head = HEADER.exec(source);
  if (!head) throw new Error(`closure ${digest}: unexpected standalone output shape`);
  const body = source.slice(head[0].length).replace(RUNTIME_REQUIRE, (_m, mod: string, name: string) => {
    helpers.add(mod);
    return `__rt(__rt_${mod}, ${JSON.stringify(name)})`;
  });
  if (/\brequire\s*\(|new Function|\beval\s*\(/.test(body))
    throw new Error(`closure ${digest}: standalone output still needs require or runtime evaluation`);
  return `(() => {\n"use strict";\n${body}\nreturn ${head[1]};\n})()`;
}

function generate(): void {
  const files = readdirSync(inputs).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no contract sources in ${inputs}`);
  const clusters = new Map<string, { labels: string[]; document: ContractSource["document"] }>();
  const roots = new Map<string, unknown>();
  for (const file of files) {
    const src = JSON.parse(readFileSync(join(inputs, file), "utf8")) as ContractSource;
    const clusterDigest = singleDocumentClosure(src.document).closureDigest;
    if (clusterDigest !== src.clusterDigest)
      throw new Error(`${file}: cluster document recomputes to ${clusterDigest}, the source recorded ${src.clusterDigest}`);
    for (const root of src.roots) roots.set(singleDocumentClosure(root).closureDigest, root);
    for (const command of src.document.commands)
      for (const digest of [command.inputDigest, command.outputDigest])
        if (!roots.has(digest)) throw new Error(`${file}: ${command.name} names closure ${digest} with no schema root`);
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
    "// GENERATED by packages/core/scripts/gen-browser-contracts.ts from packages/core/browser-contracts/*.json.",
    "// Do not edit. Regenerate with `pnpm --filter @cotal-ai/core gen:browser-contracts`.",
    ...imports,
    "/** An Ajv runtime helper from a CommonJS module, whichever way the importer exposes its exports. */",
    "const __rt = (ns, name) => {",
    "  const exports = ns.default !== null && typeof ns.default === \"object\" && name in ns.default ? ns.default : ns;",
    "  const value = exports[name];",
    "  if (typeof value !== \"function\") throw new Error(`ajv runtime helper ${name} is not a function`);",
    "  return value;",
    "};",
    "export const PACKAGED_VALIDATORS = Object.freeze({",
    ...validators,
    "});",
    "export const PACKAGED_CLUSTERS = Object.freeze({",
    ...clusterRows,
    "});",
    "",
  ].join("\n");
  writeFileSync(output, text);
  console.log(`generate: ${clusters.size} cluster documents, ${roots.size} closures, helpers [${[...helpers].sort().join(", ")}] -> ${output}`);
}

const [verb, ...rest] = process.argv.slice(2);
if (verb === "extract" && rest.length === 3) await extract(rest[0]!, rest[1]!, rest[2]!);
else if (verb === "generate" && rest.length === 0) generate();
else throw new Error("usage: gen-browser-contracts.ts extract <module> <label> <out.json> | generate");
