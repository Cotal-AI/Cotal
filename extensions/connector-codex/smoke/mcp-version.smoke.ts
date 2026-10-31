/** Standard MCP initialize must name the loaded release, not a placeholder or the CLI on PATH. */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { configFromEnv, DOCS_VERSION, type MeshAgent } from "@cotal-ai/connector-core";
import { startCotalMcp } from "../src/mcp.js";

const config = configFromEnv({ COTAL_NAME: "version-fixture", COTAL_SPACE: "versionfixture", COTAL_SERVERS: "nats://127.0.0.1:1" });
let reached = 0;
const agent = new Proxy({} as MeshAgent, { get() { reached++; throw new Error("metadata must not reach the mesh agent"); } });
const endpoint = await startCotalMcp(agent, config, () => {}, () => "fixture-thread");
let checked = 0;
let failed = 0;
const check = (name: string, value: unknown, expected: unknown) => {
  checked++;
  try { assert.deepEqual(value, expected); console.log(`ok ${name}`); }
  catch { failed++; console.log(`FAIL ${name}: ${JSON.stringify({ value, expected })}`); }
};
try {
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: "version-fixture", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
      }));
      check(`session ${i}: loaded release in serverInfo`, client.getServerVersion(), { name: "cotal", version: DOCS_VERSION });
      check(`session ${i}: orientation remains discoverable`, (await client.listTools()).tools.some(tool => tool.name === "cotal_orientation"), true);
    } finally { await client.close(); }
  }
  check("metadata requires no broker or agent call", reached, 0);
} finally { await endpoint.close(); }
assert.equal(checked, 5);
console.log(`CODEX MCP VERSION: ${checked - failed}/${checked} passed`);
process.exitCode = failed ? 1 : 0;
