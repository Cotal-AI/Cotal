import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  closeSync,
  rmSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  canonicalBackupStreamConfig,
  consumerConfigFromCheckpoint,
  deliveryBucket,
  downloadStreamSnapshot,
  finalizeStreamRestore,
  initiateStreamRestore,
  LEASE_TTL_MS,
  managerBucket,
  MANAGER_LEASE_TTL_MS,
  membershipBucket,
  MEMBERSHIP_MAX_BYTES,
  presenceBucket,
  recreateConsumerCheckpoint,
  spaceBackupInventory,
  uploadStreamRestoreChunk,
  validateSpaceAuth,
  validateSpaceBackupInventory,
  validateBackupStreamState,
  validateCanonicalBackupStreamConfig,
  type PersistentConsumerCheckpoint,
} from "@cotal-ai/core";
import {
  acquireMaintenanceLock,
  assessRestoreClaim,
  authDir,
  bindRestoreListener,
  bindRestoreTarget,
  loadSpaceAuth,
  markRestoreActive,
  markRestoreDegraded,
  moveSamePathRestoreSource,
  prepareAlternateRestore,
  prepareMissingSourceRestore,
  prepareSamePathRestore,
  readMaintenanceJournal,
  readMaintenanceResumeDocument,
  recordRestoreAttemptResources,
  recordRestoreManagerCommit,
  replaceDeadRestoreListener,
  repairRestoreDegradedToActive,
  releaseMaintenanceLock,
  rollbackRestore,
  writeRestoreCommitIntent,
  type AttemptOwnedPath,
  type CommitIntentRecord,
  type JsonValue,
  type ManagerCommitEvidence,
  type ManagerFinalizeEvidence,
  type MaintenanceReadyRecord,
  type ProcessOwner,
  type RestoreActiveRecord,
  type RestoreDegradedRecord,
  type RestoreListenerProof,
  type RestoreManagerCommittedRecord,
} from "@cotal-ai/workspace";
import { readStagedCheckpoints, stageArtifact, type BackupManifest, type StagedArtifact } from "./backup-artifact.js";
import { authorityFingerprint } from "./maintenance-files.js";
import { connectIsolatedBroker, ensurePrivateAttemptsDir, startIsolatedBroker, sweepAttemptResidue, type IsolatedBroker } from "./isolated-broker.js";

const RESTORE_TIMEOUT_MS = 30 * 60 * 1000;
const CHUNK_BYTES = 1024 * 1024;

export interface RestoreFlags {
  restore: string;
  "restore-only"?: string;
  "accept-missing-source"?: boolean;
  "store-dir"?: string;
  space?: string;
  server?: string;
  host?: string;
  runtime?: string;
  detach?: boolean;
  open?: boolean;
  "user-auth"?: boolean;
  idp?: string;
}

export interface PreparedRestore {
  root: string;
  attemptId: string;
  targetPath: string;
  space: string;
  mode: MaintenanceReadyRecord["mode"];
  server: string;
  host: string;
  runtime: string;
  detached: boolean;
  selection: "full" | "registry";
  inventory: JsonValue;
  serverName: string;
  serverNonce: string;
  /** True only when reconstructed from durable commit/repair state after coordinator loss. */
  reentry: boolean;
  journalState: "commit-intent" | "manager-committed" | "active" | "degraded";
  managerCommit?: ManagerCommitEvidence;
  listenerProof?: RestoreListenerProof;
  cleanupStage(): void;
}

type RecoverableRestoreRecord = CommitIntentRecord | RestoreManagerCommittedRecord | RestoreActiveRecord | RestoreDegradedRecord;

function launchString(launch: Readonly<Record<string, JsonValue>>, key: string): string {
  const value = launch[key];
  if (typeof value !== "string" || !value) throw new Error(`restore launch record is missing ${key}`);
  return value;
}

function restoreServerIdentity(attemptId: string, serverName: string, serverNonce: string): void {
  if (!/^[0-9a-f]{32}$/.test(serverNonce) || serverName !== `${attemptId}-${serverNonce}`)
    throw new Error(`restore attempt ${attemptId} has invalid listener name/nonce provenance`);
}

/** Remove only journaled attempt-owned working trees whose inode identity still matches. */
function removeRecordedOwnedPaths(ownedPaths: readonly AttemptOwnedPath[] | undefined): void {
  for (const owned of ownedPaths ?? []) {
    try {
      const stat = lstatSync(owned.path, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink() &&
          stat.dev.toString() === owned.dev && stat.ino.toString() === owned.ino)
        rmSync(owned.path, { recursive: true });
    } catch { /* absent or identity cannot be proven — preserve */ }
  }
}

