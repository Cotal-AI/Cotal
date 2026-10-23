/**
 * `cotal feedback` against loopback stand-ins for an intake, with no broker: a connection that never
 * opened is reported as not sent, and a request that was written before the connection broke stays
 * unconfirmed. Run: pnpm smoke:feedback-command
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
let requests = 0;
const intake = createServer((req, res) => {
  requests++;
  req.resume();
  req.on("end", () => {
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
