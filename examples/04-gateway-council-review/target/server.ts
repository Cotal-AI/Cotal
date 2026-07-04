/**
 * agentgw: a demo LLM gateway for a coding-agent CLI.
 *
 * Holds provider keys server-side, issues CLI tokens, rate-limits, and serves
 * the encrypted logic bundle. See README.md. Purpose-built review target.
 */

import { issueToken, validate } from "./auth";
import { encryptBundleFor } from "./bundle";
import { keyFor, putKeys } from "./keys";
import { allowUser } from "./ratelimit";

function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") return json({ status: "ok" });

  // Device flow tail: issue a CLI token for a verified user. Verification of
  // the device code is elsewhere; here we trust the demo caller.
  if (url.pathname === "/auth/token" && req.method === "POST") {
    const { userId, email } = (await req.json().catch(() => ({}))) as {
      userId?: string;
      email?: string;
    };
    if (!userId || !email) return json({ error: "userId and email required" }, 400);
    return json({ token: issueToken(userId, email) });
  }

  // Store a caller's BYO provider keys.
  if (url.pathname === "/keys" && req.method === "PUT") {
    const s = validate(bearer(req));
    if (!s) return json({ error: "unauthorized" }, 401);
    const body = (await req.json().catch(() => ({}))) as {
      openaiKey?: string;
      anthropicKey?: string;
    };
    putKeys(s.userId, { openaiKey: body.openaiKey, anthropicKey: body.anthropicKey });
    return json({ ok: true });
  }

  // Proxy an LLM completion. Auth + per-user rate limit. BYO key if present.
  if (url.pathname === "/llm" && req.method === "POST") {
    const s = validate(bearer(req));
    if (!s) return json({ error: "unauthorized" }, 401);
    if (!(await allowUser(s.userId))) return json({ error: "rate limited" }, 429);
    const { provider = "anthropic" } = (await req.json().catch(() => ({}))) as {
      provider?: "openai" | "anthropic";
    };
    const key = keyFor(s.userId, provider) ?? process.env[`${provider.toUpperCase()}_API_KEY`];
    if (!key) return json({ error: `no ${provider} key configured` }, 400);
    // A real gateway forwards to the provider here. Demo: acknowledge only.
    return json({ ok: true, provider, usedByoKey: Boolean(keyFor(s.userId, provider)) });
  }

  // Serve the encrypted logic bundle for the authenticated user.
  if (url.pathname === "/bundle") {
    const token = bearer(req);
    const s = validate(token);
    if (!s || !token) return json({ error: "unauthorized" }, 401);
    return json(encryptBundleFor(token));
  }

  return json({ error: "not found" }, 404);
}

const port = Number(process.env.PORT ?? 8787);
Bun.serve({ port, fetch: handle });
console.log(`agentgw listening on :${port}`);
