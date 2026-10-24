/**
 * `cotal feedback` against loopback stand-ins for an intake, with no broker: each refusal names its
 * cause and a next step, a connection that never opened is reported as not sent, and a request that
 * was written before the connection broke stays unconfirmed. Run: pnpm smoke:feedback-command
 */
import { createServer } from "node:http";
import { createServer as createTcpServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { isCommandFailure, type CommandFailure } from "@cotal-ai/workspace";
import { feedback } from "../src/commands/feedback.js";

const { check, finish } = createSuite();
delete process.env.COTAL_FEEDBACK_KEY;
delete process.env.COTAL_FEEDBACK_URL;

const dir = mkdtempSync(join(tmpdir(), "cotal-feedback-command-"));
const keyFile = (key: string) => {
  const path = join(dir, `${key}.key`);
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return path;
};
const retryDate = new Date(Date.now() + 3_600_000).toUTCString();
let requests = 0;
const intake = createServer((req, res) => {
  requests++;
  req.resume();
  req.on("end", () => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const reply = (status: number, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify({ error: "echo-me-not" })); };
    if (req.method !== "POST" || path !== "/v1/feedback" || key === "no-endpoint") return reply(404);
    if (key === undefined || key === "wrong") return reply(401);
    if (key === "limited") return reply(429);
    if (key === "limited-seconds") return reply(429, { "retry-after": "37" });
    if (key === "limited-date") return reply(429, { "retry-after": retryDate });
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: "fb_1", published: true }));
  });
});
// Accepts the connection and resets it once the request arrives, so the request was written.
const resetter = createTcpServer((socket) => socket.once("data", () => socket.resetAndDestroy()));
const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const port = await listen(intake);
const resetPort = await listen(resetter);
const closed = createServer();
const closedPort = await listen(closed);
await new Promise<void>((resolve) => closed.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;

async function refusal(values: Record<string, string | boolean | undefined>): Promise<CommandFailure | undefined> {
  try { await feedback({ values: { json: true, ...values }, positionals: ["smoke summary"], raw: [] }); return undefined; }
  catch (error) { return isCommandFailure(error) ? error : undefined; }
}

try {
  const bad = await refusal({ "key-file": keyFile("wrong"), url: `${origin}/v1/feedback` });
  check("a refused key is AUTH_REQUIRED and names the key", bad?.code === "AUTH_REQUIRED" && /refused the feedback key/.test(bad.message) && /--key-file/.test(bad.remedy ?? ""), bad);
  check("the intake's response body is not echoed", !JSON.stringify(bad?.detail()).includes("echo-me-not"), bad?.detail());

  process.env.COTAL_FEEDBACK_KEY = "wrong";
  const configured = await refusal({ url: `${origin}/v1/feedback` });
  delete process.env.COTAL_FEEDBACK_KEY;
  check("a refused configured key names COTAL_FEEDBACK_KEY", configured?.code === "AUTH_REQUIRED" && /COTAL_FEEDBACK_KEY/.test(configured.remedy ?? ""), configured);

  const keyless = await refusal({ email: "tester@example.invalid", url: `${origin}/v1/feedback` });
  check("a keyed intake reached without a key says a key is required", keyless?.code === "AUTH_REQUIRED" && /requires a feedback key/.test(keyless.message) && /--key-file/.test(keyless.remedy ?? ""), keyless);

  const bare = await refusal({ "key-file": keyFile("good"), url: origin });
  check("a URL without the path is TARGET_NOT_FOUND and names /v1/feedback", bare?.code === "TARGET_NOT_FOUND" && bare.remedy === `set --url to ${origin}/v1/feedback, the path a Cotal intake serves`, bare);
  const noEndpoint = await refusal({ "key-file": keyFile("no-endpoint"), url: `${origin}/v1/feedback` });
  check("a 404 at /v1/feedback asks whether the origin runs an intake", noEndpoint?.code === "TARGET_NOT_FOUND" && noEndpoint.remedy === `check that ${origin} runs a Cotal feedback intake`, noEndpoint);

  const limited = await refusal({ "key-file": keyFile("limited"), url: `${origin}/v1/feedback` });
  check("a 429 without Retry-After says it is rate limited and gives a next step", limited?.code === "TARGET_UNAVAILABLE" && /rate limiting submissions and did not say for how long/.test(limited.message) && limited.remedy === "wait, then submit again", limited);
  const before = Date.now();
  const seconds = await refusal({ "key-file": keyFile("limited-seconds"), url: `${origin}/v1/feedback` });
  const until = Date.parse(/until (\S+),/.exec(seconds?.message ?? "")?.[1] ?? "");
  check("a 429 with Retry-After seconds names the retry time", seconds?.code === "TARGET_UNAVAILABLE" && until >= before + 36_000 && until <= Date.now() + 38_000 && /^submit again after /.test(seconds.remedy ?? ""), seconds);
  const dated = await refusal({ "key-file": keyFile("limited-date"), url: `${origin}/v1/feedback` });
  check("a 429 with a Retry-After date names that date", dated?.message.includes(new Date(retryDate).toISOString().replace(/\.\d{3}Z$/, "Z")) === true, dated);

  const seen = requests;
  const refused = await refusal({ "key-file": keyFile("good"), url: `http://127.0.0.1:${closedPort}/v1/feedback` });
  check("a refused connection is refused TARGET_UNAVAILABLE, not sent", refused?.outcome === "refused" && refused.code === "TARGET_UNAVAILABLE" && /was not sent/.test(refused.message) && refused.native?.code === "ECONNREFUSED", refused);
  const tls = await refusal({ "key-file": keyFile("good"), url: `https://127.0.0.1:${port}/v1/feedback` });
  check("a failed TLS handshake is refused TARGET_UNAVAILABLE and names HTTPS", tls?.outcome === "refused" && tls.code === "TARGET_UNAVAILABLE" && /serves HTTPS/.test(tls.remedy ?? ""), tls);
  check("neither unopened connection delivered a request", requests === seen, { requests, seen });

  const reset = await refusal({ "key-file": keyFile("good"), url: `http://127.0.0.1:${resetPort}/v1/feedback` });
  check("a connection that broke after the request was written stays unconfirmed", reset?.outcome === "unknown" && reset.code === "OPERATION_UNKNOWN" && /may have reached the intake/.test(reset.message), reset);

  const accepted = await refusal({ "key-file": keyFile("good"), url: `${origin}/v1/feedback` });
  check("a good key is still accepted", accepted === undefined, accepted);
} finally {
  intake.close();
  resetter.close();
  rmSync(dir, { recursive: true, force: true });
}
finish();
