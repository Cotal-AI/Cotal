import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { findCotalRoot } from "./auth-paths.js";
import {
  ATTEMPT_ID,
  type AttemptBrokerInstance,
  type AttemptOwnedPath,
  type CommitIntentRecord,
  type ControllerCutBinding,
  type ControllerListenerInstance,
  type ControllerReconfiguration,
  type ControllerResumeBinding,
  type ControllerRole,
  type ControllerStartedMember,
  type JsonValue,
  type ListenerProof,
  type MaintenanceAuthMode,
  type MaintenanceClaim,
  type MaintenanceClaimedRecord,
  type MaintenanceCutCommittedRecord,
  type MaintenanceCutCompletionEvidence,
  type MaintenanceCutContext,
  type MaintenanceCutIntentRecord,
  type MaintenanceJournal,
  type MaintenanceLock,
  type MaintenanceReadyRecord,
  type MaintenanceRecourse,
  type MaintenanceResumeDescriptor,
  type ManagerCommitEvidence,
  type ManagerFinalizeEvidence,
  type OrdinaryResumeActivationEvidence,
  type OrdinaryResumeActiveRecord,
  type OrdinaryResumeCommittedRecord,
  type OrdinaryResumeContext,
  type OrdinaryResumeDegradedRecord,
  type OrdinaryResumeIntentRecord,
  type OrdinaryResumeRecord,
  type OrdinaryResumeRetiredRecord,
  type PreservedStopAttempt,
  type ProcessOwner,
  type ReplaceDeadRestoreListenerOptions,
  type RestoreActiveRecord,
  type RestoreDegradedRecord,
  type RestoreListenerReplacement,
  type RestoreManagerCommittedRecord,
  type RestoreReadyRecord,
  type TokenHandoff,
  assertLock,
  assertStoreIdentity,
  atomicWrite,
  ensureLayout,
  ensureStoreIdentity,
  errno,
  fsyncDirectory,
  isMaintenanceError,
  localProcessOwnerStatus,
  maintenanceError,
  maintenancePaths,
  parseOwner,
  sameStoreIdentity,
  carriedTokenHandoff,
  removeOwnedPathsOrFail,
  requireSettledTokenHandoff,
} from "./maintenance-foundation.js";
export {
  MAINTENANCE_JOURNAL_VERSION,
  MAINTENANCE_RESUME_DOCUMENT_VERSION,
  MAX_MAINTENANCE_RESUME_BYTES,
  type MaintenanceAuthMode,
  type OwnerStatus,
  type StoreIdentity,
  type ProcessOwner,
  type MaintenanceRecourse,
  type MaintenanceErrorCode,
  type MaintenanceErrorDetails,
  MaintenanceError,
  isMaintenanceError,
  type MaintenanceCutContext,
  type ControllerRole,
  type PinnedProcess,
  type ControllerCutBinding,
  type ControllerMember,
  type ControllerStop,
  type PreservedStopAttempt,
  type PreservedStop,
  type ControllerStartedMember,
  type ControllerResumeBinding,
  type AttemptBrokerInstance,
  type TokenHandoff,
  type ControllerReconfiguration,
  type MaintenanceCutCompletionEvidence,
  type MaintenanceCutIntentRecord,
  type MaintenanceCutCommittedRecord,
  type MaintenanceReadyRecord,
  type AttemptOwnedPath,
  type MaintenanceClaim,
  type RestoreClaim,
  type RestoreClaimAssessment,
  type MaintenanceClaimedRecord,
  type RestorePhase,
  type PreviousSource,
  type CleanupProgress,
  type RestoreSelection,
  type RestoreContext,
  type RestoreReadyRecord,
  type JsonValue,
  type MaintenanceResumeDocument,
  type MaintenanceResumeDescriptor,
  type ListenerProof,
  type ControllerListenerInstance,
  type RestoreListenerReplacement,
  type ReplaceDeadRestoreListenerOptions,
  type ManagerCommitEvidence,
  type ManagerFinalizeEvidence,
  type RestoreActivationEvidence,
  type CommitIntentRecord,
  type RestoreManagerCommittedRecord,
  type RestoreActiveRecord,
  type RestoreDegradedRecord,
  type OrdinaryResumeContext,
  type OrdinaryResumeActivationEvidence,
  type OrdinaryResumeIntentRecord,
  type OrdinaryResumeActiveRecord,
  type OrdinaryResumeCommittedRecord,
  type OrdinaryResumeDegradedRecord,
  type OrdinaryResumeRetiredRecord,
  type OrdinaryResumeRecord,
  type MaintenanceJournal,
  type MaintenancePaths,
  type MaintenanceLock,
  type AcquireMaintenanceLockOptions,
  maintenancePaths,
  readStoreIdentity,
  ensureStoreIdentity,
  sameStoreIdentity,
  assertStoreIdentity,
  localProcessOwnerStatus,
  readMaintenanceLockHolder,
  maintenanceLockHolder,
  acquireMaintenanceLock,
  assertMaintenanceLock,
  releaseMaintenanceLock,
  withMaintenanceLock,
} from "./maintenance-foundation.js";
import {
  assertListenerOwnerAlive,
  canonicalListenerEndpoint,
  currentJournal,
  cutBrokerRetired,
  cutController,
  exactObjectKeys,
  normalizedListenerProof,
  ordinaryResumeController,
  readMaintenanceJournal,
  readMaintenanceResumeDocument,
  readyFrom,
  requireCustodyProof,
  reusesListenerIdentity,
  sameJsonValue,
  sameListenerProof,
  sameManagerCommitEvidence,
  sameManagerFinalizeEvidence,
  sameResumeDescriptor,
  validAttemptBroker,
  validCutCompletionEvidence,
  validManagerCommitEvidence,
  validManagerFinalizeEvidence,
  validOrdinaryResumeActivationEvidence,
  validOwnedPaths,
  validRecourse,
  writeJournal,
  requireReady,
} from "./maintenance-journal.js";
export {
  cutController,
  ordinaryResumeController,
  writeMaintenanceResumeDocument,
  readMaintenanceResumeDocument,
  readMaintenanceJournal,
} from "./maintenance-journal.js";
import {
  type ClaimAssessmentOptions,
  jsonObject,
  requireRestoreReady,
} from "./maintenance-restore.js";
export {
  type RestoreClaimInput,
  type ClaimAssessmentOptions,
  assessMaintenanceClaim,
  assessRestoreClaim,
  recordRestoreAttemptResources,
  prepareSamePathRestore,
  interpretPendingStoreMove,
  moveSamePathRestoreSource,
  prepareAlternateRestore,
  prepareMissingSourceRestore,
  bindRestoreTarget,
  writeRestoreCommitIntent,
  bindRestoreListener,
  replaceDeadRestoreListener,
  rearmUnboundRestoreCommitIntent,
  recordRestoreManagerCommit,
  markRestoreActive,
  markRestoreDegraded,
  repairRestoreDegradedToActive,
  type RollbackRestoreOptions,
  assertRestoreClaimRollbackable,
  rollbackRestore,
  restoreReplacedNewerCut,
  restoreOtherAccounts,
  restoreLeftOut,
  type RolledBackRun,
  restoreRolledBackRuns,
  restoreLeftOutReason,
  cleanupRestoreFallback,
} from "./maintenance-restore.js";

/** Attempt binding persisted BEFORE the manager is fenced, so a crash between manager preparation
 *  and the cut-intent journal write can retry with the exact attempt the manager already holds. */
