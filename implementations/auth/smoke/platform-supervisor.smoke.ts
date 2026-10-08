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
  "U7-8 an ended assignment refuses registration, activation and renewal with held unexpired material",
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
const ended = `u_${"c".repeat(26)}`;
const stateC = remoteManagerClient.loadOrCreateRemoteManagerIdentity(join(fx.dir, "mgr-c"), a.space);
const assignmentC: PlatformSupervisorAssignment = { ...assignment, owner: ended, instanceId: stateC.instanceId, lifecycleUid: stateC.lifecycleUid, expiresAt: Math.floor(Date.now() / 1000) + 300 };
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
    platformSupervisor: { authorizePlatformAdmin: async () => admin, observeAssignment: async (requestedOwner) => requestedOwner === other ? assignmentB : requestedOwner === ended ? { ...assignmentC } : assignment },
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
      // Effect: the issuer behind the door can mint a transfer-reader credential for this owner and
      // instance. The door must refuse that operation, so no new credential reaches the broker.
      const transferIdentity = newIdentity();
      let minted: RemoteManagerAuthorityMaterial | undefined;
      try {
        minted = await call(remoteManagerClient.remoteManagerAuthorityRequest(state, "cli", "transferReader", {
          registrationProof: remoteManagerRegistrationProof(owner, state), transferReader: { id: transferIdentity.id },
        }));
      } catch (error) {
        assert.match(error instanceof Error ? error.message : "", /operation transferReader is outside manager registration and renewal/);
      }
      if (minted) {
        const leaked = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: remoteManagerClient.materialCredential(minted, "transferReader", transferIdentity), tls: false }) });
        await leaked.close();
        assert.fail("the supervisor door minted a transfer-reader credential that the broker accepted");
      }
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
  await cell(7, async () => {
    const doorC = await service!.platformSupervisorAuthority!(ended);
    const callC = (request: RemoteManagerAuthorityRequest) => doorC({ v: 1, kind: "platform-supervisor-authority", owner: ended, assignmentRevision: 1, request });
    const held = await callC(remoteManagerClient.remoteManagerAuthorityRequest(stateC, "cli", "prepare"));
    const register = () => registerRemoteManagerAuthority({
      space: a.space, server: fx.servers, owner: ended, instanceId: stateC.instanceId, serveActor: held.actors.serve,
      prepareCreds: remoteManagerClient.materialCredential(held, "executor", stateC.identities.executor),
      tlsRequired: false, evict: async (principals) => principals.map(() => true),
    });
    const registeredC = await register();
    const artifacts = managerClusterArtifacts();
    const contractArtifacts = [artifacts.document, artifacts.manifest];
    const activationProof = remoteManagerRegistrationProof(ended, stateC, contractArtifacts);
    const activatedC = await callC(remoteManagerClient.remoteManagerAuthorityRequest(stateC, "cli", "activate", { registrationProof: activationProof, contractArtifacts }));
    const now = Math.floor(Date.now() / 1000);
    assert.ok(held.credentials.executor!.exp > now + 60, "the held executor credential must still be unexpired");
    // The platform records the assignment ended, then ends its issuance at the authority plane.
    assignmentC.state = "ended";
    assignmentC.revision = 2;
    await service!.endPlatformSupervisorAssignment!(ended);
    const renewal = remoteManagerClient.remoteManagerAuthorityRequest(stateC, "cli", "renewStandingBundle", { registrationProof: remoteManagerClient.currentRegistrationProof(activatedC) });
    renewal.accountPublicKey = a.accountPublicKey; renewal.processEpoch = registeredC.processEpoch;
    const refusals: string[] = [];
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try { await fn(); refusals.push(`${label}: SUCCEEDED`); }
      catch (error) { refusals.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    // A stale host read that still reports the old revision as assigned must not reopen anything.
    for (const hostView of ["ended", "stale-assigned"] as const) {
      if (hostView === "stale-assigned") { assignmentC.state = "assigned"; assignmentC.revision = 1; }
      await attempt(`${hostView} registration`, register);
      await attempt(`${hostView} activate`, () => callC(remoteManagerClient.remoteManagerAuthorityRequest(stateC, "cli", "activate", { registrationProof: activationProof, contractArtifacts })));
      await attempt(`${hostView} renewal`, () => callC(renewal));
    }
    // Held executor material still holds a plain put on its own gate row. Rewriting the retired gate
    // open must not reopen the authority plane: the retired issued generations refuse every door.
    const heldNc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: remoteManagerClient.materialCredential(held, "executor", stateC.identities.executor), tls: false }) });
    try {
      const authKv = await new Kvm(heldNc).open(epAuthBucket(a.space));
      const gateKey = epgateKey("manager", stateC.instanceId);
      const retired = JSON.parse(new TextDecoder().decode((await authKv.get(gateKey))!.value)) as Record<string, unknown>;
      assert.equal(retired.state, "retired");
      delete retired.op;
      await authKv.put(gateKey, new TextEncoder().encode(JSON.stringify({ ...retired, state: "open" })));
    } finally { await heldNc.close(); }
    await attempt("rewritten-gate activate", () => callC(remoteManagerClient.remoteManagerAuthorityRequest(stateC, "cli", "activate", { registrationProof: activationProof, contractArtifacts })));
    await attempt("rewritten-gate renewal", () => callC(renewal));
    await attempt("rewritten-gate prepare", () => callC(remoteManagerClient.remoteManagerAuthorityRequest(stateC, "cli", "prepare")));
    const named = (line: string) => line.includes("registration: ")
      ? /issuance gate for "[^"]+" is retired/.test(line)
      : line.includes(`platform supervisor assignment for owner ${ended} has ended`);
    const leaked = refusals.filter((line) => line.endsWith("SUCCEEDED") || !named(line));
    assert.deepEqual(leaked, [], `every door must refuse held material by naming the ended assignment:\n${refusals.join("\n")}`);
  });
} finally {
  await service?.close(); await reader?.close(); await fx.close();
}
console.log(`platform supervisor: ${passed}/${names.length} cells passed, ${failed} failed`);
emitSentinel({passed,failed});
if (failed) process.exit(1);
