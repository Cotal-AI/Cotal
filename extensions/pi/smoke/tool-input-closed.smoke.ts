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

process.env.COTAL_SPACE ||= "toolclosed";
process.env.COTAL_NAME ||= "pi-1";
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";

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

console.log(`\n${failures === 0 ? "PI-TOOL-CLOSED SMOKE OK ✅" : "PI-TOOL-CLOSED SMOKE FAILED"}  (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
