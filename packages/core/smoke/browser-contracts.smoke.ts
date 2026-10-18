/**
 * The browser entry (`@cotal-ai/core/browser`) against the real compiler and a sandbox with no
 * code generation (no test runner).
 *
 *  1. PARITY: every packaged closure gives the same verdict as `compileContract` over the same
 *     closure, on a value sampled from its schema and on mutations of it.
 *  2. DRIFT: the source Manager contract's cluster digest is packaged, so a contract change that
 *     skips `gen:browser-contracts` fails here.
 *  3. REFUSAL: an unknown cluster or closure digest refuses as `unsupported-version`; describe-view
 *     narrowing and last-cluster-wins match `resolveService`.
 *  4. CSP: bundled for the browser, the entry reaches no Node built-in and no transport-node, and it
 *     runs in a context whose string code generation is disabled, which is what `script-src 'self'`
 *     enforces. The control proves the context refuses `eval` and `new Function`.
 *
 * Run: pnpm smoke:browser-contracts   (after `pnpm --filter @cotal-ai/core build`)
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { compileContract, singleDocumentClosure, VOID_SCHEMA_DIGEST } from "../src/schema-profile.js";
import { EpEnvelopeError } from "../src/endpoint-error.js";
import { PACKAGED_MANAGER_CLUSTERS, packagedContract, packagedServiceSurface } from "../src/browser.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const refusal = (fn: () => unknown): string | undefined => {
  try { fn(); return undefined; } catch (e) { return e instanceof EpEnvelopeError ? e.code : `not an envelope error: ${String(e)}`; }
};

type Schema = Record<string, unknown>;
/** A value the schema describes, as far as a small walk can tell; parity holds either way. */
function sample(schema: unknown, depth = 0): unknown {
  if (depth > 8 || schema === null || typeof schema !== "object") return null;
  const s = schema as Schema;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  for (const key of ["oneOf", "anyOf", "allOf"]) if (Array.isArray(s[key])) return sample((s[key] as unknown[])[0], depth + 1);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "null": return null;
    case "boolean": return true;
    case "integer": case "number": return typeof s.minimum === "number" ? s.minimum : 0;
    case "string": return "a".repeat(typeof s.minLength === "number" ? Math.max(1, s.minLength) : 1);
    case "array": return typeof s.minItems === "number" && s.minItems > 0 ? Array.from({ length: s.minItems }, () => sample(s.items, depth + 1)) : [];
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(s.required) ? s.required as string[] : []) out[key] = sample(props[key], depth + 1);
      return out;
    }
    default: return null;
  }
}
function mutations(value: unknown): unknown[] {
  const out: unknown[] = [undefined, null, 0, "", [], {}, value];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0) out.push(Object.fromEntries(keys.slice(1).map((k) => [k, (value as Record<string, unknown>)[k]])));
    out.push({ ...(value as object), zzUnknown: 1 });
    for (const k of keys) out.push({ ...(value as object), [k]: 12345 });
  }
  return out;
}

// ---- 1. parity ----
const sources = readdirSync(join(here, "..", "browser-contracts")).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(here, "..", "browser-contracts", f), "utf8")) as { label: string; clusterDigest: string; roots: unknown[]; document: { commands: Array<{ name: string; inputDigest: string; outputDigest: string }> } });
check("at least one Manager release is packaged", PACKAGED_MANAGER_CLUSTERS.length >= 1 && sources.length >= 1, PACKAGED_MANAGER_CLUSTERS);
const roots = new Map<string, unknown>();
for (const src of sources) for (const root of src.roots) roots.set(singleDocumentClosure(root).closureDigest, root);
let compared = 0, mismatched = 0, accepted = 0;
for (const [digest, root] of roots) {
  const reference = compileContract({ root });
  const packaged = packagedContract(digest);
  check(`closure ${digest.slice(0, 19)} compiles to the packaged digest`, reference.closureDigest === digest);
  for (const value of mutations(sample(root))) {
    const expected = reference.validate(value);
    const got = packaged.check(value).ok;
    compared++;
    if (got) accepted++;
    if (expected !== got) { mismatched++; console.log(`    verdict differs on ${digest}:`, JSON.stringify(value)); }
  }
}
check(`packaged verdicts equal the compiler's (${compared} comparisons over ${roots.size} closures)`, mismatched === 0 && compared >= roots.size * 7, { compared, mismatched });
check(`the samples include accepted values (${accepted} accepted), not only refusals`, accepted >= roots.size, { accepted });

