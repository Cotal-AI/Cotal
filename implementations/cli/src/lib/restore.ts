import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  consumerConfigFromCheckpoint,
  hardenPrivate,
  readPluginMaintenanceState,
  spaceBackupInventory,
  spacePluginStreams,
  validateSpaceAuth,
  validateBackupStreamState,
  validateCanonicalBackupStreamConfig,
  wfjStreamName,
  type SpaceAuth,
} from "@cotal-ai/core";
import {
  CommandFailure,
  acquireMaintenanceLock,
  assessMaintenanceClaim,
  assessRestoreClaim,
  bindRestoreListener,
  bindRestoreTarget,
  codeSpan,
  cutController,
  getSpaceAuth,
  maintenancePaths,
  markRestoreActive,
  settleTokenHandoff,
  markRestoreDegraded,
  moveSamePathRestoreSource,
  prepareAlternateRestore,
  prepareMissingSourceRestore,
  prepareSamePathRestore,
  rearmUnboundRestoreCommitIntent,
  localProcessOwnerStatus,
  parsePositiveIntegerFlag,
  readMaintenanceJournal,
  restoreLeftOut,
  restoreOtherAccounts,
  restoreReplacedNewerCut,
  restoreRolledBackRuns,
  storeAccounts,
  readMaintenanceResumeDocument,
  recordRestoreAttemptResources,
  recordRestoreManagerCommit,
  replaceDeadRestoreListener,
  repairRestoreDegradedToActive,
  releaseMaintenanceLock,
  shellPath,
  workspaceSecretStore,
  writeRestoreCommitIntent,
  type AttemptOwnedPath,
  type CommitIntentRecord,
  type JsonValue,
  type ManagerCommitEvidence,
  type ManagerFinalizeEvidence,
  type MaintenanceClaim,
  type MaintenanceLock,
  type MaintenanceReadyRecord,
  type ProcessOwner,
  type RestoreActiveRecord,
  type RestoreDegradedRecord,
  type ListenerProof,
  type RestoreManagerCommittedRecord,
  type RestoreReadyRecord,
  readStoreIdentity,
  preparedSpaceAt,
  retainedLegacyBroker,
  type StoreIdentity,
} from "@cotal-ai/workspace";
import { controllerStackApplies } from "../commands/stack-up.js";
import { ArtifactFileFault, artifactReadRefusal, artifactStreams, BACKUP_MANIFEST_FORMAT_V1, declaredArtifactStreams, inspectBackupArtifact, missingBackupPath, missingBackupPathText, notAnArtifactRefusal, readStagedCheckpoints, stageArtifact, type BackupManifest, type StagedArtifact } from "./backup-artifact.js";
import { authorityFingerprint } from "./maintenance-files.js";
import { attemptProcessesGone, connectIsolatedBroker, createAttemptClone, ensurePrivateAttemptsDir, startIsolatedBroker, sweepAttemptResidue, type IsolatedBroker } from "./isolated-broker.js";
import { inspectPreviousStore, readRegistryDefault, readRunJournals, rolledBackRuns } from "./rolled-back-runs.js";
import { noticeOnInterrupt } from "./interrupt-notice.js";
import { displayCmd } from "./self-exec.js";
import { localDiagnostic } from "../telemetry.js";
import { assertEndpointUnreachable } from "./endpoint-cut.js";
import { acquireStackOperationLock } from "./stack-journal.js";
import { checkStorePath, foreignEntriesRefusal, missingRestoreStoreParent, oldStoreForeignEntries } from "./store-dir.js";
import { admitAndRestoreSeatCheckpoints } from "./seat-resume.js";
import { assertControllerRestorable, reconfigureControllerBroker, rollbackRestoreWithBroker } from "./controller-restore.js";
import { assertControllerCoupling, newControllerAttemptLaunch } from "./controller-resume.js";
import { RESTORE_TIMEOUT_MS, sanitizeStreamSnapshot, applyRecordedAge, restoreAndValidate, restoredPluginState } from "./restore-streams.js";
export interface RestoreFlags {
  restore: string;
  "restore-only"?: string;
  "accept-missing-source"?: boolean;
  "store-dir"?: string;
  "max-file-store"?: string;
  space?: string;
  server?: string;
  host?: string;
  runtime?: string;
  detach?: boolean;
  open?: boolean;
  "user-auth"?: boolean;
  idp?: string;
  /** Consent for admission gate 3, as the ordinary resume path takes it: a restored journal's
   *  retained seats pass the same gates, so they need the same override available. */
  "accept-stale-checkpoint"?: boolean;
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
  /** The JetStream file storage cap the restore started its broker with (`--max-file-store`). */
  maxFileStore?: number;
  selection: "full" | "registry";
  /** The streams this attempt restored from the artifact. */
  restoredStreams: readonly string[];
  inventory: JsonValue;
  serverName: string;
  serverNonce: string;
  /** True only when reconstructed from durable commit/repair state after coordinator loss. */
  reentry: boolean;
  journalState: "commit-intent" | "manager-committed" | "active" | "degraded";
  managerCommit?: ManagerCommitEvidence;
  listenerProof?: ListenerProof;
  /** A new restore hands its interrupt notice to the startup that continues it. */
  releaseInterruptNotice?(): void;
  cleanupStage(): void;
}

type RecoverableRestoreRecord = CommitIntentRecord | RestoreManagerCommittedRecord | RestoreActiveRecord | RestoreDegradedRecord;

function launchString(launch: Readonly<Record<string, JsonValue>>, key: string): string {
  const value = launch[key];
  if (typeof value !== "string" || !value) throw new Error(`restore launch record is missing ${key}`);
  return value;
}

/** The store cap a preserved launch recorded: absent, or a positive integer byte count. Anything
 *  else is a damaged journal, refused rather than rendered as the dynamic default. */
export function journaledMaxFileStore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`the preserved launch records an invalid maxFileStore (${JSON.stringify(value)}); refusing to guess the broker's store cap`);
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
  const maxFileStore = journaledMaxFileStore(journal.launch.maxFileStore);
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
    ...(maxFileStore !== undefined ? { maxFileStore } : {}),
    selection: restoreOnly,
    restoredStreams: journaledRestoredStreams(journal.launch, journal.space, journal.mode),
    inventory: resume.inventory,
    serverName,
    serverNonce,
    // Only a bound listener is adopted or replaced. With none bound, the attempt starts its listener,
    // the first one under its launch identity (#7127).
    reentry: Boolean(journal.listenerProof),
    journalState: journal.state,
    ...(journal.state !== "commit-intent" && journal.managerCommit ? { managerCommit: journal.managerCommit } : {}),
    ...(journal.listenerProof ? { listenerProof: journal.listenerProof } : {}),
    cleanupStage() {
      removeRecordedOwnedPaths(journal.restore.ownedPaths);
    },
  };
}

