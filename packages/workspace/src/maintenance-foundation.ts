/** The maintenance foundation: the journal and lock contract types, the structured
 *  MaintenanceError, store identity, the process owner and the store-wide maintenance lock that
 *  every maintenance operation in `maintenance.ts` builds on. `maintenance.ts` re-exports every public
 *  name here, so importers keep their path. */
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { hardenPrivate } from "@cotal-ai/core";
import { recordOperationWarning } from "./output.js";

/** Version 1 lives in `<project>/.cotal/maintenance/v1`; the lock is shared across versions. */
export const MAINTENANCE_JOURNAL_VERSION = 1 as const;
export const MAINTENANCE_RESUME_DOCUMENT_VERSION = 1 as const;
export const MAX_MAINTENANCE_RESUME_BYTES = 1024 * 1024;

export type MaintenanceAuthMode = "auth" | "open" | "user";
export type OwnerStatus = "alive" | "dead" | "unknown";

export interface StoreIdentity {
  readonly path: string;
  /** Decimal strings preserve the full `bigint` values returned by `stat`. */
  readonly dev: string;
  readonly ino: string;
  /** Random marker persisted inside the store, so inode reuse cannot impersonate the old store. */
  readonly generation: string;
}

export interface ProcessOwner {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly id: string;
}

export interface MaintenanceRecourse {
  readonly action: "retry" | "inspect" | "rollback" | "repair" | "cleanup";
  readonly description: string;
  readonly command?: string;
  readonly paths?: readonly string[];
}

export type MaintenanceErrorCode =
  | "invalid-path"
  | "path-exists"
  | "path-missing"
  | "identity-mismatch"
  | "ambiguous-filesystem-state"
  | "journal-missing"
  | "journal-corrupt"
  | "journal-version"
  | "invalid-transition"
  | "lock-held"
  | "lock-owner-ambiguous"
  | "lock-lost"
  | "claim-live"
  | "claim-owner-ambiguous"
  | "claim-not-expired"
  | "cleanup-incomplete"
  | "rollback-forbidden"
  | "cleanup-forbidden"
  | "store-holds-foreign-entries"
  | "cleanup-complete"
  | "resume-missing"
  | "resume-mismatch"
  | "resume-invalid"
  | "resume-too-large"
  | "listener-proof-invalid"
  | "listener-proof-missing"
  | "listener-proof-mismatch"
  | "listener-owner-alive"
  | "listener-owner-dead"
  | "listener-owner-ambiguous"
  | "activation-evidence-invalid";

export interface MaintenanceErrorDetails {
  readonly root?: string;
  readonly attemptId?: string;
  readonly paths?: readonly string[];
  readonly expected?: StoreIdentity;
  readonly actual?: StoreIdentity;
  readonly recourse: readonly MaintenanceRecourse[];
}

const MAINTENANCE_ERROR = "cotal:workspace:maintenance-error";

/** Stable code and structured recourse are the consumer contract; `message` is diagnostic text. */
export class MaintenanceError extends Error {
  readonly brand = MAINTENANCE_ERROR;
  readonly code: MaintenanceErrorCode;
  readonly details: MaintenanceErrorDetails;

  constructor(code: MaintenanceErrorCode, message: string, details: MaintenanceErrorDetails) {
    super(message);
    this.name = "MaintenanceError";
    this.code = code;
    this.details = details;
  }
}

export function isMaintenanceError(error: unknown): error is MaintenanceError {
  return typeof error === "object" && error !== null &&
    (error as { brand?: unknown }).brand === MAINTENANCE_ERROR;
}

interface JournalBase {
  readonly version: typeof MAINTENANCE_JOURNAL_VERSION;
  readonly revision: number;
  readonly updatedAt: string;
  readonly space: string;
  readonly mode: MaintenanceAuthMode;
  readonly source: StoreIdentity;
  readonly resume: MaintenanceResumeDescriptor;
  readonly cut: MaintenanceCutContext;
}

export interface CompletedJournalBase extends JournalBase {
  readonly cutCompletion: MaintenanceCutCompletionEvidence;
}

export interface MaintenanceCutContext {
  readonly attemptId: string;
  readonly intentAt: string;
  readonly launch: { readonly server: string; readonly [key: string]: JsonValue };
}

export type ControllerRole = "broker" | "auth" | "delivery" | "manager";

/** A creation-pinned process. The token is opaque (pid.ts); only its frame is validated. */
export type PinnedProcess = {
  readonly pid: number;
  readonly token: string;
};

/** The original member incarnations a controller cut stopped. Immutable for the life of the cut,
 *  except that a restore rollback rebinds `brokerDefinitionRevision`. Type aliases keep these
 *  shapes assignable to the journal's JSON launch object. */
export type ControllerCutBinding = {
  readonly stackOperationId: string;
  readonly brokerDefinitionRevision: string;
  readonly members: readonly ControllerMember[];
  readonly manager: { readonly instanceId: string; readonly epoch: number; readonly lifecycleUid: string };
};

export type ControllerMember = {
  readonly role: ControllerRole;
  readonly definition: string;
  readonly definitionRevision: string;
  readonly instanceId: string;
  readonly launchRequestId: string;
  readonly process: PinnedProcess;
};

/** Each member's own terminal receipt, copied from its instance record at the cut. A later launch
 *  rewrites the instance record, so this row is the durable stop evidence. */