export interface PreservationPrepareIntent {
  readonly attemptId: string;
  readonly space: string;
  readonly mode: MaintenanceAuthMode;
  readonly server: string;
  readonly storeDir: string;
  /** Controller custody only, together with `capability`: the exact manager incarnation proved to
   *  serve the preserved-exit stop before the first preservation effect. */
  readonly custody?: "controller";
  readonly capability?: PreservedExitCapability;
}

/** The pre-effect proof binding. It is rechecked after prepare, at the cut and before the stop. */
export interface PreservedExitCapability {
  readonly instanceId: string;
  readonly epoch: number;
  readonly owner: string;
  readonly uid: string;
  readonly clusterDigest: string;
  readonly statusOutputDigest: string;
}

function validCapability(value: unknown): value is PreservedExitCapability {
  const capability = value as PreservedExitCapability;
  const text = (field: unknown): boolean => typeof field === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(field);
  return Boolean(capability && typeof capability === "object" &&
    exactObjectKeys(capability, ["instanceId", "epoch", "owner", "uid", "clusterDigest", "statusOutputDigest"]) &&
    text(capability.instanceId) && Number.isSafeInteger(capability.epoch) && capability.epoch >= 0 &&
    text(capability.owner) && text(capability.uid) &&
    typeof capability.clusterDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(capability.clusterDigest) &&
    typeof capability.statusOutputDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(capability.statusOutputDigest));
}

function validPrepareIntent(value: unknown): value is PreservationPrepareIntent {
  const intent = value as PreservationPrepareIntent;
  const controller = Boolean(intent && typeof intent === "object" && (intent.custody !== undefined || intent.capability !== undefined));
  return Boolean(intent && typeof intent === "object" &&
    exactObjectKeys(intent, controller
      ? ["attemptId", "space", "mode", "server", "storeDir", "custody", "capability"]
      : ["attemptId", "space", "mode", "server", "storeDir"]) &&
    (!controller || intent.custody === "controller" && validCapability(intent.capability)) &&
    typeof intent.attemptId === "string" && ATTEMPT_ID.test(intent.attemptId) &&
    typeof intent.space === "string" && intent.space &&
    ["auth", "open", "user"].includes(intent.mode) &&
    typeof intent.server === "string" && intent.server &&
    typeof intent.storeDir === "string" && isAbsolute(intent.storeDir));
}

export function writePreservationPrepareIntent(lock: MaintenanceLock, intent: PreservationPrepareIntent): void {
  assertLock(lock);
  if (!validPrepareIntent(intent))
    maintenanceError("invalid-transition", "preservation prepare intent is invalid", { root: lock.root });
  const paths = maintenancePaths(lock.root);
  ensureLayout(paths);
  if (readMaintenanceJournal(lock.root))
    maintenanceError("invalid-transition", "a maintenance journal already binds this attempt; prepare intent is stale", {
      root: lock.root, paths: [paths.journal],
    });
  atomicWrite(paths.prepareIntent, intent);
}

