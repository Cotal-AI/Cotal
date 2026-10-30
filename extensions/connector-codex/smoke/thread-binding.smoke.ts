/** Native MCP request metadata binds tools to one managed Codex conversation. */
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { configFromEnv, type MeshAgent } from "@cotal-ai/connector-core";
import { startCotalMcp } from "../src/mcp.js";

for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
Object.assign(process.env, { COTAL_SPACE: "threadbinding", COTAL_NAME: "codexpeer" });
let bound: string | undefined = "bound-thread";
const reached: string[] = [];
const agent = new Proxy({} as MeshAgent, {
  get(_target, prop) {
    reached.push(String(prop));
    if (prop === "pullQuietInbox") return () => [];
    return () => undefined;
  },
});
const endpoint = await startCotalMcp(agent, configFromEnv(), () => {}, () => bound);
const client = new Client({ name: "thread-binding-smoke", version: "1" });
let pass = 0;
function check(name: string, ok: boolean): void { assert.ok(ok, name); pass++; console.log(`ok ${name}`); }
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
  }));
  for (const name of ["cotal_status", "cotal_inbox"]) {
    for (const meta of [undefined, {}, { threadId: "other-root" }, { threadId: 42 }]) {
      reached.length = 0;
      const result = await client.callTool({ name, arguments: {}, ...(meta ? { _meta: meta } : {}) });
      const text = JSON.stringify(result.content);
      check(`${name} refuses missing or foreign native thread metadata ${JSON.stringify(meta)}`,
        result.isError === true && reached.length === 0 && text.includes("bound-thread") && text.includes("/new"));
    }
    reached.length = 0;
    await client.callTool({ name, arguments: {}, _meta: { threadId: "bound-thread" } });
    check(`${name} accepts native bound-thread metadata`, reached.length > 0);
  }
  reached.length = 0;
  const forged = await client.callTool({ name: "cotal_status", arguments: { threadId: "bound-thread" }, _meta: { threadId: "other-root" } });
  check("model arguments cannot supply ownership", forged.isError === true && reached.length === 0);
  bound = undefined;
  const starting = await client.callTool({ name: "cotal_status", arguments: {}, _meta: { threadId: "bound-thread" } });
  check("unready incarnation refuses without mesh effects", starting.isError === true && reached.length === 0 && JSON.stringify(starting.content).includes("not ready"));
  bound = "replacement-thread";
  const stale = await client.callTool({ name: "cotal_status", arguments: {}, _meta: { threadId: "bound-thread" } });
  check("old incarnation cannot keep speaking", stale.isError === true && reached.length === 0);
  await client.callTool({ name: "cotal_status", arguments: {}, _meta: { threadId: "replacement-thread" } });
  check("legitimate replacement uses current bound thread", reached.length > 0);
} finally {
  await client.close();
  await endpoint.close();
}
console.log(`CODEX THREAD BINDING PASSED (${pass} checks)`);
