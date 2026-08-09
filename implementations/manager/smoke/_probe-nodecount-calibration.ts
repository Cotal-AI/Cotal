/**
 * CALIBRATION PROBE (not a suite): does schema NODE/KEYWORD COUNT predict compile cost well enough
 * to replace the wall-clock/CPU time budget with a deterministic pre-compile bound?
 *
 * The time budget refuses a schema whose COMPILATION is the DoS. It cannot be measured soundly:
 * elapsed time counts the machine, and `process.cpuUsage()` counts V8's background JIT threads and
 * any sibling Worker (16.4ms process CPU against 0.18ms thread CPU, measured by the critic seat).
 * Node count is computable EXACTLY before compiling, identically on every host.
 *
 * A proxy nobody has calibrated is superstition, so this reports the numbers rather than asserting
 * the relationship: node count against compile cost for (a) every contract this repo actually
 * registers, and (b) a spread of synthetics up to genuinely pathological. A defensible ceiling has
 * to sit well ABOVE the largest real contract and well BELOW the cheapest pathological one; this
 * prints both edges and the margin between them, so the number can be argued with.
 *
 * Measured WARM (after a discard compile) on purpose: the question is the schema's intrinsic cost,
 * not the process's cold-start, and cold-start is precisely the contamination that made the time
 * budget unusable.
 *
 * MUST run on a quiet box, holding the build lock. A number measured under load is the same mistake
 * this whole exercise exists to correct.
 *
 * Run: npx tsx implementations/manager/smoke/_probe-nodecount-calibration.ts
 */
import { compileContract } from "@cotal-ai/core";
import { managerContractArtifactValues } from "../src/manager-service-contract.js";

/** Applicator keywords whose VALUE is a subschema (or a map/array of them). Compile cost is driven
 *  by how many subschemas ajv generates code for, so the walk follows exactly these. */
const SUBSCHEMA = ["not", "if", "then", "else", "items", "contains", "additionalProperties", "propertyNames", "unevaluatedItems", "unevaluatedProperties"];
const SUBSCHEMA_MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SUBSCHEMA_LIST = ["allOf", "anyOf", "oneOf", "prefixItems"];

/** Count (subschema nodes, applied keywords) in a schema document. Deterministic, cheap, and
 *  independent of spelling: 1000 patterned properties is ~1000 nodes however tersely written. */
function countNodes(doc: unknown): { nodes: number; keywords: number } {
  let nodes = 0, keywords = 0;
  const walk = (d: unknown): void => {
    if (d === null || typeof d !== "object") return;
    if (Array.isArray(d)) { for (const v of d) walk(v); return; }
    nodes++;
    const o = d as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      keywords++;
      if (SUBSCHEMA.includes(k)) walk(v);
      else if (SUBSCHEMA_MAP.includes(k) && v && typeof v === "object") for (const s of Object.values(v as object)) walk(s);
      else if (SUBSCHEMA_LIST.includes(k) && Array.isArray(v)) for (const s of v) walk(s);
    }
  };
  walk(doc);
  return { nodes, keywords };
}

/** Warm CPU + elapsed for one compile. A discard compile first so we measure the schema, not V8. */
function costOf(root: unknown): { cpuMs: number; elapsedMs: number } | { error: string } {
  try { compileContract({ root: root as Record<string, unknown> }); } catch (e) { return { error: (e as Error).message.slice(0, 60) }; }
  const c0 = process.cpuUsage(); const t0 = Date.now();
  try { compileContract({ root: root as Record<string, unknown> }); } catch (e) { return { error: (e as Error).message.slice(0, 60) }; }
  const c = process.cpuUsage(c0);
  return { cpuMs: (c.user + c.system) / 1000, elapsedMs: Date.now() - t0 };
}

const rows: Array<{ label: string; kind: "REAL" | "synthetic"; nodes: number; keywords: number; cpuMs: number; elapsedMs: number; note?: string }> = [];

// (a) every contract this repo actually registers.
const real = managerContractArtifactValues();
real.forEach((root, i) => {
  const { nodes, keywords } = countNodes(root);
  const cost = costOf(root);
  if ("error" in cost) { rows.push({ label: `manager artifact #${i}`, kind: "REAL", nodes, keywords, cpuMs: NaN, elapsedMs: NaN, note: cost.error }); return; }
  rows.push({ label: `manager artifact #${i}`, kind: "REAL", nodes, keywords, ...cost });
});

