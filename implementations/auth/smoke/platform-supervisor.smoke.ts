import assert from "node:assert/strict";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  readAcceptedRow, connectionAcceptedToken, importNativeSubjectPermissions,
  epAuthBucket, epgateKey, mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams, standaloneConnectOpts,
  type RemoteManagerAuthorityMaterial, type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { Kvm } from "@nats-io/kv";
import { managerClusterArtifacts, registerRemoteManagerAuthority, remoteManagerClient } from "../../manager/dist/index.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import type { AuthServiceHandle, PlatformSupervisorAssignment, PlatformSupervisorAuthorityRequest } from "../src/index.js";
import { authorityBarrierGrants, openAuthorityClient, remoteManagerRegistrationProof } from "../src/authority-client.js";
import { withIssuerSession } from "@cotal-ai/core";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { startAuthService } = process.argv.includes("--built-auth")
  ? await import("../dist/index.js")
  : await import("../src/index.js");

const names = [
  "U7-1 registration attributes the manager to owner A",
  "U7-2 an owner A issuance refuses a request naming owner B",
  "U7-3 the supervisor credential cannot mint",
  "U7-4 supervisor material cannot exchange for a human view",
  "U7-5 signed permissions stay identical on renewal",
  "U7-6 a caller without platform-admin cannot obtain issuance",
  "U7-7 recorded lifecycle expiry refuses renewal and registration",
];
let passed = 0;
let failed = 0;
async function cell(index: number, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${names[index]}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${names[index]}`); console.error(error instanceof Error ? error.message : "unknown failure"); }
}
function claims(jwt: string): { exp: number; nats: { pub: unknown; sub: unknown; tags: string[] } } {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
}
const fx = await startHostedAuthFixture("u7-supervisor", 1);
let service: AuthServiceHandle | undefined;
let admin = true;
const a = fx.accounts[0]!;
const owner = `u_${"a".repeat(26)}`;
const other = `u_${"b".repeat(26)}`;
const state = remoteManagerClient.loadOrCreateRemoteManagerIdentity(join(fx.dir, "mgr"), a.space);
const assignment: PlatformSupervisorAssignment = {
  v: 1, kind: "platform-supervisor", owner, space: a.space, accountPublicKey: a.accountPublicKey,
  instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, revision: 1, state: "assigned",
  expiresAt: Math.floor(Date.now() / 1000) + 30, scope: ["supervise"],
};
const stateB = remoteManagerClient.loadOrCreateRemoteManagerIdentity(join(fx.dir, "mgr-b"), a.space);
const assignmentB: PlatformSupervisorAssignment = { ...assignment, owner: other, instanceId: stateB.instanceId, lifecycleUid: stateB.lifecycleUid };
let prepared: RemoteManagerAuthorityMaterial | undefined;
let activated: RemoteManagerAuthorityMaterial | undefined;
let registered: Awaited<ReturnType<typeof registerRemoteManagerAuthority>> | undefined;
let door: ((request: PlatformSupervisorAuthorityRequest) => Promise<RemoteManagerAuthorityMaterial>) | undefined;
let reader: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
const wrap = (request: RemoteManagerAuthorityRequest): PlatformSupervisorAuthorityRequest => ({ v: 1, kind: "platform-supervisor-authority", owner, assignmentRevision: 1, request });
const call = (request: RemoteManagerAuthorityRequest) => door!(wrap(request));
try {
  const creds = await mintCreds(a.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds });
  reader = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.accountPublicKey, signingSeed: a.auth.account.signingSeed! }, label: "u7-test-reader", grants: (id) => authorityBarrierGrants(a.space, id), log: () => {} });
  service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space,
    servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity,
    platformSupervisor: { authorizePlatformAdmin: async () => admin, observeAssignment: async (requestedOwner) => requestedOwner === other ? assignmentB : assignment },
  });
  door = await service.platformSupervisorAuthority!(owner);
  await cell(0, async () => {
    prepared = await call(remoteManagerClient.remoteManagerAuthorityRequest(state, "cli", "prepare"));
    assert.equal(prepared.owner, owner);
    registered = await registerRemoteManagerAuthority({
      space: a.space, server: fx.servers, owner: prepared.owner, instanceId: state.instanceId,
      serveActor: prepared.actors.serve, prepareCreds: remoteManagerClient.materialCredential(prepared, "executor", state.identities.executor),
      tlsRequired: false, evict: async () => [],
    });
    const artifacts = managerClusterArtifacts();
    const contractArtifacts = [artifacts.document, artifacts.manifest];
    const registrationProof = remoteManagerRegistrationProof(owner, state, contractArtifacts);
    activated = await call(remoteManagerClient.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof, contractArtifacts }));
    assert.equal(activated.owner, owner);
    const gate = await (await new Kvm(reader!.nc).open(epAuthBucket(a.space))).get(epgateKey("manager", state.instanceId));
    assert.ok(gate);
    assert.equal((JSON.parse(new TextDecoder().decode(gate.value)) as { principal: string }).principal, `${owner}.${prepared.actors.serve}`);
    const serve = await connect({servers:fx.servers,...standaloneConnectOpts({creds:remoteManagerClient.materialCredential(activated,"serve",state.identities.serve),tls:false})});
    await serve.close();
  });
  await cell(1, async () => {
    await assert.rejects(door!({ ...wrap(remoteManagerClient.remoteManagerAuthorityRequest(stateB, "cli", "prepare")), owner: other }),
      (error: Error) => error.message.includes(owner) && error.message.includes(other));
    await assert.rejects(door!({ ...wrap(remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare")), request: { ...remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare"), owner: other } } as PlatformSupervisorAuthorityRequest), /unknown field.*owner/);
  });
  await cell(2, async () => {
    assert.ok(prepared);
    const nc = await connect({servers:fx.servers,...standaloneConnectOpts({creds:remoteManagerClient.materialCredential(prepared,"supervisor",state.identities.supervisor),tls:false})});
    try {
      let denied = false;
      const statuses = (async () => { for await (const event of nc.status()) if (event.type === "error" && String(event.error).includes("Permissions")) denied = true; })();
      nc.publish(`$KV.cotal_actors_${a.space}.forged`, new TextEncoder().encode("{}"));
      await nc.flush();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(denied, "broker must refuse generic actor-ledger writes");
      await nc.close(); await statuses;
      await assert.rejects(door!({ ...wrap(remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare")), request:{...remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare"), profile:"provisioner"} } as PlatformSupervisorAuthorityRequest),/unknown field.*profile/);
    } finally { await nc.close(); }
  });
  await cell(3, async () => {
    assert.ok(prepared);
    const response = await fetch(`${service!.url}/exchange`, { method:"POST", headers:{"content-type":"application/json",authorization:`Bearer ${service!.cap}`}, body:JSON.stringify({idpToken:prepared.credentials.supervisor!.jwt,actor:"cli",view:"admin"}) });
    assert.equal(response.status,401);
    const result = await response.json() as {token?:unknown; error?:string};
    assert.equal(result.token,undefined);
    assert.match(result.error??"",/algorithm|alg|not allowed|key|JWT|issuer/i);
    await assert.rejects(door!({...wrap(remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare")),view:"admin"} as PlatformSupervisorAuthorityRequest),/unknown field.*view/);
  });
  await cell(4, async () => {
    assert.ok(prepared && activated && registered);
    const registrationProof = remoteManagerClient.currentRegistrationProof(activated);
    const renewalRequest = remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","renewStandingBundle",{registrationProof});
    renewalRequest.accountPublicKey = a.accountPublicKey; renewalRequest.processEpoch = registered.processEpoch;
    const renewed = await call(renewalRequest);
    for (const key of ["supervisor","executor","serve","goalWriter","sessionLedger"] as const) {
      const original: { jwt: string; exp: number } = key === "supervisor" || key === "executor" ? prepared.credentials[key]! : activated.credentials[key]!;
      const next = renewed.credentials[key]!;
      assert.deepEqual(claims(next.jwt).nats.pub,claims(original.jwt).nats.pub,`${key} publish permissions must not widen`);
      assert.deepEqual(claims(next.jwt).nats.sub,claims(original.jwt).nats.sub,`${key} subscribe permissions must not widen`);
      assert.ok(next.exp <= assignment.expiresAt,"every credential must end with its recorded lifecycle");
    }
    assert.deepEqual(assignment.scope,["supervise"]);
    await withIssuerSession({servers:fx.servers,space:a.space,auth:a.auth,tls:false},async(session)=>{
      for (const duty of ["supervisor","executor"] as const) {
        const token = connectionAcceptedToken(`platform-supervisor:${owner}:${state.instanceId}:${state.lifecycleUid}:${duty}`);
        const ref = await readAcceptedRow(session.nc,a.space,token);
        const resolved = await session.store.resolve(ref,session.sourceIsLive);
        const recorded = JSON.stringify(resolved.evidence.permissions);
        for (const material of [prepared!, renewed]) {
          const signed = claims(material.credentials[duty]!.jwt).nats;
          assert.equal(recorded, JSON.stringify(importNativeSubjectPermissions({ pub: signed.pub, sub: signed.sub })),
            `${duty} recorded permissions must be byte-identical to the signed permissions before and after renewal`);
        }
        assert.equal(resolved.evidence.ref.owner,owner);
      }
    });
    const changed = remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare");
    changed.identities.supervisor = {id:newIdentity().id};
    await assert.rejects(call(changed),/different ceiling/);
  });
  await cell(5, async () => {
    admin = false;
    try {
      await assert.rejects(service!.platformSupervisorAuthority!(owner),/platform-admin/);
      await assert.rejects(call(remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare")),/platform-admin/);
    } finally { admin = true; }
  });
  await cell(6, async () => {
    assert.ok(prepared && activated);
    assignment.state = "ended";
    try {
      await assert.rejects(call(remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare")),/lifecycle has ended/);
      const registrationProof = remoteManagerClient.currentRegistrationProof(activated);
      await assert.rejects(call(remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","renew",{registrationProof})),/lifecycle has ended/);
    } finally { assignment.state = "assigned"; }
    assignment.expiresAt = Math.floor(Date.now()/1000) + 2;
    // Obtain actual short-lived prepare material, then wait for its recorded lifecycle.
    const short = await call(remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare"));
    await new Promise((resolve) => setTimeout(resolve, 3100));
    const registrationProof = remoteManagerClient.currentRegistrationProof(activated);
    await assert.rejects(call(remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","renew",{registrationProof})),/lifecycle has ended/);
    await assert.rejects(call(remoteManagerClient.remoteManagerAuthorityRequest(state,"cli","prepare")),/lifecycle has ended/);
    await assert.rejects(registerRemoteManagerAuthority({
      space:a.space,server:fx.servers,owner,instanceId:state.instanceId,serveActor:short.actors.serve,
      prepareCreds:remoteManagerClient.materialCredential(short,"executor",state.identities.executor),tlsRequired:false,evict:async()=>[],
    }),/expir|Authorization/i);
  });
} finally {
  await service?.close(); await reader?.close(); await fx.close();
}
console.log(`platform supervisor: ${passed}/${names.length} cells passed, ${failed} failed`);
emitSentinel({passed,failed});
if (failed) process.exit(1);
