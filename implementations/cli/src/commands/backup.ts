import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { ConsumerInfo } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  downloadStreamSnapshot,
  spaceBackupInventory,
  validateCanonicalBackupStreamConfig,
  validateBackupStreamState,
  validatePersistentConsumerInventory,
  validateSpaceBackupInventory,
  type ParsedArgs,
  type FlagSpec,
  type CompletionResult,
  type SpaceBackupSelection,
  type PersistentConsumerCheckpoint,
  type BackupStreamState,
} from "@cotal-ai/core";
import {
  CommandFailure, isCommandFailure, isMaintenanceError, jsonFlag, plainFlag, presentationOf, writeResult, type Report,
  acquireMaintenanceLock,
  assertSingleSpaceBroker,
  assertStoreIdentity,
  authDir,
  claimMaintenanceReady,
  cutController,
  getSpaceAuth,
  readMaintenanceJournal,
  recordMaintenanceClaimResources,
  recoverStaleMaintenanceClaim,
  readStoreIdentity,
  releaseMaintenanceClaim,
  releaseMaintenanceLock,
  sameStoreIdentity,
  workspaceSecretStore,
  type MaintenanceReadyRecord,
  type ProcessOwner,
} from "@cotal-ai/workspace";
import { createArtifactWriter, snapshotFileName, type BackupFileRecord, type BackupStreamRecord } from "../lib/backup-artifact.js";
import { assertControllerResumeEligible } from "../lib/controller-resume.js";
import { assertControllerBrokerConfig } from "../lib/controller-restore.js";
import { refuseControllerCut } from "../lib/stack-journal.js";
import { authorityFingerprint } from "../lib/maintenance-files.js";
import { connectIsolatedBroker, createAttemptClone, ensurePrivateAttemptsDir, startIsolatedBroker, sweepAttemptResidue, type IsolatedBroker } from "../lib/isolated-broker.js";
import { cotalRoot } from "../lib/paths.js";
import { liveMeshProcesses } from "./clean.js";
import { backupMaintenance } from "./backup-maintenance.js";
import { backupRead } from "./backup-read.js";
import { backupRestore } from "./backup-restore.js";
import { completingFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { assertEndpointUnreachable } from "../lib/endpoint-cut.js";

const OPERATION_TIMEOUT_MS = 30 * 60 * 1000;

export const backupFlags: FlagSpec[] = [jsonFlag, plainFlag,
  { name: "yes", short: "y", type: "boolean", description: "recover/cleanup-fallback: confirm only the exact reviewed restore attempt" },
  { name: "dry-run", type: "boolean", description: "recover/cleanup-fallback: read the original journal and paths without a lock or write" },
  { name: "only", type: "string", value: "<full|registry>", description: "create: artifact selection (default full; registry is the only partial); restore: only registry, to restore just the registry (default follows the artifact)" },
  { name: "store-dir", type: "string", value: "<dir>", description: "create: preserved source store; restore: restore target (default .cotal/nats)" },
  { name: "accept-missing-source", type: "boolean", description: "restore: explicit disaster consent when the inode-bound preserved source is absent" },
];

export function backupComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, backupFlags);
  if (flag?.name === "only") return { items: (positionalsForCompletion(argv, backupFlags)[0] === "restore" ? ["registry"] : ["full", "registry"]).map((value) => ({ value })), directive: "nofiles" };
  if (flag?.name === "store-dir") return { items: [], directive: "default" };
  const words = positionalsForCompletion(argv, backupFlags);
  return words.length <= 1 ? { items: ["create", "inspect", "verify", "restore", "recover", "cleanup-fallback"].map((value) => ({ value })), directive: "nofiles" } : { items: [], directive: "default" };
}

interface BackupValues {
  json?: boolean;
  plain?: boolean;
  only?: string;
  "store-dir"?: string;
}

function selection(value: string | undefined): SpaceBackupSelection {
  if (value === undefined || value === "full") return "full";
  if (value === "registry") return "registry";
  throw new CommandFailure("refused", "USAGE_INVALID", "--only supports full or registry");
}

function localOwner(id: string): ProcessOwner {
  return { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), id };
}

