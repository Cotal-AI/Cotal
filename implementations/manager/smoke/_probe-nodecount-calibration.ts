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
import { compileContract, countSchemaNodes } from "@cotal-ai/core";
import { managerContractArtifactValues, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";

/** Applicator keywords whose VALUE is a subschema (or a map/array of them). Compile cost is driven
 *  by how many subschemas ajv generates code for, so the walk follows exactly these. */
const SUBSCHEMA = ["not", "if", "then", "else", "items", "contains", "additionalProperties", "propertyNames", "unevaluatedItems", "unevaluatedProperties"];
const SUBSCHEMA_MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SUBSCHEMA_LIST = ["allOf", "anyOf", "oneOf", "prefixItems"];

/** Node count comes from core's exported {@link countSchemaNodes} — the SAME function the
 *  `maxSchemaNodes` bound enforces. A ceiling calibrated against one definition of "node" and
 *  enforced against another is not calibrated, so this must never grow a local copy. The keyword
 *  count is the probe's own, reported alongside because it is the obvious rival proxy and the
 *  numbers show it is not a better one. */
function countNodes(doc: unknown): { nodes: number; keywords: number } {
  let keywords = 0;
  const walk = (d: unknown): void => {
    if (d === null || typeof d !== "object") return;
    if (Array.isArray(d)) { for (const v of d) walk(v); return; }
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      keywords++;
      if (SUBSCHEMA.includes(k)) walk(v);
      else if (SUBSCHEMA_MAP.includes(k) && v && typeof v === "object") for (const s of Object.values(v as object)) walk(s);
      else if (SUBSCHEMA_LIST.includes(k) && Array.isArray(v)) for (const s of v) walk(s);
    }
  };
  walk(doc);
  return { nodes: countSchemaNodes(doc), keywords };
}

/** Warm CPU + elapsed for one compile. A discard compile first so we measure the schema, not V8.
 *
 *  A schema OVER the budget is REFUSED, which would make the pathological edge unmeasurable
 *  exactly because it is pathological — the first run of this probe reported "no synthetic
 *  exceeded 100ms" while a 1001-node synthetic was being refused at 178ms two lines above. The
 *  refusal message carries the measurement, so parse it rather than throwing away the one data
 *  point the upper edge depends on. A refused row is still a measured row; it is flagged so the
 *  table never passes one off as a clean compile. */
function costOf(root: unknown): { cpuMs: number; elapsedMs: number; digest: string; refused: boolean } | { error: string } {
  const BUDGET_REFUSAL = /compile took (\d+)ms of CPU \(profile budget \d+ms; (\d+)ms elapsed\)/;
  // NOW THAT THE CEILING IS ENFORCED, THIS PROBE CANNOT RE-DERIVE IT UNAIDED. Every synthetic above
  // `maxSchemaNodes` is refused BEFORE compiling, so its cost is unmeasurable by construction —
  // the bound removed the very observation that justified the bound. That is correct behaviour and
  // a real limitation of this tool: to re-run the calibration (a new host, a Node upgrade, a
  // contract that has grown), raise `SCHEMA_PROFILE.maxSchemaNodes` for the duration of the run.
  // Those rows are labelled below rather than left to look like a compile error.
  const NODE_REFUSAL = /(\d+) subschema nodes \(profile max (\d+)\)/;
  try { compileContract({ root: root as Record<string, unknown> }); } catch { /* discard: warms V8; a refusal here is read from the second attempt */ }
  const c0 = process.cpuUsage(); const t0 = Date.now();
  try {
    const digest = compileContract({ root: root as Record<string, unknown> }).closureDigest;
    const c = process.cpuUsage(c0);
    return { cpuMs: (c.user + c.system) / 1000, elapsedMs: Date.now() - t0, digest, refused: false };
  } catch (e) {
    const msg = (e as Error).message;
    const m = BUDGET_REFUSAL.exec(msg);
    if (m) return { cpuMs: Number(m[1]), elapsedMs: Number(m[2]), digest: "", refused: true };
    const n = NODE_REFUSAL.exec(msg);
    if (n) return { error: `over the ${n[2]}-node ceiling (${n[1]}) - cost unmeasurable while enforced; raise maxSchemaNodes to re-calibrate` };
    return { error: msg.slice(0, 60) };
  }
}

/** Which COMMANDS a compiled root serves, by closure-digest identity. The per-command source
 *  schemas are module-private, but `MANAGER_CONTRACTS` exposes each command's compiled input and
 *  output, and the closure digest IS the identity — so this names a schema without reaching into
 *  the module or guessing from artifact order (roots are deduped, so one root can serve several
 *  commands, and saying so is more useful than picking one). */
const DIGEST_TO_COMMANDS = new Map<string, string[]>();
for (const [name, pair] of Object.entries(MANAGER_CONTRACTS)) {
  for (const [side, compiled] of [["in", pair.input], ["out", pair.output]] as const) {
    const key = compiled.closureDigest;
    if (!DIGEST_TO_COMMANDS.has(key)) DIGEST_TO_COMMANDS.set(key, []);
    DIGEST_TO_COMMANDS.get(key)!.push(`${name}.${side}`);
  }
}
/** The closure manifest artifacts (`{v, root, members}`) are published beside each root but are not
 *  schemas and are never compiled by the manager's own `cc`, so they must not distort the edges. */
const isManifest = (v: unknown): boolean =>
  !!v && typeof v === "object" && "root" in (v as object) && "members" in (v as object) && "v" in (v as object);

const rows: Array<{ label: string; kind: "REAL" | "manifest" | "synthetic"; nodes: number; keywords: number; cpuMs: number; elapsedMs: number; refused?: boolean; note?: string }> = [];

