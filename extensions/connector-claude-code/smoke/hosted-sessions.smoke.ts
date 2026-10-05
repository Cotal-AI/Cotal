/**
 * Two managed Claude Code sessions served from ONE process by `serveClaudeSession`, over a real
 * broker (no test runner, no `claude`).
 *
 * The hosted contract: each call is an independent session. It reads its identity only from the env
 * it is handed (never `process.env`), owns its own mesh endpoint, control socket and wake policy, and
 * pushes `claude/channel` notices only to its own output stream. A launch that cannot bind its
 * control socket REJECTS instead of exiting the process, so a host serving several sessions keeps
 * the others. Closing one session takes only that one off the mesh.
 *
 * Run: pnpm smoke:claude-hosted-sessions
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { serveClaudeSession, type ClaudeSession } from "../src/mcp.js";

async function freePort(): Promise<number> {
  const srv = createNetServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "cchosted";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const waitFor = async (what: string, cond: () => boolean, ms = 10_000): Promise<void> => {
  for (let i = 0; i < ms / 100 && !cond(); i++) await sleep(100);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

/** One fake Claude Code client: an MCP stream pair plus every JSON-RPC line the session wrote. */
function client(name: string, controlSocket = join(dir, `${name}.sock`)) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Array<Record<string, unknown>> = [];
  let buf = "";
  output.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  const env: NodeJS.ProcessEnv = {
    COTAL_SPACE: space,
    COTAL_NAME: name,
    COTAL_ID: name.toLowerCase(),
    COTAL_SERVERS: servers,
    COTAL_SUBSCRIBE: "general",
    COTAL_ALLOW_SUBSCRIBE: "general",
    COTAL_CHANNEL: "1",
    COTAL_CONTROL_SOCKET: controlSocket,
    COTAL_CONTROL_TOKEN: `token-${name}`,
  };
  const send = (msg: Record<string, unknown>) => input.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  return { name, env, input, output, lines, send };
}
const channelNotices = (c: ReturnType<typeof client>) =>
  c.lines.filter((l) => l.method === "notifications/claude/channel");

const observer = new CotalEndpoint({ space, servers, card: { name: "Olive", kind: "agent", id: "olive" }, channels: ["general"] });
observer.on("error", () => {});
const sessions: ClaudeSession[] = [];

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { general: { replay: false } } } });
  await observer.start();

  // A process-level env identity that must NOT leak into either hosted session.
  process.env.COTAL_NAME = "Leak";
  const a = client("Alpha");
  const b = client("Bravo");
  for (const c of [a, b]) {
    sessions.push(await serveClaudeSession({ env: c.env, input: c.input, output: c.output, log: () => {} }));
    c.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
    c.send({ method: "notifications/initialized" });
    c.send({ id: 2, method: "tools/list" });
  }
  check("each call names its session from its own env", sessions.map((s) => s.name).join() === "Alpha,Bravo");

  await waitFor("both hosted sessions on the roster", () =>
    ["Alpha", "Bravo"].every((n) => observer.getRoster().some((p) => p.card.name === n)),
  );
  check("the process env identity joined nobody", !observer.getRoster().some((p) => p.card.name === "Leak"));
  await waitFor("tools/list answered on both streams", () => [a, b].every((c) => c.lines.some((l) => l.id === 2 && l.result)));
  check("each session answered MCP on its own stream", [a, b].every((c) => c.lines.filter((l) => l.id === 2).length === 1));

  // ---- a DM to one session wakes only that session --------------------------------------------
  const alphaId = observer.getRoster().find((p) => p.card.name === "Alpha")!.card.id;
  await observer.unicast(alphaId, "for alpha only");
  await waitFor("Alpha's claude/channel notice", () => channelNotices(a).length > 0);
  await sleep(500);
  check("the DM woke the session it was addressed to", channelNotices(a).length >= 1, channelNotices(a));
  check("and pushed nothing to the other session's stream", channelNotices(b).length === 0, channelNotices(b));

  // ---- a launch that cannot bind its control socket rejects, the others stay up -----------------
  const bad = client("Charlie", join(dir, "no-such-dir", "c.sock"));
  let rejected: Error | undefined;
  try {
    sessions.push(await serveClaudeSession({ env: bad.env, input: bad.input, output: bad.output, log: () => {} }));
  } catch (e) {
    rejected = e as Error;
  }
  check("an unbindable control socket rejects the call instead of exiting", /control socket/.test(rejected?.message ?? ""), rejected?.message);
  await sleep(1000);
  check("and leaves no half-made session on the mesh", !observer.getRoster().some((p) => p.card.name === "Charlie" && p.status !== "offline"));

  // ---- closing one session leaves the other serving ------------------------------------------
  await sessions[0]!.close();
  await waitFor("Alpha to leave the mesh", () => observer.getRoster().find((p) => p.card.name === "Alpha")?.status === "offline" || !observer.getRoster().some((p) => p.card.name === "Alpha"));
  b.send({ id: 3, method: "tools/list" });
  await waitFor("Bravo still answering", () => b.lines.some((l) => l.id === 3 && l.result));
  check("closing one session leaves the other serving", true);
  await sessions[0]!.close();
  check("close() is idempotent", true);

  console.log(`\nhosted-sessions: ${pass} checks passed`);
} finally {
  for (const s of sessions) await s.close().catch(() => {});
  await observer.stop().catch(() => {});
  releaseBroker();
}
process.exit(0);
