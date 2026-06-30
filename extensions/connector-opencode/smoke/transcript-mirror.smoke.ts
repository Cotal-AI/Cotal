/**
 * OpenCode transcript-mirror smoke (no test runner) — spins up its OWN nats-server, boots the plugin
 * with COTAL_TRANSCRIPT=1, fires real opencode bus events at its `event` hook, and asserts the
 * event-driven mirror publishes the agent's OWN assistant output to `tr-<name>` — end to end over a
 * real mesh (a separate CotalEndpoint subscribes to the transcript channel and reads what lands).
 *
 * No model and no `opencode` binary: the mirror is fed purely by message.updated / message.part.updated
 * / session.idle events (the same in-process stream the plugin gets from `opencode serve`), so the
 * test drives those directly. Covers: assistant text + tool one-liners are mirrored on idle; injected
 * (user-role) turns are NOT mirrored; a duplicate session.idle does not republish; and `/new` session
 * adoption resets the buffer so a half-finished turn never leaks into the next session.
 * Run: pnpm smoke:opencode-transcript
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import type { CotalMessage, Delivery } from "@cotal-ai/core";
import { transcriptChannel } from "@cotal-ai/connector-core";
import { cotal } from "../src/plugin.js";

async function freePort(): Promise<number> {
  const srv = createNetServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "octr";
const SID = "ses_tr";
const NAME = "Otto";
const CHAN = transcriptChannel(NAME); // "tr-otto" — the shared connector-core convention
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "cotal-octr-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// A fake OpenCode HTTP server: the plugin creates its session at boot; the mirror itself is
// event-driven and never calls back, so /session is all that's needed (prompt_async is humoured).
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/session")
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: SID }));
    if (req.method === "POST" && req.url === `/session/${SID}/prompt_async`) return void res.writeHead(204).end();
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const ocPort = (oc.address() as { port: number }).port;

// The plugin reads identity from COTAL_* env. Scrub any inherited managed-agent env first.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
Object.assign(process.env, {
  COTAL_NAME: NAME,
  COTAL_ID: "otto",
  COTAL_SPACE: space,
  COTAL_SERVERS: servers,
  COTAL_ROLE: "generalist",
  COTAL_TRANSCRIPT: "1", // arm the mirror
  COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${ocPort}`,
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "test-secret",
});

type Hooks = Awaited<ReturnType<typeof cotal>>;
const fire = (hooks: Hooks, event: unknown) => hooks.event!({ event } as never);
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

// A separate peer subscribes to the transcript channel and records every line that lands there.
const sub = new CotalEndpoint({ space, servers, card: { name: "Watcher", kind: "agent", id: "watcher" }, channels: [CHAN] });
sub.on("error", () => {});
const got: string[] = [];
sub.on("message", (m: CotalMessage, d: Delivery) => {
  if (m.channel === CHAN) got.push(textOf(m));
  d.ack();
});
const waitForGot = async (n: number, ms = 4000): Promise<void> => {
  for (let i = 0; i < ms / 100 && got.length < n; i++) await sleep(100);
};
const someGot = (needle: string) => got.some((g) => g.includes(needle));

let hooks: Hooks | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { [CHAN]: { replay: false } } } });
  await sub.start();

  hooks = await cotal();
  for (let i = 0; i < 50; i++) { if (sub.getRoster().some((p) => p.card.name === NAME)) break; await sleep(100); }
  check(`the opencode plugin came online (${NAME} live in the watcher roster)`, sub.getRoster().some((p) => p.card.name === NAME));

  // (1) an assistant turn's text + tool parts are mirrored to tr-<name> on session.idle. Retry the turn
  //     until it lands: the agent connects in the BACKGROUND, so its presence can appear a beat before
  //     it can publish, and the mirror drops (by design) a turn it cannot send. Re-firing is idempotent
  //     (record/observe replace by key; idle rebuilds + flushes), so this just waits out the connect.
  for (let attempt = 0; attempt < 20 && got.length === 0; attempt++) {
    await fire(hooks, { type: "message.updated", properties: { info: { id: "m1", sessionID: SID, role: "assistant" } } });
    await fire(hooks, { type: "message.part.updated", properties: { part: { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Did the thing." } } });
    await fire(hooks, { type: "message.part.updated", properties: { part: { id: "p2", sessionID: SID, messageID: "m1", type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls -la" }, output: "a\nb" } } } });
    await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
    await waitForGot(1, 1000);
  }
  check("assistant text is mirrored to tr-<name>", someGot("Did the thing."), got);
  check("tool call is mirrored as a one-liner", someGot("⚒ bash: ls -la"), got);
  check("tool output is mirrored (truncated)", someGot("→ a"), got);
  const afterTurn1 = got.length;

  // (2) a duplicate / late session.idle must NOT republish (flush snapshots+clears the buffer).
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
  await sleep(400);
  check("a duplicate session.idle does not republish", got.length === afterTurn1, got);

  // (3) an injected (user-role) turn is NOT mirrored — only the agent's OWN output is.
  await fire(hooks, { type: "message.updated", properties: { info: { id: "mU", sessionID: SID, role: "user" } } });
  await fire(hooks, { type: "message.part.updated", properties: { part: { id: "pU", sessionID: SID, messageID: "mU", type: "text", text: "INJECTED-PEER-TURN" } } });
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
  await sleep(400);
  check("injected user-role turns are not mirrored", !someGot("INJECTED-PEER-TURN") && got.length === afterTurn1, got);

  // (4) `/new` session adoption resets the mirror — a half-buffered turn never leaks into the next session.
  await fire(hooks, { type: "message.updated", properties: { info: { id: "m4", sessionID: SID, role: "assistant" } } });
  await fire(hooks, { type: "message.part.updated", properties: { part: { id: "p4", sessionID: SID, messageID: "m4", type: "text", text: "DROP-ON-RESET" } } });
  await fire(hooks, { type: "session.created", properties: { info: { id: "ses_new" } } }); // top-level (no parentID) → adopt + reset
  await fire(hooks, { type: "session.idle", properties: { sessionID: "ses_new" } });
  await sleep(400);
  check("session adoption (/new) drops the buffered partial turn", !someGot("DROP-ON-RESET"), got);

  // (5) long assistant text (> MAX_CHUNK) is mirrored IN FULL, split across messages — not truncated.
  const beforeBig = got.length;
  const big = `BIG-START-${"x".repeat(9000)}-BIG-END`; // ~9018 chars, one line → must split into ≥2 chunks
  await fire(hooks, { type: "message.updated", properties: { info: { id: "m5", sessionID: "ses_new", role: "assistant" } } });
  await fire(hooks, { type: "message.part.updated", properties: { part: { id: "p5", sessionID: "ses_new", messageID: "m5", type: "text", text: big } } });
  await fire(hooks, { type: "session.idle", properties: { sessionID: "ses_new" } });
  await waitForGot(beforeBig + 2);
  const bigJoined = got.slice(beforeBig).join("");
  check("long assistant text is chunked, not truncated", got.length >= beforeBig + 2 && bigJoined.includes("BIG-START-") && bigJoined.includes("-BIG-END"), { chunks: got.length - beforeBig });

  // (6) two assistant messages in one turn that reuse the same part id are both kept (keyed by msg+part).
  await fire(hooks, { type: "message.updated", properties: { info: { id: "mA", sessionID: "ses_new", role: "assistant" } } });
  await fire(hooks, { type: "message.updated", properties: { info: { id: "mB", sessionID: "ses_new", role: "assistant" } } });
  await fire(hooks, { type: "message.part.updated", properties: { part: { id: "text", sessionID: "ses_new", messageID: "mA", type: "text", text: "FROM-MSG-A" } } });
  await fire(hooks, { type: "message.part.updated", properties: { part: { id: "text", sessionID: "ses_new", messageID: "mB", type: "text", text: "FROM-MSG-B" } } });
  await fire(hooks, { type: "session.idle", properties: { sessionID: "ses_new" } });
  await sleep(400);
  check("same part id across two messages does not collide", someGot("FROM-MSG-A") && someGot("FROM-MSG-B"), got);

  console.log(`\nOPENCODE TRANSCRIPT-MIRROR SMOKE OK ✅  (${pass} passed, 0 failed)`);
} finally {
  await hooks?.dispose?.();
  await sub.stop();
  srv.kill("SIGKILL");
  oc.close();
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