function requireReady(root: string, storeDir: string): MaintenanceReadyRecord {
  const record = readMaintenanceJournal(root);
  if (!record) throw new Error("backup requires a completed cut; run `cotal down --preserve-state` first");
  if (record.state !== "ready") throw new Error(`backup requires stable ready maintenance state; current state is ${record.state}`);
  const actual = readStoreIdentity(storeDir);
  if (!sameStoreIdentity(record.source, actual))
    throw new Error(`--store-dir does not match the preserved source ${record.source.path}`);
  assertStoreIdentity(record.source);
  // Backup coupling: a controller cut is backed up only while every member is the
  // stopped record the cut recorded, with its receipt, the broker definition is the expected one, and
  // the configuration it names hashes to the cut launch's recorded configuration.
  const controller = cutController(record.cut);
  if (controller) {
    assertControllerResumeEligible(record.space, controller, record.cutCompletion.controllerStops ?? [], controller.brokerDefinitionRevision);
    assertControllerBrokerConfig(record.space, controller);
  }
  return record;
}

async function inspectionConnection(broker: IsolatedBroker): Promise<NatsConnection> {
  return connectIsolatedBroker(broker, broker.initialLogin);
}

async function collectInventory(nc: NatsConnection, space: string, selected: SpaceBackupSelection): Promise<{
  checkpoints: PersistentConsumerCheckpoint[];
}> {
  const requestPage = async <T>(subject: string, offset: number): Promise<T & { total: number; offset: number; limit: number }> => {
    const msg = await nc.request(subject, JSON.stringify({ offset }), { timeout: 10_000 });
    const response = JSON.parse(msg.string()) as T & {
      total?: number;
      offset?: number;
      limit?: number;
      error?: { description?: string };
    };
    if (response.error) throw new Error(response.error.description ?? `JetStream request failed for ${subject}`);
    if (!Number.isSafeInteger(response.total) || !Number.isSafeInteger(response.offset) || !Number.isSafeInteger(response.limit))
      throw new Error(`JetStream returned an invalid page for ${subject}`);
    return response as T & { total: number; offset: number; limit: number };
  };
  const streamNames: string[] = [];
  for (let offset = 0;;) {
    const page = await requestPage<{ streams?: string[] }>("$JS.API.STREAM.NAMES", offset);
    streamNames.push(...(page.streams ?? []));
    const next = page.offset + (page.streams?.length ?? 0);
    if (next >= page.total) break;
    if (next <= offset) throw new Error("JetStream stream inventory pagination made no progress");
    offset = next;
  }
  // The clone is a stopped store on a fresh broker, so the memory-backed presence bucket is gone.
  validateSpaceBackupInventory(space, streamNames, { atRest: true });
  const inventory = spaceBackupInventory(space);
  const expected = inventory[selected];
  const consumersByStream: Record<string, ConsumerInfo[]> = {};
  const statesByStream: Record<string, BackupStreamState> = {};
  for (const stream of expected) {
    const infoMessage = await nc.request(`$JS.API.STREAM.INFO.${stream}`, "{}", { timeout: 10_000 });
    const streamInfo = JSON.parse(infoMessage.string()) as {
      state?: Readonly<Record<string, unknown>>;
      error?: { description?: string };
    };
    if (streamInfo.error) throw new Error(streamInfo.error.description ?? `JetStream stream info failed for ${stream}`);
    if (!streamInfo.state) throw new Error(`JetStream omitted stream state for ${stream}`);
    statesByStream[stream] = validateBackupStreamState(streamInfo.state);
    const consumers: ConsumerInfo[] = [];
    try {
      for (let offset = 0;;) {
        const page = await requestPage<{ consumers?: ConsumerInfo[] }>(`$JS.API.CONSUMER.LIST.${stream}`, offset);
        consumers.push(...(page.consumers ?? []));
        const next = page.offset + (page.consumers?.length ?? 0);
        if (next >= page.total) break;
        if (next <= offset) throw new Error(`JetStream consumer pagination made no progress for ${stream}`);
        offset = next;
      }
    } catch (error) {
      throw new Error(`isolated backup cannot enumerate consumers for ${stream}: ${(error as Error).message}`);
    }
    consumersByStream[stream] = consumers;
  }
  if (selected === "registry") {
    const registry = inventory.registry[0];
    const consumers = consumersByStream[registry] ?? [];
    if (consumers.some((consumer) => !isStoppedKvWatcher(registry, consumer)))
      throw new Error(`${registry} has an unsupported consumer`);
    return { checkpoints: [] };
  }
  const backedConsumers = Object.fromEntries(inventory.full.map((stream) => {
    const consumers = consumersByStream[stream] ?? [];
    for (const consumer of consumers)
      if (stream.startsWith("KV_") && consumer.name.startsWith("oc_") && !isStoppedKvWatcher(stream, consumer))
        throw new Error(`${stream}/${consumer.name} has an unsupported stopped KV watcher config: ${JSON.stringify(consumer.config)}`);
    return [stream, consumers.filter((consumer) => !isStoppedKvWatcher(stream, consumer))];
  }));
  return { checkpoints: validatePersistentConsumerInventory(space, backedConsumers, statesByStream) };
}

