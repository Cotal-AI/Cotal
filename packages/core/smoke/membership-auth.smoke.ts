/**
 * Auth-mode test for channelMembers() — proves the privilege boundary (no test runner).
 * Spins up its OWN JWT-auth nats-server (no external server needed) and verifies:
 *   - a privileged (delivery-cred) endpoint reads the live membership end-to-end (the provisioner
 *     onboards + the scoped `delivery` cred serves the read, post manager-least-privilege split);
 *   - the members-KV grant channelMembers() rides is held by the `delivery` profile only, and no
 *     profile can enumerate CHAT consumers (observer/admin/agent denied) — the view is delivery-served.
 * Run: pnpm smoke:membership:auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  membersBucket,
} from "../src/index.js";
import type { Identity } from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
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

// Can this principal READ the members-KV registry — the grant channelMembers() rides now the view is
// delivery-served? (raw; per-id inbox because scoped creds only sub `_INBOX_<id>.>`.) Mirrors
// listMembers' read: open the bucket + iterate keys (the ordered-consumer create is the ACL boundary).
async function canReadMembers(id: Identity, creds: string): Promise<boolean> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id.id}`,
    maxReconnectAttempts: 0,
  });
  try {
    const kv = await new Kvm(nc).open(membersBucket(space));
    for await (const _ of await kv.keys()) break; // first page triggers the read request
    return true;
  } catch {
    return false; // permission violation → denied
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
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // The onboarding authority: a provisioner-cred endpoint (the DurableProvisioner for provisionAgent).
  // It does NOT watch presence — the provisioner cred holds no presence-watch grant; the dashboard
  // membership read (roster + members-KV) rides the scoped `delivery` cred (`dlv`) below instead.
  const mgr = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: mgrCreds,
    card: { name: "mgr", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();
  // Plane-3 host = the server-side delivery daemon (scoped `delivery` cred), NOT the
  // manager — the manager cred no longer carries the Plane-3 inject grants (closure (i)).
  // The manager stays provisioner + publisher (its multicast posts chat AS the operator;
  // the daemon's fan-out reads CHAT and delivers). Only the HOST endpoint moves here.
  const dlvId = newIdentity();
  const dlv = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  dlv.on("error", (e: Error) => console.error("  ! dlv", e.message));
  await dlv.start();
  // Host Plane-3 so provisionAgent's boot membership write (durable-class boot channels → durable-active
  // records) lands — channelMembers reads that registry.
  const agentId = newIdentity();
  await dlv.startPlane3((id) => (id === agentId.id ? ["general"] : undefined));

  // An agent: provision its bind-only durables + boot membership, mint scoped creds, join #general.
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
  // channelMembers reads the members-KV registry + the presence roster — the scoped `delivery` cred
  // (`dlv`, watchPresence:true) holds both grants; the provisioner cred (`mgr`) holds neither.
  const members = await dlv.channelMembers("general");
  check("manager channelMembers sees ag1 live", members.some((m) => m.name === "ag1" && m.live), members);
  check("agent id is the real cred identity", members.some((m) => m.id === agentId.id));

  console.log("\n[AUTH] the membership read is capability-gated (delivery-served; others can't enumerate)");
  // The privileged membership read now rides the members-KV grant (channelMembers → the members
  // registry), held by the `delivery` profile only — NOT the former CONSUMER.LIST path, which the
  // manager-least-privilege split removed from every profile. Fresh `delivery` id for the raw probe.
  const memReaderId = newIdentity();
  check("delivery CAN read the members registry", (await canReadMembers(memReaderId, await mintCreds(auth, memReaderId, "delivery"))) === true);
  // Negatives must probe the SAME capability the view now rides (members-KV read), NOT the removed
  // CONSUMER.LIST path — else they're vacuously true (no profile can list) and a future regression handing
  // a non-privileged cred members-KV read would sail through green.
  const obsId = newIdentity(), admId = newIdentity(), agtId = newIdentity();
  check("observer CANNOT read the members registry", (await canReadMembers(obsId, await mintCreds(auth, obsId, "observer"))) === false);
  check("admin CANNOT read the members registry", (await canReadMembers(admId, await mintCreds(auth, admId, "admin"))) === false);
  check("agent CANNOT read the members registry", (await canReadMembers(agtId, await mintCreds(auth, agtId, "agent", { allowSubscribe: ["general"] }))) === false);

  await agent.stop();
  await dlv.stop();
  await mgr.stop();
} catch (e) {
  fail++;
  console.error("  ✗ auth scenario threw:", (e as Error).message);
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  `\n${fail === 0 ? "AUTH MEMBERSHIP TESTS PASSED ✅" : "AUTH MEMBERSHIP TESTS FAILED ❌"}  (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
