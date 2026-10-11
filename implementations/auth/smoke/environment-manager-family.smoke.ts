/** Existing supervisor issuance cannot cross an environment-manager gate. */
import assert from "node:assert/strict";
import { Kvm } from "@nats-io/kv";
import {
  epAuthBucket, epgateKey, mintCreds, mintLifecycleUid, newIdentity, parseEndpointGate,
  provisionEndpointGateOpen, remoteManagerActors, REMOTE_MANAGER_IDENTITY_NAMES, setupSpaceStreams,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { startAuthService, type AuthServiceHandle } from "../src/index.js";
import { remoteManagerIssuerGrants, openAuthorityClient, type AuthorityClient } from "../src/authority-client.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fx = await startHostedAuthFixture("environment-family", 1);
const account = fx.accounts[0]!;
const owner = `u_${"a".repeat(26)}`;
let instanceId = mintLifecycleUid(), lifecycleUid = mintLifecycleUid();
let state: "assigned" | "ended" = "assigned";
const identities = Object.fromEntries(REMOTE_MANAGER_IDENTITY_NAMES.map(name => [name, { id: newIdentity().id }])) as RemoteManagerAuthorityRequest["identities"];
const request = (): RemoteManagerAuthorityRequest => ({
  v: 1, kind: "manager-service-authority", operation: "prepare", space: account.space,
  actor: "cli", instanceId, managerLifecycleUid: lifecycleUid, requestId: mintLifecycleUid(), identities,
});
let service: AuthServiceHandle | undefined;
let writer: AuthorityClient | undefined;
let passed = 0;
try {
  await setupSpaceStreams({ servers: fx.servers, space: account.space,
    creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  service = await startAuthService({
    context: { accountPublicKey: account.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: account.space, servers: fx.servers, stateDir: account.stateDir,
    store: account.store, storeIdentity: account.store.identity,
    platformSupervisor: { authorizePlatformAdmin: async () => true,
      observeAssignment: async () => ({ v: 1, kind: "platform-supervisor", owner, state,
        space: account.space, accountPublicKey: account.accountPublicKey, instanceId, lifecycleUid,
        revision: 1, expiresAt: Math.floor(Date.now() / 1000) + 300, scope: ["supervise"] }) },
  });
  writer = await openAuthorityClient({ server: fx.servers, space: account.space,
    dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
    label: "environment-family-fixture", grants: id => remoteManagerIssuerGrants(account.space, id), log: () => {} });
  const kv = await new Kvm(writer.nc).open(epAuthBucket(account.space));
  await provisionEndpointGateOpen(kv, { endpoint: "manager", instanceId,
    principal: `${owner}.${remoteManagerActors(instanceId).serve}`, authorityFamily: "environment-manager" });
  const door = await service.platformSupervisorAuthority!(owner);
  const prepare = () => door({ v: 1, kind: "platform-supervisor-authority", owner,
    assignmentRevision: 1, request: request() });
  const key = epgateKey("manager", instanceId);
  const initial = (await kv.get(key))!;
  const row = parseEndpointGate(initial.value, key);
  for (const gateState of ["open", "frozen", "retired"] as const) {
    const current = (await kv.get(key))!;
    const bytes = new TextEncoder().encode(JSON.stringify({ ...row, state: gateState,
      ...(gateState === "open" ? {} : { op: { opId: mintLifecycleUid(), kind: gateState === "frozen" ? "registration" : "retirement" } }) }));
    parseEndpointGate(bytes, key);
    await kv.update(key, bytes, current.revision);
    await assert.rejects(prepare, /environment-manager/,
      `human-family prepare refuses an environment gate in ${gateState} before releasing direct-store credentials`);
    passed++;
    assert.deepEqual((await kv.get(key))!.value, bytes, `refused ${gateState} preparation leaves the gate bytes unchanged`);
    passed++;
  }
  state = "ended";
  const beforeEnd = (await kv.get(key))!;
  await assert.rejects(() => service!.endPlatformSupervisorAssignment!(owner), /environment-manager/,
    "ending a human supervisor cannot retire an environment gate");
  passed++;
  assert.equal((await kv.get(key))!.revision, beforeEnd.revision, "refused cross-family end leaves the gate revision unchanged");
  passed++;

  state = "assigned";
  instanceId = mintLifecycleUid(); lifecycleUid = mintLifecycleUid();
  const plain = await prepare();
  assert.deepEqual(Object.keys(plain.credentials).sort(), ["executor", "supervisor"], "plain supervisor preparation still returns its fixed credentials");
  passed++;
  const reservedEntry = await kv.get(epgateKey("manager", instanceId));
  assert.ok(reservedEntry, "plain preparation reserves its native family before credential release");
  passed++;
  const reserved = parseEndpointGate(reservedEntry.value, epgateKey("manager", instanceId));
  assert.equal(reserved.authorityFamily, undefined, "plain preparation reserves the existing unmarked family");
  passed++;
  await assert.rejects(() => provisionEndpointGateOpen(kv, { endpoint: "manager", instanceId,
    principal: reserved.principal, authorityFamily: "environment-manager" }), /FOREIGN|conflict/,
    "environment admission cannot adopt an instance whose direct-store preparation already won");
  passed++;

  for (let attempt = 0; attempt < 6; attempt++) {
    instanceId = mintLifecycleUid(); lifecycleUid = mintLifecycleUid();
    const raced = await Promise.allSettled([
      provisionEndpointGateOpen(kv, { endpoint: "manager", instanceId,
        principal: `${owner}.${remoteManagerActors(instanceId).serve}`, authorityFamily: "environment-manager" }),
      prepare(),
    ]);
    assert.equal(raced.filter(result => result.status === "fulfilled").length, 1, "native create-only reservation admits only one racing family");
    passed++;
    const gate = parseEndpointGate((await kv.get(epgateKey("manager", instanceId)))!.value, epgateKey("manager", instanceId));
    assert.equal(gate.authorityFamily === "environment-manager", raced[0].status === "fulfilled", "the winning family matches the native gate");
    passed++;
  }
} finally {
  await service?.close();
  await writer?.close();
  await fx.close();
}
emitSentinel({ passed, failed: 0 });
