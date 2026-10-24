import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import type { ConsumerInfo } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  downloadStreamSnapshot,
  spaceBackupInventory,
  validateCanonicalBackupStreamConfig,
  validateBackupStreamState,
  validatePersistentConsumerInventory,
  validateSpaceBackupInventory,
  wfjStreamName,
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
  assessRestoreClaim,
  assertStoreIdentity,
  authDir,
  claimMaintenanceReady,
  cutController,
  getSpaceAuth,
  readMaintenanceJournal,
  readMaintenanceLockHolder,
  recordMaintenanceClaimResources,
  recoverStaleMaintenanceClaim,
  readStoreIdentity,
  releaseMaintenanceClaim,
  releaseMaintenanceLock,
  sameStoreIdentity,
  workspaceSecretStore,
  type MaintenanceLock,
  type MaintenanceReadyRecord,
  type ProcessOwner,
  restoreLeftOut,
} from "@cotal-ai/workspace";
import { artifactStreams, BACKUP_MANIFEST_FORMAT, createArtifactWriter, isTrustBound, missingBackupPath, snapshotFileName, TRUST_BOUND_TEXT, type BackupFileRecord, type BackupStreamRecord } from "../lib/backup-artifact.js";
import { assertControllerResumeEligible } from "../lib/controller-resume.js";
import { assertControllerBrokerConfig } from "../lib/controller-restore.js";
import { refuseControllerCut } from "../lib/stack-journal.js";
import { authorityFingerprint } from "../lib/maintenance-files.js";
import { attemptProcessesGone, connectIsolatedBroker, createAttemptClone, ensurePrivateAttemptsDir, startIsolatedBroker, sweepAttemptResidue, type IsolatedBroker } from "../lib/isolated-broker.js";
import { cotalRoot } from "../lib/paths.js";
import { heldClaim, movedFolderRefusal, preservedSourceState, restoreNextStep } from "../lib/restore.js";
import { noticeOnInterrupt } from "../lib/interrupt-notice.js";
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
  { name: "discard-history", type: "boolean", description: "cleanup-fallback: also delete a previous store that holds the only copy of the history or workflow runs the restore left out" },
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

const BACKUP_CREATE_LOCK = { operation: "backup create" };

function localOwner(id: string): ProcessOwner {
  return { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), id };
}

/** What an interrupted backup create left, read from the journal at the moment of the signal. */
function backupInterruptNotice(root: string, attemptId: string, destination: string): string {
  const journal = readMaintenanceJournal(root);
  if (journal?.state !== "claimed" || journal.claim.attemptId !== attemptId) return `Interrupted: backup attempt ${attemptId} stopped and holds no claim on this root.`;
  const recover = `cotal backup recover ${attemptId} --yes`;
  if (lstatSync(join(destination, "manifest.json"), { throwIfNoEntry: false }))
    return `Interrupted: backup attempt ${attemptId} published ${destination} but stopped before it released this root.\nRelease it with ${recover}; the published artifact is kept.`;
  return `Interrupted: backup attempt ${attemptId} stopped before it published, and left a partial artifact at ${destination}.\nRemove it and release this root with ${recover}; a backup create to another directory also does that first.`;
}

/** This root has no stopped preserved cut to back up. Nothing was claimed or copied. */
function notReady(root: string, record: ReturnType<typeof readMaintenanceJournal>): CommandFailure {
  if (!record) return new CommandFailure("refused", "LIFECYCLE_BLOCKED", "backup requires a stopped preserved cut, and this root records none", { target: { root }, remedy: "stop the stack with cotal down --preserve-state, then create the backup" });
  // A restore that still runs is named and waited for; only a stale one is rolled back.
  if (record.state === "restore-ready") {
    const assessment = assessRestoreClaim(record, { unrecordedOwnersDead: attemptProcessesGone(root) });
    if (assessment !== "stale") return heldClaim(root, record.restore.attemptId, record.claim, "backup create", assessment);
  }
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `backup requires the stopped preserved cut; maintenance state is ${record.state}`, {
    target: { root, space: record.space, state: record.state },
    remedy: "restore" in record ? restoreNextStep(record.state, record.restore.attemptId, restoreLeftOut(record)) : "finish this root's current maintenance attempt first; check it with cotal status",
  });
}