export function readPreservationPrepareIntent(root: string): PreservationPrepareIntent | undefined {
  const paths = maintenancePaths(root);
  let raw: string;
  try {
    const stat = lstatSync(paths.prepareIntent);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
      maintenanceError("journal-corrupt", "preservation prepare intent is not a bounded regular file", { paths: [paths.prepareIntent] });
    raw = readFileSync(paths.prepareIntent, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    if (isMaintenanceError(error)) throw error;
    maintenanceError("journal-corrupt", "preservation prepare intent cannot be read", { paths: [paths.prepareIntent] });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    maintenanceError("journal-corrupt", "preservation prepare intent cannot be parsed", { paths: [paths.prepareIntent] });
  }
  if (!validPrepareIntent(parsed))
    maintenanceError("journal-corrupt", "preservation prepare intent is invalid", { paths: [paths.prepareIntent] });
  return parsed;
}

export function clearPreservationPrepareIntent(lock: MaintenanceLock): void {
  assertLock(lock);
  const paths = maintenancePaths(lock.root);
  try {
    unlinkSync(paths.prepareIntent);
    fsyncDirectory(paths.versionDir);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

/** Written AFTER the cut-intent journal but BEFORE the manager is asked to stop its children, so a
 *  coordinator crash in that window leaves proof the stop RPC may already have executed. Without it,
 *  recovery sees a bare cut-intent and wrongly assumes nothing was stopped — then deletes the cut and
 *  loses the retained inventory. Cleared once cut-committed is durably journaled. */
export interface PreservationCommitIntent {
  readonly attemptId: string;
}

function validCommitIntent(value: unknown): value is PreservationCommitIntent {
  const intent = value as PreservationCommitIntent;
  return Boolean(intent && typeof intent === "object" &&
    exactObjectKeys(intent, ["attemptId"]) &&
    typeof intent.attemptId === "string" && ATTEMPT_ID.test(intent.attemptId));
}

export function writePreservationCommitIntent(lock: MaintenanceLock, intent: PreservationCommitIntent): void {
  assertLock(lock);
  if (!validCommitIntent(intent))
    maintenanceError("invalid-transition", "preservation commit intent is invalid", { root: lock.root });
  const paths = maintenancePaths(lock.root);
  ensureLayout(paths);
  const journal = readMaintenanceJournal(lock.root);
  if (!journal || journal.state !== "cut-intent" || journal.cut.attemptId !== intent.attemptId)
    maintenanceError("invalid-transition", "commit intent requires a cut-intent journal for the same attempt", {
      root: lock.root, paths: [paths.journal],
    });
  atomicWrite(paths.commitIntent, intent);
}

export function readPreservationCommitIntent(root: string): PreservationCommitIntent | undefined {
  const paths = maintenancePaths(root);
  let raw: string;
  try {
    const stat = lstatSync(paths.commitIntent);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
      maintenanceError("journal-corrupt", "preservation commit intent is not a bounded regular file", { paths: [paths.commitIntent] });
    raw = readFileSync(paths.commitIntent, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    if (isMaintenanceError(error)) throw error;
    maintenanceError("journal-corrupt", "preservation commit intent cannot be read", { paths: [paths.commitIntent] });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    maintenanceError("journal-corrupt", "preservation commit intent cannot be parsed", { paths: [paths.commitIntent] });
  }
  if (!validCommitIntent(parsed))
    maintenanceError("journal-corrupt", "preservation commit intent is invalid", { paths: [paths.commitIntent] });
  return parsed;
}

export function clearPreservationCommitIntent(lock: MaintenanceLock): void {
  assertLock(lock);
  const paths = maintenancePaths(lock.root);
  try {
    unlinkSync(paths.commitIntent);
    fsyncDirectory(paths.versionDir);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

/** Persist source identity and launch provenance before manager commitment or any process stop. */
export function beginMaintenanceCut(
  lock: MaintenanceLock,
  input: {
    readonly attemptId: string;
    readonly space: string;
    readonly mode: MaintenanceAuthMode;
    readonly sourcePath: string;
    readonly resume: MaintenanceResumeDescriptor;
    readonly launch: { readonly server: string; readonly [key: string]: JsonValue };
  },
): MaintenanceCutIntentRecord {
  assertLock(lock);
  if (!ATTEMPT_ID.test(input.attemptId))
    maintenanceError("invalid-transition", "maintenance cut attempt id must be a safe token", {
      root: lock.root, attemptId: input.attemptId,
    });
  const previous = readMaintenanceJournal(lock.root);
  readMaintenanceResumeDocument(lock.root, input.resume);
  const source = ensureStoreIdentity(input.sourcePath);
  const launch = jsonObject(input.launch) as MaintenanceCutContext["launch"];
  if (typeof launch.server !== "string" || canonicalListenerEndpoint(launch.server) !== launch.server)
    maintenanceError("invalid-transition", "maintenance cut launch requires a canonical normal listener endpoint", {
      root: lock.root, attemptId: input.attemptId,
    });
  if (previous) {
    if (previous.state !== "cut-intent")
      maintenanceError("invalid-transition", `cannot begin a maintenance cut from ${previous.state}`, { root: lock.root });
    if (previous.cut.attemptId !== input.attemptId || previous.space !== input.space || previous.mode !== input.mode ||
        !sameStoreIdentity(previous.source, source) || !sameResumeDescriptor(previous.resume, input.resume) ||
        !sameJsonValue(previous.cut.launch, launch))
      maintenanceError("identity-mismatch", "maintenance cut retry does not exactly match the durable intent", {
        root: lock.root, attemptId: input.attemptId, expected: previous.source, actual: source,
      });
    return previous;
  }
  const cut: MaintenanceCutContext = {
    attemptId: input.attemptId, intentAt: new Date().toISOString(), launch,
  };
  return writeJournal(lock, undefined, {
    state: "cut-intent", space: input.space, mode: input.mode, source, resume: input.resume, cut,
  }) as MaintenanceCutIntentRecord;
}

/** Abandon an uncommitted cut: before `cut-committed`, no suppression is durable and no process was
 *  stopped by the cut, so the intent may be safely abandoned instead of wedging on lost manager
 *  memory. The content-addressed resume document is left in place for inspection. */
export function abortMaintenanceCut(lock: MaintenanceLock): MaintenanceCutIntentRecord {
  const record = currentJournal(lock);
  if (record.state !== "cut-intent")
    maintenanceError("invalid-transition", `only an uncommitted cut intent can be aborted, not ${record.state}`, {
      root: lock.root, paths: [record.source.path],
    });
  const paths = maintenancePaths(lock.root);
  unlinkSync(paths.journal);
  fsyncDirectory(paths.versionDir);
  return record;
}

/** Fsync the manager's preservation commitment BEFORE any process stop, so a crash between manager
 *  commit and the ready promotion recovers idempotently without requiring a live manager. */
export function recordPreservationManagerCommit(
  lock: MaintenanceLock,
  managerCommit: MaintenanceCutCompletionEvidence["managerCommit"],
): MaintenanceCutCommittedRecord {
  const record = currentJournal(lock);
  const valid = managerCommit && typeof managerCommit === "object" &&
    exactObjectKeys(managerCommit, ["operation", "attemptId", "state"]) &&
    managerCommit.operation === "commitPreservation" && managerCommit.attemptId === record.cut.attemptId &&
    managerCommit.state === "preserved";
  if (record.state === "cut-committed") {
    if (!valid)
      maintenanceError("activation-evidence-invalid", "preservation commit retry does not match the durable cut", {
        root: lock.root, attemptId: record.cut.attemptId, paths: [record.source.path],
      });
    assertStoreIdentity(record.source);
    return record;
  }
  if (record.state !== "cut-intent")
    maintenanceError("invalid-transition", `cannot record preservation commitment from ${record.state}`, {
      root: lock.root, paths: [record.source.path],
    });
  if (!valid)
    maintenanceError("activation-evidence-invalid", "preservation commitment evidence is invalid or belongs to another attempt", {
      root: lock.root, attemptId: record.cut.attemptId, paths: [record.source.path],
    });
  assertStoreIdentity(record.source);
  return writeJournal(lock, record, {
    state: "cut-committed", space: record.space, mode: record.mode, source: record.source,
    resume: record.resume, cut: record.cut,
    managerCommittedAt: new Date().toISOString(), managerCommit,
  }) as MaintenanceCutCommittedRecord;
}

function controllerCutCommitted(lock: MaintenanceLock): { record: MaintenanceCutCommittedRecord; controller: ControllerCutBinding } {
  const record = currentJournal(lock);
  const controller = cutController(record.cut);
  if (record.state !== "cut-committed" || !controller)
    maintenanceError("invalid-transition", "a preserved-exit stop attempt needs a controller cut-committed journal", { root: lock.root });
  assertStoreIdentity(record.source);
  return { record: record as MaintenanceCutCommittedRecord, controller: controller! };
}

/** Journal one preserved-exit stop attempt BEFORE its request can be published. The caller has
 *  already proved the handoff empty under this lock. An attempt is never
 *  rewritten or removed; at most 16 are kept. */
export function appendPreservedStopAttempt(lock: MaintenanceLock, attempt: Omit<PreservedStopAttempt, "published" | "recordedAt">): MaintenanceCutCommittedRecord {
  const { record, controller } = controllerCutCommitted(lock);
  const manager = controller.members.find((member) => member.role === "manager")!;
  const previous = record.preservedStop?.attempts ?? [];
  if (previous.some((row) => row.requestId === attempt.requestId))
    maintenanceError("invalid-transition", "this preserved-exit stop attempt is already journaled", { root: lock.root, attemptId: record.cut.attemptId });
  const row: PreservedStopAttempt = {
    requestId: attempt.requestId, target: { pid: attempt.target.pid, token: attempt.target.token },
    stopper: { pid: attempt.stopper.pid, token: attempt.stopper.token }, withAgents: false,
    scopeSha256: attempt.scopeSha256,
    preserved: { attemptId: attempt.preserved.attemptId, inventorySha256: attempt.preserved.inventorySha256 },
    recordedAt: new Date().toISOString(),
  };
  return writeJournal(lock, record, {
    state: "cut-committed", space: record.space, mode: record.mode, source: record.source,
    resume: record.resume, cut: record.cut, managerCommittedAt: record.managerCommittedAt, managerCommit: record.managerCommit,
    preservedStop: { instanceId: manager.instanceId, launchRequestId: manager.launchRequestId, attempts: [...previous, row] },
  }) as MaintenanceCutCommittedRecord;
}

/** Mark the attempt published only after its request file was written. */
export function markPreservedStopPublished(lock: MaintenanceLock, requestId: string): MaintenanceCutCommittedRecord {
  const { record } = controllerCutCommitted(lock);
  const stop = record.preservedStop;
  const index = stop?.attempts.findIndex((row) => row.requestId === requestId) ?? -1;
  if (!stop || index < 0)
    maintenanceError("invalid-transition", "the published preserved-exit stop attempt is not journaled", { root: lock.root, attemptId: record.cut.attemptId });
  if (stop!.attempts[index]!.published) return record;
  return writeJournal(lock, record, {
    state: "cut-committed", space: record.space, mode: record.mode, source: record.source,
    resume: record.resume, cut: record.cut, managerCommittedAt: record.managerCommittedAt, managerCommit: record.managerCommit,
    preservedStop: { ...stop!, attempts: stop!.attempts.map((row, at) => at === index ? { ...row, published: true as const } : row) },
  }) as MaintenanceCutCommittedRecord;
}

/** Promote only the exact durable cut after all stopped/unreachable evidence has been supplied. */
export function completeMaintenanceCut(
  lock: MaintenanceLock,
  evidence: MaintenanceCutCompletionEvidence,
): MaintenanceReadyRecord {
  const record = currentJournal(lock);
  if (record.state === "ready") {
    if (!validCutCompletionEvidence(evidence, record.cut))
      maintenanceError("activation-evidence-invalid", "maintenance cut completion retry does not match ready", {
        root: lock.root, attemptId: record.cut.attemptId, paths: [record.source.path],
      });
    assertStoreIdentity(record.source);
    return record;
  }
  if (record.state !== "cut-committed")
    maintenanceError("invalid-transition", `cannot complete a maintenance cut from ${record.state}`, {
      root: lock.root, paths: [record.source.path],
    });
  if (!validCutCompletionEvidence(evidence, record.cut) ||
      evidence.managerCommit.attemptId !== record.managerCommit.attemptId)
    maintenanceError("activation-evidence-invalid", "maintenance cut requires exact stopped and unreachable evidence", {
      root: lock.root, attemptId: record.cut.attemptId, paths: [record.source.path],
    });
  assertStoreIdentity(record.source);
  return writeJournal(lock, record, {
    state: "ready", space: record.space, mode: record.mode, source: record.source, resume: record.resume,
    cut: record.cut, cutCompletion: evidence,
  }) as MaintenanceReadyRecord;
}

export function claimMaintenanceReady(lock: MaintenanceLock, claim: MaintenanceClaim): MaintenanceClaimedRecord {
  const ready = requireReady(lock);
  if (!ATTEMPT_ID.test(claim.attemptId) || !Number.isFinite(Date.parse(claim.deadline)))
    maintenanceError("invalid-transition", "claim attempt and deadline are required", { root: lock.root });
  parseOwner(claim.coordinator, "claim coordinator");
  for (const claimOwner of claim.owners) parseOwner(claimOwner, "claim owner");
  if (claim.ownedPaths !== undefined && !validOwnedPaths(claim.ownedPaths))
    maintenanceError("invalid-transition", "claim owned paths are invalid", { root: lock.root, attemptId: claim.attemptId });
  return writeJournal(lock, ready, { ...readyFrom(ready), state: "claimed", claim }) as MaintenanceClaimedRecord;
}

/** Merge broker/watchdog owners and attempt-owned slots into the live claim. A slot journaled
 *  before its path exists ("pending") is upgraded in place once the exact inode is known. */
export function recordMaintenanceClaimResources(
  lock: MaintenanceLock,
  input: { readonly owners?: readonly ProcessOwner[]; readonly ownedPaths?: readonly AttemptOwnedPath[] },
): MaintenanceClaimedRecord {
  const record = currentJournal(lock);
  if (record.state !== "claimed")
    maintenanceError("invalid-transition", "maintenance journal has no live claim to extend", { root: lock.root });
  const owners = [...record.claim.owners, ...(input.owners ?? [])];
  const merged = [...(record.claim.ownedPaths ?? [])];
  for (const owned of input.ownedPaths ?? []) {
    const existing = merged.findIndex((entry) => entry.path === owned.path && entry.label === owned.label);
    if (existing >= 0) merged.splice(existing, 1, owned);
    else merged.push(owned);
  }
  const claim: MaintenanceClaim = { ...record.claim, owners, ...(merged.length ? { ownedPaths: merged } : {}) };
  if (!validRestoreClaimOwnersBound(owners) || !validOwnedPaths(merged))
    maintenanceError("invalid-transition", "claim resources are invalid", { root: lock.root, attemptId: record.claim.attemptId });
  for (const claimOwner of owners) parseOwner(claimOwner, "claim owner");
  return writeJournal(lock, record, { ...readyFrom(record), state: "claimed", claim }) as MaintenanceClaimedRecord;
}

function validRestoreClaimOwnersBound(owners: readonly ProcessOwner[]): boolean {
  return owners.length <= 16;
}

export function releaseMaintenanceClaim(lock: MaintenanceLock, attemptId: string): MaintenanceReadyRecord {
  const record = currentJournal(lock);
  if (record.state !== "claimed" || record.claim.attemptId !== attemptId)
    maintenanceError("invalid-transition", "maintenance claim does not match this attempt", { root: lock.root, attemptId });
  assertStoreIdentity(record.source);
  return writeJournal(lock, record, readyFrom(record)) as MaintenanceReadyRecord;
}

/** Recover a stale backup claim: remove exactly the paths it owns and return the cut to ready. The
 *  claim must be stale as {@link assessMaintenanceClaim} judges it, so before its deadline the
 *  caller's `unrecordedOwnersDead` proof is required. */
export function recoverStaleMaintenanceClaim(
  lock: MaintenanceLock,
  options: ClaimAssessmentOptions = {},
): MaintenanceReadyRecord {
  const record = currentJournal(lock);
  if (record.state !== "claimed")
    maintenanceError("invalid-transition", "maintenance journal has no claim to recover", { root: lock.root });
  const now = options.now ?? new Date();
  const status = options.ownerStatus ?? localProcessOwnerStatus;
  const proven = options.unrecordedOwnersDead === true && [record.claim.coordinator, ...record.claim.owners].every((owner) => status(owner) === "dead");
  if (now.getTime() <= Date.parse(record.claim.deadline) && !proven)
    maintenanceError("claim-not-expired", "maintenance claim deadline has not elapsed", {
      root: lock.root, attemptId: record.claim.attemptId,
      recourse: [{ action: "retry", description: `Retry after ${record.claim.deadline}.` }],
    });
  const owners = [record.claim.coordinator, ...record.claim.owners];
  const statuses = owners.map(status);
  if (statuses.includes("alive"))
    maintenanceError("claim-live", "a maintenance claim owner is still alive", {
      root: lock.root, attemptId: record.claim.attemptId,
      recourse: [{ action: "retry", description: "Wait for coordinator, watchdog, and broker exit." }],
    });
  if (statuses.includes("unknown"))
    maintenanceError("claim-owner-ambiguous", "not every maintenance claim owner is proven dead", {
      root: lock.root, attemptId: record.claim.attemptId,
      recourse: [{ action: "inspect", description: "Prove coordinator, watchdog, and broker death before recovery." }],
    });
  assertStoreIdentity(record.source);
  removeOwnedPathsOrFail(lock, record.claim.attemptId, record.claim.ownedPaths);
  return writeJournal(lock, record, readyFrom(record)) as MaintenanceReadyRecord;
}

/**
 * Fsync normal-listener launch provenance before exposure. A crash after this transition is
 * intentionally ambiguous: callers must inspect/recover forward or record `resume-degraded`.
 */
export function beginOrdinaryResume(
  lock: MaintenanceLock,
  input: { readonly attemptId: string; readonly launch: { readonly [key: string]: JsonValue } },
): OrdinaryResumeIntentRecord {
  const ready = requireReady(lock);
  if (!ATTEMPT_ID.test(input.attemptId))
    maintenanceError("invalid-transition", "ordinary resume attempt id must be a safe token", {
      root: lock.root, attemptId: input.attemptId,
    });
  const ordinaryResume: OrdinaryResumeContext = {
    attemptId: input.attemptId,
    intentAt: new Date().toISOString(),
    launch: jsonObject(input.launch),
  };
  return writeJournal(lock, ready, {
    ...readyFrom(ready), state: "resume-intent", ordinaryResume,
  }) as OrdinaryResumeIntentRecord;
}

function ordinaryListenerState(record: OrdinaryResumeRecord): {
  listenerProof?: ListenerProof;
  listenerReplacements?: readonly RestoreListenerReplacement[];
  tokenHandoff?: TokenHandoff;
} {
  return {
    ...(record.listenerProof ? { listenerProof: record.listenerProof } : {}),
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
  };
}

type ControllerAttemptRecord = OrdinaryResumeIntentRecord | OrdinaryResumeCommittedRecord | CommitIntentRecord | RestoreManagerCommittedRecord;

/** The start rows of a controller resume or a controller restore, or undefined for any other record. */
export function controllerAttemptBinding(record: MaintenanceJournal): ControllerResumeBinding | undefined {
  if (!cutController(record.cut)) return undefined;
  if ("ordinaryResume" in record) return ordinaryResumeController(record.ordinaryResume);
  if ("restore" in record && "launch" in record && record.launch.custody === "controller")
    return record.launch.controller as unknown as ControllerResumeBinding;
  return undefined;
}

/** The stack facts a controller restore admission compares, read from the CLI's stack journal. */
export interface ControllerStackView {
  readonly space: string;
  readonly server: string;
  readonly storeDir?: string;
  readonly operation: { readonly id: string; readonly phase: string };
}

/** Mirroring legacy bare down, a validated `active` controller restore of
 *  this space no longer fences the controller stack it restored. That stack's journal must name the
 *  restore's address and restored store, and must have settled the restore's own operation. Every
 *  other state and journal kind still fences. This only reads: the journal is never consumed,
 *  rewritten or deleted. */
export function admittedControllerRestore(root: string, stack: ControllerStackView): RestoreActiveRecord | undefined {
  const record = readMaintenanceJournal(root);
  const binding = record ? controllerAttemptBinding(record) : undefined;
  if (!record || record.state !== "active" || !binding || record.space !== stack.space || record.launch.server !== stack.server ||
      record.restore.target.path !== stack.storeDir || stack.operation.id === binding.stackOperationId && stack.operation.phase !== "completed")
    return undefined;
  return record;
}

/** Whether stack work that carries no maintenance attempt may go ahead at this root: the root holds
 *  no maintenance journal, or its journal is a settled active controller restore of the stack these
 *  facts describe, at this space and address. The broker and manager adapters and a service restart
 *  all decide through it. This only reads. */
export function maintenanceAdmitsStackWork(root: string, space: string, server: string, stack: ControllerStackView | undefined): boolean {
  if (!readMaintenanceJournal(root)) return true;
  return Boolean(stack && stack.space === space && stack.server === server && admittedControllerRestore(root, stack));
}

/** The record a controller start may change. Before manager commitment any member may start. After
 *  it, only the manager may be relaunched. The
 *  custody and attempt are read from the journal, never from a caller. */
function controllerAttemptRecord(lock: MaintenanceLock, role: ControllerRole): { record: ControllerAttemptRecord; binding: ControllerResumeBinding; committed: boolean } {
  const record = currentJournal(lock);
  const binding = controllerAttemptBinding(record);
  const committed = record.state === "resume-committed" || record.state === "manager-committed";
  if (!binding || !committed && record.state !== "resume-intent" && record.state !== "commit-intent")
    return maintenanceError("invalid-transition", `controller member starts are recorded only in a controller resume or restore before activation, not from ${record.state}`, { root: lock.root });
  if (committed && role !== "manager")
    maintenanceError("invalid-transition", "after manager commitment only the manager may be relaunched", { root: lock.root });
  return { record: record as ControllerAttemptRecord, binding, committed };
}

type HandoffRecord = OrdinaryResumeCommittedRecord | OrdinaryResumeDegradedRecord | RestoreManagerCommittedRecord | RestoreDegradedRecord;

/** A commit token exists only after manager commitment, so a handoff belongs to a committed resume
 *  or restore, in any custody (every new launcher passes it as a file). */
function handoffRecord(lock: MaintenanceLock): { record: HandoffRecord; attemptId: string } {
  const record = currentJournal(lock);
  if ((record.state === "resume-committed" || record.state === "resume-degraded") && record.managerCommit)
    return { record, attemptId: record.ordinaryResume.attemptId };
  if ((record.state === "manager-committed" || record.state === "degraded") && record.managerCommit)
    return { record, attemptId: record.restore.attemptId };
  return maintenanceError("invalid-transition", `a commit-token handoff needs a manager-committed resume or restore, not ${record.state}`, { root: lock.root });
}

/** Rewrite only the handoff record; every other field is carried unchanged and revalidated. */
function rewriteHandoff(lock: MaintenanceLock, record: MaintenanceJournal, tokenHandoff: TokenHandoff): MaintenanceJournal {
  return writeJournal(lock, record, { ...record, tokenHandoff } as unknown as Omit<MaintenanceJournal, "version" | "revision" | "updatedAt">);
}

/** Rewrite only the attempt binding; every other field is carried unchanged and revalidated. */
function rewriteControllerAttempt(lock: MaintenanceLock, record: ControllerAttemptRecord, binding: ControllerResumeBinding, started: readonly ControllerStartedMember[]): ControllerAttemptRecord {
  const controller = { stackOperationId: binding.stackOperationId, started: started.map((row) => ({ ...row })), ...(binding.broker ? { broker: { ...binding.broker } } : {}) };
  const next = "ordinaryResume" in record
    ? { ...record, ordinaryResume: { ...record.ordinaryResume, launch: { ...record.ordinaryResume.launch, controller } } }
    : { ...record, launch: { ...record.launch, controller } };
  return writeJournal(lock, record, next as unknown as Omit<MaintenanceJournal, "version" | "revision" | "updatedAt">) as ControllerAttemptRecord;
}

/** Journal one member start as `requested` BEFORE `startProcessService` is called. A later run
 *  reads this row with the instance record to decide retry, adopt or hold.
 *  After manager commitment the row may name only the manager, its newest row must have run, and
 *  the caller must prove that exact recorded process gone. */
export function requestControllerMemberStart(
  lock: MaintenanceLock,
  row: { readonly role: ControllerRole; readonly instanceId: string; readonly priorLaunchRequestId: string },
  options: { readonly priorManagerGone?: (prior: ControllerStartedMember) => boolean } = {},
): ControllerAttemptRecord {
  const { record, binding, committed } = controllerAttemptRecord(lock, row.role);
  if (committed) {
    const prior = [...binding.started].reverse().find((entry) => entry.role === "manager");
    if (!prior || prior.outcome !== "running" || !options.priorManagerGone?.(prior))
      maintenanceError("invalid-transition", "a committed attempt relaunches its manager only after its last recorded start ran and that exact process is proven gone", { root: lock.root });
  }
  return rewriteControllerAttempt(lock, record, binding, [...binding.started, { role: row.role, instanceId: row.instanceId, priorLaunchRequestId: row.priorLaunchRequestId, state: "requested" }]);
}

/** Settle the newest `requested` row for this role with the launch request and its outcome. */
export function settleControllerMemberStart(lock: MaintenanceLock, role: ControllerRole, launchRequestId: string, outcome: NonNullable<ControllerStartedMember["outcome"]>): ControllerAttemptRecord {
  const { record, binding } = controllerAttemptRecord(lock, role);
  let index = -1;
  binding.started.forEach((row, at) => { if (row.role === role) index = at; });
  if (index < 0 || binding.started[index]!.outcome !== undefined)
    maintenanceError("invalid-transition", "no unsettled member start row matches this role", { root: lock.root });
  return rewriteControllerAttempt(lock, record, binding, binding.started.map((row, at) => at === index ? { ...row, launchRequestId, outcome } : row));
}

/** The new broker instance this attempt must start, when the cut's broker record is retired for it:
 *  an alternate restore whose broker definition was rewritten (`reconfiguredBroker`), or any attempt
 *  after a rollback rebound the broker revision (the binding's `broker`). */
export function controllerAttemptBroker(record: MaintenanceJournal): { readonly required: boolean; readonly instance?: AttemptBrokerInstance } {
  const cut = cutController(record.cut);
  if (!cut) return { required: false };
  if ("restore" in record && record.restore.controllerReconfiguration?.phase === "definition-committed")
    return { required: true, ...(record.restore.reconfiguredBroker ? { instance: record.restore.reconfiguredBroker } : {}) };
  if (!cutBrokerRetired(cut)) return { required: false };
  const broker = controllerAttemptBinding(record)?.broker;
  return { required: true, ...(broker ? { instance: broker } : {}) };
}

/** Journal the attempt's new broker instance before its start. Only an
 *  uncommitted controller resume, or a restore at commit intent, records one, and only once. */
export function recordControllerAttemptBroker(lock: MaintenanceLock, instance: AttemptBrokerInstance): MaintenanceJournal {
  const record = currentJournal(lock);
  const cut = cutController(record.cut);
  const needed = controllerAttemptBroker(record);
  if (!cut || !needed.required || record.state !== "resume-intent" && record.state !== "commit-intent")
    return maintenanceError("invalid-transition", "only a controller attempt whose cut broker is retired records a new broker instance, before manager commitment", { root: lock.root });
  if (needed.instance) {
    if (needed.instance.instanceId !== instance.instanceId || needed.instance.launchRequestId !== instance.launchRequestId)
      maintenanceError("invalid-transition", "this attempt already records another broker instance; it was not replaced", { root: lock.root });
    return record;
  }
  if (!validAttemptBroker(instance, cut)) maintenanceError("invalid-transition", "the new broker instance IDs are invalid", { root: lock.root });
  if (record.state === "commit-intent" && record.restore.controllerReconfiguration?.phase === "definition-committed")
    return writeJournal(lock, record, { ...record, restore: { ...record.restore, reconfiguredBroker: { instanceId: instance.instanceId, launchRequestId: instance.launchRequestId } } } as unknown as Omit<MaintenanceJournal, "version" | "revision" | "updatedAt">);
  const binding = controllerAttemptBinding(record)!;
  return rewriteControllerAttempt(lock, record as ControllerAttemptRecord, { ...binding, broker: { instanceId: instance.instanceId, launchRequestId: instance.launchRequestId } }, binding.started);
}

const RECONFIGURATION_FIXED = ["fromRevision", "fromOptionsSha256", "fromConfigPath", "fromConfigSha256", "toConfigPath", "toConfigSha256"] as const;

/** Journal one step of an alternate restore's broker definition rewrite, each before the definition
 *  write it names: `rendered` with its attempt-owned
 *  config file, then `definition-committed`, `rolling-back`, and `rolled-back`, which rebinds the
 *  cut's broker revision in the same write. Pre-commit controller alternate restores only. */
export function recordRestoreReconfiguration(lock: MaintenanceLock, next: ControllerReconfiguration, owned?: AttemptOwnedPath): RestoreReadyRecord {
  const record = requireRestoreReady(lock);
  const cut = cutController(record.cut);
  const prior = record.restore.controllerReconfiguration;
  const allowed = prior === undefined
    ? next.phase === "rendered" && owned?.label === "config" && owned.path === next.toConfigPath && owned.dev !== undefined
    : prior.phase === "rendered" ? next.phase === "definition-committed"
      : prior.phase === "definition-committed" ? next.phase === "rolling-back" && next.toRevision === prior.toRevision
        : prior.phase === "rolling-back" && next.phase === "rolled-back" && next.toRevision === prior.toRevision;
  const same = prior === undefined || RECONFIGURATION_FIXED.every((key) => prior[key] === next[key]) && sameStoreIdentity(prior.toStoreIdentity, next.toStoreIdentity);
  if (!cut || record.restore.method !== "alternate" || !allowed || !same || (prior === undefined) !== (owned !== undefined))
    maintenanceError("invalid-transition", `a controller broker reconfiguration cannot move from ${prior?.phase ?? "none"} to ${next.phase}`, { root: lock.root, attemptId: record.restore.attemptId });
  const ownedPaths = owned ? [...(record.restore.ownedPaths ?? []).filter((entry) => entry.path !== owned.path), owned] : record.restore.ownedPaths;
  const restore = { ...record.restore, ...(ownedPaths ? { ownedPaths } : {}), controllerReconfiguration: next };
  const rebound = next.phase === "rolled-back"
    ? { ...record.cut, launch: { ...record.cut.launch, controller: { ...cut!, brokerDefinitionRevision: next.rollbackRevision! } as unknown as JsonValue } }
    : record.cut;
  return writeJournal(lock, record, { ...readyFrom(record), cut: rebound, state: "restore-ready", phase: record.phase, restore, claim: record.claim }) as RestoreReadyRecord;
}

const HANDOFF_ENTRY = /^resume-commit\./u;

/** Create or check the 0700 handoff directory. An existing directory is never chmodded or adopted:
 *  it must be ours, not a link, and closed to group and other. */
function handoffDirectory(root: string): string {
  const paths = maintenancePaths(root);
  ensureLayout(paths);
  try { mkdirSync(paths.handoff, { mode: 0o700 }); fsyncDirectory(paths.versionDir); }
  catch (error) { if (errno(error) !== "EEXIST") throw error; }
  const stat = lstatSync(paths.handoff);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    maintenanceError("ambiguous-filesystem-state", "the commit-token handoff directory is not an owned private directory; it was not adopted", { root, paths: [paths.handoff] });
  return paths.handoff;
}

/** Settle an earlier handoff of this attempt before a new one, and hold on
 *  any entry the journal does not record: an inode with no recorded identity is never deleted. */
export function sweepTokenHandoff(lock: MaintenanceLock): MaintenanceJournal {
  const { record } = handoffRecord(lock);
  const directory = handoffDirectory(lock.root);
  const recorded = record.tokenHandoff;
  const unknown = readdirSync(directory).filter((name) => HANDOFF_ENTRY.test(name) && join(directory, name) !== recorded?.path);
  if (unknown.length)
    maintenanceError("ambiguous-filesystem-state", "the handoff directory holds a commit-token file this attempt did not record; it was not removed", { root: lock.root, paths: unknown.map((name) => join(directory, name)) });
  if (!recorded || recorded.state === "consumed" || recorded.state === "swept") return record;
  const stat = lstatSync(recorded.path, { throwIfNoEntry: false });
  if (!stat) return rewriteHandoff(lock, record, { ...recorded, state: "swept" });
  if (recorded.state === "intended" || !stat.isFile() || stat.isSymbolicLink() || String(stat.dev) !== recorded.dev || String(stat.ino) !== recorded.ino || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1)
    maintenanceError("ambiguous-filesystem-state", "a recorded commit-token handoff path holds an unrecorded or changed file; it was not removed", { root: lock.root, paths: [recorded.path] });
  unlinkSync(recorded.path);
  fsyncDirectory(directory);
  return rewriteHandoff(lock, record, { ...recorded, state: "swept" });
}

/** Steps 2 and 3: journal the path, write the journal's own token create-only at 0600, then journal
 *  its exact inode and digest, all before the child starts. The token is read from the durable
 *  manager commit evidence, never from a caller. Returns only the path and digest for argv. */
export function writeTokenHandoff(lock: MaintenanceLock): { path: string; sha256: string } {
  const { record, attemptId } = handoffRecord(lock);
  const token = record.managerCommit!.durableCommitToken;
  if (record.tokenHandoff && record.tokenHandoff.state !== "consumed" && record.tokenHandoff.state !== "swept")
    maintenanceError("invalid-transition", "an earlier commit-token handoff is not settled; sweep it first", { root: lock.root, attemptId });
  const directory = handoffDirectory(lock.root);
  const path = join(directory, `resume-commit.${attemptId}.${randomUUID()}`);
  const intended = rewriteHandoff(lock, record, { path, state: "intended" });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, token); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncDirectory(directory);
  const stat = lstatSync(path);
  const sha256 = createHash("sha256").update(token).digest("hex");
  rewriteHandoff(lock, intended, { path, state: "written", dev: String(stat.dev), ino: String(stat.ino), sha256 });
  return { path, sha256 };
}

/** Step 6, after manager readiness: an absent file was consumed by the child; the same inode is
 *  removed here; any other file at the path holds. */
export function settleTokenHandoff(lock: MaintenanceLock): void {
  const record = currentJournal(lock) as MaintenanceJournal & { tokenHandoff?: TokenHandoff };
  const recorded = record.tokenHandoff;
  if (!recorded || recorded.state === "consumed" || recorded.state === "swept") return;
  if (recorded.state !== "written")
    maintenanceError("ambiguous-filesystem-state", "the commit-token handoff never recorded its written file; it was not settled", { root: lock.root, paths: [recorded.path] });
  const stat = lstatSync(recorded.path, { throwIfNoEntry: false });
  let next: TokenHandoff;
  if (!stat) next = { ...recorded, state: "consumed" };
  else if (stat.isFile() && !stat.isSymbolicLink() && String(stat.dev) === recorded.dev && String(stat.ino) === recorded.ino) {
    unlinkSync(recorded.path);
    fsyncDirectory(dirname(recorded.path));
    next = { ...recorded, state: "swept" };
  } else return maintenanceError("ambiguous-filesystem-state", "the commit-token handoff path holds another file; it was not removed", { root: lock.root, paths: [recorded.path] });
  rewriteHandoff(lock, record, next);
}

/** Fsync the exact ordinary-resume listener identity after spawn and before activation. The
 *  proof's target is the preserved SOURCE store. */
export function bindOrdinaryResumeListener(
  lock: MaintenanceLock,
  proof: ListenerProof,
  options: { readonly controllerInstanceRunning?: (instance: ControllerListenerInstance) => boolean } = {},
): OrdinaryResumeIntentRecord | OrdinaryResumeDegradedRecord {
  const record = currentJournal(lock);
  if (record.state !== "resume-intent" &&
      (record.state !== "resume-degraded" || record.managerCommit !== undefined))
    maintenanceError("invalid-transition", "resume listener can be bound only before manager commitment", {
      root: lock.root,
    });
  const normalized = normalizedListenerProof(proof);
  const resumeController = ordinaryResumeController(record.ordinaryResume);
  requireCustodyProof(normalized, record.cut, resumeController ? { resume: resumeController } : undefined,
    options.controllerInstanceRunning, lock.root, record.ordinaryResume.attemptId);
  if (normalized.attemptId !== record.ordinaryResume.attemptId ||
      !sameStoreIdentity(normalized.target, record.source))
    maintenanceError("listener-proof-mismatch", "resume listener proof does not match the attempt and preserved source", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId,
      paths: [record.source.path], expected: record.source, actual: normalized.target,
    });
  const launchServer = record.ordinaryResume.launch.server;
  if (typeof launchServer !== "string" || canonicalListenerEndpoint(launchServer) !== normalized.serverEndpoint)
    maintenanceError("listener-proof-mismatch", "resume listener endpoint does not match durable launch provenance", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
    });
  assertStoreIdentity(record.source);
  if (record.listenerReplacements?.some((replacement) => reusesListenerIdentity(replacement.proof, normalized)))
    maintenanceError("listener-proof-mismatch", "resume listener proof reuses a retired listener identity", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
    });
  assertListenerOwnerAlive(normalized);
  if (record.listenerProof) {
    if (!sameListenerProof(record.listenerProof, normalized))
      maintenanceError("listener-proof-mismatch", "ordinary resume is already bound to another listener", {
        root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
      });
    return record as OrdinaryResumeIntentRecord | OrdinaryResumeDegradedRecord;
  }
  if (record.state === "resume-intent")
    return writeJournal(lock, record, {
      ...readyFrom(record), state: "resume-intent", ordinaryResume: record.ordinaryResume,
      listenerProof: normalized,
      ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
      ...carriedTokenHandoff(record),
    }) as OrdinaryResumeIntentRecord;
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "resume-degraded", ordinaryResume: record.ordinaryResume,
    ...(record.activeAt !== undefined ? { activeAt: record.activeAt, activation: record.activation } : {}),
    degradedAt: record.degradedAt, reason: record.reason, recourse: record.recourse,
    listenerProof: normalized,
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
  }) as OrdinaryResumeDegradedRecord;
}

