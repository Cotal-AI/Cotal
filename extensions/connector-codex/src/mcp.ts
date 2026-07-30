import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerCotalTools,
  type AgentConfig,
  type MeshAgent,
} from "@cotal-ai/connector-core";
import { CONNECTOR_VERSION } from "./version.js";

export interface CodexMcpServer {
  url: string;
  close(): Promise<void>;
}

export function withCotalMcp(
  config: Record<string, unknown> | undefined,
  url: string,
  token: string,
): Record<string, unknown> {
  const current = config?.mcp_servers;
  if (
    current !== undefined &&
    (!current || typeof current !== "object" || Array.isArray(current))
  )
    throw new Error("Codex thread config mcp_servers must be an object");
  const servers = (current ?? {}) as Record<string, unknown>;
  if (servers.cotal !== undefined)
    throw new Error("Codex thread config must not override the managed cotal MCP server");
  return {
    ...config,
    mcp_servers: {
      ...servers,
      cotal: {
        url,
        http_headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  };
}

export async function startCodexMcpServer(
  agent: MeshAgent,
  config: AgentConfig,
  token: string,
): Promise<CodexMcpServer> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });
  const mcp = new McpServer({
    name: "cotal",
    version: CONNECTOR_VERSION,
  });
  registerCotalTools(mcp, agent, config, "codex");
  await mcp.connect(transport);

  const server = createServer((request, response) => {
    if (
      request.url !== "/mcp" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(404).end();
      return;
    }
    void transport.handleRequest(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500).end();
      process.stderr.write(
        `[cotal-codex] MCP request failed: ${(error as Error).message}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close(): Promise<void> {
      await transport.close();
      await closeHttpServer(server);
    },
  };
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