export type ControllerStop =
  | { readonly role: "manager"; readonly instanceId: string; readonly launchRequestId: string;
      readonly receipt: { readonly kind: "preserved-exit"; readonly requestId: string; readonly scopeSha256: string; readonly observedAt: string } }
  | { readonly role: "broker"; readonly instanceId: string; readonly launchRequestId: string;
      readonly receipt: { readonly kind: "kernel-exit"; readonly requestId: string; readonly scopeSha256: string; readonly observedAt: string } }
  | { readonly role: "auth" | "delivery"; readonly instanceId: string; readonly launchRequestId: string;
      readonly receipt: { readonly kind: "process-exit"; readonly requestId: string; readonly observedAt: string } };

/** One preserved-exit stop attempt, journaled before it publishes. It carries every field the
 *  closed stop-request reader needs, so the attempt's own request can be rebuilt with its own
 *  original stopper. `published` is set only after the request file was written. */
export interface PreservedStopAttempt {
  readonly requestId: string;
  readonly target: PinnedProcess;
  readonly stopper: PinnedProcess;
  readonly withAgents: false;
  readonly scopeSha256: string;
  readonly preserved: { readonly attemptId: string; readonly inventorySha256: string };
  readonly recordedAt: string;
  readonly published?: true;
}

export interface PreservedStop {
  readonly instanceId: string;
  readonly launchRequestId: string;
  readonly attempts: readonly PreservedStopAttempt[];
}

/** One member start in a controller resume. `requested` is journaled before the start call; the
 *  outcome and launch request follow after it returns or throws. */
export type ControllerStartedMember = {
  readonly role: ControllerRole;
  readonly instanceId: string;
  readonly priorLaunchRequestId: string;
  readonly state: "requested";
  readonly launchRequestId?: string;
  readonly outcome?: "running" | "refused-before-spawn" | "unknown";
};

export type ControllerResumeBinding = {
  readonly stackOperationId: string;
  readonly started: readonly ControllerStartedMember[];
  /** After a restore rollback rebound the broker revision, the cut's broker record is retired and
   *  this attempt starts a new broker instance with these IDs, journaled before its start. */
  readonly broker?: AttemptBrokerInstance;
};

/** A new broker instance an attempt starts in place of the retired cut member. Both IDs are
 *  chosen and journaled before the start. */
export type AttemptBrokerInstance = {
  readonly instanceId: string;
  readonly launchRequestId: string;
};

/** The private commit-token handoff file: its path, then its exact inode and an integrity digest
 *  of the random value once written. Never the token bytes. */
export interface TokenHandoff {
  readonly path: string;
  readonly state: "intended" | "written" | "consumed" | "swept";
  readonly dev?: string;
  readonly ino?: string;
  readonly sha256?: string;
}

/** An alternate-target restore's recorded broker definition rewrite (`options.config` only). Each
 *  phase is journaled before the definition write it names: `rendered` before the forward write,
 *  `rolling-back` before the rollback write. */
export interface ControllerReconfiguration {
  readonly fromRevision: string;
  readonly fromOptionsSha256: string;
  readonly fromConfigPath: string;
  readonly fromConfigSha256: string;
  readonly toConfigPath: string;
  readonly toConfigSha256: string;
  readonly toStoreIdentity: StoreIdentity;
  readonly toRevision?: string;
  readonly phase: "rendered" | "definition-committed" | "rolling-back" | "rolled-back";
  readonly rollbackRevision?: string;
}

export interface MaintenanceCutCompletionEvidence {
  readonly attemptId: string;
  readonly observedAt: string;
  readonly managerCommit: {
    readonly operation: "commitPreservation";
    readonly attemptId: string;
    readonly state: "preserved";
  };
  readonly stopped: {
    readonly manager: true;
    readonly broker: true;
    readonly localProcesses: true;
  };
  readonly listener: {
    readonly endpoint: string;
    readonly unreachable: true;
  };
  /** Required iff the cut has controller custody: one row per cut member. */
  readonly controllerStops?: readonly ControllerStop[];
}

export interface MaintenanceCutIntentRecord extends JournalBase {
  readonly state: "cut-intent";
}

/** Durable proof the manager committed preservation, written BEFORE any process stop so a crash
 *  between manager commit and the final ready promotion recovers without a live manager. */
export interface MaintenanceCutCommittedRecord extends JournalBase {
  readonly state: "cut-committed";
  readonly managerCommittedAt: string;
  readonly managerCommit: MaintenanceCutCompletionEvidence["managerCommit"];
  /** Controller custody only: every preserved-exit stop attempt for the cut's manager member. */
  readonly preservedStop?: PreservedStop;
}

export interface MaintenanceReadyRecord extends CompletedJournalBase {
  readonly state: "ready";
}

/** One filesystem tree or file owned by a single maintenance attempt. A slot journaled BEFORE the
 *  path is created carries no inode ("pending"); it is upgraded with the exact dev/ino immediately
 *  after creation, so recovery can never delete a replacement. */
export interface AttemptOwnedPath {
  readonly label: "clone" | "destination" | "staging" | "quarantine" | "sanitized" | "config";
  readonly path: string;
  readonly dev?: string;
  readonly ino?: string;
}

export interface MaintenanceClaim {
  readonly attemptId: string;
  readonly deadline: string;
  readonly coordinator: ProcessOwner;
  readonly owners: readonly ProcessOwner[];
  readonly ownedPaths?: readonly AttemptOwnedPath[];
}

/** Liveness claim covering the whole pre-commit restore window. Concurrent commands refuse while
 *  it is live; recovery requires the deadline elapsed and every recorded owner proven dead. */
