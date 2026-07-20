import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireMaintenanceLock,
  beginMaintenanceCut,
  beginOrdinaryResume,
  bindRestoreListener,
  bindRestoreTarget,
  claimMaintenanceReady,
  cleanupRestoreFallback,
  completeMaintenanceCut,
  consumeRetiredMaintenance,
  ensureStoreIdentity,
  interpretPendingStoreMove,
  isMaintenanceError,
  markRestoreActive,
  markRestoreDegraded,
  markOrdinaryResumeActive,
  markOrdinaryResumeDegraded,
  maintenancePaths,
  moveSamePathRestoreSource,
  prepareAlternateRestore,
  prepareMissingSourceRestore,
  prepareSamePathRestore,
  clearPreservationCommitIntent,
  clearPreservationPrepareIntent,
  readPreservationCommitIntent,
  writePreservationCommitIntent,
  readMaintenanceJournal,
  readMaintenanceResumeDocument,
  readPreservationPrepareIntent,
  readStoreIdentity,
  recordMaintenanceClaimResources,
  recordOrdinaryResumeManagerCommit,
  recordPreservationManagerCommit,
  recordRestoreAttemptResources,
  recordRestoreManagerCommit,
  recoverStaleMaintenanceClaim,
  writePreservationPrepareIntent,
  replaceDeadRestoreListener,
  repairRestoreDegradedToActive,
  releaseMaintenanceClaim,
  releaseMaintenanceLock,
  retireOrdinaryResume,
  rollbackRestore,
  sameStoreIdentity,
  writeRestoreCommitIntent,
  writeMaintenanceResumeDocument,
  type MaintenanceAuthMode,
  type MaintenanceCutCompletionEvidence,
  type MaintenanceErrorCode,
  type MaintenanceLock,
  type MaintenanceResumeDescriptor,
  type ManagerCommitEvidence,
  type ManagerFinalizeEvidence,
  type OrdinaryResumeIntentRecord,
  type ProcessOwner,
  type RestoreListenerProof,
} from "../src/maintenance.js";

let passed = 0;
function check(name: string, condition: unknown): void {
  assert.ok(condition, name);
  passed++;
  console.log(`  ok ${name}`);
}

function expectCode(name: string, code: MaintenanceErrorCode, operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => isMaintenanceError(error) && error.code === code);
  passed++;
  console.log(`  ok ${name}`);
}

const sandbox = mkdtempSync(join(tmpdir(), "cotal-maintenance-"));

function project(name: string): { root: string; store: string } {
  const root = join(sandbox, name);
  const store = join(root, "store");
  mkdirSync(store, { recursive: true });
  return { root: realpathSync.native(root), store: realpathSync.native(store) };
}

function owner(id: string, pid = 999_999): ProcessOwner {
  return { id, pid, host: hostname(), startedAt: new Date(0).toISOString() };
}

const normalEndpoint = "nats://127.0.0.1:4222";

function cutCompletion(attemptId: string): MaintenanceCutCompletionEvidence {
  return {
    attemptId,
    observedAt: new Date().toISOString(),
    managerCommit: { operation: "commitPreservation", attemptId, state: "preserved" },
    stopped: { manager: true, broker: true, localProcesses: true },
    listener: { endpoint: normalEndpoint, unreachable: true },
  };
}

/** The smoke process itself coordinates every restore attempt: alive while tests run. */
const restoreCoordinator = owner("restore-coordinator", process.pid);

function restoreClaim(overrides: { deadline?: string; coordinator?: ProcessOwner } = {}) {
  return {
    deadline: overrides.deadline ?? new Date(Date.now() + 60_000).toISOString(),
    coordinator: overrides.coordinator ?? restoreCoordinator,
  };
}

function managerCommit(attemptId: string, durableCommitToken = "a".repeat(64)): ManagerCommitEvidence {
  return {
    attemptId, state: "awaitingFinalize", durableCommitToken,
  };
}

function managerFinalize(attemptId: string, durableCommitToken = "a".repeat(64)): ManagerFinalizeEvidence {
  return { attemptId, state: "active", durableCommitToken };
}

function ordinaryActivation(attemptId: string) {
  return {
    operation: "resumePreserved" as const,
    attemptId,
    state: "awaitingCommit" as const,
    observedAt: new Date().toISOString(),
  };
}

function finalizeRestore(lock: MaintenanceLock, proof: RestoreListenerProof): ReturnType<typeof markRestoreActive> {
  recordRestoreManagerCommit(lock, proof, managerCommit(proof.attemptId));
  return markRestoreActive(lock, proof, managerFinalize(proof.attemptId));
}

function ready(name: string, mode: MaintenanceAuthMode = "auth"): {
  root: string;
  store: string;
  lock: MaintenanceLock;
  resume: MaintenanceResumeDescriptor;
} {
  const p = project(name);
  const lock = acquireMaintenanceLock(p.root);
  const resume = writeMaintenanceResumeDocument(lock, {
    version: 1,
    inventory: [{ id: `agent-${name}`, principal: { mode } }],
    launch: { runtime: "pty", root: p.root, store: p.store, space: `space-${name}` },
  });
  const attemptId = `cut-${name}`;
  beginMaintenanceCut(lock, {
    attemptId, space: `space-${name}`, mode, sourcePath: p.store, resume,
    launch: { server: normalEndpoint, runtime: "pty", root: p.root, store: p.store },
  });
  recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId, state: "preserved" });
  completeMaintenanceCut(lock, cutCompletion(attemptId));
  return { ...p, lock, resume };
}

function committedAlternate(name: string, attemptId: string): ReturnType<typeof ready> & {
  targetPath: string;
  proof: RestoreListenerProof;
} {
  const p = ready(name);
  const targetPath = join(p.root, "target");
  prepareAlternateRestore(p.lock, { attemptId, targetPath, claim: restoreClaim() });
  mkdirSync(targetPath);
  const bound = bindRestoreTarget(p.lock);
  writeRestoreCommitIntent(p.lock, { server: "nats://127.0.0.1:4222", runtime: "pty" });
  return {
    ...p,
    targetPath,
    proof: {
      attemptId,
      serverName: `restore-${name}`,
      serverNonce: `nonce-${name}`,
      processOwner: owner(`listener-${name}`, process.pid),
      serverEndpoint: "nats://127.0.0.1:4222",
      target: bound.restore.target!,
    },
  };
}

function replacementProof(proof: RestoreListenerProof, suffix: string): RestoreListenerProof {
  return {
    ...proof,
    serverName: `${proof.serverName}-${suffix}`,
    serverNonce: `${proof.serverNonce}-${suffix}`,
    processOwner: owner(`${proof.processOwner.id}-${suffix}`, process.pid),
  };
}

// Every auth mode is retained in the private versioned record.
for (const mode of ["auth", "open", "user"] as const) {
  const p = ready(`mode-${mode}`, mode);
  const record = readMaintenanceJournal(p.root);
  check(`${mode} ready journal is versioned, mode-bound, and generation-bound`, record?.version === 1 &&
    record.state === "ready" && record.mode === mode && Boolean(record.source.generation) &&
    record.resume.sha256 === p.resume.sha256);
  const document = readMaintenanceResumeDocument(p.root, p.resume);
  check(`${mode} resume document retains inventory and launch provenance`,
    Array.isArray(document.inventory) &&
    typeof document.launch === "object" && document.launch !== null && !Array.isArray(document.launch) &&
    document.launch.runtime === "pty");
  releaseMaintenanceLock(p.lock);
}

// The pre-stop cut is durable, retryable after manager exit, and promotes only on exact evidence.
{
  const p = project("cut-intent-crash");
  const lock = acquireMaintenanceLock(p.root);
  const resume = writeMaintenanceResumeDocument(lock, {
    version: 1, inventory: [{ id: "retained-agent" }], launch: { server: normalEndpoint, runtime: "pty" },
  });
  const intent = beginMaintenanceCut(lock, {
    attemptId: "cut-crash-1", space: "cut-crash", mode: "auth", sourcePath: p.store, resume,
    launch: { server: normalEndpoint, runtime: "pty", detached: true },
  });
  check("cut intent binds attempt, source, resume, space, mode, and launch before stops",
    intent.state === "cut-intent" && intent.cut.attemptId === "cut-crash-1" &&
    sameStoreIdentity(intent.source, readStoreIdentity(p.store)) && intent.resume.sha256 === resume.sha256 &&
    intent.space === "cut-crash" && intent.mode === "auth" && intent.cut.launch.runtime === "pty");
  releaseMaintenanceLock(lock);

  const recoveredLock = acquireMaintenanceLock(p.root);
  check("crash after cut intent remains recoverable after the manager is already stopped",
    readMaintenanceJournal(p.root)?.state === "cut-intent");
  const retriedIntent = beginMaintenanceCut(recoveredLock, {
    attemptId: "cut-crash-1", space: "cut-crash", mode: "auth", sourcePath: p.store, resume,
    launch: { detached: true, runtime: "pty", server: normalEndpoint },
  });
  check("exact cut intent retry is idempotent regardless of launch object key order",
    retriedIntent.revision === intent.revision);
  expectCode("backup refuses cut-intent", "invalid-transition", () => claimMaintenanceReady(recoveredLock, {
    attemptId: "backup-cut-intent", deadline: new Date(Date.now() + 60_000).toISOString(),
    coordinator: owner("c"), owners: [owner("w"), owner("b")],
  }));
  expectCode("restore refuses cut-intent", "invalid-transition", () =>
    prepareAlternateRestore(recoveredLock, { attemptId: "restore-cut-intent", targetPath: join(p.root, "target"), claim: restoreClaim() }));
  expectCode("ordinary up refuses cut-intent", "invalid-transition", () =>
    beginOrdinaryResume(recoveredLock, { attemptId: "up-cut-intent", launch: { server: normalEndpoint } }));
  expectCode("clean refuses cut-intent", "cleanup-forbidden", () =>
    cleanupRestoreFallback(recoveredLock, "cut-crash-1"));
  expectCode("journal consumption refuses cut-intent", "invalid-transition", () =>
    consumeRetiredMaintenance(recoveredLock));
  expectCode("stop evidence cannot promote a cut whose manager commitment is not durable", "invalid-transition", () =>
    completeMaintenanceCut(recoveredLock, cutCompletion("cut-crash-1")));
  expectCode("wrong-attempt manager commitment is rejected", "activation-evidence-invalid", () =>
    recordPreservationManagerCommit(recoveredLock, { operation: "commitPreservation", attemptId: "cut-crash-wrong", state: "preserved" }));
  expectCode("empty manager commitment is rejected", "activation-evidence-invalid", () =>
    recordPreservationManagerCommit(recoveredLock, {} as never));
  const committedCut = recordPreservationManagerCommit(recoveredLock, {
    operation: "commitPreservation", attemptId: "cut-crash-1", state: "preserved",
  });
  const committedCutAgain = recordPreservationManagerCommit(recoveredLock, {
    operation: "commitPreservation", attemptId: "cut-crash-1", state: "preserved",
  });
  check("manager commitment is durable BEFORE any stop and idempotent on retry",
    committedCut.state === "cut-committed" && committedCutAgain.revision === committedCut.revision &&
    committedCut.managerCommit.attemptId === "cut-crash-1");
  expectCode("wrong-attempt stop evidence cannot promote the committed cut", "activation-evidence-invalid", () =>
    completeMaintenanceCut(recoveredLock, cutCompletion("cut-crash-wrong")));
  expectCode("empty stop evidence cannot promote the committed cut", "activation-evidence-invalid", () =>
    completeMaintenanceCut(recoveredLock, {} as never));
  const evidence = cutCompletion("cut-crash-1");
  const completed = completeMaintenanceCut(recoveredLock, evidence);
  const repeated = completeMaintenanceCut(recoveredLock, evidence);
  check("exact cut completion is idempotent without another journal revision",
    completed.state === "ready" && repeated.revision === completed.revision &&
    repeated.cutCompletion.managerCommit.attemptId === "cut-crash-1");
  const recoveredCompletion = completeMaintenanceCut(recoveredLock, {
    ...evidence, observedAt: new Date(Date.now() + 1).toISOString(),
  });
  check("fresh exact evidence after a lost response still observes the same ready revision",
    recoveredCompletion.revision === completed.revision);
  releaseMaintenanceLock(recoveredLock);
}

