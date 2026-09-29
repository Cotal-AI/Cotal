/** Native embedded bootstrap order: a virgin auth claim needs no public oracle, but reclaim
 * of a dead predecessor must wait for the real delivery-admin CONNZ oracle. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  connzRequestSubject, credsClaims, ensureAuthorityStores, identityFromCreds, leaseKey, probeConnect, MEMBERSHIP_INBOX_PREFIX,
  mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, openDeliveryRegistry, setupSpaceStreams,
} from "@cotal-ai/core";
import { DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, putSpaceAuth, remintDaemonCreds, type HostedServiceHandle } from "@cotal-ai/workspace";
import { startDeliveryService } from "../../delivery/src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { openAuthLedgerScannerCandidate } from "../src/ledger-scanner.js";
import { openRecordsScannerCandidate } from "../src/records-scanner.js";
import { acquirePlaneClaim } from "../src/plane-claim.js";
import { startAuthService, type AuthServiceHandle } from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const fx = await startHostedAuthFixture("embedded-order");
const auths: AuthServiceHandle[] = [];
const deliveries: HostedServiceHandle[] = [];
const conns: NatsConnection[] = [];
let passed = 0;
const check = (name: string, condition: boolean) => { assert.ok(condition, name); passed++; };
const quiet = () => {};
try {
  const [a, b] = fx.accounts;
  const inputs = fx.accounts.map((acct, i) => ({
    context: { accountPublicKey: acct.accountPublicKey, lifecycleUid: `life-${i}` },
    space: acct.space, servers: fx.servers, store: acct.store, storeIdentity: acct.store.identity, stateDir: acct.stateDir,
  }));
  for (const acct of fx.accounts) {
    await setupSpaceStreams({ servers: fx.servers, space: acct.space, creds: await mintCreds(acct.auth, newIdentity(), "provisioner") });
    const composition = { injected: true as const };
    await acct.store.put(deliveryCredsKey(acct.space, composition), await mintCreds(acct.auth, newIdentity(), "delivery"));
    await acct.store.put(membershipRwCredsKey(acct.space, composition), await mintCreds(acct.auth, newIdentity(), "membership-rw"));
    await acct.store.put(membershipObserverCredsKey(acct.space, composition), await mintMembershipObserverCreds(acct.auth, newIdentity()));
  }

  // Provision an inspector to observe delivery lease state directly on the broker.
  const inspectorId = newIdentity();
  const inspector = await connect({
    servers: fx.servers,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(a.auth, inspectorId, "agent", { lifecycleUid: mintLifecycleUid() }))),
    inboxPrefix: `_INBOX_${inspectorId.id}`,
  });
  conns.push(inspector);
  const dlvKv = await openDeliveryRegistry(inspector, a.space);

  // An observer client directly queries broker CONNZ for delivery connections under account A.
  const observer = await connect({
    servers: fx.servers,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintMembershipObserverCreds(a.auth, newIdentity()))),
    inboxPrefix: MEMBERSHIP_INBOX_PREFIX,
  });
  conns.push(observer);
  const countDeliveryConns = async (): Promise<number> => {
    const reply = `${MEMBERSHIP_INBOX_PREFIX}.hosted.${randomUUID()}`;
    const sub = observer.subscribe(reply, { max: 1 });
    try {
      observer.publish(connzRequestSubject(a.auth.account.pub), JSON.stringify({ subscriptions: false, limit: 1024 }), { reply });
      await observer.flush();
      const response = await Promise.race([
        (async () => { for await (const msg of sub) return msg.json<{ data?: { connections?: Array<{ name?: string }> } }>(); })(),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000)),
      ]);
      if (!response?.data?.connections) throw new Error("broker CONNZ did not answer account A");
      return response.data.connections.filter((c) => c.name === "cotal:delivery").length;
    } finally { sub.unsubscribe(); }
  };

  // The trusted signer/authority can initialize its virgin claim before the public auth
  // callout or delivery admin rail exists. This is a real hosted service, not a fake handle.
  const bAuth = await startAuthService(inputs[1]);
  auths.push(bAuth);
  check("virgin auth plane is ready before delivery is started", (await bAuth.readiness()).state === "ready");

  // Stage a predecessor that truly held the guarded claim, then lost BOTH non-reconnecting
  // scanner connections without the clean release (the process-death shape).
  const dataAccount = { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! };
  const writer = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount, label: `bootstrap:${a.space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  try {
    await ensureAuthorityStores(await jetstreamManager(writer.nc), new Kvm(writer.nc), a.space);
    const ledger = await openAuthLedgerScannerCandidate({ server: fx.servers, space: a.space, dataAccount, log: quiet });
    const records = await openRecordsScannerCandidate({ server: fx.servers, space: a.space, dataAccount, log: quiet });
    try {
      const hold = await acquirePlaneClaim({ nc: writer.nc, space: a.space, ledger: ledger.tuple, records: records.tuple, oracle: async () => { throw new Error("a virgin claim consulted the oracle"); }, log: quiet });
      check("dead predecessor first held a real plane claim", hold.generation === 1);
    } finally { await ledger.close(); await records.close(); }
  } finally { await writer.close(); }

  // Without delivery the real production oracle cannot prove the dead tuples gone, so no
  // successor gets scanner authority even though the predecessor connections have died.
  await assert.rejects(startAuthService(inputs[0]), /cannot confirm the previous auth plane|delivery daemon|liveness/i,
    "dead predecessor does not authorize reclaim while delivery oracle is absent");
  passed++;
  check("sibling B remains serving after A's refused claim", (await bAuth.readiness()).state === "ready" && (await fetch(`${bAuth.url}/health`)).ok);

  const signals = process.listenerCount("SIGTERM");
  check("no delivery lease exists before delivery is started", (await dlvKv.get(leaseKey(0)).catch(() => null)) === null);
  check("no delivery connections exist on account A before delivery is started", (await countDeliveryConns()) === 0);

  // Expired delivery credential negative control:
  // Prove an expired delivery credential refuses before acquiring owned duty / lease, leaving
  // no leaked broker connection, listener, or duty claim, while the sibling serves throughout.
  const key = deliveryCredsKey(a.space, { injected: true });
  const validDelivery = await a.store.get(key);
  assert.ok(validDelivery, "provisioned delivery credential exists");
  await a.store.put(key, await mintCreds(a.auth, newIdentity(), "delivery", { expiresAt: Math.floor(Date.now() / 1000) - 60 }));
  try {
    await assert.rejects(
      startDeliveryService(inputs[0]),
      /already-expired credential/i,
      "expired delivery credential refuses before acquiring a hosted lease",
    );
    passed++;
    check("sibling B still serves after A's expired delivery credential refuses", (await bAuth.readiness()).state === "ready" && (await fetch(`${bAuth.url}/health`)).ok);
    check("expired delivery credential refused before acquiring duty claim/lease", (await dlvKv.get(leaseKey(0)).catch(() => null)) === null);
    check("failed delivery start leaves no leaked broker connection", (await countDeliveryConns()) === 0);
    check("failed delivery start leaves no leaked process signal listeners", process.listenerCount("SIGTERM") === signals);
  } catch (e) {
    await a.store.put(key, validDelivery);
    throw e;
  }

  // Trusted recovery through the stock renewal owner: remintDaemonCreds re-signs the EXPIRED
  // delivery cred for its existing nkey through the same injected store, gated by a real broker
  // preflight. The root is a path that does not exist, so no cwd or workspace store can serve.
  const expiredCred = await a.store.get(key);
  const memKey = membershipRwCredsKey(a.space, { injected: true });
  const initialMembershipCred = await a.store.get(memKey);
  // The renewal owner's signer lives in the same injected store (stock putSpaceAuth), the store the
  // manager passes remintDaemonCreds as its secretStore. A store with no signer cannot renew.
  check("an injected store without the space signer renews nothing and preserves the last-good cred",
    (await remintDaemonCreds(join(fx.dir, "no-such-root"), a.space, a.store)).every((r) => !r.ok) && (await a.store.get(key)) === expiredCred);
  await putSpaceAuth(a.store, a.auth);
  const refused = await remintDaemonCreds(join(fx.dir, "no-such-root"), a.space, a.store, { preflight: async () => false });
  check("a candidate the broker preflight refuses preserves the last-good cred",
    refused.every((r) => !r.ok) && (await a.store.get(key)) === expiredCred);
  const reminted = await remintDaemonCreds(join(fx.dir, "no-such-root"), a.space, a.store, {
    preflight: async (creds) => (await probeConnect(fx.servers, { creds })).ok,
  });
  const renewedCred = await a.store.get(key);
  check("stock remint renews the expired delivery cred through the injected store after broker preflight",
    reminted.find((r) => r.file === DELIVERY_CREDS_KIND)?.ok === true && renewedCred !== expiredCred &&
    (credsClaims(renewedCred!).exp ?? 0) > Date.now() / 1000);
  check("the renewed delivery cred keeps its existing nkey",
    identityFromCreds(renewedCred!).id === identityFromCreds(expiredCred!).id);
  const renewedMembership = await a.store.get(memKey);
  check("stock remint renews the membership-rw cred separately through the injected store after broker preflight",
    reminted.find((r) => r.file === MEMBERSHIP_RW_CREDS_KIND)?.ok === true &&
    renewedMembership !== undefined && renewedMembership !== initialMembershipCred &&
    (credsClaims(renewedMembership!).exp ?? 0) > Date.now() / 1000);
  check("the renewed membership-rw cred keeps its existing nkey",
    identityFromCreds(renewedMembership!).id === identityFromCreds(initialMembershipCred!).id);
  check("the renewed membership-rw cred authenticates to the real broker",
    (await probeConnect(fx.servers, { creds: renewedMembership! })).ok);
  check("trusted remint consulted no workspace root", !existsSync(join(fx.dir, "no-such-root")));

  // The same injected SecretStore object and identity now serves the reminted candidate
  // without any hidden cwd/local-store substitute.
  check("delivery context preserves the exact injected store object and identity",
    inputs[0].store === a.store && inputs[0].storeIdentity === a.store.identity && a.store.identity.kind === "injected");

  const aDelivery = await startDeliveryService(inputs[0]);
  deliveries.push(aDelivery);
  check("delivery admin starts with the same injected store and assigned account", (await aDelivery.readiness()).state === "ready");
  check("delivery duty claim is acquired after the reminted candidate is adopted", (await dlvKv.get(leaseKey(0)))?.value !== undefined);
  check("broker sees A's active delivery connection after authorized start", (await countDeliveryConns()) === 1);

  const aAuth = await startAuthService(inputs[0]);
  auths.push(aAuth);
  check("real delivery-admin CONNZ oracle reclaims dead predecessor and starts A", (await aAuth.readiness()).state === "ready" && (await fetch(`${aAuth.url}/health`)).ok);
  check("A acquires its delivery lease only after the trusted remint replaces the expired one", (await aDelivery.readiness()).state === "ready");
  check("B still serves while A recovers its predecessor", (await bAuth.readiness()).state === "ready" && (await fetch(`${bAuth.url}/health`)).ok);
  console.log(`hosted bootstrap order: ${passed} native assertions passed`);
} finally {
  for (const h of auths) await h.close().catch(() => {});
  for (const h of deliveries) await h.close().catch(() => {});
  for (const nc of conns) await nc.drain().catch(() => {});
  await fx.close();
}
