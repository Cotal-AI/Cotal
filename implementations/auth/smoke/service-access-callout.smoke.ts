import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { decode } from "@nats-io/jwt";
import { createServer } from "@nats-io/nkeys";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createSpaceAuth, createEndpointStreams, endpointRegistrationBarrier, mintLifecycleUid, registerServiceInstance,
  serverConfig, isReachable, contractDigest, serviceEndpointActor, newIdentity, mintAccountCensusCreds,
  observeAccountCensusWithCreds, accountCensusInboxPrefix, connzRequestSubject, credsClaims, mintMembershipObserverCreds, type ServiceRegistrationWitness } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createCalloutAuth, startAuthCallout, type StartAuthCalloutOpts } from "../src/callout.js";
import { createUserTokenIssuer, generateSigningKey } from "../src/issuer.js";
import { validateUserToken } from "../src/token.js";
import { pickFreePort } from "./_free-port.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { openLifecycleRegistry, reserveLifecycleUid, registryStores } from "../src/lifecycle-registry.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { openConnectReader } from "../src/connect-reader.js";
import { bindNativeServiceName, nativeServiceNameAuthority } from "../src/native-service-name.js";
import { approveNativeServiceGate, createPendingServiceGate, markNativeServiceActivated, readNativeServiceGate } from "../src/native-service-gate.js";
import { createNativeServiceCalloutAuthority } from "../src/native-service-callout.js";
import { readNativeIssuance } from "../src/native-issuance.js";
import { credRowKey, markLedgerRowRevoked } from "../src/credential-ledger.js";

const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`, space = `service-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"),
  extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const exited = new Promise<void>((resolve, reject) => { srv.once("exit", () => resolve()); srv.once("error", reject); });
const issuer = createUserTokenIssuer({ issuer: "https://service-access.test", key: await generateSigningKey() });
const owner = `u_${"a".repeat(26)}`, instanceId = "i".repeat(32), endpoint = "org.example.orders";
const identity = { accountPublicKey: auth.account.pub, space, owner, endpoint, instanceId };
const witness: ServiceRegistrationWitness = { accountPublicKey: auth.account.pub, space, endpoint, instanceId,
  principal: { owner, actor: serviceEndpointActor(identity), lifecycleUid: "l".repeat(32) }, rootCredentialId: "r".repeat(32),
  approvalDigest: contractDigest({ approval: 1 }), processEpoch: 1, registrationRevision: 2, nameAuthorityRevision: 1,
  registrationRequestId: "a".repeat(32), registrationProof: contractDigest({ registration: 1 }) };
