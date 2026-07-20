import assert from "node:assert/strict";
import {
  DeliverPolicy,
  ReplayPolicy,
  type ConsumerConfig,
  type ConsumerInfo,
} from "@nats-io/jetstream";
import {
  CREDENTIAL_LIFETIMES,
  backupProfilePermissions,
  canonicalBackupStreamConfig,
  chatStream,
  consumerConfigFromCheckpoint,
  dlvDurableConfig,
  dlvStream,
  dmDurableConfig,
  dmStream,
  downloadStreamSnapshot,
  fanoutDurableConfig,
  inboxReaderConfig,
  inboxStream,
  principalKey,
  restoreProfilePermissions,
  spaceBackupInventory,
  taskDurableConfig,
  taskStream,
  validateCanonicalBackupStreamConfig,
  validatePersistentConsumer,
  validatePersistentConsumerInventory,
  validateSpaceBackupInventory,
} from "../src/index.js";

const space = "backup_smoke";
const connId = "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const inventory = spaceBackupInventory(space);

assert.equal(inventory.full.length, 8);
assert.equal(inventory.excluded.length, 4);
assert.deepEqual(validateSpaceBackupInventory(space, [...inventory.full, ...inventory.excluded.map((s) => s.name)]), inventory);
assert.throws(() => validateSpaceBackupInventory(space, inventory.full), /missing/);
assert.throws(
  () => validateSpaceBackupInventory(space, [...inventory.full, ...inventory.excluded.map((s) => s.name), "FOREIGN"]),
  /unexpected.*FOREIGN/,
);

for (const stream of inventory.full) {
  const config = canonicalBackupStreamConfig(space, stream);
  assert.deepEqual(validateCanonicalBackupStreamConfig(space, stream, config), config);
}
const hostile = { ...canonicalBackupStreamConfig(space, chatStream(space)), sealed: true };
assert.throws(() => validateCanonicalBackupStreamConfig(space, chatStream(space), hostile), /not canonical/);
assert.throws(
  () => validateCanonicalBackupStreamConfig(space, chatStream(space), {
    ...canonicalBackupStreamConfig(space, chatStream(space)),
    mirror: { name: "FOREIGN" },
  }),
  /not canonical/,
);

function consumer(stream: string, name: string, partial: Partial<ConsumerConfig>, ackFloor = 0): ConsumerInfo {
  return {
    stream_name: stream,
    name,
    created: new Date(0).toISOString(),
    config: {
      ...partial,
      name,
      durable_name: name,
      replay_policy: ReplayPolicy.Instant,
      max_ack_pending: partial.max_ack_pending ?? 1000,
      max_deliver: -1,
      max_waiting: 512,
      num_replicas: 0,
    } as ConsumerConfig,
    delivered: { consumer_seq: ackFloor, stream_seq: ackFloor, last_active: 0 },
    ack_floor: { consumer_seq: ackFloor, stream_seq: ackFloor, last_active: 0 },
    num_ack_pending: 0,
    num_redelivered: 0,
    num_waiting: 0,
    num_pending: 0,
    push_bound: false,
    pause_remaining: 0,
  };
}

const pk = principalKey("local", "agent_1");
const infos = [
  consumer(chatStream(space), "fanout", fanoutDurableConfig(space), 7),
  consumer(inboxStream(space), "reader", inboxReaderConfig(space), 5),
  consumer(dmStream(space), `dm_${pk.name}`, dmDurableConfig(space, "local", "agent_1"), 3),
  consumer(dlvStream(space), `dlv_${pk.name}`, dlvDurableConfig(space, "local", "agent_1"), 2),
  consumer(taskStream(space), "svc_worker", {
    ...taskDurableConfig(space, "worker"),
    deliver_policy: DeliverPolicy.All,
  }, 1),
];
for (const info of infos) validatePersistentConsumer(space, info.stream_name, info);

const byStream = Object.fromEntries(inventory.full.map((stream) => [stream, [] as ConsumerInfo[]]));
for (const info of infos) byStream[info.stream_name].push(info);
const statesByStream = Object.fromEntries(inventory.full.map((stream) => [stream, {
  messages: 20,
  bytes: 200,
  first_seq: 1,
  last_seq: 20,
  consumer_count: byStream[stream].length,
}]));
const checkpoints = validatePersistentConsumerInventory(space, byStream, statesByStream);
assert.equal(checkpoints.length, 5);
const dmCheckpoint = checkpoints.find((checkpoint) => checkpoint.name.startsWith("dm_"))!;
assert.equal(consumerConfigFromCheckpoint(space, dmCheckpoint).opt_start_seq, 4);
assert.equal(consumerConfigFromCheckpoint(space, dmCheckpoint).deliver_policy, DeliverPolicy.StartSequence);
const taskCheckpoint = checkpoints.find((checkpoint) => checkpoint.name === "svc_worker")!;
assert.deepEqual(consumerConfigFromCheckpoint(space, taskCheckpoint), {
  ...taskDurableConfig(space, "worker"),
  deliver_policy: DeliverPolicy.All,
});
assert.throws(
  () => validatePersistentConsumer(space, taskStream(space), {
    ...infos[4],
    config: { ...infos[4].config, deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: 2 },
  }),
  /noncanonical delivery policy/,
);

