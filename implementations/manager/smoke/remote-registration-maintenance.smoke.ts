/** Independent host refusals must survive expiry of the registration's own connection. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  commitSiblingIssuance, createSpaceAuth, credentialIdOf, credsClaims, epAuthBucket,
  endpointRegistrationBarrier, eprepairKey, isReachable, mintCreds, mintLifecycleUid, newIdentity, parseEndpointRepairCursor,
  remoteManagerActors, serverConfig, serveIssuanceGateKv, setupSpaceStreams, standaloneConnectOpts,
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
