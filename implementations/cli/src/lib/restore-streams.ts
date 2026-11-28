import { randomUUID } from "node:crypto";
import {
  drainAndClose,
  anycastStoreDefinition,
  canonicalBackupStreamConfig,
  historyLimitOf,
  historyLimitRestoreStaging,
  historyLimitStreamOf,
  readPluginMaintenanceState,
  consumerConfigFromCheckpoint,
  deliveryBucket,
  downloadStreamSnapshot,
  finalizeStreamRestore,
  initiateStreamRestore,
  LEASE_TTL_MS,
  managerBucket,
  MANAGER_LEASE_TTL_MS,
  membershipStoreDefinition,
  PRESENCE_STORAGE,
  presenceBucket,
  recreateConsumerCheckpoint,
  spaceBackupInventory,
  uploadStreamRestoreChunk,
  validateSpaceBackupInventory,
  validateBackupStreamState,
  validateCanonicalBackupStreamConfig,
  type PersistentConsumerCheckpoint,
  createEndpointStreams,
  ensureArtifactStore,
  hardenedAuthorityStreamNames,
  setHistoryLimit,
  type HistoryLimit,
  type StoredHistoryLimitStream,
} from "@cotal-ai/core";
import { constants, fsyncSync, openSync, readSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { declaredArtifactStreams, type BackupManifest, type StagedArtifact } from "./backup-artifact.js";
import { connectIsolatedBroker, type IsolatedBroker } from "./isolated-broker.js";

export const RESTORE_TIMEOUT_MS = 30 * 60 * 1000;
const CHUNK_BYTES = 1024 * 1024;

function dataStateFingerprint(input: Readonly<Record<string, unknown>>): string {
  const state = validateBackupStreamState(input);
  return JSON.stringify({
    messages: state.messages,
    bytes: state.bytes,
    // An empty stream is its last sequence: the validator admits it only as initial (0 and 0) or
    // exhausted (last_seq + 1), and nats-server 2.15 restores an initial one as exhausted.
    first_seq: state.messages === 0 ? state.last_seq + 1 : state.first_seq,
    last_seq: state.last_seq,
    deleted: [...(state.deleted ?? [])].sort((a, b) => a - b),
    num_deleted: state.num_deleted ?? 0,
  });
}

function assertRestoredState(stream: string, expected: Readonly<Record<string, unknown>>, actual: Readonly<Record<string, unknown>>): void {
  if (dataStateFingerprint(expected) !== dataStateFingerprint(actual))
    throw new Error(`${stream} restored message state does not match the backup manifest`);
}

type RestorePass = "quarantine" | "target";

/** Smoke hook: `COTAL_SMOKE_FAIL_RESTORE_STREAM=<stream>` fires on any pass; `<pass>:<stream>`
 *  fires only on that pass (so the target pass is reachable after quarantine succeeded), and
 *  `age:<stream>` as the restore applies that stream's recorded age. */
function smokeFailRestoreStream(pass: RestorePass | "age", stream: string): boolean {
  const spec = process.env.COTAL_SMOKE_FAIL_RESTORE_STREAM;
  if (!spec) return false;
  const separator = spec.indexOf(":");
  if (separator < 0) return spec === stream;
  return spec.slice(0, separator) === pass && spec.slice(separator + 1) === stream;
}

/** The history limit the backup recorded, when `record` is CHAT's, INBOX's, DLV's or DM's. Every
 *  restore check holds that stream at {@link historyLimitRestoreStaging} of it, which keeps the
 *  recorded count and sets no age, so nothing expires while the restored state is compared. */
function recordedHistoryLimit(space: string, record: BackupManifest["streams"][number]): { kind: StoredHistoryLimitStream; limit: HistoryLimit } | undefined {
  const kind = historyLimitStreamOf(space, record.stream);
  return kind && { kind, limit: historyLimitOf(record.config) };
}

async function restoreStream(
  broker: IsolatedBroker,
  space: string,
  snapshotDir: string,
  pass: RestorePass,
  stream: BackupManifest["streams"][number],
): Promise<void> {
  const recorded = recordedHistoryLimit(space, stream);
  const initLogin = await broker.addLogin({
    profile: "restore",
    scope: { operation: "initiate", stream: stream.stream },
  });
  const init = await connectIsolatedBroker(broker, initLogin);
  let session;
  try {
    session = await initiateStreamRestore(
      init,
      space,
      stream.stream,
      canonicalBackupStreamConfig(space, stream.stream, recorded && historyLimitRestoreStaging(recorded.kind, recorded.limit)),
      stream.state as unknown as Readonly<Record<string, unknown>>,
      RESTORE_TIMEOUT_MS,
    );
  } finally {
    await drainAndClose(init).catch(() => {});
  }
  const uploadLogin = await broker.addLogin({
    profile: "restore",
    scope: { operation: "upload", stream: stream.stream, deliverSubject: session.deliverSubject },
  });
  if (smokeFailRestoreStream(pass, stream.stream))
    throw new Error(`smoke-injected exact-ID chunk handoff timeout for ${stream.stream} (${pass})`);
  const upload = await connectIsolatedBroker(broker, uploadLogin);
  const fd = openSync(join(snapshotDir, stream.snapshot), constants.O_RDONLY);
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      await uploadStreamRestoreChunk(upload, session, buffer.subarray(0, count), RESTORE_TIMEOUT_MS);
    }
    const restored = await finalizeStreamRestore(upload, session, RESTORE_TIMEOUT_MS);
    validateCanonicalBackupStreamConfig(space, stream.stream, restored.config, { restoreStagingFor: recorded?.limit });
    assertRestoredState(stream.stream, stream.state as unknown as Readonly<Record<string, unknown>>, restored.state as unknown as Readonly<Record<string, unknown>>);
  } finally {
    closeSync(fd);
    await drainAndClose(upload).catch(() => {});
  }
}