const migrated = consumer(dmStream(space), `dm_${pk.name}`, {
  ...dmDurableConfig(space, "local", "agent_1"),
  deliver_policy: DeliverPolicy.StartSequence,
  opt_start_seq: 20,
}, 0);
byStream[dmStream(space)] = [migrated];
const migratedCheckpoint = validatePersistentConsumerInventory(space, byStream, statesByStream)
  .find((checkpoint) => checkpoint.name === migrated.name)!;
assert.equal(migratedCheckpoint.creationLowerBound, 20);
assert.equal(consumerConfigFromCheckpoint(space, migratedCheckpoint).opt_start_seq, 20);

assert.throws(
  () => validatePersistentConsumer(space, dmStream(space), {
    ...infos[2],
    config: { ...infos[2].config, deliver_subject: "leak.subject" },
  }),
  /push consumer/,
);
const kvInventory = { ...byStream, [inventory.registry[0]]: [infos[2]] };
assert.throws(() => validatePersistentConsumerInventory(space, kvInventory, statesByStream), /unsupported persistent consumer/);

assert.throws(
  () => consumerConfigFromCheckpoint(space, {
    ...dmCheckpoint,
    ackFloorStreamSequence: dmCheckpoint.streamState.last_seq + 1,
  }),
  /ACK floor exceeds snapshot last sequence/,
);
assert.throws(
  () => consumerConfigFromCheckpoint(space, {
    ...dmCheckpoint,
    creationLowerBound: dmCheckpoint.streamState.last_seq + 2,
  }),
  /creation lower bound exceeds snapshot sequence window/,
);
assert.throws(
  () => consumerConfigFromCheckpoint(space, {
    ...dmCheckpoint,
    ackFloorStreamSequence: Number.MAX_SAFE_INTEGER,
    creationLowerBound: Number.MAX_SAFE_INTEGER,
    streamState: { messages: 1, first_seq: Number.MAX_SAFE_INTEGER, last_seq: Number.MAX_SAFE_INTEGER },
  }),
  /ACK floor has no safe successor/,
);
assert.throws(
  () => consumerConfigFromCheckpoint(space, { ...taskCheckpoint, creationLowerBound: 2 }),
  /noncanonical TASK creation lower bound/,
);
assert.equal(consumerConfigFromCheckpoint(space, {
  ...dmCheckpoint,
  ackFloorStreamSequence: 2,
  creationLowerBound: 1,
  streamState: { messages: 6, first_seq: 5, last_seq: 10 },
}).opt_start_seq, 5, "checkpoint starts at the first retained snapshot sequence");

const backupPerms = backupProfilePermissions(space, connId, {
  operation: "snapshot",
  stream: chatStream(space),
  deliverSubject: `_INBOX_${connId}.snapshot.attempt1`,
}) as { pub: { allow: string[] }; sub: { allow: string[] } };
assert.deepEqual(backupPerms.pub.allow, [
  `$JS.API.STREAM.SNAPSHOT.${chatStream(space)}`,
]);
assert.ok(!backupPerms.pub.allow.some((subject) => subject.includes("RESTORE") || subject === "$JS.>"));

const inspectRegistry = backupProfilePermissions(space, connId, {
  operation: "inspect",
  selection: "registry",
}) as { pub: { allow: string[] } };
assert.deepEqual(inspectRegistry.pub.allow, [
  "$JS.API.STREAM.NAMES",
  `$JS.API.STREAM.INFO.${inventory.registry[0]}`,
  `$JS.API.CONSUMER.LIST.${inventory.registry[0]}`,
]);
assert.ok(!inspectRegistry.pub.allow.some((subject) => subject.includes("MSG.GET") || subject.includes(chatStream(space))));
const inspectFull = backupProfilePermissions(space, connId, {
  operation: "inspect",
  selection: "full",
}) as { pub: { allow: string[] } };
assert.equal(inspectFull.pub.allow.length, 1 + inventory.full.length * 2);