// (a) every contract this repo actually registers.
const real = managerContractArtifactValues();
real.forEach((root, i) => {
  const { nodes, keywords } = countNodes(root);
  const kind = isManifest(root) ? "manifest" as const : "REAL" as const;
  const cost = costOf(root);
  if ("error" in cost) { rows.push({ label: `artifact #${i}`, kind, nodes, keywords, cpuMs: NaN, elapsedMs: NaN, note: cost.error }); return; }
  const served = DIGEST_TO_COMMANDS.get(cost.digest);
  const label = kind === "manifest" ? `closure manifest #${i}` : (served ? served.join(",").slice(0, 24) : `artifact #${i}`);
  rows.push({ label, kind, nodes, keywords, ...cost });
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
  ["patterned x600", patterned(600)], ["patterned x700", patterned(700)],
  ["patterned x800", patterned(800)], ["patterned x1000", patterned(1000)],
  ["plain x1000", plain(1000)],
  ["nested d12", nested(12)], ["anyOf x100", unioned(100)], ["anyOf x400", unioned(400)],
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
    pad(Number.isNaN(r.cpuMs) ? "-" : r.cpuMs.toFixed(1), 10) + pad(Number.isNaN(r.elapsedMs) ? "-" : String(r.elapsedMs), 10) +
    (r.refused ? "REFUSED over budget (measurement read from the refusal)" : (r.note ?? "")),
  );
}

// The two edges a defensible ceiling has to sit between.
const reals = rows.filter((r) => r.kind === "REAL" && !Number.isNaN(r.cpuMs));
const maxRealNodes = Math.max(...reals.map((r) => r.nodes));
const maxRealCpu = Math.max(...reals.map((r) => r.cpuMs));
const expensive = rows.filter((r) => !Number.isNaN(r.cpuMs) && r.cpuMs > 100).sort((a, b) => a.nodes - b.nodes)[0];

// THE CONTRACT THAT WINDOWS ACTUALLY REFUSED. `Windows / required` failed with
// `compile took 125ms of CPU (profile budget 100ms; 80ms elapsed)` at manager-service-contract.ts's
// per-command compile, so a ceiling that does not clear THIS contract fixes nothing. Report where
// it sits, and name the single schema carrying the most cost, so a narrow margin points at a
// schema to look at rather than at a number to raise.
const worst = reals.slice().sort((a, b) => b.cpuMs - a.cpuMs)[0];
const totalRealNodes = reals.reduce((s, r) => s + r.nodes, 0);
const totalRealCpu = reals.reduce((s, r) => s + r.cpuMs, 0);
console.log(`\nMANAGER SERVICE CONTRACT (the one Windows refused):`);
console.log(`  compiled schemas:                ${reals.length} (import compiles every one)`);
console.log(`  total:                           ${totalRealNodes} nodes, ${totalRealCpu.toFixed(1)}ms CPU warm across all of them`);
if (worst) {
  console.log(`  most expensive single schema:    ${worst.label} — ${worst.nodes} nodes, ${worst.cpuMs.toFixed(1)}ms CPU warm`);
  // The instrument's own variance, stated against a fixed external observation. `Windows /
  // required` refused one of THESE schemas at 125ms of CPU. If the costliest of them measures a
  // few ms here, the refusal was not measuring the schema.
  console.log(`  vs Windows CI refusing one of them at 125ms CPU: ${(125 / Math.max(worst.cpuMs, 0.1)).toFixed(0)}x the cost of the most expensive one measured here`);
}

console.log(`\nLARGEST REAL registered contract:  ${maxRealNodes} nodes, ${maxRealCpu.toFixed(1)}ms CPU warm`);
if (expensive) {
  console.log(`CHEAPEST schema over 100ms CPU:    ${expensive.nodes} nodes (${expensive.label}, ${expensive.cpuMs.toFixed(1)}ms)`);
  // Absolute AND ratio: "550 nodes apart" and "2.4x" read very differently, and it is the RATIO
  // that says whether a ceiling survives the real contracts growing.
  console.log(`MARGIN, absolute:                  ${expensive.nodes - maxRealNodes} nodes`);
  console.log(`MARGIN, ratio:                     ${(expensive.nodes / Math.max(maxRealNodes, 1)).toFixed(1)}x`);
  // Headroom for the schema that actually costs the most, which is not necessarily the one with the
  // most NODES — if those two differ, node count is already mispredicting cost on our own contract,
  // and that is a finding about the proxy rather than about the ceiling.
  if (worst) {
    console.log(`HEADROOM for our costliest schema: ${(expensive.nodes / Math.max(worst.nodes, 1)).toFixed(1)}x its ${worst.nodes} nodes before the pathological edge`);
    if (worst.nodes !== maxRealNodes)
      console.log(`  NOTE: costliest (${worst.nodes} nodes) is NOT the largest (${maxRealNodes} nodes) — node count mispredicts cost HERE, on a real contract.`);
  }
  console.log(`\nA ceiling is defensible only if that margin is wide. Narrow margin => node count does`);
  console.log(`NOT separate real contracts from pathological ones, the proposal FAILS, and we say so.`);
  console.log(`If it IS narrow, the finding is about OUR contract, not the ceiling: name the schema`);
  console.log(`above and ask whether it is near-pathological in its own right. Do NOT widen to fit.`);
} else {
  console.log(`No synthetic exceeded 100ms CPU warm — widen the spread before drawing any ceiling.`);
}
console.log(`\nMeasured warm, after a discard compile. Must be run on a quiet box holding the build lock.`);