/** Re-snapshot one validated quarantine stream (`no_consumers` native form) into an attempt-owned
 *  pinned file. The real target is instantiated ONLY from these sanitized bytes, never from the
 *  archive-supplied snapshot. */
export async function sanitizeStreamSnapshot(
  broker: IsolatedBroker,
  space: string,
  stream: BackupManifest["streams"][number],
  destination: string,
): Promise<void> {
  const exact = await broker.addLogin((connId) => ({
    profile: "backup",
    scope: {
      operation: "snapshot",
      stream: stream.stream,
      deliverSubject: `_INBOX_${connId}.sanitize.${randomUUID().replaceAll("-", "")}`,
    },
  }));
  const deliverSubject = (exact.scope as { profile: "backup"; scope: { deliverSubject: string } }).scope.deliverSubject;
  const nc = await connectIsolatedBroker(broker, exact);
  const fd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const metadata = await downloadStreamSnapshot(nc, stream.stream, {
      deliverSubject,
      timeoutMs: RESTORE_TIMEOUT_MS,
      checkMessages: true,
      onChunk: (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
          if (written <= 0) throw new Error("sanitized snapshot write made no progress");
          offset += written;
        }
      },
    });
    validateCanonicalBackupStreamConfig(space, stream.stream, metadata.config, { restoreStagingFor: recordedHistoryLimit(space, stream)?.limit });
    assertRestoredState(stream.stream, stream.state as unknown as Readonly<Record<string, unknown>>, metadata.state as unknown as Readonly<Record<string, unknown>>);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
    await drainAndClose(nc).catch(() => {});
  }
}

async function validateRestoredStream(
  broker: IsolatedBroker,
  space: string,
  record: BackupManifest["streams"][number],
  expectedConsumers: number,
): Promise<void> {
  const login = await broker.addLogin({
    profile: "restore",
    scope: { operation: "validate", stream: record.stream },
  });
  const nc = await connectIsolatedBroker(broker, login);
  try {
    const response = await nc.request(`$JS.API.STREAM.INFO.${record.stream}`, "{}", { timeout: RESTORE_TIMEOUT_MS });
    const info = JSON.parse(response.string()) as {
      config?: Record<string, unknown>;
      state?: Record<string, unknown> & { consumer_count: number };
      error?: { description?: string };
    };
    if (info.error) throw new Error(info.error.description ?? `${record.stream} validation failed`);
    if (!info.config || !info.state) throw new Error(`${record.stream} validation returned an incomplete response`);
    validateCanonicalBackupStreamConfig(space, record.stream, info.config as unknown as Record<string, unknown>, { restoreStagingFor: recordedHistoryLimit(space, record)?.limit });
    assertRestoredState(record.stream, record.state as unknown as Readonly<Record<string, unknown>>, info.state as unknown as Readonly<Record<string, unknown>>);
    if (info.state.consumer_count !== expectedConsumers)
      throw new Error(`${record.stream} has ${info.state.consumer_count} consumers after restore; expected ${expectedConsumers}`);
  } finally {
    await drainAndClose(nc).catch(() => {});
  }
}