export function rehydratePreparedRestore(root: string, journal: RecoverableRestoreRecord): PreparedRestore {
  const resume = readMaintenanceResumeDocument(root, journal.resume);
  const restoreOnly = launchString(journal.launch, "restoreOnly");
  if (restoreOnly !== "full" && restoreOnly !== "registry") throw new Error(`unsupported restored selection ${restoreOnly}`);
  const replacementPending = !journal.listenerProof && Boolean(journal.listenerReplacements?.length);
  const serverNonce = journal.listenerProof?.serverNonce ??
    (replacementPending ? randomUUID().replaceAll("-", "") : launchString(journal.launch, "serverNonce"));
  const serverName = journal.listenerProof?.serverName ??
    (replacementPending ? `${journal.restore.attemptId}-${serverNonce}` : launchString(journal.launch, "serverName"));
  restoreServerIdentity(journal.restore.attemptId, serverName, serverNonce);
  return {
    root,
    attemptId: journal.restore.attemptId,
    targetPath: journal.restore.target.path,
    space: journal.space,
    mode: journal.mode,
    server: launchString(journal.launch, "server"),
    host: launchString(journal.launch, "host"),
    runtime: launchString(journal.launch, "runtime"),
    detached: journal.launch.detached === true,
    selection: restoreOnly,
    inventory: resume.inventory,
    serverName,
    serverNonce,
    reentry: !replacementPending,
    journalState: journal.state,
    ...(journal.state !== "commit-intent" && journal.managerCommit ? { managerCommit: journal.managerCommit } : {}),
    ...(journal.listenerProof ? { listenerProof: journal.listenerProof } : {}),
    cleanupStage() {
      removeRecordedOwnedPaths(journal.restore.ownedPaths);
    },
  };
}

export function bindPreparedRestoreListener(prepared: PreparedRestore, processOwner: ProcessOwner): RestoreListenerProof {
  const lock = acquireMaintenanceLock(prepared.root);
  try {
    const journal = readMaintenanceJournal(prepared.root);
    if (!journal || journal.state !== "commit-intent" || journal.restore.attemptId !== prepared.attemptId)
      throw new Error(`restore listener bind does not match commit attempt ${prepared.attemptId}`);
    const proof: RestoreListenerProof = {
      attemptId: prepared.attemptId,
      serverName: prepared.serverName,
      serverNonce: prepared.serverNonce,
      processOwner,
      serverEndpoint: prepared.server,
      target: journal.restore.target,
    };
    bindRestoreListener(lock, proof);
    prepared.listenerProof = proof;
    return proof;
  } finally {
    releaseMaintenanceLock(lock);
  }
}

export function replacePreparedDeadRestoreListener(prepared: PreparedRestore): void {
  if (!prepared.listenerProof)
    throw new Error(`restore attempt ${prepared.attemptId} has no bound listener proof to replace`);
  const lock = acquireMaintenanceLock(prepared.root);
  try {
    replaceDeadRestoreListener(lock, prepared.listenerProof);
    prepared.serverNonce = randomUUID().replaceAll("-", "");
    prepared.serverName = `${prepared.attemptId}-${prepared.serverNonce}`;
    prepared.listenerProof = undefined;
    prepared.journalState = "commit-intent";
    prepared.reentry = false;
  } finally {
    releaseMaintenanceLock(lock);
  }
}

export function isManagerCommittedRestore(journal: RestoreActiveRecord): boolean {
  return isManagerCommitResult(journal.managerCommit, journal.restore.attemptId) &&
    isManagerFinalizeEvidence(
      journal.details.managerFinalize,
      journal.restore.attemptId,
      journal.managerCommit.durableCommitToken,
    );
}

export function isManagerCommitResult(value: unknown, attemptId: string): value is ManagerCommitEvidence {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) ===
      JSON.stringify(["attemptId", "durableCommitToken", "state"].sort()) &&
    (value as { attemptId?: unknown }).attemptId === attemptId &&
    (value as { state?: unknown }).state === "awaitingFinalize" &&
    typeof (value as { durableCommitToken?: unknown }).durableCommitToken === "string" &&
    /^[a-f0-9]{64}$/.test((value as { durableCommitToken: string }).durableCommitToken));
}

export function isManagerFinalizeResult(value: unknown, attemptId: string): value is { attemptId: string; state: "active" } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) === JSON.stringify(["attemptId", "state"].sort()) &&
    (value as { attemptId?: unknown }).attemptId === attemptId &&
    (value as { state?: unknown }).state === "active");
}

function isManagerFinalizeEvidence(
  value: unknown,
  attemptId: string,
  durableCommitToken: string,
): value is ManagerFinalizeEvidence {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) ===
      JSON.stringify(["attemptId", "durableCommitToken", "state"].sort()) &&
    (value as { attemptId?: unknown }).attemptId === attemptId &&
    (value as { state?: unknown }).state === "active" &&
    (value as { durableCommitToken?: unknown }).durableCommitToken === durableCommitToken);
}

function createOwnedDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function canonicalFuturePath(path: string): string {
  const absolute = resolve(path);
  return join(realpathSync.native(dirname(absolute)), basename(absolute));
}

function canonicalServerEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (!(["nats:", "tls:"] as string[]).includes(endpoint.protocol) || !endpoint.hostname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.pathname && endpoint.pathname !== "/"))
    throw new Error(`restore listener endpoint is not canonicalizable: ${value}`);
  return `${endpoint.protocol}//${endpoint.hostname.toLowerCase()}:${endpoint.port || "4222"}`;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  const separator = process.platform === "win32" ? "\\" : "/";
  return path === "" || (path !== ".." && !path.startsWith(`..${separator}`) && !isAbsolute(path));
}

function assertRestoreTargetPath(source: string, artifact: string, attempts: string, target: string): void {
  const canonicalTarget = canonicalFuturePath(target);
  if (canonicalTarget !== source && (contains(source, canonicalTarget) || contains(canonicalTarget, source)))
    throw new Error("restore target must not overlap the preserved source store");
  if (contains(attempts, canonicalTarget) || contains(canonicalTarget, attempts))
    throw new Error("restore target must not overlap the maintenance attempt directory");
  if (contains(artifact, canonicalTarget) || contains(canonicalTarget, artifact))
    throw new Error("restore target must not overlap the backup artifact");
}

function dataStateFingerprint(input: Readonly<Record<string, unknown>>): string {
  const state = validateBackupStreamState(input);
  return JSON.stringify({
    messages: state.messages,
    bytes: state.bytes,
    first_seq: state.first_seq,
    last_seq: state.last_seq,
    deleted: [...(state.deleted ?? [])].sort((a, b) => a - b),
    num_deleted: state.num_deleted ?? 0,
  });
}

function assertRestoredState(stream: string, expected: Readonly<Record<string, unknown>>, actual: Readonly<Record<string, unknown>>): void {
  if (dataStateFingerprint(expected) !== dataStateFingerprint(actual))
    throw new Error(`${stream} restored message state does not match the backup manifest`);
}

async function validateManifest(
  manifest: BackupManifest,
  flags: RestoreFlags,
  ready: MaintenanceReadyRecord,
  currentAuthority: Awaited<ReturnType<typeof authorityFingerprint>>,
): Promise<void> {
  if (flags["restore-only"] !== undefined && flags["restore-only"] !== "registry")
    throw new Error("--restore-only must be exactly registry");
  if (flags["restore-only"] === "registry" && manifest.selection !== "registry" &&
      !manifest.streams.some((entry) => entry.stream === spaceBackupInventory(manifest.space).registry[0]))
    throw new Error("artifact does not contain the registry component");
  if (manifest.space !== ready.space) throw new Error(`backup belongs to space ${JSON.stringify(manifest.space)}, not ${JSON.stringify(ready.space)}`);
  if (manifest.mode !== ready.mode) throw new Error(`backup auth mode ${manifest.mode} does not match preserved source mode ${ready.mode}`);
  if (flags.space && flags.space !== manifest.space) throw new Error(`--space ${JSON.stringify(flags.space)} does not match backup space ${JSON.stringify(manifest.space)}`);
  if (flags.open && manifest.mode !== "open") throw new Error("--open conflicts with the backup auth mode");
  if (flags["user-auth"] && manifest.mode !== "user") throw new Error("--user-auth conflicts with the backup auth mode");
  const inventory = spaceBackupInventory(manifest.space);
  const selected = flags["restore-only"] === "registry" ? inventory.registry : inventory[manifest.selection];
  const actual = manifest.streams.map((entry) => entry.stream);
  if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...inventory[manifest.selection]].sort()))
    throw new Error("backup manifest stream inventory does not match its selection");
  for (const stream of selected) {
    const record = manifest.streams.find((entry) => entry.stream === stream);
    if (!record) throw new Error(`backup is missing selected stream ${stream}`);
    validateCanonicalBackupStreamConfig(manifest.space, stream, record.config);
    validateBackupStreamState(record.state as unknown as Readonly<Record<string, unknown>>);
  }
  if (manifest.selection === "full" && flags["restore-only"] !== "registry") {
    if (!manifest.authority || JSON.stringify(manifest.authority) !== JSON.stringify(currentAuthority))
      throw new Error("backup authority fingerprint does not match current trust state");
  }
}