/** Retire one exactly bound, provably dead resume listener before a fresh proof may be bound. A
 *  manager-committed resume never replaces its listener: the durable token is bound to it. */
export function replaceDeadOrdinaryResumeListener(
  lock: MaintenanceLock,
  proof: ListenerProof,
  options: ReplaceDeadRestoreListenerOptions = {},
): OrdinaryResumeIntentRecord | OrdinaryResumeActiveRecord | OrdinaryResumeDegradedRecord {
  const record = currentJournal(lock);
  if ((record.state !== "resume-intent" && record.state !== "resume-active" && record.state !== "resume-degraded") ||
      (record.state === "resume-degraded" && record.managerCommit !== undefined))
    maintenanceError("invalid-transition", "dead resume listener replacement requires an uncommitted resume attempt", {
      root: lock.root,
    });
  if (!record.listenerProof)
    maintenanceError("listener-proof-missing", "resume listener replacement requires an existing bound proof", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
    });
  const normalized = normalizedListenerProof(proof);
  if (!sameListenerProof(record.listenerProof, normalized))
    maintenanceError("listener-proof-mismatch", "resume listener replacement does not exactly match the bound proof", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
    });
  assertStoreIdentity(record.source);
  const status = (options.ownerStatus ?? localProcessOwnerStatus)(record.listenerProof.processOwner);
  if (status === "alive")
    maintenanceError("listener-owner-alive", "bound resume listener is still alive", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId,
      recourse: [{ action: "retry", description: "Stop the exact bound listener and prove process exit before replacement." }],
    });
  if (status !== "dead")
    maintenanceError("listener-owner-ambiguous", "bound resume listener death cannot be proven", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId,
      recourse: [{ action: "inspect", description: "Prove the exact recorded listener process dead before replacement." }],
    });
  const history = record.listenerReplacements ?? [];
  const replacement: RestoreListenerReplacement = {
    generation: history.length + 1,
    replacedAt: new Date().toISOString(),
    proof: record.listenerProof,
  };
  const base = {
    ...readyFrom(record), ordinaryResume: record.ordinaryResume,
    listenerReplacements: [...history, replacement],
    ...carriedTokenHandoff(record),
  };
  if (record.state === "resume-intent")
    return writeJournal(lock, record, { ...base, state: "resume-intent" }) as OrdinaryResumeIntentRecord;
  if (record.state === "resume-active")
    return writeJournal(lock, record, {
      ...base, state: "resume-active", activeAt: record.activeAt, activation: record.activation,
    }) as OrdinaryResumeActiveRecord;
  return writeJournal(lock, record, {
    ...base, state: "resume-degraded",
    ...(record.activeAt !== undefined ? { activeAt: record.activeAt, activation: record.activation } : {}),
    degradedAt: record.degradedAt, reason: record.reason, recourse: record.recourse,
  }) as OrdinaryResumeDegradedRecord;
}

