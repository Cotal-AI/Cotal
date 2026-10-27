/**
 * Every binder of the issued-authority stores verifies both stores' shape before it reads or
 * writes either (SPEC 13.12, 13.15), on a real JWT broker under the shipped `issuer` credential:
 * the one-shot issuer session, the auth plane's held issuer session, and the manager's own
 * issuance window.
 *
 *  1. Stores created before bounded retention (no `allow_msg_ttl`) are refused by each binder with
 *     the backup, remove and recreate remedy, before its callback runs, and are left unchanged.
 *  2. The operator's remedy (remove both streams, start the release) makes each binder bind.
 *  3. A pre-upgrade accepted store next to a current evidence store is refused by name.
 *
 * Run: pnpm smoke:issued-store-binders   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscardPolicy, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  acceptedBucket, createSpaceAuth, ensureIssuedStores, holdIssuerSession, issuedBucket, issuedStoreStreamNames, mintCreds, mintLifecycleUid, newIdentity,
  standaloneConnectOpts, withIssuerSession, type IssuedStore,
} from "@cotal-ai/core";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { Manager } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); }
}

const space = "binders";
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-issued-binders-"));
const [issuedStream, acceptedStream] = issuedStoreStreamNames(space);
const conns: NatsConnection[] = [];
const dial = async (profile: "provisioner" | "teardown"): Promise<{ jsm: JetStreamManager; kvm: Kvm }> => {
  const nc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), profile, profile === "teardown" ? { lifecycleUid: mintLifecycleUid() } : {}), tls: false }) });
  conns.push(nc);
  return { jsm: await jetstreamManager(nc), kvm: new Kvm(nc) };
};

const mgr = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth;
const managerIssuer = mgr as unknown as { withIssuer<T>(fn: (i: { store: IssuedStore }) => Promise<T>): Promise<T> };

// The three binders, each asked to run a callback that only records that it ran. A held session
// binds once per connection, so each cell holds a new one.
const binders: Array<[string, (fn: () => Promise<void>) => Promise<void>]> = [
  ["withIssuerSession", (fn) => withIssuerSession({ servers: broker.servers, space, auth, tls: false }, fn)],
  ["holdIssuerSession", async (fn) => {
    const held = holdIssuerSession({ servers: broker.servers, space, auth, tls: false, name: "binders-held" });
    try { await held.run(fn); } finally { await held.close(); }
  }],
  ["the manager's issuer window", (fn) => managerIssuer.withIssuer(fn)],
];

try {
  const provisioner = await dial("provisioner");
  const teardown = await dial("teardown");
  // A store as every release before bounded retention created it: the same immutable flags and
  // per-key shape, and no per-message TTL.
  const createPreUpgrade = async (bucket: string): Promise<void> => {
    const perKey = bucket === acceptedBucket(space) ? { max_msgs_per_subject: 1, discard: DiscardPolicy.New, discard_new_per_subject: true } : { max_msgs_per_subject: -1 };
    await provisioner.kvm.create(bucket, { allow_direct: bucket === acceptedBucket(space) });
    const created = (await provisioner.jsm.streams.info(`KV_${bucket}`)).config;
    await provisioner.jsm.streams.update(`KV_${bucket}`, { ...created, allow_rollup_hdrs: false, deny_delete: true, deny_purge: true, ...perKey });
  };
  const ttlOn = async (stream: string): Promise<boolean | undefined> => (await provisioner.jsm.streams.info(stream)).config.allow_msg_ttl;

  await createPreUpgrade(issuedBucket(space));
  await createPreUpgrade(acceptedBucket(space));
  for (const [name, bind] of binders) {
    await check(`${name} refuses stores created before bounded retention with the remedy, before its callback runs`, async () => {
      let ran = false;
      await assert.rejects(() => bind(async () => { ran = true; }),
        new RegExp(`store ${issuedBucket(space)} was created before bounded retention.*nats stream backup.*nats stream rm`));
      assert.equal(ran, false, "the callback ran");
      assert.equal(await ttlOn(issuedStream), false, "the refusal changed the evidence store");
      assert.equal(await ttlOn(acceptedStream), false, "the refusal changed the accepted store");
    });
  }

  // The operator's remedy: remove both streams (after `nats stream backup`), then start the release.
  for (const stream of [issuedStream, acceptedStream]) await teardown.jsm.streams.delete(stream);
  await ensureIssuedStores(provisioner.jsm, provisioner.kvm, space);
  for (const [name, bind] of binders) {
    await check(`${name} binds both stores once they are recreated`, async () => {
      let ran = false;
      await bind(async () => { ran = true; });
      assert.equal(ran, true);
    });
  }

  await teardown.jsm.streams.delete(acceptedStream);
  await createPreUpgrade(acceptedBucket(space));
  for (const [name, bind] of binders) {
    await check(`${name} refuses a pre-upgrade accepted store next to a current evidence store`, async () => {
      let ran = false;
      await assert.rejects(() => bind(async () => { ran = true; }), new RegExp(`store ${acceptedBucket(space)} was created before bounded retention`));
      assert.equal(ran, false, "the callback ran");
    });
  }
} finally {
  for (const nc of conns) await nc.close().catch(() => {});
  await broker.stop();
  rmSync(workspaceRoot, { recursive: true, force: true });
}
console.log(`ISSUED STORE BINDERS SMOKE (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
