/** Native permission proof through the production authority phase executor.
 * Run with the repository's approved nats-server on PATH. No fixture signing of serve JWTs.
 * This proves broker subscription permission, not manager handler continuity or delivery.
 */
import assert from "node:assert/strict";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  credsFromJwt, credsClaims, mintCreds, mintLifecycleUid, newIdentity, remoteManagerActors,
  remoteManagerRegistrationProof, REMOTE_MANAGER_IDENTITY_NAMES, setupSpaceStreams,
  standaloneConnectOpts, spacePrefix, endpointToken, type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { openAuthAuthorityPlane } from "../../auth/src/service.js";
import { startHostedAuthFixture } from "../../auth/smoke/_hosted-auth-fixture.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";
import { managerClusterArtifacts } from "../src/manager-service-contract.js";

const fx = await startHostedAuthFixture("issued-serve", 1);
const account = fx.accounts[0]!;
const { space } = account;
const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid(), lifecycleUid = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const held = Object.fromEntries(REMOTE_MANAGER_IDENTITY_NAMES.map(name => [name, newIdentity()]));
const identities = Object.fromEntries(REMOTE_MANAGER_IDENTITY_NAMES.map(name => [name, { id: held[name]!.id }])) as RemoteManagerAuthorityRequest["identities"];
const base = { v: 1 as const, kind: "manager-service-authority" as const, space, actor: "cli", instanceId,
  managerLifecycleUid: lifecycleUid, identities };
const clients: NatsConnection[] = [];
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  plane = await openAuthAuthorityPlane({ server: fx.servers, space, dir: account.stateDir,
    identityRoot: account.stateDir, identityStore: account.store,
    dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! }, log: console.log });
  const issue = (request: RemoteManagerAuthorityRequest) => plane!.issueManagerServiceAuthority({ owner, scope: ["supervise"], request });
  const prepare = await issue({ ...base, operation: "prepare", requestId: mintLifecycleUid() });
  assert.deepEqual(Object.keys(prepare.credentials).sort(), ["executor", "supervisor"]);
  const registered = await registerRemoteManagerAuthority({ space, server: fx.servers, owner, instanceId,
    serveActor: actors.serve, tlsRequired: false,
    prepareCreds: credsFromJwt(prepare.credentials.executor!.jwt, held.executor!),
    evict: async principals => principals.map(() => true) });
  const cluster = managerClusterArtifacts();
  const contractArtifacts = [cluster.document, cluster.manifest];
  const activation = await issue({ ...base, operation: "activate", requestId: mintLifecycleUid(), contractArtifacts,
    registrationProof: remoteManagerRegistrationProof(owner, { space, instanceId, lifecycleUid, identities }, contractArtifacts) });
  assert.ok(activation.nextRegistrationProof);
  const renewalRequest: RemoteManagerAuthorityRequest = { ...base, operation: "renewStandingBundle", requestId: mintLifecycleUid(),
    accountPublicKey: account.accountPublicKey, processEpoch: registered.processEpoch,
    registrationProof: activation.nextRegistrationProof };
  const renewal = await issue(renewalRequest);
  assert.deepEqual(Object.keys(renewal.credentials).sort(), [...REMOTE_MANAGER_IDENTITY_NAMES].sort());
  const before = credsFromJwt(activation.credentials.serve!.jwt, held.serve!);
  const after = credsFromJwt(renewal.credentials.serve!.jwt, held.serve!);
  const beforeClaims = credsClaims(before), afterClaims = credsClaims(after);
  assert.equal(beforeClaims.sub, afterClaims.sub, "renewal retains held serving nkey");
  const permissions = (claims: unknown) => (claims as { nats: { pub: unknown; sub: unknown } }).nats;
  assert.deepEqual(permissions(afterClaims).pub, permissions(beforeClaims).pub, "no publish grant widening");
  assert.deepEqual(permissions(afterClaims).sub, permissions(beforeClaims).sub, "no subscription grant widening");
  const dial = async (creds: string) => {
    const nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds, tls: false }) });
    clients.push(nc); return nc;
  };
  const serving = [await dial(before), await dial(after)];
  const errors: string[] = [];
  const watchers = serving.map(async nc => { for await (const s of nc.status()) if (s.type === "error") errors.push(String(s)); });
  const endpoint = endpointToken("manager");
  const queue = `${endpoint}.${instanceId}.${registered.processEpoch}`;
  let subscriptions = 0;
  for (const rail of ["ep", "ep.v1"]) {
    for (const mode of ["one", "all", "inst"] as const) {
      const filter = `${spacePrefix(space)}.${rail}.${mode}.${endpoint}.${mode === "inst" ? `${instanceId}.` : ""}status.>`;
      const group = mode === "one" ? endpoint : queue;
      const subs = serving.map(nc => nc.subscribe(filter, { queue: group, callback: assert.ifError }));
      await Promise.all(serving.map(nc => nc.flush()));
      // A PONG follows the SUB processing. Let the status iterators consume any broker refusal.
      await new Promise(r => setTimeout(r, 50));
      assert.deepEqual(errors, [], `${rail}/${mode} same-instance same-epoch queue must be broker-authorized`);
      subscriptions += subs.length;
      subs.forEach(sub => sub.unsubscribe());
      await Promise.all(serving.map(nc => nc.flush()));
      console.log(JSON.stringify({ rail, mode, instanceId, epoch: registered.processEpoch, queue: group, authorizedSubscriptions: subs.length }));
    }
  }
  await assert.rejects(() => issue({ ...renewalRequest, requestId: mintLifecycleUid(), processEpoch: registered.processEpoch + 1 }), /epoch|registration|proof/i);
  await Promise.all(serving.map(nc => nc.close()));
  await Promise.all(watchers);
  assert.deepEqual(errors, [], "broker accepts every issued-credential subscription");
  console.log(JSON.stringify({ result: "PASS", productionPath: "openAuthAuthorityPlane.issueManagerServiceAuthority", phases: ["prepare", "activate", "renewStandingBundle"], subscriptions, grantsUnchanged: true }));
} finally {
  await Promise.all(clients.map(nc => nc.close()));
  await plane?.close();
  await fx.close();
}
