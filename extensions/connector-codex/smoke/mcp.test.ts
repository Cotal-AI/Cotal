import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentConfig, MeshAgent } from "@cotal-ai/connector-core";
import {
  startCodexMcpServer,
  withCotalMcp,
} from "../src/mcp.js";

test("injects an authenticated per-thread MCP server without replacing user config", () => {
  assert.deepEqual(
    withCotalMcp(
      {
        model_context_window: 123,
        mcp_servers: { existing: { command: "existing" } },
      },
      "http://127.0.0.1:1234/mcp",
      "secret-token",
    ),
    {
      model_context_window: 123,
      mcp_servers: {
        existing: { command: "existing" },
        cotal: {
          url: "http://127.0.0.1:1234/mcp",
          http_headers: {
            Authorization: "Bearer secret-token",
          },
        },
      },
    },
  );
  assert.throws(
    () =>
      withCotalMcp(
        { mcp_servers: { cotal: { command: "untrusted" } } },
        "http://127.0.0.1/mcp",
        "secret-token",
      ),
    /must not override/,
  );
});

test("serves connector-core cotal_dm through the authenticated MCP endpoint", async () => {
  const calls: Array<{ to: string; text: string }> = [];
  const agent = {
    async dm(to: string, text: string) {
      calls.push({ to, text });
      return { peer: { card: { name: to } } };
    },
  } as unknown as MeshAgent;
  const config = {
    space: "smoke",
    name: "codex",
    subscribe: ["general"],
  } as AgentConfig;
  const token = "test-token";
  const server = await startCodexMcpServer(agent, config, token);
  const client = new Client({ name: "codex-connector-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    assert.equal((await fetch(server.url)).status, 404);
    assert.equal(
      (
        await fetch(server.url, {
          headers: { Authorization: "Bearer wrong-token" },
        })
      ).status,
      404,
    );
    assert.deepEqual(calls, []);
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "cotal_dm"));
    const result = await client.callTool({
      name: "cotal_dm",
      arguments: { to: "peer", text: "hello" },
    });
    assert.deepEqual(calls, [{ to: "peer", text: "hello" }]);
    assert.match(JSON.stringify(result.content), /DM sent to peer/);
  } finally {
    await client.close();
    await server.close();
  }
});