// The `heldLock` on this and the four writers below is not symmetry: an `up` resume re-entry holds
// the root maintenance lock for its whole run, the lock is not reentrant, and it cannot stale-reap
// its way out because the recorded owner is alive — it is the caller. Self-acquiring here takes the
// "held by a live owner" refusal and fails the restore outright, so a caller that already holds the
// lock MUST hand it down. Callers outside a resume pass nothing and this takes its own, as before.
export function bindPreparedRestoreListener(
  prepared: PreparedRestore,
  processOwner: ProcessOwner,
  heldLock?: MaintenanceLock,
): ListenerProof {
  const lock = heldLock ?? acquireMaintenanceLock(prepared.root);
  try {
    const journal = readMaintenanceJournal(prepared.root);
    if (!journal || journal.state !== "commit-intent" || journal.restore.attemptId !== prepared.attemptId)
      throw new Error(`restore listener bind does not match commit attempt ${prepared.attemptId}`);
    const proof: ListenerProof = {
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
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}

export function replacePreparedDeadRestoreListener(prepared: PreparedRestore, heldLock?: MaintenanceLock): void {
  if (!prepared.listenerProof)
    throw new Error(`restore attempt ${prepared.attemptId} has no bound listener proof to replace`);
  const lock = heldLock ?? acquireMaintenanceLock(prepared.root);
  try {
    replaceDeadRestoreListener(lock, prepared.listenerProof);
    prepared.serverNonce = randomUUID().replaceAll("-", "");
    prepared.serverName = `${prepared.attemptId}-${prepared.serverNonce}`;
    prepared.listenerProof = undefined;
    prepared.journalState = "commit-intent";
    prepared.reentry = false;
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}

/** Return a restore with no bound listener to commit intent before its listener starts (#7127). The
 *  caller has proved that no listener this attempt spawned still runs. */
export function rearmUnboundRestore(prepared: PreparedRestore, heldLock?: MaintenanceLock): void {
  const lock = heldLock ?? acquireMaintenanceLock(prepared.root);
  try {
    rearmUnboundRestoreCommitIntent(lock);
    prepared.journalState = "commit-intent";
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
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
  // The restore target, quarantine, and sanitized dirs hold whole-stream snapshots (chat + DMs).
  // `hardenPrivate` reasserts 0700 on POSIX and sets an owner-only NTFS ACL on win32, where the
  // create mode is a no-op — and fails closed if it cannot, so a snapshot never lands under an
  // inherited permissive ACL.
  mkdirSync(path, { mode: 0o700 });
  hardenPrivate(path, "dir");
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
    throw new Error("restore listener endpoint is not canonicalizable - use a bare nats:// or tls:// URL without credentials, a query, a fragment or a path");
  return `${endpoint.protocol}//${endpoint.hostname.toLowerCase()}:${endpoint.port || "4222"}`;
}

/** Whether `path` is a link that resolves to `target`. A dangling link resolves nowhere. */
function linksTo(path: string, target: string): boolean {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  try { return realpathSync.native(path) === target; } catch { return false; }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  const separator = process.platform === "win32" ? "\\" : "/";
  return path === "" || (path !== ".." && !path.startsWith(`..${separator}`) && !isAbsolute(path));
}

/** Refuse artifacts that overlap the preserved store or maintenance paths restore writes or sweeps.
 *  `artifact` and `store` are real paths. */
function artifactOverlapRefusal(root: string, artifact: string, store: string): CommandFailure | undefined {
  const { maintenanceDir, versionDir, lock, reaper } = maintenancePaths(root);
  const maintenance = realpathSync.native(maintenanceDir);
  for (const [path, what, why] of [
    [store, "the preserved store", " it would replace"],
    [join(maintenance, "attempts"), "this root's maintenance attempt directory", ", where it stages its attempt"],
    [join(maintenance, basename(versionDir)), "this root's maintenance journal directory", ""],
    [join(maintenance, basename(lock)), "this root's maintenance lock path", ""],
    [join(maintenance, basename(reaper)), "this root's maintenance lock recovery path", ""],
  ] as const) {
    if (!contains(path, artifact) && !contains(artifact, path)) continue;
    const relation = artifact === path ? "is" : contains(path, artifact) ? "is inside" : "holds";
    return new CommandFailure("refused", "USAGE_INVALID", `the restore artifact ${artifact} ${relation} ${what}${relation === "is" ? "" : ` ${path}`}${why}; nothing was restored`, { target: { root, directory: artifact, overlaps: path }, remedy: `name a backup artifact folder outside ${path}`, selfContained: true });
  }
  return undefined;
}

/** An explicit `--store-dir` names the directory a restore creates and owns for its rollback.
 *  Its parent must resolve to a directory, and the target must be absent unless it is the preserved store. */
function assertNewStorePath(target: string, source: string): void {
  if (!statSync(dirname(target), { throwIfNoEntry: false })?.isDirectory()) throw missingRestoreStoreParent(target);
  const remedy = "name a --store-dir path that does not exist yet, inside an existing directory; the restore creates it";
  if (target !== source && lstatSync(target, { throwIfNoEntry: false }))
    throw localDiagnostic(new CommandFailure("refused", "USAGE_INVALID", `the --store-dir path ${target} already exists, and a restore creates its store directory itself; nothing was restored`, { target: { storeDir: target }, remedy }));
}

function assertRestoreTargetPath(source: string, artifact: string, attempts: string, target: string, explicit: boolean): void {
  const canonicalTarget = explicit ? checkStorePath(target, "restore", () => canonicalFuturePath(target)) : canonicalFuturePath(target);
  if (canonicalTarget !== source && (contains(source, canonicalTarget) || contains(canonicalTarget, source)))
    throw new CommandFailure("refused", "USAGE_INVALID", "restore target must not overlap the preserved source store. No restore started.", {
      target: { storeDir: target },
      remedy: "choose an absent `--store-dir` path outside the preserved source store, under an existing writable directory",
      selfContained: true,
    });
  if (contains(attempts, canonicalTarget) || contains(canonicalTarget, attempts))
    throw new Error("restore target must not overlap the maintenance attempt directory");
  if (contains(artifact, canonicalTarget) || contains(canonicalTarget, artifact))
    throw new CommandFailure("refused", "USAGE_INVALID", "restore target must not overlap the backup artifact. No restore started.", {
      target: { storeDir: target },
      remedy: "choose an absent `--store-dir` path outside the backup artifact, under an existing writable directory",
      selfContained: true,
    });
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
  // Checked before any transition, so the preserved cut is unchanged: a refusal, not an unknown outcome.
  if (manifest.space !== ready.space)
    throw new CommandFailure("refused", "CONFLICT", `backup belongs to space ${JSON.stringify(manifest.space)}, not ${JSON.stringify(ready.space)}; the preserved cut was not changed`, { target: { space: ready.space, backupSpace: manifest.space }, remedy: `restore it on the root that preserved ${JSON.stringify(manifest.space)}, or use a backup of ${JSON.stringify(ready.space)}` });
  if (manifest.mode !== ready.mode) throw new Error(`backup auth mode ${manifest.mode} does not match preserved source mode ${ready.mode}`);
  const held = declaredArtifactStreams(manifest);
  const selected = flags["restore-only"] === "registry" ? spaceBackupInventory(manifest.space).registry : held;
  const actual = manifest.streams.map((entry) => entry.stream);
  if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...held].sort()))
    throw new Error("backup manifest stream inventory does not match its selection");
  for (const stream of selected) {
    const record = manifest.streams.find((entry) => entry.stream === stream);
    if (!record) throw new Error(`backup is missing selected stream ${stream}`);
    validateCanonicalBackupStreamConfig(manifest.space, stream, record.config);
    validateBackupStreamState(record.state as unknown as Readonly<Record<string, unknown>>);
  }
  if (manifest.selection === "full" && flags["restore-only"] !== "registry") {
    if (!manifest.authority || JSON.stringify(manifest.authority) !== JSON.stringify(currentAuthority)) {
      // Name the LIKELIEST drift instead of leaving a bare hash mismatch. The commitment covers the
      // operator JWT, the system account and the data account; when the DATA account still matches,
      // what moved is the broker half, and since `cotal up --rotate-sys` re-issues exactly those two
      // on a 30-day cadence, "you rotated after taking this backup" is the common case, not an exotic
      // one. Without this the operator sees an opaque fingerprint mismatch on the artifact they were
      // counting on during a disaster.
      // Checked before any transition, as the space is above: a refusal, not an unknown outcome.
      const sameAccount = manifest.authority?.account !== undefined && manifest.authority.account === currentAuthority.account;
      // A registry restore does not check the trust state, so an artifact that holds the registry
      // still restores that here, and the Next says how.
      const registry = spaceBackupInventory(manifest.space).registry.every((stream) => held.includes(stream))
        ? `; its channel registry still restores here with ${codeSpan(`cotal backup restore ${shellPath(resolve(flags.restore))} --only registry`)}, and chat and DM history and workflow runs then start empty`
        : "";
      throw new CommandFailure("refused", "CONFLICT",
        sameAccount
          ? "backup authority fingerprint does not match current trust state: the data account is unchanged, so the OPERATOR/SYSTEM half of the trust chain moved - this artifact predates a system-account rotation (`cotal up --rotate-sys`) and is bound to the retired chain; the preserved cut was not changed"
          : "backup authority fingerprint does not match current trust state: this full artifact was taken under another trust state, such as another machine's or a reset root's; the preserved cut was not changed",
        {
          target: { space: ready.space },
          remedy: (sameAccount
            ? "restore it into a root holding that chain, or use a backup taken after the rotation"
            : "a full backup restores only into a root that still holds the trust state it was taken under: restore it there, or use a full backup taken on this root") + registry,
        });
    }
  }
}

async function readRestorePluginState(lock: MaintenanceLock, ready: MaintenanceReadyRecord, auth: SpaceAuth, attemptId: string, deadline: Date): Promise<Awaited<ReturnType<typeof readPluginMaintenanceState>>> {
  const root = lock.root;
  const probeId = `${attemptId}-plugin-state`;
  const path = join(ensurePrivateAttemptsDir(root).path, `${probeId}-clone`);
  recordRestoreAttemptResources(lock, { ownedPaths: [{ label: "clone", path }] });
  const clone = createAttemptClone(root, ready.source.path, probeId);
  recordRestoreAttemptResources(lock, { ownedPaths: [{ label: "clone", path, dev: clone.identity.dev.toString(), ino: clone.identity.ino.toString() }] });
  const broker = await startIsolatedBroker({ root, storeDir: path, space: ready.space, mode: ready.mode, auth, deadline, label: "previous", initialScope: { profile: "backup", scope: { operation: "plugin-state" } }, attemptId: probeId });
  try {
    recordRestoreAttemptResources(lock, { owners: [broker.brokerOwner, broker.watchdogOwner], ownedPaths: broker.runFiles.map((file) => ({ label: "config" as const, ...file })) });
    const nc = await connectIsolatedBroker(broker, broker.initialLogin);
    try {
      return await readPluginMaintenanceState(nc, ready.space);
    } finally { await nc.close(); }
  } finally {
    await broker.stop();
    clone.cleanup();
  }
}

function validateRestoreCheckpoints(manifest: BackupManifest, wanted: readonly string[], checkpoints: ReturnType<typeof readStagedCheckpoints>): void {
  for (const checkpoint of checkpoints) {
    if (!wanted.includes(checkpoint.stream)) throw new Error(`checkpoint ${checkpoint.stream}/${checkpoint.name} is outside the restored selection`);
    const streamRecord = manifest.streams.find((entry) => entry.stream === checkpoint.stream);
    if (!streamRecord) throw new Error(`checkpoint ${checkpoint.stream}/${checkpoint.name} has no snapshot stream`);
    const snapshotState = validateBackupStreamState(streamRecord.state as unknown as Readonly<Record<string, unknown>>);
    if (JSON.stringify(checkpoint.streamState) !== JSON.stringify({
      messages: snapshotState.messages,
      first_seq: snapshotState.first_seq,
      last_seq: snapshotState.last_seq,
    })) throw new Error(`checkpoint ${checkpoint.stream}/${checkpoint.name} does not match its snapshot stream state`);
    consumerConfigFromCheckpoint(manifest.space, checkpoint, manifest.mode === "open");
  }
}

function removeOwnedDirectory(path: string, identity: { dev: bigint; ino: bigint }): void {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino)
      rmSync(path, { recursive: true });
  } catch { /* absent or identity cannot be proven */ }
}

