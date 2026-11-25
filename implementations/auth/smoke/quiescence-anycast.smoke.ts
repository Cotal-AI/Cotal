/** Native anycast transitions distinguish retained status from notices/removals still owed.
 * The real authority writes every valid row; denied broker verbs leave its unfinished work. */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { createSuite } from "@cotal-ai/smoke-kit";
import { ANYCAST_RECORD_RETENTION_MS, AnycastRequestAuthority, anycastBucket, anycastRecordKey, anycastSubject,
  chatStream, credsFromJwt, dmStream, eptReqStreamName, fanoutDurableConfig,
  inboxReaderConfig, inboxStream, isPermissionDenied, mintCreds, newIdentity,
  setupSpaceStreams, standaloneConnectOpts, taskDurable, taskDurableConfig, taskStream,
  timerWriterConsumerConfig, unicastSubject, type AnycastRecord } from "@cotal-ai/core";
import { observeSpaceQuiescence } from "../dist/space-quiescence.js";
import { observeAnycastQuiescence } from "../src/quiescence-anycast.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { check, finish, passed, failed } = createSuite();
const fx = await startHostedAuthFixture("quiet-anycast", 1);
const account = fx.accounts[0]!, { space, auth } = account;
const connections: NatsConnection[] = [];
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const open = async (denied: string[] = []) => {
    const id = newIdentity();
    const jwt = await encodeUser("owned-anycast-custody-fixture", fromPublic(id.id), fromPublic(auth.account.pub), {
      pub: { allow: [">"], deny: denied }, sub: { allow: [">"] },
    }, { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 180 });
    const nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: credsFromJwt(jwt, id), tls: false }), reconnect: false });
    connections.push(nc);
    return nc;
  };
  const writer = await open(), jsm = await jetstreamManager(writer), js = jetstream(writer);
  const noticeSubject = unicastSubject(space, "local", "sender", "local", "delivery");
  const restricted = await open([noticeSubject, `$JS.API.STREAM.MSG.DELETE.${taskStream(space)}`]);
  const restrictedJs = jetstream(restricted), restrictedJsm = await jetstreamManager(restricted);
  await jsm.consumers.add(chatStream(space), fanoutDurableConfig(space));
  await jsm.consumers.add(inboxStream(space), inboxReaderConfig(space));
  await jsm.consumers.add(eptReqStreamName(space), timerWriterConsumerConfig(space));
  await jsm.consumers.add(taskStream(space), taskDurableConfig(space, "worker"));
  const kv = await new Kvm(writer).open(anycastBucket(space), { allow_direct: false });
  const tracking = `KV_${anycastBucket(space)}`;
  const creds = await mintCreds(auth, newIdentity(), "space-quiescence-reader");
  const opts = { servers: fx.servers, space, creds, accountPublicKey: account.accountPublicKey, tls: false };
  const observe = () => observeSpaceQuiescence(opts);
  check("unused canonical tracking is a native idle control", (await observe()).state === "quiescent");

  let sendAllowed = false, now = Date.now();
  const errors: Error[] = [];
  const authority = (manager = restrictedJsm) => new AnycastRequestAuthority({
    jsm: manager, kv, stream: taskStream(space), mayAct: () => true, now: () => now,
    send: async (to, event) => {
      if (to !== "local.sender") throw new Error("unexpected notice recipient");
      await (sendAllowed ? js : restrictedJs).publish(noticeSubject, bytes({ id: event.key, text: event.text, notice: event.notice }), { msgID: event.key });
    },
    onError: error => errors.push(error),
  });
  const deniedAuthority = authority(), allowedAuthority = authority(jsm);
  const consumer = await js.consumers.get(taskStream(space), taskDurable("worker"));
  const enqueue = async (id: string) => {
    const ack = await js.publish(anycastSubject(space, "worker", "local", "sender"), bytes({ id }));
    const msg = await consumer.next({ expires: 1_000 });
    if (!msg || msg.seq !== ack.seq) throw new Error("native request was not delivered");
    return { msg, seq: ack.seq, epoch: (await jsm.streams.info(taskStream(space))).created };
  };
  const first = await enqueue("notice-owed");
  const taken = await deniedAuthority.take("worker", { from: { id: "local.worker", name: "worker" }, seq: first.seq, id: "notice-owed", count: 1, epoch: first.epoch });
  const errorDeadline = Date.now() + 3_000;
  while (!errors.length && Date.now() < errorDeadline) await pause(10);
  const firstKey = anycastRecordKey(first.epoch, first.seq);
  const owed = (await kv.get(firstKey))!.json<AnycastRecord>();
  check("a real denied DM publish leaves the authority's notice outbox intact", taken.ok && errors.length === 1 && isPermissionDenied(errors[0]) && owed.outbox.length === 1 && (await jsm.streams.info(dmStream(space))).state.messages === 0);
  const held = await observe();
  check("a taken request and its owed notice are active", held.state === "active" && held.complete, held);
  check("the real holder acknowledges its TASK copy", await first.msg.ackAck() && (await jsm.streams.info(taskStream(space))).state.messages === 0);
  const afterAck = await observe();
  check("owed notices remain active after the TASK queue empties", afterAck.state === "active" && afterAck.complete && afterAck.counts.owedNotices === 1 && afterAck.counts.anycastRecords === 1 && afterAck.reasons.some(reason => reason.source === "anycast"), afterAck);
  sendAllowed = true;
  await allowedAuthority.sweep();
  const finished = (await kv.get(firstKey))!;
  check("the stock sweep publishes the notice and retains terminal status", finished.json<AnycastRecord>().outbox.length === 0 && finished.json<AnycastRecord>().leftAt === now && (await jsm.streams.info(dmStream(space))).state.messages === 1);
  const terminal = await observe();
  check("retained completed tracking and unread DM history permit sleep", terminal.state === "quiescent" && terminal.complete, terminal);
  check("observation preserves terminal row bytes and revision", (await kv.get(firstKey))!.revision === finished.revision && (await kv.get(firstKey))!.string() === finished.string());

  const second = await enqueue("cancel-pending");
  let cancelError: unknown;
  try { await deniedAuthority.cancel("local.sender", { seq: second.seq, id: "cancel-pending" }); }
  catch (error) { cancelError = error; }
  const secondKey = anycastRecordKey(second.epoch, second.seq);
  check("native delete denial leaves the stock cancellation pending", isPermissionDenied(cancelError) && (await kv.get(secondKey))!.json<AnycastRecord>().removal === "pending");
  check("the already delivered cancelled copy can leave TASK before removal reconciliation", await second.msg.ackAck() && (await jsm.streams.info(taskStream(space))).state.messages === 0);
  const pending = await observe();
  check("pending native removal blocks sleep even with no queued request", pending.state === "active" && pending.complete && pending.counts.pendingRemovals === 1 && pending.counts.anycastRecords === 2 && pending.reasons.some(reason => reason.source === "anycast"), pending);
  await allowedAuthority.sweep();
  check("a real sweep resolves the removal as already gone", (await kv.get(secondKey))!.json<AnycastRecord>().removal === "already-gone" && (await observe()).state === "quiescent");
  const third = await enqueue("cancel-deleted");
  const cancelled = await allowedAuthority.cancel("local.sender", { seq: third.seq, id: "cancel-deleted" });
  const thirdKey = anycastRecordKey(third.epoch, third.seq);
  check("native successful cancellation retains a terminal deleted status", cancelled.state === "cancelled" && cancelled.removal === "deleted" && (await jsm.streams.info(taskStream(space))).state.messages === 0 && (await observe()).state === "quiescent");

  const settled = (await kv.get(secondKey))!;
  const invalid = { ...settled.json<AnycastRecord>(), state: "unrecognized" };
  await kv.update(secondKey, bytes(invalid), settled.revision);
  const malformed = await observe();
  check("malformed retained tracking remains unknown", malformed.state === "unknown" && !malformed.complete, malformed);
  await kv.put(secondKey, settled.value);
  check("restoring the genuine stock row restores a clear control", (await observe()).state === "quiescent");

  const genuine = settled.json<AnycastRecord>();
  const malformedRows: Array<[string, unknown]> = [
    ["missing outbox", { ...genuine, outbox: undefined }],
    ["row/key mismatch", { ...genuine, seq: genuine.seq + 100 }],
    ["unknown version-one field", { ...genuine, futureEffect: true }],
    ["unrecognized removal", { ...genuine, removal: "later" }],
    ["taken without a holder", { ...finished.json<AnycastRecord>(), seq: genuine.seq, taker: undefined }],
    ["null record", null],
  ];
  for (const [label, value] of malformedRows) {
    await kv.put(secondKey, bytes(value));
    const observed = await observe();
    check(`${label} cannot produce an idle result`, observed.state === "unknown" && !observed.complete);
  }
  await kv.put(secondKey, bytes({ ...genuine, removal: undefined }));
  const unstated = await observe();
  check("an unstated cancellation removal remains pending", unstated.state === "active" && unstated.complete && unstated.counts.pendingRemovals === 1, unstated);
  await kv.put(secondKey, settled.value);
  const count = (await jsm.streams.info(tracking)).state.messages;
  let reads = 0;
  const readTap = writer.subscribe(`$JS.API.STREAM.MSG.GET.${tracking}`, { callback: () => { reads++; } });
  await writer.flush();
  const inspected = await observeAnycastQuiescence(kv, count);
  await writer.flush();
  readTap.unsubscribe();
  check("leader enumeration covers every retained native row", count === 3 && inspected.recordsEnumerated === count && !inspected.unknown && inspected.owedNotices === 0 && inspected.pendingRemovals === 0);
  check("the three-row tracking census makes four native leader reads", reads === 4, { rows: count, reads });
  check("a source-count mismatch refuses a complete census", (await observeAnycastQuiescence(kv, count - 1)).unknown);
  const blind = await open([`$JS.API.STREAM.MSG.GET.${tracking}`]);
  const blindKv = await new Kvm(blind).open(anycastBucket(space), { allow_direct: false });
  check("a genuine leader-read denial remains unknown", (await observeAnycastQuiescence(blindKv, count)).unknown);

  let changed = false, mutation: Promise<unknown> | undefined;
  const tap = writer.subscribe(`$JS.API.STREAM.MSG.GET.${tracking}`, { callback: (_error, message) => {
    if (changed || message.json<{ next_by_subj?: string }>().next_by_subj !== `$KV.${anycastBucket(space)}.>`) return;
    changed = true;
    mutation = kv.put(firstKey, finished.value);
  } });
  await writer.flush();
  const moving = await observe();
  tap.unsubscribe();
  await mutation;
  check("a native tracking write during enumeration refuses a stable verdict", changed && moving.state === "unknown" && !moving.complete, moving);
  check("the changed-source case has a fresh idle control", (await observe()).state === "quiescent");

  const reader = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  connections.push(reader);
  const readerJsm = await jetstreamManager(reader);
  let read = false;
  try { read = (await readerJsm.streams.getMessage(tracking, { last_by_subj: `$KV.${anycastBucket(space)}.${firstKey}` }))?.data.length! > 0; } catch {}
  check("the trusted reader can inspect its own leader-served tracking", read);
  const denied = async (subject: string) => {
    try { await reader.request(subject, bytes({}), { timeout: 1_000 }); return false; }
    catch (error) { if (!isPermissionDenied(error)) throw error; return true; }
  };
  check("the reader cannot write tracking", await denied(`$KV.${anycastBucket(space)}.${firstKey}`));
  check("the reader cannot delete tracking", await denied(`$JS.API.STREAM.MSG.DELETE.${tracking}`));
  check("the reader cannot create a tracking consumer", await denied(`$JS.API.CONSUMER.CREATE.${tracking}.hidden-reader`));
  check("the reader cannot use Direct Get for tracking", await denied(`$JS.API.DIRECT.GET.${tracking}`));
  check("the reader cannot read another space's tracking", await denied("$JS.API.STREAM.MSG.GET.KV_cotal_anycast_foreign"));
  check("the reader cannot read retained DM payloads", await denied(`$JS.API.STREAM.MSG.GET.${dmStream(space)}`));
  check("the reader cannot read TASK payloads", await denied(`$JS.API.STREAM.MSG.GET.${taskStream(space)}`));

  await allowedAuthority.sweep();
  now += ANYCAST_RECORD_RETENTION_MS + 1;
  await allowedAuthority.sweep();
  const removed = await Promise.all([firstKey, secondKey, thirdKey].map(key => kv.get(key)));
  check("the stock retention sweep leaves genuine native deletion markers", removed.every(entry => entry?.operation === "DEL") && (await jsm.streams.info(tracking)).state.messages === 3);
  const tombstones = await observe();
  check("retained tracking deletion markers are not unfinished work", tombstones.state === "quiescent" && tombstones.complete, tombstones);
  check("observation leaves the unread notice and all native markers intact", (await jsm.streams.info(dmStream(space))).state.messages === 1 && (await jsm.streams.info(tracking)).state.messages === 3);
} catch (error) {
  check(`harness: ${error instanceof Error ? error.stack : "unknown failure"}`, false);
} finally {
  for (const nc of connections.reverse()) await nc.close();
  await fx.close();
  if (passed() + failed() !== 39) check(`cell count: ran ${passed() + failed()}, expected 39`, false);
  finish();
}
process.exit(process.exitCode ?? 0);