export interface RestoreClaim {
  readonly deadline: string;
  readonly coordinator: ProcessOwner;
  readonly owners: readonly ProcessOwner[];
}

export type RestoreClaimAssessment = "live" | "stale" | "ambiguous";

export interface MaintenanceClaimedRecord extends CompletedJournalBase {
  readonly state: "claimed";
  readonly claim: MaintenanceClaim;
}

export type RestorePhase =
  | "move-pending"
  | "source-moved"
  | "source-retained"
  | "disaster-source-missing";

export interface PreviousSource {
  /** A fallback is a renamed source; retained means an alternate-target restore left it in place. */
  readonly kind: "fallback" | "retained";
  readonly identity: StoreIdentity;
}

export interface CleanupProgress {
  /** Only `attempt-target` is attempt-owned. `previous-source` requires the explicit cleanup API. */
  readonly kind: "attempt-target" | "previous-source";
  readonly status: "pending" | "complete";
  readonly originalPath: string;
  readonly tombPath: string;
  readonly identity: StoreIdentity;
}

export type RestoreSelection = "full" | "registry";

export interface RestoreContext {
  readonly attemptId: string;
  readonly method: "same-path" | "alternate" | "disaster";
  readonly targetPath: string;
  /** What the restore brought back. A `registry` restore leaves every other stream out, so the
   *  previous store holds the only copy of that history. Absent in journals written before it was
   *  recorded. */
  readonly selection?: RestoreSelection;
  readonly fallbackPath?: string;
  readonly previousSource?: PreviousSource;
  readonly target?: StoreIdentity;
  readonly cleanup?: CleanupProgress;
  /** Attempt-owned working trees (staging, quarantine, sanitized) journaled before use so crash
   *  recovery deletes exactly these inodes and nothing else. */
  readonly ownedPaths?: readonly AttemptOwnedPath[];
  /** Controller custody and `method: "alternate"` only. */
  readonly controllerReconfiguration?: ControllerReconfiguration;
  /** The new broker instance of `toRevision`; requires `phase: "definition-committed"`. */
  readonly reconfiguredBroker?: { readonly instanceId: string; readonly launchRequestId: string };
}

export interface RestoreReadyRecord extends CompletedJournalBase {
  readonly state: "restore-ready";
  readonly phase: RestorePhase;
  readonly restore: RestoreContext;
  readonly claim: RestoreClaim;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] |
  { readonly [key: string]: JsonValue };

/** Manager-independent preservation payload. Callers own both JSON-safe shapes. */
export interface MaintenanceResumeDocument<
  Inventory extends JsonValue = JsonValue,
  Launch extends JsonValue = JsonValue,
> {
  readonly version: typeof MAINTENANCE_RESUME_DOCUMENT_VERSION;
  readonly inventory: Inventory;
  readonly launch: Launch;
}

/** Content-addressed descriptor persisted in every maintenance journal state. */
export interface MaintenanceResumeDescriptor {
  readonly version: typeof MAINTENANCE_RESUME_DOCUMENT_VERSION;
  readonly file: "resume.json";
  readonly bytes: number;
  readonly sha256: string;
}

/** Bounded, non-secret identity of the normal listener spawned for one attempt. `target` is the
 *  store that attempt binds: the restore target for a restore, and the preserved source for an
 *  ordinary resume. The controller variant (`kind: "controller"`) additionally binds the exact
 *  service-controller broker instance, launch request and creation-pinned process; its
 *  `processOwner` is still required. A legacy proof has no `kind`, and the two variants never
 *  compare equal. */
export interface ListenerProof {
  readonly kind?: "controller";
  readonly attemptId: string;
  readonly serverName: string;
  readonly serverNonce: string;
  readonly processOwner: ProcessOwner;
  readonly serverEndpoint: string;
  readonly target: StoreIdentity;
  readonly instance?: ControllerListenerInstance;
}

export interface ControllerListenerInstance {
  readonly instanceId: string;
  readonly launchRequestId: string;
  readonly process: { readonly pid: number; readonly token: string };
}

/** Durable invalidation of one dead listener identity for this unchanged restore attempt. */
export interface RestoreListenerReplacement {
  readonly generation: number;
  readonly replacedAt: string;
  readonly proof: ListenerProof;
}

export interface ReplaceDeadRestoreListenerOptions {
  readonly ownerStatus?: (owner: ProcessOwner) => OwnerStatus;
}

export interface ManagerCommitEvidence {
  readonly attemptId: string;
  readonly state: "awaitingFinalize";
  readonly durableCommitToken: string;
}

export interface ManagerFinalizeEvidence {
  readonly attemptId: string;
  readonly state: "active";
  readonly durableCommitToken: string;
}

export interface RestoreActivationEvidence {
  readonly attemptId: string;
  readonly listenerReady: true;
  readonly observedAt: string;
  readonly managerCommit: ManagerCommitEvidence;
  readonly managerFinalize: ManagerFinalizeEvidence;
}

export interface CommitIntentRecord extends CompletedJournalBase {
  readonly state: "commit-intent";
  readonly restore: RestoreContext & { readonly target: StoreIdentity };
  readonly launch: { readonly [key: string]: JsonValue };
  readonly listenerProof?: ListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
  /** Set only after manager commitment; carried unchanged here. */
  readonly tokenHandoff?: TokenHandoff;
}

export interface RestoreManagerCommittedRecord extends CompletedJournalBase {
  readonly state: "manager-committed";
  readonly restore: RestoreContext & { readonly target: StoreIdentity };
  readonly launch: { readonly [key: string]: JsonValue };
  readonly listenerProof: ListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
  readonly tokenHandoff?: TokenHandoff;
  readonly managerCommittedAt: string;
  readonly managerCommit: ManagerCommitEvidence;
}

