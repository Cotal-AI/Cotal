/**
 * `removeIssuedStoresBeforeRetention` on a real JWT broker under the shipped `issued-store-recreate`
 * credential, the step `cotal up --recreate-issued-stores` and an embedder run (#4975):
 *
 *  1. The credential reaches the two issued-authority streams and nothing else: another stream's
 *     INFO and DELETE are refused and that stream is left in place.
 *  2. It holds no response permission: a message delivered to its inbox whose reply is another
 *     stream's `STREAM.DELETE`, answered as a snapshot chunk is answered, is refused and every
 *     other stream keeps its message count.
 *  3. A backup directory that already exists is refused before anything is written or deleted.
 *  4. Both stores created before bounded retention, with rows, are backed up into a private
 *     directory in `nats stream backup` layout whose counts match the streams, then deleted. The
 *     issued store spans several snapshot chunks, so the broker asks for chunk ACKs, and a tap
 *     counts the ACKs the credential got out. Every other stream keeps its message count, and
 *     `ensureIssuedStores` then creates both stores in the current shape, empty.
 *  5. A second run selects nothing, refuses, and creates no backup directory.
 *  6. A pre-retention accepted store next to a current evidence store: only the accepted store is
 *     backed up and deleted.
 *  7. A write to a store after its backup, before the deletes, is refused with both stores and both
 *     backups kept.
 *
 * Run: pnpm smoke:issued-store-recreate   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { DiscardPolicy, jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  IssuedStoreRecreateRefusal, acceptedBucket, chatStream, createSpaceAuth, credsClaims, ensureDefaultDeliveryClass, ensureIssuedStores, isReachable,
  issuedBucket, issuedStoreStreamNames, mintCreds, mintLifecycleUid, newIdentity, removeIssuedStoresBeforeRetention, serverConfig,
  setupSpaceStreams, spaceDeletionStreams, standaloneConnectOpts,
} from "../src/index.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";
import { answerInjectedDelete, countSnapshotAcks, openSigned } from "./_snapshot-ack.js";

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

async function dial(profile: "provisioner" | "teardown" | "issuer" | "issued-store-recreate"): Promise<{ nc: NatsConnection; jsm: JetStreamManager; inboxPrefix: string; creds: string }> {
  const identity = newIdentity();
  const inboxPrefix = `_INBOX_${identity.id}`;
  const creds = await mintCreds(auth, identity, profile, profile === "teardown" ? { lifecycleUid: mintLifecycleUid() } : {});
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), inboxPrefix });
  conns.push(nc);
  return { nc, jsm: await jetstreamManager(nc, { timeout: 3_000 }), inboxPrefix, creds };
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
  // Issued rows are incompressible 64 KiB values, so that store's snapshot spans several chunks
  // and the broker asks for chunk ACKs; a store of one chunk never does.
  const createPreUpgrade = async (bucket: string, rows: number, rowBytes = 16): Promise<void> => {
    const accepted = bucket === acceptedBucket(space);
    const perKey = accepted ? { max_msgs_per_subject: 1, discard: DiscardPolicy.New, discard_new_per_subject: true } : { max_msgs_per_subject: -1 };
    await kvm.create(bucket, { allow_direct: accepted });
    const created = (await provisioner.jsm.streams.info(`KV_${bucket}`)).config;
    await provisioner.jsm.streams.update(`KV_${bucket}`, { ...created, allow_rollup_hdrs: false, deny_delete: true, deny_purge: true, ...perKey });
    const js = jetstream(issuer.nc);
    for (let i = 0; i < rows; i++) await js.publish(`$KV.${bucket}.row${i}`, randomBytes(rowBytes));
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
  await createPreUpgrade(issuedBucket(space), 5, 64 * 1024);
  await createPreUpgrade(acceptedBucket(space), 3);
  const before = await others();
  assert.ok(Object.values(before).some((n) => (n ?? 0) > 0), "the fixture has no other stream with messages to compare");
  const recreate = await dial("issued-store-recreate");
  const tap = await openSigned(servers, auth, "acktap", { sub: { allow: ["$JS.SNAPSHOT.ACK.>"] }, pub: { allow: [] } });
  const injector = await openSigned(servers, auth, "injector", { pub: { allow: [`${recreate.inboxPrefix}.>`] }, sub: { allow: [] } });
  conns.push(tap, injector);

  await check("the credential is refused INFO and DELETE on another stream, which stays in place", async () => {
    await assert.rejects(() => recreate.jsm.streams.info(chatStream(space)));
    await assert.rejects(() => recreate.jsm.streams.delete(chatStream(space)));
    assert.notEqual(await state(chatStream(space)), undefined, "the chat stream was deleted");
  });

  await check("an answered inbox message whose reply is another stream's DELETE is refused; every stream keeps its count", async () => {
    assert.equal(Object.hasOwn(credsClaims(recreate.creds).nats ?? {}, "resp"), false, "the credential carries a response permission");
    const { answered, refusal } = await answerInjectedDelete(recreate.nc, injector, `${recreate.inboxPrefix}.injected`, chatStream(space));
    assert.equal(answered, true, "the holder did not send the answer, so nothing was tested");
    assert.match(refusal ?? "", /Permissions Violation for Publish to "\$JS\.API\.STREAM\.DELETE\./);
    assert.deepEqual(await others(), before);
    assert.deepEqual(await state(issuedStream), { messages: 5, ttl: false });
    assert.deepEqual(await state(acceptedStream), { messages: 3, ttl: false });
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
  await check("both pre-retention stores are backed up privately with matching counts and ACKed chunks, then deleted; nothing else changes", async () => {
    const { result: removed, acks } = await countSnapshotAcks(tap, issuedStream,
      () => removeIssuedStoresBeforeRetention(recreate.nc, { space, backupDir: first, inboxPrefix: recreate.inboxPrefix }));
    assert.ok(acks > 0, `the issued store's snapshot sent no chunk ACK (${acks}), so the ACK grant was not exercised`);
    console.log(`    ${issuedStream}: ${acks} chunk ACK(s) out under the credential`);
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

  await check("a write to a store after its backup is refused before any delete, with both stores and both backups kept", async () => {
    await teardown.jsm.streams.delete(issuedStream);
    await createPreUpgrade(issuedBucket(space), 3, 64 * 1024);
    await createPreUpgrade(acceptedBucket(space), 16, 64 * 1024);
    const late = join(backups, "late");
    // The issued store is backed up first, so a write to it once the accepted store's backup has
    // begun lands after its snapshot and before the deletes.
    let settled = false;
    const wrote = (async () => {
      while (!settled && !existsSync(join(late, acceptedStream))) await new Promise((resolve) => setImmediate(resolve));
      if (!settled) await jetstream(issuer.nc).publish(`$KV.${issuedBucket(space)}.late`, randomBytes(16));
    })();
    const run = removeIssuedStoresBeforeRetention(recreate.nc, { space, backupDir: late, inboxPrefix: recreate.inboxPrefix }).finally(() => { settled = true; });
    await assert.rejects(() => run, (error: unknown) => {
      const message = (error as Error).message;
      return message.includes(`${issuedStream} changed after its backup`) && message.includes("no stream was deleted");
    });
    await wrote;
    assert.deepEqual(await state(issuedStream), { messages: 4, ttl: false });
    assert.deepEqual(await state(acceptedStream), { messages: 16, ttl: false });
    for (const stream of [issuedStream, acceptedStream]) assert.equal(existsSync(join(late, stream, "backup.json")), true, `${stream}: no backup`);
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
