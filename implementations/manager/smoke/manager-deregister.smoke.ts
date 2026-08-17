/**
 * MANAGER DEREGISTRATION smoke — the full lifecycle of a registration, including its END.
 *
 * THE STATE THIS EXISTS FOR, reproduced here rather than described: a manager whose host dies leaves
 * a `svc` record claiming a live instance, forever. Every later class scatter freezes that slot in
 * and pays its whole deadline waiting for it. On the laptop this change came from, one such record
 * made `cotal ps` take 12.5 seconds and print a row that said "unreachable" about a machine that had
 * been switched off for good.
 *
 * THIS SUITE FABRICATES ITS OWN CORPSE and never consults a real mesh. A second manager is started
 * and its serve connection is closed under it — the crash shape exactly: connections drop, nothing
 * is written, the registration survives. A test that leaned on whatever happens to be registered on
 * the machine running it would pass or fail for reasons that have nothing to do with the code.
 *
 * THE TWO EXITS, both proven end to end:
 *  - the instance that CAN cooperate removes its own record on a clean stop;
 *  - the one that cannot is removed by an operator naming it, behind a guard that refuses a live
 *    instance.
 *
 * AND THE RECOVERY, which is what makes either safe to do: the same instance registers AND converges
 * again on its next start, over both tombstones. Without those two cells this suite would pass while
 * shipping a manager that can be stopped once and never started again — the first draft did exactly
 * that on the status key, and section 2 is what caught it.
 *
 * THE COUNT WAS PREDICTED AT 16 AND IS 28. Recorded rather than re-cut backwards. Five of the first
 * seven came from the fixture refusing to build without them: the open-mesh restart pair (an
 * auth-mesh restart needs the delivery daemon as its eviction oracle, which is not what this suite
 * is about), the credential-boundary pair (the scatter's own credential turned out to be unable to
 * delete, which is the right answer and is now an assertion rather than an assumption), and the
 * recovery cell on the status key. The next two came from the mutation pass: section 9 established
 * the unestablishable verdict from a HAND-BUILT probe result, so nothing tested how the real probe
 * classifies a refusal, and a probe whose publishes are refused going quiet is precisely the input
 * that would delete a live manager's record. Section 10 produces that refusal for real.
 *
 * THE LAST FIVE ARE SECTION 12, and they came from review rather than from the fixture. The guard
 * as first written passed on "asked, and nothing came back" — and silence is what a dead host, a
 * WEDGED process and a slow one all look like. A reviewer produced an unanswered describe against a
 * manager that was up, and the verb deleted a LIVE registration. The guard now removes a record
 * only on the broker affirming nothing is subscribed on that instance's rail, section 12 is the
 * hung shape built for real, and its last cell is the positive control that the corpse this whole
 * change exists for still deletes. Every claim in the original 16 is still asserted.
 *
 * Run: pnpm smoke:manager-deregister   (needs nats-server + node on PATH; boots its own JWT broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER, recordsBucket,
  freezeExpectedSet, resolveService, scatterCommand, epProbeInstanceInterest,
  instancePinnedInstrumentCapabilities, spacePrefix, endpointToken,
  type EpCaller,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { InstanceDeregisterRefused, deregisterEndpointInstance, makeInstanceProbe, type InstanceProbe } from "../src/deregister-instance.js";

const EXPECTED_CELLS = 28;

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SPACE = `mgrdereg-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(SPACE);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const mkRoot = (tag: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(r), auth);
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));

type MgrPriv = { managerInstanceId: string; serviceServe?: { nc: NatsConnection } };
const kids: ReturnType<typeof spawn>[] = [];
let releaseBroker: (() => void) | undefined;
let live: InstanceType<typeof Manager> | undefined;
let corpse: InstanceType<typeof Manager> | undefined;
let nc: NatsConnection | undefined;
try {
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  kids.push(srv);
  releaseBroker = teardownOnSignal(srv, dir);
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const rootFirst = mkRoot("first"), rootLive = mkRoot("live"), rootCorpse = mkRoot("corpse");
  for (const r of [rootFirst, rootLive, rootCorpse]) recordMesh({ space: SPACE, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });

  // An observer connection with the freeze read and, later, the pinned instance rails. Minted once
  // the ids are known, so it holds exact-iid rows and no wildcard instance row anywhere.
  const openObserver = async (pins: string[]): Promise<{ nc: NatsConnection; caller: EpCaller }> => {
    const id = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await mintCreds(auth, id, "control-caller-privileged", {
      lifecycleUid: uid,
      ...(pins.length ? { endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", pins) } : {}),
    });
    return {
      nc: await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 }),
      caller: { owner: DEV_OWNER, actor: id.id, uid },
    };
  };
  const frozenIds = async (): Promise<string[]> => {
    const jsm = await jetstreamManager(nc!, { checkAPI: false });
    return (await freezeExpectedSet(jsm, SPACE, MANAGER_ENDPOINT)).map((f) => f.instanceId).sort();
  };

  console.log("1. a clean stop DEREGISTERS: the one instance that knows it is going away says so");
  let first: InstanceType<typeof Manager> | undefined = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: rootFirst });
  await first.start();
  const IID_FIRST = (first as unknown as MgrPriv).managerInstanceId;
  ({ nc } = await openObserver([]));
  check("the started manager is a live class member", (await frozenIds()).includes(IID_FIRST), IID_FIRST);
  await first.stop();
  first = undefined;
  check("after a clean stop its registration is GONE, so no later scatter can freeze it in",
    !(await frozenIds().catch(() => [] as string[])).includes(IID_FIRST), IID_FIRST);

  console.log("2. and it can come back: the same instance re-registers AND re-converges over both tombstones");
  // THE RECOVERY PATH. A deregistration that could not be undone would turn every clean stop into a
  // one-way door, and the §13.5 delete removes BOTH keys — so both writes have to survive their own
  // tombstone, not just the spec. The first draft fixed only the spec and this section is what
  // caught it: the manager registered again and could never converge.
  //
  // ON AN OPEN MESH, deliberately, and the reason is not this change. A manager restart on an AUTH
  // mesh must verify-evict its superseded serve family before the epoch advances (§13.1), which
  // needs the delivery daemon as its liveness oracle — a pre-existing condition of EVERY auth-mesh
  // restart, deregistered or not, and nothing a records tombstone affects. Booting a delivery daemon
  // to reach the tombstone question would test the oracle, not the record. So the restart is proven
  // where the record is the only variable, and the auth mesh above proves the deregistration itself.
  const OPEN_PORT = await freePort();
  const OPEN_SERVERS = `nats://127.0.0.1:${OPEN_PORT}`;
  const openSd = join(dir, "open-js");
  const openSrv = spawn("nats-server", ["-js", "-sd", openSd, "-p", String(OPEN_PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
  kids.push(openSrv);
  let openUp = false;
  for (let i = 0; i < 60 && !openUp; i++) { openUp = await isReachable(OPEN_SERVERS); if (!openUp) await wait(200); }
  if (!openUp) throw new Error(`open nats-server did not come up on ${OPEN_PORT}`);
  const openRoot = mkRoot("open");
  const openSpace = `${SPACE}-open`;
  rmSync(join(openRoot, ".cotal", "auth"), { recursive: true, force: true }); // an OPEN mesh has no space auth
  recordMesh({ space: openSpace, server: OPEN_SERVERS, root: openRoot, mode: "open", ts: new Date().toISOString() });
  const openNc = await connect({ servers: OPEN_SERVERS, maxReconnectAttempts: 0 });
  const openFrozen = async (): Promise<string[]> =>
    (await freezeExpectedSet(await jetstreamManager(openNc, { checkAPI: false }), openSpace, MANAGER_ENDPOINT)).map((f) => f.instanceId);
  let openMgr: InstanceType<typeof Manager> | undefined = new Manager({ space: openSpace, servers: OPEN_SERVERS, runtime: "pty", workspaceRoot: openRoot });
  await openMgr.start();
  const IID_OPEN = (openMgr as unknown as MgrPriv).managerInstanceId;
  await openMgr.stop();
  const goneOpen = await openFrozen().then((ids) => ids.includes(IID_OPEN)).catch(() => false);
  check("an open-mesh manager deregisters on its clean stop too (the same route, no credential system)", !goneOpen, IID_OPEN);
  openMgr = new Manager({ space: openSpace, servers: OPEN_SERVERS, runtime: "pty", workspaceRoot: openRoot });
  await openMgr.start();
  const IID_AGAIN = (openMgr as unknown as MgrPriv).managerInstanceId;
  check("the restart reuses the SAME persisted instance id (this is a restart, not a new identity)", IID_AGAIN === IID_OPEN, { IID_OPEN, IID_AGAIN });
  check("THE RECOVERY: it is a live class member again, which needs the STATUS write to survive its tombstone too",
    (await openFrozen()).includes(IID_OPEN), IID_OPEN);
  await openMgr.stop().catch(() => {});
  await openNc.drain().catch(() => openNc.close());

  console.log("3. the corpse: a manager whose host died, fabricated rather than found");
  // A LIVE peer beside it, from its own root so it is a first registration rather than a restart:
  // the sections below need one instance that answers and one that cannot, in the same class.
  live = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: rootLive });
  await live.start();
  const IID_LIVE = (live as unknown as MgrPriv).managerInstanceId;
  corpse = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: rootCorpse });
  await corpse.start();
  const IID_CORPSE = (corpse as unknown as MgrPriv).managerInstanceId;
  // The crash shape: its connections drop and it writes NOTHING. A `stop()` here would deregister,
  // which is the opposite of the state being built.
  await ((corpse as unknown as MgrPriv).serviceServe as { nc: NatsConnection }).nc.close();
  await wait(500);
  check("the corpse's registration SURVIVES its host (nothing expires a record)", (await frozenIds()).includes(IID_CORPSE), IID_CORPSE);

  // Re-open the observer with BOTH ids pinned: the guard's probe and the scatter's liveness hook
  // both publish on an instance's own rail, so they need its exact row.
  await nc.drain().catch(() => nc!.close());
  const observer = await openObserver([IID_LIVE, IID_CORPSE]);
  nc = observer.nc;
  const caller = observer.caller;

  console.log("4. what the corpse COSTS, measured, and what it costs after");
  const service = await resolveService(nc, SPACE, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000 });
  const tBefore = Date.now();
  const before = await scatterCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 3_000 });
  const beforeMs = Date.now() - tBefore;
  check("WITH the corpse registered, a scatter pays the full deadline and reports it unreachable",
    beforeMs >= 2_900 && before.missing.includes(IID_CORPSE), { beforeMs, missing: before.missing });

  console.log("5. the credential boundary, then the guard");
  // THE DELETE IS NOT THE READER'S TO MAKE. The observer holds the privileged instrument — the
  // scatter's own credential, which can freeze the class — and that is a READ. Removing a record
  // needs the `endpoint-serve-executor` pinned to that instance, whose grants name exactly its two
  // records keys. If the reader could delete, every `ps` in the space would carry the authority to
  // unregister any manager in it.
  let readerDenied: string | undefined;
  try {
    await deregisterEndpointInstance({
      kv: await new Kvm(nc).open(recordsBucket(SPACE)), endpoint: MANAGER_ENDPOINT, instanceId: IID_CORPSE,
      probeInstance: async () => ({ state: "gone", detail: "fixture: the guard is not what is under test here" }),
      log: () => {},
    });
  } catch (e) {
    readerDenied = (e as Error).message;
  }
  check("the SCATTER's own privileged credential cannot delete a registration (read, not write)",
    /Permissions Violation/i.test(readerDenied ?? ""), readerDenied?.slice(0, 90));
  check("...and the record it could not delete is still there", (await frozenIds()).includes(IID_CORPSE));

  /** One §13.5 delete under the credential the operator verb mints: an executor pinned to the instance. */
  const withExecutor = async <T>(instanceId: string, fn: (kv: KV) => Promise<T>): Promise<T> => {
    const creds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId } });
    const enc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    try { return await fn(await new Kvm(enc).open(recordsBucket(SPACE))); }
    finally { await enc.drain().catch(() => enc.close()); }
  };

  let refusedLive: InstanceDeregisterRefused | undefined;
  try {
    await withExecutor(IID_LIVE, (kv) => deregisterEndpointInstance({
      kv, endpoint: MANAGER_ENDPOINT, instanceId: IID_LIVE,
      probeInstance: makeInstanceProbe(nc!, { space: SPACE, endpoint: MANAGER_ENDPOINT, instanceId: IID_LIVE, caller }),
      log: () => {},
    }));
  } catch (e) {
    refusedLive = e as InstanceDeregisterRefused;
  }
  check("deregistering a LIVE manager is REFUSED because it answered", refusedLive?.condition === "instance-answered", refusedLive?.message);
  check("the refusal tells the operator to stop the process first, not to retry", /stop the process first/.test(refusedLive?.message ?? ""), refusedLive?.message?.slice(0, 120));
  check("and the live manager's registration is untouched by the refusal", (await frozenIds()).includes(IID_LIVE));

  console.log("6. the corpse is removed, on evidence");
  const report = await withExecutor(IID_CORPSE, (kv) => deregisterEndpointInstance({
    kv, endpoint: MANAGER_ENDPOINT, instanceId: IID_CORPSE,
    probeInstance: makeInstanceProbe(nc!, { space: SPACE, endpoint: MANAGER_ENDPOINT, instanceId: IID_CORPSE, caller, describeDeadlineMs: 2_000 }),
    log: () => {},
  }));
  check("the probe found it GONE on the broker's own verdict rather than assuming it", report.probe.state === "gone", report.probe);
  check("...and the broker's own rail check is in the evidence the operator sees",
    /broker reports nothing subscribed/.test(report.probe.detail), report.probe.detail);
  check("the removal names the revisions it deleted, not just that it deleted", report.removedSpecRevision > 0 && report.removedStatusRevision !== undefined, report);
  check("THE POINT: the corpse is gone from the class", !(await frozenIds()).includes(IID_CORPSE), IID_CORPSE);

  console.log("7. the payoff, measured against the same scatter");
  const tAfter = Date.now();
  const after = await scatterCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 3_000 });
  const afterMs = Date.now() - tAfter;
  check("the same scatter now completes instead of waiting out the deadline",
    afterMs < 1_000 && after.complete === true && after.missing.length === 0, { beforeMs, afterMs, missing: after.missing });

  console.log("8. running it twice is not a second removal");
  let refusedAgain: InstanceDeregisterRefused | undefined;
  try {
    await withExecutor(IID_CORPSE, (kv) => deregisterEndpointInstance({
      kv, endpoint: MANAGER_ENDPOINT, instanceId: IID_CORPSE,
      probeInstance: makeInstanceProbe(nc!, { space: SPACE, endpoint: MANAGER_ENDPOINT, instanceId: IID_CORPSE, caller, describeDeadlineMs: 1_500 }),
      log: () => {},
    }));
  } catch (e) {
    refusedAgain = e as InstanceDeregisterRefused;
  }
  check("a repeat is refused as NOT-REGISTERED, a distinct condition from a live instance", refusedAgain?.condition === "not-registered", refusedAgain?.message);
  check("and it says how to check the id, since a typo lands here too", /whole id/.test(refusedAgain?.message ?? ""), refusedAgain?.message?.slice(0, 140));

  console.log("9. the probe never infers death from a failure of its own");
  // A probe that could not run establishes nothing, and the guard must say so rather than proceed.
  const broken = await withExecutor(IID_CORPSE, (kv) => deregisterEndpointInstance({
    kv, endpoint: MANAGER_ENDPOINT, instanceId: IID_CORPSE,
    probeInstance: async () => ({ state: "unestablishable", detail: "the oracle was unreachable" }),
    log: () => {},
  })).then(() => undefined).catch((e: unknown) => e as InstanceDeregisterRefused);
  check("an UNESTABLISHABLE probe refuses, and not with the same condition as silence",
    broken?.condition === "liveness-unestablishable", broken?.message?.slice(0, 120));

  console.log("10. a probe the BROKER refuses is not a dead instance either");
  // The shape section 9 builds by hand, produced for real. The guard's own credential is missing the
  // instance's rail, so both of its questions are refused - and a refused publish does not fail, it
  // goes quiet. If that quiet reached the guard as silence, the operator verb would delete the
  // registration of a manager that is alive and answering, on nothing but a credential gap. The
  // instance probed here is the LIVE one, so a wrong answer is a wrong DELETE.
  const blind = await openObserver([]); // a privileged instrument with no instance rows at all
  const blindProbe = await makeInstanceProbe(blind.nc, {
    space: SPACE, endpoint: MANAGER_ENDPOINT, instanceId: IID_LIVE, caller: blind.caller,
    describeDeadlineMs: 2_000, interestDeadlineMs: 1_500,
  })();
  await blind.nc.drain().catch(() => blind.nc.close());
  check("a probe whose publishes the broker REFUSES is unestablishable, never silence",
    blindProbe.state === "unestablishable", blindProbe);
  check("...and it says the probe itself failed, so the operator repairs the credential and not the manager",
    /the probe itself failed/.test(blindProbe.detail), blindProbe.detail);

  console.log("11. the affirmative rail check is not just a timeout in disguise");
  check("the broker reports the corpse's rail GONE and the live manager's rail present",
    (await epProbeInstanceInterest(nc, SPACE, MANAGER_ENDPOINT, IID_CORPSE, caller, { deadlineMs: 2_000 })) === "gone" &&
    (await epProbeInstanceInterest(nc, SPACE, MANAGER_ENDPOINT, IID_LIVE, caller, { deadlineMs: 2_000 })) !== "gone");

  console.log("12. SILENCE IS NOT DEATH: a registration whose rail still holds a subscriber is REFUSED");
  // THE STATE UNDER TEST, and the one a reviewer used to delete a live registration: an unanswered
  // describe is what a dead host, a WEDGED process and a slow one all look like. A hung process
  // holds every subscription it registered, so the broker cannot affirm its rail empty - and a verb
  // that removed a record on silence would unregister a process that is still running, out from
  // under an operator who cannot see it.
  //
  // THE FIXTURE IS THAT SHAPE FOR REAL, never an injected verdict: a real registration, its serving
  // connection dropped, and a subscriber standing on its `inst` rail that answers nothing. It runs
  // on the OPEN mesh for the reason section 2 does - the credential system is not the variable in
  // this classification (sections 5 and 6 prove the auth-mesh credential path end to end), and only
  // an open mesh lets a stranger hold the subscription that a hung process's own connection holds.
  const hungRoot = mkRoot("hung");
  rmSync(join(hungRoot, ".cotal", "auth"), { recursive: true, force: true });
  recordMesh({ space: openSpace, server: OPEN_SERVERS, root: hungRoot, mode: "open", ts: new Date().toISOString() });
  const hungNc = await connect({ servers: OPEN_SERVERS, maxReconnectAttempts: 0 });
  let hung: InstanceType<typeof Manager> | undefined = new Manager({ space: openSpace, servers: OPEN_SERVERS, runtime: "pty", workspaceRoot: hungRoot });
  await hung.start();
  const IID_HUNG = (hung as unknown as MgrPriv).managerInstanceId;
  await ((hung as unknown as MgrPriv).serviceServe as { nc: NatsConnection }).nc.close();
  await wait(500);
  const hungCaller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
  const hungKv = await new Kvm(hungNc).open(recordsBucket(openSpace));
  const hungFrozen = async (): Promise<string[]> =>
    (await freezeExpectedSet(await jetstreamManager(hungNc, { checkAPI: false }), openSpace, MANAGER_ENDPOINT)).map((f) => f.instanceId);
  const hungProbe = (): (() => Promise<InstanceProbe>) => makeInstanceProbe(hungNc, {
    space: openSpace, endpoint: MANAGER_ENDPOINT, instanceId: IID_HUNG, caller: hungCaller,
    describeDeadlineMs: 2_000, interestDeadlineMs: 1_500,
  });
  // The wedged process's own subscription, standing in for it: registered on the instance's rail,
  // answering nothing. `>` is the same span the serve connection held.
  const holding = hungNc.subscribe(`${spacePrefix(openSpace)}.ep.inst.${endpointToken(MANAGER_ENDPOINT)}.${IID_HUNG}.>`, { callback: () => {} });
  await wait(200);
  check("a registration whose rail STILL HAS A SUBSCRIBER probes UNKNOWN, never gone", (await hungProbe()()).state === "unknown");
  let refusedHung: InstanceDeregisterRefused | undefined;
  try {
    await deregisterEndpointInstance({ kv: hungKv, endpoint: MANAGER_ENDPOINT, instanceId: IID_HUNG, probeInstance: hungProbe(), log: () => {} });
  } catch (e) {
    refusedHung = e as InstanceDeregisterRefused;
  }
  check("the verb REFUSES it: silence is not the evidence a record is removed on",
    refusedHung?.condition === "instance-not-affirmed-gone", refusedHung?.message);
  check("...and it prints what was observed, so the operator repairs the process and not the record",
    /slow or hung, not gone, and NOTHING WAS REMOVED/.test(refusedHung?.message ?? ""), refusedHung?.message?.slice(0, 200));
  check("THE POINT: the registration of a process that is still running is untouched", (await hungFrozen()).includes(IID_HUNG), IID_HUNG);
  // THE POSITIVE CONTROL, and it is what keeps the refusal above from being a verb that refuses
  // everything: the ONLY thing that changes is the subscription. Same command, same record, same
  // credential - and the corpse this whole change exists for still deletes.
  holding.unsubscribe();
  await wait(300);
  const nowGone = await deregisterEndpointInstance({ kv: hungKv, endpoint: MANAGER_ENDPOINT, instanceId: IID_HUNG, probeInstance: hungProbe(), log: () => {} });
  // This delete empties the open mesh's class, and the freeze REFUSES to represent an empty class
  // (§13.5: an empty registry is never an empty scatter success) - so "not a member" is read the
  // same way section 1 reads it, and the removal itself is asserted on the revisions it reports.
  const stillFrozen = await hungFrozen().then((ids) => ids.includes(IID_HUNG)).catch(() => false);
  check("with the subscription gone, the SAME command on the SAME record removes it",
    nowGone.probe.state === "gone" && nowGone.removedSpecRevision > 0 && !stillFrozen, { probe: nowGone.probe, stillFrozen });
  await hung.stop().catch(() => {});
  hung = undefined;
  await hungNc.drain().catch(() => hungNc.close());
} finally {
  try { await nc?.drain(); } catch { /* ignore */ }
  await live?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker?.();
}

const counted = pass + fail;
if (counted !== EXPECTED_CELLS) {
  console.log(`  ✗ FAIL: expected ${EXPECTED_CELLS} cells, ran ${counted} - a cell that stops running stops guarding`);
  fail++;
}
console.log(`\n${fail === 0 ? "MANAGER DEREGISTRATION SMOKE OK ✅" : "MANAGER DEREGISTRATION SMOKE FAILED"}  (${pass} passed, ${fail} failed, ${EXPECTED_CELLS} expected)`);
process.exit(fail === 0 ? 0 : 1);