export interface RestoreActiveRecord extends CompletedJournalBase {
  readonly state: "active";
  readonly restore: RestoreContext & { readonly target: StoreIdentity };
  readonly launch: { readonly [key: string]: JsonValue };
  readonly listenerProof?: ListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
  readonly tokenHandoff?: TokenHandoff;
  readonly managerCommittedAt: string;
  readonly managerCommit: ManagerCommitEvidence;
  readonly activeAt: string;
  readonly details: RestoreActivationEvidence;
}

export interface RestoreDegradedRecord extends CompletedJournalBase {
  readonly state: "degraded";
  readonly restore: RestoreContext & { readonly target: StoreIdentity };
  readonly launch: { readonly [key: string]: JsonValue };
  readonly listenerProof?: ListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
  readonly tokenHandoff?: TokenHandoff;
  /** Present when degradation followed manager commitment, including after finalization. */
  readonly managerCommittedAt?: string;
  readonly managerCommit?: ManagerCommitEvidence;
  /** Present when degradation followed finalization; such a listener is not replaceable here. */
  readonly activeAt?: string;
  readonly details?: RestoreActivationEvidence;
  readonly degradedAt: string;
  readonly reason: string;
  readonly recourse: readonly MaintenanceRecourse[];
}

/** Fsynced launch inputs for resuming the unchanged ready source through the normal listener. A
 *  controller resume's launch carries `custody: "controller"` and a `controller` binding, read
 *  through {@link ordinaryResumeController}. */
export interface OrdinaryResumeContext {
  readonly attemptId: string;
  readonly intentAt: string;
  readonly launch: { readonly [key: string]: JsonValue };
}

export interface OrdinaryResumeActivationEvidence {
  readonly operation: "resumePreserved";
  readonly attemptId: string;
  readonly state: "awaitingCommit";
  readonly observedAt: string;
}

/** Exact bound listener identity + retired-listener history shared by every resume phase. The
 *  proof's `target` is the preserved SOURCE store identity for an ordinary resume. */
interface OrdinaryResumeListenerState {
  readonly listenerProof?: ListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
  /** The commit-token handoff file for a manager-committed attempt, in any custody. */
  readonly tokenHandoff?: TokenHandoff;
}

export interface OrdinaryResumeIntentRecord extends CompletedJournalBase, OrdinaryResumeListenerState {
  readonly state: "resume-intent";
  readonly ordinaryResume: OrdinaryResumeContext;
}

export interface OrdinaryResumeActiveRecord extends CompletedJournalBase, OrdinaryResumeListenerState {
  readonly state: "resume-active";
  readonly ordinaryResume: OrdinaryResumeContext;
  readonly activeAt: string;
  /** Caller-supplied proof/result data for listener readiness and same-principal activation. */
  readonly activation: OrdinaryResumeActivationEvidence;
}

export interface OrdinaryResumeCommittedRecord extends CompletedJournalBase, OrdinaryResumeListenerState {
  readonly state: "resume-committed";
  readonly ordinaryResume: OrdinaryResumeContext;
  readonly activeAt: string;
  readonly activation: OrdinaryResumeActivationEvidence;
  readonly managerCommittedAt: string;
  readonly managerCommit: ManagerCommitEvidence;
}

export interface OrdinaryResumeDegradedRecord extends CompletedJournalBase, OrdinaryResumeListenerState {
  readonly state: "resume-degraded";
  readonly ordinaryResume: OrdinaryResumeContext;
  readonly activeAt?: string;
  readonly activation?: OrdinaryResumeActivationEvidence;
  readonly managerCommittedAt?: string;
  readonly managerCommit?: ManagerCommitEvidence;
  readonly degradedAt: string;
  readonly reason: string;
  readonly recourse: readonly MaintenanceRecourse[];
}

/** Terminal, still-durable proof that activation succeeded and journal consumption is now safe. */
export interface OrdinaryResumeRetiredRecord extends CompletedJournalBase, OrdinaryResumeListenerState {
  readonly state: "resume-retired";
  readonly ordinaryResume: OrdinaryResumeContext;
  readonly activeAt: string;
  readonly activation: OrdinaryResumeActivationEvidence;
  readonly managerCommittedAt: string;
  readonly managerCommit: ManagerCommitEvidence;
  readonly retiredAt: string;
  readonly retirement: ManagerFinalizeEvidence;
}

export type OrdinaryResumeRecord =
  | OrdinaryResumeIntentRecord
  | OrdinaryResumeActiveRecord
  | OrdinaryResumeCommittedRecord
  | OrdinaryResumeDegradedRecord
  | OrdinaryResumeRetiredRecord;

export type MaintenanceJournal =
  | MaintenanceCutIntentRecord
  | MaintenanceCutCommittedRecord
  | MaintenanceReadyRecord
  | MaintenanceClaimedRecord
  | RestoreReadyRecord
  | CommitIntentRecord
  | RestoreManagerCommittedRecord
  | RestoreActiveRecord
  | RestoreDegradedRecord
  | OrdinaryResumeRecord;

export interface MaintenancePaths {
  readonly root: string;
  readonly cotalDir: string;
  readonly maintenanceDir: string;
  readonly versionDir: string;
  readonly journal: string;
  readonly resume: string;
  readonly prepareIntent: string;
  readonly commitIntent: string;
  readonly lock: string;
  readonly reaper: string;
  /** The commit-token handoff directory (0700, never adopted or chmodded). */
  readonly handoff: string;
}