const restoreInit = restoreProfilePermissions(space, connId, {
  operation: "initiate",
  stream: chatStream(space),
}) as {
  pub: { allow: string[] };
};
assert.deepEqual(restoreInit.pub.allow, [`$JS.API.STREAM.RESTORE.${chatStream(space)}`]);
const restoreUpload = restoreProfilePermissions(space, connId, {
  operation: "upload",
  stream: chatStream(space),
  deliverSubject: `$JS.SNAPSHOT.RESTORE.${chatStream(space)}.attempt1`,
}) as { pub: { allow: string[] } };
assert.deepEqual(restoreUpload.pub.allow, [`$JS.SNAPSHOT.RESTORE.${chatStream(space)}.attempt1`]);
assert.throws(
  () => restoreProfilePermissions(space, connId, {
    operation: "upload",
    stream: chatStream(space),
    deliverSubject: `$JS.SNAPSHOT.RESTORE.${dmStream(space)}.attempt1`,
  }),
  /does not belong/,
);
const restoreValidate = restoreProfilePermissions(space, connId, {
  operation: "validate",
  stream: chatStream(space),
}) as { pub: { allow: string[] } };
assert.deepEqual(restoreValidate.pub.allow, [`$JS.API.STREAM.INFO.${chatStream(space)}`]);
const restoreCheckpoint = restoreProfilePermissions(space, connId, {
  operation: "checkpoint",
  checkpoint: dmCheckpoint,
}) as { pub: { allow: string[] } };
assert.deepEqual(restoreCheckpoint.pub.allow, [
  `$JS.API.CONSUMER.CREATE.${dmCheckpoint.stream}.${dmCheckpoint.name}.${dmDurableConfig(space, "local", "agent_1").filter_subject}`,
  `$JS.API.CONSUMER.INFO.${dmCheckpoint.stream}.${dmCheckpoint.name}`,
]);
assert.ok(!restoreCheckpoint.pub.allow.some((subject) => subject.includes("MSG.NEXT") || subject.includes("MSG.GET")));
assert.throws(
  () => restoreProfilePermissions(space, connId, {
    operation: "checkpoint",
    checkpoint: { ...dmCheckpoint, name: "not_cotal" },
  }),
  /unsupported persistent consumer/,
);
assert.equal(CREDENTIAL_LIFETIMES.backup.class, "one-shot");
assert.equal(CREDENTIAL_LIFETIMES.restore.class, "one-shot");
assert.ok(CREDENTIAL_LIFETIMES.backup.defaultTtlSeconds);
assert.ok(CREDENTIAL_LIFETIMES.restore.defaultTtlSeconds);

// A failed sink owns no bytes: it must reject the transfer without ACKing the chunk or accepting EOF.
let snapshotCallback!: (error: Error | null, msg: any) => void;
let chunkAcks = 0;
let unsubscribed = false;
let rejectSink!: (error: Error) => void;
let sinkStartedResolve!: () => void;
const sinkStarted = new Promise<void>((resolve) => { sinkStartedResolve = resolve; });
const sinkGate = new Promise<void>((_, reject) => { rejectSink = reject; });
const encoder = new TextEncoder();
const fakeNc = {
  subscribe(_subject: string, opts: { callback: typeof snapshotCallback }) {
    snapshotCallback = opts.callback;
    return { unsubscribe() { unsubscribed = true; } };
  },
  async flush() {},
  async request() {
    queueMicrotask(() => {
      snapshotCallback(null, {
        data: new Uint8Array([1, 2, 3]),
        reply: "$JS.SNAPSHOT.ACK.fake.id.3.1",
        respond() { chunkAcks++; return true; },
      });
      snapshotCallback(null, { data: new Uint8Array(0), respond() { return false; } });
    });
    return {
      data: encoder.encode(JSON.stringify({
        config: canonicalBackupStreamConfig(space, chatStream(space)),
        state: { messages: 1, bytes: 3, first_seq: 1, last_seq: 1, consumer_count: 0 },
      })),
    };
  },
} as any;
const failedTransfer = downloadStreamSnapshot(fakeNc, chatStream(space), {
  deliverSubject: "_INBOX_fake.snapshot",
  sinkTimeoutMs: 500,
  onChunk: () => {
    sinkStartedResolve();
    return sinkGate;
  },
});
await sinkStarted;
assert.equal(chunkAcks, 0, "chunk is not ACKed while its sink is pending");
rejectSink(new Error("sink refused bytes"));
await assert.rejects(failedTransfer, /sink refused bytes/);
assert.equal(chunkAcks, 0, "failed sink bytes are never ACKed");
assert.equal(unsubscribed, true, "failed transfer unsubscribes without successful EOF completion");

