/** The restore lifecycle: restore contexts and claims, the restore listener and its custody, and the
 *  settling, activation and retirement of a restored root, driven by the maintenance operations in
 *  `maintenance.ts`. `maintenance.ts` re-exports every public name here, so importers keep their path. */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { wfjStreamName } from "@cotal-ai/core";
import { foreignStoreEntries, STORE_ENTRY_NAMES, storeAccounts } from "./store-entries.js";
import {
  ATTEMPT_ID,
  type AttemptOwnedPath,
  type CleanupProgress,
  type CommitIntentRecord,
  type ControllerListenerInstance,
  type JsonValue,
  type ListenerProof,
  type MaintenanceAuthMode,
  type MaintenanceLock,
  type MaintenanceReadyRecord,
  type MaintenanceRecourse,
  type ManagerCommitEvidence,
  type ManagerFinalizeEvidence,
  type OwnerStatus,
  type PreviousSource,
  type ProcessOwner,
  type ReplaceDeadRestoreListenerOptions,
  type RestoreActivationEvidence,
  type RestoreActiveRecord,
  type RestoreClaim,
  type RestoreClaimAssessment,
  type RestoreContext,
  type RestoreDegradedRecord,
  type RestoreListenerReplacement,
  type RestoreManagerCommittedRecord,
  type RestoreReadyRecord,
  type RestoreSelection,
  STORE_ID_FILE,
  type StoreIdentity,
  assertLock,
  assertPathsDoNotOverlap,
  assertStoreIdentity,
  canonicalAbsentPath,
  canonicalCandidatePath,
  defaultOwner,
  ensureStoreIdentity,
  errno,
  fsyncDirectory,
  identityAt,
  localProcessOwnerStatus,
  maintenanceError,
  maintenancePaths,
  pathContains,
  pathExistsStrict,
  readStoreIdentity,
  sameStoreIdentity,
  carriedTokenHandoff,
  removeOwnedPathsOrFail,
  requireSettledTokenHandoff,
} from "./maintenance-foundation.js";
import {
  assertListenerOwnerAlive,
  canonicalListenerEndpoint,
  currentJournal,
  normalizedListenerProof,
  readMaintenanceResumeDocument,
  readyFrom,
  requireCustodyProof,
  restoreProofScope,
  reusesListenerIdentity,
  sameListenerProof,
  sameManagerCommitEvidence,
  sameManagerFinalizeEvidence,
  sameProcessOwner,
  validJsonObject,
  validManagerCommitEvidence,
  validManagerFinalizeEvidence,
  validOwnedPaths,
  validRecourse,
  validRestoreActivationEvidence,
  validRestoreClaim,
  writeJournal,
  requireReady,
} from "./maintenance-journal.js";

function restoreBase(ready: MaintenanceReadyRecord, attemptId: string, method: RestoreContext["method"], targetPath: string, selection: RestoreSelection | undefined): RestoreContext {
  if (!ATTEMPT_ID.test(attemptId))
    maintenanceError("invalid-transition", "restore attempt id must be a safe token", { root: ready.source.path, attemptId });
  return { attemptId, method, targetPath, ...(selection ? { selection } : {}) };
}

export interface RestoreClaimInput {
  readonly deadline: string;
  readonly coordinator?: ProcessOwner;
  readonly ownedPaths?: readonly AttemptOwnedPath[];
}

function newRestoreClaim(input: RestoreClaimInput): { claim: RestoreClaim; ownedPaths?: readonly AttemptOwnedPath[] } {
  if (!Number.isFinite(Date.parse(input.deadline)))
    maintenanceError("invalid-transition", "restore claim requires an absolute deadline");
  const claim: RestoreClaim = { deadline: input.deadline, coordinator: input.coordinator ?? defaultOwner(), owners: [] };
  if (!validRestoreClaim(claim))
    maintenanceError("invalid-transition", "restore claim coordinator is invalid");
  if (input.ownedPaths !== undefined && !validOwnedPaths(input.ownedPaths))
    maintenanceError("invalid-transition", "restore claim owned paths are invalid");
  return { claim, ...(input.ownedPaths ? { ownedPaths: input.ownedPaths } : {}) };
}

/** Options for judging a claim: the clock, the owner probe, and the caller's proof that no process
 *  the attempt started outside its recorded owners is alive. */
export interface ClaimAssessmentOptions {
  readonly now?: Date;
  readonly ownerStatus?: (owner: ProcessOwner) => OwnerStatus;
  readonly unrecordedOwnersDead?: boolean;
}

/** Assess a maintenance claim (a restore's or a backup's). `live` while the deadline has not elapsed
 *  or any recorded owner is alive; `stale` once the deadline elapsed AND every owner is proven dead.
 *  Before the deadline it is `stale` only when the caller also proves that no process the attempt
 *  started outside the recorded owners is alive (`unrecordedOwnersDead`), and every recorded owner,
 *  coordinator included, is proven dead. */
export function assessMaintenanceClaim(
  claim: { readonly deadline: string; readonly coordinator: ProcessOwner; readonly owners: readonly ProcessOwner[] },
  options: ClaimAssessmentOptions = {},
): RestoreClaimAssessment {
  const now = options.now ?? new Date();
  const status = options.ownerStatus ?? localProcessOwnerStatus;
  if (now.getTime() <= Date.parse(claim.deadline))
    return options.unrecordedOwnersDead === true && [claim.coordinator, ...claim.owners].every((owner) => status(owner) === "dead") ? "stale" : "live";
  const statuses = [claim.coordinator, ...claim.owners].map(status);
  if (statuses.includes("alive")) return "live";
  if (statuses.includes("unknown")) return "ambiguous";
  return "stale";
}

/** Assess the recorded pre-commit restore claim; see {@link assessMaintenanceClaim}. */
export function assessRestoreClaim(record: RestoreReadyRecord, options: ClaimAssessmentOptions = {}): RestoreClaimAssessment {
  return assessMaintenanceClaim(record.claim, options);
}

export function requireRestoreReady(lock: MaintenanceLock): RestoreReadyRecord {
  const record = currentJournal(lock);
  if (record.state !== "restore-ready")
    maintenanceError("invalid-transition", "maintenance journal has no pre-commit restore attempt", { root: lock.root });
  return record;
}

/** Append broker/watchdog owners and attempt-owned working trees to the live restore attempt so
 *  recovery can refuse while they live and delete exactly these inodes once they are proven dead. */
