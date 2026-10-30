/** Run after building core: pnpm smoke:listing-issuance:live (needs nats-server). A static agent
 *  mint's listing generation on a throwaway broker: a fresh one binds and is recorded, a same-key
 *  re-mint reuses it only for the identical ceiling and triple, and nothing is ever replaced. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  acceptedBucket, acceptedKey, createSpaceAuth, credsClaims, ensureIssuedStores, importNativeSubjectPermissions, issuedBucket,
  listingAcceptedToken, mintCreds, mintGeneration, mintLifecycleUid, newIdentity, openIssuedStore, isReachable,
  type Identity, type IssuedAuthorityRef, type ListingSeam, type MintOpts,
} from "../src/index.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); }
}
const port = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  const servers = `nats://127.0.0.1:${port}`;
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  const space = "listing";
  const auth = await createSpaceAuth(space);
  await ensureIssuedStores(jsm, kvm, space);
  const store = openIssuedStore(await kvm.open(issuedBucket(space)), jsm, space);
  const accepted = await kvm.open(acceptedBucket(space));
  const seam: ListingSeam = { nc, store, accepted };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const v1Row = (creds: string) => (credsClaims(creds).nats?.pub?.allow ?? []).filter((r) => r.startsWith(`cotal.${space}.ep.v1.`));
  const generationOf = (creds: string) => v1Row(creds)[0]?.split(".").at(-2);
  const acceptedGeneration = async (id: string, horizon: number) => {
    const entry = await accepted.get(acceptedKey(listingAcceptedToken(id, horizon)));
    return entry ? (entry.json() as { ref: IssuedAuthorityRef }).ref.generation : undefined;
  };
  const mint = (identity: Identity, uid: string, opts: MintOpts = {}) =>
    mintCreds(auth, identity, "agent", { lifecycleUid: uid, expiresAt: exp, listingSeam: seam, ...opts });

  const identity = newIdentity();
  const uid = mintLifecycleUid();
  let first = "";
  await check("a static mint with an expiry binds a fresh listing generation and records its whole ceiling", async () => {
    const creds = await mint(identity, uid);
    first = generationOf(creds) ?? "";
    assert.equal(v1Row(creds).length, 1);
    assert.equal(await acceptedGeneration(identity.id, exp), first);
    const ref: IssuedAuthorityRef = { space, owner: "local", actor: identity.id, uid, generation: first };
    const observed = await store.observe(ref);
    assert.deepEqual(observed.evidence.permissions, importNativeSubjectPermissions({ pub: credsClaims(creds).nats!.pub, sub: credsClaims(creds).nats!.sub }));
    assert.equal(observed.evidence.expiresAt, exp);
  });

  await check("a same-key re-mint with the identical ceiling reuses the generation", async () => {
    assert.equal(generationOf(await mint(identity, uid)), first);
  });

  await check("a same-key re-mint with a different ceiling carries no listing rows and replaces nothing", async () => {
    const creds = await mint(identity, uid, { allowPublish: ["other"], allowSubscribe: ["other"] });
    assert.equal(v1Row(creds).length, 0);
    assert.ok(!(credsClaims(creds).nats?.pub?.allow ?? []).some((r) => r.includes(`KV_${acceptedBucket(space)}`)));
    assert.equal(await acceptedGeneration(identity.id, exp), first);
  });

  await check("a same-key mint for another triple carries no listing rows", async () => {
    const creds = await mint(identity, mintLifecycleUid());
    assert.equal(v1Row(creds).length, 0);
  });

  await check("a mint with no expiry gets no listing generation", async () => {
    const creds = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid(), listingSeam: seam });
    assert.equal(credsClaims(creds).exp, undefined);
    assert.equal(v1Row(creds).length, 0);
  });

  await check("evidence left by a crash before the accepted row does not bind; the next mint takes a fresh generation", async () => {
    const orphanIdentity = newIdentity();
    const orphanUid = mintLifecycleUid();
    const orphan: IssuedAuthorityRef = { space, owner: "local", actor: orphanIdentity.id, uid: orphanUid, generation: mintGeneration(exp) };
    await store.release(await store.stage({ version: 1, ref: orphan, sources: [], permissions: importNativeSubjectPermissions({ pub: { deny: [">"] } }), expiresAt: exp }), async () => {});
    const creds = await mint(orphanIdentity, orphanUid);
    const generation = generationOf(creds);
    assert.ok(generation && generation !== orphan.generation);
    assert.equal(await acceptedGeneration(orphanIdentity.id, exp), generation);
  });

  await check("concurrent same-key mints never release a credential whose generation the accepted row does not name", async () => {
    const raceIdentity = newIdentity();
    const raceUid = mintLifecycleUid();
    const results = await Promise.allSettled([mint(raceIdentity, raceUid), mint(raceIdentity, raceUid), mint(raceIdentity, raceUid)]);
    const released = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => generationOf(r.value));
    assert.ok(released.length >= 1);
    const named = await acceptedGeneration(raceIdentity.id, exp);
    assert.ok(released.every((g) => g === named), JSON.stringify({ released, named }));
  });
} finally {
  if (nc) await nc.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