export function isStoppedKvWatcher(stream: string, consumer: ConsumerInfo): boolean {
  if (!stream.startsWith("KV_")) return false;
  const config = consumer.config;
  const metadata = config.metadata ?? {};
  const activeKeys = new Set([
    "name", "deliver_policy", "ack_policy", "max_deliver", "filter_subject", "replay_policy",
    "flow_control", "deliver_subject", "idle_heartbeat", "inactive_threshold", "num_replicas", "metadata",
    "max_ack_pending", "max_waiting", "headers_only",
  ]);
  const inertRemainder = Object.entries(config).every(([key, value]) =>
    activeKeys.has(key) || value === undefined || value === false || value === 0 || value === "" ||
    (Array.isArray(value) && value.length === 0),
  );
  // The public KV watcher (`keys`/ordinary watch) uses LastPerSubject; the core-owned whole-bucket
  // scanner uses All so concurrent tombstones can collapse correctly. Both are stopped ephemeral
  // readers when every other field below matches the pinned client's ordered-consumer shape.
  return consumer.push_bound !== true &&
    config.name === consumer.name &&
    !config.durable_name &&
    consumer.name.startsWith("oc_") &&
    (config.deliver_policy === "last_per_subject" || config.deliver_policy === "all") &&
    config.ack_policy === "none" &&
    (config.max_deliver === undefined || config.max_deliver === -1 || config.max_deliver === 1) &&
    config.filter_subject === `$KV.${stream.slice(3)}.>` &&
    config.replay_policy === "instant" &&
    config.flow_control === true &&
    typeof config.deliver_subject === "string" && config.deliver_subject.startsWith("_INBOX_") &&
    (config.idle_heartbeat === 5_000_000_000 || config.idle_heartbeat === 30_000_000_000) &&
    (config.inactive_threshold === undefined || config.inactive_threshold === 300_000_000_000) &&
    (config.num_replicas === 0 || config.num_replicas === 1) &&
    (config.max_ack_pending === undefined || config.max_ack_pending === 1000) &&
    (config.max_waiting === undefined || config.max_waiting === 512) &&
    !config.deliver_group &&
    (!config.filter_subjects || config.filter_subjects.length === 0) &&
    Object.entries(metadata).every(([key, value]) => key.startsWith("_nats.") && typeof value === "string") &&
    inertRemainder;
}

export function chunkQueue(): {
  iterable: AsyncIterable<Uint8Array>;
  push(chunk: Uint8Array): Promise<void>;
  close(error?: Error): void;
} {
  let pending: { chunk: Uint8Array; resolve: () => void; reject: (error: Error) => void } | undefined;
  let nextWaiter: { resolve: (value: IteratorResult<Uint8Array>) => void; reject: (error: Error) => void } | undefined;
  let delivered: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let ended = false;
  let failure: Error | undefined;
  const deliver = () => {
    if (!pending || !nextWaiter) return;
    const item = pending;
    const waiter = nextWaiter;
    pending = undefined;
    nextWaiter = undefined;
    delivered = item;
    waiter.resolve({ done: false, value: item.chunk });
  };
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            // The consumer asks for the next chunk only after it has written the previous one.
            delivered?.resolve();
            delivered = undefined;
            if (failure) return Promise.reject(failure);
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolveNext, rejectNext) => {
              nextWaiter = { resolve: resolveNext, reject: rejectNext };
              deliver();
            });
          },
        };
      },
    },
    push(chunk) {
      if (ended || failure) return Promise.reject(failure ?? new Error("snapshot sink is closed"));
      if (pending || delivered) return Promise.reject(new Error("snapshot sink received a concurrent chunk"));
      return new Promise<void>((resolvePush, rejectPush) => {
        pending = { chunk, resolve: resolvePush, reject: rejectPush };
        deliver();
      });
    },
    close(error) {
      failure = error;
      ended = true;
      if (error) {
        pending?.reject(error);
        delivered?.reject(error);
        nextWaiter?.reject(error);
      } else {
        delivered?.resolve();
        nextWaiter?.resolve({ done: true, value: undefined });
      }
      pending = undefined;
      delivered = undefined;
      nextWaiter = undefined;
    },
  };
}

