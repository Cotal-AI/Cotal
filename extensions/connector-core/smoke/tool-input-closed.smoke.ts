/**
 * A TOOL'S ARGUMENT OBJECT IS UNTRUSTED INPUT, AND AN OPEN SCHEMA DROPS THE PART THAT MATTERS.
 *
 * Every `cotal_*` tool is defined once, platform-neutrally, in {@link cotalToolSpecs}, and five
 * adapters render from that one source: the shared MCP renderer here (Claude Code), the Codex MCP
 * renderer, OpenCode, pi, and Hermes. The specs are AUTHORED as raw Zod shapes because that reads
 * better inline; `cotalToolSpecs` closes each one exactly once on the way out, so no author can
 * forget and no adapter can be handed an open schema.
 *
 * WHY CLOSURE, AND NOT MERELY VALIDATION. A plain `z.object` does not reject an unmodelled key — it
 * STRIPS it. So a call carrying `owner` or `actor` alongside the real arguments does not fail; it
 * succeeds, having quietly discarded exactly the fields a caller would use to speak for someone
 * else. The tool then does something subtly different from what its caller asked, and the caller is
 * told nothing. A refusal that names the key is strictly better than a success that hides it: the
 * model can read it and repair, which a silent strip gives it no way to do.
 *
 * WHAT THIS FILE ASSERTS:
 *
 *   1. at least one spec carries a schema                 <- the control (see below)
 *   2. EVERY spec's schema refuses an unmodelled key      <- the closure itself, at the source
 *   3. the shared MCP renderer EMITS `additionalProperties: false` on tools/list
 *   4. an MCP tools/call carrying identity-shaped extras is REFUSED TO THE CALLER
 *   5. ...and the tool's `run` never executes
 *
 * (1) is a control, not decoration: if `cotalToolSpecs` ever returned schemaless specs, every
 * closure assertion below would pass vacuously over an empty set.
 *
 * (3) and (4) are separate claims on purpose. Emitting `additionalProperties: false` only advertises
 * the rule; a host that advertises and does not enforce leaves the strip in place while looking
 * covered. The two adapters whose hosts do NOT enforce — OpenCode and Hermes — therefore close at
 * their own dispatch instead, and assert it in their own suites; nothing above them has touched
 * those args, so that is the real boundary and not a stand-in for one.
 *
 * WHAT IT DOES NOT COVER, said plainly: it grades the shared renderer, not the four other render
 * sites — those are graded in their own packages, because an assertion made here about a host this
 * package cannot import would be an assertion about a copy of the thing under test.
 *
 * Run: pnpm smoke:tool-input-closed
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configFromEnv } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { registerCotalTools } from "../src/tools.js";
import type { MeshAgent } from "../src/agent.js";

process.env.COTAL_SPACE ||= "toolclosed";
process.env.COTAL_NAME ||= "closed-1";
// `||=` KEEPS an already-set value, so this suite is loopback only where nothing set the
// variable. In any shell that already exports COTAL_SERVERS — an agent's, an operator's — it
// resolves to that instead, and an archived run gave no way to tell which. It names its target
// now: a suite that names its target cannot silently change it. Measured, and true today: this
// suite opens no TCP connection to the value at all (verified against a listener that counted
// zero accepts), so the line discloses a CONFIG input, not traffic. If that ever stops being
// true, this line is already where a reader would look.
const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";
console.log(`• broker: ${process.env.COTAL_SERVERS} (${brokerFromEnv ? "INHERITED from the environment" : "suite default"})`);

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { console.log(`  ok    ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

const config = configFromEnv();
const specs = cotalToolSpecs(config, "smoke");
const withArgs = specs.filter((s) => Object.keys(s.schema.shape).length > 0);
const zeroArg = specs.filter((s) => Object.keys(s.schema.shape).length === 0);

// Two premises, both load-bearing. The first is the invariant that was broken: a spec authored
// without a shape used to pass through the factory SCHEMALESS, and every adapter's schemaless path
// forwards whatever it is handed — so `cotal_roster` with `{owner, actor}` succeeded on all five
// hosts. The second keeps the closure loop below from being vacuous in the direction that matters:
// if no zero-argument tool were present, the empty-closure case would go ungraded.
check("EVERY spec carries a closed input object — the factory mints no schemaless tool",
  specs.length > 0 && specs.every((s) => !!s.schema), { specs: specs.length });
check(`the set contains BOTH argument-bearing and zero-argument tools, so neither closure case is ungraded`,
  withArgs.length > 0 && zeroArg.length > 0, { withArgs: withArgs.length, zeroArg: zeroArg.map((s) => s.name) });

// ── 2. the closure at the source ──
// Identity-shaped on purpose: this is the confused-deputy case, not a generic typo. A tool that
// accepted `owner` would be speaking for whoever the caller named.
const IDENTITY_EXTRA = { owner: "u_attacker", actor: "someone-else" };
const notClosed: string[] = [];
for (const spec of specs) {
  const probe = spec.schema.safeParse({ ...IDENTITY_EXTRA });
  const refusedTheExtras = !probe.success &&
    probe.error.issues.some((i) => i.code === "unrecognized_keys" && i.keys.some((k) => k in IDENTITY_EXTRA));
  if (!refusedTheExtras) notClosed.push(spec.name);
}
check(`every tool schema REFUSES an unmodelled key rather than stripping it (${specs.length} schemas, ${zeroArg.length} of them zero-argument)`,
  notClosed.length === 0, { notClosed });

// ── 3-5. the shared MCP renderer, against a real server and a real client ──
// The witness for "the handler never ran" is the AGENT, and it has to be: `registerCotalTools`
// calls `cotalToolSpecs()` itself, so the array it registers is not the `specs` array above.
// Wrapping `run` on a spec from `specs` therefore observes nothing the server ever calls, and its
// counter reads zero whether the refusal bit or not. The agent proxy IS the object the server was
// handed, so every property access it sees is an execution that got past the boundary.
const reached: string[] = [];
const agent = new Proxy({} as MeshAgent, {
  get(_t, prop) {
    reached.push(String(prop));
    throw new Error(`the tool reached the mesh agent (${String(prop)}) — it should have been refused`);
  },
});

const server = new McpServer({ name: "tool-input-closed", version: "0.0.0" });
registerCotalTools(server, agent, config, "smoke");

// A tool with arguments, chosen from the rendered surface rather than named here, so this cannot
// grade a tool that was removed. cotal_status takes optional args, so the extras are the ONLY
// reason a call can fail — nothing else is missing.
const probeName = "cotal_status";
if (!withArgs.some((s) => s.name === probeName)) throw new Error(`${probeName} is no longer an argument-bearing tool — repoint this suite`);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "tool-input-closed-client", version: "0.0.0" });
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const listed = await client.listTools();
const emitted = listed.tools.filter((t) => t.inputSchema && Object.keys(t.inputSchema.properties ?? {}).length > 0);
const open = emitted.filter((t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false);
check(`the MCP renderer EMITS additionalProperties:false for every tool with arguments (${emitted.length})`,
  emitted.length > 0 && open.length === 0, { open: open.map((t) => t.name) });

// The zero-argument tools separately, because the filter above excludes them by construction and
// they are the ones that regressed: registered without an `inputSchema`, a no-argument tool has
// nothing for the host to check and forwards the extras to be dropped.
const emittedZero = listed.tools.filter((t) => zeroArg.some((s) => s.name === t.name));
const openZero = emittedZero.filter((t) => (t.inputSchema as { additionalProperties?: unknown } | undefined)?.additionalProperties !== false);
check(`...and for every ZERO-ARGUMENT tool too, which is where the seam was open (${emittedZero.length})`,
  emittedZero.length === zeroArg.length && emittedZero.length > 0 && openZero.length === 0,
  { openZero: openZero.map((t) => t.name), expected: zeroArg.length });

let refusal: string | undefined;
let succeeded = false;
try {
  const r = await client.callTool({ name: probeName, arguments: { ...IDENTITY_EXTRA } });
  succeeded = !r.isError;
  if (r.isError) refusal = JSON.stringify(r.content);
} catch (e) {
  refusal = (e as Error).message;
}

check("an MCP call carrying identity-shaped extras is REFUSED TO THE CALLER, naming the keys",
  !succeeded && !!refusal && refusal.includes("unrecognized_keys") &&
    Object.keys(IDENTITY_EXTRA).every((k) => refusal!.includes(k)),
  { refusal, succeeded });
check("...and the tool's run never executed — the refusal precedes the effect, it does not report one",
  reached.length === 0, { reached });

// A zero-argument tool through the SAME real client. This is the case that shipped broken, and it
// cannot be inferred from the argument-bearing one: it travelled a different registration branch.
let zeroRefusal: string | undefined;
let zeroSucceeded = false;
const zeroName = zeroArg[0].name;
try {
  const r = await client.callTool({ name: zeroName, arguments: { ...IDENTITY_EXTRA } });
  zeroSucceeded = !r.isError;
  if (r.isError) zeroRefusal = JSON.stringify(r.content);
} catch (e) {
  zeroRefusal = (e as Error).message;
}
check(`a ZERO-ARGUMENT tool (${zeroName}) also refuses identity-shaped extras rather than running without them`,
  !zeroSucceeded && !!zeroRefusal && zeroRefusal.includes("unrecognized_keys") &&
    Object.keys(IDENTITY_EXTRA).every((k) => zeroRefusal!.includes(k)) && reached.length === 0,
  { zeroRefusal, zeroSucceeded, reached });

// POSITIVE CONTROL, and the reason the two `reached.length === 0` assertions above mean anything:
// a well-formed call must get PAST the boundary and touch the agent. Without this, a witness that
// can never fire — the previous version wrapped `run` on a spec array the server never registered
// — reads exactly like a refusal that works.
let controlErr: string | undefined;
try {
  const r = await client.callTool({ name: probeName, arguments: {} });
  if (r.isError) controlErr = JSON.stringify(r.content);
} catch (e) {
  controlErr = (e as Error).message;
}
check("CONTROL: a well-formed call to the same tool DOES reach the agent — the witness can fire",
  reached.length > 0, { reached, controlErr });

await client.close();
await server.close();

console.log(`\n${failures === 0 ? "TOOL-INPUT-CLOSED SMOKE OK ✅" : "TOOL-INPUT-CLOSED SMOKE FAILED"}  (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
