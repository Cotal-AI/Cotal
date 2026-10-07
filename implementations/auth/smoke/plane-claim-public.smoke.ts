import assert from "node:assert/strict";
import { Kvm } from "@nats-io/kv";
import { epAuthBucket, mintCreds, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import * as auth from "../src/index.js";
import { openAuthorityClient, authorityBarrierGrants } from "../src/authority-client.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fx = await startHostedAuthFixture("public-claim", 2);
let handle: auth.AuthServiceHandle | undefined;
const clients: Awaited<ReturnType<typeof openAuthorityClient>>[] = [];
let count = 0;
try {
  const [a, virgin] = fx.accounts;
  for (const acct of fx.accounts) {
    await setupSpaceStreams({ servers: fx.servers, space: acct.space, creds: await mintCreds(acct.auth, newIdentity(), "provisioner") });
    // An independent reader in the same account, with no claim writes.
    clients.push(await openAuthorityClient({ server: fx.servers, space: acct.space, dataAccount: { pub: acct.auth.account.pub, signingSeed: acct.auth.account.signingSeed! }, label: "harness-reader", grants: (id) => {
      const g = authorityBarrierGrants(acct.space, id);
      return { publish: g.publish.filter((s) => !s.startsWith("$KV.")), subscribe: g.subscribe };
    }, log: () => {} }));
  }
  handle = await auth.startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: "life-a" }, space: a.space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir: a.stateDir });
  assert.ok("readPlaneClaim" in auth && typeof auth.readPlaneClaim === "function", "cell 2a: root exports readPlaneClaim"); count++;
  assert.equal(auth.PLANE_CLAIM_KEY, "plane", "cell 2a: root exports exact claim key"); count++;
  const kv = await new Kvm(clients[0].nc).open(epAuthBucket(a.space));
  const held = await auth.readPlaneClaim(kv, a.space);
  assert.equal(held?.state, "held", "cell 2a: public reader returns held row"); count++;
  await handle.close();
  const released = await auth.readPlaneClaim(kv, a.space);
  assert.equal(released?.state, "released", "cell 2a: public reader returns released row"); count++;
  assert.equal(released?.claimId, held?.claimId, "cell 2a: close preserves claim identity"); count++;
  const never = await new Kvm(clients[1].nc).open(epAuthBucket(virgin.space));
  assert.equal(await auth.readPlaneClaim(never, virgin.space), undefined, "cell 2a: unclaimed space returns undefined"); count++;
  await assert.rejects(auth.readPlaneClaim(kv, virgin.space), /bucket|space/i, "cell 2a: foreign space refuses"); count++;
  console.log(`plane claim public: ${count} assertions passed`);
  emitSentinel({ passed: count, failed: 0 });
} finally {
  await handle?.close().catch(() => {});
  for (const c of clients) await c.close();
  await fx.close();
}
