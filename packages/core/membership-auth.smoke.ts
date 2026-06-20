/**
 * Auth-mode test for channelMembers() — proves the privilege boundary (no test runner).
 * Spins up its OWN JWT-auth nats-server (no external server needed) and verifies:
 *   - a privileged (manager) endpoint can read the live membership end-to-end;
 *   - the broker grant it rides — $JS.API.CONSUMER.LIST.CHAT_<space> — is held by manager
 *     only; observer/admin/agent are denied (so the view is manager-served today).
 * Run: pnpm smoke:membership:auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  chatStream,
} from "./src/index.js";

const PORT = 14223;
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

// Can this principal publish CONSUMER.LIST on the chat stream? (raw, no endpoint.)
async function canList(creds: string): Promise<boolean> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    maxReconnectAttempts: 0,
  });
  try {
    const jsm = await jetstreamManager(nc, { timeout: 3000 });
    await jsm.consumers.list(chatStream(space)).next(); // first page triggers the request
    return true;
  } catch {
    return false; // permission violation (or no responder) → denied
  } finally {
    await nc.drain().catch(() => {});
  }
}

const space = `mem-auth-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-memauth-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      up = true;
      break;
    }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // Privileged setup: manager creds create the streams + presence KV.
  const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // The dashboard: a manager-profile endpoint (watches presence, doesn't consume).
  const mgr = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: mgrCreds,
    card: { name: "mgr", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: true,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();

  // An agent: provision its bind-only durables, mint scoped creds, join #general.
  const agentId = newIdentity();
  const agentCreds = await provisionAgent(mgr, auth, agentId, { subscribe: ["general"], allowPublish: ["general"], role: "worker" });
  const agent = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: agentCreds,
    card: { name: "ag1", role: "worker", kind: "agent" },
    channels: ["general"],
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  agent.on("error", (e: Error) => console.error("  ! ag1", e.message));
  await agent.start();
  await wait(900);

  console.log("\n[AUTH] privileged read works end-to-end");
  const members = await mgr.channelMembers("general");
  check("manager channelMembers sees ag1 live", members.some((m) => m.name === "ag1" && m.live), members);
  check("agent id is the real cred identity", members.some((m) => m.id === agentId.id));

  console.log("\n[AUTH] the CONSUMER.LIST grant is manager-only");
  check("manager CAN list CHAT consumers", (await canList(mgrCreds)) === true);
  check("observer CANNOT list CHAT consumers", (await canList(await mintCreds(auth, newIdentity(), "observer"))) === false);
  check("admin CANNOT list CHAT consumers", (await canList(await mintCreds(auth, newIdentity(), "admin"))) === false);
  check("agent CANNOT list CHAT consumers", (await canList(await mintCreds(auth, newIdentity(), "agent", { allowSubscribe: ["general"] }))) === false);

  await agent.stop();
  await mgr.stop();
} catch (e) {
  fail++;
  console.error("  ✗ auth scenario threw:", (e as Error).message);
} finally {
  srv.kill("SIGKILL");
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  `\n${fail === 0 ? "AUTH MEMBERSHIP TESTS PASSED ✅" : "AUTH MEMBERSHIP TESTS FAILED ❌"}  (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