export interface MaintenanceLock {
  readonly root: string;
  readonly path: string;
  readonly token: string;
  readonly owner: ProcessOwner;
  /** Empty directories created only to hold this lock, deepest first. */
  readonly createdDirectories?: readonly string[];
}

export interface AcquireMaintenanceLockOptions {
  readonly owner?: ProcessOwner;
  readonly ownerStatus?: (owner: ProcessOwner) => OwnerStatus;
  /** What the holder does, such as `backup create`, recorded in the lock so a refused contender can
   *  name it ({@link readMaintenanceLockHolder}). */
  readonly operation?: string;
}

const noRecourse: readonly MaintenanceRecourse[] = [];
export const STORE_ID_FILE = ".cotal-store-id";
export const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const DURABLE_COMMIT_TOKEN = /^[a-f0-9]{64}$/;

export function maintenanceError(
  code: MaintenanceErrorCode,
  message: string,
  details: Omit<MaintenanceErrorDetails, "recourse"> &
    { readonly recourse?: readonly MaintenanceRecourse[] } = {},
): never {
  throw new MaintenanceError(code, message, { ...details, recourse: details.recourse ?? noRecourse });
}

export function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function canonicalRoot(root: string): string {
  if (!root || !isAbsolute(root))
    maintenanceError("invalid-path", "maintenance root must be an absolute existing directory", {
      root,
      paths: [root],
    });
  let canonical: string;
  try {
    canonical = realpathSync.native(root);
  } catch {
    maintenanceError("invalid-path", "maintenance root does not exist", { root, paths: [root] });
  }
  if (!statSync(canonical!).isDirectory())
    maintenanceError("invalid-path", "maintenance root is not a directory", { root, paths: [root] });
  return canonical!;
}

export function maintenancePaths(root: string): MaintenancePaths {
  const canonical = canonicalRoot(root);
  const cotalDir = join(canonical, ".cotal");
  const maintenanceDir = join(cotalDir, "maintenance");
  const versionDir = join(maintenanceDir, `v${MAINTENANCE_JOURNAL_VERSION}`);
  return {
    root: canonical,
    cotalDir,
    maintenanceDir,
    versionDir,
    journal: join(versionDir, "journal.json"),
    resume: join(versionDir, "resume.json"),
    prepareIntent: join(versionDir, "prepare-intent.json"),
    commitIntent: join(versionDir, "commit-intent.json"),
    lock: join(maintenanceDir, "lock.json"),
    reaper: join(maintenanceDir, "lock-reaper.json"),
    handoff: join(versionDir, "handoff"),
  };
}

export function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    // Windows does not support opening/fsyncing a directory. POSIX errors are correctness failures.
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureDirectory(path: string, harden: boolean): void {
  if (!existsSync(path)) {
    // A concurrent first operation on this root can create it between the check and the mkdir; the
    // checks below verify what is there, and the lock then names that operation.
    try {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    maintenanceError("invalid-path", "maintenance path is not a real directory", { paths: [path] });
  if (harden) {
    if (process.platform !== "win32") chmodSync(path, 0o700);
    hardenPrivate(path, "dir");
  }
}

export function ensureLayout(paths: MaintenancePaths): void {
  ensureDirectory(paths.cotalDir, false);
  ensureDirectory(paths.maintenanceDir, true);
  ensureDirectory(paths.versionDir, true);
}

export function canonicalAbsentPath(path: string): string {
  if (!path || !isAbsolute(path))
    maintenanceError("invalid-path", "store path must be absolute", { paths: [path] });
  const parent = dirname(resolve(path));
  let realParent: string;
  try {
    realParent = realpathSync.native(parent);
  } catch {
    maintenanceError("invalid-path", "store parent does not exist", { paths: [parent] });
  }
  const canonical = join(realParent!, basename(path));
  if (pathExistsStrict(canonical))
    maintenanceError("path-exists", "store path must be absent", {
      paths: [canonical],
      recourse: [{ action: "inspect", description: "Inspect the unexpected path before retrying.", paths: [canonical] }],
    });
  return canonical;
}

export function canonicalCandidatePath(path: string): string {
  if (!path || !isAbsolute(path))
    maintenanceError("invalid-path", "store path must be absolute", { paths: [path] });
  if (pathExistsStrict(resolve(path))) {
    try {
      return realpathSync.native(resolve(path));
    } catch {
      maintenanceError("invalid-path", "store path cannot be resolved safely", { paths: [path] });
    }
  }
  return canonicalAbsentPath(path);
}

export function pathContains(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}

export function assertPathsDoNotOverlap(a: string, b: string, message: string): void {
  if (pathContains(a, b) || pathContains(b, a))
    maintenanceError("invalid-path", message, {
      paths: [a, b],
      recourse: [{ action: "inspect", description: "Choose disjoint source and target directory trees.", paths: [a, b] }],
    });
}

export function pathExistsStrict(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    maintenanceError("invalid-path", "filesystem path cannot be inspected safely", { paths: [path] });
  }
}

function storeGeneration(path: string, create: boolean): string {
  const marker = join(path, STORE_ID_FILE);
  if (!pathExistsStrict(marker)) {
    if (!create)
      maintenanceError("identity-mismatch", "store generation marker is missing", {
        paths: [path, marker],
        recourse: [{ action: "inspect", description: "Treat this path as a replacement until its provenance is proven.", paths: [path] }],
      });
    writePrivateExclusive(marker, `${randomUUID()}\n`);
  }
  let stat;
  try {
    stat = lstatSync(marker);
  } catch {
    maintenanceError("identity-mismatch", "store generation marker cannot be inspected", { paths: [path, marker] });
  }
  if (!stat!.isFile() || stat!.isSymbolicLink() || stat!.size > 128)
    maintenanceError("identity-mismatch", "store generation marker is invalid", { paths: [path, marker] });
  const generation = readFileSync(marker, "utf8").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generation))
    maintenanceError("identity-mismatch", "store generation marker is corrupt", { paths: [path, marker] });
  return generation;
}