/** Record that the normal listener is ready and retained principals were activated successfully. */
export function markOrdinaryResumeActive(
  lock: MaintenanceLock,
  activation: OrdinaryResumeActivationEvidence,
): OrdinaryResumeActiveRecord {
  const record = currentJournal(lock);
  if (record.state !== "resume-intent" && record.state !== "resume-degraded")
    maintenanceError("invalid-transition", "ordinary resume activation requires intent or repaired degraded state", {
      root: lock.root,
      paths: [record.source.path],
    });
  assertStoreIdentity(record.source);
  if (!validOrdinaryResumeActivationEvidence(activation, record.ordinaryResume.attemptId))
    maintenanceError("activation-evidence-invalid", "ordinary resume activation evidence is invalid or belongs to another attempt", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
    });
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "resume-active", ordinaryResume: record.ordinaryResume,
    ...ordinaryListenerState(record),
    activeAt: new Date().toISOString(), activation,
  }) as OrdinaryResumeActiveRecord;
}

/** Preserve an ambiguous or failed post-intent result without rolling back or deleting any bytes. */
export function markOrdinaryResumeDegraded(
  lock: MaintenanceLock,
  reason: string,
  recourse: readonly MaintenanceRecourse[],
): OrdinaryResumeDegradedRecord {
  const record = currentJournal(lock);
  if (record.state !== "resume-intent" && record.state !== "resume-active")
    maintenanceError("invalid-transition", "degraded ordinary resume requires intent or active state", {
      root: lock.root,
      paths: [record.source.path],
    });
  if (!reason || !validRecourse(recourse))
    maintenanceError("invalid-transition", "degraded ordinary resume requires a reason and structured recourse", {
      root: lock.root,
    });
  assertStoreIdentity(record.source);
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "resume-degraded", ordinaryResume: record.ordinaryResume,
    ...ordinaryListenerState(record),
    ...(record.state === "resume-active"
      ? { activeAt: record.activeAt, activation: record.activation }
      : {}),
    degradedAt: new Date().toISOString(), reason, recourse: [...recourse],
  }) as OrdinaryResumeDegradedRecord;
}