export function recordRestoreAttemptResources(
  lock: MaintenanceLock,
  input: { readonly owners?: readonly ProcessOwner[]; readonly ownedPaths?: readonly AttemptOwnedPath[] },
): RestoreReadyRecord {
  const record = requireRestoreReady(lock);
  const owners = [...record.claim.owners, ...(input.owners ?? [])];
  const claim: RestoreClaim = { ...record.claim, owners };
  const ownedPaths = [...(record.restore.ownedPaths ?? [])];
  for (const owned of input.ownedPaths ?? []) {
    const existing = ownedPaths.findIndex((entry) => entry.path === owned.path && entry.label === owned.label);
    if (existing >= 0) ownedPaths.splice(existing, 1, owned);
    else ownedPaths.push(owned);
  }
  if (!validRestoreClaim(claim))
    maintenanceError("invalid-transition", "restore claim owners are invalid", { attemptId: record.restore.attemptId });
  if (!validOwnedPaths(ownedPaths))
    maintenanceError("invalid-transition", "restore attempt-owned paths are invalid", { attemptId: record.restore.attemptId });
  const restore = { ...record.restore, ...(ownedPaths.length ? { ownedPaths } : {}) };
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "restore-ready", phase: record.phase, restore, claim,
  }) as RestoreReadyRecord;
}

export function prepareSamePathRestore(
  lock: MaintenanceLock,
  input: { readonly attemptId: string; readonly targetPath: string; readonly fallbackPath: string; readonly claim: RestoreClaimInput; readonly selection?: RestoreSelection },
): RestoreReadyRecord {
  const ready = requireReady(lock);
  const targetPath = resolve(input.targetPath);
  if (targetPath !== ready.source.path)
    maintenanceError("invalid-path", "same-path restore target must be the recorded source path", {
      paths: [targetPath, ready.source.path],
    });
  const fallbackPath = canonicalAbsentPath(input.fallbackPath);
  if (dirname(fallbackPath) !== dirname(ready.source.path))
    maintenanceError("invalid-path", "same-path fallback must be a sibling of the source", {
      paths: [ready.source.path, fallbackPath],
    });
  const parentDev = statSync(dirname(fallbackPath), { bigint: true }).dev.toString();
  if (parentDev !== ready.source.dev)
    maintenanceError("invalid-path", "same-path fallback must be on the source filesystem", {
      paths: [ready.source.path, fallbackPath],
    });
  const { claim, ownedPaths } = newRestoreClaim(input.claim);
  const restore = {
    ...restoreBase(ready, input.attemptId, "same-path", targetPath, input.selection), fallbackPath,
    ...(ownedPaths ? { ownedPaths } : {}),
  };
  return writeJournal(lock, ready, { ...readyFrom(ready), state: "restore-ready", phase: "move-pending", restore, claim }) as RestoreReadyRecord;
}

export function interpretPendingStoreMove(record: RestoreReadyRecord): "not-moved" | "moved" {
  if (record.phase !== "move-pending" || record.restore.method !== "same-path" || !record.restore.fallbackPath)
    maintenanceError("invalid-transition", "record is not a pending same-path move", { attemptId: record.restore.attemptId });
  const source = identityAt(record.source.path);
  const fallback = identityAt(record.restore.fallbackPath);
  const sourceMatches = source ? sameStoreIdentity(record.source, source) : false;
  const expectedFallback = { ...record.source, path: record.restore.fallbackPath };
  const fallbackMatches = fallback ? sameStoreIdentity(expectedFallback, fallback) : false;
  if (sourceMatches && !fallback) return "not-moved";
  if (!source && fallbackMatches) return "moved";
  maintenanceError("ambiguous-filesystem-state", "same-path move cannot be interpreted safely", {
    attemptId: record.restore.attemptId,
    paths: [record.source.path, record.restore.fallbackPath],
    expected: record.source,
    actual: source ?? fallback,
    recourse: [{ action: "inspect", description: "Preserve both paths; do not rename or delete either store.", paths: [record.source.path, record.restore.fallbackPath] }],
  });
}

/**
 * Move the stopped source after interpreting either crash side. This is a cooperative filesystem
 * transition: the caller must first prove every broker and other non-Cotal store user has exited.
 * The maintenance lock excludes Cotal peers; it is not a shared-store lock for raw processes.
 */
export function moveSamePathRestoreSource(lock: MaintenanceLock): RestoreReadyRecord {
  const record = currentJournal(lock);
  if (record.state !== "restore-ready" || record.phase !== "move-pending" ||
      record.restore.method !== "same-path" || !record.restore.fallbackPath)
    maintenanceError("invalid-transition", "maintenance journal is not awaiting a source move", { root: lock.root });
  if (interpretPendingStoreMove(record) === "not-moved")
    renameSync(record.source.path, record.restore.fallbackPath);
  // Also fsync on crash recovery: the rename may have happened before its original parent fsync.
  fsyncDirectory(dirname(record.source.path));
  const fallback = readStoreIdentity(record.restore.fallbackPath);
  const expected = { ...record.source, path: record.restore.fallbackPath };
  if (!sameStoreIdentity(expected, fallback) || existsSync(record.source.path))
    maintenanceError("ambiguous-filesystem-state", "source rename did not produce the recorded filesystem state", {
      attemptId: record.restore.attemptId,
      paths: [record.source.path, record.restore.fallbackPath], expected, actual: fallback,
    });
  const restore = { ...record.restore, previousSource: { kind: "fallback", identity: fallback } as PreviousSource };
  return writeJournal(lock, record, { ...readyFrom(record), state: "restore-ready", phase: "source-moved", restore, claim: record.claim }) as RestoreReadyRecord;
}

export function prepareAlternateRestore(
  lock: MaintenanceLock,
  input: { readonly attemptId: string; readonly targetPath: string; readonly claim: RestoreClaimInput; readonly selection?: RestoreSelection },
): RestoreReadyRecord {
  const ready = requireReady(lock);
  const targetPath = canonicalCandidatePath(input.targetPath);
  assertPathsDoNotOverlap(
    ready.source.path,
    targetPath,
    "alternate restore target must not equal, contain, or be nested under the retained source",
  );
  if (pathExistsStrict(targetPath))
    maintenanceError("path-exists", "store path must be absent", {
      paths: [targetPath],
      recourse: [{ action: "inspect", description: "Inspect the unexpected path before retrying.", paths: [targetPath] }],
    });
  const { claim, ownedPaths } = newRestoreClaim(input.claim);
  const restore = {
    ...restoreBase(ready, input.attemptId, "alternate", targetPath, input.selection),
    previousSource: { kind: "retained", identity: ready.source } as PreviousSource,
    ...(ownedPaths ? { ownedPaths } : {}),
  };
  return writeJournal(lock, ready, { ...readyFrom(ready), state: "restore-ready", phase: "source-retained", restore, claim }) as RestoreReadyRecord;
}

export function prepareMissingSourceRestore(
  lock: MaintenanceLock,
  input: { readonly attemptId: string; readonly targetPath: string; readonly claim: RestoreClaimInput; readonly selection?: RestoreSelection },
): RestoreReadyRecord {
  assertLock(lock);
  const record = currentJournal(lock);
  if (record.state !== "ready")
    maintenanceError("invalid-transition", "missing-source consent requires a ready journal", { root: lock.root });
  const existing = identityAt(record.source.path);
  if (existing)
    maintenanceError("identity-mismatch", "missing-source consent cannot accept an existing or replacement inode", {
      expected: record.source, actual: existing, paths: [record.source.path],
    });
  const targetPath = canonicalAbsentPath(input.targetPath);
  if (targetPath !== record.source.path)
    maintenanceError("invalid-path", "disaster restore target must be the missing canonical source path", {
      paths: [targetPath, record.source.path],
    });
  const { claim, ownedPaths } = newRestoreClaim(input.claim);
  const restore = {
    ...restoreBase(record, input.attemptId, "disaster", targetPath, input.selection),
    ...(ownedPaths ? { ownedPaths } : {}),
  };
  return writeJournal(lock, record, { ...readyFrom(record), state: "restore-ready", phase: "disaster-source-missing", restore, claim }) as RestoreReadyRecord;
}