async function restoreStream(
  broker: IsolatedBroker,
  space: string,
  snapshotDir: string,
  stream: BackupManifest["streams"][number],
): Promise<void> {
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
      canonicalBackupStreamConfig(space, stream.stream),
      stream.state as unknown as Readonly<Record<string, unknown>>,
      RESTORE_TIMEOUT_MS,
    );
  } finally {
    await init.drain().catch(() => {});
  }
  const uploadLogin = await broker.addLogin({
    profile: "restore",
    scope: { operation: "upload", stream: stream.stream, deliverSubject: session.deliverSubject },
  });
  if (process.env.COTAL_SMOKE_FAIL_RESTORE_STREAM === stream.stream)
    throw new Error(`smoke-injected exact-ID chunk handoff timeout for ${stream.stream}`);
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
    validateCanonicalBackupStreamConfig(space, stream.stream, restored.config);
    assertRestoredState(stream.stream, stream.state as unknown as Readonly<Record<string, unknown>>, restored.state as unknown as Readonly<Record<string, unknown>>);
  } finally {
    closeSync(fd);
    await upload.drain().catch(() => {});
  }
}

/** Re-snapshot one validated quarantine stream (`no_consumers` native form) into an attempt-owned
 *  pinned file. The real target is instantiated ONLY from these sanitized bytes, never from the
 *  archive-supplied snapshot. */
async function sanitizeStreamSnapshot(
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
    validateCanonicalBackupStreamConfig(space, stream.stream, metadata.config);
    assertRestoredState(stream.stream, stream.state as unknown as Readonly<Record<string, unknown>>, metadata.state as unknown as Readonly<Record<string, unknown>>);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
    await nc.drain().catch(() => {});
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
    validateCanonicalBackupStreamConfig(space, record.stream, info.config as unknown as Record<string, unknown>);
    assertRestoredState(record.stream, record.state as unknown as Readonly<Record<string, unknown>>, info.state as unknown as Readonly<Record<string, unknown>>);
    if (info.state.consumer_count !== expectedConsumers)
      throw new Error(`${record.stream} has ${info.state.consumer_count} consumers after restore; expected ${expectedConsumers}`);
  } finally {
    await nc.drain().catch(() => {});
  }
}

async function recreateCheckpoint(
  broker: IsolatedBroker,
  space: string,
  checkpoint: PersistentConsumerCheckpoint,
): Promise<void> {
  const expected = consumerConfigFromCheckpoint(space, checkpoint);
  const login = await broker.addLogin({
    profile: "restore",
    scope: { operation: "checkpoint", checkpoint },
  });
  const nc = await connectIsolatedBroker(broker, login);
  try {
    const info = await recreateConsumerCheckpoint(nc, space, checkpoint, RESTORE_TIMEOUT_MS);
    if (info.config.opt_start_seq !== expected.opt_start_seq || info.config.deliver_policy !== expected.deliver_policy)
      throw new Error(`${checkpoint.stream}/${checkpoint.name} did not preserve its conservative checkpoint floor`);
    if (info.ack_floor.stream_seq !== 0 || info.ack_floor.consumer_seq !== 0)
      throw new Error(`${checkpoint.stream}/${checkpoint.name} was recreated with a non-zero native ACK floor`);
  } finally {
    await nc.drain().catch(() => {});
  }
}

async function createOmittedInfrastructure(
  broker: IsolatedBroker,
  space: string,
  registryOnly: boolean,
): Promise<void> {
  const inventory = spaceBackupInventory(space);
  const create = registryOnly ? inventory.full.filter((name) => !inventory.registry.includes(name)) : [];
  const excluded = inventory.excluded.map((entry) => entry.name);
  const login = await broker.addLogin({
    profile: "infrastructure",
    streams: [...create, ...excluded],
  });
  const nc = await connectIsolatedBroker(broker, login);
  try {
    const jsm = await jetstreamManager(nc);
    for (const stream of create) await jsm.streams.add(canonicalBackupStreamConfig(space, stream));
    const kvm = new Kvm(nc);
    await kvm.create(presenceBucket(space), { ttl: 6_000 });
    await kvm.create(membershipBucket(space), { history: 1, max_bytes: MEMBERSHIP_MAX_BYTES });
    await kvm.create(deliveryBucket(space), { ttl: LEASE_TTL_MS });
    await kvm.create(managerBucket(space), { ttl: MANAGER_LEASE_TTL_MS });
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
    validateSpaceBackupInventory(space, names);
  } finally {
    await nc.drain().catch(() => {});
  }
}

async function restoreAndValidate(
  broker: IsolatedBroker,
  space: string,
  staged: StagedArtifact,
  snapshotDir: string,
  onlyRegistry: boolean,
  checkpoints: readonly PersistentConsumerCheckpoint[],
  completeInfrastructure: boolean,
): Promise<void> {
  const wanted = onlyRegistry ? spaceBackupInventory(space).registry : spaceBackupInventory(space)[staged.manifest.selection];
  for (const name of wanted) await restoreStream(broker, space, snapshotDir, staged.manifest.streams.find((entry) => entry.stream === name)!);
  for (const name of wanted)
    await validateRestoredStream(broker, space, staged.manifest.streams.find((entry) => entry.stream === name)!, 0);
  if (completeInfrastructure) await createOmittedInfrastructure(broker, space, onlyRegistry);
  if (!onlyRegistry) for (const checkpoint of checkpoints) await recreateCheckpoint(broker, space, checkpoint);
  if (!onlyRegistry) for (const name of wanted) {
    const count = checkpoints.filter((checkpoint) => checkpoint.stream === name).length;
    await validateRestoredStream(broker, space, staged.manifest.streams.find((entry) => entry.stream === name)!, count);
  }
}

