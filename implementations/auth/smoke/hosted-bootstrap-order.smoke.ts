/** Native embedded bootstrap order: a virgin auth claim needs no public oracle, but reclaim
 * of a dead predecessor must wait for the real delivery-admin CONNZ oracle. */
import assert from "node:assert/strict";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  ensureAuthorityStores, mintCreds, mintMembershipObserverCreds, newIdentity, setupSpaceStreams,
} from "@cotal-ai/core";
import { deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, type HostedServiceHandle } from "@cotal-ai/workspace";
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

  const aDelivery = await startDeliveryService(inputs[0]);
  deliveries.push(aDelivery);
  check("delivery admin starts with the same injected store and assigned account", (await aDelivery.readiness()).state === "ready");
  const aAuth = await startAuthService(inputs[0]);
  auths.push(aAuth);
  check("real delivery-admin CONNZ oracle reclaims dead predecessor and starts A", (await aAuth.readiness()).state === "ready" && (await fetch(`${aAuth.url}/health`)).ok);
  check("B still serves while A recovers its predecessor", (await bAuth.readiness()).state === "ready" && (await fetch(`${bAuth.url}/health`)).ok);
  console.log(`hosted bootstrap order: ${passed} native assertions passed`);
} finally {
  for (const h of auths) await h.close().catch(() => {});
  for (const h of deliveries) await h.close().catch(() => {});
  await fx.close();
}