/** Another operation holds this root's maintenance lock. A backup or restore attempt whose claim that
 *  process holds is named by its claim, which `backup recover` knows; otherwise the lock names the
 *  operation, its process and when it took the lock. Nothing was claimed or copied. */
function lockHeld(root: string, retry: string): CommandFailure {
  const holder = readMaintenanceLockHolder(root);
  let journal: ReturnType<typeof readMaintenanceJournal>;
  try { journal = readMaintenanceJournal(root); } catch { journal = undefined; }
  const held = journal?.state === "claimed" ? { attemptId: journal.claim.attemptId, claim: journal.claim }
    : journal?.state === "restore-ready" ? { attemptId: journal.restore.attemptId, claim: journal.claim } : undefined;
  if (holder && held && held.claim.coordinator.pid === holder.owner.pid && held.claim.coordinator.host === holder.owner.host)
    return heldClaim(root, held.attemptId, held.claim, "backup create", "live");
  const who = holder
    ? `${holder.operation ? `a ${holder.operation}` : "another maintenance operation"}, process ${holder.owner.pid}, has held this root's maintenance lock since ${holder.owner.startedAt}`
    : "another maintenance operation holds this root's maintenance lock";
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `backup create is refused: ${who}; nothing was changed`, {
    target: { root, ...(holder ? { holderPid: holder.owner.pid, holderStartedAt: holder.owner.startedAt, ...(holder.operation ? { holderOperation: holder.operation } : {}) } : {}) },
    remedy: `wait for ${holder ? `process ${holder.owner.pid}` : "that operation"} to finish, then run ${retry} again; cotal status shows this root's maintenance state`,
  });
}

/** Refuse a `--store-dir` that is not the cut's preserved store, naming both, with the native reason
 *  when the named folder holds no readable store identity. */
function assertNamedStore(root: string, record: MaintenanceReadyRecord, storeDir: string): void {
  const mismatch = (reason?: string) => new CommandFailure("refused", "CONFLICT", `--store-dir ${storeDir} is not this cut's preserved store ${record.source.path}${reason ? ` (${reason})` : ""}; nothing was backed up`, { target: { root, space: record.space, storeDir, preservedStore: record.source.path }, remedy: `omit --store-dir to back up ${record.source.path}, or name that store` });
  let actual: ReturnType<typeof readStoreIdentity>;
  try { actual = readStoreIdentity(storeDir); }
  catch (error) { if (isMaintenanceError(error)) throw mismatch(error.message); throw error; }
  if (!sameStoreIdentity(record.source, actual)) throw mismatch();
}

