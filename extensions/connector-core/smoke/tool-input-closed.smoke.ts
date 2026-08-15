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
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { console.log(`  ok    ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

const config = configFromEnv();
const specs = cotalToolSpecs(config, "smoke");
const withSchema = specs.filter((s) => s.schema);

check("the spec set carries schemas at all, so the closure assertions grade a non-empty set",
  withSchema.length > 0, { specs: specs.length, withSchema: withSchema.length });

// ── 2. the closure at the source ──
// Identity-shaped on purpose: this is the confused-deputy case, not a generic typo. A tool that
// accepted `owner` would be speaking for whoever the caller named.
const IDENTITY_EXTRA = { owner: "u_attacker", actor: "someone-else" };
const notClosed: string[] = [];
for (const spec of withSchema) {
  const probe = spec.schema!.safeParse({ ...IDENTITY_EXTRA });
  const refusedTheExtras = !probe.success &&
    probe.error.issues.some((i) => i.code === "unrecognized_keys" && i.keys.some((k) => k in IDENTITY_EXTRA));
  if (!refusedTheExtras) notClosed.push(spec.name);
}
check(`every tool schema REFUSES an unmodelled key rather than stripping it (${withSchema.length} schemas)`,
  notClosed.length === 0, { notClosed });

// ── 3-5. the shared MCP renderer, against a real server and a real client ──
// `run` must never execute, so an agent that throws on any use is the right stub: if the refusal
// failed to bite, the failure is loud rather than a quietly-mutated fixture.
const ran: string[] = [];
const agent = new Proxy({} as MeshAgent, {
  get(_t, prop) { throw new Error(`the tool reached the mesh agent (${String(prop)}) — it should have been refused`); },
});

const server = new McpServer({ name: "tool-input-closed", version: "0.0.0" });
registerCotalTools(server, agent, config, "smoke");

// A tool with a schema, chosen from the rendered surface rather than named here, so this cannot
// grade a tool that was removed. cotal_status takes optional args, so the extras are the ONLY
// reason a call can fail — nothing else is missing.
const probeName = "cotal_status";
const probeSpec = withSchema.find((s) => s.name === probeName);
if (!probeSpec) throw new Error(`${probeName} is no longer a schema-bearing tool — repoint this suite`);
const originalRun = probeSpec.run.bind(probeSpec);
probeSpec.run = (...args: Parameters<typeof originalRun>) => { ran.push(probeName); return originalRun(...args); };

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "tool-input-closed-client", version: "0.0.0" });
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const listed = await client.listTools();
const emitted = listed.tools.filter((t) => t.inputSchema && Object.keys(t.inputSchema.properties ?? {}).length > 0);
const open = emitted.filter((t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false);
check(`the MCP renderer EMITS additionalProperties:false for every tool with arguments (${emitted.length})`,
  emitted.length > 0 && open.length === 0, { open: open.map((t) => t.name) });

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
  ran.length === 0, { ran });

await client.close();
await server.close();

console.log(`\n${failures === 0 ? "TOOL-INPUT-CLOSED SMOKE OK ✅" : "TOOL-INPUT-CLOSED SMOKE FAILED"}  (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
