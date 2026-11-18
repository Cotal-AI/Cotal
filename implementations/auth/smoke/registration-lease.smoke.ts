/** Host-issued registration leases survive host restart and never grant participant writes. */
import assert from "node:assert/strict";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";
import {
  credsClaims, epAuthBucket, epRegistrationLeaseKey, mintLifecycleUid, newIdentity,
  readEndpointRegistrationLease, remoteManagerActors, remoteManagerRegistrationProof,
  setupSpaceStreams, mintCreds, standaloneConnectOpts, type Identity, type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { openAuthAuthorityPlane } from "../src/index.js";
import { openAuthorityClient, remoteManagerIssuerGrants } from "../src/authority-client.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { registerRemoteManagerAuthority } from "../../manager/src/remote-register.js";
import { materialCredential } from "../../manager/src/remote-authority.js";
import { managerClusterArtifacts } from "../../manager/src/manager-service-contract.js";

const fx = await startHostedAuthFixture("reglease", 1, { keepFiles: true });
const account = fx.accounts[0]!;
const { space } = account;
process.env.HOME = account.stateDir;
process.env.XDG_CONFIG_HOME = account.stateDir;
process.env.XDG_RUNTIME_DIR = account.stateDir;
process.env.COTAL_HOME = account.stateDir;
const owner = `u_${"c".repeat(26)}`;
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
const held = Object.fromEntries(names.map(name => [name, newIdentity()])) as Record<typeof names[number], Identity>;
const identities = Object.fromEntries(names.map(name => [name, { id: held[name].id }])) as RemoteManagerAuthorityRequest["identities"];
const dataAccount = { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! };
const open = () => openAuthAuthorityPlane({ server: fx.servers, space, dir: account.stateDir,
  identityRoot: account.stateDir, identityStore: account.store, dataAccount, log: () => {} });
const request = (extra: Partial<RemoteManagerAuthorityRequest> = {}): RemoteManagerAuthorityRequest => ({
  v: 1, kind: "manager-service-authority", operation: "prepare", space, actor: "cli", instanceId,
  managerLifecycleUid, requestId: mintLifecycleUid(), identities, ...extra,
});
let plane: Awaited<ReturnType<typeof open>> | undefined;
let writer: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let participant: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  plane = await open();
  writer = await openAuthorityClient({ server: fx.servers, space, dataAccount,
    label: "registration-lease-observer", grants: id => remoteManagerIssuerGrants(space, id), log: () => {} });
  const kv = await new Kvm(writer.nc).open(epAuthBucket(space));
  const initialRequest = request();
  let material = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: initialRequest });
  assert.ok(material.registrationLease);
  const leaseId = material.registrationLease.leaseId;
  assert.ok(material.registrationLease.expiresAt > material.credentials.executor!.exp * 1000);
  assert.equal((await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: initialRequest })).registrationLease!.leaseId, leaseId);
  await assert.rejects(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request() }), /already holds/);
  await assert.rejects(plane.issueManagerServiceAuthority({ owner, scope: [], request: request({ registrationLeaseId: leaseId }) }), /supervise/);
  const before = (await readEndpointRegistrationLease(kv, "manager", instanceId))!;
  const executorCreds = materialCredential(material, "executor", held.executor);
  participant = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: executorCreds, tls: false }), reconnect: false });
  const permissions: string[] = [];
  const watching = (async () => { for await (const event of participant!.status()) {
    if (event.type === "error" && String(event.error).includes("Permissions")) permissions.push(String(event.error));
  } })();
  // An executor can read lease metadata, but publishing a forged release is denied by the broker.
  participant.publish(`$KV.${epAuthBucket(space)}.${epRegistrationLeaseKey("manager", instanceId)}`, new TextEncoder().encode("{}"));
  await participant.flush();
  await participant.close();
  await watching;
  assert.ok(permissions.length > 0, "broker must deny participant lease publication");
  assert.equal((await readEndpointRegistrationLease(kv, "manager", instanceId))!.revision, before.revision);
  console.log("  ✓ prepare creates a bounded host lease, exact retries join and participant writes are denied");

  await plane.close();
  plane = await open();
  material = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request({ registrationLeaseId: leaseId }) });
  assert.equal(material.registrationLease!.leaseId, leaseId);
  assert.equal((await readEndpointRegistrationLease(kv, "manager", instanceId))!.lease.state, "active");
  console.log("  ✓ a restarted host renews the same durable attempt without replacing its identity");

  const registered = await registerRemoteManagerAuthority({ space, server: fx.servers, owner, instanceId,
    serveActor: remoteManagerActors(instanceId).serve, prepareCreds: materialCredential(material, "executor", held.executor),
    registrationLease: material.registrationLease!, refreshPrepareCreds: async () => {
      material = await plane!.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request({ registrationLeaseId: leaseId }) });
      return materialCredential(material, "executor", held.executor);
    }, tlsRequired: false, evict: async principals => principals.map(() => true),
  });
  assert.equal(registered.processEpoch, 0);
  const artifacts = managerClusterArtifacts();
  const contractArtifacts = [artifacts.document, artifacts.manifest];
  const registrationProof = remoteManagerRegistrationProof(owner, { space, instanceId, lifecycleUid: managerLifecycleUid, identities }, contractArtifacts);
  const activated = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request({
    operation: "activate", registrationProof, contractArtifacts,
  }) });
  assert.ok(activated.credentials.serve);
  assert.equal((await readEndpointRegistrationLease(kv, "manager", instanceId))!.lease.state, "released");
  assert.ok(credsClaims(materialCredential(activated, "serve", held.serve)).sub === held.serve.id);
  await assert.rejects(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request({ registrationLeaseId: leaseId }) }), /expired|claimed|another attempt/);
  console.log("  ✓ normal registration activates and releases only its completed lease");
} finally {
  await participant?.close();
  await writer?.close();
  await plane?.close();
  await fx.close();
}
console.log("host-registration-lease: 3 passed, 0 failed");
