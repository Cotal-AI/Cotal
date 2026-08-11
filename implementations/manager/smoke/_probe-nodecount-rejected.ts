/**
 * THE RECORD OF A REJECTED PROPOSAL (a probe, not a suite).
 *
 * PROPOSAL: replace the §13.8 compile-time budget — which cannot be measured soundly, because
 * elapsed time counts the machine and `process.cpuUsage()` counts V8's background JIT threads and
 * any sibling Worker — with a deterministic pre-compile ceiling on SUBSCHEMA NODE COUNT. Node count
 * is computable exactly before compiling, identically on every host. It shipped briefly as
 * `maxSchemaNodes` / `maxClosureNodes`.
 *
 * VERDICT: REJECTED, and both candidate bases for the constant were falsified by running this.
 *
 *   COST HAS NO KNEE, AND THE SPREAD GROWS WITH NODE COUNT. Section 2 measures it; THIS HEADER
 *   DELIBERATELY REPORTS NO NUMBERS. An earlier version quoted the ratios here and claimed two lines
 *   later that section 2 recomputes them rather than quoting them. It quoted them. A reviewer sent
 *   here for an independent figure then measured one matching the header to three significant
 *   figures, having read it first, and disclosed the exposure itself. AN INSTRUMENT SOMEONE IS SENT
 *   TO IN ORDER TO SETTLE A QUESTION MUST NOT OPEN BY TELLING THEM THE ANSWER.
 *
 *   THE CRASH IS NOT AN EDGE. A 2048-node patterned document was observed to RangeError in Ajv's
 *   codegen at ~186KB — inside `maxDocumentBytes`, which is what made it look like the one gap
 *   worth a node bound. But the SAME DOCUMENT IN THE SAME PROCESS threw cold and then compiled on
 *   the immediate warm retry, and on other hosts it does not throw at all. Section 3 runs that
 *   cold/warm pair and reports whichever it gets — including "both compiled", which is the same
 *   finding arrived at from the other side.
 *
 *   AND THE PROPOSED VALUE WAS UNSAFE ON AN UNMEASURED AXIS. Under `node --stack-size=256` a
 *   512-node object RangeErrors while 384 compiles — so `maxSchemaNodes: 512` did not hold at a
 *   supported process configuration that the value it replaced survived.
 *
 * WHY THIS FILE SURVIVES THE THING IT TESTED. A node ceiling has been proposed twice. The FIRST
 * one was indefensible in a way that is easy to repeat and hard to see: it was calibrated against a
 * corpus THE CEILING ITSELF BOUNDED. Every synthetic above the line was refused before compiling,
 * so its cost recorded as "unmeasurable", and the calibration then reported that nothing it
 * measured had exceeded the budget. Circular by construction — no evidence above the line could
 * exist, so the number was unfalsifiable the moment it shipped. Run this before proposing a third.
 *
 * NO BOUNDS ARE BYPASSED HERE, and that is not a compromise — it is the consequence of the ruling.
 * With `maxSchemaNodes` gone, `compileContract` no longer censors its own calibration, so the
 * ordinary registration path measures the whole ladder. The re-derivation blocker this probe used
 * to carry is MOOT, not fixed.
 *
 * MUST run on a quiet box, holding the build lock. A number measured under load is the same mistake
 * this whole exercise exists to correct. Measured WARM after a discard compile, except where a
 * section says otherwise: the question is a schema's intrinsic cost, not the process's cold start.
 *
 * Run: npx tsx implementations/manager/smoke/_probe-nodecount-rejected.ts
 */
import { compileContract } from "@cotal-ai/core";
import { managerContractArtifactValues, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";

/** Applicator keywords whose VALUE is a subschema (or a map/array of them). Compile cost is driven
 *  by how many subschemas Ajv generates code for, so the walk follows exactly these.
 *
 *  LOCAL ON PURPOSE. Core exported a `countSchemaNodes` so a calibration would measure the same
 *  quantity the bound enforced; with no bound, that export was a precise instrument wired to
 *  nothing and came out with it. This counter now serves only this probe, and nothing in the
 *  product depends on its definition of "node". */
const SUBSCHEMA = ["not", "if", "then", "else", "items", "contains", "additionalProperties", "propertyNames", "unevaluatedItems", "unevaluatedProperties", "contentSchema", "additionalItems"];
const SUBSCHEMA_MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];
const SUBSCHEMA_LIST = ["allOf", "anyOf", "oneOf", "prefixItems"];

/** Subschema nodes and raw keyword count. A BOOLEAN IS A SUBSCHEMA: `true`/`false` are valid
 *  2020-12 schemas and each is a branch the compiler generates code for. The first version of this
 *  walk returned on any non-object, which made `{anyOf: [false, …x40000]}` — legal, 240KB, ~3.8s to
 *  compile — count as ONE node. Kept correct here because a wrong counter would make the rejection
 *  above look like an artifact of bad measurement. */