export function bindRestoreTarget(lock: MaintenanceLock): RestoreReadyRecord {
  const record = currentJournal(lock);
  if (record.state !== "restore-ready")
    maintenanceError("invalid-transition", "restore target can be bound only before commit intent", { root: lock.root });
  if (record.restore.target)
    maintenanceError("invalid-transition", "restore target is already bound", { attemptId: record.restore.attemptId });
  if (record.restore.method === "same-path" && record.phase !== "source-moved")
    maintenanceError("invalid-transition", "same-path target cannot be bound before the source move", {
      attemptId: record.restore.attemptId,
    });
  const target = ensureStoreIdentity(record.restore.targetPath);
  if (record.restore.method === "alternate")
    assertPathsDoNotOverlap(
      record.source.path,
      target.path,
      "alternate restore target must remain disjoint from the retained source",
    );
  if (record.restore.previousSource &&
      target.dev === record.restore.previousSource.identity.dev && target.ino === record.restore.previousSource.identity.ino)
    maintenanceError("identity-mismatch", "restore target aliases the old source inode", {
      attemptId: record.restore.attemptId,
      expected: record.restore.previousSource.identity,
      actual: target,
      paths: [target.path, record.restore.previousSource.identity.path],
    });
  const restore = { ...record.restore, target };
  return writeJournal(lock, record, { ...readyFrom(record), state: "restore-ready", phase: record.phase, restore, claim: record.claim }) as RestoreReadyRecord;
}

export function jsonObject(value: { readonly [key: string]: JsonValue }): { readonly [key: string]: JsonValue } {
  if (!validJsonObject(value))
    maintenanceError("invalid-transition", "restore metadata must be finite JSON data");
  return JSON.parse(JSON.stringify(value)) as { readonly [key: string]: JsonValue };
}

function preflightRollbackSource(record: RestoreReadyRecord): void {
  if (record.restore.method === "same-path") {
    if (record.phase === "move-pending") {
      interpretPendingStoreMove(record);
      return;
    }
    if (!record.restore.previousSource)
      maintenanceError("journal-corrupt", "moved restore has no previous source", { attemptId: record.restore.attemptId });
    assertStoreIdentity(record.restore.previousSource.identity);
    return;
  }
  if (record.restore.method === "alternate") {
    assertStoreIdentity(record.source);
    return;
  }
  if (identityAt(record.source.path))
    maintenanceError("ambiguous-filesystem-state", "missing-source rollback found an unexpected replacement", {
      attemptId: record.restore.attemptId, paths: [record.source.path], expected: record.source,
    });
}

export function writeRestoreCommitIntent(
  lock: MaintenanceLock,
  launch: { readonly [key: string]: JsonValue },
): CommitIntentRecord {
  const record = currentJournal(lock);
  if (record.state !== "restore-ready" || !record.restore.target)
    maintenanceError("invalid-transition", "commit intent requires a bound pre-commit target", { root: lock.root });
  assertStoreIdentity(record.restore.target);
  if (record.restore.previousSource) {
    const previous = assertStoreIdentity(record.restore.previousSource.identity);
    if (previous.dev === record.restore.target.dev && previous.ino === record.restore.target.ino)
      maintenanceError("identity-mismatch", "old source aliases the restore target at commit intent", {
        attemptId: record.restore.attemptId,
        expected: record.restore.previousSource.identity,
        actual: record.restore.target,
        paths: [previous.path, record.restore.target.path],
      });
  }
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "commit-intent", restore: record.restore as RestoreContext & { target: StoreIdentity },
    launch: jsonObject(launch),
  }) as CommitIntentRecord;
}

/** Fsync the exact normal listener identity after spawn and before activation is published. */
export function bindRestoreListener(
  lock: MaintenanceLock,
  proof: ListenerProof,
  options: { readonly controllerInstanceRunning?: (instance: ControllerListenerInstance) => boolean } = {},
): CommitIntentRecord {
  const record = currentJournal(lock);
  if (record.state !== "commit-intent")
    maintenanceError("invalid-transition", "restore listener can be bound only from commit intent", {
      root: lock.root,
    });
  const normalized = normalizedListenerProof(proof);
  requireCustodyProof(normalized, record.cut, restoreProofScope(record), options.controllerInstanceRunning,
    lock.root, record.restore.attemptId);
  if (normalized.attemptId !== record.restore.attemptId ||
      !sameStoreIdentity(normalized.target, record.restore.target))
    maintenanceError("listener-proof-mismatch", "restore listener proof does not match the committed attempt and target", {
      root: lock.root, attemptId: record.restore.attemptId,
      paths: [record.restore.target.path], expected: record.restore.target, actual: normalized.target,
    });
  const launchServer = record.launch.server;
  if (typeof launchServer !== "string" || canonicalListenerEndpoint(launchServer) !== normalized.serverEndpoint)
    maintenanceError("listener-proof-mismatch", "restore listener endpoint does not match committed launch provenance", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  assertStoreIdentity(record.restore.target);
  if (record.listenerReplacements?.some((replacement) => reusesListenerIdentity(replacement.proof, normalized)))
    maintenanceError("listener-proof-mismatch", "restore listener proof reuses a retired listener identity", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  assertListenerOwnerAlive(normalized);
  if (record.listenerProof) {
    if (!sameListenerProof(record.listenerProof, normalized))
      maintenanceError("listener-proof-mismatch", "restore commit intent is already bound to another listener", {
        root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
      });
    return record;
  }
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "commit-intent", restore: record.restore,
    launch: record.launch, listenerProof: normalized,
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
  }) as CommitIntentRecord;
}

/**
 * Retire one exactly bound, provably dead listener without changing the restore attempt. The
 * atomic journal transition clears the current proof before another listener may be spawned.
 */