/** Fsync the manager's suppression-retaining commit token before requesting finalization. */
export function recordOrdinaryResumeManagerCommit(
  lock: MaintenanceLock,
  evidence: ManagerCommitEvidence,
): OrdinaryResumeCommittedRecord {
  const record = currentJournal(lock);
  if (record.state === "resume-committed") {
    if (!validManagerCommitEvidence(evidence, record.ordinaryResume.attemptId) ||
        !sameManagerCommitEvidence(record.managerCommit, evidence))
      maintenanceError("activation-evidence-invalid", "ordinary resume commit retry does not match the durable manager token", {
        root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
      });
    assertStoreIdentity(record.source);
    return record;
  }
  if (record.state !== "resume-active")
    maintenanceError("invalid-transition", "ordinary resume manager commit requires resume-active state", {
      root: lock.root,
      paths: [record.source.path],
    });
  assertStoreIdentity(record.source);
  if (!validManagerCommitEvidence(evidence, record.ordinaryResume.attemptId))
    maintenanceError("activation-evidence-invalid", "ordinary resume commit evidence is invalid or belongs to another attempt", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
    });
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "resume-committed", ordinaryResume: record.ordinaryResume,
    ...ordinaryListenerState(record),
    activeAt: record.activeAt, activation: record.activation,
    managerCommittedAt: new Date().toISOString(), managerCommit: evidence,
  }) as OrdinaryResumeCommittedRecord;
}

