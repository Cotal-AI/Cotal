/**
 * The cotal_* surface, served by the host ITSELF over a loopback MCP endpoint.
 *
 * Why not app-server `dynamicTools` (the obvious choice, and what this connector did first):
 * a dynamic tool is routed back to *the client that owns the turn*. That works while the host
 * is the only client, but the moment the operator's TUI is attached and types something, the
 * turn belongs to the TUI — which refuses outright ("Dynamic tool calls are not available in
 * TUI yet"). The mesh tools would exist on mesh-driven turns and vanish on human-driven ones.
 *
 * An MCP server has no such split: the **app-server** is the MCP client, so it executes the
 * call itself and no UI client is ever asked to. The same cotal_* tools therefore work
 * identically whether the turn came from a peer message or from someone typing in the TUI.
 *
 * Transport is streamable HTTP on 127.0.0.1 rather than a stdio child, so the tools stay
 * IN THIS PROCESS: one mesh endpoint, one credential, one presence. A stdio MCP server would
 * be a second process that then needs its own channel back here to reach the MeshAgent.
 *
 * The endpoint is loopback-bound and bearer-authenticated with a token minted once per HOST
 * (the endpoint deliberately outlives app-server restarts, so this token does too), handed
 * to the codex child by env var name (`bearer_token_env_var`) so it is never an argv string.
 * Loopback alone is not a boundary on a shared workstation — any local user could otherwise
 * speak as this agent on the mesh — so the token is what guards it, not the bind address.
 *
 * The honest limit: the token lives in the codex child's environment, and managed agents on one
 * machine share a uid. A hostile SIBLING agent that can read that environment could impersonate
 * this one on the mesh. That is the same same-uid boundary the app-server listener has (see
 * app-server.ts), and it is documented rather than claimed away.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { cotalToolSpecs, NO_TOOL_ARGS, type MeshAgent, type AgentConfig, type ToolResult } from "@cotal-ai/connector-core";

/** The env var the codex child reads the bearer token from (`mcp_servers.cotal.bearer_token_env_var`). */
export const MCP_TOKEN_ENV = "COTAL_MCP_TOKEN";
/** The MCP server name, and therefore the `mcp_servers.<name>` config prefix. */
export const MCP_SERVER_NAME = "cotal";
/** The path the endpoint answers on. */
const MCP_PATH = "/mcp";
/** Concurrent MCP sessions to keep. One live app-server needs exactly one; the cap only bounds
 *  the leak from app-server restarts, which drop their session without a DELETE. */
const MAX_SESSIONS = 8;
/** Cap on one JSON-RPC request body. Tool arguments are small; anything near this is a bug or an
 *  attempt to grow the host's memory with a stolen bearer. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface CotalMcpEndpoint {
  /** `http://127.0.0.1:<port>/mcp` — what `mcp_servers.cotal.url` points at. */
  url: string;
  /** The bearer token, passed to the child by env var NAME (see {@link MCP_TOKEN_ENV}). */
  token: string;
  close(): Promise<void>;
}

/** Constant-time bearer comparison — a length-independent equality check on a secret invites
 *  timing recovery, and this one guards the agent's whole mesh identity. */
function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Is this request actually from this machine, addressed to this machine? The `Host` check is
 *  the DNS-rebinding guard: a browser can be steered to a name that resolves to 127.0.0.1, but
 *  it cannot forge the Host header we require, nor attach the bearer token. */
function fromLoopback(req: IncomingMessage, port: number): boolean {
  const remote = req.socket.remoteAddress ?? "";
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const host = req.headers.host ?? "";
  const expected = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return local && expected.includes(host);
}

/**
 * Build and serve the cotal_* tools. The returned URL/token go into the codex child's config
 * and env. That token is what keeps other OS users and off-box callers out; it is not a barrier
 * to a same-uid sibling that can read the child's environment (see the header).
 */