export function replaceDeadRestoreListener(
  lock: MaintenanceLock,
  proof: ListenerProof,
  options: ReplaceDeadRestoreListenerOptions = {},
): CommitIntentRecord {
  const record = currentJournal(lock);
  if (record.state !== "commit-intent" && record.state !== "degraded")
    maintenanceError("invalid-transition", "dead restore listener replacement requires uncommitted commit intent or degraded state", {
      root: lock.root,
    });
  if (record.state === "degraded" &&
      (record.managerCommittedAt !== undefined || record.managerCommit !== undefined || record.activeAt !== undefined))
    maintenanceError("invalid-transition", "manager-committed restore listener cannot be replaced", {
      root: lock.root, attemptId: record.restore.attemptId,
    });
  if (!record.listenerProof)
    maintenanceError("listener-proof-missing", "restore listener replacement requires an existing bound proof", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  const normalized = normalizedListenerProof(proof);
  if (!sameListenerProof(record.listenerProof, normalized))
    maintenanceError("listener-proof-mismatch", "restore listener replacement does not exactly match the bound proof", {
      root: lock.root, attemptId: record.restore.attemptId,
      paths: [record.restore.target.path], expected: record.restore.target, actual: normalized.target,
    });
  assertStoreIdentity(record.restore.target);
  const status = (options.ownerStatus ?? localProcessOwnerStatus)(record.listenerProof.processOwner);
  if (status === "alive")
    maintenanceError("listener-owner-alive", "bound restore listener is still alive", {
      root: lock.root, attemptId: record.restore.attemptId,
      recourse: [{ action: "retry", description: "Stop the exact bound listener and prove process exit before replacement." }],
    });
  if (status !== "dead")
    maintenanceError("listener-owner-ambiguous", "bound restore listener death cannot be proven", {
      root: lock.root, attemptId: record.restore.attemptId,
      recourse: [{ action: "inspect", description: "Prove the exact recorded listener process dead before replacement." }],
    });
  const history = record.listenerReplacements ?? [];
  const replacement: RestoreListenerReplacement = {
    generation: history.length + 1,
    replacedAt: new Date().toISOString(),
    proof: record.listenerProof,
  };
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "commit-intent", restore: record.restore, launch: record.launch,
    listenerReplacements: [...history, replacement],
    ...carriedTokenHandoff(record),
  }) as CommitIntentRecord;
}

/**
 * Return an unbound degraded restore to commit intent after the caller proves its listener is gone.
 * A bound listener is retired through {@link replaceDeadRestoreListener}. At the spawn boundary,
 * sync the current listener name and spawn mark before the caller starts the process. A caller
 * that proves its spawn created no live listener can reset the mark without changing the name.
 */
export function rearmUnboundRestoreCommitIntent(
  lock: MaintenanceLock,
  spawn?: { readonly serverNonce: string } | "not-started",
): CommitIntentRecord {
  const record = currentJournal(lock);
  if ((record.state !== "commit-intent" && record.state !== "degraded") || record.listenerProof)
    maintenanceError("invalid-transition", "restore commit intent is re-armed only from a degraded restore with no bound listener", {
      root: lock.root,
    });
  if (record.state === "degraded" &&
      (record.managerCommittedAt !== undefined || record.managerCommit !== undefined || record.activeAt !== undefined))
    maintenanceError("invalid-transition", "manager-committed restore cannot return to commit intent", {
      root: lock.root, attemptId: record.restore.attemptId,
    });
  if (record.state === "commit-intent" && !spawn) return record;
  assertStoreIdentity(record.restore.target);
  const launch = spawn === "not-started"
    ? { ...record.launch, listenerSpawn: spawn }
    : spawn
      ? { ...record.launch, listenerSpawn: "started", serverNonce: spawn.serverNonce, serverName: `${record.restore.attemptId}-${spawn.serverNonce}` }
      : record.launch;
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "commit-intent", restore: record.restore, launch,
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
  }) as CommitIntentRecord;
}

/** Fsync the manager's suppression-retaining commit token before requesting finalization. */
export function recordRestoreManagerCommit(
  lock: MaintenanceLock,
  proof: ListenerProof,
  evidence: ManagerCommitEvidence,
): RestoreManagerCommittedRecord {
  const record = currentJournal(lock);
  if (record.state === "manager-committed") {
    const normalized = normalizedListenerProof(proof);
    if (!sameListenerProof(record.listenerProof, normalized))
      maintenanceError("listener-proof-mismatch", "restore commit retry does not match the durable listener proof", {
        root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
      });
    if (!validManagerCommitEvidence(evidence, record.restore.attemptId) ||
        !sameManagerCommitEvidence(record.managerCommit, evidence))
      maintenanceError("activation-evidence-invalid", "restore commit retry does not match the durable manager token", {
        root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
      });
    assertStoreIdentity(record.restore.target);
    return record;
  }
  if (record.state !== "commit-intent" && record.state !== "degraded")
    maintenanceError("invalid-transition", "restore manager commit requires commit-intent or uncommitted degraded state", {
      root: lock.root,
    });
  if (record.state === "degraded" &&
      (record.managerCommittedAt !== undefined || record.managerCommit !== undefined || record.activeAt !== undefined))
    maintenanceError("invalid-transition", "restore manager commitment is already durable", {
      root: lock.root, attemptId: record.restore.attemptId,
    });
  if (!record.listenerProof)
    maintenanceError("listener-proof-missing", "restore manager commit requires a durably bound listener proof", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  const normalized = normalizedListenerProof(proof);
  if (!sameListenerProof(record.listenerProof, normalized))
    maintenanceError("listener-proof-mismatch", "restore manager commit proof does not exactly match the bound listener", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  if (!validManagerCommitEvidence(evidence, record.restore.attemptId))
    maintenanceError("activation-evidence-invalid", "restore manager commit evidence is invalid or belongs to another attempt", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  assertStoreIdentity(record.restore.target);
  assertListenerOwnerAlive(record.listenerProof);
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "manager-committed", restore: record.restore,
    launch: record.launch, listenerProof: record.listenerProof,
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
    managerCommittedAt: new Date().toISOString(), managerCommit: evidence,
  }) as RestoreManagerCommittedRecord;
}

export function markRestoreActive(
  lock: MaintenanceLock,
  proof: ListenerProof,
  evidence: ManagerFinalizeEvidence,
): RestoreActiveRecord {
  const record = currentJournal(lock);
  const normalizedProof = normalizedListenerProof(proof);
  if (record.state === "active") {
    if (!record.listenerProof || !sameListenerProof(record.listenerProof, normalizedProof))
      maintenanceError("listener-proof-mismatch", "active restore retry does not match the durable listener proof", {
        root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
      });
    if (!validManagerFinalizeEvidence(
          evidence,
          record.restore.attemptId,
          record.details.managerCommit.durableCommitToken,
        ) || !sameManagerFinalizeEvidence(record.details.managerFinalize, evidence))
      maintenanceError("activation-evidence-invalid", "active restore retry does not match the durable manager finalize evidence", {
        root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
      });
    assertStoreIdentity(record.restore.target);
    return record;
  }
  if (record.state !== "manager-committed")
    maintenanceError("invalid-transition", "active restore requires manager-committed state", { root: lock.root });
  if (!sameListenerProof(record.listenerProof, normalizedProof))
    maintenanceError("listener-proof-mismatch", "active restore proof does not exactly match the bound listener", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  if (!validManagerFinalizeEvidence(evidence, record.restore.attemptId, record.managerCommit.durableCommitToken))
    maintenanceError("activation-evidence-invalid", "active restore requires exact token-bound manager finalize evidence", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  assertStoreIdentity(record.restore.target);
  assertListenerOwnerAlive(record.listenerProof);
  requireSettledTokenHandoff(record, lock.root);
  const details: RestoreActivationEvidence = {
    attemptId: record.restore.attemptId,
    listenerReady: true,
    observedAt: new Date().toISOString(),
    managerCommit: record.managerCommit,
    managerFinalize: evidence,
  };
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "active", restore: record.restore,
    launch: record.launch, listenerProof: record.listenerProof,
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
    managerCommittedAt: record.managerCommittedAt, managerCommit: record.managerCommit,
    activeAt: new Date().toISOString(), details,
  }) as RestoreActiveRecord;
}

export function markRestoreDegraded(
  lock: MaintenanceLock,
  reason: string,
  recourse: readonly MaintenanceRecourse[],
): RestoreDegradedRecord {
  const record = currentJournal(lock);
  if (record.state !== "commit-intent" && record.state !== "manager-committed" && record.state !== "active")
    maintenanceError("invalid-transition", "degraded restore requires commit intent, manager-committed, or active state", { root: lock.root });
  if (!reason || !validRecourse(recourse))
    maintenanceError("invalid-transition", "degraded restore requires a reason and structured recourse", { root: lock.root });
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "degraded", restore: record.restore,
    launch: record.launch, ...(record.listenerProof ? { listenerProof: record.listenerProof } : {}),
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
    ...(record.state === "manager-committed"
      ? { managerCommittedAt: record.managerCommittedAt, managerCommit: record.managerCommit }
      : {}),
    ...(record.state === "active"
      ? {
          managerCommittedAt: record.managerCommittedAt,
          managerCommit: record.managerCommit,
          details: record.details,
          activeAt: record.activeAt,
        }
      : {}),
    degradedAt: new Date().toISOString(), reason, recourse: [...recourse],
  }) as RestoreDegradedRecord;
}