// (b) synthetics: a spread from trivial to the shape that motivated the whole exercise.
const patterned = (n: number) => {
  const props: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) props[`p${i}`] = { type: "string", pattern: `^[a-z]{1,12}-[0-9]{1,6}$`, minLength: 1, maxLength: 40 };
  return { type: "object", properties: props, additionalProperties: false };
};
const plain = (n: number) => {
  const props: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) props[`p${i}`] = { type: "string" };
  return { type: "object", properties: props, additionalProperties: false };
};
const nested = (d: number) => { let s: Record<string, unknown> = { type: "string" }; for (let i = 0; i < d; i++) s = { type: "object", properties: { n: s } }; return s; };
const unioned = (n: number) => ({ anyOf: Array.from({ length: n }, (_, i) => ({ type: "object", properties: { [`k${i}`]: { const: i } }, required: [`k${i}`] })) });

for (const [label, root] of [
  ["trivial 1-prop", { type: "object", properties: { a: { type: "string" } } }],
  ["plain x50", plain(50)], ["plain x200", plain(200)], ["plain x600", plain(600)],
  ["patterned x50", patterned(50)], ["patterned x200", patterned(200)],
  ["patterned x600", patterned(600)], ["patterned x1000", patterned(1000)],
  ["nested d20", nested(20)], ["anyOf x100", unioned(100)], ["anyOf x400", unioned(400)],
] as Array<[string, unknown]>) {
  const { nodes, keywords } = countNodes(root);
  const cost = costOf(root);
  if ("error" in cost) { rows.push({ label, kind: "synthetic", nodes, keywords, cpuMs: NaN, elapsedMs: NaN, note: cost.error }); continue; }
  rows.push({ label, kind: "synthetic", nodes, keywords, ...cost });
}

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\n${pad("schema", 26)}${pad("kind", 11)}${pad("nodes", 8)}${pad("keywords", 10)}${pad("cpu ms", 10)}${pad("elapsed", 10)}note`);
for (const r of rows) {
  console.log(
    pad(r.label, 26) + pad(r.kind, 11) + pad(String(r.nodes), 8) + pad(String(r.keywords), 10) +
    pad(Number.isNaN(r.cpuMs) ? "-" : r.cpuMs.toFixed(1), 10) + pad(Number.isNaN(r.elapsedMs) ? "-" : String(r.elapsedMs), 10) + (r.note ?? ""),
  );
}

// The two edges a defensible ceiling has to sit between.
const reals = rows.filter((r) => r.kind === "REAL" && !Number.isNaN(r.cpuMs));
const maxRealNodes = Math.max(...reals.map((r) => r.nodes));
const maxRealCpu = Math.max(...reals.map((r) => r.cpuMs));
const expensive = rows.filter((r) => !Number.isNaN(r.cpuMs) && r.cpuMs > 100).sort((a, b) => a.nodes - b.nodes)[0];

console.log(`\nLARGEST REAL registered contract:  ${maxRealNodes} nodes, ${maxRealCpu.toFixed(1)}ms CPU warm`);
if (expensive) {
  console.log(`CHEAPEST schema over 100ms CPU:    ${expensive.nodes} nodes (${expensive.label}, ${expensive.cpuMs.toFixed(1)}ms)`);
  // Absolute AND ratio: "550 nodes apart" and "2.4x" read very differently, and it is the RATIO
  // that says whether a ceiling survives the real contracts growing.
  console.log(`MARGIN, absolute:                  ${expensive.nodes - maxRealNodes} nodes`);
  console.log(`MARGIN, ratio:                     ${(expensive.nodes / Math.max(maxRealNodes, 1)).toFixed(1)}x`);
  console.log(`\nA ceiling is defensible only if that margin is wide. Narrow margin => node count does`);
  console.log(`NOT separate real contracts from pathological ones, the proposal FAILS, and we say so.`);
} else {
  console.log(`No synthetic exceeded 100ms CPU warm — widen the spread before drawing any ceiling.`);
}
console.log(`\nMeasured warm, after a discard compile. Must be run on a quiet box holding the build lock.`);
