import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  epAuthBucket, spacePrefix, mintCreds, mintLifecycleUid, newIdentity,
  parseRemoteEndpointDeregisterRequest, parseRemoteEndpointDeregisterResult, recordsBucket,
  remoteManagerServePrincipal, setupSpaceStreams,
  type RemoteEndpointDeregisterRequest,
} from "@cotal-ai/core";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { openAuthorityClient, type AuthorityClient } from "../src/authority-client.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fx = await startHostedAuthFixture("deregister", 1);
const [account] = fx.accounts;
const pair = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(pair.publicKey), kid: "deregister-test" };
const idp = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
writeFileSync(join(account.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/jwks` }));
let service: AuthServiceHandle | undefined;
let nc: NatsConnection | undefined;
let fixtureClient: AuthorityClient | undefined;
let checks = 0;
const check = (condition: unknown, name: string) => { assert.ok(condition, name); checks++; console.log(`  ✓ ${name}`); };
try {
  await setupSpaceStreams({ servers: fx.servers, space: account.space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  // Fixture-only records simulate registration states. Acceptance also runs real daemon managers.
  fixtureClient = await openAuthorityClient({ server: fx.servers, space: account.space, dataAccount: { pub: account.auth.account.pub, signingSeed: account.auth.account.signingSeed! }, label: "deregister-fixture", log: () => {},
    grants: id => ({ publish: ["$JS.API.INFO", ...[recordsBucket(account.space), epAuthBucket(account.space)].flatMap(b => [`$JS.API.STREAM.INFO.KV_${b}`, `$JS.API.STREAM.MSG.GET.KV_${b}`, `$JS.API.DIRECT.GET.${b}`, `$JS.API.DIRECT.GET.${b}.>`, `$KV.${b}.>`])], subscribe: [`_INBOX_${id}.>`, `${spacePrefix(account.space)}.ep.inst.manager.>`] }),
  });
  nc = fixtureClient.nc;
  const kvm = new Kvm(nc), kv = await kvm.open(recordsBucket(account.space)), authKv = await kvm.open(epAuthBucket(account.space));
  const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(account.store, account.space))!, origin, "member");
  const other = deriveOwnerForIdpSubject((await loadOwnerSecret(account.store, account.space))!, origin, "other");
  const request = (instanceId: string): RemoteEndpointDeregisterRequest => ({ v: 1, kind: "endpoint-deregister", space: account.space, endpoint: "manager", instanceId });
  const seed = async (holder = owner) => {
    const id = mintLifecycleUid();
    const specRevision = await kv.put(`svc.manager.${id}.spec`, new TextEncoder().encode(JSON.stringify({ endpoint: "manager", owner: holder, clusterDigests: [`sha256:${"a".repeat(64)}`], protocol: { v: 1 } })));
    await kv.put(`svc.manager.${id}.status`, new TextEncoder().encode(JSON.stringify({ epoch: 0, state: "ready", observedSpecRevision: specRevision })));
    await authKv.put(`epgate.manager.${id}`, new TextEncoder().encode(JSON.stringify({ state: "open", principal: remoteManagerServePrincipal(holder, id), generation: 1, processEpoch: 0, registrationRevision: specRevision, nameAuthorityRevision: 0 })));
    return id;
  };
  service = await startAuthService({ context: { accountPublicKey: account.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: account.space, servers: fx.servers, store: account.store, storeIdentity: account.store.identity, stateDir: account.stateDir, publicFace: { port: 0, trustedProxy: false } });
  const token = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject("member").setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${service!.publicUrl}/endpoint-deregister`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const first = await seed();
  check((await post({ idpToken: token, request: request(first) })).status === 403, "no current supervise grant refuses before deletion");
  grantActor(account.stateDir, { owner, actor: "cli", scope: ["admin"], allowSubscribe: [], allowPublish: [] });
  check((await post({ idpToken: token, request: request(first) })).status === 403, "admin does not imply supervise or space operator");
  grantActor(account.stateDir, { owner, actor: "cli", scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
  check((await post({ idpToken: token, request: { ...request(first), owner: other } })).status === 400, "client ownership claims refuse closed parser");
  check((await post({ idpToken: token, request: request(first), granter: { kind: "operator", auditId: "forged" } })).status === 400, "public operator claim refuses");
  check((await post({ idpToken: token, request: request(first) }, { origin })).status === 403, "browser-origin removal refuses");
  check((await service.deregisterEndpoint({ ...request(first), space: "another-space" }, { kind: "owner", owner }).then(() => false, () => true)), "cross-space host request refuses");
  check(await service.deregisterEndpoint(request(first), { kind: "unknown" } as never).then(() => false, () => true), "unknown trusted granter refuses instead of becoming operator");
  const foreign = await seed(other);
  const foreignResult = await post({ idpToken: token, request: request(foreign) });
  check(foreignResult.body.state === "refused" && foreignResult.body.condition === "permission-denied" && (await kv.get(`svc.manager.${foreign}.spec`))?.operation === "PUT", "member cannot remove another account's Manager");
  const held = await seed();
  const heldSub = nc.subscribe(`${spacePrefix(account.space)}.ep.inst.manager.${held}.describe.>`);
  // Keep a real instance rail subscription without answering it.
  await nc.flush();
  const quiet = await service.deregisterEndpoint(request(held), { kind: "owner", owner });
  check(quiet.state === "refused" && quiet.condition === "instance-not-affirmed-gone", "unanswered instance with broker interest is not gone");
  heldSub.unsubscribe(); await nc.flush();
  const gateEntry = (await authKv.get(`epgate.manager.${held}`))!;
  const gate = JSON.parse(new TextDecoder().decode(gateEntry.value));
  await authKv.update(`epgate.manager.${held}`, new TextEncoder().encode(JSON.stringify({ ...gate, state: "frozen", op: { kind: "registration", opId: mintLifecycleUid() } })), gateEntry.revision);
  const inflight = await service.deregisterEndpoint(request(held), { kind: "owner", owner });
  check(inflight.state === "refused" && inflight.condition === "registration-in-flight", "in-flight registration refuses even on an empty rail");
  const removed = await post({ idpToken: token, request: request(first) });
  const parsed = parseRemoteEndpointDeregisterResult(removed.body, request(first));
  check(removed.status === 200 && parsed.state === "removed" && (await kv.get(`svc.manager.${first}.spec`))?.operation !== "PUT" && (await kv.get(`svc.manager.${first}.status`))?.operation !== "PUT", "same-account HTTP removal deletes status and spec");
  check((await authKv.get(`epgate.manager.${first}`))?.operation === "PUT", "removal leaves issuance gate intact");
  const operator = await service.deregisterEndpoint(request(foreign), { kind: "operator", auditId: "authenticated-space-operator" });
  check(operator.state === "removed", "trusted governing operator can remove another account's gone Manager");
  check(await Promise.resolve().then(() => parseRemoteEndpointDeregisterRequest({ ...request(first), instanceId: "prefix.bad" })).then(() => false, () => true), "full native instance grammar is enforced");
  check(await Promise.resolve().then(() => parseRemoteEndpointDeregisterResult({ ...removed.body, instanceId: foreign }, request(first))).then(() => false, () => true), "response from another instance is never accepted");
  console.log(`${checks} endpoint deregistration checks passed`);
  emitSentinel({ passed: checks, failed: 0 });
} finally {
  await fixtureClient?.close();
  await service?.close();
  idp.closeAllConnections();
  await new Promise<void>(resolve => idp.close(() => resolve()));
  await fx.stopBroker();
}