/** Recover forward only by re-presenting the exact bound listener plus fresh readiness evidence. */
export function repairRestoreDegradedToActive(
  lock: MaintenanceLock,
  proof: ListenerProof,
  evidence: ManagerFinalizeEvidence,
): RestoreActiveRecord {
  const record = currentJournal(lock);
  if (record.state !== "degraded")
    maintenanceError("invalid-transition", "restore repair requires degraded state", { root: lock.root });
  if (!record.listenerProof)
    maintenanceError("listener-proof-missing", "degraded restore has no bound listener proof", {
      root: lock.root, attemptId: record.restore.attemptId,
      paths: [record.restore.target.path, record.restore.previousSource?.identity.path]
        .filter((path): path is string => Boolean(path)),
      recourse: [{ action: "inspect", description: "Preserve both stores; listener ownership was never durably bound." }],
    });
  const normalized = normalizedListenerProof(proof);
  if (!sameListenerProof(record.listenerProof, normalized))
    maintenanceError("listener-proof-mismatch", "restore repair proof does not exactly match the bound listener", {
      root: lock.root, attemptId: record.restore.attemptId,
      paths: [record.restore.target.path, record.restore.previousSource?.identity.path]
        .filter((path): path is string => Boolean(path)),
    });
  assertStoreIdentity(record.restore.target);
  assertListenerOwnerAlive(record.listenerProof);
  requireSettledTokenHandoff(record, lock.root);
  if (!record.managerCommit || !record.managerCommittedAt)
    maintenanceError("invalid-transition", "uncommitted degraded restore must record manager commitment before finalization", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  if (!validManagerFinalizeEvidence(evidence, record.restore.attemptId, record.managerCommit.durableCommitToken))
    maintenanceError("activation-evidence-invalid", "restore repair requires exact token-bound manager finalize evidence", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  const details: RestoreActivationEvidence = {
    attemptId: record.restore.attemptId,
    listenerReady: true,
    observedAt: new Date().toISOString(),
    managerCommit: record.managerCommit,
    managerFinalize: evidence,
  };
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "active", restore: record.restore, launch: record.launch,
    listenerProof: record.listenerProof,
    managerCommittedAt: record.managerCommittedAt, managerCommit: record.managerCommit,
    activeAt: new Date().toISOString(), details,
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
  }) as RestoreActiveRecord;
}

function cleanupTomb(record: RestoreReadyRecord | RestoreActiveRecord, kind: CleanupProgress["kind"], identity: StoreIdentity): string {
  return join(dirname(identity.path), `.cotal-clean-${record.restore.attemptId}-${kind}-${randomUUID()}`);
}

function startCleanup(
  lock: MaintenanceLock,
  record: RestoreReadyRecord | RestoreActiveRecord,
  kind: CleanupProgress["kind"],
  identity: StoreIdentity,
): RestoreReadyRecord | RestoreActiveRecord {
  const cleanup: CleanupProgress = {
    kind, status: "pending", originalPath: identity.path,
    tombPath: cleanupTomb(record, kind, identity), identity,
  };
  const restore = { ...record.restore, cleanup };
  if (record.state === "restore-ready")
    return writeJournal(lock, record, { ...readyFrom(record), state: "restore-ready", phase: record.phase, restore, claim: record.claim }) as RestoreReadyRecord;
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "active", restore: restore as RestoreContext & { target: StoreIdentity },
    launch: record.launch, ...(record.listenerProof ? { listenerProof: record.listenerProof } : {}),
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
    managerCommittedAt: record.managerCommittedAt, managerCommit: record.managerCommit,
    activeAt: record.activeAt, details: record.details,
  }) as RestoreActiveRecord;
}

function continueCleanup(
  lock: MaintenanceLock,
  record: RestoreReadyRecord | RestoreActiveRecord,
): RestoreReadyRecord | RestoreActiveRecord {
  const cleanup = record.restore.cleanup;
  if (!cleanup) maintenanceError("invalid-transition", "no cleanup is recorded", { attemptId: record.restore.attemptId });
  if (cleanup.status === "complete") return record;
  if (record.state === "active") {
    assertStoreIdentity(record.restore.target);
    if (pathContains(cleanup.originalPath, record.restore.target.path) ||
        pathContains(cleanup.tombPath, record.restore.target.path))
      maintenanceError("cleanup-forbidden", "recursive cleanup tree contains the active target", {
        root: lock.root, attemptId: record.restore.attemptId,
        paths: [cleanup.originalPath, cleanup.tombPath, record.restore.target.path],
      });
  }
  const original = identityAt(cleanup.originalPath);
  const tomb = identityAt(cleanup.tombPath);
  const expectedOriginal = cleanup.identity;
  const expectedTomb = { ...cleanup.identity, path: cleanup.tombPath };
  if (original && sameStoreIdentity(expectedOriginal, original) && !tomb) {
    renameSync(cleanup.originalPath, cleanup.tombPath);
    fsyncDirectory(dirname(cleanup.originalPath));
  } else if (!original && tomb && sameStoreIdentity(expectedTomb, tomb)) {
    // Crash after rename: continue with the recorded inode.
  } else if (!original && !tomb) {
    // Crash after removal but before the final journal write: the requested cleanup is complete.
  } else {
    maintenanceError("ambiguous-filesystem-state", "recorded cleanup paths do not match the journal", {
      attemptId: record.restore.attemptId,
      paths: [cleanup.originalPath, cleanup.tombPath], expected: cleanup.identity, actual: original ?? tomb,
      recourse: [{ action: "inspect", description: "Preserve every matching path and repair the journal explicitly.", paths: [cleanup.originalPath, cleanup.tombPath] }],
    });
  }
  const moved = identityAt(cleanup.tombPath);
  if (moved) {
    if (!sameStoreIdentity(expectedTomb, moved))
      maintenanceError("identity-mismatch", "cleanup tomb inode changed", {
        attemptId: record.restore.attemptId, expected: expectedTomb, actual: moved, paths: [cleanup.tombPath],
      });
    if (record.state === "active") assertStoreIdentity(record.restore.target);
    if (cleanup.kind === "previous-source") removeStoreTomb(lock, record, cleanup);
    else rmSync(cleanup.tombPath, { recursive: true });
    fsyncDirectory(dirname(cleanup.tombPath));
  }
  const restore = { ...record.restore, cleanup: { ...cleanup, status: "complete" as const } };
  if (record.state === "restore-ready")
    return writeJournal(lock, record, { ...readyFrom(record), state: "restore-ready", phase: record.phase, restore, claim: record.claim }) as RestoreReadyRecord;
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "active", restore: restore as RestoreContext & { target: StoreIdentity },
    launch: record.launch, ...(record.listenerProof ? { listenerProof: record.listenerProof } : {}),
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    ...carriedTokenHandoff(record),
    managerCommittedAt: record.managerCommittedAt, managerCommit: record.managerCommit,
    activeAt: record.activeAt, details: record.details,
  }) as RestoreActiveRecord;
}