/** Where a preserved store is relative to the path its journal recorded. `moved` means that path is
 *  gone and this root's own `.cotal/nats` is the same store, by device, inode and generation, so the
 *  folder was moved after the cut and `recordedRoot` is where it was. Resume and restore use the
 *  recorded path, so moving the folder back is what lets them run. */
export function preservedSourceState(root: string, source: StoreIdentity): { state: "present" } | { state: "missing" } | { state: "moved"; recordedRoot: string; store: string } {
  // Only a confirmed absence is classified here; any other lstat failure is left to the store checks.
  try { lstatSync(source.path); return { state: "present" }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { state: "present" }; }
  if (basename(source.path) !== "nats" || basename(dirname(source.path)) !== ".cotal") return { state: "missing" };
  const recordedRoot = dirname(dirname(source.path));
  let here: StoreIdentity;
  try { here = readStoreIdentity(join(root, ".cotal", "nats")); }
  catch { return { state: "missing" }; }
  return here.dev === source.dev && here.ino === source.ino && here.generation === source.generation ? { state: "moved", recordedRoot, store: here.path } : { state: "missing" };
}

/** The refusal for a folder moved after its state was preserved: where the journal recorded the
 *  store, where it is now, and the folder to move back to before `then` runs there. */
export function movedFolderRefusal(root: string, space: string, recordedStore: string, moved: { recordedRoot: string; store: string }, then: string): CommandFailure {
  return new CommandFailure("refused", "CONFLICT", `this folder was moved from ${moved.recordedRoot} after its state was preserved: the maintenance journal records the preserved store at ${recordedStore}, and that store is now ${moved.store}`, { target: { root, space, recordedRoot: moved.recordedRoot, recordedStore, store: moved.store }, remedy: `move this folder back to ${moved.recordedRoot}, then ${then} there` });
}

/** The streams a restore attempt restored, from its launch record. A record written before full
 *  backups held workflow runs names none, and those attempts restored a v1 artifact's streams. */
export function journaledRestoredStreams(launch: Readonly<Record<string, JsonValue>>, space: string, mode: MaintenanceReadyRecord["mode"]): string[] {
  const recorded = launch.restoredStreams;
  const selection = launchString(launch, "restoreOnly") === "registry" ? "registry" : "full";
  if (recorded === undefined) return [...artifactStreams({ format: BACKUP_MANIFEST_FORMAT_V1, space, selection, mode })];
  if (!Array.isArray(recorded) || recorded.some((name) => typeof name !== "string")) throw new Error("restore launch record has an invalid restoredStreams");
  return recorded as string[];
}

const CLASS_WORDS: Record<string, string> = {
  registry: "channel registry", messages: "messages", authorization: "channel ACLs and members", workflow: "workflow runs",
  transient: "presence", derived: "membership", lease: "leases", control: "endpoint control stores", artifact: "artifact store",
};

/** What a restore brought back from the artifact and what it recreated empty, by stream, and the
 *  same in words. A full restore that brought back no workflow store carries a note that says why:
 *  a user-mode artifact holds none, and an older artifact was made before full backups held runs. */