function removeOwnedDirectory(path: string, identity: { dev: bigint; ino: bigint }): void {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino)
      rmSync(path, { recursive: true });
  } catch { /* absent or identity cannot be proven */ }
}

export async function prepareRestore(root: string, flags: RestoreFlags): Promise<PreparedRestore> {
  const attemptId = `restore-${randomUUID()}`;
  const serverNonce = randomUUID().replaceAll("-", "");
  const serverName = `${attemptId}-${serverNonce}`;
  const coordinator: ProcessOwner = {
    pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), id: `${attemptId}-coordinator`,
  };
  const deadline = new Date(Date.now() + RESTORE_TIMEOUT_MS);
  let lock = acquireMaintenanceLock(root);
  let staged: StagedArtifact | undefined;
  let transitioned = false;
  let targetBound = false;
  let targetIdentity: { dev: bigint; ino: bigint } | undefined;
  let quarantine: { path: string; identity: { dev: bigint; ino: bigint } } | undefined;
  let sanitized: { path: string; identity: { dev: bigint; ino: bigint } } | undefined;
  let broker: IsolatedBroker | undefined;
  let quarantineBroker: IsolatedBroker | undefined;
  const recordResources = (input: { owners?: readonly ProcessOwner[]; ownedPaths?: readonly AttemptOwnedPath[] }) => {
    const resourceLock = acquireMaintenanceLock(root);
    try {
      recordRestoreAttemptResources(resourceLock, input);
    } finally {
      releaseMaintenanceLock(resourceLock);
    }
  };
  try {
    let journal = readMaintenanceJournal(root);
    if (journal?.state === "restore-ready") {
      // Never touch a live attempt: recover by rollback only once the recorded claim is provably
      // stale (deadline elapsed, coordinator/watchdogs/brokers all dead).
      const assessment = assessRestoreClaim(journal);
      if (assessment === "live")
        throw new Error(`restore attempt ${journal.restore.attemptId} is in progress (claim live until ${journal.claim.deadline}); retry after it completes or becomes provably stale`);
      if (assessment === "ambiguous")
        throw new Error(`restore attempt ${journal.restore.attemptId} owners cannot be proven dead; inspect the recorded coordinator, watchdog, and broker processes before recovery`);
      journal = rollbackRestore(lock);
    }
    if (!journal || journal.state !== "ready") throw new Error(`restore requires stable ready maintenance state, found ${journal?.state ?? "none"}`);
    const auth = journal.mode === "open" ? undefined : loadSpaceAuth(authDir(root));
    if (journal.mode !== "open") validateSpaceAuth(auth, journal.space);
    // Compute user-provider continuity before staging too. The later manifest comparison reuses this
    // value, so malformed trust cannot create an attempt target or move the preserved source first.
    const currentAuthority = await authorityFingerprint(root, journal.space, journal.mode);
    const stageParent = ensurePrivateAttemptsDir(root).path;
    const artifactPath = realpathSync.native(resolve(flags.restore));
    if (contains(journal.source.path, artifactPath) || contains(artifactPath, journal.source.path))
      throw new Error("restore artifact must not overlap the preserved source store");
    if (contains(stageParent, artifactPath) || contains(artifactPath, stageParent))
      throw new Error("restore artifact must not overlap the maintenance attempt directory");
    const targetPath = resolve(flags["store-dir"] ?? join(root, ".cotal", "nats"));
    assertRestoreTargetPath(journal.source.path, artifactPath, stageParent, targetPath);
    // The journal is ready with no live claim, and the artifact/target are proven disjoint from
    // the attempts directory: any attempts-dir content is dead-attempt residue.
    sweepAttemptResidue(root);
    const artifact = stageArtifact(artifactPath, stageParent);
    staged = artifact;
    await validateManifest(artifact.manifest, flags, journal, currentAuthority);
    const checkpoints = readStagedCheckpoints(artifact);
    const resume = readMaintenanceResumeDocument(root, journal.resume);
    const inventoryAgents = (resume.inventory as { agents?: Array<{ launch?: { runtime?: unknown } }> }).agents ?? [];
    const inventoryRuntimes = [...new Set(inventoryAgents
      .map((agent) => agent.launch?.runtime)
      .filter((value): value is string => typeof value === "string"))];
    if (inventoryRuntimes.length > 1) throw new Error(`resume inventory requires multiple runtimes: ${inventoryRuntimes.join(", ")}`);
    // The partial selection is a property of the artifact, not only of the flag: a registry-only
    // artifact restored without --restore-only registry must still create omitted infrastructure.
    const onlyRegistry = flags["restore-only"] === "registry" || artifact.manifest.selection === "registry";
    // Retained agents relaunch under their preserved runtime; a contradicting override must fail
    // in preflight, before any mutation or listener exposure.
    if (!onlyRegistry && flags.runtime && inventoryRuntimes[0] && flags.runtime !== inventoryRuntimes[0])
      throw new Error(`--runtime ${flags.runtime} contradicts the preserved agent runtime ${inventoryRuntimes[0]}; omit it or restore registry-only`);
    const effectiveRuntime = flags.runtime ?? inventoryRuntimes[0] ?? "pty";
    const wanted = onlyRegistry ? spaceBackupInventory(journal.space).registry : spaceBackupInventory(journal.space)[artifact.manifest.selection];
    for (const checkpoint of onlyRegistry ? [] : checkpoints) {
      if (!wanted.includes(checkpoint.stream)) throw new Error(`checkpoint ${checkpoint.stream}/${checkpoint.name} is outside the restored selection`);
      const streamRecord = artifact.manifest.streams.find((entry) => entry.stream === checkpoint.stream);
      if (!streamRecord) throw new Error(`checkpoint ${checkpoint.stream}/${checkpoint.name} has no snapshot stream`);
      const snapshotState = validateBackupStreamState(streamRecord.state as unknown as Readonly<Record<string, unknown>>);
      if (JSON.stringify(checkpoint.streamState) !== JSON.stringify({
        messages: snapshotState.messages,
        first_seq: snapshotState.first_seq,
        last_seq: snapshotState.last_seq,
      })) throw new Error(`checkpoint ${checkpoint.stream}/${checkpoint.name} does not match its snapshot stream state`);
      consumerConfigFromCheckpoint(journal.space, checkpoint);
    }
    const authorityBeforeMutation = await authorityFingerprint(root, journal.space, journal.mode);
    if (JSON.stringify(authorityBeforeMutation) !== JSON.stringify(currentAuthority))
      throw new Error("current trust state changed during restore validation");
    await validateManifest(artifact.manifest, flags, journal, authorityBeforeMutation);
    const sourceExists = (() => {
      try { lstatSync(journal.source.path); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    })();
    const stagedStat = lstatSync(artifact.directory, { bigint: true });
    const claim = {
      deadline: deadline.toISOString(),
      coordinator,
      ownedPaths: [{
        label: "staging" as const, path: artifact.directory,
        dev: stagedStat.dev.toString(), ino: stagedStat.ino.toString(),
      }],
    };
    if (!sourceExists) {
      if (!flags["accept-missing-source"]) throw new Error("preserved source is missing; pass --accept-missing-source only after verifying disaster recovery intent");
      prepareMissingSourceRestore(lock, { attemptId, targetPath, claim });
    } else if (targetPath === journal.source.path) {
      const fallbackPath = join(dirname(targetPath), `.cotal-restore-fallback-${attemptId}`);
      prepareSamePathRestore(lock, { attemptId, targetPath, fallbackPath, claim });
      moveSamePathRestoreSource(lock);
    } else {
      prepareAlternateRestore(lock, { attemptId, targetPath, claim });
    }
    transitioned = true;
    createOwnedDirectory(targetPath);
    const targetStat = lstatSync(targetPath, { bigint: true });
    targetIdentity = { dev: targetStat.dev, ino: targetStat.ino };
    bindRestoreTarget(lock);
    targetBound = true;
    releaseMaintenanceLock(lock);
    lock = undefined as never;

    // The lock is held across broker spawn → owner record so no live broker can exist outside the
    // journaled claim, even across a crash in between; stale recovery then never races an orphan.
    lock = acquireMaintenanceLock(root);
    const quarantinePath = join(stageParent, `${attemptId}-quarantine`);
    createOwnedDirectory(quarantinePath);
    const quarantineStat = lstatSync(quarantinePath, { bigint: true });
    quarantine = { path: quarantinePath, identity: { dev: quarantineStat.dev, ino: quarantineStat.ino } };
    recordRestoreAttemptResources(lock, { ownedPaths: [{
      label: "quarantine", path: quarantinePath,
      dev: quarantineStat.dev.toString(), ino: quarantineStat.ino.toString(),
    }] });
    quarantineBroker = await startIsolatedBroker({
      root,
      storeDir: quarantinePath,
      space: journal.space,
      mode: journal.mode,
      auth,
      deadline,
      label: "quarantine",
      initialScope: { profile: "restore", scope: { operation: "initiate", stream: wanted[0] } },
      attemptId,
    });
    recordRestoreAttemptResources(lock, {
      owners: [quarantineBroker.brokerOwner, quarantineBroker.watchdogOwner],
      ownedPaths: quarantineBroker.runFiles.map((file) => ({ label: "config" as const, ...file })),
    });
    releaseMaintenanceLock(lock);
    lock = undefined as never;
    try {
      await restoreAndValidate(quarantineBroker, journal.space, artifact, artifact.directory, onlyRegistry, [], false);
      // Re-derive every snapshot from the VALIDATED quarantine state. Only these sanitized bytes
      // may instantiate the real target; the archive-supplied snapshots never touch it.
      // Ownership precedes existence: the slot is journaled pending, created, then inode-upgraded.
      const sanitizedPath = join(stageParent, `${attemptId}-sanitized`);
      const sanitizedLock = acquireMaintenanceLock(root);
      try {
        recordRestoreAttemptResources(sanitizedLock, { ownedPaths: [{ label: "sanitized", path: sanitizedPath }] });
        createOwnedDirectory(sanitizedPath);
        const sanitizedStat = lstatSync(sanitizedPath, { bigint: true });
        sanitized = { path: sanitizedPath, identity: { dev: sanitizedStat.dev, ino: sanitizedStat.ino } };
        recordRestoreAttemptResources(sanitizedLock, { ownedPaths: [{
          label: "sanitized", path: sanitizedPath,
          dev: sanitizedStat.dev.toString(), ino: sanitizedStat.ino.toString(),
        }] });
      } finally {
        releaseMaintenanceLock(sanitizedLock);
      }
      for (const name of wanted) {
        const record = artifact.manifest.streams.find((entry) => entry.stream === name)!;
        await sanitizeStreamSnapshot(quarantineBroker, journal.space, record, join(sanitizedPath, record.snapshot));
      }
    } finally {
      await quarantineBroker.stop();
      quarantineBroker = undefined;
    }
    removeOwnedDirectory(quarantine.path, quarantine.identity);
    quarantine = undefined;

    lock = acquireMaintenanceLock(root);
    broker = await startIsolatedBroker({
      root,
      storeDir: targetPath,
      space: journal.space,
      mode: journal.mode,
      auth,
      deadline,
      label: "restore",
      initialScope: { profile: "restore", scope: { operation: "initiate", stream: wanted[0] } },
      attemptId,
    });
    recordRestoreAttemptResources(lock, {
      owners: [broker.brokerOwner, broker.watchdogOwner],
      ownedPaths: broker.runFiles.map((file) => ({ label: "config" as const, ...file })),
    });
    releaseMaintenanceLock(lock);
    lock = undefined as never;
    await restoreAndValidate(broker, journal.space, artifact, sanitized!.path, onlyRegistry, checkpoints, true);
    await broker.stop();
    broker = undefined;

    lock = acquireMaintenanceLock(root);
    const resumeLaunch = (resume.launch ?? {}) as { server?: unknown };
    const effectiveServer = canonicalServerEndpoint(flags.server ?? (typeof resumeLaunch.server === "string" ? resumeLaunch.server : "nats://127.0.0.1:4222"));
    const effectiveHost = flags.host ?? (() => {
      try { return new URL(effectiveServer).hostname; } catch { return "127.0.0.1"; }
    })();
    writeRestoreCommitIntent(lock, {
      attemptId,
      targetPath,
      space: journal.space,
      mode: journal.mode,
      server: effectiveServer,
      host: effectiveHost,
      runtime: effectiveRuntime,
      detached: Boolean(flags.detach),
      restoreSource: resolve(flags.restore),
      restoreOnly: flags["restore-only"] ?? artifact.manifest.selection,
      acceptMissingSource: Boolean(flags["accept-missing-source"]),
      serverName,
      serverNonce,
    } as { [key: string]: JsonValue });
    releaseMaintenanceLock(lock);
    lock = undefined as never;
    return {
      root,
      attemptId,
      targetPath,
      space: journal.space,
      mode: journal.mode,
      server: effectiveServer,
      host: effectiveHost,
      runtime: effectiveRuntime,
      detached: Boolean(flags.detach),
      selection: onlyRegistry ? "registry" : artifact.manifest.selection,
      inventory: resume.inventory,
      serverName,
      serverNonce,
      reentry: false,
      journalState: "commit-intent",
      cleanupStage: () => {
        artifact.cleanup();
        if (sanitized) removeOwnedDirectory(sanitized.path, sanitized.identity);
      },
    };
  } catch (error) {
    const shutdownFailures: Error[] = [];
    if (broker) try { await broker.stop(); broker = undefined; } catch (cause) {
      shutdownFailures.push(cause instanceof Error ? cause : new Error(String(cause)));
    }
    if (quarantineBroker) try { await quarantineBroker.stop(); quarantineBroker = undefined; } catch (cause) {
      shutdownFailures.push(cause instanceof Error ? cause : new Error(String(cause)));
    }
    if (shutdownFailures.length)
      throw new Error(`${error instanceof Error ? error.message : String(error)}; isolated broker exit could not be proven, so stores and staging were preserved: ${shutdownFailures.map((failure) => failure.message).join("; ")}`);
    if (quarantine) removeOwnedDirectory(quarantine.path, quarantine.identity);
    if (sanitized) removeOwnedDirectory(sanitized.path, sanitized.identity);
    if (!lock) lock = acquireMaintenanceLock(root);
    if (transitioned && !targetBound && targetIdentity) {
      removeOwnedDirectory(resolve(flags["store-dir"] ?? join(root, ".cotal", "nats")), targetIdentity);
      targetIdentity = undefined;
    }
    let rollbackFailure: Error | undefined;
    if (transitioned) try { rollbackRestore(lock, { asCoordinator: coordinator }); } catch (cause) {
      rollbackFailure = cause instanceof Error ? cause : new Error(String(cause));
    }
    if (!rollbackFailure && targetIdentity) removeOwnedDirectory(resolve(flags["store-dir"] ?? join(root, ".cotal", "nats")), targetIdentity);
    staged?.cleanup();
    if (rollbackFailure)
      throw new Error(`${error instanceof Error ? error.message : String(error)}; pre-commit rollback also failed: ${rollbackFailure.message}`);
    throw error;
  } finally {
    if (lock) releaseMaintenanceLock(lock);
  }
}

