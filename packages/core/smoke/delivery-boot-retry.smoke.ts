/**
 * delivery boot self-join retry/reconcile smoke (blocker 4 — the honesty + recovery guard). If the
 * delivery daemon is DOWN when an agent first connects, the boot durable self-join must NOT silently
 * degrade to live-only forever: it keeps pending intent, the health surface reports degraded (lease/owner
 * membership absent → NOT "active"), and `reconcileBootJoin` retries until the membership lands once the
 * daemon recovers. Asserts: agent first-connects with NO daemon → no durable membership (degraded) → the
 * daemon starts → the membership APPEARS (health transitions to active) without restarting the agent.
 *
 * Run: pnpm smoke:delivery-boot-retry:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, serverConfig, newIdentity, setupSpaceStreams } from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, t = 3000): Promise<void> =>
  new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode !== null) return resolve(); proc.once("exit", () => resolve()); setTimeout(resolve, t); });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `delivery-boot-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-boot-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

let mgr: CotalEndpoint | undefined, daemon: CotalEndpoint | undefined, agent: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  mgr.on("error", () => {}); await mgr.start();

  // Provision an agent for boot durable channel "review" (durable-class by default) — ACL written.
  const aId = newIdentity();
  const aCreds = await provisionAgent(mgr, auth, aId, { allowSubscribe: ["review"], subscribe: ["review"] });

  // Agent connects with NO delivery daemon running → boot self-join hits NoResponders → reconcile pending.
  agent = new CotalEndpoint({ space, servers: SERVERS, creds: aCreds, channels: ["review"], watchPresence: false, registerPresence: false, card: { id: aId.id, name: "alice", kind: "agent" } });
  agent.on("error", () => {}); await agent.start();
  await wait(500);
  check("with no daemon at first connect, the boot channel has NO durable membership (degraded)", agent.hasDurableMembership("review") === false);

  // Now bring the delivery daemon up. reconcileBootJoin retries (capped backoff) and should establish it.
  daemon = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {}); await daemon.start();
  await daemon.startPlane3((owner) => daemon!.aclForOwner(owner));

  // Wait for the reconcile loop's backoff tick(s) to land the membership (first retry ~1s, then 2s, 4s…).
  let established = false;
  for (let i = 0; i < 20; i++) {
    if (agent.hasDurableMembership("review")) { established = true; break; }
    await wait(500);
  }
  check("after the daemon recovers, reconcileBootJoin establishes the membership (health → active)", established);

  console.log(`\nDELIVERY-BOOT-RETRY SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await agent?.stop(); } catch { /* ignore */ }
  try { await daemon?.stop(); } catch { /* ignore */ }
  try { await mgr?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