export function restoreComposition(space: string, restored: readonly string[], mode: MaintenanceReadyRecord["mode"]): { restored: string[]; recreatedEmpty: string[]; restoredWords: string; emptyWords: string; note?: string } {
  const inventory = spaceBackupInventory(space, spacePluginStreams(space).some((stream) => restored.includes(stream)));
  const all = [...inventory.backedUp, ...inventory.excluded];
  const empty = all.filter((entry) => !restored.includes(entry.name));
  const words = (entries: readonly { class: string }[]) => [...new Set(entries.map((entry) => CLASS_WORDS[entry.class]))].join(", ") || "none";
  const workflow = inventory.backedUp.filter((entry) => entry.class === "workflow").map((entry) => entry.name);
  return {
    restored: [...restored],
    recreatedEmpty: empty.map((entry) => entry.name),
    restoredWords: words(all.filter((entry) => restored.includes(entry.name))),
    emptyWords: words(empty),
    ...(restored.length > inventory.registry.length && !workflow.some((name) => restored.includes(name))
      ? { note: mode === "user" ? USER_MODE_NO_RUNS : OLDER_FORMAT_NO_RUNS } : {}),
  };
}

const USER_MODE_NO_RUNS = "A user-mode backup holds no workflow runs, because the records store's lifecycle heads name credential rows in the auth store, which a backup does not carry; the workflow run stores were recreated empty.";
const OLDER_FORMAT_NO_RUNS = "This backup was made before full backups held workflow runs, so it holds none; the workflow run stores were recreated empty.";

/** The step that moves a restore attempt on from `state`. A committed or degraded attempt goes
 *  forward through bare `up`. A preview can carry an explicit discard flag without deleting data.
 *  `cleanupRoot` is the project to enter when an active restore was started from another root. */
export function restoreNextStep(state: string, attemptId: string, journal?: Parameters<typeof restoreLeftOut>[0], { cleanupRoot, cmd = "cotal", previewDiscard = false }: { cleanupRoot?: string | undefined; cmd?: string; previewDiscard?: boolean } = {}): string {
  if (state === "restore-ready") return `roll the pre-commit attempt back with ${codeSpan(`${cmd} backup recover ${attemptId} --yes`)}; preview it first with --dry-run`;
  if (state === "active") {
    const leftOut = journal?.restore.previousSource ? restoreLeftOut(journal) : undefined;
    const cleanup = `${cleanupRoot ? `cd ${shellPath(cleanupRoot)} && ` : ""}${cmd} backup cleanup-fallback ${attemptId}`;
    if (leftOut || previewDiscard) {
      const preview = codeSpan(`${cleanup} --dry-run${previewDiscard ? " --discard-history" : ""}`);
      const history = leftOut ? `. Deleting the previous store requires --discard-history and removes the only copy of the ${leftOut} it left out.` : "";
      return `the restore completed: preview cleanup with ${preview}${history}`;
    }
    const note = journal?.restore.selection === "registry" ? ". Chat and DM history and workflow runs start empty after a registry-only restore." : "";
    return `the restore completed: retire its journal with ${codeSpan(`${cleanup} --yes`)}; preview it first with --dry-run${note}`;
  }
  return `recover forward with bare ${codeSpan(`${cmd} up`)} from this root, which continues attempt ${attemptId}; fallback cleanup follows once it is active`;
}

/** A ready journal's next step. Resume and backup use the store at its recorded path, so a folder
 *  moved after the cut is told to move back, and a missing store is named. */
function readyNextStep(source: StoreIdentity, where: ReturnType<typeof preservedSourceState>): string {
  if (where.state === "moved") return `this folder was moved from ${where.recordedRoot} after its state was preserved: move it back there, then create a backup or resume with bare \`${displayCmd()} up\``;
  if (where.state === "missing") return `the preserved store recorded at ${source.path} is missing: if this folder was moved, move it back; if the store is lost, restore a backup with \`${displayCmd()} backup restore <dir> --accept-missing-source\``;
  return `create a backup with \`${displayCmd()} backup create <dir>\`, or resume with bare \`${displayCmd()} up\``;
}

/** The next step for a cut a backup create still claims: wait while it runs, or release it once it
 *  stopped before it finished. */
function claimedNextStep(root: string, claim: MaintenanceClaim): string {
  const recover = `${displayCmd()} backup recover ${claim.attemptId} --yes`;
  if (assessMaintenanceClaim(claim, { unrecordedOwnersDead: attemptProcessesGone(root) }) === "stale")
    return `backup attempt ${claim.attemptId} stopped before it finished: release it with \`${recover}\``;
  return `backup attempt ${claim.attemptId} holds this root until ${claim.deadline} (process ${claim.coordinator.pid}); if it was stopped, run \`${recover}\` once it has exited`;
}

/** The attempt a root's maintenance journal holds and the step that moves it on, as `cotal status`
 *  shows it and a command that refuses over that journal names it. */
export function maintenanceNextStep(root: string, journal: NonNullable<ReturnType<typeof readMaintenanceJournal>>): { attemptId: string; next: string | null; sourceMissing?: true } {
  const attemptId = "restore" in journal ? journal.restore.attemptId : journal.state === "claimed" ? journal.claim.attemptId : journal.cut.attemptId;
  if (journal.state === "ready") {
    const source = preservedSourceState(root, journal.source);
    return { attemptId, next: readyNextStep(journal.source, source), ...(source.state === "missing" ? { sourceMissing: true } : {}) };
  }
  const next = "restore" in journal ? restoreNextStep(journal.state, attemptId, journal)
    : journal.state === "claimed" ? claimedNextStep(root, journal.claim) : null;
  return { attemptId, next };
}

/** The refusal while a restore's or backup's claim is not provably stale: what holds it, until
 *  when, and when `backup recover` can release it. The refusing command changed nothing. */
export function heldClaim(root: string, attemptId: string, claim: { readonly deadline: string; readonly coordinator: ProcessOwner; readonly owners: readonly ProcessOwner[] }, command: string, assessment: "live" | "ambiguous"): CommandFailure {
  const { coordinator, owners, deadline } = claim, kind = attemptId.startsWith("backup-") ? "backup" : "restore";
  const running = owners.filter((owner) => localProcessOwnerStatus(owner) === "alive").map((owner) => owner.pid);
  const coordinatorRuns = localProcessOwnerStatus(coordinator) === "alive";
  const recover = `cotal backup recover ${attemptId} --yes`;
  const [holder, remedy] = assessment === "ambiguous"
    ? [`its processes on host ${coordinator.host} cannot be proven gone from this host`, `prove its ${kind} process and brokers on ${coordinator.host} have exited, then run \`${recover}\``]
    : coordinatorRuns
      ? [`its ${kind} process ${coordinator.pid} is still running, started at ${coordinator.startedAt}`, `wait for that ${kind} to finish; if it was stopped, run \`${recover}\` once process ${coordinator.pid} has exited`]
      : running.length
        ? [`its ${kind} process ${coordinator.pid} has exited, and its brokers (pid ${running.join(", ")}) are still stopping`, `run \`${recover}\` again once they have exited`]
        : [`its ${kind} process ${coordinator.pid} has exited, but a broker it started cannot be proven gone`, `run \`${recover}\` after ${deadline}`];
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `${command} is refused: ${kind} attempt ${attemptId} holds this root until ${deadline}, and ${holder}; nothing was changed`, { target: { root, attemptId, deadline, holderPid: coordinator.pid }, remedy });
}

interface RestoreOnlyCopy {
  leftOut: string;
  newer: boolean;
  otherAccounts: string[];
  rolledBack: ReturnType<typeof restoreRolledBackRuns>;
  previousStore?: string;
}

/** The history evidence recorded for this attempt, including what remains only in the fallback. */
export function restoreHistory(root: string, attemptId: string): { onlyCopy?: RestoreOnlyCopy; emptyNote?: string } {
  try {
    const journal = readMaintenanceJournal(root);
    if (!journal || !("restore" in journal) || journal.restore.attemptId !== attemptId) return {};
    const leftOut = restoreLeftOut(journal);
    const onlyCopy = leftOut ? { leftOut, newer: restoreReplacedNewerCut(journal), otherAccounts: restoreOtherAccounts(journal), rolledBack: restoreRolledBackRuns(journal), ...(journal.restore.previousSource ? { previousStore: journal.restore.previousSource.identity.path } : {}) } : undefined;
    const emptyNote = "launch" in journal && journal.launch.previousCutNewer === false ? "The previous store held no additional backed-up state for the restored space." : undefined;
    return { onlyCopy, emptyNote };
  } catch { return {}; }
}