const enc = (s: string) => new TextEncoder().encode(s);
const conns: NatsConnection[] = [], hooks: string[] = [], logs: string[] = [];
let setup: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
const nonces = new WeakMap<NatsConnection, string>();
const dial = async (bearer: string) => {
  const nonce = randomUUID().replaceAll("-", "");
  const nc = await connect({ servers, name: nonce, inboxPrefix: `_INBOX_${nonce}`, timeout: 4000, reconnect: false, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearer)] });
  conns.push(nc); nonces.set(nc, nonce); return nc;
};
try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) { up = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(up, "owned broker becomes ready");
  const nc = await connect({ servers, authenticator: credsAuthenticator(enc(callout.calloutCreds)) }); conns.push(nc);
  const options: StartAuthCalloutOpts = {
    xkeySeed: callout.xkey.seed, authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, space,
    token: { issuer: issuer.issuer, key: issuer.localKeySet() },
    // Deliberately permissive ordinary hooks: the service view must never reach them.
    authorizeActor: () => { hooks.push("actor"); },
    permissionsFor: (_token, nonce) => { hooks.push("permissions"); return { pub: { allow: [`_INBOX_${nonce}.>`] }, sub: { allow: [`_INBOX_${nonce}.>`] } }; },
    recordIssuance: async () => { hooks.push("record"); }, onMint: () => { hooks.push("mint"); }, log: (line) => logs.push(line),
  };
  startAuthCallout(nc as never, options);
  await nc.flush();
  await dial(await issuer.issue({ owner, actor: "control", space, ttlSec: 60 }));
  assert.deepEqual(hooks, ["actor", "permissions", "record", "mint"], "ordinary control reaches its normal hooks");
  hooks.length = 0;
  const serviceBearer = await issuer.issueServiceAccess({ witness, expiresAt: Math.floor(Date.now() / 1000) + 45 });
  await validateUserToken(serviceBearer, { issuer: issuer.issuer, audience: space, key: issuer.localKeySet() });
  await assert.rejects(dial(serviceBearer), /authorization violation/i);
  assert.deepEqual(hooks, [], "service refusal precedes every ordinary hook and native mint");
  assert.ok(logs.some((line) => line.includes("requires dedicated native service authority")), "denial reaches the intended service boundary");
  await nc.close();
  const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
  setup = await openAuthorityClient({ server: servers, space, dataAccount, label: "service-callout-fixture",
    grants: (nonce) => ({ publish: [">"], subscribe: [`_INBOX_${nonce}.>`] }), log: () => {} });
  await createEndpointStreams(await jetstreamManager(setup.nc), new Kvm(setup.nc), space);
  const reg = await openLifecycleRegistry(setup.nc, space), stores = registryStores(reg);
  const actor = serviceEndpointActor(identity), lifecycleUid = await reserveLifecycleUid(reg, { owner, actor, mintedBy: "service-fixture" });
  const binding = { ...identity, lifecycleUid, assignmentDigest: contractDigest({ identity, lifecycleUid }) };
  const name = await bindNativeServiceName(reg, identity, { v: 1, kind: "service-endpoint-host", operation: "name-bind", requestId: "a".repeat(32),
    granter: { kind: "operator", auditId: "fixture-operator" }, input: { endpoint, owner, expectedRevision: 0, claimReference: "fixture-namespace" } });
  let gate = await createPendingServiceGate(reg, binding);
  const rootCredentialId = await ensureRootCredential(reg, { owner, actor, lifecycleUid, managerInstance: "service-fixture" });
  gate = await approveNativeServiceGate(reg, binding, { expectedRevision: gate.revision, rootCredentialId,
    approvalDigest: contractDigest({ approval: binding.assignmentDigest }), nameAuthorityRevision: name.revision, approvalExpiresAt: null, callerCeiling: [] });
  const schema = { type: "object" }, document = { urn: endpoint, revision: 1, attributes: [], events: [], commands: [{ name: "read",
    class: "ephemeral", targeted: false, capability: "orders.read", inputDigest: contractDigest(schema), outputDigest: contractDigest(schema) }] };
  const manifest = { v: 1, root: contractDigest(document), members: [] };
  const artifacts = new Map([schema, document, manifest].map((artifact) => [contractDigest(artifact), artifact]));
  const readClusterArtifact = (digest: string) => artifacts.get(digest);
  await registerServiceInstance(stores.recordsKv, { space, instanceId, spec: { endpoint, owner, clusterDigests: [contractDigest(manifest)], protocol: { v: 1 } },
    registrant: { owner }, authority: nativeServiceNameAuthority(reg, identity), readClusterArtifact,
    barrier: endpointRegistrationBarrier(stores.authKv, space, { endpoint, instanceId, opId: mintLifecycleUid(),
      serviceRegistration: { requestId: "b".repeat(32), requestDigest: contractDigest({ registration: manifest }) } }) });
  gate = (await readNativeServiceGate(reg, binding))!;
  const stamp = gate.row.serviceAuthority.registration!;
  const actualWitness: ServiceRegistrationWitness = { accountPublicKey: auth.account.pub, space, endpoint, instanceId,
    principal: { owner, actor, lifecycleUid }, rootCredentialId, approvalDigest: gate.row.serviceAuthority.approvalDigest!,
    processEpoch: gate.row.processEpoch, registrationRevision: gate.row.registrationRevision, nameAuthorityRevision: name.revision,
    registrationRequestId: stamp.requestId, registrationProof: stamp.registrationProof };
  await markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness: actualWitness });
  const reader = await openConnectReader(setup.nc, space);
  let open = true;
  const serviceAuthority = createNativeServiceCalloutAuthority({ registry: reg, reader: () => reader, dataAccount,
    resolveAssignment: async () => binding, readClusterArtifact, assertOpen: () => { if (!open) throw new Error("fixture authority fenced"); } });
  assert.throws(() => startAuthCallout({ subscribe: () => { throw new Error("must not subscribe"); } } as never,
    { ...options, serviceAuthority: { space, accountPublicKey: auth.account.pub } }), /not native/);
  const servingCallout = await connect({ servers, authenticator: credsAuthenticator(enc(callout.calloutCreds)) }); conns.push(servingCallout);
  const serverId = servingCallout.info?.server_id;
  assert.equal(typeof serverId, "string");
  const mints: Array<{ jwt: string; principal: string; exp: number }> = [];
  startAuthCallout(servingCallout as never, { ...options, serviceAuthority, expectedServerIds: [serverId!], onMint: (mint) => { mints.push(mint); } });
  await servingCallout.flush();
  const actualBearer = await issuer.issueServiceAccess({ witness: actualWitness, expiresAt: Math.floor(Date.now() / 1000) + 45 });
  const service = await dial(actualBearer); await service.flush();
  assert.deepEqual(hooks, [], "native service acceptance never uses ordinary actor, permissions or recorder hooks");
  assert.equal(mints.length, 1);
  const firstKey = decode(mints[0]!.jwt).sub;
  assert.ok(typeof firstKey === "string");
  const receipt = (await readNativeIssuance(stores.authKv, firstKey))!;
  assert.deepEqual(receipt.service!.witness, actualWitness);
  assert.equal(receipt.service!.connection.userNkey, firstKey);
  assert.equal(receipt.service!.connection.serverId, serverId);
  assert.equal(receipt.service!.connection.clientId, service.info?.client_id, "native receipt identifies the accepted broker connection");
  assert.equal(receipt.connId, nonces.get(service));
  await service.close();
  const reconnect = await dial(actualBearer); await reconnect.flush();
  assert.equal(mints.length, 2);
  const secondKey = decode(mints[1]!.jwt).sub;
  assert.ok(typeof secondKey === "string");
  assert.notEqual(secondKey, firstKey, "reconnect after disconnect preserves registration but records a new broker key");
  const secondReceipt = (await readNativeIssuance(stores.authKv, secondKey))!;
  assert.equal(secondReceipt.service!.connection.clientId, reconnect.info?.client_id);
  assert.equal(secondReceipt.service!.connection.serverId, serverId);
  const censusCreds = await mintAccountCensusCreds(auth, newIdentity(), { expiresInSeconds: 120 });
  const censusClaims = credsClaims(censusCreds);
  assert.deepEqual(censusClaims.nats?.pub, { allow: [connzRequestSubject(auth.account.pub)] });
  assert.deepEqual(censusClaims.nats?.sub, { allow: [`${accountCensusInboxPrefix(auth.account.pub)}.>`] });
  const censusOpts = { servers, observerCreds: censusCreds, accountId: auth.account.pub, expectedServerId: serverId! };
  const census = await observeAccountCensusWithCreds(censusOpts);
  assert.equal(census.state, "complete", "census-only credential reads the real pinned account page");
  assert.ok(census.connections.some((c) => c.serverId === serverId && c.cid === reconnect.info?.client_id && c.principal === `${owner}.${actor}`));
  assert.ok(!census.connections.some((c) => c.cid === service.info?.client_id), "disconnected connection is absent from the pinned page");
  assert.ok(census.connections.every((c) => c.userNkey === undefined || c.userNkey.startsWith("U")), "principal names are not reported as user keys");
  const limited = await observeAccountCensusWithCreds({ ...censusOpts, options: { pageLimit: 1 } });
  assert.deepEqual(limited.state === "unknown" ? limited.reason : limited.state, "incomplete-page", "partial page cannot be called complete");
  const wrongServer = await observeAccountCensusWithCreds({ ...censusOpts, expectedServerId: createServer().getPublicKey() });
  assert.equal(wrongServer.state === "unknown" ? wrongServer.reason : wrongServer.state, "unsupported-topology");
  const legacyObserver = await mintMembershipObserverCreds(auth, newIdentity(), { expiresInSeconds: 120 });
  await assert.rejects(observeAccountCensusWithCreds({ ...censusOpts, observerCreds: legacyObserver }), /account-scoped/);
  await assert.rejects(mintAccountCensusCreds({ account: auth.account, sys: { pub: auth.sys.pub } }, newIdentity()), /registered system-account signer/);
  await assert.rejects(mintAccountCensusCreds(auth, newIdentity(), { expiresAt: 0 }), /bounded future/);
  await assert.rejects(mintAccountCensusCreds(auth, newIdentity(), { expiresInSeconds: 31 * 86400 }), /bounded future/);
  const shortExpiry = Math.floor(Date.now() / 1000) + 3;
  const expiring = await dial(await issuer.issueServiceAccess({ witness: actualWitness, expiresAt: shortExpiry }));
  assert.equal(mints.length, 3);
  assert.equal(mints[2]!.exp, shortExpiry);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reason = await Promise.race([expiring.closed(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("native service JWT expiry did not close the connection")), 8000);
    })]);
    assert.match(String(reason), /expired/i, "broker closes the admitted service connection on authentication expiry");
    assert.ok(Date.now() >= shortExpiry * 1000);
  } finally { clearTimeout(timer); }

  open = false;
  await assert.rejects(dial(actualBearer), /authorization violation/i);
  open = true;
  await markLedgerRowRevoked(stores.authKv, credRowKey(lifecycleUid, rootCredentialId));
  await assert.rejects(dial(actualBearer), /authorization violation/i);
  assert.equal(mints.length, 3, "fenced or revoked native authority never releases another mint");
  assert.deepEqual(hooks, []);
  const afterExpiry = await observeAccountCensusWithCreds(censusOpts);
  assert.equal(afterExpiry.state, "complete");
  assert.ok(!afterExpiry.connections.some((c) => c.cid === expiring.info?.client_id), "expired service connection is absent from the pinned page");
  await setup.close(); setup = undefined;
  for (const connection of conns) await connection.close();
  const empty = await observeAccountCensusWithCreds(censusOpts);
  assert.equal(empty.state, "complete");
  assert.deepEqual(empty.connections, [], "empty account has a complete empty page, without a retirement verdict");
  console.log("service access callout: default refusal and ordinary control preserved; native registered service connected, disconnected/reconnected and expired through encrypted auth with exact broker receipts, then deny-new checked; account-qualified pinned census and incomplete-page refusal checked; public approval and terminal retirement not exercised");
} finally {
  await setup?.close();
  for (const nc of conns.reverse()) await nc.close().catch(() => {});
  srv.kill("SIGKILL"); await exited;
  rmSync(dir, { recursive: true, force: true }); releaseBroker();
}