export function markPreparedRestoreActive(
  prepared: PreparedRestore,
  managerResult: ManagerFinalizeEvidence,
): void {
  if (!isManagerFinalizeEvidence(managerResult, prepared.attemptId, prepared.managerCommit?.durableCommitToken ?? ""))
    throw new Error(`restore attempt ${prepared.attemptId} has invalid manager finalize evidence`);
  const lock = acquireMaintenanceLock(prepared.root);
  try {
    const journal = readMaintenanceJournal(prepared.root);
    if (!journal || !["manager-committed", "active", "degraded"].includes(journal.state))
      throw new Error(`restore activation journal does not match attempt ${prepared.attemptId}`);
    const restoreJournal = journal as RestoreManagerCommittedRecord | RestoreActiveRecord | RestoreDegradedRecord;
    if (restoreJournal.restore.attemptId !== prepared.attemptId)
      throw new Error(`restore activation journal does not match attempt ${prepared.attemptId}`);
    if (restoreJournal.state === "active") {
      if (!isManagerCommittedRestore(restoreJournal))
        throw new Error(`restore attempt ${prepared.attemptId} is active without durable manager commit evidence`);
      markRestoreActive(lock, prepared.listenerProof!, managerResult);
      prepared.journalState = "active";
      return;
    }
    if (!prepared.listenerProof)
      throw new Error(`restore attempt ${prepared.attemptId} has no bound listener proof at activation`);
    if (restoreJournal.state === "manager-committed")
      markRestoreActive(lock, prepared.listenerProof, managerResult);
    else if (restoreJournal.managerCommit)
      repairRestoreDegradedToActive(lock, prepared.listenerProof, managerResult);
    else
      throw new Error(`restore activation journal does not contain durable manager commit evidence for ${prepared.attemptId}`);
    prepared.journalState = "active";
  } finally {
    releaseMaintenanceLock(lock);
  }
}