/** What a restore over a newer cut says about each run it rolled back ({@link restoreRolledBackRuns}):
 *  the steps settled after the artifact that are open again, and that the previous store holds the
 *  only copy of how they settled. Answering a reopened step again is allowed. */
export function rolledBackNotes(rolledBack: ReturnType<typeof restoreRolledBackRuns>): string[] {
  const lines = rolledBack.runs.map((row) => {
    if (row.missing) return `Run ${row.run} started after this backup, so the restore removed it; only the previous store holds it.`;
    if (!row.reopened.length) return `Run ${row.run} went back to where this backup left it; what it recorded after that is only in the previous store.`;
    const one = row.reopened.length === 1;
    const answered = row.reopened.every((key) => /^(checkpoint|ask)\b/.test(key.slice(key.lastIndexOf("/") + 1)));
    const kept = answered ? (one ? "That answer is" : "Those answers are") : (one ? "Its outcome is" : "Their outcomes are");
    return `Run ${row.run} went back to where this backup left it: ${row.reopened.join(", ")} ${one ? "was" : "were"} ${answered ? "answered" : "settled"} after that and ${one ? "is" : "are"} open again. ${kept} only in the previous store.`;
  });
  return rolledBack.more ? [...lines, `${rolledBack.more} more runs went back as well.`] : lines;
}

/** What a restore's receipt says about what it left out. A registry-only restore brings back channel
 *  settings only, and every other stream starts empty; a full restore of an artifact with no runs has
 *  a composition note that says why, and one of an artifact older than the state it replaced says
 *  that what was written after the artifact is not restored. One whose replaced store also held
 *  another account's streams says those are not restored. The store it set aside holds the only
 *  copy, which cleanup-fallback deletes only with `--discard-history`. */
export function leftOutNotes(attemptId: string, selection: string, onlyCopy: RestoreOnlyCopy | undefined, cleanupRoot?: string, cmd = "cotal"): string[] {
  if (!onlyCopy) return [];
  const accounts = onlyCopy.otherAccounts;
  const cleanup = codeSpan(`${cleanupRoot ? `cd ${shellPath(cleanupRoot)} && ` : ""}${cmd} backup cleanup-fallback ${attemptId}`);
  const kept = onlyCopy.previousStore ? `The previous store at ${onlyCopy.previousStore} holds the only copy of ${selection === "registry" && !accounts.length ? "them" : `the ${onlyCopy.leftOut}`}. ${cleanup} deletes it only with --discard-history.` : undefined;
  const other = accounts.length ? [`The store this restore replaced also held streams of ${accounts.length === 1 ? "account" : "accounts"} ${accounts.join(", ")}, which this backup does not hold, so they are not restored.`] : [];
  if (selection !== "registry") return [...(onlyCopy.newer ? ["This backup was made before the state it replaced was preserved. Later changes to channel settings, access grants, membership, history limits, message history, and workflow runs are not restored.", ...rolledBackNotes(onlyCopy.rolledBack)] : []), ...other, ...(kept ? [kept] : [])];
  return ["A registry-only restore brings back channel settings only, so chat and DM history and workflow runs start empty.", ...other, kept ?? "No previous store was retained."];
}

/** The restore attempt the root's journal holds, with the step that moves it on, so a failure can
 *  name the full attempt a recovery command needs. An unreadable journal names none. */
export function heldRestoreAttempt(root: string): { attemptId: string; journalState: string; remedy: string } | undefined {
  let journal: ReturnType<typeof readMaintenanceJournal>;
  try { journal = readMaintenanceJournal(root); } catch { return undefined; }
  if (!journal || !("restore" in journal)) return undefined;
  return { attemptId: journal.restore.attemptId, journalState: journal.state, remedy: restoreNextStep(journal.state, journal.restore.attemptId, journal) };
}

/** A root with no stopped preserved cut to restore into. Nothing was staged, moved or claimed. */
function notRestorable(root: string, journal: ReturnType<typeof readMaintenanceJournal>): CommandFailure {
  // `down --preserve-state` only cuts a running stack, so a stack a plain `cotal down` stopped is
  // started first (#7330).
  if (!journal) {
    const prepared = preparedSpaceAt(root);
    const remedy = prepared && !retainedLegacyBroker(root) && controllerStackApplies(root, prepared.space, {})
      ? "run `cotal space show` to inspect this prepared space. Its first `cotal up` uses the stack controller, which does not support preservation or restore in this release"
      : "restore needs the stopped preserved cut from `cotal down --preserve-state` on this root, and a plain `cotal down` records none: start a stopped stack with `cotal up` first, then stop it with `cotal down --preserve-state` and run the restore again";
    return new CommandFailure("refused", "LIFECYCLE_BLOCKED", "restore requires stable ready maintenance state, found none", { target: { root }, remedy });
  }
  const remedy = "restore" in journal ? restoreNextStep(journal.state, journal.restore.attemptId, journal)
    : "this root's maintenance attempt must finish first; check it with `cotal status`";
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `restore requires stable ready maintenance state, found ${journal.state}`, { target: { root, state: journal.state }, remedy });
}

type RestoreLaunch = Pick<PreparedRestore, "root" | "targetPath" | "space" | "mode" | "server" | "host" | "runtime" | "maxFileStore">;