function requireReady(root: string, storeDir: string, named: boolean): MaintenanceReadyRecord {
  const record = readMaintenanceJournal(root);
  if (!record || record.state !== "ready") throw notReady(root, record);
  const source = preservedSourceState(root, record.source);
  if (source.state === "moved") throw movedFolderRefusal(root, record.space, record.source.path, source, "create the backup");
  if (source.state === "missing")
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the preserved store recorded at ${record.source.path} is missing; nothing was backed up`, { target: { root, space: record.space, recordedStore: record.source.path }, remedy: "if this folder was moved, move it back so that path exists again" });
  if (named) assertNamedStore(root, record, storeDir);
  else if (!sameStoreIdentity(record.source, readStoreIdentity(storeDir)))
    throw new CommandFailure("refused", "CONFLICT", `--store-dir does not match the preserved source ${record.source.path}`, { target: { root, space: record.space }, remedy: "omit --store-dir, or name the preserved store" });
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

async function collectInventory(nc: NatsConnection, space: string, selected: SpaceBackupSelection, held: readonly string[]): Promise<{
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
  const expected = held;
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
  const backedConsumers = Object.fromEntries(held.map((stream) => {
    const consumers = consumersByStream[stream] ?? [];
    for (const consumer of consumers)
      if (stream.startsWith("KV_") && consumer.name.startsWith("oc_") && !isStoppedKvWatcher(stream, consumer))
        throw new Error(`${stream}/${consumer.name} has an unsupported stopped KV watcher config: ${JSON.stringify(consumer.config)}`);
    return [stream, consumers.filter((consumer) => !isStoppedKvWatcher(stream, consumer))];
  }));
  return { checkpoints: validatePersistentConsumerInventory(space, backedConsumers, statesByStream, held) };
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
  // readers when every other field below matches the pinned client's ordered-consumer shape. A
  // watcher may read one subtree of its bucket, as the manager's goal index does on the records store.
  return consumer.push_bound !== true &&
    config.name === consumer.name &&
    !config.durable_name &&
    consumer.name.startsWith("oc_") &&
    (config.deliver_policy === "last_per_subject" || config.deliver_policy === "all") &&
    config.ack_policy === "none" &&
    (config.max_deliver === undefined || config.max_deliver === -1 || config.max_deliver === 1) &&
    typeof config.filter_subject === "string" && config.filter_subject.startsWith(`$KV.${stream.slice(3)}.`) &&
    config.replay_policy === "instant" &&
    config.flow_control === true &&
    // A connection with its own inbox prefix delivers to `_INBOX_<id>`, one without it, as on an open
    // mesh, to the client's default `_INBOX.`.
    typeof config.deliver_subject === "string" && (config.deliver_subject.startsWith("_INBOX_") || config.deliver_subject.startsWith("_INBOX.")) &&
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
        if (process.env.COTAL_SMOKE_FAIL_BACKUP_STAGE === "nospace")
          throw Object.assign(new Error("ENOSPC: no space left on device, write (smoke-injected)"), { code: "ENOSPC" });
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
  /** Whether it restores only into a root that still holds the trust state it was taken under. */
  readonly trustBound: boolean;
  /** Whether it holds the workflow runs. A registry or user-mode artifact does not, so a restore
   *  from it starts them empty. */
  readonly workflowRuns: boolean;
  readonly restored: false;
}
interface BackupObservation {
  attemptId?: string;
  priorClaimAttemptId?: string;
  mutationAttempted: boolean;
  cleanupConfirmed: boolean;
  published?: BackupCreateResult;
  /** What the attempt was writing, and the directory it went to, for a disk that fills up. */
  writing?: { what: "store copy" | "backup"; directory: string };
}

/** The failure for a create that ran out of disk space or quota and removed what it wrote. A
 *  destination write error names no file, so the message names the directory the attempt was
 *  writing; the preserved cut is untouched, so the next step is to free space and run it again. */
function noSpaceFailure(error: unknown, observed: BackupObservation, args: ParsedArgs, target: Record<string, unknown>): CommandFailure | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if ((code !== "ENOSPC" && code !== "EDQUOT") || !observed.writing) return undefined;
  const destination = resolve(args.positionals[1]!);
  const { what, directory } = observed.writing;
  const written = what === "backup" ? "it removed the partial backup and published none" : `it removed the partial copy and wrote nothing to ${destination}`;
  return new CommandFailure("failed", "OPERATION_FAILED", `backup create ran out of disk space (${code}) writing the ${what} in ${directory}; ${written}, and the preserved cut is still ready`, { target, native: { detail: error instanceof Error ? error.message : String(error) }, remedy: `free space on the disk that holds ${directory}, then run ${retryCreate(args)} again` });
}

/** The same `backup create`, for a failure that left the preserved cut ready to try again. */
function retryCreate(args: ParsedArgs): string {
  const flags = [args.values.only === undefined ? "" : ` --only ${args.values.only}`, args.values["store-dir"] === undefined ? "" : ` --store-dir ${args.values["store-dir"]}`].join("");
  return `cotal backup create ${resolve(args.positionals[1]!)}${flags}`;
}

export function validateBackupArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode, directory, ...extra] = args.positionals;
  if (!mode || !["create", "inspect", "verify", "restore", "recover", "cleanup-fallback"].includes(mode) || !directory?.trim() || extra.length || /[\u0000-\u001f\u007f]/u.test(directory)) throw new CommandFailure("refused", "USAGE_INVALID", "use backup create/inspect/verify/restore <directory>, or backup recover/cleanup-fallback <full-attempt-id>");
  const maintenance = mode === "recover" || mode === "cleanup-fallback";
  // recover also takes an interrupted backup create's own attempt; cleanup-fallback only a restore's.
  const attempt = new RegExp(`^(${mode === "recover" ? "restore|backup" : "restore"})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "i");
  if (maintenance && !attempt.test(directory)) throw new CommandFailure("refused", "USAGE_INVALID", mode === "recover" ? "name the full attempt id, restore-<uuid> or backup-<uuid>; a prefix, path or backup directory is refused" : "name the full restore attempt id, restore-<uuid>; a prefix, path or backup directory is refused", { remedy: "cotal status shows the attempt this root holds, under Maintenance" });
  const allowed = new Set(["json", "plain", ...(mode === "create" ? ["only", "store-dir"] : mode === "restore" ? ["only", "store-dir", "accept-missing-source"] : maintenance ? ["yes", "dry-run", ...(mode === "cleanup-fallback" ? ["discard-history"] : [])] : [])]);
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
    // A refused create journaled no attempt, so it names none that `backup recover` could not find.
    const target = { directory: resolve(args.positionals[1]!), attemptId: observed.mutationAttempted ? observed.attemptId ?? null : null, priorClaimAttemptId: observed.priorClaimAttemptId ?? null };
    if (observed.published) {
      const failure = new CommandFailure("partial", "OPERATION_PARTIAL", "the private artifact was published, but final maintenance cleanup was not confirmed; its receipt is retained", { target, changed: [{ kind: "published-backup", directory: observed.published.directory }], remedy: "inspect this original artifact and retained maintenance attempt before another create; do not delete an unreviewed fallback or claim" });
      writeResult(presentationOf(args.values), { command: "backup create", target, result: { ...observed.published, cleanupConfirmed: observed.cleanupConfirmed }, failure }, backupCreateView);
      return;
    }
    if (isCommandFailure(error) && !observed.mutationAttempted) throw error;
    const outcome = !observed.mutationAttempted ? "refused" : observed.cleanupConfirmed ? "failed" : "unknown";
    if (outcome === "failed") {
      const noSpace = noSpaceFailure(error, observed, args, target);
      if (noSpace) throw noSpace;
    }
    // The guard's own sentence is the operator's evidence, as on restore: it names the cause, such as
    // a broker still answering at the cut's endpoint. Snapshot bytes and credentials never reach it.
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandFailure(outcome, outcome === "refused" ? "LIFECYCLE_BLOCKED" : outcome === "failed" ? "OPERATION_FAILED" : "OPERATION_UNKNOWN", outcome === "refused" ? "backup preparation did not establish an eligible stopped preserved cut; no published artifact was established" : outcome === "failed" ? "backup creation failed and its native attempt cleanup completed; no published artifact was established" : "the backup attempt did not confirm publication and cleanup; its original attempt is retained without a retry", { target, native: { ...(isMaintenanceError(error) ? { code: error.code } : {}), detail }, remedy: outcome === "failed" ? `the preserved cut is still ready; fix the cause in the native detail, then run ${retryCreate(args)} again` : "inspect the preserved-cut maintenance state and original attempt before recovery; snapshot bytes and credentials were not printed" });
  }
  writeResult(presentationOf(args.values), { command: "backup create", target: { space: observed.published!.space, directory: observed.published!.directory }, result: { ...observed.published!, cleanupConfirmed: observed.cleanupConfirmed } }, backupCreateView);
}

