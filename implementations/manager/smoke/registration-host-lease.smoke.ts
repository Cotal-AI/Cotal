/** Production host lease ownership and participant grant confinement on a real broker. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  credsClaims, credsFromJwt, endpointRegistrationBarrier, epAuthBucket, mintCreds, mintLifecycleUid,
  newIdentity, permissionsFor, principalKey, recordsBucket, reconcileEndpointGate, GateReconcileRefused,
  registrationLeaseKey, remoteManagerActors, setupSpaceStreams, standaloneConnectOpts, renewRegistrationLease,
  parseRegistrationLease, claimRegistrationRecovery,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { openAuthAuthorityPlane } from "../../auth/dist/index.js";
import { startHostedAuthFixture } from "../../auth/smoke/_hosted-auth-fixture.js";
import { registerRemoteManagerAuthority, remoteManagerClient as client } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "registration-host-lease-"));
for (const name of ["home", "config", "runtime", "cotal"]) mkdirSync(join(root, name), { mode: 0o700 });
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.COTAL_HOME = join(root, "cotal");
const fx = await startHostedAuthFixture("regleasehost", 1, { keepFiles: true });
const account = fx.accounts[0]!, space = account.space, owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid(), actors = remoteManagerActors(instanceId), id = mintLifecycleUid();
const identities = { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() };
const state = { v: 1 as const, space, instanceId, lifecycleUid: mintLifecycleUid(), identities };
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
let host: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  plane = await openAuthAuthorityPlane({ server: fx.servers, space, dir: account.stateDir, identityRoot: account.stateDir,
    identityStore: account.store, dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! }, log: console.log });
  const issue = (request: RemoteManagerAuthorityRequest) => plane!.issueManagerServiceAuthority({ owner, scope: ["supervise"], request });
  const request = client.remoteManagerAuthorityRequest(state, "cli", "prepare", { registrationLeaseId: id });
  const prepared = await issue(request);
  assert.equal(prepared.registrationLease?.id, id);
  assert.equal(prepared.registrationLease?.state, "active");
  assert.ok(prepared.credentials.executor!.exp * 1000 <= prepared.registrationLease!.until);
  const maintain = async (operation: "renew-registration" | "release-registration", leaseId = id) => {
    const q = client.remoteManagerMaintenanceRequest(state, "cli", operation, instanceId, undefined, leaseId);
    return client.remoteManagerMaintenanceResult(await plane!.maintainRemoteManager({ owner, scope: ["supervise"], request: q }), q, owner);
  };
  await maintain("renew-registration");
  await assert.rejects(() => maintain("renew-registration", mintLifecycleUid()), /held|operation/);
  await assert.rejects(() => plane!.maintainRemoteManager({ owner: `u_${"b".repeat(26)}`, scope: ["supervise"],
    request: client.remoteManagerMaintenanceRequest(state, "cli", "release-registration", instanceId, undefined, id) }), /belongs|principal/);
  const foreign = { ...client.remoteManagerMaintenanceRequest(state, "cli", "renew-registration", mintLifecycleUid(), undefined, id) };
  await assert.rejects(() => plane!.maintainRemoteManager({ owner, scope: ["supervise"], request: foreign }), /only caller instance/);
  const { registrationLeaseId: _id, ...legacy } = request;
  await assert.rejects(() => issue(legacy), /requires a registration lease id/);
  for (const actor of [actors.executor, actors.supervisor]) {
    const permissions = permissionsFor("remote-manager", space, { owner, actor, connId: identities.executor.id }, { remoteManager: { instanceId, owner, actor } });
    assert.ok(!JSON.stringify(permissions).includes("epreglease"), "participant has no lease write grant");
  }
  let released = false;
  await registerRemoteManagerAuthority({ space, server: fx.servers, owner, instanceId, serveActor: actors.serve,
    prepareCreds: credsFromJwt(prepared.credentials.executor!.jwt, identities.executor), tlsRequired: false,
    evict: async principals => principals.map(() => true),
    registrationLease: { renew: async () => { await maintain("renew-registration"); }, release: async () => { await maintain("release-registration"); released = true; } } });
  assert.ok(released);
  await assert.rejects(() => issue({ ...request, requestId: mintLifecycleUid() }), /expired|fenced/);
  const nextId = mintLifecycleUid();
  const next = await issue({ ...request, requestId: mintLifecycleUid(), registrationLeaseId: nextId });
  assert.equal(next.registrationLease?.id, nextId);
  host = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: await mintCreds(account.auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId } }), tls: false }) });
  const kv = await new Kvm(host).open(epAuthBucket(space)), recordsKv = await new Kvm(host).open(recordsBucket(space));
  const barrier = endpointRegistrationBarrier(kv, space, { endpoint: "manager", instanceId, opId: instanceId });
  const before = (await barrier.observe())!, frozen = await barrier.freeze(before.revision);
  assert.ok(frozen);
  const reconcile = () => reconcileEndpointGate({ kv, recordsKv, space, endpoint: "manager", instanceId, requireRegistrationLease: true,
    probeHolder: async () => ({ state: "gone", detail: "fixture has no serving connection" }),
    probeRegistrationExecutor: async () => ({ state: "gone", detail: "registration executor closed" }),
    evictHolders: async holders => holders.map(() => true), log: console.log });
  await assert.rejects(reconcile, e => e instanceof GateReconcileRefused && e.condition === "registration-active");
  const key = registrationLeaseKey("manager", instanceId), lease = (await kv.get(key))!;
  for (const malformed of [{ ...lease.json<object>(), extra: true }, { ...lease.json<object>(), state: "unknown" }, { ...lease.json<object>(), until: -1 }])
    assert.throws(() => parseRegistrationLease(new TextEncoder().encode(JSON.stringify(malformed)), key), /invalid registration lease/);
  await kv.update(key, new TextEncoder().encode(JSON.stringify({ ...lease.json<object>(), until: Date.now() - 1 })), lease.revision);
  await assert.rejects(() => issue({ ...request, registrationLeaseId: nextId, requestId: mintLifecycleUid() }), /expired|fenced/);
  const report = await reconcile();
  assert.equal(report.freezeToken, frozen);
  await assert.rejects(() => maintain("renew-registration", nextId), /expired|fenced/);
  assert.equal((await kv.get(key))!.json<{ state: string }>().state, "released");
  const finalId = mintLifecycleUid();
  await issue({ ...request, registrationLeaseId: finalId, requestId: mintLifecycleUid() });
  await maintain("release-registration", finalId);
  await assert.rejects(() => issue({ ...request, requestId: mintLifecycleUid() }), /already been used/);
  await assert.rejects(() => claimRegistrationRecovery(kv, { endpoint: "manager", instanceId: mintLifecycleUid(), principal: next.registrationLease!.principal, freezeToken: 1, required: true }), /no host-owned lease/);
  // A host crash between acquiring its lease and provisioning the gate must not strand the id.
  const interrupted = mintLifecycleUid(), interruptedKey = registrationLeaseKey("manager", interrupted);
  const issuer = await import("../../auth/src/authority-client.js");
  const writer = await issuer.openAuthorityClient({ server: fx.servers, space,
    dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! }, label: "interrupted-lease-host",
    grants: connId => issuer.remoteManagerIssuerGrants(space, connId), log: () => {} });
  try {
    const leaseKv = await new Kvm(writer.nc).open(epAuthBucket(space));
    const coords = { endpoint: "manager", instanceId: interrupted, principal: `${owner}.${remoteManagerActors(interrupted).serve}` };
    await renewRegistrationLease(leaseKv, { ...coords, id: mintLifecycleUid(), acquire: true });
    const current = (await leaseKv.get(interruptedKey))!;
    await leaseKv.update(interruptedKey, new TextEncoder().encode(JSON.stringify({ ...current.json<object>(), until: Date.now() - 1 })), current.revision);
    await renewRegistrationLease(leaseKv, { ...coords, id: mintLifecycleUid(), acquire: true });
  } finally { await writer.close(); }
  assert.equal(principalKey(owner, actors.serve).key, next.registrationLease?.principal);
  assert.equal(credsClaims(credsFromJwt(prepared.credentials.executor!.jwt, identities.executor)).sub, identities.executor.id);
  console.log("registration-host-lease: real host prepare, renewal, release, crash recovery, late prepare fencing and participant confinement passed");
} finally {
  await host?.close();
  await plane?.close();
  await fx.close();
}
