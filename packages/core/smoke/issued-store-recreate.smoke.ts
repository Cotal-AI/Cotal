/**
 * `removeIssuedStoresBeforeRetention` on a real JWT broker under the shipped `issued-store-recreate`
 * credential, the step `cotal up --recreate-issued-stores` and an embedder run (#4975):
 *
 *  1. The credential reaches the two issued-authority streams and nothing else: another stream's
 *     INFO and DELETE are refused and that stream is left in place.
 *  2. A backup directory that already exists is refused before anything is written or deleted.
 *  3. Both stores created before bounded retention, with rows, are backed up into a private
 *     directory in `nats stream backup` layout whose counts match the streams, then deleted. Every
 *     other stream keeps its message count, and `ensureIssuedStores` then creates both stores in the
 *     current shape, empty.
 *  4. A second run selects nothing, refuses, and creates no backup directory.
 *  5. A pre-retention accepted store next to a current evidence store: only the accepted store is
 *     backed up and deleted.
 *
 * Run: pnpm smoke:issued-store-recreate   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { DiscardPolicy, jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  IssuedStoreRecreateRefusal, acceptedBucket, chatStream, createSpaceAuth, ensureDefaultDeliveryClass, ensureIssuedStores, isReachable,
  issuedBucket, issuedStoreStreamNames, mintCreds, mintLifecycleUid, newIdentity, removeIssuedStoresBeforeRetention, serverConfig,
  setupSpaceStreams, spaceDeletionStreams, standaloneConnectOpts,
} from "../src/index.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); }
}

const space = "recreate";
const auth = await createSpaceAuth(space);
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const backups = join(dir, "backups");
mkdirSync(backups, { mode: 0o700 });
const [issuedStream, acceptedStream] = issuedStoreStreamNames(space) as [string, string];
const conns: NatsConnection[] = [];

async function dial(profile: "provisioner" | "teardown" | "issuer" | "issued-store-recreate"): Promise<{ nc: NatsConnection; jsm: JetStreamManager; inboxPrefix: string }> {
  const identity = newIdentity();
  const inboxPrefix = `_INBOX_${identity.id}`;
  const creds = await mintCreds(auth, identity, profile, profile === "teardown" ? { lifecycleUid: mintLifecycleUid() } : {});
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), inboxPrefix });
  conns.push(nc);
  return { nc, jsm: await jetstreamManager(nc, { timeout: 3_000 }), inboxPrefix };
}

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  // A space as `up` leaves it, then its two issued-authority stores as every release before
  // bounded retention created them: the same immutable flags and per-key shape, no per-message TTL.
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  await ensureDefaultDeliveryClass({ servers, space, creds: provisionerCreds, deliveryClass: "durable" });
  const provisioner = await dial("provisioner");
  const teardown = await dial("teardown");
  const issuer = await dial("issuer");
  const kvm = new Kvm(provisioner.nc);
  const createPreUpgrade = async (bucket: string, rows: number): Promise<void> => {
    const accepted = bucket === acceptedBucket(space);
    const perKey = accepted ? { max_msgs_per_subject: 1, discard: DiscardPolicy.New, discard_new_per_subject: true } : { max_msgs_per_subject: -1 };
    await kvm.create(bucket, { allow_direct: accepted });
    const created = (await provisioner.jsm.streams.info(`KV_${bucket}`)).config;
    await provisioner.jsm.streams.update(`KV_${bucket}`, { ...created, allow_rollup_hdrs: false, deny_delete: true, deny_purge: true, ...perKey });
    const js = jetstream(issuer.nc);
    for (let i = 0; i < rows; i++) await js.publish(`$KV.${bucket}.row${i}`, new TextEncoder().encode(`row ${i}`));
  };
  const state = async (stream: string): Promise<{ messages: number; ttl: boolean } | undefined> => {
    try {
      const info = await teardown.jsm.streams.info(stream);
      return { messages: info.state.messages, ttl: info.config.allow_msg_ttl === true };
    } catch { return undefined; }
  };
  // Every other stream of the space with its message count, read under the teardown credential,
  // whose INFO grant covers every stream the space has.
  const others = async (): Promise<Record<string, number | undefined>> => {
    const out: Record<string, number | undefined> = {};
    for (const stream of spaceDeletionStreams(space, []))
      if (stream !== issuedStream && stream !== acceptedStream) out[stream] = (await state(stream))?.messages;
    return out;
  };
  for (const stream of [issuedStream, acceptedStream]) await teardown.jsm.streams.delete(stream);
  await createPreUpgrade(issuedBucket(space), 5);
  await createPreUpgrade(acceptedBucket(space), 3);
  const before = await others();
  assert.ok(Object.values(before).some((n) => (n ?? 0) > 0), "the fixture has no other stream with messages to compare");
  const recreate = await dial("issued-store-recreate");

  await check("the credential is refused INFO and DELETE on another stream, which stays in place", async () => {
    await assert.rejects(() => recreate.jsm.streams.info(chatStream(space)));
    await assert.rejects(() => recreate.jsm.streams.delete(chatStream(space)));
    assert.notEqual(await state(chatStream(space)), undefined, "the chat stream was deleted");
  });

  await check("an existing backup directory is refused with both stores intact and nothing written", async () => {
    const taken = join(backups, "taken");
    mkdirSync(taken, { mode: 0o700 });
    await assert.rejects(() => removeIssuedStoresBeforeRetention(recreate.nc, { space, backupDir: taken, inboxPrefix: recreate.inboxPrefix }),
      (error: unknown) => error instanceof IssuedStoreRecreateRefusal && /already exists/.test((error as Error).message));
    assert.deepEqual(await state(issuedStream), { messages: 5, ttl: false });
    assert.deepEqual(await state(acceptedStream), { messages: 3, ttl: false });
    assert.equal(existsSync(join(taken, issuedStream)), false, "a stream backup was written into the existing directory");
  });

  const first = join(backups, "first");
  await check("both pre-retention stores are backed up privately with matching counts, then deleted; nothing else changes", async () => {
    const removed = await removeIssuedStoresBeforeRetention(recreate.nc, { space, backupDir: first, inboxPrefix: recreate.inboxPrefix });
    assert.deepEqual(removed.map((r) => [r.stream, r.messages, r.lastSeq]), [[issuedStream, 5, 5], [acceptedStream, 3, 3]]);
    assert.equal(statSync(first).mode & 0o777, 0o700);
    for (const r of removed) {
      assert.equal(r.backup, join(first, r.stream));
      assert.equal(statSync(r.backup).mode & 0o777, 0o700);
      const meta = JSON.parse(readFileSync(join(r.backup, "backup.json"), "utf8")) as { config: { name: string }; state: { messages: number; last_seq: number } };
      assert.equal(meta.config.name, r.stream);
      assert.equal(meta.state.messages, r.messages);
      assert.equal(meta.state.last_seq, r.lastSeq);
      const data = readFileSync(join(r.backup, "stream.tar.s2"));
      assert.ok(data.length > 0, `${r.stream}: empty snapshot`);
      assert.equal(data.subarray(0, 10).toString("latin1"), "\xff\x06\x00\x00S2sTwO", `${r.stream}: not an s2 stream`);
      for (const file of ["backup.json", "stream.tar.s2"]) assert.equal(statSync(join(r.backup, file)).mode & 0o777, 0o600, `${r.stream}/${file}`);
      assert.equal(await state(r.stream), undefined, `${r.stream} still exists`);
    }
    assert.deepEqual(await others(), before);
  });

  await check("ensureIssuedStores then creates both stores in the current shape, empty", async () => {
    await ensureIssuedStores(provisioner.jsm, kvm, space);
    assert.deepEqual(await state(issuedStream), { messages: 0, ttl: true });
    assert.deepEqual(await state(acceptedStream), { messages: 0, ttl: true });
  });

  await check("a second run selects nothing, refuses and creates no backup directory", async () => {
    const second = join(backups, "second");
    await assert.rejects(() => removeIssuedStoresBeforeRetention(recreate.nc, { space, backupDir: second, inboxPrefix: recreate.inboxPrefix }),
      (error: unknown) => error instanceof IssuedStoreRecreateRefusal && /neither issued-authority store/.test((error as Error).message));
    assert.equal(existsSync(second), false);
    assert.deepEqual(await state(issuedStream), { messages: 0, ttl: true });
  });

  await check("a pre-retention accepted store next to a current evidence store: only the accepted store is backed up and deleted", async () => {
    await teardown.jsm.streams.delete(acceptedStream);
    await createPreUpgrade(acceptedBucket(space), 2);
    const mixed = join(backups, "mixed");
    const removed = await removeIssuedStoresBeforeRetention(recreate.nc, { space, backupDir: mixed, inboxPrefix: recreate.inboxPrefix });
    assert.deepEqual(removed.map((r) => [r.stream, r.messages]), [[acceptedStream, 2]]);
    assert.equal(existsSync(join(mixed, issuedStream)), false);
    assert.deepEqual(await state(issuedStream), { messages: 0, ttl: true });
    assert.equal(await state(acceptedStream), undefined);
  });
} finally {
  for (const nc of conns) await nc.close().catch(() => {});
  await killAndAwaitExit(broker);
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`ISSUED STORE RECREATE SMOKE (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