/** Remove an old store's tomb by its store entries, then the folder once it is empty. An entry no
 *  Cotal store writes, there before the removal or put there since, moves the folder back to where it
 *  was and refuses, so the old source loses nothing but its store. */
function removeStoreTomb(lock: MaintenanceLock, record: RestoreReadyRecord | RestoreActiveRecord, cleanup: CleanupProgress): void {
  const refuse = (entries: readonly string[]): never => {
    const back = !existsSync(cleanup.originalPath);
    if (back) {
      renameSync(cleanup.tombPath, cleanup.originalPath);
      fsyncDirectory(dirname(cleanup.originalPath));
    }
    const path = back ? cleanup.originalPath : cleanup.tombPath;
    return maintenanceError("store-holds-foreign-entries", `the restore's old source ${path} also holds ${entries.join(", ")}, which no Cotal store writes`, {
      root: lock.root, attemptId: record.restore.attemptId, paths: [path],
      recourse: [{ action: "inspect", description: "Move those entries out of the old source, then run the cleanup again.", paths: [path] }],
    });
  };
  const foreign = foreignStoreEntries(cleanup.tombPath);
  if (foreign.length) refuse(foreign);
  for (const entry of STORE_ENTRY_NAMES) rmSync(join(cleanup.tombPath, entry), { recursive: true, force: true });
  try { rmdirSync(cleanup.tombPath); }
  catch (error) {
    if (errno(error) !== "ENOTEMPTY" && errno(error) !== "EEXIST") throw error;
    refuse(foreignStoreEntries(cleanup.tombPath));
  }
}

function cleanupAttemptTarget(lock: MaintenanceLock, record: RestoreReadyRecord): RestoreReadyRecord {
  const target = record.restore.target;
  if (!target) return record;
  let current = record;
  if (!current.restore.cleanup)
    current = startCleanup(lock, current, "attempt-target", target) as RestoreReadyRecord;
  if (current.restore.cleanup?.kind !== "attempt-target")
    maintenanceError("cleanup-forbidden", "pre-commit rollback cannot run previous-source cleanup", {
      attemptId: current.restore.attemptId,
    });
  return continueCleanup(lock, current) as RestoreReadyRecord;
}

export interface RollbackRestoreOptions {
  /** Exact live-claim coordinator identity: the owning coordinator rolling back its own attempt. */
  readonly asCoordinator?: ProcessOwner;
  readonly now?: Date;
  readonly ownerStatus?: (owner: ProcessOwner) => OwnerStatus;
  /** The caller's proof that no process the attempt started outside its recorded owners is alive.
   *  With every recorded owner proven dead, it makes the claim stale before its deadline. */
  readonly unrecordedOwnersDead?: boolean;
  /** A controller alternate restore with a recorded broker reconfiguration: the live broker
   *  definition revision the caller read under the definition writer lock. Rollback proceeds only
   *  while it is the revision the reconfiguration says the cut runs at again. */
  readonly controllerDefinition?: { readonly liveRevision: string };
}

/** Refuse to touch a LIVE restore attempt: only the exact recorded coordinator, or a caller that
 *  proves the attempt stale (every owner dead, and the deadline elapsed or no unrecorded owner
 *  alive), may roll it back. */
export function assertRestoreClaimRollbackable(lock: MaintenanceLock, record: RestoreReadyRecord, options: RollbackRestoreOptions): void {
  if (options.asCoordinator) {
    if (!sameProcessOwner(options.asCoordinator, record.claim.coordinator))
      maintenanceError("claim-live", "rollback caller is not the recorded restore coordinator", {
        root: lock.root, attemptId: record.restore.attemptId,
        recourse: [{ action: "retry", description: "Wait for the live restore attempt to finish or become provably stale." }],
      });
    return;
  }
  const assessment = assessRestoreClaim(record, options);
  if (assessment === "live")
    maintenanceError("claim-live", "a restore attempt claim is still live", {
      root: lock.root, attemptId: record.restore.attemptId,
      recourse: [{ action: "retry", description: `Retry after ${record.claim.deadline} once the restore coordinator, watchdogs, and brokers have exited.` }],
    });
  if (assessment === "ambiguous")
    maintenanceError("claim-owner-ambiguous", "not every restore attempt owner is proven dead", {
      root: lock.root, attemptId: record.restore.attemptId,
      recourse: [{ action: "inspect", description: "Prove the recorded restore coordinator, watchdogs, and brokers dead before recovery." }],
    });
}


