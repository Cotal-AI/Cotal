/** Real owned broker/callout acceptance for generic user-auth endpoint caller issuance.
 * Fixture IdP and endpoint, no provider/Cloud traffic. --baseline expects missing caller reach.
 * This suite changes no shipped implementation and performs no mutation/reversion. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { authorizeServeGrant, compileContract, contractArtifactCanonicalBytes, contractDigest, contractStoreContext, epAuthBucket,
  invokeCommand, mintCreds, newIdentity, publishContractArtifact, recordSpecKey, RECORD_KINDS, resolveService, serveEndpoint,
  setupSpaceStreams, singleDocumentClosure, type ServiceAuthorityRequest, type ServiceAuthorityResult, type ServiceRegistrationWitness } from "@cotal-ai/core";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { SERVICE_CALLER_PAYLOAD_FLOOR } from "../src/service-caller-payload.js";
import { createHash } from "node:crypto";
import { grantActor, findInteractiveActor, revokeActor, grantManagedActor } from "../src/ledger.js";
import { ensurePinnedIdp, loadOwnerSecret } from "../src/store.js";
import { deriveOwnerForIdpSubject } from "../src/derive.js";
import { startAuthService, type AuthServiceHandle } from "../src/service.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { checks } from "./_service-custody-fixture.js";

const baseline = process.argv.includes("--baseline"), second = process.argv.includes("--second"), c = checks(), rid = () => randomBytes(16).toString("hex");
const enc = new TextEncoder();
const fx = await startHostedAuthFixture("callerissue", 1, baseline ? {} : { maxPayload: SERVICE_CALLER_PAYLOAD_FLOOR }), a = fx.accounts[0]!;
const { publicKey, privateKey } = await generateKeyPair("EdDSA"), jwk = { ...await exportJWK(publicKey), kid: "caller-fixture" };
const idp = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>(r => idp.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
const stateDir = join(fx.dir, "caller-state"); mkdirSync(stateDir);
ensurePinnedIdp(stateDir, `${origin}/api/auth`);
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "human");
grantActor(stateDir, { owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
const callerRow = grantActor(stateDir, { owner, actor: "caller", scope: [], allowSubscribe: [], allowPublish: [] });
const strangerRow = grantActor(stateDir, { owner, actor: "stranger", scope: [], allowSubscribe: [], allowPublish: [] });
const managedToken = rid(), managedUid = rid();
const managedRow = grantManagedActor(stateDir, { owner, actor: "managed", lifecycleUid: managedUid, parent: `${owner}.caller`,
  scope: [], allowSubscribe: [], allowPublish: [], tokenHash: createHash("sha256").update(managedToken).digest("hex"), custody: { kind: "foreground" } });
const idpToken = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject("human").setIssuedAt().setExpirationTime("10m").sign(privateKey);
let service: AuthServiceHandle | undefined, admin: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
const connections: NatsConnection[] = [];
let serve: ReturnType<typeof serveEndpoint> | undefined, runs = 0;
try {
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: "caller-fixture" }, space: a.space,
    servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir, serviceEndpoints: { startup: { kind: "normal" } } });
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${service!.url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify(body) });
    const out = await r.json() as Record<string, any>;
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${out.error ?? out.reason ?? "refused"}`);
    return out;
  };
  const host = service.serviceEndpointHost!;
  const endpoint = second ? "org.example.calculator" : "org.example.generic-caller", instanceId = rid(), command = second ? "square" : "ping";
  const schemaRoot = second ? { type: "object", additionalProperties: false, properties: { n: { type: "number" } }, required: ["n"] }
    : { type: "object", additionalProperties: false };
  const schema = singleDocumentClosure(schemaRoot), compiled = compileContract({ root: schemaRoot });
  const outputRoot = second ? { type: "object", additionalProperties: false, properties: { squared: { type: "number" } }, required: ["squared"] } : schemaRoot;
  const output = singleDocumentClosure(outputRoot), outputCompiled = compileContract({ root: outputRoot });
  const document = { urn: endpoint, revision: 1, attributes: [], events: [], commands: [{ name: command, class: "ephemeral", targeted: false,
    capability: "read", inputDigest: schema.closureDigest, outputDigest: output.closureDigest }] };
  const cluster = singleDocumentClosure(document);
  const request = (operation: string, fields: object): ServiceAuthorityRequest => ({ v: 1, kind: "service-endpoint-authority", operation, requestId: rid(),
    accountPublicKey: a.accountPublicKey, space: a.space, endpoint, instanceId, ...fields }) as ServiceAuthorityRequest;
  const authority = async (request: ServiceAuthorityRequest) => await post("/service-endpoint-authority", { request, proof: { kind: "idp", token: idpToken } }) as ServiceAuthorityResult;
  const bind = await host({ v: 1, kind: "service-endpoint-host", operation: "name-bind", requestId: rid(), granter: { kind: "operator", auditId: "owned-fixture" },
    input: { endpoint, owner, expectedRevision: 0, claimReference: "owned-fixture-namespace" } });
  assert.equal(bind.state, "bound");
  const registration = request("register", { registration: { clusterDigests: [cluster.closureDigest], contractArtifacts: [cluster.manifest, document] }, expected: { state: "unregistered" } });
  const first = await authority(registration); assert.equal(first.state, "approval-required");
  if (first.state !== "approval-required" || bind.state !== "bound") throw new Error("fixture proposal");
  const proposal = await host({ v: 1, kind: "service-endpoint-host", operation: "proposal-read", requestId: rid(), granter: { kind: "owner", owner }, input: { proposalId: first.proposalId } });
  assert.equal(proposal.state, "present"); if (proposal.state !== "present") throw new Error("fixture proposal read");
  const capability = { endpoint, command, instanceId, instanceOnly: true };
  const approved = await host({ v: 1, kind: "service-endpoint-host", operation: "decide", requestId: rid(), granter: { kind: "owner", owner }, input: {
    proposalId: first.proposalId, expectedProposalRevision: proposal.record.revision, expectedNameRevision: bind.binding.revision, decision: "approve", callerCeiling: [capability] } });
  assert.equal(approved.state, "approved");
  const registered = await authority(registration); assert.equal(registered.state, "registered"); if (registered.state !== "registered") throw new Error("fixture registration");
  const witness: ServiceRegistrationWitness = registered.witness;
  const credential = await authority(request("activate", { witness })); assert.equal(credential.state, "credential"); if (credential.state !== "credential") throw new Error("fixture activate");
  admin = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! },
    label: "caller-fixture-admin", grants: id => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const store = await contractStoreContext(admin.nc, a.space);
  for (const artifact of [schema.manifest, schemaRoot, output.manifest, outputRoot]) await publishContractArtifact(store, contractArtifactCanonicalBytes(artifact));
  const snapshot = credential.snapshot, specKey = recordSpecKey(RECORD_KINDS.svc, [endpoint, instanceId]);
  const grant = await authorizeServeGrant({ get: async key => key === specKey ? { operation: "PUT", value: enc.encode(JSON.stringify(snapshot.spec.value)), revision: snapshot.spec.revision } : null },
    { space: a.space, endpoint, instanceId, epoch: witness.processEpoch, holder: { owner }, authority: { authorize: () => ({ authorized: true, revision: snapshot.name.revision }) },
      readProcessEpoch: () => snapshot.processEpoch, readClusterArtifact: digest => digest === cluster.closureDigest ? cluster.manifest : digest === contractDigest(document) ? document : undefined });
  const nonce = rid(), serving = await connect({ servers: fx.servers, name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc.encode(a.sentinelCreds)), tokenAuthenticator(credential.accessBearer)] }); connections.push(serving);
  serve = serveEndpoint(serving, a.space, grant, [{ command, contract: { input: compiled, output: outputCompiled }, handler: ctx => { runs++; return second ? { squared: Number((ctx.request.args as { n: number }).n) ** 2 } : {}; } }], { public: true });
  await serving.flush();
  await post("/service-endpoint-authority", { request: request("ready", { witness }), proof: { kind: "service-access", token: credential.accessBearer } });
  const grantee = { owner, actor: "caller", lifecycleUid: callerRow.lifecycleUid! };
  // Baseline seeds the already-existing native policy syntax, not substitute broker permissions.
  // Fixed acceptance uses the controlled host append below instead.
  const authKv = await new Kvm(admin.nc).open(epAuthBucket(a.space));
  let grantId = rid();
  if (baseline) {
    await authKv.create(`servicepolicy.${grantee.lifecycleUid}`, enc.encode(JSON.stringify({ v: 1, accountPublicKey: a.accountPublicKey, space: a.space, grantee, grants: [{
      grantId, endpoint, instanceId, serviceApprovalDigest: witness.approvalDigest, capabilities: [capability], parentRefs: [], status: { state: "active" },
      source: { kind: "service-owner", owner, approvalDigest: witness.approvalDigest, nameAuthorityRevision: witness.nameAuthorityRevision } }] })));
  } else {
    // Labelled fixture operator assertion, not a product assertion pass or Cloud prerequisite closure.
    await authKv.create("svchost.payload", enc.encode(JSON.stringify({ v: 1, kind: "service-caller-payload", state: "asserted",
      floor: SERVICE_CALLER_PAYLOAD_FLOOR, assertedAtMs: Date.now(), evidenceDigest: contractDigest({ ownedSingleBroker: fx.servers }) })));
    const granted = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "caller-grant", granter: { kind: "owner", owner }, input: {
      grantee, service: { endpoint, instanceId, approvalDigest: witness.approvalDigest }, capabilities: [capability], expectedPolicyRevision: 0 } });
    assert.equal(granted.state, "granted", JSON.stringify(granted)); if (granted.state !== "granted") throw new Error("caller grant"); grantId = granted.grant.grantId;
    if (!process.argv.includes("--managed-before")) {
      const managedGrant = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "caller-grant", granter: { kind: "owner", owner }, input: {
        grantee: { owner, actor: "managed", lifecycleUid: managedRow.lifecycleUid! }, service: { endpoint, instanceId, approvalDigest: witness.approvalDigest }, capabilities: [capability], expectedPolicyRevision: 0 } });
      assert.equal(managedGrant.state, "granted", JSON.stringify(managedGrant));
      c.check("managed grant captures actual parent lifecycle and immutable covering grant", managedGrant.state === "granted" && managedGrant.grant.parentRefs.length === 1
        && managedGrant.grant.parentRefs[0]!.principal.lifecycleUid === grantee.lifecycleUid);
    }
    if (process.argv.includes("--managed-before")) {
      const managedGrant = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "caller-grant", granter: { kind: "owner", owner }, input: {
        grantee: { owner, actor: "managed", lifecycleUid: managedRow.lifecycleUid! }, service: { endpoint, instanceId, approvalDigest: witness.approvalDigest }, capabilities: [capability], expectedPolicyRevision: 0 } });
      console.log("MANAGED_BEFORE", managedGrant.state, "reason" in managedGrant ? managedGrant.reason : "");
      assert.equal(managedGrant.state, "denied");
    }
  }
  const dial = async (actor: string) => {
    const exchange = await post("/exchange", actor === "managed" ? { owner, actor, actorToken: managedToken } : { idpToken, actor }); const nonce = rid();
    const nc = await connect({ servers: fx.servers, name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0, timeout: 5000,
      authenticator: [credsAuthenticator(enc.encode(a.sentinelCreds)), tokenAuthenticator(exchange.token)] }); connections.push(nc); return nc;
  };
  const invoke = async (actor: string, uid: string) => {
    const nc = await dial(actor); const target = await resolveService(nc, a.space, endpoint, { owner, actor, uid }, { instanceId, deadlineMs: 3000 });
    const reply = await invokeCommand(nc, a.space, target, command, second ? { n: 7 } : {}, { deadlineMs: 3000 });
    if (reply.reply.ok && second) assert.deepEqual(reply.reply.data, { squared: 49 });
    return reply;
  };
  console.log(`CONTRACT endpoint=${endpoint} command=${command} input=${schema.closureDigest} output=${output.closureDigest}`);
  let reached = false;
  try { reached = (await invoke("caller", callerRow.lifecycleUid!)).reply.ok; } catch (e) { console.log(`CALLER_RESULT ${e instanceof Error ? e.message : String(e)}`); }
  c.check(baseline ? "BEFORE active exact policy still has no generic caller resolve/invoke" : "AFTER exact policy reaches endpoint through real user-auth callout resolve/invoke", baseline ? !reached && runs === 0 : reached && runs === 1);
  if (!baseline) {
    let reachedManaged = false; try { reachedManaged = (await invoke("managed", managedRow.lifecycleUid!)).reply.ok; } catch (e) { console.log("MANAGED_RESULT", (e as Error).message); }
    c.check("actual managed actor secret exchange and callout resolves/invokes generic endpoint", reachedManaged && runs === 2);
    let staleRefused = false; try { await invoke("managed", rid()); } catch { staleRefused = true; }
    c.check("managed connection cannot publish as a different caller lifecycle", staleRefused && runs === 2);
    const expectedRuns = runs;
    let refused = false; try { await invoke("stranger", strangerRow.lifecycleUid!); } catch { refused = true; }
    c.check("ungranted lifecycle cannot invoke and handler count unchanged", refused && runs === expectedRuns);
    const revision = (await authKv.get(`servicepolicy.${grantee.lifecycleUid}`))!.revision;
    const revoked = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "caller-revoke", granter: { kind: "owner", owner }, input: { grantee, grantId, expectedPolicyRevision: revision } });
    c.check("controlled revoke confirms deny-new without claiming retirement", "denyNew" in revoked && revoked.denyNew === "landed", revoked);
    refused = false; try { await invoke("caller", callerRow.lifecycleUid!); } catch { refused = true; }
    c.check("revoked new issuance cannot invoke and handler count unchanged", refused && runs === expectedRuns);
    refused = false; try { await invoke("managed", managedRow.lifecycleUid!); } catch { refused = true; }
    c.check("revoked parent grant denies descendant managed issuance", refused && runs === expectedRuns);
    // A fresh actor lifecycle cannot inherit a predecessor policy. This is an ordinary ledger replacement, not a source mutation.
    const previous = findInteractiveActor(stateDir, owner, "caller")!;
    assert.equal(previous.lifecycleUid, grantee.lifecycleUid);
    revokeActor(stateDir, owner, "caller");
    const successor = grantActor(stateDir, { owner, actor: "caller", scope: [], allowSubscribe: [], allowPublish: [] });
    assert.notEqual(successor.lifecycleUid, grantee.lifecycleUid);
    refused = false; try { await invoke("caller", successor.lifecycleUid!); } catch { refused = true; }
    c.check("same-alias successor lifecycle does not inherit predecessor policy", refused && runs === expectedRuns);
  }
} finally {
  await serve?.stop().catch(() => {});
  for (const nc of connections) await nc.close().catch(() => {});
  await admin?.close().catch(() => {}); await service?.close(); await fx.close();
  await new Promise<void>(r => idp.close(() => r()));
}
c.finish(); process.exitCode = c.failed ? 1 : 0;
