/**
 * OpenCode idle-activity regression test (no test runner) — spins up its OWN nats-server and drives
 * the REAL plugin with a fake OpenCode HTTP server + real opencode bus events, reading the RAW
 * presence KV record (what a dashboard/CLI wire consumer sees). It guards the stale-activity half of
 * issue #286: `session.status: retry` publishes `retrying: <message>` as presence activity, but the
 * idle transitions used to call `setStatus("idle")` bare — which leaves the previous activity
 * untouched — so a transient "retrying: Rate limit exceeded…" survived into `○ idle` (and, once the
 * agent died, into its retained offline record) indefinitely. Every idle transition must CLEAR the
 * retained activity on the wire:
 *   1. session.status retry publishes the retry text as activity (precondition);
 *   2. session.status idle clears it;
 *   3. session.idle (the turn-end site) clears it;
 *   4. session.error recovery (which lands presence on idle) clears it;
 *   5. adopting a replacement session (`/new`) clears it — the replaced session's own events no
 *      longer pass ours(), so nothing else ever could, and the heartbeat would republish the
 *      stale text (fresh ts) forever.
 * Run: pnpm smoke:opencode-idle-activity
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { isReachable, presenceBucket, principalKey, DEV_OWNER, type Presence } from "@cotal-ai/core";
import { cotal } from "../src/plugin.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "ocidleact";
const id = "otto_idleact";
const SID = "ses_idleact";
const RETRY_MSG = "Rate limit exceeded, retrying in 27 seconds (attempt 5)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const dir = mkdtempSync(join(tmpdir(), "cotal-ocidleact-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// A fake OpenCode HTTP server: hand the plugin its session id (the plugin drives no turns here).
let sessionCreated = false;
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "POST" && req.url === "/session") {
    sessionCreated = true;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: SID }));
    return;
  }
  if (req.method === "POST" && req.url === `/session/${SID}/prompt_async`) {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(404).end();
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const ocPort = (oc.address() as { port: number }).port;

// The plugin reads its identity from COTAL_* env (it runs inside the opencode process). Scrub any
// managed-agent env inherited by this smoke itself; stale creds/links would point at the wrong broker.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
Object.assign(process.env, {
  COTAL_NAME: "Otto",
  COTAL_ID: id,
  COTAL_SPACE: space,
  COTAL_SERVERS: servers,
  COTAL_SUBSCRIBE: "team",
  COTAL_ROLE: "generalist",
  COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${ocPort}`,
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "test-secret",
});

// Fire one opencode bus event at the plugin's `event` hook.
type Hooks = Awaited<ReturnType<typeof cotal>>;
const fire = (hooks: Hooks, event: unknown) => hooks.event!({ event } as never);

let hooks: Hooks | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  // Boot the plugin (it connects its mesh agent in the background and creates session SID).
  hooks = await cotal();
  for (let i = 0; i < 100 && !sessionCreated; i++) await sleep(100);
  check("the plugin booted and owns its opencode session", sessionCreated);

  // A direct wire consumer of the presence KV (like a dashboard/CLI), bypassing observer-side
  // materialization. Presence is keyed by the PRINCIPAL dot-form (`local.<id>` in dev mode).
  nc = await connect({ servers });
  const kv = await new Kvm(nc).open(presenceBucket(space));
  const read = async (): Promise<Presence | undefined> => (await kv.get(principalKey(DEV_OWNER, id).key))?.json<Presence>();
  const readUntil = async (cond: (p: Presence | undefined) => boolean, ms = 5000): Promise<Presence | undefined> => {
    let p: Presence | undefined;
    for (let i = 0; i < ms / 100; i++) {
      p = await read();
      if (cond(p)) return p;
      await sleep(100);
    }
    return p;
  };
  check("the plugin's presence record landed in the KV", (await readUntil((p) => p !== undefined)) !== undefined);

  // (1) a provider retry publishes its message as activity — the exact record issue #286 shows.
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "retry", message: RETRY_MSG } } });
  const retrying = await readUntil((p) => p?.activity === `retrying: ${RETRY_MSG}`);
  check("a retry publishes its message as presence activity (wire)", retrying?.status === "working" && retrying?.activity === `retrying: ${RETRY_MSG}`, retrying);

  // (2) session.status idle → the retry text must not survive into idle on the wire.
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "idle" } } });
  const idled = await readUntil((p) => p?.status === "idle" && !p.activity);
  check("session.status idle clears the stale retry activity on the wire", idled?.status === "idle" && !idled?.activity, idled);

  // (3) same guard for session.idle — the turn-end site.
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "retry", message: RETRY_MSG } } });
  check("retry re-arms activity", (await readUntil((p) => p?.activity === `retrying: ${RETRY_MSG}`))?.activity === `retrying: ${RETRY_MSG}`);
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
  const turnEnded = await readUntil((p) => p?.status === "idle" && !p.activity);
  check("session.idle (turn end) clears the stale retry activity on the wire", turnEnded?.status === "idle" && !turnEnded?.activity, turnEnded);

  // (4) same guard for session.error recovery — the failed-turn path lands presence on idle.
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "retry", message: RETRY_MSG } } });
  check("retry re-arms activity before the error", (await readUntil((p) => p?.activity === `retrying: ${RETRY_MSG}`))?.activity === `retrying: ${RETRY_MSG}`);
  await fire(hooks, { type: "session.error", properties: { sessionID: SID } });
  const recovered = await readUntil((p) => p?.status === "idle" && !p.activity);
  check("session.error recovery clears the stale retry activity on the wire", recovered?.status === "idle" && !recovered?.activity, recovered);

  // (5) session replacement (`/new`) — adoptSession must clear the replaced session's presence.
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "retry", message: RETRY_MSG } } });
  check("retry re-arms activity before the replacement", (await readUntil((p) => p?.activity === `retrying: ${RETRY_MSG}`))?.activity === `retrying: ${RETRY_MSG}`);
  await fire(hooks, { type: "session.created", properties: { info: { id: "ses_idleact2" } } }); // top-level: no parentID
  const adopted = await readUntil((p) => p?.status === "idle" && !p.activity);
  check("adopting a replacement session clears the stale activity on the wire", adopted?.status === "idle" && !adopted?.activity, adopted);

  console.log(`\nPRESENCE IDLE-ACTIVITY TEST PASSED ✅  (${pass} checks)`);
} finally {
  await hooks?.dispose?.();
  await nc?.close();
  srv.kill("SIGKILL");
  oc.close();
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
