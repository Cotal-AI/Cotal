import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hardenPrivate } from "@cotal-ai/core";

/** Version 1 lives in `<project>/.cotal/maintenance/v1`; the lock is shared across versions. */
export const MAINTENANCE_JOURNAL_VERSION = 1 as const;
/**
 * The resume document version WRITTEN by this binary.
 *
 * **v2 exists because `launch.transcript` became `launch.events`, and those are not the same
 * request.** `transcript` asked for the condensed-text `tr-` mirror; `events` asks for the agent
 * event plane that REPLACED it — a different mechanism, wire shape, grant and consumer. Treating
 * one as a spelling of the other is a semantic decision, and this version boundary is where that
 * decision is made visibly and once, rather than invisibly on every read by a parser alias.
 *
 * **The bump is also the only thing that arms the downgrade barrier at all.** Both gates below
 * (`resumeBytes` normalization and `validResumeDescriptor`) compare the version for equality against
 * a known set. Had this stayed at 1, a new binary would write `launch.events` into a document still
 * stamped v1, an older binary would accept that version, proceed, and find the key it expects simply
 * absent — silently. Leaving the version alone does not preserve the barrier; it disarms it.
 */
export const MAINTENANCE_RESUME_DOCUMENT_VERSION = 2 as const;

/**
 * Versions this binary can READ. Writing is always at the current version; reading accepts the
 * older shapes it knows how to migrate, and **anything outside this set fails loud** — a newer
 * document reaching an older binary is the no-downgrade support boundary, not a parse error.
 */
export const SUPPORTED_RESUME_DOCUMENT_VERSIONS = [1, 2] as const;
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

interface CompletedJournalBase extends JournalBase {
  readonly cutCompletion: MaintenanceCutCompletionEvidence;
}