function countNodes(doc: unknown): { nodes: number; keywords: number } {
  let nodes = 0, keywords = 0;
  const walk = (d: unknown): void => {
    if (typeof d === "boolean") { nodes++; return; }
    if (d === null || typeof d !== "object") return;
    if (Array.isArray(d)) { for (const v of d) walk(v); return; }
    nodes++;
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      keywords++;
      if (SUBSCHEMA.includes(k)) walk(v);
      else if (SUBSCHEMA_MAP.includes(k) && v && typeof v === "object") for (const s of Object.values(v as object)) walk(s);
      else if (SUBSCHEMA_LIST.includes(k) && Array.isArray(v)) for (const s of v) walk(s);
    }
  };
  walk(doc);
  return { nodes, keywords };
}

type Cost = { cpuMs: number; elapsedMs: number; digest: string } | { failed: string };

/** One compile through the ORDINARY registration path. Nothing is bypassed: with the node bounds
 *  removed, this path measures the full ladder, which is the whole reason the calibration is
 *  honest now and was not before. A codegen RangeError arrives here already normalised to
 *  `contract-invalid` by `compileWithinBudget`'s catch — that catch is what actually guards the
 *  overflow, and reporting it as a FAILURE row rather than a crash is what it looks like in
 *  production. */
function cost(root: unknown, warm: boolean): Cost {
  if (warm) { try { compileContract({ root: root as Record<string, unknown> }); } catch { /* discard compile: warms V8 */ } }
  const c0 = process.cpuUsage(); const t0 = Date.now();
  try {
    const digest = compileContract({ root: root as Record<string, unknown> }).closureDigest;
    const c = process.cpuUsage(c0);
    return { cpuMs: (c.user + c.system) / 1000, elapsedMs: Date.now() - t0, digest };
  } catch (e) {
    return { failed: `${(e as Error).message.slice(0, 72)} [after ${Date.now() - t0}ms]` };
  }
}

const pad = (s: string, n: number) => s.padEnd(n);

// ---- 1) EVERY CONTRACT THIS REPO ACTUALLY REGISTERS ---------------------------------------------
// The lower edge any proposed ceiling would have had to clear. Also the contract `Windows /
// required` refused at "125ms of CPU (profile budget 100ms; 80ms elapsed)" — CPU above wall clock,
// which is only possible with concurrent threads, so that refusal was measuring the runner and not
// the schema.
const DIGEST_TO_COMMANDS = new Map<string, string[]>();
for (const [name, pair] of Object.entries(MANAGER_CONTRACTS)) {
  for (const [side, compiled] of [["in", pair.input], ["out", pair.output]] as const) {
    const key = compiled.closureDigest;
    if (!DIGEST_TO_COMMANDS.has(key)) DIGEST_TO_COMMANDS.set(key, []);
    DIGEST_TO_COMMANDS.get(key)!.push(`${name}.${side}`);
  }
}
/** The closure manifest artifacts (`{v, root, members}`) are published beside each root but are not
 *  schemas and are never compiled, so they must not distort the edges. */
const isManifest = (v: unknown): boolean =>
  !!v && typeof v === "object" && "root" in (v as object) && "members" in (v as object) && "v" in (v as object);

console.log(`REAL registered contracts (warm)\n`);
console.log(`${pad("schema", 26)}${pad("nodes", 8)}${pad("keywords", 10)}${pad("cpu ms", 10)}elapsed`);
let realCount = 0, realNodes = 0, realCpu = 0, maxRealNodes = 0;
let worst = { label: "", nodes: 0, cpuMs: 0 };
for (const [i, root] of managerContractArtifactValues().entries()) {
  if (isManifest(root)) continue;
  const { nodes, keywords } = countNodes(root);
  const c = cost(root, true);
  if ("failed" in c) { console.log(pad(`artifact #${i}`, 26) + pad(String(nodes), 8) + pad(String(keywords), 10) + `FAILED: ${c.failed}`); continue; }
  const label = (DIGEST_TO_COMMANDS.get(c.digest) ?? [`artifact #${i}`]).join(",").slice(0, 24);
  console.log(pad(label, 26) + pad(String(nodes), 8) + pad(String(keywords), 10) + pad(c.cpuMs.toFixed(1), 10) + `${c.elapsedMs}ms`);
  realCount++; realNodes += nodes; realCpu += c.cpuMs;
  if (nodes > maxRealNodes) maxRealNodes = nodes;
  if (c.cpuMs > worst.cpuMs) worst = { label, nodes, cpuMs: c.cpuMs };
}
console.log(`\n  ${realCount} compiled schemas, ${realNodes} nodes and ${realCpu.toFixed(1)}ms CPU in total`);
console.log(`  largest single document: ${maxRealNodes} nodes`);
console.log(`  costliest single document: ${worst.label} at ${worst.cpuMs.toFixed(1)}ms CPU (${worst.nodes} nodes)`);
if (worst.nodes !== maxRealNodes)
  console.log(`  NOTE: the costliest is NOT the largest — node count mispredicts cost HERE, on a real contract.`);