{
  const p = project("ready-requires-resume");
  const lock = acquireMaintenanceLock(p.root);
  const absent: MaintenanceResumeDescriptor = {
    version: 1, file: "resume.json", bytes: 2, sha256: "0".repeat(64),
  };
  expectCode("ready refuses a missing resume document", "resume-missing", () =>
    beginMaintenanceCut(lock, {
      attemptId: "cut-missing-resume", space: "missing-resume", mode: "auth",
      sourcePath: p.store, resume: absent, launch: { server: normalEndpoint },
    }));
  check("missing resume publishes no journal", !statExists(maintenancePaths(p.root).journal));
  releaseMaintenanceLock(lock);
}

{
  const p = ready("resume-missing");
  rmSync(maintenancePaths(p.root).resume);
  expectCode("ready journal is invalid when resume bytes disappear", "resume-missing", () =>
    readMaintenanceJournal(p.root));
  expectCode("transitions refuse a missing resume document", "resume-missing", () =>
    claimMaintenanceReady(p.lock, {
      attemptId: "missing-resume-claim", deadline: new Date(1).toISOString(),
      coordinator: owner("c"), owners: [owner("w"), owner("b")],
    }));
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("resume-tamper");
  const path = maintenancePaths(p.root).resume;
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace('"pty"', '"bad"'), { mode: 0o600 });
  expectCode("resume SHA-256 tampering invalidates ready", "resume-mismatch", () =>
    readMaintenanceJournal(p.root));
  expectCode("resume SHA-256 tampering blocks restore preparation", "resume-mismatch", () =>
    prepareAlternateRestore(p.lock, { attemptId: "tampered-resume", targetPath: join(p.root, "target"), claim: restoreClaim() }));
  releaseMaintenanceLock(p.lock);
}

if (process.platform !== "win32") {
  const p = ready("resume-symlink");
  const paths = maintenancePaths(p.root);
  const identical = join(p.root, "identical-resume.json");
  writeFileSync(identical, readFileSync(paths.resume), { mode: 0o600 });
  rmSync(paths.resume);
  symlinkSync(identical, paths.resume);
  expectCode("resume verification refuses a symlink to identical bytes", "resume-mismatch", () =>
    readMaintenanceResumeDocument(p.root, p.resume));
  releaseMaintenanceLock(p.lock);
}

{
  const p = project("resume-validation");
  const lock = acquireMaintenanceLock(p.root);
  expectCode("resume document rejects non-JSON values", "resume-invalid", () =>
    writeMaintenanceResumeDocument(lock, {
      version: 1, inventory: undefined, launch: {},
    } as never));
  expectCode("resume document enforces its byte bound", "resume-too-large", () =>
    writeMaintenanceResumeDocument(lock, {
      version: 1, inventory: [], launch: { value: "x".repeat(1024 * 1024) },
    }));
  check("invalid resume documents publish no bytes", !statExists(maintenancePaths(p.root).resume));
  releaseMaintenanceLock(lock);
}

if (process.platform !== "win32") {
  const p = project("private-layout");
  const lock = acquireMaintenanceLock(p.root);
  const resume = writeMaintenanceResumeDocument(lock, {
    version: 1, inventory: [], launch: { runtime: "pty" },
  });
  beginMaintenanceCut(lock, {
    attemptId: "cut-private-layout", space: "private-layout", mode: "auth",
    sourcePath: p.store, resume, launch: { server: normalEndpoint },
  });
  recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId: "cut-private-layout", state: "preserved" });
  completeMaintenanceCut(lock, cutCompletion("cut-private-layout"));
  const paths = maintenancePaths(p.root);
  check("maintenance directory is private", (statSync(paths.maintenanceDir).mode & 0o777) === 0o700);
  check("versioned journal is private", (statSync(paths.journal).mode & 0o777) === 0o600);
  check("resume document is private", (statSync(paths.resume).mode & 0o777) === 0o600);
  releaseMaintenanceLock(lock);
}

// An active owner excludes a second writer. A dead owner may be reaped, while ambiguous death may not.
{
  const p = project("lock-race");
  const first = acquireMaintenanceLock(p.root);
  expectCode("live lock excludes a concurrent writer", "lock-held", () => acquireMaintenanceLock(p.root));
  releaseMaintenanceLock(first);

  const stale = acquireMaintenanceLock(p.root, { owner: owner("stale") });
  expectCode("unknown stale owner fails closed", "lock-owner-ambiguous", () =>
    acquireMaintenanceLock(p.root, { ownerStatus: () => "unknown" }));
  const recovered = acquireMaintenanceLock(p.root, { ownerStatus: () => "dead" });
  expectCode("reaped holder cannot release its successor's lock", "lock-lost", () => releaseMaintenanceLock(stale));
  releaseMaintenanceLock(recovered);
}

{
  const p = project("stale-reaper");
  const stale = acquireMaintenanceLock(p.root, { owner: owner("stale-lock") });
  const paths = maintenancePaths(p.root);
  writeFileSync(paths.reaper, `${JSON.stringify({ token: "stale-reaper-token", owner: owner("stale-reaper") })}\n`, { mode: 0o600 });
  expectCode("dead crash-left reaper fails closed for manual single-operator recovery", "lock-owner-ambiguous", () =>
    acquireMaintenanceLock(p.root, { ownerStatus: () => "dead" }));
  check("stale reaper handling does not unlink the recorded lock", statExists(paths.lock));
  rmSync(paths.reaper);
  releaseMaintenanceLock(stale);
}

// Claims recover only after deadline, all three process owners are dead, and source identity matches.
{
  const p = ready("claim");
  const claim = {
    attemptId: "backup-1",
    deadline: new Date(1).toISOString(),
    coordinator: owner("coordinator"), owners: [owner("watchdog"), owner("broker")],
  };
  const claimed = claimMaintenanceReady(p.lock, claim);
  check("claim preserves resume descriptor", claimed.resume.sha256 === p.resume.sha256);
  expectCode("one live claim owner blocks stale recovery", "claim-live", () =>
    recoverStaleMaintenanceClaim(p.lock, { now: new Date(2), ownerStatus: (candidate) => candidate.id === "broker" ? "alive" : "dead" }));
  const recovered = recoverStaleMaintenanceClaim(p.lock, { now: new Date(2), ownerStatus: () => "dead" });
  check("dead stale claim returns to ready with resume descriptor",
    recovered.state === "ready" && recovered.resume.sha256 === p.resume.sha256);
  releaseMaintenanceLock(p.lock);
}

