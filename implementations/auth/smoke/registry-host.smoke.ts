/** Real user-auth registry hosting, renewal, same-store restart and plane fencing.
 * Two fixture accounts, stock auth/delivery and ordinary fenced serving credentials.
 * No fixture-supplied registry name authority, issued evidence or successful-eviction stub.
 * Store continuity is in-process; this is not a cold-process or physical-host acceptance. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Kvm } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, EpEnvelopeError, dialerFor, epAuthBucket, mintCreds, mintConnectionEvictorCreds, mintMembershipObserverCreds,
  mintLifecycleUid, newIdentity, serveIssuanceGateKv, setupSpaceStreams, standaloneConnectOpts, type RegistryService, type RegistryServiceInputs,
} from "@cotal-ai/core";
import {
  connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey,
  type HostedServiceHandle,
} from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";
import { registryService } from "../../registry/src/host.js";
import { startDeliveryService } from "../../delivery/src/index.js";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, openAuthAuthorityPlane, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { claimRegistryIdentity } from "../src/registry-state.js";
import { startHostedAuthFixture, type HostedAuthAccount } from "./_hosted-auth-fixture.js";

const suite = createSuite();
const fx = await startHostedAuthFixture("registryhost", 2);
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "registry-host-fixture", alg: "EdDSA" };
const idp = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
const services = new Map<string, AuthServiceHandle>();
const deliveries: HostedServiceHandle[] = [];
const clients: CotalEndpoint[] = [];
const fixtureConnections: NatsConnection[] = [];
const captures = new Map<string, RegistryServiceInputs[]>();
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
const implementation: RegistryService = {
  ...registryService,
  start: async (inputs) => {
    const handle = await registryService.start(inputs);
    captures.set(inputs.space, [...(captures.get(inputs.space) ?? []), inputs]);
    return handle;
  },
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (test: () => boolean | Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await test()) return true; await wait(100); }
  return test();
};
const last = (a: HostedAuthAccount) => captures.get(a.space)!.at(-1)!;
const start = async (a: HostedAuthAccount) => {
  const service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity,
    publicFace: { port: 0, trustedProxy: false }, registry: implementation, registryCredentialTtlSeconds: 8,
  });
  services.set(a.space, service);
  return service;
};
const idpToken = () => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid })
  .setSubject("registry-fixture-human").setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("10m").sign(privateKey);
const bearer = async (a: HostedAuthAccount) => {
  const service = services.get(a.space)!;
  const response = await fetch(`${service.url}/exchange`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.cap}` },
    body: JSON.stringify({ idpToken: await idpToken(), actor: "lister" }),
  });
  const body = await response.json() as { token?: unknown };
  if (response.status !== 200 || typeof body.token !== "string") throw new Error(`fixture exchange refused (${response.status})`);
  return body.token;
};
const list = async (ep: CotalEndpoint) => {
  const result = await ep.listEndpoints({});
  if (result.unbound || result.page === undefined) throw new Error("the real user-auth caller has no listing generation");
  return result.page;
};
try {
  for (const a of fx.accounts) {
    writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/jwks` }), { mode: 0o600 });
    const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "registry-fixture-human");
    const row = grantActor(a.stateDir, { owner, actor: "lister", scope: [], allowSubscribe: [], allowPublish: [] });
    await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
    const composition = { injected: true as const };
    await a.store.put(deliveryCredsKey(a.space, composition), await mintCreds(a.auth, newIdentity(), "delivery"));
    await a.store.put(membershipRwCredsKey(a.space, composition), await mintCreds(a.auth, newIdentity(), "membership-rw"));
    await a.store.put(membershipObserverCredsKey(a.space, composition), await mintMembershipObserverCreds(a.auth, newIdentity()));
    await a.store.put(connectionEvictorCredsKey(a.space, composition), await mintConnectionEvictorCreds(a.auth, newIdentity()));
    if (a === fx.accounts[0]) {
      const disabled = await startAuthService({
        context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
        space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity,
      });
      services.set(a.space, disabled);
      suite.check("registry is absent by default, with no registry identity write", captures.get(a.space) === undefined
        && ![...a.store.values.keys()].some((key) => key.endsWith("/registry-instance.json")));
      await disabled.close(); services.delete(a.space);
    }
    await start(a);
    suite.check("auth-owned registry binds separate serving and reader connections", last(a).connection !== last(a).reader);
    const delivery = await startDeliveryService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity });
    deliveries.push(delivery);
    suite.check("the native fixture delivery service serves its account", await until(async () => (await delivery.readiness()).state === "ready"));
    const ep = new CotalEndpoint({ space: a.space, servers: fx.servers, bearer: await bearer(a), sentinelCreds: a.sentinelCreds,
      lifecycleUid: row.lifecycleUid!, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
      card: { owner, actor: "lister", name: "lister", kind: "agent" } });
    ep.on("error", () => {}); ep.on("warning", () => {});
    clients.push(ep);
    await ep.start();
    const page = await list(ep);
    suite.check("a real user-auth caller lists the auth-hosted registry under its recorded ceiling", page.source === "recorded-ceiling"
      && page.rows.length === 1 && page.rows[0]!.endpoint === "registry" && page.rows[0]!.commands[0]?.name === "endpoints");
    suite.check("the listing names only this account's registry instance", page.rows[0]!.instances.every((i) => i.instanceId === last(a).grant.instanceId));
  }
  const [a, b] = fx.accounts as [HostedAuthAccount, HostedAuthAccount];
  const firstA = last(a), firstB = last(b);
  suite.check("the two tenants do not share registry identities or connections", firstA.grant.instanceId !== firstB.grant.instanceId
    && firstA.reader !== firstB.reader && firstA.connection !== firstB.connection);
  const serveCid = firstA.connection.info?.client_id, readerCid = firstA.reader.info?.client_id;
  await wait(12_000);
  suite.check("both scoped connections renew past their initial eight-second credential lifetime", typeof serveCid === "number" && typeof readerCid === "number"
    && await until(() => firstA.connection.info?.client_id !== serveCid && firstA.reader.info?.client_id !== readerCid));
  suite.check("listing still succeeds after renewal", (await list(clients[0]!)).rows[0]!.instances[0]!.instanceId === firstA.grant.instanceId);
  const identity = await claimRegistryIdentity(a.store, a.space, a.accountPublicKey);
  await assert.rejects(() => claimRegistryIdentity(a.store, a.space, b.accountPublicKey), /another account/);
  suite.check("a foreign account cannot adopt the retained registry identity", (await claimRegistryIdentity(a.store, a.space, a.accountPublicKey)).instanceId === identity.instanceId);
  await services.get(a.space)!.close(); services.delete(a.space);
  suite.check("normal close stops the owned registry connections", firstA.reader.isClosed() && firstA.connection.isClosed());
  const executorIdentity = newIdentity();
  const executor = await dialerFor(fx.servers)({ servers: fx.servers, ...standaloneConnectOpts({
    creds: await mintCreds(a.auth, executorIdentity, "endpoint-serve-executor", {
      endpointServeExecutor: { endpoint: "registry", instanceId: identity.instanceId }, expiresInSeconds: 180,
    }), tls: false,
  }), maxReconnectAttempts: 0 });
  fixtureConnections.push(executor);
  const gate = serveIssuanceGateKv(await new Kvm(executor).open(epAuthBucket(a.space)), a.space, { endpoint: "registry", instanceId: identity.instanceId });
  // A genuine current serving credential is the positive control for later stale-grant refusal.
  // Keep its socket alive through restart so the real delivery evictor must remove a live holder.
  const retainedCreds = await mintCreds(a.auth, identity.serveIdentity, "endpoint-serve", {
    endpointServe: firstA.grant, serveIssuance: gate, expiresInSeconds: 60,
  });
  const predecessor = await dialerFor(fx.servers)({ servers: fx.servers,
    ...standaloneConnectOpts({ creds: retainedCreds, tls: false }), reconnect: false, maxReconnectAttempts: 0 });
  fixtureConnections.push(predecessor);
  await predecessor.flush();
  suite.check("the retained serving identity has a genuinely live predecessor socket", !predecessor.isClosed());
  await start(a);
  suite.check("native restart verify-evicts the live predecessor holder", await until(() => predecessor.isClosed()));
  await assert.rejects(() => mintCreds(a.auth, identity.serveIdentity, "endpoint-serve", {
    endpointServe: firstA.grant, serveIssuance: gate, expiresInSeconds: 60,
  }), (error: unknown) => error instanceof EpEnvelopeError && error.code === "expired" && /processEpoch/.test(error.message));
  suite.check("the previously valid captured grant cannot mint after restart", true);
  suite.check("same-store restart retains the instance and advances its epoch", last(a).grant.instanceId === firstA.grant.instanceId && last(a).grant.epoch === firstA.grant.epoch + 1);
  suite.check("the existing user-auth caller discovers the restarted registry", (await list(clients[0]!)).rows[0]!.instances[0]!.instanceId === firstA.grant.instanceId);
  suite.check("the sibling account still lists its own registry", (await list(clients[1]!)).rows[0]!.instances[0]!.instanceId === firstB.grant.instanceId);
  await services.get(a.space)!.close(); services.delete(a.space);
  await deliveries[0]!.close();
  await assert.rejects(() => start(a), (error: unknown) => error instanceof Error && /evict|eviction/i.test(error.message));
  const held = await gate.observe();
  suite.check("missing native eviction authority refuses restart and retains the registration operation", held?.state === "frozen"
    && held.op.kind === "registration" && (await claimRegistryIdentity(a.store, a.space, a.accountPublicKey)).instanceId === identity.instanceId);
  deliveries[0] = await startDeliveryService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity });
  assert.ok(await until(async () => (await deliveries[0]!.readiness()).state === "ready"));
  // Read the held operation above before invoking the documented recovery path; no raw gate write.
  await start(a);
  suite.check("native reconciliation recovers the retained identity once the real oracle is available", (await gate.observe())?.state === "open"
    && last(a).grant.instanceId === identity.instanceId && (await list(clients[0]!)).rows.length === 1);

  await services.get(b.space)!.close(); services.delete(b.space);
  let killLedger: (() => Promise<void>) | undefined;
  plane = await openAuthAuthorityPlane({ server: fx.servers, space: b.space, dir: b.stateDir,
    identityRoot: b.stateDir, identityStore: b.store, registryStore: b.store,
    dataAccount: { pub: b.accountPublicKey, signingSeed: b.auth.account.signingSeed! },
    registry: implementation, registryCredentialTtlSeconds: 8, log: () => {},
    probePlaneDeath: (kill) => { killLedger = kill.ledger; },
  });
  suite.check("the direct plane uses the same production registry lifecycle", (await list(clients[1]!)).rows[0]!.instances[0]!.instanceId === firstB.grant.instanceId);
  const fencedRegistry = last(b);
  await killLedger!();
  await plane.fenced;
  await assert.rejects(() => list(clients[1]!));
  suite.check("scanner death refuses registry disclosure", fencedRegistry.signal.aborted);
  await plane.close(); plane = undefined;
  suite.check("fenced registry connections close before plane close completes", fencedRegistry.connection.isClosed() && fencedRegistry.reader.isClosed());
  suite.check("fencing one tenant leaves the other registry available", (await list(clients[0]!)).rows.length === 1);
} catch (error) {
  suite.check("registry host lifecycle completes", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const client of clients) await client.stop();
  for (const connection of fixtureConnections) await connection.close();
  await plane?.close();
  for (const service of services.values()) await service.close();
  for (const delivery of deliveries) await delivery.close();
  await new Promise<void>((r) => idp.close(() => r()));
  await fx.close();
}
suite.finish();
