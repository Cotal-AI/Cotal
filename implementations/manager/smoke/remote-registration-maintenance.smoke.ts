/** Independent host refusals must survive expiry of the registration's own connection. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  commitSiblingIssuance, createSpaceAuth, credentialIdOf, credsClaims, EpEnvelopeError, epAuthBucket,
  endpointRegistrationBarrier, eprepairKey, isReachable, mintCreds, mintLifecycleUid, newIdentity, parseEndpointRepairCursor,
  RECORD_KINDS, recordsBucket, recordStatusKey, remoteManagerActors, serverConfig, serveIssuanceGateKv, setupSpaceStreams, standaloneConnectOpts,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { registerRemoteManagerAuthority } from "../dist/index.js";

const suite = createSuite();
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}registration-maintenance-`));
for (const name of ["home", "config", "runtime", "cotal"]) mkdirSync(join(root, name), { mode: 0o700 });
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.COTAL_HOME = join(root, "cotal");
const space = `regmaint${mintLifecycleUid().slice(0, 8)}`;
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const config = join(root, "server.conf");
writeFileSync(config, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js") }));
const broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
const release = teardownOnSignal(broker, root);
const owner = `u_${"a".repeat(26)}`;
const observers: Array<Awaited<ReturnType<typeof connect>>> = [];
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const openAuth = async (instanceId: string) => {
    const nc = await connect({ servers: server, ...standaloneConnectOpts({
      creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId } }), tls: false,
    }), maxReconnectAttempts: 0 });
    observers.push(nc);
    return new Kvm(nc).open(epAuthBucket(space));
  };
  // Hold the first two governance reads until both Managers have observed the same head.
  // Their registrations and the deciding CAS both run against the live broker.
  const open = Kvm.prototype.open;
  let reads = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>(resolve => { releaseReads = resolve; });
  Kvm.prototype.open = async function (this: Kvm, ...args: Parameters<typeof open>) {
    const kv = await open.apply(this, args);
    if (args[0] === recordsBucket(space)) {
      const get = kv.get.bind(kv);
      kv.get = async (...query) => {
        const entry = await get(...query);
        if (query[0] === "govern.manager" && ++reads <= 2) {
          if (reads === 2) releaseReads();
          await bothRead;
        }
        return entry;
      };
    }
    return kv;
  };
  const managers = [owner, `u_${"b".repeat(26)}`].map(owner => ({ owner, instanceId: mintLifecycleUid() }));
  const readDeadline = setTimeout(releaseReads, 10_000);
  try {
    const results = await Promise.allSettled(managers.map(async ({ owner, instanceId }) => {
      const { executor, serve } = remoteManagerActors(instanceId);
      const prepareCreds = await mintCreds(auth, newIdentity(), "remote-manager", {
        principal: { owner, actor: executor }, remoteManager: { instanceId, owner, actor: executor }, expiresInSeconds: 120,
      });
      return registerRemoteManagerAuthority({ space, server, owner, instanceId, serveActor: serve, tlsRequired: false,
        prepareCreds, evict: async () => { throw new Error("first registration must not evict a holder"); } });
    }));
    suite.check("concurrent first registrations: both Managers acquire their own serving grants", results.every((result, i) =>
      result.status === "fulfilled" && result.value.processEpoch === 0 &&
      result.value.serveGrant.instanceId === managers[i]!.instanceId && result.value.serveGrant.owner === managers[i]!.owner),
    results.map(result => result.status === "rejected" ? String(result.reason) : result.value.registrationRevision));
  } finally {
    clearTimeout(readDeadline);
    Kvm.prototype.open = open;
  }
  const gates = await Promise.all(managers.map(async ({ instanceId }) =>
    serveIssuanceGateKv(await openAuth(instanceId), space, { endpoint: "manager", instanceId }).observe()));
  suite.check("concurrent first registrations: the loser reopened and retried at the original epoch",
    gates.every(gate => gate?.state === "open" && gate.processEpoch === 0) &&
      gates.map(gate => gate?.generation).sort().join(",") === "1,2", gates);

  const statusRaceId = mintLifecycleUid();
  const statusRaceActors = remoteManagerActors(statusRaceId);
  const statusRaceGate = serveIssuanceGateKv(await openAuth(statusRaceId), space, { endpoint: "manager", instanceId: statusRaceId });
  const statusKey = recordStatusKey(RECORD_KINDS.svc, ["manager", statusRaceId]);
  const statusRaceCreds = await mintCreds(auth, newIdentity(), "remote-manager", {
    principal: { owner, actor: statusRaceActors.executor },
    remoteManager: { instanceId: statusRaceId, owner, actor: statusRaceActors.executor }, expiresInSeconds: 120,
  });
  let stagedStatus = false;
  Kvm.prototype.open = async function (this: Kvm, ...args: Parameters<typeof open>) {
    const kv = await open.apply(this, args);
    if (args[0] !== recordsBucket(space)) return kv;
    const get = kv.get.bind(kv);
    kv.get = async (...query) => {
      const entry = await get(...query);
      if (query[0] === statusKey && !stagedStatus) {
        assert.equal(entry, null);
        const gate = await statusRaceGate.observe();
        assert.equal(gate?.state, "open");
        await kv.create(statusKey, new TextEncoder().encode(JSON.stringify({
          state: "ready", epoch: gate.processEpoch, observedSpecRevision: gate.registrationRevision,
        })));
        stagedStatus = true;
      }
      return entry;
    };
    return kv;
  };
  try {
    await assert.rejects(registerRemoteManagerAuthority({ space, server, owner, instanceId: statusRaceId,
      serveActor: statusRaceActors.serve, tlsRequired: false, prepareCreds: statusRaceCreds,
      evict: async () => { throw new Error("a ready-status conflict must not restart registration"); },
    }), error => error instanceof EpEnvelopeError && error.code === "conflict");
  } finally {
    Kvm.prototype.open = open;
  }
  const afterStatusRace = await statusRaceGate.observe();
  suite.check("ready-status CAS conflict does not repeat the committed registration", stagedStatus &&
    afterStatusRace?.state === "open" && afterStatusRace.generation === 1 && afterStatusRace.processEpoch === 0, afterStatusRace);

  for (const mode of ["throw", "mixed", "short", "mixed-live"] as const) {
    const instanceId = mintLifecycleUid();
    const actors = remoteManagerActors(instanceId);
    const authKv = await openAuth(instanceId);
    const executor = newIdentity();
    const executorCreds = (ttl: number) => mintCreds(auth, executor, "remote-manager", {
      principal: { owner, actor: actors.executor },
      remoteManager: { instanceId, owner, actor: actors.executor }, expiresInSeconds: ttl,
    });
    const base = { space, server, owner, instanceId, serveActor: actors.serve, tlsRequired: false };
    const initial = await registerRemoteManagerAuthority({ ...base, prepareCreds: await executorCreds(120), evict: async holders => holders.map(() => true) });
    const gate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId });
    const barrier = endpointRegistrationBarrier(authKv, space, { endpoint: "manager", instanceId, opId: instanceId });
    for (const [actor, profile] of [[actors.goalWriter, "goal-writer"], [actors.sessionLedger, "session-ledger"]] as const) {
      const identity = newIdentity();
      const creds = await mintCreds(auth, identity, profile, { principal: { owner, actor }, ...(profile === "goal-writer" ? { goalWriter: { endpoint: "manager" } } : {}) });
      const observed = (await gate.observe())!;
      await commitSiblingIssuance(gate, observed, {
        credentialId: credentialIdOf(creds), credentialKey: identity.id,
        holderPrincipal: `${owner}.${actor}`, endpoint: "manager", lifecycleUid: instanceId,
        sourceChain: ["root"], state: "active", exp: credsClaims(creds).exp,
        generation: observed.generation, processEpoch: observed.processEpoch,
        registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
      });
    }
    const short = await executorCreds(5);
    const expiry = credsClaims(short).exp!;
    let refreshes = 0, evictions = 0;
    let error: unknown;
    try {
      await registerRemoteManagerAuthority({ ...base, prepareCreds: short,
        refreshPrepareCreds: async () => { refreshes++; return executorCreds(120); },
        evict: async holders => {
          evictions++;
          assert.equal(holders.length, 2);
          if (evictions === 1) {
            if (mode !== "mixed-live")
              await new Promise(resolve => setTimeout(resolve, Math.max(0, (expiry + 1) * 1000 - Date.now())));
            if (mode === "throw") throw new Error("independent host maintenance connection closed");
            return mode === "short" ? [true] : [true, false];
          }
          return holders.map(() => true);
        },
      });
    } catch (caught) { error = caught; }
    const observed = (await gate.observe())!;
    suite.check(`${mode}: independent refusal is not replaced by an automatic prepare retry`,
      error instanceof Error && error.message.includes(mode === "throw" ? "independent host maintenance" : "host eviction did not verify")
        && refreshes === 0 && evictions === 1,
      { error: error instanceof Error ? error.message : String(error), refreshes, evictions });
    suite.check(`${mode}: the gate stays frozen without advancing its registered epoch`,
      observed.state === "frozen" && observed.processEpoch === initial.processEpoch,
      { state: observed.state, epoch: observed.processEpoch });
    suite.check(`${mode}: every completed row revocation remains durable`,
      (await barrier.enumerate()).every(row => row.state === "revoked"));
    if (mode === "mixed-live") {
      const key = eprepairKey("manager", instanceId);
      const entry = (await authKv.get(key))!;
      const cursor = parseEndpointRepairCursor(entry.value, key);
      suite.check("mixed-live: successful partial verdict is still journaled before refusal",
        cursor.holders.length === 2 && cursor.verified.length === 1);
    }
    await registerRemoteManagerAuthority({ ...base, prepareCreds: await executorCreds(120), evict: async holders => holders.map(() => true) });
  }

  const holderId = mintLifecycleUid();
  const contenderId = mintLifecycleUid();
  const prepareFor = (instanceId: string, ttl: number) => {
    const actor = remoteManagerActors(instanceId).executor;
    return mintCreds(auth, newIdentity(), "remote-manager", {
      principal: { owner, actor }, remoteManager: { instanceId, owner, actor }, expiresInSeconds: ttl,
    });
  };
  const holder = { space, server, owner, instanceId: holderId, serveActor: remoteManagerActors(holderId).serve, tlsRequired: false };
  await registerRemoteManagerAuthority({ ...holder, prepareCreds: await prepareFor(holderId, 120), evict: async holders => holders.map(() => true) });
  const authKv = await openAuth(holderId);
  const holderGate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId: holderId });
  const holderObserved = (await holderGate.observe())!;
  await commitSiblingIssuance(holderGate, holderObserved, {
    credentialId: `sha256-${"a".repeat(64)}`, credentialKey: newIdentity().id,
    holderPrincipal: `${owner}.old_holder`, endpoint: "manager", lifecycleUid: holderId,
    sourceChain: ["root"], state: "active", exp: Math.floor(Date.now() / 1000) + 120,
    generation: holderObserved.generation, processEpoch: holderObserved.processEpoch,
    registrationRevision: holderObserved.registrationRevision, nameAuthorityRevision: holderObserved.nameAuthorityRevision,
  });
  await assert.rejects(registerRemoteManagerAuthority({ ...holder, prepareCreds: await prepareFor(holderId, 120), evict: async () => { throw new Error("fixture holds foreign slot"); } }), /fixture holds foreign slot/);
  const contenderIdentity = newIdentity();
  const contenderActor = remoteManagerActors(contenderId).executor;
  const contenderCreds = (ttl: number) => mintCreds(auth, contenderIdentity, "remote-manager", {
    principal: { owner, actor: contenderActor }, remoteManager: { instanceId: contenderId, owner, actor: contenderActor }, expiresInSeconds: ttl,
  });
  const short = await contenderCreds(5);
  const expiry = credsClaims(short).exp!;
  let reconciliations = 0, refreshes = 0;
  let error: unknown;
  try {
    await registerRemoteManagerAuthority({ space, server, owner, instanceId: contenderId, serveActor: remoteManagerActors(contenderId).serve, tlsRequired: false,
      prepareCreds: short, refreshPrepareCreds: async () => { refreshes++; return contenderCreds(120); },
      evict: async holders => holders.map(() => true),
      reconcileForeignRegistration: async instanceId => {
        assert.equal(instanceId, holderId);
        reconciliations++;
        if (reconciliations === 1) {
          await new Promise(resolve => setTimeout(resolve, Math.max(0, (expiry + 1) * 1000 - Date.now())));
          throw new Error("independent host reconciliation connection closed");
        }
        throw new Error("unexpected repeated reconciliation");
      },
    });
  } catch (caught) { error = caught; }
  suite.check("reconciliation: independent refusal propagates without prepare retry",
    error instanceof Error && error.message.includes("independent host reconciliation") && refreshes === 0 && reconciliations === 1,
    { error: error instanceof Error ? error.message : String(error), refreshes, reconciliations });
  suite.check("reconciliation: the foreign holder remains frozen at its original epoch",
    (await holderGate.observe())!.state === "frozen" && (await holderGate.observe())!.processEpoch === holderObserved.processEpoch);
} finally {
  await Promise.all(observers.map(nc => nc.close()));
  await killAndAwaitExit(broker);
  release();
}
suite.finish();