function canonicalFuturePath(path: string): string {
  const absolute = resolve(path);
  return join(realpathSync.native(dirname(absolute)), basename(absolute));
}

function overlaps(a: string, b: string): boolean {
  const fromA = relative(a, b);
  const fromB = relative(b, a);
  const contained = (path: string) => path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
  return contained(fromA) || contained(fromB);
}

function assertBackupPaths(root: string, source: string, destination: string): void {
  const artifact = canonicalFuturePath(destination);
  const attempts = resolve(root, ".cotal", "maintenance", "attempts");
  if (overlaps(source, attempts)) throw new Error("preserved source must not overlap the maintenance attempt directory");
  if (overlaps(artifact, source)) throw new Error("backup destination must not overlap the preserved source store");
  if (overlaps(artifact, attempts)) throw new Error("backup destination must not overlap the maintenance attempt directory");
}

async function snapshotStream(
  writer: ReturnType<typeof createArtifactWriter>,
  broker: IsolatedBroker,
  space: string,
  stream: string,
): Promise<{ file: BackupFileRecord; stream: BackupStreamRecord }> {
  // The private inbox is part of the exact snapshot authority, so mint the phase only after its
  // connection identity is known.
  const exact = await broker.addLogin((connId) => ({
    profile: "backup",
    scope: {
      operation: "snapshot",
      stream,
      deliverSubject: `_INBOX_${connId}.backup.${randomUUID().replaceAll("-", "")}`,
    },
  }));
  const deliverSubject = (exact.scope as { profile: "backup"; scope: { deliverSubject: string } }).scope.deliverSubject;
  const nc: NatsConnection = await connectIsolatedBroker(broker, exact);
  const queue = chunkQueue();
  const name = snapshotFileName(stream);
  const write = writer.writeFile(name, "snapshot", queue.iterable, stream);
  void write.catch((error) => queue.close(error instanceof Error ? error : new Error(String(error))));
  let sunkChunks = 0;
  try {
    const metadata = await downloadStreamSnapshot(nc, stream, {
      deliverSubject,
      timeoutMs: OPERATION_TIMEOUT_MS,
      checkMessages: true,
      onChunk: (chunk) => {
        if (process.env.COTAL_SMOKE_FAIL_BACKUP_STAGE === "chunk" && ++sunkChunks === 1)
          throw new Error("smoke-injected failure at the first snapshot chunk");
        return queue.push(chunk);
      },
    });
    validateCanonicalBackupStreamConfig(space, stream, metadata.config);
    queue.close();
    const file = await write;
    return { file, stream: { stream, snapshot: name, config: metadata.config, state: metadata.state } };
  } catch (error) {
    queue.close(error instanceof Error ? error : new Error(String(error)));
    await write.catch(() => {});
    throw error;
  } finally {
    await nc.drain().catch(() => {});
  }
}

interface BackupCreateResult {
  readonly kind: "backup-created";
  readonly directory: string;
  readonly space: string;
  readonly selection: SpaceBackupSelection;
  readonly createdAt: string;
  readonly streamCount: number;
  readonly fileCount: number;
  readonly attemptId: string;
  readonly sourceGeneration: string;
  readonly restored: false;
}
interface BackupObservation {
  attemptId?: string;
  priorClaimAttemptId?: string;
  mutationAttempted: boolean;
  cleanupConfirmed: boolean;
  published?: BackupCreateResult;
}

