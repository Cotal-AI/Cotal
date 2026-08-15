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
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";

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
  check("tools with arguments are served, so the closure assertion grades a non-empty set",
    withArgs.length > 0, { tools: listed.tools.length, withArgs: withArgs.length });
  const open = withArgs.filter((t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false);
  check(`every Codex-served tool with arguments advertises additionalProperties:false (${withArgs.length})`,
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
} finally {
  await client.close().catch(() => { /* already down */ });
  await endpoint.close();
}

console.log(`\n${failures === 0 ? "CODEX-TOOL-CLOSED SMOKE OK ✅" : "CODEX-TOOL-CLOSED SMOKE FAILED"}  (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
