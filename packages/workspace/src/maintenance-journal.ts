/** The maintenance journal: the shape validators for every persisted journal record and its evidence,
 *  listener custody proofs, the resume document, and the journal read/validate/write path that the
 *  maintenance operations in `maintenance.ts` drive. `maintenance.ts` re-exports every public name
 *  here, so importers keep their path. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  ATTEMPT_ID,
  type AttemptBrokerInstance,
  type AttemptOwnedPath,
  type CommitIntentRecord,
  type CompletedJournalBase,
  type ControllerCutBinding,
  type ControllerListenerInstance,
  type ControllerMember,
  type ControllerReconfiguration,
  type ControllerResumeBinding,
  type ControllerRole,
  type ControllerStartedMember,
  type ControllerStop,
  DURABLE_COMMIT_TOKEN,
  type JsonValue,
  type ListenerProof,
  MAINTENANCE_JOURNAL_VERSION,
  MAINTENANCE_RESUME_DOCUMENT_VERSION,
  MAX_MAINTENANCE_RESUME_BYTES,
  type MaintenanceCutCompletionEvidence,
  type MaintenanceCutContext,
  type MaintenanceJournal,
  type MaintenanceLock,
  type MaintenanceReadyRecord,
  type MaintenanceRecourse,
  type MaintenanceResumeDescriptor,
  type MaintenanceResumeDocument,
  type ManagerCommitEvidence,
  type ManagerFinalizeEvidence,
  type OrdinaryResumeActivationEvidence,
  type OrdinaryResumeContext,
  type OrdinaryResumeIntentRecord,
  type OrdinaryResumeRecord,
  type PinnedProcess,
  type PreservedStop,
  type PreservedStopAttempt,
  type ProcessOwner,
  type RestoreActivationEvidence,
  type RestoreActiveRecord,
  type RestoreClaim,
  type RestoreContext,
  type RestoreDegradedRecord,
  type RestoreListenerReplacement,
  type RestoreManagerCommittedRecord,
  type RestoreReadyRecord,
  type StoreIdentity,
  type TokenHandoff,
  assertLock,
  atomicWrite,
  ensureLayout,
  errno,
  fsyncDirectory,
  isMaintenanceError,
  localProcessOwnerStatus,
  maintenanceError,
  maintenancePaths,
  parseOwner,
  pathContains,
  sameStoreIdentity,
  writePrivateExclusive,
  assertStoreIdentity,
} from "./maintenance-foundation.js";

function validIdentity(value: unknown): value is StoreIdentity {
  const identity = value as StoreIdentity;
  return Boolean(identity && typeof identity === "object" && isAbsolute(identity.path) &&
    typeof identity.dev === "string" && /^\d+$/.test(identity.dev) &&
    typeof identity.ino === "string" && /^\d+$/.test(identity.ino) &&
    typeof identity.generation === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.generation));
}

export function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",") &&
    Reflect.ownKeys(value).length === expected.length;
}

export function canonicalListenerEndpoint(value: string): string | undefined {
  if (!value || Buffer.byteLength(value) > 2048) return undefined;
  try {
    const endpoint = new URL(value);
    if (!["nats:", "tls:"].includes(endpoint.protocol) || !endpoint.hostname ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        (endpoint.pathname && endpoint.pathname !== "/")) return undefined;
    const port = endpoint.port || "4222";
    const canonical = `${endpoint.protocol}//${endpoint.hostname.toLowerCase()}:${port}`;
    return value === canonical ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function validProofOwner(value: unknown): value is ProcessOwner {
  const owner = value as ProcessOwner;
  return Boolean(owner && typeof owner === "object" &&
    exactObjectKeys(owner, ["pid", "host", "startedAt", "id"]) &&
    Number.isInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.host === "string" && Buffer.byteLength(owner.host) <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(owner.host) &&
    typeof owner.startedAt === "string" && owner.startedAt.length <= 64 &&
    Number.isFinite(Date.parse(owner.startedAt)) &&
    typeof owner.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(owner.id));
}

function validProofIdentity(value: unknown): value is StoreIdentity {
  return Boolean(value && typeof value === "object" &&
    exactObjectKeys(value, ["path", "dev", "ino", "generation"]) && validIdentity(value));
}

const LISTENER_PROOF_KEYS = ["attemptId", "serverName", "serverNonce", "processOwner", "serverEndpoint", "target"] as const;
/** The service layer's full assigned id (`serviceOperationId`), repeated here because this module
 *  reports through its own maintenance error and must not import the adapter layer. */
const SERVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validControllerListenerInstance(value: unknown, owner: ProcessOwner): value is ControllerListenerInstance {
  const instance = value as ControllerListenerInstance;
  const pinned = instance?.process as { pid?: unknown; token?: unknown } | undefined;
  // The creation token is opaque (pid.ts): a macOS token carries spaces, so only its frame is checked.
  return Boolean(instance && typeof instance === "object" &&
    exactObjectKeys(instance, ["instanceId", "launchRequestId", "process"]) &&
    typeof instance.instanceId === "string" && SERVICE_ID.test(instance.instanceId) &&
    typeof instance.launchRequestId === "string" && SERVICE_ID.test(instance.launchRequestId) &&
    pinned && typeof pinned === "object" && exactObjectKeys(pinned, ["pid", "token"]) &&
    Number.isInteger(pinned.pid) && Number(pinned.pid) > 0 &&
    typeof pinned.token === "string" && pinned.token !== "" && pinned.token.trim() === pinned.token &&
    pinned.token.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(pinned.token) &&
    owner.pid === pinned.pid && owner.id === `controller-broker-${instance.launchRequestId}`);
}