/** Give a restored CHAT, INBOX, DLV or DM stream the age the backup recorded, after the target's last
 *  check, and read it back; a failure fails the restore. No full-state comparison runs after it,
 *  since the broker may expire entries as soon as it lands. A process that dies before this write
 *  leaves the target at age 0, before commit intent, so the attempt rolls back with it. Each login
 *  reaches its one stream alone and only updates it. */
export async function applyRecordedAge(broker: IsolatedBroker, space: string, record: BackupManifest["streams"][number]): Promise<void> {
  const recorded = recordedHistoryLimit(space, record);
  if (!recorded || recorded.limit.maxAgeMs === 0) return;
  if (smokeFailRestoreStream("age", record.stream)) throw new Error(`smoke-injected failure applying the recorded age of ${record.stream}`);
  const login = await broker.addLogin({ profile: "infrastructure", streams: [record.stream], updateStreams: [record.stream] });
  const nc = await connectIsolatedBroker(broker, login);
  try {
    await setHistoryLimit(await jetstreamManager(nc), space, recorded.kind, recorded.limit, historyLimitRestoreStaging(recorded.kind, recorded.limit));
  } finally {
    await drainAndClose(nc).catch(() => {});
  }
}

async function recreateCheckpoint(
  broker: IsolatedBroker,
  space: string,
  checkpoint: PersistentConsumerCheckpoint,
  openArtifact: boolean,
): Promise<void> {
  const expected = consumerConfigFromCheckpoint(space, checkpoint, openArtifact);
  const login = await broker.addLogin({
    profile: "restore",
    scope: { operation: "checkpoint", checkpoint },
  });
  const nc = await connectIsolatedBroker(broker, login);
  try {
    const info = await recreateConsumerCheckpoint(nc, space, checkpoint, RESTORE_TIMEOUT_MS, openArtifact);
    if (info.config.opt_start_seq !== expected.opt_start_seq || info.config.deliver_policy !== expected.deliver_policy)
      throw new Error(`${checkpoint.stream}/${checkpoint.name} did not preserve its conservative checkpoint floor`);
    // A fresh durable can report a zero ACK floor or effectiveStart - 1. The start policy
    // above preserves the replay position in either case. No delivery or pending ACK may
    // have advanced the new consumer, and no other stream floor is accepted.
    const bornFloor = Math.max(expected.opt_start_seq ?? 1, checkpoint.streamState.first_seq || 1) - 1;
    const floor = info.ack_floor.stream_seq;
    if ((floor !== 0 && floor !== bornFloor) || info.ack_floor.consumer_seq !== 0 ||
        info.delivered?.consumer_seq !== 0 || info.num_ack_pending !== 0)
      throw new Error(`${checkpoint.stream}/${checkpoint.name} was not recreated as an unused checkpoint with stream ACK floor 0 or ${bornFloor}`);
  } finally {
    await drainAndClose(nc).catch(() => {});
  }
}