export interface MaintenanceCutContext {
  readonly attemptId: string;
  readonly intentAt: string;
  readonly launch: { readonly server: string; readonly [key: string]: JsonValue };
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

export interface RestoreContext {
  readonly attemptId: string;
  readonly method: "same-path" | "alternate" | "disaster";
  readonly targetPath: string;
  readonly fallbackPath?: string;
  readonly previousSource?: PreviousSource;
  readonly target?: StoreIdentity;
  readonly cleanup?: CleanupProgress;
  /** Attempt-owned working trees (staging, quarantine, sanitized) journaled before use so crash
   *  recovery deletes exactly these inodes and nothing else. */
  readonly ownedPaths?: readonly AttemptOwnedPath[];
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

/** Bounded, non-secret identity of the normal listener spawned for one restore attempt. */
export interface RestoreListenerProof {
  readonly attemptId: string;
  readonly serverName: string;
  readonly serverNonce: string;
  readonly processOwner: ProcessOwner;
  readonly serverEndpoint: string;
  readonly target: StoreIdentity;
}

/** Durable invalidation of one dead listener identity for this unchanged restore attempt. */
export interface RestoreListenerReplacement {
  readonly generation: number;
  readonly replacedAt: string;
  readonly proof: RestoreListenerProof;
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
  readonly listenerProof?: RestoreListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
}

export interface RestoreManagerCommittedRecord extends CompletedJournalBase {
  readonly state: "manager-committed";
  readonly restore: RestoreContext & { readonly target: StoreIdentity };
  readonly launch: { readonly [key: string]: JsonValue };
  readonly listenerProof: RestoreListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
  readonly managerCommittedAt: string;
  readonly managerCommit: ManagerCommitEvidence;
}

export interface RestoreActiveRecord extends CompletedJournalBase {
  readonly state: "active";
  readonly restore: RestoreContext & { readonly target: StoreIdentity };
  readonly launch: { readonly [key: string]: JsonValue };
  readonly listenerProof?: RestoreListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
  readonly managerCommittedAt: string;
  readonly managerCommit: ManagerCommitEvidence;
  readonly activeAt: string;
  readonly details: RestoreActivationEvidence;
}

export interface RestoreDegradedRecord extends CompletedJournalBase {
  readonly state: "degraded";
  readonly restore: RestoreContext & { readonly target: StoreIdentity };
  readonly launch: { readonly [key: string]: JsonValue };
  readonly listenerProof?: RestoreListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
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

/** Fsynced launch inputs for resuming the unchanged ready source through the normal listener. */
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
  readonly listenerProof?: RestoreListenerProof;
  readonly listenerReplacements?: readonly RestoreListenerReplacement[];
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
}

export interface MaintenanceLock {
  readonly root: string;
  readonly path: string;
  readonly token: string;
  readonly owner: ProcessOwner;
}

export interface AcquireMaintenanceLockOptions {
  readonly owner?: ProcessOwner;
  readonly ownerStatus?: (owner: ProcessOwner) => OwnerStatus;
}

const noRecourse: readonly MaintenanceRecourse[] = [];
const STORE_ID_FILE = ".cotal-store-id";
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DURABLE_COMMIT_TOKEN = /^[a-f0-9]{64}$/;

function maintenanceError(
  code: MaintenanceErrorCode,
  message: string,
  details: Omit<MaintenanceErrorDetails, "recourse"> &
    { readonly recourse?: readonly MaintenanceRecourse[] } = {},
): never {
  throw new MaintenanceError(code, message, { ...details, recourse: details.recourse ?? noRecourse });
}

function errno(error: unknown): string | undefined {
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
  };
}

function fsyncDirectory(path: string): void {
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
    mkdirSync(path, { mode: 0o700 });
    fsyncDirectory(dirname(path));
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    maintenanceError("invalid-path", "maintenance path is not a real directory", { paths: [path] });
  if (harden) {
    if (process.platform !== "win32") chmodSync(path, 0o700);
    hardenPrivate(path, "dir");
  }
}

function ensureLayout(paths: MaintenancePaths): void {
  ensureDirectory(paths.cotalDir, false);
  ensureDirectory(paths.maintenanceDir, true);
  ensureDirectory(paths.versionDir, true);
}

function canonicalAbsentPath(path: string): string {
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

function canonicalCandidatePath(path: string): string {
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

function pathContains(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}

function assertPathsDoNotOverlap(a: string, b: string, message: string): void {
  if (pathContains(a, b) || pathContains(b, a))
    maintenanceError("invalid-path", message, {
      paths: [a, b],
      recourse: [{ action: "inspect", description: "Choose disjoint source and target directory trees.", paths: [a, b] }],
    });
}

function pathExistsStrict(path: string): boolean {
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

function identityAt(path: string): StoreIdentity | undefined {
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

function writePrivateExclusive(path: string, data: string): void {
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

function atomicWrite(path: string, value: unknown): void {
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

function defaultOwner(): ProcessOwner {
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

function parseOwner(value: unknown, label: string): ProcessOwner {
  const o = value as ProcessOwner;
  if (!o || typeof o !== "object" || !Number.isInteger(o.pid) || o.pid <= 0 ||
      typeof o.host !== "string" || !o.host || typeof o.startedAt !== "string" || !Number.isFinite(Date.parse(o.startedAt)) ||
      typeof o.id !== "string" || !o.id)
    maintenanceError("journal-corrupt", `invalid ${label} owner record`);
  return o;
}

function readLockFile(path: string): { token: string; owner: ProcessOwner } {
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
  const lock = parsed as { token?: unknown; owner?: unknown };
  if (!lock || typeof lock !== "object" || typeof lock.token !== "string" || !lock.token)
    maintenanceError("journal-corrupt", "maintenance lock has no token", { paths: [path] });
  return { token: lock.token, owner: parseOwner(lock.owner, "lock") };
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

export function acquireMaintenanceLock(
  root: string,
  options: AcquireMaintenanceLockOptions = {},
): MaintenanceLock {
  const paths = maintenancePaths(root);
  ensureLayout(paths);
  const owner = options.owner ?? defaultOwner();
  parseOwner(owner, "requested lock");
  const token = randomUUID();
  const body = `${JSON.stringify({ token, owner }, null, 2)}\n`;

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
  return { root: paths.root, path: paths.lock, token, owner };
}

function assertLock(lock: MaintenanceLock): void {
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

export function releaseMaintenanceLock(lock: MaintenanceLock): void {
  assertLock(lock);
  unlinkSync(lock.path);
  fsyncDirectory(dirname(lock.path));
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

function validIdentity(value: unknown): value is StoreIdentity {
  const identity = value as StoreIdentity;
  return Boolean(identity && typeof identity === "object" && isAbsolute(identity.path) &&
    typeof identity.dev === "string" && /^\d+$/.test(identity.dev) &&
    typeof identity.ino === "string" && /^\d+$/.test(identity.ino) &&
    typeof identity.generation === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.generation));
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",") &&
    Reflect.ownKeys(value).length === expected.length;
}

function canonicalListenerEndpoint(value: string): string | undefined {
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

function validListenerProof(value: unknown): value is RestoreListenerProof {
  const proof = value as RestoreListenerProof;
  return Boolean(proof && typeof proof === "object" &&
    exactObjectKeys(proof, ["attemptId", "serverName", "serverNonce", "processOwner", "serverEndpoint", "target"]) &&
    typeof proof.attemptId === "string" && ATTEMPT_ID.test(proof.attemptId) &&
    typeof proof.serverName === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(proof.serverName) &&
    typeof proof.serverNonce === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(proof.serverNonce) &&
    validProofOwner(proof.processOwner) && typeof proof.serverEndpoint === "string" &&
    canonicalListenerEndpoint(proof.serverEndpoint) === proof.serverEndpoint && validProofIdentity(proof.target) &&
    Buffer.byteLength(JSON.stringify(proof)) <= 16 * 1024);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validManagerCommitEvidence(value: unknown, attemptId: string): value is ManagerCommitEvidence {
  const evidence = value as ManagerCommitEvidence;
  return Boolean(evidence && typeof evidence === "object" &&
    exactObjectKeys(evidence, ["attemptId", "state", "durableCommitToken"]) &&
    evidence.attemptId === attemptId && evidence.state === "awaitingFinalize" &&
    typeof evidence.durableCommitToken === "string" && DURABLE_COMMIT_TOKEN.test(evidence.durableCommitToken));
}

function validManagerFinalizeEvidence(
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

function sameManagerCommitEvidence(a: ManagerCommitEvidence, b: ManagerCommitEvidence): boolean {
  return a.attemptId === b.attemptId && a.state === b.state &&
    a.durableCommitToken === b.durableCommitToken;
}

function sameManagerFinalizeEvidence(a: ManagerFinalizeEvidence, b: ManagerFinalizeEvidence): boolean {
  return a.attemptId === b.attemptId && a.state === b.state &&
    a.durableCommitToken === b.durableCommitToken;
}

function validRestoreActivationEvidence(value: unknown, attemptId: string): value is RestoreActivationEvidence {
  const evidence = value as RestoreActivationEvidence;
  return Boolean(evidence && typeof evidence === "object" &&
    exactObjectKeys(evidence, ["attemptId", "listenerReady", "observedAt", "managerCommit", "managerFinalize"]) &&
    evidence.attemptId === attemptId && evidence.listenerReady === true && validTimestamp(evidence.observedAt) &&
    validManagerCommitEvidence(evidence.managerCommit, attemptId) &&
    validManagerFinalizeEvidence(evidence.managerFinalize, attemptId, evidence.managerCommit.durableCommitToken));
}

function validOrdinaryResumeActivationEvidence(
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

function validOwnedPaths(value: unknown): value is readonly AttemptOwnedPath[] {
  return Array.isArray(value) && value.length <= 64 && value.every(validAttemptOwnedPath) &&
    new Set(value.map((owned: AttemptOwnedPath) => owned.path)).size === value.length;
}

function validRestoreClaim(value: unknown): value is RestoreClaim {
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
    canonicalListenerEndpoint(cut.launch.server) === cut.launch.server);
}

function validCutCompletionEvidence(
  value: unknown,
  cut: MaintenanceCutContext,
): value is MaintenanceCutCompletionEvidence {
  const evidence = value as MaintenanceCutCompletionEvidence;
  return Boolean(evidence && typeof evidence === "object" &&
    exactObjectKeys(evidence, ["attemptId", "observedAt", "managerCommit", "stopped", "listener"]) &&
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

function normalizedListenerProof(value: RestoreListenerProof): RestoreListenerProof {
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
  };
}

function sameProcessOwner(a: ProcessOwner, b: ProcessOwner): boolean {
  return a.pid === b.pid && a.host === b.host && a.startedAt === b.startedAt && a.id === b.id;
}

function sameListenerProof(a: RestoreListenerProof, b: RestoreListenerProof): boolean {
  return a.attemptId === b.attemptId && a.serverName === b.serverName &&
    a.serverNonce === b.serverNonce && sameProcessOwner(a.processOwner, b.processOwner) &&
    a.serverEndpoint === b.serverEndpoint && sameStoreIdentity(a.target, b.target);
}

function reusesListenerIdentity(a: RestoreListenerProof, b: RestoreListenerProof): boolean {
  return a.serverName === b.serverName || a.serverNonce === b.serverNonce ||
    sameProcessOwner(a.processOwner, b.processOwner);
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

function assertListenerOwnerAlive(proof: RestoreListenerProof): void {
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

function validJsonObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && validJson(value);
}

function sameJsonValue(a: JsonValue, b: JsonValue): boolean {
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

/**
 * Migrate a persisted resume document forward to {@link MAINTENANCE_RESUME_DOCUMENT_VERSION}, or
 * FAIL LOUD naming the version and the remedy.
 *
 * **v1 → v2 carries a semantic decision, stated here rather than hidden in a parser.** A v1 document
 * spelled the flag `launch.transcript`, which requested the condensed-text `tr-` mirror. That
 * mechanism has been REPLACED by the agent event plane, which `launch.events` requests. They are not
 * two spellings of one feature, so migrating the key is a judgement: **a resumed session that asked
 * for the abolished mirror is taken to be asking for its successor.** That is almost certainly what
 * an operator wants — the alternative is a preserved inventory that silently comes back with the
 * feature off — but it is a decision, and it is made once, here, at a named boundary, where a
 * reader can see it and disagree with it.
 *
 * Precedence is explicit, never OR-ed: if a document somehow carries BOTH keys it contradicts
 * itself, and `events` wins because it is the one this binary can honour.
 *
 * An UNKNOWN version is refused rather than coerced. A version ABOVE ours is the no-downgrade
 * support boundary: a newer binary wrote it, this one cannot read it, and the remedy is to upgrade
 * rather than to guess at a shape we have never seen.
 */
function refuseResumeVersion(version: unknown, paths: { readonly resume: string; readonly root: string }): never {
  if (typeof version === "number" && version > MAINTENANCE_RESUME_DOCUMENT_VERSION)
    maintenanceError("resume-invalid",
      `maintenance resume document is version ${version}; this build reads up to ` +
      `${MAINTENANCE_RESUME_DOCUMENT_VERSION}. It was written by a NEWER cotal — upgrade this ` +
      `installation to resume from it. Older builds never rewrite a newer document.`,
      { root: paths.root, paths: [paths.resume],
        recourse: [{ action: "repair", description: "Upgrade cotal to a build that reads this document version.", command: "npm i -g cotal-ai@latest", paths: [paths.resume] }] });
  maintenanceError("resume-invalid",
    `maintenance resume document reports version ${JSON.stringify(version)}, which is not a known ` +
    `version (this build reads ${SUPPORTED_RESUME_DOCUMENT_VERSIONS.join(", ")}); it is refused ` +
    `rather than coerced.`,
    { root: paths.root, paths: [paths.resume] });
}

/**
 * Rename `launch.transcript` → `launch.events` on every retained agent, leaving everything else
 * byte-identical. `events` wins if both are present — never OR-ed, since two disagreeing values must
 * not silently resolve to the permissive one, and `transcript: false` must survive as `events: false`
 * (an operator who ran `--no-transcript` does not get a live stream back on resume).
 */
function migrateInventoryAgents(inventory: unknown): unknown {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return inventory;
  const inv = inventory as { agents?: unknown };
  if (!Array.isArray(inv.agents)) return inventory;
  return {
    ...(inventory as Record<string, unknown>),
    agents: inv.agents.map((agent) => {
      if (!agent || typeof agent !== "object" || Array.isArray(agent)) return agent;
      const a = agent as { launch?: unknown };
      const launch = a.launch;
      if (!launch || typeof launch !== "object" || Array.isArray(launch) || !("transcript" in launch)) return agent;
      const { transcript, ...rest } = launch as Record<string, unknown>;
      return { ...(agent as Record<string, unknown>), launch: "events" in rest ? rest : { ...rest, events: transcript } };
    }),
  };
}

function migrateResumeDocument(parsed: unknown, paths: { readonly resume: string; readonly root: string }): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const doc = parsed as { version?: unknown; launch?: unknown };
  const version = doc.version;

  if (version === MAINTENANCE_RESUME_DOCUMENT_VERSION) return parsed;
  if (version !== 1) refuseResumeVersion(version, paths);

  // v1 → v2: rename the launch flag on EVERY RETAINED AGENT.
  //
  // **THE FLAG LIVES AT `inventory.agents[].launch`, NOT AT THE DOCUMENT'S TOP-LEVEL `launch`.**
  // An earlier version of this migration rewrote the top-level `launch`, which `cotal down
  // --preserve-state` writes as `{ attemptId, space, server, storeDir, mode }` (`down.ts`) and which
  // therefore NEVER carries an agent flag. It stamped the document v2 and changed nothing — a false
  // success, masked downstream by the manager's parser alias. Its fixture built the flag at the top
  // level because the same understanding produced both the fixture and the code, so the two agreed
  // with each other and neither agreed with the disk.
  //
  // The inventory is manager-shaped by construction — `down.ts` persists the manager's own
  // `replan.inventory` verbatim — so walking `agents[].launch` here is reading a real shape, not
  // guessing at one. The walk is deliberately defensive: anything that is not an agent array with
  // object launches is passed through untouched rather than coerced, because a document we do not
  // recognise is not one to rewrite.
  const migratedInventory = migrateInventoryAgents((parsed as { inventory?: unknown }).inventory);
  return { ...(parsed as Record<string, unknown>), version: MAINTENANCE_RESUME_DOCUMENT_VERSION, inventory: migratedInventory };
}

/**
 * The version stamped on an existing resume document, or `undefined` when there is none to read.
 *
 * Deliberately tolerant: a missing, unreadable or unparseable file returns `undefined` so the write
 * proceeds — this guard exists to stop a NEWER document being destroyed, not to make every damaged
 * file un-writable. A corrupt document is the READ path's problem and it already fails loud there.
 */
function readExistingResumeVersion(resumePath: string): number | undefined {
  try {
    const v = (JSON.parse(readFileSync(resumePath, "utf8")) as { version?: unknown }).version;
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
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
  // A READABLE version, not the current one: a v1 cut written before the rename must still resume,
  // and the migration below is what makes that safe. An older binary has only `[1]` here, so a v2
  // descriptor refuses there — that refusal IS the downgrade barrier.
  return Boolean(descriptor && typeof descriptor === "object" &&
    (SUPPORTED_RESUME_DOCUMENT_VERSIONS as readonly number[]).includes(descriptor.version) && descriptor.file === "resume.json" &&
    Number.isInteger(descriptor.bytes) && descriptor.bytes > 0 && descriptor.bytes <= MAX_MAINTENANCE_RESUME_BYTES &&
    typeof descriptor.sha256 === "string" && /^[0-9a-f]{64}$/.test(descriptor.sha256));
}

function sameResumeDescriptor(a: MaintenanceResumeDescriptor, b: MaintenanceResumeDescriptor): boolean {
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
  // NEVER OVERWRITE A NEWER DOCUMENT. The barrier was enforced on READS and absent on WRITES.
  //
  // `readMaintenanceResumeDocument` refuses a version above ours — that is the downgrade barrier, and
  // it is what every read-side test exercises. But nothing inspected an existing `resume.json` before
  // the rename below replaced it, so an OLDER build silently destroyed a NEWER document: reproduced
  // with a v3 document and the v2 writer, `overwritten = true, afterVersion = 2`. That directly
  // falsified this file's own comment claiming older builds never rewrite a newer document.
  //
  // Reachable outside a constructed case: a writer that runs before `beginMaintenanceCut` leaves a
  // `resume.json` with no journal, which is exactly the state the branch above does not cover.
  //
  // The general shape, worth more than the fix: **a barrier must be asserted on every path that can
  // cross it, not on the direction it was written for.** "Both sides" is not only shrink-and-widen;
  // it is read-and-write. This is the second read/write asymmetry in this lane — `O_NOFOLLOW` on a
  // read path with the write path open was the first.
  const existingVersion = readExistingResumeVersion(paths.resume);
  if (existingVersion !== undefined && existingVersion > MAINTENANCE_RESUME_DOCUMENT_VERSION)
    maintenanceError("resume-invalid",
      `refusing to overwrite the resume document at ${paths.resume}: it is version ${existingVersion} ` +
      `and this build writes ${MAINTENANCE_RESUME_DOCUMENT_VERSION}. It was written by a NEWER cotal — ` +
      `upgrade this installation rather than replacing a document it cannot read. Nothing was changed.`,
      { root: lock.root, paths: [paths.resume],
        recourse: [{ action: "repair", description: "Upgrade cotal to a build that writes this document version.", command: "npm i -g cotal-ai@latest", paths: [paths.resume] }] });

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
  // The version is refused FIRST and by name. Falling through to the generic "descriptor is invalid"
  // would still block a newer document — the barrier would hold — but it would tell an operator
  // nothing about WHY or what to do, and a barrier whose message cannot be acted on is only half
  // shipped. Same refusal text at both gates, so the descriptor and document layers cannot drift.
  if (descriptor && typeof descriptor === "object" &&
      !(SUPPORTED_RESUME_DOCUMENT_VERSIONS as readonly number[]).includes((descriptor as MaintenanceResumeDescriptor).version))
    refuseResumeVersion((descriptor as MaintenanceResumeDescriptor).version, { resume: paths.resume, root: paths.root });
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
  // Migrate BEFORE normalization: `resumeBytes` gates on the CURRENT version by exact equality, so
  // an un-migrated v1 document would be refused here rather than resumed. The migration is what
  // makes an existing persisted cut survive the rename.
  const migrated = migrateResumeDocument(parsed, { resume: paths.resume, root: paths.root });
  const normalized = resumeBytes(migrated as MaintenanceResumeDocument).document;
  return normalized as MaintenanceResumeDocument<Inventory, Launch>;
}

function validRecourse(value: unknown): value is readonly MaintenanceRecourse[] {
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
      typeof restore.targetPath !== "string" || !isAbsolute(restore.targetPath))
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
  if (record.listenerProof !== undefined &&
      (!validListenerProof(record.listenerProof) ||
       record.listenerProof.attemptId !== context.attemptId ||
       !sameStoreIdentity(record.listenerProof.target, record.source) ||
       typeof context.launch.server !== "string" ||
       canonicalListenerEndpoint(context.launch.server) !== record.listenerProof.serverEndpoint))
    maintenanceError("journal-corrupt", "resume listener proof is invalid or belongs to another attempt", { paths: [path] });
  if (record.listenerReplacements !== undefined &&
      (!validListenerReplacements(record.listenerReplacements) ||
       record.listenerReplacements.some((replacement) =>
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
  }
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
    if (restoreRecord.state !== "restore-ready" && restoreRecord.listenerProof !== undefined &&
        (!validListenerProof(restoreRecord.listenerProof) ||
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

function currentJournal(lock: MaintenanceLock): MaintenanceJournal {
  assertLock(lock);
  const record = readMaintenanceJournal(lock.root);
  if (!record)
    maintenanceError("journal-missing", "maintenance journal does not exist", {
      root: lock.root,
      recourse: [{ action: "repair", description: "Complete a preserve-state cut before backup or restore." }],
    });
  return record!;
}

function writeJournal<T extends Omit<MaintenanceJournal, "version" | "revision" | "updatedAt">>(
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

function readyFrom(record: CompletedJournalBase): Omit<MaintenanceReadyRecord, "version" | "revision" | "updatedAt"> {
  return {
    state: "ready", space: record.space, mode: record.mode, source: record.source, resume: record.resume,
    cut: record.cut, cutCompletion: record.cutCompletion,
  };
}

/** Attempt binding persisted BEFORE the manager is fenced, so a crash between manager preparation
 *  and the cut-intent journal write can retry with the exact attempt the manager already holds. */
export interface PreservationPrepareIntent {
  readonly attemptId: string;
  readonly space: string;
  readonly mode: MaintenanceAuthMode;
  readonly server: string;
  readonly storeDir: string;
}

function validPrepareIntent(value: unknown): value is PreservationPrepareIntent {
  const intent = value as PreservationPrepareIntent;
  return Boolean(intent && typeof intent === "object" &&
    exactObjectKeys(intent, ["attemptId", "space", "mode", "server", "storeDir"]) &&
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

function requireReady(lock: MaintenanceLock): MaintenanceReadyRecord {
  const record = currentJournal(lock);
  if (record.state !== "ready")
    maintenanceError("invalid-transition", `maintenance journal is ${record.state}, not ready`, {
      root: lock.root,
      paths: record.state === "restore-ready" ? [record.restore.targetPath, record.source.path] : [record.source.path],
    });
  assertStoreIdentity(record.source);
  return record as MaintenanceReadyRecord;
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

export function recoverStaleMaintenanceClaim(
  lock: MaintenanceLock,
  options: { readonly now?: Date; readonly ownerStatus?: (owner: ProcessOwner) => OwnerStatus } = {},
): MaintenanceReadyRecord {
  const record = currentJournal(lock);
  if (record.state !== "claimed")
    maintenanceError("invalid-transition", "maintenance journal has no claim to recover", { root: lock.root });
  const now = options.now ?? new Date();
  if (now.getTime() <= Date.parse(record.claim.deadline))
    maintenanceError("claim-not-expired", "maintenance claim deadline has not elapsed", {
      root: lock.root, attemptId: record.claim.attemptId,
      recourse: [{ action: "retry", description: `Retry after ${record.claim.deadline}.` }],
    });
  const status = options.ownerStatus ?? localProcessOwnerStatus;
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

/** Residue a crashed attempt may leave in a pending (pre-inode) destination slot. */
const DESTINATION_RESIDUE = /^(stream-[0-9a-f]{24}\.snap|checkpoints\.json|manifest\.json\.[A-Za-z0-9.-]+\.tmp)$/;

/** Remove exactly the journaled attempt-owned paths, or fail closed WITHOUT surrendering ownership.
 *  Every branch must prove what it deletes: a proven slot deletes only its exact inode; a pending
 *  destination slot deletes only recognizable attempt residue; anything else is preserved, and any
 *  removal failure keeps the claim so a retry (not silence) finishes the cleanup. */
function removeOwnedPathsOrFail(
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
  listenerProof?: RestoreListenerProof;
  listenerReplacements?: readonly RestoreListenerReplacement[];
} {
  return {
    ...(record.listenerProof ? { listenerProof: record.listenerProof } : {}),
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
  };
}

/** Fsync the exact ordinary-resume listener identity after spawn and before activation. The
 *  proof's target is the preserved SOURCE store. */
export function bindOrdinaryResumeListener(
  lock: MaintenanceLock,
  proof: RestoreListenerProof,
): OrdinaryResumeIntentRecord | OrdinaryResumeDegradedRecord {
  const record = currentJournal(lock);
  if (record.state !== "resume-intent" &&
      (record.state !== "resume-degraded" || record.managerCommit !== undefined))
    maintenanceError("invalid-transition", "resume listener can be bound only before manager commitment", {
      root: lock.root,
    });
  const normalized = normalizedListenerProof(proof);
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
    }) as OrdinaryResumeIntentRecord;
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "resume-degraded", ordinaryResume: record.ordinaryResume,
    ...(record.activeAt !== undefined ? { activeAt: record.activeAt, activation: record.activation } : {}),
    degradedAt: record.degradedAt, reason: record.reason, recourse: record.recourse,
    listenerProof: normalized,
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
  }) as OrdinaryResumeDegradedRecord;
}

/** Retire one exactly bound, provably dead resume listener before a fresh proof may be bound. A
 *  manager-committed resume never replaces its listener: the durable token is bound to it. */
export function replaceDeadOrdinaryResumeListener(
  lock: MaintenanceLock,
  proof: RestoreListenerProof,
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

function restoreBase(ready: MaintenanceReadyRecord, attemptId: string, method: RestoreContext["method"], targetPath: string): RestoreContext {
  if (!ATTEMPT_ID.test(attemptId))
    maintenanceError("invalid-transition", "restore attempt id must be a safe token", { root: ready.source.path, attemptId });
  return { attemptId, method, targetPath };
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

/** Assess the recorded pre-commit liveness claim. `live` while the deadline has not elapsed or any
 *  recorded owner is alive; `stale` only when the deadline elapsed AND every owner is proven dead. */
export function assessRestoreClaim(
  record: RestoreReadyRecord,
  options: { readonly now?: Date; readonly ownerStatus?: (owner: ProcessOwner) => OwnerStatus } = {},
): RestoreClaimAssessment {
  const now = options.now ?? new Date();
  if (now.getTime() <= Date.parse(record.claim.deadline)) return "live";
  const status = options.ownerStatus ?? localProcessOwnerStatus;
  const statuses = [record.claim.coordinator, ...record.claim.owners].map(status);
  if (statuses.includes("alive")) return "live";
  if (statuses.includes("unknown")) return "ambiguous";
  return "stale";
}

function requireRestoreReady(lock: MaintenanceLock): RestoreReadyRecord {
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
  input: { readonly attemptId: string; readonly targetPath: string; readonly fallbackPath: string; readonly claim: RestoreClaimInput },
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
    ...restoreBase(ready, input.attemptId, "same-path", targetPath), fallbackPath,
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
  input: { readonly attemptId: string; readonly targetPath: string; readonly claim: RestoreClaimInput },
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
    ...restoreBase(ready, input.attemptId, "alternate", targetPath),
    previousSource: { kind: "retained", identity: ready.source } as PreviousSource,
    ...(ownedPaths ? { ownedPaths } : {}),
  };
  return writeJournal(lock, ready, { ...readyFrom(ready), state: "restore-ready", phase: "source-retained", restore, claim }) as RestoreReadyRecord;
}

export function prepareMissingSourceRestore(
  lock: MaintenanceLock,
  input: { readonly attemptId: string; readonly targetPath: string; readonly claim: RestoreClaimInput },
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
    ...restoreBase(record, input.attemptId, "disaster", targetPath),
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

function jsonObject(value: { readonly [key: string]: JsonValue }): { readonly [key: string]: JsonValue } {
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
  proof: RestoreListenerProof,
): CommitIntentRecord {
  const record = currentJournal(lock);
  if (record.state !== "commit-intent")
    maintenanceError("invalid-transition", "restore listener can be bound only from commit intent", {
      root: lock.root,
    });
  const normalized = normalizedListenerProof(proof);
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
  }) as CommitIntentRecord;
}

/**
 * Retire one exactly bound, provably dead listener without changing the restore attempt. The
 * atomic journal transition clears the current proof before another listener may be spawned.
 */
export function replaceDeadRestoreListener(
  lock: MaintenanceLock,
  proof: RestoreListenerProof,
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
  }) as CommitIntentRecord;
}

/** Fsync the manager's suppression-retaining commit token before requesting finalization. */
export function recordRestoreManagerCommit(
  lock: MaintenanceLock,
  proof: RestoreListenerProof,
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
    managerCommittedAt: new Date().toISOString(), managerCommit: evidence,
  }) as RestoreManagerCommittedRecord;
}

export function markRestoreActive(
  lock: MaintenanceLock,
  proof: RestoreListenerProof,
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
  proof: RestoreListenerProof,
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
    rmSync(cleanup.tombPath, { recursive: true });
    fsyncDirectory(dirname(cleanup.tombPath));
  }
  const restore = { ...record.restore, cleanup: { ...cleanup, status: "complete" as const } };
  if (record.state === "restore-ready")
    return writeJournal(lock, record, { ...readyFrom(record), state: "restore-ready", phase: record.phase, restore, claim: record.claim }) as RestoreReadyRecord;
  return writeJournal(lock, record, {
    ...readyFrom(record), state: "active", restore: restore as RestoreContext & { target: StoreIdentity },
    launch: record.launch, ...(record.listenerProof ? { listenerProof: record.listenerProof } : {}),
    ...(record.listenerReplacements ? { listenerReplacements: record.listenerReplacements } : {}),
    managerCommittedAt: record.managerCommittedAt, managerCommit: record.managerCommit,
    activeAt: record.activeAt, details: record.details,
  }) as RestoreActiveRecord;
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
}

/** Refuse to touch a LIVE restore attempt: only the exact recorded coordinator, or a caller that
 *  proves the attempt stale (deadline elapsed + every owner dead), may roll it back. */
function assertRestoreClaimRollbackable(lock: MaintenanceLock, record: RestoreReadyRecord, options: RollbackRestoreOptions): void {
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

export function cleanupRestoreFallback(lock: MaintenanceLock, attemptId: string): RestoreActiveRecord {
  let record = currentJournal(lock);
  if (record.state !== "active" || record.restore.attemptId !== attemptId)
    maintenanceError("cleanup-forbidden", "old-source cleanup requires the matching healthy active restore", {
      root: lock.root, attemptId,
      recourse: [{ action: "repair", description: "Recover the restore to healthy active state before cleanup." }],
    });
  assertStoreIdentity(record.restore.target);
  const previous = record.restore.previousSource;
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
  if (!record.restore.cleanup)
    record = startCleanup(lock, record, "previous-source", previous.identity) as RestoreActiveRecord;
  if (record.restore.cleanup?.kind !== "previous-source")
    maintenanceError("cleanup-forbidden", "active record contains an attempt-target cleanup", { root: lock.root, attemptId });
  record = continueCleanup(lock, record) as RestoreActiveRecord;
  return retireCleanedRestore(lock, record);
}

/** Consume a healthy restore only after exact old-source cleanup is durably complete. */
function retireCleanedRestore(lock: MaintenanceLock, record: RestoreActiveRecord): RestoreActiveRecord {
  if (record.restore.cleanup?.kind !== "previous-source" || record.restore.cleanup.status !== "complete")
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