function validListenerProof(value: unknown): value is ListenerProof {
  const proof = value as ListenerProof;
  const controller = Boolean(proof && typeof proof === "object" && (proof as { kind?: unknown }).kind !== undefined);
  return Boolean(proof && typeof proof === "object" &&
    (controller
      ? exactObjectKeys(proof, ["kind", ...LISTENER_PROOF_KEYS, "instance"]) && proof.kind === "controller"
      : exactObjectKeys(proof, LISTENER_PROOF_KEYS)) &&
    typeof proof.attemptId === "string" && ATTEMPT_ID.test(proof.attemptId) &&
    typeof proof.serverName === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(proof.serverName) &&
    typeof proof.serverNonce === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(proof.serverNonce) &&
    validProofOwner(proof.processOwner) && typeof proof.serverEndpoint === "string" &&
    canonicalListenerEndpoint(proof.serverEndpoint) === proof.serverEndpoint && validProofIdentity(proof.target) &&
    (!controller || validControllerListenerInstance(proof.instance, proof.processOwner)) &&
    Buffer.byteLength(JSON.stringify(proof)) <= 16 * 1024);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

export function validManagerCommitEvidence(value: unknown, attemptId: string): value is ManagerCommitEvidence {
  const evidence = value as ManagerCommitEvidence;
  return Boolean(evidence && typeof evidence === "object" &&
    exactObjectKeys(evidence, ["attemptId", "state", "durableCommitToken"]) &&
    evidence.attemptId === attemptId && evidence.state === "awaitingFinalize" &&
    typeof evidence.durableCommitToken === "string" && DURABLE_COMMIT_TOKEN.test(evidence.durableCommitToken));
}

export function validManagerFinalizeEvidence(
  value: unknown,
  attemptId: string,
  durableCommitToken: string,
): value is ManagerFinalizeEvidence {
  const evidence = value as ManagerFinalizeEvidence;
  return Boolean(evidence && typeof evidence === "object" &&
    exactObjectKeys(evidence, ["attemptId", "state", "durableCommitToken"]) &&
    evidence.attemptId === attemptId && evidence.state === "active" &&
    evidence.durableCommitToken === durableCommitToken && DURABLE_COMMIT_TOKEN.test(evidence.durableCommitToken));
}

export function sameManagerCommitEvidence(a: ManagerCommitEvidence, b: ManagerCommitEvidence): boolean {
  return a.attemptId === b.attemptId && a.state === b.state &&
    a.durableCommitToken === b.durableCommitToken;
}

export function sameManagerFinalizeEvidence(a: ManagerFinalizeEvidence, b: ManagerFinalizeEvidence): boolean {
  return a.attemptId === b.attemptId && a.state === b.state &&
    a.durableCommitToken === b.durableCommitToken;
}

export function validRestoreActivationEvidence(value: unknown, attemptId: string): value is RestoreActivationEvidence {
  const evidence = value as RestoreActivationEvidence;
  return Boolean(evidence && typeof evidence === "object" &&
    exactObjectKeys(evidence, ["attemptId", "listenerReady", "observedAt", "managerCommit", "managerFinalize"]) &&
    evidence.attemptId === attemptId && evidence.listenerReady === true && validTimestamp(evidence.observedAt) &&
    validManagerCommitEvidence(evidence.managerCommit, attemptId) &&
    validManagerFinalizeEvidence(evidence.managerFinalize, attemptId, evidence.managerCommit.durableCommitToken));
}

export function validOrdinaryResumeActivationEvidence(
  value: unknown,
  attemptId: string,
): value is OrdinaryResumeActivationEvidence {
  const evidence = value as OrdinaryResumeActivationEvidence;
  return Boolean(evidence && typeof evidence === "object" &&
    exactObjectKeys(evidence, ["operation", "attemptId", "state", "observedAt"]) &&
    evidence.operation === "resumePreserved" && evidence.attemptId === attemptId &&
    evidence.state === "awaitingCommit" && validTimestamp(evidence.observedAt));
}

function validAttemptOwnedPath(value: unknown): value is AttemptOwnedPath {
  const owned = value as AttemptOwnedPath;
  if (!owned || typeof owned !== "object") return false;
  const pending = exactObjectKeys(owned, ["label", "path"]);
  if (!pending && !exactObjectKeys(owned, ["label", "path", "dev", "ino"])) return false;
  if (!["clone", "destination", "staging", "quarantine", "sanitized", "config"].includes(owned.label) ||
      typeof owned.path !== "string" || !isAbsolute(owned.path)) return false;
  if (pending) return true;
  return typeof owned.dev === "string" && /^\d+$/.test(owned.dev) &&
    typeof owned.ino === "string" && /^\d+$/.test(owned.ino);
}

export function validOwnedPaths(value: unknown): value is readonly AttemptOwnedPath[] {
  return Array.isArray(value) && value.length <= 64 && value.every(validAttemptOwnedPath) &&
    new Set(value.map((owned: AttemptOwnedPath) => owned.path)).size === value.length;
}

export function validRestoreClaim(value: unknown): value is RestoreClaim {
  const claim = value as RestoreClaim;
  if (!claim || typeof claim !== "object" || !exactObjectKeys(claim, ["deadline", "coordinator", "owners"]))
    return false;
  if (typeof claim.deadline !== "string" || !Number.isFinite(Date.parse(claim.deadline))) return false;
  if (!validProofOwner(claim.coordinator)) return false;
  return Array.isArray(claim.owners) && claim.owners.length <= 16 && claim.owners.every(validProofOwner);
}

function validCutContext(value: unknown): value is MaintenanceCutContext {
  const cut = value as MaintenanceCutContext;
  return Boolean(cut && typeof cut === "object" && exactObjectKeys(cut, ["attemptId", "intentAt", "launch"]) &&
    typeof cut.attemptId === "string" && ATTEMPT_ID.test(cut.attemptId) && validTimestamp(cut.intentAt) &&
    validJsonObject(cut.launch) && typeof cut.launch.server === "string" &&
    canonicalListenerEndpoint(cut.launch.server) === cut.launch.server &&
    (cut.launch.custody === undefined ? cut.launch.controller === undefined
      : cut.launch.custody === "legacy" ? cut.launch.controller === undefined
        : cut.launch.custody === "controller" && validControllerCutBinding(cut.launch.controller)));
}

const CONTROLLER_ROLES: readonly ControllerRole[] = ["broker", "auth", "delivery", "manager"];
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A protected local record revision (protected-records.ts mints a UUID; older records are text). */
const DEFINITION_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFINITION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validPinnedProcess(value: unknown): value is PinnedProcess {
  const pinned = value as { pid?: unknown; token?: unknown } | undefined;
  return Boolean(pinned && typeof pinned === "object" && exactObjectKeys(pinned, ["pid", "token"]) &&
    Number.isInteger(pinned.pid) && Number(pinned.pid) > 0 &&
    typeof pinned.token === "string" && pinned.token !== "" && pinned.token.trim() === pinned.token &&
    pinned.token.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(pinned.token));
}

function validControllerMember(value: unknown): value is ControllerMember {
  const member = value as ControllerMember;
  return Boolean(member && typeof member === "object" &&
    exactObjectKeys(member, ["role", "definition", "definitionRevision", "instanceId", "launchRequestId", "process"]) &&
    CONTROLLER_ROLES.includes(member.role) &&
    typeof member.definition === "string" && DEFINITION_NAME.test(member.definition) &&
    typeof member.definitionRevision === "string" && DEFINITION_REVISION.test(member.definitionRevision) &&
    typeof member.instanceId === "string" && SERVICE_ID.test(member.instanceId) &&
    typeof member.launchRequestId === "string" && SERVICE_ID.test(member.launchRequestId) &&
    validPinnedProcess(member.process));
}

/** Members are unique by role and instance, and always include the broker and the manager. The
 *  broker member keeps its cut-time revision; only `brokerDefinitionRevision` is rebound by a
 *  restore rollback, so the two are not compared here. */
function validControllerCutBinding(value: unknown): value is ControllerCutBinding {
  const binding = value as ControllerCutBinding;
  const manager = binding?.manager as { instanceId?: unknown; epoch?: unknown; lifecycleUid?: unknown } | undefined;
  if (!binding || typeof binding !== "object" ||
      !exactObjectKeys(binding, ["stackOperationId", "brokerDefinitionRevision", "members", "manager"]) ||
      typeof binding.stackOperationId !== "string" || !SERVICE_ID.test(binding.stackOperationId) ||
      typeof binding.brokerDefinitionRevision !== "string" || !DEFINITION_REVISION.test(binding.brokerDefinitionRevision) ||
      !Array.isArray(binding.members) || binding.members.length < 2 || binding.members.length > CONTROLLER_ROLES.length ||
      !binding.members.every(validControllerMember) ||
      !manager || typeof manager !== "object" || !exactObjectKeys(manager, ["instanceId", "epoch", "lifecycleUid"]) ||
      typeof manager.instanceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(manager.instanceId) ||
      !Number.isSafeInteger(manager.epoch) || Number(manager.epoch) < 0 ||
      typeof manager.lifecycleUid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(manager.lifecycleUid))
    return false;
  const roles = binding.members.map((member) => member.role);
  const broker = binding.members.find((member) => member.role === "broker");
  return new Set(roles).size === roles.length && roles.includes("manager") && Boolean(broker) &&
    new Set(binding.members.map((member) => member.instanceId)).size === binding.members.length;
}

/** The cut's controller binding, or undefined for a legacy cut. The journal reader has validated it. */
export function cutController(cut: MaintenanceCutContext): ControllerCutBinding | undefined {
  return cut.launch.custody === "controller" ? cut.launch.controller as unknown as ControllerCutBinding : undefined;
}

function validControllerStop(value: unknown, members: readonly ControllerMember[]): value is ControllerStop {
  const stop = value as ControllerStop;
  if (!stop || typeof stop !== "object" || !exactObjectKeys(stop, ["role", "instanceId", "launchRequestId", "receipt"]))
    return false;
  const member = members.find((row) => row.role === stop.role);
  if (!member || member.instanceId !== stop.instanceId || member.launchRequestId !== stop.launchRequestId) return false;
  const receipt = stop.receipt as { kind?: unknown; requestId?: unknown; scopeSha256?: unknown; observedAt?: unknown };
  const kind = stop.role === "manager" ? "preserved-exit" : stop.role === "broker" ? "kernel-exit" : "process-exit";
  const scoped = kind !== "process-exit";
  return Boolean(receipt && typeof receipt === "object" &&
    exactObjectKeys(receipt, scoped ? ["kind", "requestId", "scopeSha256", "observedAt"] : ["kind", "requestId", "observedAt"]) &&
    receipt.kind === kind && typeof receipt.requestId === "string" && SERVICE_ID.test(receipt.requestId) &&
    (!scoped || typeof receipt.scopeSha256 === "string" && SHA256_HEX.test(receipt.scopeSha256)) &&
    validTimestamp(receipt.observedAt));
}

/** One row per cut member, in any order, with the receipt kind its role requires. */
function validControllerStops(value: unknown, binding: ControllerCutBinding): value is readonly ControllerStop[] {
  return Array.isArray(value) && value.length === binding.members.length &&
    value.every((stop) => validControllerStop(stop, binding.members)) &&
    new Set(value.map((stop: ControllerStop) => stop.role)).size === value.length;
}

function validPreservedStop(value: unknown, cut: MaintenanceCutContext, binding: ControllerCutBinding): value is PreservedStop {
  const stop = value as PreservedStop;
  const manager = binding.members.find((member) => member.role === "manager")!;
  if (!stop || typeof stop !== "object" || !exactObjectKeys(stop, ["instanceId", "launchRequestId", "attempts"]) ||
      stop.instanceId !== manager.instanceId || stop.launchRequestId !== manager.launchRequestId ||
      !Array.isArray(stop.attempts) || stop.attempts.length < 1 || stop.attempts.length > 16)
    return false;
  // An unpublished attempt at any position is prepublication history.
  return stop.attempts.every((attempt) => {
    const row = attempt as PreservedStopAttempt & { preserved?: { attemptId?: unknown; inventorySha256?: unknown } };
    const published = exactObjectKeys(row, ["requestId", "target", "stopper", "withAgents", "scopeSha256", "preserved", "recordedAt", "published"]);
    return Boolean((published || exactObjectKeys(row, ["requestId", "target", "stopper", "withAgents", "scopeSha256", "preserved", "recordedAt"])) &&
      (!published || row.published === true) &&
      typeof row.requestId === "string" && SERVICE_ID.test(row.requestId) &&
      validPinnedProcess(row.target) && row.target.pid === manager.process.pid && row.target.token === manager.process.token &&
      validPinnedProcess(row.stopper) && row.withAgents === false &&
      typeof row.scopeSha256 === "string" && SHA256_HEX.test(row.scopeSha256) &&
      row.preserved && typeof row.preserved === "object" && exactObjectKeys(row.preserved, ["attemptId", "inventorySha256"]) &&
      row.preserved.attemptId === cut.attemptId &&
      typeof row.preserved.inventorySha256 === "string" && SHA256_HEX.test(row.preserved.inventorySha256) &&
      validTimestamp(row.recordedAt));
  }) && new Set(stop.attempts.map((attempt) => attempt.requestId)).size === stop.attempts.length;
}

/** A rollback rebound the broker revision away from the one the cut's broker record runs at, so that
 *  record can never start again (`startProcessService` refuses a revision mismatch). */
export function cutBrokerRetired(cut: ControllerCutBinding): boolean {
  return cut.members.find((member) => member.role === "broker")!.definitionRevision !== cut.brokerDefinitionRevision;
}

export function validAttemptBroker(value: unknown, cut: ControllerCutBinding): value is AttemptBrokerInstance {
  const broker = value as AttemptBrokerInstance;
  return Boolean(broker && typeof broker === "object" && exactObjectKeys(broker, ["instanceId", "launchRequestId"]) &&
    typeof broker.instanceId === "string" && SERVICE_ID.test(broker.instanceId) &&
    typeof broker.launchRequestId === "string" && SERVICE_ID.test(broker.launchRequestId) &&
    broker.instanceId !== cut.members.find((member) => member.role === "broker")!.instanceId);
}

function validControllerResumeBinding(value: unknown, cut: ControllerCutBinding): value is ControllerResumeBinding {
  const binding = value as ControllerResumeBinding;
  if (!binding || typeof binding !== "object" ||
      !exactObjectKeys(binding, binding.broker === undefined ? ["stackOperationId", "started"] : ["stackOperationId", "started", "broker"]) ||
      binding.broker !== undefined && (!cutBrokerRetired(cut) || !validAttemptBroker(binding.broker, cut)) ||
      typeof binding.stackOperationId !== "string" || !SERVICE_ID.test(binding.stackOperationId) ||
      binding.stackOperationId === cut.stackOperationId ||
      !Array.isArray(binding.started) || binding.started.length > 64)
    return false;
  return binding.started.every((value) => {
    const row = value as ControllerStartedMember;
    const keys = ["role", "instanceId", "priorLaunchRequestId", "state"];
    const settled = row?.launchRequestId !== undefined || row?.outcome !== undefined;
    return Boolean(row && typeof row === "object" &&
      exactObjectKeys(row, settled ? [...keys, "launchRequestId", "outcome"] : keys) &&
      CONTROLLER_ROLES.includes(row.role) && row.state === "requested" &&
      typeof row.instanceId === "string" && SERVICE_ID.test(row.instanceId) &&
      typeof row.priorLaunchRequestId === "string" && SERVICE_ID.test(row.priorLaunchRequestId) &&
      (!settled || typeof row.launchRequestId === "string" && SERVICE_ID.test(row.launchRequestId) &&
        row.launchRequestId !== row.priorLaunchRequestId &&
        ["running", "refused-before-spawn", "unknown"].includes(String(row.outcome))));
  });
}

/** The resume's controller binding, or undefined for a legacy resume. The journal reader has validated it. */
export function ordinaryResumeController(context: OrdinaryResumeContext): ControllerResumeBinding | undefined {
  return context.launch.custody === "controller" ? context.launch.controller as unknown as ControllerResumeBinding : undefined;
}

function validTokenHandoff(value: unknown, handoffDir: string, attemptId: string): value is TokenHandoff {
  const handoff = value as TokenHandoff;
  if (!handoff || typeof handoff !== "object") return false;
  const pinned = handoff.dev !== undefined || handoff.ino !== undefined || handoff.sha256 !== undefined;
  if (!exactObjectKeys(handoff, pinned ? ["path", "state", "dev", "ino", "sha256"] : ["path", "state"])) return false;
  if (typeof handoff.path !== "string" || dirname(handoff.path) !== handoffDir ||
      !new RegExp(`^resume-commit\\.${attemptId}\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(basename(handoff.path)))
    return false;
  // `intended` never has an inode; `written` always has one; consumed or swept keep it when it was written.
  if (handoff.state === "intended") return !pinned;
  if (!["written", "consumed", "swept"].includes(handoff.state)) return false;
  if (handoff.state === "written" && !pinned) return false;
  return !pinned || (typeof handoff.dev === "string" && /^\d+$/.test(handoff.dev) &&
    typeof handoff.ino === "string" && /^\d+$/.test(handoff.ino) &&
    typeof handoff.sha256 === "string" && SHA256_HEX.test(handoff.sha256));
}

function validControllerReconfiguration(value: unknown, restore: RestoreContext, binding: ControllerCutBinding): value is ControllerReconfiguration {
  const reconfiguration = value as ControllerReconfiguration;
  if (!reconfiguration || typeof reconfiguration !== "object") return false;
  const keys = ["fromRevision", "fromOptionsSha256", "fromConfigPath", "fromConfigSha256", "toConfigPath", "toConfigSha256", "toStoreIdentity", "phase"];
  const phase = reconfiguration.phase;
  const expected = phase === "rendered" ? keys
    : phase === "definition-committed" || phase === "rolling-back" ? [...keys, "toRevision"]
      : phase === "rolled-back" ? [...keys, "toRevision", "rollbackRevision"] : undefined;
  return Boolean(expected && exactObjectKeys(reconfiguration, expected) &&
    typeof reconfiguration.fromRevision === "string" && DEFINITION_REVISION.test(reconfiguration.fromRevision) &&
    typeof reconfiguration.fromOptionsSha256 === "string" && SHA256_HEX.test(reconfiguration.fromOptionsSha256) &&
    typeof reconfiguration.fromConfigPath === "string" && isAbsolute(reconfiguration.fromConfigPath) &&
    reconfiguration.fromConfigPath !== reconfiguration.toConfigPath &&
    typeof reconfiguration.fromConfigSha256 === "string" && SHA256_HEX.test(reconfiguration.fromConfigSha256) &&
    typeof reconfiguration.toConfigPath === "string" && isAbsolute(reconfiguration.toConfigPath) &&
    restore.ownedPaths?.some((owned) => owned.label === "config" && owned.path === reconfiguration.toConfigPath) &&
    typeof reconfiguration.toConfigSha256 === "string" && SHA256_HEX.test(reconfiguration.toConfigSha256) &&
    validIdentity(reconfiguration.toStoreIdentity) && reconfiguration.toStoreIdentity.path === restore.targetPath &&
    (restore.target === undefined || sameStoreIdentity(reconfiguration.toStoreIdentity, restore.target)) &&
    (reconfiguration.toRevision === undefined ||
      typeof reconfiguration.toRevision === "string" && DEFINITION_REVISION.test(reconfiguration.toRevision) &&
      reconfiguration.toRevision !== reconfiguration.fromRevision) &&
    (reconfiguration.rollbackRevision === undefined ||
      typeof reconfiguration.rollbackRevision === "string" && DEFINITION_REVISION.test(reconfiguration.rollbackRevision) &&
      reconfiguration.rollbackRevision !== reconfiguration.fromRevision && reconfiguration.rollbackRevision !== reconfiguration.toRevision &&
      reconfiguration.rollbackRevision === binding.brokerDefinitionRevision) &&
    // Before a rollback the cut still expects the revision the rewrite started from.
    (phase === "rolled-back" || reconfiguration.fromRevision === binding.brokerDefinitionRevision));
}

type ControllerProofScope =
  | { readonly resume: ControllerResumeBinding }
  | { readonly restore: RestoreContext; readonly broker?: AttemptBrokerInstance };

/** A restore's proof scope: its context and the attempt broker its launch binding names. */
export function restoreProofScope(record: { readonly restore: RestoreContext; readonly launch: { readonly [key: string]: JsonValue } }): ControllerProofScope {
  const broker = (record.launch.controller as ControllerResumeBinding | undefined)?.broker;
  return { restore: record.restore, ...(broker ? { broker } : {}) };
}

/** A controller listener proof fits the journal's own record of which broker it may name. A
 *  resume names a settled `started` broker row. A restore names `reconfiguredBroker` or its
 *  binding's attempt broker when present, otherwise the cut's broker instance at a new launch
 *  request. An attempt broker of a resume must be that exact pair too. The caller still checks
 *  that the instance record is running at that launch request with that process. */
function controllerProofFits(
  proof: ListenerProof,
  cut: ControllerCutBinding,
  scope: ControllerProofScope,
): boolean {
  const instance = proof.instance;
  if (proof.kind !== "controller" || !instance) return false;
  const exact = (pair: AttemptBrokerInstance) => pair.instanceId === instance.instanceId && pair.launchRequestId === instance.launchRequestId;
  if ("resume" in scope)
    return (!scope.resume.broker || exact(scope.resume.broker)) &&
      scope.resume.started.some((row) => row.role === "broker" && row.instanceId === instance.instanceId &&
        row.launchRequestId === instance.launchRequestId);
  const attempt = scope.restore.reconfiguredBroker ?? scope.broker;
  if (attempt) return exact(attempt);
  const broker = cut.members.find((member) => member.role === "broker")!;
  return broker.instanceId === instance.instanceId && broker.launchRequestId !== instance.launchRequestId;
}

/** The proof variant follows the cut's custody, and a controller proof fits its scope. */
function listenerProofFitsCustody(
  proof: ListenerProof,
  cut: MaintenanceCutContext,
  scope: ControllerProofScope | undefined,
): boolean {
  const controller = cutController(cut);
  if (!controller) return proof.kind === undefined;
  return scope !== undefined && controllerProofFits(proof, controller, scope);
}

export function validCutCompletionEvidence(
  value: unknown,
  cut: MaintenanceCutContext,
): value is MaintenanceCutCompletionEvidence {
  const evidence = value as MaintenanceCutCompletionEvidence;
  const controller = cutController(cut);
  return Boolean(evidence && typeof evidence === "object" &&
    exactObjectKeys(evidence, controller
      ? ["attemptId", "observedAt", "managerCommit", "stopped", "listener", "controllerStops"]
      : ["attemptId", "observedAt", "managerCommit", "stopped", "listener"]) &&
    (!controller || validControllerStops(evidence.controllerStops, controller)) &&
    evidence.attemptId === cut.attemptId && validTimestamp(evidence.observedAt) &&
    evidence.managerCommit && typeof evidence.managerCommit === "object" &&
    exactObjectKeys(evidence.managerCommit, ["operation", "attemptId", "state"]) &&
    evidence.managerCommit.operation === "commitPreservation" &&
    evidence.managerCommit.attemptId === cut.attemptId && evidence.managerCommit.state === "preserved" &&
    evidence.stopped && typeof evidence.stopped === "object" &&
    exactObjectKeys(evidence.stopped, ["manager", "broker", "localProcesses"]) &&
    evidence.stopped.manager === true && evidence.stopped.broker === true && evidence.stopped.localProcesses === true &&
    evidence.listener && typeof evidence.listener === "object" &&
    exactObjectKeys(evidence.listener, ["endpoint", "unreachable"]) &&
    evidence.listener.endpoint === cut.launch.server && evidence.listener.unreachable === true);
}

export function normalizedListenerProof(value: ListenerProof): ListenerProof {
  if (!validListenerProof(value))
    maintenanceError("listener-proof-invalid", "restore listener proof is invalid, non-canonical, or oversized");
  return {
    attemptId: value.attemptId,
    serverName: value.serverName,
    serverNonce: value.serverNonce,
    processOwner: {
      pid: value.processOwner.pid,
      host: value.processOwner.host,
      startedAt: value.processOwner.startedAt,
      id: value.processOwner.id,
    },
    serverEndpoint: value.serverEndpoint,
    target: {
      path: value.target.path,
      dev: value.target.dev,
      ino: value.target.ino,
      generation: value.target.generation,
    },
    ...(value.kind === "controller" && value.instance ? {
      kind: "controller" as const,
      instance: {
        instanceId: value.instance.instanceId,
        launchRequestId: value.instance.launchRequestId,
        process: { pid: value.instance.process.pid, token: value.instance.process.token },
      },
    } : {}),
  };
}

export function sameProcessOwner(a: ProcessOwner, b: ProcessOwner): boolean {
  return a.pid === b.pid && a.host === b.host && a.startedAt === b.startedAt && a.id === b.id;
}

/** The proof variant must match the cut's custody, and a controller proof must fit the journal's
 *  recorded broker. The workspace cannot read service instance records, so the caller passes the
 *  live check that the named instance is running at that launch request with that process. A
 *  controller proof without that check refuses. */
export function requireCustodyProof(
  proof: ListenerProof,
  cut: MaintenanceCutContext,
  scope: ControllerProofScope | undefined,
  running: ((instance: ControllerListenerInstance) => boolean) | undefined,
  root: string,
  attemptId: string,
): void {
  if (!listenerProofFitsCustody(proof, cut, scope))
    maintenanceError("listener-proof-mismatch", proof.kind === "controller"
      ? "the controller listener proof does not name this attempt's recorded broker instance"
      : "a legacy listener proof cannot bind a controller-custody attempt", { root, attemptId });
  if (proof.kind === "controller" && (!running || !running(proof.instance!)))
    maintenanceError("listener-proof-mismatch", "the controller listener's broker instance is not proven running at that launch request and process", { root, attemptId });
}

export function sameListenerProof(a: ListenerProof, b: ListenerProof): boolean {
  return a.kind === b.kind && a.attemptId === b.attemptId && a.serverName === b.serverName &&
    a.serverNonce === b.serverNonce && sameProcessOwner(a.processOwner, b.processOwner) &&
    a.serverEndpoint === b.serverEndpoint && sameStoreIdentity(a.target, b.target) &&
    (a.kind !== "controller" || Boolean(a.instance && b.instance &&
      a.instance.instanceId === b.instance.instanceId && a.instance.launchRequestId === b.instance.launchRequestId &&
      a.instance.process.pid === b.instance.process.pid && a.instance.process.token === b.instance.process.token));
}

export function reusesListenerIdentity(a: ListenerProof, b: ListenerProof): boolean {
  return a.serverName === b.serverName || a.serverNonce === b.serverNonce ||
    sameProcessOwner(a.processOwner, b.processOwner) ||
    Boolean(a.instance && b.instance && a.instance.launchRequestId === b.instance.launchRequestId);
}

function validListenerReplacements(value: unknown): value is readonly RestoreListenerReplacement[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1024) return false;
  const replacements = value as readonly RestoreListenerReplacement[];
  for (let index = 0; index < replacements.length; index++) {
    const replacement = replacements[index];
    if (!replacement || typeof replacement !== "object" ||
        !exactObjectKeys(replacement, ["generation", "replacedAt", "proof"]) ||
        replacement.generation !== index + 1 || typeof replacement.replacedAt !== "string" ||
        replacement.replacedAt.length > 64 || !Number.isFinite(Date.parse(replacement.replacedAt)) ||
        !validListenerProof(replacement.proof)) return false;
    if (replacements.slice(0, index).some((prior) => reusesListenerIdentity(prior.proof, replacement.proof)))
      return false;
  }
  return Buffer.byteLength(JSON.stringify(replacements)) <= 512 * 1024;
}

export function assertListenerOwnerAlive(proof: ListenerProof): void {
  const status = localProcessOwnerStatus(proof.processOwner);
  if (status === "unknown")
    maintenanceError("listener-owner-ambiguous", "restore listener process ownership cannot be proven locally", {
      attemptId: proof.attemptId,
      recourse: [{ action: "inspect", description: "Prove the recorded listener owner and server nonce before recovery." }],
    });
  if (status === "dead")
    maintenanceError("listener-owner-dead", "recorded restore listener process is not alive", {
      attemptId: proof.attemptId,
      recourse: [{ action: "repair", description: "Preserve both stores and relaunch through an explicit restore recovery path." }],
    });
}

function validJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validJson);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(validJson);
}

export function validJsonObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && validJson(value);
}

export function sameJsonValue(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((item, index) => sameJsonValue(item, b[index]!));
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const aObject = a as { readonly [key: string]: JsonValue };
  const bObject = b as { readonly [key: string]: JsonValue };
  const aKeys = Object.keys(aObject).sort();
  const bKeys = Object.keys(bObject).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) =>
    key === bKeys[index] && sameJsonValue(aObject[key]!, bObject[key]!));
}

function cloneJsonValue(value: unknown, seen: Set<object>, depth = 0, budget = { nodes: 0 }): JsonValue {
  if (++budget.nodes > 100_000 || depth > 64)
    maintenanceError("resume-too-large", "maintenance resume document is too deeply nested or complex");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_MAINTENANCE_RESUME_BYTES)
      maintenanceError("resume-too-large", "maintenance resume document contains an oversized string");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) maintenanceError("resume-invalid", "maintenance resume document contains a non-finite number");
    return value;
  }
  if (!value || typeof value !== "object")
    maintenanceError("resume-invalid", "maintenance resume document must contain only JSON values");
  if (seen.has(value)) maintenanceError("resume-invalid", "maintenance resume document contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1)
        maintenanceError("resume-invalid", "maintenance resume arrays must be dense plain data");
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set)
          maintenanceError("resume-invalid", "maintenance resume arrays must contain data properties only");
        return cloneJsonValue(descriptor.value, seen, depth + 1, budget);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      maintenanceError("resume-invalid", "maintenance resume document objects must be plain data");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (Reflect.ownKeys(value).length !== keys.length ||
        keys.some((key) => !descriptors[key]!.enumerable || descriptors[key]!.get || descriptors[key]!.set))
      maintenanceError("resume-invalid", "maintenance resume document objects must contain enumerable data properties only");
    const output: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    for (const key of keys)
      Object.defineProperty(output, key, {
        value: cloneJsonValue(descriptors[key]!.value, seen, depth + 1, budget),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return output;
  } finally {
    seen.delete(value);
  }
}

function resumeBytes(document: MaintenanceResumeDocument): {
  readonly document: MaintenanceResumeDocument;
  readonly data: string;
  readonly descriptor: MaintenanceResumeDescriptor;
} {
  if (!document || typeof document !== "object" || Array.isArray(document))
    maintenanceError("resume-invalid", "maintenance resume document must be exactly { version, inventory, launch }");
  const prototype = Object.getPrototypeOf(document);
  const descriptors = Object.getOwnPropertyDescriptors(document);
  const keys = Object.keys(descriptors).sort();
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(document).length !== 3 ||
      keys.join(",") !== "inventory,launch,version" ||
      keys.some((key) => !descriptors[key]!.enumerable || descriptors[key]!.get || descriptors[key]!.set) ||
      descriptors.version!.value !== MAINTENANCE_RESUME_DOCUMENT_VERSION)
    maintenanceError("resume-invalid", "maintenance resume document must be exactly { version, inventory, launch }");
  const normalized: MaintenanceResumeDocument = {
    version: MAINTENANCE_RESUME_DOCUMENT_VERSION,
    inventory: cloneJsonValue(descriptors.inventory!.value, new Set()),
    launch: cloneJsonValue(descriptors.launch!.value, new Set()),
  };
  const data = `${JSON.stringify(normalized, null, 2)}\n`;
  const bytes = Buffer.byteLength(data);
  if (bytes > MAX_MAINTENANCE_RESUME_BYTES)
    maintenanceError("resume-too-large", `maintenance resume document exceeds ${MAX_MAINTENANCE_RESUME_BYTES} bytes`);
  return {
    document: normalized,
    data,
    descriptor: {
      version: MAINTENANCE_RESUME_DOCUMENT_VERSION,
      file: "resume.json",
      bytes,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
  };
}

function validResumeDescriptor(value: unknown): value is MaintenanceResumeDescriptor {
  const descriptor = value as MaintenanceResumeDescriptor;
  return Boolean(descriptor && typeof descriptor === "object" &&
    descriptor.version === MAINTENANCE_RESUME_DOCUMENT_VERSION && descriptor.file === "resume.json" &&
    Number.isInteger(descriptor.bytes) && descriptor.bytes > 0 && descriptor.bytes <= MAX_MAINTENANCE_RESUME_BYTES &&
    typeof descriptor.sha256 === "string" && /^[0-9a-f]{64}$/.test(descriptor.sha256));
}

export function sameResumeDescriptor(a: MaintenanceResumeDescriptor, b: MaintenanceResumeDescriptor): boolean {
  return a.version === b.version && a.file === b.file && a.bytes === b.bytes && a.sha256 === b.sha256;
}

/** Atomically persist the bounded private resume inventory and launch provenance before publishing ready. */
export function writeMaintenanceResumeDocument<Inventory extends JsonValue, Launch extends JsonValue>(
  lock: MaintenanceLock,
  document: MaintenanceResumeDocument<Inventory, Launch>,
): MaintenanceResumeDescriptor {
  assertLock(lock);
  const paths = maintenancePaths(lock.root);
  ensureLayout(paths);
  const serialized = resumeBytes(document);
  const journal = readMaintenanceJournal(lock.root);
  if (journal) {
    if (!sameResumeDescriptor(journal.resume, serialized.descriptor))
      maintenanceError("invalid-transition", "cannot replace the resume document referenced by a maintenance journal", {
        root: lock.root,
        paths: [paths.resume, paths.journal],
        recourse: [{ action: "repair", description: "Complete or explicitly repair the current maintenance state before writing another resume document.", paths: [paths.journal] }],
      });
    return journal.resume;
  }
  const tmp = `${paths.resume}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writePrivateExclusive(tmp, serialized.data);
    renameSync(tmp, paths.resume);
    fsyncDirectory(paths.versionDir);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort for an exclusively-created private temp */ }
    throw error;
  }
  readMaintenanceResumeDocument(lock.root, serialized.descriptor);
  return serialized.descriptor;
}

/** Read exactly the fixed resume file after size, mode, SHA-256, version, and JSON-shape verification. */
export function readMaintenanceResumeDocument<
  Inventory extends JsonValue = JsonValue,
  Launch extends JsonValue = JsonValue,
>(root: string, descriptor: MaintenanceResumeDescriptor): MaintenanceResumeDocument<Inventory, Launch> {
  const paths = maintenancePaths(root);
  if (!validResumeDescriptor(descriptor))
    maintenanceError("resume-invalid", "maintenance resume descriptor is invalid", { paths: [paths.journal] });
  let fd: number;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fd = openSync(paths.resume, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (errno(error) === "ENOENT")
      maintenanceError("resume-missing", "maintenance resume document is missing", {
        root: paths.root,
        paths: [paths.resume],
        recourse: [{ action: "repair", description: "Restore the exact resume document before using this maintenance cut.", paths: [paths.resume] }],
      });
    if (errno(error) === "ELOOP")
      maintenanceError("resume-mismatch", "maintenance resume document must not be a symlink", { paths: [paths.resume] });
    maintenanceError("resume-invalid", "maintenance resume document cannot be inspected", { paths: [paths.resume] });
  }
  let bytes: Buffer;
  try {
    const before = fstatSync(fd!, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(descriptor.bytes) ||
        before.size > BigInt(MAX_MAINTENANCE_RESUME_BYTES) ||
        (process.platform !== "win32" && (before.mode & 0o077n) !== 0n))
      maintenanceError("resume-mismatch", "maintenance resume document metadata does not match its descriptor", {
        root: paths.root,
        paths: [paths.resume],
        recourse: [{ action: "inspect", description: "Do not resume or restore from a missing, replaced, or non-private document.", paths: [paths.resume] }],
      });
    const bounded = Buffer.alloc(descriptor.bytes + 1);
    let length = 0;
    while (length < bounded.length) {
      const count = readSync(fd!, bounded, length, bounded.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd!, { bigint: true });
    if (length !== descriptor.bytes || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      maintenanceError("resume-mismatch", "maintenance resume document changed while it was being read", {
        root: paths.root, paths: [paths.resume],
      });
    bytes = bounded.subarray(0, length);
  } finally {
    closeSync(fd!);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== descriptor.sha256)
    maintenanceError("resume-mismatch", "maintenance resume document SHA-256 does not match its descriptor", {
      root: paths.root,
      paths: [paths.resume],
      recourse: [{ action: "inspect", description: "Restore the exact content-addressed resume document before continuing.", paths: [paths.resume] }],
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    maintenanceError("resume-invalid", "maintenance resume document is not valid JSON", { paths: [paths.resume] });
  }
  const normalized = resumeBytes(parsed as MaintenanceResumeDocument).document;
  return normalized as MaintenanceResumeDocument<Inventory, Launch>;
}

export function validRecourse(value: unknown): value is readonly MaintenanceRecourse[] {
  return Array.isArray(value) && value.every((item: unknown) => {
    const r = item as MaintenanceRecourse;
    return Boolean(r && typeof r === "object" &&
      ["retry", "inspect", "rollback", "repair", "cleanup"].includes(r.action) &&
      typeof r.description === "string" &&
      (r.command === undefined || typeof r.command === "string") &&
      (r.paths === undefined || (Array.isArray(r.paths) && r.paths.every((p) => typeof p === "string" && isAbsolute(p)))));
  });
}

function validateRestoreContext(
  record: RestoreReadyRecord | CommitIntentRecord | RestoreManagerCommittedRecord | RestoreActiveRecord | RestoreDegradedRecord,
  path: string,
): void {
  const restore = record.restore;
  if (!restore || typeof restore.attemptId !== "string" || !ATTEMPT_ID.test(restore.attemptId) ||
      !["same-path", "alternate", "disaster"].includes(restore.method) ||
      typeof restore.targetPath !== "string" || !isAbsolute(restore.targetPath) ||
      (restore.selection !== undefined && !["full", "registry"].includes(restore.selection)))
    maintenanceError("journal-corrupt", "restore context is invalid", { paths: [path] });
  if (restore.target && (!validIdentity(restore.target) || restore.target.path !== restore.targetPath))
    maintenanceError("journal-corrupt", "restore target identity is invalid", { paths: [path] });
  if (restore.previousSource &&
      (!["fallback", "retained"].includes(restore.previousSource.kind) || !validIdentity(restore.previousSource.identity)))
    maintenanceError("journal-corrupt", "previous source identity is invalid", { paths: [path] });

  if (restore.method === "same-path") {
    if (restore.targetPath !== record.source.path || typeof restore.fallbackPath !== "string" ||
        !isAbsolute(restore.fallbackPath) || dirname(restore.fallbackPath) !== dirname(record.source.path))
      maintenanceError("journal-corrupt", "same-path restore paths are inconsistent", { paths: [path] });
    if (record.state === "restore-ready" && !["move-pending", "source-moved"].includes(record.phase))
      maintenanceError("journal-corrupt", "same-path restore phase is inconsistent", { paths: [path] });
    if (record.state === "restore-ready" && record.phase === "move-pending" &&
        (restore.previousSource || restore.target || restore.cleanup))
      maintenanceError("journal-corrupt", "pending move unexpectedly records bound or owned paths", { paths: [path] });
    if ((record.state !== "restore-ready" || record.phase === "source-moved") &&
        (!restore.previousSource || restore.previousSource.kind !== "fallback" ||
         restore.previousSource.identity.path !== restore.fallbackPath ||
         restore.previousSource.identity.dev !== record.source.dev || restore.previousSource.identity.ino !== record.source.ino ||
         restore.previousSource.identity.generation !== record.source.generation))
      maintenanceError("journal-corrupt", "moved source identity is inconsistent", { paths: [path] });
  } else if (restore.method === "alternate") {
    if (restore.targetPath === record.source.path || restore.fallbackPath !== undefined ||
        !restore.previousSource || restore.previousSource.kind !== "retained" ||
        !sameStoreIdentity(restore.previousSource.identity, record.source) ||
        (record.state === "restore-ready" && record.phase !== "source-retained"))
      maintenanceError("journal-corrupt", "alternate restore context is inconsistent", { paths: [path] });
    if (pathContains(record.source.path, restore.targetPath) || pathContains(restore.targetPath, record.source.path))
      maintenanceError("journal-corrupt", "alternate restore source and target trees overlap", {
        paths: [path, record.source.path, restore.targetPath],
      });
  } else if (restore.targetPath !== record.source.path || restore.fallbackPath !== undefined ||
      restore.previousSource !== undefined ||
      (record.state === "restore-ready" && record.phase !== "disaster-source-missing")) {
    maintenanceError("journal-corrupt", "disaster restore context is inconsistent", { paths: [path] });
  }

  if (restore.ownedPaths !== undefined && !validOwnedPaths(restore.ownedPaths))
    maintenanceError("journal-corrupt", "restore attempt-owned paths are invalid", { paths: [path] });

  const controller = cutController(record.cut);
  if (restore.controllerReconfiguration !== undefined &&
      (!controller || restore.method !== "alternate" ||
       !validControllerReconfiguration(restore.controllerReconfiguration, restore, controller)))
    maintenanceError("journal-corrupt", "restore broker reconfiguration is invalid or outside a controller alternate restore", { paths: [path] });
  const reconfiguredBroker = restore.reconfiguredBroker;
  if (reconfiguredBroker !== undefined) {
    const broker = controller?.members.find((member) => member.role === "broker");
    if (!broker || restore.controllerReconfiguration?.phase !== "definition-committed" ||
        !reconfiguredBroker || typeof reconfiguredBroker !== "object" ||
        !exactObjectKeys(reconfiguredBroker, ["instanceId", "launchRequestId"]) ||
        typeof reconfiguredBroker.instanceId !== "string" || !SERVICE_ID.test(reconfiguredBroker.instanceId) ||
        typeof reconfiguredBroker.launchRequestId !== "string" || !SERVICE_ID.test(reconfiguredBroker.launchRequestId) ||
        reconfiguredBroker.instanceId === broker.instanceId)
      maintenanceError("journal-corrupt", "reconfigured broker instance is invalid", { paths: [path] });
  }
  const handoff = (record as { tokenHandoff?: unknown }).tokenHandoff;
  if (handoff !== undefined &&
      !validTokenHandoff(handoff, join(dirname(path), "handoff"), restore.attemptId))
    maintenanceError("journal-corrupt", "restore commit-token handoff record is invalid", { paths: [path] });

  if (restore.cleanup) {
    const cleanup = restore.cleanup;
    if (!["attempt-target", "previous-source"].includes(cleanup.kind) ||
        !["pending", "complete"].includes(cleanup.status) || !validIdentity(cleanup.identity) ||
        cleanup.originalPath !== cleanup.identity.path || !isAbsolute(cleanup.tombPath) ||
        dirname(cleanup.tombPath) !== dirname(cleanup.originalPath) ||
        (cleanup.kind === "attempt-target" && (!restore.target || !sameStoreIdentity(cleanup.identity, restore.target))) ||
        (cleanup.kind === "previous-source" && (!restore.previousSource || !sameStoreIdentity(cleanup.identity, restore.previousSource.identity))))
      maintenanceError("journal-corrupt", "restore cleanup record is inconsistent", { paths: [path] });
  }
}

function validateOrdinaryResume(record: OrdinaryResumeRecord, path: string): void {
  const context = record.ordinaryResume;
  if (!context || typeof context !== "object" || typeof context.attemptId !== "string" ||
      !ATTEMPT_ID.test(context.attemptId) || typeof context.intentAt !== "string" ||
      !Number.isFinite(Date.parse(context.intentAt)) || !validJsonObject(context.launch))
    maintenanceError("journal-corrupt", "ordinary resume intent is invalid", { paths: [path] });
  const cut = cutController(record.cut);
  const custody = context.launch.custody;
  if (cut ? custody !== "controller" || !validControllerResumeBinding(context.launch.controller, cut)
    : custody !== undefined || context.launch.controller !== undefined)
    maintenanceError("journal-corrupt", "ordinary resume custody does not match the cut", { paths: [path] });
  const resumeScope = cut ? { resume: ordinaryResumeController(context)! } : undefined;
  if (record.tokenHandoff !== undefined &&
      !validTokenHandoff(record.tokenHandoff, join(dirname(path), "handoff"), context.attemptId))
    maintenanceError("journal-corrupt", "resume commit-token handoff record is invalid", { paths: [path] });
  if (record.listenerProof !== undefined &&
      (!validListenerProof(record.listenerProof) ||
       !listenerProofFitsCustody(record.listenerProof, record.cut, resumeScope) ||
       record.listenerProof.attemptId !== context.attemptId ||
       !sameStoreIdentity(record.listenerProof.target, record.source) ||
       typeof context.launch.server !== "string" ||
       canonicalListenerEndpoint(context.launch.server) !== record.listenerProof.serverEndpoint))
    maintenanceError("journal-corrupt", "resume listener proof is invalid or belongs to another attempt", { paths: [path] });
  if (record.listenerReplacements !== undefined &&
      (!validListenerReplacements(record.listenerReplacements) ||
       record.listenerReplacements.some((replacement) =>
         !listenerProofFitsCustody(replacement.proof, record.cut, resumeScope) ||
         replacement.proof.attemptId !== context.attemptId ||
         !sameStoreIdentity(replacement.proof.target, record.source) ||
         typeof context.launch.server !== "string" ||
         canonicalListenerEndpoint(context.launch.server) !== replacement.proof.serverEndpoint)))
    maintenanceError("journal-corrupt", "resume listener replacement history is invalid", { paths: [path] });
  const currentResumeProof = record.listenerProof;
  if (currentResumeProof && record.listenerReplacements?.some((replacement) =>
      reusesListenerIdentity(replacement.proof, currentResumeProof)))
    maintenanceError("journal-corrupt", "current resume listener reuses a retired identity", { paths: [path] });
  if (record.state === "resume-intent") {
    const extra = record as OrdinaryResumeIntentRecord & {
      activeAt?: unknown; activation?: unknown; degradedAt?: unknown; reason?: unknown;
      recourse?: unknown; managerCommittedAt?: unknown; managerCommit?: unknown;
      retiredAt?: unknown; retirement?: unknown;
    };
    if (extra.activeAt !== undefined || extra.activation !== undefined || extra.degradedAt !== undefined ||
        extra.reason !== undefined || extra.recourse !== undefined || extra.managerCommittedAt !== undefined ||
        extra.managerCommit !== undefined || extra.retiredAt !== undefined || extra.retirement !== undefined)
      maintenanceError("journal-corrupt", "ordinary resume intent contains later-phase fields", { paths: [path] });
    return;
  }
  if (record.state === "resume-active") {
    if (typeof record.activeAt !== "string" || !Number.isFinite(Date.parse(record.activeAt)) ||
        !validOrdinaryResumeActivationEvidence(record.activation, context.attemptId))
      maintenanceError("journal-corrupt", "active ordinary resume is invalid", { paths: [path] });
    return;
  }
  if (record.state === "resume-committed") {
    if (typeof record.activeAt !== "string" || !Number.isFinite(Date.parse(record.activeAt)) ||
        !validOrdinaryResumeActivationEvidence(record.activation, context.attemptId) ||
        typeof record.managerCommittedAt !== "string" || !Number.isFinite(Date.parse(record.managerCommittedAt)) ||
        !validManagerCommitEvidence(record.managerCommit, context.attemptId))
      maintenanceError("journal-corrupt", "manager-committed ordinary resume is invalid", { paths: [path] });
    return;
  }
  if (record.state === "resume-degraded") {
    const hasActiveAt = record.activeAt !== undefined;
    const hasActivation = record.activation !== undefined;
    if (hasActiveAt !== hasActivation ||
        (hasActiveAt && (typeof record.activeAt !== "string" || !Number.isFinite(Date.parse(record.activeAt)) ||
          !validOrdinaryResumeActivationEvidence(record.activation, context.attemptId))) ||
        ((record.managerCommittedAt === undefined) !== (record.managerCommit === undefined)) ||
        (record.managerCommittedAt !== undefined &&
          (!validTimestamp(record.managerCommittedAt) ||
           !validManagerCommitEvidence(record.managerCommit, context.attemptId))) ||
        typeof record.degradedAt !== "string" || !Number.isFinite(Date.parse(record.degradedAt)) ||
        typeof record.reason !== "string" ||
        !record.reason || !validRecourse(record.recourse))
      maintenanceError("journal-corrupt", "degraded ordinary resume is invalid", { paths: [path] });
    return;
  }
  if (typeof record.activeAt !== "string" || !Number.isFinite(Date.parse(record.activeAt)) ||
      !validOrdinaryResumeActivationEvidence(record.activation, context.attemptId) ||
      typeof record.managerCommittedAt !== "string" || !Number.isFinite(Date.parse(record.managerCommittedAt)) ||
      !validManagerCommitEvidence(record.managerCommit, context.attemptId) ||
      typeof record.retiredAt !== "string" || !Number.isFinite(Date.parse(record.retiredAt)) ||
      !validManagerFinalizeEvidence(
        record.retirement,
        context.attemptId,
        record.managerCommit.durableCommitToken,
      ))
    maintenanceError("journal-corrupt", "retired ordinary resume is invalid", { paths: [path] });
}

function validateJournal(value: unknown, path: string): MaintenanceJournal {
  const record = value as MaintenanceJournal;
  if (!record || typeof record !== "object")
    maintenanceError("journal-corrupt", "maintenance journal is not an object", { paths: [path] });
  if ((record as { version?: unknown }).version !== MAINTENANCE_JOURNAL_VERSION)
    maintenanceError("journal-version", "unsupported maintenance journal version", { paths: [path] });
  if (!Number.isInteger(record.revision) || record.revision <= 0 || typeof record.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      typeof record.space !== "string" || !record.space || !["auth", "open", "user"].includes(record.mode) ||
      !validIdentity(record.source) || !validResumeDescriptor(record.resume) || !validCutContext(record.cut))
    maintenanceError("journal-corrupt", "maintenance journal base fields are invalid", { paths: [path] });
  if (!["cut-intent", "cut-committed", "ready", "claimed", "restore-ready", "commit-intent", "manager-committed", "active", "degraded",
      "resume-intent", "resume-active", "resume-committed", "resume-degraded", "resume-retired"].includes(record.state))
    maintenanceError("journal-corrupt", "maintenance journal state is invalid", { paths: [path] });
  const completion = (record as MaintenanceReadyRecord).cutCompletion;
  if (record.state === "cut-intent" || record.state === "cut-committed") {
    if (completion !== undefined)
      maintenanceError("journal-corrupt", "an uncompleted cut cannot contain completion evidence", { paths: [path] });
  } else if (!validCutCompletionEvidence(completion, record.cut)) {
    maintenanceError("journal-corrupt", "completed maintenance state has invalid cut evidence", { paths: [path] });
  }
  if (record.state === "cut-committed") {
    const committed = record;
    const manager = committed.managerCommit as unknown;
    if (!validTimestamp(committed.managerCommittedAt) || !manager || typeof manager !== "object" ||
        !exactObjectKeys(manager, ["operation", "attemptId", "state"]) ||
        committed.managerCommit.operation !== "commitPreservation" ||
        committed.managerCommit.attemptId !== record.cut.attemptId ||
        committed.managerCommit.state !== "preserved")
      maintenanceError("journal-corrupt", "cut-committed manager evidence is invalid", { paths: [path] });
    const controller = cutController(record.cut);
    if (committed.preservedStop !== undefined &&
        (!controller || !validPreservedStop(committed.preservedStop, record.cut, controller)))
      maintenanceError("journal-corrupt", "cut-committed preserved stop attempts are invalid", { paths: [path] });
  } else if ((record as { preservedStop?: unknown }).preservedStop !== undefined) {
    maintenanceError("journal-corrupt", "only a cut-committed journal can record preserved stop attempts", { paths: [path] });
  }
  if ((record as { tokenHandoff?: unknown }).tokenHandoff !== undefined &&
      !["manager-committed", "active", "degraded", "resume-committed", "resume-degraded", "resume-retired"].includes(record.state))
    maintenanceError("journal-corrupt", "this maintenance state cannot record a commit-token handoff", { paths: [path] });
  if (record.state === "claimed") {
    const claim = record.claim;
    if (!claim || typeof claim.attemptId !== "string" || !ATTEMPT_ID.test(claim.attemptId) ||
        typeof claim.deadline !== "string" || !Number.isFinite(Date.parse(claim.deadline)) ||
        !Array.isArray(claim.owners) || claim.owners.length > 16)
      maintenanceError("journal-corrupt", "maintenance claim is invalid", { paths: [path] });
    parseOwner(claim.coordinator, "claim coordinator");
    for (const claimOwner of claim.owners) parseOwner(claimOwner, "claim owner");
    if (claim.ownedPaths !== undefined && !validOwnedPaths(claim.ownedPaths))
      maintenanceError("journal-corrupt", "maintenance claim owned paths are invalid", { paths: [path] });
  }
  if (record.state === "restore-ready" && !validRestoreClaim(record.claim))
    maintenanceError("journal-corrupt", "restore-ready record has no valid liveness claim", { paths: [path] });
  if (["restore-ready", "commit-intent", "manager-committed", "active", "degraded"].includes(record.state)) {
    const restoreRecord = record as RestoreReadyRecord | CommitIntentRecord | RestoreManagerCommittedRecord | RestoreActiveRecord | RestoreDegradedRecord;
    if (restoreRecord.state === "restore-ready" && !["move-pending", "source-moved", "source-retained", "disaster-source-missing"].includes(restoreRecord.phase))
      maintenanceError("journal-corrupt", "restore phase is invalid", { paths: [path] });
    if (restoreRecord.state !== "restore-ready" && !restoreRecord.restore.target)
      maintenanceError("journal-corrupt", "committed restore has no target identity", { paths: [path] });
    validateRestoreContext(restoreRecord, path);
    if (restoreRecord.state !== "restore-ready" &&
        !validJsonObject(restoreRecord.launch))
      maintenanceError("journal-corrupt", "restore launch metadata is invalid", { paths: [path] });
    // A controller restore journals its member starts in the launch, as a controller resume does.
    if (restoreRecord.state !== "restore-ready") {
      const launch = restoreRecord.launch;
      const controller = cutController(record.cut);
      if (controller ? launch.custody !== "controller" || !validControllerResumeBinding(launch.controller, controller) ||
          // A rewritten broker definition names its new broker in reconfiguredBroker, never here.
          (launch.controller as ControllerResumeBinding).broker !== undefined && restoreRecord.restore.controllerReconfiguration !== undefined
        : launch.custody !== undefined || launch.controller !== undefined)
        maintenanceError("journal-corrupt", "restore launch custody does not match the cut", { paths: [path] });
    }
    if (restoreRecord.state !== "restore-ready" && restoreRecord.listenerProof !== undefined &&
        (!validListenerProof(restoreRecord.listenerProof) ||
         !listenerProofFitsCustody(restoreRecord.listenerProof, record.cut, restoreProofScope(restoreRecord as CommitIntentRecord)) ||
         restoreRecord.listenerProof.attemptId !== restoreRecord.restore.attemptId ||
         !sameStoreIdentity(restoreRecord.listenerProof.target, restoreRecord.restore.target) ||
         typeof restoreRecord.launch.server !== "string" ||
         canonicalListenerEndpoint(restoreRecord.launch.server) !== restoreRecord.listenerProof.serverEndpoint))
      maintenanceError("journal-corrupt", "restore listener proof is invalid or belongs to another attempt", { paths: [path] });
    if (restoreRecord.state !== "restore-ready") {
      const committed = restoreRecord as CommitIntentRecord | RestoreManagerCommittedRecord | RestoreActiveRecord | RestoreDegradedRecord;
      if (committed.listenerReplacements !== undefined &&
          (!validListenerReplacements(committed.listenerReplacements) ||
           committed.listenerReplacements.some((replacement) =>
             !listenerProofFitsCustody(replacement.proof, record.cut, restoreProofScope(committed)) ||
             replacement.proof.attemptId !== committed.restore.attemptId ||
             !sameStoreIdentity(replacement.proof.target, committed.restore.target) ||
             typeof committed.launch.server !== "string" ||
             canonicalListenerEndpoint(committed.launch.server) !== replacement.proof.serverEndpoint)))
        maintenanceError("journal-corrupt", "restore listener replacement history is invalid", { paths: [path] });
      const currentProof = committed.listenerProof;
      if (currentProof && committed.listenerReplacements?.some((replacement) =>
          reusesListenerIdentity(replacement.proof, currentProof)))
        maintenanceError("journal-corrupt", "current restore listener reuses a retired identity", { paths: [path] });
    }
    if (restoreRecord.state === "manager-committed" &&
        (!restoreRecord.listenerProof || !validTimestamp(restoreRecord.managerCommittedAt) ||
         !validManagerCommitEvidence(restoreRecord.managerCommit, restoreRecord.restore.attemptId)))
      maintenanceError("journal-corrupt", "manager-committed restore evidence is invalid", { paths: [path] });
    if (restoreRecord.state === "active" &&
        (!validTimestamp(restoreRecord.managerCommittedAt) ||
         !validManagerCommitEvidence(restoreRecord.managerCommit, restoreRecord.restore.attemptId) ||
         !Number.isFinite(Date.parse(restoreRecord.activeAt)) || !restoreRecord.listenerProof ||
         !validRestoreActivationEvidence(restoreRecord.details, restoreRecord.restore.attemptId) ||
         !sameManagerCommitEvidence(restoreRecord.managerCommit, restoreRecord.details.managerCommit)))
      maintenanceError("journal-corrupt", "active restore details are invalid", { paths: [path] });
    if (restoreRecord.state === "degraded" &&
        (((restoreRecord.managerCommittedAt === undefined) !== (restoreRecord.managerCommit === undefined)) ||
         (restoreRecord.managerCommittedAt !== undefined &&
          (!restoreRecord.listenerProof || !validTimestamp(restoreRecord.managerCommittedAt) ||
           !validManagerCommitEvidence(restoreRecord.managerCommit, restoreRecord.restore.attemptId))) ||
         (restoreRecord.activeAt !== undefined && !Number.isFinite(Date.parse(restoreRecord.activeAt))) ||
         (restoreRecord.activeAt !== undefined && (!restoreRecord.listenerProof ||
           !validRestoreActivationEvidence(restoreRecord.details, restoreRecord.restore.attemptId))) ||
         (restoreRecord.activeAt !== undefined &&
          (restoreRecord.managerCommit === undefined ||
           !sameManagerCommitEvidence(restoreRecord.managerCommit, restoreRecord.details!.managerCommit))) ||
         (restoreRecord.activeAt === undefined && restoreRecord.details !== undefined) ||
         !Number.isFinite(Date.parse(restoreRecord.degradedAt)) ||
         typeof restoreRecord.reason !== "string" || !validRecourse(restoreRecord.recourse)))
      maintenanceError("journal-corrupt", "degraded restore recourse is invalid", { paths: [path] });
  }
  if (["resume-intent", "resume-active", "resume-committed", "resume-degraded", "resume-retired"].includes(record.state))
    validateOrdinaryResume(record as OrdinaryResumeRecord, path);
  return record;
}

export function readMaintenanceJournal(root: string): MaintenanceJournal | undefined {
  const paths = maintenancePaths(root);
  let raw: string;
  try {
    const stat = lstatSync(paths.journal);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      maintenanceError("journal-corrupt", "maintenance journal is not a bounded regular file", { paths: [paths.journal] });
    raw = readFileSync(paths.journal, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    if (isMaintenanceError(error)) throw error;
    maintenanceError("journal-corrupt", "maintenance journal cannot be read", { paths: [paths.journal] });
  }
  try {
    const record = validateJournal(JSON.parse(raw!), paths.journal);
    readMaintenanceResumeDocument(paths.root, record.resume);
    return record;
  } catch (error) {
    if (isMaintenanceError(error)) throw error;
    maintenanceError("journal-corrupt", "maintenance journal cannot be parsed", { paths: [paths.journal] });
  }
}

export function currentJournal(lock: MaintenanceLock): MaintenanceJournal {
  assertLock(lock);
  const record = readMaintenanceJournal(lock.root);
  if (!record)
    maintenanceError("journal-missing", "maintenance journal does not exist", {
      root: lock.root,
      recourse: [{ action: "repair", description: "Complete a preserve-state cut before backup or restore." }],
    });
  return record!;
}

export function writeJournal<T extends Omit<MaintenanceJournal, "version" | "revision" | "updatedAt">>(
  lock: MaintenanceLock,
  previous: MaintenanceJournal | undefined,
  next: T,
): MaintenanceJournal {
  assertLock(lock);
  const paths = maintenancePaths(lock.root);
  ensureLayout(paths);
  const record = {
    ...next,
    version: MAINTENANCE_JOURNAL_VERSION,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  } as MaintenanceJournal;
  validateJournal(record, paths.journal);
  readMaintenanceResumeDocument(lock.root, record.resume);
  atomicWrite(paths.journal, record);
  return record;
}

export function readyFrom(record: CompletedJournalBase): Omit<MaintenanceReadyRecord, "version" | "revision" | "updatedAt"> {
  return {
    state: "ready", space: record.space, mode: record.mode, source: record.source, resume: record.resume,
    cut: record.cut, cutCompletion: record.cutCompletion,
  };
}

export function requireReady(lock: MaintenanceLock): MaintenanceReadyRecord {
  const record = currentJournal(lock);
  if (record.state !== "ready")
    maintenanceError("invalid-transition", `maintenance journal is ${record.state}, not ready`, {
      root: lock.root,
      paths: record.state === "restore-ready" ? [record.restore.targetPath, record.source.path] : [record.source.path],
    });
  assertStoreIdentity(record.source);
  return record as MaintenanceReadyRecord;
}
