import assert from "node:assert/strict";
import { decode, encodeAccount, type Account } from "@nats-io/jwt";
import { createAccount, fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  STANDING_RENEWABLE_TTL_SEC,
  createBrokerAuth,
  createSpaceAccountAuth,
  credsClaims,
  hibernateAccountClaim,
  identityFromCreds,
  verifyStaticUserCredential,
  type SecretStore,
} from "@cotal-ai/core";
import { createCalloutAuth } from "../src/callout.js";
import {
  authCalloutKey,
  loadCalloutAuth,
  renewCalloutCredentials,
  saveCalloutAccountJwt,
} from "../src/store.js";
import { STORE_VER } from "../src/store-file.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  puts = 0;
  async get(key: string) { return this.values.get(key); }
  async put(key: string, value: string) { this.puts++; this.values.set(key, value); }
  async create(key: string, value: string) {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }
  async delete(key: string) { this.values.delete(key); }
}

const now = () => Math.floor(Date.now() / 1000);
const waitNextSecond = async () => {
  const at = now();
  while (now() === at) await new Promise((resolve) => setTimeout(resolve, 20));
};
let passed = 0, failed = 0;
const cell = async (name: string, run: () => Promise<void>) => {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
};

const broker = await createBrokerAuth("callout-store-transition");
const space = await createSpaceAccountAuth(broker, "callout-store-transition");
const original = await createCalloutAuth({ space: space.space, operatorSeed: broker.operator.seed, accountPub: space.account.pub });
const store = new MemoryStore(), key = authCalloutKey(space.space);
store.values.set(key, JSON.stringify({ ver: STORE_VER, callout: original }, null, 2));

await waitNextSecond();
const sleepingJwt = await hibernateAccountClaim(broker, original.account.jwt, now());
await cell("saveCalloutAccountJwt persists only the newer transitioned account JWT", async () => {
  const updated = await saveCalloutAccountJwt(store, space.space, sleepingJwt);
  const loaded = await loadCalloutAuth(store, space.space);
  assert.equal(updated.account.jwt, sleepingJwt);
  assert.equal(loaded?.account.jwt, sleepingJwt);
  assert.equal(updated.account.pub, original.account.pub);
  assert.equal(updated.account.signingSeed, original.account.signingSeed);
  assert.equal(updated.calloutCreds, original.calloutCreds);
  assert.equal(updated.sentinelCreds, original.sentinelCreds);
  assert.equal(updated.xkey.seed, original.xkey.seed);
  assert.equal(store.puts, 1);
});

await cell("saveCalloutAccountJwt refuses stale, foreign and authority-changing claims without a write", async () => {
  const puts = store.puts;
  await assert.rejects(saveCalloutAccountJwt(store, space.space, original.account.jwt), /not newer/);
  const foreign = await createCalloutAuth({
    space: "foreign-callout-store",
    operatorSeed: (await createBrokerAuth("foreign-callout-store")).operator.seed,
    accountPub: (await createSpaceAccountAuth(await createBrokerAuth("foreign-data"), "foreign-data")).account.pub,
  });
  await assert.rejects(saveCalloutAccountJwt(store, space.space, foreign.account.jwt), /changes identity or authority/);
  const claims = decode<Account>(sleepingJwt);
  const account = fromPublic(original.account.pub), signer = fromSeed(new TextEncoder().encode(broker.operator.seed));
  const changed = await encodeAccount(claims.name, account, {
    ...claims.nats,
    authorization: { ...claims.nats.authorization!, allowed_accounts: [createAccount().getPublicKey()] },
  }, { signer });
  account.clear(); signer.clear();
  await assert.rejects(saveCalloutAccountJwt(store, space.space, changed), /changes identity or authority/);
  assert.equal(store.puts, puts);
});

await cell("renewCalloutCredentials keeps both user nkeys and permissions, adds a bounded shared expiry, and atomically persists", async () => {
  const beforeCallout = identityFromCreds(original.calloutCreds), beforeSentinel = identityFromCreds(original.sentinelCreds);
  const oldCallout = credsClaims(original.calloutCreds), oldSentinel = credsClaims(original.sentinelCreds);
  assert.equal(oldCallout.exp, undefined);
  assert.equal(oldSentinel.exp, undefined);
  const beforePuts = store.puts;
  const renewed = await renewCalloutCredentials(store, space.space, 60);
  const calloutClaims = credsClaims(renewed.calloutCreds), sentinelClaims = credsClaims(renewed.sentinelCreds);
  assert.equal(identityFromCreds(renewed.calloutCreds).id, beforeCallout.id);
  assert.equal(identityFromCreds(renewed.sentinelCreds).id, beforeSentinel.id);
  assert.deepEqual(calloutClaims.nats?.pub, oldCallout.nats?.pub);
  assert.deepEqual(calloutClaims.nats?.sub, oldCallout.nats?.sub);
  assert.deepEqual(sentinelClaims.nats?.pub, oldSentinel.nats?.pub);
  assert.deepEqual(sentinelClaims.nats?.sub, oldSentinel.nats?.sub);
  assert.equal(calloutClaims.exp, sentinelClaims.exp);
  assert.ok(typeof calloutClaims.exp === "number" && calloutClaims.exp > now());
  assert.equal(verifyStaticUserCredential(renewed.calloutCreds, {
    accountPub: renewed.account.pub,
    signingPub: renewed.account.signingPub,
  }).identity, beforeCallout.id);
  assert.equal(verifyStaticUserCredential(renewed.sentinelCreds, {
    accountPub: renewed.account.pub,
    signingPub: renewed.account.signingPub,
  }).identity, beforeSentinel.id);
  assert.equal(store.puts, beforePuts + 1);
  assert.equal((await loadCalloutAuth(store, space.space))?.calloutCreds, renewed.calloutCreds);
});

await cell("renewCalloutCredentials refuses bad TTLs and mismatched stored credentials without writing", async () => {
  const beforePuts = store.puts;
  for (const ttl of [0, 59, 60.5, STANDING_RENEWABLE_TTL_SEC + 1])
    await assert.rejects(renewCalloutCredentials(store, space.space, ttl), /expiresInSeconds/);
  const currentRaw = store.values.get(key)!;
  const current = JSON.parse(currentRaw) as { ver: number; callout: typeof original };
  current.callout.calloutCreds = current.callout.sentinelCreds;
  store.values.set(key, JSON.stringify(current));
  await assert.rejects(renewCalloutCredentials(store, space.space, 60), /stored callout credential does not match/);
  assert.equal(store.puts, beforePuts);
  store.values.set(key, currentRaw);
});

emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
