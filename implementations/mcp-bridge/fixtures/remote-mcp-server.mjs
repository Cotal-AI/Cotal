/**
 * Remote MCP server fixtures for mcp-bridge-remote.smoke.ts — started in-process.
 *
 * - startBearerServer(): a Streamable HTTP MCP server gated by a static bearer token.
 * - startOAuthServer():  a fake OAuth authorization server + token-protected MCP endpoint
 *   (DCR + PKCE authorize/token), enough to exercise the full interactive login flow.
 *
 * Both expose a single `echo` tool via the low-level Server API (no zod dependency).
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function makeMcpServer() {
  const server = new Server({ name: "remote-fixture", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo back the message.",
        inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text", text: String(req.params.arguments?.message ?? "") }],
  }));
  return server;
}

/** Handle an MCP request with a fresh stateless transport (JSON responses, no sessions). */
async function handleMcp(req, res) {
  let body;
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    body = raw ? JSON.parse(raw) : undefined;
  }
  const server = makeMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const listen = (srv) =>
  new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv.address().port)));
const sendJson = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};

/** Streamable HTTP MCP server requiring `Authorization: Bearer <token>`. */
export async function startBearerServer({ token = "secret-token" } = {}) {
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname !== "/mcp") return res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${token}`)
      return res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end();
    await handleMcp(req, res);
  });
  const port = await listen(srv);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

/** Fake OAuth (DCR + PKCE) + token-protected MCP endpoint. Auto-approves `/authorize`. */
export async function startOAuthServer() {
  const codes = new Map(); // code -> { challenge, redirect }
  const tokens = new Set(); // valid access tokens
  let base = "";

  const meta = () => ({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });

  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, base);
    const path = u.pathname;

    if (path === "/.well-known/oauth-protected-resource")
      return sendJson(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")
      return sendJson(res, 200, meta());

    if (path === "/register" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      return sendJson(res, 201, {
        client_id: "test-client",
        redirect_uris: body.redirect_uris ?? [],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    }

    if (path === "/authorize") {
      const redirect = u.searchParams.get("redirect_uri");
      const state = u.searchParams.get("state");
      const code = randomBytes(16).toString("hex");
      codes.set(code, { challenge: u.searchParams.get("code_challenge"), redirect });
      const loc = new URL(redirect);
      loc.searchParams.set("code", code);
      if (state) loc.searchParams.set("state", state);
      return res.writeHead(302, { location: loc.href }).end();
    }

    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type");
      const issue = () => {
        const access = randomBytes(24).toString("hex");
        tokens.add(access);
        return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: randomBytes(24).toString("hex"), scope: "mcp" };
      };
      if (grant === "authorization_code") {
        const rec = codes.get(form.get("code"));
        if (!rec) return sendJson(res, 400, { error: "invalid_grant" });
        const expect = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (rec.challenge && rec.challenge !== expect)
          return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
        codes.delete(form.get("code"));
        return sendJson(res, 200, issue());
      }
      if (grant === "refresh_token") return sendJson(res, 200, issue());
      return sendJson(res, 400, { error: "unsupported_grant_type" });
    }

    if (path === "/mcp") {
      const auth = req.headers.authorization ?? "";
      const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!tokens.has(tok))
        return res
          .writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` })
          .end();
      return handleMcp(req, res);
    }

    res.writeHead(404).end();
  });
  const port = await listen(srv);
  base = `http://127.0.0.1:${port}`;
  return { url: `${base}/mcp`, close: () => new Promise((r) => srv.close(() => r())) };
}
