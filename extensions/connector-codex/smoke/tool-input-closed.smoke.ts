/**
 * THE CODEX CONNECTOR RENDERS THE TOOL SURFACE ITSELF, SO IT CAN DRIFT BY ITSELF.
 *
 * `startCotalMcp` builds its own `McpServer` and registers the shared specs with its own copy of
 * the registration loop — it does not go through connector-core's renderer. That is a deliberate
 * split (Codex needs a bearer-guarded HTTP endpoint and its own `cotal_inbox` override), and it is
 * exactly why the closure has to be graded here too: a suite that proved the shared renderer closes
 * would say nothing about this one, while reading as if the surface were covered.
 *
 * WHAT THIS FILE ASSERTS, against the real endpoint over real HTTP with the real bearer token:
 *   1. tools with arguments are served                            <- the control
 *   2. every one of them advertises `additionalProperties: false`
 *   3. a call carrying identity-shaped extras is REFUSED TO THE CALLER, naming the keys
 *   4. ...and the tool's `run` never executes
 *
 * Run: pnpm smoke:codex-tool-closed
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { configFromEnv, cotalToolSpecs, type MeshAgent } from "@cotal-ai/connector-core";
import { startCotalMcp } from "../src/mcp.js";

process.env.COTAL_SPACE ||= "toolclosed";
process.env.COTAL_NAME ||= "codex-1";
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
const reached: string[] = [];
const agent = new Proxy({} as MeshAgent, {
  get(_t, prop) { reached.push(String(prop)); return () => undefined; },
});

const TOOL = "cotal_status"; // optional args only: the extras are the ONLY reason a call can fail
const spec = cotalToolSpecs(config, "codex").find((s) => s.name === TOOL);
if (!spec?.schema) throw new Error(`${TOOL} is no longer a schema-bearing tool — repoint this suite`);

const IDENTITY_EXTRA = { owner: "u_attacker", actor: "someone-else" };
const endpoint = await startCotalMcp(agent, config, () => { /* quiet */ });
const client = new Client({ name: "codex-tool-closed", version: "0.0.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
  }));

  const listed = await client.listTools();
  const withArgs = listed.tools.filter((t) => Object.keys(t.inputSchema?.properties ?? {}).length > 0);
  const zeroArg = listed.tools.filter((t) => Object.keys(t.inputSchema?.properties ?? {}).length === 0);
  // Both subsets, both required non-empty. Grading only `withArgs` is what let the zero-argument
  // tools ship OPEN: this connector registered them with no `inputSchema` at all, so the host had
  // nothing to check and forwarded `{owner, actor}` to be dropped, with every cell here still green.
  check("tools with arguments AND zero-argument tools are both served, so neither closure case is ungraded",
    withArgs.length > 0 && zeroArg.length > 0, { tools: listed.tools.length, withArgs: withArgs.length, zeroArg: zeroArg.map((t) => t.name) });
  const open = listed.tools.filter((t) => (t.inputSchema as { additionalProperties?: unknown } | undefined)?.additionalProperties !== false);
  check(`EVERY Codex-served tool advertises additionalProperties:false (${listed.tools.length}, ${zeroArg.length} of them zero-argument)`,
    open.length === 0, { open: open.map((t) => t.name) });

  let refusal: string | undefined;
  let succeeded = false;
  try {
    const r = await client.callTool({ name: TOOL, arguments: { ...IDENTITY_EXTRA } });
    succeeded = !r.isError;
    if (r.isError) refusal = JSON.stringify(r.content);
  } catch (e) {
    refusal = (e as Error).message;
  }
  check("a call carrying identity-shaped extras is REFUSED TO THE CALLER, naming the keys",
    !succeeded && !!refusal && refusal.includes("unrecognized_keys") &&
      Object.keys(IDENTITY_EXTRA).every((k) => refusal!.includes(k)),
    { refusal, succeeded });
  check("...and the refusal precedes the effect: the tool never reached the mesh agent",
    reached.length === 0, { reached });

  // cotal_inbox is this connector's one override: it drops the spec's own arguments and supplies
  // `scope` itself. Registered without an `inputSchema` that substitution silently ate whatever the
  // caller sent, on that tool alone — the seam open at exactly the point nobody looks.
  let inboxRefusal: string | undefined;
  let inboxSucceeded = false;
  try {
    const r = await client.callTool({ name: "cotal_inbox", arguments: { ...IDENTITY_EXTRA } });
    inboxSucceeded = !r.isError;
    if (r.isError) inboxRefusal = JSON.stringify(r.content);
  } catch (e) {
    inboxRefusal = (e as Error).message;
  }
  check("cotal_inbox, whose arguments this connector SUBSTITUTES, refuses the caller's extras rather than discarding them",
    !inboxSucceeded && !!inboxRefusal && Object.keys(IDENTITY_EXTRA).every((k) => inboxRefusal!.includes(k)) && reached.length === 0,
    { inboxRefusal, inboxSucceeded, reached });

  // POSITIVE CONTROL. `reached` is the witness for all three assertions above, and a witness that
  // cannot fire is indistinguishable from a refusal that works.
  await client.callTool({ name: TOOL, arguments: {} }).catch(() => { /* the stub agent is inert */ });
  check("CONTROL: a well-formed call DOES reach the agent — the witness can fire",
    reached.length > 0, { reached });
} finally {
  await client.close().catch(() => { /* already down */ });
  await endpoint.close();
}

console.log(`\n${failures === 0 ? "CODEX-TOOL-CLOSED SMOKE OK ✅" : "CODEX-TOOL-CLOSED SMOKE FAILED"}  (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