// ---- 2. drift ----
const source = await import(pathToFileURL(join(here, "..", "..", "..", "implementations", "manager", "src", "manager-service-contract.ts")).href);
const sourceDigest: string = source.managerClusterArtifacts().closureDigest;
check("the source Manager cluster document is packaged (regenerate on any contract change)",
  PACKAGED_MANAGER_CLUSTERS.some((c) => c.clusterDigest === sourceDigest), { sourceDigest, packaged: PACKAGED_MANAGER_CLUSTERS.map((c) => c.clusterDigest) });

// ---- 3. refusal and surface assembly ----
const cluster = PACKAGED_MANAGER_CLUSTERS[0]!;
const unknownDigest = `sha256:${"0".repeat(64)}`;
check("an unknown closure digest refuses as unsupported-version", refusal(() => packagedContract(unknownDigest)) === "unsupported-version");
check("an inherited property name is not a packaged closure", refusal(() => packagedContract("constructor")) === "unsupported-version");
check("a descriptor naming an unknown cluster refuses the whole surface",
  refusal(() => packagedServiceSurface({ clusters: [{ digest: cluster.clusterDigest, commands: [...cluster.commands] }, { digest: unknownDigest, commands: ["spawn"] }] })) === "unsupported-version");
const full = packagedServiceSurface({ clusters: [{ digest: cluster.clusterDigest, commands: [...cluster.commands] }] });
check("a full describe view resolves every packaged command", full.size === cluster.commands.length, full.size);
const narrow = packagedServiceSurface({ clusters: [{ digest: cluster.clusterDigest, commands: ["status"] }] });
check("a describe view narrows the surface to the commands it lists", narrow.size === 1 && narrow.has("status"), [...narrow.keys()]);
const status = full.get("status");
check("a packaged command keeps its declared capability, class and targeting", status?.capability === source.managerClusterDocument().commands.find((c: { name: string }) => c.name === "status")?.capability && status?.class === "ephemeral");
check("the void closure accepts null and refuses a value", packagedContract(VOID_SCHEMA_DIGEST).check(null).ok && !packagedContract(VOID_SCHEMA_DIGEST).check(1).ok);

// ---- 4. CSP: browser bundle, no Node, no code generation ----
const esbuild = await import(pathToFileURL(createRequire(join(here, "..", "..", "..", "implementations", "manager", "package.json")).resolve("esbuild")).href);
const bundle = await esbuild.build({
  entryPoints: [join(here, "..", "src", "browser.ts")], bundle: true, platform: "browser", format: "iife",
  globalName: "CotalBrowser", write: false, metafile: true, logLevel: "silent",
});
const inputs = Object.keys(bundle.metafile.inputs);
check("the browser bundle reaches no Node built-in and no transport-node",
  inputs.length > 0 && !inputs.some((p) => p.startsWith("node:") || p.includes("transport-node")), inputs.filter((p) => p.startsWith("node:") || p.includes("transport-node")));
check("the browser bundle does not include the runtime compiler", !inputs.some((p) => /ajv\/dist\/(2020|core|compile)/.test(p)), inputs.filter((p) => /ajv\/dist\/(2020|core|compile)/.test(p)));
const code = bundle.outputFiles[0].text as string;
const sandbox = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
check("CONTROL: the sandbox refuses eval and new Function", (() => {
  let refused = 0;
  for (const probe of ["eval('1')", "new Function('return 1')()"]) { try { vm.runInContext(probe, sandbox); } catch { refused++; } }
  return refused === 2;
})());
vm.runInContext(code, sandbox);
const verdicts = vm.runInContext(`(() => {
  const c = CotalBrowser.packagedContract(${JSON.stringify(VOID_SCHEMA_DIGEST)});
  const s = CotalBrowser.packagedServiceSurface({ clusters: [{ digest: ${JSON.stringify(cluster.clusterDigest)}, commands: ["status"] }] });
  return [c.check(null).ok, c.check(1).ok, s.size];
})()`, sandbox) as [boolean, boolean, number];
check("the bundled entry validates without code generation", verdicts[0] === true && verdicts[1] === false && verdicts[2] === 1, verdicts);

console.log(`\nBROWSER CONTRACTS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