/** Durably authorize journal consumption only after exact token-bound manager finalization. */
export function retireOrdinaryResume(
  lock: MaintenanceLock,
  retirement: ManagerFinalizeEvidence,
): OrdinaryResumeRetiredRecord {
  const record = currentJournal(lock);
  if (record.state === "resume-retired") {
    if (!validManagerFinalizeEvidence(
          retirement,
          record.ordinaryResume.attemptId,
          record.managerCommit.durableCommitToken,
        ) || !sameManagerFinalizeEvidence(record.retirement, retirement))
      maintenanceError("activation-evidence-invalid", "ordinary resume finalize retry does not match the durable manager token", {
        root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
      });
    assertStoreIdentity(record.source);
    return record;
  }
  if (record.state !== "resume-committed")
    maintenanceError("invalid-transition", "ordinary resume retirement requires resume-committed state", {
      root: lock.root,
      paths: [record.source.path],
    });
  assertStoreIdentity(record.source);
  requireSettledTokenHandoff(record, lock.root);
  if (!validManagerFinalizeEvidence(
        retirement,
        record.ordinaryResume.attemptId,
        record.managerCommit.durableCommitToken,
      ))
    maintenanceError("activation-evidence-invalid", "ordinary resume retirement requires exact manager finalize evidence", {
      root: lock.root, attemptId: record.ordinaryResume.attemptId, paths: [record.source.path],
    });
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "resume-retired", ordinaryResume: record.ordinaryResume,
    ...ordinaryListenerState(record),
    activeAt: record.activeAt, activation: record.activation,
    managerCommittedAt: record.managerCommittedAt, managerCommit: record.managerCommit,
    retiredAt: new Date().toISOString(), retirement,
  }) as OrdinaryResumeRetiredRecord;
}