console.log(`  vs the 125ms of "CPU" Windows CI refused one of these at: ${(125 / Math.max(worst.cpuMs, 0.1)).toFixed(0)}x the costliest measured here.`);

// ---- 2) THE FAMILY SPREAD: WHY THERE IS NO KNEE TO PUT A CONSTANT AT --------------------------
// Three families at the same node counts. If node count predicted cost, the columns would track
// each other. They do not, and the spread at one node count is the whole argument.
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
const unioned = (n: number) => ({ anyOf: Array.from({ length: n }, (_, i) => ({ type: "object", properties: { [`k${i}`]: { const: i } }, required: [`k${i}`] })) });
/** The CHEAP end of the spread, and it has to be here or the spread is understated. `false` is a
 *  valid 2020-12 subschema, so this is N compile units of almost no cost each — the opposite extreme
 *  from `patterned`. Omitting it is how a first version of this probe reported a 2.9x spread and
 *  left a 14x figure in a comment unmeasured beside it. */
const booleans = (n: number) => ({ anyOf: Array.from({ length: n }, (_, i) => i % 2 === 0) });

console.log(`\n\nFAMILY SPREAD (warm) — the ladder the FIRST ceiling could not see, because it refused it\n`);
console.log(`${pad("shape", 20)}${pad("nodes", 8)}${pad("cpu ms", 10)}${pad("elapsed", 10)}outcome`);
const atCount = new Map<number, number[]>();
for (const [shape, make] of [["object-patterned", patterned], ["plain", plain], ["anyOf-object", unioned], ["anyOf-boolean", booleans]] as Array<[string, (n: number) => unknown]>) {
  for (const n of [256, 512, 1024, 2048]) {
    const root = make(n);
    const { nodes } = countNodes(root);
    const c = cost(root, true);
    console.log(pad(shape, 20) + pad(String(nodes), 8) +
      ("failed" in c ? pad("-", 10) + pad("-", 10) + `REFUSED: ${c.failed}` : pad(c.cpuMs.toFixed(1), 10) + pad(String(c.elapsedMs), 10) + "compiled"));
    if (!("failed" in c)) { if (!atCount.has(n)) atCount.set(n, []); atCount.get(n)!.push(c.cpuMs); }
  }
}
for (const [n, costs] of [...atCount].sort((a, b) => a[0] - b[0])) {
  if (costs.length < 2) continue;
  const lo = Math.min(...costs), hi = Math.max(...costs);
  console.log(`  at ~${n} nodes: ${lo.toFixed(1)}ms .. ${hi.toFixed(1)}ms across families — ${(hi / Math.max(lo, 0.01)).toFixed(1)}x spread at ONE node count`);
}
console.log(`  A single scalar ceiling is set by the worst family and refuses the best. That is the`);
console.log(`  cost basis, and it is why there is no defensible number to pick.`);

// ---- 3) THE COUNTEREXAMPLE THAT KILLED THE CRASH BASIS ------------------------------------------
// Deliberately COLD then WARM, same document, same process. The crash basis said: the codegen
// RangeError is a hard edge, so put the ceiling a doubling below it. If the edge moves between two
// consecutive runs, there is nothing to sit below.
console.log(`\n\nCOLD-THEN-WARM, ONE DOCUMENT, ONE PROCESS — is the codegen overflow an edge at all?\n`);
{
  const big = patterned(2048);
  const { nodes } = countNodes(big);
  const cold = cost(big, false);
  const warm = cost(big, false); // no discard compile: this IS the immediate retry
  const show = (label: string, c: Cost) =>
    console.log(`  ${pad(label, 8)}${"failed" in c ? `RangeError/refusal — ${c.failed}` : `COMPILED in ${c.cpuMs.toFixed(1)}ms CPU / ${c.elapsedMs}ms elapsed`}`);
  console.log(`  ${nodes}-node object-patterned document:`);
  show("cold", cold);
  show("warm", warm);
  if ("failed" in cold && !("failed" in warm))
    console.log(`\n  REPRODUCED: threw cold, compiled warm. The "edge" moved between two consecutive runs.`);
  else if (!("failed" in cold) && !("failed" in warm))
    console.log(`\n  Both compiled on this host — the overflow is host/version-dependent, which is the same finding.`);
  else if ("failed" in cold && "failed" in warm)
    console.log(`\n  Both refused here. That does NOT restore the crash basis: it was falsified by a single\n  observed cold-throw/warm-compile pair, and one counterexample does not un-happen.`);
}

console.log(`\nStack size is a further axis and is NOT fixed by this process: re-run under`);
console.log(`\`node --stack-size=256\` and watch the overflow point move down past values that were`);
console.log(`safe here. A bound that is not a bound across the axes it ships on is not a bound.`);
console.log(`\nMeasured warm except section 3. Must be run on a quiet box holding the build lock.`);