function backupCreateView(result: BackupCreateResult & { cleanupConfirmed: boolean }): Report {
  return { sections: [{ title: "Private backup artifact published", blocks: [
    { kind: "fields", rows: [["Artifact", result.directory], ["Space", result.space], ["Selection", result.selection], ...(result.trustBound ? [["Restores into", TRUST_BOUND_TEXT] as [string, string]] : []), ["Created", result.createdAt], ["Streams", String(result.streamCount)], ["Files", String(result.fileCount)], ["Original attempt", result.attemptId], ["Source generation", result.sourceGeneration], ["Maintenance cleanup", result.cleanupConfirmed ? "native cleanup completed" : { text: "not confirmed", tone: "waiting" }], ["Restore", { text: "not attempted or proved", tone: "waiting" }]] },
    ...(result.workflowRuns ? [] : [{ kind: "lines" as const, lines: ["Workflow runs are not in this artifact, so a restore from it starts them empty."] }]),
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
  if (live.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `backup is offline-only; still running: ${live.join(", ")}`, { target: { root }, remedy: "stop the stack with cotal down --preserve-state, then create the backup" });
  // Refusals that need no lock come first, so a refused create leaves no maintenance state behind.
  const journal = readMaintenanceJournal(root);
  if (!journal) throw notReady(root, undefined);
  const destinationPath = resolve(destination);
  if (lstatSync(destinationPath, { throwIfNoEntry: false })) {
    // The partial artifact of an interrupted create is named with the command that removes it.
    const partial = journal.state === "claimed" && journal.claim.ownedPaths?.some((owned) => owned.label === "destination" && owned.path === destinationPath) ? journal.claim.attemptId : undefined;
    throw new CommandFailure("refused", "CONFLICT", partial ? `the backup destination ${destinationPath} is the partial artifact of interrupted backup attempt ${partial}; backup create writes only a new directory` : "the backup destination already exists; backup create writes only a new directory", { target: { directory: destinationPath }, remedy: partial ? `remove it with cotal backup recover ${partial} --yes, then run this create again` : "name a directory that does not exist yet" });
  }
  if (missingBackupPath(destinationPath) === "folder")
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", `there is no folder ${dirname(destinationPath)} to create the backup in; nothing was written`, { target: { directory: destinationPath, folder: dirname(destinationPath), missing: "folder" }, remedy: "create that folder first; backup create makes only the artifact's own folder" });
  // A destination the preserved store holds, or one in a folder this account cannot write, is refused
  // here, before the lock, so it leaves no attempt behind.
  const preserved = journal.state === "ready" || journal.state === "claimed" ? journal.source.path : undefined;
  if (preserved && overlaps(canonicalFuturePath(destinationPath), preserved))
    throw new CommandFailure("refused", "USAGE_INVALID", `the backup destination ${destinationPath} is inside the preserved store ${preserved} it would copy; nothing was written`, { target: { directory: destinationPath, store: preserved }, remedy: `name a destination outside ${preserved}`, selfContained: true });
  try { accessSync(dirname(destinationPath), constants.W_OK | constants.X_OK); }
  catch {
    throw new CommandFailure("refused", "PERMISSION_DENIED", `this account cannot write ${dirname(destinationPath)}, so the backup cannot be created in it; nothing was written`, { target: { directory: destinationPath, folder: dirname(destinationPath) }, remedy: `make that folder writable with chmod u+w ${dirname(destinationPath)}, or name a destination in a folder this account can write` });
  }
  if (values["store-dir"] !== undefined && journal.state === "ready") assertNamedStore(root, journal, resolve(values["store-dir"]));
  // Omitted, the store is the cut's own source, which a restore into --store-dir put outside
  // .cotal/nats. An interrupted create's claim keeps that source, and this create recovers the claim
  // first. A named store is still checked against it.
  const storeDir = resolve(values["store-dir"] ?? (journal.state === "ready" || journal.state === "claimed" ? journal.source.path : resolve(root, ".cotal", "nats")));
  const attemptId = `backup-${randomUUID()}`;
  observed.attemptId = attemptId;
  const deadline = new Date(Date.now() + OPERATION_TIMEOUT_MS);
  const clonePath = join(ensurePrivateAttemptsDir(root).path, `${attemptId}-clone`);
  let lock: MaintenanceLock;
  try { lock = acquireMaintenanceLock(root, BACKUP_CREATE_LOCK); }
  catch (error) {
    if (isMaintenanceError(error) && error.code === "lock-held") throw lockHeld(root, retryCreate(args));
    throw error;
  }
  let ready: MaintenanceReadyRecord;
  let clone: ReturnType<typeof createAttemptClone> | undefined;
  let broker: IsolatedBroker | undefined;
  let claimed = false;
  let writer: ReturnType<typeof createArtifactWriter> | undefined;
  let releaseNotice: (() => void) | undefined;
  try {
    const current = readMaintenanceJournal(root);
    if (current?.state === "claimed") {
      observed.priorClaimAttemptId = current.claim.attemptId;
      // An earlier attempt's claim that is not provably stale refuses before anything is removed.
      try { recoverStaleMaintenanceClaim(lock, { unrecordedOwnersDead: attemptProcessesGone(root) }); }
      catch (error) {
        if (isMaintenanceError(error) && ["claim-not-expired", "claim-live", "claim-owner-ambiguous"].includes(error.code))
          throw heldClaim(root, current.claim.attemptId, current.claim, "backup create", error.code === "claim-owner-ambiguous" ? "ambiguous" : "live");
        observed.mutationAttempted = true;
        throw error;
      }
      observed.mutationAttempted = true;
    }
    ready = requireReady(root, storeDir, values["store-dir"] !== undefined);
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
    releaseNotice = noticeOnInterrupt(() => backupInterruptNotice(root, attemptId, destinationPath));
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
    observed.writing = { what: "store copy", directory: dirname(clonePath) };
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
    observed.writing = { what: "backup", directory: destinationPath };
    writer = createArtifactWriter(destination);
    recordMaintenanceClaimResources(lock, { ownedPaths: [
      { label: "destination", path: writer.directory, dev: writer.identity.dev.toString(), ino: writer.identity.ino.toString() },
    ] });
    releaseMaintenanceLock(lock);
    lock = undefined as never;

    const held = artifactStreams({ format: BACKUP_MANIFEST_FORMAT, space: ready.space, selection: selected, mode: ready.mode });
    const inspect = await inspectionConnection(broker);
    let checkpoints;
    try {
      ({ checkpoints } = await collectInventory(inspect, ready.space, selected, held));
    } finally {
      await inspect.drain().catch(() => {});
    }
    if (process.env.COTAL_SMOKE_FAIL_BACKUP_STAGE === "initiation")
      throw new Error("smoke-injected failure at snapshot initiation");
    const files: BackupFileRecord[] = [];
    const streams: BackupStreamRecord[] = [];
    for (const stream of held) {
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
    observed.published = { kind: "backup-created", directory: writer.directory, space: ready.space, selection: selected, createdAt: published.createdAt, streamCount: streams.length, fileCount: files.length, attemptId, sourceGeneration: ready.source.generation, trustBound: isTrustBound(selected, ready.mode), workflowRuns: held.includes(wfjStreamName(ready.space)), restored: false };
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
    if (!lock) lock = acquireMaintenanceLock(root, BACKUP_CREATE_LOCK);
    try {
      if (claimed && !residue.length) releaseMaintenanceClaim(lock, attemptId);
    } finally {
      releaseMaintenanceLock(lock);
      releaseNotice?.();
    }
    observed.cleanupConfirmed = claimed && !residue.length;
    if (residue.length) {
      const message = `backup attempt ${attemptId} retains its maintenance claim; cleanup incomplete: ${residue.join("; ")} — retry the command or recover the stale claim`;
      throw new Error(message);
    }
  }
}
