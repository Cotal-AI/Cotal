/** Recovery must not sweep a registration while its expired executor is being replaced. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  commitSiblingIssuance, createSpaceAuth, credsClaims, epAuthBucket, GateReconcileRefused,
  isReachable, mintCreds, mintLifecycleUid, newIdentity, recordsBucket, reconcileEndpointGate,
  remoteManagerActors, serverConfig, serveIssuanceGateKv, setupSpaceStreams, standaloneConnectOpts,
  mintMembershipObserverCreds, observePrincipalLiveness, MEMBERSHIP_INBOX_PREFIX,
  renewRegistrationLease, releaseRegistrationLease, registrationLeaseKey, claimRegistrationRecovery,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { registerRemoteManagerAuthority } from "../dist/index.js";
import { openAuthorityClient, remoteManagerIssuerGrants } from "../../auth/src/authority-client.js";

const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}registration-refresh-lease-`));
for (const name of ["home", "config", "runtime", "cotal"]) mkdirSync(join(root, name), { mode: 0o700 });
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.COTAL_HOME = join(root, "cotal");
const space = `reglease${mintLifecycleUid().slice(0, 8)}`;
const port = await freePort(), server = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const config = join(root, "server.conf");
writeFileSync(config, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js") }));
const broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
const release = teardownOnSignal(broker);
const clients: NatsConnection[] = [];
const owner = `u_${"a".repeat(26)}`;
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const dial = async (creds: string, inboxPrefix?: string) => {
    const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds, tls: false }), ...(inboxPrefix ? { inboxPrefix } : {}), maxReconnectAttempts: 0 });
    clients.push(nc); return nc;
  };
  const liveness = await dial(await mintMembershipObserverCreds(auth, newIdentity()), MEMBERSHIP_INBOX_PREFIX);
  const run = async (mode: "connected" | "refresh" | "renewal-failure") => {
    const instanceId = mintLifecycleUid(), actors = remoteManagerActors(instanceId), identity = newIdentity();
    const prepare = (ttl: number) => mintCreds(auth, identity, "remote-manager", {
      principal: { owner, actor: actors.executor }, remoteManager: { instanceId, owner, actor: actors.executor }, expiresInSeconds: ttl,
    });
    const host = await dial(await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId } }));
    const kvm = new Kvm(host), kv = await kvm.open(epAuthBucket(space)), recordsKv = await kvm.open(recordsBucket(space));
    const gate = serveIssuanceGateKv(kv, space, { endpoint: "manager", instanceId });
    const issuer = await openAuthorityClient({ server, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! },
      label: "registration-lease-smoke-host", grants: connId => remoteManagerIssuerGrants(space, connId), log: () => {} });
    clients.push(issuer.nc);
    const leaseKv = await new Kvm(issuer.nc).open(epAuthBucket(space));
    const base = { space, server, owner, instanceId, serveActor: actors.serve, tlsRequired: false };
    await registerRemoteManagerAuthority({ ...base, prepareCreds: await prepare(120), evict: async holders => holders.map(() => true) });
    const before = (await gate.observe())!;
    await commitSiblingIssuance(gate, before, {
      credentialId: `sha256-${"a".repeat(64)}`, credentialKey: newIdentity().id,
      holderPrincipal: `${owner}.${actors.goalWriter}`, endpoint: "manager", lifecycleUid: instanceId,
      sourceChain: ["root"], state: "active", exp: Math.floor(Date.now() / 1000) + 120,
      generation: before.generation, processEpoch: before.processEpoch,
      registrationRevision: before.registrationRevision, nameAuthorityRevision: before.nameAuthorityRevision,
    });
    const probe = async (principal: string) => {
      const result = await observePrincipalLiveness(liveness, auth.account.pub, principal, { settleMs: 0, maxWaitMs: 1000 });
      assert.equal(result.sweepComplete, true);
      return { state: result.state, detail: `complete broker sweep: ${result.state}` };
    };
    const reconcile = () => reconcileEndpointGate({ kv, recordsKv, space, endpoint: "manager", instanceId,
      probeHolder: probe, probeRegistrationExecutor: () => probe(`${owner}.${actors.executor}`),
      evictHolders: async holders => holders.map(() => true), log: console.log });
    let attempted = false, refreshed = false;
    const short = await prepare(mode === "refresh" ? 4 : 120), exp = credsClaims(short).exp!;
    const id = mintLifecycleUid();
    const leaseArgs = { endpoint: "manager", instanceId, principal: `${owner}.${actors.serve}`, id };
    await renewRegistrationLease(leaseKv, { ...leaseArgs, acquire: true });
    let renewals = 0, released = false;
    let renewalObserved!: () => void;
    const renewed = new Promise<void>(resolve => { renewalObserved = resolve; });
    const registration = registerRemoteManagerAuthority({ ...base, prepareCreds: short,
      registrationLease: {
        renew: async () => {
          renewals++;
          renewalObserved();
          if (mode === "renewal-failure") throw new Error("host lease renewal refused");
          await renewRegistrationLease(leaseKv, { ...leaseArgs, acquire: false });
        },
        release: async () => { await releaseRegistrationLease(leaseKv, leaseArgs); released = true; },
      },
      refreshPrepareCreds: async () => {
        refreshed = true;
        const frozen = (await gate.observe())!;
        assert.equal(frozen.state, "frozen");
        assert.equal((await probe(`${owner}.${actors.executor}`)).state, "gone");
        assert.equal((await probe(`${owner}.${actors.serve}`)).state, "gone");
        attempted = true;
        await assert.rejects(reconcile, error => error instanceof GateReconcileRefused && error.condition === "registration-active");
        assert.equal((await gate.observe())!.revision, frozen.revision);
        console.log("REFRESH_GAP_REFUSED", frozen.revision);
        // Keep the executor disconnected past one real renewal tick. The host lease must renew
        // independently, and recovery must still refuse after that request settles.
        await renewed;
        await assert.rejects(reconcile, error => error instanceof GateReconcileRefused && error.condition === "registration-active");
        return prepare(120);
      },
      evict: async holders => {
        if (mode === "renewal-failure") {
          await renewed;
          return holders.map(() => true);
        }
        if (!attempted && mode === "connected") {
          const frozen = (await gate.observe())!;
          await assert.rejects(reconcile, error => error instanceof GateReconcileRefused && error.condition === "holder-alive");
          assert.equal((await gate.observe())!.revision, frozen.revision);
          attempted = true;
          console.log("CONTROL_CONNECTED_REFUSED", frozen.revision);
        }
        if (!refreshed && mode === "refresh") await new Promise(resolve => setTimeout(resolve, Math.max(0, (exp + 1) * 1000 - Date.now())));
        return holders.map(() => true);
      },
    });
    if (mode === "renewal-failure") {
      await assert.rejects(registration, /host lease renewal refused/);
      assert.equal((await gate.observe())!.state, "frozen");
      assert.equal((await probe(`${owner}.${actors.executor}`)).state, "gone");
      assert.equal(renewals, 1);
      assert.ok(released);
      console.log("RENEWAL_FAILURE_CLOSED_EXECUTOR");
      return;
    }
    await registration;
    assert.ok(attempted);
    if (mode === "refresh") assert.ok(renewals >= 1);
    assert.equal((await gate.observe())!.state, "open");
    assert.equal((await kv.get(registrationLeaseKey("manager", instanceId)))!.json<{ state: string }>().state, "released");

    // Crash recovery claims an expired lease durably and refuses a delayed renewal.
    const crashedId = mintLifecycleUid();
    await renewRegistrationLease(leaseKv, { ...leaseArgs, id: crashedId, acquire: true });
    const key = registrationLeaseKey("manager", instanceId), active = (await kv.get(key))!;
    await kv.update(key, new TextEncoder().encode(JSON.stringify({ ...active.json<object>(), until: Date.now() - 1 })), active.revision);
    assert.equal(await claimRegistrationRecovery(kv, { endpoint: "manager", instanceId, principal: leaseArgs.principal, freezeToken: 123 }), "claimed");
    await assert.rejects(() => renewRegistrationLease(leaseKv, { ...leaseArgs, id: crashedId, acquire: false }), /expired|fenced/);
    console.log("EXPIRED_LEASE_FENCED", mode);
  };
  await run("connected");
  await run("refresh");
  await run("renewal-failure");
  console.log("registration-refresh-lease: connected control, disconnected refresh exclusion and late-renewal fencing passed");
} finally {
  await Promise.all(clients.map(nc => nc.close()));
  await killAndAwaitExit(broker);
  release();
}