function storeIdentity(path: string, createGeneration: boolean): StoreIdentity {
  if (!path || !isAbsolute(path))
    maintenanceError("invalid-path", "store path must be absolute", { paths: [path] });
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch (error) {
    if (errno(error) === "ENOENT")
      maintenanceError("path-missing", "store path is missing", { paths: [path] });
    maintenanceError("invalid-path", "store path cannot be resolved safely", { paths: [path] });
  }
  const stat = lstatSync(canonical!, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    maintenanceError("invalid-path", "store path must be a real directory", { paths: [canonical!] });
  return {
    path: canonical!, dev: stat.dev.toString(), ino: stat.ino.toString(),
    generation: storeGeneration(canonical!, createGeneration),
  };
}

/** Read an already-bound store identity. Missing generation is a replacement ambiguity, not absence. */
export function readStoreIdentity(path: string): StoreIdentity {
  return storeIdentity(path, false);
}

/** Bind a stopped source or attempt-owned target to a non-reusable generation marker. */
export function ensureStoreIdentity(path: string): StoreIdentity {
  return storeIdentity(path, true);
}

export function sameStoreIdentity(a: StoreIdentity, b: StoreIdentity): boolean {
  return a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.generation === b.generation;
}

export function identityAt(path: string): StoreIdentity | undefined {
  try {
    return readStoreIdentity(path);
  } catch (error) {
    if (isMaintenanceError(error) && error.code === "path-missing") return undefined;
    throw error;
  }
}

export function assertStoreIdentity(expected: StoreIdentity): StoreIdentity {
  const actual = identityAt(expected.path);
  if (!actual)
    maintenanceError("path-missing", "recorded store path is missing", {
      paths: [expected.path], expected,
      recourse: [{ action: "inspect", description: "Do not recreate the path; inspect maintenance state first.", paths: [expected.path] }],
    });
  if (!sameStoreIdentity(expected, actual!))
    maintenanceError("identity-mismatch", "recorded store path has been replaced", {
      paths: [expected.path], expected, actual,
      recourse: [{ action: "inspect", description: "Preserve both stores and determine which inode is authoritative.", paths: [expected.path] }],
    });
  return actual!;
}

export function writePrivateExclusive(path: string, data: string): void {
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    created = true;
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    hardenPrivate(path, "file");
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try { unlinkSync(path); } catch { /* remove only the path this exclusive create owned */ }
    }
    throw error;
  }
}

export function atomicWrite(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writePrivateExclusive(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort for an exclusively-created temp */ }
    throw error;
  }
}

export function defaultOwner(): ProcessOwner {
  return { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), id: randomUUID() };
}

export function localProcessOwnerStatus(owner: ProcessOwner): OwnerStatus {
  if (owner.host !== hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    if (errno(error) === "ESRCH") return "dead";
    if (errno(error) === "EPERM") return "alive";
    return "unknown";
  }
}

export function parseOwner(value: unknown, label: string): ProcessOwner {
  const o = value as ProcessOwner;
  if (!o || typeof o !== "object" || !Number.isInteger(o.pid) || o.pid <= 0 ||
      typeof o.host !== "string" || !o.host || typeof o.startedAt !== "string" || !Number.isFinite(Date.parse(o.startedAt)) ||
      typeof o.id !== "string" || !o.id)
    maintenanceError("journal-corrupt", `invalid ${label} owner record`);
  return o;
}

function readLockFile(path: string): { token: string; owner: ProcessOwner; operation?: string } {
  let parsed: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
      maintenanceError("journal-corrupt", "maintenance lock is not a bounded regular file", { paths: [path] });
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (isMaintenanceError(error)) throw error;
    if (errno(error) === "ENOENT") throw error;
    maintenanceError("journal-corrupt", "maintenance lock cannot be parsed", { paths: [path] });
  }
  const lock = parsed as { token?: unknown; owner?: unknown; operation?: unknown };
  if (!lock || typeof lock !== "object" || typeof lock.token !== "string" || !lock.token)
    maintenanceError("journal-corrupt", "maintenance lock has no token", { paths: [path] });
  const operation = typeof lock.operation === "string" && /^[a-z][a-z -]{0,63}$/.test(lock.operation) ? lock.operation : undefined;
  return { token: lock.token, owner: parseOwner(lock.owner, "lock"), ...(operation ? { operation } : {}) };
}

/** The process that holds this root's maintenance lock, and the operation it recorded, for a refused
 *  contender to name. Undefined when no lock is held or it cannot be read. */
export function readMaintenanceLockHolder(root: string): { readonly owner: ProcessOwner; readonly operation?: string } | undefined {
  try {
    const { owner, operation } = readLockFile(maintenancePaths(root).lock);
    return { owner, ...(operation ? { operation } : {}) };
  } catch { return undefined; }
}