/** Check the named artifact without taking a lock or staging it. */
export function restoreArtifactPath(root: string, dir: string, source: string): string {
  const named = resolve(dir);
  const missing = missingBackupPath(named);
  if (missing) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${missingBackupPathText(named, missing)}; nothing was restored`, { target: { root, directory: named, folder: dirname(named), missing }, remedy: "name an existing backup artifact folder; `cotal backup verify <dir>` checks one before a restore" });
  const path = realpathSync.native(named);
  const problem = artifactOverlapRefusal(root, path, source) ?? notAnArtifactRefusal(root, path, "nothing was restored", { root });
  if (problem) throw problem;
  return path;
}

/** The launch that will open the restored store, derived without creating it. */
export function restoreLaunch(root: string, flags: RestoreFlags, journal: MaintenanceReadyRecord) {
  const controller = cutController(journal.cut);
  const defaultStore = join(root, ".cotal", "nats");
  const source = preservedSourceState(root, journal.source);
  const targetPath = resolve(flags["store-dir"] ?? (controller || source.state === "missing" || linksTo(defaultStore, journal.source.path) ? journal.source.path : defaultStore));
  const resume = readMaintenanceResumeDocument(root, journal.resume);
  const agents = (resume.inventory as { agents?: Array<{ launch?: { runtime?: unknown } }> }).agents ?? [];
  const runtimes = [...new Set(agents.map((agent) => agent.launch?.runtime).filter((value): value is string => typeof value === "string"))];
  if (runtimes.length > 1) throw new Error(`resume inventory requires multiple runtimes: ${runtimes.join(", ")}`);
  const launch = resume.launch as { server?: unknown; maxFileStore?: unknown } | undefined;
  const server = canonicalServerEndpoint(controller ? journal.cut.launch.server : flags.server ?? (typeof launch?.server === "string" ? launch.server : "nats://127.0.0.1:4222"));
  const host = (!controller ? flags.host : undefined) ?? new URL(server).hostname;
  const runtime = flags.runtime ?? runtimes[0] ?? "pty";
  const maxFileStore = parsePositiveIntegerFlag("--max-file-store", flags["max-file-store"])
    ?? (controller ? undefined : journaledMaxFileStore(launch?.maxFileStore));
  return { launch: { root, targetPath, space: journal.space, mode: journal.mode, server, host, runtime, ...(maxFileStore !== undefined ? { maxFileStore } : {}) } satisfies RestoreLaunch, resume, preservedRuntime: runtimes[0], source };
}

/** Recheck the validated launch under the operation lock, before staging. `progress` receives the
 *  seat admission lines, which `backup restore` routes to stderr to keep stdout for its receipt. */
export async function prepareRestore(root: string, flags: RestoreFlags, validateLaunch?: (launch: RestoreLaunch, controller: boolean) => Promise<void>, progress?: (line: string) => void): Promise<PreparedRestore> {
  const attemptId = `restore-${randomUUID()}`;
  const serverNonce = randomUUID().replaceAll("-", "");
  const serverName = `${attemptId}-${serverNonce}`;
  const coordinator: ProcessOwner = {
    pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), id: `${attemptId}-coordinator`,
  };
  const deadline = new Date(Date.now() + RESTORE_TIMEOUT_MS);
  // With no journal there is no cut to restore into. Refuse before the lock creates the maintenance
  // directory, so a refused restore leaves the folder as it found it and `up` there sees no state.
  const recorded = readMaintenanceJournal(root);
  if (!recorded) throw notRestorable(root, undefined);
  // A path that names nothing is refused here too, saying whether its folder or the artifact is missing.
  restoreArtifactPath(root, flags.restore, recorded.source.path);
  let lock = acquireStackOperationLock(root, "restore");
  let staged: StagedArtifact | undefined;
  let transitioned = false;
  let targetBound = false;
  let targetIdentity: { dev: bigint; ino: bigint } | undefined;
  let quarantine: { path: string; identity: { dev: bigint; ino: bigint } } | undefined;
  let sanitized: { path: string; identity: { dev: bigint; ino: bigint } } | undefined;
  let broker: IsolatedBroker | undefined;
  let quarantineBroker: IsolatedBroker | undefined;
  let targetPath: string | undefined;
  const recordResources = (input: { owners?: readonly ProcessOwner[]; ownedPaths?: readonly AttemptOwnedPath[] }) => {
    const resourceLock = acquireMaintenanceLock(root);
    try {
      recordRestoreAttemptResources(resourceLock, input);
    } finally {
      releaseMaintenanceLock(resourceLock);
    }
  };
  // From here an interrupt leaves whatever this attempt journaled; the notice names it and its recovery.
  const releaseNotice = noticeOnInterrupt(() => restoreInterruptNotice(root, attemptId));
  let handedOff = false;
  try {
    let journal = readMaintenanceJournal(root);
    if (journal?.state === "restore-ready") {
      // Never touch a live attempt: recover by rollback only once the recorded claim is provably
      // stale (every owner dead, and the deadline elapsed or every broker it started gone).
      const unrecordedOwnersDead = attemptProcessesGone(root);
      const assessment = assessRestoreClaim(journal, { unrecordedOwnersDead });
      if (assessment !== "stale") throw heldClaim(root, journal.restore.attemptId, journal.claim, "this restore", assessment);
      journal = rollbackRestoreWithBroker(lock, { unrecordedOwnersDead });
    }
    if (!journal || journal.state !== "ready") throw notRestorable(root, journal);
    const { launch, resume, preservedRuntime, source } = restoreLaunch(root, flags, journal);
    const { server: effectiveServer, host: effectiveHost, runtime: effectiveRuntime, maxFileStore } = launch;
    // A preserved store gone from its recorded path either moved with this folder, which no restore
    // here may replace, or is lost, which only --accept-missing-source restores over.
    if (source.state === "moved") throw movedFolderRefusal(root, journal.space, journal.source.path, source, "run the restore");
    if (source.state === "missing" && !flags["accept-missing-source"])
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the preserved store recorded at ${journal.source.path} is missing; the restore did not start`, { target: { root, space: journal.space, recordedStore: journal.source.path }, remedy: "if this folder was moved, move it back so that path exists again; pass --accept-missing-source only after verifying disaster recovery intent" });
    // A controller cut restores only through its recorded members,
    // checked here before staging, a claim or any store move. Its broker address is the cut's.
    const controller = cutController(journal.cut);
    if (controller) {
      const cutServer = journal.cut.launch.server;
      if (flags.server !== undefined && canonicalServerEndpoint(flags.server) !== canonicalServerEndpoint(cutServer))
        throw new CommandFailure("refused", "USAGE_INVALID", "a controller restore takes its broker address from the cut; --server is refused", { target: { root, space: journal.space } });
      if (flags.host !== undefined && flags.host !== new URL(cutServer).hostname)
        throw new CommandFailure("refused", "USAGE_INVALID", "a controller restore takes its broker address from the cut; --host is refused", { target: { root, space: journal.space } });
      assertControllerRestorable(root, journal, controller, flags["store-dir"]);
    }
    await validateLaunch?.(launch, Boolean(controller));
    if (flags.space && flags.space !== journal.space)
      throw new CommandFailure("refused", "USAGE_INVALID", `--space ${JSON.stringify(flags.space)} does not match the preserved space ${JSON.stringify(journal.space)}; nothing was restored`, { remedy: "omit --space to use the preserved space" });
    const wrongMode = flags.open && journal.mode !== "open" ? "--open" : flags["user-auth"] && journal.mode !== "user" ? "--user-auth" : undefined;
    if (wrongMode)
      throw new CommandFailure("refused", "USAGE_INVALID", `${wrongMode} conflicts with the preserved auth mode; nothing was restored`, { remedy: `omit ${wrongMode} to use the preserved auth mode` });
    const auth = journal.mode === "open" ? undefined : await getSpaceAuth(workspaceSecretStore(root), journal.space);
    if (journal.mode !== "open") validateSpaceAuth(auth, journal.space);
    // Compute user-provider continuity before staging too. The later manifest comparison reuses this
    // value, so malformed trust cannot create an attempt target or move the preserved source first.
    const currentAuthority = await authorityFingerprint(root, journal.space, journal.mode);
    const artifactPath = realpathSync.native(resolve(flags.restore));
    // Again under the lock: a link in the path may name another folder now, and the journal is reread.
    const lockedOverlap = artifactOverlapRefusal(root, artifactPath, journal.source.path);
    if (lockedOverlap) throw lockedOverlap;
    // The cut records its source by real path, so a default .cotal/nats that links there is that
    // source and is restored in place, not taken for an alternate target. A missing source is rebuilt
    // where the cut records it, the only target its disaster restore takes (#7049).
    const rebuild = source.state === "missing";
    targetPath = launch.targetPath;
    if (rebuild && targetPath !== journal.source.path)
      throw new CommandFailure("refused", "USAGE_INVALID", `a restore over a missing preserved store rebuilds it at its recorded path ${journal.source.path}, and --store-dir names another; the restore did not start`, { target: { root, space: journal.space, recordedStore: journal.source.path }, remedy: "omit --store-dir, or pass the recorded path" });
    const explicitStore = flags["store-dir"] !== undefined;
    if (explicitStore) checkStorePath(targetPath, "restore", () => assertNewStorePath(launch.targetPath, journal.source.path));
    assertRestoreTargetPath(journal.source.path, artifactPath, join(root, ".cotal", "maintenance", "attempts"), targetPath, explicitStore);
    // A restore into the preserved store's own path moves that store aside whole, so a file in it that
    // no Cotal store writes would move with it; it is refused before anything moves. A store restored
    // elsewhere stays where it is, and its cleanup refuses instead.
    if (targetPath === journal.source.path) {
      const foreign = oldStoreForeignEntries(journal.source.path);
      if (foreign.length) throw foreignEntriesRefusal(journal.source.path, foreign, "the preserved store", "a restore into it moves that store aside whole, so nothing was restored", "the restore", { root, space: journal.space });
    }
    const assertRuntime = (selection: string) => {
      if (flags["restore-only"] !== "registry" && selection !== "registry" && flags.runtime && preservedRuntime && flags.runtime !== preservedRuntime)
        throw new CommandFailure("refused", "USAGE_INVALID", `--runtime ${JSON.stringify(flags.runtime)} contradicts the preserved agent runtime ${JSON.stringify(preservedRuntime)}; nothing was restored`, { remedy: "omit --runtime or restore only the registry with --restore-only registry" });
    };
    let stageParent: string;
    let artifact: StagedArtifact;
    // A faulty artifact is refused before anything moves, naming the file and fault verify names.
    try {
      if (flags["restore-only"] !== "registry" && flags.runtime && preservedRuntime && flags.runtime !== preservedRuntime)
        assertRuntime(inspectBackupArtifact(artifactPath, false).selection);
      stageParent = ensurePrivateAttemptsDir(root).path;
      // The journal is ready with no live claim, and the artifact/target are disjoint from attempts.
      sweepAttemptResidue(root);
      artifact = stageArtifact(artifactPath, stageParent);
    } catch (error) {
      const denied = artifactReadRefusal(error, artifactPath, root);
      if (denied) throw denied;
      if (!(error instanceof ArtifactFileFault)) throw error;
      throw new CommandFailure("refused", "SCHEMA_INVALID", `${error.message}; nothing was restored`, { target: { root, directory: artifactPath, file: error.file, fault: error.fault }, remedy: `this copy cannot be restored as it is: check it with ${codeSpan(`cotal backup verify ${shellPath(artifactPath)}`)}, or restore another copy of the same artifact; the preserved cut is unchanged` });
    }
    staged = artifact;
    await validateManifest(artifact.manifest, flags, journal, currentAuthority);
    const checkpoints = readStagedCheckpoints(artifact);
    // The partial selection is a property of the artifact, not only of the flag: a registry-only
    // artifact restored without --restore-only registry must still create omitted infrastructure.
    const onlyRegistry = flags["restore-only"] === "registry" || artifact.manifest.selection === "registry";
    // Journaled, so cleanup-fallback knows the previous store holds the only copy of what was left out.
    const selection = onlyRegistry ? "registry" as const : "full" as const;
    // Retained agents relaunch under their preserved runtime; a contradicting override must fail
    // in preflight, before any mutation or listener exposure.
    assertRuntime(artifact.manifest.selection);
    const wanted = onlyRegistry ? spaceBackupInventory(journal.space).registry : declaredArtifactStreams(artifact.manifest);
    if (!onlyRegistry) validateRestoreCheckpoints(artifact.manifest, wanted, checkpoints);
    const authorityBeforeMutation = await authorityFingerprint(root, journal.space, journal.mode);
    if (JSON.stringify(authorityBeforeMutation) !== JSON.stringify(currentAuthority))
      throw new Error("current trust state changed during restore validation");
    await validateManifest(artifact.manifest, flags, journal, authorityBeforeMutation);
    // The restored broker binds this address after commit intent, so another listener there would
    // leave the attempt degraded. It is refused here, before anything moves, as backup create does.
    await assertEndpointUnreachable(effectiveServer).catch((error: Error) => {
      throw new CommandFailure("refused", "CONFLICT", `${error.message}; the restored broker needs that address, so the preserved cut was not changed`, { target: { root, space: journal.space, server: effectiveServer }, remedy: `stop the process that listens on ${effectiveServer}, then run the restore again` });
    });
    const sourceExists = (() => {
      try { lstatSync(journal.source.path); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    })();
    // The store can also hold another account's streams, such as an open mesh's beside a static
    // space's. The artifact holds only this space's account, so the store this restore sets aside
    // keeps their only copy; they are read before it moves.
    const otherAccounts = sourceExists ? storeAccounts(journal.source.path).filter((account) => account !== currentAuthority.account) : [];
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
      if (!flags["accept-missing-source"])
        throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the preserved source ${journal.source.path} is missing; nothing was changed`, { target: { root, space: journal.space, source: journal.source.path }, remedy: "put the preserved store back at that path, or, once you have verified it is lost, repeat the restore with --accept-missing-source to rebuild it from this backup" });
      prepareMissingSourceRestore(lock, { attemptId, targetPath, claim, selection });
    } else if (targetPath === journal.source.path) {
      const fallbackPath = join(dirname(targetPath), `.cotal-restore-fallback-${attemptId}`);
      prepareSamePathRestore(lock, { attemptId, targetPath, fallbackPath, claim, selection });
    } else {
      prepareAlternateRestore(lock, { attemptId, targetPath, claim, selection });
    }
    transitioned = true;
    const holdsPluginHistory = spacePluginStreams(journal.space).some((stream) => artifact.manifest.streams.some((entry) => entry.stream === stream));
    const pluginState = auth && sourceExists ? await readRestorePluginState(lock, journal, auth, attemptId, deadline) : undefined;
    const pluginChannels = pluginState?.state.enabled === true;
    if (holdsPluginHistory && !pluginChannels)
      throw new CommandFailure("refused", "CONFLICT", "the backup contains plugin channel history, but the destination does not have plugin channels enabled; nothing was restored");
    if (sourceExists && targetPath === journal.source.path) moveSamePathRestoreSource(lock);
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
      await restoreAndValidate(quarantineBroker, journal.space, artifact, artifact.directory, "quarantine", onlyRegistry, [], false);
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
    await restoreAndValidate(broker, journal.space, artifact, sanitized!.path, "target", onlyRegistry, checkpoints, true, pluginChannels);
    if (journal.mode === "auth" && !onlyRegistry) {
      const restored = await restoredPluginState(broker, journal.space);
      if (restored.state.enabled !== pluginChannels || (pluginChannels && restored.state.epoch !== pluginState?.state.epoch))
        throw new Error("the restored plugin channel state does not match the preserved destination epoch");
    }
    // A newer cut can hold state the artifact lacks. Inspect the set-aside store on a private
    // clone before waiving consent, and use both brokers' journals to name rolled-back runs.
    const previousCutNewer = sourceExists && Date.parse(journal.cut.intentAt) > Date.parse(artifact.manifest.createdAt);
    const restoredRuns = previousCutNewer && wanted.includes(wfjStreamName(journal.space)) ? await readRunJournals(broker, journal.space) : undefined;
    for (const record of artifact.manifest.streams)
      if (wanted.includes(record.stream)) await applyRecordedAge(broker, journal.space, record);
    const restoredDefault = restoredRuns ? await readRegistryDefault(broker, journal.space) : undefined;
    await broker.stop();
    broker = undefined;
    const previousStore = restoredRuns ? (readMaintenanceJournal(root) as RestoreReadyRecord | undefined)?.restore.previousSource?.identity.path : undefined;
    const previous = previousStore
      ? await inspectPreviousStore({ root, previousStore, attemptId, space: journal.space, mode: journal.mode, auth, restoredDefault, recordedStreams: artifact.manifest.streams, deadline, record: recordResources })
      : undefined;
    const rolledBack = previous && restoredRuns ? rolledBackRuns(previous.runs, restoredRuns) : undefined;

    // The seats this restore is about to resume owe the same admission and the same restore as an
    // ordinary one: the retained inventory here is this root's own preserved cut, and the manager
    // operation it ends in is the same `resumePreserved`. Run them after the store is restored and
    // validated, before commit intent is journaled and long before a manager launches, so a refusal
    // costs a rollback rather than a live seat on an unrestored tree.
    //
    // A registry-only restore resumes no seat (the agents are dropped from the inventory it hands
    // the manager), so there is nothing to admit and nothing to restore.
    const staleConsent = onlyRegistry
      ? []
      : admitAndRestoreSeatCheckpoints(root, journal.space, journal.cut.attemptId, flags, resume.inventory, progress);

    lock = acquireMaintenanceLock(root);
    // A controller alternate restore rewrites the broker definition to the target before commit
    // intent, so a failure up to here still rolls the definition back first.
    if (controller && sourceExists && targetPath !== journal.source.path) reconfigureControllerBroker(lock);
    // The controller binding journals each member start before it.
    const controllerLaunch = controller ? newControllerAttemptLaunch() : undefined;
    // The restored broker starts with this cap, so the journal keeps it for a re-entry that adopts it.
    writeRestoreCommitIntent(lock, {
      attemptId,
      targetPath,
      space: journal.space,
      mode: journal.mode,
      server: effectiveServer,
      host: effectiveHost,
      runtime: effectiveRuntime,
      detached: Boolean(flags.detach),
      ...(maxFileStore !== undefined ? { maxFileStore } : {}),
      restoreSource: resolve(flags.restore),
      restoreOnly: flags["restore-only"] ?? artifact.manifest.selection,
      restoredStreams: [...wanted],
      acceptMissingSource: Boolean(flags["accept-missing-source"]),
      // On a newer cut, only a proof that no backed-up state is unique to it clears the warning.
      ...(previousCutNewer ? { previousCutNewer: previous?.noUniqueState !== true } : {}),
      ...(otherAccounts.length ? { otherAccounts } : {}),
      ...(rolledBack?.runs.length ? { rolledBackRuns: rolledBack.runs as unknown as JsonValue, ...(rolledBack.more ? { rolledBackRunsMore: rolledBack.more } : {}) } : {}),
      serverName,
      serverNonce,
      // An older attempt journal has no listenerSpawn. This one stays not-started until the spawn syncs started.
      listenerSpawn: "not-started",
      // Durable evidence of consent, as the ordinary resume journals it: an operator asking later
      // why a seat resumed from a checkpoint past its horizon reads it from the journal.
      ...(staleConsent.length
        ? { acceptedStaleCheckpoints: staleConsent.map((seat) => ({ ...seat })) as unknown as JsonValue }
        : {}),
      ...(controllerLaunch ? controllerLaunch as unknown as { [key: string]: JsonValue } : {}),
    } as { [key: string]: JsonValue });
    // The stack journal follows the maintenance journal's attempt.
    if (controller) assertControllerCoupling(root, controller, journal.cut.launch.server, journal.source.path, { stackOperationId: controllerLaunch!.controller.stackOperationId, attemptId });
    releaseMaintenanceLock(lock);
    lock = undefined as never;
    handedOff = true;
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
      ...(maxFileStore !== undefined ? { maxFileStore } : {}),
      selection: onlyRegistry ? "registry" : artifact.manifest.selection,
      restoredStreams: wanted,
      inventory: resume.inventory,
      serverName,
      serverNonce,
      reentry: false,
      journalState: "commit-intent",
      releaseInterruptNotice: releaseNotice,
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
      removeOwnedDirectory(targetPath!, targetIdentity);
      targetIdentity = undefined;
    }
    let rollbackFailure: Error | undefined;
    if (transitioned) try { rollbackRestoreWithBroker(lock, { asCoordinator: coordinator }); } catch (cause) {
      rollbackFailure = cause instanceof Error ? cause : new Error(String(cause));
    }
    if (!rollbackFailure && targetIdentity) removeOwnedDirectory(targetPath!, targetIdentity);
    staged?.cleanup();
    if (rollbackFailure)
      throw new Error(`${error instanceof Error ? error.message : String(error)}; pre-commit rollback also failed: ${rollbackFailure.message}`);
    throw error;
  } finally {
    if (!handedOff) releaseNotice();
    if (lock) releaseMaintenanceLock(lock);
  }
}

/** What an interrupted restore left, read from the journal at the moment of the signal. */
export function restoreInterruptNotice(root: string, attemptId: string): string {
  const journal = readMaintenanceJournal(root);
  const ours = journal !== undefined && "restore" in journal && journal.restore.attemptId === attemptId;
  if (ours && journal.state === "restore-ready")
    return `Interrupted: restore attempt ${attemptId} stopped before it committed, and nothing was restored.\nRoll it back with \`cotal backup recover ${attemptId} --yes\`, or run the restore again, which rolls it back first.`;
  if (ours && journal.state === "active") return `Interrupted after restore attempt ${attemptId} finished. Check it with ${codeSpan(`${displayCmd()} status`)} from ${root}.`;
  if (ours) return `Interrupted: restore attempt ${attemptId} committed before it stopped. Continue it with bare ${codeSpan(`${displayCmd()} up`)} from ${root}.`;
  return `Interrupted: restore attempt ${attemptId} stopped before it claimed this root; nothing was restored.`;
}