export function validateBackupArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode, directory, ...extra] = args.positionals;
  if (!mode || !["create", "inspect", "verify", "restore", "recover", "cleanup-fallback"].includes(mode) || !directory?.trim() || extra.length || /[\u0000-\u001f\u007f]/u.test(directory)) throw new CommandFailure("refused", "USAGE_INVALID", "use backup create/inspect/verify/restore <directory>, or backup recover/cleanup-fallback <full-attempt-id>");
  const maintenance = mode === "recover" || mode === "cleanup-fallback";
  if (maintenance && !/^restore-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(directory)) throw new CommandFailure("refused", "USAGE_INVALID", "name the full native restore attempt, not a prefix, path or backup directory");
  const allowed = new Set(["json", "plain", ...(mode === "create" ? ["only", "store-dir"] : mode === "restore" ? ["only", "store-dir", "accept-missing-source"] : maintenance ? ["yes", "dry-run"] : [])]);
  if (Object.keys(args.values).some((flag) => !allowed.has(flag))) throw new CommandFailure("refused", "USAGE_INVALID", mode === "restore" ? "backup restore accepts only --only, --store-dir and --accept-missing-source; the space, broker and runtime come from the preserved cut" : "backup inspection and verification accept no creation, target or restore inputs");
  if (mode === "create") selection(args.values.only as string | undefined);
  // The native restore accepts only a registry narrowing and otherwise follows the artifact's own
  // selection, so an explicit `full` could not be honored over a registry-only artifact. Refused here,
  // before the seed or any effect, rather than dropped.
  if (mode === "restore" && args.values.only !== undefined && args.values.only !== "registry")
    throw new CommandFailure("refused", "USAGE_INVALID", "backup restore accepts only --only registry; without it the restore follows the artifact's own selection");
  if (args.values["store-dir"] !== undefined && (typeof args.values["store-dir"] !== "string" || !args.values["store-dir"].trim() || /[\u0000-\u001f\u007f]/u.test(args.values["store-dir"]))) throw new CommandFailure("refused", "USAGE_INVALID", "--store-dir requires one path without terminal controls");
  if (mode === "create" || mode === "restore") refuseControllerCut(cotalRoot(), mode === "create" ? "backup create" : "backup restore");
}

/** Native preservation/copy guards are unchanged; only final public observations reach the UI. */
export async function backup(args: ParsedArgs): Promise<void> {
  validateBackupArguments(args);
  if (args.positionals[0] === "recover" || args.positionals[0] === "cleanup-fallback") return backupMaintenance(args);
  if (args.positionals[0] === "restore") return backupRestore(args);
  if (args.positionals[0] !== "create") return backupRead(args);
  const observed: BackupObservation = { mutationAttempted: false, cleanupConfirmed: false };
  try { await createBackup(args, observed); }
  catch (error) {
    const target = { directory: resolve(args.positionals[1]!), attemptId: observed.attemptId ?? null, priorClaimAttemptId: observed.priorClaimAttemptId ?? null };
    if (observed.published) {
      const failure = new CommandFailure("partial", "OPERATION_PARTIAL", "the private artifact was published, but final maintenance cleanup was not confirmed; its receipt is retained", { target, changed: [{ kind: "published-backup", directory: observed.published.directory }], remedy: "inspect this original artifact and retained maintenance attempt before another create; do not delete an unreviewed fallback or claim" });
      writeResult(presentationOf(args.values), { command: "backup create", target, result: { ...observed.published, cleanupConfirmed: observed.cleanupConfirmed }, failure }, backupCreateView);
      return;
    }
    if (isCommandFailure(error) && !observed.mutationAttempted) throw error;
    const outcome = !observed.mutationAttempted ? "refused" : observed.cleanupConfirmed ? "failed" : "unknown";
    throw new CommandFailure(outcome, outcome === "refused" ? "LIFECYCLE_BLOCKED" : outcome === "failed" ? "OPERATION_FAILED" : "OPERATION_UNKNOWN", outcome === "refused" ? "backup preparation did not establish an eligible stopped preserved cut; no published artifact was established" : outcome === "failed" ? "backup creation failed and its native attempt cleanup completed; no published artifact was established" : "the backup attempt did not confirm publication and cleanup; its original attempt is retained without a retry", { target, ...(isMaintenanceError(error) ? { native: { code: error.code } } : {}), remedy: "inspect the preserved-cut maintenance state and original attempt before recovery; raw snapshot, credential and native configuration values were not printed" });
  }
  writeResult(presentationOf(args.values), { command: "backup create", target: { space: observed.published!.space, directory: observed.published!.directory }, result: { ...observed.published!, cleanupConfirmed: observed.cleanupConfirmed } }, backupCreateView);
}