export async function startCotalMcp(
  agent: MeshAgent,
  config: AgentConfig,
  log: (m: string) => void,
): Promise<CotalMcpEndpoint> {
  const token = randomBytes(32).toString("hex");
  const specs = cotalToolSpecs(config, "codex");

  /** One MCP server per session. Cheap: every one closes over the SAME MeshAgent, so this is
   *  tool wiring, not a second mesh identity. */
  const build = (): McpServer => {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.0.0" });
    for (const spec of specs) {
      const toContent = (r: ToolResult) => {
        const content = [{ type: "text" as const, text: r.text }];
        return r.isError ? { content, isError: true as const } : { content };
      };
      // The one Codex-specific override (shared with the OpenCode connector): automatic traffic
      // is OWNED by the host's turn loop — surfaced into turns and acked at the turn boundary —
      // so cotal_inbox must pull only quiet ambient here. A destructive drain of automatic items
      // would ack messages the loop is still accountable for delivering.
      if (spec.name === "cotal_inbox") {
        server.registerTool(
          spec.name,
          {
            title: spec.title,
            description:
              "Pull and clear quiet-channel ambient waiting for you. Connector-managed automatic traffic " +
              "stays queued; in focus mode, normal channel recall is also shown read-only.",
            // The override drops the spec's own `peek` and supplies `scope` itself, so the caller
            // has nothing to send — but WITHOUT an `inputSchema` the host has nothing to refuse
            // against and forwards extras to be discarded here. Publish the closed empty object.
            inputSchema: NO_TOOL_ARGS,
          },
          async () => toContent(await spec.run(agent, config, { scope: "pull-only" })),
        );
        continue;
      }
      // Always with the closed `inputSchema`, empty ones included — a tool registered without one
      // has nothing for the host to check against and forwards whatever the model sent.
      server.registerTool(
        spec.name,
        { title: spec.title, description: spec.description, inputSchema: spec.schema },
        async (args: Record<string, unknown>) => toContent(await spec.run(agent, config, args)),
      );
    }
    return server;
  };

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  const drop = (id: string): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.server.close().catch(() => {});
  };

  let port = 0;
  const http: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (!fromLoopback(req, port)) {
        res.writeHead(403).end();
        return;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        log(`mcp: rejected an unauthenticated ${req.method} — something local is probing the endpoint`);
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const path = (req.url ?? "").split("?")[0];
      if (path !== MCP_PATH) {
        res.writeHead(404).end();
        return;
      }

      let body: unknown;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          const chunk = c as Buffer;
          // Bounded even though the caller is already authenticated: a wedged or hostile client
          // holding the bearer should not be able to grow this process without limit.
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "payload too large" }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          res.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }),
          );
          return;
        }
      }

      const sid = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) return existing.transport.handleRequest(req, res, body);

      // No session yet: only an `initialize` may open one. Anything else is a stale client
      // pointing at a session this process no longer has.
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "no such MCP session" }, id: null }),
        );
        return;
      }
      const server = build();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, server });
          // An app-server that crashed never sends DELETE, so its session would linger. Evict
          // oldest-first rather than grow without bound across restarts.
          while (sessions.size > MAX_SESSIONS) {
            const oldest = sessions.keys().next().value;
            if (oldest === undefined) break;
            log(`mcp: evicting stale session ${oldest}`);
            drop(oldest);
          }
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) drop(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((e) => {
      log(`mcp: request failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((res, rej) => {
    http.once("error", rej);
    http.listen(0, "127.0.0.1", res);
  });
  const addr = http.address();
  if (!addr || typeof addr === "string") throw new Error("cotal MCP endpoint did not bind a TCP port");
  port = addr.port;
  const url = `http://127.0.0.1:${port}${MCP_PATH}`;
  log(`mcp: serving ${specs.length} cotal tools on ${url}`);

  return {
    url,
    token,
    async close(): Promise<void> {
      for (const id of [...sessions.keys()]) drop(id);
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}