export function rollbackRestore(lock: MaintenanceLock, options: RollbackRestoreOptions = {}): MaintenanceReadyRecord {
  const initial = currentJournal(lock);
  if (initial.state === "commit-intent" || initial.state === "manager-committed" || initial.state === "active" || initial.state === "degraded") {
    const paths = [initial.restore.target.path, initial.restore.previousSource?.identity.path].filter((p): p is string => Boolean(p));
    maintenanceError("rollback-forbidden", "restore commit intent makes rollback unsafe", {
      root: lock.root, attemptId: initial.restore.attemptId, paths,
      recourse: [
        { action: "repair", description: "Preserve the restored target and old source; recover forward.", paths },
        { action: "cleanup", description: "After healthy activation, explicitly clean the recorded old source.", command: `cotal clean restore-fallback --attempt ${initial.restore.attemptId} --force`, paths },
      ],
    });
  }
  if (initial.state !== "restore-ready")
    maintenanceError("invalid-transition", "no pre-commit restore is available to roll back", { root: lock.root });
  assertRestoreClaimRollbackable(lock, initial, options);
  // The attempt-owned config is deleted below only once no live broker definition names it: either
  // the forward rewrite never landed, or the definition rollback already recorded its revision.
  const reconfiguration = initial.restore.controllerReconfiguration;
  const live = options.controllerDefinition?.liveRevision;
  if (reconfiguration && !(reconfiguration.phase === "rendered" && live === reconfiguration.fromRevision) &&
      !(reconfiguration.phase === "rolled-back" && live === reconfiguration.rollbackRevision))
    maintenanceError("rollback-forbidden", "the controller broker definition is not back at the cut's revision; its definition rollback must run first", {
      root: lock.root, attemptId: initial.restore.attemptId,
      recourse: [{ action: "inspect", description: "Run the controller restore recovery, which rolls the broker definition back before the store." }],
    });

  if (!initial.restore.target && pathExistsStrict(initial.restore.targetPath) &&
      !(initial.restore.method === "same-path" && initial.phase === "move-pending" &&
        sameStoreIdentity(initial.source, readStoreIdentity(initial.restore.targetPath)))) {
    // A crash between target creation and the bind journal write leaves an unbound target that is
    // either EMPTY (pre-marker) or holds EXACTLY the attempt's own generation marker — the single
    // durable side effect of ensureStoreIdentity before writeJournal. Both shapes are content-
    // bounded and provably data-free, so removal is safe; anything else fails closed.
    const stat = lstatSync(initial.restore.targetPath);
    const removableUnboundTarget = (): boolean => {
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const entries = readdirSync(initial.restore.targetPath);
      if (entries.length === 0) return true;
      if (entries.length !== 1 || entries[0] !== STORE_ID_FILE) return false;
      const marker = lstatSync(join(initial.restore.targetPath, STORE_ID_FILE));
      if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 128) return false;
      const generation = readFileSync(join(initial.restore.targetPath, STORE_ID_FILE), "utf8").trim();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generation);
    };
    if (removableUnboundTarget()) {
      rmSync(initial.restore.targetPath, { recursive: true });
      fsyncDirectory(dirname(initial.restore.targetPath));
    } else {
      maintenanceError("ambiguous-filesystem-state", "unbound restore target appeared before rollback", {
        attemptId: initial.restore.attemptId,
        paths: [initial.restore.targetPath],
        recourse: [{ action: "inspect", description: "Preserve the unbound path; its ownership was never journaled.", paths: [initial.restore.targetPath] }],
      });
    }
  }

  // Never delete the restored target until the exact old-source rollback path is proven usable.
  preflightRollbackSource(initial);
  let record = cleanupAttemptTarget(lock, initial);
  if (record.restore.method === "same-path") {
    const fallbackPath = record.restore.fallbackPath!;
    const source = identityAt(record.source.path);
    const fallback = identityAt(fallbackPath);
    const expectedFallback = { ...record.source, path: fallbackPath };
    if (source && sameStoreIdentity(record.source, source) && !fallback) {
      // Crash after the fallback was already returned.
    } else if (!source && fallback && sameStoreIdentity(expectedFallback, fallback)) {
      renameSync(fallbackPath, record.source.path);
      fsyncDirectory(dirname(record.source.path));
      assertStoreIdentity(record.source);
    } else {
      maintenanceError("ambiguous-filesystem-state", "same-path rollback cannot identify one unchanged source", {
        attemptId: record.restore.attemptId,
        paths: [record.source.path, fallbackPath], expected: record.source, actual: source ?? fallback,
        recourse: [{ action: "inspect", description: "Preserve both paths and repair manually; do not overwrite either store.", paths: [record.source.path, fallbackPath] }],
      });
    }
  } else if (record.restore.method === "alternate") {
    assertStoreIdentity(record.source);
  } else if (identityAt(record.source.path)) {
    maintenanceError("ambiguous-filesystem-state", "missing-source rollback found an unexpected replacement", {
      attemptId: record.restore.attemptId, paths: [record.source.path], expected: record.source,
    });
  }
  removeOwnedPathsOrFail(lock, record.restore.attemptId, record.restore.ownedPaths);
  return writeJournal(lock, record, readyFrom(record)) as MaintenanceReadyRecord;
}

type LeftOutRecord = { readonly space: string; readonly mode: MaintenanceAuthMode; readonly restore: Pick<RestoreContext, "selection" | "previousSource">; readonly launch?: { readonly [key: string]: JsonValue } };

/** Whether a restore replaced a newer cut and did not rule out additional backed-up state. */
export function restoreReplacedNewerCut(record: LeftOutRecord): boolean {
  return record.launch?.previousCutNewer === true;
}

/** The other JetStream accounts whose streams a restore left in the store it set aside, such as an
 *  open mesh's account beside a static space's after both ran in one folder. A backup holds one
 *  account, so that store holds their only copy. The restore's launch records them. When it has no
 *  such record, as in a restore journaled by an earlier release, they are read from that store while
 *  it is still the recorded one, and only the accounts the journal's auth mode rules out are named:
 *  an open restore restored `$G`, and a static or user restore restored a data account, never `$G`.
 *  Which data account that was is not recorded, so after a static or user restore only `$G` is named.
 *  A store at that path that is not the recorded one throws. */
export function restoreOtherAccounts(record: LeftOutRecord): string[] {
  const recorded = record.launch?.otherAccounts;
  if (Array.isArray(recorded)) return recorded.filter((account): account is string => typeof account === "string");
  const previous = record.restore.previousSource?.identity;
  if (!record.launch || !previous || !identityAt(previous.path)) return [];
  assertStoreIdentity(previous);
  const held = storeAccounts(previous.path);
  return record.mode === "open" ? held.filter((account) => account !== "$G") : held.filter((account) => account === "$G");
}

/** What a restore left only in the store it set aside. A registry restore left out every other
 *  stream, and a full restore whose launch names no workflow journal, of a user-mode artifact or one
 *  made before full backups held runs, left out the workflow runs. A full restore that replaced a
 *  newer cut ({@link restoreReplacedNewerCut}) also left out what was written after its artifact.
 *  Any restore left out the streams of the other accounts in that store ({@link restoreOtherAccounts}).
 *  Undefined when it left out nothing. */
export function restoreLeftOut(record: LeftOutRecord): string | undefined {
  const accounts = restoreOtherAccounts(record);
  const theirs = accounts.length ? `streams of ${accounts.length === 1 ? "account" : "accounts"} ${accounts.join(", ")}` : undefined;
  const restored = record.launch?.restoredStreams;
  const runs = Array.isArray(restored) && restored.includes(wfjStreamName(record.space));
  const own = record.restore.selection === "registry" ? "chat and DM history and workflow runs"
    : restoreReplacedNewerCut(record) ? (runs ? "newer space state" : "workflow runs and newer space state")
    : runs ? undefined : "workflow runs";
  return own && theirs ? `${own} and the ${theirs}` : own ?? theirs;
}