let replylessCallback!: (error: Error | null, msg: any) => void;
const replylessEvents: string[] = [];
const replylessNc = {
  subscribe(_subject: string, opts: { callback: typeof replylessCallback }) {
    replylessCallback = opts.callback;
    return { unsubscribe() {} };
  },
  async flush() {},
  async request() {
    queueMicrotask(() => {
      replylessCallback(null, {
        data: new Uint8Array([9]),
        reply: "",
        respond() { throw new Error("reply-less chunk must not be ACKed"); },
      });
      replylessCallback(null, {
        data: new Uint8Array([10]),
        respond() { throw new Error("reply-less chunk must not be ACKed"); },
      });
      replylessCallback(null, {
        data: new Uint8Array([11]),
        reply: "$JS.SNAPSHOT.ACK.fake.id.1.2",
        respond() { replylessEvents.push("ack:11"); return true; },
      });
      replylessCallback(null, {
        data: new Uint8Array([12]),
        reply: "",
        respond() { throw new Error("reply-less chunk must not be ACKed"); },
      });
      replylessCallback(null, { data: new Uint8Array(0), respond() { return false; } });
    });
    return {
      data: encoder.encode(JSON.stringify({
        config: canonicalBackupStreamConfig(space, chatStream(space)),
        state: { messages: 1, bytes: 1, first_seq: 1, last_seq: 1, consumer_count: 0 },
      })),
    };
  },
} as any;
await downloadStreamSnapshot(replylessNc, chatStream(space), {
  deliverSubject: "_INBOX_fake.replyless",
  onChunk: async (chunk) => {
    await Promise.resolve();
    replylessEvents.push(`sink:${chunk[0]}`);
  },
});
assert.deepEqual(
  replylessEvents,
  ["sink:9", "sink:10", "sink:11", "ack:11", "sink:12"],
  "multiple reply-less chunks share the ordered sink and only reply-bearing chunks ACK after sink success",
);

let stalledUnsubscribed = false;
const stalledNc = {
  subscribe() {
    return { unsubscribe() { stalledUnsubscribed = true; } };
  },
  async flush() {},
  request() { return new Promise(() => {}); },
} as any;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
try {
  await assert.rejects(downloadStreamSnapshot(stalledNc, chatStream(space), {
    deliverSubject: "_INBOX_fake.stalled",
    timeoutMs: 20,
    onChunk: () => {},
  }), /transfer deadline exceeded/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(unhandled, [], "stalled initiation has no internal unhandled rejection");
  assert.equal(stalledUnsubscribed, true, "stalled initiation obeys the public transfer deadline");
} finally {
  process.off("unhandledRejection", onUnhandled);
}

let settlingCallback!: (error: Error | null, msg: any) => void;
let releaseSink!: () => void;
let settlingSinkDone = false;
let settlingUnsubscribed = false;
const settlingGate = new Promise<void>((resolve) => { releaseSink = resolve; });
const settlingNc = {
  subscribe(_subject: string, opts: { callback: typeof settlingCallback }) {
    settlingCallback = opts.callback;
    return { unsubscribe() { settlingUnsubscribed = true; } };
  },
  async flush() {},
  async request() {
    queueMicrotask(() => settlingCallback(null, {
      data: new Uint8Array([4, 5]),
      reply: "$JS.SNAPSHOT.ACK.fake.id.2.1",
      respond() { throw new Error("must not ACK after failure"); },
    }));
    return {
      data: encoder.encode(JSON.stringify({
        config: canonicalBackupStreamConfig(space, chatStream(space)),
        state: { messages: 1, bytes: 2, first_seq: 1, last_seq: 1, consumer_count: 0 },
      })),
    };
  },
} as any;
const settlingTransfer = downloadStreamSnapshot(settlingNc, chatStream(space), {
  deliverSubject: "_INBOX_fake.settling",
  sinkTimeoutMs: 200,
  onChunk: async () => {
    queueMicrotask(() => settlingCallback(new Error("snapshot transport failed"), {}));
    await settlingGate;
    settlingSinkDone = true;
  },
});
let settlingReturned = false;
const settlingOutcome = settlingTransfer.then(
  () => undefined,
  (error) => error,
).then((outcome) => {
  settlingReturned = true;
  return outcome;
});
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(settlingUnsubscribed, true, "failure unsubscribes before sink settlement");
assert.equal(settlingReturned, false, "failure waits for the active sink");
releaseSink();
const settlingError = await settlingOutcome;
assert.match((settlingError as Error).message, /snapshot transport failed/);
assert.equal(settlingSinkDone, true, "sink is settled before transfer failure returns");

console.log("backup broker-free smoke: ok");