export function markPreparedRestoreActive(
  prepared: PreparedRestore,
  managerResult: ManagerFinalizeEvidence,
  heldLock?: MaintenanceLock,
): void {
  if (!isManagerFinalizeEvidence(managerResult, prepared.attemptId, prepared.managerCommit?.durableCommitToken ?? ""))
    throw new Error(`restore attempt ${prepared.attemptId} has invalid manager finalize evidence`);
  const lock = heldLock ?? acquireMaintenanceLock(prepared.root);
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
    // The finalized manager has read or abandoned its handoff file; settle it before activation.
    settleTokenHandoff(lock);
    if (restoreJournal.state === "manager-committed")
      markRestoreActive(lock, prepared.listenerProof, managerResult);
    else if (restoreJournal.managerCommit)
      repairRestoreDegradedToActive(lock, prepared.listenerProof, managerResult);
    else
      throw new Error(`restore activation journal does not contain durable manager commit evidence for ${prepared.attemptId}`);
    prepared.journalState = "active";
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}

export function recordPreparedRestoreManagerCommit(
  prepared: PreparedRestore,
  evidence: ManagerCommitEvidence,
  heldLock?: MaintenanceLock,
): void {
  if (!isManagerCommitResult(evidence, prepared.attemptId))
    throw new Error(`restore attempt ${prepared.attemptId} has invalid manager commit evidence`);
  if (!prepared.listenerProof)
    throw new Error(`restore attempt ${prepared.attemptId} has no bound listener proof at manager commit`);
  const lock = heldLock ?? acquireMaintenanceLock(prepared.root);
  try {
    recordRestoreManagerCommit(lock, prepared.listenerProof, evidence);
    prepared.managerCommit = evidence;
    prepared.journalState = "manager-committed";
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}

export function markPreparedRestoreDegraded(
  root: string,
  attemptId: string,
  reason: string,
  heldLock?: MaintenanceLock,
): void {
  const lock = heldLock ?? acquireMaintenanceLock(root);
  try {
    const journal = readMaintenanceJournal(root);
    if (!journal || (journal.state !== "commit-intent" && journal.state !== "active") || journal.restore.attemptId !== attemptId) return;
    markRestoreDegraded(lock, reason, [{
      action: "repair",
      description: "Preserve the restored target and retained source; recover forward before cleanup.",
      paths: [journal.restore.target.path, journal.restore.previousSource?.identity.path].filter((path): path is string => Boolean(path)),
    }]);
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}
