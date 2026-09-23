/**
 * PI IS THE HOST THAT ALREADY ENFORCED, AND THE CODE USED TO OPT OUT OF IT.
 *
 * pi validates a tool call strictly against the JSON Schema it was registered with, so it is the one
 * adapter whose host would refuse an unmodelled key without being asked. The converter here used to
 * suppress exactly that: it wrapped the shared raw shape in a plain `z.object` and converted under
 * `io:"input"` specifically because the default io emits `additionalProperties: false` — chosen, in
 * its own words, so pi would match the Claude Code / OpenCode STRIP behaviour. It matched the wrong
 * thing. Those hosts now refuse too, and a rationale for opting out of a refusal must not outlive
 * the behaviour it was matching.
 *
 * A closed object emits `additionalProperties: false` under EVERY io mode, so closing pi cost the
 * io choice nothing: `io:"input"` remains because this schema describes what a caller may SEND, and
 * it no longer decides closure.
 *
 * WHAT THIS FILE ASSERTS, against the parameters handed to the real `pi.registerTool`:
 *   1. tools with arguments are actually registered   <- the control
 *   2. every one of them carries `additionalProperties: false`
 *   3. a JSON round-trip of every tool's parameters carries only JSON Schema keywords
 *      (no `~standard` brand or other vendor member survives stringify — #1835)
 *
 * WHAT IT DOES NOT COVER: the refusal itself. pi's validator is pi's, not ours, and it is not in
 * this process — this grades what we hand it, which is the half we own. The refusal is graded at the
 * hosts we can drive end to end (the MCP renderer) and at the dispatches we own (OpenCode, Hermes).
 *
 * Run: pnpm smoke:pi-tool-closed
 */
import { configFromEnv } from "@cotal-ai/connector-core";
import type { MeshAgent } from "@cotal-ai/connector-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCotalTools } from "../src/tools.js";

// WHATEVER RUNS THIS SUITE MAY BE A MANAGED AGENT SESSION, and `configFromEnv` below reads the
// AMBIENT environment, so that session's live identity becomes an input this suite never chose.
// The whole COTAL_ prefix goes here, at module scope, before the first read: a scrub of one
// variable leaves the twelve beside it, and a scrub inside a function is a promise that the
// function runs first. Graded by `pnpm smoke:suite-ambient-env-self`.
const inheritedBroker = process.env.COTAL_SERVERS !== undefined;
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

process.env.COTAL_SPACE ||= "toolclosed";
process.env.COTAL_NAME ||= "pi-1";
// After that scrub this `||=` always takes the default, so the line below discloses the value the
// suite RESOLVED plus whether an ambient one was discarded on the way in. The second half is only
// knowable BEFORE the scrub, which is why it is captured above. Measured, and true today: this
// suite opens no TCP connection to the value at all (verified against a listener that counted
// zero accepts), so the line discloses a CONFIG input, not traffic. If that ever stops being
// true, this line is already where a reader would look.
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";
console.log(`• broker: ${process.env.COTAL_SERVERS} (suite default; an inherited COTAL_SERVERS was ${inheritedBroker ? "DISCARDED by the ambient scrub" : "absent"})`);

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { console.log(`  ok    ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

type Registered = { name: string; parameters: { properties?: Record<string, unknown>; additionalProperties?: unknown } };
const registered: Registered[] = [];
const pi = { registerTool: (def: Registered) => { registered.push(def); } } as unknown as ExtensionAPI;
const agent = new Proxy({} as MeshAgent, {
  get(_t, prop) { throw new Error(`registration touched the mesh agent (${String(prop)})`); },
});

registerCotalTools(pi, agent, configFromEnv());

const withArgs = registered.filter((d) => Object.keys(d.parameters?.properties ?? {}).length > 0);
const zeroArg = registered.filter((d) => Object.keys(d.parameters?.properties ?? {}).length === 0);
// BOTH subsets, and both asserted non-empty. Grading only `withArgs` is what hid the hole this
// suite exists to guard: a zero-argument tool was registered with an OPEN empty object, so
// `{owner, actor}` on `cotal_roster` was accepted and discarded while every cell here stayed green.
check("tools with arguments AND zero-argument tools are both registered, so neither closure case is ungraded",
  withArgs.length > 0 && zeroArg.length > 0, { registered: registered.length, withArgs: withArgs.length, zeroArg: zeroArg.map((d) => d.name) });

const open = registered.filter((d) => d.parameters.additionalProperties !== false);
check(`EVERY pi tool is registered CLOSED, zero-argument ones included (${registered.length} tools, ${zeroArg.length} zero-argument)`,
  open.length === 0, { open: open.map((d) => d.name) });

// JSON Schema keywords at any depth (draft 2020-12 plus the common applicator/validation
// vocabulary). Everything else in a JSON round-trip is a stray brand or vendor member a strict
// provider refuses the whole declaration for (#1835: `~standard.{vendor,version}`).
const SCHEMA_KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "$comment", "$anchor", "$dynamicRef", "$dynamicAnchor",
  "type", "properties", "required", "additionalProperties", "items", "prefixItems", "unevaluatedItems",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependentSchemas", "propertyNames",
  "enum", "const", "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
  "maxLength", "minLength", "pattern", "maxItems", "minItems", "uniqueItems", "maxContains",
  "minContains", "maxProperties", "minProperties", "patternProperties", "title", "description",
  "default", "deprecated", "readOnly", "writeOnly", "examples", "format", "contentEncoding",
  "contentMediaType", "contentSchema", "contains", "dependentRequired", "definitions",
]);

/** Every path at every depth of the round-tripped value whose key is not a JSON Schema keyword.
 *  Walks only where JSON Schema itself nests (arrays and keyword values): a stray member's OWN
 *  children (e.g. `~standard.jsonSchema`) are artifacts of the stray, not additional strays, and
 *  `properties` keys are property NAMES, which JSON Schema does not constrain. */
function strayKeys(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => strayKeys(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    const here = keys.filter((k) => !SCHEMA_KEYWORDS.has(k)).map((k) => `${path}.${k}`);
    const nested = keys.filter((k) => SCHEMA_KEYWORDS.has(k) && k !== "properties" && k !== "patternProperties" && k !== "dependentSchemas");
    return [...here, ...nested.flatMap((k) => strayKeys((value as Record<string, unknown>)[k], `${path}.${k}`))];
  }
  return [];
}

const strays: string[] = [];
for (const d of registered) {
  // The round-trip is the measurement: JSON.stringify is exactly where a non-enumerable member
  // either stays hidden (zod's raw render) or leaks (after an enumerable copy), so the cell grades
  // what pi's registry would hand a provider, not the in-memory descriptor.
  const roundTripped = JSON.parse(JSON.stringify(d.parameters ?? {}));
  strays.push(...strayKeys(roundTripped, `parameters(${d.name})`));
}
check(`a JSON round-trip of every tool's parameters carries ONLY JSON Schema keywords (${registered.length} tools)`,
  strays.length === 0, { strays });

console.log(`\n${failures === 0 ? "PI-TOOL-CLOSED SMOKE OK ✅" : "PI-TOOL-CLOSED SMOKE FAILED"}  (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
