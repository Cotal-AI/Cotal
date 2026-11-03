/**
 * delivery reconnect-responder smoke (blocker 2). `serveControl(CONTROL_DELIVERY)` is bound via
 * `armPlane3`/`armDeliveryControl`, which runs on EVERY (re)connect — a reconnect drains the old
 * connection (the old sub dies, and `clearConnectionScoped` leaves caller-owned subs alone), so the
 * responder + the Plane-3 KV handles (`membersKv`/`aclKv`/`deliveryKv`) and the observer's derived
 * membership-feed handle must be re-bound/re-opened on the fresh connection. Old and stopped watches
 * must release their local subscription. Read-only consumers remain for native inactivity reclamation
 * without ungranted DELETE requests. Asserts these lifetimes beside durable join/leave/list checks.
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
import { CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid, serverConfig, newIdentity, setupSpaceStreams, principalKey, DEV_OWNER, membershipBucket, MEMBERSHIP_FEED_KEY, standaloneConnectOpts, dlvDurable, type MembershipChange } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const MON = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, t = 3000): Promise<void> =>
  new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode !== null) return resolve(); proc.once("exit", () => resolve()); setTimeout(resolve, t); });
const reconnected = (ep: CotalEndpoint): Promise<void> => new Promise((resolve) => {
  const onConnection = (state: { connected: boolean }) => { if (state.connected) { ep.off("connection", onConnection); resolve(); } };
  ep.on("connection", onConnection);
});
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `delivery-reconnect-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }) + `
http: "127.0.0.1:${MON}"
`);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let mgr: CotalEndpoint | undefined, daemon: CotalEndpoint | undefined, agent: CotalEndpoint | undefined, observer: CotalEndpoint | undefined, sup: CotalEndpoint | undefined;
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
  observer = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "observer", role: "observer", kind: "endpoint" } });
  observer.on("error", () => {}); await observer.start();

  const aId = newIdentity();
  const uidA = mintLifecycleUid(); // alice's one lifecycle uid (SPEC §13.1)
  const aCreds = await provisionAgent(mgr, auth, aId, { allowSubscribe: ["review", "ops"], subscribe: ["review"], lifecycleUid: uidA });
  agent = new CotalEndpoint({ space, servers: SERVERS, creds: aCreds, channels: [], consume: false, lifecycleUid: uidA, watchPresence: false, registerPresence: false, card: { id: aId.id, name: "alice", kind: "agent" } });
  agent.on("error", () => {}); await agent.start();

  // Pre-reconnect: the responder works + the daemon holds a (ready) lease (so the deliveryKv reopen is
  // exercised post-reconnect).
  const leaseRev = await daemon.acquireDeliveryLease(0);
  const readyLeaseRev = await daemon.markDeliveryLeaseReady(0, leaseRev);
  const pre = await agent.durableJoinChannel("review");
  check("durableJoin works before reconnect", pre.durable === true);
  const reviewGen = pre.generation ?? 0;
  await observer.readMembership(); // open the membership-feed KV on the old connection before rebuilding
  const membershipStream = `KV_${membershipBucket(space)}`;
  // PUSH-BOUND consumers only. The admin cred holds no consumer delete on this bucket (#691), so a
  // stopped or superseded watch leaves its unbound consumer to the broker's inactive threshold.
  const membershipConsumers = async (): Promise<string[]> => {
    const j = await (await fetch(`http://127.0.0.1:${MON}/jsz?consumers=true&streams=true&accounts=true`)).json() as
      { account_details?: { stream_detail?: { name: string; consumer_detail?: { name: string; push_bound?: boolean }[] }[] }[] };
    const out: string[] = [];
    for (const acc of j.account_details ?? []) for (const st of acc.stream_detail ?? [])
      if (st.name === membershipStream) for (const c of st.consumer_detail ?? []) if (c.push_bound) out.push(c.name);
    return out.sort();
  };
  let membershipChanges = 0;
  const membershipDelivered: MembershipChange[] = [];
  const membershipWatch = await observer.watchMembership((change) => { membershipChanges++; membershipDelivered.push(change); });
  await wait(200); // drain the watch's initial replay before measuring the post-reconnect write
  // #4904: the watch delivers the entries, not a bare tick, and the replay ends with one marker.
  check("the watch's initial replay ends with exactly one replayed marker", membershipDelivered.filter((c) => c.type === "replayed").length === 1, membershipDelivered);
  check("every replayed entry is marked update: false", membershipDelivered.every((c) => c.type === "replayed" || c.update === false), membershipDelivered);
  membershipChanges = 0;
  membershipDelivered.length = 0;
  const beforeMembershipConsumers = await membershipConsumers();
  check("the pre-reconnect membership watch owns exactly one live broker consumer", beforeMembershipConsumers.length === 1, beforeMembershipConsumers);
  const predecessorMembershipConsumerName = beforeMembershipConsumers[0];

  // A supervisor holding its manager liveness lease, so the lease KV handle is cached before the rebuild.
  // Its renew after the reconnect is the cell: the handle is bound to the connection, and a rebuild that
  // keeps it leaves every later renew and re-read timing out on a dead connection for good.
  sup = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "supervisor"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "sup", role: "manager", kind: "endpoint" } });
  sup.on("error", () => {}); await sup.start();
  const leaseInfo = { holder: sup.ref().id, instanceId: `iid-${randomUUID().slice(0, 8)}`, runtime: "pty", root: dir, pid: process.pid };
  const supRev = await sup.acquireManagerLease(leaseInfo);

  // Force the roles to drain + rebuild. The daemon exercises its responder/Plane-3 handles; the
  // observer exercises the cached read-only membership-feed handle that triggered #800; the
  // supervisor exercises the cached manager-lease handle.
  await Promise.all([daemon.reconnect(), observer.reconnect(), sup.reconnect()]);
  await wait(400);
  // The rearmed watch replays the bucket again before any new write: the feed is empty here, so the
  // replay is its marker alone, and it must not count as the write below arriving.
  const rearmReplay = membershipDelivered.splice(0);
  membershipChanges = 0;
  check("the rearmed watch replays the feed again: one replayed marker and nothing marked update: true", rearmReplay.filter((c) => c.type === "replayed").length === 1 && rearmReplay.every((c) => c.type === "replayed" || !c.update), rearmReplay);

  let renewedRev: number | undefined, renewErr: string | undefined;
  try { renewedRev = await sup.renewManagerLease(leaseInfo, supRev); } catch (e) { renewErr = (e as Error).message; }
  const reread = await sup.readOwnManagerLease(leaseInfo.instanceId).catch((e: Error) => e.message);
  check("the manager lease renews after reconnect (managerLeaseKv reopened on the fresh connection)", renewedRev !== undefined && renewedRev > supRev, { renewErr, supRev, renewedRev });
  check("and the manager lease reads back as its own after reconnect", typeof reread === "object" && reread?.revision === renewedRev, reread);

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
  let membershipReadOk = false;
  try { await observer.readMembership(); membershipReadOk = true; }
  catch (e) { console.log(`    (post-reconnect membership read threw: ${(e as Error).message})`); }
  check("the membership feed read re-opens on the fresh connection", membershipReadOk);

  const membershipRwCreds = await mintCreds(auth, newIdentity(), "membership-rw");
  const membershipNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: membershipRwCreds, tls: false }) });
  try {
    const feed = await new Kvm(membershipNc).open(membershipBucket(space));
    const probeObservedAt = Date.now();
    await feed.put("reconnect-probe", JSON.stringify({ live: ["ops"], durable: [], observedAt: probeObservedAt }));
    for (let i = 0; i < 20 && membershipChanges === 0; i++) await wait(50);
    check("the membership feed watch stays live across reconnect", membershipChanges > 0, { membershipChanges });
    // The write is delivered as a decoded member record; a heartbeat write arrives as its `asOf`, and
    // a delete as a member change with no record — the shapes a caller needs to keep its snapshot
    // current without re-reading the bucket (#4904).
    const probeChange = membershipDelivered.find((c) => c.type === "member" && c.id === "reconnect-probe");
    check("the post-reconnect write is delivered as a decoded member change", probeChange?.type === "member" && probeChange.operation === "PUT" && probeChange.update && probeChange.member?.observedAt === probeObservedAt && probeChange.member.live[0] === "ops" && probeChange.revision > 0, membershipDelivered);
    const seen = membershipDelivered.length;
    const heartbeatAt = Date.now();
    await feed.put(MEMBERSHIP_FEED_KEY, JSON.stringify({ observedAt: heartbeatAt }));
    await feed.delete("reconnect-probe");
    const later = () => membershipDelivered.slice(seen);
    const deletion = () => later().find((c) => c.type === "member" && c.id === "reconnect-probe");
    for (let i = 0; i < 40 && !deletion(); i++) await wait(50);
    const heartbeat = later().find((c) => c.type === "heartbeat");
    check("a heartbeat write is delivered as the feed's asOf, not as a member", heartbeat?.type === "heartbeat" && heartbeat.asOf === heartbeatAt && heartbeat.update, later());
    const deleted = deletion();
    check("a deleted member is delivered as a member change with no record", deleted?.type === "member" && deleted.operation === "DEL" && deleted.member === undefined && deleted.update === true, later());
  } finally {
    await membershipNc.drain();
  }
  const afterMembershipConsumers = await membershipConsumers();
  const successorMembershipConsumerName = afterMembershipConsumers.find((n) => n !== predecessorMembershipConsumerName);
  check("reconnect creates exactly one successor membership consumer", afterMembershipConsumers.length === 1 && successorMembershipConsumerName !== undefined, { predecessorMembershipConsumerName, afterMembershipConsumers });
  check("reconnect leaves no bound predecessor membership consumer", !afterMembershipConsumers.includes(predecessorMembershipConsumerName), { predecessorMembershipConsumerName, afterMembershipConsumers });
  await membershipWatch.stop();
  for (let i = 0; i < 20 && (await membershipConsumers()).length !== 0; i++) await wait(50);
  check("stopping the membership watch unbinds its broker consumer", (await membershipConsumers()).length === 0, await membershipConsumers());

  // Invoke the public stop while its broker consumer is live, then terminal-close that epoch.
  // Read-only cleanup must settle and unbind without attempting an ungranted delete on either epoch.
  const raceNc = (observer as unknown as { nc: import("@nats-io/transport-node").NatsConnection }).nc;
  const raceFeed = await new Kvm(raceNc).open(membershipBucket(space));
  const raceBucket = raceFeed as unknown as { js: { consumers: { getPushConsumer: (...a: unknown[]) => Promise<import("@nats-io/jetstream").PushConsumer> } } };
  const raceGet = raceBucket.js.consumers.getPushConsumer.bind(raceBucket.js.consumers);
  let raceConsumer: import("@nats-io/jetstream").PushConsumer | undefined;
  raceBucket.js.consumers.getPushConsumer = async (...args: unknown[]) => {
    raceConsumer = await raceGet(...args);
    return raceConsumer;
  };
  (observer as unknown as { membershipFeedKv: unknown }).membershipFeedKv = raceFeed;
  const raceHandle = await observer.watchMembership(() => {});
  // The broker marks the consumer push-bound only once it sees the subscribe, which can trail the watch.
  for (let i = 0; i < 20 && (await membershipConsumers()).length !== 1; i++) await wait(50);
  const raceConsumers = await membershipConsumers();
  check("the public stop/close race starts with one membership consumer", raceConsumers.length === 1 && raceConsumer !== undefined, raceConsumers);
  if (!raceConsumer) throw new Error("public stop/close race did not capture broker consumer creation");
  const raceDelete = raceConsumer.delete;
  let raceDeleteCalls = 0;
  raceConsumer.delete = function () { raceDeleteCalls++; return raceDelete.call(this); };
  const raceDeletePrefix = `$JS.API.CONSUMER.DELETE.${membershipStream}.`;
  const ncPrototype = Object.getPrototypeOf(raceNc) as typeof raceNc;
  const ncRequest = ncPrototype.request;
  const raceRequest = raceNc.request;
  let raceDeleteRequests = 0;
  // Existing connections already bind request; the prototype observes the fresh connection too.
  raceNc.request = function (this: typeof raceNc, ...args: Parameters<typeof raceRequest>) {
    if (args[0].startsWith(raceDeletePrefix)) raceDeleteRequests++;
    return raceRequest.apply(this, args);
  };
  ncPrototype.request = function (this: typeof raceNc, ...args: Parameters<typeof ncRequest>) {
    if (args[0].startsWith(raceDeletePrefix)) raceDeleteRequests++;
    return ncRequest.apply(this, args);
  };
  try {
    const raceStop = raceHandle.stop();
    void raceStop.catch(() => {});
    const raceHealed = reconnected(observer).then(() => true);
    void raceNc.close();
    await raceNc.closed();
    const raceStopSettled = await Promise.race([raceStop.then(() => true, () => false), wait(5000).then(() => false)]);
    // Observe fresh-epoch requests before restoring the spies or starting another watch.
    const raceReconnected = await Promise.race([raceHealed, wait(5000).then(() => false)]);
    for (let i = 0; i < 40 && (await membershipConsumers()).length !== 0; i++) await wait(50);
    check("public stop concurrent with terminal close resolves without ungranted deletes", raceStopSettled && raceReconnected && raceDeleteCalls === 0 && raceDeleteRequests === 0 && (await membershipConsumers()).length === 0, { raceStopSettled, raceReconnected, raceDeleteCalls, raceDeleteRequests, consumers: await membershipConsumers() });
  } finally {
    raceConsumer.delete = raceDelete;
    raceNc.request = raceRequest;
    ncPrototype.request = ncRequest;
  }

  const shutdownWatch = await observer.watchMembership(() => {});
  await wait(200);
  const shutdownConsumer = await membershipConsumers();
  check("the shutdown-order control starts with one membership consumer", shutdownConsumer.length === 1, shutdownConsumer);
  await shutdownWatch.stop();
  await observer.stop();
  for (let i = 0; i < 20 && (await membershipConsumers()).length !== 0; i++) await wait(50);
  check("awaited watch stop before endpoint stop unbinds the broker consumer", (await membershipConsumers()).length === 0, await membershipConsumers());

  // Permanent endpoint shutdown has no future cleanup epoch. If the broker connection is already
  // terminal, an outstanding public stop must not hang the process waiting for an impossible rebuild.
  observer = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "observer-broker-down", role: "observer", kind: "endpoint" } });
  observer.on("error", () => {}); await observer.start();
  const brokerDownWatch = await observer.watchMembership(() => {});
  await (observer as unknown as { nc: import("@nats-io/transport-node").NatsConnection }).nc.close();
  const brokerDownStop = brokerDownWatch.stop();
  void brokerDownStop.catch(() => {});
  const endpointStopped = await Promise.race([observer.stop().then(() => true), wait(2000).then(() => false)]);
  const brokerDownWatchStopped = await Promise.race([brokerDownStop.then(() => true, () => false), wait(1000).then(() => false)]);
  check("endpoint shutdown while broker is down settles the public membership stop", endpointStopped && brokerDownWatchStopped, { endpointStopped, brokerDownWatchStopped });
  // This terminal boundary leaves broker expiry to retire the unreachable consumer, which the bound-only
  // census no longer counts, so later cells grade their own ownership rather than this exception.
  for (let i = 0; i < 20 && (await membershipConsumers()).length !== 0; i++) await wait(50);
  check("the broker-down shutdown exception is isolated before later lifecycle cells", (await membershipConsumers()).length === 0, await membershipConsumers());

  // Restart a fresh observer for the terminal-close arm: endpoint stop is permanent by contract.
  observer = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "observer-2", role: "observer", kind: "endpoint" } });
  observer.on("error", () => {}); await observer.start();

  // Terminal self-heal starts after the old connection closes. The read-only predecessor becomes
  // unbound for native inactivity reclamation; the fresh connection must own one successor watch.
  let terminalChanges = 0;
  const terminalWatch = await observer.watchMembership(() => { terminalChanges++; });
  await wait(200);
  terminalChanges = 0;
  const terminalBefore = await membershipConsumers();
  check("the terminal-close control starts with one membership consumer", terminalBefore.length === 1, terminalBefore);
  const healed = reconnected(observer);
  await (observer as unknown as { nc: import("@nats-io/transport-node").NatsConnection }).nc.close();
  await Promise.race([healed, wait(5000)]);
  await wait(200);
  const terminalAfter = await membershipConsumers();
  check("terminal self-heal creates one successor and leaves no bound closed-epoch predecessor", terminalAfter.length === 1 && !terminalAfter.some((n) => terminalBefore.includes(n)), { terminalBefore, terminalAfter });
  const terminalNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: membershipRwCreds, tls: false }) });
  try {
    const feed = await new Kvm(terminalNc).open(membershipBucket(space));
    await feed.put("terminal-reconnect-probe", JSON.stringify({ live: [], durable: [], observedAt: Date.now() }));
    for (let i = 0; i < 20 && terminalChanges === 0; i++) await wait(50);
  } finally { await terminalNc.drain(); }
  check("the membership watch stays live after terminal self-heal", terminalChanges > 0, { terminalChanges });

  // A transient failed arm leaves a rejected promise in the per-watch queue. A later rebuild must
  // reset that rejection before appending cleanup/rearm work, or this watch is poisoned forever.
  const terminalIntent = [...(observer as unknown as { membershipFeedWatches: Set<{ arm: Promise<void> }> }).membershipFeedWatches][0];
  terminalIntent.arm = Promise.reject(new Error("transient membership arm failure"));
  void terminalIntent.arm.catch(() => {}); // handled, but intentionally still the rejected queue value
  let recoveredFromRejectedArm = false;
  try { await observer.reconnect(); recoveredFromRejectedArm = true; } catch { /* cell below names it */ }
  check("a later rebuild recovers a membership watch after a transient arm rejection", recoveredFromRejectedArm);

  // A watch iterator closed under a live connection must reach the caller through onClosed,
  // not just the generic endpoint error event.
  const closedReasons: string[] = [];
  const watchesBeforeClosedCell = new Set([...(observer as unknown as { membershipFeedWatches: Set<{ iter?: { stop(): void } }> }).membershipFeedWatches]);
  const closedWatch = await observer.watchMembership(() => {}, (err) => { closedReasons.push(err.message); });
  await wait(200);
  const closedWatchIntent = [...(observer as unknown as { membershipFeedWatches: Set<{ iter?: { stop(): void } }> }).membershipFeedWatches]
    .find((w) => !watchesBeforeClosedCell.has(w));
  closedWatchIntent?.iter?.stop();
  for (let i = 0; i < 40 && closedReasons.length === 0; i++) await wait(50);
  check("a watch iterator closed under a live connection reaches the caller's closed callback", JSON.stringify(closedReasons) === JSON.stringify(["membership watch closed"]), closedReasons);
  await closedWatch.stop();

  await terminalWatch.stop();

  const durable = dlvDurable(DEV_OWNER, aId.id, uidA);
  const probeDlvBind = async () => {
    const errors: Error[] = [];
    const warnings: Error[] = [];
    let messages = 0;
    const probe = new CotalEndpoint({ space, servers: SERVERS, creds: aCreds, channels: [], lifecycleUid: uidA, watchPresence: false, registerPresence: false, card: { id: aId.id, name: "alice-bind-probe", kind: "agent" } });
    probe.on("error", (e) => errors.push(e));
    probe.on("warning", (e) => warnings.push(e));
    probe.on("message", () => { messages++; });
    let startError: Error | undefined;
    try { await probe.start(); await wait(100); }
    catch (e) { startError = e as Error; }
    finally { try { await probe.stop(); } catch { /* isolate probe cleanup from the named bind cells */ } }
    return { errors, warnings, messages, startError };
  };

  const quiet = await probeDlvBind();
  check("a quiet delivery durable binds while the plane holds a ready lease without raising a warning", quiet.startError === undefined && quiet.errors.length === 0 && quiet.warnings.length === 0, quiet);
  check("the ready-lease control delivers no message on a genuinely quiet plane", quiet.messages === 0, quiet);

  await daemon.releaseDeliveryLease(0, readyLeaseRev);
  const missingLease = await probeDlvBind();
  const missingLeaseWarning = missingLease.warnings[0];
  check("a delivery durable binds and warns when the plane has no ready delivery lease", missingLease.startError === undefined && missingLease.errors.length === 0 && missingLease.warnings.length === 1, missingLease);
  check("the missing-lease warning names the durable, space, condition, and reconnect repair", missingLeaseWarning?.message.includes(durable) === true && missingLeaseWarning.message.includes(space) && missingLeaseWarning.message.includes("no ready delivery lease") && missingLeaseWarning.message.includes("reconnect against it"), missingLeaseWarning?.message);
  check("the warned missing-lease bind delivers no message", missingLease.messages === 0, missingLease);

  const notReadyRev = await daemon.acquireDeliveryLease(0);
  const notReadyLease = await probeDlvBind();
  const notReadyWarning = notReadyLease.warnings[0];
  check("a delivery durable binds and warns when the delivery lease is not ready", notReadyLease.startError === undefined && notReadyLease.errors.length === 0 && notReadyLease.warnings.length === 1, notReadyLease);
  check("the not-ready warning names the durable, space, condition, and reconnect repair", notReadyWarning?.message.includes(durable) === true && notReadyWarning.message.includes(space) && notReadyWarning.message.includes("no ready delivery lease") && notReadyWarning.message.includes("reconnect against it"), notReadyWarning?.message);
  check("the warned not-ready bind delivers no message", notReadyLease.messages === 0, notReadyLease);
  await daemon.releaseDeliveryLease(0, notReadyRev);

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
  try { await sup?.stop(); } catch { /* ignore */ }
  try { await mgr?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
