/**
 * cotal_feedback sender test (no test runner) — spins up a tiny recording HTTP server, points
 * the config's feedbackUrl at it, and drives the spec's run() directly to verify the routing:
 *   - keyed: Authorization: Bearer <key>, no email required;
 *   - keyless: contact email in the body, NO auth header;
 *   - keyless without any email source: err() before any request leaves;
 *   - a 400 reply surfaces the server's `error` field as an error result.
 * Run: pnpm smoke:feedback
 */
import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage } from "node:http";
import { cotalToolSpecs } from "./src/tool-specs.js";
import type { AgentConfig } from "./src/config.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

interface Hit {
  auth?: string;
  body: Record<string, unknown>;
}
const hits: Hit[] = [];
let nextStatus = 200;
let nextReply: unknown = { ok: true, id: "fb_1" };

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};
const http = createServer(async (req, res) => {
  hits.push({ auth: req.headers.authorization, body: await readBody(req) });
  res.writeHead(nextStatus, { "content-type": "application/json" });
  res.end(JSON.stringify(nextReply));
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/v1/feedback`;

const baseCfg: AgentConfig = {
  space: "fbsmoke",
  name: "Otto",
  servers: "nats://127.0.0.1:4222",
  subscribe: ["general"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
  kind: "agent",
  tls: false,
  feedbackUrl: url,
};
const spec = (cfg: AgentConfig) => {
  const s = cotalToolSpecs(cfg, "smoke").find((t) => t.name === "cotal_feedback");
  assert.ok(s, "cotal_feedback spec exists");
  return s;
};
const args = { origin: "agent", type: "bug", summary: "it broke" };
delete process.env.COTAL_FEEDBACK_EMAIL;

try {
  // ---- keyed: Bearer header, no email needed ----
  const keyed = await spec({ ...baseCfg, feedbackKey: "fbk_test" }).run(null as never, baseCfg, args);
  check("keyed send succeeds", !keyed.isError, keyed.text);
  check("keyed result carries the id", keyed.text.includes("fb_1"), keyed.text);
  check("keyed request has Bearer header", hits[0]?.auth === "Bearer fbk_test", hits[0]?.auth);
  check("keyed request stamps source", hits[0]?.body.source === "smoke", hits[0]?.body);

  // ---- keyless: email in body, no auth header ----
  const keyless = await spec(baseCfg).run(null as never, baseCfg, { ...args, email: "dev@example.com" });
  check("keyless send succeeds", !keyless.isError, keyless.text);
  check("keyless request has no auth header", hits[1]?.auth === undefined, hits[1]?.auth);
  check("keyless request carries the email", hits[1]?.body.email === "dev@example.com", hits[1]?.body);

  // ---- keyless without any email source: refused before any request ----
  const before = hits.length;
  const gitless = { ...process.env, GIT_DIR: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const noEmail = await withEnv(gitless, () => spec(baseCfg).run(null as never, baseCfg, args));
  check("keyless without email is an error", noEmail.isError === true, noEmail.text);
  check("error asks for a contact email", /email/i.test(noEmail.text), noEmail.text);
  check("no request left without an email", hits.length === before);

  // ---- 400: server error surfaces ----
  nextStatus = 400;
  nextReply = { ok: false, error: "summary is required" };
  const rejected = await spec({ ...baseCfg, feedbackKey: "fbk_test" }).run(null as never, baseCfg, args);
  check("400 is an error result", rejected.isError === true, rejected.text);
  check("400 surfaces the server's error", rejected.text.includes("summary is required"), rejected.text);

  console.log(`\nfeedback smoke: ${pass} checks passed`);
  process.exit(0);
} finally {
  http.close();
}

/** Run fn with process.env temporarily replaced (git lookup must not see a real user.email). */
async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env;
  process.env = env;
  try {
    return await fn();
  } finally {
    process.env = prev;
  }
}