/** A run a restore over a newer cut rolled back: its journal in the store the restore set aside goes
 *  further than the restored one. `reopened` names each step settled there that is open again, and
 *  `missing` marks a run that started after the artifact, so the restored store does not hold it. */
export interface RolledBackRun {
  readonly run: string;
  readonly reopened: readonly string[];
  readonly missing?: true;
}

/** The runs a restore's launch records it rolled back, and how many more it counted than it listed.
 *  Empty when it recorded none. */
export function restoreRolledBackRuns(record: LeftOutRecord): { readonly runs: readonly RolledBackRun[]; readonly more: number } {
  const recorded = record.launch?.rolledBackRuns, more = record.launch?.rolledBackRunsMore;
  const runs = Array.isArray(recorded) ? recorded.flatMap((row): RolledBackRun[] => {
    const value = row as { run?: unknown; reopened?: unknown; missing?: unknown };
    if (!value || typeof value !== "object" || typeof value.run !== "string" || !Array.isArray(value.reopened) || !value.reopened.every((key) => typeof key === "string")) return [];
    return [{ run: value.run, reopened: value.reopened as string[], ...(value.missing === true ? { missing: true as const } : {}) }];
  }) : [];
  return { runs, more: typeof more === "number" && Number.isSafeInteger(more) && more > 0 ? more : 0 };
}

/** Why a restore left something only in the store it set aside ({@link restoreLeftOut}), as a clause
 *  about the restore. Undefined when it left out nothing. */
export function restoreLeftOutReason(record: LeftOutRecord): string | undefined {
  const leftOut = restoreLeftOut(record);
  if (!leftOut) return undefined;
  const accounts = restoreOtherAccounts(record).length ? ["held only one of the accounts in the store it replaced"] : [];
  if (record.restore.selection === "registry") return `this restore was registry-only${accounts.length ? ` and its artifact ${accounts[0]}` : ""}`;
  const why = [...(restoreReplacedNewerCut(record) ? ["was made before the state it replaced was preserved"] : []), ...(leftOut.startsWith("workflow runs") ? ["held no workflow runs"] : []), ...accounts];
  return `this restore's artifact ${why.join(" and ")}`;
}

/** Delete the old store a healthy active restore set aside, then retire its journal. When the
 *  restore left something out ({@link restoreLeftOut}), that store holds its only copy and is
 *  deleted only with `discardHistory`. A store that also holds an entry no Cotal store writes
 *  ({@link foreignStoreEntries}) is not deleted at all. */
export function cleanupRestoreFallback(lock: MaintenanceLock, attemptId: string, options: { readonly discardHistory?: boolean } = {}): RestoreActiveRecord {
  let record = currentJournal(lock);
  if (record.state !== "active" || record.restore.attemptId !== attemptId)
    maintenanceError("cleanup-forbidden", "old-source cleanup requires the matching healthy active restore", {
      root: lock.root, attemptId,
      recourse: [{ action: "repair", description: "Recover the restore to healthy active state before cleanup." }],
    });
  assertStoreIdentity(record.restore.target);
  const previous = record.restore.previousSource;
  // A disaster restore replaced a missing source, so it retains no old store: retiring its journal is
  // the whole cleanup, after the same finalization checks.
  if (!previous && record.restore.method === "disaster" && !record.restore.cleanup) return retireCleanedRestore(lock, record);
  if (!previous)
    maintenanceError("cleanup-forbidden", "this restore has no retained old source", { root: lock.root, attemptId });
  if (sameStoreIdentity(previous.identity, record.restore.target) || previous.identity.path === record.restore.target.path)
    maintenanceError("cleanup-forbidden", "recorded old source aliases the active target", {
      root: lock.root, attemptId, paths: [previous.identity.path, record.restore.target.path],
    });
  if (pathContains(previous.identity.path, record.restore.target.path))
    maintenanceError("cleanup-forbidden", "old-source cleanup would recursively delete the active target", {
      root: lock.root, attemptId, paths: [previous.identity.path, record.restore.target.path],
      recourse: [{ action: "repair", description: "Preserve both trees and repair the overlapping restore journal.", paths: [previous.identity.path, record.restore.target.path] }],
    });
  if (record.restore.cleanup?.status === "complete") return retireCleanedRestore(lock, record);
  // A cleanup already under way had this consent when it started.
  const leftOut = restoreLeftOut(record);
  if (!record.restore.cleanup && leftOut && !options.discardHistory)
    maintenanceError("cleanup-forbidden", `the restore's old source holds the only copy of the ${leftOut} it left out`, {
      root: lock.root, attemptId, paths: [previous.identity.path],
      recourse: [{ action: "cleanup", description: "Keep the old source, or repeat the cleanup with explicit consent to discard that history.", paths: [previous.identity.path] }],
    });
  // A file in the old source that no Cotal store writes is someone's, so nothing there is deleted.
  if (!record.restore.cleanup && existsSync(previous.identity.path)) {
    const foreign = foreignStoreEntries(previous.identity.path);
    if (foreign.length)
      maintenanceError("store-holds-foreign-entries", `the restore's old source ${previous.identity.path} also holds ${foreign.join(", ")}, which no Cotal store writes`, {
        root: lock.root, attemptId, paths: [previous.identity.path],
        recourse: [{ action: "inspect", description: "Move those entries out of the old source, then run the cleanup again.", paths: [previous.identity.path] }],
      });
  }
  if (!record.restore.cleanup)
    record = startCleanup(lock, record, "previous-source", previous.identity) as RestoreActiveRecord;
  if (record.restore.cleanup?.kind !== "previous-source")
    maintenanceError("cleanup-forbidden", "active record contains an attempt-target cleanup", { root: lock.root, attemptId });
  record = continueCleanup(lock, record) as RestoreActiveRecord;
  return retireCleanedRestore(lock, record);
}

/** Consume a healthy restore only after exact old-source cleanup is durably complete. A disaster
 *  restore retained no old source, so it has no cleanup to complete. */
function retireCleanedRestore(lock: MaintenanceLock, record: RestoreActiveRecord): RestoreActiveRecord {
  const cleaned = record.restore.method === "disaster"
    ? record.restore.cleanup === undefined
    : record.restore.cleanup?.kind === "previous-source" && record.restore.cleanup.status === "complete";
  if (!cleaned)
    maintenanceError("cleanup-forbidden", "restore retirement requires completed previous-source cleanup", {
      root: lock.root, attemptId: record.restore.attemptId,
    });
  assertStoreIdentity(record.restore.target);
  if (!validRestoreActivationEvidence(record.details, record.restore.attemptId) ||
      !sameManagerCommitEvidence(record.managerCommit, record.details.managerCommit))
    maintenanceError("activation-evidence-invalid", "restore retirement requires exact healthy manager finalization evidence", {
      root: lock.root, attemptId: record.restore.attemptId, paths: [record.restore.target.path],
    });
  readMaintenanceResumeDocument(lock.root, record.resume);
  const paths = maintenancePaths(lock.root);
  unlinkSync(paths.journal);
  fsyncDirectory(paths.versionDir);
  return record;
}
