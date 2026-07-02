/**
 * delivery reconnect-responder smoke (blocker 2). `serveControl(CONTROL_DELIVERY)` is bound via
 * `armPlane3`/`armDeliveryControl`, which runs on EVERY (re)connect — a reconnect drains the old
 * connection (the old sub dies, and `clearConnectionScoped` leaves caller-owned subs alone), so the
 * responder + the Plane-3 KV handles (`membersKv`/`aclKv`/`deliveryKv`, cleared in `doRebuild`) must be
 * re-bound/re-opened on the fresh connection. Asserts: after the daemon endpoint reconnects, durable
 * join/leave/list still work (the responder survived and the KV reads/writes use the new connection).
 *
 * Run: pnpm smoke:delivery-reconnect:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
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
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `delivery-reconnect-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-reconnect-"));
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

  daemon = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {}); await daemon.start();
  await daemon.startPlane3((owner) => daemon!.aclForOwner(owner));

  const aId = newIdentity();
  const aCreds = await provisionAgent(mgr, auth, aId, { allowSubscribe: ["review", "ops"], subscribe: ["review"] });
  agent = new CotalEndpoint({ space, servers: SERVERS, creds: aCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { id: aId.id, name: "alice", kind: "agent" } });
  agent.on("error", () => {}); await agent.start();

  // Pre-reconnect: the responder works + the daemon holds a (ready) lease (so the deliveryKv reopen is
  // exercised post-reconnect).
  const leaseRev = await daemon.acquireDeliveryLease(0);
  await daemon.markDeliveryLeaseReady(0, leaseRev);
  const pre = await agent.durableJoinChannel("review");
  check("durableJoin works before reconnect", pre.durable === true);
  const reviewGen = pre.generation ?? 0;

  // Force the daemon endpoint to drain + rebuild its connection (drops the old ctl.delivery sub + KV handles).
  await daemon.reconnect();
  await wait(400);

  // Post-reconnect, ALL ctl.delivery ops + every Plane-3 KV handle must work on the fresh connection:
  // join (aclKv read + membersKv write), list (membersKv read), leave (membersKv tombstone), and the
  // lease read (deliveryKv) — the exact set the blocker covered (responder rebind + stale KV reopen).
  let postJoin: { durable: boolean } | undefined;
  try { postJoin = await agent.durableJoinChannel("ops"); } catch (e) { console.log(`    (post-reconnect join threw: ${(e as Error).message})`); }
  check("durableJoin works after reconnect (responder + aclKv + membersKv re-bound)", postJoin?.durable === true);

  const members = await daemon.ownerMemberships(aId.id);
  check("listMemberships works after reconnect (membersKv reopened)", members.some((m) => m.channel === "review") && members.some((m) => m.channel === "ops"));

  let leftOk = false;
  try { await agent.durableLeaveChannel("review", reviewGen); leftOk = true; } catch (e) { console.log(`    (post-reconnect leave threw: ${(e as Error).message})`); }
  check("durableLeave works after reconnect (membersKv tombstone)", leftOk);

  const lease = await daemon.readDeliveryLease(0);
  check("the delivery lease is still readable after reconnect (deliveryKv reopened)", lease?.ready === true);

  console.log(`\nDELIVERY-RECONNECT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
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