function removeReaper(path: string, token: string): void {
  try {
    const current = readLockFile(path);
    if (current.token === token) {
      unlinkSync(path);
      fsyncDirectory(dirname(path));
    }
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

/** Whether a live process holds `root`'s maintenance lock, read without taking it: the holder's
 *  status as {@link acquireMaintenanceLock} would judge it, or `undefined` when no lock is held. */
export function maintenanceLockHolder(root: string): OwnerStatus | undefined {
  try {
    return localProcessOwnerStatus(readLockFile(maintenancePaths(root).lock).owner);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

export function acquireMaintenanceLock(
  root: string,
  options: AcquireMaintenanceLockOptions = {},
): MaintenanceLock {
  const paths = maintenancePaths(root);
  ensureLayout(paths);
  const owner = options.owner ?? defaultOwner();
  parseOwner(owner, "requested lock");
  const token = randomUUID();
  const body = `${JSON.stringify({ token, owner, ...(options.operation ? { operation: options.operation } : {}) }, null, 2)}\n`;

  try {
    writePrivateExclusive(paths.lock, body);
    return { root: paths.root, path: paths.lock, token, owner };
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }

  // One exclusive reaper serializes stale-owner removal. Without it, two reclaimers could race
  // between checking the old inode and unlinking it, and one could unlink the other's new lock.
  const reaperToken = randomUUID();
  try {
    writePrivateExclusive(paths.reaper, `${JSON.stringify({ token: reaperToken, owner }, null, 2)}\n`);
  } catch (error) {
    if (errno(error) === "EEXIST") {
      const stale = readLockFile(paths.reaper);
      const status = (options.ownerStatus ?? localProcessOwnerStatus)(stale.owner);
      if (status === "alive")
        maintenanceError("lock-held", "maintenance lock recovery is already in progress", {
          root: paths.root,
          recourse: [{ action: "retry", description: "Retry after the current maintenance operation exits." }],
        });
      if (status === "unknown")
        maintenanceError("lock-owner-ambiguous", "maintenance lock reaper death cannot be proven", {
          root: paths.root,
          paths: [paths.reaper],
          recourse: [{ action: "inspect", description: "Prove the recorded reaper owner dead before retrying.", paths: [paths.reaper] }],
        });
      // There is no portable token-conditional unlink. Automatic recovery would let two contenders
      // both approve the stale token, then one unlink the other's fresh reaper. Fail closed and make
      // the deliberate single-operator recovery step explicit instead of weakening exclusion.
      maintenanceError("lock-owner-ambiguous", "maintenance lock reaper is stale and requires manual recovery", {
        root: paths.root,
        paths: [paths.lock, paths.reaper],
        recourse: [{
          action: "repair",
          description: "With all Cotal maintenance commands stopped, remove only the recorded stale reaper, then retry; the stale main lock will be recovered normally.",
          paths: [paths.reaper],
        }],
      });
    }
    throw error;
  }

  let takenOver: ProcessOwner | undefined;
  try {
    let existing: { token: string; owner: ProcessOwner } | undefined;
    try {
      existing = readLockFile(paths.lock);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    if (existing) {
      const status = (options.ownerStatus ?? localProcessOwnerStatus)(existing.owner);
      if (status === "alive")
        maintenanceError("lock-held", "maintenance lock is held by a live owner", {
          root: paths.root,
          recourse: [{ action: "retry", description: "Wait for the current maintenance operation to finish." }],
        });
      if (status === "unknown")
        maintenanceError("lock-owner-ambiguous", "maintenance lock owner death cannot be proven", {
          root: paths.root,
          recourse: [{ action: "inspect", description: "Confirm the recorded host and process are dead before retrying.", paths: [paths.lock] }],
        });
      const again = readLockFile(paths.lock);
      if (again.token !== existing.token)
        maintenanceError("lock-held", "maintenance lock changed during stale-owner recovery", {
          root: paths.root,
          recourse: [{ action: "retry", description: "Retry after the current maintenance operation exits." }],
        });
      unlinkSync(paths.lock);
      fsyncDirectory(paths.maintenanceDir);
      takenOver = existing.owner;
    }
  } finally {
    removeReaper(paths.reaper, reaperToken);
  }

  // Another waiter may win after stale removal. Exclusive create remains the arbiter.
  try {
    writePrivateExclusive(paths.lock, body);
  } catch (error) {
    if (errno(error) === "EEXIST")
      maintenanceError("lock-held", "another maintenance operation acquired the recovered lock", {
        root: paths.root,
        recourse: [{ action: "retry", description: "Retry after the current maintenance operation exits." }],
      });
    throw error;
  }
  // A lock is taken over only from an owner proven dead, and the run that takes it says so.
  if (takenOver) recordOperationWarning({
    code: "MAINTENANCE_LOCK_TAKEN_OVER",
    target: { root: paths.root, path: paths.lock, owner: { pid: takenOver.pid, host: takenOver.host, startedAt: takenOver.startedAt } },
    message: `took over the maintenance lock in ${paths.root} that process ${takenOver.pid} (started ${takenOver.startedAt}) left; that process is no longer running, so the command it ran there ended without releasing it`,
  });
  return { root: paths.root, path: paths.lock, token, owner };
}

export function assertLock(lock: MaintenanceLock): void {
  const paths = maintenancePaths(lock.root);
  if (paths.lock !== lock.path)
    maintenanceError("lock-lost", "maintenance lock belongs to a different root", { root: paths.root });
  let current: { token: string; owner: ProcessOwner };
  try {
    current = readLockFile(lock.path);
  } catch (error) {
    if (errno(error) === "ENOENT")
      maintenanceError("lock-lost", "maintenance lock disappeared", { root: paths.root });
    throw error;
  }
  if (current.token !== lock.token)
    maintenanceError("lock-lost", "maintenance lock ownership changed", { root: paths.root });
}

/** Verify a retained lock token at the expected root, without releasing it. */
export function assertMaintenanceLock(lock: MaintenanceLock, root = lock.root): void {
  if (maintenancePaths(root).root !== lock.root)
    maintenanceError("lock-lost", "maintenance lock belongs to a different root", { root: maintenancePaths(root).root });
  assertLock(lock);
}

export function releaseMaintenanceLock(lock: MaintenanceLock): void {
  assertLock(lock);
  unlinkSync(lock.path);
  fsyncDirectory(dirname(lock.path));
  const onlyLockLayout = lock.createdDirectories !== undefined && readdirSync(join(lock.root, ".cotal")).every((entry) => entry === "maintenance");
  for (const dir of onlyLockLayout ? lock.createdDirectories ?? [] : []) {
    try { rmdirSync(dir); } catch { break; }
  }
}

export function withMaintenanceLock<T>(
  root: string,
  operation: (lock: MaintenanceLock) => T,
  options: AcquireMaintenanceLockOptions = {},
): T {
  const lock = acquireMaintenanceLock(root, options);
  try {
    return operation(lock);
  } finally {
    releaseMaintenanceLock(lock);
  }
}

/** Residue a crashed attempt may leave in a pending (pre-inode) destination slot. */
const DESTINATION_RESIDUE = /^(stream-[0-9a-f]{24}\.snap|checkpoints\.json|manifest\.json\.[A-Za-z0-9.-]+\.tmp)$/;

/** Remove exactly the journaled attempt-owned paths, or fail closed WITHOUT surrendering ownership.
 *  Every branch must prove what it deletes: a proven slot deletes only its exact inode; a pending
 *  destination slot deletes only recognizable attempt residue; anything else is preserved, and any
 *  removal failure keeps the claim so a retry (not silence) finishes the cleanup. */
export function removeOwnedPathsOrFail(
  lock: MaintenanceLock,
  attemptId: string,
  ownedPaths: readonly AttemptOwnedPath[] | undefined,
): void {
  const failures: string[] = [];
  for (const owned of ownedPaths ?? []) {
    try {
      let stat;
      try {
        stat = lstatSync(owned.path, { bigint: true });
      } catch (error) {
        if (errno(error) === "ENOENT") continue;
        throw error;
      }
      // A destination with a published manifest is a COMPLETE artifact, never recovery residue.
      if (owned.label === "destination" && stat.isDirectory() && pathExistsStrict(join(owned.path, "manifest.json"))) continue;
      if (owned.dev === undefined) {
        // Pending slot: the path was journaled before creation, so no inode proof exists.
        if (owned.label !== "destination") {
          // Non-destination slots live only inside Cotal's private attempts tree, where a live
          // journal record + claim exclusivity make any plain directory ours by construction.
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            rmSync(owned.path, { recursive: true });
            fsyncDirectory(dirname(owned.path));
          } else {
            failures.push(`${owned.path} (pending slot is not a plain directory)`);
          }
          continue;
        }
        // A destination is operator-named: delete only recognizable attempt residue.
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          failures.push(`${owned.path} (pending destination is not a plain directory)`);
          continue;
        }
        const entries = readdirSync(owned.path);
        const residueOnly = entries.every((name) => {
          if (!DESTINATION_RESIDUE.test(name)) return false;
          const child = lstatSync(join(owned.path, name));
          return child.isFile() && !child.isSymbolicLink();
        });
        if (!residueOnly) {
          failures.push(`${owned.path} (pending destination holds unrecognized content)`);
          continue;
        }
        rmSync(owned.path, { recursive: true });
        fsyncDirectory(dirname(owned.path));
        continue;
      }
      if (stat.isSymbolicLink() || stat.dev.toString() !== owned.dev || stat.ino.toString() !== owned.ino)
        continue; // replaced by something that is not ours — preserve
      if (stat.isDirectory()) rmSync(owned.path, { recursive: true });
      else rmSync(owned.path);
      fsyncDirectory(dirname(owned.path));
    } catch (error) {
      failures.push(`${owned.path} (${(error as Error).message})`);
    }
  }
  if (failures.length)
    maintenanceError("cleanup-incomplete", "attempt-owned cleanup could not be proven complete", {
      root: lock.root, attemptId,
      paths: (ownedPaths ?? []).map((owned) => owned.path),
      recourse: [{ action: "retry", description: `Resolve and retry: ${failures.join("; ")}` }],
    });
}

/** Every transition that rebuilds a resume or committed-restore record keeps its handoff record,
 *  so a later run can still sweep or settle the exact recorded file. */
export function carriedTokenHandoff(record: { readonly tokenHandoff?: TokenHandoff }): { tokenHandoff?: TokenHandoff } {
  return record.tokenHandoff ? { tokenHandoff: record.tokenHandoff } : {};
}

/** Step 7: retirement or restore activation requires a settled handoff when one was made. */
export function requireSettledTokenHandoff(record: { readonly tokenHandoff?: TokenHandoff }, root: string): void {
  if (record.tokenHandoff && record.tokenHandoff.state !== "consumed" && record.tokenHandoff.state !== "swept")
    maintenanceError("invalid-transition", "the commit-token handoff is not settled; activation cannot retire it", { root, paths: [record.tokenHandoff.path] });
}