async function createOmittedInfrastructure(
  broker: IsolatedBroker,
  space: string,
  restored: readonly string[],
  pluginChannels: boolean,
): Promise<void> {
  const inventory = spaceBackupInventory(space, pluginChannels);
  // The workflow stores are endpoint stores: createEndpointStreams below creates the ones the
  // artifact did not hold and verifies the restored ones.
  const workflow = inventory.backedUp.filter((entry) => entry.class === "workflow").map((entry) => entry.name);
  const create = inventory.full.filter((name) => !restored.includes(name) && !workflow.includes(name));
  const excluded = [...workflow, ...inventory.excluded.map((entry) => entry.name)];
  const login = await broker.addLogin({
    profile: "infrastructure",
    streams: [...create, ...excluded],
    // createEndpointStreams hardens each fresh authority store with one STREAM.UPDATE right after
    // KVM creates it. Core names those stores in one list, so this login and the provisioner cannot
    // disagree about which they are; the update grant stays separate from the wider create/info
    // set so restored message streams remain immutable.
    updateStreams: hardenedAuthorityStreamNames(space),
  });
  const nc = await connectIsolatedBroker(broker, login);
  try {
    const jsm = await jetstreamManager(nc);
    for (const stream of create) await jsm.streams.add(canonicalBackupStreamConfig(space, stream));
    const kvm = new Kvm(nc);
    await kvm.create(presenceBucket(space), { ttl: 6_000, storage: PRESENCE_STORAGE });
    const membership = membershipStoreDefinition(space);
    await kvm.create(membership.bucket, membership.createOptions);
    const anycast = anycastStoreDefinition(space);
    await kvm.create(anycast.bucket, anycast.createOptions);
    await kvm.create(deliveryBucket(space), { ttl: LEASE_TTL_MS });
    await kvm.create(managerBucket(space), { ttl: MANAGER_LEASE_TTL_MS });
    // The other endpoint stores are nonportable control state. Recreate them empty, with any workflow
    // store the artifact did not hold, through the same production seam as ordinary space setup,
    // which verifies the restored workflow stores.
    await createEndpointStreams(jsm, kvm, space);
    // The artifact Object Store is EXCLUDED from the backup artifact, which does not mean restore
    // ignores it: the assertion below covers `excluded` too, so a restored space must come back
    // with an EMPTY store rather than none. Excluding a stream and forgetting to recreate it is the
    // failure that only appears at restore - the one moment nobody is watching for a new defect.
    // Create-or-verify (not a bare create): a restore target that already holds a drifted store must
    // refuse rather than adopt it, which matters more here than at setup - a restore is exactly when
    // an operator is least able to tell an inherited config from a fresh one.
    await ensureArtifactStore(nc, space);
    for (const stream of [...create, ...excluded]) await jsm.streams.info(stream);
    // The normal listener is exposed only over a complete space: assert the exact stream inventory
    // (restored + created + excluded transient) before the coordinator may write commit intent.
    const names: string[] = [];
    for (let offset = 0;;) {
      const message = await nc.request("$JS.API.STREAM.NAMES", JSON.stringify({ offset }), { timeout: RESTORE_TIMEOUT_MS });
      const page = JSON.parse(message.string()) as { streams?: string[]; total?: number; offset?: number; error?: { description?: string } };
      if (page.error) throw new Error(`post-restore inventory listing failed: ${page.error.description ?? "JetStream error"}`);
      if (!Number.isSafeInteger(page.total) || !Number.isSafeInteger(page.offset))
        throw new Error("post-restore inventory listing returned an invalid page");
      names.push(...(page.streams ?? []));
      const next = page.offset! + (page.streams?.length ?? 0);
      if (next >= page.total!) break;
      if (next <= offset) throw new Error("post-restore inventory pagination made no progress");
      offset = next;
    }
    validateSpaceBackupInventory(space, names, { pluginChannels });
  } finally {
    await drainAndClose(nc).catch(() => {});
  }
}

export async function restoreAndValidate(
  broker: IsolatedBroker,
  space: string,
  staged: StagedArtifact,
  snapshotDir: string,
  pass: RestorePass,
  onlyRegistry: boolean,
  checkpoints: readonly PersistentConsumerCheckpoint[],
  completeInfrastructure: boolean,
  pluginChannels = false,
): Promise<void> {
  const wanted = onlyRegistry ? spaceBackupInventory(space).registry : declaredArtifactStreams(staged.manifest);
  for (const name of wanted) await restoreStream(broker, space, snapshotDir, pass, staged.manifest.streams.find((entry) => entry.stream === name)!);
  for (const name of wanted)
    await validateRestoredStream(broker, space, staged.manifest.streams.find((entry) => entry.stream === name)!, 0);
  if (completeInfrastructure) await createOmittedInfrastructure(broker, space, wanted, pluginChannels);
  if (!onlyRegistry) for (const checkpoint of checkpoints)
    await recreateCheckpoint(broker, space, checkpoint, staged.manifest.mode === "open");
  if (!onlyRegistry) for (const name of wanted) {
    const count = checkpoints.filter((checkpoint) => checkpoint.stream === name).length;
    await validateRestoredStream(broker, space, staged.manifest.streams.find((entry) => entry.stream === name)!, count);
  }
}

/** Read the restored records store with a separate read-only phase before listener exposure. */
export async function restoredPluginState(broker: IsolatedBroker, space: string): ReturnType<typeof readPluginMaintenanceState> {
  const login = await broker.addLogin({ profile: "backup", scope: { operation: "plugin-state" } });
  const nc = await connectIsolatedBroker(broker, login);
  try {
    return await readPluginMaintenanceState(nc, space);
  } finally { await drainAndClose(nc).catch(() => {}); }
}
