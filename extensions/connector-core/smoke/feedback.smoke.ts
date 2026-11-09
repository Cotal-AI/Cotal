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
import { cotalToolSpecs } from "../src/tool-specs.js";
import * as connectorCore from "../src/index.js";
import type { AgentConfig } from "../src/config.js";

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
let nextStatus = 202;
let nextReply: unknown = { ok: true, id: "fb_1", published: true };

const readRaw = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
};
const readBody = async (req: IncomingMessage) => JSON.parse((await readRaw(req)).toString("utf8")) as Record<string, unknown>;
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
  // ---- exported helper: the reusable library path must exist and preserve the tool's exact result ----
  const helperFailures: string[] = [];
  const submitFeedback = (connectorCore as unknown as {
    submitFeedback?: (input: Record<string, unknown>, options: { key?: string; url?: string; email?: string }) => Promise<{ text: string; isError?: boolean }>;
  }).submitFeedback;
  if (typeof submitFeedback !== "function") {
    helperFailures.push("submitFeedback is not exported from connector-core");
    helperFailures.push("the exported helper cannot preserve the keyed tool result because it is absent");
  } else {
    const helperResult = await submitFeedback({ ...args, source: "smoke" }, { key: "fbk_test", url });
    if (helperResult.text !== "Feedback sent (id fb_1). Thanks!" || helperResult.isError)
      helperFailures.push(`helper result drifted: ${JSON.stringify(helperResult)}`);
    if (hits[0]?.auth !== "Bearer fbk_test" || hits[0]?.body.source !== "smoke")
      helperFailures.push(`helper request drifted: ${JSON.stringify(hits[0])}`);
  }
  assert.deepEqual(helperFailures, [], `feedback helper acceptance cells red=${helperFailures.length}/2:\n${helperFailures.join("\n")}`);
  hits.splice(0);
  console.log("  ✓ feedback helper acceptance cells passed (2/2)");

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

  // ---- a 2xx that is not the documented receipt is unconfirmed, not sent ----
  nextStatus = 200;
  nextReply = "";
  const empty = await submitFeedback!({ ...args, source: "smoke" }, { key: "fbk_test", url });
  check("empty 200 is not a confirmed send", empty.isError === true && !/Feedback sent/.test(empty.text), empty.text);
  nextReply = "<html><body>not a receipt</body></html>";
  const html = await submitFeedback!({ ...args, source: "smoke" }, { key: "fbk_test", url });
  check("HTML 200 is not a confirmed send", html.isError === true && !/Feedback sent/.test(html.text), html.text);
  nextStatus = 200;
  nextReply = { ok: true, id: "not-a-receipt", published: true };
  const json200 = await submitFeedback!({ ...args, source: "smoke" }, { key: "fbk_test", url });
  check("JSON 200 with an id is not a confirmed send", json200.isError === true && !/not-a-receipt/.test(json200.text), json200.text);

  // ---- a redirect stays on the configured intake and is not retried ----
  const sinkHits: string[] = [];
  const sink = createServer(async (req, res) => {
    sinkHits.push((await readRaw(req)).toString("utf8"));
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: "from-sink", published: true }));
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/`;
  const source = createServer(async (req, res) => {
    await readRaw(req);
    res.writeHead(307, { location: sinkUrl });
    res.end();
  });
  await new Promise<void>((r) => source.listen(0, "127.0.0.1", r));
  const sourceUrl = `http://127.0.0.1:${(source.address() as { port: number }).port}/`;
  const redirected = await submitFeedback!({ ...args, source: "smoke" }, { key: "fbk_test", url: sourceUrl });
  check("a 307 is not a confirmed send", redirected.isError === true && !/from-sink/.test(redirected.text), redirected.text);
  check("a 307 does not deliver the body to the other origin", sinkHits.length === 0, sinkHits);
  sink.close();
  source.close();

  // ---- the documented 202 receipt, including a stored-but-unpublished record, is still a send ----
  nextStatus = 202;
  nextReply = { ok: true, id: "fb_stored", published: false };
  const unpublished = await submitFeedback!({ ...args, source: "smoke" }, { key: "fbk_test", url });
  check("202 with published false is still stored", !unpublished.isError && unpublished.text.includes("fb_stored") && unpublished.text.includes("publish failed"), unpublished.text);

  // ---- a body that fails after the headers is an unconfirmed result, not a throw ----
  const cut = createServer(async (req, res) => {
    await readRaw(req);
    res.writeHead(202, { "content-type": "application/json", "content-length": "1024" });
    res.flushHeaders();
    res.write('{"ok":true,');
    setTimeout(() => res.destroy(), 25);
  });
  await new Promise<void>((r) => cut.listen(0, "127.0.0.1", r));
  const cutUrl = `http://127.0.0.1:${(cut.address() as { port: number }).port}/`;
  const truncated = await submitFeedback!({ ...args, source: "smoke" }, { key: "fbk_test", url: cutUrl });
  check("a truncated body is an unconfirmed result", truncated.isError === true && /not retried/.test(truncated.text) && !/Feedback sent/.test(truncated.text), truncated.text);
  cut.close();

  nextStatus = 202;
  nextReply = { ok: true, id: "fixture-incomplete" };
  const missingPublished = await submitFeedback!({ ...args, source: "smoke" }, { key: "fbk_test", url });
  check("202 without published is not a confirmed send", missingPublished.isError === true && !/fixture-incomplete/.test(missingPublished.text), missingPublished.text);
  nextReply = { ok: true, id: " \n", published: true };
  const blankId = await submitFeedback!({ ...args, source: "smoke" }, { key: "fbk_test", url });
  check("202 with a whitespace id is not a confirmed send", blankId.isError === true && !/Feedback sent/.test(blankId.text), blankId.text);

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