// The content-addressed resume descriptor is immutable across the complete restore state chain.
{
  const p = ready("resume-transitions");
  const claim = claimMaintenanceReady(p.lock, {
    attemptId: "resume-transition-claim", deadline: new Date(Date.now() + 60_000).toISOString(),
    coordinator: owner("coordinator"), owners: [owner("watchdog"), owner("broker")],
  });
  check("ready to claimed preserves resume", claim.resume.sha256 === p.resume.sha256);
  const released = releaseMaintenanceClaim(p.lock, "resume-transition-claim");
  check("claimed to ready preserves resume", released.resume.sha256 === p.resume.sha256);
  const targetPath = join(p.root, "target");
  const prepared = prepareAlternateRestore(p.lock, { attemptId: "resume-transition-restore", targetPath, claim: restoreClaim() });
  check("ready to restore-ready preserves resume", prepared.resume.sha256 === p.resume.sha256);
  mkdirSync(targetPath);
  const bound = bindRestoreTarget(p.lock);
  check("bound restore preserves resume", bound.resume.sha256 === p.resume.sha256);
  const intent = writeRestoreCommitIntent(p.lock, { server: "nats://127.0.0.1:4222", runtime: "pty" });
  check("commit intent preserves resume", intent.resume.sha256 === p.resume.sha256);
  const proof: RestoreListenerProof = {
    attemptId: "resume-transition-restore", serverName: "resume-transition-listener",
    serverNonce: "resume-transition-nonce", processOwner: owner("resume-transition-owner", process.pid),
    serverEndpoint: normalEndpoint, target: bound.restore.target!,
  };
  bindRestoreListener(p.lock, proof);
  const active = finalizeRestore(p.lock, proof);
  check("active restore preserves resume", active.resume.sha256 === p.resume.sha256);
  const degraded = markRestoreDegraded(p.lock, "test degradation", [
    { action: "repair", description: "Inspect the test restore.", paths: [targetPath, p.store] },
  ]);
  check("active-to-degraded restore preserves resume and repairable manager commit evidence",
    degraded.resume.sha256 === p.resume.sha256 &&
    degraded.managerCommit?.durableCommitToken === degraded.details?.managerCommit.durableCommitToken);
  const document = readMaintenanceResumeDocument(p.root, degraded.resume);
  check("degraded journal still verifies exact resume inventory", Array.isArray(document.inventory));
  const repaired = repairRestoreDegradedToActive(p.lock, proof, managerFinalize(proof.attemptId));
  check("finalized restore degradation repairs with the retained exact token",
    repaired.state === "active" &&
    repaired.managerCommit.durableCommitToken === repaired.details.managerFinalize.durableCommitToken);
  releaseMaintenanceLock(p.lock);
}

// A crash after ordinary resume intent preserves exact launch provenance and blocks every other path.
{
  const p = ready("ordinary-resume-intent");
  const source = readStoreIdentity(p.store);
  const intent = beginOrdinaryResume(p.lock, {
    attemptId: "ordinary-intent-1",
    launch: {
      host: "127.0.0.1", port: 4222, server: "nats://127.0.0.1:4222",
      runtime: "pty", detached: false, store: p.store,
    },
  });
  check("ordinary resume intent is fsynced with source, resume, and launch provenance",
    intent.state === "resume-intent" && sameStoreIdentity(intent.source, source) &&
    intent.resume.sha256 === p.resume.sha256 && intent.ordinaryResume.launch.runtime === "pty");
  releaseMaintenanceLock(p.lock);

  const recoveredLock = acquireMaintenanceLock(p.root);
  const recovered = readMaintenanceJournal(p.root) as OrdinaryResumeIntentRecord;
  check("crash recovery distinguishes resume-intent", recovered.state === "resume-intent" &&
    recovered.ordinaryResume.attemptId === "ordinary-intent-1");
  expectCode("backup refuses resume-intent", "invalid-transition", () =>
    claimMaintenanceReady(recoveredLock, {
      attemptId: "backup-during-resume", deadline: new Date(Date.now() + 60_000).toISOString(),
      coordinator: owner("c"), owners: [owner("w"), owner("b")],
    }));
  expectCode("restore refuses resume-intent", "invalid-transition", () =>
    prepareAlternateRestore(recoveredLock, { attemptId: "restore-during-resume", targetPath: join(p.root, "target"), claim: restoreClaim() }));
  expectCode("repeated ordinary up refuses resume-intent", "invalid-transition", () =>
    beginOrdinaryResume(recoveredLock, { attemptId: "second-resume", launch: {} }));
  expectCode("clean-style consumption refuses resume-intent", "invalid-transition", () =>
    consumeRetiredMaintenance(recoveredLock));
  const degraded = markOrdinaryResumeDegraded(recoveredLock, "listener exposure is unknown", [
    { action: "inspect", description: "Inspect the listener and retained principals before recovery.", paths: [p.store] },
    { action: "repair", description: "Recover forward without deleting source or resume inventory.", paths: [p.store] },
  ]);
  check("ambiguous intent becomes deterministic resume-degraded",
    degraded.state === "resume-degraded" && degraded.reason === "listener exposure is unknown" &&
    degraded.recourse.length === 2 && degraded.resume.sha256 === p.resume.sha256);
  check("degraded ordinary resume preserves source and inventory",
    sameStoreIdentity(source, readStoreIdentity(p.store)) &&
    Array.isArray(readMaintenanceResumeDocument(p.root, p.resume).inventory));
  releaseMaintenanceLock(recoveredLock);
}