function backupCreateView(result: BackupCreateResult & { cleanupConfirmed: boolean }): Report {
  return { sections: [{ title: "Private backup artifact published", blocks: [
    { kind: "fields", rows: [["Artifact", result.directory], ["Space", result.space], ["Selection", result.selection], ["Created", result.createdAt], ["Streams", String(result.streamCount)], ["Files", String(result.fileCount)], ["Original attempt", result.attemptId], ["Source generation", result.sourceGeneration], ["Maintenance cleanup", result.cleanupConfirmed ? "native cleanup completed" : { text: "not confirmed", tone: "waiting" }], ["Restore", { text: "not attempted or proved", tone: "waiting" }]] },
    { kind: "lines", lines: [{ text: "The artifact's completion manifest was published from the native preserved cut. Creation does not prove restoration or future authority continuity. Snapshot bytes, checkpoint contents and credentials remain private and are not printed or uploaded.", tone: "hint" }] },
  ] }] };
}

/** Offline backup of one stable preservation cut. No implicit stop or restart. */
async function createBackup(args: ParsedArgs, observed: BackupObservation): Promise<void> {
  const destination = args.positionals[1]!;
  const values = args.values as BackupValues;
  const selected = selection(values.only);
  const root = cotalRoot();
  // The artifact snapshots the whole store but commits to ONE space's trust chain
  // (`cotal-space-auth-root/v1`), so on a multi-space broker it would silently restore as a
  // single-tenant root. Refuse rather than emit an artifact that cannot describe what it holds,
  // naming the tenants: as a plain error the catch in `backup` would report it as an ineligible cut.
  try { assertSingleSpaceBroker(authDir(root), "cotal backup"); }
  catch (error) { throw new CommandFailure("refused", "CONFLICT", (error as Error).message, { target: { root } }); }
  const live = liveMeshProcesses(root);
  if (live.length) throw new Error(`backup is offline-only; still running: ${live.join(", ")}. Run \`cotal down --preserve-state\` first`);
  const storeDir = resolve(values["store-dir"] ?? resolve(root, ".cotal", "nats"));
  const attemptId = `backup-${randomUUID()}`;
  observed.attemptId = attemptId;
  const deadline = new Date(Date.now() + OPERATION_TIMEOUT_MS);
  const destinationPath = resolve(destination);
  const clonePath = join(ensurePrivateAttemptsDir(root).path, `${attemptId}-clone`);
  let lock = acquireMaintenanceLock(root);
  let ready: MaintenanceReadyRecord;
  let clone: ReturnType<typeof createAttemptClone> | undefined;
  let broker: IsolatedBroker | undefined;
  let claimed = false;
  let writer: ReturnType<typeof createArtifactWriter> | undefined;
  try {
    const current = readMaintenanceJournal(root);
    if (current?.state === "claimed") {
      observed.mutationAttempted = true;
      observed.priorClaimAttemptId = current.claim.attemptId;
      recoverStaleMaintenanceClaim(lock);
    }
    ready = requireReady(root, storeDir);
    assertBackupPaths(root, ready.source.path, destination);
    // The journal is ready with no live claim, and the destination is proven disjoint from the
    // attempts directory: any attempts-dir content is dead-attempt residue.
    sweepAttemptResidue(root);
    const auth = ready.mode === "open" ? undefined : await getSpaceAuth(workspaceSecretStore(root), ready.space);
    if (ready.mode !== "open" && (!auth || auth.space !== ready.space))
      throw new Error(`backup requires existing trust material for space ${JSON.stringify(ready.space)}`);
    const authority = selected === "full" ? await authorityFingerprint(root, ready.space, ready.mode) : undefined;
    const recordedServer = ready.cut.launch.server;
    if (authority) {
      const authorityAtClone = await authorityFingerprint(root, ready.space, ready.mode);
      if (JSON.stringify(authorityAtClone) !== JSON.stringify(authority))
        throw new Error("current trust state changed before backup cloning");
    }
    // This is intentionally the final await before the claim: pidfiles are only hints, while a
    // listener at the recorded endpoint can still mutate the source or disprove the offline cut.
    await assertEndpointUnreachable(recordedServer);
    // Ownership precedes existence: the claim is journaled with pending slots for every path this
    // attempt may create, so a crash at any later instant leaves a journal owner to recover from.
    observed.mutationAttempted = true;
    claimMaintenanceReady(lock, {
      attemptId,
      deadline: deadline.toISOString(),
      coordinator: localOwner(`${attemptId}-coordinator`),
      owners: [],
      ownedPaths: [
        { label: "clone", path: clonePath },
        { label: "destination", path: destinationPath },
      ],
    });
    claimed = true;
    clone = createAttemptClone(root, ready.source.path, attemptId);
    recordMaintenanceClaimResources(lock, { ownedPaths: [
      { label: "clone", path: clone.path, dev: clone.identity.dev.toString(), ino: clone.identity.ino.toString() },
    ] });
    broker = await startIsolatedBroker({
      root,
      storeDir: clone.path,
      space: ready.space,
      mode: ready.mode,
      auth,
      deadline,
      label: "backup",
      initialScope: { profile: "backup", scope: { operation: "inspect", selection: selected } },
      attemptId,
    });
    recordMaintenanceClaimResources(lock, {
      owners: [broker.brokerOwner, broker.watchdogOwner],
      ownedPaths: broker.runFiles.map((file) => ({ label: "config" as const, ...file })),
    });
    writer = createArtifactWriter(destination);
    recordMaintenanceClaimResources(lock, { ownedPaths: [
      { label: "destination", path: writer.directory, dev: writer.identity.dev.toString(), ino: writer.identity.ino.toString() },
    ] });
    releaseMaintenanceLock(lock);
    lock = undefined as never;

    const inspect = await inspectionConnection(broker);
    let checkpoints;
    try {
      ({ checkpoints } = await collectInventory(inspect, ready.space, selected));
    } finally {
      await inspect.drain().catch(() => {});
    }
    if (process.env.COTAL_SMOKE_FAIL_BACKUP_STAGE === "initiation")
      throw new Error("smoke-injected failure at snapshot initiation");
    const files: BackupFileRecord[] = [];
    const streams: BackupStreamRecord[] = [];
    for (const stream of spaceBackupInventory(ready.space)[selected]) {
      const snapshot = await snapshotStream(writer, broker, ready.space, stream);
      files.push(snapshot.file);
      streams.push(snapshot.stream);
      if (process.env.COTAL_SMOKE_FAIL_BACKUP_STAGE === "close")
        throw new Error("smoke-injected failure after snapshot close");
    }
    if (process.env.COTAL_SMOKE_FAIL_BACKUP_STAGE === "manifest")
      throw new Error("smoke-injected failure before manifest publication");
    const checkpointName = "checkpoints.json";
    files.push(await writer.writeFile(checkpointName, "checkpoints", `${JSON.stringify(selected === "full" ? checkpoints : [], null, 2)}\n`));
    const published = writer.publish({
      space: ready.space,
      selection: selected,
      mode: ready.mode,
      source: ready.source,
      ...(authority ? { authority } : {}),
      streams,
      checkpoints: checkpointName,
    }, files);
    observed.published = { kind: "backup-created", directory: writer.directory, space: ready.space, selection: selected, createdAt: published.createdAt, streamCount: streams.length, fileCount: files.length, attemptId, sourceGeneration: ready.source.generation, restored: false };
  } finally {
    // Ownership is surrendered ONLY once every owned resource is proven stopped and removed (or
    // published). Any cleanup failure keeps the claim so retry/stale-recovery finishes it — attempt
    // residue must never exist without a journal owner.
    const residue: string[] = [];
    if (broker) try { await broker.stop(); } catch (cause) {
      residue.push(`isolated broker: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (writer) try { writer.cleanup(); } catch (cause) {
      residue.push(`destination: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (clone) try { clone.cleanup(); } catch (cause) {
      residue.push(`clone: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (!lock) lock = acquireMaintenanceLock(root);
    try {
      if (claimed && !residue.length) releaseMaintenanceClaim(lock, attemptId);
    } finally {
      releaseMaintenanceLock(lock);
    }
    observed.cleanupConfirmed = claimed && !residue.length;
    if (residue.length) {
      const message = `backup attempt ${attemptId} retains its maintenance claim; cleanup incomplete: ${residue.join("; ")} — retry the command or recover the stale claim`;
      throw new Error(message);
    }
  }
}
