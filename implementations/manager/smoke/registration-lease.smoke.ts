/** Real executor expiry with concurrent recovery must preserve the host-leased registration. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  commitSiblingIssuance, createSpaceAuth, credentialIdOf, credsClaims, epAuthBucket,
  endpointRegistrationBarrier, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  remoteManagerActors, serverConfig, serveIssuanceGateKv, setupSpaceStreams, standaloneConnectOpts,
  mintMembershipObserverCreds, observePrincipalLiveness, MEMBERSHIP_INBOX_PREFIX,
  recordsBucket, reconcileEndpointGate, GateReconcileRefused, renewEndpointRegistrationLease,
  releaseEndpointRegistrationLease, readEndpointRegistrationLease, epRegistrationLeaseKey, claimEndpointRegistrationRecovery,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { registerRemoteManagerAuthority } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}registration-lease-`));
for (const name of ["home", "config", "runtime", "cotal"]) mkdirSync(join(root, name), { mode: 0o700 });
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.COTAL_HOME = join(root, "cotal");
const space = `reglease${mintLifecycleUid().slice(0, 8)}`;
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
const config = join(root, "server.conf");
writeFileSync(config, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js") }));
const broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
const release = teardownOnSignal(broker, root);
const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const executor = newIdentity();
const lifecycleUid = mintLifecycleUid();
const principal = `${owner}.${actors.serve}`;
const executorCreds = (ttl: number) => mintCreds(auth, executor, "remote-manager", {
  principal: { owner, actor: actors.executor }, remoteManager: { instanceId, owner, actor: actors.executor }, expiresInSeconds: ttl,
});
let observer: Awaited<ReturnType<typeof connect>> | undefined;
let liveness: Awaited<ReturnType<typeof connect>> | undefined;
let control: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  observer = await connect({ servers: server, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId } }), tls: false }), maxReconnectAttempts: 0 });
  liveness = await connect({ servers: server, ...standaloneConnectOpts({ creds: observerCreds, tls: false }), inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0 });
  const authKv = await new Kvm(observer).open(epAuthBucket(space));
  const recordsKv = await new Kvm(observer).open(recordsBucket(space));
  const gate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId });
  const barrier = endpointRegistrationBarrier(authKv, space, { endpoint: "manager", instanceId, opId: instanceId });
  const probe = async (who: string) => {
    const result = await observePrincipalLiveness(liveness!, auth.account.pub, who, { settleMs: 0, maxWaitMs: 1000 });
    assert.equal(result.sweepComplete, true);
    return { state: result.state, detail: "complete private-broker CONNZ sweep" };
  };
  const reconcile = () => reconcileEndpointGate({ kv: authKv, recordsKv, space, endpoint: "manager", instanceId,
    probeHolder: probe, probeRegistrationExecutor: () => probe(`${owner}.${actors.executor}`),
    evictHolders: async holders => holders.map(() => true), log: () => {},
  });
  const base = { space, server, owner, instanceId, serveActor: actors.serve, tlsRequired: false };
  await registerRemoteManagerAuthority({ ...base, prepareCreds: await executorCreds(60), evict: async holders => holders.map(() => true) });
  // The existing connected-executor control still refuses before a lease is needed.
  control = await connect({ servers: server, ...standaloneConnectOpts({ creds: await executorCreds(60), tls: false }), maxReconnectAttempts: 0 });
  await barrier.freeze((await gate.observe())!.revision);
  const controlRevision = (await gate.observe())!.revision;
  await assert.rejects(reconcile(), error => error instanceof GateReconcileRefused && error.condition === "holder-alive");
  assert.equal((await gate.observe())!.revision, controlRevision);
  await control.close();
  await reconcile();
  console.log("  ✓ connected executor refuses recovery and leaves the gate unchanged");

  const observed = (await gate.observe())!;
  const sibling = newIdentity();
  const creds = await mintCreds(auth, sibling, "goal-writer", { principal: { owner, actor: actors.goalWriter }, goalWriter: { endpoint: "manager" } });
  await commitSiblingIssuance(gate, observed, {
    credentialId: credentialIdOf(creds), credentialKey: sibling.id, holderPrincipal: `${owner}.${actors.goalWriter}`,
    endpoint: "manager", lifecycleUid: instanceId, sourceChain: ["root"], state: "active", exp: credsClaims(creds).exp,
    generation: observed.generation, processEpoch: observed.processEpoch, registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
  });
  const short = await executorCreds(4);
  const expiry = credsClaims(short).exp!;
  const binding = { endpoint: "manager", instanceId, principal, executorNkey: executor.id, lifecycleUid };
  const lease = await renewEndpointRegistrationLease(authKv, { ...binding, requestId: mintLifecycleUid(), expiresAt: expiry * 1000 + 60_000 });
  // An exact request retry joins, while another attempt and another identity cannot replace it.
  assert.equal((await renewEndpointRegistrationLease(authKv, { ...binding, requestId: lease.requestId, expiresAt: lease.expiresAt })).leaseId, lease.leaseId);
  await assert.rejects(renewEndpointRegistrationLease(authKv, { ...binding, requestId: mintLifecycleUid(), expiresAt: lease.expiresAt }), /already holds/);
  await assert.rejects(renewEndpointRegistrationLease(authKv, { ...binding, executorNkey: newIdentity().id,
    requestId: mintLifecycleUid(), leaseId: lease.leaseId, expiresAt: lease.expiresAt }), /another attempt/);
  let evictions = 0;
  let refreshes = 0;
  const registered = await registerRemoteManagerAuthority({ ...base, prepareCreds: short, registrationLease: lease,
    refreshPrepareCreds: async () => {
      refreshes++;
      const before = (await gate.observe())!;
      assert.equal(before.state, "frozen");
      assert.equal((await probe(principal)).state, "gone");
      assert.equal((await probe(`${owner}.${actors.executor}`)).state, "gone");
      await assert.rejects(reconcile(), error => error instanceof GateReconcileRefused && error.condition === "registration-leased");
      assert.equal((await gate.observe())!.revision, before.revision);
      const next = await executorCreds(60);
      await renewEndpointRegistrationLease(authKv, { ...binding, requestId: mintLifecycleUid(), leaseId: lease.leaseId,
        expiresAt: credsClaims(next).exp! * 1000 + 60_000 });
      return next;
    },
    evict: async holders => {
      if (++evictions === 1) await new Promise(resolve => setTimeout(resolve, Math.max(0, (expiry + 1) * 1000 - Date.now())));
      return holders.map(() => true);
    },
  });
  assert.equal(refreshes, 1);
  assert.equal(registered.processEpoch, observed.processEpoch + 1);
  assert.equal((await gate.observe())!.generation, observed.generation + 1);
  assert.equal((await gate.observe())!.state, "open");
  await releaseEndpointRegistrationLease(authKv, binding);
  assert.equal((await readEndpointRegistrationLease(authKv, "manager", instanceId))!.lease.state, "released");
  console.log("  ✓ complete gone sweeps during real credential expiry cannot sweep a live leased registration");
  console.log("  ✓ the same attempt renews, completes one epoch and releases at activation");

  // Long work renews independently of its broker connection.
  const heartbeatLease = await renewEndpointRegistrationLease(authKv, { ...binding, requestId: mintLifecycleUid(), expiresAt: Date.now() + 1200 });
  const abortGate = (await gate.observe())!;
  const abortToken = await barrier.freeze(abortGate.revision);
  assert.ok(abortToken);
  assert.equal(await barrier.reopen(abortToken, { generation: abortGate.generation + 1,
    processEpoch: abortGate.processEpoch, registrationRevision: abortGate.registrationRevision,
    nameAuthorityRevision: abortGate.nameAuthorityRevision }), true);
  await assert.rejects(releaseEndpointRegistrationLease(authKv, binding), /completed/);
  await assert.rejects(renewEndpointRegistrationLease(authKv, { ...binding, requestId: mintLifecycleUid(), expiresAt: Date.now() + 2000 }), /already holds/);
  const rebound = await renewEndpointRegistrationLease(authKv, { ...binding, requestId: mintLifecycleUid(),
    leaseId: heartbeatLease.leaseId, expiresAt: Date.now() + 1200 });
  assert.equal(rebound.generation, abortGate.generation + 1);
  const heartbeatCreds = await executorCreds(60);
  let heartbeats = 0;
  const heartbeat = await registerRemoteManagerAuthority({ ...base, prepareCreds: heartbeatCreds, registrationLease: heartbeatLease,
    refreshPrepareCreds: async () => {
      heartbeats++;
      await renewEndpointRegistrationLease(authKv, { ...binding, leaseId: heartbeatLease.leaseId,
        requestId: mintLifecycleUid(), expiresAt: Date.now() + 2000 });
      return heartbeatCreds;
    },
    evict: async holders => {
      await new Promise(resolve => setTimeout(resolve, 700));
      return holders.map(() => true);
    },
  });
  assert.ok(heartbeats >= 1);
  assert.equal(heartbeat.processEpoch, registered.processEpoch + 1);
  await releaseEndpointRegistrationLease(authKv, binding);
  console.log("  ✓ a long registration renews its host lease before the executor expires");

  // A dead attempt becomes recoverable after the bound executor has expired. Use a real short
  // lease with no live executor, then exercise the same repair and stale-renewal entrypoints.
  const abandoned = await renewEndpointRegistrationLease(authKv, { ...binding, requestId: mintLifecycleUid(), expiresAt: Date.now() + 350 });
  await barrier.freeze((await gate.observe())!.revision);
  await new Promise(resolve => setTimeout(resolve, 400));
  const repaired = await reconcile();
  assert.equal(repaired.after.generation, repaired.before.generation + 1);
  await assert.rejects(renewEndpointRegistrationLease(authKv, { ...binding, requestId: mintLifecycleUid(), leaseId: abandoned.leaseId,
    expiresAt: Date.now() + 60_000 }), /expired|claimed/);
  console.log("  ✓ expired dead attempt is durably claimed and cannot renew after recovery");

  const claimed = (await readEndpointRegistrationLease(authKv, "manager", instanceId))!;
  assert.equal(claimed.lease.state, "recovering");
  assert.equal(await claimEndpointRegistrationRecovery(authKv, { endpoint: "manager", instanceId, principal,
    generation: claimed.lease.generation, freezeToken: claimed.lease.freezeToken! }), "claimed");
  await assert.rejects(claimEndpointRegistrationRecovery(authKv, { endpoint: "manager", instanceId, principal,
    generation: claimed.lease.generation, freezeToken: claimed.lease.freezeToken! + 1 }), /another freeze/);

  const refusedLease = await renewEndpointRegistrationLease(authKv, { ...binding, requestId: mintLifecycleUid(), expiresAt: Date.now() + 1200 });
  const beforeRefusal = (await gate.observe())!;
  const denied = new Error("host denied registration lease renewal");
  await assert.rejects(registerRemoteManagerAuthority({ ...base, prepareCreds: await executorCreds(60), registrationLease: refusedLease,
    refreshPrepareCreds: async () => { throw denied; }, evict: async holders => {
      await new Promise(resolve => setTimeout(resolve, 700));
      return holders.map(() => true);
    },
  }), error => error === denied);
  assert.equal((await gate.observe())!.state, "frozen");
  assert.equal((await gate.observe())!.registrationRevision, beforeRefusal.registrationRevision);
  console.log("  ✓ host renewal refusal prevents spec publication and leaves the attempt frozen");

  // Malformed or tombstoned state is never interpreted as absence.
  const key = epRegistrationLeaseKey("manager", instanceId);
  const row = (await authKv.get(key))!;
  await authKv.update(key, new TextEncoder().encode('{"v":1}'), row.revision);
  await assert.rejects(readEndpointRegistrationLease(authKv, "manager", instanceId), /validate/);
  await authKv.delete(key);
  await assert.rejects(readEndpointRegistrationLease(authKv, "manager", instanceId), /deleted/);
  console.log("  ✓ malformed registration authority fails closed");
} finally {
  await control?.close();
  await liveness?.close();
  await observer?.close();
  await killAndAwaitExit(broker);
  release();
}
console.log("registration-lease: 7 passed, 0 failed");