export function recordPreparedRestoreManagerCommit(
  prepared: PreparedRestore,
  evidence: ManagerCommitEvidence,
): void {
  if (!isManagerCommitResult(evidence, prepared.attemptId))
    throw new Error(`restore attempt ${prepared.attemptId} has invalid manager commit evidence`);
  if (!prepared.listenerProof)
    throw new Error(`restore attempt ${prepared.attemptId} has no bound listener proof at manager commit`);
  const lock = acquireMaintenanceLock(prepared.root);
  try {
    recordRestoreManagerCommit(lock, prepared.listenerProof, evidence);
    prepared.managerCommit = evidence;
    prepared.journalState = "manager-committed";
  } finally {
    releaseMaintenanceLock(lock);
  }
}

export function markPreparedRestoreDegraded(root: string, attemptId: string, reason: string): void {
  const lock = acquireMaintenanceLock(root);
  try {
    const journal = readMaintenanceJournal(root);
    if (!journal || (journal.state !== "commit-intent" && journal.state !== "active") || journal.restore.attemptId !== attemptId) return;
    markRestoreDegraded(lock, reason, [{
      action: "repair",
      description: "Preserve the restored target and retained source; recover forward before cleanup.",
      paths: [journal.restore.target.path, journal.restore.previousSource?.identity.path].filter((path): path is string => Boolean(path)),
    }]);
  } finally {
    releaseMaintenanceLock(lock);
  }
}