/**
 * Consume only a durable retired marker. The source store and content-addressed resume document are
 * deliberately left untouched; a crash leaves either `resume-retired` or an absent journal.
 */
export function consumeRetiredMaintenance(lock: MaintenanceLock): OrdinaryResumeRetiredRecord {
  const record = currentJournal(lock);
  if (record.state !== "resume-retired")
    maintenanceError("invalid-transition", "maintenance journal can be consumed only from resume-retired", {
      root: lock.root,
      paths: [record.source.path],
    });
  assertStoreIdentity(record.source);
  readMaintenanceResumeDocument(lock.root, record.resume);
  const paths = maintenancePaths(lock.root);
  unlinkSync(paths.journal);
  fsyncDirectory(paths.versionDir);
  return record;
}

/** A follow-up hint for failures whose signature is stale on-disk broker state: streams/durable
 *  consumers minted by an older, incompatible Cotal generation survive every down/up cycle, and
 *  JetStream rejects a same-name re-create with a different config. Rendered dim under the red
 *  line by the error surfaces - the error itself stays the broker's own sentence. A root whose
 *  maintenance journal holds a restore or a preserved cut gets no clean recipe: its store is that
 *  data, and the hint never names a command that would delete it. */
export function staleStoreHint(msg: string, root?: string): string | undefined {
  if (!/consumer already exists|stream already exists/i.test(msg)) return undefined;
  let held: string | undefined;
  try { held = readMaintenanceJournal(root ?? findCotalRoot())?.state; } catch { held = "unreadable"; }
  if (held) return `this root's maintenance journal holds a restore or a preserved cut (state ${held}), so its store holds that data and must not be cleaned; check it with \`cotal status\` before any recovery`;
  // The recipe must not promise a configuration-preserving restart: a bare `cotal up` would turn
  // a named/open/user-auth mesh into the default authenticated one, and a custom --store-dir is
  // not recorded - so both variable parts are called out instead of implied.
  return "likely stale on-disk mesh state from an older Cotal version - reset: `cotal down`, `cotal clean store --force` (repeat any custom --store-dir), then `cotal up` with your usual flags";
}
