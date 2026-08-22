/**
 * delivery reconnect-responder smoke (blocker 2). `serveControl(CONTROL_DELIVERY)` is bound via
 * `armPlane3`/`armDeliveryControl`, which runs on EVERY (re)connect — a reconnect drains the old
 * connection (the old sub dies, and `clearConnectionScoped` leaves caller-owned subs alone), so the
 * responder + the Plane-3 KV handles (`membersKv`/`aclKv`/`deliveryKv`) and the observer's derived
 * membership-feed handle (all cleared in `doRebuild`) must be re-bound/re-opened on the fresh connection.
 * Asserts: after reconnect, durable join/leave/list still work and the observer can watch membership.
 *
 * Run: pnpm smoke:delivery-reconnect:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid, serverConfig, newIdentity, setupSpaceStreams, principalKey, DEV_OWNER, membershipBucket, standaloneConnectOpts } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, t = 3000): Promise<void> =>
  new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode !== null) return resolve(); proc.once("exit", () => resolve()); setTimeout(resolve, t); });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `delivery-reconnect-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let mgr: CotalEndpoint | undefined, daemon: CotalEndpoint | undefined, agent: CotalEndpoint | undefined, observer: CotalEndpoint | undefined;
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
  await daemon.startPlane3((owner, lifecycleUid) => daemon!.aclForOwner(owner, lifecycleUid));

  // The dashboard/observer is the membership-feed reader in production. Use its real admin grant:
  // the delivery cred writes the feed but deliberately cannot create the ordered consumer a KV watch needs.
  observer = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "observer", role: "observer", kind: "observer" } });
  observer.on("error", () => {}); await observer.start();

  const aId = newIdentity();
  const uidA = mintLifecycleUid(); // alice's one lifecycle uid (SPEC §13.1)
  const aCreds = await provisionAgent(mgr, auth, aId, { allowSubscribe: ["review", "ops"], subscribe: ["review"], lifecycleUid: uidA });
  agent = new CotalEndpoint({ space, servers: SERVERS, creds: aCreds, channels: [], consume: false, lifecycleUid: uidA, watchPresence: false, registerPresence: false, card: { id: aId.id, name: "alice", kind: "agent" } });
  agent.on("error", () => {}); await agent.start();

  // Pre-reconnect: the responder works + the daemon holds a (ready) lease (so the deliveryKv reopen is
  // exercised post-reconnect).
  const leaseRev = await daemon.acquireDeliveryLease(0);
  await daemon.markDeliveryLeaseReady(0, leaseRev);
  const pre = await agent.durableJoinChannel("review");
  check("durableJoin works before reconnect", pre.durable === true);
  const reviewGen = pre.generation ?? 0;
  await observer.readMembership(); // open the membership-feed KV on the old connection before rebuilding
  const watchIntents = (observer as unknown as { membershipFeedWatches: Set<{ consumer?: import("@nats-io/jetstream").PushConsumer }> }).membershipFeedWatches;
  const consumerExists = async (consumer: import("@nats-io/jetstream").PushConsumer | undefined) => {
    if (!consumer) return false;
    try { await consumer.info(false); return true; }
    catch { return false; }
  };
  let membershipChanges = 0;
  const membershipWatch = await observer.watchMembership(() => { membershipChanges++; });
  await wait(200); // drain the watch's initial replay before measuring the post-reconnect write
  membershipChanges = 0;
  const membershipWatchIntent = [...watchIntents][0];
  const predecessorMembershipConsumer = membershipWatchIntent?.consumer;
  const predecessorMembershipConsumerName = (await predecessorMembershipConsumer?.info(true))?.name;
  check("the pre-reconnect membership watch owns a live broker consumer", await consumerExists(predecessorMembershipConsumer), predecessorMembershipConsumerName);

  // Force both roles to drain + rebuild. The daemon exercises its responder/Plane-3 handles; the
  // observer exercises the cached read-only membership-feed handle that triggered #800.
  await Promise.all([daemon.reconnect(), observer.reconnect()]);
  await wait(400);

  // Post-reconnect, ALL ctl.delivery ops + every Plane-3 KV handle must work on the fresh connection:
  // join (aclKv read + membersKv write), list (membersKv read), leave (membersKv tombstone), and the
  // lease read (deliveryKv) — the exact set the blocker covered (responder rebind + stale KV reopen).
  let postJoin: { durable: boolean } | undefined;
  try { postJoin = await agent.durableJoinChannel("ops"); } catch (e) { console.log(`    (post-reconnect join threw: ${(e as Error).message})`); }
  check("durableJoin works after reconnect (responder + aclKv + membersKv re-bound)", postJoin?.durable === true);

  const members = await daemon.ownerMemberships(principalKey(DEV_OWNER, aId.id).key, uidA);
  check("listMemberships works after reconnect (membersKv reopened)", members.some((m) => m.channel === "review") && members.some((m) => m.channel === "ops"));

  let leftOk = false;
  try { await agent.durableLeaveChannel("review", reviewGen); leftOk = true; } catch (e) { console.log(`    (post-reconnect leave threw: ${(e as Error).message})`); }
  check("durableLeave works after reconnect (membersKv tombstone)", leftOk);

  const lease = await daemon.readDeliveryLease(0);
  check("the delivery lease is still readable after reconnect (deliveryKv reopened)", lease?.ready === true);

  const membershipRwCreds = await mintCreds(auth, newIdentity(), "membership-rw");
  const membershipNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: membershipRwCreds, tls: false }) });
  try {
    const feed = await new Kvm(membershipNc).open(membershipBucket(space));
    await feed.put("reconnect-probe", JSON.stringify({ live: [], durable: [], observedAt: Date.now() }));
    for (let i = 0; i < 20 && membershipChanges === 0; i++) await wait(50);
  } finally {
    await membershipNc.drain();
  }
  check("the membership feed watch stays live across reconnect", membershipChanges > 0, { membershipChanges });
  const successorMembershipConsumer = membershipWatchIntent?.consumer;
  const successorMembershipConsumerName = (await successorMembershipConsumer?.info(true))?.name;
  check("reconnect creates a successor membership consumer", successorMembershipConsumer !== undefined && successorMembershipConsumer !== predecessorMembershipConsumer && await consumerExists(successorMembershipConsumer), { predecessorMembershipConsumerName, successorMembershipConsumerName });
  check("reconnect deletes the predecessor membership consumer instead of accumulating one", !(await consumerExists(predecessorMembershipConsumer)), predecessorMembershipConsumerName);
  membershipWatch.stop();
  for (let i = 0; i < 20 && await consumerExists(successorMembershipConsumer); i++) await wait(50);
  check("stopping the membership watch deletes its broker consumer", !(await consumerExists(successorMembershipConsumer)), successorMembershipConsumerName);

  console.log(`\nDELIVERY-RECONNECT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await agent?.stop(); } catch { /* ignore */ }
  try { await observer?.stop(); } catch { /* ignore */ }
  try { await daemon?.stop(); } catch { /* ignore */ }
  try { await mgr?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