{
  const p = ready("ordinary-resume-corrupt-intent");
  const intent = beginOrdinaryResume(p.lock, { attemptId: "strict-intent", launch: { runtime: "pty" } });
  const forged = {
    ...intent,
    ordinaryResume: { ...intent.ordinaryResume, attemptId: 123, intentAt: 0 },
  };
  writeFileSync(maintenancePaths(p.root).journal, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  expectCode("ordinary resume rejects numeric attempt id and intent timestamp", "journal-corrupt", () =>
    readMaintenanceJournal(p.root));
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("ordinary-resume-corrupt-active");
  beginOrdinaryResume(p.lock, { attemptId: "strict-active", launch: { runtime: "pty" } });
  const active = markOrdinaryResumeActive(p.lock, ordinaryActivation("strict-active"));
  const forged = { ...active, activeAt: 0 };
  writeFileSync(maintenancePaths(p.root).journal, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  expectCode("ordinary resume rejects numeric active timestamp", "journal-corrupt", () =>
    readMaintenanceJournal(p.root));
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("ordinary-resume-evidence");
  beginOrdinaryResume(p.lock, { attemptId: "ordinary-evidence", launch: { runtime: "pty" } });
  expectCode("empty ordinary activation cannot authorize active state", "activation-evidence-invalid", () =>
    markOrdinaryResumeActive(p.lock, {} as never));
  expectCode("foreign ordinary activation attempt is rejected", "activation-evidence-invalid", () =>
    markOrdinaryResumeActive(p.lock, ordinaryActivation("ordinary-foreign")));
  markOrdinaryResumeActive(p.lock, ordinaryActivation("ordinary-evidence"));
  expectCode("empty ordinary manager commit cannot authorize finalization", "activation-evidence-invalid", () =>
    recordOrdinaryResumeManagerCommit(p.lock, {} as never));
  expectCode("foreign manager commit cannot retire ordinary resume", "activation-evidence-invalid", () =>
    recordOrdinaryResumeManagerCommit(p.lock, managerCommit("ordinary-foreign")));
  expectCode("unretired active journal cannot be consumed", "invalid-transition", () =>
    consumeRetiredMaintenance(p.lock));
  check("wrong ordinary evidence leaves the active journal unconsumed",
    readMaintenanceJournal(p.root)?.state === "resume-active");
  releaseMaintenanceLock(p.lock);
}

// Retirement is a separate durable boundary; a crash before consumption is safely retryable.
{
  const p = ready("ordinary-resume-retirement");
  const source = readStoreIdentity(p.store);
  beginOrdinaryResume(p.lock, {
    attemptId: "ordinary-retire-1",
    launch: { server: "nats://127.0.0.1:4222", runtime: "pty", resumeAgents: true },
  });
  expectCode("ordinary resume cannot retire before activation", "invalid-transition", () =>
    retireOrdinaryResume(p.lock));
  const active = markOrdinaryResumeActive(p.lock, ordinaryActivation("ordinary-retire-1"));
  check("ordinary resume active retains provenance and activation result",
    active.state === "resume-active" && active.ordinaryResume.launch.runtime === "pty" &&
    active.activation.state === "awaitingCommit" && active.resume.sha256 === p.resume.sha256);
  const committed = recordOrdinaryResumeManagerCommit(p.lock, managerCommit("ordinary-retire-1"));
  check("manager commit publishes a durable resume-committed boundary",
    committed.state === "resume-committed" && committed.managerCommit.state === "awaitingFinalize" &&
    sameStoreIdentity(committed.source, source) && committed.resume.sha256 === p.resume.sha256 &&
    committed.cut.attemptId.startsWith("cut-") && committed.ordinaryResume.launch.runtime === "pty");
  const committedAgain = recordOrdinaryResumeManagerCommit(p.lock, managerCommit("ordinary-retire-1"));
  check("ordinary manager commit recording is idempotent",
    committedAgain.revision === committed.revision);
  expectCode("ordinary committed journal cannot be consumed before finalize", "invalid-transition", () =>
    consumeRetiredMaintenance(p.lock));
  releaseMaintenanceLock(p.lock);

  const finalizeLock = acquireMaintenanceLock(p.root);
  const recoveredCommit = readMaintenanceJournal(p.root);
  check("commit-before-finalize crash remains distinguishable with exact ordinary token evidence",
    recoveredCommit?.state === "resume-committed" &&
    recoveredCommit.managerCommit.durableCommitToken === "a".repeat(64));
  expectCode("ordinary finalize rejects a token mismatch", "activation-evidence-invalid", () =>
    retireOrdinaryResume(finalizeLock, managerFinalize("ordinary-retire-1", "b".repeat(64))));
  const retired = retireOrdinaryResume(finalizeLock, managerFinalize("ordinary-retire-1"));
  const retiredAgain = retireOrdinaryResume(finalizeLock, managerFinalize("ordinary-retire-1"));
  check("successful activation publishes terminal resume-retired",
    retired.state === "resume-retired" && retired.retirement.state === "active" &&
    retiredAgain.revision === retired.revision);
  releaseMaintenanceLock(finalizeLock);

  const recoveredLock = acquireMaintenanceLock(p.root);
  check("crash after retirement leaves a distinguishable terminal marker",
    readMaintenanceJournal(p.root)?.state === "resume-retired");
  expectCode("backup refuses unconsumed resume-retired", "invalid-transition", () =>
    claimMaintenanceReady(recoveredLock, {
      attemptId: "backup-before-consume", deadline: new Date(Date.now() + 60_000).toISOString(),
      coordinator: owner("c"), owners: [owner("w"), owner("b")],
    }));
  expectCode("restore refuses unconsumed resume-retired", "invalid-transition", () =>
    prepareAlternateRestore(recoveredLock, { attemptId: "restore-before-consume", targetPath: join(p.root, "target"), claim: restoreClaim() }));
  const consumed = consumeRetiredMaintenance(recoveredLock);
  check("retired consumption removes only the maintenance journal",
    consumed.state === "resume-retired" && readMaintenanceJournal(p.root) === undefined &&
    sameStoreIdentity(source, readStoreIdentity(p.store)) && statExists(maintenancePaths(p.root).resume));
  check("retired consumption preserves exact resume inventory",
    readMaintenanceResumeDocument(p.root, p.resume).version === 1);
  releaseMaintenanceLock(recoveredLock);
}

{
  const p = ready("ordinary-resume-active-degraded");
  beginOrdinaryResume(p.lock, { attemptId: "ordinary-active-degraded", launch: { runtime: "pty" } });
  const active = markOrdinaryResumeActive(p.lock, ordinaryActivation("ordinary-active-degraded"));
  const degraded = markOrdinaryResumeDegraded(p.lock, "principal activation incomplete", [
    { action: "repair", description: "Adopt or relaunch the exact retained principals.", paths: [p.store] },
  ]);
  check("active ambiguity preserves activation evidence in resume-degraded",
    degraded.state === "resume-degraded" && degraded.activeAt === active.activeAt &&
    degraded.activation?.state === "awaitingCommit");
  expectCode("degraded ordinary resume cannot be retired", "invalid-transition", () =>
    retireOrdinaryResume(p.lock));
  const repaired = markOrdinaryResumeActive(p.lock, ordinaryActivation("ordinary-active-degraded"));
  check("repaired degraded ordinary resume can recover forward to active",
    repaired.state === "resume-active" && repaired.activation.attemptId === "ordinary-active-degraded");
  recordOrdinaryResumeManagerCommit(p.lock, managerCommit("ordinary-active-degraded"));
  retireOrdinaryResume(p.lock, managerFinalize("ordinary-active-degraded"));
  consumeRetiredMaintenance(p.lock);
  releaseMaintenanceLock(p.lock);
}

// The same move-pending record has exactly two valid crash interpretations.
{
  const p = ready("rename-crash");
  const fallback = join(p.root, "store.fallback");
  const pending = prepareSamePathRestore(p.lock, { attemptId: "restore-crash", targetPath: p.store, fallbackPath: fallback, claim: restoreClaim() });
  check("pre-rename crash interprets as not moved", interpretPendingStoreMove(pending) === "not-moved");
  renameSync(p.store, fallback);
  check("post-rename crash interprets as moved", interpretPendingStoreMove(pending) === "moved");
  const moved = moveSamePathRestoreSource(p.lock);
  check("post-rename recovery publishes source-moved with resume descriptor",
    moved.phase === "source-moved" && moved.restore.previousSource?.kind === "fallback" &&
    moved.resume.sha256 === p.resume.sha256);
  rollbackRestore(p.lock, { asCoordinator: restoreCoordinator });
  check("rollback after recovered rename restores the original inode", sameStoreIdentity(moved.source, readStoreIdentity(p.store)));
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("rename-ambiguous");
  const fallback = join(p.root, "store.fallback");
  const pending = prepareSamePathRestore(p.lock, { attemptId: "restore-ambiguous", targetPath: p.store, fallbackPath: fallback, claim: restoreClaim() });
  mkdirSync(fallback);
  ensureStoreIdentity(fallback);
  expectCode("both move paths present fail closed", "ambiguous-filesystem-state", () => interpretPendingStoreMove(pending));
  releaseMaintenanceLock(p.lock);
}

// A complete pre-commit same-path attempt removes only its bound target and returns the fallback.
{
  const p = ready("rollback");
  const original = readStoreIdentity(p.store);
  const fallback = join(p.root, "store.fallback");
  prepareSamePathRestore(p.lock, { attemptId: "restore-rollback", targetPath: p.store, fallbackPath: fallback, claim: restoreClaim() });
  moveSamePathRestoreSource(p.lock);
  mkdirSync(p.store);
  bindRestoreTarget(p.lock);
  const target = readStoreIdentity(p.store);
  const result = rollbackRestore(p.lock, { asCoordinator: restoreCoordinator });
  check("pre-commit rollback returns ready with resume descriptor",
    result.state === "ready" && result.resume.sha256 === p.resume.sha256);
  check("pre-commit rollback restores exact original", sameStoreIdentity(original, readStoreIdentity(p.store)));
  check("pre-commit rollback removed the attempt target", !sameStoreIdentity(target, readStoreIdentity(p.store)));
  releaseMaintenanceLock(p.lock);
}

// A replacement at the canonical path is never accepted as the recorded source or missing-source consent.
{
  const p = ready("replacement");
  const displaced = join(p.root, "displaced");
  renameSync(p.store, displaced);
  mkdirSync(p.store);
  expectCode("ready source replacement fails identity validation", "identity-mismatch", () =>
    prepareSamePathRestore(p.lock, { attemptId: "bad", targetPath: p.store, fallbackPath: join(p.root, "fallback"), claim: restoreClaim() }));
  expectCode("missing-source flag cannot consent to a replacement", "identity-mismatch", () =>
    prepareMissingSourceRestore(p.lock, { attemptId: "bad-disaster", targetPath: p.store, claim: restoreClaim() }));
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("forged-move-pending");
  const original = readStoreIdentity(p.store);
  const pending = prepareSamePathRestore(p.lock, {
    attemptId: "forged-pending", targetPath: p.store, fallbackPath: join(p.root, "fallback"), claim: restoreClaim() });
  const forged = { ...pending, restore: { ...pending.restore, target: pending.source } };
  writeFileSync(maintenancePaths(p.root).journal, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  expectCode("forged move-pending target is rejected before cleanup", "journal-corrupt", () => rollbackRestore(p.lock, { asCoordinator: restoreCoordinator }));
  check("forged move-pending cannot delete the original", sameStoreIdentity(original, readStoreIdentity(p.store)));
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("forged-fallback-generation");
  const fallback = join(p.root, "fallback");
  prepareSamePathRestore(p.lock, { attemptId: "forged-generation", targetPath: p.store, fallbackPath: fallback, claim: restoreClaim() });
  const moved = moveSamePathRestoreSource(p.lock);
  const forged = {
    ...moved,
    restore: {
      ...moved.restore,
      previousSource: {
        ...moved.restore.previousSource!,
        identity: { ...moved.restore.previousSource!.identity, generation: "00000000-0000-4000-8000-000000000000" },
      },
    },
  };
  writeFileSync(maintenancePaths(p.root).journal, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  expectCode("forged fallback generation is rejected", "journal-corrupt", () => rollbackRestore(p.lock, { asCoordinator: restoreCoordinator }));
  check("generation mismatch preserves fallback", sameStoreIdentity(moved.restore.previousSource!.identity, readStoreIdentity(fallback)));
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("attempt-traversal");
  const target = join(p.root, "target");
  expectCode("attempt id traversal is rejected", "invalid-transition", () =>
    prepareAlternateRestore(p.lock, { attemptId: "../escape", targetPath: target, claim: restoreClaim() }));
  check("invalid attempt creates no target", !statExists(target));
  releaseMaintenanceLock(p.lock);
}

// Alternate target retains the source, and disaster mode requires the exact canonical path to be absent.
{
  const overlap = ready("alternate-overlap");
  expectCode("alternate target nested under retained source is rejected in workspace API", "invalid-path", () =>
    prepareAlternateRestore(overlap.lock, {
      attemptId: "alternate-nested-target", targetPath: join(overlap.store, "nested-target"), claim: restoreClaim() }));
  expectCode("alternate target ancestor containing retained source is rejected in workspace API", "invalid-path", () =>
    prepareAlternateRestore(overlap.lock, {
      attemptId: "alternate-ancestor-target", targetPath: overlap.root, claim: restoreClaim() }));
  check("overlap refusals leave the retained source unchanged",
    sameStoreIdentity(readMaintenanceJournal(overlap.root)!.source, readStoreIdentity(overlap.store)));
  releaseMaintenanceLock(overlap.lock);

  const alternate = ready("alternate", "open");
  const original = readStoreIdentity(alternate.store);
  const targetPath = join(alternate.root, "alternate-target");
  const retained = prepareAlternateRestore(alternate.lock, { attemptId: "alternate-1", targetPath, claim: restoreClaim() });
  check("alternate restore records source-retained", retained.phase === "source-retained" && sameStoreIdentity(original, retained.restore.previousSource!.identity));
  rollbackRestore(alternate.lock, { asCoordinator: restoreCoordinator });
  check("alternate rollback leaves source untouched", sameStoreIdentity(original, readStoreIdentity(alternate.store)));
  releaseMaintenanceLock(alternate.lock);

  const unbound = ready("alternate-unbound");
  const unboundTarget = join(unbound.root, "unbound-target");
  prepareAlternateRestore(unbound.lock, { attemptId: "alternate-unbound-1", targetPath: unboundTarget, claim: restoreClaim() });
  mkdirSync(unboundTarget);
  writeFileSync(join(unboundTarget, "not-ours"), "operator data", { mode: 0o600 });
  expectCode("unbound alternate target with content is preserved as ambiguous", "ambiguous-filesystem-state", () => rollbackRestore(unbound.lock, { asCoordinator: restoreCoordinator }));
  check("unbound non-empty target is never deleted as attempt-owned", statExists(join(unboundTarget, "not-ours")));
  rmSync(join(unboundTarget, "not-ours"));
  const emptied = rollbackRestore(unbound.lock, { asCoordinator: restoreCoordinator });
  check("an unbound EMPTY target is provably safe and removed on rollback",
    emptied.state === "ready" && !statExists(unboundTarget));
  releaseMaintenanceLock(unbound.lock);

  // The exact bindRestoreTarget crash gap: ensureStoreIdentity durably wrote the generation marker
  // but the bind journal write never happened. Recovery removes the marker-only target.
  const markerGap = ready("alternate-marker-gap");
  const markerTarget = join(markerGap.root, "marker-target");
  prepareAlternateRestore(markerGap.lock, { attemptId: "marker-gap-1", targetPath: markerTarget, claim: restoreClaim() });
  mkdirSync(markerTarget);
  ensureStoreIdentity(markerTarget);
  const markerRecovered = rollbackRestore(markerGap.lock, { asCoordinator: restoreCoordinator });
  check("an unbound target holding exactly the attempt's generation marker is removed on rollback",
    markerRecovered.state === "ready" && !statExists(markerTarget));
  releaseMaintenanceLock(markerGap.lock);

  const disaster = ready("disaster", "user");
  rmSync(disaster.store, { recursive: true });
  const missing = prepareMissingSourceRestore(disaster.lock, { attemptId: "disaster-1", targetPath: disaster.store, claim: restoreClaim() });
  check("explicit absent source records disaster phase", missing.phase === "disaster-source-missing");
  rollbackRestore(disaster.lock, { asCoordinator: restoreCoordinator });
  check("disaster rollback returns to inode-bound ready without inventing a source", readMaintenanceJournal(disaster.root)?.state === "ready");
  releaseMaintenanceLock(disaster.lock);
}

// Commit intent is the irreversible boundary: preserve both and expose deterministic recourse.
{
  const p = ready("preserve-both");
  const fallback = join(p.root, "store.fallback");
  prepareSamePathRestore(p.lock, { attemptId: "restore-commit", targetPath: p.store, fallbackPath: fallback, claim: restoreClaim() });
  moveSamePathRestoreSource(p.lock);
  mkdirSync(p.store);
  bindRestoreTarget(p.lock);
  writeRestoreCommitIntent(p.lock, { server: "nats://127.0.0.1:4222", runtime: "pty" });
  let rollbackError: unknown;
  try { rollbackRestore(p.lock, { asCoordinator: restoreCoordinator }); } catch (error) { rollbackError = error; }
  check("rollback after intent is forbidden with repair and cleanup recourse",
    isMaintenanceError(rollbackError) && rollbackError.code === "rollback-forbidden" &&
    rollbackError.details.recourse.map((item) => item.action).join(",") === "repair,cleanup");
  check("rollback refusal preserves restored target", Boolean(readStoreIdentity(p.store)));
  check("rollback refusal preserves fallback", Boolean(readStoreIdentity(fallback)));
  const degraded = markRestoreDegraded(p.lock, "listener readiness unknown", [
    { action: "repair", description: "Inspect listener and both stores.", paths: [p.store, fallback] },
  ]);
  check("commit ambiguity records degraded with both paths", degraded.state === "degraded" && degraded.recourse[0]?.paths?.length === 2);
  releaseMaintenanceLock(p.lock);
}

// Listener ownership survives the post-bind crash boundary and permits only exact recovery.
{
  const p = committedAlternate("restore-active-evidence", "restore-active-evidence-attempt");
  expectCode("restore manager commit refuses an unbound listener", "listener-proof-missing", () =>
    recordRestoreManagerCommit(p.lock, p.proof, managerCommit(p.proof.attemptId)));
  bindRestoreListener(p.lock, p.proof);
  expectCode("empty restore manager commit cannot authorize committed state", "activation-evidence-invalid", () =>
    recordRestoreManagerCommit(p.lock, p.proof, {} as never));
  expectCode("foreign restore manager commit attempt is rejected", "activation-evidence-invalid", () =>
    recordRestoreManagerCommit(p.lock, p.proof, managerCommit("restore-active-foreign")));
  expectCode("foreign restore listener proof is rejected at manager commit", "listener-proof-mismatch", () =>
    recordRestoreManagerCommit(
      p.lock,
      { ...p.proof, serverNonce: "forged-active-nonce" },
      managerCommit(p.proof.attemptId),
    ));
  const committed = recordRestoreManagerCommit(p.lock, p.proof, managerCommit(p.proof.attemptId));
  const committedAgain = recordRestoreManagerCommit(p.lock, p.proof, managerCommit(p.proof.attemptId));
  check("restore manager commit is durable and idempotent with complete provenance",
    committed.state === "manager-committed" && committedAgain.revision === committed.revision &&
    sameStoreIdentity(committed.source, readStoreIdentity(p.store)) && committed.resume.sha256 === p.resume.sha256 &&
    sameStoreIdentity(committed.restore.target, p.proof.target) &&
    committed.listenerProof.serverNonce === p.proof.serverNonce &&
    committed.cut.attemptId.startsWith("cut-") &&
    committed.managerCommit.durableCommitToken === "a".repeat(64));
  expectCode("manager-committed restore refuses pre-finalize cleanup", "cleanup-forbidden", () =>
    cleanupRestoreFallback(p.lock, p.proof.attemptId));
  expectCode("manager-committed restore refuses rollback", "rollback-forbidden", () =>
    rollbackRestore(p.lock, { asCoordinator: restoreCoordinator }));
  releaseMaintenanceLock(p.lock);

  const recoveredLock = acquireMaintenanceLock(p.root);
  check("commit-before-finalize crash remains distinguishable as manager-committed",
    readMaintenanceJournal(p.root)?.state === "manager-committed");
  expectCode("restore finalize rejects a token mismatch", "activation-evidence-invalid", () =>
    markRestoreActive(recoveredLock, p.proof, managerFinalize(p.proof.attemptId, "b".repeat(64))));
  const active = markRestoreActive(recoveredLock, p.proof, managerFinalize(p.proof.attemptId));
  const activeAgain = markRestoreActive(recoveredLock, p.proof, managerFinalize(p.proof.attemptId));
  check("exact finalize publishes active idempotently with commit and finalize evidence",
    activeAgain.revision === active.revision &&
    active.listenerProof?.serverNonce === p.proof.serverNonce &&
    active.details.managerCommit.attemptId === p.proof.attemptId &&
    active.details.managerFinalize.durableCommitToken === active.details.managerCommit.durableCommitToken);
  releaseMaintenanceLock(recoveredLock);
}

{
  const p = committedAlternate("listener-crash", "listener-crash-attempt");
  const bound = bindRestoreListener(p.lock, p.proof);
  check("post-spawn listener bind records attempt, nonce, owner, endpoint, and target",
    bound.listenerProof?.attemptId === p.proof.attemptId &&
    bound.listenerProof.serverNonce === p.proof.serverNonce &&
    bound.listenerProof.processOwner.pid === process.pid &&
    bound.listenerProof.serverEndpoint === p.proof.serverEndpoint &&
    sameStoreIdentity(bound.listenerProof.target, p.proof.target));
  releaseMaintenanceLock(p.lock);

  const recoveredLock = acquireMaintenanceLock(p.root);
  const recovered = readMaintenanceJournal(p.root);
  check("crash immediately after listener bind retains fsynced ownership proof",
    recovered?.state === "commit-intent" && recovered.listenerProof?.serverName === p.proof.serverName);
  markRestoreDegraded(recoveredLock, "crashed after listener bind", [
    { action: "repair", description: "Re-prove the exact bound listener.", paths: [p.store, p.targetPath] },
  ]);
  recordRestoreManagerCommit(recoveredLock, p.proof, managerCommit(p.proof.attemptId));
  markRestoreDegraded(recoveredLock, "crashed after manager commit", [
    { action: "repair", description: "Finalize the exact committed listener.", paths: [p.store, p.targetPath] },
  ]);
  const active = repairRestoreDegradedToActive(
    recoveredLock,
    p.proof,
    managerFinalize(p.proof.attemptId),
  );
  check("exact committed proof and finalize evidence repair degraded restore to active",
    active.state === "active" && active.listenerProof?.serverNonce === p.proof.serverNonce &&
    active.details.managerCommit.state === "awaitingFinalize");
  releaseMaintenanceLock(recoveredLock);
}

// A dead uncommitted listener is retired durably before a wholly fresh proof may be bound.
{
  const p = ready("listener-dead-replacement");
  const fallback = join(p.root, "store.fallback");
  prepareSamePathRestore(p.lock, {
    attemptId: "listener-dead-replacement-attempt", targetPath: p.store, fallbackPath: fallback, claim: restoreClaim() });
  moveSamePathRestoreSource(p.lock);
  mkdirSync(p.store);
  const target = bindRestoreTarget(p.lock).restore.target!;
  const launch = { server: "nats://127.0.0.1:4222", runtime: "pty", restoreOnly: "full" } as const;
  writeRestoreCommitIntent(p.lock, launch);
  const proof: RestoreListenerProof = {
    attemptId: "listener-dead-replacement-attempt",
    serverName: "listener-dead-replacement",
    serverNonce: "listener-dead-replacement-nonce",
    processOwner: owner("listener-dead-replacement-owner", process.pid),
    serverEndpoint: launch.server,
    target,
  };
  const bound = bindRestoreListener(p.lock, proof);
  const replaced = replaceDeadRestoreListener(p.lock, proof, { ownerStatus: () => "dead" });
  check("dead exact listener replacement returns durably to unbound commit intent",
    replaced.state === "commit-intent" && replaced.listenerProof === undefined &&
    replaced.listenerReplacements?.length === 1 &&
    replaced.listenerReplacements[0]?.generation === 1 &&
    replaced.listenerReplacements[0]?.proof.serverNonce === proof.serverNonce);
  check("listener replacement preserves resume, source, fallback, target, attempt, endpoint, and launch",
    replaced.resume.sha256 === bound.resume.sha256 && sameStoreIdentity(replaced.source, bound.source) &&
    replaced.restore.fallbackPath === fallback &&
    sameStoreIdentity(replaced.restore.previousSource!.identity, bound.restore.previousSource!.identity) &&
    sameStoreIdentity(replaced.restore.target, target) && replaced.restore.attemptId === proof.attemptId &&
    replaced.launch.server === launch.server && replaced.launch.runtime === launch.runtime &&
    replaced.launch.restoreOnly === launch.restoreOnly);
  expectCode("retired old listener proof cannot be rebound", "listener-proof-mismatch", () =>
    bindRestoreListener(p.lock, proof));
  const fresh = replacementProof(proof, "fresh");
  const rebound = bindRestoreListener(p.lock, fresh);
  check("fresh listener name, nonce, and process proof bind to the same attempt and target",
    rebound.listenerProof?.serverName === fresh.serverName &&
    rebound.listenerProof.serverNonce === fresh.serverNonce &&
    rebound.listenerProof.processOwner.id === fresh.processOwner.id &&
    rebound.listenerReplacements?.[0]?.proof.serverNonce === proof.serverNonce);
  const replacedAgain = replaceDeadRestoreListener(p.lock, fresh, { ownerStatus: () => "dead" });
  check("replacement generations retain the complete retired listener history",
    replacedAgain.listenerReplacements?.length === 2 &&
    replacedAgain.listenerReplacements[0]?.generation === 1 &&
    replacedAgain.listenerReplacements[1]?.generation === 2);
  expectCode("an earlier-generation proof remains retired after another replacement", "listener-proof-mismatch", () =>
    bindRestoreListener(p.lock, proof));
  expectCode("the immediately previous proof remains retired after another replacement", "listener-proof-mismatch", () =>
    bindRestoreListener(p.lock, fresh));
  bindRestoreListener(p.lock, replacementProof(fresh, "newest"));
  releaseMaintenanceLock(p.lock);
}

{
  const p = committedAlternate("listener-replacement-owner", "listener-replacement-owner-attempt");
  bindRestoreListener(p.lock, p.proof);
  expectCode("alive listener owner refuses replacement", "listener-owner-alive", () =>
    replaceDeadRestoreListener(p.lock, p.proof, { ownerStatus: () => "alive" }));
  expectCode("unknown listener owner refuses replacement", "listener-owner-ambiguous", () =>
    replaceDeadRestoreListener(p.lock, p.proof, { ownerStatus: () => "unknown" }));
  const unchanged = readMaintenanceJournal(p.root);
  check("alive and unknown refusals retain the exact bound listener",
    unchanged?.state === "commit-intent" && unchanged.listenerProof?.serverNonce === p.proof.serverNonce &&
    unchanged.listenerReplacements === undefined);
  releaseMaintenanceLock(p.lock);
}

{
  const p = committedAlternate("listener-replacement-target-drift", "listener-replacement-target-drift-attempt");
  bindRestoreListener(p.lock, p.proof);
  const displaced = join(p.root, "displaced-target");
  renameSync(p.targetPath, displaced);
  mkdirSync(p.targetPath);
  ensureStoreIdentity(p.targetPath);
  expectCode("target identity drift refuses dead listener replacement", "identity-mismatch", () =>
    replaceDeadRestoreListener(p.lock, p.proof, { ownerStatus: () => "dead" }));
  check("target drift replacement refusal preserves source, displaced target, and replacement",
    statExists(p.store) && sameStoreIdentity(readStoreIdentity(displaced), { ...p.proof.target, path: displaced }) &&
    statExists(p.targetPath));
  releaseMaintenanceLock(p.lock);
}

{
  const p = committedAlternate("listener-degraded-replacement", "listener-degraded-replacement-attempt");
  bindRestoreListener(p.lock, p.proof);
  markRestoreDegraded(p.lock, "listener exited during uncommitted recovery", [
    { action: "repair", description: "Replace only after proving listener death.", paths: [p.targetPath] },
  ]);
  const replaced = replaceDeadRestoreListener(p.lock, p.proof, { ownerStatus: () => "dead" });
  check("degraded dead listener replacement returns to commit intent without losing restore provenance",
    replaced.state === "commit-intent" && replaced.listenerProof === undefined &&
    replaced.listenerReplacements?.[0]?.generation === 1 && replaced.resume.sha256 === p.resume.sha256 &&
    sameStoreIdentity(replaced.source, readStoreIdentity(p.store)) &&
    sameStoreIdentity(replaced.restore.target, p.proof.target));
  const fresh = replacementProof(p.proof, "degraded-fresh");
  check("degraded replacement accepts a fresh proof for the unchanged attempt",
    bindRestoreListener(p.lock, fresh).listenerProof?.serverNonce === fresh.serverNonce);
  releaseMaintenanceLock(p.lock);
}

{
  const p = committedAlternate("listener-active-replacement", "listener-active-replacement-attempt");
  bindRestoreListener(p.lock, p.proof);
  recordRestoreManagerCommit(p.lock, p.proof, managerCommit(p.proof.attemptId));
  expectCode("manager-committed restore refuses listener replacement", "invalid-transition", () =>
    replaceDeadRestoreListener(p.lock, p.proof, { ownerStatus: () => "dead" }));
  check("replacement refusal retains manager-committed state and proof",
    readMaintenanceJournal(p.root)?.state === "manager-committed" &&
    readMaintenanceJournal(p.root)?.listenerProof?.serverNonce === p.proof.serverNonce);
  markRestoreDegraded(p.lock, "manager-committed listener degraded", [
    { action: "repair", description: "Repair the committed listener without replacing ownership." },
  ]);
  expectCode("degraded manager-committed restore still refuses listener replacement", "invalid-transition", () =>
    replaceDeadRestoreListener(p.lock, p.proof, { ownerStatus: () => "dead" }));
  repairRestoreDegradedToActive(p.lock, p.proof, managerFinalize(p.proof.attemptId));
  releaseMaintenanceLock(p.lock);
}

{
  const p = committedAlternate("listener-foreign", "listener-foreign-attempt");
  bindRestoreListener(p.lock, p.proof);
  markRestoreDegraded(p.lock, "listener identity uncertain", [
    { action: "repair", description: "Re-prove listener identity.", paths: [p.store, p.targetPath] },
  ]);
  recordRestoreManagerCommit(p.lock, p.proof, managerCommit(p.proof.attemptId));
  markRestoreDegraded(p.lock, "finalize requires exact listener identity", [
    { action: "repair", description: "Re-prove listener identity.", paths: [p.store, p.targetPath] },
  ]);
  expectCode("foreign listener name cannot repair degraded restore", "listener-proof-mismatch", () =>
    repairRestoreDegradedToActive(
      p.lock, { ...p.proof, serverName: "foreign-listener" }, managerFinalize(p.proof.attemptId),
    ));
  expectCode("foreign listener nonce cannot repair degraded restore", "listener-proof-mismatch", () =>
    repairRestoreDegradedToActive(
      p.lock, { ...p.proof, serverNonce: "foreign-nonce" }, managerFinalize(p.proof.attemptId),
    ));
  expectCode("listener pid mismatch cannot repair degraded restore", "listener-proof-mismatch", () =>
    repairRestoreDegradedToActive(p.lock, {
      ...p.proof,
      processOwner: { ...p.proof.processOwner, pid: process.pid + 1 },
    }, managerFinalize(p.proof.attemptId)));
  expectCode("missing caller proof cannot repair degraded restore", "listener-proof-invalid", () =>
    repairRestoreDegradedToActive(p.lock, undefined as never, managerFinalize(p.proof.attemptId)));
  expectCode("exact proof without activation evidence cannot repair degraded restore", "activation-evidence-invalid", () =>
    repairRestoreDegradedToActive(p.lock, p.proof, {} as never));
  check("foreign listener refusals preserve retained source and restore target",
    sameStoreIdentity(readStoreIdentity(p.store), readMaintenanceJournal(p.root)!.source) &&
    sameStoreIdentity(readStoreIdentity(p.targetPath), p.proof.target));
  releaseMaintenanceLock(p.lock);
}

{
  const p = committedAlternate("listener-no-proof", "listener-no-proof-attempt");
  markRestoreDegraded(p.lock, "spawn result unknown before proof bind", [
    { action: "inspect", description: "Preserve both stores.", paths: [p.store, p.targetPath] },
  ]);
  expectCode("degraded restore without recorded proof refuses reachability-only recovery", "listener-proof-missing", () =>
    repairRestoreDegradedToActive(p.lock, p.proof, managerFinalize(p.proof.attemptId)));
  check("no-proof refusal preserves both stores",
    statExists(p.store) && sameStoreIdentity(readStoreIdentity(p.targetPath), p.proof.target));
  releaseMaintenanceLock(p.lock);
}

{
  const p = committedAlternate("listener-target-drift", "listener-target-drift-attempt");
  bindRestoreListener(p.lock, p.proof);
  markRestoreDegraded(p.lock, "target ownership requires recovery", [
    { action: "inspect", description: "Verify target identity.", paths: [p.store, p.targetPath] },
  ]);
  const displacedTarget = join(p.root, "displaced-target");
  renameSync(p.targetPath, displacedTarget);
  mkdirSync(p.targetPath);
  ensureStoreIdentity(p.targetPath);
  expectCode("target identity drift refuses listener-proof recovery", "identity-mismatch", () =>
    repairRestoreDegradedToActive(p.lock, p.proof, managerFinalize(p.proof.attemptId)));
  check("target drift refusal preserves retained, displaced, and replacement stores",
    statExists(p.store) && sameStoreIdentity(readStoreIdentity(displacedTarget), {
      ...p.proof.target, path: displacedTarget,
    }) && statExists(p.targetPath));
  releaseMaintenanceLock(p.lock);
}

{
  const p = committedAlternate("listener-owner-ambiguous", "listener-owner-ambiguous-attempt");
  const bound = bindRestoreListener(p.lock, p.proof);
  markRestoreDegraded(p.lock, "owner host became ambiguous", [
    { action: "inspect", description: "Prove process ownership.", paths: [p.store, p.targetPath] },
  ]);
  const journal = readMaintenanceJournal(p.root)!;
  const ambiguousProof = {
    ...p.proof,
    processOwner: { ...p.proof.processOwner, host: "foreign.example" },
  };
  writeFileSync(maintenancePaths(p.root).journal, `${JSON.stringify({
    ...journal,
    listenerProof: ambiguousProof,
  })}\n`, { mode: 0o600 });
  expectCode("ambiguous process owner refuses otherwise exact listener recovery", "listener-owner-ambiguous", () =>
    repairRestoreDegradedToActive(p.lock, ambiguousProof, managerFinalize(p.proof.attemptId)));
  check("ambiguous owner refusal preserves both stores and degraded state",
    bound.listenerProof !== undefined && statExists(p.store) && statExists(p.targetPath) &&
    readMaintenanceJournal(p.root)?.state === "degraded");
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("commit-old-source-mismatch");
  const fallback = join(p.root, "store.fallback");
  prepareSamePathRestore(p.lock, { attemptId: "commit-mismatch", targetPath: p.store, fallbackPath: fallback, claim: restoreClaim() });
  moveSamePathRestoreSource(p.lock);
  mkdirSync(p.store);
  bindRestoreTarget(p.lock);
  const target = readStoreIdentity(p.store);
  renameSync(fallback, join(p.root, "fallback-moved-externally"));
  expectCode("commit intent refuses missing old source", "path-missing", () =>
    writeRestoreCommitIntent(p.lock, { server: "nats://127.0.0.1:4222" }));
  check("failed commit remains pre-commit", readMaintenanceJournal(p.root)?.state === "restore-ready");
  check("failed commit preserves target", sameStoreIdentity(target, readStoreIdentity(p.store)));
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("rollback-old-source-missing");
  const fallback = join(p.root, "store.fallback");
  prepareSamePathRestore(p.lock, { attemptId: "rollback-source-missing", targetPath: p.store, fallbackPath: fallback, claim: restoreClaim() });
  moveSamePathRestoreSource(p.lock);
  mkdirSync(p.store);
  bindRestoreTarget(p.lock);
  const target = readStoreIdentity(p.store);
  renameSync(fallback, join(p.root, "fallback-moved-externally"));
  expectCode("rollback refuses missing fallback before target cleanup", "path-missing", () => rollbackRestore(p.lock, { asCoordinator: restoreCoordinator }));
  check("missing fallback rollback preserves target", sameStoreIdentity(target, readStoreIdentity(p.store)));
  releaseMaintenanceLock(p.lock);
}

{
  const p = ready("rollback-retained-source-missing");
  const targetPath = join(p.root, "target");
  prepareAlternateRestore(p.lock, { attemptId: "rollback-retained-missing", targetPath, claim: restoreClaim() });
  mkdirSync(targetPath);
  bindRestoreTarget(p.lock);
  const target = readStoreIdentity(targetPath);
  renameSync(p.store, join(p.root, "source-moved-externally"));
  expectCode("alternate rollback refuses missing source before target cleanup", "path-missing", () => rollbackRestore(p.lock, { asCoordinator: restoreCoordinator }));
  check("missing retained source rollback preserves target", sameStoreIdentity(target, readStoreIdentity(targetPath)));
  releaseMaintenanceLock(p.lock);
}

// Healthy activation permits only explicit, identity-exact old-source cleanup; active target survives.
{
  const p = ready("cleanup");
  const fallback = join(p.root, "store.fallback");
  prepareSamePathRestore(p.lock, { attemptId: "restore-clean", targetPath: p.store, fallbackPath: fallback, claim: restoreClaim() });
  moveSamePathRestoreSource(p.lock);
  mkdirSync(p.store);
  bindRestoreTarget(p.lock);
  const target = readStoreIdentity(p.store);
  writeRestoreCommitIntent(p.lock, { server: "nats://127.0.0.1:4222" });
  const proof: RestoreListenerProof = {
    attemptId: "restore-clean", serverName: "restore-clean-listener", serverNonce: "restore-clean-nonce",
    processOwner: owner("restore-clean-owner", process.pid), serverEndpoint: normalEndpoint, target,
  };
  bindRestoreListener(p.lock, proof);
  finalizeRestore(p.lock, proof);
  const cleaned = cleanupRestoreFallback(p.lock, "restore-clean");
  check("explicit cleanup records previous-source completion", cleaned.restore.cleanup?.kind === "previous-source" && cleaned.restore.cleanup.status === "complete");
  check("explicit cleanup deletes fallback only", !exists(fallback) && sameStoreIdentity(target, readStoreIdentity(p.store)));
  check("healthy cleanup retires the restore journal for a later preserve cycle", readMaintenanceJournal(p.root) === undefined);
  expectCode("retired cleanup is not repeatable as arbitrary deletion", "journal-missing", () => cleanupRestoreFallback(p.lock, "restore-clean"));
  releaseMaintenanceLock(p.lock);
}

// Replacing the retained source before cleanup fails closed and preserves both the replacement and target.
{
  const p = ready("cleanup-mismatch");
  const targetPath = join(p.root, "target");
  prepareAlternateRestore(p.lock, { attemptId: "restore-mismatch", targetPath, claim: restoreClaim() });
  mkdirSync(targetPath);
  bindRestoreTarget(p.lock);
  const target = readStoreIdentity(targetPath);
  writeRestoreCommitIntent(p.lock, { server: "nats://127.0.0.1:4222" });
  const proof: RestoreListenerProof = {
    attemptId: "restore-mismatch", serverName: "restore-mismatch-listener", serverNonce: "restore-mismatch-nonce",
    processOwner: owner("restore-mismatch-owner", process.pid), serverEndpoint: normalEndpoint, target,
  };
  bindRestoreListener(p.lock, proof);
  finalizeRestore(p.lock, proof);
  renameSync(p.store, join(p.root, "old-source-moved-externally"));
  mkdirSync(p.store);
  expectCode("old-source replacement refuses cleanup", "identity-mismatch", () =>
    cleanupRestoreFallback(p.lock, "restore-mismatch"));
  check("cleanup mismatch preserves active target", sameStoreIdentity(target, readStoreIdentity(targetPath)));
  check("cleanup mismatch preserves replacement path", statExists(p.store));
  releaseMaintenanceLock(p.lock);
}

// Even a forged journal cannot turn old-source cleanup into recursive deletion of the active target.
{
  const p = committedAlternate("cleanup-containment", "cleanup-containment-attempt");
  bindRestoreListener(p.lock, p.proof);
  const active = finalizeRestore(p.lock, p.proof);
  const nestedTargetPath = join(p.store, "nested-active-target");
  renameSync(p.targetPath, nestedTargetPath);
  const nestedTarget = readStoreIdentity(nestedTargetPath);
  const forged = {
    ...active,
    restore: { ...active.restore, targetPath: nestedTargetPath, target: nestedTarget },
    listenerProof: { ...active.listenerProof!, target: nestedTarget },
  };
  writeFileSync(maintenancePaths(p.root).journal, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  expectCode("cleanup rejects a forged source tree containing the active target", "journal-corrupt", () =>
    cleanupRestoreFallback(p.lock, p.proof.attemptId));
  check("cleanup containment refusal preserves source and nested active target",
    sameStoreIdentity(readStoreIdentity(nestedTargetPath), nestedTarget) && statExists(p.store));
  releaseMaintenanceLock(p.lock);
}

// A live restore claim excludes every non-coordinator; recovery requires deadline + proven death.
{
  const p = ready("restore-claim-exclusion");
  const targetPath = join(p.root, "target");
  prepareAlternateRestore(p.lock, { attemptId: "claim-exclusion", targetPath, claim: restoreClaim() });
  expectCode("a non-coordinator cannot roll back a live restore claim", "claim-live", () =>
    rollbackRestore(p.lock));
  expectCode("a foreign coordinator identity cannot roll back a live claim", "claim-live", () =>
    rollbackRestore(p.lock, { asCoordinator: owner("foreign-coordinator", process.pid) }));
  expectCode("an elapsed deadline with an alive owner is still live", "claim-live", () =>
    rollbackRestore(p.lock, { now: new Date(Date.now() + 120_000) }));
  expectCode("an elapsed deadline with unproven owner death is ambiguous", "claim-owner-ambiguous", () =>
    rollbackRestore(p.lock, { now: new Date(Date.now() + 120_000), ownerStatus: () => "unknown" }));
  const journal = readMaintenanceJournal(p.root);
  check("refusals preserve the live restore-ready claim",
    journal?.state === "restore-ready" && journal.claim.coordinator.id === restoreCoordinator.id);
  const recovered = rollbackRestore(p.lock, { now: new Date(Date.now() + 120_000), ownerStatus: () => "dead" });
  check("a provably stale claim recovers by rollback to ready", recovered.state === "ready");
  releaseMaintenanceLock(p.lock);
}

// Recorded owners and attempt-owned trees ride the claim; recovery deletes exactly those inodes.
{
  const p = ready("restore-claim-resources");
  const targetPath = join(p.root, "target");
  const staging = join(p.root, "attempt-staging");
  mkdirSync(staging);
  const stagingStat = statSync(staging, { bigint: true });
  prepareAlternateRestore(p.lock, {
    attemptId: "claim-resources", targetPath,
    claim: restoreClaim(),
  });
  const updated = recordRestoreAttemptResources(p.lock, {
    owners: [owner("attempt-broker"), owner("attempt-watchdog")],
    ownedPaths: [{ label: "staging", path: staging, dev: stagingStat.dev.toString(), ino: stagingStat.ino.toString() }],
  });
  check("claim owners and owned paths are journaled for the live attempt",
    updated.claim.owners.length === 2 && updated.restore.ownedPaths?.length === 1);
  expectCode("an alive recorded broker owner blocks stale recovery", "claim-live", () =>
    rollbackRestore(p.lock, {
      now: new Date(Date.now() + 120_000),
      ownerStatus: (candidate) => candidate.id === "attempt-broker" ? "alive" : "dead",
    }));
  const replacement = join(p.root, "replacement-staging");
  renameSync(staging, replacement);
  mkdirSync(staging);
  rollbackRestore(p.lock, { now: new Date(Date.now() + 120_000), ownerStatus: () => "dead" });
  check("stale recovery deletes only the exact journaled inode, never a replacement",
    statExists(staging) && statExists(replacement));
  releaseMaintenanceLock(p.lock);

  const p2 = ready("restore-claim-resources-exact");
  const staging2 = join(p2.root, "attempt-staging");
  mkdirSync(staging2);
  const staging2Stat = statSync(staging2, { bigint: true });
  prepareAlternateRestore(p2.lock, {
    attemptId: "claim-resources-exact", targetPath: join(p2.root, "target"),
    claim: restoreClaim(),
  });
  recordRestoreAttemptResources(p2.lock, {
    ownedPaths: [{ label: "staging", path: staging2, dev: staging2Stat.dev.toString(), ino: staging2Stat.ino.toString() }],
  });
  rollbackRestore(p2.lock, { asCoordinator: restoreCoordinator });
  check("rollback removes the exact journaled attempt-owned tree", !statExists(staging2));
  releaseMaintenanceLock(p2.lock);
}

// A forged restore-ready record without a liveness claim is rejected outright.
{
  const p = ready("restore-claim-required");
  const targetPath = join(p.root, "target");
  prepareAlternateRestore(p.lock, { attemptId: "claim-required", targetPath, claim: restoreClaim() });
  const journal = readMaintenanceJournal(p.root)! as { claim?: unknown };
  const forged = { ...journal };
  delete forged.claim;
  writeFileSync(maintenancePaths(p.root).journal, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  expectCode("restore-ready without a claim is journal corruption", "journal-corrupt", () =>
    readMaintenanceJournal(p.root));
  releaseMaintenanceLock(p.lock);
}

// The cut-committed boundary recovers after coordinator death without a live manager.
{
  const p = project("cut-committed-recovery");
  const lock = acquireMaintenanceLock(p.root);
  const resume = writeMaintenanceResumeDocument(lock, {
    version: 1, inventory: [], launch: { server: normalEndpoint },
  });
  beginMaintenanceCut(lock, {
    attemptId: "cut-committed-1", space: "cut-committed", mode: "auth", sourcePath: p.store, resume,
    launch: { server: normalEndpoint },
  });
  recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId: "cut-committed-1", state: "preserved" });
  releaseMaintenanceLock(lock);

  const recoveredLock = acquireMaintenanceLock(p.root);
  const recovered = readMaintenanceJournal(p.root);
  check("crash after manager commitment recovers as durable cut-committed",
    recovered?.state === "cut-committed" && recovered.managerCommit.attemptId === "cut-committed-1");
  expectCode("backup refuses cut-committed", "invalid-transition", () =>
    claimMaintenanceReady(recoveredLock, {
      attemptId: "backup-cut-committed", deadline: new Date(Date.now() + 60_000).toISOString(),
      coordinator: owner("c"), owners: [owner("w"), owner("b")],
    }));
  const completed = completeMaintenanceCut(recoveredLock, cutCompletion("cut-committed-1"));
  check("cut-committed promotes to ready with exact stopped evidence and no live manager",
    completed.state === "ready");
  releaseMaintenanceLock(recoveredLock);
}

// The prepare intent binds the attempt BEFORE the manager fence and survives a coordinator crash.
{
  const p = project("prepare-intent");
  const lock = acquireMaintenanceLock(p.root);
  check("no prepare intent reads as undefined", readPreservationPrepareIntent(p.root) === undefined);
  writePreservationPrepareIntent(lock, {
    attemptId: "prepare-1", space: "prepare-space", mode: "auth", server: normalEndpoint, storeDir: p.store,
  });
  const intent = readPreservationPrepareIntent(p.root);
  check("prepare intent survives a crash with exact attempt and launch binding",
    intent?.attemptId === "prepare-1" && intent.space === "prepare-space" && intent.storeDir === p.store);
  const resume = writeMaintenanceResumeDocument(lock, {
    version: 1, inventory: [], launch: { server: normalEndpoint },
  });
  beginMaintenanceCut(lock, {
    attemptId: "prepare-1", space: "prepare-space", mode: "auth", sourcePath: p.store, resume,
    launch: { server: normalEndpoint },
  });
  expectCode("a stale prepare intent cannot be rewritten once a journal binds the attempt", "invalid-transition", () =>
    writePreservationPrepareIntent(lock, {
      attemptId: "prepare-2", space: "prepare-space", mode: "auth", server: normalEndpoint, storeDir: p.store,
    }));
  clearPreservationPrepareIntent(lock);
  check("cleared prepare intent reads as undefined again", readPreservationPrepareIntent(p.root) === undefined);
  clearPreservationPrepareIntent(lock);
  releaseMaintenanceLock(lock);
}

// The commit intent is written AFTER cut-intent but BEFORE the child-stopping RPC, so a crash in
// that window proves the stop may already have run and recovery must not delete the cut.
{
  const p = project("commit-intent");
  const lock = acquireMaintenanceLock(p.root);
  check("no commit intent reads as undefined", readPreservationCommitIntent(p.root) === undefined);
  expectCode("commit intent without a cut-intent journal is refused", "invalid-transition", () =>
    writePreservationCommitIntent(lock, { attemptId: "commit-1" }));
  const resume = writeMaintenanceResumeDocument(lock, { version: 1, inventory: [], launch: { server: normalEndpoint } });
  beginMaintenanceCut(lock, {
    attemptId: "commit-1", space: "commit-space", mode: "auth", sourcePath: p.store, resume,
    launch: { server: normalEndpoint },
  });
  expectCode("commit intent for a different attempt than the journal is refused", "invalid-transition", () =>
    writePreservationCommitIntent(lock, { attemptId: "commit-2" }));
  writePreservationCommitIntent(lock, { attemptId: "commit-1" });
  check("commit intent survives a crash and names the committing attempt",
    readPreservationCommitIntent(p.root)?.attemptId === "commit-1");
  clearPreservationCommitIntent(lock);
  check("cleared commit intent reads as undefined again", readPreservationCommitIntent(p.root) === undefined);
  clearPreservationCommitIntent(lock);
  releaseMaintenanceLock(lock);
}

// Backup stale-claim recovery deletes exactly the journaled clone/destination; a published artifact survives.
{
  const p = ready("backup-claim-owned");
  const clone = join(p.root, "attempt-clone");
  const incomplete = join(p.root, "incomplete-artifact");
  const published = join(p.root, "published-artifact");
  mkdirSync(clone);
  mkdirSync(incomplete);
  mkdirSync(published);
  writeFileSync(join(published, "manifest.json"), "{}\n", { mode: 0o600 });
  const identity = (path: string) => {
    const stat = statSync(path, { bigint: true });
    return { dev: stat.dev.toString(), ino: stat.ino.toString() };
  };
  claimMaintenanceReady(p.lock, {
    attemptId: "backup-owned", deadline: new Date(1).toISOString(),
    coordinator: owner("c"), owners: [owner("w"), owner("b")],
    ownedPaths: [
      { label: "clone", path: clone, ...identity(clone) },
      { label: "destination", path: incomplete, ...identity(incomplete) },
      { label: "destination", path: published, ...identity(published) },
    ],
  });
  recoverStaleMaintenanceClaim(p.lock, { now: new Date(2), ownerStatus: () => "dead" });
  check("stale backup recovery removes the journaled clone and incomplete destination",
    !statExists(clone) && !statExists(incomplete));
  check("stale backup recovery preserves a published artifact", statExists(join(published, "manifest.json")));
  releaseMaintenanceLock(p.lock);
}

// Ownership precedes existence: pending slots are journaled before creation, upgraded with the
// exact inode after, and recovery deletes only provable residue — else it keeps the claim.
{
  const p = ready("backup-claim-pending");
  const pendingDestination = join(p.root, "pending-destination");
  claimMaintenanceReady(p.lock, {
    attemptId: "backup-pending", deadline: new Date(1).toISOString(),
    coordinator: owner("c"), owners: [],
    ownedPaths: [
      { label: "clone", path: join(p.root, "never-created-clone") },
      { label: "destination", path: pendingDestination },
    ],
  });
  const grown = recordMaintenanceClaimResources(p.lock, { owners: [owner("late-broker")] });
  check("claim owners can be appended after proven spawn", grown.claim.owners.length === 1);
  mkdirSync(pendingDestination);
  writeFileSync(join(pendingDestination, `stream-${"a".repeat(24)}.snap`), "partial", { mode: 0o600 });
  writeFileSync(join(pendingDestination, "checkpoints.json"), "[]\n", { mode: 0o600 });
  writeFileSync(join(pendingDestination, "not-ours.txt"), "operator data", { mode: 0o600 });
  expectCode("a pending destination holding unrecognized content fails recovery closed", "cleanup-incomplete", () =>
    recoverStaleMaintenanceClaim(p.lock, { now: new Date(2), ownerStatus: () => "dead" }));
  check("failed cleanup KEEPS the claim as the residue's journal owner",
    readMaintenanceJournal(p.root)?.state === "claimed");
  rmSync(join(pendingDestination, "not-ours.txt"));
  const recovered = recoverStaleMaintenanceClaim(p.lock, { now: new Date(2), ownerStatus: () => "dead" });
  check("residue-only pending destination is removed and the absent pending clone is skipped",
    recovered.state === "ready" && !statExists(pendingDestination));
  releaseMaintenanceLock(p.lock);
}

// A pending slot upgraded with its inode replaces the pending entry rather than duplicating it.
{
  const p = ready("backup-claim-upgrade");
  const destination = join(p.root, "upgrade-destination");
  claimMaintenanceReady(p.lock, {
    attemptId: "backup-upgrade", deadline: new Date(Date.now() + 60_000).toISOString(),
    coordinator: owner("c"), owners: [],
    ownedPaths: [{ label: "destination", path: destination }],
  });
  mkdirSync(destination);
  const stat = statSync(destination, { bigint: true });
  const upgraded = recordMaintenanceClaimResources(p.lock, {
    ownedPaths: [{ label: "destination", path: destination, dev: stat.dev.toString(), ino: stat.ino.toString() }],
  });
  check("inode upgrade replaces the pending slot in place",
    upgraded.claim.ownedPaths?.length === 1 && upgraded.claim.ownedPaths[0]?.dev === stat.dev.toString());
  releaseMaintenanceClaim(p.lock, "backup-upgrade");
  releaseMaintenanceLock(p.lock);
}

function exists(path: string): boolean {
  try { readStoreIdentity(path); return true; } catch { return false; }
}

function statExists(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\nmaintenance (workspace) smoke: ${passed} checks passed`);
